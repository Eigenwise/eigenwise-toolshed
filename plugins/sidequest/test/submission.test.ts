import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
const agentsync = require('../lib/agentsync.js');
const mcp = require('../lib/mcp.js');
const db = require('../lib/db.js');
const { submissionRangeFailureMessage } = require('../lib/mcp-lifecycle.js');
const { createLocks } = require('../src/lib/store/locks.ts');
const { makeCliRunner } = require('./_helpers.js');

const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-project-'));
const REMOTE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-remote-'));
function git(args?: any) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), 'submission fixture\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'main']);
execFileSync('git', ['init', '--bare', REMOTE_DIR], { encoding: 'utf8', windowsHide: true });
git(['remote', 'add', 'origin', REMOTE_DIR]);
git(['push', '-u', 'origin', 'main']);
let branchSeq = 0;
function cleanBranch() {
  git(['checkout', '-f', '-B', `submission-${++branchSeq}`, 'origin/main']);
  git(['clean', '-fd']);
}
function pin(ticket?: any, commit?: any) {
  git(['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
}
const { slug } = store.ensureProject(PROJECT_DIR);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
// Dispatch fixtures route through a Claude model on purpose: the default routes
// are Codex, and CI has no model gateway to confirm readiness against.
store.setCategory({
  id: 'submission.fixture',
  name: 'Submission fixture',
  description: 'Fixed submission lifecycle fixture.',
  route: { model: 'sonnet', effort: 'medium' },
  fallback: null,
  enabled: true,
});
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function persist(ticket?: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

function addTicket(title?: any, extra?: any) {
  return store.createTicket(slug, Object.assign({
    title,
    complexity: 3,
    complexityWhy: 'fixture for the submission lifecycle tests, single mechanical change',
    files: ['lib/fixture.js'],
    source: 'cli',
    labels: ['direct-ok'],
  }, extra || {}));
}

function noGitCliTicket(title: string, files: string[]) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-submission-no-git-project-'));
  const project = store.ensureProject(projectPath).slug;
  const ticket = store.createTicket(project, {
    title,
    complexity: 3,
    complexityWhy: 'fixture for one immutable non-Git project revision',
    files,
    source: 'cli',
    labels: ['direct-ok'],
  });
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: projectPath }, { cwd: projectPath });
  return { project, ticket, runCli: runner.runCli };
}

function addClaimedTicket(title: string, owner: string, extra?: any) {
  const ticket = addTicket(title, extra);
  const claim = store.claimTicket(slug, ticket.ref, owner, { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(claim.ok, true, claim.message);
  return ticket;
}

function createCandidateCommit(filename: string, content: string) {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', filename), content);
  git(['add', `lib/${filename}`]);
  git(['commit', '-m', `candidate ${filename}`]);
  return git(['rev-parse', 'HEAD']);
}

function assertForeignSubmissionWasRefused(ticket: any, owner: string) {
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, owner);
  assert.strictEqual(stored.submission, undefined);
  assert.strictEqual(stored.rejectedSubmissions, undefined);
}

async function callMcp(name: string, args: Record<string, unknown>) {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === name);
  assert.ok(tool, `missing MCP tool ${name}`);
  return tool.handler(args);
}




test('submit requires a held claim, records the submission, and releases the claim in doing', () => {
  const t = addTicket('submit happy path');

  // No claim yet: the submit is refused — it is the terminal act of a claimed run.
  const unclaimed = store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT });
  assert.strictEqual(unclaimed.ok, false);
  assert.strictEqual(unclaimed.reason, 'not_claimed');

  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

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
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  for (const bad of [null, '', 'not-a-hash', 'abc123', 'g'.repeat(10)]) {
    assert.throws(() => store.submitTicket(slug, t.ref, 'worker-a', { commit: bad }), /invalid commit/);
  }
  assert.ok(store.getTicket(slug, t.ref).claim, 'the claim survives a rejected submit');
});

test('submit rejects invalid verify commands without releasing the claim or pin', () => {
  const t = addTicket('invalid submit verify');
  const by = 'verify-worker';
  const pinnedCommit = git(['rev-parse', 'origin/main']);
  pin(t, pinnedCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, by, {
    commit: pinnedCommit,
    verify: 'GIT_TERMINAL_PROMPT=0; cd plugins/sidequest && npx tsx --test test/*.test.ts',
  });

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_verify');
  assert.match(refused.message, /Verify cannot use `;` command chaining/);
  assert.match(refused.message, /join dependent steps with `&&`/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);
  assert.strictEqual(git(['rev-parse', `refs/sidequest/${t.ref}`]), pinnedCommit);
});

test('submit rejects bare manual prose without releasing the claim', () => {
  const t = addTicket('bare manual submit verify');
  const by = 'bare-manual-worker';
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, by, {
    commit: COMMIT,
    verify: 'manual focused verifier',
  });

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_verify');
  assert.match(refused.message, /exact prefix `manual: <what you checked>`/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);
});

test('integration rejects legacy invalid submission verify before delivery', () => {
  const t = addTicket('legacy malformed submission');
  t.submission = { commit: COMMIT, verify: 'manual focused verifier', integratedAt: null };
  persist(t);

  const refused = store.validateIntegrationSubmission(slug, t.ref);

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'invalid_submission_verify');
  assert.match(refused.message, /submission record verify "manual focused verifier"/);
  assert.match(refused.message, /submission\.verify, not ticket\.executorVerify/);
});

test('submit requires the declared executor verify command', () => {
  fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'scoped-surface.test.js'), '');
  const t = addTicket('declared scoped verify', { executorVerify: 'node --test test/scoped-surface.test.js' });
  const by = 'scoped-verify-worker';
  const pinnedCommit = git(['rev-parse', 'origin/main']);
  pin(t, pinnedCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, by, {
    commit: pinnedCommit,
    verify: 'node --test test/unrelated.test.js',
  });

  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'executor_verify_mismatch');
  assert.match(refused.message, /must match the declared executor verify command/);
  assert.strictEqual(store.getTicket(slug, t.ref).claim.by, by);

  const accepted = store.submitTicket(slug, t.ref, by, {
    commit: pinnedCommit,
    verify: t.executorVerify,
  });
  assert.strictEqual(accepted.ok, true);
});

test('submit accepts runnable and manual verify commands', () => {
  const runnable = addTicket('runnable submit verify');
  const manual = addTicket('manual submit verify');
  assert.strictEqual(store.claimTicket(slug, runnable.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.claimTicket(slug, manual.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const runnableResult = store.submitTicket(slug, runnable.ref, 'worker-a', {
    commit: COMMIT,
    verify: 'cd plugins/sidequest && npm run test:full',
  });
  const manualResult = store.submitTicket(slug, manual.ref, 'worker-b', {
    commit: COMMIT,
    verify: 'manual: submission tests passed',
  });

  assert.strictEqual(runnableResult.ok, true);
  assert.strictEqual(manualResult.ok, true);
  assert.strictEqual(store.getTicket(slug, runnable.ref).submission.verify, 'cd plugins/sidequest && npm run test:full');
  assert.strictEqual(store.getTicket(slug, manual.ref).submission.verify, 'manual: submission tests passed');
});

test('integration rejects a plugin change when its merged-tree full gate fails', () => {
  const pluginDir = path.join(PROJECT_DIR, 'plugins', 'integration-gate-fixture');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node -e "process.exit(7)"' } }));
  const t = addTicket('integration full gate', { files: ['plugins/integration-gate-fixture/src/changed.js'] });
  t.submission = {
    commit: COMMIT,
    verify: 'cd plugins/integration-gate-fixture && node --test test/changed.test.js',
    integration: { outcome: 'delivered' },
  };
  persist(t);

  const result = store.verifyIntegration(slug, t.ref);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'verify_failed');
  assert.strictEqual(result.verify.status, 'failed');
  assert.strictEqual(result.verify.command, 'cd plugins/integration-gate-fixture && npm ci && npm run test:full');
});

test('SQ-1875: every submission range reason gives a pinned-base remedy', () => {
  const ticket = { ref: 'SQ-1875', dispatch: { baseCommit: '1234567890abcdef1234567890abcdef12345678' } };
  const reasons = ['merge_commit', 'empty_range', 'base_not_reachable', 'range_changed', 'no_op_changed', 'reconciled_path_diverged'];
  for (const reason of reasons) {
    const message = submissionRangeFailureMessage(ticket, { reason, commit: 'abcdef1' }, 'refs/sidequest/SQ-1875');
    assert.match(message, new RegExp(`submit: refused SQ-1875; ${reason}`));
    assert.match(message, /behind the integration tip is expected/);
    assert.doesNotMatch(message, /rebase onto|current integration target|origin\/main|\bmain\b/);
  }
  const mergeMessage = submissionRangeFailureMessage(ticket, { reason: 'merge_commit', commit: 'abcdef1' }, 'refs/sidequest/SQ-1875');
  assert.match(mergeMessage, /1234567890abcdef1234567890abcdef12345678/);
  assert.match(mergeMessage, /Do not use `git pull`/);
});

test('SQ-971: rejected range submission is quarantined and clean rebase resubmits', async () => {
  cleanBranch();
  const t = addTicket('rejected range preservation', { files: ['lib/rebased.js'] });
  const by = 'rebase-worker';
  assert.strictEqual(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'parent.js'), 'feature parent\n');
  git(['add', 'parent.js']);
  git(['commit', '-m', 'unrecognized feature parent']);
  const parent = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'rebased.js'), 'verified work\n');
  git(['add', 'lib/rebased.js']);
  git(['commit', '-m', 'verified ticket work']);
  const rejectedCommit = git(['rev-parse', 'HEAD']);
  pin(t, rejectedCommit);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: rejectedCommit,
    base: parent,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/rebased.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unrecognized_base');
  assert.match(rejected.message, /Preserved .*refs\/sidequest\/SQ-\d+-rejected/);
  assert.match(rejected.message, /recorded .*base|approved submitted-ticket boundary/);
  assert.doesNotMatch(rejected.message, /Rebase onto the current|current origin\/main target/);
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}-rejected`]), rejectedCommit);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.checkpoint.kind, 'submission_rejected');
  assert.equal(preserved.checkpoint.commit, rejectedCommit);
  assert.equal(preserved.checkpoint.gitRef, `refs/sidequest/${t.ref}-rejected`);
  assert.equal(preserved.checkpoint.failure.reason, 'unrecognized_base');
  assert.match(preserved.comments.at(-1).body, /Claim retained with a recovery checkpoint/);

  git(['rebase', '--onto', 'origin/main', parent, rejectedCommit]);
  const rebasedCommit = git(['rev-parse', 'HEAD']);
  assert.notEqual(rebasedCommit, rejectedCommit);
  pin(t, rebasedCommit);
  const resubmitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: rebasedCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Rebased lib/rebased.js onto origin/main. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(resubmitted.ok, true, resubmitted.message);
  const after = store.getTicket(slug, t.ref);
  assert.equal(after.claim, null);
  assert.equal(after.submission.commit, rebasedCommit);
  assert.deepEqual(after.submission.commits, [rebasedCommit]);
  assert.equal(after.submission.base, git(['rev-parse', 'origin/main']));
});

test('SQ-822: MCP submit refuses uncommitted declared work, then accepts it once committed', async () => {
  cleanBranch();
  const t = addTicket('declared work must be committed', { files: ['lib/committed.js'] });
  const by = 'committed-work-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'committed.js'), 'first version\n');
  git(['add', 'lib/committed.js']);
  git(['commit', '-m', 'first declared version']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  pin(t, firstCommit);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'committed.js'), 'second version\n');

  const refused = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: firstCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/committed.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'dirty_scope');
  assert.match(refused.message, /uncommitted changes fall inside this ticket's declared scope: lib\/committed\.js/);
  assert.match(refused.message, /Commit these paths, or explain why they are deliberately excluded/);
  assert.equal(store.getTicket(slug, t.ref).claim.by, by, 'refusal retains the claim so the executor can commit its work');

  git(['add', 'lib/committed.js']);
  git(['commit', '-m', 'second declared version']);
  const committed = git(['rev-parse', 'HEAD']);
  pin(t, committed);
  const submitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit: committed,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/committed.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(submitted.ok, true, submitted.message);

  cleanBranch();
  const outsideScope = addTicket('outside dirty work does not block submit', { files: ['lib/declared.js'] });
  const outsideBy = 'outside-work-worker';
  assert.equal(store.claimTicket(slug, outsideScope.ref, outsideBy, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'declared.js'), 'declared work\n');
  git(['add', 'lib/declared.js']);
  git(['commit', '-m', 'declared work']);
  const outsideCommit = git(['rev-parse', 'HEAD']);
  pin(outsideScope, outsideCommit);
  fs.mkdirSync(path.join(PROJECT_DIR, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'notes', 'noise.md'), 'out of scope\n');
  const outsideSubmitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: outsideScope.ref,
    by: outsideBy,
    commit: outsideCommit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/declared.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(outsideSubmitted.ok, true, outsideSubmitted.message);
});

test('SQ-1880: MCP submit inspects a pinned candidate from the repository after its worktree is gone', async () => {
  cleanBranch();
  const ticket = addTicket('worktree swept after verified commit', { files: ['lib/swept-worktree.js'] });
  const by = 'swept-worktree-worker';
  assert.equal(store.claimTicket(slug, ticket.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'swept-worktree.js'), 'verified before sweep\n');
  git(['add', 'lib/swept-worktree.js']);
  git(['commit', '-m', 'verified swept worktree candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(ticket, commit);
  git(['reset', '--hard', 'origin/main']);
  const missingWorktree = path.join(PROJECT_DIR, 'missing-agent-worktree');

  const submitted = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by,
    commit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: missingWorktree,
    body: 'Changed lib/swept-worktree.js. Scoped submission test passed. Nothing skipped.',
  });

  assert.equal(submitted.ok, true, submitted.message);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.submission.commit, commit);
  assert.equal(stored.submission.worktree, missingWorktree);
  assert.equal(stored.claim, null);
});

test('SQ-971: an unavailable recorded integration target still quarantines verified work', async () => {
  cleanBranch();
  const t = addTicket('missing integration target preservation', { files: ['lib/missing-target.js'] });
  const by = 'missing-target-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  const claimed = store.getTicket(slug, t.ref);
  claimed.dispatch = {
    integrationTarget: {
      mode: 'local',
      upstream: 'missing-feature-target',
      branch: 'missing-feature-target',
    },
  };
  persist(claimed);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'missing-target.js'), 'verified work\n');
  git(['add', 'lib/missing-target.js']);
  git(['commit', '-m', 'verified work for deleted target']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by,
    commit,
    verify: 'npm run test:files -- test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'Changed lib/missing-target.js. Scoped submission test passed. Nothing skipped.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'integration_target_unavailable');
  assert.match(rejected.message, /Fetch or recreate missing-feature-target/);
  assert.match(rejected.message, /rebase refs\/sidequest\/SQ-\d+ onto that target, and resubmit/);
  assert.match(rejected.message, /orchestrator can cherry-pick/);
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}-rejected`]), commit);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.checkpoint.kind, 'submission_rejected');
  assert.equal(preserved.checkpoint.failure.reason, 'integration_target_unavailable');
  assert.match(preserved.checkpoint.failure.message, /refs\/heads\/missing-feature-target/);
});

