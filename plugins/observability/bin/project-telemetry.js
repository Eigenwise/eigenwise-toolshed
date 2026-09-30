#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_PORTS,
  compareVersions,
  observabilityEnvironment,
  setupObservability,
  verifyCommand,
} = require('./setup-observability.js');
const { projectMetadata, repositoryRoot } = require('../hooks/observability.js');
const {
  mergeProjectEnvironment,
  projectSettingsPath,
  readSettings,
  writeProjectSettings,
  writeSettings,
} = require('../lib/project-settings.js');
const {
  defaultConfigPath,
  defaultDataDir,
  readObservabilityConfig,
  writeObservabilityConfig,
} = require('../observability/sinks/index.js');

const STATE_FILE = 'settings.local.workbench-telemetry.json';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_DIRECTORIES = 4096;
// From 2.1.282 Claude Code ignores these in project and local settings (only user, managed,
// --settings or the launch environment can turn export on). OTEL_RESOURCE_ATTRIBUTES is not on
// its list, so project.id still comes from each session directory's settings.
const PROJECT_EXPORT_IGNORED_SINCE = '2.1.282';
const USER_EXPORT_VARIABLES = Object.freeze([
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
]);

function projectName(projectDir) {
  return projectMetadata(path.resolve(projectDir)).project_name;
}

function telemetryRoot(projectDir) {
  const resolved = path.resolve(projectDir);
  return repositoryRoot(resolved) || resolved;
}

function claudeProjectsDir(options = {}) {
  if (options.projectsDir) return options.projectsDir;
  const environment = options.environment || process.env;
  return path.join(environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// Claude Code names a session directory by replacing every non-alphanumeric character of
// the absolute path with a dash. That is not reversible (a dash may be a separator or a
// literal), so candidate directories are encoded and matched, never decoded.
function encodedProjectDirectory(directory) {
  return path.resolve(directory).replace(/[^A-Za-z0-9]/g, '-');
}

function repositorySubdirectories(root) {
  const found = [];
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_SCAN_DIRECTORIES) {
    const { directory, depth } = queue.shift();
    visited += 1;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      // The parent already resolved to this repository, so only a child carrying its own
      // `.git` can belong somewhere else, and only that child is worth resolving.
      const marker = fs.statSync(path.join(child, '.git'), { throwIfNoEntry: false });
      if (marker && telemetryRoot(child) !== root) continue;
      found.push(child);
      if (depth + 1 < MAX_SCAN_DEPTH) queue.push({ directory: child, depth: depth + 1 });
    }
  }
  return found.sort();
}

function hostedEncodings(options) {
  const projects = claudeProjectsDir(options);
  // Windows and macOS hand back paths whose case may differ from the one Claude Code
  // encoded, and neither filesystem can hold two names that differ only by case.
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  try {
    return {
      insensitive,
      names: new Set(fs.readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => (insensitive ? entry.name.toLowerCase() : entry.name))),
    };
  } catch {
    return { insensitive, names: new Set() };
  }
}

// Claude Code reads OTEL_RESOURCE_ATTRIBUTES from the settings of the directory a session
// started in and never walks up to the repository root, so the env has to physically exist
// in every directory that hosts sessions.
function sessionDirectories(projectDir, options = {}) {
  const root = telemetryRoot(projectDir);
  const { insensitive, names } = hostedEncodings(options);
  const hosted = (directory) => {
    const encoded = encodedProjectDirectory(directory);
    return names.has(insensitive ? encoded.toLowerCase() : encoded);
  };
  return [root, ...repositorySubdirectories(root).filter(hosted)];
}

function registryEntry(projectDir, now = new Date()) {
  const metadata = projectMetadata(path.resolve(projectDir));
  if (!metadata.project_id || !metadata.project_name) throw new Error('Project directory must have a safe basename.');
  return { ...metadata, optedInAt: new Date(now).toISOString() };
}

function registryConfigPath(options = {}) {
  return options.configFile || defaultConfigPath(options.dataDir || defaultDataDir(options.environment));
}

