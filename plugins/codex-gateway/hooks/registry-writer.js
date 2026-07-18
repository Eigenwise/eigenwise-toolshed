#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const CATALOG_SCHEMA_VERSION = 3;

function pluginRoot() {
  return path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'));
}

function pluginVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

function registryPath(home = os.homedir()) {
  return path.join(home, '.claude', 'toolshed', 'registry', 'codex-gateway.json');
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
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function breadcrumb(root, version, home) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'codex-gateway',
    version,
    root,
    capabilities: ['model-catalog'],
    catalog: {
      path: path.join(home, '.claude', 'codex-gateway', 'catalog.json'),
      schemaVersion: CATALOG_SCHEMA_VERSION,
    },
  };
}

function writeBreadcrumb({ root = pluginRoot(), home = os.homedir(), version = pluginVersion(root) } = {}) {
  const file = registryPath(home);
  if (futureSchema(file)) return { written: false, reason: 'future-schema', file };
  writeAtomically(file, breadcrumb(root, version, home));
  return { written: true, file };
}

if (require.main === module) {
  try { writeBreadcrumb(); } catch (_) {}
}

module.exports = { CATALOG_SCHEMA_VERSION, SCHEMA_VERSION, breadcrumb, registryPath, writeBreadcrumb };
