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
const agentsync = require('../lib/agentsync.js');
const mcp = require('../lib/mcp.js');
const db = require('../lib/db.js');
const reviewBinding = require('../lib/kernel/review-binding.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');

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
  const terminalAt = new Date().toISOString();
  source.status = 'doing';
  source.claim = null;
  source.dispatch = {
    terminalAt,
    outcome: 'submitted',
    agentId: `source-agent-${label}`,
    attempts: [{ outcome: 'submitted', commit, agentId: `source-agent-${label}`, terminalAt }],
  };
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

// The review as a terminal executor leaves it: status done plus an appended
// terminal attempt carrying the runtime identity that actually ran it.
function completeReview(slug: string, ref: string, agentId: string | null) {
  const done = store.getTicket(slug, ref);
  const terminalAt = new Date().toISOString();
  done.status = 'done';
  done.dispatch = {
    terminalAt,
    outcome: 'done',
    agentId,
    attempts: [{ outcome: 'done', agentId, terminalAt }],
  };
  persist(slug, done);
  return store.getTicket(slug, ref);
}

// The exact bytes a refused mutation must leave behind on both halves.
function bindingBytes(slug: string, sourceRef: string, reviewRef: string) {
  return JSON.stringify({
    source: store.getTicket(slug, sourceRef),
    review: store.getTicket(slug, reviewRef),
  });
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

test('SQ-2203: a candidate review is told to synchronize its worktree to the exact candidate', async () => {
  const { repository, slug, commit } = board('candidate-sync');
  const source = submittedSource(slug, commit, 'candidate-sync');
  // The checkout moves on after the candidate, which is the incident shape: a harness-created worktree starts
  // at this HEAD, and reviewing it instead of the candidate is what produced a false rejection (SQ-2124).
  fs.appendFileSync(path.join(repository, 'candidate.txt'), 'later work\n');
  git(repository, ['add', 'candidate.txt']);
  git(repository, ['commit', '-m', 'work after the candidate']);
  assert.notEqual(git(repository, ['rev-parse', 'HEAD']), commit, 'the checkout HEAD must differ from the candidate');

  const created = await tool('add').handler({
    project: repository,
    title: 'review the candidate sync',
    category: 'review-audit',
    files: ['candidate.txt'],
    reviewTarget: { ref: source.ref, commit },
  });
  const reviewAudit = store.getCategory('review-audit');
  store.setCategory(Object.assign({}, reviewAudit, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
  const prepared = store.prepareDispatch(slug, created.ref, { sessionId: `candidate-sync-${Date.now()}`, sharedTree: false });
  assert.equal(prepared.ticket.dispatch.baseCommit, commit, 'the prepared baseline is the candidate');

  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, repository);
  assert.ok(briefing.includes('Candidate synchronization (run before any review work)'), 'the reviewer is told to synchronize');
  assert.ok(briefing.includes(`git checkout --detach ${commit}`), 'the instruction names the candidate commit');
  assert.ok(briefing.includes('stop and report that the candidate is not present'), 'an unreachable candidate stops the review instead of reviewing the wrong tree');
  assert.ok(briefing.includes('A review also ENDS on its candidate'), 'the reviewer is told the closure rule the board enforces (SQ-2207)');
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

test('no direct store call can permanently reject a bound candidate under any caller label', () => {
  const { repository, slug, commit } = board('direct-store-reject');
  const source = submittedSource(slug, commit, 'direct-store-reject');
  const review = store.createTicket(slug, { title: 'direct store review', category: 'review-audit' }, { ref: source.ref, commit });
  completeReview(slug, review.ref, 'reviewer-agent');
  const before = bindingBytes(slug, source.ref, review.ref);

  for (const by of ['implementer', 'reviewer', 'fresh-repair-identity']) {
    const direct = store.recordSubmissionRejection(slug, source.ref, {
      by,
      review: 'read the pinned candidate end to end',
      reason: 'confirmed defect',
      commit,
      root: repository,
    });
    assert.equal(direct.ok, false, `${by} cannot reject directly`);
    assert.equal(direct.reason, 'candidate_review_locked', `${by} gets the lock, not an ownership answer`);
    assert.match(direct.message, /only an integrated repair may supersede it/);

    const reworked = store.reworkSubmission(slug, source.ref, {
      by,
      review: 'read the pinned candidate end to end',
      reviewRef: review.ref,
      reason: 'confirmed defect',
    });
    assert.equal(reworked.ok, false, `${by} cannot rework the bound candidate`);
    assert.equal(reworked.reason, 'candidate_review_locked');
  }

  assert.equal(bindingBytes(slug, source.ref, review.ref), before, 'every refused route left both halves byte-identical');
  const parked = store.getTicket(slug, source.ref);
  assert.equal(parked.rejectedSubmissions, undefined, 'no rejected history was written');
  assert.equal(parked.submission.review.outcome, 'planned', 'no review outcome was written');
  assert.equal(store.rejectBoundCandidate, undefined, 'no privileged rejection wrapper is exported');
  assert.equal(store.reworkSubmissionAsReleaseAuthority, undefined, 'no release-authority rework wrapper is exported');
});

test('raw MCP rework refuses a bound candidate for an arbitrary client with any reviewRef, payload, or session string', async () => {
  const { repository, slug, commit } = board('raw-mcp-reject');
  const source = submittedSource(slug, commit, 'raw-mcp-reject');
  const review = store.createTicket(slug, { title: 'raw mcp review', category: 'review-audit' }, { ref: source.ref, commit });
  completeReview(slug, review.ref, 'reviewer-agent');
  const before = bindingBytes(slug, source.ref, review.ref);
  const copiedPayload = JSON.parse(JSON.stringify(store.getTicket(slug, source.ref).submission));

  const forgeries: Array<[string, any]> = [
    ['an arbitrary client', { by: 'arbitrary-mcp-client', review: 'audited the candidate', reviewRef: review.ref, reason: 'confirmed defect' }],
    ['the copied candidate payload', { by: copiedPayload.by, review: JSON.stringify(copiedPayload), reviewRef: review.ref, reason: `confirmed defect in ${copiedPayload.commit}` }],
    ['a publish-lock session string', { by: 'release-authority session=sidequest-publish-lock', review: 'audited the candidate', reviewRef: review.ref, reason: 'confirmed defect' }],
  ];
  for (const [label, forged] of forgeries) {
    const response = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 4100,
      method: 'tools/call',
      params: { name: 'rework', arguments: Object.assign({ project: repository, ref: source.ref }, forged) },
    });
    assert.equal(response.result.isError, undefined, `rework returned a refusal payload for ${label}`);
    const ack = JSON.parse(response.result.content[0].text);
    assert.equal(ack.ok, false, `${label} cannot reject over raw MCP`);
    assert.equal(ack.reason, 'candidate_review_locked', `${label} gets the lock`);
    assert.match(ack.message, /A failed review records its evidence on the review ticket/);
  }

  // Session ids, publish-lock holders, and whole submission records cannot even
  // be spelled as arguments, so there is no field left for a caller to forge.
  const smuggled = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: 4101,
    method: 'tools/call',
    params: {
      name: 'rework',
      arguments: {
        project: repository,
        ref: source.ref,
        by: 'release-authority',
        review: 'audited the candidate',
        reason: 'confirmed defect',
        session: 'sidequest-publish-lock',
        publishLock: 'held',
        submission: copiedPayload,
      },
    },
  });
  assert.equal(smuggled.result.isError, true, 'rework refuses arguments it does not accept');
  assert.match(smuggled.result.content[0].text, /unknown arguments/);

  assert.equal(bindingBytes(slug, source.ref, review.ref), before, 'raw MCP rework left both halves byte-identical');
});

