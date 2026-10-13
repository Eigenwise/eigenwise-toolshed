#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { defaultConfigPath, defaultDataDir, readObservabilityConfig } = require('../observability/sinks/index.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { defaultDatabaseFile } = require('./observer.js');
const { projectMetadata } = require('../hooks/observability.js');
const {
  PROJECT_EXPORT_IGNORED_SINCE,
  claudeUserSettingsPath,
  installedClaudeVersion,
  missingUserExport,
  projectSettingsCanExport,
  sessionDirectories,
  telemetryRoot,
  userExportCommand,
  wiredProjectId,
} = require('./project-telemetry.js');

const DEFAULT_WINDOW_HOURS = 6;

function projectIdentifiers(project) {
  return [project?.project_id, project?.project_name].filter((value) => typeof value === 'string' && value.length > 0);
}

function hasSampledProject(projects, project) {
  return projectIdentifiers(project).some((identifier) => projects.has(identifier));
}

function getJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ statusCode: response.statusCode, body: null });
        }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project' && argv[index + 1]) {
      options.projectDir = argv[++index];
      continue;
    }
    if (argument === '--audit') { options.audit = true; continue; }
    if (argument === '--window' && Number(argv[index + 1]) > 0) {
      options.windowHours = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function observabilityConfig(options) {
  const configFile = options.configFile || defaultConfigPath(options.dataDir || defaultDataDir(options.environment));
  return readObservabilityConfig(configFile).observability;
}

async function prometheusQuery(config, query) {
  if (!config.dashboard) return { ok: false, reason: 'dashboard_not_configured' };
  const dashboardUrl = `http://127.0.0.1:${config.ports?.dashboard || 3000}`;
  const dataSources = await getJson(`${dashboardUrl}/api/datasources`);
  if (dataSources?.statusCode !== 200) return { ok: false, reason: 'dashboard_unreachable' };

  const dataSource = Array.isArray(dataSources.body) && dataSources.body.find((candidate) => candidate.type === 'prometheus');
  const response = await getJson(`${dashboardUrl}/api/datasources/proxy/uid/${encodeURIComponent(dataSource?.uid || 'prometheus')}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (response?.statusCode !== 200) return { ok: false, reason: 'dashboard_unreachable' };
  return { ok: true, result: Array.isArray(response.body?.data?.result) ? response.body.data.result : [] };
}

async function verifyProjectTelemetry(projectDir, options = {}) {
  const config = observabilityConfig(options);
  const project = projectMetadata(telemetryRoot(projectDir));
  const observer = await getJson(`http://127.0.0.1:${config.ports?.observer || 14319}/health`);
  const observerHealthy = observer?.statusCode === 200 && observer.body?.ok === true;
  let prometheus = { ok: true, result: [] };
  for (const projectId of projectIdentifiers(project)) {
    const query = `claude_code_token_usage_tokens_total{project_id=${JSON.stringify(projectId)}}`;
    prometheus = await prometheusQuery(config, query);
    if (!prometheus.ok || prometheus.result.length > 0) break;
  }
  if (!prometheus.ok) return { found: false, project: project.project_name, observerHealthy, reason: prometheus.reason };

  const found = prometheus.result.length > 0;
  return { found, project: project.project_name, observerHealthy, reason: found ? undefined : 'metric_not_found' };
}

// Hook events reach the observer from any directory, but the claude_code_* metrics only
// exist where Claude Code found the telemetry env. A project with the first and none of
// the second is half-wired, which is invisible on its dashboard: it just reads empty.
function readStore(databaseFile, read) {
  if (!fs.existsSync(databaseFile)) return null;
  let store = null;
  try {
    store = openObservabilityStore(databaseFile, { outboxEnabled: false });
    return read(store.database);
  } catch {
    return null;
  } finally {
    try { if (store) store.close(); } catch {}
  }
}

function observerActivity(databaseFile, since) {
  return readStore(databaseFile, (database) => {
    const rows = database.prepare(`
      SELECT json_extract(attributes_json, '$.project_name') AS project_name, COUNT(*) AS events
      FROM observation
      WHERE event_name LIKE 'hook.%' AND observed_at >= ?
      GROUP BY project_name
    `).all(since);
    return new Map(rows.filter((row) => row.project_name).map((row) => [row.project_name, Number(row.events)]));
  });
}

// Claude Code's own events land as claude_code, its metrics as otel_collector.
function claudeCodeRows(databaseFile, identifiers, since) {
  return readStore(databaseFile, (database) => Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM observation
    WHERE source IN ('claude_code', 'otel_collector') AND observed_at >= ?
      AND project_id IN (SELECT value FROM json_each(?))
  `).get(since, JSON.stringify(identifiers)).count));
}

function directoryState(hasProjectId, exportMissing) {
  if (!hasProjectId) return 'unwired';
  return exportMissing.length > 0 ? 'no-export' : 'wired';
}

function auditVerdict({ directories, exportMissing, claudeCodeRows: rows }) {
  if (directories.some(({ state }) => state === 'unwired')) return 'unwired';
  if (exportMissing.length > 0) return 'export-disabled';
  if (rows === null) return 'unconfirmed';
  return rows > 0 ? 'wired' : 'no-data';
}

async function sampledProjects(config, windowHours) {
  const query = `count by (project_id) (count_over_time(claude_code_token_usage_tokens_total[${windowHours}h]))`;
  const response = await prometheusQuery(config, query);
  if (!response.ok) return { available: false, reason: response.reason, projects: new Set() };
  return {
    available: true,
    projects: new Set(response.result.map((entry) => entry?.metric?.project_id).filter(Boolean)),
  };
}

function auditWindow(options) {
  const windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
  const now = options.now ? new Date(options.now) : new Date();
  return { windowHours, since: new Date(now.getTime() - windowHours * 3600 * 1000).toISOString() };
}

function registeredProjects(config) {
  return new Map((config.optedInProjects || [])
    .filter((entry) => typeof entry?.project_name === 'string')
    .map((entry) => [entry.project_name, entry]));
}

function projectsMissingSamples(observed, sampled, registered) {
  if (!observed || !sampled.available) return [];
  const sentEventsWithoutSamples = ([name, events]) => {
    const entry = registered.get(name);
    const identifiers = entry ? projectIdentifiers(entry) : [name];
    return events > 0 && !identifiers.some((identifier) => sampled.projects.has(identifier));
  };
  return [...observed].filter(sentEventsWithoutSamples).map(([name, events]) => ({ project: name, events }));
}

function sampleSummary(observed, sampled, project) {
  return {
    observerEvents: observed ? (observed.get(project.project_name) || 0) : null,
    nativeSamples: sampled.available ? hasSampledProject(sampled.projects, project) : null,
    reason: sampled.available ? undefined : sampled.reason,
  };
}

// project.id in a directory's settings still attributes a session; turning export on is what
// moved out of project settings, so both have to hold before a directory counts as wired.
function exportMissingFor(claudeVersion, config, options) {
  return projectSettingsCanExport(claudeVersion) ? [] : missingUserExport(config.ports, options);
}

async function auditProjectTelemetry(projectDir, options = {}) {
  const config = observabilityConfig(options);
  const root = telemetryRoot(projectDir);
  const project = projectMetadata(root);
  const { windowHours, since } = auditWindow(options);
  const databaseFile = options.databaseFile || defaultDatabaseFile();
  const observed = observerActivity(databaseFile, since);
  const sampled = await sampledProjects(config, windowHours);
  const registered = registeredProjects(config);
  const claudeVersion = installedClaudeVersion(options);
  const exportMissing = exportMissingFor(claudeVersion, config, options);
  const directories = sessionDirectories(root, options).map((directory) => ({
    directory,
    state: directoryState(projectIdentifiers(project).includes(wiredProjectId(directory)), exportMissing),
  }));
  const byEvents = (left, right) => right.events - left.events || left.project.localeCompare(right.project);
  const entries = projectsMissingSamples(observed, sampled, registered);
  const optedIn = ({ project: name }) => registered.has(name);

  const audit = {
    project: project.project_name,
    repositoryRoot: root,
    windowHours,
    claudeVersion,
    ...sampleSummary(observed, sampled, project),
    claudeCodeRows: claudeCodeRows(databaseFile, projectIdentifiers(project), since),
    halfWired: entries.filter(optedIn).sort(byEvents),
    // Names nothing opted in: mostly other repositories, so this is a hint rather than a
    // fault, and only the busiest few are worth a line.
    unregistered: entries.filter((entry) => !optedIn(entry)).sort(byEvents),
    directories,
    exportMissing,
    userSettingsPath: claudeUserSettingsPath(options),
    fixCommand: `node "${path.join(__dirname, 'project-telemetry.js')}" --project "${root}"`,
    userExportCommand: userExportCommand(),
  };
  return { ...audit, verdict: auditVerdict(audit) };
}

const DIRECTORY_LABELS = Object.freeze({ wired: 'wired', 'no-export': 'NO-EXPORT', unwired: 'UNWIRED' });

function countLabel(value) {
  return value === null ? 'unknown' : value;
}

function nativeSamplesLabel(audit) {
  if (audit.nativeSamples === null) return `unknown reason=${audit.reason}`;
  return audit.nativeSamples ? 'yes' : 'no';
}

function needsProjectFix(audit) {
  return audit.directories.some(({ state }) => state === 'unwired')
    || audit.halfWired.some(({ project }) => project === audit.project);
}

function exportFixLines(audit) {
  return [
    `export: Claude Code ${audit.claudeVersion || '(version unknown)'} ignores telemetry export variables in project settings (since ${PROJECT_EXPORT_IGNORED_SINCE}), and neither ${audit.userSettingsPath} nor the launch environment sets ${audit.exportMissing.join(', ')}`,
    `fix export, only after the user agrees, since every Claude Code session on this machine then exports (the observer keeps only opted-in projects, but traces and metrics from other projects reach a configured sink or dashboard ungated): ${audit.userExportCommand}`,
  ];
}

function fixLines(audit) {
  const lines = [];
  if (needsProjectFix(audit)) lines.push(`fix: ${audit.fixCommand}`);
  if (audit.exportMissing.length > 0) lines.push(...exportFixLines(audit));
  if (lines.length > 0) return [...lines, 'then restart Claude Code in each of those directories before their metrics appear'];
  return audit.verdict === 'no-data'
    ? [`no-data: no claude_code rows for ${audit.project} in ${audit.windowHours}h; restart Claude Code in the wired directories and create activity, and if rows still do not arrive check the collector with node "${path.join(__dirname, '..', 'lib', 'observability', 'ensure.js')}" --health`]
    : [];
}

function unregisteredLines(audit) {
  const busiest = audit.unregistered.slice(0, 3).map(({ project, events }) => `${project} (${events})`).join(', ');
  if (!busiest) return [];
  const count = audit.unregistered.length;
  return [`not opted in: ${count} project name${count === 1 ? '' : 's'} sent observer events with no metrics, busiest ${busiest}`];
}

function formatAudit(audit) {
  const lines = [
    `audit project=${audit.project} root=${audit.repositoryRoot} window=${audit.windowHours}h claude-code=${audit.claudeVersion || 'unknown'}`,
    `observer-events=${countLabel(audit.observerEvents)} claude-code-rows=${countLabel(audit.claudeCodeRows)} native-samples=${nativeSamplesLabel(audit)}`,
    ...audit.directories.map(({ directory, state }) => `${DIRECTORY_LABELS[state]} ${directory}`),
    `verdict=${audit.verdict}`,
    ...fixLines(audit),
    ...audit.halfWired.map(({ project, events }) => `half-wired: opted-in project ${project} has ${events} observer events and no claude_code_* samples in ${audit.windowHours}h; run /observability:enable-project-telemetry from it, then restart Claude Code`),
    ...unregisteredLines(audit),
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(options.projectDir || process.cwd());
  if (options.audit) {
    process.stdout.write(formatAudit(await auditProjectTelemetry(projectDir, options)));
    return;
  }
  const result = await verifyProjectTelemetry(projectDir, options);
  process.stdout.write(`${result.found ? 'found' : 'not-found'} project=${result.project} observer=${result.observerHealthy ? 'healthy' : 'unavailable'}${result.reason ? ` reason=${result.reason}` : ''}\n`);
}

module.exports = { auditProjectTelemetry, formatAudit, parseArgs, verifyProjectTelemetry };

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
