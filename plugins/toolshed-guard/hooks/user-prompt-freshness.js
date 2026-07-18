#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKETPLACE = 'eigenwise-toolshed';
const STATE_SCHEMA = 1;
const CACHE_TTL_MS = 10 * 60 * 1000;
const REFRESH_DEADLINE_MS = 1200;
const LOCK_STALE_MS = 10 * 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const BACKOFF_MS = [60 * 1000, 2 * 60 * 1000, 4 * 60 * 1000, 8 * 60 * 1000, 15 * 60 * 1000];
const REMOTE_URL = 'https://api.github.com/repos/Eigenwise/eigenwise-toolshed/contents/.claude-plugin/marketplace.json?ref=main';

function pluginIdParts(id) {
  const index = String(id || '').lastIndexOf('@');
  return index > 0 ? { name: id.slice(0, index), marketplace: id.slice(index + 1) } : null;
}

function parseSemver(value) {
  const match = String(value || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]+))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]);
    const bNumber = /^\d+$/.test(b.prerelease[index]);
    if (aNumber && bNumber) return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function normalizePath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return null;
  const api = platform === 'win32' ? path.win32 : path;
  return api.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function activeInstances(registry, cwd, platform = process.platform) {
  const sessionPath = normalizePath(cwd, platform);
  const instances = [];
  for (const [id, installs] of Object.entries(registry?.plugins || {})) {
    const parts = pluginIdParts(id);
    if (!parts || parts.marketplace !== MARKETPLACE || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!install || !['user', 'project', 'local'].includes(install.scope)) continue;
      if (install.scope === 'user') {
        instances.push({ id, name: parts.name, ...install });
        continue;
      }
      const projectPath = normalizePath(install.projectPath, platform);
      if (sessionPath && projectPath && pathsOverlap(sessionPath, projectPath)) instances.push({ id, name: parts.name, ...install });
    }
  }
  return instances;
}

function hasPluginInstall(registry, name, scope) {
  const installs = registry?.plugins?.[`${name}@${MARKETPLACE}`];
  return Array.isArray(installs) && installs.some((install) => install && (!scope || install.scope === scope));
}

function isMaintenancePrompt(prompt) {
  const value = String(prompt || '').trim();
  if (/^\/(?:workbench:)?update-toolshed(?:\s+[\w.-]+)*$/i.test(value)) return true;
  if (/^\/reload-plugins(?:\s+--force)?$/i.test(value)) return true;
  if (/^\/plugin$/i.test(value)) return true;
  if (/^\/plugin\s+(?:install|update|enable|disable|remove|uninstall)(?:\s+[^\s]+){0,4}$/i.test(value)) return true;
  if (/^\/plugin\s+marketplace\s+(?:add|update|remove)(?:\s+[^\s]+){0,3}$/i.test(value)) return true;
  if (/^claude\s+plugin\s+marketplace\s+update\s+eigenwise-toolshed$/i.test(value)) return true;
  return /^claude\s+plugin\s+update\s+[\w.-]+@eigenwise-toolshed(?:\s+--scope\s+(?:user|project|local))?$/i.test(value);
}

function isTaskNotificationPrompt(prompt) {
  const source = String(prompt || '');
  const allowedFields = new Set(['task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note', 'result', 'usage', 'worktree']);
  const values = new Map();
  const stack = [];
  const tags = /<(\/)?([a-z][a-z0-9-]*)>/g;
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;
  let match;
  while ((match = tags.exec(source))) {
    const text = source.slice(cursor, match.index);
    if (text.includes('<') || (stack.length === 1 && stack[0].name === 'task-notification' && text.trim())) return false;
    cursor = tags.lastIndex;
    const closing = Boolean(match[1]);
    const name = match[2];
    if (!closing) {
      if (!stack.length) {
        if (name !== 'task-notification' || rootSeen || source.slice(0, match.index).trim()) return false;
        rootSeen = true;
      } else if (stack.length === 1 && stack[0].name === 'task-notification') {
        if (!allowedFields.has(name) || values.has(name)) return false;
      } else if (name === 'task-notification') {
        return false;
      }
      stack.push({ name, valueStart: tags.lastIndex });
      continue;
    }
    const field = stack.pop();
    if (!field || field.name !== name) return false;
    if (stack.length === 1 && stack[0].name === 'task-notification') values.set(name, source.slice(field.valueStart, match.index));
    if (name === 'task-notification') {
      if (stack.length || rootClosed || source.slice(tags.lastIndex).trim()) return false;
      rootClosed = true;
    }
  }
  if (source.slice(cursor).includes('<') || !rootClosed || stack.length) return false;
  const taskId = values.get('task-id');
  const toolUseId = values.get('tool-use-id');
  const status = values.get('status');
  const summary = values.get('summary');
  return Boolean(taskId?.trim() && toolUseId?.trim() && summary?.trim())
    && !/[<]/.test(taskId)
    && !/[<]/.test(toolUseId)
    && !/[<]/.test(summary)
    && ['completed', 'failed', 'stopped'].includes(status?.trim());
}

