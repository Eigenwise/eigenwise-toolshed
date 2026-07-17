'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-home-'));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
const discovery = require('../lib/discovery.js');
const store = require('../lib/store.js');

function writeCatalog(models, catalog = { schema: 2 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-'));
  const dir = path.join(root, 'codex-gateway');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ ...catalog, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
}

test('missing and malformed catalogs fail soft', () => {
  assert.deepEqual(discovery.discoverExternalModels(), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-bad-'));
  fs.mkdirSync(path.join(root, 'codex-gateway'));
  fs.writeFileSync(path.join(root, 'codex-gateway', 'catalog.json'), '{bad');
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('discovery validates concrete catalog identity and drops routing hints', () => {
  writeCatalog([
    { slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test', suggestedTier: 'ignored' },
    { slug: 'Bad Slug', id: 'bad' },
    { slug: 'missing-id' },
  ]);
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test', source: 'codex-gateway',
  }]);
});

test('discovery accepts catalog v3 during the v2 migration window', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }], {
    schemaVersion: 3,
    source: 'codex-gateway',
    updatedAt: new Date().toISOString(),
  });
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test', source: 'codex-gateway',
  }]);
});

test('discovery ignores future catalog schemas', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }], { schemaVersion: 4 });
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('concrete discovered route resolves while an absent route is unavailable', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }]);
  assert.equal(store.resolveExec('codex-gpt-test', 'high').runsModel, 'codex-gpt-test');
  assert.equal(store.resolveExec('missing-model', 'high'), null);
  assert.equal(store.classifyModelFilter('missing-model'), 'unknown');
});