test('SQ-971: checkpoint failure reports the already-written quarantine ref', async () => {
  cleanBranch();
  const t = addTicket('checkpoint failure after quarantine', { files: ['lib/checkpoint-failure.js'] });
  const by = 'checkpoint-failure-worker';
  assert.equal(store.claimTicket(slug, t.ref, by, { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'parent.js'), 'unrecognized parent\n');
  git(['add', 'parent.js']);
  git(['commit', '-m', 'checkpoint failure parent']);
  const parent = git(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'checkpoint-failure.js'), 'verified work\n');
  git(['add', 'lib/checkpoint-failure.js']);
  git(['commit', '-m', 'verified work before checkpoint failure']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const originalCheckpointTicket = store.checkpointTicket;
  store.checkpointTicket = () => {
    throw new Error(`forced checkpoint write failure ${'x'.repeat(5000)}`);
  };
  let rejected: any;
  try {
    rejected = await callMcp('submit', {
      project: PROJECT_DIR,
      ref: t.ref,
      by,
      commit,
      base: parent,
      verify: 'npm run test:files -- test/submission.test.ts',
      worktree: PROJECT_DIR,
      body: 'Changed lib/checkpoint-failure.js. Scoped submission test passed. Nothing skipped.',
    });
  } finally {
    store.checkpointTicket = originalCheckpointTicket;
  }

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'unrecognized_base');
  assert.match(rejected.message, new RegExp(`Preserved ${commit} at refs/sidequest/${t.ref}-rejected`));
  assert.match(rejected.message, /recovery checkpoint failed: checkpoint_error: forced checkpoint write failure/);
  assert.ok(rejected.message.length < 2000, 'checkpoint failure text is bounded');
  assert.equal(git(['rev-parse', `refs/sidequest/${t.ref}-rejected`]), commit);
  const preserved = store.getTicket(slug, t.ref);
  assert.equal(preserved.claim.by, by);
  assert.equal(preserved.checkpoint, null);
});

test('submitted tickets leave the ready pool and refuse claims until cleared', () => {
  const t = addTicket('submitted leaves ready');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const readyRefs = store.readyTickets(slug, {}).map((x?: any) => x.ref);
  assert.ok(!readyRefs.includes(t.ref), 'a submitted ticket is not re-dispatchable');

  const reclaim = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(reclaim.ok, false);
  assert.strictEqual(reclaim.reason, 'submitted');

  const queue = store.submissionsPayload(slug);
  assert.ok(queue.tickets.some((x?: any) => x.ref === t.ref), 'the integration queue lists it');

  // Orchestrator reset: integration bounced, the work must be redone.
  const cleared = store.clearSubmission(slug, t.ref, { by: 'worker-a', status: 'todo' });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(cleared.cleared.commit, COMMIT);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(after.status, 'todo');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true, 'claimable again once cleared');
  assert.strictEqual(store.clearSubmission(slug, t.ref, {}).reason, 'no_submission');
});

