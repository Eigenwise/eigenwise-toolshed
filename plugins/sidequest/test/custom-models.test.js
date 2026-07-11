'use strict';
/**
 * Per-tier model backend (1.36.0): a ladder tier can be pointed at a discovered
 * Codex model, resolved at spawn. This file covers the store-level vocabulary,
 * resolveExec/resolveModelId, makeWorkedBy provenance, and the backward-compat
 * guarantee that the built-in ladder is unchanged. Catalog discovery integration
 * lives in discovery.test.js.
 * Run: node --test "plugins/sidequest/test/**\/*.test.js"
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-tierbackend-'));
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-tb-nodiscovery-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const store = require('../lib/store.js');
const {
  routingLadder, getModelPrefs, setModelPrefs, getModelVocab, resolveModelId,
  resolveExec, coerceModel, classifyModelFilter, makeWorkedBy,
} = store;

const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORT_MODELS = ['sonnet', 'opus', 'fable'];
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function mkPrefs(tiers, efforts, bias) {
  const p = { routingBias: bias };
  for (const t of TIER_ORDER) p[t] = tiers.includes(t);
  p.efforts = {};
  for (const m of EFFORT_MODELS) {
    const arr = Array.isArray(efforts) ? efforts : (efforts[m] || []);
    const row = {};
    for (const e of ALL_EFFORTS) row[e] = arr.includes(e);
    p.efforts[m] = row;
  }
  return p;
}

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'opus' };
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'haiku' };

function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-tb-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'),
    JSON.stringify({ schema: 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }

function rungs(ladder) {
  const out = [];
  for (const r of ladder) {
    const s = `${r.model}.${r.effort}`;
    if (!out.length || out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/* -------------------------------------------------------------- *
 *  vocabulary: tiers are always the four built-ins
 * -------------------------------------------------------------- */

