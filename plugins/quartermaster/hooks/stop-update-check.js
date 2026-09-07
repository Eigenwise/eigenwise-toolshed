#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cacheIsCurrent,
  readCache,
  requestManifest,
  writeCache,
} = require('./marketplace-freshness-cache.js');
const {
  MARKETPLACE,
  activeInstances,
  availableVersionsKey,
  installedVersionsKey,
  loadedPluginVersion,
  newerInstalledVersion,
  remoteUpdates,
  remoteWarning,
  reloadWarning,
  reportedReloads,
  reportedReloadWarning,
  warnOnce,
} = require('./user-prompt-freshness.js');
const { readJson } = require('./freshness-helpers.js');

const REFRESH_TIMEOUT_MS = 2_000;

function readStdin(fileSystem = fs) {
  try {
    const raw = fileSystem.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function activeToolshedInstances(input, options) {
  const fileSystem = options.fileSystem || fs;
  const home = options.home || os.homedir();
  const registryFile = options.registryFile || path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  return activeInstances(readJson(fileSystem, registryFile) || {}, input.cwd, MARKETPLACE, options.platform);
}

function refreshManifest(options) {
  if (options.requestManifest) return options.requestManifest();
  return requestManifest(options.request, options.requestTimeoutMs ?? REFRESH_TIMEOUT_MS);
}

async function decide(input, options = {}) {
  const environment = options.environment || process.env;
  if (input?.stop_hook_active || !input?.session_id || environment.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1') return '';

  const fileSystem = options.fileSystem || fs;
  const home = options.home || os.homedir();
  const now = options.now ?? Date.now();
  let cache = options.cache === undefined ? readCache(fileSystem, home) : options.cache;
  if (!cacheIsCurrent(cache, now)) {
    try {
      const manifest = await refreshManifest(options);
      cache = { checkedAt: new Date(now).toISOString(), manifest };
      writeCache(cache, fileSystem, home);
    } catch {
      cache = null;
    }
  }

  const instances = activeToolshedInstances(input, options);
  const messages = [];
  const updates = remoteUpdates(instances, cache?.manifest);
  if (updates.length && warnOnce(input, 'stop-remote', options, availableVersionsKey(updates))) {
    messages.push(remoteWarning(instances, cache, now));
  }

  const loadedVersion = loadedPluginVersion(fileSystem, options.pluginRoot || environment.CLAUDE_PLUGIN_ROOT);
  const installedVersion = newerInstalledVersion(instances, loadedVersion);
  if (installedVersion && warnOnce(input, 'stop-reload', options, `quartermaster@${installedVersion}`)) {
    messages.push(reloadWarning(installedVersion, loadedVersion));
  }

  const reportedUpdates = reportedReloads(instances, input, options);
  if (reportedUpdates.length && warnOnce(input, 'stop-reload', options, installedVersionsKey(reportedUpdates))) {
    messages.push(reportedReloadWarning(reportedUpdates));
  }

  return messages.length ? JSON.stringify({ systemMessage: messages.join('\n') }) : '';
}

async function main() {
  const output = await decide(readStdin());
  if (output) process.stdout.write(output);
}

if (require.main === module) main().catch(() => {});

module.exports = {
  REFRESH_TIMEOUT_MS,
  activeToolshedInstances,
  decide,
  readStdin,
  refreshManifest,
};