// SQ-1010: release --force + update --status todo both used to report ok while
// leaving the submission in place, so the next claim kept refusing the ticket
// as already-submitted even though it looked reopened. release/update must
// now either refuse with the correct command, or (release --force) actually
// reject the submission as part of the explicit reopen.
test('release --status todo on a pending submission refuses instead of silently wedging it (SQ-1010)', () => {
  const t = addTicket('release reopen refuses on pending submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const released = store.releaseTicket(slug, t.ref, 'worker-a', { status: 'todo' });
  assert.strictEqual(released.ok, false);
  assert.strictEqual(released.reason, 'pending_submission');
  assert.match(released.message, /pending submission/);
  assert.match(released.message, /submit .*--clear/);

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(store.pendingSubmission(after), true, 'the submission is untouched by the refused release');
  const stillRefused = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(stillRefused.ok, false);
  assert.strictEqual(stillRefused.reason, 'submitted');
});

test('store force cannot release a foreign live claim or mutate its status (SQ-1711)', () => {
  const ticket = addClaimedTicket('store foreign forced claim release', 'victim-worker');
  const result = store.releaseTicket(slug, ticket.ref, 'attacker-worker', { status: 'todo', force: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('CLI force cannot release a foreign live claim or mutate its status (SQ-1711)', () => {
  const ticket = addClaimedTicket('CLI foreign forced claim release', 'victim-worker');
  const result = runCli(['release', ticket.ref, '--by', 'attacker-worker', '--status', 'todo', '--force']);
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /add `?--force|pass --force/i);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('store force cannot clear a foreign pending submission or write rework history (SQ-1711)', () => {
  const ticket = addClaimedTicket('store foreign forced submission release', 'victim-worker');
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT }).ok, true);
  const result = store.releaseTicket(slug, ticket.ref, 'attacker-worker', { status: 'todo', force: true });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('CLI force cannot clear a foreign pending submission or write rework history (SQ-1711)', () => {
  const ticket = addClaimedTicket('CLI foreign forced submission release', 'victim-worker');
  assert.strictEqual(store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT }).ok, true);
  const result = runCli(['release', ticket.ref, '--by', 'attacker-worker', '--status', 'todo', '--force']);
  assert.strictEqual(result.status, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /add `?--force|pass --force/i);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.status, 'doing');
  assert.strictEqual(stored.reworkEvents, undefined);
});

test('release --status todo --force rejects the pending submission and reopens in one step (SQ-1010)', () => {
  const t = addTicket('release force reopen clears submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const released = store.releaseTicket(slug, t.ref, 'worker-a', { status: 'todo', force: true });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.clearedSubmission.commit, COMMIT);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(after.status, 'todo');

  // Redispatch: a fresh executor claims cleanly, no leftover "submitted" refusal.
  const reclaimed = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(reclaimed.ok, true);
});

test('update --status todo refuses on a pending submission instead of silently applying (SQ-1010)', () => {
  const t = addTicket('update reopen refuses on pending submission');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'worker-a', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  assert.throws(() => store.updateTicket(slug, t.ref, { status: 'todo', source: 'test' }), /pending submission/);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(store.pendingSubmission(after), true, 'the submission is untouched by the refused update');
  assert.strictEqual(after.status, 'doing', 'status did not silently move');

  const cliAttempt = runCli(['update', t.ref, '--status', 'todo']);
  assert.strictEqual(cliAttempt.status, 1);
  assert.match(cliAttempt.stderr + cliAttempt.stdout, /pending submission/);

  // The documented escape works and unwedges the ticket.
  const cleared = store.clearSubmission(slug, t.ref, { by: 'worker-a', status: 'todo' });
  assert.strictEqual(cleared.ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
});

test('review rejection preserves the candidate through a normal repair dispatch until replacement submission (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'original candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'original candidate']);
  const originalCommit = git(['rev-parse', 'HEAD']);
  const t = addTicket('high-stakes rejected candidate', { highStakes: true, category: 'submission.fixture' });
  pin(t, originalCommit);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'original-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'original-worker', { commit: originalCommit }).ok, true);

  const unauthorizedCliRejection = runCli([
    'rework', t.ref,
    '--by', 'review-audit',
    '--review', 'SQ-1640 rejected: missing lifecycle coverage',
    '--reason', 'Repair the rejected submission without dropping the candidate.',
    '--force',
  ]);
  assert.strictEqual(unauthorizedCliRejection.status, 1);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, originalCommit);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions, undefined);

  const unauthorizedRejection = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'review-audit',
    review: 'SQ-1640 rejected: missing lifecycle coverage',
    reason: 'Repair the rejected submission without dropping the candidate.',
    force: true,
  });
  assert.strictEqual(unauthorizedRejection.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, originalCommit);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions, undefined);

  const rejected = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'original-worker',
    review: 'SQ-1640 rejected: missing lifecycle coverage',
    reason: 'Repair the rejected submission without dropping the candidate.',
  });
  assert.strictEqual(rejected.ok, true, rejected.message);
  const afterRejection = store.getTicket(slug, t.ref);
  assert.strictEqual(afterRejection.submission, null);
  assert.strictEqual(afterRejection.status, 'todo');
  assert.strictEqual(afterRejection.rejectedSubmissions[0].commit, originalCommit);
  assert.match(afterRejection.rejectedSubmissions[0].review, /SQ-1640/);
  assert.strictEqual(afterRejection.rejectedSubmissions[0].quarantineRef, `refs/sidequest/${t.ref}-rejected`);
  assert.strictEqual(git(['rev-parse', afterRejection.rejectedSubmissions[0].quarantineRef]), originalCommit);

  const firstRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'sq-1642-first-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'repair-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'sq-1642-first-repair',
  }).ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'duplicate-repair-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'sq-1642-first-repair',
  }).reason, 'claimed');
  const reused = store.submitTicket(slug, t.ref, 'repair-worker', { commit: originalCommit });
  assert.strictEqual(reused.ok, false);
  assert.strictEqual(reused.reason, 'rejected_submission_reused');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].supersededAt, undefined, 'the rejected candidate cannot be reused as its own repair');
  assert.throws(() => store.submitTicket(slug, t.ref, 'repair-worker', { commit: 'not-a-commit' }), /invalid commit/);
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].supersededAt, undefined, 'a failed repair leaves the rejected candidate intact');
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'repair-worker', { status: 'todo', reason: 'Repair submission validation failed.' }).ok, true);

  const repaired = store.prepareDispatch(slug, t.ref, { sessionId: 'sq-1642-second-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'stale-repair-worker', {
    token: firstRepair.token, executor: repaired.ticket.dispatchExecutor, sessionId: 'sq-1642-second-repair',
  }).reason, 'token');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'replacement-worker', {
    token: repaired.token, executor: repaired.ticket.dispatchExecutor, sessionId: 'sq-1642-second-repair',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'replacement candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'replacement candidate']);
  const replacementCommit = git(['rev-parse', 'HEAD']);
  pin(t, replacementCommit);
  const replacement = store.submitTicket(slug, t.ref, 'replacement-worker', { commit: replacementCommit });
  assert.strictEqual(replacement.ok, true, replacement.message);
  const afterReplacement = store.getTicket(slug, t.ref);
  assert.strictEqual(afterReplacement.submission.integratedAt, null, 'repair submission is still queued, never integrated early');
  assert.strictEqual(afterReplacement.submission.supersedesRejectedSubmission, originalCommit);
  assert.strictEqual(afterReplacement.rejectedSubmissions[0].supersededBy.commit, replacementCommit);
});

test('rework preserves every rejected commit and avoids quarantine ref collisions (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate one\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate one']);
  const candidateOne = git(['rev-parse', 'HEAD']);
  const collisionCommit = git(['rev-parse', 'origin/main']);
  const t = addTicket('repeated rejected candidates', { category: 'submission.fixture' });
  pin(t, candidateOne);
  git(['update-ref', `refs/sidequest/${t.ref}-rejected`, collisionCommit]);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'first-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'first-worker', { commit: candidateOne }).ok, true);
  assert.strictEqual(runCli([
    'rework', t.ref,
    '--by', 'first-worker',
    '--review', 'First repair review evidence.',
    '--reason', 'Replace the first rejected candidate.',
  ]).status, 0);
  assert.strictEqual(git(['rev-parse', `refs/sidequest/${t.ref}-rejected`]), collisionCommit, 'an existing quarantine ref remains untouched');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions[0].quarantineRef, `refs/sidequest/${t.ref}-rejected-2`);

  const firstRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'first-repeated-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'second-worker', {
    token: firstRepair.token, executor: firstRepair.ticket.dispatchExecutor, sessionId: 'first-repeated-repair',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate two\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate two']);
  const candidateTwo = git(['rev-parse', 'HEAD']);
  pin(t, candidateTwo);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'second-worker', { commit: candidateTwo }).ok, true);
  assert.strictEqual((await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'second-worker',
    review: 'Second repair review evidence.',
    reason: 'Replace the second rejected candidate.',
  })).ok, true);

  const afterSecondRejection = store.getTicket(slug, t.ref);
  assert.strictEqual(afterSecondRejection.rejectedSubmissions[1].quarantineRef, `refs/sidequest/${t.ref}-rejected-3`);
  const secondRepair = store.prepareDispatch(slug, t.ref, { sessionId: 'second-repeated-repair', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'third-worker', {
    token: secondRepair.token, executor: secondRepair.ticket.dispatchExecutor, sessionId: 'second-repeated-repair',
  }).ok, true);
  const reused = store.submitTicket(slug, t.ref, 'third-worker', { commit: candidateOne });
  assert.strictEqual(reused.reason, 'rejected_submission_reused');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'candidate three\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'candidate three']);
  const candidateThree = git(['rev-parse', 'HEAD']);
  const replayedRange = store.submitTicket(slug, t.ref, 'third-worker', {
    commit: candidateThree,
    range: {
      base: candidateOne,
      upstream: 'main',
      upstreamCommit: candidateOne,
      commits: [candidateOne, candidateThree],
      changedPaths: [],
    },
  });
  assert.strictEqual(replayedRange.reason, 'rejected_submission_reused', 'a new tip cannot replay a rejected commit in its admitted range');
  assert.strictEqual(store.getTicket(slug, t.ref).rejectedSubmissions.length, 2, 'a failed third repair retains the full rejection history');
});

test('store force cannot submit over a foreign claim or replace its pending submission (SQ-1702)', () => {
  const ticket = addClaimedTicket('store foreign forced submission', 'victim-worker');
  const forcedSubmission = store.submitTicket(slug, ticket.ref, 'attacker-worker', { commit: COMMIT, force: true });
  assert.strictEqual(forcedSubmission.ok, false);
  assert.strictEqual(forcedSubmission.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: COMMIT });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = store.submitTicket(slug, ticket.ref, 'attacker-worker', { commit: 'def5678abc1234def5678abc1234def5678abc12', force: true });
  assert.strictEqual(forcedReplacement.ok, false);
  assert.strictEqual(forcedReplacement.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.submission.commit, COMMIT);

  const ownerReplacement = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit: 'def5678abc1234def5678abc1234def5678abc12', force: true });
  assert.strictEqual(ownerReplacement.ok, true, ownerReplacement.message);
  assert.strictEqual(ownerReplacement.ticket.submission.by, 'victim-worker');
});

test('CLI force cannot submit over a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('cli-force-submit.js', 'CLI force submit candidate\n');
  const ticket = addClaimedTicket('CLI foreign forced submission', 'victim-worker', { files: ['lib/cli-force-submit.js'], category: 'submission.fixture' });
  pin(ticket, commit);
  const result = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr + result.stdout, /not_owner|claimed by "victim-worker"|rather than you/);
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(forcedReplacement.status, 1);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.rejectedSubmissions, undefined);
});

test('MCP force cannot submit over a foreign claim (SQ-1702)', async () => {
  const commit = createCandidateCommit('mcp-force-submit.js', 'MCP force submit candidate\n');
  const ticket = addClaimedTicket('MCP foreign forced submission', 'victim-worker', { files: ['lib/mcp-force-submit.js'], category: 'submission.fixture' });
  pin(ticket, commit);
  const result = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign force must not submit or release the victim claim.',
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');

  const ownerSubmission = store.submitTicket(slug, ticket.ref, 'victim-worker', { commit });
  assert.strictEqual(ownerSubmission.ok, true, ownerSubmission.message);
  const forcedReplacement = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign force must not replace the victim submission.',
    force: true,
  });
  assert.strictEqual(forcedReplacement.ok, false);
  assert.strictEqual(forcedReplacement.reason, 'not_owner');
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.claim, null);
  assert.strictEqual(stored.submission.by, 'victim-worker');
  assert.strictEqual(stored.rejectedSubmissions, undefined);
});

test('store force cannot preserve rejection history for a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('store-force-rejection.js', 'Store force rejection candidate\n');
  const ticket = addClaimedTicket('store foreign forced rejection', 'victim-worker', { files: ['lib/store-force-rejection.js'], category: 'submission.fixture' });
  const result = store.recordSubmissionRejection(slug, ticket.ref, {
    by: 'attacker-worker',
    review: 'Foreign rejection evidence must be refused.',
    reason: 'Foreign force must not poison rejection history.',
    commit,
    root: PROJECT_DIR,
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('CLI forced validation failure cannot preserve rejection history for a foreign claim (SQ-1702)', () => {
  const commit = createCandidateCommit('cli-force-rejection.js', 'CLI force rejection candidate\n');
  const ticket = addClaimedTicket('CLI foreign forced rejection', 'victim-worker', { files: ['lib/cli-force-rejection.js'], category: 'submission.fixture' });
  const result = runCli([
    'submit', ticket.ref,
    '--by', 'attacker-worker',
    '--commit', commit,
    '--gitref', `refs/sidequest/${ticket.ref}-missing`,
    '--verify', 'node --test test/submission.test.ts',
    '--force',
  ]);
  assert.strictEqual(result.status, 1);
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('MCP forced validation failure cannot preserve rejection history for a foreign claim (SQ-1702)', async () => {
  const commit = createCandidateCommit('mcp-force-rejection.js', 'MCP force rejection candidate\n');
  const ticket = addClaimedTicket('MCP foreign forced rejection', 'victim-worker', { files: ['lib/mcp-force-rejection.js'], category: 'submission.fixture' });
  const result = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'attacker-worker',
    commit,
    gitRef: `refs/sidequest/${ticket.ref}-missing`,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'A foreign forced validation failure must not preserve rejection history.',
    force: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'not_owner');
  assertForeignSubmissionWasRefused(ticket, 'victim-worker');
});

test('CLI and MCP reject unauthorized or independently invalid ranges without poisoning history (SQ-1667)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'validation-parity.js'), 'candidate\n');
  git(['add', 'lib/validation-parity.js']);
  git(['commit', '-m', 'validation parity candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  const ticket = addTicket('canonical submission validation', { files: ['lib/validation-parity.js'], category: 'submission.fixture' });
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'owner-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const unauthorizedCli = runCli(['submit', ticket.ref, '--by', 'intruder-worker', '--commit', commit, '--verify', 'node --test test/submission.test.ts']);
  assert.strictEqual(unauthorizedCli.status, 1);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
  const unauthorizedMcp = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'intruder-worker',
    commit,
    verify: 'node --test test/submission.test.ts',
    worktree: PROJECT_DIR,
    body: 'No paths admitted. Validation was expected to refuse the caller.',
  });
  assert.strictEqual(unauthorizedMcp.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);

  const invalidCli = runCli(['submit', ticket.ref, '--by', 'owner-worker', '--commit', commit, '--verify', 'unstructured prose']);
  assert.strictEqual(invalidCli.status, 1);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
  const invalidMcp = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: ticket.ref,
    by: 'owner-worker',
    commit,
    verify: 'unstructured prose',
    worktree: PROJECT_DIR,
    body: 'No paths admitted. Independent verify validation must prevent rejection history.',
  });
  assert.strictEqual(invalidMcp.reason, 'missing_git_ref');
  assert.ok(invalidMcp.failures.some((failure: any) => failure.reason === 'invalid_verify'));
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions, undefined);
});

