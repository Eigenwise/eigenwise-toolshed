'use strict';
/**
 * External model catalog discovery (SQ-157): lib/discovery.js on its own,
 * plus its integration into store.js's getModelPrefs/setModelPrefs/
 * routingLadder pipeline.
 * Run: node --test "plugins/sidequest/test/**\/*.test.js"
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Throwaway home so pref reads/writes never touch the real one.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-home-'));
// Start with no discovery root at all (no catalog anywhere) — tests below
// point SIDEQUEST_DISCOVERY_DIRS at their own fake catalog as needed.
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const { discoverExternalModels } = require('../lib/discovery.js');
const store = require('../lib/store.js');
const { getModelPrefs, setModelPrefs, routingLadder } = store;

// Write a fake codex-gateway catalog file directly (bypassing the usual
// {schema,source,updatedAt,models} envelope helper below when a test wants
// to hand-craft a malformed body).
function writeCatalogRaw(dir, body) {
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), body);
}

function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schema: 1, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}

function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}

/* -------------------------------------------------------------- *
 *  discoverExternalModels() — the module in isolation
 * -------------------------------------------------------------- */

test('discoverExternalModels: no catalog anywhere -> []', () => {
  clearCatalog();
  assert.deepStrictEqual(discoverExternalModels(), []);
});

test('discoverExternalModels: missing catalog file under an existing root -> [] (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-nofile-'));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir; // dir exists, but no codex-gateway/catalog.json inside it
  assert.deepStrictEqual(discoverExternalModels(), []);
  clearCatalog();
});

test('discoverExternalModels: a valid catalog resolves to [{slug,id,label,anchor,source}]', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol', anchor: 'opus' }]);
  const found = discoverExternalModels();
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0], {
    slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol', anchor: 'opus', source: 'codex-gateway',
  });
  clearCatalog();
});

test('discoverExternalModels: label falls back to slug when absent', () => {
  seedCatalog([{ slug: 'no-label', id: 'x', anchor: 'sonnet' }]);
  const found = discoverExternalModels();
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].label, 'no-label');
  clearCatalog();
});

test('discoverExternalModels: malformed JSON body -> [] (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-badjson-'));
  writeCatalogRaw(dir, '{ this is not valid json');
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  assert.deepStrictEqual(discoverExternalModels(), []);
  clearCatalog();
});

test('discoverExternalModels: non-array models / non-object root -> [] (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-badshape-'));
  writeCatalogRaw(dir, JSON.stringify({ schema: 1, source: 'codex-gateway', models: 'not-an-array' }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  assert.deepStrictEqual(discoverExternalModels(), []);
  clearCatalog();
});

test('discoverExternalModels: individual bad entries are skipped, good ones survive', () => {
  seedCatalog([
    { slug: 'BAD SLUG', id: 'a', anchor: 'opus' },     // invalid slug chars
    { slug: 'no-id', id: '', anchor: 'opus' },         // empty id
    { slug: 'no-id-2', anchor: 'opus' },               // missing id
    { slug: 'bad-anchor', id: 'b', anchor: 'nope' },   // invalid anchor
    { slug: 'not-an-object' },                          // fine shape actually, missing id -> dropped
    null,                                                // not an object at all
    { slug: 'good', id: 'g', anchor: 'sonnet' },        // the only keeper
  ]);
  const found = discoverExternalModels();
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].slug, 'good');
  clearCatalog();
});

test('discoverExternalModels: duplicate slugs across the catalog -> first wins', () => {
  seedCatalog([
    { slug: 'dup', id: 'first', anchor: 'opus' },
    { slug: 'dup', id: 'second', anchor: 'sonnet' },
  ]);
  const found = discoverExternalModels();
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].id, 'first');
  clearCatalog();
});

test('discoverExternalModels: SIDEQUEST_DISCOVERY_DIRS accepts multiple comma-separated roots', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-multi-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-multi-b-'));
  writeCatalogRaw(dirA, JSON.stringify({ schema: 1, source: 'codex-gateway', models: [{ slug: 'from-a', id: 'a', anchor: 'opus' }] }));
  writeCatalogRaw(dirB, JSON.stringify({ schema: 1, source: 'codex-gateway', models: [{ slug: 'from-b', id: 'b', anchor: 'sonnet' }] }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = `${dirA},${dirB}`;
  const found = discoverExternalModels().map((m) => m.slug).sort();
  assert.deepStrictEqual(found, ['from-a', 'from-b']);
  clearCatalog();
});

/* -------------------------------------------------------------- *
 *  Integration: getModelPrefs / setModelPrefs / routingLadder
 * -------------------------------------------------------------- */

test('getModelPrefs: no catalog present -> discovered=[], custom=[], byte-identical to no-discovery behavior', () => {
  clearCatalog();
  const prefs = getModelPrefs();
  assert.deepStrictEqual(prefs.discovered, []);
  assert.deepStrictEqual(prefs.custom, []);
  assert.deepStrictEqual(prefs.customOverrides, {});
  // The ladder is unaffected — same shape as with prefs.custom == [], no
  // catalog-derived model name shows up anywhere in it.
  const ladder = routingLadder(prefs);
  assert.ok(Array.isArray(ladder) && ladder.length > 0);
  const builtins = ['haiku', 'sonnet', 'opus', 'fable'];
  assert.ok(ladder.every((r) => builtins.indexOf(r.model) !== -1), 'only built-in tiers appear');
});

test('getModelPrefs: a discovered model is disabled by default (never silently reroutes)', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol', anchor: 'opus' }]);
  const prefs = getModelPrefs();
  assert.strictEqual(prefs.discovered.length, 1, 'detected for UI display');
  assert.strictEqual(prefs.discovered[0].slug, 'codex-sol');
  assert.strictEqual(prefs.custom.length, 1, 'resolved list includes it even while disabled');
  assert.strictEqual(prefs.custom[0].enabled, false, 'disabled until the user opts in');
  assert.deepStrictEqual(prefs.customOverrides, {}, 'no override written yet');
  // A disabled custom must not appear as a rung in the ladder.
  const ladder = routingLadder(prefs);
  assert.ok(!ladder.some((r) => r.model === 'codex-sol'), 'disabled custom never reaches the ladder');
  clearCatalog();
});

