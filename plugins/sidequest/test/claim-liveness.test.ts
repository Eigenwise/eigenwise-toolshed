import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * Claim liveness: observed death decides, the clock never does (SQ-820).
 *
 * A 60 minute wall-clock TTL once stranded an executor that had done ~50 minutes
 * of real work: it finished, verified, and then could not hand its own work in,
 * because a timer had decided it was dead. Elapsed time says nothing about
 * liveness, and it fails in the most expensive direction — late in long runs,
 * during verify and commit, with the most unsaved work at stake.
 *
 * These tests pin the replacement: closeout never consults a clock, sweeping
 * keys on an observed stop, activity keeps a quiet-but-alive executor safe, and
 * the backstop that remains still cannot wedge a ticket forever.
 *
 * Run: node --test plugins/sidequest/test/claim-liveness.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-liveness-home-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-liveness-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const db = require('../lib/db.js');
const { makeCliRunner } = require('./_helpers.js');

function git(args?: any) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), 'module.exports = 1;\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'main']);

const { slug } = store.ensureProject(PROJECT_DIR);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });

const HOUR = 60 * 60 * 1000;
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function addRouted(title?: any) {
  return store.createTicket(slug, {
    title,
    description: 'Where: claim liveness fixture. Contract: keep a routed executor claimable and closeable. Verify: inspect persisted board state.',
    category: 'codebase-exploration',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function addWriteRouted(title?: any) {
  return store.createTicket(slug, {
    title,
    description: 'Where: claim liveness fixture. Contract: keep a routed executor claimable and closeable. Verify: inspect persisted board state.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function claimRouted(ticket?: any, by?: any, opts?: any) {
  const sessionId = (opts && opts.sessionId) || `${ticket.ref}-session`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, ...(opts || {}), sessionId });
  const taskName = prepared.ticket.dispatch.launchName;
  assert.strictEqual(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: taskName,
    source: 'test',
  }).ok, true);
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
    sessionId,
  });
  assert.strictEqual(claimed.ok, true);
  return prepared;
}

let negativeControlVersion = 3;

function addNegativeControlTicket(title?: any, by = 'negative-control-executor') {
  const ticket = store.createTicket(slug, {
    title,
    description: 'Where: negative-control fixture. Contract: reject a completion whose tests pass against pre-change code. Verify: inspect the refusal.',
    category: 'coding.normal',
    files: ['lib/fixture.js', 'test/fixture.test.js'],
    source: 'cli',
  });
  claimRouted(ticket, by);
  negativeControlVersion += 1;
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), `module.exports = ${negativeControlVersion};\n`);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `module.exports = ${negativeControlVersion};\n`);
  return ticket;
}

// Rewrite persisted ticket state directly: these scenarios need claims that are
// hours or days old without the test waiting for them.
// Fixed offsets from one clock read, so the ordering the test pins cannot depend on where in the run
// the test lands, while the claim stays far inside the idle backstop.
const fixtureClockMs = Date.now();
function secondsAgo(seconds: number): string {
  return new Date(fixtureClockMs - seconds * 1000).toISOString();
}

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

function backdateClaim(ref?: any, ms?: any) {
  const ticket = store.getTicket(slug, ref);
  const at = new Date(Date.now() - ms).toISOString();
  ticket.claim.at = at;
  if (ticket.claim.activeAt) ticket.claim.activeAt = at;
  if (ticket.claim.verification) ticket.claim.verification.startedAt = at;
  for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
    if (comment.by === ticket.claim.by) comment.at = at;
  }
  ticket.updatedAt = at;
  persist(ticket);
  return ticket;
}

test('a claim far past any wall-clock TTL still commits, submits, and checkpoints', () => {
  const ticket = addRouted('terge regression');
  const by = 'long-running-executor';
  claimRouted(ticket, by);
  backdateClaim(ticket.ref, 10 * 24 * HOUR);

  // Closeout-adjacent paths that used to consult the clock.
  const checkpoint = store.checkpointTicket(slug, ticket.ref, by, { commit: COMMIT, verify: 'node --test: 16/16 matrix cases' });
  assert.strictEqual(checkpoint.ok, true, 'a checkpoint is proof of life, never something a timer refuses');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 2;\n');
  const committed = runCli(['commit', ticket.ref, '--by', by, '--message', 'scoped work from a very long run']);
  assert.strictEqual(committed.status, 0, committed.stderr + committed.stdout);

  const head = git(['rev-parse', 'HEAD']);
  const submitted = store.submitTicket(slug, ticket.ref, by, { commit: head, verify: 'npm run test:full' });
  assert.strictEqual(submitted.ok, true, 'an executor must always be able to hand in work it actually did');
  assert.strictEqual(store.getTicket(slug, ticket.ref).submission.commit, head.toLowerCase());
});

test('a long claim does not let a second executor take the ticket', () => {
  const ticket = addRouted('double claim guard');
  const prepared = claimRouted(ticket, 'first-executor');
  backdateClaim(ticket.ref, 6 * HOUR);
  store.addComment(slug, ticket.ref, { by: 'first-executor', kind: 'comment', body: 'Still working: verification is running.', source: 'mcp' });

  const stranger = store.claimTicket(slug, ticket.ref, 'second-executor', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.reason, 'claimed');
  assert.strictEqual(store.getTicket(slug, ticket.ref).claim.by, 'first-executor');
  assert.strictEqual(store.readyTickets(slug).some((entry?: any) => entry.ref === ticket.ref), false, 'live work never returns to the ready pool');
});

test('a quiet long-running executor and an executor between turns survive the sweep', () => {
  const quiet = addRouted('quiet but alive');
  claimRouted(quiet, 'quiet-executor');
  backdateClaim(quiet.ref, 20 * HOUR);
  store.addComment(slug, quiet.ref, { by: 'quiet-executor', kind: 'comment', body: 'Checkpoint: 573 lines rewritten, verification next.', source: 'mcp' });

  const stopped = addRouted('observed stop');
  const session = 'session-observed-stop';
  const prepared = claimRouted(stopped, 'stopped-executor', { sessionId: session });
  const marked = store.markDispatchStopped(session, prepared.ticket.dispatchExecutor, null, null);
  assert.strictEqual(marked.ok, true);
  const betweenTurns = store.getTicket(slug, stopped.ref);
  assert.strictEqual(betweenTurns.claim.by, 'stopped-executor');
  assert.strictEqual(betweenTurns.dispatch.outcome, 'claimed');
  assert.ok(betweenTurns.dispatch.turnEndedAt);
  assert.strictEqual(store.readDispatchBriefing(slug, stopped.ref, prepared.token).ok, true);

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.deepStrictEqual(swept.released, []);

  assert.strictEqual(store.getTicket(slug, quiet.ref).claim.by, 'quiet-executor', 'activity, not age, is what the backstop reads');
  assert.strictEqual(store.getTicket(slug, stopped.ref).claim.by, 'stopped-executor');
});

test('an executor between turns can still submit with its prepared dispatch', () => {
  const ticket = addRouted('submit after turn end');
  const session = 'session-submit-after-turn-end';
  const prepared = claimRouted(ticket, 'between-turns-executor', { sessionId: session });
  assert.equal(store.markDispatchStopped(session, prepared.ticket.dispatchExecutor, null, null).ok, true);

  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = "submitted after turn end";\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'submit after turn end fixture']);
  const submitted = store.submitTicket(slug, ticket.ref, 'between-turns-executor', {
    commit: git(['rev-parse', 'HEAD']),
  });
  assert.equal(submitted.ok, true);
});

test('an active verification marker is alive until a terminal Agent failure is recorded', () => {
  const ticket = addRouted('verification is still running');
  const session = 'session-verifying';
  const prepared = claimRouted(ticket, 'verifying-executor', { sessionId: session });
  store.addComment(slug, ticket.ref, {
    by: 'verifying-executor',
    body: '[sidequest:verify-start] npm run e2e',
    source: 'mcp',
  });

  backdateClaim(ticket.ref, 2 * HOUR);
  const verifyingPulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(verifyingPulse.liveness, 'alive');
  assert.equal(verifyingPulse.claim.verifying, true);
  assert.equal(verifyingPulse.claim.reclaimable, null);
  assert.ok(verifyingPulse.claim.lastBoardActivityAt);
  const protectedSweep = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(protectedSweep.released.some((entry?: any) => entry.ref === ticket.ref), false);

  const stoppedDuringVerify = store.markDispatchStopped(session, prepared.ticket.dispatchExecutor, null, null);
  assert.equal(stoppedDuringVerify.ok, true);
  assert.equal(stoppedDuringVerify.stopped, false);
  const betweenTurnsPulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(betweenTurnsPulse.liveness, 'alive');
  assert.equal(betweenTurnsPulse.claim.reclaimable, null);

  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: session,
    taskName: prepared.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  }).ok, true);
  const stopped = store.getTicket(slug, ticket.ref);
  assert.equal(stopped.status, 'todo');
  assert.equal(stopped.claim, null);
  assert.equal(stopped.dispatchNonce, null);
  assert.equal(stopped.dispatch.outcome, 'died');
});


