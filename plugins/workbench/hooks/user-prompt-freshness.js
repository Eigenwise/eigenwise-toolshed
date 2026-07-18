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
const STATE_SCHEMA = 1;
const RELOAD_STATE_SCHEMA = 1;
const MAX_RELOAD_SESSIONS = 32;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REFRESH_DEADLINE_MS = 1200;
const LOCK_STALE_MS = 10 * 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const BACKOFF_MS = [60 * 1000, 2 * 60 * 1000, 4 * 60 * 1000, 8 * 60 * 1000, 15 * 60 * 1000];
const REMOTE_URL = 'https://api.github.com/repos/Eigenwise/eigenwise-toolshed/contents/.claude-plugin/marketplace.json?ref=main';

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

function isTaskNotificationPrompt(prompt) {
  const fields = String(prompt || '').match(/^\s*<task-notification>\s*<task-id>[^<\s][^<]*<\/task-id>\s*<tool-use-id>[^<\s][^<]*<\/tool-use-id>\s*<status>(?:completed|failed|stopped)<\/status>\s*<summary>[^<\s][\s\S]*?<\/summary>(?:\s*(?:<result>[\s\S]*?<\/result>|<usage>[\s\S]*?<\/usage>|<output-file>[\s\S]*?<\/output-file>))*\s*<\/task-notification>\s*$/);
  return Boolean(fields);
}

function validState(value) {
  if (!value || value.schema !== STATE_SCHEMA || value.repository !== 'Eigenwise/eigenwise-toolshed' || value.ref !== 'main') return null;
  if (!value.plugins || typeof value.plugins !== 'object' || Array.isArray(value.plugins)) return null;
  if (!Number.isFinite(value.lastSuccess) || !Number.isFinite(value.freshUntil)) return null;
  return value;
}

function readState(fileSystem, stateFile) {
  return validState(readJson(fileSystem, stateFile));
}

function staleInstances(instances, state) {
  if (!state?.plugins) return [];
  return instances.filter((instance) => {
    const remoteVersion = state.plugins[instance.name];
    return remoteVersion && compareSemver(instance.version, remoteVersion) === -1;
  });
}

function blockReason(instances, state) {
  const stale = staleInstances(instances, state);
  if (!stale.length) return null;
  const shown = stale.slice(0, 4).map((instance) => {
    const location = instance.scope === 'user' ? 'user' : `${instance.scope}, ${instance.projectPath || 'unknown project'}`;
    return `${instance.name} ${instance.version} -> ${state.plugins[instance.name]} (${location})`;
  });
  const extra = stale.length > shown.length ? `; +${stale.length - shown.length} more` : '';
  return `Toolshed update required before Claude works on this prompt. Outdated here: ${shown.join('; ')}${extra}. Run /update-toolshed, then /reload-plugins or restart Claude Code. This prompt was not sent to Claude. Update, reload, and /plugin maintenance paths remain allowed.`;
}

function reloadSessionId(input) {
  const value = String(input?.session_id || '');
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

function validReloadState(value) {
  if (!value || value.schema !== RELOAD_STATE_SCHEMA || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) return null;
  const entries = Object.entries(value.sessions);
  if (entries.length > MAX_RELOAD_SESSIONS) return null;
  for (const [sessionId, required] of entries) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || !Number.isFinite(required?.requiredAt) || !Array.isArray(required.plugins) || !required.plugins.length || required.plugins.length > 16) return null;
    if (required.plugins.some((plugin) => typeof plugin?.name !== 'string' || !parseSemver(plugin.version))) return null;
  }
  return value;
}

function readReloadState(fileSystem, reloadStateFile) {
  return validReloadState(readJson(fileSystem, reloadStateFile)) || { schema: RELOAD_STATE_SCHEMA, sessions: {} };
}

function writeReloadState(fileSystem, reloadStateFile, state) {
  writeStateAtomic(fileSystem, reloadStateFile, state);
}

function recordReloadRequired(fileSystem, reloadStateFile, sessionId, stale, now) {
  if (!sessionId || !stale.length) return;
  const state = readReloadState(fileSystem, reloadStateFile);
  const sessions = { ...state.sessions, [sessionId]: { requiredAt: now, plugins: stale.slice(0, 16).map(({ name, version }) => ({ name, version })) } };
  const retained = Object.entries(sessions).sort(([, left], [, right]) => right.requiredAt - left.requiredAt).slice(0, MAX_RELOAD_SESSIONS);
  writeReloadState(fileSystem, reloadStateFile, { schema: RELOAD_STATE_SCHEMA, sessions: Object.fromEntries(retained) });
}

