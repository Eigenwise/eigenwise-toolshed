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

const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', suggestedTier: 'grade-4' };
const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'grade-3' };
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'grade-1' };

test('shared runtime merges grade effort rows without duplicate or regressing runtime efforts', () => {
  seedCatalog([TERRA]);
  const efforts = {};
  for (const grade of ['grade-1', 'grade-2', 'grade-3', 'grade-4']) {
    efforts[grade] = { low: false, medium: false, high: false, xhigh: false, max: false };
  }
  efforts['grade-2'].high = true;
  efforts['grade-2'].xhigh = true;
  efforts['grade-3'].medium = true;
  efforts['grade-3'].xhigh = true;
  efforts['grade-3'].max = true;
  const prefs = {
    'grade-1': false, 'grade-2': true, 'grade-3': true, 'grade-4': false,
    efforts, routingBias: 0,
    tierBackend: { 'grade-2': TERRA.slug, 'grade-3': TERRA.slug },
  };

  const ladder = routingLadder(prefs);
  const runtimePairs = ladder.map((r) => `${store.resolveModelId(r.model, prefs)}.${r.effort}`);
  const effortRank = ['low', 'medium', 'high', 'xhigh', 'max'];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(effortRank.indexOf(ladder[i].effort) >= effortRank.indexOf(ladder[i - 1].effort));
  }
  assert.deepStrictEqual([...new Set(runtimePairs)], [
    `${TERRA.id}.medium`, `${TERRA.id}.high`, `${TERRA.id}.xhigh`, `${TERRA.id}.max`,
  ]);
  assert.ok(ladder.every((r) => r.model === 'grade-3'), 'highest shared grade remains stamped for provenance');
  clearCatalog();
});


test('no catalog anywhere -> []', () => {
  clearCatalog();
  assert.deepStrictEqual(discoverExternalModels(), []);
});

test('a valid schema-2 catalog resolves to [{slug,id,label,suggestedTier,source}]', () => {
  seedCatalog([TERRA]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0], { slug: TERRA.slug, id: TERRA.id, label: TERRA.label, suggestedTier: 'grade-3', source: 'codex-gateway' });
});

test('suggestedTier missing/invalid -> null (still discovered)', () => {
  seedCatalog([{ slug: 'codex-x', id: 'claude-codex-x[1m]', label: 'X' }, { slug: 'codex-y', id: 'claude-codex-y[1m]', label: 'Y', suggestedTier: 'bogus' }]);
  const got = discoverExternalModels();
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].suggestedTier, null);
  assert.strictEqual(got[1].suggestedTier, null);
});

test('legacy schema-1 anchor field is read as suggestedTier', () => {
  seedCatalog([{ slug: 'codex-old', id: 'claude-codex-old[1m]', label: 'Old', anchor: 'grade-3' }], 1);
  assert.strictEqual(discoverExternalModels()[0].suggestedTier, 'grade-3');
});

test('label falls back to slug when absent', () => {
  seedCatalog([{ slug: 'codex-nolabel', id: 'claude-codex-nolabel[1m]', suggestedTier: 'grade-1' }]);
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
  assert.deepStrictEqual(prefs.tierBackend, { 'grade-1': 'claude', 'grade-2': 'claude', 'grade-3': 'claude', 'grade-4': 'claude' });
  // every ladder rung is a built-in tier
  for (const rung of routingLadder(prefs)) {
    assert.ok(['grade-3', 'grade-2', 'grade-1', 'grade-4'].includes(rung.model), `rung ${rung.model} is a built-in`);
  }
});

test('mapping a tier to a discovered slug: resolveExec routes to its agent, ladder shape unchanged', () => {
  seedCatalog([TERRA, SOL, LUNA]);
  const prefs = setModelPrefs({ tierBackend: { opus: 'codex-gpt-5-6-terra' } });
  assert.strictEqual(prefs.tierBackend['grade-3'], 'codex-gpt-5-6-terra');
  assert.deepStrictEqual(prefs.tierBackendWarnings, []);
  const ex = store.resolveExec('grade-3', 'high', prefs);
  // The Codex contract a dispatcher relies on: the exact generated backend-
  // specific agent, model null (the Agent-tool model param must be OMITTED so
  // the agent's pinned frontmatter model actually runs), and the advertised
  // native-Agent execution path.
  assert.strictEqual(ex.agent, 'sidequest-exec-codex-gpt-5-6-terra-high');
  assert.strictEqual(ex.model, null);
  assert.strictEqual(ex.backend, 'codex');
  assert.strictEqual(ex.dispatch, 'native-agent');
  assert.strictEqual(ex.spawnId, TERRA.id);
  // sonnet still Claude — and still native Agent dispatch, with a real model param
  const claudeEx = store.resolveExec('grade-2', 'high', prefs);
  assert.strictEqual(claudeEx.backend, 'claude');
  assert.strictEqual(claudeEx.dispatch, 'native-agent');
  assert.strictEqual(claudeEx.model, 'sonnet');
  // haiku (effort-null Claude route) advertises the same execution path
  assert.strictEqual(store.resolveExec('grade-1', null, prefs).dispatch, 'native-agent');
  // ladder still stamps the tier, not the backend slug
  assert.strictEqual(routingLadder(prefs).find((r) => r.model !== 'grade-1' && r.effort === 'high' && r.model === 'grade-3') !== undefined, true);
});

test('mapping grade 1 to Codex gives it effort rungs and preserves its effort prefs', () => {
  seedCatalog([LUNA]);
  const prefs = setModelPrefs({
    tierBackend: { 'grade-1': LUNA.slug },
    efforts: { 'grade-1': { low: false, medium: true, high: false, xhigh: false, max: false } },
  });
  assert.deepStrictEqual(prefs.profiles['grade-1'].efforts, { low: false, medium: true, high: false, xhigh: false, max: false });
  const gradeOne = routingLadder(prefs).filter((r) => r.model === 'grade-1');
  assert.ok(gradeOne.length > 0);
  gradeOne.forEach((r) => assert.strictEqual(r.effort, 'medium'));
  assert.strictEqual(store.resolveExec('grade-1', 'medium', prefs).agent, 'sidequest-exec-codex-gpt-5-6-luna-medium');

  const haiku = setModelPrefs({ tierBackend: { 'grade-1': 'claude' } });
  assert.strictEqual(haiku.profiles['grade-1'].efforts, null);
  assert.strictEqual(haiku.efforts['grade-1'].medium, true, 'Haiku retains Grade 1 effort choices for a later remap');
  routingLadder(haiku).filter((r) => r.model === 'grade-1').forEach((r) => assert.strictEqual(r.effort, null));
});
test('stale mapping (slug not in catalog) falls back to Claude with a warning', () => {
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { fable: 'codex-gone' } });
  assert.ok(prefs.tierBackendWarnings.some((w) => w.includes('Grade 4') && w.includes('codex-gone')));
  assert.strictEqual(store.resolveExec('grade-4', 'high', prefs).backend, 'claude');
});

test('clearing a mapping back to claude', () => {
  seedCatalog([TERRA]);
  setModelPrefs({ tierBackend: { opus: 'codex-gpt-5-6-terra' } });
  const prefs = setModelPrefs({ tierBackend: { opus: 'claude' } });
  assert.strictEqual(prefs.tierBackend['grade-3'], 'claude');
  assert.strictEqual(store.resolveExec('grade-3', 'high', prefs).backend, 'claude');
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