test('the claim sweep releases a dead executor with a pending scope request', () => {
  const ticket = addRouted('dead executor scope request');
  claimRouted(ticket, 'dead-scope-worker', { sessionId: 'session-dead-scope' });
  assert.equal(store.requestScope(slug, ticket.ref, 'dead-scope-worker', ['lib/dead-scope.js']).ok, true);
  const dead = store.getTicket(slug, ticket.ref);
  dead.dispatch.outcome = 'died';
  dead.dispatch.terminalAt = new Date().toISOString();
  persist(dead);

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === ticket.ref), true);
});


test('a terminal dispatch immediately releases its exact claim for a fresh dispatch', () => {
  const ticket = addRouted('terminal claim release');
  const sessionId = 'terminal-claim-release-session';
  const prepared = claimRouted(ticket, 'terminated-executor', { sessionId });
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    taskName: prepared.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  }).ok, true);

  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.status, 'todo');
  assert.equal(released.claim, null);
  assert.equal(released.dispatchNonce, null);
  assert.equal(released.dispatch.outcome, 'died');
  const fresh = store.prepareDispatch(slug, ticket.ref);
  assert.equal(store.claimTicket(slug, ticket.ref, 'replacement-executor', {
    token: fresh.token,
    executor: fresh.ticket.dispatchExecutor,
  }).ok, true);
});

test('terminal evidence keeps partial, stale, and mismatched runtime bindings live', () => {
  const ticket = addRouted('terminal runtime identity guard');
  const sessionId = 'terminal-runtime-identity-session';
  const prepared = claimRouted(ticket, 'identity-guard-executor', { sessionId });
  const base = {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    taskName: prepared.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  };
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, { ...base, taskName: undefined }).reason, 'runtime_mismatch');
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, { ...base, sessionId: 'stale-session' }).reason, 'runtime_mismatch');
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, { ...base, taskName: 'other-native-task' }).reason, 'runtime_mismatch');
  const protectedTicket = store.getTicket(slug, ticket.ref);
  assert.equal(protectedTicket.status, 'doing');
  assert.equal(protectedTicket.claim.by, 'identity-guard-executor');
  assert.equal(protectedTicket.dispatch.terminalAt, null);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, base).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).claim, null);
});

test('a non-terminal dispatch still refuses a forced direct takeover', () => {
  const ticket = addRouted('live claim remains protected');
  claimRouted(ticket, 'live-executor');
  const takeover = store.claimTicket(slug, ticket.ref, 'orchestrator', {
    direct: true,
    force: true,
    reason: 'The orchestrator is attempting the terminal-only forced takeover regression check.',
  });
  assert.equal(takeover.ok, false);
  assert.equal(takeover.reason, 'direct_conflict');
  assert.equal(store.getTicket(slug, ticket.ref).claim.by, 'live-executor');
});


test('a shared-tree write dispatch refuses an empty verification completion unless it declares a no-op', () => {
  const ticket = store.createTicket(slug, {
    title: 'shared-tree completion tree check',
    description: 'Where: shared-tree completion fixture. Contract: reject a completion claim with no scoped diff. Verify: inspect the refusal.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: 'session-tree-check' });
  assert.equal(store.claimTicket(slug, ticket.ref, 'tree-check-executor', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
    sessionId: 'session-tree-check',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'tree-check-executor',
    body: '[sidequest:verify-start] npm run test:full',
    source: 'mcp',
  }).ok, true);

  const refused = store.addComment(slug, ticket.ref, {
    by: 'tree-check-executor',
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'empty_declared_scope');
  assert.match(refused.message, /lib\/fixture\.js/);
  assert.match(refused.message, /empty diff since dispatch base/);

  const submitRefused = store.submitTicket(slug, ticket.ref, 'tree-check-executor', { commit: COMMIT });
  assert.equal(submitRefused.ok, false);
  assert.equal(submitRefused.reason, 'empty_declared_scope');

  const evidenceMarkers = [
    '[sidequest:verify-complete] could_not_run: shell unavailable before editing.',
    '[sidequest:verify-complete] failed: focused regression failed before editing.',
  ];
  for (const body of evidenceMarkers) {
    const recorded = store.addComment(slug, ticket.ref, {
      by: 'tree-check-executor',
      body,
      source: 'mcp',
    });
    assert.equal(recorded.ok, true, body);
    assert.equal(recorded.comment.body, body);
  }
  assert.equal(store.claimMaySubmit(store.getTicket(slug, ticket.ref)), false);

  const wrongAuthor = store.addComment(slug, ticket.ref, {
    by: 'another-executor',
    body: '[sidequest:verify-complete] could_not_run: a different executor cannot clear this guard.',
    source: 'mcp',
  });
  assert.equal(wrongAuthor.ok, false);
  assert.equal(wrongAuthor.reason, 'empty_declared_scope');

  const unclaimed = store.createTicket(slug, {
    title: 'unclaimed failure evidence guard',
    description: 'Where: completion fixture. Contract: require a valid claim before accepting pre-edit failure evidence. Verify: inspect the refusal.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  store.prepareDispatch(slug, unclaimed.ref, { sharedTree: true, sessionId: 'session-unclaimed-failure-evidence' });
  const unclaimedRefusal = store.addComment(slug, unclaimed.ref, {
    by: 'unclaimed-executor',
    body: '[sidequest:verify-complete] failed: no claim exists.',
    source: 'mcp',
  });
  assert.equal(unclaimedRefusal.ok, false);
  assert.equal(unclaimedRefusal.reason, 'empty_declared_scope');

  const noOp = store.addComment(slug, ticket.ref, {
    by: 'tree-check-executor',
    body: '[sidequest:verify-complete] no-op',
    source: 'mcp',
  });
  assert.equal(noOp.ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).claim.verification, undefined);

  const doneRefused = store.completeTicket(slug, ticket.ref, 'tree-check-executor', { body: 'No repository change.' });
  assert.equal(doneRefused.ok, false);
  assert.equal(doneRefused.reason, 'submission_required');
  assert.equal(store.completeTicket(slug, ticket.ref, 'tree-check-executor', {
    body: 'No repository change.',
    cleanDeclaredScope: true,
  }).ok, true);
});

test('verification completions accept statuses, evidence, and the legacy bare marker', () => {
  const completions = [
    '[sidequest:verify-complete] passed: 885 tests, 884 passed, 1 skipped, 0 failed (92.7s).',
    '[sidequest:verify-complete] failed-suite Focused check passed: node --test fixture.test.js (21/21).',
    '[sidequest:verify-complete] failed_suite: named suite failed.',
    '[sidequest:verify-complete] toolchain_missing: required executable missing.',
    '[sidequest:verify-complete] could_not_run: shell unavailable.',
    '[sidequest:verify-complete] timeout: retained partial output.',
    '[sidequest:verify-complete] manual: checked the rendered artifact.',
    '[sidequest:verify-complete] attestation: dashboard provisioned.',
    '[sidequest:verify-complete] skipped: waived documentation link check.',
    '[sidequest:verify-complete] failed_check: schema contract missing a field.',
    '[sidequest:verify-complete] failed: focused suite failed after 21 passing tests.',
    '[sidequest:verify-complete] pytest: 1720 passed, 25 skipped, 3 deselected, exit 0.',
    '[sidequest:verify-complete]',
  ];
  for (const [index, body] of completions.entries()) {
    const by = `completion-evidence-${index}`;
    const ticket = addWriteRouted(`completion evidence ${index}`);
    claimRouted(ticket, by);
    fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), `module.exports = ${100 + index};\n`);
    assert.equal(store.addComment(slug, ticket.ref, {
      by,
      body: '[sidequest:verify-start] node --test test/fixture.test.js',
      source: 'mcp',
    }).ok, true);
    assert.equal(store.addComment(slug, ticket.ref, { by, body, source: 'mcp' }).ok, true, body);
    assert.equal(store.getTicket(slug, ticket.ref).claim.verification, undefined, body);
    git(['checkout', '--', 'lib/fixture.js']);
  }
});

test('a released no-op dispatch closes after its isolated worktree disappears', () => {
  const ticket = addWriteRouted('durable no-op release');
  const agentId = 'no-op-release-agent';
  const worktree = worktrees.agentWorktreePath(PROJECT_DIR, agentId);
  claimRouted(ticket, 'no-op-release-executor');
  git(['worktree', 'add', '--detach', worktree]);
  const claimed = store.getTicket(slug, ticket.ref);
  claimed.dispatch.sharedTree = false;
  claimed.dispatch.agentId = agentId;
  claimed.dispatch.worktree = worktrees.canonicalPath(worktree);
  claimed.dispatch.worktreeBindingSource = 'worktree-create';
  persist(claimed);
  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'no-op-release-executor',
    body: '[sidequest:verify-start] npm run test:full',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'no-op-release-executor',
    body: '[sidequest:verify-complete] no-op: focused regression passed 1/1, 0 failed, 0 skipped.',
    source: 'mcp',
  }).ok, true);
  const verified = store.getTicket(slug, ticket.ref);
  assert.equal(verified.claim.noOp.by, 'no-op-release-executor');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'no-op-release-executor', { status: 'todo', source: 'mcp' }).ok, true);

  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.dispatch.noOpRelease.by, 'no-op-release-executor');
  git(['worktree', 'remove', '--force', worktree]);
  assert.equal(fs.existsSync(worktree), false);

  const completed = store.completeTicket(slug, ticket.ref, 'orchestrator', { body: 'The reported issue was already fixed.', source: 'mcp' });
  assert.equal(completed.ok, true, completed.message);
  assert.equal(completed.ticket.completion.purpose, 'no-op');
  assert.notEqual(completed.ticket.completion.purpose, 'grooming');
});

