'use strict';
/**
 * Invariant tests for the complexity routing ladder (SQ-84 audit).
 * Run: node --test plugins/switchboard/test/ladder.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the store at a throwaway home so pref reads/writes never touch the real one.
process.env.SWITCHBOARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-ladder-test-'));

const store = require('../lib/ladder.js');
const { routingLadder, deriveRouting, coerceComplexity, setModelPrefs } = store;

const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORT_MODELS = ['sonnet', 'opus', 'fable']; // tiers that carry an effort row (haiku has none)
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh']; // non-max scale
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Per-tier base offsets mirroring store.js's LADDER_TIER_BASE (SQ-93: the
// sonnet<->opus boundary keeps the old uniform gap of 2 — evidence-supported
// crossover, unchanged — while the opus<->fable boundary widens to a gap of 4,
// eliminating the previously-unsupported fable.low == opus.high tie).
const TIER_BASE = { haiku: 0, sonnet: 2, opus: 4, fable: 8 };

// All 15 non-empty tier subsets.
const tierSubsets = [];
for (let mask = 1; mask < 16; mask++) {
  tierSubsets.push(TIER_ORDER.filter((_, i) => mask & (1 << i)));
}

const effortSubsets = {
  'all-on': ALL_EFFORTS,
  'max-off': ['low', 'medium', 'high', 'xhigh'],
  'low+medium': ['low', 'medium'],
  'high-only': ['high'],
  'max-only': ['max'],
  // SQ-134 ticket shape: sonnet hi+xhi, opus hi+xhi+max — no low/medium.
  'hi+xhi+max': ['high', 'xhigh', 'max'],
};

// SQ-134: invariants (C1 cheapest, C10 top/max, monotone non-decreasing) must
// hold at EVERY integer bias -5..+5, not just a sample.
const BIASES = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

// `efforts` may be a flat array (applied uniformly to every model row — the
// convenient mode the invariant sweep and oracles rely on) OR an object mapping
// model -> array for per-model control (opus·medium excluded while sonnet keeps
// it, etc.). Missing rows in the object form default to no efforts enabled.
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

// Capability score mirroring the store's ranking rule, for monotonicity checks.
// The sparing max rung (top tier · max, outside the sequence) scores Infinity.
function rungScore(rung, maxInSequence) {
  const tr = TIER_ORDER.indexOf(rung.model);
  const base = TIER_BASE[rung.model];
  if (rung.effort === null) return { score: base, tr };
  if (rung.effort === 'max') {
    return maxInSequence ? { score: base + EFFORT_ORDER.length, tr } : { score: Infinity, tr };
  }
  return { score: base + EFFORT_ORDER.indexOf(rung.effort), tr };
}

test('invariant sweep: 15 tier subsets x 5 effort subsets x 5 biases', () => {
  for (const tiers of tierSubsets) {
    for (const [effName, efforts] of Object.entries(effortSubsets)) {
      for (const bias of BIASES) {
        const label = `[${tiers.join('+')} | ${effName} | bias ${bias}]`;
        const prefs = mkPrefs(tiers, efforts, bias);
        const ladder = routingLadder(prefs);

        // Shape: exactly 10 rungs, complexity 1..10, never empty.
        assert.strictEqual(ladder.length, 10, `${label} length`);
        ladder.forEach((r, i) => {
          assert.strictEqual(r.complexity, i + 1, `${label} complexity field`);
          assert.ok('model' in r && 'effort' in r, `${label} shape`);
          // No disabled tier emitted.
          assert.ok(tiers.includes(r.model), `${label} c${i + 1} model ${r.model} enabled`);
          // Effort null only on haiku; otherwise an enabled effort.
          if (r.model === 'haiku') {
            assert.strictEqual(r.effort, null, `${label} haiku effort null`);
          } else {
            assert.notStrictEqual(r.effort, null, `${label} non-haiku effort non-null`);
            assert.ok(efforts.includes(r.effort), `${label} effort ${r.effort} enabled`);
          }
        });

        // Reconstruct the store's sequence facts for max-rule / extreme checks.
        const nonMaxEfforts = efforts.filter((e) => e !== 'max');
        const maxInSequence = nonMaxEfforts.length === 0;
        const topTier = tiers[tiers.length - 1];
        const hasMaxRung = efforts.includes('max') && !maxInSequence && topTier !== 'haiku';

        // Monotone capability as complexity rises (tie-break: higher tier ranks higher).
        for (let i = 1; i < 10; i++) {
          const a = rungScore(ladder[i - 1], maxInSequence);
          const b = rungScore(ladder[i], maxInSequence);
          const ok = b.score > a.score || (b.score === a.score && b.tr >= a.tr);
          assert.ok(ok, `${label} monotone at c${i}->c${i + 1}: ${JSON.stringify(ladder[i - 1])} -> ${JSON.stringify(ladder[i])}`);
        }

        // Max rule: the sparing rung is top-tier only, at c10 always, c9 only at bias +5.
        ladder.forEach((r) => {
          if (r.effort === 'max' && !maxInSequence) {
            assert.strictEqual(r.model, topTier, `${label} max rung on top tier only`);
            assert.ok(
              r.complexity === 10 || (r.complexity === 9 && bias >= 5),
              `${label} max rung only at c10 (c9 at +5), got c${r.complexity}`
            );
          }
        });
        if (hasMaxRung) {
          assert.strictEqual(ladder[9].effort, 'max', `${label} c10 hits the max rung`);
          assert.strictEqual(ladder[8].effort === 'max', bias >= 5, `${label} c9 max iff bias +5`);
        } else {
          // max never emitted unless it's carrying the sequence (max-only efforts).
          ladder.forEach((r) => {
            if (!maxInSequence) assert.notStrictEqual(r.effort, 'max', `${label} no max rung -> no max emitted`);
          });
        }

        // Extremes invariant at every bias:
        // c1 -> cheapest rung: lowest tier, and its weakest enabled effort.
        const cheapTier = tiers[0];
        assert.strictEqual(ladder[0].model, cheapTier, `${label} c1 cheapest tier`);
        if (cheapTier !== 'haiku') {
          const seqEfforts = maxInSequence ? efforts : nonMaxEfforts;
          assert.strictEqual(ladder[0].effort, seqEfforts[0], `${label} c1 weakest effort`);
        }
        // c10 -> top rung: top tier at its strongest available effort.
        assert.strictEqual(ladder[9].model, topTier, `${label} c10 top tier`);
        if (topTier !== 'haiku') {
          const seqEfforts = maxInSequence ? efforts : nonMaxEfforts;
          const expectTopEff = hasMaxRung ? 'max' : seqEfforts[seqEfforts.length - 1];
          assert.strictEqual(ladder[9].effort, expectTopEff, `${label} c10 strongest effort`);
        }
      }
    }
  }
});

test('gamma index map: monotone, ends invariant, for N=1..16 at every integer bias (SQ-134 floor bucketing)', () => {
  // Mirrors the store's remap (SQ-134): idx = min(N-1, floor(p^gamma * N)),
  // p = (c-1)/nc — nc (not nc-1) as the divisor, so p never reaches 1 within
  // this branch; the no-max-rung c=nc pin forces the top complexity to N-1.
  for (let N = 1; N <= 16; N++) {
    for (let bias = -5; bias <= 5; bias++) {
      const gamma = Math.pow(3, -bias / 5);
      const nc = 10; // normal count without a max rung
      let prev = -1;
      for (let c = 1; c <= nc; c++) {
        const p = (c - 1) / nc;
        let idx = Math.min(N - 1, Math.floor(Math.pow(p, gamma) * N));
        if (c === nc) idx = N - 1; // pin: top complexity always hits the strongest rung
        assert.ok(idx >= prev, `N=${N} bias=${bias} non-monotonic at c${c}`);
        assert.ok(idx >= 0 && idx <= N - 1, `N=${N} bias=${bias} idx out of range`);
        prev = idx;
      }
      // Ends invariant: c1 -> 0, top -> N-1.
      const first = Math.min(N - 1, Math.floor(Math.pow(0, gamma) * N));
      assert.strictEqual(first, 0, `N=${N} bias=${bias} start`);
      assert.strictEqual(prev, N - 1, `N=${N} bias=${bias} end reaches top`);
    }
  }
});

test('exact ladder: all tiers, max off, bias 0 (crossovers + tie-break, SQ-134 floor bucketing)', () => {
  // seq (score, tie->higher tier later): h0, sL2, sM3, sH4, oL4, sX5, oM5, oH6,
  // oX7, fL8, fM9, fH10, fX11 — N=13 bins; idx = min(12, floor((c-1)/10 * 13)),
  // with c=10 pinned to 12 (no max rung). Floor bucketing skips some rungs
  // entirely (opus.low, opus.xhigh, fable.high never surface here) rather than
  // round()'s interior-weighted spread — that's the intended bottom-weighting.
  // The sonnet<->opus boundary still ties/overlaps (sH4~oL4, sX5~oM5,
  // unchanged), but the opus<->fable boundary (SQ-93) no longer does:
  // opus.xhigh(7) sits strictly below fable.low(8).
  const prefs = mkPrefs(TIER_ORDER, ['low', 'medium', 'high', 'xhigh'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'haiku.null', 'sonnet.low', 'sonnet.medium', 'sonnet.high', 'sonnet.xhigh',
    'opus.medium', 'opus.high', 'fable.low', 'fable.medium', 'fable.xhigh',
  ]);
});

test('SQ-93 oracle: fable.low ranks strictly above opus.high (widened opus<->fable gap)', () => {
  // Under the OLD uniform gap (tierRank*2), opus.high scored 2*2+2=6 and
  // fable.low scored 3*2+0=6 — an exact tie, broken toward fable (the higher
  // tier) so fable.low still landed just above opus.high in the merged order.
  // The new per-tier base (opus=4, fable=8) pushes fable's floor strictly past
  // opus's ceiling (4+2=6 < 8+0=8): no tie, no ambiguity.
  const fableLowScore = TIER_BASE.fable + EFFORT_ORDER.indexOf('low');
  const opusHighScore = TIER_BASE.opus + EFFORT_ORDER.indexOf('high');
  assert.ok(
    fableLowScore > opusHighScore,
    `fable.low score (${fableLowScore}) must be strictly above opus.high score (${opusHighScore})`
  );

  // End-to-end, through the actual merged sequence (opus+fable, all non-max
  // efforts enabled, bias 0): opus.high must appear at a lower complexity than
  // fable.low.
  const prefs = mkPrefs(['opus', 'fable'], EFFORT_ORDER, 0);
  const ladder = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  const idxOpusHigh = ladder.indexOf('opus.high');
  const idxFableLow = ladder.indexOf('fable.low');
  assert.ok(idxOpusHigh !== -1, 'opus.high must appear in the ladder');
  assert.ok(idxFableLow !== -1, 'fable.low must appear in the ladder');
  assert.ok(
    idxOpusHigh < idxFableLow,
    `opus.high (c${idxOpusHigh + 1}) must rank below fable.low (c${idxFableLow + 1})`
  );
});

test('SQ-93 oracle: sonnet.xhigh still ties-or-adjacent opus.medium (unchanged crossover)', () => {
  const sonnetXhighScore = TIER_BASE.sonnet + EFFORT_ORDER.indexOf('xhigh');
  const opusMediumScore = TIER_BASE.opus + EFFORT_ORDER.indexOf('medium');
  assert.ok(
    Math.abs(sonnetXhighScore - opusMediumScore) <= 1,
    `sonnet.xhigh score (${sonnetXhighScore}) and opus.medium score (${opusMediumScore}) must tie or be adjacent`
  );
  // This boundary is unchanged from the old formula: an exact tie, resolved to
  // the higher tier (opus) by the tie-break rule.
  assert.strictEqual(sonnetXhighScore, opusMediumScore, 'sonnet.xhigh == opus.medium (exact tie, unchanged)');

  const prefs = mkPrefs(['sonnet', 'opus'], EFFORT_ORDER, 0);
  const ladder = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  const idxSonnetXhigh = ladder.indexOf('sonnet.xhigh');
  const idxOpusMedium = ladder.indexOf('opus.medium');
  assert.ok(idxSonnetXhigh !== -1 && idxOpusMedium !== -1, 'both rungs appear in the ladder');
  assert.ok(
    idxOpusMedium >= idxSonnetXhigh,
    `opus.medium (c${idxOpusMedium + 1}) must not rank below sonnet.xhigh (c${idxSonnetXhigh + 1})`
  );
});

test('skipped middle tier keeps absolute ranks: haiku+opus, low+medium, bias 0 (SQ-134 floor bucketing)', () => {
  // seq: h0, opus.low(4), opus.medium(5) — N=3 bins, no max rung (normalCount=10).
  // idx = min(2, floor((c-1)/10 * 3)): bottom-weighted, so haiku (the cheapest
  // bucket) now claims 4 complexities instead of round()'s 3.
  const prefs = mkPrefs(['haiku', 'opus'], ['low', 'medium'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'haiku.null', 'haiku.null', 'haiku.null', 'haiku.null', 'opus.low',
    'opus.low', 'opus.low', 'opus.medium', 'opus.medium', 'opus.medium',
  ]);
});

test('C9 max edge: haiku+opus all efforts, bias +5 gives max at 9 and 10 only', () => {
  const ladder = routingLadder(mkPrefs(['haiku', 'opus'], ALL_EFFORTS, 5));
  assert.deepStrictEqual(
    ladder.filter((r) => r.effort === 'max').map((r) => r.complexity),
    [9, 10]
  );
  assert.strictEqual(ladder[8].model, 'opus');
  // At bias +3 (and below), c9 stays off max.
  const l3 = routingLadder(mkPrefs(['haiku', 'opus'], ALL_EFFORTS, 3));
  assert.notStrictEqual(l3[8].effort, 'max');
  assert.strictEqual(l3[9].effort, 'max');
});

// SQ-134 acceptance tables: bottom-weighted floor bucketing, spec prefs
// {haiku:false, sonnet:true, opus:true, fable:false,
//  efforts:{sonnet:{low:false,medium:false},opus:{low:false,medium:false}}}
// i.e. sonnet hi+xhi, opus hi+xhi+max (low/medium off on both, max defaults on).
const SQ134_TICKET_EFFORTS = { sonnet: ['high', 'xhigh', 'max'], opus: ['high', 'xhigh', 'max'] };

test('SQ-134 acceptance: neutral bias 0 (sonnet hi+xhi, opus hi+xhi+max)', () => {
  const prefs = mkPrefs(['sonnet', 'opus'], SQ134_TICKET_EFFORTS, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'sonnet.high', 'sonnet.high', 'sonnet.high',
    'sonnet.xhigh', 'sonnet.xhigh',
    'opus.high', 'opus.high',
    'opus.xhigh', 'opus.xhigh',
    'opus.max',
  ]);
});

test('SQ-134 acceptance: frugal bias -5, gamma=3 (sonnet hi+xhi, opus hi+xhi+max) — opus.xhigh absent below max', () => {
  const prefs = mkPrefs(['sonnet', 'opus'], SQ134_TICKET_EFFORTS, -5);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'sonnet.high', 'sonnet.high', 'sonnet.high', 'sonnet.high', 'sonnet.high', 'sonnet.high',
    'sonnet.xhigh', 'sonnet.xhigh',
    'opus.high',
    'opus.max',
  ]);
  assert.ok(!got.includes('opus.xhigh'), 'opus.xhigh must not appear below the max rung at frugal bias');
});

test('SQ-134 acceptance: full matrix, both tiers all four efforts + max, bias 0 — top normal rung at C9', () => {
  const prefs = mkPrefs(['sonnet', 'opus'], ALL_EFFORTS, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'sonnet.low', 'sonnet.low', 'sonnet.medium', 'sonnet.high', 'opus.low',
    'sonnet.xhigh', 'opus.medium', 'opus.high', 'opus.xhigh', 'opus.max',
  ]);
  assert.strictEqual(got[0], 'sonnet.low', 'C1-2 land the cheapest rung');
  assert.strictEqual(got[1], 'sonnet.low', 'C1-2 land the cheapest rung');
  assert.strictEqual(got[8], 'opus.xhigh', 'C9 reaches the top NORMAL rung');
  assert.strictEqual(got[9], 'opus.max', 'C10 is the sparing max rung');
});

test('SQ-134 invariants: ticket prefs (sonnet hi+xhi, opus hi+xhi+max) hold at every bias -5..+5', () => {
  for (let bias = -5; bias <= 5; bias++) {
    const label = `bias ${bias}`;
    const ladder = routingLadder(mkPrefs(['sonnet', 'opus'], SQ134_TICKET_EFFORTS, bias));
    // C1 = cheapest enabled rung.
    assert.strictEqual(ladder[0].model, 'sonnet', `${label} C1 cheapest tier`);
    assert.strictEqual(ladder[0].effort, 'high', `${label} C1 cheapest effort`);
    // C10 = max rung (hasMaxRung is true here: opus's row keeps max enabled).
    assert.strictEqual(ladder[9].model, 'opus', `${label} C10 top tier`);
    assert.strictEqual(ladder[9].effort, 'max', `${label} C10 hits the max rung`);
    // Monotone non-decreasing capability across C1..C10.
    const rank = (r) => {
      if (r.effort === 'max') return Infinity;
      const base = r.model === 'opus' ? 4 : 2;
      return base + ['low', 'medium', 'high', 'xhigh'].indexOf(r.effort);
    };
    for (let i = 1; i < 10; i++) {
      assert.ok(rank(ladder[i]) >= rank(ladder[i - 1]), `${label} monotone at c${i}->c${i + 1}`);
    }
  }
});

test('only max enabled: max carries the whole sequence, no extra sparing rung', () => {
  const ladder = routingLadder(mkPrefs(['sonnet', 'opus'], ['max'], 0));
  ladder.forEach((r) => assert.strictEqual(r.effort, 'max'));
  assert.strictEqual(ladder[0].model, 'sonnet');
  assert.strictEqual(ladder[9].model, 'opus');
});

test('haiku-only: 10 effort-null rungs, no max even when max enabled', () => {
  for (const bias of BIASES) {
    const ladder = routingLadder(mkPrefs(['haiku'], ALL_EFFORTS, bias));
    ladder.forEach((r) => {
      assert.strictEqual(r.model, 'haiku');
      assert.strictEqual(r.effort, null);
    });
  }
});

test('single tier + single effort: constant ladder', () => {
  const ladder = routingLadder(mkPrefs(['sonnet'], ['high'], -5));
  ladder.forEach((r) => {
    assert.strictEqual(r.model, 'sonnet');
    assert.strictEqual(r.effort, 'high');
  });
});

test('empty prefs can never yield an empty ladder (defensive fallbacks)', () => {
  const prefs = mkPrefs([], [], 0); // all tiers + efforts false — unreachable via setModelPrefs
  const ladder = routingLadder(prefs);
  assert.strictEqual(ladder.length, 10);
  ladder.forEach((r) => {
    assert.strictEqual(r.model, 'sonnet');
    assert.strictEqual(r.effort, 'medium');
  });
});

test('setModelPrefs guards: refusing to disable every tier / every effort per row', () => {
  const allOff = {};
  for (const t of TIER_ORDER) allOff[t] = false;
  for (const e of ALL_EFFORTS) allOff[e] = false; // flat keys broadcast "off" to every model row
  const saved = setModelPrefs(allOff);
  assert.ok(TIER_ORDER.some((t) => saved[t]), 'at least one tier stays enabled');
  assert.strictEqual(saved.sonnet, true);
  // Per-row guard: every model row keeps at least one effort, falling back to medium.
  for (const m of EFFORT_MODELS) {
    assert.ok(ALL_EFFORTS.some((e) => saved.efforts[m][e]), `${m} keeps an effort enabled`);
    assert.strictEqual(saved.efforts[m].medium, true, `${m} falls back to medium`);
  }
  // Disk shape is the nested matrix only — no flat effort keys leak to the top level.
  for (const e of ALL_EFFORTS) assert.ok(!(e in saved), `no flat "${e}" key written to disk`);
  // routingBias clamps on write.
  assert.strictEqual(setModelPrefs({ routingBias: 99 }).routingBias, 5);
  assert.strictEqual(setModelPrefs({ routingBias: -99 }).routingBias, -5);
  assert.strictEqual(setModelPrefs({ routingBias: 'garbage' }).routingBias, 0);
});

test('per-model efforts: disabling opus.medium drops that rung but keeps sonnet.medium', () => {
  const prefs = mkPrefs(['sonnet', 'opus'], {
    sonnet: ['low', 'medium', 'high', 'xhigh'],
    opus: ['low', 'high', 'xhigh'], // medium excluded on opus only
  }, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.ok(got.includes('sonnet.medium'), 'sonnet.medium still routed');
  assert.ok(!got.includes('opus.medium'), 'opus.medium never routed');
  // opus's other rungs survive, so it's a targeted exclusion, not opus-wide.
  assert.ok(got.includes('opus.low') && got.includes('opus.high'), 'opus keeps its other rungs');
});

test('per-model efforts: disabling fable.max (all tiers on) removes the sparing rung, c10 = top normal rung', () => {
  const prefs = mkPrefs(TIER_ORDER, {
    sonnet: ALL_EFFORTS,
    opus: ALL_EFFORTS,
    fable: ['low', 'medium', 'high', 'xhigh'], // top tier's row has max OFF
  }, 0);
  const ladder = routingLadder(prefs);
  const got = ladder.map((r) => `${r.model}.${r.effort}`);
  assert.ok(!got.some((s) => s.endsWith('.max')), 'no max rung anywhere (top tier max off)');
  assert.strictEqual(got[9], 'fable.xhigh', 'c10 lands the top normal rung');
});

test('migration: a legacy flat-key file on disk broadcasts into every model row', () => {
  const file = path.join(process.env.SWITCHBOARD_HOME, 'prefs.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Old shape: no `efforts` object, just the flat effort booleans.
  fs.writeFileSync(file, JSON.stringify({
    haiku: true, sonnet: true, opus: true, fable: true,
    low: true, medium: false, high: true, xhigh: true, max: false,
    routing: true, routingBias: 0,
  }));
  const prefs = store.getModelPrefs();
  assert.ok(!('medium' in prefs), 'flat effort keys are gone from the returned shape');
  assert.ok(prefs.efforts && !prefs.efforts.haiku, 'haiku has no efforts row');
  for (const m of EFFORT_MODELS) {
    assert.deepStrictEqual(prefs.efforts[m], {
      low: true, medium: false, high: true, xhigh: true, max: false,
    }, `${m} row seeded from the legacy flat values`);
  }
});

test('setModelPrefs: a flat-key patch broadcasts to every model row and writes nested only', () => {
  const saved = setModelPrefs({ low: true, medium: false, high: true, xhigh: true, max: true });
  for (const m of EFFORT_MODELS) {
    assert.deepStrictEqual(saved.efforts[m], {
      low: true, medium: false, high: true, xhigh: true, max: true,
    }, `${m} row set from the flat patch`);
  }
  for (const e of ALL_EFFORTS) assert.ok(!(e in saved), `no flat "${e}" key on the written shape`);
});

test('setModelPrefs: per-row guard — disabling all of opus efforts leaves opus.medium on', () => {
  // Start from a known-good baseline so sonnet/fable rows are unaffected by prior tests.
  setModelPrefs({ efforts: { sonnet: ALL_EFFORTS.reduce((o, e) => ((o[e] = true), o), {}) } });
  const saved = setModelPrefs({
    efforts: { opus: { low: false, medium: false, high: false, xhigh: false, max: false } },
  });
  assert.strictEqual(saved.efforts.opus.medium, true, 'opus falls back to medium');
  for (const e of ['low', 'high', 'xhigh', 'max']) {
    assert.strictEqual(saved.efforts.opus[e], false, `opus.${e} stays off`);
  }
  // The nested patch touched only opus; sonnet keeps its full row.
  assert.strictEqual(saved.efforts.sonnet.low, true, 'sonnet row untouched by the opus-only patch');
});

test('deriveRouting: shape and null on invalid complexity', () => {
  const prefs = mkPrefs(TIER_ORDER, ALL_EFFORTS, 0);
  const r = deriveRouting(7, prefs);
  assert.ok(r && typeof r.model === 'string' && ('effort' in r));
  assert.strictEqual(deriveRouting(null, prefs), null);
  assert.strictEqual(deriveRouting('nope', prefs), null);
  assert.strictEqual(deriveRouting(0, prefs), null);
  assert.strictEqual(deriveRouting(11, prefs), null);
  assert.strictEqual(coerceComplexity('7.4'), 7);
});
