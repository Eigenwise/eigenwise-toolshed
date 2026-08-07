#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const MARKETPLACE_URL = 'https://raw.githubusercontent.com/Eigenwise/eigenwise-toolshed/main/.claude-plugin/marketplace.json';
const REQUEST_TIMEOUT_MS = 5_000;

function cacheFile(home = os.homedir()) {
  return path.join(home, '.claude', 'eigenwise-toolshed', 'marketplace-freshness.json');
}

function readCache(fileSystem = fs, home = os.homedir()) {
  try {
    return JSON.parse(fileSystem.readFileSync(cacheFile(home), 'utf8'));
  } catch (_) {
    return null;
  }
}

function cacheIsCurrent(cache, now = Date.now()) {
  const checkedAt = Date.parse(cache?.checkedAt || '');
  return Number.isFinite(checkedAt) && now - checkedAt >= 0 && now - checkedAt < CACHE_MAX_AGE_MS;
}

function requestManifest(request = https.get) {
  return new Promise((resolve, reject) => {
    const response = request(MARKETPLACE_URL, { headers: { accept: 'application/json' } }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        if (incoming.statusCode !== 200) {
          reject(new Error(`unexpected status ${incoming.statusCode}`));
          return;
        }
        try {
          const manifest = JSON.parse(body);
          if (!Array.isArray(manifest.plugins)) throw new Error('plugins array missing');
          resolve(manifest);
        } catch (error) {
          reject(error);
        }
      });
    });
    response.setTimeout(REQUEST_TIMEOUT_MS, () => response.destroy(new Error('request timed out')));
    response.on('error', reject);
  });
}

function writeCache(cache, fileSystem = fs, home = os.homedir()) {
  const destination = cacheFile(home);
  fileSystem.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, 'utf8');
  fileSystem.renameSync(temporary, destination);
}

async function refreshCache(options = {}) {
  const now = options.now ?? Date.now();
  const existing = readCache(options.fileSystem, options.home);
  if (cacheIsCurrent(existing, now)) return existing;
  try {
    const manifest = await (options.requestManifest || requestManifest)();
    const cache = { checkedAt: new Date(now).toISOString(), manifest };
    writeCache(cache, options.fileSystem, options.home);
    return cache;
  } catch (_) {
    const cache = { checkedAt: new Date(now).toISOString(), unavailable: true };
    try {
      writeCache(cache, options.fileSystem, options.home);
    } catch (_) {
      // The prompt guard still treats an unwritable cache as unknown.
    }
    return cache;
  }
}

async function main() {
  process.stdout.write(`${JSON.stringify({ async: true, asyncTimeout: REQUEST_TIMEOUT_MS + 1_000 })}\n`);
  await refreshCache();
}

if (require.main === module) main();

module.exports = {
  CACHE_MAX_AGE_MS,
  MARKETPLACE_URL,
  REQUEST_TIMEOUT_MS,
  cacheFile,
  cacheIsCurrent,
  readCache,
  refreshCache,
  requestManifest,
  writeCache,
};