function readJson(fileSystem, file) {
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
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

function blockReason(instances, state, workspaceInitInstalled) {
  const stale = staleInstances(instances, state);
  if (!stale.length) return null;
  const shown = stale.slice(0, 4).map((instance) => {
    const location = instance.scope === 'user' ? 'user' : `${instance.scope}, ${instance.projectPath || 'unknown project'}`;
    return `${instance.name} ${instance.version} -> ${state.plugins[instance.name]} (${location})`;
  });
  const extra = stale.length > shown.length ? `; +${stale.length - shown.length} more` : '';
  const recovery = workspaceInitInstalled ? '/update-toolshed' : '/plugin install workbench@eigenwise-toolshed --scope user';
  return `Toolshed update required before Claude works on this prompt. Outdated here: ${shown.join('; ')}${extra}. Run ${recovery}, then /reload-plugins or restart Claude Code. If ordinary reload is refused after plugin MCP state changes, retry with /reload-plugins --force. This prompt was not sent to Claude. Update, reload, and /plugin maintenance paths remain allowed.`;
}

function reloadReason(instances, loadedVersion) {
  const installed = instances.filter((instance) => instance.name === 'toolshed-guard').find((instance) => compareSemver(loadedVersion, instance.version) === -1);
  return installed ? `Toolshed plugins were updated, but this session still loaded toolshed-guard ${loadedVersion} while the installed version is ${installed.version}. Run /reload-plugins or restart Claude Code. If ordinary reload is refused after plugin MCP state changes, retry with /reload-plugins --force, then resubmit this prompt. This prompt was not sent to Claude.` : null;
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

async function decide(input, options = {}) {
  if (isTaskNotificationPrompt(input?.prompt)) return '';
  if (process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1' || isMaintenancePrompt(input?.prompt)) return '';
  const fileSystem = options.fileSystem || fs;
  const registryFile = options.registryFile || path.join(options.home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const registry = readJson(fileSystem, registryFile) || {};
  if (hasPluginInstall(registry, 'workbench', 'user')) return '';
  const instances = activeInstances(registry, input?.cwd, options.platform);
  const workspaceInitInstalled = hasPluginInstall(registry, 'workspace-init');
  const loadedVersion = loadedPluginVersion(fileSystem, options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT);
  const reload = reloadReason(instances, loadedVersion);
  if (reload) return blockOutput(reload);
  const stateFile = options.stateFile || stateFileFor(options.dataDirectory);
  if (!stateFile) return '';
  let state = readState(fileSystem, stateFile);
  const current = (options.now || Date.now)();
  if (!state || (state.freshUntil <= current && state.retryAfter <= current)) state = await refreshDue({ ...options, fileSystem, stateFile });
  return blockOutput(blockReason(instances, state, workspaceInitInstalled));
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const output = await decide(input);
    if (output) process.stdout.write(output);
  } catch (_) {
    // Unknown local state and hook failures must not block a user prompt.
  }
}

if (require.main === module) main();

module.exports = {
  BACKOFF_MS,
  CACHE_TTL_MS,
  MARKETPLACE,
  REFRESH_DEADLINE_MS,
  STATE_SCHEMA,
  activeInstances,
  blockReason,
  compareSemver,
  decide,
  failedState,
  hasPluginInstall,
  isMaintenancePrompt,
  isTaskNotificationPrompt,
  loadedPluginVersion,
  outputFor,
  parseSemver,
  readState,
  refreshDue,
  reloadReason,
  stateForManifest,
  staleInstances,
  writeStateAtomic,
};
