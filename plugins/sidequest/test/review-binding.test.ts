import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-review-binding-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const db = require('../lib/db.js');

function git(repository: string, args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function persist(slug: string, ticket: any) {
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

function board(label: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-review-${label}-`));
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repository, 'candidate.txt'), 'candidate\n');
  git(repository, ['add', 'candidate.txt']);
  git(repository, ['commit', '-m', 'candidate']);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  const { slug } = store.ensureProject(repository);
  return { repository, slug, commit };
}

// A claim-free terminal submission: exactly the state a candidate review binds to.
function submittedSource(slug: string, commit: string, label: string, overrides: any = {}) {
  const source = store.createTicket(slug, { title: `source ${label}`, files: ['candidate.txt'] });
  source.status = 'doing';
  source.claim = null;
  source.dispatch = { terminalAt: new Date().toISOString(), outcome: 'submitted' };
  source.submission = Object.assign({
    by: 'implementer',
    at: new Date().toISOString(),
    commit,
    verify: 'manual: fixture',
    changedPaths: ['candidate.txt'],
    integratedAt: null,
  }, overrides);
  persist(slug, source);
  return store.getTicket(slug, source.ref);
}

function reviewTicket(slug: string, label: string) {
  return store.createTicket(slug, { title: `review ${label}`, category: 'review-audit', files: ['candidate.txt'] });
}

function tool(name: string) {
  const found = mcp.TOOLS.find((candidate: any) => candidate.name === name);
  assert.ok(found, `${name} is exposed over MCP`);
  return found;
}

function throwsWith(fn: () => any, pattern: RegExp) {
  assert.throws(fn, (error: any) => {
    assert.match(String(error?.message || error), pattern);
    return true;
  });
}

test('public add binds the review target and the source mirror as one committed pair', async () => {
  const { repository, slug, commit } = board('add');
  const source = submittedSource(slug, commit, 'add');
  const created = await tool('add').handler({
    project: repository,
    title: 'review the add candidate',
    category: 'review-audit',
    files: ['candidate.txt'],
    reviewTarget: { ref: source.ref, commit },
  });
  const review = store.getTicket(slug, created.ref);
  assert.equal(review.reviewTarget.ticketId, source.id);
  assert.equal(review.reviewTarget.ref, source.ref);
  assert.deepEqual(
    { source: review.reviewTarget.candidate.source, value: review.reviewTarget.candidate.value },
    { source: 'git', value: commit },
  );
  const mirror = store.getTicket(slug, source.ref).submission.review;
  assert.equal(mirror.ticketId, review.id);
  assert.equal(mirror.ref, review.ref);
  assert.equal(mirror.candidate.value, commit);
  assert.equal(mirror.outcome, 'planned');
});

test('public update binds through the same transition and reads back identically every time', async () => {
  const { repository, slug, commit } = board('update');
  const source = submittedSource(slug, commit, 'update');
  const review = reviewTicket(slug, 'update');
  assert.equal(store.getTicket(slug, review.ref).reviewTarget, undefined);
  await tool('update').handler({
    project: repository,
    ref: review.ref,
    reviewTarget: { ref: source.ref, commit },
  });
  const first = store.submissionReviewRelation(slug, store.getTicket(slug, source.ref));
  const second = store.submissionReviewRelation(slug, store.getTicket(slug, source.ref));
  assert.equal(first.side, 'both');
  assert.equal(first.reviewTicket.ref, review.ref);
  assert.equal(second.reviewTicket.ref, first.reviewTicket.ref);
  assert.equal(second.candidate.value, first.candidate.value);
  assert.equal(second.conflict, false);
});

test('a fault between the two writes rolls the whole binding back and leaves neither side changed', () => {
  const { slug, commit } = board('rollback');
  const source = submittedSource(slug, commit, 'rollback');
  const review = reviewTicket(slug, 'rollback');
  process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT = 'review';
  try {
    throwsWith(
      () => store.updateTicket(slug, review.ref, { title: 'bound review title' }, { ref: source.ref, commit }),
      /injected review binding fault after the review write/,
    );
  } finally {
    delete process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT;
  }
  const rolledBackReview = store.getTicket(slug, review.ref);
  assert.equal(rolledBackReview.reviewTarget, undefined);
  assert.equal(rolledBackReview.title, `review rollback`);
  assert.equal(store.getTicket(slug, source.ref).submission.review, undefined);
  assert.equal(store.submissionReviewRelation(slug, store.getTicket(slug, source.ref)), null);

  // The same transition succeeds once the fault is gone, proving the rollback
  // left a bindable state rather than a wedged half-binding.
  store.updateTicket(slug, review.ref, { title: 'bound review title' }, { ref: source.ref, commit });
  assert.equal(store.getTicket(slug, review.ref).reviewTarget.ref, source.ref);
  assert.equal(store.getTicket(slug, source.ref).submission.review.ref, review.ref);
});

test('a faulted add leaves no review ticket and no mirror behind', () => {
  const { slug, commit } = board('rollback-add');
  const source = submittedSource(slug, commit, 'rollback-add');
  const before = store.listTickets(slug).length;
  process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT = 'review';
  try {
    throwsWith(
      () => store.createTicket(slug, { title: 'faulted review', category: 'review-audit' }, { ref: source.ref, commit }),
      /injected review binding fault/,
    );
  } finally {
    delete process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT;
  }
  assert.equal(store.listTickets(slug).length, before);
  assert.equal(store.getTicket(slug, source.ref).submission.review, undefined);
});

test('binding refuses a live claim, an unsubmitted source, a mismatched commit, and a self review', () => {
  const { slug, commit } = board('refusals');
  const claimed = submittedSource(slug, commit, 'claimed');
  claimed.claim = { by: 'still-working', at: new Date().toISOString() };
  persist(slug, claimed);
  throwsWith(
    () => store.createTicket(slug, { title: 'review claimed', category: 'review-audit' }, { ref: claimed.ref, commit }),
    /is still live-claimed by still-working/,
  );

  const unsubmitted = store.createTicket(slug, { title: 'never submitted' });
  throwsWith(
    () => store.createTicket(slug, { title: 'review unsubmitted', category: 'review-audit' }, { ref: unsubmitted.ref, commit }),
    /has no claim-free terminal submission/,
  );

  const source = submittedSource(slug, commit, 'mismatch');
  throwsWith(
    () => store.createTicket(slug, { title: 'review mismatch', category: 'review-audit' }, { ref: source.ref, commit: 'a'.repeat(40) }),
    /candidate does not match its submitted git:/,
  );
  throwsWith(
    () => store.createTicket(slug, { title: 'review neither', category: 'review-audit' }, { ref: source.ref }),
    /requires exactly one of commit or sourceRevision/,
  );
  throwsWith(
    () => store.createTicket(slug, { title: 'review both', category: 'review-audit' }, { ref: source.ref, commit, sourceRevision: { source: 'notion', value: 'page-1' } }),
    /requires exactly one of commit or sourceRevision/,
  );
  throwsWith(
    () => store.createTicket(slug, { title: 'review outside category' }, { ref: source.ref, commit }),
    /reviewTarget is only valid for category review-audit/,
  );
});

test('a second review of the same candidate and a retarget of a bound review are both refused', () => {
  const { slug, commit } = board('duplicate');
  const source = submittedSource(slug, commit, 'duplicate');
  const other = submittedSource(slug, commit, 'other');
  const review = store.createTicket(slug, { title: 'first review', category: 'review-audit' }, { ref: source.ref, commit });
  throwsWith(
    () => store.createTicket(slug, { title: 'second review', category: 'review-audit' }, { ref: source.ref, commit }),
    new RegExp(`candidate is already bound to ${review.ref}`),
  );
  throwsWith(
    () => store.updateTicket(slug, review.ref, {}, { ref: other.ref, commit }),
    /candidate is already bound to|reviewTarget is immutable/,
  );
  assert.equal(store.getTicket(slug, review.ref).reviewTarget.ref, source.ref);
});

test('no generic field or patch can set, change, or clear reviewTarget', () => {
  const { slug, commit } = board('generic');
  const source = submittedSource(slug, commit, 'generic');
  throwsWith(
    () => store.createTicket(slug, { title: 'smuggled', category: 'review-audit', reviewTarget: { ref: source.ref, commit } }),
    /generic ticket fields cannot set reviewTarget/,
  );
  const review = store.createTicket(slug, { title: 'bound review', category: 'review-audit' }, { ref: source.ref, commit });
  throwsWith(
    () => store.updateTicket(slug, review.ref, { reviewTarget: null }),
    /generic ticket patch cannot set, change, or clear reviewTarget/,
  );
  throwsWith(
    () => store.updateTicket(slug, review.ref, { category: 'coding.hard' }),
    /reviewTarget is immutable and cannot be cleared by changing category/,
  );
  assert.equal(store.getTicket(slug, review.ref).reviewTarget.ref, source.ref);
  assert.equal(store.getTicket(slug, source.ref).submission.review.ref, review.ref);
});

test('a bound candidate refuses reclaim, amendment, and clearing from either legacy direction', () => {
  for (const direction of ['both', 'target-only', 'mirror-only']) {
    const { slug, commit } = board(`locked-${direction}`);
    const source = submittedSource(slug, commit, direction);
    const review = store.createTicket(slug, { title: `bound ${direction}`, category: 'review-audit' }, { ref: source.ref, commit });
    if (direction === 'target-only') {
      const stripped = store.getTicket(slug, source.ref);
      delete stripped.submission.review;
      persist(slug, stripped);
    }
    if (direction === 'mirror-only') {
      const stripped = store.getTicket(slug, review.ref);
      delete stripped.reviewTarget;
      persist(slug, stripped);
    }
    const relation = store.submissionReviewRelation(slug, store.getTicket(slug, source.ref));
    assert.equal(relation.side, direction, `${direction} relation is detected`);

    const claim = store.claimTicket(slug, source.ref, 'reclaimer', {});
    assert.equal(claim.ok, false, `${direction} refuses reclaim`);
    assert.equal(claim.reason, 'candidate_review_locked');
    assert.match(claim.message, /Repair requires a fresh ticket, attempt, candidate, and review identity/);

    const cleared = store.clearSubmission(slug, source.ref, { by: 'implementer' });
    assert.equal(cleared.ok, false, `${direction} refuses clearSubmission`);
    assert.equal(cleared.reason, 'candidate_review_locked');

    const amended = store.submitTicket(slug, source.ref, 'implementer', { commit, verify: 'manual: amended' });
    assert.equal(amended.ok, false, `${direction} refuses an amendment`);
    assert.equal(amended.reason, 'candidate_review_locked');

    assert.equal(store.getTicket(slug, source.ref).submission.commit, commit);
  }
});

test('integration waits for the bound review and stays blocked once the candidate is rejected', () => {
  const { slug, commit } = board('integration');
  const source = submittedSource(slug, commit, 'integration');
  const review = store.createTicket(slug, { title: 'gate review', category: 'review-audit' }, { ref: source.ref, commit });
  const pending = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, 'candidate_review_required');
  assert.match(pending.message, /has not terminally completed its bound review/);

  const done = store.getTicket(slug, review.ref);
  done.status = 'done';
  done.dispatch = { terminalAt: new Date().toISOString(), outcome: 'done' };
  persist(slug, done);

  const rejected = store.reworkSubmission(slug, source.ref, {
    by: 'reviewer',
    review: 'read the candidate diff end to end',
    reviewRef: review.ref,
    reason: 'the transition writes one half without the other',
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.freshRepairRequired, true);
  const parked = store.getTicket(slug, source.ref);
  assert.equal(parked.submission.commit, commit, 'the rejected candidate stays parked, not cleared');
  assert.equal(parked.submission.review.outcome, 'rejected');
  const blocked = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'candidate_rejected');
  assert.match(blocked.message, /repair needs fresh ticket, attempt, candidate, and review identities/);
});

test('rejecting a bound candidate needs the bound review ref, a terminal review, and a different identity', () => {
  const { slug, commit } = board('reject-guards');
  const source = submittedSource(slug, commit, 'reject-guards');
  const review = store.createTicket(slug, { title: 'guard review', category: 'review-audit' }, { ref: source.ref, commit });
  const evidence = { review: 'inspected the pinned candidate', reason: 'confirmed defect' };

  const unnamed = store.reworkSubmission(slug, source.ref, Object.assign({ by: 'reviewer' }, evidence));
  assert.equal(unnamed.reason, 'review_identity_required');
  assert.match(unnamed.message, new RegExp(`pass reviewRef ${review.ref}`));

  const wrongReview = store.reworkSubmission(slug, source.ref, Object.assign({ by: 'reviewer', reviewRef: 'SQ-999999' }, evidence));
  assert.equal(wrongReview.reason, 'review_identity_required');

  const notTerminal = store.reworkSubmission(slug, source.ref, Object.assign({ by: 'reviewer', reviewRef: review.ref }, evidence));
  assert.equal(notTerminal.reason, 'review_not_terminal');

  const done = store.getTicket(slug, review.ref);
  done.status = 'done';
  done.dispatch = { terminalAt: new Date().toISOString(), outcome: 'done' };
  persist(slug, done);

  const selfConfirmed = store.reworkSubmission(slug, source.ref, Object.assign({ by: 'implementer', reviewRef: review.ref }, evidence));
  assert.equal(selfConfirmed.reason, 'fresh_repair_identity_required');
  assert.equal(store.getTicket(slug, source.ref).submission.review.outcome, 'planned');
});

test('dispatch pins a bound review to the exact candidate in an isolated checkout', () => {
  const { repository, slug, commit } = board('dispatch');
  const source = submittedSource(slug, commit, 'dispatch');
  const review = store.createTicket(slug, {
    title: 'pinned review',
    category: 'review-audit',
    files: ['candidate.txt'],
    executorVerify: 'manual: read the candidate',
  }, { ref: source.ref, commit });
  const prepared = store.prepareDispatch(slug, review.ref, { sessionId: `review-dispatch-${Date.now()}` });
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(prepared.ticket.dispatch.baseCommit, commit);
  assert.equal(prepared.ticket.dispatch.reviewTarget.ref, source.ref);
  throwsWith(
    () => store.prepareDispatch(slug, review.ref, { sessionId: `review-shared-${Date.now()}`, sharedTree: true, runtimeCwd: repository }),
    /requires an isolated immutable checkout/,
  );
});

test('dispatch refuses a bound review whose candidate moved out from under it', () => {
  const { slug, commit } = board('dispatch-drift');
  const source = submittedSource(slug, commit, 'drift');
  const review = store.createTicket(slug, {
    title: 'drifting review',
    category: 'review-audit',
    files: ['candidate.txt'],
    executorVerify: 'manual: read the candidate',
  }, { ref: source.ref, commit });
  const drifted = store.getTicket(slug, source.ref);
  drifted.submission.commit = 'b'.repeat(40);
  drifted.submission.review.candidate = { source: 'git', value: 'b'.repeat(40) };
  persist(slug, drifted);
  throwsWith(
    () => store.prepareDispatch(slug, review.ref, { sessionId: `review-drift-${Date.now()}` }),
    /no longer matches its exact submitted candidate/,
  );
});
