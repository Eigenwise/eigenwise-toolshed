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

function writeCatalog(models, catalog = { schemaVersion: 3, source: 'codex-gateway' }) {
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

test('discovery accepts catalog v2 migration input', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }], {
    schema: 2,
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

function writeSwitchboardFixture() {
  const discoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-switchboard-registry-'));
  const pluginRoot = path.join(discoveryRoot, 'installed-switchboard');
  fs.mkdirSync(path.join(discoveryRoot, 'toolshed', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'lib', 'contract.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(pluginRoot, 'lib', 'mcp.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(pluginRoot, 'dashboard', 'panel.js'), 'window.SwitchboardPanel = {};\n');
  fs.writeFileSync(path.join(pluginRoot, 'bin', 'switchboard.js'), `
const requestAt = process.argv.indexOf('--request');
const request = JSON.parse(process.argv[requestAt + 1]);
if (process.env.SQ_FAKE_SWITCHBOARD_INVALID === '1') {
  process.stdout.write('{bad');
} else {
  process.stdout.write(JSON.stringify({
    contractVersion: 1,
    status: 'routed',
    category: { id: request.categoryId, contract: 'Run the fixture.' },
    route: { model: process.env.SQ_FAKE_SWITCHBOARD_MODEL || 'sonnet', effort: 'high', source: 'primary' },
    dispatch: { kind: 'native', spawnModel: process.env.SQ_FAKE_SWITCHBOARD_MODEL || 'sonnet' },
    attempts: [],
    warnings: []
  }));
}
`);
  fs.writeFileSync(path.join(discoveryRoot, 'toolshed', 'registry', 'switchboard.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'switchboard',
    version: '0.10.0',
    root: pluginRoot,
    capabilities: ['routing', 'categories'],
    routing: { contractVersion: 1, command: 'bin/switchboard.js routing resolve --request <json>', adapter: 'lib/contract.js' },
    ui: { contractVersion: 1, panels: [{ id: 'routing', label: 'Routing', entry: 'dashboard/panels/routing.js', capability: 'routing' }] },
  }));
  return { discoveryRoot, pluginRoot };
}

test('discovers and independently validates Switchboard contract v1', { concurrency: false }, () => {
  const fixture = writeSwitchboardFixture();
  process.env.SIDEQUEST_DISCOVERY_DIRS = fixture.discoveryRoot;
  discovery.clearSwitchboardCache();
  const found = discovery.discoverSwitchboard();
  assert.equal(found.available, true);
  assert.equal(found.contractVersion, 1);
  assert.equal(found.panel.available, true);
  assert.equal(found.panel.file, path.join(fixture.pluginRoot, 'dashboard', 'panel.js'));
  assert.match(found.diagnostics.join(' '), /contract v1 dashboard\/panel\.js fallback/);

  const resolved = discovery.resolveThroughSwitchboard({ categoryId: 'general', projectPath: fixture.discoveryRoot });
  assert.equal(resolved.status, 'routed');
  assert.deepEqual(resolved.result.route, { model: 'sonnet', effort: 'high', source: 'primary' });
});

test('rejects invalid Switchboard results without throwing into ticket reads', { concurrency: false }, () => {
  const fixture = writeSwitchboardFixture();
  process.env.SIDEQUEST_DISCOVERY_DIRS = fixture.discoveryRoot;
  process.env.SQ_FAKE_SWITCHBOARD_INVALID = '1';
  discovery.clearSwitchboardCache();
  try {
    const resolved = discovery.resolveThroughSwitchboard({ categoryId: 'general' });
    assert.equal(resolved.status, 'incompatible');
    assert.match(resolved.diagnostics.join(' '), /invalid JSON/);
  } finally {
    delete process.env.SQ_FAKE_SWITCHBOARD_INVALID;
  }
});

test('rejects future Switchboard registry contracts independently', { concurrency: false }, () => {
  const fixture = writeSwitchboardFixture();
  process.env.SIDEQUEST_DISCOVERY_DIRS = fixture.discoveryRoot;
  const registry = path.join(fixture.discoveryRoot, 'toolshed', 'registry', 'switchboard.json');
  const value = JSON.parse(fs.readFileSync(registry, 'utf8'));
  value.routing.contractVersion = 2;
  fs.writeFileSync(registry, JSON.stringify(value));
  const found = discovery.discoverSwitchboard();
  assert.equal(found.available, false);
  assert.equal(found.status, 'incompatible');
  assert.match(found.diagnostics.join(' '), /supported contract v1/);
});