function updateProjectRegistry(projectDir, options = {}) {
  const configFile = registryConfigPath(options);
  const config = readObservabilityConfig(configFile);
  const entry = registryEntry(projectDir, options.now);
  const projects = Array.isArray(config.observability.optedInProjects) ? config.observability.optedInProjects : [];
  const existing = projects.find((project) => project?.project_id === entry.project_id);
  const next = {
    ...config,
    observability: {
      ...config.observability,
      optedInProjects: [
        ...projects.filter((project) => project?.project_id !== entry.project_id),
        existing ? { ...entry, optedInAt: existing.optedInAt } : entry,
      ],
    },
  };
  writeObservabilityConfig(configFile, next);
  return { configFile, entry: existing ? { ...entry, optedInAt: existing.optedInAt } : entry };
}

function removeProjectRegistry(projectDir, options = {}) {
  const configFile = registryConfigPath(options);
  const config = readObservabilityConfig(configFile);
  const metadata = projectMetadata(path.resolve(projectDir));
  const projects = Array.isArray(config.observability.optedInProjects) ? config.observability.optedInProjects : [];
  const remaining = projects.filter((project) => project?.project_id !== metadata.project_id);
  if (remaining.length === projects.length) return { changed: false, configFile };
  writeObservabilityConfig(configFile, {
    ...config,
    observability: { ...config.observability, optedInProjects: remaining },
  });
  return { changed: true, configFile };
}

function telemetryStatePath(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', STATE_FILE);
}

function wiredProjectId(projectDir) {
  try {
    const settings = JSON.parse(fs.readFileSync(projectSettingsPath(projectDir), 'utf8'));
    return parseResourceAttributes(settings?.env?.OTEL_RESOURCE_ATTRIBUTES).get('project.id') || null;
  } catch {
    return null;
  }
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); fs.chmodSync(filePath, 0o600); } catch {}
}

