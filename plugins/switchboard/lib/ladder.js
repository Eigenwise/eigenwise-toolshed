'use strict';
/**
 * switchboard - the ladder engine
 *
 * Complexity-scored model/effort routing, copied out of sidequest's
 * `lib/store.js` (the routing region) into its own home so it can run without
 * a ticket board. No projects, no tickets: just one user-level prefs file.
 *
 * Layout (root defaults to ~/.claude/switchboard, override with SWITCHBOARD_HOME):
 *
 *   <root>/
 *     prefs.json                          # which tiers/efforts are enabled + bias
 *
 * Source of truth for behavior changes is each plugin's own tests: this file is
 * a COPY, not a shared dependency, so sidequest and switchboard can each evolve
 * their engine independently once forked.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ *
 *  Root and path helpers
 * ------------------------------------------------------------------ */

function homeRoot() {
  const env = process.env.SWITCHBOARD_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.claude', 'switchboard');
}

function prefsFile() {
  return path.join(homeRoot(), 'prefs.json');
}

/* ------------------------------------------------------------------ *
 *  Low-level JSON IO (atomic-ish, fail-soft on read)
 * ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.floor(process.hrtime()[1] % 1e6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows rename onto an existing file can fail; replace explicitly.
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* ignore */
    }
    fs.renameSync(tmp, file);
  }
}

/* ------------------------------------------------------------------ *
 *  Vocabulary
 * ------------------------------------------------------------------ */

// The agent tiers the ladder routes across — the same aliases Claude Code's Task
// tool accepts, so the orchestrator can pass a derived tier straight through as
// a subagent's model.
const VALID_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