test('pending rejection transactions recover the quarantine ref and store transition (SQ-1667)', () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'crash recovery candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'crash recovery candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  const ticket = addTicket('recover a staged rejection', { category: 'submission.fixture' });
  const stored = store.getTicket(slug, ticket.ref);
  stored.rejectedSubmissions = [{
    commit,
    rejectedAt: '2026-08-09T12:00:00.000Z',
    rejectedBy: 'recovery-worker',
    review: 'Recovery evidence survives the interrupted transaction.',
    reason: 'The process stopped after the store intent was committed.',
    quarantineRef: `refs/sidequest/${ticket.ref}-rejected`,
    validation: true,
    rejectionKind: 'validation',
    preservationState: 'pending',
    source: 'mcp',
  }];
  persist(stored);
  git(['update-ref', '-d', stored.rejectedSubmissions[0].quarantineRef]);

  const recovered = store.reconcileSubmissionRejections(slug, ticket.ref);
  assert.strictEqual(recovered.ok, true, recovered.message);
  assert.strictEqual(recovered.recovered.length, 1);
  assert.strictEqual(git(['rev-parse', stored.rejectedSubmissions[0].quarantineRef]), commit);
  assert.strictEqual(store.getTicket(slug, ticket.ref).rejectedSubmissions[0].preservationState, 'preserved');
});

test('rejection history retrieval returns every bounded row oldest first (SQ-1667)', async () => {
  const ticket = addTicket('retrieve complete rejection history', { category: 'submission.fixture' });
  const stored = store.getTicket(slug, ticket.ref);
  stored.rejectedSubmissions = Array.from({ length: 6 }, (_, index) => ({
    commit: `${index + 1}`.repeat(40),
    rejectedAt: `2026-08-09T12:00:0${index}.000Z`,
    rejectedBy: 'review-audit',
    review: `${index}:` + 'v'.repeat(990),
    reason: `${index}:` + 'r'.repeat(3990),
    quarantineRef: `refs/sidequest/${ticket.ref}-rejected-${index + 1}`,
    preservationState: 'preserved',
  }));
  persist(stored);
  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, ticket.ref), 'history-token', slug, PROJECT_DIR);
  const latest = stored.rejectedSubmissions[stored.rejectedSubmissions.length - 1];
  assert.ok(briefing.includes(`Latest rejected candidate (6/6): ${latest.commit}`));
  assert.ok(briefing.includes(`Latest rejection reason:\n${latest.reason}`));
  assert.ok(briefing.includes(`Latest review evidence:\n${latest.review}`));
  const retrievalMatch = briefing.match(/context_page\((\{[^\n]+\})\)\. For every later page/);
  assert.ok(retrievalMatch, 'briefing carries the mandatory history retrieval');
  let argumentsValue: any = JSON.parse(retrievalMatch[1]);
  const rows: any[] = [];
  while (argumentsValue) {
    const page = await callMcp('context_page', argumentsValue);
    rows.push(...page.rows);
    argumentsValue = page.continuation;
  }
  assert.deepStrictEqual(rows.map((entry: any) => entry.position), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(rows.map((entry: any) => entry.commit), stored.rejectedSubmissions.map((entry: any) => entry.commit));
  assert.strictEqual(rows[0].reason, stored.rejectedSubmissions[0].reason);
  assert.strictEqual(rows[5].review, stored.rejectedSubmissions[5].review);
});

test('rework leaves a pending submission intact when quarantine preservation fails (SQ-1642)', async () => {
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'preservation failure candidate\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'preservation failure candidate']);
  const candidate = git(['rev-parse', 'HEAD']);
  const t = addTicket('rework preservation failure', { category: 'submission.fixture' });
  pin(t, candidate);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'failure-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'failure-worker', { commit: candidate }).ok, true);
  const pending = store.getTicket(slug, t.ref);
  pending.submission.commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  persist(pending);

  const rejected = await callMcp('rework', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'failure-worker',
    review: 'Preservation failure review evidence.',
    reason: 'Keep the pending candidate when its quarantine ref cannot be created.',
  });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'rejected_submission_preservation_failed');
  const afterFailure = store.getTicket(slug, t.ref);
  assert.strictEqual(afterFailure.submission.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(afterFailure.rejectedSubmissions, undefined);
});

test('MCP submit(clear:true) clears a bounced submission end to end: submit -> clear -> redispatch -> fresh claim succeeds (SQ-1010)', async () => {
  const t = addTicket('mcp submit clear end to end');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);
  assert.strictEqual(store.pendingSubmission(store.getTicket(slug, t.ref)), true);

  const unauthorizedCliClear = runCli(['submit', t.ref, '--by', 'orchestrator', '--clear', '--status', 'todo', '--force']);
  assert.strictEqual(unauthorizedCliClear.status, 1);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, COMMIT);

  const unauthorizedClear = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'orchestrator',
    clear: true,
    status: 'todo',
    force: true,
  });
  assert.strictEqual(unauthorizedClear.reason, 'not_owner');
  assert.strictEqual(store.getTicket(slug, t.ref).submission.commit, COMMIT);

  const rejected = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: t.ref,
    by: 'worker-a',
    clear: true,
    status: 'todo',
  });
  assert.strictEqual(rejected.ok, true);
  assert.strictEqual(rejected.status, 'todo');

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission, null);
  assert.strictEqual(store.pendingSubmission(after), false);

  const redispatched = store.claimTicket(slug, t.ref, 'worker-b', { direct: true, reason: 'The submission fixture requires a local direct claim.' });
  assert.strictEqual(redispatched.ok, true, 'a fresh executor claims successfully after the reject');

  const doubleClear = await callMcp('submit', { project: PROJECT_DIR, ref: t.ref, by: 'orchestrator', clear: true });
  assert.strictEqual(doubleClear.ok, false);
  assert.strictEqual(doubleClear.reason, 'no_submission');
});

test('existing tickets with prose verify fields remain readable', () => {
  const t = addTicket('legacy prose verify');
  t.executorVerify = 'Read the rendered page source and confirm the required points.';
  persist(t);

  assert.strictEqual(store.getTicket(slug, t.ref).executorVerify, t.executorVerify);
});

test('integration rolls back when post-merge verification fails', () => {
  cleanBranch();
  const t = addTicket('post-merge verification', { files: ['lib/preflight.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'post-merge-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'preflight.js'), 'preflight\n');
  git(['add', 'lib/preflight.js']);
  git(['commit', '-m', 'post-merge candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'post-merge-worker', '--commit', commit, '--verify', 'node -e "process.exit(1)"']).status, 0);

  const before = git(['rev-parse', 'HEAD']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'verify_failed_post_merge');
  assert.strictEqual(rejected.verify.command, 'node -e "process.exit(1)"');
  assert.ok(fs.existsSync(rejected.verify.logPath));
  assert.strictEqual(git(['rev-parse', 'HEAD']), before);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.integration.reason, 'verify_failed_post_merge');
});

test('SQ-1743: a held delivery lock refuses another integration before it changes the checkout', () => {
  cleanBranch();
  const t = addTicket('delivery lock', { files: ['lib/delivery-lock.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'delivery-lock-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'delivery-lock.js'), 'locked\n');
  git(['add', 'lib/delivery-lock.js']);
  git(['commit', '-m', 'delivery lock candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'delivery-lock-worker', '--commit', commit]).status, 0);
  const before = git(['rev-parse', 'HEAD']);
  const lock = path.resolve(PROJECT_DIR, git(['rev-parse', '--git-common-dir']), 'sidequest-delivery.lock');
  fs.writeFileSync(lock, 'another integration\n');
  try {
    const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
    const refused = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'delivery_in_progress');
    assert.strictEqual(git(['rev-parse', 'HEAD']), before);
  } finally {
    fs.unlinkSync(lock);
  }
});

test('SQ-1749: a live owner survives expiry and cannot release a replacement lock', () => {
  const locks = createLocks({ fs, path, ticketsDir: () => SIDEQUEST_HOME, transaction: (fn: any) => fn() });
  const lock = path.join(SIDEQUEST_HOME, 'delivery-owner.lock');
  const owner = locks.acquireLock(lock, { wait: false });
  assert.ok(owner);
  try {
    const expired = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, expired, expired);
    assert.strictEqual(locks.acquireLock(lock, { wait: false }), false);
  } finally {
    assert.deepStrictEqual(locks.releaseLock(lock, owner), { ok: true });
  }

  fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }));
  const replacement = locks.acquireLock(lock, { wait: false });
  assert.ok(replacement);
  assert.deepStrictEqual(locks.releaseLock(lock, 'dead-owner'), { ok: false, reason: 'lock_owner_lost' });
  assert.ok(fs.existsSync(lock));
  assert.deepStrictEqual(locks.releaseLock(lock, replacement), { ok: true });
});

test('integration reports and records merge conflict paths before aborting', () => {
  cleanBranch();
  const t = addTicket('merge conflict paths', { files: ['lib/merge-conflict.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'merge-conflict-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'merge-conflict.js'), 'candidate\n');
  git(['add', 'lib/merge-conflict.js']);
  git(['commit', '-m', 'merge conflict candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'merge-conflict-worker', '--commit', commit]).status, 0);

  git(['checkout', '-f', '-B', 'merge-conflict-target', 'origin/main']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'merge-conflict.js'), 'target\n');
  git(['add', 'lib/merge-conflict.js']);
  git(['commit', '-m', 'merge conflict target']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'merge', target });

  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'merge_failed');
  assert.deepStrictEqual(rejected.conflictedPaths, ['lib/merge-conflict.js']);
  assert.match(rejected.message, /Conflicted paths: lib\/merge-conflict\.js\./);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.integration.conflictedPaths, ['lib/merge-conflict.js']);
  assert.strictEqual(git(['status', '--porcelain']), '');
});

