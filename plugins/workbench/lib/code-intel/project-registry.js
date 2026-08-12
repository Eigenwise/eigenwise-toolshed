'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createLspClient } = require('./lsp-client');
const { locateLanguageServer } = require('./language-server-locator');

const DEFAULT_IDLE_LIMIT_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const IDLE_LIMIT_ENV = 'WORKBENCH_CODE_INTEL_IDLE_MS';
const SWEEP_INTERVAL_ENV = 'WORKBENCH_CODE_INTEL_SWEEP_MS';

const clients = new Map();
let sweepTimer = null;

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rootKey(realRootDir) {
  return process.platform === 'win32' ? realRootDir.toLowerCase() : realRootDir;
}

function canonicalizeRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || !rawRoot.trim()) {
    return { error: 'root is required: pass the absolute project root this request binds to.' };
  }
  const resolved = path.resolve(rawRoot.trim());
  let realRootDir;
  try {
    realRootDir = fs.realpathSync.native(resolved);
  } catch {
    return { error: `project root does not exist: ${resolved}. If this was a temporary worktree it may have been removed; bind requests to a root that is still on disk.` };
  }
  let stat;
  try {
    stat = fs.statSync(realRootDir);
  } catch {
    return { error: `project root is not readable: ${realRootDir}` };
  }
  if (!stat.isDirectory()) {
    return { error: `project root is not a directory: ${realRootDir}` };
  }
  return { rootDir: realRootDir, key: rootKey(realRootDir) };
}

// A swept worktree on Windows can survive as a locked, file-less husk while the
// language server's watchers hold directory handles, so "no files left at the
// top level" counts as removed and releases those handles for the next sweep.
function rootLooksRemoved(rootDir) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return true;
  }
  return entries.length === 0 || !entries.some((entry) => entry.isFile());
}

function sweep() {
  const idleLimitMs = positiveIntegerEnv(IDLE_LIMIT_ENV, DEFAULT_IDLE_LIMIT_MS);
  for (const [key, entry] of clients) {
    if (!entry.client.isAlive()) {
      clients.delete(key);
      continue;
    }
    if (rootLooksRemoved(entry.rootDir)) {
      entry.client.kill('project root removed');
      clients.delete(key);
      continue;
    }
    if (Date.now() - entry.client.lastUsedAt() > idleLimitMs) {
      entry.client.kill('idle');
      clients.delete(key);
    }
  }
  if (clients.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function ensureSweepTimer() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, positiveIntegerEnv(SWEEP_INTERVAL_ENV, DEFAULT_SWEEP_INTERVAL_MS));
  sweepTimer.unref();
}

// Pyright's key includes its resolved interpreter, so package environments under one
// bound root retain independent clients. Sweep and eviction stay per client entry.
function clientKey(root, language, serverKey = '') {
  return `${root}\u0000${language}\u0000${serverKey}`;
}

function clientForRoot(rawRoot, language = 'typescript', filePath) {
  const canonical = canonicalizeRoot(rawRoot);
  if (canonical.error) {
    sweep();
    return canonical;
  }
  const recipe = locateLanguageServer(language, canonical.rootDir, process.env, filePath);
  if (recipe.error) return { error: recipe.error };
  const key = clientKey(canonical.key, language, recipe.serverKey);
  const existing = clients.get(key);
  if (existing && existing.client.isAlive()) {
    existing.client.touch();
    return { client: existing.client, rootDir: canonical.rootDir };
  }
  if (existing) clients.delete(key);
  const client = createLspClient({
    rootDir: canonical.rootDir,
    recipe,
    onExit: () => {
      const entry = clients.get(key);
      if (entry && entry.client === client) clients.delete(key);
    },
  });
  clients.set(key, { client, rootDir: canonical.rootDir });
  ensureSweepTimer();
  return { client, rootDir: canonical.rootDir };
}

function activeRootCount() {
  return clients.size;
}

function shutdownAll() {
  for (const [key, entry] of clients) {
    entry.client.kill('code-intel server shutting down');
    clients.delete(key);
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  canonicalizeRoot,
  clientForRoot,
  sweep,
  shutdownAll,
  activeRootCount,
  DEFAULT_IDLE_LIMIT_MS,
  IDLE_LIMIT_ENV,
  SWEEP_INTERVAL_ENV,
};