function clearReloadRequired(fileSystem, reloadStateFile, sessionId) {
  if (!sessionId) return;
  const state = readReloadState(fileSystem, reloadStateFile);
  if (!state.sessions[sessionId]) return;
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  writeReloadState(fileSystem, reloadStateFile, { schema: RELOAD_STATE_SCHEMA, sessions });
}

function reloadReason(instances, loadedVersion, reloadState, sessionId) {
  const required = sessionId ? reloadState?.sessions?.[sessionId] : null;
  if (required) {
    const plugins = required.plugins.map(({ name, version }) => `${name} ${version}`).join(', ');
    return `Toolshed plugins were updated, but this session still needs a reload after detecting ${plugins}. Run /reload-plugins or restart Claude Code, then resubmit this prompt. This prompt was not sent to Claude.`;
  }
  const installed = instances.filter((instance) => instance.name === 'workbench').find((instance) => compareSemver(loadedVersion, instance.version) === -1);
  return installed ? `Toolshed plugins were updated, but this session still loaded workbench ${loadedVersion} while the installed version is ${installed.version}. Run /reload-plugins or restart Claude Code, then resubmit this prompt. This prompt was not sent to Claude.` : null;
}

function blockOutput(reason) {
  return reason ? JSON.stringify({ decision: 'block', reason }) : '';
}

function outputFor(instances, state) {
  return blockOutput(blockReason(instances, state));
}

function loadedPluginVersion(fileSystem, pluginRoot) {
  return pluginRoot ? readJson(fileSystem, path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version || null : null;
}

function stateForManifest(manifest, body, previous, now, etag) {
  if (!manifest || manifest.name !== MARKETPLACE || !parseSemver(manifest.version) || !Array.isArray(manifest.plugins)) throw new Error('invalid marketplace manifest');
  const plugins = {};
  for (const plugin of manifest.plugins) {
    if (!plugin || typeof plugin.name !== 'string' || !parseSemver(plugin.version) || plugins[plugin.name]) throw new Error('invalid marketplace plugin');
    plugins[plugin.name] = plugin.version;
  }
  return {
    schema: STATE_SCHEMA,
    repository: 'Eigenwise/eigenwise-toolshed',
    ref: 'main',
    etag: etag || previous?.etag || null,
    manifestSha256: crypto.createHash('sha256').update(body).digest('hex'),
    marketplaceVersion: manifest.version,
    plugins,
    lastAttempt: now,
    lastSuccess: now,
    freshUntil: now + CACHE_TTL_MS,
    retryAfter: 0,
    failureCount: 0,
    failureClass: null,
  };
}

function failedState(previous, now, failureClass) {
  const failureCount = Math.min((previous?.failureCount || 0) + 1, BACKOFF_MS.length);
  return {
    ...(previous || { schema: STATE_SCHEMA, repository: 'Eigenwise/eigenwise-toolshed', ref: 'main', plugins: {}, lastSuccess: 0, freshUntil: 0 }),
    lastAttempt: now,
    retryAfter: now + BACKOFF_MS[failureCount - 1],
    failureCount,
    failureClass,
  };
}

function writeStateAtomic(fileSystem, stateFile, state) {
  const directory = path.dirname(stateFile);
  fileSystem.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(stateFile)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, 'w');
    fileSystem.writeFileSync(descriptor, JSON.stringify(state));
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(temporary, stateFile);
  } finally {
    if (descriptor !== undefined && descriptor !== null) fileSystem.closeSync(descriptor);
    try { fileSystem.unlinkSync(temporary); } catch (_) {}
  }
}

function lockIsStale(fileSystem, lockFile, now) {
  try {
    return now - fileSystem.statSync(lockFile).mtimeMs > LOCK_STALE_MS;
  } catch (_) {
    return false;
  }
}

function acquireLock(fileSystem, lockFile, now) {
  try {
    fileSystem.mkdirSync(lockFile);
    fileSystem.writeFileSync(path.join(lockFile, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now }));
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
    if (!lockIsStale(fileSystem, lockFile, now)) return false;
    try { fileSystem.rmSync(lockFile, { recursive: true, force: true }); } catch (_) { return false; }
    try {
      fileSystem.mkdirSync(lockFile);
      fileSystem.writeFileSync(path.join(lockFile, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now }));
      return true;
    } catch (_) {
      return false;
    }
  }
}

