'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-test-'));
const DISCOVERY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-catalog-'));
const catalogDir = path.join(DISCOVERY_ROOT, 'codex-gateway');
fs.mkdirSync(catalogDir, { recursive: true });
fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
  schemaVersion: 3, source: 'codex-gateway',
  models: [{ slug: 'codex-gpt-test', id: 'claude-codex-test', label: 'GPT Test' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY_ROOT;

const store = require('../lib/store.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJ = path.join(os.tmpdir(), 'sq-claim-effort-fixtures', 'board');

store.setCategory({
  id: 'guard.codex', name: 'Codex guard',
  route: { model: 'codex-gpt-test', effort: 'high' },
  fallback: { model: 'opus', effort: 'medium' }, enabled: true,
});
store.setCategory({
  id: 'guard.claude', name: 'Claude guard',
  route: { model: 'sonnet', effort: 'high' }, enabled: true,
});
store.setCategory({
  id: 'guard.haiku', name: 'Haiku guard',
  route: { model: 'haiku', effort: 'medium' }, enabled: true,
});

function runCli(args) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, SIDEQUEST_DISCOVERY_DIRS: process.env.SIDEQUEST_DISCOVERY_DIRS, CLAUDE_PROJECT_DIR: PROJ });
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function cliJson(args) {
  const result = runCli(args.concat(['--json']));
  assert.equal(result.status, 0, `expected success: ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

function ticket(ref) {
  const payload = cliJson(['list']);
  const tickets = Array.isArray(payload.tickets) ? payload.tickets : [].concat(...Object.values(payload).filter(Array.isArray));
  const found = tickets.find((candidate) => candidate.ref === ref);
  assert.ok(found, `ticket ${ref} not found`);
  return found;
}

function seed(category) {
  return cliJson(['add', '-t', 'guard fixture', '--category', category]).ticket.ref;
}

function otherEffort(effort) {
  return store.VALID_EFFORTS.find((candidate) => candidate !== effort);
}

test('Codex category routes reject a generic executor even when effort matches', () => {
  const ref = seed('guard.codex');
  const derived = ticket(ref);
  const expected = `sidequest-exec-dispatch-${derived.effort}`;
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', `sidequest-exec-${derived.effort}`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, new RegExp(expected));
  assert.equal(ticket(ref).status, 'todo');
  const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, ref);
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', derived.effort, '--executor', expected, '--token', prepared.token]).ok, true);
});

test('a category-route effort mismatch refuses the claim without mutation', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const wrong = otherEffort(derived.effort);
  const result = runCli(['claim', ref, '--by', 'w1', '--effort', wrong]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /sidequest-exec-high/);
  assert.equal(ticket(ref).status, 'todo');
  assert.equal(ticket(ref).claim, null);
});

test('JSON mismatch reports the category-resolved model and effort', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const wrong = otherEffort(derived.effort);
  const result = runCli(['claim', ref, '--by', 'w1', '--effort', wrong, '--json']);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'effort_mismatch');
  assert.equal(payload.derivedEffort, derived.effort);
  assert.equal(payload.derivedModel, derived.model);
  assert.equal(payload.claimedEffort, wrong);
});

test('a category-routed claim requires a prepared token even with its resolved executor and effort', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', derived.exec.agent, '--json']);
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stdout).reason, 'dispatch_required');
  assert.equal(ticket(ref).status, 'todo');
  const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, ref);
  const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', derived.exec.agent, '--token', prepared.token]);
  assert.equal(claim.ticket.status, 'doing');
});

test('the store requires a dispatch nonce, rejects a wrong one, and accepts its prepared executor', () => {
  const ref = seed('guard.claude');
  const slug = store.ensureProject(PROJ).slug;
  const routed = store.getTicket(slug, ref);
  const missing = store.claimTicket(slug, ref, 'store-no-token', { executor: routed.exec.agent, effort: routed.effort });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'dispatch_required');
  const prepared = store.prepareDispatch(slug, ref);
  const wrong = store.claimTicket(slug, ref, 'store-wrong-token', { token: 'wrong-token', executor: prepared.ticket.dispatchExecutor });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'token');
  assert.equal(wrong.detail, 'missing or expired dispatch token — run dispatch again and use its returned token.');
  const accepted = store.claimTicket(slug, ref, 'store-prepared', { token: prepared.token, executor: prepared.ticket.dispatchExecutor });
  assert.equal(accepted.ok, true);
});

test('an explicit direct claim records the bypass on no-file routed research work', () => {
  const ref = cliJson(['add', '-t', 'research fixture', '--category', 'guard.claude']).ticket.ref;
  const before = ticket(ref);
  assert.deepEqual(before.files, []);
  const claim = cliJson(['claim', ref, '--by', 'inline-worker', '--direct']);
  assert.equal(claim.ticket.directClaim.model, before.model);
  assert.equal(claim.ticket.directClaim.effort, before.effort);
  const pulse = cliJson(['pulse', ref]);
  assert.equal(pulse.direct.by, 'inline-worker');
  assert.equal(pulse.direct.model, before.model);
  const brief = cliJson(['list', '--brief']).tickets.find((candidate) => candidate.ref === ref);
  assert.equal(brief.direct.by, 'inline-worker');
});

test('instant dispatch targets the stable executor, gates the claim, and clears on done and release without deleting the stable def', () => {
  const slug = store.ensureProject(PROJ).slug;
  const agents = path.join(SIDEQUEST_HOME, 'agents');
  fs.mkdirSync(agents, { recursive: true });

  const doneRef = seed('guard.codex');
  const preparedDone = store.prepareDispatch(slug, doneRef);
  assert.equal(preparedDone.ok, true);
  assert.equal(preparedDone.ephemeral, false);
  assert.ok(preparedDone.token);
  // Instant dispatch points the guard at the STABLE per-model executor, not a
  // fresh per-ticket definition, and writes no def file.
  assert.equal(preparedDone.ticket.dispatchExecutor, 'sidequest-exec-dispatch-high');
  assert.equal(preparedDone.ticket.dispatchExecutor, ticket(doneRef).exec.agent);
  // The stable executor is registered from session start; closeout on done/release
  // must never delete it (it is not a per-ticket temp def).
  const stableDef = path.join(agents, `${preparedDone.ticket.dispatchExecutor}.md`);
  fs.writeFileSync(stableDef, '<!-- generated-by: sidequest-agentsync -->\nstable exec body\n');

  const missing = runCli(['claim', doneRef, '--by', 'missing-token', '--json']);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).reason, 'token');
  const wrong = runCli(['claim', doneRef, '--by', 'wrong-executor', '--token', preparedDone.token, '--executor', 'sidequest-exec-high', '--json']);
  assert.notEqual(wrong.status, 0);
  assert.equal(JSON.parse(wrong.stdout).reason, 'executor_mismatch');
  assert.equal(cliJson(['claim', doneRef, '--by', 'right-token', '--token', preparedDone.token, '--executor', preparedDone.ticket.dispatchExecutor]).ok, true);
  const done = cliJson(['done', doneRef, '--by', 'right-token']);
  assert.equal(done.ticket.dispatchNonce, null);
  assert.equal(done.ticket.dispatchExecutor, null);
  assert.ok(fs.existsSync(stableDef));

  const releaseRef = seed('guard.codex');
  const preparedRelease = store.prepareDispatch(slug, releaseRef);
  assert.equal(preparedRelease.ticket.dispatchExecutor, 'sidequest-exec-dispatch-high');
  assert.equal(cliJson(['claim', releaseRef, '--by', 'release-token', '--token', preparedRelease.token, '--executor', preparedRelease.ticket.dispatchExecutor]).ok, true);
  const released = cliJson(['release', releaseRef, '--by', 'release-token', '--status', 'todo']);
  assert.equal(released.ticket.dispatchNonce, null);
  assert.equal(released.ticket.dispatchExecutor, null);
  assert.ok(fs.existsSync(stableDef));
});

test('claims sweep marks stale claims, audits release, and leaves fresh claims alone', () => {
  const slug = store.ensureProject(PROJ).slug;
  const staleRef = seed('guard.claude');
  const freshRef = seed('guard.claude');
  assert.equal(store.claimTicket(slug, staleRef, 'stale-worker', { direct: true }).ok, true);
  assert.equal(store.claimTicket(slug, freshRef, 'fresh-worker', { direct: true }).ok, true);
  const stale = store.getTicket(slug, staleRef);
  stale.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  stale.updatedAt = stale.claim.at;
  const dbModule = require('../lib/db.js');
  const db = dbModule.openDb(SIDEQUEST_HOME);
  dbModule.putRow(db, 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });

  const before = cliJson(['list', '--brief']);
  assert.equal(before.tickets.find((ticket) => ticket.ref === staleRef).claim.stale, true);
  assert.equal(before.tickets.find((ticket) => ticket.ref === freshRef).claim.stale, false);
  const swept = cliJson(['claims', 'sweep']);
  assert.equal(swept.released.length, 1);
  assert.equal(ticket(staleRef).status, 'todo');
  assert.equal(ticket(staleRef).claim, null);
  assert.match(ticket(staleRef).comments.at(-1).body, /claim exceeded the/);
  assert.equal(ticket(freshRef).claim.by, 'fresh-worker');
});

test('a re-dispatch rotates the token against a constant stable executor and rejects the stale token', () => {
  const slug = store.ensureProject(PROJ).slug;
  const ref = seed('guard.codex');
  const first = store.prepareDispatch(slug, ref);
  const second = store.prepareDispatch(slug, ref);

  assert.equal(first.ticket.dispatchExecutor, second.ticket.dispatchExecutor);
  assert.notEqual(first.token, second.token);
  assert.equal(store.getTicket(slug, ref).dispatchNonce, second.token);
  const stale = runCli(['claim', ref, '--by', 'stale', '--token', first.token, '--executor', first.ticket.dispatchExecutor, '--json']);
  assert.notEqual(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).reason, 'token');
  assert.equal(cliJson(['claim', ref, '--by', 'latest', '--token', second.token, '--executor', second.ticket.dispatchExecutor]).ok, true);
});

test('instant dispatch (default) returns the stable executor, the briefing, and the token', () => {
  const ref = seed('guard.codex');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.ref, ref);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-dispatch-high');
  assert.equal(dispatched.spawn.subagent_type, dispatched.agent);
  assert.equal(dispatched.tokenPrefix, dispatched.token.slice(0, 12));
  assert.match(dispatched.briefing, new RegExp(`--token ${dispatched.token}`));
  assert.match(dispatched.briefing, /mcp__plugin_sidequest_board__claim/);
  assert.match(dispatched.briefing, /exact\n   `executor`/);
  assert.doesNotMatch(dispatched.briefing, new RegExp(`--executor ${dispatched.agent}`));
  assert.match(dispatched.briefing, /## This ticket/);
  assert.doesNotMatch(dispatched.briefing, /^---$/m);
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
});

test('dispatch --ephemeral writes a per-ticket definition for cross-session adoption', () => {
  const ref = seed('guard.codex');
  const agents = path.join(SIDEQUEST_HOME, 'agents');
  const dispatched = cliJson(['dispatch', ref, '--ephemeral']);
  assert.equal(dispatched.ref, ref);
  assert.equal(dispatched.mode, 'ephemeral');
  assert.match(dispatched.agent, new RegExp(`^sidequest-ticket-${ref.toLowerCase()}-gpt-test-[a-f0-9]{8}$`));
  assert.equal(dispatched.tokenPrefix, dispatched.token.slice(0, 12));
  assert.match(dispatched.guidance, new RegExp(`--executor ${dispatched.agent}`));
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
  const defFile = path.join(agents, `${dispatched.agent}.md`);
  assert.ok(fs.existsSync(defFile));
  assert.match(fs.readFileSync(defFile, 'utf8'), new RegExp(`--token ${dispatched.token}`));
});

test('instant dispatch sends Haiku through its stable executor with a Haiku spawn model', () => {
  const ref = seed('guard.haiku');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.mode, 'instant');
  assert.equal(dispatched.agent, 'sidequest-exec-medium');
  assert.equal(dispatched.spawn.subagent_type, 'sidequest-exec-medium');
  assert.equal(dispatched.spawn.model, 'haiku');
  assert.equal(ticket(ref).dispatchExecutor, 'sidequest-exec-medium');
});

test('prepare dispatch rejects unknown ticket refs loudly', () => {
  const slug = store.ensureProject(PROJ).slug;
  assert.throws(() => store.prepareDispatch(slug, 'SQ-999999'), /no ticket/);
});

test('an unavailable primary uses the category fallback effort for the guard', () => {
  const ref = seed('guard.codex');
  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-effort-empty-'));
  const derived = ticket(ref);
  assert.equal(derived.model, 'opus');
  assert.equal(derived.effort, 'medium');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'high']);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout + wrong.stderr, /sidequest-exec-medium/);
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium', '--direct']).ok, true);
});

test('a concrete Haiku category keeps its configured effort guard', () => {
  const ref = seed('guard.haiku');
  const derived = ticket(ref);
  assert.equal(derived.model, 'haiku');
  assert.equal(derived.effort, 'medium');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'high']);
  assert.notEqual(wrong.status, 0);
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium', '--direct']).ok, true);
});
