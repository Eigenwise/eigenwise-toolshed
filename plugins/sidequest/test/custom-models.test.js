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

test('setModelPrefs: a valid custom is normalized, persisted, and returned', () => {
  const saved = setModelPrefs({
    custom: [{
      slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', anchor: 'opus', offset: 1,
      enabled: true, label: 'Codex Sol', color: '#3366cc',
      efforts: { low: false, medium: false, high: true, xhigh: true, max: true },
    }],
  });
  assert.strictEqual(saved.custom.length, 1);
  const c = saved.custom[0];
  assert.strictEqual(c.slug, 'codex-sol');
  assert.strictEqual(c.id, 'claude-codex-gpt-5.6-sol[1m]');
  assert.strictEqual(c.anchor, 'opus');
  assert.strictEqual(c.offset, 1);
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.label, 'Codex Sol');
  assert.strictEqual(c.color, '#3366cc');
  assert.deepStrictEqual(c.efforts, { low: false, medium: false, high: true, xhigh: true, max: true });
  assert.ok(!('customWarnings' in saved), 'no warnings on a clean write');
  // Round-trips through disk.
  assert.deepStrictEqual(getModelPrefs().custom, saved.custom);
});

test('setModelPrefs: invalid entries are dropped with customWarnings, not thrown', () => {
  const saved = setModelPrefs({
    custom: [
      { slug: 'opus', id: 'x', anchor: 'opus' },        // collides with a built-in
      { slug: 'BAD SLUG', id: 'y', anchor: 'opus' },    // invalid slug
      { slug: 'ok1', id: '', anchor: 'opus' },          // empty id
      { slug: 'ok2', id: 'z', anchor: 'nope' },         // bad anchor
      { slug: 'good', id: 'g', anchor: 'sonnet' },      // the only keeper
    ],
  });
  assert.strictEqual(saved.custom.length, 1, 'only the valid entry survives');
  assert.strictEqual(saved.custom[0].slug, 'good');
  assert.strictEqual(saved.customWarnings.length, 4, 'four drops reported');
  // The write still happened (guards intact) and coerceModel('opus') is still built-in.
  assert.strictEqual(coerceModel('opus', saved), 'opus');
});

test('setModelPrefs: duplicate slugs keep the first, drop the rest', () => {
  const saved = setModelPrefs({
    custom: [
      { slug: 'dup', id: 'a', anchor: 'opus' },
      { slug: 'dup', id: 'b', anchor: 'opus' },
    ],
  });
  assert.strictEqual(saved.custom.length, 1);
  assert.strictEqual(saved.custom[0].id, 'a', 'first wins');
  assert.strictEqual(saved.customWarnings.length, 1);
});

test('setModelPrefs: custom efforts get the per-row guard (never all-off)', () => {
  const saved = setModelPrefs({
    custom: [{ slug: 'guarded', id: 'g', anchor: 'opus', efforts: { low: false, medium: false, high: false, xhigh: false, max: false } }],
  });
  assert.strictEqual(saved.custom[0].efforts.medium, true, 'falls back to medium');
});

test('setModelPrefs: omitting custom preserves the current list; [] clears it; tier guard intact', () => {
  setModelPrefs({ custom: [{ slug: 'keep', id: 'k', anchor: 'opus' }] });
  const afterToggle = setModelPrefs({ opus: false }); // patch omits custom
  assert.strictEqual(afterToggle.custom.length, 1, 'custom preserved when patch omits it');
  assert.ok(TIER_ORDER.some((t) => afterToggle[t]), 'tier guard still keeps a built-in on');
  const cleared = setModelPrefs({ custom: [] });
  assert.deepStrictEqual(cleared.custom, [], 'explicit [] clears');
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