test('a changed release cannot use no-op provenance to bypass submission', () => {
  const ticket = addWriteRouted('changed release still needs submission');
  claimRouted(ticket, 'changed-release-executor');
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = "changed release";\n');
  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'changed-release-executor',
    body: '[sidequest:verify-start] npm run test:full',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'changed-release-executor',
    body: '[sidequest:verify-complete] no-op',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'changed-release-executor', { status: 'todo', source: 'mcp' }).ok, true);

  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.dispatch.noOpRelease, undefined);
  git(['checkout', '--', 'lib/fixture.js']);
  const refused = store.completeTicket(slug, ticket.ref, 'orchestrator', { body: 'Repository work was not submitted.', source: 'mcp' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'submission_required');
});

test('SQ-1328: a shared-tree read-only dispatch closes after a sibling commits in its scope', () => {
  const ticket = addRouted('read-only closeout beside sibling commit');
  claimRouted(ticket, 'read-only-sibling-worker', { sessionId: 'session-read-only-sibling' });

  fs.appendFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 2;\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'sibling executor change']);

  const completed = store.completeTicket(slug, ticket.ref, 'read-only-sibling-worker', {
    body: 'Read-only review completed without repository changes.',
  });
  assert.strictEqual(completed.ok, true, completed.message);
  assert.strictEqual(completed.ticket.status, 'done');
});

test('a mixed source and test diff needs a claim-holder negative control before completion', () => {
  const by = 'negative-control-executor';
  const ticket = addNegativeControlTicket('negative control is required', by);

  const missing = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'negative_control_required');
  assert.match(missing.message, /Revert the non-test changes, run the changed tests/);

  const submission = store.submitTicket(slug, ticket.ref, by, { commit: COMMIT });
  assert.equal(submission.ok, false);
  assert.equal(submission.reason, 'negative_control_required');

  const ticketWithForeignMarker = store.getTicket(slug, ticket.ref);
  ticketWithForeignMarker.comments.push({
    id: 'historical-negative-control-marker',
    by: 'another-executor',
    kind: 'comment',
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1',
    source: 'mcp',
    at: new Date().toISOString(),
  });
  persist(ticketWithForeignMarker);
  const wrongAuthor = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(wrongAuthor.reason, 'negative_control_required');
  assert.match(wrongAuthor.message, /negative control was recorded by "another-executor", but the current claim holder is "negative-control-executor"/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1',
    source: 'mcp',
  }).ok, true);
  const missingEvidence = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(missingEvidence.reason, 'negative_control_evidence_required');
  assert.match(missingEvidence.message, /must name the broken target and the assertion that failed/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target= ; assertion= ; npm run test:files test/fixture.test.js failed=1',
    source: 'mcp',
  }).ok, true);
  const blankEvidence = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(blankEvidence.reason, 'negative_control_evidence_required');

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=0',
    source: 'mcp',
  }).ok, true);
  const zeroFailures = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(zeroFailures.ok, false);
  assert.equal(zeroFailures.reason, 'negative_control_zero_failures');
  assert.match(zeroFailures.message, /tests passed against the pre-change code/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=import (the revert removed the imported symbol)',
    source: 'mcp',
  }).ok, true);
  const importError = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(importError.reason, 'negative_control_import_error');
  assert.match(importError.message, /recorded negative control failed with an ImportError/);
  assert.match(importError.message, /only an assertion failure proves they catch wrong behavior/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=collection',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).reason, 'negative_control_collection_error');

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] waived too short',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).reason, 'negative_control_waiver_too_short');

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control marker fixture']);
});

test('SQ-2731: the negative control declares its failure kind instead of being guessed from prose', () => {
  const by = 'negative-control-declared-kind-executor';
  const ticket = addNegativeControlTicket('negative control declares its failure kind', by);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=2',
    source: 'mcp',
  }).ok, true);
  const undeclared = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.reason, 'negative_control_failure_kind_required');
  assert.match(undeclared.message, /failure-kind=assertion, failure-kind=import, or failure-kind=collection/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=2 failure-kind=whatever',
    source: 'mcp',
  }).ok, true);
  const unknownKind = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(unknownKind.ok, false);
  assert.equal(unknownKind.reason, 'negative_control_failure_kind_required');

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=3 failure-kind=assertion\nNo ImportError and no collection error: the reverted source produced pure assertion failures.',
    source: 'mcp',
  }).ok, true);
  const truthfulProse = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(truthfulProse.ok, true, truthfulProse.message);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control declared failure kind fixture']);
});

test('SQ-2731: a declared assertion failure still owes a report for every changed test', () => {
  const by = 'negative-control-unmasked-report-executor';
  const ticket = addNegativeControlTicket('negative control reports changed tests despite error prose', by);
  const testName = 'the unmasked assertion catches the reverted source';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${testName}', () => {});\n`);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion\nNeither an ImportError nor a collection error was involved.',
    source: 'mcp',
  }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, new RegExp(testName));

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control unmasked per-test fixture']);
});

test('negative-control comments use the claim owner and skip identical markers', () => {
  const claimOwner = 'negative-control-comment-owner';
  const ticket = store.createTicket(slug, {
    title: 'negative-control comment ownership',
    description: 'Where: comment writer fixture. Contract: attribute an executor marker to the active claim. Verify: inspect persisted comments.',
    category: 'coding.normal',
    files: ['lib/fixture.js', 'test/fixture.test.js'],
    source: 'cli',
  });
  const prepared = claimRouted(ticket, claimOwner);
  const tokenFile = String(prepared.ticket.dispatch?.tokenFile || '');
  assert.ok(tokenFile);
  assert.equal(fs.existsSync(tokenFile), true);
  const marker = '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1';
  const { runCli: runExecutorComment } = makeCliRunner(BIN, {
    SIDEQUEST_HOME,
    CLAUDE_PROJECT_DIR: PROJECT_DIR,
    CLAUDE_SESSION_ID: 'ambient-orchestrator-session',
  }, { cwd: PROJECT_DIR });

  const first = runExecutorComment(['comment', ticket.ref, '--token-file', tokenFile, '--body', marker, '--json']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstMarkerComments = store.getTicket(slug, ticket.ref).comments.filter((comment?: any) => comment.body === marker);
  assert.equal(firstMarkerComments.length, 1);
  assert.equal(firstMarkerComments[0].by, claimOwner);

  const second = runExecutorComment(['comment', ticket.ref, '--token-file', tokenFile, '--body', marker, '--json']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).duplicate, true);
  assert.equal(store.getTicket(slug, ticket.ref).comments.filter((comment?: any) => comment.body === marker).length, 1);
});

test('negative-control markers accept context after failed counts', () => {
  const controls = [
    '[sidequest:negative-control] target=plugins/sidequest/src/lib/agentsync.ts:1; assertion=briefing contains the requested evidence; node --import tsx --test plugins/sidequest/test/agentsync.test.ts failed=1 failure-kind=assertion exit=1',
    '[sidequest:negative-control] target=python fixture behavior; assertion=fixture rejects the reverted behavior; uv run pytest failed=1. Restoring the source made it fail; 5 passed. failure-kind=assertion',
  ];
  for (const [index, body] of controls.entries()) {
    const by = `negative-control-context-${index}`;
    const ticket = addNegativeControlTicket('negative control allows trailing context', by);
    assert.equal(store.addComment(slug, ticket.ref, { by, body, source: 'mcp' }).ok, true);
    assert.equal(store.addComment(slug, ticket.ref, {
      by,
      body: '[sidequest:verify-complete]',
      source: 'mcp',
    }).ok, true);
    git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
    git(['commit', '-m', 'negative control trailing context fixture']);
  }
});

