'use strict';
/**
 * Invariant tests for the complexity routing ladder (SQ-84 audit).
 * Run: node --test plugins/sidequest/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the store at a throwaway home so pref reads/writes never touch the real one.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-ladder-test-'));

const store = require('../lib/store.js');
const db = require('../lib/db.js');
const { routingLadder, deriveRouting, coerceComplexity, setModelPrefs } = store;

const TIER_ORDER = ['grade-1', 'grade-2', 'grade-3', 'grade-4'];
const EFFORT_MODELS = TIER_ORDER.slice(); // every grade stores a row; grade-1 uses it only with an effort-capable runtime
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh']; // non-max scale
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Per-tier base offsets mirroring store.js's LADDER_TIER_BASE (SQ-93: the
// sonnet<->opus boundary keeps the old uniform gap of 2 — evidence-supported
// crossover, unchanged — while the opus<->fable boundary widens to a gap of 4,
// eliminating the previously-unsupported grade-4.low == grade-3.high tie).
const TIER_BASE = { 'grade-1': 0, 'grade-2': 2, 'grade-3': 4, 'grade-4': 8 };

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
function mkPrefs(tiers, efforts, bias, tierBackend) {
  const p = { routingBias: bias, tierBackend: tierBackend || {} };
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
          if (r.model === 'grade-1') {
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
        const hasMaxRung = efforts.includes('max') && !maxInSequence && topTier !== 'grade-1';

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
        if (cheapTier !== 'grade-1') {
          const seqEfforts = maxInSequence ? efforts : nonMaxEfforts;
          assert.strictEqual(ladder[0].effort, seqEfforts[0], `${label} c1 weakest effort`);
        }
        // c10 -> top rung: top tier at its strongest available effort.
        assert.strictEqual(ladder[9].model, topTier, `${label} c10 top tier`);
        if (topTier !== 'grade-1') {
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
  // entirely (grade-3.low, grade-3.xhigh, grade-4.high never surface here) rather than
  // round()'s interior-weighted spread — that's the intended bottom-weighting.
  // The sonnet<->opus boundary still ties/overlaps (sH4~oL4, sX5~oM5,
  // unchanged), but the opus<->fable boundary (SQ-93) no longer does:
  // grade-3.xhigh(7) sits strictly below grade-4.low(8).
  const prefs = mkPrefs(TIER_ORDER, ['low', 'medium', 'high', 'xhigh'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'grade-1.null', 'grade-2.low', 'grade-2.medium', 'grade-2.high', 'grade-2.xhigh',
    'grade-3.medium', 'grade-3.high', 'grade-4.low', 'grade-4.medium', 'grade-4.xhigh',
  ]);
});

test('SQ-93 oracle: grade-4.low ranks strictly above grade-3.high (widened opus<->fable gap)', () => {
  // Under the OLD uniform gap (tierRank*2), grade-3.high scored 2*2+2=6 and
  // grade-4.low scored 3*2+0=6 — an exact tie, broken toward fable (the higher
  // tier) so grade-4.low still landed just above grade-3.high in the merged order.
  // The new per-tier base (opus=4, fable=8) pushes fable's floor strictly past
  // opus's ceiling (4+2=6 < 8+0=8): no tie, no ambiguity.
  const fableLowScore = TIER_BASE["grade-4"] + EFFORT_ORDER.indexOf('low');
  const opusHighScore = TIER_BASE["grade-3"] + EFFORT_ORDER.indexOf('high');
  assert.ok(
    fableLowScore > opusHighScore,
    `grade-4.low score (${fableLowScore}) must be strictly above grade-3.high score (${opusHighScore})`
  );

  // End-to-end, through the actual merged sequence (opus+fable, all non-max
  // efforts enabled, bias 0): grade-3.high must appear at a lower complexity than
  // grade-4.low.
  const prefs = mkPrefs(['grade-3', 'grade-4'], EFFORT_ORDER, 0);
  const ladder = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  const idxOpusHigh = ladder.indexOf('grade-3.high');
  const idxFableLow = ladder.indexOf('grade-4.low');
  assert.ok(idxOpusHigh !== -1, 'grade-3.high must appear in the ladder');
  assert.ok(idxFableLow !== -1, 'grade-4.low must appear in the ladder');
  assert.ok(
    idxOpusHigh < idxFableLow,
    `grade-3.high (c${idxOpusHigh + 1}) must rank below grade-4.low (c${idxFableLow + 1})`
  );
});

test('SQ-93 oracle: grade-2.xhigh still ties-or-adjacent grade-3.medium (unchanged crossover)', () => {
  const sonnetXhighScore = TIER_BASE["grade-2"] + EFFORT_ORDER.indexOf('xhigh');
  const opusMediumScore = TIER_BASE["grade-3"] + EFFORT_ORDER.indexOf('medium');
  assert.ok(
    Math.abs(sonnetXhighScore - opusMediumScore) <= 1,
    `grade-2.xhigh score (${sonnetXhighScore}) and grade-3.medium score (${opusMediumScore}) must tie or be adjacent`
  );
  // This boundary is unchanged from the old formula: an exact tie, resolved to
  // the higher tier (opus) by the tie-break rule.
  assert.strictEqual(sonnetXhighScore, opusMediumScore, 'grade-2.xhigh == grade-3.medium (exact tie, unchanged)');

  const prefs = mkPrefs(['grade-2', 'grade-3'], EFFORT_ORDER, 0);
  const ladder = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  const idxSonnetXhigh = ladder.indexOf('grade-2.xhigh');
  const idxOpusMedium = ladder.indexOf('grade-3.medium');
  assert.ok(idxSonnetXhigh !== -1 && idxOpusMedium !== -1, 'both rungs appear in the ladder');
  assert.ok(
    idxOpusMedium >= idxSonnetXhigh,
    `grade-3.medium (c${idxOpusMedium + 1}) must not rank below grade-2.xhigh (c${idxSonnetXhigh + 1})`
  );
});

test('skipped middle tier keeps absolute ranks: haiku+opus, low+medium, bias 0 (SQ-134 floor bucketing)', () => {
  // seq: h0, grade-3.low(4), grade-3.medium(5) — N=3 bins, no max rung (normalCount=10).
  // idx = min(2, floor((c-1)/10 * 3)): bottom-weighted, so haiku (the cheapest
  // bucket) now claims 4 complexities instead of round()'s 3.
  const prefs = mkPrefs(['grade-1', 'grade-3'], ['low', 'medium'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'grade-1.null', 'grade-1.null', 'grade-1.null', 'grade-1.null', 'grade-3.low',
    'grade-3.low', 'grade-3.low', 'grade-3.medium', 'grade-3.medium', 'grade-3.medium',
  ]);
});

test('C9 max edge: haiku+opus all efforts, bias +5 gives max at 9 and 10 only', () => {
  const ladder = routingLadder(mkPrefs(['grade-1', 'grade-3'], ALL_EFFORTS, 5));
  assert.deepStrictEqual(
    ladder.filter((r) => r.effort === 'max').map((r) => r.complexity),
    [9, 10]
  );
  assert.strictEqual(ladder[8].model, 'grade-3');
  // At bias +3 (and below), c9 stays off max.
  const l3 = routingLadder(mkPrefs(['grade-1', 'grade-3'], ALL_EFFORTS, 3));
  assert.notStrictEqual(l3[8].effort, 'max');
  assert.strictEqual(l3[9].effort, 'max');
});

// SQ-134 acceptance tables: bottom-weighted floor bucketing, spec prefs
// {'grade-1':false, 'grade-2':true, 'grade-3':true, 'grade-4':false,
//  efforts:{'grade-2':{low:false,medium:false},'grade-3':{low:false,medium:false}}}
// i.e. sonnet hi+xhi, opus hi+xhi+max (low/medium off on both, max defaults on).
const SQ134_TICKET_EFFORTS = { 'grade-2': ['high', 'xhigh', 'max'], 'grade-3': ['high', 'xhigh', 'max'] };

test('SQ-134 acceptance: neutral bias 0 (sonnet hi+xhi, opus hi+xhi+max)', () => {
  const prefs = mkPrefs(['grade-2', 'grade-3'], SQ134_TICKET_EFFORTS, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'grade-2.high', 'grade-2.high', 'grade-2.high',
    'grade-2.xhigh', 'grade-2.xhigh',
    'grade-3.high', 'grade-3.high',
    'grade-3.xhigh', 'grade-3.xhigh',
    'grade-3.max',
  ]);
});

test('SQ-134 acceptance: frugal bias -5, gamma=3 (sonnet hi+xhi, opus hi+xhi+max) — grade-3.xhigh absent below max', () => {
  const prefs = mkPrefs(['grade-2', 'grade-3'], SQ134_TICKET_EFFORTS, -5);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'grade-2.high', 'grade-2.high', 'grade-2.high', 'grade-2.high', 'grade-2.high', 'grade-2.high',
    'grade-2.xhigh', 'grade-2.xhigh',
    'grade-3.high',
    'grade-3.max',
  ]);
  assert.ok(!got.includes('grade-3.xhigh'), 'grade-3.xhigh must not appear below the max rung at frugal bias');
});

test('SQ-134 acceptance: full matrix, both tiers all four efforts + max, bias 0 — top normal rung at C9', () => {
  const prefs = mkPrefs(['grade-2', 'grade-3'], ALL_EFFORTS, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'grade-2.low', 'grade-2.low', 'grade-2.medium', 'grade-2.high', 'grade-3.low',
    'grade-2.xhigh', 'grade-3.medium', 'grade-3.high', 'grade-3.xhigh', 'grade-3.max',
  ]);
  assert.strictEqual(got[0], 'grade-2.low', 'C1-2 land the cheapest rung');
  assert.strictEqual(got[1], 'grade-2.low', 'C1-2 land the cheapest rung');
  assert.strictEqual(got[8], 'grade-3.xhigh', 'C9 reaches the top NORMAL rung');
  assert.strictEqual(got[9], 'grade-3.max', 'C10 is the sparing max rung');
});

test('SQ-134 invariants: ticket prefs (sonnet hi+xhi, opus hi+xhi+max) hold at every bias -5..+5', () => {
  for (let bias = -5; bias <= 5; bias++) {
    const label = `bias ${bias}`;
    const ladder = routingLadder(mkPrefs(['grade-2', 'grade-3'], SQ134_TICKET_EFFORTS, bias));
    // C1 = cheapest enabled rung.
    assert.strictEqual(ladder[0].model, 'grade-2', `${label} C1 cheapest tier`);
    assert.strictEqual(ladder[0].effort, 'high', `${label} C1 cheapest effort`);
    // C10 = max rung (hasMaxRung is true here: opus's row keeps max enabled).
    assert.strictEqual(ladder[9].model, 'grade-3', `${label} C10 top tier`);
    assert.strictEqual(ladder[9].effort, 'max', `${label} C10 hits the max rung`);
    // Monotone non-decreasing capability across C1..C10.
    const rank = (r) => {
      if (r.effort === 'max') return Infinity;
      const base = r.model === 'grade-3' ? 4 : 2;
      return base + ['low', 'medium', 'high', 'xhigh'].indexOf(r.effort);
    };
    for (let i = 1; i < 10; i++) {
      assert.ok(rank(ladder[i]) >= rank(ladder[i - 1]), `${label} monotone at c${i}->c${i + 1}`);
    }
  }
});

test('only max enabled: max carries the whole sequence, no extra sparing rung', () => {
  const ladder = routingLadder(mkPrefs(['grade-2', 'grade-3'], ['max'], 0));
  ladder.forEach((r) => assert.strictEqual(r.effort, 'max'));
  assert.strictEqual(ladder[0].model, 'grade-2');
  assert.strictEqual(ladder[9].model, 'grade-3');
});

test('haiku-only: 10 effort-null rungs, no max even when max enabled', () => {
  for (const bias of BIASES) {
    const ladder = routingLadder(mkPrefs(['grade-1'], ALL_EFFORTS, bias));
    ladder.forEach((r) => {
      assert.strictEqual(r.model, 'grade-1');
      assert.strictEqual(r.effort, null);
    });
  }
});

test('single tier + single effort: constant ladder', () => {
  const ladder = routingLadder(mkPrefs(['grade-2'], ['high'], -5));
  ladder.forEach((r) => {
    assert.strictEqual(r.model, 'grade-2');
    assert.strictEqual(r.effort, 'high');
  });
});

test('explicit Claude Haiku keeps the mapped grade as ladder provenance', () => {
  const prefs = setModelPrefs({
    'grade-1': false, 'grade-2': true, 'grade-3': false, 'grade-4': false,
    tierBackend: { 'grade-2': 'haiku' },
  });
  const ladder = routingLadder(prefs);
  ladder.forEach((r) => {
    assert.strictEqual(r.model, 'grade-2');
    assert.strictEqual(r.effort, null);
  });
});

test('empty prefs can never yield an empty ladder (defensive fallbacks)', () => {
  const prefs = mkPrefs([], [], 0); // all tiers + efforts false — unreachable via setModelPrefs
  const ladder = routingLadder(prefs);
  assert.strictEqual(ladder.length, 10);
  ladder.forEach((r) => {
    assert.strictEqual(r.model, 'grade-2');
    assert.strictEqual(r.effort, 'medium');
  });
});

test('setModelPrefs guards: refusing to disable every tier / every effort per row', () => {
  const allOff = {};
  for (const t of TIER_ORDER) allOff[t] = false;
  for (const e of ALL_EFFORTS) allOff[e] = false; // flat keys broadcast "off" to every model row
  const saved = setModelPrefs(allOff);
  assert.ok(TIER_ORDER.some((t) => saved[t]), 'at least one tier stays enabled');
  assert.strictEqual(saved['grade-2'], true);
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

test('per-model efforts: disabling grade-3.medium drops that rung but keeps grade-2.medium', () => {
  const prefs = mkPrefs(['grade-2', 'grade-3'], {
    'grade-2': ['low', 'medium', 'high', 'xhigh'],
    'grade-3': ['low', 'high', 'xhigh'], // medium excluded on opus only
  }, 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.ok(got.includes('grade-2.medium'), 'grade-2.medium still routed');
  assert.ok(!got.includes('grade-3.medium'), 'grade-3.medium never routed');
  // opus's other rungs survive, so it's a targeted exclusion, not opus-wide.
  assert.ok(got.includes('grade-3.low') && got.includes('grade-3.high'), 'opus keeps its other rungs');
});

test('per-model efforts: disabling grade-4.max (all tiers on) removes the sparing rung, c10 = top normal rung', () => {
  const prefs = mkPrefs(TIER_ORDER, {
    'grade-2': ALL_EFFORTS,
    'grade-3': ALL_EFFORTS,
    'grade-4': ['low', 'medium', 'high', 'xhigh'], // top tier's row has max OFF
  }, 0);
  const ladder = routingLadder(prefs);
  const got = ladder.map((r) => `${r.model}.${r.effort}`);
  assert.ok(!got.some((s) => s.endsWith('.max')), 'no max rung anywhere (top tier max off)');
  assert.strictEqual(got[9], 'grade-4.xhigh', 'c10 lands the top normal rung');
});

test('migration: a legacy flat-key record broadcasts into every model row', () => {
  // Old shape: no `efforts` object, just the flat effort booleans.
  db.putRow(db.openDb(process.env.SIDEQUEST_HOME), 'globals', {
    key: 'model-prefs',
    data: {
      'grade-1': true, 'grade-2': true, 'grade-3': true, 'grade-4': true,
      low: true, medium: false, high: true, xhigh: true, max: false,
      routing: true, routingBias: 0,
    },
  });
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

test('setModelPrefs: per-row guard — disabling all of opus efforts leaves grade-3.medium on', () => {
  // Start from a known-good baseline so sonnet/fable rows are unaffected by prior tests.
  setModelPrefs({ efforts: { 'grade-2': ALL_EFFORTS.reduce((o, e) => ((o[e] = true), o), {}) } });
  const saved = setModelPrefs({
    efforts: { 'grade-3': { low: false, medium: false, high: false, xhigh: false, max: false } },
  });
  assert.strictEqual(saved.efforts["grade-3"].medium, true, 'opus falls back to medium');
  for (const e of ['low', 'high', 'xhigh', 'max']) {
    assert.strictEqual(saved.efforts["grade-3"][e], false, `grade-3.${e} stays off`);
  }
  // The nested patch touched only opus; sonnet keeps its full row.
  assert.strictEqual(saved.efforts["grade-2"].low, true, 'sonnet row untouched by the opus-only patch');
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
