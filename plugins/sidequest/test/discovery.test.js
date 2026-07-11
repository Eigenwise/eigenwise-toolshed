'use strict';
/**
 * External model catalog discovery (lib/discovery.js) and its integration into
 * store.js's per-tier backend resolution. Catalog schema 2 carries
 * {slug,id,label,suggestedTier}; discovery validates it and store maps a tier
 * onto a discovered model.
 * Run: node --test "plugins/sidequest/test/**\/*.test.js"
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Throwaway home so pref reads/writes never touch the real one.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-home-'));
// Start with no discovery root at all (no catalog anywhere).
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const { discoverExternalModels } = require('../lib/discovery.js');
const store = require('../lib/store.js');
const { getModelPrefs, setModelPrefs, routingLadder } = store;

function writeCatalogRaw(dir, body) {
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), body);
}

// Seed a schema-2 catalog and point discovery at it.
function seedCatalog(models, schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schema: schema || 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}

function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}

const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', suggestedTier: 'fable' };
const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'opus' };
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'haiku' };

/* -------------------------------------------------------------- *
 *  discoverExternalModels() in isolation
 * -------------------------------------------------------------- */

test('no catalog anywhere -> []', () => {
  clearCatalog();
  assert.deepStrictEqual(discoverExternalModels(), []);
});

test('a valid schema-2 catalog resolves to [{slug,id,label,suggestedTier,source}]', () => {
  seedCatalog([TERRA]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0], { slug: TERRA.slug, id: TERRA.id, label: TERRA.label, suggestedTier: 'opus', source: 'codex-gateway' });
});

test('suggestedTier missing/invalid -> null (still discovered)', () => {
  seedCatalog([{ slug: 'codex-x', id: 'claude-codex-x[1m]', label: 'X' }, { slug: 'codex-y', id: 'claude-codex-y[1m]', label: 'Y', suggestedTier: 'bogus' }]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].suggestedTier, null);
  assert.strictEqual(got[1].suggestedTier, null);
});

test('legacy schema-1 anchor field is read as suggestedTier', () => {
  seedCatalog([{ slug: 'codex-old', id: 'claude-codex-old[1m]', label: 'Old', anchor: 'opus' }], 1);
  assert.strictEqual(discoverExternalModels()[0].suggestedTier, 'opus');
});

test('label falls back to slug when absent', () => {
  seedCatalog([{ slug: 'codex-nolabel', id: 'claude-codex-nolabel[1m]', suggestedTier: 'haiku' }]);
  assert.strictEqual(discoverExternalModels()[0].label, 'codex-nolabel');
});

test('malformed JSON body -> [] (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-bad-'));
  writeCatalogRaw(dir, '{ not json');
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  assert.deepStrictEqual(discoverExternalModels(), []);
});

test('individual bad entries skipped, good ones survive', () => {
  seedCatalog([{ slug: 'BAD SLUG', id: 'x' }, { id: 'no-slug[1m]' }, TERRA]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].slug, TERRA.slug);
});

test('duplicate slugs across the catalog -> first wins', () => {
  seedCatalog([TERRA, Object.assign({}, TERRA, { label: 'Dupe' })]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].label, 'GPT-5.6 Terra');
});

/* -------------------------------------------------------------- *
 *  store integration: per-tier backend
 * -------------------------------------------------------------- */

test('no catalog -> discovered=[], every tier "claude", ladder built-in only', () => {
  clearCatalog();
  const prefs = getModelPrefs();
  assert.deepStrictEqual(prefs.discovered, []);
  assert.deepStrictEqual(prefs.tierBackend, { opus: 'claude', sonnet: 'claude', haiku: 'claude', fable: 'claude' });
  // every ladder rung is a built-in tier
  for (const rung of routingLadder(prefs)) {
    assert.ok(['opus', 'sonnet', 'haiku', 'fable'].includes(rung.model), `rung ${rung.model} is a built-in`);
  }
});

test('mapping a tier to a discovered slug: resolveExec routes to its agent, ladder shape unchanged', () => {
  seedCatalog([TERRA, SOL, LUNA]);
  const prefs = setModelPrefs({ tierBackend: { opus: 'codex-gpt-5-6-terra' } });
  assert.strictEqual(prefs.tierBackend.opus, 'codex-gpt-5-6-terra');
  assert.deepStrictEqual(prefs.tierBackendWarnings, []);
  const ex = store.resolveExec('opus', 'high', prefs);
  assert.strictEqual(ex.agent, 'sidequest-exec-codex-gpt-5-6-terra-high');
  assert.strictEqual(ex.model, null);
  assert.strictEqual(ex.backend, 'codex');
  assert.strictEqual(ex.spawnId, TERRA.id);
  // sonnet still Claude
  assert.strictEqual(store.resolveExec('sonnet', 'high', prefs).backend, 'claude');
  // ladder still stamps the tier, not the backend slug
  assert.strictEqual(routingLadder(prefs).find((r) => r.model !== 'haiku' && r.effort === 'high' && r.model === 'opus') !== undefined, true);
});

test('stale mapping (slug not in catalog) falls back to Claude with a warning', () => {
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { fable: 'codex-gone' } });
  assert.ok(prefs.tierBackendWarnings.some((w) => w.includes('fable') && w.includes('codex-gone')));
  assert.strictEqual(store.resolveExec('fable', 'high', prefs).backend, 'claude');
});

test('clearing a mapping back to claude', () => {
  seedCatalog([TERRA]);
  setModelPrefs({ tierBackend: { opus: 'codex-gpt-5-6-terra' } });
  const prefs = setModelPrefs({ tierBackend: { opus: 'claude' } });
  assert.strictEqual(prefs.tierBackend.opus, 'claude');
  assert.strictEqual(store.resolveExec('opus', 'high', prefs).backend, 'claude');
});

test('a stale 1.35.0 customOverrides file is stripped on read, tierBackend defaults', () => {
  clearCatalog();
  const dir = process.env.SIDEQUEST_HOME;
  const prefsFile = path.join(dir, 'projects', 'model-prefs.json');
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  fs.writeFileSync(prefsFile, JSON.stringify({ opus: true, sonnet: true, haiku: true, fable: true, routing: true, customOverrides: { 'codex-x': { enabled: true } }, custom: [{ slug: 'codex-x' }] }));
  const prefs = getModelPrefs();
  assert.strictEqual(prefs.customOverrides, undefined);
  assert.strictEqual(prefs.custom, undefined);
  // and the file no longer has them
  const onDisk = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  assert.strictEqual('customOverrides' in onDisk, false);
  assert.strictEqual('custom' in onDisk, false);
});