test('negative-control marker refusals quote malformed marker lines', () => {
  const by = 'negative-control-malformed-marker';
  const ticket = addNegativeControlTicket('negative control names malformed marker lines', by);
  const markerLine = '[sidequest:negative-control] npm run test failed=not-a-number';
  assert.equal(store.addComment(slug, ticket.ref, { by, body: markerLine, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_evidence_required');
  assert.match(refusal.message, new RegExp(markerLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(refusal.message, /it does not begin with target=/);
  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control malformed marker fixture']);
});

test('negative-control marker refusals bound an unbounded quoted marker line', () => {
  const by = 'negative-control-long-marker';
  const ticket = addNegativeControlTicket('negative control bounds a long marker line', by);
  const longMarker = `[sidequest:negative-control] ${'x'.repeat(400)} failed=1`;
  assert.equal(store.addComment(slug, ticket.ref, { by, body: longMarker, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_evidence_required');
  assert.match(refusal.message, new RegExp(longMarker.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(refusal.message, /more characters/);
  assert.ok(!refusal.message.includes(longMarker), 'a long marker line must not appear in full');
  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control long marker fixture']);
});

test('SQ-17: a target= value keeps its semicolons, and an unparsed marker names the field it stopped at', () => {
  const by = 'negative-control-semicolon-target';
  const ticket = addNegativeControlTicket('negative control target keeps its semicolons', by);
  const testName = 'a semicolon-joined target is read as one value';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${testName}', () => {});\n`);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `[sidequest:negative-control] target=lib/fixture.js:1;lib/other.js:2; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion\n[sidequest:negative-control-test] failed ${testName}`,
    source: 'mcp',
  }).ok, true);
  const accepted = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(accepted.ok, true, accepted.message);

  const unparsed = '[sidequest:negative-control] target=lib/fixture.js:1;lib/other.js:2 npm run test:files test/fixture.test.js failed=1 failure-kind=assertion';
  assert.equal(store.addComment(slug, ticket.ref, { by, body: unparsed, source: 'mcp' }).ok, true);
  const unparsedRefusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(unparsedRefusal.reason, 'negative_control_evidence_required');
  assert.match(unparsedRefusal.message, new RegExp(unparsed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(unparsedRefusal.message, /no "; assertion=" follows its target= value/);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control semicolon target fixture']);
});

test('SQ-17: a changed it.each table is attributed to its own test, not the preceding plain test', () => {
  const by = 'negative-control-each-table';
  const eachName = 'adds %s to the row';
  const unrelatedName = 'an unrelated baseline test';
  const baseline = `test('${unrelatedName}', () => {});\n\ntest.each([\n  ['a'],\n])('${eachName}', () => {});\n`;
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), baseline);
  git(['add', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control each-table baseline']);

  const ticket = addNegativeControlTicket('negative control reads an each table', by);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), baseline.replace("  ['a'],\n", "  ['a'],\n  ['b'],\n"));

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion',
    source: 'mcp',
  }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, new RegExp(eachName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(refusal.message, new RegExp(unrelatedName));

  // The runner substitutes %s with the row's actual value, so an agent reporting the
  // resolved name ("adds a to the row") must still match the table's placeholder name.
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control-test] failed adds a to the row',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control each-table fixture']);
});

test('SQ-17: a hunk inserted between tests does not demand the test that follows it', () => {
  const by = 'negative-control-inserted-hunk';
  const alphaName = 'alpha baseline assertion';
  const omegaName = 'omega baseline assertion';
  const insertedName = 'inserted middle assertion';
  const definition = 'test';
  const baseline = `${definition}('${alphaName}', () => {});\n\n${definition}('${omegaName}', () => {});\n`;
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), baseline);
  git(['add', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control inserted-hunk baseline']);

  const ticket = addNegativeControlTicket('negative control reads an inserted hunk', by);
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'test', 'fixture.test.js'),
    baseline.replace(`${definition}('${omegaName}`, `${definition}('${insertedName}', () => {});\n\n${definition}('${omegaName}`),
  );

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion\n[sidequest:negative-control-test] failed ${insertedName}\n[sidequest:negative-control-test] failed ${alphaName}`,
    source: 'mcp',
  }).ok, true);
  const accepted = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(accepted.ok, true, accepted.message);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control inserted-hunk fixture']);
});

test('negative controls account for every added named test', () => {
  const by = 'negative-control-per-test-executor';
  const ticket = addNegativeControlTicket('negative control names every changed test', by);
  const testName = 'a new assertion catches the reverted source';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${testName}', () => {});\n`);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion exit=1\n[sidequest:negative-control-test] failed a different test',
    source: 'mcp',
  }).ok, true);
  const missingTest = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(missingTest.reason, 'negative_control_test_required');
  assert.match(missingTest.message, new RegExp(testName));

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion trailing context\n[sidequest:negative-control-test] failed ${testName}`,
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control per test fixture']);
});

test('negative controls decode escaped source test names', () => {
  const by = 'negative-control-escaped-name-executor';
  const ticket = addNegativeControlTicket('negative control decodes escaped test names', by);
  const testNames = [
    "the reviewer's prose",
    'a "quoted" test name',
    'a `backticked` test name',
    'a \\ backslash test name',
  ];
  const testInvocation = 'test';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), [
    `${testInvocation}('the reviewer\\'s prose', () => {});`,
    `${testInvocation}("a \\"quoted\\" test name", () => {});`,
    `${testInvocation}(` + '`a \\`backticked\\` test name`, () => {});',
    `${testInvocation}('a \\\\ backslash test name', () => {});`,
  ].join('\n'));

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=4 failure-kind=assertion\n${testNames.map((testName) => `[sidequest:negative-control-test] failed ${testName}`).join('\n')}`,
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control escaped names fixture']);
});

test('negative controls skip template source test names with substitutions', () => {
  const by = 'negative-control-template-name-executor';
  const ticket = addNegativeControlTicket('negative control skips template test names with substitutions', by);
  const testInvocation = 'test';
  const templateName = '`renders ${label} in the header`';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `const label = "header";\n${testInvocation}(${templateName}, () => {});\n`);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control template names fixture']);
});

test('negative controls account for tests in added files', () => {
  const by = 'negative-control-added-file-executor';
  const testName = 'a test in a newly added file catches the revert';
  const ticket = store.createTicket(slug, {
    title: 'negative control checks added test files',
    description: 'Where: negative-control fixture. Contract: account for added test files. Verify: inspect the refusal.',
    category: 'coding.normal',
    files: ['lib/fixture.js', 'test/added-fixture.test.js'],
    source: 'cli',
  });
  claimRouted(ticket, by);
  negativeControlVersion += 1;
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), `module.exports = ${negativeControlVersion};\n`);
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'added-fixture.test.js'), `test('${testName}', () => {});\n`);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] target=lib/fixture.js:1; assertion=added fixture catches the changed value; npm run test:files test/added-fixture.test.js failed=1 failure-kind=assertion',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).reason, 'negative_control_test_required');

  git(['add', 'lib/fixture.js', 'test/added-fixture.test.js']);
  git(['commit', '-m', 'negative control added test file fixture']);
});

test('negative controls allow a plainly identified unaffected test', () => {
  const by = 'negative-control-unaffected-test-executor';
  const ticket = addNegativeControlTicket('negative control identifies unaffected tests', by);
  const testName = 'a new unrelated assertion remains green';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${testName}', () => {});\n`);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: `[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/fixture.test.js failed=1 failure-kind=assertion\n[sidequest:negative-control-test] unaffected ${testName} because it verifies an independent formatter`,
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control unaffected test fixture']);
});

test('a valid negative-control waiver accepts a mixed source and test diff', () => {
  const by = 'negative-control-waiver-executor';
  const ticket = addNegativeControlTicket('negative control waiver', by);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] waived This platform cannot safely run the reverted fixture in this environment.\nThe isolated runner has no compatible fallback.',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control waiver fixture']);
});