test('setModelPrefs: toggling customOverrides.enabled makes a discovered model reach the ladder', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol', anchor: 'opus' }]);
  const before = routingLadder(getModelPrefs());
  assert.ok(!before.some((r) => r.model === 'codex-sol'));

  const saved = setModelPrefs({ customOverrides: { 'codex-sol': { enabled: true } } });
  assert.strictEqual(saved.custom[0].enabled, true);
  assert.deepStrictEqual(saved.custom[0].efforts, { low: false, medium: false, high: true, xhigh: false, max: false }, 'sensible default: high only');

  const after = routingLadder(saved);
  assert.ok(after.some((r) => r.model === 'codex-sol'), 'now reaches the ladder');
  assert.ok(after.every((r) => r.model !== 'codex-sol' || r.effort === 'high'), 'only the default-enabled effort rung shows up');
  clearCatalog();
});

test('setModelPrefs/getModelPrefs: a malformed catalog is ignored end-to-end, no throw, prefs stay usable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-e2e-bad-'));
  writeCatalogRaw(dir, 'not json at all {{{');
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  const prefs = getModelPrefs();
  assert.deepStrictEqual(prefs.discovered, []);
  assert.deepStrictEqual(prefs.custom, []);
  const saved = setModelPrefs({ customOverrides: { anything: { enabled: true } } });
  assert.deepStrictEqual(saved.custom, [], 'an override for a slug that was never discovered fabricates nothing');
  clearCatalog();
});

test('getModelPrefs: migrates a legacy hand-authored `custom` array on disk into customOverrides, then drops it', () => {
  // Simulate a pre-SQ-157 model-prefs.json on disk (never actually shipped,
  // per the ticket, but store.js must be defensive about it anyway).
  const prefsFile = path.join(store.projectsRoot(), 'model-prefs.json');
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  fs.writeFileSync(prefsFile, JSON.stringify({
    sonnet: true,
    custom: [{ slug: 'legacy-slug', id: 'legacy-id', anchor: 'opus', offset: 1, enabled: true, color: '#112233' }],
  }));

  seedCatalog([{ slug: 'legacy-slug', id: 'legacy-id-from-catalog', anchor: 'opus', label: 'Legacy' }]);
  const prefs = getModelPrefs();
  assert.strictEqual(prefs.custom.length, 1);
  assert.strictEqual(prefs.custom[0].enabled, true, 'migrated enabled:true carried over as an override');
  assert.strictEqual(prefs.custom[0].offset, 1, 'migrated offset carried over');
  assert.strictEqual(prefs.custom[0].color, '#112233', 'migrated color carried over');
  assert.strictEqual(prefs.custom[0].id, 'legacy-id-from-catalog', 'id always comes from the catalog, never the legacy entry');
  assert.ok('legacy-slug' in prefs.customOverrides, 'migrated into customOverrides');

  // Migration persisted: re-reading from a fresh call shows no legacy `custom`
  // key on disk anymore (the raw file itself was rewritten).
  const onDisk = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
  assert.ok(!('custom' in onDisk), 'legacy key dropped from disk');
  assert.ok('customOverrides' in onDisk, 'customOverrides persisted instead');
  clearCatalog();
});

test('setModelPrefs: patch.custom (a full hand-authored list) is silently ignored, never persisted', () => {
  seedCatalog([{ slug: 'ignored-target', id: 'x', anchor: 'opus' }]);
  const saved = setModelPrefs({
    custom: [{ slug: 'hand-authored', id: 'h', anchor: 'opus', enabled: true }],
  });
  assert.ok(!saved.custom.some((c) => c.slug === 'hand-authored'), 'patch.custom never makes it into the resolved list');
  const onDisk = JSON.parse(fs.readFileSync(path.join(store.projectsRoot(), 'model-prefs.json'), 'utf8'));
  assert.ok(!('custom' in onDisk), 'patch.custom is never written to disk either');
  clearCatalog();
});
