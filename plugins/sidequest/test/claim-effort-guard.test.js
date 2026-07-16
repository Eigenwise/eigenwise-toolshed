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
  const expected = `sidequest-exec-codex-gpt-test-${derived.effort}`;
  const rejected = runCli(['claim', ref, '--by', 'w1', '--effort', derived.effort, '--executor', `sidequest-exec-${derived.effort}`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, new RegExp(expected));
  assert.equal(ticket(ref).status, 'todo');
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', derived.effort, '--executor', expected]).ok, true);
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

test('matching the category-resolved effort claims cleanly', () => {
  const ref = seed('guard.claude');
  const derived = ticket(ref);
  const claim = cliJson(['claim', ref, '--by', 'w1', '--effort', derived.effort]);
  assert.equal(claim.ok, true);
  assert.equal(claim.ticket.status, 'doing');
});

test('omitting effort remains compatible with callers that do not prove an executor tier', () => {
  const ref = seed('guard.claude');
  const claim = cliJson(['claim', ref, '--by', 'w1']);
  assert.equal(claim.ok, true);
  assert.equal(claim.ticket.status, 'doing');
});

test('prepared dispatches require their token and ephemeral executor, then clear on done and release', () => {
  const slug = store.ensureProject(PROJ).slug;

  const doneRef = seed('guard.codex');
  const preparedDone = store.prepareDispatch(slug, doneRef);
  assert.equal(preparedDone.ok, true);
  assert.ok(preparedDone.token);
  assert.equal(preparedDone.ticket.dispatchExecutor, `sidequest-ticket-${doneRef.toLowerCase()}-gpt-test`);
  const missing = runCli(['claim', doneRef, '--by', 'missing-token', '--json']);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).reason, 'token');
  const wrong = runCli(['claim', doneRef, '--by', 'wrong-executor', '--token', preparedDone.token, '--executor', 'sidequest-ticket-wrong-gpt-test', '--json']);
  assert.notEqual(wrong.status, 0);
  assert.equal(JSON.parse(wrong.stdout).reason, 'executor_mismatch');
  assert.equal(cliJson(['claim', doneRef, '--by', 'right-token', '--token', preparedDone.token, '--executor', preparedDone.ticket.dispatchExecutor]).ok, true);
  const done = cliJson(['done', doneRef, '--by', 'right-token']);
  assert.equal(done.ticket.dispatchNonce, null);
  assert.equal(done.ticket.dispatchExecutor, null);

  const releaseRef = seed('guard.codex');
  const preparedRelease = store.prepareDispatch(slug, releaseRef);
  assert.equal(cliJson(['claim', releaseRef, '--by', 'release-token', '--token', preparedRelease.token, '--executor', preparedRelease.ticket.dispatchExecutor]).ok, true);
  const released = cliJson(['release', releaseRef, '--by', 'release-token', '--status', 'todo']);
  assert.equal(released.ticket.dispatchNonce, null);
  assert.equal(released.ticket.dispatchExecutor, null);
});

test('dispatch prepares and renders a claim-ready ephemeral executor', () => {
  const ref = seed('guard.codex');
  const dispatched = cliJson(['dispatch', ref]);
  assert.equal(dispatched.ref, ref);
  assert.equal(dispatched.agent, `sidequest-ticket-${ref.toLowerCase()}-gpt-test`);
  assert.equal(dispatched.tokenPrefix, dispatched.token.slice(0, 12));
  assert.match(dispatched.guidance, new RegExp(`--executor ${dispatched.agent}`));
  assert.equal(ticket(ref).dispatchExecutor, dispatched.agent);
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
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium']).ok, true);
});

test('a concrete Haiku category keeps its configured effort guard', () => {
  const ref = seed('guard.haiku');
  const derived = ticket(ref);
  assert.equal(derived.model, 'haiku');
  assert.equal(derived.effort, 'medium');
  const wrong = runCli(['claim', ref, '--by', 'w1', '--effort', 'high']);
  assert.notEqual(wrong.status, 0);
  assert.equal(cliJson(['claim', ref, '--by', 'w2', '--effort', 'medium']).ok, true);
});