test('a source-only scoped diff still completes without a negative control', () => {
  const ticket = store.createTicket(slug, {
    title: 'source-only completion',
    description: 'Where: source-only fixture. Contract: keep negative controls limited to test changes. Verify: inspect completion.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  const by = 'source-only-executor';
  claimRouted(ticket, by);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-start] npm run test:files test/fixture.test.js',
    source: 'mcp',
  }).ok, true);
  negativeControlVersion += 1;
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), `module.exports = ${negativeControlVersion};\n`);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] failed-suite',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).claim.verification, undefined);

  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'source-only negative control fixture']);
});

test('a verification marker still releases after the unobserved-death backstop', () => {
  const ticket = addRouted('verification marker after a crash');
  const session = 'session-verifying-crash';
  claimRouted(ticket, 'crashed-verifier', { sessionId: session });
  store.addComment(slug, ticket.ref, {
    by: 'crashed-verifier',
    body: '[sidequest:verify-start] npm run e2e',
    source: 'mcp',
  });
  backdateClaim(ticket.ref, 25 * HOUR);

  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.claim.reclaimable, 'abandoned_verifying');
  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === ticket.ref), true);
});

test('a closeout after an auto-release names the exact recovery instead of silently failing', async () => {
  const ticket = addRouted('fail loud after auto-release');
  const session = 'session-fail-loud';
  const prepared = claimRouted(ticket, 'stranded-executor', { sessionId: session });
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: session,
    taskName: prepared.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  }).ok, true);
  store.sweepStaleClaims({ project: slug, source: 'test' });

  const submitted = store.submitTicket(slug, ticket.ref, 'stranded-executor', { commit: COMMIT });
  assert.strictEqual(submitted.ok, false);
  assert.strictEqual(submitted.reason, 'not_claimed');
  assert.match(submitted.message, /auto-released/);
  assert.match(submitted.message, new RegExp(`sidequest dispatch ${ticket.ref}`));
  assert.match(submitted.message, /commits are safe/i);

  const closed = store.completeTicket(slug, ticket.ref, 'stranded-executor', { body: 'done' });
  assert.strictEqual(closed.ok, false);
  assert.strictEqual(closed.reason, 'claim_released');
  assert.match(closed.message, new RegExp(`sidequest dispatch ${ticket.ref}`));

  const committed = runCli(['commit', ticket.ref, '--by', 'stranded-executor', '--message', 'after the sweep']);
  assert.notStrictEqual(committed.status, 0);
  assert.match(committed.stderr + committed.stdout, /auto-released/);
});

test('the sweep refuses to release a shared-tree claim while the checkout is dirty', () => {
  const ticket = addRouted('dirty shared checkout release guard');
  const sessionId = 'session-dirty-shared-tree';
  const agentId = 'dirty-shared-tree-agent';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-shared-tree-executor', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId,
  }).ok, true);
  const fixturePath = path.join(PROJECT_DIR, 'lib', 'fixture.js');
  const originalFixture = fs.readFileSync(fixturePath, 'utf8');
  fs.writeFileSync(fixturePath, `${originalFixture}module.exports.dirty = true;\n`);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    taskName: agentId,
    agentId,
    agentName: agentId,
    error: 'Prompt is too long',
  }).ok, true);

  const blockedSweep = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(blockedSweep.released.some((entry?: any) => entry.ref === ticket.ref), false);
  assert.deepStrictEqual(
    blockedSweep.blocked.find((entry?: any) => entry.ref === ticket.ref),
    {
      project: slug,
      ref: ticket.ref,
      kind: 'dirty_shared_tree',
      paths: ['lib/fixture.js'],
      preExistingPaths: [],
      newlyChangedPaths: ['lib/fixture.js'],
    },
  );
  assert.equal(store.getTicket(slug, ticket.ref).claim.by, 'dirty-shared-tree-executor');

  fs.writeFileSync(fixturePath, originalFixture);
  const cleanSweep = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(cleanSweep.released.some((entry?: any) => entry.ref === ticket.ref && entry.kind === 'observed_stop'), true);
});

// SQ-2862: a removed checkout used to free the claim on the spot. A native agent is a
// loop inside its session process and holds no directory, so `git worktree remove --force`
// succeeds under a working executor while its runtime keeps writing — the absence proves
// nothing, and a replacement used to claim the ticket out from under it.
test('a checkout removed under a live claim does not free it, an attested death still does, and a silent bound dispatch reaches the abandon backstop', () => {
  const removed = addRouted('checkout removed under a live claim');
  const removedSession = 'session-removed-checkout';
  const removedAgent = 'removed-checkout-agent';
  const removedPrepared = store.prepareDispatch(slug, removed.ref, { sharedTree: false, sessionId: removedSession });
  assert.equal(store.recordDispatchLaunch(slug, removed.ref, {
    token: removedPrepared.token, executor: removedPrepared.ticket.dispatchExecutor, sessionId: removedSession, agentName: removedAgent,
  }).ok, true);
  const removedWorktree = worktrees.agentWorktreePath(PROJECT_DIR, removedAgent);
  git(['worktree', 'add', '--detach', removedWorktree]);
  assert.equal(store.bindDispatchWorktreeCreation(slug, removedSession, removedWorktree).ok, true);
  assert.equal(store.bindDispatchAgent(removedSession, removedPrepared.ticket.dispatchExecutor, removedAgent, removedAgent).ok, true);
  assert.equal(store.claimTicket(slug, removed.ref, 'live-isolated-executor', {
    token: removedPrepared.token, executor: removedPrepared.ticket.dispatchExecutor, sessionId: removedSession,
  }).ok, true);
  const removedDispatch = store.getTicket(slug, removed.ref).dispatch;
  assert.equal(removedDispatch.terminalAt, null);
  git(['worktree', 'remove', '--force', removedDispatch.worktree]);
  assert.equal(fs.existsSync(removedDispatch.worktree), false, 'the checkout is genuinely gone');
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, removed.ref)), null, 'a gone checkout is not evidence its executor stopped');
  assert.equal(store.pulsePayload(slug, removed.ref).liveness, 'unknown');
  assert.equal(store.sweepStaleClaims({ project: slug, source: 'test' }).released.some((entry?: any) => entry.ref === removed.ref), false, 'the sweep leaves the live claim held');
  assert.equal(store.getTicket(slug, removed.ref).claim.by, 'live-isolated-executor');

  // The authority that does free it, with the checkout just as gone: a durable terminal
  // record for that exact runtime.
  assert.equal(store.recordDispatchAgentFailure(slug, removed.ref, {
    token: removedPrepared.token,
    executor: removedPrepared.ticket.dispatchExecutor,
    sessionId: removedSession,
    taskName: removedAgent,
    agentId: removedAgent,
    agentName: removedAgent,
    error: 'Prompt is too long',
  }).ok, true);
  assert.equal(store.getTicket(slug, removed.ref).dispatch.outcome, 'died');
  assert.equal(store.getTicket(slug, removed.ref).claim, null, 'an attested death still recovers the ticket at once');

  const live = addRouted('quiet live isolated dispatch');
  const liveSession = 'session-quiet-isolated';
  const liveAgent = 'quiet-isolated-agent';
  const livePrepared = store.prepareDispatch(slug, live.ref, { sharedTree: false, sessionId: liveSession });
  assert.equal(store.recordDispatchLaunch(slug, live.ref, {
    token: livePrepared.token, executor: livePrepared.ticket.dispatchExecutor, sessionId: liveSession, agentName: liveAgent,
  }).ok, true);
  const liveWorktree = worktrees.agentWorktreePath(PROJECT_DIR, liveAgent);
  assert.equal(store.bindDispatchWorktreeCreation(slug, liveSession, liveWorktree).ok, true);
  assert.equal(store.bindDispatchAgent(liveSession, livePrepared.ticket.dispatchExecutor, liveAgent, liveAgent).ok, true);
  assert.equal(store.claimTicket(slug, live.ref, 'quiet-isolated-executor', {
    token: livePrepared.token, executor: livePrepared.ticket.dispatchExecutor, sessionId: liveSession,
  }).ok, true);
  const liveDispatch = store.getTicket(slug, live.ref).dispatch;
  fs.mkdirSync(liveDispatch.worktree, { recursive: true });
  backdateClaim(live.ref, 31 * 24 * HOUR);
  const livePulse = store.pulsePayload(slug, live.ref);
  assert.equal(livePulse.liveness, 'dead');
  assert.equal(livePulse.claim.reclaimable, 'abandoned');

  // A session-end assertion for that same session frees nothing; the backstop is what recovers it.
  assert.deepEqual(store.reconcileSession(liveSession, { reason: 'session ended', source: 'session-end' }).released, []);
  assert.equal(store.getTicket(slug, live.ref).claim.by, 'quiet-isolated-executor');

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === live.ref && entry.kind === 'abandoned'), true);
  assert.equal(store.getTicket(slug, live.ref).claim, null);
  fs.rmSync(liveDispatch.worktree, { recursive: true, force: true });
});


