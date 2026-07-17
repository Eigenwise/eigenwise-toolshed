'use strict';
/**
 * Tests for the ready-for-integration submission lifecycle (SQ-398).
 *
 * Executors never publish: a repo-changing run ends at a verified LOCAL commit
 * submitted for the orchestrator's publish transaction. These tests pin the
 * lifecycle invariants — submit requires the held claim and releases it, the
 * ticket parks in "doing" (distinct from done), submitted work leaves the
 * ready/claim pool, done consumes the submission, and clear reopens the ticket.
 *
 * Run: node --test plugins/sidequest/test/submission.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const { makeCliRunner } = require('./_helpers.js');

const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-project-'));
function git(args) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
const { slug } = store.ensureProject(PROJECT_DIR);
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function addTicket(title, extra) {
  return store.createTicket(slug, Object.assign({
    title,
    complexity: 3,
    complexityWhy: 'fixture for the submission lifecycle tests, single mechanical change',
    files: ['lib/fixture.js'],
    source: 'cli',
  }, extra || {}));
}

test('submit requires a held claim, records the submission, and releases the claim in doing', () => {
  const t = addTicket('submit happy path');

  // No claim yet: the submit is refused — it is the terminal act of a claimed run.
  const unclaimed = store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT });
  assert.strictEqual(unclaimed.ok, false);
  assert.strictEqual(unclaimed.reason, 'not_claimed');

  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {}).ok, true);

  // Another worker can't submit over worker-a's claim.
  const stranger = store.submitTicket(slug, t.ref, 'worker-b', { commit: COMMIT });
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.reason, 'not_owner');

  const res = store.submitTicket(slug, t.ref, 'worker-a', {
    commit: COMMIT.toUpperCase(), // normalized to lowercase
    verify: 'node --test plugins/sidequest/test/submission.test.js',
    worktree: 'C:/tmp/worktrees/agent-x',
  });
  assert.strictEqual(res.ok, true);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.status, 'doing', 'ready-for-integration parks in doing, never done');
  assert.strictEqual(after.claim, null, 'submit releases the claim');
  assert.strictEqual(after.submission.commit, COMMIT.toLowerCase());
  assert.strictEqual(after.submission.gitRef, `refs/sidequest/${t.ref}`, 'durable ref defaults per ticket');
  assert.strictEqual(after.submission.by, 'worker-a');
  assert.strictEqual(after.submission.integratedAt, null);
  assert.ok(store.pendingSubmission(after));
});

test('an invalid commit hash is rejected before anything is written', () => {
  const t = addTicket('bad hash');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {}).ok, true);
  for (const bad of [null, '', 'not-a-hash', 'abc123', 'g'.repeat(10)]) {
    assert.throws(() => store.submitTicket(slug, t.ref, 'worker-a', { commit: bad }), /invalid commit/);
  }
  assert.ok(store.getTicket(slug, t.ref).claim, 'the claim survives a rejected submit');
});

test('submitted tickets leave the ready pool and refuse claims until cleared', () => {
  const t = addTicket('submitted leaves ready');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {}).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const readyRefs = store.readyTickets(slug, {}).map((x) => x.ref);
  assert.ok(!readyRefs.includes(t.ref), 'a submitted ticket is not re-dispatchable');

  const reclaim = store.claimTicket(slug, t.ref, 'worker-b', {});
  assert.strictEqual(reclaim.ok, false);
  assert.strictEqual(reclaim.reason, 'submitted');

  const queue = store.submissionsPayload(slug);
  assert.ok(queue.tickets.some((x) => x.ref === t.ref), 'the integration queue lists it');

  // Orchestrator reset: integration bounced, the work must be redone.
  const cleared = store.clearSubmission(slug, t.ref, { status: 'todo' });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.cleared.commit, COMMIT);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(after.status, 'todo');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-b', {}).ok, true, 'claimable again once cleared');
  assert.strictEqual(store.clearSubmission(slug, t.ref, {}).reason, 'no_submission');
});

test('done consumes the submission: integratedAt is stamped and the queue drains', () => {
  const t = addTicket('done consumes submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {}).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  // The publish transaction completes the ticket after pushing.
  assert.strictEqual(store.completeTicket(slug, t.ref, 'orchestrator', {}).ok, true);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.status, 'done');
  assert.ok(after.submission.integratedAt, 'done stamps the submission integrated');
  assert.strictEqual(store.pendingSubmission(after), false);
  assert.ok(!store.submissionsPayload(slug).tickets.some((x) => x.ref === t.ref));
});

test('brief and pulse surface a pending submission', () => {
  const t = addTicket('surfaced submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {}).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const brief = store.briefTicket(slug, store.getTicket(slug, t.ref));
  assert.strictEqual(brief.submission.commit, COMMIT);

  const pulse = store.pulsePayload(slug, t.ref);
  assert.strictEqual(pulse.submission.commit, COMMIT);
  assert.strictEqual(pulse.claim, null);
});

test('CLI: scoped commit excludes a foreign staged path and keeps it staged', () => {
  const t = addTicket('cli scoped commit', { files: ['lib/cli-scoped.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'scope-worker']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'cli-scoped.js'), 'scoped\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', '.']);

  const committed = runCli(['commit', t.ref, '--by', 'scope-worker', '--message', 'scoped fixture']);
  assert.strictEqual(committed.status, 0, committed.stderr + committed.stdout);
  assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'lib/cli-scoped.js');
  assert.equal(git(['diff', '--cached', '--name-only']), 'foreign.js');
  assert.strictEqual(runCli(['release', t.ref, '--by', 'scope-worker']).status, 0);
  git(['reset', '--', 'foreign.js']);
});

test('CLI: submit parks the ticket READY_FOR_INTEGRATION with an evidence comment, publish queue lists it', () => {
  const t = addTicket('cli submit round-trip');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'cli-worker']).status, 0);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'submitted fixture\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'submission fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  const submitted = runCli([
    'submit', t.ref, '--by', 'cli-worker', '--commit', commit,
    '--verify', 'node --test plugins/sidequest/test/submission.test.js',
    '-m', 'READY_FOR_INTEGRATION evidence body',
  ]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /READY_FOR_INTEGRATION/);

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission.verify, 'node --test plugins/sidequest/test/submission.test.js');
  assert.ok(after.comments.some((c) => /READY_FOR_INTEGRATION evidence body/.test(c.body)));

  const queue = cliJson(['publish', 'queue', '--json']);
  assert.ok(queue.tickets.some((x) => x.ref === t.ref));

  // done without integration is the orchestrator's call; the CLI still guards claims:
  const reclaim = runCli(['claim', t.ref, '--by', 'other']);
  assert.strictEqual(reclaim.status, 1);
  assert.match(reclaim.stdout, /READY_FOR_INTEGRATION/);

  const cleared = runCli(['submit', t.ref, '--clear', '-s', 'todo']);
  assert.strictEqual(cleared.status, 0, cleared.stderr + cleared.stdout);
  assert.strictEqual(store.getTicket(slug, t.ref).submission, null);
});