function parseResourceAttributes(value) {
  return new Map(String(value || '').split(',').filter(Boolean).map((entry) => {
    const index = entry.indexOf('=');
    return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
}

function serializeResourceAttributes(attributes) {
  return [...attributes.entries()].map(([key, value]) => `${key}=${value}`).join(',');
}

function restoreResourceAttributes(current, previous, added) {
  if (current === added) return previous;
  const currentAttributes = parseResourceAttributes(current);
  const previousAttributes = parseResourceAttributes(previous);
  const addedAttributes = parseResourceAttributes(added);
  for (const [name, value] of addedAttributes) {
    if (currentAttributes.get(name) !== value) continue;
    if (previousAttributes.has(name)) currentAttributes.set(name, previousAttributes.get(name));
    else currentAttributes.delete(name);
  }
  const restored = serializeResourceAttributes(currentAttributes);
  return restored || null;
}

function telemetryEnvironment(projectDir, ports) {
  const project = projectMetadata(path.resolve(projectDir));
  const attributes = parseResourceAttributes();
  attributes.set('project.id', project.project_id);
  attributes.set('project.name', project.project_name);
  attributes.set('service.name', 'claude-code');
  return {
    ...observabilityEnvironment(ports),
    OTEL_RESOURCE_ATTRIBUTES: serializeResourceAttributes(attributes),
  };
}

function mergeTelemetrySettings(settings, projectDir, options = {}) {
  const existingEnvironment = settings?.env || {};
  const addedEnvironment = telemetryEnvironment(projectDir, options.ports);
  const previous = Object.fromEntries(Object.keys(addedEnvironment).map((name) => [
    name,
    Object.hasOwn(existingEnvironment, name) ? existingEnvironment[name] : null,
  ]));
  const project = projectMetadata(path.resolve(projectDir));
  const attributes = parseResourceAttributes(existingEnvironment.OTEL_RESOURCE_ATTRIBUTES);
  attributes.set('project.id', project.project_id);
  attributes.set('project.name', project.project_name);
  attributes.set('service.name', 'claude-code');
  addedEnvironment.OTEL_RESOURCE_ATTRIBUTES = serializeResourceAttributes(attributes);
  const next = mergeProjectEnvironment(settings, addedEnvironment);
  return { settings: next, state: { version: 1, previous, added: addedEnvironment } };
}

function applyProjectTelemetry(projectDir, options = {}) {
  const settingsPath = projectSettingsPath(projectDir);
  const statePath = telemetryStatePath(projectDir);
  const before = readJson(settingsPath);
  const result = mergeTelemetrySettings(before, projectDir, options);
  const currentState = readJson(statePath, null);
  const state = currentState?.previous && currentState?.added
    ? { ...currentState, added: result.state.added }
    : result.state;
  const changed = JSON.stringify(before) !== JSON.stringify(result.settings);
  if (changed) writeProjectSettings(projectDir, result.settings);
  writePrivateJson(statePath, state);
  return { changed, settingsPath, statePath, settings: result.settings };
}

function wiredDirectories(projectDir) {
  const root = telemetryRoot(projectDir);
  const wired = (directory) => Boolean(fs.statSync(telemetryStatePath(directory), { throwIfNoEntry: false }));
  return [root, ...repositorySubdirectories(root).filter(wired)];
}

function unwireDirectory(projectDir) {
  const settingsPath = projectSettingsPath(projectDir);
  const statePath = telemetryStatePath(projectDir);
  const state = readJson(statePath, null);
  if (!state?.added || !state?.previous) return { changed: false, settingsPath, statePath, reason: 'not_enabled' };

  const before = readJson(settingsPath);
  const next = structuredClone(before);
  const environment = { ...(next.env || {}) };
  for (const [name, added] of Object.entries(state.added)) {
    const previous = state.previous[name];
    if (name === 'OTEL_RESOURCE_ATTRIBUTES') {
      const restored = restoreResourceAttributes(environment[name], previous, added);
      if (restored === null) delete environment[name];
      else environment[name] = restored;
      continue;
    }
    if (environment[name] !== added) continue;
    if (previous === null) delete environment[name];
    else environment[name] = previous;
  }
  if (Object.keys(environment).length > 0) next.env = environment;
  else delete next.env;
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (changed) writeProjectSettings(projectDir, next);
  fs.rmSync(statePath, { force: true });
  return { changed, settingsPath, statePath, settings: next };
}

function disableProjectTelemetry(projectDir, options = {}) {
  const root = telemetryRoot(projectDir);
  const registry = removeProjectRegistry(root, options);
  const directories = wiredDirectories(root).map((directory) => ({ directory, ...unwireDirectory(directory) }));
  const [rootDirectory] = directories;
  return {
    changed: registry.changed || directories.some((entry) => entry.changed),
    repositoryRoot: root,
    directories,
    settingsPath: rootDirectory.settingsPath,
    statePath: rootDirectory.statePath,
    settings: rootDirectory.settings,
    registry,
    ...(directories.every((entry) => entry.reason === 'not_enabled') ? { reason: 'not_enabled' } : {}),
  };
}

async function enableProjectTelemetry(projectDir, options = {}) {
  const root = telemetryRoot(projectDir);
  const runtime = await (options.prepareRuntime || setupObservability)({
    ...options,
    projectDir: root,
    applyProjectSettings: false,
  });
  const ports = runtime.config.observability.ports;
  const registry = updateProjectRegistry(root, { ...options, configFile: runtime.observabilityConfig });
  const directories = sessionDirectories(root, options)
    .map((directory) => ({ directory, ...applyProjectTelemetry(directory, { ports }) }));
  const [rootDirectory] = directories;
  return {
    runtime,
    registry,
    repositoryRoot: root,
    directories,
    changed: directories.some((entry) => entry.changed),
    settingsPath: rootDirectory.settingsPath,
    statePath: rootDirectory.statePath,
    settings: rootDirectory.settings,
  };
}

function claudeUserSettingsPath(options = {}) {
  if (options.userSettingsPath) return options.userSettingsPath;
  const environment = options.environment || process.env;
  return path.join(environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

function userExportEnvironment(ports) {
  const environment = observabilityEnvironment({ ...DEFAULT_PORTS, ...ports });
  return Object.fromEntries(USER_EXPORT_VARIABLES.map((name) => [name, environment[name]]));
}

function configuredPorts(options = {}) {
  return readObservabilityConfig(registryConfigPath(options)).observability.ports;
}

// Claude Code sets AI_AGENT=claude-code_<major>-<minor>-<patch>_<source> for the hooks and tools it runs.
function claudeVersionFromAgent(environment = process.env) {
  return /^claude-code[_/](\d+)-(\d+)-(\d+)/.exec(environment.AI_AGENT || '')?.slice(1).join('.') || null;
}

function claudeCliVersion(options) {
  return /\d+\.\d+\.\d+/.exec(verifyCommand(options.claude || 'claude', ['--version'], options.spawnSync))?.[0] || null;
}

function installedClaudeVersion(options = {}) {
  if (options.claudeVersion !== undefined) return options.claudeVersion;
  try {
    return claudeCliVersion(options);
  } catch {
    return claudeVersionFromAgent(options.environment);
  }
}

// An unknown version counts as current: every release since 2.1.282 needs user-level export.
function projectSettingsCanExport(version) {
  return Boolean(version) && compareVersions(version, PROJECT_EXPORT_IGNORED_SINCE) < 0;
}

function missingUserExport(ports, options = {}) {
  const userEnvironment = readSettings(claudeUserSettingsPath(options)).env || {};
  const launchEnvironment = options.environment || process.env;
  const exportsNowhere = ([name, value]) => userEnvironment[name] !== value && launchEnvironment[name] !== value;
  return Object.entries(userExportEnvironment(ports)).filter(exportsNowhere).map(([name]) => name);
}

function applyUserExport(options = {}) {
  const settingsPath = claudeUserSettingsPath(options);
  const settings = readSettings(settingsPath);
  const existing = settings.env || {};
  const wanted = Object.entries(userExportEnvironment(options.ports));
  const alreadySet = ([name]) => Object.hasOwn(existing, name);
  const heldByOtherValue = ([name, value]) => alreadySet([name]) && existing[name] !== value;
  const written = Object.fromEntries(wanted.filter((entry) => !alreadySet(entry)));
  const conflicting = wanted.filter(heldByOtherValue).map(([name]) => name);
  if (Object.keys(written).length > 0) writeSettings(settingsPath, mergeProjectEnvironment(settings, written));
  return { settingsPath, written, conflicting };
}

function userExportCommand() {
  return `node "${path.join(__dirname, 'project-telemetry.js')}" --user-export`;
}

function userExportAdvice(ports, options = {}) {
  const version = installedClaudeVersion(options);
  if (projectSettingsCanExport(version)) return '';
  const missing = missingUserExport(ports, options);
  if (missing.length === 0) return '';
  return `Nothing exports yet. Claude Code ${version || '(version unknown)'} ignores telemetry export settings in project files (since ${PROJECT_EXPORT_IGNORED_SINCE}), so those directories only carry this project's id. `
    + `Export has to be turned on once in your user settings (${claudeUserSettingsPath(options)}). That makes every Claude Code session on this machine send telemetry to the local collector. The observer keeps only projects you opted in, but traces and metrics from other projects still reach a configured sink or dashboard, because that path has no opt-in gate. `
    + `To do it, run:\n  ${userExportCommand()}\n`;
}

function userExportNotice(config, options = {}) {
  const version = claudeVersionFromAgent(options.environment);
  if (projectSettingsCanExport(version || '0.0.0') || !config.observability.optedInProjects?.length) return null;
  if (missingUserExport(config.observability.ports, options).length === 0) return null;
  return `Observability: Claude Code ${version} ignores telemetry export settings in project files, so opted-in projects record no claude_code metrics or events. Run /observability:enable-project-telemetry to turn export on in your user settings.`;
}

function userExportReport({ settingsPath, written, conflicting }) {
  const writtenLines = Object.entries(written).map(([name, value]) => `  ${name}=${value}\n`);
  const lines = writtenLines.length > 0
    ? [`Turned on telemetry export for every Claude Code session on this machine. Wrote to ${settingsPath} env:\n`, ...writtenLines]
    : [`Nothing written: ${settingsPath} already has every export variable.\n`];
  if (conflicting.length > 0) {
    lines.push(`Left alone because ${settingsPath} already gives them other values: ${conflicting.join(', ')}. Export reaches this plugin's collector only with the values listed by verify-project-telemetry.js --audit.\n`);
  }
  lines.push('Restart running Claude Code sessions before their telemetry appears.\n');
  return lines.join('');
}

const FLAG_OPTIONS = Object.freeze({ '--disable': 'disable', '--user-export': 'userExport' });

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project' && argv[index + 1]) { options.projectDir = argv[++index]; continue; }
    if (!Object.hasOwn(FLAG_OPTIONS, argument)) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[FLAG_OPTIONS[argument]] = true;
  }
  return options;
}

function directoryReport(directories) {
  return directories.map(({ directory }) => `  ${directory}\n`).join('');
}

function directoryCount(count) {
  return `${count} director${count === 1 ? 'y' : 'ies'}`;
}

function disableReport(result) {
  if (!result.changed) return 'Project telemetry was not enabled by Observability.\n';
  const unwired = result.directories.filter((entry) => entry.changed);
  if (unwired.length === 0) return `Removed ${projectName(result.repositoryRoot)} from the local registry; no wired directory remained.\n`;
  return `Project telemetry disabled for ${projectName(result.repositoryRoot)} in ${directoryCount(unwired.length)}:\n`
    + directoryReport(unwired)
    + 'Restart Claude Code in each of them for the change to take effect.\n';
}

function enableReport(result) {
  return `Project telemetry enabled for ${projectName(result.repositoryRoot)} (repository ${result.repositoryRoot}) in ${directoryCount(result.directories.length)}:\n`
    + directoryReport(result.directories)
    + 'Every Claude Code session running in those directories must restart before its metrics appear.\n';
}

async function runCommand(argv, dependencies = {}) {
  const options = { ...dependencies, ...parseArgs(argv) };
  if (options.userExport) return userExportReport(applyUserExport({ ...options, ports: configuredPorts(options) }));
  const projectDir = path.resolve(options.projectDir || process.cwd());
  if (options.disable) return disableReport(disableProjectTelemetry(projectDir, options));
  const result = await enableProjectTelemetry(projectDir, options);
  return enableReport(result) + userExportAdvice(result.runtime.config.observability.ports, options);
}

module.exports = {
  PROJECT_EXPORT_IGNORED_SINCE,
  STATE_FILE,
  USER_EXPORT_VARIABLES,
  applyProjectTelemetry,
  applyUserExport,
  claudeProjectsDir,
  claudeUserSettingsPath,
  claudeVersionFromAgent,
  disableProjectTelemetry,
  enableProjectTelemetry,
  encodedProjectDirectory,
  installedClaudeVersion,
  mergeTelemetrySettings,
  missingUserExport,
  parseArgs,
  projectName,
  projectSettingsCanExport,
  projectSettingsPath,
  registryEntry,
  registryConfigPath,
  removeProjectRegistry,
  repositorySubdirectories,
  runCommand,
  sessionDirectories,
  telemetryEnvironment,
  telemetryRoot,
  telemetryStatePath,
  updateProjectRegistry,
  userExportAdvice,
  userExportCommand,
  userExportEnvironment,
  userExportNotice,
  wiredDirectories,
  wiredProjectId,
};

if (require.main === module) {
  runCommand(process.argv.slice(2))
    .then((report) => process.stdout.write(report))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