test('an unobserved death still frees the ticket, and a fresh claim clears the release record', () => {
  const ticket = store.createTicket(slug, {
    title: 'unobserved death backstop', complexity: 2, complexityWhy: 'fixture for an inactive claim that no hook observed',
    labels: ['direct-ok'], files: ['lib/fixture.js'], source: 'cli',
  });
  assert.equal(store.claimTicket(slug, ticket.ref, 'vanished-executor', { direct: true, reason: 'The unobserved-death fixture uses an inactive direct claim.' }).ok, true);
  backdateClaim(ticket.ref, 30 * 24 * HOUR);

  const verdict = store.claimReleaseVerdict(store.getTicket(slug, ticket.ref));
  assert.strictEqual(verdict.kind, 'idle', 'nothing reported the stop, so the inactive-claim backstop may free it');

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.ok(swept.released.some((entry?: any) => entry.ref === ticket.ref));
  const released = store.getTicket(slug, ticket.ref);
  assert.strictEqual(released.status, 'todo');
  assert.match(released.comments.at(-1).body, /no board activity from/);

  const reclaimed = store.claimTicket(slug, ticket.ref, 'replacement-executor', {
    direct: true,
    reason: 'The replacement fixture uses a direct claim after the inactive one releases.',
  });
  assert.strictEqual(reclaimed.ok, true);
  assert.strictEqual(store.getTicket(slug, ticket.ref).claimRelease, null);
});

test('the idle backstop only applies when no executor is associated', () => {
  const hand = store.createTicket(slug, {
    title: 'hand claim goes idle',
    complexity: 2,
    complexityWhy: 'fixture for the idle backstop, no implementation work',
    labels: ['direct-ok'],
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  assert.strictEqual(store.claimTicket(slug, hand.ref, 'human', { direct: true, reason: 'A hand claim needs no executor association.' }).ok, true);
  backdateClaim(hand.ref, 2 * HOUR);
  assert.strictEqual(store.claimReleaseVerdict(store.getTicket(slug, hand.ref)).kind, 'idle');

  const routed = addRouted('routed executor outlives the idle window');
  const sessionId = 'session-bound-idle-window';
  const agentId = 'bound-idle-window-agent';
  const prepared = store.prepareDispatch(slug, routed.ref, { sharedTree: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, routed.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(slug, routed.ref, 'patient-executor', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId,
  }).ok, true);
  backdateClaim(routed.ref, 2 * HOUR);
  assert.strictEqual(store.claimReleaseVerdict(store.getTicket(slug, routed.ref)), null, 'a bound executor is not idle just because it is quiet');
});

test('a launched unbound dispatch can be superseded with observed evidence, but a freshly bound or claimed dispatch cannot', () => {
  const ticket = addRouted('supersedable unclaimed launch');
  const first = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: 'session-supersedable-launch' });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: first.token, executor: first.ticket.dispatchExecutor, sessionId: 'session-supersedable-launch', agentName: 'supersedable-launch-agent',
  }).ok, true);
  assert.match(store.pulsePayload(slug, ticket.ref).livenessEvidence, /without a bound runtime identity, claim, or checkpoint/);
  const replacement = store.prepareDispatch(slug, ticket.ref, {
    sharedTree: true,
    sessionId: 'session-supersedable-replacement',
    recoveryEvidence: 'The executor reported a token claim refusal and exited before binding.',
  });
  assert.notEqual(replacement.token, first.token);
  assert.equal(replacement.ticket.dispatch.attempts.at(-1).failureShape, 'unclaimed_launch_superseded');
  assert.equal(replacement.ticket.dispatch.attempts.at(-1).recoveryEvidence, 'The executor reported a token claim refusal and exited before binding.');

  const bound = addRouted('bound launch stays protected');
  const boundPrepared = store.prepareDispatch(slug, bound.ref, { sharedTree: true, sessionId: 'session-bound-protected' });
  assert.equal(store.recordDispatchLaunch(slug, bound.ref, {
    token: boundPrepared.token, executor: boundPrepared.ticket.dispatchExecutor, sessionId: 'session-bound-protected', agentName: 'bound-protected-agent',
  }).ok, true);
  assert.equal(store.bindDispatchAgent('session-bound-protected', boundPrepared.ticket.dispatchExecutor, 'bound-protected-agent', 'bound-protected-agent').ok, true);
  assert.throws(() => store.prepareDispatch(slug, bound.ref, { sharedTree: true, recoveryEvidence: 'The executor reported a refusal.' }), /cannot be superseded/);

  const claimed = addRouted('claimed launch stays protected');
  const claimedPrepared = store.prepareDispatch(slug, claimed.ref, { sharedTree: true, sessionId: 'session-claimed-protected' });
  assert.equal(store.recordDispatchLaunch(slug, claimed.ref, {
    token: claimedPrepared.token, executor: claimedPrepared.ticket.dispatchExecutor, sessionId: 'session-claimed-protected', agentName: 'claimed-protected-agent',
  }).ok, true);
  assert.equal(store.claimTicket(slug, claimed.ref, 'claimed-protected-executor', {
    token: claimedPrepared.token, executor: claimedPrepared.ticket.dispatchExecutor, sessionId: 'session-claimed-protected',
  }).ok, true);
  assert.throws(() => store.prepareDispatch(slug, claimed.ref, { sharedTree: true, recoveryEvidence: 'The executor reported a refusal.' }), /cannot be superseded/);
});

// SQ-2206: a bound attempt that never claimed had no exit but its own stop hook, so a runtime that died
// without firing it stranded the ticket for good: redispatch refused it as live, evidence refused it as bound,
// and session-start reconciliation skips bound attempts on purpose.
test('SQ-2206: a bound launch that never claimed becomes retirable on evidence past the idle backstop', () => {
  const ticket = addRouted('stranded bound launch');
  const sessionId = 'session-stranded-bound';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: 'stranded-bound-agent',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'stranded-bound-id', 'stranded-bound-agent').ok, true);

  const evidence = 'The native task for this launch completed without ever claiming, observed by the orchestrator.';
  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: `${sessionId}-early`, recoveryEvidence: evidence }),
    /bound to a runtime .* ago and still unclaimed, which becomes retirable on evidence in .* unless its terminal hook fires first/,
    'inside the backstop a live executor stays protected, and the refusal says how long is left',
  );

  const originalIdleMinutes = process.env.SIDEQUEST_CLAIM_IDLE_MIN;
  process.env.SIDEQUEST_CLAIM_IDLE_MIN = '0.000001';
  try {
    const replacement = store.prepareDispatch(slug, ticket.ref, {
      sharedTree: true,
      sessionId: `${sessionId}-replacement`,
      recoveryEvidence: evidence,
    });
    const retired = replacement.ticket.dispatch.attempts.at(-1);
    assert.equal(retired.failureShape, 'stranded_bound_launch_superseded');
    assert.equal(retired.recoveryEvidence, evidence);
    assert.ok(retired.boundAt, 'the retired attempt is preserved as the bound one it was');
    assert.notEqual(replacement.token, prepared.token);
  } finally {
    if (originalIdleMinutes === undefined) delete process.env.SIDEQUEST_CLAIM_IDLE_MIN;
    else process.env.SIDEQUEST_CLAIM_IDLE_MIN = originalIdleMinutes;
  }
});

