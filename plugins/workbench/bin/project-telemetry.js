#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { observabilityEnvironment, setupObservability } = require('./setup-observability.js');
const { projectMetadata, repositoryRoot } = require('../hooks/observability.js');
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

function projectSettingsPath(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'settings.local.json');
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
  const attributes = parseResourceAttributes();
  attributes.set('project.id', projectName(projectDir));
  attributes.set('service.name', 'claude-code');
  return {
    ...observabilityEnvironment(ports),
    OTEL_RESOURCE_ATTRIBUTES: serializeResourceAttributes(attributes),
  };
}

function mergeTelemetrySettings(settings, projectDir, options = {}) {
  const next = structuredClone(settings || {});
  const existingEnvironment = next.env || {};
  const addedEnvironment = telemetryEnvironment(projectDir, options.ports);
  const previous = Object.fromEntries(Object.keys(addedEnvironment).map((name) => [
    name,
    Object.hasOwn(existingEnvironment, name) ? existingEnvironment[name] : null,
  ]));
  const attributes = parseResourceAttributes(existingEnvironment.OTEL_RESOURCE_ATTRIBUTES);
  attributes.set('project.id', projectName(projectDir));
  attributes.set('service.name', 'claude-code');
  addedEnvironment.OTEL_RESOURCE_ATTRIBUTES = serializeResourceAttributes(attributes);
  next.env = { ...existingEnvironment, ...addedEnvironment };
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
  if (changed) writePrivateJson(settingsPath, result.settings);
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
  if (changed) writePrivateJson(settingsPath, next);
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

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--project' && next) { options.projectDir = argv[++index]; continue; }
    if (argument === '--disable') { options.disable = true; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function directoryReport(directories) {
  return directories.map(({ directory }) => `  ${directory}\n`).join('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(options.projectDir || process.cwd());
  if (options.disable) {
    const result = disableProjectTelemetry(projectDir);
    if (!result.changed) {
      process.stdout.write('Project telemetry was not enabled by Workbench.\n');
      return;
    }
    const unwired = result.directories.filter((entry) => entry.changed);
    if (unwired.length === 0) {
      process.stdout.write(`Removed ${projectName(result.repositoryRoot)} from the local registry; no wired directory remained.\n`);
      return;
    }
    process.stdout.write(`Project telemetry disabled for ${projectName(result.repositoryRoot)} in ${unwired.length} director${unwired.length === 1 ? 'y' : 'ies'}:\n`);
    process.stdout.write(directoryReport(unwired));
    process.stdout.write('Restart Claude Code in each of them for the change to take effect.\n');
    return;
  }
  const result = await enableProjectTelemetry(projectDir, options);
  process.stdout.write(`Project telemetry enabled for ${projectName(result.repositoryRoot)} (repository ${result.repositoryRoot}) in ${result.directories.length} director${result.directories.length === 1 ? 'y' : 'ies'}:\n`);
  process.stdout.write(directoryReport(result.directories));
  process.stdout.write('Every Claude Code session running in those directories must restart before its metrics appear.\n');
}

module.exports = {
  STATE_FILE,
  applyProjectTelemetry,
  claudeProjectsDir,
  disableProjectTelemetry,
  enableProjectTelemetry,
  encodedProjectDirectory,
  mergeTelemetrySettings,
  parseArgs,
  projectName,
  projectSettingsPath,
  registryEntry,
  registryConfigPath,
  removeProjectRegistry,
  repositorySubdirectories,
  sessionDirectories,
  telemetryEnvironment,
  telemetryRoot,
  telemetryStatePath,
  updateProjectRegistry,
  wiredDirectories,
  wiredProjectId,
};

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
