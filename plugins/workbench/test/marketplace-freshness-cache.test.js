'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CACHE_MAX_AGE_MS,
  cacheIsCurrent,
  readCache,
  refreshCache,
} = require('../hooks/marketplace-freshness-cache.js');

test('refreshes a stale cache with the remote marketplace manifest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const manifest = { plugins: [{ name: 'sidequest', version: '4.35.0' }] };
    const cache = await refreshCache({
      home,
      now: 1_000,
      requestManifest: async () => manifest,
    });
    assert.deepEqual(cache.manifest, manifest);
    assert.deepEqual(readCache(fs, home).manifest, manifest);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('keeps a current cache without another remote request', async () => {
  const cache = {
    checkedAt: new Date(1_000).toISOString(),
    manifest: { plugins: [] },
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const result = await refreshCache({
      home,
      now: 1_001,
      requestManifest: async () => { throw new Error('must not request'); },
      fileSystem: {
        ...fs,
        readFileSync: () => JSON.stringify(cache),
      },
    });
    assert.deepEqual(result, cache);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('records a failed remote request as unavailable for the cache lifetime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-freshness-'));
  try {
    const cache = await refreshCache({
      home,
      now: 1_000,
      requestManifest: async () => { throw new Error('offline'); },
    });
    assert.equal(cache.unavailable, true);
    assert.equal(cache.manifest, undefined);
    assert.equal(cacheIsCurrent(cache, 1_000 + CACHE_MAX_AGE_MS - 1), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
