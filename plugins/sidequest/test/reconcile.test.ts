'use strict';
/**
 * Tests for the session worker registry + reconcileSession (SQ-153).
 *
 * The claim TTL (default 60 min) frees a crashed worker's ticket eventually. The
 * registry lets a SessionEnd / SubagentStop hook do it IMMEDIATELY, but safely:
 * reconciling a session must release ONLY the claims taken under that exact
 * session id, never a claim another live session holds, and never a finished
 * ticket. These tests pin that safety.
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

function addTicket(title?: any) {
  return store.createTicket(slug, { title, complexity: 3, complexityWhy: 'fixture for reconcile tests, single mechanical change', labels: ['direct-ok'], source: 'cli' });
}

test('reconcileSession releases only the ending session\'s claims, and moves them back to todo', () => {
  const a = addTicket('session A ticket');
  const b = addTicket('session B ticket');

  const ra = store.claimTicket(slug, a.ref, 'worker-a', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-A' });
  const rb = store.claimTicket(slug, b.ref, 'worker-b', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-B' });
  assert.strictEqual(ra.ok, true);
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'doing');
  assert.strictEqual(store.getTicket(slug, b.ref).status, 'doing');

  const res = store.reconcileSession('sess-A', { reason: 'session ended' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.released, [a.ref], 'only A\'s ticket is released');

  const at = store.getTicket(slug, a.ref);
  assert.strictEqual(at.status, 'todo', 'A\'s ticket returns to todo');
  assert.strictEqual(at.claim, null, 'A\'s claim is cleared');

  const bt = store.getTicket(slug, b.ref);
  assert.strictEqual(bt.status, 'doing', 'B\'s ticket is untouched');
  assert.ok(bt.claim && bt.claim.by === 'worker-b', 'B\'s claim is intact');
});

test('reconcileSession leaves a note comment on each released ticket', () => {
  const a = addTicket('to be auto-released');
  store.claimTicket(slug, a.ref, 'worker-x', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-note' });
  store.reconcileSession('sess-note', { reason: 'subagent stopped' });
  const t = store.getTicket(slug, a.ref);
  const last = t.comments[t.comments.length - 1];
  assert.ok(last, 'a comment was added');
  assert.match(last.body, /Auto-released/i);
  assert.match(last.body, /subagent stopped/i);
});

test('a completed ticket is never auto-released, even if still registered', () => {
  const a = addTicket('finished before reconcile');
  store.claimTicket(slug, a.ref, 'worker-done', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-done' });
  // Finish WITHOUT passing the sessionId (simulates a done that forgot to thread
  // it) so the registry entry lingers — reconcile must still skip the done ticket.
  store.completeTicket(slug, a.ref, 'worker-done', { model: 'sonnet', effort: 'high' });
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done');

  const res = store.reconcileSession('sess-done', { reason: 'session ended' });
  assert.deepStrictEqual(res.released, [], 'a done ticket is not released');
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'done', 'still done');
});

test('reconcileSession is idempotent — a second call releases nothing', () => {
  const a = addTicket('idempotency check');
  store.claimTicket(slug, a.ref, 'worker-i', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-idem' });
  const first = store.reconcileSession('sess-idem', { reason: 'ended' });
  assert.deepStrictEqual(first.released, [a.ref]);
  const second = store.reconcileSession('sess-idem', { reason: 'ended' });
  assert.deepStrictEqual(second.released, [], 'nothing left to release');
});

test('a claim re-taken by another session since is NOT released by the first session\'s reconcile', () => {
  const a = addTicket('re-claimed in the interim');
  store.claimTicket(slug, a.ref, 'worker-1', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-1' });
  // Session 2 force-steals it (as if the TTL lapsed or --force was used) and
  // registers under its own session.
  store.claimTicket(slug, a.ref, 'worker-2', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-2', force: true });
  assert.strictEqual(store.getTicket(slug, a.ref).claim.by, 'worker-2');

  const res = store.reconcileSession('sess-1', { reason: 'session 1 ended' });
  assert.deepStrictEqual(res.released, [], 'session 1 must not release a claim now held by session 2');
  assert.strictEqual(store.getTicket(slug, a.ref).claim.by, 'worker-2', 'session 2\'s live claim stands');
});

test('unregisterClaim drops a claim so a later reconcile ignores it', () => {
  const a = addTicket('unregistered before reconcile');
  store.claimTicket(slug, a.ref, 'worker-u', { direct: true, reason: 'The reconcile fixture requires a local direct claim.', sessionId: 'sess-unreg' });
  store.unregisterClaim('sess-unreg', slug, a.id);
  // The ticket is still 'doing' (unregister doesn't touch the ticket), but the
  // registry no longer attributes it to the session, so reconcile is a no-op.
  const res = store.reconcileSession('sess-unreg', { reason: 'ended' });
  assert.deepStrictEqual(res.released, []);
  assert.strictEqual(store.getTicket(slug, a.ref).status, 'doing', 'ticket unchanged by a no-op reconcile');
});

test('reconciling an unknown session is a harmless no-op', () => {
  const res = store.reconcileSession('nope-not-a-session', { reason: 'ended' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.released, []);
});

// The TOCTOU guard: releaseTicket must refuse a DONE ticket outright (the fresh
// locked read is authoritative), so a reconcile racing behind a completeTicket
// can never yank finished work back to todo. completeTicket clears the claim, so
// without this guard the empty-claim ownership check would pass vacuously.
test('releaseTicket refuses a done ticket — a reconcile cannot un-complete finished work', () => {
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
