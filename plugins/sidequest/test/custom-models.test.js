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

/* -------------------------------------------------------------- *
 *  execution profiles (SQ-188): the neutral user-facing plan over
 *  the unchanged internal tier ladder
 * -------------------------------------------------------------- */

const PROFILES = ['routine', 'everyday', 'complex', 'frontier'];
const PROFILE_TIER = { routine: 'haiku', everyday: 'sonnet', complex: 'opus', frontier: 'fable' };

// Reset the persisted prefs to the everything-on defaults with no backend map,
// so each profile test starts from a known state (this file's tests share one
// SIDEQUEST_HOME and setModelPrefs persists).
function resetPrefs() {
  const efforts = {};
  for (const m of EFFORT_MODELS) {
    efforts[m] = ALL_EFFORTS.reduce((o, e) => ((o[e] = true), o), {});
  }
  return setModelPrefs({
    haiku: true, sonnet: true, opus: true, fable: true,
    efforts,
    tierBackend: { haiku: 'claude', sonnet: 'claude', opus: 'claude', fable: 'claude' },
    routing: true, routingBias: 0,
  });
}

test('profile vocabulary: four profiles, bidirectional tier mapping', () => {
  assert.deepStrictEqual(store.EXECUTION_PROFILES, PROFILES);
  assert.strictEqual(store.tierForProfile('everyday'), 'sonnet');
  assert.strictEqual(store.tierForProfile('OPUS'), 'opus');      // a tier passes through
  assert.strictEqual(store.tierForProfile('nonsense'), null);
  assert.strictEqual(store.profileForTier('fable'), 'frontier');
  assert.strictEqual(store.profileForTier('routine'), 'routine'); // a profile passes through
  assert.strictEqual(store.profileForTier('nonsense'), null);
});

test('coerceModel: profile names resolve to their tier, old tier aliases unchanged', () => {
  assert.strictEqual(coerceModel('routine'), 'haiku');
  assert.strictEqual(coerceModel('EVERYDAY'), 'sonnet');
  assert.strictEqual(coerceModel('complex'), 'opus');
  assert.strictEqual(coerceModel('frontier'), 'fable');
  for (const tier of TIER_ORDER) assert.strictEqual(coerceModel(tier), tier, `legacy alias ${tier}`);
});

test('classifyModelFilter: a profile name filters as its tier', () => {
  assert.strictEqual(classifyModelFilter('complex'), 'opus');
  assert.strictEqual(classifyModelFilter('routine'), 'haiku');
  assert.strictEqual(classifyModelFilter('still-nonsense'), 'unknown');
});

test('getModelPrefs.profiles: default all-Claude view, tier prefs intact alongside', () => {
  clearCatalog();
  const prefs = resetPrefs();
  assert.deepStrictEqual(Object.keys(prefs.profiles), PROFILES);
  for (const p of PROFILES) {
    const row = prefs.profiles[p];
    assert.strictEqual(row.tier, PROFILE_TIER[p], `${p} tier`);
    assert.strictEqual(row.enabled, true, `${p} enabled`);
    assert.strictEqual(row.backend, 'claude', `${p} claude-backed by default`);
    assert.strictEqual(row.runsModel, PROFILE_TIER[p], `${p} runs its own tier`);
    assert.match(row.runsLabel, /^Claude /, `${p} human label`);
  }
  assert.strictEqual(prefs.profiles.routine.efforts, null, 'routine/haiku has no effort axis');
  assert.deepStrictEqual(prefs.profiles.complex.efforts, prefs.efforts.opus, 'profile efforts mirror the tier row');
  // The documented default ladder (all tiers, all efforts, bias 0) grouped by
  // profile — including the evidence-supported sonnet/opus crossover at C4/C5.
  assert.deepStrictEqual(prefs.profiles.routine.complexities, [1]);
  assert.deepStrictEqual(prefs.profiles.everyday.complexities, [2, 3, 5]);
  assert.deepStrictEqual(prefs.profiles.complex.complexities, [4, 6, 7]);
  assert.deepStrictEqual(prefs.profiles.frontier.complexities, [8, 9, 10]);
  assert.deepStrictEqual(prefs.profiles.frontier.range, [8, 10]);
  // The tier-keyed shape is still fully present (nothing migrated away).
  for (const tier of TIER_ORDER) assert.strictEqual(prefs[tier], true);
  assert.ok(prefs.efforts && prefs.tierBackend, 'tier prefs remain alongside the profiles view');
});