test('the CLI rework command refuses a bound candidate and writes nothing', () => {
  const { repository, slug, commit } = board('cli-reject');
  const source = submittedSource(slug, commit, 'cli-reject');
  const review = store.createTicket(slug, { title: 'cli review', category: 'review-audit' }, { ref: source.ref, commit });
  completeReview(slug, review.ref, 'reviewer-agent');
  const before = bindingBytes(slug, source.ref, review.ref);

  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const result = require('node:child_process').spawnSync(process.execPath, [
    cli, 'rework', source.ref,
    '--project', repository,
    '--by', 'reviewer',
    '--review', 'audited the candidate',
    '--review-ref', review.ref,
    '--reason', 'confirmed defect',
    '--json',
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SIDEQUEST_HOME } });
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'candidate_review_locked');
  assert.equal(bindingBytes(slug, source.ref, review.ref), before, 'CLI rework left both halves byte-identical');
});

test('reconciliation refuses a pending rejection of the bound candidate and still finishes an older one', () => {
  const { repository, slug, commit: older } = board('reconcile');
  fs.writeFileSync(path.join(repository, 'candidate.txt'), 'second candidate\n');
  git(repository, ['add', 'candidate.txt']);
  git(repository, ['commit', '-m', 'second candidate']);
  const bound = git(repository, ['rev-parse', 'HEAD']);

  const source = submittedSource(slug, bound, 'reconcile');
  const review = store.createTicket(slug, { title: 'reconcile review', category: 'review-audit' }, { ref: source.ref, commit: bound });
  completeReview(slug, review.ref, 'reviewer-agent');

  const matching = store.getTicket(slug, source.ref);
  matching.rejectedSubmissions = [{
    commit: bound,
    rejectedAt: new Date().toISOString(),
    rejectedBy: 'reviewer',
    review: 'half-written rejection of the bound candidate',
    reason: 'confirmed defect',
    rejectionKind: 'validation',
    validation: true,
    preservationState: 'pending',
    source: 'mcp',
  }];
  persist(slug, matching);
  const before = bindingBytes(slug, source.ref, review.ref);

  const refused = store.reconcileSubmissionRejections(slug, source.ref);
  assert.equal(refused.ok, false, 'a pending rejection of the bound candidate cannot be finished');
  assert.equal(refused.reason, 'candidate_review_locked');
  assert.equal(bindingBytes(slug, source.ref, review.ref), before, 'reconciliation wrote nothing');
  assert.equal(store.getTicket(slug, source.ref).rejectedSubmissions[0].preservationState, 'pending');

  const stale = store.getTicket(slug, source.ref);
  stale.rejectedSubmissions[0].commit = older;
  persist(slug, stale);
  const recovered = store.reconcileSubmissionRejections(slug, source.ref);
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal(store.getTicket(slug, source.ref).rejectedSubmissions[0].preservationState, 'preserved');
  assert.equal(store.getTicket(slug, source.ref).submission.commit, bound, 'the bound candidate stayed parked');
});