// How hard the executor should think — the reasoning-effort levels Claude Code
// supports in agent-definition frontmatter. Rides alongside `model` as the
// other half of the cost dial (model = capability tier, effort = thinking depth).
// Note: Haiku has no effort support at all — routing guidance lives in the
// skill, not enforced here.
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The tiers that carry an effort axis — every model except haiku (which has no
// reasoning-effort support). model-prefs stores one effort row per tier here, so
// a single (model, effort) combo like opus·medium can be excluded on its own.
const EFFORT_MODELS = VALID_MODELS.filter((m) => m !== 'haiku');

// Capability order, weakest first — the axis the ladder scales along.
// (VALID_MODELS is unordered vocabulary; this is the ranking.)
const MODEL_CAPABILITY_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

/* ------------------------------------------------------------------ *
 *  Complexity-driven routing
 *
 *  Score a task's complexity 1–10 (with a mandatory motivation — enforced at
 *  the entry points) and switchboard derives WHICH tier works it and HOW hard
 *  it thinks, by banding the score over the tiers the user has enabled in the
 *  model picker. Derivation happens at read time, so toggling a tier instantly
 *  re-routes every future score — nothing stored ever goes stale.
 * ------------------------------------------------------------------ */

// An integer score 1..10, or null when absent/garbage.
function coerceComplexity(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

// The routing bias: an integer dial ROUTING_BIAS_MIN..ROUTING_BIAS_MAX (default
// 0) that warps the complexity→tier ladder without changing which tiers are
// enabled. Negative = frugal (hold cheaper tiers for longer before escalating),
// positive = generous (escalate to pricier tiers sooner), 0 = today's neutral
// ladder. Clamped to range on write; anything unparseable degrades to 0, so a
// missing/garbage pref can never perturb the default routing.
const ROUTING_BIAS_MIN = -5;
const ROUTING_BIAS_MAX = 5;
function coerceRoutingBias(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(ROUTING_BIAS_MIN, Math.min(ROUTING_BIAS_MAX, n));
}

// Capability score for a rung: score = tierBase + effortIndex, where tierBase is
// a PER-TIER BASE OFFSET (LADDER_TIER_BASE below — keyed by tier, not a single
// uniform gap times tierRank) and effortIndex is the effort's position in the
// non-max effort list (low 0 … xhigh 3, a span of 3). SQ-87 researched real
// published benchmarks across the current model line (Sonnet 5 / Opus 4.8 /
// Fable 5) and found the two tier boundaries are NOT the same size, so a single
// constant gap applied at every boundary (the old LADDER_TIER_GAP=2) mis-modeled
// one of them:
//   - haiku(0) -> sonnet(2) -> opus(4): gap 2 at both boundaries, UNCHANGED.
//     This gap is deliberately SMALLER than the effort span (3) so
//     CAPABILITY-ADJACENT TIERS OVERLAP: a lower tier's top effort outranks the
//     next tier's bottom effort(s) (e.g. sonnet·xhigh ties opus·medium, and the
//     tie still resolves to opus — see tie-break below). SQ-87's benchmark
//     survey found a genuinely mixed sonnet/opus picture (Opus keeps a real edge
//     on SWE-bench Pro, but Sonnet wins Terminal-Bench and GDPval and ties HLE),
//     plus an effort-qualified data point that sonnet·xhigh is comparable to
//     opus·medium-to-high — so this crossover is evidence-supported and stays.
//   - opus(4) -> fable(8): gap WIDENED to 4 — the full effort span (3) plus one,
//     making this boundary fully tier-major (zero overlap). Every published
//     benchmark SQ-87 found has Fable 5 leading Opus 4.8, by a margin that GROWS
//     on harder tasks, with no observed crossover — a materially different, more
//     one-sided picture than sonnet/opus, so it doesn't belong on the same
//     constant. Under the old uniform gap, fable·low tied opus·high one tick
//     early (nothing in the evidence supports that); the widened gap fixes it —
//     fable·low now ranks strictly above opus·high, with opus·xhigh (Opus's own
//     ceiling) as the rung directly below it instead of being skipped.
// Bump a tier's offset further above its neighbor's to weaken/eliminate overlap
// there (more tier-major); pull it closer to widen the crossover band.
const LADDER_TIER_BASE = { haiku: 0, sonnet: 2, opus: 4, fable: 8 };
// The effort axis the score indexes along (max held out — it's the sparing top
// rung, ranked separately). Position in this list == a rung's effortIndex.
const LADDER_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

// Build the 10-rung ladder for the currently enabled prefs as ONE merged,
// capability-ranked sequence of (model, effort) rungs — not tier bands. Every
// enabled (tier × non-max effort) combo participates as a rung, scored by
// capability (see LADDER_TIER_BASE) so tiers overlap/diverge per boundary and
// crossovers happen where the evidence supports them; haiku
// carries no effort and contributes a single null rung below every richer tier's
// low rung. `max` is held out of that sequence and reserved for the very top of
// the scale ("use sparingly for the hardest tasks"). routingBias then curves how
// complexity 1..10 maps onto the sequence index (SQ-76 gamma remap), bending the
// whole combined model+effort cost curve. Returns [{ complexity: 1..10, model,
// effort }] — the shape every consumer already expects.
function routingLadder(prefs) {
  prefs = prefs || getModelPrefs();
  let enabled = MODEL_CAPABILITY_ORDER.filter((m) => prefs[m] !== false);
  if (!enabled.length) enabled = ['sonnet']; // unreachable via setModelPrefs, but never return an empty ladder

  // Resolve a tier's effort row from the per-model matrix, fail-soft to
  // all-enabled when the row (or the whole efforts object) is missing/garbage —
  // so an old flat-shape prefs object handed straight to routingLadder still
  // yields a full ladder rather than an empty one.
  const efforts = prefs.efforts && typeof prefs.efforts === 'object' ? prefs.efforts : {};
  function rowOf(model) {
    const r = efforts[model] && typeof efforts[model] === 'object' ? efforts[model] : null;
    const row = {};
    for (const e of VALID_EFFORTS) row[e] = r ? r[e] !== false : true;
    return row;
  }
  // The enabled non-max efforts of a tier's own row (the rungs it contributes to
  // the ranked sequence). `max` is held out — it's the sparing top rung.
  function seqEffortsOf(model) {
    return LADDER_EFFORT_ORDER.filter((e) => rowOf(model)[e] !== false);
  }

  // ENUMERATE every enabled combo programmatically and score it by capability.
  // Haiku → a single effort-null rung; every other tier → one rung per enabled
  // non-max effort IN ITS OWN ROW (so opus·medium can be excluded while
  // sonnet·medium stays). If a tier's row has ONLY max enabled, max carries that
  // tier's sequence rungs (the per-model maxInSequence fallback).
  const seq = [];
  for (let t = 0; t < enabled.length; t++) {
    const model = enabled[t];
    const tierRank = MODEL_CAPABILITY_ORDER.indexOf(model); // absolute, not enabled-relative
    if (model === 'haiku') {
      seq.push({ model: 'haiku', effort: null, tierRank, score: LADDER_TIER_BASE.haiku });
      continue;
    }
    const row = rowOf(model);
    let modelEfforts = seqEffortsOf(model);
    if (!modelEfforts.length) {
      // Nothing but max (or nothing) left on in this row: max carries the tier's
      // sequence; a fully-empty row (unreachable via setModelPrefs's per-row
      // guard) falls back to medium so the tier still contributes a rung.
      modelEfforts = row.max !== false ? ['max'] : ['medium'];
    }
    for (const eff of modelEfforts) {
      // 'max' only appears here in the only-max-enabled fallback; rank it above
      // the normal effort scale so it stays the strongest rung of its tier.
      const idx = eff === 'max' ? LADDER_EFFORT_ORDER.length : LADDER_EFFORT_ORDER.indexOf(eff);
      seq.push({ model, effort: eff, tierRank, score: LADDER_TIER_BASE[model] + idx });
    }
  }
  // RANK ascending by capability; exact cross-tier score ties (e.g. sonnet·high ==
  // opus·low) break by higher tier ranking above — one merged total order.
  seq.sort((a, b) => (a.score - b.score) || (a.tierRank - b.tierRank));

  // MAX SPARINGLY: the strongest enabled tier's ·max rung sits ABOVE the whole
  // sequence and is only reached at the very top of the complexity scale. It
  // exists iff the top enabled tier's OWN row has max enabled AND max isn't
  // already carrying that tier's sequence (only-max row). Haiku has no ·max, so
  // there's no max rung when it's the only/top tier.
  const topTier = enabled[enabled.length - 1];
  const hasMaxRung =
    topTier !== 'haiku' && rowOf(topTier).max !== false && seqEffortsOf(topTier).length > 0;
  const full = hasMaxRung ? seq.concat([{ model: topTier, effort: 'max' }]) : seq;

  // BIAS curves complexity → sequence index via the SQ-76 gamma remap. Reserve the
  // top complexities for the max rung: complexity 10 always, and 9 too only at the
  // most generous bias (+5); never below 9, at any bias. With no max rung, 10
  // lands the top of the normal sequence instead.
  const bias = coerceRoutingBias(prefs.routingBias);
  const gamma = Math.pow(3, -bias / 5);
  const maxCount = hasMaxRung ? (bias >= ROUTING_BIAS_MAX ? 2 : 1) : 0;
  const normalCount = 10 - maxCount;      // complexities 1..normalCount hit the sequence
  const maxIdx = full.length - 1;         // index of the max rung (only used when hasMaxRung)
  const lastNormal = seq.length - 1;      // top index of the normal sequence

  const out = [];
  for (let c = 1; c <= 10; c++) {
    let rung;
    if (hasMaxRung && c > normalCount) {
      rung = full[maxIdx];
    } else {
      // BOTTOM-WEIGHTED FLOOR BUCKETING (SQ-134): p in [0,1) uses normalCount (not
      // normalCount-1) as the divisor, so p never reaches 1 within this branch —
      // floor()ing frac*(lastNormal+1) then splits the sequence into lastNormal+1
      // equal-width buckets with the REMAINDER width falling on the cheapest
      // (lowest-index) buckets, instead of round()'s interior-weighted split. Cost
      // curves are convex, so neutral bias should be bottom-weighted. gamma still
      // bends p (bias>0 -> higher index sooner). Duplicates across adjacent
      // complexities are fine; we never index outside the enabled sequence.
      const p = (c - 1) / normalCount;
      const frac = Math.pow(p, gamma);
      let idx = Math.min(lastNormal, Math.floor(frac * (lastNormal + 1)));
      // c=10 must always hit the strongest rung. With a max rung the branch above
      // already handles c=10 (c > normalCount); without one, normalCount=10 so p
      // never quite reaches 1 here (0.9 at gamma=1) and a frugal gamma>1 can shrink
      // it further and undershoot the top rung — pin it explicitly.
      if (!hasMaxRung && c === 10) idx = lastNormal;
      rung = seq[idx];
    }
    out.push({ complexity: c, model: rung.model, effort: rung.effort });
  }
  return out;
}

// { model, effort } for a score under the current (or given) prefs, or null
// for a null/invalid score.
function deriveRouting(complexity, prefs) {
  const c = coerceComplexity(complexity);
  if (!c) return null;
  const rung = routingLadder(prefs)[c - 1];
  return { model: rung.model, effort: rung.effort };
}

/* ------------------------------------------------------------------ *
 *  Model prefs (which agent tiers AND effort levels the user wants offered)
 *
 *  A per-user allowlist over VALID_MODELS *and* VALID_EFFORTS. This is a
 *  UI/routing preference, not a data rule: routingLadder drops disabled effort
 *  levels from the within-band spread, and the skill tells the orchestrator to
 *  treat a disabled tier/effort as unavailable.
 * ------------------------------------------------------------------ */

// Missing/corrupt file -> every tier enabled, every effort enabled in every
// model row, routing on, and a neutral (0) bias. `routing` is the master switch:
// when false the skill's model/effort enforcement stands down and the main agent
// may work any task itself (a score becomes informational). `routingBias` (-5..+5)
// warps the complexity ladder routingLadder() derives from the enabled tiers
// (see coerceRoutingBias).
//
// Effort is a PER-MODEL MATRIX, not global booleans: `efforts` is one row per
// non-haiku tier ({ sonnet:{low..max}, opus:{...}, fable:{...} }) so a single
// (model, effort) combo like opus·medium can be excluded while sonnet·medium
// stays. Haiku has no efforts row (no effort axis). The flat effort keys
// (low/medium/high/xhigh/max) are NOT present on the returned object anymore.
//
// Migration on read: a legacy file that predates the matrix has no `efforts`
// object but may carry the old flat effort keys — seed EVERY model row from
// those flat values so an existing allowlist survives the upgrade unchanged.
function getModelPrefs() {
  const saved = readJson(prefsFile(), null);
  const merged = saved && typeof saved === 'object' ? saved : {};
  const out = {};
  for (const m of VALID_MODELS) out[m] = merged[m] !== false;

  const savedEfforts = merged.efforts && typeof merged.efforts === 'object' ? merged.efforts : null;
  // Only fall back to legacy flat keys when there's no matrix at all.
  const hasLegacyFlat = !savedEfforts && VALID_EFFORTS.some((e) => e in merged);
  out.efforts = {};
  for (const m of EFFORT_MODELS) {
    const savedRow = savedEfforts && merged.efforts[m] && typeof merged.efforts[m] === 'object' ? merged.efforts[m] : null;
    const row = {};
    for (const e of VALID_EFFORTS) {
      if (savedRow) row[e] = savedRow[e] !== false;
      else if (hasLegacyFlat) row[e] = merged[e] !== false; // broadcast the old global flag into this row
      else row[e] = true;
    }
    out.efforts[m] = row;
  }
  out.routing = merged.routing !== false;
  out.routingBias = coerceRoutingBias(merged.routingBias);
  return out;
}

// Persist a partial or full set. Unknown keys are dropped; refuses to disable
// every tier at once (the last enabled tier stays on) so routing always has
// somewhere to go.
//
// Accepts BOTH effort shapes in the patch: a nested `efforts` object (partial
// rows allowed, merged per-key over the current matrix) AND legacy flat effort
// keys (low/medium/…), which broadcast to EVERY model row. Only the nested
// matrix is written to disk. Per-row guard mirrors the tier guard: each model
// row keeps at least one effort enabled (fallback medium). The `routing` switch
// and `routingBias` dial carry through independently; routingBias clamps on
// write.
function setModelPrefs(patch) {
  const cur = getModelPrefs();
  patch = patch || {};
  const out = {};

  // Tiers: carried from the current set unless the patch names them.
  for (const m of VALID_MODELS) out[m] = (m in patch) ? patch[m] !== false : cur[m];
  if (!VALID_MODELS.some((m) => out[m])) out[VALID_MODELS.indexOf('sonnet') !== -1 ? 'sonnet' : VALID_MODELS[0]] = true;

  // Efforts: start from the current matrix, layer any legacy flat keys over every
  // row, then layer a nested patch row per-key on top (nested wins over flat).
  const patchEfforts = patch.efforts && typeof patch.efforts === 'object' ? patch.efforts : null;
  const flatKeys = VALID_EFFORTS.filter((e) => e in patch);
  out.efforts = {};
  for (const m of EFFORT_MODELS) {
    const row = Object.assign({}, cur.efforts[m]);
    for (const e of flatKeys) row[e] = patch[e] !== false;
    const pr = patchEfforts && patchEfforts[m] && typeof patchEfforts[m] === 'object' ? patchEfforts[m] : null;
    if (pr) for (const e of VALID_EFFORTS) { if (e in pr) row[e] = pr[e] !== false; }
    if (!VALID_EFFORTS.some((e) => row[e])) row.medium = true; // per-row guard: never leave a tier effortless
    out.efforts[m] = row;
  }

  out.routing = (patch.routing !== undefined) ? patch.routing !== false : cur.routing;
  out.routingBias = coerceRoutingBias(patch.routingBias !== undefined ? patch.routingBias : cur.routingBias);
  writeJson(prefsFile(), out);
  return out;
}

module.exports = {
  VALID_MODELS,
  VALID_EFFORTS,
  EFFORT_MODELS,
  MODEL_CAPABILITY_ORDER,
  coerceComplexity,
  ROUTING_BIAS_MIN,
  ROUTING_BIAS_MAX,
  coerceRoutingBias,
  LADDER_TIER_BASE,
  LADDER_EFFORT_ORDER,
  routingLadder,
  deriveRouting,
  getModelPrefs,
  setModelPrefs,
};