test('integration reports and records replay conflict paths before aborting', () => {
  cleanBranch();
  const t = addTicket('replay conflict paths', { files: ['lib/replay-conflict.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'replay-conflict-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'replay-conflict.js'), 'candidate\n');
  git(['add', 'lib/replay-conflict.js']);
  git(['commit', '-m', 'replay conflict candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'replay-conflict-worker', '--commit', commit]).status, 0);

  git(['checkout', '-f', '-B', 'replay-conflict-target', 'origin/main']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'replay-conflict.js'), 'target\n');
  git(['add', 'lib/replay-conflict.js']);
  git(['commit', '-m', 'replay conflict target']);
  const target = Object.assign({}, store.integrationTarget(slug), { branch: git(['branch', '--show-current']) });
  const rejected = store.integrateSubmission(slug, t.ref, { mode: 'replay', target });

  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'replay_failed');
  assert.deepStrictEqual(rejected.conflictedPaths, ['lib/replay-conflict.js']);
  assert.match(rejected.message, /Conflicted paths: lib\/replay-conflict\.js\./);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.integration.conflictedPaths, ['lib/replay-conflict.js']);
  assert.strictEqual(git(['status', '--porcelain']), '');
});

test('integration closure consumes an in-scope submission with control-plane provenance', () => {
  cleanBranch();
  const t = addTicket('integration consumes submission', {
    files: ['lib/integrates.js'],
    category: 'submission.fixture',
  });
  const prepared = store.prepareDispatch(slug, t.ref, {
    sessionId: 'integration-consumes-submission',
    sharedTree: true,
  });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'integration-consumes-submission',
  }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'integrates.js'), 'integrated\n');
  git(['add', 'lib/integrates.js']);
  git(['commit', '-m', 'integration candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'worker-a', '--commit', commit]).status, 0);
  const submitted = store.getTicket(slug, t.ref);
  assert.strictEqual(submitted.lifecycleAttempt.state, 'submitted');
  assert.strictEqual(submitted.dispatch.lifecycleAttempt.state, 'submitted');

  const completed = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${commit} into main.`]);
  assert.strictEqual(completed.status, 0, completed.stderr + completed.stdout);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.status, 'done');
  assert.strictEqual(after.completion.authority, 'control-plane');
  assert.strictEqual(after.completion.purpose, 'integration');
  assert.ok(after.submission.integratedAt, 'integration closure stamps the submission integrated');
  assert.strictEqual(after.lifecycleAttempt.state, 'closed');
  assert.strictEqual(after.dispatch.lifecycleAttempt.state, 'closed');
  assert.strictEqual(store.pendingSubmission(after), false);
  assert.ok(!store.submissionsPayload(slug).tickets.some((x?: any) => x.ref === t.ref));
});

test('legacy submission scope overrides require an explicit flag and retain its reason', () => {
  cleanBranch();
  const t = addTicket('legacy scope snapshot', { files: ['lib/legacy.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'legacy-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'legacy.js'), 'legacy\n');
  git(['add', 'lib/legacy.js']);
  git(['commit', '-m', 'legacy scope candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'legacy-worker', '--commit', commit]).status, 0);
  const legacy = store.getTicket(slug, t.ref);
  delete legacy.submission.admittedScope;
  persist(legacy);

  const queued = cliJson(['publish', 'queue', '--json']).tickets.find((entry?: any) => entry.ref === t.ref);
  assert.strictEqual(queued.rangeValidation.reason, 'missing_scope_snapshot');
  const refused = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--reason', 'Legacy handoff was integrated before scope snapshots shipped.']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /no admitted scope snapshot/);

  const overridden = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--override-legacy-scope', '--reason', 'Legacy handoff was integrated before scope snapshots shipped.']);
  assert.strictEqual(overridden.status, 0, overridden.stderr + overridden.stdout);
  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.completion.legacyScopeOverride.reason, 'Legacy handoff was integrated before scope snapshots shipped.');
  assert.match(after.comments.at(-1).body, /Legacy handoff was integrated before scope snapshots shipped/);
});

test('scope snapshots refuse changed paths at queue and integration after ticket scope changes', () => {
  cleanBranch();
  const t = addTicket('immutable admitted scope', { files: ['lib/snapshotted.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'snapshot-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'snapshotted.js'), 'snapshotted\n');
  git(['add', 'lib/snapshotted.js']);
  git(['commit', '-m', 'snapshotted scope candidate']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  assert.strictEqual(runCli(['submit', t.ref, '--by', 'snapshot-worker', '--commit', commit]).status, 0);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, ['lib/snapshotted.js']);

  store.updateTicket(slug, t.ref, { files: ['lib'] });
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, ['lib/snapshotted.js']);
  const malformed = store.getTicket(slug, t.ref);
  malformed.submission.admittedScope = ['lib/rewritten.js'];
  persist(malformed);

  const queued = cliJson(['publish', 'queue', '--json']).tickets.find((entry?: any) => entry.ref === t.ref);
  assert.strictEqual(queued.rangeValidation.reason, 'outside_scope');
  assert.deepStrictEqual(queued.rangeValidation.outside, ['lib/snapshotted.js']);
  const refused = runCli(['groom-close', t.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${commit} into main.`]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /lib\/snapshotted\.js/);
});

test('brief and pulse surface a pending submission', () => {
  const t = addTicket('surfaced submission');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-a', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-a', { commit: COMMIT }).ok, true);

  const brief = store.briefTicket(slug, store.getTicket(slug, t.ref));
  assert.strictEqual(brief.submission.commit, COMMIT);

  const pulse = store.pulsePayload(slug, t.ref);
  assert.strictEqual(pulse.submission.commit, COMMIT);
  assert.strictEqual(pulse.claim, null);
});

test('CLI: scoped commit excludes a foreign staged path and keeps it staged', () => {
  const t = addTicket('cli scoped commit', { files: ['lib/cli-scoped.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'cli-scoped.js'), 'scoped\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', '.']);

  const committed = runCli(['commit', t.ref, '--by', 'scope-worker', '--message', 'scoped fixture']);
  assert.strictEqual(committed.status, 0, committed.stderr + committed.stdout);
  assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'lib/cli-scoped.js');
  assert.equal(git(['diff', '--cached', '--name-only']), 'foreign.js');
  assert.match(store.getTicket(slug, t.ref).comments.at(-1).body, /out-of-scope changes present: foreign\.js/);
  assert.strictEqual(runCli(['release', t.ref, '--by', 'scope-worker']).status, 0);
  git(['reset', '--', 'foreign.js']);
});

test('SQ-1008: scope-gated submission is refused and legacy partial records stay visibly blocked', () => {
  const unscopedPaths = [
    'plugins/model-gateway/bin/model-gateway.js',
    'plugins/model-gateway/test/context-window.test.js',
    'plugins/workbench/skills/enable-project-telemetry/SKILL.md',
    'plugins/workbench/skills/init-workspace/SKILL.md',
    'plugins/workbench/test/init-workspace-skill.test.js',
  ];
  const changedPaths = ['docs/src/content/docs/getting-started/codex-gateway.md'];
  const t = addTicket('SQ-1003 partial submission fixture', { files: ['docs/'] });
  assert.strictEqual(store.claimTicket(slug, t.ref, 'docs-worker', { direct: true, reason: 'The submission fixture requires a local direct claim.' }).ok, true);

  const refused = store.submitTicket(slug, t.ref, 'docs-worker', { commit: COMMIT, unscopedPaths });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'unscoped_paths');
  assert.match(refused.message, /PARTIAL/);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).claim.by, 'docs-worker');
  assert.strictEqual(store.getTicket(slug, t.ref).submission, undefined);

  const legacy = store.getTicket(slug, t.ref);
  legacy.claim = null;
  legacy.submission = {
    commit: COMMIT,
    gitRef: `refs/sidequest/${t.ref}`,
    admittedScope: ['docs/'],
    unscopedPaths,
    changedPaths,
    integratedAt: null,
  };
  persist(legacy);

  assert.deepStrictEqual(store.submissionReadiness(legacy.submission), {
    ok: false,
    state: 'partial',
    reason: 'unscoped_paths',
    unscopedPaths,
    message: `PARTIAL: scope-gated paths remain outside this submission: ${unscopedPaths.join(', ')}.`,
  });
  assert.strictEqual(store.briefTicket(slug, legacy).submission.readiness.state, 'partial');
  assert.strictEqual(store.pulsePayload(slug, t.ref).submission.readiness.state, 'partial');
  assert.strictEqual(store.submissionsPayload(slug).tickets.find((entry?: any) => entry.ref === t.ref).submission.readiness.state, 'partial');

  const queued = cliJson(['publish', 'queue', '--json']).tickets.find((entry?: any) => entry.ref === t.ref);
  assert.strictEqual(queued.rangeValidation.reason, 'unscoped_paths');
  assert.deepStrictEqual(queued.rangeValidation.unscopedPaths, unscopedPaths);

  const integration = store.integrateSubmission(slug, t.ref, {});
  assert.strictEqual(integration.ok, false);
  assert.strictEqual(integration.reason, 'unscoped_paths');
  assert.match(integration.message, /PARTIAL/);
});