test('a failed exact review blocks integration and leaves the candidate and both binding halves untouched', () => {
  const { slug, commit } = board('failed-review');
  const source = submittedSource(slug, commit, 'failed-review');
  const review = store.createTicket(slug, { title: 'failing review', category: 'review-audit' }, { ref: source.ref, commit });
  const pending = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, 'candidate_review_required');
  assert.match(pending.message, /has not terminally completed its bound review/);

  const before = bindingBytes(slug, source.ref, review.ref);
  // What a review executor that found a real defect actually does: evidence on
  // the review ticket, then release it for an external oracle.
  const released = store.getTicket(slug, review.ref);
  released.status = 'awaiting-oracle';
  released.dispatch = { terminalAt: new Date().toISOString(), outcome: 'released', agentId: 'reviewer-agent', attempts: [{ outcome: 'released', agentId: 'reviewer-agent', terminalAt: new Date().toISOString() }] };
  persist(slug, released);

  const blocked = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'candidate_review_required');
  const after = store.getTicket(slug, source.ref);
  assert.equal(JSON.stringify(after), JSON.stringify(JSON.parse(before).source), 'the source half is byte-identical');
  assert.equal(after.submission.commit, commit);
  assert.equal(after.submission.review.outcome, 'planned');
  assert.equal(store.getTicket(slug, review.ref).reviewTarget.candidate.value, commit);
});

