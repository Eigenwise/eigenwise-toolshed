'use strict';
/**
 * Tests for the claim-time effort guard (SQ: wrong-executor drift).
 *
 * An executor is spawned as `sidequest-exec-<effort>` with its effort baked into
 * the agent file. The orchestrator is supposed to spawn the executor whose effort
 * equals the ticket's DERIVED effort. It doesn't always: the real bug was
 * `sidequest-exec-medium` (Sonnet) claiming a ticket that derived to `sonnet·high`
 * because the orchestrator hand-picked `medium` — a rung disabled in the ladder.
 *
 * The guard: `sidequest claim` now takes an optional `--effort <level>` (the
 * executor passes its baked level). If it doesn't match the ticket's derived
 * effort, the claim is REFUSED before it mutates anything, so the ticket stays
 * free for the correct-tier executor. Capping never trips it (a cap lowers the
 * model, not the effort). The guard stands down when routing is off, the ticket
 * has no complexity, or it derives to haiku (no effort axis).
 *
 * Run: node --test plugins/sidequest/test/claim-effort-guard.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJ = path.join(os.tmpdir(), 'sq-claim-effort-fixtures', 'board');

function runCli(args) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}
function cliJson(args) {
  const res = runCli(args.concat(['--json']));
  assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\n${res.stderr}${res.stdout}`);
  return JSON.parse(res.stdout);
}
// The ticket's CURRENTLY-derived model/effort (re-read under whatever prefs are set now).
function derivedOf(ref) {
  const list = cliJson(['list']);
  const all = [].concat(...Object.values(list).filter(Array.isArray));
  const t = all.find((x) => x.ref === ref);
  assert.ok(t, `ticket ${ref} not found`);
  return { model: t.model, effort: t.effort, status: t.status, claim: t.claim };
}
function otherEffort(effort) {
  return store.VALID_EFFORTS.find((e) => e !== effort);
}

// A fresh unclaimed ticket for each scenario, so tests don't interfere.
function seed(why) {
  const added = cliJson(['add', '-t', 'guard fixture', '--complexity', '5', '--why', why]);
  return added.ticket.ref;
}

test('Codex routes reject a generic executor even when its effort matches', () => {
  const original = store.getModelPrefs();
  store.setModelPrefs({ routing: true, tierBackend: { sonnet: 'codex-gpt-5-6-terra' } });
  try {
    const ref = seed('seed a Codex-routed ticket to reject a generic executor with matching effort');
    const derived = derivedOf(ref);
    const expected = `sidequest-exec-codex-gpt-5-6-terra-${derived.effort}`;
    const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', `sidequest-exec-${derived.effort}`]);
    assert.notStrictEqual(rejected.status, 0, 'generic executor must not claim a Codex route');
    assert.match(rejected.stdout + rejected.stderr, new RegExp(expected), 'refusal names the authoritative generated executor');
    assert.strictEqual(derivedOf(ref).status, 'todo', 'rejection must leave the ticket free');
    const accepted = cliJson(['claim', ref, '--by', 'w2', '--effort', derived.effort, '--executor', expected]);
    assert.strictEqual(accepted.ok, true);
  } finally {
    store.setModelPrefs({ routing: original.routing, tierBackend: original.tierBackend });
  }
});
test('routing on: a mismatched --effort is refused and does NOT claim the ticket', () => {
  store.setModelPrefs({ routing: true });
  const ref = seed('seed a ticket whose derived effort the guard will check against a wrong claim');
  const { effort: derived } = derivedOf(ref);
  assert.ok(derived, 'ticket should derive an effort with routing on');
  const wrong = otherEffort(derived);

  const res = runCli(['claim', ref, '--by', 'w1', '--effort', wrong]);
  assert.notStrictEqual(res.status, 0, 'a wrong-effort claim must fail');
  assert.match(res.stdout + res.stderr, new RegExp(`sidequest-exec-${derived}`), 'error names the correct executor');

  const after = derivedOf(ref);
  assert.strictEqual(after.status, 'todo', 'a refused claim must leave the ticket in todo');
  assert.strictEqual(after.claim, null, 'a refused claim must not stamp a claim');
});

test('routing on: the JSON form reports reason=effort_mismatch and the derived tier', () => {
  const ref = seed('seed a ticket to inspect the structured mismatch payload');
  const { effort: derived, model } = derivedOf(ref);
  const wrong = otherEffort(derived);
  const res = runCli(['claim', ref, '--by', 'w1', '--effort', wrong, '--json']);
  assert.notStrictEqual(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(payload.reason, 'effort_mismatch');
  assert.strictEqual(payload.derivedEffort, derived);
  assert.strictEqual(payload.derivedModel, model);
  assert.strictEqual(payload.claimedEffort, wrong);
});

test('routing on: the matching --effort claims cleanly', () => {
  const ref = seed('seed a ticket the correct-tier executor claims with its baked effort');
  const { effort: derived } = derivedOf(ref);
  const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', derived]);
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.ticket.status, 'doing');
});

test('no --effort at all still claims (backward compatible with existing callers)', () => {
  const ref = seed('seed a ticket claimed the old way, without an effort flag');
  const claim = cliJson(['claim', ref, '--by', 'w1']);
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.ticket.status, 'doing');
});

test('routing OFF: the guard stands down — even a mismatched --effort claims', () => {
  const ref = seed('seed a ticket to prove the guard is inert when routing is disabled');
  store.setModelPrefs({ routing: false });
  try {
    // With routing off the derived effort is moot; any --effort must be accepted.
    const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', 'medium']);
    assert.strictEqual(claim.ok, true);
    assert.strictEqual(claim.ticket.status, 'doing');
  } finally {
    store.setModelPrefs({ routing: true });
  }
});

test('haiku-derived ticket (no effort axis): the guard stands down', () => {
  const ref = seed('seed a ticket that derives to haiku so the no-effort branch is exercised');
  // Enable only haiku → every rung is haiku, effort null, so there is nothing to match.
  store.setModelPrefs({ routing: true, opus: false, sonnet: false, fable: false, haiku: true });
  try {
    assert.strictEqual(derivedOf(ref).model, 'grade-1', 'ticket should derive to haiku');
    const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', 'high']);
    assert.strictEqual(claim.ok, true, 'a haiku ticket has no effort to guard against');
  } finally {
    store.setModelPrefs({ routing: true, opus: true, sonnet: true, fable: true, haiku: true });
  }
});