test('retireOnly retires an expired bound-unclaimed attempt without a replacement and preserves recovery guards', () => {
  const evidence = 'The dispatch remained bound and unclaimed beyond the backstop.';
  const expired = addRouted('retire only expired bound attempt');
  const expiredSessionId = 'retire-only-expired-session';
  const expiredPrepared = store.prepareDispatch(slug, expired.ref, { sharedTree: true, sessionId: expiredSessionId });
  assert.equal(store.recordDispatchLaunch(slug, expired.ref, {
    token: expiredPrepared.token, executor: expiredPrepared.ticket.dispatchExecutor, sessionId: expiredSessionId, agentName: 'retire-only-expired-agent',
  }).ok, true);
  assert.equal(store.bindDispatchAgent('wrong-retire-only-session', expiredPrepared.ticket.dispatchExecutor, 'retire-only-expired-agent', 'retire-only-expired-agent').reason, 'not_found', 'a different session cannot bind the attempt');
  assert.equal(store.bindDispatchAgent(expiredSessionId, expiredPrepared.ticket.dispatchExecutor, 'retire-only-expired-agent', 'retire-only-expired-agent').ok, true);
  const expiredState = store.getTicket(slug, expired.ref);
  expiredState.dispatch.boundAt = new Date(Date.now() - 2 * HOUR).toISOString();
  persist(expiredState);

  assert.doesNotThrow(
    () => store.prepareDispatch(slug, expired.ref, { retireOnly: true, recoveryEvidence: evidence }),
    'an expired bound-unclaimed attempt is eligible for retireOnly',
  );
  const retired = store.getTicket(slug, expired.ref);
  assert.equal(retired.dispatchNonce, null, 'retireOnly does not prepare a replacement token');
  assert.equal(retired.dispatch.attempts.at(-1).failureShape, 'stranded_bound_launch_superseded');
  assert.equal(retired.dispatch.attempts.at(-1).recoveryEvidence, evidence);

  const young = addRouted('retire only young bound attempt');
  const youngPrepared = store.prepareDispatch(slug, young.ref, { sharedTree: true, sessionId: 'retire-only-young-session' });
  assert.equal(store.recordDispatchLaunch(slug, young.ref, {
    token: youngPrepared.token, executor: youngPrepared.ticket.dispatchExecutor, sessionId: 'retire-only-young-session', agentName: 'retire-only-young-agent',
  }).ok, true);
  assert.equal(store.bindDispatchAgent('retire-only-young-session', youngPrepared.ticket.dispatchExecutor, 'retire-only-young-agent', 'retire-only-young-agent').ok, true);
  assert.throws(
    () => store.prepareDispatch(slug, young.ref, { retireOnly: true, recoveryEvidence: evidence }),
    /bound to a runtime .* ago and still unclaimed, which becomes retirable on evidence in/,
    'a live bound attempt stays protected during the backstop',
  );

  const claimed = addRouted('retire only claimed attempt');
  const claimedPrepared = store.prepareDispatch(slug, claimed.ref, { sharedTree: true, sessionId: 'retire-only-claimed-session' });
  assert.equal(store.recordDispatchLaunch(slug, claimed.ref, {
    token: claimedPrepared.token, executor: claimedPrepared.ticket.dispatchExecutor, sessionId: 'retire-only-claimed-session', agentName: 'retire-only-claimed-agent',
  }).ok, true);
  assert.equal(store.claimTicket(slug, claimed.ref, 'retire-only-claimed-executor', {
    token: claimedPrepared.token, executor: claimedPrepared.ticket.dispatchExecutor, sessionId: 'retire-only-claimed-session',
  }).ok, true);
  assert.throws(
    () => store.prepareDispatch(slug, claimed.ref, { retireOnly: true, recoveryEvidence: evidence }),
    /claimed by retire-only-claimed-executor/,
    'a claimed attempt stays protected',
  );
});

test('SQ-2136: a prepared dispatch that never launched is retirable on evidence, and the refusal names the real blocker', () => {
  const ticket = addRouted('prepared unbound retirement');
  const first = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: 'session-prepared-unbound' });
  const prepared = store.getTicket(slug, ticket.ref).dispatch;
  assert.equal(prepared.outcome, 'prepared');
  assert.equal(prepared.launchedAt, null);
  assert.equal(prepared.boundAt, null);

  const evidence = 'Pulse showed prepared with no launch, runtime identity, claim, or checkpoint, and the spawn was cancelled before it ran.';
  const replacement = store.prepareDispatch(slug, ticket.ref, {
    sharedTree: true,
    sessionId: 'session-prepared-unbound-replacement',
    recoveryEvidence: evidence,
  });
  const retired = replacement.ticket.dispatch.attempts.at(-1);
  assert.equal(replacement.ticket.dispatch.attempts.length, 1, 'evidence retires exactly one attempt');
  assert.equal(retired.outcome, 'failed');
  assert.equal(retired.failureShape, 'unclaimed_launch_superseded');
  assert.equal(retired.recoveryEvidence, evidence);
  assert.equal(retired.launchedAt, null, 'the retired attempt is preserved as the unlaunched one it was');
  assert.notEqual(replacement.token, first.token);
  assert.equal(replacement.ticket.dispatch.outcome, 'prepared');
  assert.equal(replacement.ticket.dispatch.terminalAt, null);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'todo');

  // The refusal used to assert four states that did not hold, which is how a prepared-unbound ticket read as
  // permanently trapped: the orchestrator was told to wait for a runtime that had never existed.
  const untouched = addRouted('never dispatched retirement');
  assert.throws(
    () => store.prepareDispatch(slug, untouched.ref, { sharedTree: true, recoveryEvidence: evidence }),
    /cannot be superseded on recovery evidence because its dispatch is not an active attempt/,
  );

  const claimed = addRouted('claimed retirement stays protected');
  const claimedPrepared = store.prepareDispatch(slug, claimed.ref, { sharedTree: true, sessionId: 'session-prepared-unbound-claimed' });
  assert.equal(store.claimTicket(slug, claimed.ref, 'prepared-unbound-executor', {
    token: claimedPrepared.token, executor: claimedPrepared.ticket.dispatchExecutor, sessionId: 'session-prepared-unbound-claimed',
  }).ok, true);
  assert.throws(
    () => store.prepareDispatch(slug, claimed.ref, { sharedTree: true, recoveryEvidence: evidence }),
    /cannot be superseded on recovery evidence because its dispatch is claimed by prepared-unbound-executor/,
  );

  assert.equal(store.releaseTicket(slug, ticket.ref, 'foreign-executor', { status: 'todo', source: 'test' }).reason, 'unclaimed_active_dispatch');
});

test('an unbound claimed dispatch reports a binding fault and stays claimed without death evidence', () => {
  const ticket = addRouted('unbound dispatch claim');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: 'session-unbound-dispatch' });
  assert.equal(store.claimTicket(slug, ticket.ref, 'unbound-executor', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: 'session-unbound-dispatch',
  }).ok, true);

  const claimed = store.getTicket(slug, ticket.ref);
  assert.equal(claimed.dispatch.agentId, undefined);
  assert.equal(claimed.dispatch.agentName, undefined);
  assert.equal(claimed.dispatch.boundAt, null);
  let pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'binding_fault');
  assert.match(pulse.livenessEvidence, /dispatch\.boundAt is null/);

  backdateClaim(ticket.ref, 2 * HOUR);
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, ticket.ref)), null);
  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === ticket.ref), false);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'binding_fault');
  assert.equal(pulse.claim.reclaimable, null);
  assert.equal(store.getTicket(slug, ticket.ref).claim.by, 'unbound-executor');
});