test('generated pairs admit tracked output through CLI scoped commit and submit', () => {
  cleanBranch();
  const source = 'plugins/sidequest/src/bin/pair.ts';
  const output = 'plugins/sidequest/bin/pair.js';
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, source)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, output)), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, source), 'export const pair = true;\n');
  fs.writeFileSync(path.join(PROJECT_DIR, output), 'exports.pair = true;\n');
  git(['add', source, output]);
  git(['commit', '-m', 'tracked generated pair fixture']);
  git(['push', 'origin', `HEAD:main`]);
  cleanBranch();
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/bin/*.ts', to: 'plugins/*/bin/*.js' }] });
  const t = addTicket('generated pair submission', { files: [source] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'pair-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, source), 'export const pair = false;\n');
  fs.writeFileSync(path.join(PROJECT_DIR, output), 'exports.pair = false;\n');
  const committed = cliJson(['commit', t.ref, '--by', 'pair-worker', '--message', 'paired submission', '--json']);
  assert.deepStrictEqual(committed.paths.sort(), [output, source]);
  pin(t, committed.commit);
  const submitted = runCli(['submit', t.ref, '--by', 'pair-worker', '--commit', committed.commit]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.deepStrictEqual(store.getTicket(slug, t.ref).submission.admittedScope, [source, output]);
  store.setBoardConfig(slug, { generatedPairs: null });
});


test('publish queue adds release-window context only when release fragments exist', () => {
  cleanBranch();
  const fragments = path.join(PROJECT_DIR, '.release', 'unreleased');
  assert.strictEqual(cliJson(['publish', 'queue', '--json']).releaseWindow, undefined);
  fs.mkdirSync(fragments, { recursive: true });
  fs.writeFileSync(path.join(fragments, 'SQ-1.md'), '---\nhold: true\n---\nHeld\n');
  fs.writeFileSync(path.join(fragments, 'SQ-2.md'), '---\n---\nReady\n');
  store.setBoardConfig(slug, { integrationBranch: 'dev' });
  try {
    const queue = cliJson(['publish', 'queue', '--json']);
    assert.equal(queue.releaseWindow.fragmentCount, 2);
    assert.equal(queue.releaseWindow.heldCount, 1);
    assert.equal(queue.releaseWindow.integrationBranch, 'dev');
    assert.equal(queue.releaseWindow.publishedBranch, 'main');
    assert.equal(queue.releaseWindow.nextScheduledCut, 'daily at 06:00 local');
    const output = runCli(['publish', 'queue']);
    assert.match(output.stdout, /release window: 2 fragment\(s\), 1 held/);
    assert.match(output.stdout, /dev → main/);
  } finally {
    store.setBoardConfig(slug, { integrationBranch: 'main' });
    fs.rmSync(path.join(PROJECT_DIR, '.release'), { recursive: true, force: true });
  }
});

test('CLI: submit parks an immutable source revision without Git range discovery', () => {
  const { project, ticket, runCli: runNoGitCli } = noGitCliTicket('CLI source revision', ['wiki/page.md']);
  assert.strictEqual(runNoGitCli([
    'claim', ticket.ref, '--by', 'cli-source-worker', '--direct',
    '--reason', 'This fixture publishes one exact immutable source revision.',
  ]).status, 0);

  const submitted = runNoGitCli([
    'submit', ticket.ref, '--by', 'cli-source-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'wiki-revision-42',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--no-process', '--no-worktree', '--review',
    '--verify', 'attestation: wiki-revision-42 | editor-approved | editor approved the immutable revision',
    '--body', 'Reviewed immutable wiki revision.',
  ]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /wiki:wiki-revision-42/);

  const stored = store.getTicket(project, ticket.ref);
  assert.deepStrictEqual(stored.submission.sourceRevision, {
    source: 'wiki',
    value: 'wiki-revision-42',
    observedAt: '2026-08-14T00:00:00.000Z',
  });
  assert.deepStrictEqual(stored.submission.changedPaths, ['wiki/page.md']);
  assert.deepStrictEqual(stored.submission.projectCapabilities, {
    process: false,
    worktree: false,
    review: true,
    git: false,
  });
  assert.ok(stored.comments.some((comment?: any) => /Reviewed immutable wiki revision/.test(comment.body)));

  const queueJson = runNoGitCli(['publish', 'queue', '--json']);
  assert.strictEqual(queueJson.status, 0, queueJson.stderr + queueJson.stdout);
  const queuedTicket = JSON.parse(queueJson.stdout).tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.strictEqual(queuedTicket.rangeValidation.ok, true);
  assert.strictEqual(queuedTicket.rangeValidation.reason, null);

  const queueText = runNoGitCli(['publish', 'queue']);
  assert.strictEqual(queueText.status, 0, queueText.stderr + queueText.stdout);
  assert.match(queueText.stdout, /source revision wiki:wiki-revision-42/);
  assert.doesNotMatch(queueText.stdout, /legacy_submission/);
});

test('CLI: source revision submission cannot bypass Git delivery', () => {
  const ticket = addTicket('CLI false non-Git submission', { files: ['wiki/page.md'] });
  assert.strictEqual(runCli([
    'claim', ticket.ref, '--by', 'cli-false-capability-worker', '--direct',
    '--reason', 'This fixture checks one exact public submission refusal.',
  ]).status, 0);

  const refused = runCli([
    'submit', ticket.ref, '--by', 'cli-false-capability-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'invented-revision',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--verify', 'attestation: invented-revision | self-approved | caller asserted delivery',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /require a project outside Git/);
  const stored = store.getTicket(slug, ticket.ref);
  assert.strictEqual(stored.submission, undefined);
  assert.strictEqual(stored.claim.by, 'cli-false-capability-worker');
});

test('CLI: submit reports source revision scope refusals without crashing', () => {
  const { project, ticket, runCli: runNoGitCli } = noGitCliTicket('CLI source scope refusal', ['wiki/allowed.md']);
  assert.strictEqual(runNoGitCli([
    'claim', ticket.ref, '--by', 'cli-source-refusal-worker', '--direct',
    '--reason', 'This fixture checks one exact public submission refusal.',
  ]).status, 0);

  const refused = runNoGitCli([
    'submit', ticket.ref, '--by', 'cli-source-refusal-worker',
    '--source-revision-source', 'wiki',
    '--source-revision-value', 'wiki-revision-43',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/outside.md',
    '--verify', 'attestation: wiki-revision-43 | editor-reviewed | editor found the revision complete',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /outside its declared scope/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /TypeError/);
  assert.strictEqual(store.getTicket(project, ticket.ref).submission, undefined);
});

test('CLI: submit rejects mixed Git and source revision identities', () => {
  const ticket = addTicket('CLI mixed revision identity', { files: ['wiki/page.md'] });
  assert.strictEqual(runCli([
    'claim', ticket.ref, '--by', 'cli-mixed-worker', '--direct',
    '--reason', 'This fixture checks one exact public submission validation.',
  ]).status, 0);

  const refused = runCli([
    'submit', ticket.ref, '--by', 'cli-mixed-worker', '--commit', COMMIT,
    '--source-revision-source', 'wiki', '--source-revision-value', 'wiki-revision-42',
    '--source-revision-observed-at', '2026-08-14T00:00:00.000Z',
    '--changed-surface', 'wiki/page.md',
    '--verify', 'attestation: wiki-revision-42',
  ]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /exactly one of --commit or --source-revision-value/);
});

test('CLI: submit parks the ticket READY_FOR_INTEGRATION with an evidence comment, publish queue lists it', () => {
  cleanBranch();
  const t = addTicket('cli submit round-trip');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'cli-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'submitted fixture\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'submission fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);
  const submitted = runCli([
    'submit', t.ref, '--by', 'cli-worker', '--commit', commit,
    '--verify', 'node --test plugins/sidequest/test/submission.test.js',
    '-m', 'READY_FOR_INTEGRATION evidence body',
  ]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /READY_FOR_INTEGRATION/);

  const after = store.getTicket(slug, t.ref);
  assert.strictEqual(after.submission.verify, 'node --test plugins/sidequest/test/submission.test.js');
  assert.deepStrictEqual(after.submission.commits, [commit]);
  assert.deepStrictEqual(after.submission.changedPaths, ['lib/fixture.js']);
  assert.strictEqual(after.submission.base, git(['rev-parse', 'origin/main']));
  assert.ok(after.comments.some((c?: any) => /READY_FOR_INTEGRATION evidence body/.test(c.body)));

  const queue = cliJson(['publish', 'queue', '--json']);
  assert.ok(queue.tickets.some((x?: any) => x.ref === t.ref));

  // done without integration is the orchestrator's call; the CLI still guards claims:
  const reclaim = runCli(['claim', t.ref, '--by', 'other', '--direct', '--reason', 'The submission fixture requires a local direct claim.']);
  assert.strictEqual(reclaim.status, 1);
  assert.match(reclaim.stdout, /READY_FOR_INTEGRATION/);

  const cleared = runCli(['submit', t.ref, '--by', 'cli-worker', '--clear', '-s', 'todo']);
  assert.strictEqual(cleared.status, 0, cleared.stderr + cleared.stdout);
  assert.strictEqual(store.getTicket(slug, t.ref).submission, null);
});

test('CLI: submit rejects worktree-bound verify commands and preserves portable commands', () => {
  cleanBranch();
  const t = addTicket('worktree-bound verify command');
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'verify-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'submitted fixture\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'verify fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const windowsStyle = `${PROJECT_DIR.replace(/\//g, '\\')}\\lib\\fixture.js`;
  const posixStyle = `${PROJECT_DIR.replace(/\\/g, '/')}/lib/fixture.js`;
  for (const verify of [windowsStyle, posixStyle]) {
    const rejected = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', `node --test ${verify}`]);
    assert.strictEqual(rejected.status, 1, rejected.stderr + rejected.stdout);
    assert.match(rejected.stderr + rejected.stdout, /run verification from the repo root and use repo-relative paths/i);
    assert.ok(store.getTicket(slug, t.ref).claim, 'rejected submission keeps the claim');
  }

  if (process.platform === 'win32') {
    const caseVariant = `${posixStyle.slice(0, 1).toLowerCase()}${posixStyle.slice(1).toUpperCase()}`;
    const rejected = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', `node --test ${caseVariant}`]);
    assert.strictEqual(rejected.status, 1, rejected.stderr + rejected.stdout);
  }

  const verify = 'C:\\tools\\node.exe --test lib/fixture.js --fixture C:\\fixtures\\submission.json';
  const submitted = runCli(['submit', t.ref, '--by', 'verify-worker', '--commit', commit, '--verify', verify]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.strictEqual(store.getTicket(slug, t.ref).submission.verify, verify);
});

test('CLI: SQ-406-shaped two-commit submissions retain implementation and tests in order', () => {
  cleanBranch();
  const t = addTicket('SQ-406-shaped range', { files: ['lib', 'test'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'range-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'implementation.js'), 'module.exports = true;\n');
  git(['add', 'lib/implementation.js']);
  git(['commit', '-m', 'implementation']);
  const implementation = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'implementation.test.js'), 'test fixture\n');
  git(['add', 'test/implementation.test.js']);
  git(['commit', '-m', 'tests']);
  const tests = git(['rev-parse', 'HEAD']);
  pin(t, tests);

  const submitted = runCli(['submit', t.ref, '--by', 'range-worker', '--commit', tests, '--verify', 'node --test plugins/sidequest/test/*.test.js']);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const queue = cliJson(['publish', 'queue', '--json']);
  const entry = queue.tickets.find((item?: any) => item.ref === t.ref);
  assert.deepStrictEqual(entry.submission.commits, [implementation, tests]);
  assert.deepStrictEqual(entry.submission.changedPaths, ['lib/implementation.js', 'test/implementation.test.js']);
});

test('CLI: hidden out-of-scope path in the first range commit is refused', () => {
  cleanBranch();
  const t = addTicket('hidden first commit scope', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'hidden foreign path']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'allowed tip']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(t, tip);

  const submitted = runCli(['submit', t.ref, '--by', 'scope-worker', '--commit', tip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /foreign\.js/);
  assert.match(submitted.stderr + submitted.stdout, new RegExp(`sidequest update ${t.ref} --files`));
  assert.ok(store.getTicket(slug, t.ref).claim, 'failed range validation keeps the claim');
  assert.strictEqual(runCli(['release', t.ref, '--by', 'scope-worker']).status, 0);
});

test('CLI: unrelated durable-ref history is refused', () => {
  cleanBranch();
  const t = addTicket('unrelated submission', { files: ['lib/unrelated.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'unrelated-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  git(['checkout', '--orphan', `unrelated-${++branchSeq}`]);
  git(['rm', '-rf', '.']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'unrelated.js'), 'unrelated\n');
  git(['add', '.']);
  git(['commit', '-m', 'unrelated root']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(t, tip);

  const submitted = runCli(['submit', t.ref, '--by', 'unrelated-worker', '--commit', tip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /unrelated_history/);
  assert.strictEqual(runCli(['release', t.ref, '--by', 'unrelated-worker']).status, 0);
});

test('CLI: an integrated ancestor is excluded from dependent submission duplicate checks', () => {
  cleanBranch();
  const first = addTicket('integrated ancestor', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-integrated-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'integrated ancestor']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-integrated-worker', '--commit', firstTip]).status, 0);
  const integrated = runCli(['groom-close', first.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${firstTip} into main.`]);
  assert.strictEqual(integrated.status, 0, integrated.stderr + integrated.stdout);

  const second = addTicket('dependent submission duplicate check', { files: ['lib'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'dependent-duplicate-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'dependent submission']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'dependent-duplicate-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, second.ref).submission;
  assert.strictEqual(submission.base, firstTip);
  assert.deepStrictEqual(submission.commits, [secondTip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/second.js']);
});

test('CLI: integrated ancestor paths are excluded from dependent submission scope checks', () => {
  cleanBranch();
  const first = addTicket('integrated out-of-scope ancestor', { files: ['foreign.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'integrated foreign path']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-scope-worker', '--commit', firstTip]).status, 0);
  const integrated = runCli(['groom-close', first.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${firstTip} into main.`]);
  assert.strictEqual(integrated.status, 0, integrated.stderr + integrated.stdout);

  const second = addTicket('dependent submission scope check', { files: ['lib/second.js'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'dependent-scope-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'scoped dependent submission']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'dependent-scope-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, second.ref).submission;
  assert.strictEqual(submission.base, firstTip);
  assert.deepStrictEqual(submission.commits, [secondTip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/second.js']);
});

test('CLI: an explicit submitted base isolates a dependent queued range', () => {
  cleanBranch();
  const first = addTicket('explicit base ancestor', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'explicit-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'explicit base ancestor']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'explicit-base-worker', '--commit', firstTip]).status, 0);

  const second = addTicket('explicit dependent range', { files: ['lib/second.js'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'explicit-dependent-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'explicit dependent range']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);

  const submitted = runCli(['submit', second.ref, '--by', 'explicit-dependent-worker', '--commit', secondTip, '--base', firstTip]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, second.ref).submission;
  assert.strictEqual(submission.base, firstTip);
  assert.deepStrictEqual(submission.commits, [secondTip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/second.js']);
});

test('CLI: a control-plane-integrated local main commit is accepted as an explicit base', (t?: any) => {
  cleanBranch();
  t.after(() => git(['branch', '-f', 'main', 'origin/main']));

  const integratedTicket = addTicket('control-plane-integrated base', { files: ['foreign.js'] });
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'integrated locally\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'control-plane-integrated base']);
  const integratedBase = git(['rev-parse', 'HEAD']);
  git(['branch', '-f', 'main', integratedBase]);
  const closed = runCli(['groom-close', integratedTicket.ref, '--by', 'orchestrator', '--reason', `Integrated ${integratedBase} into local main without a submission.`]);
  assert.strictEqual(closed.status, 0, closed.stderr + closed.stdout);
  assert.ok(!store.getTicket(slug, integratedTicket.ref).submission);

  const ticket = addTicket('depends on control-plane-integrated base', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', ticket.ref, '--by', 'local-main-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'dependent submission']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(ticket, tip);

  const submitted = runCli(['submit', ticket.ref, '--by', 'local-main-base-worker', '--commit', tip, '--base', integratedBase]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  const submission = store.getTicket(slug, ticket.ref).submission;
  assert.strictEqual(submission.base, integratedBase);
  assert.deepStrictEqual(submission.commits, [tip]);
  assert.deepStrictEqual(submission.changedPaths, ['lib/allowed.js']);
});

test('CLI: an arbitrary explicit base cannot hide an out-of-scope commit', () => {
  cleanBranch();
  const ticket = addTicket('unrecognized explicit base', { files: ['lib/allowed.js'] });
  assert.strictEqual(runCli(['claim', ticket.ref, '--by', 'unrecognized-base-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign.js'), 'foreign\n');
  git(['add', 'foreign.js']);
  git(['commit', '-m', 'unrecognized base']);
  const hiddenCommit = git(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'allowed.js'), 'allowed\n');
  git(['add', 'lib/allowed.js']);
  git(['commit', '-m', 'allowed tip']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(ticket, tip);

  const submitted = runCli(['submit', ticket.ref, '--by', 'unrecognized-base-worker', '--commit', tip, '--base', hiddenCommit]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, /unrecognized_base/);
  assert.ok(store.getTicket(slug, ticket.ref).claim, 'rejected base keeps the claim');
});

test('CLI: a genuine ownership overlap with another queued submission is refused', () => {
  cleanBranch();
  const first = addTicket('first queued submission', { files: ['lib/first.js'] });
  assert.strictEqual(runCli(['claim', first.ref, '--by', 'first-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'first ticket']);
  const firstTip = git(['rev-parse', 'HEAD']);
  pin(first, firstTip);
  assert.strictEqual(runCli(['submit', first.ref, '--by', 'first-worker', '--commit', firstTip]).status, 0);

  const second = addTicket('second includes first', { files: ['lib'] });
  assert.strictEqual(runCli(['claim', second.ref, '--by', 'second-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second\n');
  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'second ticket']);
  const secondTip = git(['rev-parse', 'HEAD']);
  pin(second, secondTip);
  const submitted = runCli(['submit', second.ref, '--by', 'second-worker', '--commit', secondTip]);
  assert.strictEqual(submitted.status, 1);
  assert.match(submitted.stderr + submitted.stdout, new RegExp(first.ref));
  assert.strictEqual(runCli(['release', second.ref, '--by', 'second-worker']).status, 0);
});

test('CLI: board config stores a worktree setup command', () => {
  const setup = 'cd plugins/sidequest && npm ci';
  const pairs = JSON.stringify([{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }]);
  const configured = cliJson(['board-config', '--worktree-setup', setup, '--generated-pairs', pairs, '--json']);
  assert.strictEqual(configured.worktreeSetup, setup);
  assert.deepStrictEqual(configured.generatedPairs, JSON.parse(pairs));
  assert.strictEqual(cliJson(['board-config', '--json']).worktreeSetup, setup);
});

test('CLI: board config renames only the display name', () => {
  const ticket = addTicket('rename keeps CLI ticket refs');
  const before = store.readMeta(slug);
  const renamed = cliJson(['board-config', '--name', 'CLI renamed board', '--json']);

  assert.strictEqual(renamed.project, slug);
  assert.strictEqual(renamed.name, 'CLI renamed board');
  assert.strictEqual(renamed.projectName, 'CLI renamed board');
  assert.strictEqual(store.readMeta(slug).path, before.path);
  assert.strictEqual(store.getTicket(slug, ticket.ref).ref, ticket.ref);

  const rejected = runCli(['board-config', '--name', '', '--json']);
  assert.strictEqual(rejected.status, 1);
  assert.match(rejected.stderr, /Board name cannot be empty/);
});

test('CLI: a configured feature integration branch accepts its base and main refuses it', () => {
  cleanBranch();
  assert.equal(store.boardConfig(slug).integrationBranch, 'main');

  git(['checkout', '-f', '-B', 'feat/submission-target', 'origin/main']);
  fs.writeFileSync(path.join(PROJECT_DIR, 'feature-base.txt'), 'feature baseline\n');
  git(['add', 'feature-base.txt']);
  git(['commit', '-m', 'feature integration baseline']);
  const featureBase = git(['rev-parse', 'HEAD']);
  git(['push', '-f', '-u', 'origin', 'feat/submission-target']);
  store.setBoardConfig(slug, { integrationMode: 'remote', integrationBranch: 'feat/submission-target' });
  assert.deepStrictEqual(store.integrationTarget(slug), {
    mode: 'remote', upstream: 'origin/feat/submission-target', branch: 'feat/submission-target',
  });

  const accepted = addTicket('feature integration branch submission', { files: ['lib/feature-target.js'] });
  assert.equal(runCli(['claim', accepted.ref, '--by', 'feature-target-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'feature-target.js'), 'feature target\n');
  git(['add', 'lib/feature-target.js']);
  git(['commit', '-m', 'feature target submission']);
  const tip = git(['rev-parse', 'HEAD']);
  pin(accepted, tip);
  assert.equal(runCli(['submit', accepted.ref, '--by', 'feature-target-worker', '--commit', tip, '--base', featureBase]).status, 0);

  const refused = addTicket('main rejects feature integration base', { files: ['lib/feature-target.js'] });
  assert.equal(runCli(['claim', refused.ref, '--by', 'main-target-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  pin(refused, tip);
  store.setBoardConfig(slug, { integrationBranch: 'main' });
  const rejected = runCli(['submit', refused.ref, '--by', 'main-target-worker', '--commit', tip, '--base', featureBase]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr + rejected.stdout, /unrecognized_base/);
  assert.ok(store.getTicket(slug, refused.ref).claim, 'rejected submission keeps the claim');
  assert.equal(runCli(['release', refused.ref, '--by', 'main-target-worker']).status, 0);

  store.setBoardConfig(slug, { integrationBranch: 'missing-integration-branch' });
  assert.throws(() => store.integrationTarget(slug), /Configured integration ref "refs\/remotes\/origin\/missing-integration-branch"/);
  store.setBoardConfig(slug, { integrationBranch: 'main' });
});

test('CLI: a remote-less board auto-selects local integration and records a main baseline', () => {
  git(['checkout', '-f', 'main']);
  git(['clean', '-fd']);
  git(['remote', 'remove', 'origin']);
  git(['checkout', '-f', '-B', 'local-only', 'main']);

  const configured = cliJson(['board-config', '--integration-mode', 'local', '--json']);
  assert.strictEqual(configured.integrationMode, 'local');
  store.setBoardConfig(slug, { integrationMode: 'auto' });
  assert.deepStrictEqual(store.integrationTarget(slug), { mode: 'local', upstream: 'main', branch: 'main' });

  const t = addTicket('local-only submit', { files: ['lib/local-only.js'] });
  assert.strictEqual(runCli(['claim', t.ref, '--by', 'local-worker', '--direct', '--reason', 'The submission fixture requires a local direct claim.']).status, 0);
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'local-only.js'), 'local-only\n');
  git(['add', 'lib/local-only.js']);
  git(['commit', '-m', 'local-only submission']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const submitted = runCli(['submit', t.ref, '--by', 'local-worker', '--commit', commit]);
  assert.strictEqual(submitted.status, 0, submitted.stderr + submitted.stdout);
  assert.match(submitted.stdout, /against local main, then marks done without pushing/);
  const submission = store.getTicket(slug, t.ref).submission;
  assert.strictEqual(submission.integrationMode, 'local');
  assert.strictEqual(submission.upstream, 'main');
  assert.strictEqual(submission.base, git(['rev-parse', 'main']));
});

// A shared tree is the user's own checkout and can already be dirty with work
// that has nothing to do with the run. Gating a verified submission on those
// paths costs a scope round trip nobody can rule on usefully (contractify SQ-95).
test('SQ-1367: a shared-tree submission is not gated on paths that were already dirty at dispatch', () => {
  const stray = path.join(PROJECT_DIR, 'before-neutral-rework.jpeg');
  fs.writeFileSync(stray, 'the user\'s own screenshot\n');

  const t = addTicket('inherited dirt', { files: ['lib/inherited.js'], category: 'submission.fixture' });
  const prepared = store.prepareDispatch(slug, t.ref, { sessionId: 'inherited-dirt', sharedTree: true });
  assert.ok(
    store.getTicket(slug, t.ref).dispatch.dirtyBaseline.some((entry: any) => entry.path === 'before-neutral-rework.jpeg'),
    'the dispatch records what was already dirty in the shared tree',
  );
  assert.strictEqual(store.claimTicket(slug, t.ref, 'inherited-worker', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'inherited-dirt',
  }).ok, true);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'inherited.js'), 'scoped work\n');
  git(['add', 'lib/inherited.js']);
  git(['commit', '-m', 'scoped work beside inherited dirt']);
  const commit = git(['rev-parse', 'HEAD']);
  pin(t, commit);

  const unscopedPaths = ['before-neutral-rework.jpeg'];
  const submitted = store.submitTicket(slug, t.ref, 'inherited-worker', { commit, unscopedPaths });
  assert.strictEqual(submitted.ok, true, submitted.message);
  assert.deepStrictEqual(submitted.ticket.submission.unscopedPaths, []);
  assert.deepStrictEqual(submitted.ticket.submission.inheritedPaths, unscopedPaths);

  // Touching an inherited path puts it back under the gate: the exemption is
  // content-aware, not a permanent pass for the path.
  const reworked = addTicket('inherited dirt, then touched', { files: ['lib/reworked.js'], category: 'submission.fixture' });
  const second = store.prepareDispatch(slug, reworked.ref, { sessionId: 'inherited-touch', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, reworked.ref, 'touch-worker', {
    token: second.token, executor: second.ticket.dispatchExecutor, sessionId: 'inherited-touch',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'reworked.js'), 'more scoped work\n');
  git(['add', 'lib/reworked.js']);
  git(['commit', '-m', 'more scoped work']);
  const reworkedCommit = git(['rev-parse', 'HEAD']);
  pin(reworked, reworkedCommit);
  fs.writeFileSync(stray, 'an executor overwrote it\n');
  const refused = store.submitTicket(slug, reworked.ref, 'touch-worker', { commit: reworkedCommit, unscopedPaths });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'unscoped_paths');
  assert.match(refused.message, /before-neutral-rework\.jpeg/);
  fs.rmSync(stray);
});

test('SQ-1328: concurrent shared-tree submissions attribute foreign working paths without weakening range scope', async () => {
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  cleanBranch();
  const upstreamCommit = git(['rev-parse', 'origin/main']);
  const userNotes = path.join(PROJECT_DIR, 'user-notes.txt');
  fs.writeFileSync(userNotes, 'pre-existing user work\n');

  const firstTicket = addTicket('first concurrent executor', { files: ['lib/first.js'], category: 'submission.fixture' });
  const secondTicket = addTicket('second concurrent executor', { files: ['lib/second.js'], category: 'submission.fixture' });
  const firstDispatch = store.prepareDispatch(slug, firstTicket.ref, { sessionId: 'concurrent-first', sharedTree: true });
  const secondDispatch = store.prepareDispatch(slug, secondTicket.ref, { sessionId: 'concurrent-second', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, firstTicket.ref, 'concurrent-first-worker', {
    token: firstDispatch.token, executor: firstDispatch.ticket.dispatchExecutor, sessionId: 'concurrent-first',
  }).ok, true);
  assert.strictEqual(store.claimTicket(slug, secondTicket.ref, 'concurrent-second-worker', {
    token: secondDispatch.token, executor: secondDispatch.ticket.dispatchExecutor, sessionId: 'concurrent-second',
  }).ok, true);

  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'second.js'), 'second executor in flight\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'first.js'), 'first executor committed\n');
  git(['add', 'lib/first.js']);
  git(['commit', '-m', 'first concurrent submission']);
  const firstCommit = git(['rev-parse', 'HEAD']);
  pin(firstTicket, firstCommit);

  const firstSubmission = store.submitTicket(slug, firstTicket.ref, 'concurrent-first-worker', {
    commit: firstCommit,
    unscopedPaths: ['user-notes.txt', 'lib/second.js'],
    range: {
      base: upstreamCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [firstCommit],
      changedPaths: ['lib/first.js'],
    },
  });
  assert.strictEqual(firstSubmission.ok, true, firstSubmission.message);
  assert.deepStrictEqual(firstSubmission.ticket.submission.inheritedPaths, ['user-notes.txt']);
  assert.deepStrictEqual(firstSubmission.ticket.submission.unsubmittedWorkingPaths, ['lib/second.js']);
  assert.match(firstSubmission.advisory, /user-notes\.txt \(present before dispatch\)/);
  assert.match(firstSubmission.advisory, /lib\/second\.js \(not in submitted range\)/);
  assert.match(firstSubmission.advisory, /Commit only your declared scope; never stash or revert foreign paths/);

  git(['add', 'lib/second.js']);
  git(['commit', '-m', 'second concurrent submission']);
  const secondCommit = git(['rev-parse', 'HEAD']);
  pin(secondTicket, secondCommit);
  const secondSubmission = store.submitTicket(slug, secondTicket.ref, 'concurrent-second-worker', {
    commit: secondCommit,
    unscopedPaths: ['user-notes.txt'],
    range: {
      base: firstCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [secondCommit],
      changedPaths: ['lib/second.js'],
    },
  });
  assert.strictEqual(secondSubmission.ok, true, secondSubmission.message);
  assert.deepStrictEqual(secondSubmission.ticket.submission.inheritedPaths, ['user-notes.txt']);

  const escapedTicket = addTicket('submitted range still owns its scope', { files: ['lib/scoped.js'], category: 'submission.fixture' });
  const escapedDispatch = store.prepareDispatch(slug, escapedTicket.ref, { sessionId: 'escaped-range', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, escapedTicket.ref, 'escaped-range-worker', {
    token: escapedDispatch.token, executor: escapedDispatch.ticket.dispatchExecutor, sessionId: 'escaped-range',
  }).ok, true);
  fs.mkdirSync(path.join(PROJECT_DIR, 'foreign'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'scoped.js'), 'scoped\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'foreign', 'escaped.js'), 'escaped\n');
  git(['add', 'lib/scoped.js', 'foreign/escaped.js']);
  git(['commit', '-m', 'range with escaped path']);
  const escapedCommit = git(['rev-parse', 'HEAD']);
  pin(escapedTicket, escapedCommit);
  const mcpEscapedSubmission = await callMcp('submit', {
    project: PROJECT_DIR,
    ref: escapedTicket.ref,
    by: 'escaped-range-worker',
    commit: escapedCommit,
    base: secondCommit,
    worktree: PROJECT_DIR,
    body: 'Escaped range refusal fixture.',
  });
  assert.strictEqual(mcpEscapedSubmission.ok, false);
  assert.strictEqual(mcpEscapedSubmission.reason, 'outside_scope');
  assert.match(mcpEscapedSubmission.message, /never stash, revert, or include foreign paths/);

  const cliEscapedSubmission = runCli([
    'submit', escapedTicket.ref, '--by', 'escaped-range-worker', '--commit', escapedCommit, '--base', secondCommit,
  ]);
  assert.strictEqual(cliEscapedSubmission.status, 1);
  assert.match(cliEscapedSubmission.stderr + cliEscapedSubmission.stdout, /never stash, revert, or include foreign paths/);

  const escapedSubmission = store.submitTicket(slug, escapedTicket.ref, 'escaped-range-worker', {
    commit: escapedCommit,
    range: {
      base: secondCommit,
      upstream: 'origin/main',
      upstreamCommit,
      commits: [escapedCommit],
      changedPaths: ['foreign/escaped.js', 'lib/scoped.js'],
    },
  });
  assert.strictEqual(escapedSubmission.ok, false);
  assert.strictEqual(escapedSubmission.reason, 'outside_scope');
  assert.deepStrictEqual(escapedSubmission.outside, ['foreign/escaped.js']);
  assert.match(escapedSubmission.message, /never stash, revert, or include foreign paths/);
});

test('a submit after a terminal dispatch is gated on current ticket scope, not the dead binding', () => {
  const ticket = addTicket('terminal dispatch binding must not gate the submit', { files: ['lib/original.js'], category: 'submission.fixture' });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'terminal-binding', sharedTree: true });
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'terminal-binding-worker', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'terminal-binding',
  }).ok, true);
  assert.strictEqual(store.releaseTicket(slug, ticket.ref, 'terminal-binding-worker', {
    status: 'todo',
    source: 'mcp',
    releaseKind: 'handback',
    releaseReason: 'A stale pin outside the dispatched binding blocks verify.',
  }).ok, true);
  assert.ok(store.getTicket(slug, ticket.ref).dispatch.terminalAt);
  store.updateTicket(slug, ticket.ref, { files: ['lib/original.js', 'lib/granted-late.js'] });
  assert.deepStrictEqual(store.getTicket(slug, ticket.ref).files, ['lib/original.js', 'lib/granted-late.js']);
  assert.strictEqual(store.claimTicket(slug, ticket.ref, 'orchestrator-main', {
    direct: true, reason: 'Finishing the granted-path edit inline after the handback.',
  }).ok, true);
  cleanBranch();
  fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'original.js'), 'original\n');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'granted-late.js'), 'granted\n');
  git(['add', 'lib/original.js', 'lib/granted-late.js']);
  git(['commit', '-m', 'granted-path candidate']);
  const grantedCommit = git(['rev-parse', 'HEAD']);
  pin(ticket, grantedCommit);
  const grantedBase = git(['rev-parse', 'origin/main']);
  const submission = store.submitTicket(slug, ticket.ref, 'orchestrator-main', {
    commit: grantedCommit,
    range: {
      base: grantedBase,
      upstream: 'origin/main',
      upstreamCommit: grantedBase,
      commits: [grantedCommit],
      changedPaths: ['lib/granted-late.js', 'lib/original.js'],
    },
  });
  assert.strictEqual(submission.ok, true, submission.message);
  assert.ok(submission.ticket.submission.admittedScope.includes('lib/granted-late.js'));
});

export {};