test('getModelPrefs.profiles: a Codex-backed tier surfaces as that profile\'s resolved runtime', () => {
  seedCatalog([TERRA]);
  resetPrefs();
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  assert.strictEqual(prefs.profiles.complex.backend, 'codex');
  assert.strictEqual(prefs.profiles.complex.runsModel, TERRA.slug);
  assert.strictEqual(prefs.profiles.complex.runsLabel, TERRA.label);
  // Effort matrix and the rest of the backend map are untouched by the view.
  assert.strictEqual(prefs.tierBackend.opus, TERRA.slug);
  assert.strictEqual(prefs.tierBackend.sonnet, 'claude');
  assert.deepStrictEqual(Object.keys(prefs.efforts).sort(), EFFORT_MODELS.slice().sort());
});

test('setModelPrefs: profile-keyed patches translate to tier keys, nothing profile-shaped persists', () => {
  seedCatalog([TERRA]);
  resetPrefs();
  // Enable/disable by profile.
  let saved = setModelPrefs({ profiles: { everyday: false } });
  assert.strictEqual(saved.sonnet, false, 'everyday:false disables sonnet');
  assert.strictEqual(saved.profiles.everyday.enabled, false);
  saved = setModelPrefs({ profiles: { everyday: true } });
  assert.strictEqual(saved.sonnet, true);
  // Runtime assignment by profile.
  saved = setModelPrefs({ profiles: { complex: { backend: TERRA.slug } } });
  assert.strictEqual(saved.tierBackend.opus, TERRA.slug);
  assert.strictEqual(saved.profiles.complex.backend, 'codex');
  saved = setModelPrefs({ profiles: { complex: { backend: 'claude' } } });
  assert.strictEqual(saved.tierBackend.opus, 'claude');
  // Profile names accepted as tierBackend keys too.
  saved = setModelPrefs({ tierBackend: { frontier: TERRA.slug } });
  assert.strictEqual(saved.tierBackend.fable, TERRA.slug);
  saved = setModelPrefs({ tierBackend: { frontier: 'claude' } });
  assert.strictEqual(saved.tierBackend.fable, 'claude');
  // Per-profile effort rows reach the tier's matrix row.
  saved = setModelPrefs({ profiles: { complex: { efforts: { low: false } } } });
  assert.strictEqual(saved.efforts.opus.low, false);
  assert.strictEqual(saved.efforts.sonnet.low, true, 'other rows untouched');
  // The persisted file stays tier-keyed only: no profiles object, no profile keys.
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.env.SIDEQUEST_HOME, 'projects', 'model-prefs.json'), 'utf8'));
  assert.ok(!('profiles' in raw), 'no profiles object on disk');
  for (const p of PROFILES) {
    assert.ok(!(p in raw), `no top-level "${p}" key on disk`);
    assert.ok(!(p in (raw.tierBackend || {})), `no "${p}" tierBackend key on disk`);
  }
  resetPrefs();
});

test('setModelPrefs: an explicit tier key beats a stale profile echo in the same patch', () => {
  clearCatalog();
  resetPrefs();
  // A legacy-shaped full-object PUT can carry both the flipped tier boolean and
  // the profiles view it was GET'd with — the explicit tier key must win.
  const saved = setModelPrefs({ sonnet: false, profiles: { everyday: { enabled: true } } });
  assert.strictEqual(saved.sonnet, false, 'explicit sonnet:false wins over the profile echo');
  resetPrefs();
});

test('applyDerivedRouting: every routed ticket carries its neutral profile', () => {
  clearCatalog();
  const prefs = resetPrefs();
  for (let c = 1; c <= 10; c++) {
    const t = store.applyDerivedRouting({ complexity: c }, prefs);
    assert.strictEqual(t.profile, store.profileForTier(t.model), `c${c} profile matches its routed tier`);
    assert.ok(PROFILES.includes(t.profile), `c${c} profile is one of the four`);
  }
});

test('applyDerivedRouting: a legacy no-complexity ticket keeps its tags but resolves profile + exec', () => {
  seedCatalog([TERRA]);
  resetPrefs();
  const prefs = setModelPrefs({ tierBackend: { opus: TERRA.slug } });
  const t = store.applyDerivedRouting({ model: 'opus', effort: 'high' }, prefs);
  assert.strictEqual(t.model, 'opus', 'stored tag untouched');
  assert.strictEqual(t.effort, 'high', 'stored effort untouched');
  assert.strictEqual(t.profile, 'complex');
  assert.strictEqual(t.exec.backend, 'codex', 'legacy ticket still resolves its Codex backend');
  assert.strictEqual(t.exec.agent, 'sidequest-exec-codex-gpt-5-6-terra-high');
  assert.strictEqual(t.exec.runsLabel, TERRA.label);
  // No model at all -> no profile, no exec.
  const bare = store.applyDerivedRouting({ title: 'x' }, prefs);
  assert.strictEqual(bare.profile, null);
  assert.ok(!bare.exec, 'no exec without a tier');
  resetPrefs();
});
