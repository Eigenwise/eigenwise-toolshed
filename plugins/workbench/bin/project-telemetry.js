#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { observabilityEnvironment, setupObservability } = require('./setup-observability.js');
const { projectMetadata } = require('../hooks/observability.js');
const {
  defaultConfigPath,
  defaultDataDir,
  readObservabilityConfig,
  writeObservabilityConfig,
} = require('../observability/sinks/index.js');

const STATE_FILE = 'settings.local.workbench-telemetry.json';

function projectName(projectDir) {
  return projectMetadata(path.resolve(projectDir)).project_name;
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

function disableProjectTelemetry(projectDir, options = {}) {
  const registry = removeProjectRegistry(projectDir, options);
  const settingsPath = projectSettingsPath(projectDir);
  const statePath = telemetryStatePath(projectDir);
  const state = readJson(statePath, null);
  if (!state?.added || !state?.previous) return {
    changed: registry.changed,
    settingsPath,
    statePath,
    registry,
    reason: 'not_enabled',
  };

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
  return { changed: changed || registry.changed, settingsPath, statePath, registry, settings: next };
}

async function enableProjectTelemetry(projectDir, options = {}) {
  const runtime = await (options.prepareRuntime || setupObservability)({
    ...options,
    projectDir,
    applyProjectSettings: false,
  });
  const ports = runtime.config.observability.ports;
  const registry = updateProjectRegistry(projectDir, { ...options, configFile: runtime.observabilityConfig });
  return { runtime, registry, ...applyProjectTelemetry(projectDir, { ports }) };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(options.projectDir || process.cwd());
  if (options.disable) {
    const result = disableProjectTelemetry(projectDir);
    process.stdout.write(result.changed ? `Project telemetry disabled in ${result.settingsPath}.\n` : 'Project telemetry was not enabled by Workbench.\n');
    return;
  }
  const result = await enableProjectTelemetry(projectDir, options);
  process.stdout.write(`Project telemetry enabled for ${projectName(projectDir)} in ${result.settingsPath}. Restart Claude Code before sending telemetry.\n`);
}

module.exports = {
  STATE_FILE,
  applyProjectTelemetry,
  disableProjectTelemetry,
  enableProjectTelemetry,
  mergeTelemetrySettings,
  parseArgs,
  projectName,
  projectSettingsPath,
  registryEntry,
  registryConfigPath,
  removeProjectRegistry,
  telemetryEnvironment,
  telemetryStatePath,
  updateProjectRegistry,
};

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
