#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

function pluginRoot() {
  return path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'));
}

function pluginVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

function registryPath(home = os.homedir()) {
  return path.join(home, '.claude', 'toolshed', 'registry', 'switchboard.json');
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

function writeBreadcrumb({ root = pluginRoot(), home = os.homedir(), version = pluginVersion(root) } = {}) {
  const file = registryPath(home);
  if (futureSchema(file)) return { written: false, reason: 'future-schema', file };
  const contract = require(path.join(root, 'lib', 'contract.js'));
  writeAtomically(file, contract.createRegistryBreadcrumb({ root, version }));
  return { written: true, file };
}

if (require.main === module) {
  try { writeBreadcrumb(); } catch (_) {}
}

module.exports = { SCHEMA_VERSION, registryPath, writeBreadcrumb };
