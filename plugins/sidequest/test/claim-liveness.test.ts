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
fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 1;\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'main']);

const { slug } = store.ensureProject(PROJECT_DIR);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
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

test('a quiet long-running executor survives the sweep; an observed stop does not', () => {
  const quiet = addRouted('quiet but alive');
  claimRouted(quiet, 'quiet-executor');
  backdateClaim(quiet.ref, 20 * HOUR);
  store.addComment(slug, quiet.ref, { by: 'quiet-executor', kind: 'comment', body: 'Checkpoint: 573 lines rewritten, verification next.', source: 'mcp' });

  const stopped = addRouted('observed stop');
  const session = 'session-observed-stop';
  const prepared = claimRouted(stopped, 'stopped-executor', { sessionId: session });
  const marked = store.markDispatchStopped(session, prepared.ticket.dispatchExecutor, null, null);
  assert.strictEqual(marked.ok, true);
  assert.strictEqual(store.getTicket(slug, stopped.ref).claim.by, 'stopped-executor', 'the stop hook leaves the claim for the sweep to audit');

  const swept = store.sweepStaleClaims({ project: slug, source: 'test' });
  const refs = swept.released.map((entry?: any) => entry.ref);
  assert.deepStrictEqual(refs, [stopped.ref]);
  assert.strictEqual(swept.released[0].kind, 'observed_stop');

  assert.strictEqual(store.getTicket(slug, quiet.ref).claim.by, 'quiet-executor', 'activity, not age, is what the backstop reads');
  const after = store.getTicket(slug, stopped.ref);
  assert.strictEqual(after.status, 'todo');
  assert.strictEqual(after.claim, null);
  assert.strictEqual(after.claimRelease.kind, 'observed_stop');

  const note = after.comments.at(-1).body;
  assert.match(note, /observed to stop while holding the claim/);
  assert.doesNotMatch(note, /TTL/i, 'the released comment must name the real reason');
});

test('a closeout after an auto-release names the exact recovery instead of silently failing', async () => {
  const ticket = addRouted('fail loud after auto-release');
  const session = 'session-fail-loud';
  const prepared = claimRouted(ticket, 'stranded-executor', { sessionId: session });
  store.markDispatchStopped(session, prepared.ticket.dispatchExecutor, null, null);
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
  assert.equal(store.markDispatchStopped(stoppedSession, stoppedPrepared.ticket.dispatchExecutor, stoppedAgent, stoppedAgent).ok, true);
  const stoppedPulse = store.pulsePayload(slug, stopped.ref);
  assert.equal(stoppedPulse.working, false);
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
  assert.equal(livePulse.working, true);
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
