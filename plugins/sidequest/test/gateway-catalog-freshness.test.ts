import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
'use strict';
/**
 * SQ-2937. Fixture catalogs have no gateway refresh source, so their recorded catalog remains usable even
 * after the installed gateway's freshness window. The isolated Claude home in _gateway-catalog-freshness.ts
 * keeps this test from touching the developer's gateway install.
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

test('SQ-2937: a fixture catalog never invokes the installed gateway refresh command', (t) => {
  const previousClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const gatewayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-catalog-refresh-probe-'));
  const marker = path.join(gatewayHome, 'refresh-called');
  const command = path.join(gatewayHome, 'plugins', 'model-gateway', 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  fs.mkdirSync(path.join(gatewayHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(gatewayHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'model-gateway@eigenwise-toolshed': [{ installPath: path.dirname(path.dirname(command)), version: '0.1.0' }] },
  }));
  process.env.SIDEQUEST_CLAUDE_HOME = gatewayHome;
  t.after(() => { process.env.SIDEQUEST_CLAUDE_HOME = previousClaudeHome; });

  assert.deepEqual(discovery.discoverExternalModels().map((model: { slug: string }) => model.slug), ['codex-gpt-5-6-terra']);
  assert.equal(fs.existsSync(marker), false);
});

test('SQ-2937: an empty fixture root does not invent a catalog', () => {
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-catalog-freshness-none-'));
  process.env.SIDEQUEST_DISCOVERY_DIRS = emptyDirectory;
  assert.equal(discovery.providerReadiness('codex'), null);
  assert.deepEqual(discovery.discoverExternalModels(), []);
  process.env.SIDEQUEST_DISCOVERY_DIRS = catalogDirectory;
});

export {};