test('a historical rejected review outcome stays readable and keeps integration blocked', () => {
  const { slug, commit } = board('legacy-rejected');
  const source = submittedSource(slug, commit, 'legacy-rejected');
  store.createTicket(slug, { title: 'legacy review', category: 'review-audit' }, { ref: source.ref, commit });
  const legacy = store.getTicket(slug, source.ref);
  legacy.submission.review.outcome = 'rejected';
  legacy.rejectedSubmissions = [{
    commit,
    rejectedAt: '2026-01-01T00:00:00.000Z',
    rejectedBy: 'legacy-reviewer',
    review: 'recorded before public rejection was removed',
    reason: 'legacy confirmed defect',
    preservationState: 'preserved',
    quarantineRef: `refs/sidequest/${source.ref}-rejected`,
  }];
  persist(slug, legacy);

  const blocked = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'candidate_rejected');
  assert.match(blocked.message, /repair needs fresh ticket, attempt, candidate, and review identities/);
  assert.equal(store.getTicket(slug, source.ref).rejectedSubmissions.length, 1, 'the historical record is still readable');
});

test('an oracle rejection marks both binding halves rejected and permits a reviewed integrated replacement', async () => {
  const { repository, slug, commit: candidate } = board('oracle-rejection');
  const source = submittedSource(slug, candidate, 'oracle-rejection');
  const review = store.createTicket(slug, {
    title: 'oracle-confirmed review',
    category: 'review-audit',
    files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  const claimedReview = store.getTicket(slug, review.ref);
  claimedReview.status = 'doing';
  claimedReview.claim = { by: 'reviewer', at: new Date().toISOString() };
  claimedReview.dispatch = { launchSeq: 1 };
  persist(slug, claimedReview);

  const released = await tool('release').handler({
    project: repository,
    ref: review.ref,
    by: 'reviewer',
    kind: 'oracle',
    oracle: 'Does the recorded defect reject this candidate?',
  });
  assert.equal(released.ok, true, released.message);
  const verdict = await tool('verdict').handler({
    project: repository,
    ref: review.ref,
    text: 'The candidate is rejected because the recorded defect is confirmed.',
    outcome: 'rejected',
    why: 'The review found a reproducible defect in the pinned candidate.',
    constraint: 'Replace the candidate before integration.',
  });
  assert.equal(verdict.ok, true, verdict.message);

  assert.equal(store.getTicket(slug, review.ref).reviewTarget.outcome, 'rejected');
  assert.equal(store.getTicket(slug, source.ref).submission.review.outcome, 'rejected');

  fs.writeFileSync(path.join(repository, 'candidate.txt'), 'repaired candidate\n');
  git(repository, ['add', 'candidate.txt']);
  git(repository, ['commit', '-m', 'repair rejected candidate']);
  const repairCommit = git(repository, ['rev-parse', 'HEAD']);
  const repair = store.createTicket(slug, { title: 'repair rejected candidate', files: ['candidate.txt'] });
  repair.status = 'done';
  repair.submission = {
    commit: repairCommit,
    integratedAt: new Date().toISOString(),
    integration: {
      outcome: 'verified',
      resultingHead: repairCommit,
      deliveredFiles: ['candidate.txt'],
    },
  };
  persist(slug, repair);

  const superseded = await tool('supersede_submission').handler({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: repair.ref,
    reason: 'The integrated repair replaces the oracle-rejected candidate.',
    reviewedReplacements: [{
      path: 'candidate.txt',
      reviewedBy: review.ref,
      reason: 'The review confirmed the original candidate must be replaced.',
    }],
  });
  assert.equal(superseded.ok, true, superseded.message);
  const closed = store.getTicket(slug, source.ref);
  assert.equal(closed.status, 'done');
  assert.equal(closed.submission.integration.outcome, 'superseded');
});

test('an accepted oracle review continues to lock candidate supersession', async () => {
  const { repository, slug, commit: candidate } = board('oracle-acceptance');
  const source = submittedSource(slug, candidate, 'oracle-acceptance');
  const review = store.createTicket(slug, {
    title: 'oracle-accepted review',
    category: 'review-audit',
    files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  const claimedReview = store.getTicket(slug, review.ref);
  claimedReview.status = 'doing';
  claimedReview.claim = { by: 'reviewer', at: new Date().toISOString() };
  claimedReview.dispatch = {
    launchSeq: 1,
    readonly: false,
    executor: 'sidequest-exec-dispatch-readonly',
    agentId: 'reviewer-agent',
  };
  persist(slug, claimedReview);

  const released = await tool('release').handler({
    project: repository,
    ref: review.ref,
    by: 'reviewer',
    kind: 'oracle',
    oracle: 'Does the review accept this candidate?',
  });
  assert.equal(released.ok, true, released.message);
  const verdict = await tool('verdict').handler({
    project: repository,
    ref: review.ref,
    text: 'The candidate is accepted.',
    outcome: 'accepted',
    why: 'The review found no defect in the pinned candidate.',
    constraint: 'Keep the accepted candidate immutable.',
  });
  assert.equal(verdict.ok, true, verdict.message);
  const completedReview = store.getTicket(slug, review.ref);
  assert.equal(completedReview.status, 'done');
  assert.equal(completedReview.completion.purpose, 'oracle-review-verdict');
  assert.equal(completedReview.comments.find((comment: any) => comment.id === completedReview.completion.commentId)?.body, 'Oracle verdict (accepted): The candidate is accepted.');
  assert.equal(completedReview.reviewTarget.outcome, 'accepted');
  assert.equal(store.getTicket(slug, source.ref).submission.review.outcome, 'accepted');
  assert.equal(reviewBinding.reviewProvenance(store.getTicket(slug, source.ref), completedReview).reason, 'ok');
  const integration = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.notEqual(integration.reason, 'candidate_review_required');

  const superseded = await tool('supersede_submission').handler({
    project: repository,
    ref: source.ref,
    by: 'orchestrator',
    supersededBy: 'SQ-repair',
    reason: 'An accepted candidate must remain immutable.',
  });
  assert.equal(superseded.ok, false);
  assert.equal(superseded.reason, 'candidate_review_locked');
});

test('oracle outcomes retain their candidate review meaning', () => {
  assert.equal(reviewBinding.reviewOutcomeFromOracleVerdict('accepted'), 'accepted');
  assert.equal(reviewBinding.reviewOutcomeFromOracleVerdict('rejected'), 'rejected');
  assert.equal(reviewBinding.reviewOutcomeFromOracleVerdict('inconclusive'), 'inconclusive');
});

test('unbound owner rework still parks the candidate and reopens the ticket', () => {
  const { slug, commit } = board('unbound-rework');
  const source = submittedSource(slug, commit, 'unbound-rework');
  const reworked = store.reworkSubmission(slug, source.ref, {
    by: 'implementer',
    review: 'the orchestrator read the diff',
    reason: 'the range includes a foreign path',
  });
  assert.equal(reworked.ok, true, reworked.message);
  const reopened = store.getTicket(slug, source.ref);
  assert.equal(reopened.status, 'todo');
  assert.equal(reopened.submission, null);
  assert.equal(reopened.rejectedSubmissions[0].commit, commit);
  assert.equal(reopened.rejectedSubmissions[0].preservationState, 'preserved');
});

test('review provenance comes from immutable terminal attempts, not the mutable current dispatch', () => {
  const { slug, commit } = board('provenance');
  const source = submittedSource(slug, commit, 'provenance');
  const review = store.createTicket(slug, { title: 'provenance review', category: 'review-audit' }, { ref: source.ref, commit });

  // The exact terminal attempts an executor pair leaves behind.
  const submittedAt = new Date(Date.now() - 60_000).toISOString();
  const withAttempts = store.getTicket(slug, source.ref);
  withAttempts.dispatch = {
    attempts: [{ outcome: 'submitted', commit, agentId: 'source-a', terminalAt: submittedAt }],
    // A LATER prepared dispatch: no outcome, no terminalAt, a foreign identity.
    preparedAt: new Date().toISOString(),
    outcome: null,
    terminalAt: null,
    agentId: null,
  };
  persist(slug, withAttempts);

  const reviewedAt = new Date().toISOString();
  const done = store.getTicket(slug, review.ref);
  done.status = 'done';
  done.dispatch = {
    attempts: [{ outcome: 'done', agentId: 'review-b', terminalAt: reviewedAt }],
    preparedAt: new Date().toISOString(),
    outcome: null,
    terminalAt: null,
    agentId: 'someone-else-entirely',
  };
  persist(slug, done);

  const provenance = reviewBinding.reviewProvenance(store.getTicket(slug, source.ref), store.getTicket(slug, review.ref));
  assert.equal(provenance.reason, 'ok');
  assert.equal(provenance.source.agentId, 'source-a', 'the source identity comes from the submitted attempt');
  assert.equal(provenance.reviewer.agentId, 'review-b', 'the reviewer identity comes from the terminal done attempt');

  const accepted = store.validateIntegrationSubmission(slug, source.ref, {});
  assert.notEqual(accepted.reason, 'candidate_review_required', 'the completed independent review no longer blocks integration');
  assert.notEqual(accepted.reason, 'candidate_rejected');
});

test('integration stays blocked when a matching attempt, an identity, or a distinct reviewer is missing', () => {
  const cases: Array<[string, any, any]> = [
    ['source attempt for another commit', [{ outcome: 'submitted', commit: 'f'.repeat(40), agentId: 'source-a', terminalAt: '2026-01-01T00:00:00.000Z' }], [{ outcome: 'done', agentId: 'review-b', terminalAt: '2026-01-02T00:00:00.000Z' }]],
    ['no terminal done review attempt', null, [{ outcome: 'released', agentId: 'review-b', terminalAt: '2026-01-02T00:00:00.000Z' }]],
    ['no reviewer identity', null, [{ outcome: 'done', agentId: null, terminalAt: '2026-01-02T00:00:00.000Z' }]],
    ['the same agent on both sides', null, [{ outcome: 'done', agentId: 'source-a', terminalAt: '2026-01-02T00:00:00.000Z' }]],
  ];
  for (const [label, sourceAttempts, reviewAttempts] of cases) {
    const { slug, commit } = board(`blocked-${label.replace(/\W+/g, '-')}`);
    const source = submittedSource(slug, commit, 'blocked');
    const review = store.createTicket(slug, { title: `blocked ${label}`, category: 'review-audit' }, { ref: source.ref, commit });
    const withAttempts = store.getTicket(slug, source.ref);
    withAttempts.dispatch = {
      attempts: sourceAttempts || [{ outcome: 'submitted', commit, agentId: 'source-a', terminalAt: '2026-01-01T00:00:00.000Z' }],
      outcome: 'submitted',
      terminalAt: '2026-01-01T00:00:00.000Z',
      agentId: 'source-a',
    };
    persist(slug, withAttempts);
    const done = store.getTicket(slug, review.ref);
    done.status = 'done';
    done.dispatch = { attempts: reviewAttempts, outcome: 'done', terminalAt: '2026-01-02T00:00:00.000Z', agentId: 'review-b' };
    persist(slug, done);

    const blocked = store.validateIntegrationSubmission(slug, source.ref, {});
    assert.equal(blocked.ok, false, `${label} blocks integration`);
    assert.equal(blocked.reason, 'candidate_review_required', `${label} blocks integration`);
    assert.equal(store.getTicket(slug, source.ref).submission.commit, commit, `${label} mutated nothing`);
  }
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

// A launched review standing in its own linked checkout at the candidate, which is where worktree creation binds
// it and the only state the ending tree can be read from.
function claimedReviewInWorktree(slug: string, repository: string, reviewRef: string, label: string) {
  const sessionId = `review-close-${label}`;
  const agentId = `review-closer-${label}`;
  const prepared = store.prepareDispatch(slug, reviewRef, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, reviewRef, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  const worktree = worktrees.resolvedAgentWorktree(repository, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  git(repository, ['worktree', 'add', '--detach', worktree, String(prepared.ticket.dispatch.baseCommit)]);
  worktreeLease.createCheckoutInstanceMarker(path.resolve(worktree, git(worktree, ['rev-parse', '--git-dir'])));
  assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(slug, reviewRef, agentId, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
  }).ok, true);
  return { worktree, agentId };
}

// SQ-2207. A review that ends on a tree other than its candidate is a verdict about different code, which is how
// SQ-2124 rejected a commit whose own suite passed. The reviewer is told to synchronize, and the briefing is not
// evidence that it did: the board observes the ending checkout itself.
test('SQ-2207: a review cannot close from a tree that is not its candidate', () => {
  const { repository, slug, commit } = board('close-tree');
  const source = submittedSource(slug, commit, 'close-tree');
  // The later commit deliberately stays outside the review's declared scope: scope checking cannot see this drift,
  // so the refusal below is the only thing standing between a wrong tree and a recorded verdict.
  fs.writeFileSync(path.join(repository, 'elsewhere.txt'), 'unrelated later work\n');
  git(repository, ['add', 'elsewhere.txt']);
  git(repository, ['commit', '-m', 'work after the candidate, outside the review scope']);
  const later = git(repository, ['rev-parse', 'HEAD']);
  const review = store.createTicket(slug, {
    title: 'review closing off the candidate',
    category: 'review-audit',
    files: ['candidate.txt'],
    executorVerify: 'manual: read the candidate',
  }, { ref: source.ref, commit });
  const { worktree, agentId } = claimedReviewInWorktree(slug, repository, review.ref, 'mismatch');
  // The reviewer walks off the candidate mid-run, which is all it takes: nothing else in the board reads the
  // checkout again, because a readonly review never asks for a write lease.
  git(worktree, ['checkout', '--detach', later]);

  const refused = store.releaseTicket(slug, review.ref, agentId, { status: 'done', source: 'test' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'review_tree_mismatch');
  assert.ok(refused.message.includes(`its checkout is on ${later}`), refused.message);
  assert.ok(refused.message.includes(`the candidate ${commit}`), refused.message);
  assert.ok(
    refused.message.includes(`git -C ${worktrees.canonicalPath(worktree)} checkout --detach ${commit}`),
    refused.message,
  );
  assert.equal(store.getTicket(slug, review.ref).status, 'doing');

  git(worktree, ['checkout', '--detach', commit]);
  const closed = store.releaseTicket(slug, review.ref, agentId, { status: 'done', source: 'test' });
  assert.equal(closed.ok, true, closed.message);
  assert.equal(store.getTicket(slug, review.ref).status, 'done');
});

test('SQ-2207: a review whose checkout cannot be read is refused instead of closing unobserved', () => {
  const { repository, slug, commit } = board('close-unreadable');
  const source = submittedSource(slug, commit, 'close-unreadable');
  const review = store.createTicket(slug, {
    title: 'review with no readable checkout',
    category: 'review-audit',
    files: ['candidate.txt'],
    executorVerify: 'manual: read the candidate',
  }, { ref: source.ref, commit });
  const { worktree, agentId } = claimedReviewInWorktree(slug, repository, review.ref, 'unreadable');
  git(repository, ['worktree', 'remove', '--force', worktree]);

  const refused = store.releaseTicket(slug, review.ref, agentId, { status: 'done', source: 'test' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'review_tree_unobservable');
  assert.ok(refused.message.includes('technical_blocker'), refused.message);
  assert.equal(store.getTicket(slug, review.ref).status, 'doing');
});