// SQ-2868: `dead` is what sends an orchestrator looking for recovery evidence to retire an attempt,
// so pulse answering it from a died record that belongs to some OTHER attempt aims that at a live
// executor. Both shapes below reported dead over a working runtime, and only the claim guard refused
// to free the ticket. The third case is why the fix cannot just report everything alive.
test('a died record only reports dead for the attempt that is actually being asked about', () => {
  const superseded = addRouted('historical died attempt');
  const firstSession = 'session-historical-death-first';
  const first = claimRouted(superseded, 'sq2868-first-executor', { sessionId: firstSession });
  assert.equal(store.recordDispatchAgentFailure(slug, superseded.ref, {
    token: first.token,
    executor: first.ticket.dispatchExecutor,
    sessionId: firstSession,
    taskName: first.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  }).ok, true);
  assert.equal(store.getTicket(slug, superseded.ref).dispatch.attempts.at(-1).outcome, 'died');

  const secondSession = 'session-historical-death-second';
  const second = store.prepareDispatch(slug, superseded.ref, { sharedTree: true, sessionId: secondSession });
  const secondAgent = second.ticket.dispatch.launchName;
  assert.equal(store.recordDispatchLaunch(slug, superseded.ref, {
    token: second.token, executor: second.ticket.dispatchExecutor, sessionId: secondSession, agentName: secondAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(secondSession, second.ticket.dispatchExecutor, secondAgent, secondAgent).ok, true);
  assert.equal(store.claimTicket(slug, superseded.ref, 'sq2868-replacement-executor', {
    token: second.token, executor: second.ticket.dispatchExecutor, sessionId: secondSession,
  }).ok, true);

  const freshPulse = store.pulsePayload(slug, superseded.ref);
  assert.equal(freshPulse.died, null, 'a died attempt the live dispatch superseded is not this attempt’s death');
  assert.equal(freshPulse.liveness, 'unknown');
  assert.match(freshPulse.livenessEvidence, /no process heartbeat/);
  assert.equal(store.getTicket(slug, superseded.ref).claim.by, 'sq2868-replacement-executor');

  // The second shape: the terminal record is the current dispatch's own, but it predates the claim
  // now holding the ticket, so it is about the launch that died rather than the runtime working now.
  const reclaimed = addRouted('died record predates the claim');
  const staleSession = 'session-stale-death';
  const stale = claimRouted(reclaimed, 'sq2868-stopped-executor', { sessionId: staleSession });
  assert.equal(store.recordDispatchAgentFailure(slug, reclaimed.ref, {
    token: stale.token,
    executor: stale.ticket.dispatchExecutor,
    sessionId: staleSession,
    taskName: stale.ticket.dispatch.launchName,
    error: 'Prompt is too long',
  }).ok, true);
  const freed = store.getTicket(slug, reclaimed.ref);
  assert.equal(freed.claim, null);
  freed.labels = ['direct-ok'];
  persist(freed);
  assert.equal(store.claimTicket(slug, reclaimed.ref, 'sq2868-direct-executor', {
    direct: true, reason: 'A direct claim picks the ticket up after the previous launch died.',
  }).ok, true);

  // Pinned rather than live: a same-millisecond claim reads as the death's own, which is correct but
  // is not this case, and the position of this test in the run must not decide which case it is.
  const directState = store.getTicket(slug, reclaimed.ref);
  for (const record of [directState.dispatch, ...(directState.dispatch.attempts ?? [])]) {
    if (record.terminalAt) record.terminalAt = secondsAgo(2);
  }
  directState.claim.at = secondsAgo(1);
  directState.claim.activeAt = directState.claim.at;
  persist(directState);
  const directPulse = store.pulsePayload(slug, reclaimed.ref);
  assert.equal(directPulse.died, null, 'a death recorded before this claim says nothing about the runtime holding it');
  assert.notEqual(directPulse.liveness, 'dead');
  assert.equal(store.getTicket(slug, reclaimed.ref).claim.by, 'sq2868-direct-executor');

  // Negative case: the attempt holding the claim genuinely died, and that still frees the ticket.
  const gone = addRouted('genuinely dead current attempt');
  const dyingSession = 'session-genuine-death';
  const dyingPrepared = store.prepareDispatch(slug, gone.ref, { sharedTree: true, sessionId: dyingSession });
  const dyingClaim = store.claimTicket(slug, gone.ref, 'sq2868-dying-executor', {
    token: dyingPrepared.token, executor: dyingPrepared.ticket.dispatchExecutor, sessionId: dyingSession,
  });
  assert.equal(dyingClaim.ok, true, JSON.stringify(dyingClaim));
  const dying = store.getTicket(slug, gone.ref);
  dying.dispatch.outcome = 'died';
  dying.dispatch.terminalAt = new Date().toISOString();
  dying.dispatch.terminalSource = 'test-stop-hook';
  persist(dying);

  const deadPulse = store.pulsePayload(slug, gone.ref);
  assert.equal(deadPulse.liveness, 'dead');
  assert.equal(deadPulse.died.source, 'test-stop-hook');
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, gone.ref)).kind, 'observed_stop');
});

test('the died-record predicate keys on attempt identity and record age, not on presence', () => {
  const { diedRecordAttestsAttempt } = require('../lib/store/pulse.js');
  const dispatch = { preparedAt: '2026-09-01T10:00:00.000Z', tokenPrefix: 'aaaa-bbbb-cc' };
  const claim = { at: '2026-09-01T10:05:00.000Z' };
  const ownRecord = (fields?: any) => Object.assign({}, dispatch, { outcome: 'died', terminalSource: 'stop-hook' }, fields);
  const rows = [
    ['its own death after the claim', ownRecord({ terminalAt: '2026-09-01T10:06:00.000Z' }), claim, true],
    ['its own death at the claim instant', ownRecord({ terminalAt: claim.at }), claim, true],
    ['its own death with no claim to outlive', ownRecord({ terminalAt: '2026-09-01T10:01:00.000Z' }), null, true],
    ['its own death before the claim', ownRecord({ terminalAt: '2026-09-01T10:04:59.999Z' }), claim, false],
    // The reclaim authority (claims.observedStop) rejects a stop the claim outlived; pulse must agree (SQ-2917).
    ['its own death, then the claim resumed activity', ownRecord({ terminalAt: '2026-09-01T10:06:00.000Z' }), { at: claim.at, activeAt: '2026-09-01T10:07:00.000Z' }, false],
    // touchClaimActivity resumes a dispatch on same-instant activity, so the stop cannot attest it.
    ['its own death at the instant of the last activity', ownRecord({ terminalAt: '2026-09-01T10:06:00.000Z' }), { at: claim.at, activeAt: '2026-09-01T10:06:00.000Z' }, false],
    ['its own death after the last activity', ownRecord({ terminalAt: '2026-09-01T10:06:00.001Z' }), { at: claim.at, activeAt: '2026-09-01T10:06:00.000Z' }, true],
    ['its own death under a clock that stepped back one millisecond', ownRecord({ terminalAt: '2026-09-01T10:04:59.999Z' }), { at: claim.at, activeAt: claim.at }, false],
    ['a superseded attempt that died after the claim', ownRecord({
      preparedAt: '2026-09-01T09:00:00.000Z', tokenPrefix: 'zzzz-yyyy-xx', terminalAt: '2026-09-01T10:06:00.000Z',
    }), claim, false],
    ['a non-died terminal record', ownRecord({ outcome: 'failed', terminalAt: '2026-09-01T10:06:00.000Z' }), claim, false],
    ['a died record with no terminal time', ownRecord({ terminalAt: null }), claim, false],
  ];
  for (const [label, record, claimRow, expected] of rows) {
    assert.equal(diedRecordAttestsAttempt(dispatch, record, claimRow), expected, label as string);
  }
});

// The store-level twin of the resumed-activity row: a stop hook fires, then the same runtime writes to
// the board again. The sweep treats the claim as alive (touchClaimActivity resumed the dispatch), so
// pulse reporting dead here would aim recovery at a runtime the sweep refuses to free.
test('a died record the claim outlived does not read as dead once the runtime resumed activity', () => {
  const ticket = addRouted('resumed after a stop hook');
  const session = 'session-resumed-after-stop';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: session });
  assert.equal(store.claimTicket(slug, ticket.ref, 'sq2917-resumed-executor', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: session,
  }).ok, true);
  const stopped = store.getTicket(slug, ticket.ref);
  stopped.claim.at = secondsAgo(3);
  stopped.claim.activeAt = secondsAgo(1);
  stopped.dispatch.outcome = 'died';
  stopped.dispatch.terminalAt = secondsAgo(2);
  stopped.dispatch.terminalSource = 'test-stop-hook';
  persist(stopped);

  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.died, null);
  assert.notEqual(pulse.liveness, 'dead');
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, ticket.ref)), null, 'the sweep sees a live claim, and pulse agrees');
});

// SQ-2918: the claim holder writes to the board at the same millisecond its stop was recorded.
// touchClaimActivity resumes the dispatch, but the retained attempt keeps the stop with the current
// identity, so pulse used to find it and report dead while the sweep held the claim.
test('activity at the same instant as the stop resumes the dispatch and pulse does not read the retained stop as dead', () => {
  const ticket = addRouted('same-instant resume');
  const session = 'session-same-instant-resume';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: session });
  const holder = 'sq2918-same-instant-executor';
  assert.equal(store.claimTicket(slug, ticket.ref, holder, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: session,
  }).ok, true);
  const stopped = store.getTicket(slug, ticket.ref);
  stopped.claim.at = secondsAgo(2);
  stopped.claim.activeAt = stopped.claim.at;
  stopped.dispatch.outcome = 'died';
  stopped.dispatch.terminalAt = secondsAgo(1);
  stopped.dispatch.terminalSource = 'test-stop-hook';
  persist(stopped);
  assert.equal(store.pulsePayload(slug, ticket.ref).liveness, 'dead', 'before the activity the stop is the attempt’s own');

  const commented = store.addComment(slug, ticket.ref, { by: holder, body: 'still here' });
  assert.equal(commented.ok, true, JSON.stringify(commented));
  const resumed = store.getTicket(slug, ticket.ref);
  assert.equal(resumed.dispatch.outcome, 'claimed');
  assert.equal(resumed.dispatch.terminalAt, undefined);
  assert.equal(resumed.claim.activeAt, commented.comment.at);
  // addComment stamps its own clock, so the same-instant stop is written into the retained attempt
  // afterwards: the shape touchClaimActivity leaves behind when the stop hook and the comment share
  // a millisecond.
  resumed.dispatch.attempts = [...(resumed.dispatch.attempts ?? []), {
    preparedAt: resumed.dispatch.preparedAt, tokenPrefix: resumed.dispatch.tokenPrefix,
    outcome: 'died', terminalAt: commented.comment.at, terminalSource: 'test-stop-hook',
  }];
  persist(resumed);
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.died, null);
  assert.notEqual(pulse.liveness, 'dead');
  assert.equal(store.claimReleaseVerdict(resumed), null);
});
