'use strict';
/**
 * Custom model tiers in prefs + ladder merge (SQ-156).
 * Run: node --test plugins/sidequest/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Throwaway home so pref reads/writes never touch the real one.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-custom-test-'));
// Throwaway discovery root (SQ-157): getModelPrefs/setModelPrefs now source
// prefs.custom from discoverExternalModels(), whose default root is
// ~/.claude — NOT SIDEQUEST_HOME. Without this, a dev box that happens to
// have a real ~/.claude/codex-gateway/catalog.json (e.g. from running
// codex-gateway) would leak real discovered models into these tests. Default
// to an empty dir (no catalog); individual tests below override this to a
// dir holding a fake catalog.json when they need one, then restore it.
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-custom-nodiscovery-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const store = require('../lib/store.js');
const {
  routingLadder, getModelPrefs, setModelPrefs, getModelVocab, resolveModelId,
  coerceModel, classifyModelFilter, makeWorkedBy,
} = store;

const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORT_MODELS = ['sonnet', 'opus', 'fable'];
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Build a prefs object. `efforts` is an array applied to every model row, or an
// object mapping model -> array. `custom` is an optional raw custom list.
function mkPrefs(tiers, efforts, bias, custom) {
  const p = { routingBias: bias };
  for (const t of TIER_ORDER) p[t] = tiers.includes(t);
  p.efforts = {};
  for (const m of EFFORT_MODELS) {
    const arr = Array.isArray(efforts) ? efforts : (efforts[m] || []);
    const row = {};
    for (const e of ALL_EFFORTS) row[e] = arr.includes(e);
    p.efforts[m] = row;
  }
  if (custom) p.custom = custom;
  return p;
}

// A raw custom entry with `efforts` given as an array (like mkPrefs).
function mkCustom(slug, anchor, offset, efforts, extra) {
  const row = {};
  for (const e of ALL_EFFORTS) row[e] = efforts.includes(e);
  return Object.assign({ slug, id: `id-${slug}`, anchor, offset, efforts: row }, extra || {});
}

// Write a fake codex-gateway catalog into a fresh temp dir and point
// SIDEQUEST_DISCOVERY_DIRS at it (discovery.js re-reads on every call, so
// this takes effect immediately, no re-require needed). `models` is the raw
// [{slug,id,label,anchor}, ...] list, written as-is (a test can hand in
// deliberately malformed entries).
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-custom-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'codex-gateway', 'catalog.json'),
    JSON.stringify({ schema: 1, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }),
  );
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}

// Restore discovery to "nothing installed" so later tests aren't affected.
function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}

// Collapse a ladder to its distinct rung sequence (consecutive dupes removed).
function rungs(ladder) {
  const out = [];
  for (const r of ladder) {
    const s = `${r.model}.${r.effort}`;
    if (!out.length || out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/* -------------------------------------------------------------- *
 *  getModelPrefs / getModelVocab / resolveModelId
 * -------------------------------------------------------------- */

test('getModelPrefs: custom is [] when absent', () => {
  // Fresh throwaway home, nothing written yet.
  assert.deepStrictEqual(getModelPrefs().custom, []);
});

