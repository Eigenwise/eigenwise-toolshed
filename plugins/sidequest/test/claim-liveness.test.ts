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
const db = require('../lib/db.js');
const { makeCliRunner } = require('./_helpers.js');

function git(args?: any) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}
git(['init']);
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

function claimRouted(ticket?: any, by?: any, opts?: any) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, ...(opts || {}) });
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
    sessionId: (opts && opts.sessionId) || undefined,
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
  const scope = store.requestScope(slug, ticket.ref, by, ['lib/extra.js']);
  assert.strictEqual(scope.ok, true);
  store.updateTicket(slug, ticket.ref, { files: ['lib/fixture.js', 'lib/extra.js'] });
  backdateClaim(ticket.ref, 10 * 24 * HOUR);

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
    error: 'Prompt is too long',
  }).ok, true);
  const stoppedPulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(stoppedPulse.liveness, 'dead');
  assert.equal(stoppedPulse.died.source, 'agent-terminal-failure');
  assert.equal(stoppedPulse.claim.reclaimable, 'observed_stop');
  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === ticket.ref), true);
});

test('a pending scope request reports waiting before and after the executor stops', () => {
  const ticket = addRouted('scope request is waiting');
  const sessionId = 'session-scope-waiting';
  const prepared = claimRouted(ticket, 'scope-waiting-executor', { sessionId });
  assert.equal(store.requestScope(slug, ticket.ref, 'scope-waiting-executor', ['lib/extra.js']).ok, true);

  let pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'waiting');
  assert.match(pulse.livenessEvidence, /scope request pending/);
  assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, null, null).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'waiting');
  assert.equal(pulse.died, null);
  assert.equal(pulse.dispatch.outcome, 'claimed');
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

test('a pending scope request preserves committed work and permits a checkpoint', () => {
  const ticket = store.createTicket(slug, {
    title: 'scope request release guard',
    description: 'Where: scope-release fixture. Contract: a scope timeout holds verified work. Verify: inspect release and checkpoint outcomes.',
    category: 'codebase-exploration',
    files: ['lib/release-guard.js'],
    source: 'cli',
  });
  claimRouted(ticket, 'scope-release-guard-worker', { sessionId: 'session-scope-release-guard' });
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'release-guard.js'), 'module.exports = true;\n');
  git(['add', 'lib/release-guard.js']);
  git(['commit', '-m', 'scope release guard fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  assert.equal(store.requestScope(slug, ticket.ref, 'scope-release-guard-worker', ['foreign/release-guard.js']).ok, true);

  const refused = store.releaseTicket(slug, ticket.ref, 'scope-release-guard-worker', { status: 'todo' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'scope_work_pending');
  assert.equal(refused.commit, commit);
  assert.match(refused.message, new RegExp(commit));
  assert.match(refused.message, /Checkpoint and hold/);

  const checkpoint = store.checkpointTicket(slug, ticket.ref, 'scope-release-guard-worker', {
    commit,
    verify: 'node --test test/claim-liveness.test.js',
  });
  assert.equal(checkpoint.ok, true);

  const noWork = addRouted('scope request with no work');
  claimRouted(noWork, 'scope-no-work-worker', { sessionId: 'session-scope-no-work' });
  assert.equal(store.requestScope(slug, noWork.ref, 'scope-no-work-worker', ['foreign/no-work.js']).ok, true);
  assert.equal(store.releaseTicket(slug, noWork.ref, 'scope-no-work-worker', { status: 'todo' }).ok, true);
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

  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'another-executor',
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1',
    source: 'mcp',
  }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).reason, 'negative_control_required');

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=0',
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
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1',
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

test('a valid negative-control waiver accepts a mixed source and test diff', () => {
  const by = 'negative-control-waiver-executor';
  const ticket = addNegativeControlTicket('negative control waiver', by);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] waived This platform cannot safely run the reverted fixture in this environment.',
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
  negativeControlVersion += 1;
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), `module.exports = ${negativeControlVersion};\n`);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  }).ok, true);

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

