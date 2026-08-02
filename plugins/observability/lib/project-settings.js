'use strict';

// Workbench owns the full workspace-settings writer (agent teams, compaction). Plugins cannot require
// across plugin roots, so this keeps only the read/merge/write primitives the telemetry flow needs.

const fs = require('node:fs');
const path = require('node:path');

function projectSettingsPath(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'settings.local.json');
}

function readSettings(settingsPath) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${settingsPath}: ${error.message}`);
  }
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.dirname(settingsPath), 0o700); fs.chmodSync(settingsPath, 0o600); } catch {}
  return settingsPath;
}

function readProjectSettings(projectDir) {
  return readSettings(projectSettingsPath(projectDir));
}

function writeProjectSettings(projectDir, settings) {
  return writeSettings(projectSettingsPath(projectDir), settings);
}

function mergeProjectEnvironment(settings, environment) {
  const next = structuredClone(settings || {});
  next.env = { ...(next.env || {}), ...environment };
  return next;
}

module.exports = {
  mergeProjectEnvironment,
  projectSettingsPath,
  readProjectSettings,
  readSettings,
  writeProjectSettings,
  writeSettings,
};
