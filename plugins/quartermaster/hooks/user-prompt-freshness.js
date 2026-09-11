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
  pluginIdParts,
  readJson,
  reportLoadedPluginVersion,
  reportedLoadedPluginVersion,
} = require('./freshness-helpers.js');
const { cacheIsCurrent, readCache } = require('./marketplace-freshness-cache.js');

const MARKETPLACE = 'eigenwise-toolshed';
const warnedStates = new Set();

function isMaintenancePrompt(prompt) {
  const value = String(prompt || '').trim();
  if (/^\/(?:quartermaster:)?update-toolshed(?:\s+[\w.-]+)*$/i.test(value)) return true;
  if (/^\/(?:quartermaster:)?toolshed-doctor$/i.test(value)) return true;
  if (/^\/reload-plugins(?:\s+--force)?$/i.test(value)) return true;
  if (/^\/plugin$/i.test(value)) return true;
  if (/^\/plugin\s+(?:install|update|enable|disable|remove|uninstall)(?:\s+[^\s]+){0,4}$/i.test(value)) return true;
  if (/^\/plugin\s+marketplace\s+(?:add|update|remove)(?:\s+[^\s]+){0,3}$/i.test(value)) return true;
  if (/^claude\s+plugin\s+marketplace\s+update\s+eigenwise-toolshed$/i.test(value)) return true;
  return /^claude\s+plugin\s+update\s+[\w.-]+@eigenwise-toolshed(?:\s+--scope\s+(?:user|project|local))?$/i.test(value);
}

function newerInstalledVersion(instances, loadedVersion) {
  return instances
    .filter((instance) => instance.name === 'quartermaster' && compareSemver(loadedVersion, instance.version) === -1)
    .map((instance) => instance.version)
    .sort((left, right) => compareSemver(left, right) || 0)
    .at(-1) || null;
}

function warningOutput(message) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } });
}

function reloadWarning(installedVersion, loadedVersion) {
  return `Quartermaster ${installedVersion} is installed, but this session loaded ${loadedVersion}. This prompt is proceeding. Reload with /reload-plugins or restart Claude Code before relying on the updated plugin code.`;
}

function reportedReloads(instances, input, options) {
  const updates = new Map();
  for (const instance of instances) {
    const parts = pluginIdParts(instance.id);
    if (!parts || parts.name === 'quartermaster') continue;
    const loadedVersion = reportedLoadedPluginVersion(input, instance.id, {
      directory: options.loadedVersionStateDirectory,
      fileSystem: options.fileSystem,
    });
    if (!loadedVersion || compareSemver(loadedVersion, instance.version) !== -1) continue;
    const existing = updates.get(parts.name);
    if (!existing || compareSemver(existing.installedVersion, instance.version) === -1) {
      updates.set(parts.name, { name: parts.name, loadedVersion, installedVersion: instance.version });
    }
  }
  return [...updates.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function reportedReloadWarning(updates) {
  return `Toolshed plugins need reload: ${updates.map((update) => `${update.name}: loaded ${update.loadedVersion}, installed ${update.installedVersion}`).join('; ')}. This prompt is proceeding. Reload with /reload-plugins or restart Claude Code before relying on the updated plugin code.`;
}

function warningKey(input, kind, versionSet = '') {
  const base = `${input?.session_id || ''}\0${kind}`;
  return versionSet ? `${base}\0${versionSet}` : base;
}

function warningStateFile(input, kind, directory, versionSet) {
  if (!input?.session_id) return null;
  const digest = crypto.createHash('sha256').update(warningKey(input, kind, versionSet)).digest('hex');
  return path.join(directory, digest);
}

function warnOnce(input, kind, options = {}, versionSet = '') {
  const key = warningKey(input, kind, versionSet);
  const warned = options.warnedStates || warnedStates;
  if (warned.has(key)) return false;
  warned.add(key);
  const stateFile = warningStateFile(input, kind, options.warningStateDirectory || path.join(os.tmpdir(), 'eigenwise-toolshed', 'freshness-warnings'), versionSet);
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

function remoteUpdates(instances, manifest) {
  const available = new Map((manifest?.plugins || []).map((plugin) => [plugin.name, plugin.version]));
  const updates = new Map();
  for (const instance of instances) {
    const version = available.get(instance.name);
    const comparison = compareSemver(instance.version, version);
    if (comparison !== -1) continue;
    const existing = updates.get(instance.name);
    if (!existing || compareSemver(instance.version, existing.installed) === -1) {
      updates.set(instance.name, { name: instance.name, installed: instance.version, available: version });
    }
  }
  return [...updates.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function availableVersionsKey(updates) {
  return updates.map((update) => `${update.name}@${update.available}`).join(',');
}

function installedVersionsKey(updates) {
  return updates.map((update) => `${update.name}@${update.installedVersion ?? update.installed}`).join(',');
}

function remoteWarning(instances, cache, now) {
  if (!instances.length) return '';
  if (!cacheIsCurrent(cache, now) || !cache?.manifest) return 'Toolshed release freshness could not be determined. This prompt is proceeding. Run /update-toolshed to refresh the marketplace.';
  const updates = remoteUpdates(instances, cache.manifest);
  if (!updates.length) return '';
  return `Toolshed updates available: ${updates.map((update) => `${update.name} ${update.installed} → ${update.available}`).join(', ')}. Run /update-toolshed to install them; /reload-plugins cannot fetch new versions.`;
}

function decide(input, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const pluginRoot = options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT;
  const loadedVersion = loadedPluginVersion(fileSystem, pluginRoot);
  reportLoadedPluginVersion(input, 'quartermaster@eigenwise-toolshed', loadedVersion, {
    directory: options.loadedVersionStateDirectory,
    fileSystem,
    pluginRoot,
  });
  if (process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1' || isMaintenancePrompt(input?.prompt)) return '';
  const home = options.home || os.homedir();
  const registryFile = options.registryFile || path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const instances = activeInstances(readJson(fileSystem, registryFile) || {}, input?.cwd, MARKETPLACE, options.platform);
  const cache = options.cache === undefined ? readCache(fileSystem, home) : options.cache;
  const remoteMessage = remoteWarning(instances, cache, options.now ?? Date.now());
  const updates = remoteUpdates(instances, cache?.manifest);
  if (remoteMessage && warnOnce(input, 'remote', options, availableVersionsKey(updates))) return warningOutput(remoteMessage);
  const installedVersion = newerInstalledVersion(instances, loadedVersion);
  if (installedVersion) return warnOnce(input, 'reload', options, `quartermaster@${installedVersion}`) ? warningOutput(reloadWarning(installedVersion, loadedVersion)) : '';
  const reportedUpdates = reportedReloads(instances, input, options);
  if (!reportedUpdates.length) return '';
  return warnOnce(input, 'reload', options, installedVersionsKey(reportedUpdates)) ? warningOutput(reportedReloadWarning(reportedUpdates)) : '';
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
  availableVersionsKey,
  compareSemver,
  decide,
  isMaintenancePrompt,
  installedVersionsKey,
  loadedPluginVersion,
  newerInstalledVersion,
  parseSemver,
  reloadWarning,
  remoteUpdates,
  remoteWarning,
  reportedReloads,
  reportedReloadWarning,
  warnOnce,
};