test('a missing isolated worktree after stop is reclaimable while a live quiet dispatch remains protected', () => {
  const stopped = addRouted('missing worktree after stop');
  const stoppedSession = 'session-missing-worktree';
  const stoppedAgent = 'missing-worktree-agent';
  const stoppedPrepared = store.prepareDispatch(slug, stopped.ref, { sharedTree: false, sessionId: stoppedSession });
  assert.equal(store.recordDispatchLaunch(slug, stopped.ref, {
    token: stoppedPrepared.token, executor: stoppedPrepared.ticket.dispatchExecutor, sessionId: stoppedSession, agentName: stoppedAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(stoppedSession, stoppedPrepared.ticket.dispatchExecutor, stoppedAgent, stoppedAgent).ok, true);
  assert.equal(store.claimTicket(slug, stopped.ref, 'stopped-isolated-executor', {
    token: stoppedPrepared.token, executor: stoppedPrepared.ticket.dispatchExecutor, sessionId: stoppedSession,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, stopped.ref, {
    token: stoppedPrepared.token,
    executor: stoppedPrepared.ticket.dispatchExecutor,
    error: 'Prompt is too long',
  }).ok, true);
  const stoppedPulse = store.pulsePayload(slug, stopped.ref);
  assert.equal(stoppedPulse.liveness, 'dead');
  assert.equal(stoppedPulse.claim.reclaimable, 'observed_stop');

  const live = addRouted('quiet live isolated dispatch');
  const liveSession = 'session-quiet-isolated';
  const liveAgent = 'quiet-isolated-agent';
  const livePrepared = store.prepareDispatch(slug, live.ref, { sharedTree: false, sessionId: liveSession });
  assert.equal(store.recordDispatchLaunch(slug, live.ref, {
    token: livePrepared.token, executor: livePrepared.ticket.dispatchExecutor, sessionId: liveSession, agentName: liveAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(liveSession, livePrepared.ticket.dispatchExecutor, liveAgent, liveAgent).ok, true);
  assert.equal(store.claimTicket(slug, live.ref, 'quiet-isolated-executor', {
    token: livePrepared.token, executor: livePrepared.ticket.dispatchExecutor, sessionId: liveSession,
  }).ok, true);
  backdateClaim(live.ref, 31 * 24 * HOUR);
  const livePulse = store.pulsePayload(slug, live.ref);
  assert.equal(livePulse.liveness, 'unknown');
  assert.equal(livePulse.claim.reclaimable, null);
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
  claimRouted(routed, 'patient-executor');
  backdateClaim(routed.ref, 2 * HOUR);
  assert.strictEqual(store.claimReleaseVerdict(store.getTicket(slug, routed.ref)), null, 'a live executor is not idle just because it is quiet');
});

test('an unbound isolated dispatch can still file a scope request', () => {
  const ticket = store.createTicket(slug, {
    title: 'scope request without a bound worktree',
    description: 'Where: scope fixture. Contract: a scope request is board state and never needs the worktree. Verify: inspect the recorded request.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  const by = 'unbound-scope-executor';
  claimRouted(ticket, by, { sharedTree: false });
  assert.strictEqual(store.getTicket(slug, ticket.ref).dispatch.worktree, undefined, 'the fixture dispatch must be unbound');

  const requested = store.requestScope(slug, ticket.ref, by, ['lib/wanted.js']);
  assert.strictEqual(requested.ok, true, `scope request must not fail on a missing worktree: ${requested.reason || ''}`);
  assert.deepStrictEqual(store.getTicket(slug, ticket.ref).scopeRequest.files, ['lib/wanted.js']);
});

test('a control-plane files update resolves a pending scope request partially and syncs the dispatch record', () => {
  const ticket = store.createTicket(slug, {
    title: 'partial scope resolution',
    description: 'Where: scope fixture. Contract: a scope edit rules on the pending request and the dispatch snapshot follows it. Verify: inspect files, request, and declaredFiles.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  const by = 'partial-scope-executor';
  claimRouted(ticket, by, { sharedTree: false });

  assert.strictEqual(store.requestScope(slug, ticket.ref, by, ['lib/wanted.js', 'lib/phantom.js']).ok, true);
  const updated = store.updateTicket(slug, ticket.ref, { files: ['lib/fixture.js', 'lib/wanted.js'], by: 'orchestrator' });
  assert.deepStrictEqual(updated.files, ['lib/fixture.js', 'lib/wanted.js']);
  assert.strictEqual(updated.scopeRequest, null, 'the request is resolved, not left pending');
  assert.deepStrictEqual(updated.dispatch.declaredFiles, updated.files, 'commit enforcement follows the ruling');
  const resolution = updated.comments.at(-1).body;
  assert.match(resolution, /granted lib\/wanted\.js/);
  assert.match(resolution, /not granted: lib\/phantom\.js/);

  const refiled = store.requestScope(slug, ticket.ref, by, ['lib/wanted.js']);
  assert.strictEqual(refiled.ok, true, 'a granted path re-requested reports covered instead of dead-ending');
  assert.strictEqual(refiled.scopeRequest, null);
});

test('a scope denial states the scope in force and syncs the dispatch record', () => {
  const ticket = store.createTicket(slug, {
    title: 'scope denial stays truthful',
    description: 'Where: scope fixture. Contract: a denial names the live scope and leaves no stale dispatch snapshot. Verify: inspect the denial comment and declaredFiles.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
  const by = 'denied-scope-executor';
  claimRouted(ticket, by, { sharedTree: false });

  assert.strictEqual(store.requestScope(slug, ticket.ref, by, ['lib/refused.js']).ok, true);
  const denied = store.denyScopeRequest(slug, ticket.ref, 'orchestrator', 'The requested path belongs to another live ticket.');
  assert.strictEqual(denied.ok, true);
  assert.match(denied.comment.body, /Declared scope is now: lib\/fixture\.js/);
  assert.doesNotMatch(denied.comment.body, /remains unchanged/);
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.scopeRequest, null);
  assert.deepStrictEqual(after.dispatch.declaredFiles, ['lib/fixture.js']);
});
