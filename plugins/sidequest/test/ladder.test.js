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
const { routingLadder, deriveRouting, coerceComplexity, setModelPrefs } = store;

const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
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
};

const BIASES = [-5, -3, 0, 3, 5];

function mkPrefs(tiers, efforts, bias) {
  const p = { routingBias: bias };
  for (const t of TIER_ORDER) p[t] = tiers.includes(t);
  for (const e of ALL_EFFORTS) p[e] = efforts.includes(e);
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

test('gamma index map: monotone, ends invariant, for N=1..16 at every integer bias', () => {
  // Mirrors the store's remap: idx = round(p^gamma * (N-1)), p = (c-1)/(nc-1).
  for (let N = 1; N <= 16; N++) {
    for (let bias = -5; bias <= 5; bias++) {
      const gamma = Math.pow(3, -bias / 5);
      const nc = 10; // normal count without a max rung
      let prev = -1;
      for (let c = 1; c <= nc; c++) {
        const p = nc > 1 ? (c - 1) / (nc - 1) : 0;
        const idx = N - 1 <= 0 ? 0 : Math.round(Math.pow(p, gamma) * (N - 1));
        assert.ok(idx >= prev, `N=${N} bias=${bias} non-monotonic at c${c}`);
        assert.ok(idx >= 0 && idx <= N - 1, `N=${N} bias=${bias} idx out of range`);
        prev = idx;
      }
      // Ends invariant: c1 -> 0, top -> N-1.
      const first = N - 1 <= 0 ? 0 : Math.round(Math.pow(0, gamma) * (N - 1));
      assert.strictEqual(first, 0, `N=${N} bias=${bias} start`);
      assert.strictEqual(prev, N - 1 <= 0 ? 0 : N - 1, `N=${N} bias=${bias} end reaches top`);
    }
  }
});

test('exact ladder: all tiers, max off, bias 0 (crossovers + tie-break)', () => {
  // seq (score, tie->higher tier later): h0, sL2, sM3, sH4, oL4, sX5, oM5, oH6,
  // oX7, fL8, fM9, fH10, fX11 — N=13; idx = round((c-1)/9*12). Note the
  // sonnet<->opus boundary still ties/overlaps (sH4~oL4, sX5~oM5, unchanged),
  // but the opus<->fable boundary (SQ-93) no longer does: opus.xhigh(7) sits
  // strictly below fable.low(8), so opus keeps its own ceiling (c6/c7 below)
  // before the ladder ever reaches fable's cheapest rung.
  const prefs = mkPrefs(TIER_ORDER, ['low', 'medium', 'high', 'xhigh'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'haiku.null', 'sonnet.low', 'sonnet.high', 'opus.low', 'sonnet.xhigh',
    'opus.high', 'opus.xhigh', 'fable.low', 'fable.high', 'fable.xhigh',
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

test('skipped middle tier keeps absolute ranks: haiku+opus, low+medium, bias 0', () => {
  const prefs = mkPrefs(['haiku', 'opus'], ['low', 'medium'], 0);
  const got = routingLadder(prefs).map((r) => `${r.model}.${r.effort}`);
  assert.deepStrictEqual(got, [
    'haiku.null', 'haiku.null', 'haiku.null', 'opus.low', 'opus.low',
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

test('setModelPrefs guards: refusing to disable every tier / every effort', () => {
  const allOff = {};
  for (const t of TIER_ORDER) allOff[t] = false;
  for (const e of ALL_EFFORTS) allOff[e] = false;
  const saved = setModelPrefs(allOff);
  assert.ok(TIER_ORDER.some((t) => saved[t]), 'at least one tier stays enabled');
  assert.ok(ALL_EFFORTS.some((e) => saved[e]), 'at least one effort stays enabled');
  assert.strictEqual(saved.sonnet, true);
  assert.strictEqual(saved.medium, true);
  // routingBias clamps on write.
  assert.strictEqual(setModelPrefs({ routingBias: 99 }).routingBias, 5);
  assert.strictEqual(setModelPrefs({ routingBias: -99 }).routingBias, -5);
  assert.strictEqual(setModelPrefs({ routingBias: 'garbage' }).routingBias, 0);
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