function releaseLock(fileSystem, lockFile) {
  try { fileSystem.rmSync(lockFile, { recursive: true, force: true }); } catch (_) {}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchState({ fetchFn, previous, now, timeoutMs = REFRESH_DEADLINE_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2026-03-10' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    const response = await fetchFn(REMOTE_URL, { headers, signal: controller.signal });
    if (response.status === 304 && previous) return { state: { ...previous, lastAttempt: now, lastSuccess: now, freshUntil: now + CACHE_TTL_MS, retryAfter: 0, failureCount: 0, failureClass: null } };
    if (response.status !== 200) throw new Error(`http-${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) throw new Error('manifest-too-large');
    return { state: stateForManifest(JSON.parse(body), body, previous, now, response.headers.get('etag')) };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshDue(options) {
  const { fileSystem = fs, stateFile, now = () => Date.now(), fetchFn = globalThis.fetch, sleep = delay } = options;
  const lockFile = `${stateFile}.lock`;
  fileSystem.mkdirSync(path.dirname(stateFile), { recursive: true });
  const started = now();
  let state = readState(fileSystem, stateFile);
  if (state?.freshUntil > started || state?.retryAfter > started) return state;
  if (!acquireLock(fileSystem, lockFile, started)) {
    while (now() - started < REFRESH_DEADLINE_MS) {
      await sleep(25);
      state = readState(fileSystem, stateFile);
      if (state?.freshUntil > now() || state?.retryAfter > now() || !fileSystem.existsSync(lockFile)) return state;
    }
    return state;
  }
  try {
    const current = now();
    state = readState(fileSystem, stateFile);
    if (state?.freshUntil > current || state?.retryAfter > current) return state;
    try {
      const result = await fetchState({ fetchFn, previous: state, now: current, timeoutMs: Math.max(1, REFRESH_DEADLINE_MS - (current - started)) });
      writeStateAtomic(fileSystem, stateFile, result.state);
      return result.state;
    } catch (error) {
      const failed = failedState(state, current, error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'network').slice(0, 80));
      writeStateAtomic(fileSystem, stateFile, failed);
      return state;
    }
  } finally {
    releaseLock(fileSystem, lockFile);
  }
}

function stateFileFor(dataDirectory = process.env.CLAUDE_PLUGIN_DATA) {
  return dataDirectory ? path.join(dataDirectory, 'remote-freshness.json') : null;
}

function reloadStateFileFor(dataDirectory = process.env.CLAUDE_PLUGIN_DATA) {
  return dataDirectory ? path.join(dataDirectory, 'reload-required.json') : null;
}

async function decide(input, options = {}) {
  if (process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1' || isMaintenancePrompt(input?.prompt) || isTaskNotificationPrompt(input?.prompt)) return '';
  const fileSystem = options.fileSystem || fs;
  const registryFile = options.registryFile || path.join(options.home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const instances = activeInstances(readJson(fileSystem, registryFile) || {}, input?.cwd, MARKETPLACE, options.platform);
  const loadedVersion = loadedPluginVersion(fileSystem, options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT);
  const sessionId = reloadSessionId(input);
  const reloadStateFile = options.reloadStateFile || reloadStateFileFor(options.dataDirectory);
  const reload = reloadReason(instances, loadedVersion, reloadStateFile ? readReloadState(fileSystem, reloadStateFile) : null, sessionId);
  if (reload) return blockOutput(reload);
  const stateFile = options.stateFile || stateFileFor(options.dataDirectory);
  if (!stateFile) return '';
  let state = readState(fileSystem, stateFile);
  const current = (options.now || Date.now)();
  if (!state || (state.freshUntil <= current && state.retryAfter <= current)) state = await refreshDue({ ...options, fileSystem, stateFile });
  const stale = staleInstances(instances, state);
  if (reloadStateFile) recordReloadRequired(fileSystem, reloadStateFile, sessionId, stale, current);
  return blockOutput(blockReason(instances, state));
}

function sessionStart(input, options = {}) {
  if (!['startup', 'resume'].includes(input?.source)) return;
  const fileSystem = options.fileSystem || fs;
  const reloadStateFile = options.reloadStateFile || reloadStateFileFor(options.dataDirectory);
  if (reloadStateFile) clearReloadRequired(fileSystem, reloadStateFile, reloadSessionId(input));
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (process.argv.includes('--session-start')) sessionStart(input);
    else {
      const output = await decide(input);
      if (output) process.stdout.write(output);
    }
  } catch (_) {
    // Unknown local state and hook failures must not block a user prompt.
  }
}

if (require.main === module) main();

module.exports = {
  BACKOFF_MS,
  CACHE_TTL_MS,
  MAX_RELOAD_SESSIONS,
  MARKETPLACE,
  REFRESH_DEADLINE_MS,
  RELOAD_STATE_SCHEMA,
  STATE_SCHEMA,
  activeInstances,
  blockReason,
  clearReloadRequired,
  compareSemver,
  decide,
  failedState,
  isMaintenancePrompt,
  isTaskNotificationPrompt,
  loadedPluginVersion,
  outputFor,
  parseSemver,
  readReloadState,
  readState,
  refreshDue,
  reloadReason,
  reloadSessionId,
  reloadStateFileFor,
  sessionStart,
  stateForManifest,
  staleInstances,
  writeStateAtomic,
};
