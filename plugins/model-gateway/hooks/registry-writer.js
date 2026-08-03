#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const CATALOG_SCHEMA_VERSION = 4;
const UPDATE_LAUNCHER = `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function compareVersions(left, right) {
  const parts = (value) => String(value || '').split(/[^0-9]+/).map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function currentModelGatewayCli() {
  const claudeHome = process.env.MODEL_GATEWAY_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const registry = JSON.parse(fs.readFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8'));
  const candidates = (registry.plugins?.['model-gateway@eigenwise-toolshed'] || [])
    .filter((install) => install?.installPath)
    .map((install) => ({ ...install, script: path.join(install.installPath, 'bin', 'model-gateway.js') }))
    .filter((install) => fs.existsSync(install.script));
  candidates.sort((left, right) => compareVersions(right.version, left.version)
    || String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')));
  return candidates[0]?.script;
}

const script = currentModelGatewayCli();
if (!script) throw new Error('Model Gateway is not installed in Claude Code\\'s plugin registry.');
const result = spawnSync(process.execPath, [script, 'setup'], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`;

function pluginRoot() {
  return path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'));
}

function pluginVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

function registryPath(home = os.homedir()) {
  return path.join(home, '.claude', 'toolshed', 'registry', 'model-gateway.json');
}

function updateLauncherPath(home = os.homedir()) {
  return path.join(home, '.claude', 'model-gateway', 'update.js');
}

function writeUpdateLauncher({ home = os.homedir() } = {}) {
  const file = updateLauncherPath(home);
  writeAtomically(file, UPDATE_LAUNCHER);
  return { written: true, file };
}

function futureSchema(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(value && value.schemaVersion) && value.schemaVersion > SCHEMA_VERSION;
  } catch (_) {
    return false;
  }
}

function writeAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function breadcrumb(root, version, home) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'model-gateway',
    version,
    root,
    capabilities: ['model-catalog'],
    catalog: {
      path: path.join(home, '.claude', 'model-gateway', 'catalog.json'),
      schemaVersion: CATALOG_SCHEMA_VERSION,
    },
  };
}

function writeBreadcrumb({ root = pluginRoot(), home = os.homedir(), version = pluginVersion(root) } = {}) {
  const file = registryPath(home);
  writeUpdateLauncher({ home });
  if (futureSchema(file)) return { written: false, reason: 'future-schema', file };
  writeAtomically(file, breadcrumb(root, version, home));
  return { written: true, file };
}

if (require.main === module) {
  try { writeBreadcrumb(); } catch (_) {}
}

module.exports = { CATALOG_SCHEMA_VERSION, SCHEMA_VERSION, breadcrumb, registryPath, updateLauncherPath, writeBreadcrumb, writeUpdateLauncher };
