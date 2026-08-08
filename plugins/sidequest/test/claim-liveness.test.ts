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


test('a terminal dispatch lets the orchestrator take over and submit the existing claim', () => {
  const ticket = addRouted('terminal claim takeover');
  const prepared = claimRouted(ticket, 'terminated-executor');
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    error: 'Prompt is too long',
  }).ok, true);

  const requiresForce = store.claimTicket(slug, ticket.ref, 'orchestrator', {
    direct: true,
    reason: 'The executor has a recorded terminal dispatch outcome and cannot submit its verified commit.',
  });
  assert.equal(requiresForce.ok, false);
  assert.equal(requiresForce.reason, 'terminal_claim_takeover_required');

  const takeover = store.claimTicket(slug, ticket.ref, 'orchestrator', {
    direct: true,
    force: true,
    reason: 'The executor has a recorded terminal dispatch outcome and cannot submit its verified commit.',
  });
  assert.equal(takeover.ok, true);
  const claimed = store.getTicket(slug, ticket.ref);
  assert.equal(claimed.claim.by, 'orchestrator');
  assert.deepEqual(claimed.claimTakeover, {
    by: 'orchestrator',
    at: claimed.claim.at,
    previousBy: 'terminated-executor',
    evidence: {
      outcome: 'died',
      terminalAt: claimed.claimTakeover.evidence.terminalAt,
      terminalSource: 'agent-terminal-failure',
    },
  });

  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = "terminal takeover fixture";\n');
  git(['add', 'lib/fixture.js']);
  git(['commit', '-m', 'terminal takeover fixture']);
  const submitted = store.submitTicket(slug, ticket.ref, 'orchestrator', { commit: git(['rev-parse', 'HEAD']) });
  assert.equal(submitted.ok, true);
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

  assert.equal(store.addComment(slug, ticket.ref, {
    by: 'another-executor',
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1',
    source: 'mcp',
  }).ok, true);
  const wrongAuthor = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(wrongAuthor.reason, 'negative_control_required');
  assert.match(wrongAuthor.message, /negative control was recorded by "another-executor", but the current claim holder is "negative-control-executor"/);

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
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1 (expected ImportError after reverting non-test changes)',
    source: 'mcp',
  }).ok, true);
  const importError = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete]',
    source: 'mcp',
  });
  assert.equal(importError.reason, 'negative_control_import_error');
  assert.match(importError.message, /Only an assertion failure in the changed tests proves they catch wrong behavior/);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1 collection error after reverting non-test changes',
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

test('negative-control markers accept context after failed counts', () => {
  const controls = [
    '[sidequest:negative-control] node --import tsx --test plugins/sidequest/test/agentsync.test.ts failed=1 exit=1',
    '[sidequest:negative-control] uv run pytest failed=1. Restoring the source made it fail; 5 passed.',
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
  assert.equal(refusal.reason, 'negative_control_required');
  assert.match(refusal.message, new RegExp(markerLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(refusal.message, /number was not where it was expected/);
  git(['add', 'lib/fixture.js', 'test/fixture.test.js']);
  git(['commit', '-m', 'negative control malformed marker fixture']);
});

test('negative controls account for every added named test', () => {
  const by = 'negative-control-per-test-executor';
  const ticket = addNegativeControlTicket('negative control names every changed test', by);
  const testName = 'a new assertion catches the reverted source';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `test('${testName}', () => {});\n`);

  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1 exit=1\n[sidequest:negative-control-test] failed a different test',
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
    body: `[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1 trailing context\n[sidequest:negative-control-test] failed ${testName}`,
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
    body: '[sidequest:negative-control] npm run test:files test/added-fixture.test.js failed=1',
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
    body: `[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1\n[sidequest:negative-control-test] unaffected ${testName} because it verifies an independent formatter`,
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
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    error: 'Prompt is too long',
  }).ok, true);

  const fixturePath = path.join(PROJECT_DIR, 'lib', 'fixture.js');
  const originalFixture = fs.readFileSync(fixturePath, 'utf8');
  fs.writeFileSync(fixturePath, `${originalFixture}module.exports.dirty = true;\n`);
  const blockedSweep = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(blockedSweep.released.some((entry?: any) => entry.ref === ticket.ref), false);
  assert.deepStrictEqual(
    blockedSweep.blocked.find((entry?: any) => entry.ref === ticket.ref),
    { project: slug, ref: ticket.ref, kind: 'dirty_shared_tree', paths: ['lib/fixture.js'] },
  );
  assert.equal(store.getTicket(slug, ticket.ref).claim.by, 'dirty-shared-tree-executor');

  fs.writeFileSync(fixturePath, originalFixture);
  const cleanSweep = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(cleanSweep.released.some((entry?: any) => entry.ref === ticket.ref && entry.kind === 'observed_stop'), true);
});

test('a missing isolated worktree is death evidence without a terminal dispatch stamp', () => {
  const missing = addRouted('missing worktree without observed stop');
  const missingSession = 'session-missing-worktree';
  const missingAgent = 'missing-worktree-agent';
  const missingPrepared = store.prepareDispatch(slug, missing.ref, { sharedTree: false, sessionId: missingSession });
  assert.equal(store.recordDispatchLaunch(slug, missing.ref, {
    token: missingPrepared.token, executor: missingPrepared.ticket.dispatchExecutor, sessionId: missingSession, agentName: missingAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(missingSession, missingPrepared.ticket.dispatchExecutor, missingAgent, missingAgent).ok, true);
  assert.equal(store.claimTicket(slug, missing.ref, 'missing-isolated-executor', {
    token: missingPrepared.token, executor: missingPrepared.ticket.dispatchExecutor, sessionId: missingSession,
  }).ok, true);
  const missingDispatch = store.getTicket(slug, missing.ref).dispatch;
  assert.equal(missingDispatch.terminalAt, null);
  assert.equal(fs.existsSync(missingDispatch.worktree), false);
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, missing.ref)).kind, 'missing_worktree');
  assert.equal(store.pulsePayload(slug, missing.ref).liveness, 'dead');

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
  const liveDispatch = store.getTicket(slug, live.ref).dispatch;
  fs.mkdirSync(liveDispatch.worktree, { recursive: true });
  backdateClaim(live.ref, 31 * 24 * HOUR);
  const livePulse = store.pulsePayload(slug, live.ref);
  assert.equal(livePulse.liveness, 'unknown');
  assert.equal(livePulse.claim.reclaimable, null);

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  assert.equal(swept.released.some((entry?: any) => entry.ref === missing.ref && entry.kind === 'missing_worktree'), true);
  assert.equal(store.getTicket(slug, live.ref).claim.by, 'quiet-isolated-executor');
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
