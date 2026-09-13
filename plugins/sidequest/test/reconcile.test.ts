import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * Tests for the session worker registry + reconcileSession (SQ-153, SQ-2862).
 *
 * The registry once let a SessionEnd hook release a session's claims IMMEDIATELY,
 * instead of waiting out a backstop. It cannot: the SessionEnd payload carries no
 * generation, nonce or owning pid, two of its own reasons (`clear`, `resume`) fire
 * while the process keeps running, and the host offers no way to ask whether a
 * session id is live. So the assertion is replayable, and SQ-2859 replayed it
 * against a live executor claim and watched a replacement take the ticket while the
 * original runtime kept writing. These tests pin that a bare session id now only
 * forgets registrations: the claims stay held and the backstops do the recovering.
 *
 * Run: node --test plugins/sidequest/test/reconcile.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-reconcile-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const { slug } = store.ensureProject(path.join(os.tmpdir(), 'sq-reconcile-fixtures', 'board'));
const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function addTicket(title?: any) {
  return store.createTicket(slug, { title, complexity: 3, complexityWhy: 'fixture for reconcile tests, single mechanical change', labels: ['direct-ok'], source: 'cli' });
}

test('reconcileSession reports the ending session\'s claims as held, and releases nothing', () => {
  const a = addTicket('session A ticket');
  const b = addTicket('session B ticket');

  const ra = store.claimTicket(slug, a.ref, 'worker-a', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-A' });
  const rb = store.claimTicket(slug, b.ref, 'worker-b', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-B' });
  assert.strictEqual(ra.ok, true);
  assert.strictEqual(rb.ok, true);

  const res = store.reconcileSession('sess-A', { reason: 'session ended' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.released, [], 'a session id releases nothing');
  assert.deepStrictEqual(res.held, [a.ref], 'only A\'s claim is reported, and it is reported as still held');

  const at = store.getTicket(slug, a.ref);
  assert.strictEqual(at.status, 'doing', 'A\'s ticket stays in doing');
  assert.ok(at.claim && at.claim.by === 'worker-a', 'A\'s claim is intact');
  assert.strictEqual(store.getTicket(slug, b.ref).claim.by, 'worker-b', 'B\'s claim is untouched');
});

// The exact sequence SQ-2859 used to strand a live executor: claim a routed dispatch,
// then replay that session's SessionEnd while its runtime is still working.
test('a replayed SessionEnd for a session with live routed work releases nothing and records no death', () => {
  const ticket = store.createTicket(slug, {
    title: 'routed session end replay',
    description: 'Where: session reconcile fixture. Contract: keep a live routed claim through a replayed session end. Verify: inspect pulse.',
    category: 'coding.normal',
    files: ['lib/fixture.js'],
    source: 'test',
  });
  const sessionId = 'sess-routed-death';
  const agentName = 'routed-death-agent';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'routed-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  for (const attempt of [1, 2]) {
    const reconciled = store.reconcileSession(sessionId, { reason: 'session ended', source: 'session-end' });
    assert.deepStrictEqual(reconciled.released, [], `replay ${attempt} releases nothing`);
  }
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.claim.by, 'routed-worker', 'the live executor keeps its claim');
  assert.equal(stored.status, 'doing');
  assert.equal(stored.dispatch.outcome, 'claimed');
  assert.equal(stored.dispatch.terminalAt, null, 'no died record is minted from a bare session id');
  assert.equal(store.claimReleaseVerdict(stored), null);
  assert.equal(store.pulsePayload(slug, ticket.ref).liveness, 'unknown');
  assert.equal(store.sweepStaleClaims({ project: slug, source: 'test' }).released.some((entry?: any) => entry.ref === ticket.ref), false, 'and the sweep behind it leaves the claim alone');
});

test('a completed ticket is never reported as held, even if still registered', () => {
  const a = addTicket('finished before reconcile');
  store.claimTicket(slug, a.ref, 'worker-done', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-done' });
  // Finish WITHOUT passing the sessionId (simulates a done that forgot to thread
  // it) so the registry entry lingers — reconcile must still skip the done ticket.
  store.completeTicket(slug, a.ref, 'worker-done', { model: 'sonnet', effort: 'high' });
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done');

  const res = store.reconcileSession('sess-done', { reason: 'session ended' });
  assert.deepStrictEqual(res.held, [], 'a done ticket is not reported');
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done', 'still done');
});

test('reconcileSession forgets the registration — a second call reports nothing', () => {
  const a = addTicket('idempotency check');
  store.claimTicket(slug, a.ref, 'worker-i', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-idem' });
  const first = store.reconcileSession('sess-idem', { reason: 'ended' });
  assert.deepStrictEqual(first.held, [a.ref]);
  const second = store.reconcileSession('sess-idem', { reason: 'ended' });
  assert.deepStrictEqual(second.held, [], 'the registration is gone, so a replay has nothing to say');
  assert.strictEqual(store.getTicket(slug, a.ref).claim.by, 'worker-i', 'and the claim survived both');
});

test('a claim re-taken by another session since is NOT reported by the first session\'s reconcile', () => {
  const a = addTicket('re-claimed in the interim');
  store.claimTicket(slug, a.ref, 'worker-1', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-1' });
  // Session 2 force-steals it (as if the TTL lapsed or --force was used) and
  // registers under its own session.
  store.claimTicket(slug, a.ref, 'worker-2', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-2', force: true });
  assert.strictEqual(store.getTicket(slug, a.ref).claim.by, 'worker-2');

  const res = store.reconcileSession('sess-1', { reason: 'session 1 ended' });
  assert.deepStrictEqual(res.held, [], 'session 1 must not speak for a claim now held by session 2');
  assert.strictEqual(store.getTicket(slug, a.ref).claim.by, 'worker-2', 'session 2\'s live claim stands');
});

test('unregisterClaim drops a claim so a later reconcile ignores it', () => {
  const a = addTicket('unregistered before reconcile');
  store.claimTicket(slug, a.ref, 'worker-u', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-unreg' });
  store.unregisterClaim('sess-unreg', slug, a.id);
  // The ticket is still 'doing' (unregister doesn't touch the ticket), but the
  // registry no longer attributes it to the session, so reconcile is a no-op.
  const res = store.reconcileSession('sess-unreg', { reason: 'ended' });
  assert.deepStrictEqual(res.held, []);
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'doing', 'ticket unchanged by a no-op reconcile');
});

test('reconciling an unknown session is a harmless no-op', () => {
  const res = store.reconcileSession('nope-not-a-session', { reason: 'ended' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.held, []);
});

// The TOCTOU guard: releaseTicket must refuse a DONE ticket outright (the fresh
// locked read is authoritative), so a stale release cannot yank finished work back
// to todo. completeTicket clears the claim, so without this guard the empty-claim
// ownership check would pass vacuously.
test('releaseTicket refuses a done ticket — a stale session-end release cannot un-complete finished work', () => {
  const a = addTicket('finished, then a stale release arrives');
  store.claimTicket(slug, a.ref, 'worker-r', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-race' });
  store.completeTicket(slug, a.ref, 'worker-r', { model: 'sonnet', effort: 'high' });
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done');

  // The exact call reconcileSession would make against a ticket it believed was
  // still 'doing' but which finished in the meantime.
  const res = store.releaseTicket(slug, a.ref, 'worker-r', { status: 'todo', source: 'session-end' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'done');
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done', 'status stays done — not resurrected');
});

export {};