test('getModelVocab: models include custom slugs, byId resolves, efforts unchanged', () => {
  const prefs = { custom: [mkCustom('codex-sol', 'opus', 1, ['high', 'xhigh', 'max'], { id: 'claude-codex-gpt-5.6-sol[1m]' })] };
  const vocab = getModelVocab(prefs);
  assert.ok(vocab.models.includes('opus'), 'built-ins present');
  assert.ok(vocab.models.includes('codex-sol'), 'custom slug present');
  assert.deepStrictEqual(vocab.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(vocab.byId.opus, 'opus', 'built-in maps to itself');
  assert.strictEqual(vocab.byId['codex-sol'], 'claude-codex-gpt-5.6-sol[1m]', 'custom maps to its id');
  assert.ok(vocab.bySlug['codex-sol'], 'bySlug has the entry');
  assert.strictEqual(vocab.bySlug['codex-sol'].anchor, 'opus');
});

test('getModelVocab: a disabled custom still counts as a valid model name', () => {
  const prefs = { custom: [mkCustom('codex-off', 'opus', 0, ['high'], { enabled: false })] };
  const vocab = getModelVocab(prefs);
  assert.ok(vocab.models.includes('codex-off'), 'disabled custom is still a recognized name');
});

test('resolveModelId: built-ins map to themselves, slugs to their id, unknown to null', () => {
  const prefs = { custom: [mkCustom('codex-x', 'opus', 0, ['high'], { id: 'real-codex-id' })] };
  assert.strictEqual(resolveModelId('opus', prefs), 'opus');
  assert.strictEqual(resolveModelId('OPUS', prefs), 'opus', 'case-insensitive');
  assert.strictEqual(resolveModelId('codex-x', prefs), 'real-codex-id');
  assert.strictEqual(resolveModelId('nope', prefs), null);
  assert.strictEqual(resolveModelId('', prefs), null);
  assert.strictEqual(resolveModelId(null, prefs), null);
});

/* -------------------------------------------------------------- *
 *  coerceModel / classifyModelFilter
 * -------------------------------------------------------------- */

test('coerceModel: one-arg form is built-ins only (backward compatible)', () => {
  assert.strictEqual(coerceModel('opus'), 'opus');
  assert.strictEqual(coerceModel('codex-x'), null, 'no prefs -> custom slug not recognized');
  assert.strictEqual(coerceModel('any'), null);
  assert.strictEqual(coerceModel('none'), null);
  assert.strictEqual(coerceModel(''), null);
  assert.strictEqual(coerceModel(null), null);
});

test('coerceModel(v, prefs): recognizes a custom slug, still rejects garbage', () => {
  const prefs = { custom: [mkCustom('codex-x', 'opus', 0, ['high'])] };
  assert.strictEqual(coerceModel('codex-x', prefs), 'codex-x');
  assert.strictEqual(coerceModel('opus', prefs), 'opus', 'built-ins still resolve');
  assert.strictEqual(coerceModel('nope', prefs), null, 'unknown -> null');
  assert.strictEqual(coerceModel('any', prefs), null);
});

test('classifyModelFilter: distinguishes any / unknown / resolved (SQ-156 footgun affordance)', () => {
  const prefs = { custom: [mkCustom('codex-x', 'opus', 0, ['high'])] };
  assert.strictEqual(classifyModelFilter(null, prefs), 'any');
  assert.strictEqual(classifyModelFilter('', prefs), 'any');
  assert.strictEqual(classifyModelFilter('any', prefs), 'any');
  assert.strictEqual(classifyModelFilter('none', prefs), 'any');
  assert.strictEqual(classifyModelFilter('opus', prefs), 'opus');
  assert.strictEqual(classifyModelFilter('codex-x', prefs), 'codex-x');
  assert.strictEqual(classifyModelFilter('totally-bogus', prefs), 'unknown', 'a real name that matches nothing');
});

/* -------------------------------------------------------------- *
 *  routingLadder regression: absent/empty/disabled custom == today
 * -------------------------------------------------------------- */

test('regression: no custom key == custom:[] == disabled custom, byte-for-byte', () => {
  const combos = [
    [TIER_ORDER, ['low', 'medium', 'high', 'xhigh'], 0],
    [TIER_ORDER, ALL_EFFORTS, 0],
    [['sonnet', 'opus'], ALL_EFFORTS, -3],
    [['sonnet', 'opus'], ALL_EFFORTS, 5],
    [['haiku', 'opus'], ['low', 'medium'], 0],
    [['fable'], ['high'], 2],
  ];
  for (const [tiers, efforts, bias] of combos) {
    const base = routingLadder(mkPrefs(tiers, efforts, bias));
    const empty = routingLadder(mkPrefs(tiers, efforts, bias, []));
    const disabled = routingLadder(mkPrefs(tiers, efforts, bias, [mkCustom('off', 'opus', 0, ['high'], { enabled: false })]));
    assert.deepStrictEqual(empty, base, `custom:[] identical for [${tiers}|${bias}]`);
    assert.deepStrictEqual(disabled, base, `disabled custom identical for [${tiers}|${bias}]`);
  }
});

test('regression: the documented all-tiers/max-off/bias-0 snapshot is unchanged', () => {
  const got = routingLadder(mkPrefs(TIER_ORDER, ['low', 'medium', 'high', 'xhigh'], 0)).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'haiku.null', 'sonnet.low', 'sonnet.medium', 'sonnet.high', 'sonnet.xhigh',
    'opus.medium', 'opus.high', 'fable.low', 'fable.medium', 'fable.xhigh',
  ]);
});

/* -------------------------------------------------------------- *
 *  routingLadder: custom rungs, tie-break, max rung
 * -------------------------------------------------------------- */

test('tie rule: a custom anchored at opus offset 0 LOSES the exact score tie to opus (anchor wins)', () => {
  // opus.high and codex.high both score 6; the anchor (opus) must rank above its
  // custom, so the custom is the cheaper/weaker rung and opus is the top rung.
  const prefs = mkPrefs(['opus'], { opus: ['high'] }, 0, [mkCustom('codex', 'opus', 0, ['high'])]);
  const ladder = routingLadder(prefs);
  assert.strictEqual(`${ladder[0].model}.${ladder[0].effort}`, 'codex.high', 'c1 = custom (tie loser, ranks below its anchor)');
  assert.strictEqual(`${ladder[9].model}.${ladder[9].effort}`, 'opus.high', 'c10 = opus (anchor wins the tie)');
});