test('getModelVocab: exactly the four built-in tiers, five efforts', () => {
  clearCatalog();
  const v = getModelVocab(getModelPrefs());
  assert.deepStrictEqual(v.models.slice().sort(), ['fable', 'haiku', 'opus', 'sonnet']);
  assert.deepStrictEqual(v.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('coerceModel: one of the four tiers, else null (a Codex slug is NOT a tier)', () => {
  assert.strictEqual(coerceModel('opus'), 'opus');
  assert.strictEqual(coerceModel('OPUS'), 'opus');
  assert.strictEqual(coerceModel('codex-gpt-5-6-terra'), null);
  assert.strictEqual(coerceModel('any'), null);
  assert.strictEqual(coerceModel(''), null);
});

test('classifyModelFilter: any / unknown / a resolved tier', () => {
  assert.strictEqual(classifyModelFilter(null), 'any');
  assert.strictEqual(classifyModelFilter('none'), 'any');
  assert.strictEqual(classifyModelFilter('opus'), 'opus');
  assert.strictEqual(classifyModelFilter('nonsense'), 'unknown');
});

/* -------------------------------------------------------------- *
 *  resolveExec / resolveModelId
 * -------------------------------------------------------------- */

test('resolveExec: a Claude-backed tier spawns the effort agent with model:<tier>', () => {
  clearCatalog();
  const prefs = getModelPrefs();
  assert.deepStrictEqual(resolveExec('opus', 'high', prefs), {
    agent: 'sidequest-exec-high', model: 'opus', spawnId: 'opus', backend: 'claude', slug: null,
    runsModel: 'opus', runsLabel: 'opus',
  });
});

test('resolveExec: a Claude haiku tier has no effort agent (plain agent, model:haiku)', () => {
  clearCatalog();
  const ex = resolveExec('haiku', null, getModelPrefs());
  assert.strictEqual(ex.agent, null);
  assert.strictEqual(ex.model, 'haiku');
});

test('resolveExec: a Codex-backed tier spawns the slug agent with model:null + the real spawnId', () => {
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  const ex = resolveExec('opus', 'xhigh', prefs);
  assert.strictEqual(ex.agent, 'sidequest-exec-codex-gpt-5-6-terra-xhigh');
  assert.strictEqual(ex.model, null);
  assert.strictEqual(ex.spawnId, TERRA.id);
  assert.strictEqual(ex.backend, 'codex');
});

test('resolveExec: a Codex-backed HAIKU tier gets a fixed effort in its agent name', () => {
  seedCatalog([LUNA]);
  const prefs = setModelPrefs({ tierBackend: { haiku: LUNA.slug } });
  const ex = resolveExec('haiku', null, prefs);
  assert.strictEqual(ex.agent, 'sidequest-exec-codex-gpt-5-6-luna-medium');
  assert.strictEqual(ex.spawnId, LUNA.id);
});

test('resolveModelId: a tier maps to itself, or to its mapped Codex id', () => {
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  assert.strictEqual(resolveModelId('sonnet', prefs), 'sonnet');
  assert.strictEqual(resolveModelId('opus', prefs), TERRA.id);
  assert.strictEqual(resolveModelId('nonsense', prefs), null);
});

/* -------------------------------------------------------------- *
 *  ladder is backend-agnostic (backward compat)
 * -------------------------------------------------------------- */

test('regression: mapping a tier to Codex does NOT change the ladder shape', () => {
  clearCatalog();
  const base = rungs(routingLadder(mkPrefs(['sonnet', 'opus', 'fable'], ['high', 'xhigh'], 0)));
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  // routingLadder reads enabled tiers + efforts, not tierBackend
  const mapped = rungs(routingLadder(Object.assign(mkPrefs(['sonnet', 'opus', 'fable'], ['high', 'xhigh'], 0), { tierBackend: prefs.tierBackend })));
  assert.deepStrictEqual(mapped, base, 'ladder rungs still name tiers, unaffected by the backend map');
});

test('regression: the documented all-tiers/max-off/bias-0 snapshot is unchanged', () => {
  clearCatalog();
  const p = mkPrefs(['haiku', 'sonnet', 'opus', 'fable'], ['low', 'medium', 'high', 'xhigh'], 0);
  const l = routingLadder(p);
  assert.strictEqual(l.length, 10);
  assert.strictEqual(l[0].model, 'haiku');
  assert.strictEqual(l[9].model, 'fable');
});

/* -------------------------------------------------------------- *
 *  provenance
 * -------------------------------------------------------------- */

test('makeWorkedBy: a built-in tier stamps with no prefs argument', () => {
  const wb = makeWorkedBy({ model: 'opus', effort: 'high', by: 'x' });
  assert.strictEqual(wb.model, 'opus');
  assert.strictEqual(wb.effort, 'high');
});

test('makeWorkedBy: a discovered Codex slug is a valid provenance model', () => {
  seedCatalog([TERRA]);
  const wb = makeWorkedBy({ model: TERRA.slug, effort: 'high', by: 'x' });
  assert.strictEqual(wb.model, TERRA.slug);
});

test('makeWorkedBy: throws on a model that is neither a tier nor a discovered slug', () => {
  clearCatalog();
  assert.throws(() => makeWorkedBy({ model: 'gpt-bogus', by: 'x' }), /invalid model/);
});

test('makeWorkedBy: no model -> null (a done with no --model carries no stamp)', () => {
  assert.strictEqual(makeWorkedBy({ effort: 'high', by: 'x' }), null);
});

/* -------------------------------------------------------------- *
 *  applyDerivedRouting attaches a resolved exec
 * -------------------------------------------------------------- */

test('a ticket read carries a resolved exec matching its stamped tier backend', () => {
  seedCatalog([TERRA]);
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  // find the complexity that derives to opus
  const ladder = routingLadder(prefs);
  const opusC = ladder.findIndex((r) => r.model === 'opus') + 1;
  assert.ok(opusC >= 1, 'some complexity derives to opus');
  const t = store.applyDerivedRouting({ complexity: opusC }, prefs);
  assert.strictEqual(t.model, 'opus');           // stamped by tier
  assert.strictEqual(t.exec.backend, 'codex');   // but backed by Codex
  assert.strictEqual(t.exec.agent, `sidequest-exec-codex-gpt-5-6-terra-${t.effort}`);
  assert.strictEqual(t.exec.model, null);
});
