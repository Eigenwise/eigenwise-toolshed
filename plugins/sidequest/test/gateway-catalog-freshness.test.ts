import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
'use strict';
/**
 * SQ-2199. Long suites seed one fake model-gateway catalog at module load and then run for longer than
 * CATALOG_STALE_MS, so by their later tests the catalog reads as absent and every codex route starts
 * refusing. This file reproduces that end state directly, by stamping its catalog outside the window
 * before any test runs, and proves the shared freshness hook puts it back inside.
 *
 * Run: node --import tsx --test plugins/sidequest/test/gateway-catalog-freshness.test.ts
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGED_PAST_THE_WINDOW_MILLISECONDS = 6 * 60 * 1000;
const catalogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-catalog-freshness-'));
fs.mkdirSync(path.join(catalogDirectory, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(catalogDirectory, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  updatedAt: new Date(Date.now() - AGED_PAST_THE_WINDOW_MILLISECONDS).toISOString(),
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [{ id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }],
}));
process.env.SIDEQUEST_DISCOVERY_DIRS = catalogDirectory;

const discovery = require('../lib/discovery.js');

test('SQ-2199: a fixture catalog that aged out of the stale window is usable again by the next test', () => {
  assert.equal(
    discovery.providerReadiness('codex')?.ready,
    true,
    'a seeded catalog must keep answering for readiness however long the suite has already been running',
  );
  assert.deepEqual(discovery.discoverExternalModels().map((model: { slug: string }) => model.slug), ['codex-gpt-5-6-terra']);
});

test('SQ-2199: re-stamping does not invent a catalog where a test asked for none', () => {
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-catalog-freshness-none-'));
  process.env.SIDEQUEST_DISCOVERY_DIRS = emptyDirectory;
  assert.equal(discovery.providerReadiness('codex'), null);
  assert.deepEqual(discovery.discoverExternalModels(), []);
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalogDirectory;
});

export {};
