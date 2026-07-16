'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-routing-test-'));
const emptyDiscovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-routing-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = emptyDiscovery;
const store = require('../lib/store.js');

function seedCatalog(models) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-routing-catalog-'));
  const dir = path.join(root, 'codex-gateway');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
}

test('model vocabulary contains Claude runtimes and discovered concrete models', () => {
  seedCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }]);
  assert.deepEqual(store.getModelVocab().models, ['haiku', 'sonnet', 'opus', 'fable', 'codex-gpt-test']);
  assert.equal(store.classifyModelFilter('opus'), 'opus');
  assert.equal(store.classifyModelFilter('codex-gpt-test'), 'codex-gpt-test');
  assert.equal(store.classifyModelFilter('missing'), 'unknown');
});

test('resolveExec is keyed directly by concrete model and effort', () => {
  seedCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }]);
  assert.deepEqual(store.resolveExec('opus', 'high'), {
    agent: 'sidequest-exec-high', model: 'opus', spawnId: 'opus', backend: 'claude', slug: 'opus',
    runsModel: 'opus', runsLabel: 'Claude Opus', dispatch: 'native-agent',
  });
  const codex = store.resolveExec('codex-gpt-test', 'xhigh');
  assert.equal(codex.agent, 'sidequest-exec-dispatch-xhigh');
  assert.equal(codex.model, null);
  assert.equal(codex.spawnId, 'claude-codex-test');
  assert.equal(codex.dispatchModel, 'test');
  assert.equal(codex.runsModel, 'codex-gpt-test');
});

test('models payload contains resolved category policy without grade vocabulary', () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-luna', id: 'claude-codex-luna', label: 'Luna' }]);
  const payload = store.modelsPayload();
  assert.ok(payload.categories.length);
  assert.deepEqual(payload.globalFallback, { model: 'sonnet', effort: 'high' });
  assert.doesNotMatch(JSON.stringify(payload), /grade-[1-4]|tierBackend|routingLadder|routingBias|profiles/);
  assert.ok(payload.categories.every((category) => category.resolved && category.resolved.model));
});
