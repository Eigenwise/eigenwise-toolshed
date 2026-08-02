#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { defaultConfigPath, defaultDataDir, readObservabilityConfig } = require('../observability/sinks/index.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { defaultDatabaseFile } = require('./observer.js');
const { projectName, sessionDirectories, telemetryRoot, wiredProjectId } = require('./project-telemetry.js');

const DEFAULT_WINDOW_HOURS = 6;

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
  const project = projectName(projectDir);
  const observer = await getJson(`http://127.0.0.1:${config.ports?.observer || 14319}/health`);
  const observerHealthy = observer?.statusCode === 200 && observer.body?.ok === true;
  const query = `claude_code_token_usage_tokens_total{project_id=${JSON.stringify(project)}}`;
  const prometheus = await prometheusQuery(config, query);
  if (!prometheus.ok) return { found: false, project, observerHealthy, reason: prometheus.reason };

  const found = prometheus.result.length > 0;
  return { found, project, observerHealthy, reason: found ? undefined : 'metric_not_found' };
}

// Hook events reach the observer from any directory, but the claude_code_* metrics only
// exist where Claude Code found the telemetry env. A project with the first and none of
// the second is half-wired, which is invisible on its dashboard: it just reads empty.
function observerActivity(databaseFile, since) {
  if (!fs.existsSync(databaseFile)) return null;
  let store = null;
  try {
    store = openObservabilityStore(databaseFile, { outboxEnabled: false });
    const rows = store.database.prepare(`
      SELECT json_extract(attributes_json, '$.project_name') AS project_name, COUNT(*) AS events
      FROM observation
      WHERE event_name LIKE 'hook.%' AND observed_at >= ?
      GROUP BY project_name
    `).all(since);
    return new Map(rows.filter((row) => row.project_name).map((row) => [row.project_name, Number(row.events)]));
  } catch {
    return null;
  } finally {
    try { if (store) store.close(); } catch {}
  }
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

async function auditProjectTelemetry(projectDir, options = {}) {
  const config = observabilityConfig(options);
  const root = telemetryRoot(projectDir);
  const project = projectName(root);
  const windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
  const now = options.now ? new Date(options.now) : new Date();
  const since = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const observed = observerActivity(options.databaseFile || defaultDatabaseFile(), since);
  const sampled = await sampledProjects(config, windowHours);
  const registered = new Set((config.optedInProjects || []).map((entry) => entry?.project_name));
  const directories = sessionDirectories(root, options).map((directory) => ({
    directory,
    wired: wiredProjectId(directory) === project,
  }));
  const active = observed && sampled.available
    ? [...observed].filter(([name, events]) => events > 0 && !sampled.projects.has(name))
    : [];
  const byEvents = (left, right) => right.events - left.events || left.project.localeCompare(right.project);
  const entries = active.map(([name, events]) => ({ project: name, events }));

  return {
    project,
    repositoryRoot: root,
    windowHours,
    observerEvents: observed ? (observed.get(project) || 0) : null,
    nativeSamples: sampled.available ? sampled.projects.has(project) : null,
    reason: sampled.available ? undefined : sampled.reason,
    halfWired: entries.filter(({ project: name }) => registered.has(name)).sort(byEvents),
    // Names nothing opted in: mostly other repositories, so this is a hint rather than a
    // fault, and only the busiest few are worth a line.
    unregistered: entries.filter(({ project: name }) => !registered.has(name)).sort(byEvents),
    directories,
    fixCommand: `node "${path.join(__dirname, 'project-telemetry.js')}" --project "${root}"`,
  };
}

function formatAudit(audit) {
  const lines = [
    `audit project=${audit.project} root=${audit.repositoryRoot} window=${audit.windowHours}h`,
    `observer-events=${audit.observerEvents === null ? 'unknown' : audit.observerEvents} native-samples=${audit.nativeSamples === null ? `unknown reason=${audit.reason}` : (audit.nativeSamples ? 'yes' : 'no')}`,
    ...audit.directories.map(({ directory, wired }) => `${wired ? 'wired  ' : 'UNWIRED'} ${directory}`),
  ];
  const unwired = audit.directories.filter(({ wired }) => !wired);
  if (unwired.length > 0 || audit.halfWired.some(({ project }) => project === audit.project)) {
    lines.push(`fix: ${audit.fixCommand}`);
    lines.push('then restart Claude Code in each of those directories before their metrics appear');
  }
  for (const { project, events } of audit.halfWired) {
    lines.push(`half-wired: opted-in project ${project} has ${events} observer events and no claude_code_* samples in ${audit.windowHours}h; run /workbench:enable-project-telemetry from it, then restart Claude Code`);
  }
  const unregistered = audit.unregistered.slice(0, 3);
  if (unregistered.length > 0) {
    const busiest = unregistered.map(({ project, events }) => `${project} (${events})`).join(', ');
    lines.push(`not opted in: ${audit.unregistered.length} project name${audit.unregistered.length === 1 ? '' : 's'} sent observer events with no metrics, busiest ${busiest}`);
  }
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