test('interleave: custom(opus, high+xhigh) merges each rung just below the matching opus rung', () => {
  const prefs = mkPrefs(['opus'], { opus: ['high', 'xhigh'] }, 0, [mkCustom('codex', 'opus', 0, ['high', 'xhigh'])]);
  assert.deepStrictEqual(rungs(routingLadder(prefs)), [
    'codex.high', 'opus.high', 'codex.xhigh', 'opus.xhigh',
  ]);
});

test('same-anchor customs tie-break among themselves by slug (deterministic)', () => {
  // Two customs, same anchor/offset/effort -> identical score AND tierRank; slug
  // breaks the tie so 'aaa' ranks below 'bbb'.
  const prefs = mkPrefs(['opus'], { opus: [] }, 0, [
    mkCustom('bbb', 'opus', 0, ['high']),
    mkCustom('aaa', 'opus', 0, ['high']),
  ]);
  // opus has no non-max efforts here (row empty, max off) -> opus contributes its
  // medium fallback rung, but the two customs both sit at score 6 and rank by slug.
  const seq = rungs(routingLadder(prefs));
  const iAaa = seq.indexOf('aaa.high');
  const iBbb = seq.indexOf('bbb.high');
  assert.ok(iAaa !== -1 && iBbb !== -1, 'both customs appear');
  assert.ok(iAaa < iBbb, `slug tie-break: aaa (${iAaa}) ranks below bbb (${iBbb})`);
});

test('max rung: a custom with the highest base becomes the top tier and owns .max', () => {
  // codex anchored opus offset +2 -> base 6, above sonnet(2) and opus(4).
  const prefs = mkPrefs(['sonnet', 'opus'], ALL_EFFORTS, 0, [mkCustom('codex', 'opus', 2, ALL_EFFORTS)]);
  const ladder = routingLadder(prefs);
  assert.strictEqual(ladder[9].model, 'codex', 'c10 top tier is the custom');
  assert.strictEqual(ladder[9].effort, 'max', 'c10 is the sparing max rung');
  assert.notStrictEqual(ladder[8].effort, 'max', 'max only at c10 (bias 0)');
  // And the custom really is above opus in the merged order.
  const seq = rungs(ladder);
  assert.ok(seq.indexOf('opus.xhigh') < seq.indexOf('codex.max'), 'opus.xhigh ranks below the custom max rung');
});

/* -------------------------------------------------------------- *
 *  setModelPrefs: validation, warnings, persistence, guards
 * -------------------------------------------------------------- */

// SQ-157: prefs.custom's SOURCE changed from a hand-authored `patch.custom`
// list to auto-discovery (a catalog file, e.g. codex-gateway's) merged with
// per-slug `patch.customOverrides` tweaks. The five tests below replace the
// old hand-authored-list tests; they seed a fake catalog via
// SIDEQUEST_DISCOVERY_DIRS instead of handing full custom defs to
// setModelPrefs (which now silently ignores `patch.custom` entirely).

test('setModelPrefs: customOverrides enables a discovered model, normalized and persisted, round-trips', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', anchor: 'opus', label: 'Codex Sol' }]);
  const saved = setModelPrefs({
    customOverrides: {
      'codex-sol': { enabled: true, offset: 1, color: '#3366cc', efforts: { low: false, medium: false, high: true, xhigh: true, max: true } },
    },
  });
  assert.strictEqual(saved.custom.length, 1);
  const c = saved.custom[0];
  assert.strictEqual(c.slug, 'codex-sol');
  assert.strictEqual(c.id, 'claude-codex-gpt-5.6-sol[1m]', 'id comes from the catalog, not the override');
  assert.strictEqual(c.label, 'Codex Sol', 'label comes from the catalog, not the override');
  assert.strictEqual(c.anchor, 'opus');
  assert.strictEqual(c.offset, 1);
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.color, '#3366cc');
  assert.deepStrictEqual(c.efforts, { low: false, medium: false, high: true, xhigh: true, max: true });
  // Only the override tweak is persisted, not the resolved catalog fields.
  assert.deepStrictEqual(saved.customOverrides['codex-sol'].enabled, true);
  assert.ok(!('id' in saved.customOverrides['codex-sol']), 'id is not part of an override, it comes from the catalog');
  // Round-trips through disk.
  assert.deepStrictEqual(getModelPrefs().custom, saved.custom);
  assert.deepStrictEqual(getModelPrefs().customOverrides, saved.customOverrides);
  clearCatalog();
});

