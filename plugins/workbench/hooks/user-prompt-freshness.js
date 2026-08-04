#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  activeInstances,
  compareSemver,
  parseSemver,
  readJson,
} = require('./freshness-helpers.js');

const MARKETPLACE = 'eigenwise-toolshed';
const warnedReloads = new Set();

function isMaintenancePrompt(prompt) {
  const value = String(prompt || '').trim();
  if (/^\/(?:workbench:)?update-toolshed(?:\s+[\w.-]+)*$/i.test(value)) return true;
  if (/^\/(?:workbench:)?workbench-doctor$/i.test(value)) return true;
  if (/^\/reload-plugins(?:\s+--force)?$/i.test(value)) return true;
  if (/^\/plugin$/i.test(value)) return true;
  if (/^\/plugin\s+(?:install|update|enable|disable|remove|uninstall)(?:\s+[^\s]+){0,4}$/i.test(value)) return true;
  if (/^\/plugin\s+marketplace\s+(?:add|update|remove)(?:\s+[^\s]+){0,3}$/i.test(value)) return true;
  if (/^claude\s+plugin\s+marketplace\s+update\s+eigenwise-toolshed$/i.test(value)) return true;
  return /^claude\s+plugin\s+update\s+[\w.-]+@eigenwise-toolshed(?:\s+--scope\s+(?:user|project|local))?$/i.test(value);
}

function newerInstalledVersion(instances, loadedVersion) {
  return instances
    .filter((instance) => instance.name === 'workbench')
    .find((instance) => compareSemver(loadedVersion, instance.version) === -1)?.version || null;
}

function warningOutput(message) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } });
}

function reloadWarning(installedVersion, loadedVersion) {
  return `Workbench ${installedVersion} is installed, but this session loaded ${loadedVersion}. This prompt is proceeding. Reload with /reload-plugins or restart Claude Code before relying on the updated plugin code.`;
}

function warningKey(input) {
  return `${input?.session_id || ''}\0workbench`;
}

function warningStateFile(input, directory) {
  if (!input?.session_id) return null;
  const digest = crypto.createHash('sha256').update(warningKey(input)).digest('hex');
  return path.join(directory, digest);
}

function warnOnce(input, options = {}) {
  const key = warningKey(input);
  const warned = options.warnedReloads || warnedReloads;
  if (warned.has(key)) return false;
  warned.add(key);
  const stateFile = warningStateFile(input, options.warningStateDirectory || path.join(os.tmpdir(), 'eigenwise-toolshed', 'freshness-warnings'));
  if (!stateFile) return true;
  try {
    (options.fileSystem || fs).mkdirSync(path.dirname(stateFile), { recursive: true });
    (options.fileSystem || fs).writeFileSync(stateFile, '', { flag: 'wx' });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function loadedPluginVersion(fileSystem, pluginRoot) {
  return pluginRoot ? readJson(fileSystem, path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version || null : null;
}

function decide(input, options = {}) {
  if (process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1' || isMaintenancePrompt(input?.prompt)) return '';
  const fileSystem = options.fileSystem || fs;
  const registryFile = options.registryFile || path.join(options.home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const instances = activeInstances(readJson(fileSystem, registryFile) || {}, input?.cwd, MARKETPLACE, options.platform);
  const loadedVersion = loadedPluginVersion(fileSystem, options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT);
  const installedVersion = newerInstalledVersion(instances, loadedVersion);
  if (!installedVersion) return '';
  return warnOnce(input, options) ? warningOutput(reloadWarning(installedVersion, loadedVersion)) : '';
}

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const output = decide(input);
    if (output) process.stdout.write(output);
  } catch (_) {
    // Unknown local state and hook failures must never block a user prompt.
  }
}

if (require.main === module) main();

module.exports = {
  MARKETPLACE,
  activeInstances,
  compareSemver,
  decide,
  isMaintenancePrompt,
  loadedPluginVersion,
  newerInstalledVersion,
  parseSemver,
  reloadWarning,
  warnOnce,
};