test('setModelPrefs: a catalog entry colliding with a built-in tier name is dropped, never surfaces, never throws', () => {
  // 'opus' passes discovery.js's own slug/id/anchor validation (it's a fine
  // slug shape) but store.js's normalizeCustomEntry rejects it for colliding
  // with a built-in tier — that drop must not take the whole write down.
  seedCatalog([
    { slug: 'opus', id: 'x', anchor: 'opus' },
    { slug: 'good', id: 'g', anchor: 'sonnet' },
  ]);
  const saved = setModelPrefs({ customOverrides: { opus: { enabled: true }, good: { enabled: true } } });
  assert.strictEqual(saved.custom.length, 1, 'only the non-colliding entry survives');
  assert.strictEqual(saved.custom[0].slug, 'good');
  // The write still happened (guards intact) and coerceModel('opus') is still built-in.
  assert.strictEqual(coerceModel('opus', saved), 'opus');
  clearCatalog();
});

test('setModelPrefs: an override for a slug that is not discovered is inert (no custom entry fabricated)', () => {
  seedCatalog([{ slug: 'present', id: 'p', anchor: 'opus' }]);
  const saved = setModelPrefs({
    customOverrides: { present: { enabled: true }, 'not-installed': { enabled: true } },
  });
  assert.strictEqual(saved.custom.length, 1, 'only the discovered slug produces a custom entry');
  assert.strictEqual(saved.custom[0].slug, 'present');
  // The dead override is still stored (so it takes effect later if that
  // plugin ever gets installed) but doesn't fabricate a phantom tier now.
  assert.ok('not-installed' in saved.customOverrides);
  clearCatalog();
});

test('setModelPrefs: custom efforts get the per-row guard (never all-off)', () => {
  seedCatalog([{ slug: 'guarded', id: 'g', anchor: 'opus' }]);
  const saved = setModelPrefs({
    customOverrides: { guarded: { enabled: true, efforts: { low: false, medium: false, high: false, xhigh: false, max: false } } },
  });
  assert.strictEqual(saved.custom[0].efforts.medium, true, 'falls back to medium');
  clearCatalog();
});

test('setModelPrefs: omitting customOverrides preserves it; a null entry removes a slug; tier guard intact', () => {
  seedCatalog([{ slug: 'keep', id: 'k', anchor: 'opus' }]);
  setModelPrefs({ customOverrides: { keep: { enabled: true } } });
  const afterToggle = setModelPrefs({ opus: false }); // patch omits customOverrides
  assert.strictEqual(afterToggle.custom.length, 1, 'custom preserved when patch omits customOverrides');
  assert.ok(TIER_ORDER.some((t) => afterToggle[t]), 'tier guard still keeps a built-in on');
  const cleared = setModelPrefs({ customOverrides: { keep: null } });
  // The catalog entry is still discovered (seedCatalog wasn't cleared), so it
  // still resolves into `custom` — just back to disabled-by-default, since the
  // override that turned it on is gone.
  assert.strictEqual(cleared.custom.length, 1, 'still discovered, just no longer overridden');
  assert.strictEqual(cleared.custom[0].enabled, false, 'null removes the override, back to disabled-by-default');
  assert.ok(!('keep' in cleared.customOverrides), 'the override key itself is gone');
  clearCatalog();
});

/* -------------------------------------------------------------- *
 *  makeWorkedBy provenance
 * -------------------------------------------------------------- */

test('makeWorkedBy: accepts a custom slug (via vocab), stamps it', () => {
  const prefs = { custom: [mkCustom('codex-x', 'opus', 0, ['high'])] };
  const wb = makeWorkedBy({ model: 'codex-x', effort: 'high', by: 'exec-1' }, prefs);
  assert.strictEqual(wb.model, 'codex-x');
  assert.strictEqual(wb.effort, 'high');
  assert.strictEqual(wb.by, 'exec-1');
});

test('makeWorkedBy: built-in tiers still stamp with no prefs argument', () => {
  const wb = makeWorkedBy({ model: 'opus', effort: 'medium', by: 'exec-2' });
  assert.strictEqual(wb.model, 'opus');
  assert.strictEqual(wb.effort, 'medium');
});

test('makeWorkedBy: throws on a model that is neither built-in nor a configured custom', () => {
  assert.throws(() => makeWorkedBy({ model: 'totally-not-real', by: 'x' }, { custom: [] }), /invalid model/);
  // A custom slug that isn't configured in the given prefs also throws.
  assert.throws(() => makeWorkedBy({ model: 'codex-x', by: 'x' }, { custom: [] }), /invalid model/);
});
