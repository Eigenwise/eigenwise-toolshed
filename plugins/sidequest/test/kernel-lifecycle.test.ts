import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubmissionAdmissionFacts } from '../src/lib/kernel/submission';

const kernel = require('../src/lib/kernel/index.ts');
const submission = require('../src/lib/kernel/submission.ts');

function admissionFacts(source: string, value: string): SubmissionAdmissionFacts {
  return {
    ticket: { ref: 'SQ-1916' },
    authority: { authority: { actor: 'executor', operation: 'submit' }, claimOwner: 'executor', submittedOwner: null, terminal: false, allowSubmittedOwner: false },
    completion: { complete: true },
    verification: { result: { kind: 'attestation', status: 'passed', evidence: 'verified submission' }, expectedEvidence: null },
    candidate: { source, value, observedAt: '2026-08-14T00:00:00.000Z' },
    baseline: { candidateExists: true, containsCandidate: true },
    surfaces: { declared: ['docs/change.md'], admitted: ['docs/change.md'], changed: ['docs/change.md'], pending: [] },
    duplicate: { identity: null },
  };
}

test('kernel transitions artifact attempts through the full project-neutral lifecycle', () => {
  const baseline = { revision: { source: 'wiki', value: 'revision-4', observedAt: '2026-08-13T00:00:00.000Z' }, purpose: 'dispatch' };
  const requirement = kernel.verificationRequirement({ kind: 'schema', evidence: 'schema fixture output', command: 'node scripts/check-schema.mjs' });
  let attempt = kernel.prepareAttempt(baseline, { actor: 'editor', operation: 'prepare' }, undefined, requirement);
  assert.deepEqual(attempt.verificationRequirement, requirement);
  for (const event of ['launch', 'bind', 'claim', 'start_work', 'verify', 'submit', 'assemble', 'integrate', 'close']) attempt = kernel.transitionAttempt(attempt, event);
  assert.equal(attempt.state, 'closed');
});

test('kernel keeps host binding separate from claim-token compatibility binding', () => {
  const baseline = { revision: { source: 'wiki', value: 'revision-4', observedAt: '2026-08-13T00:00:00.000Z' }, purpose: 'dispatch' };
  const prepared = kernel.prepareAttempt(baseline, { actor: 'editor', operation: 'prepare' });
  assert.equal(kernel.reduceAttempt(prepared, ['launch', 'claim']).code, 'invalid_transition');
  assert.equal(kernel.transitionAttempt(prepared, 'bind').code, 'invalid_transition');
  assert.equal(kernel.transitionAttempt(prepared, 'bind_claim_token').state, 'bound');
  assert.equal(kernel.reduceAttempt(prepared, ['launch', 'bind_claim_token', 'claim']).state, 'claimed');
});
test('kernel gives direct work a claim path without executor launch or binding', () => {
  const baseline = { revision: { source: 'document', value: 'revision-5', observedAt: '2026-08-13T00:00:00.000Z' }, purpose: 'dispatch' };
  const attempt = kernel.transitionAttempt(kernel.prepareDirectAttempt(baseline, { actor: 'editor', operation: 'claim' }), 'claim_direct');
  assert.equal(attempt.state, 'claimed');
  assert.equal(attempt.execution, 'direct');
  const direct = kernel.prepareDirectAttempt(baseline, { actor: 'editor', operation: 'claim' });
  for (const event of ['launch', 'bind', 'bind_claim_token', 'claim']) {
    assert.equal(kernel.transitionAttempt(direct, event).code, 'invalid_transition');
  }
  assert.equal(kernel.transitionAttempt(kernel.prepareAttempt(baseline, { actor: 'executor', operation: 'prepare' }), 'claim_direct').code, 'invalid_transition');
});

test('kernel admits Git, wiki, vault, and research revisions through one decision', () => {
  for (const [source, value] of [['git', 'a'.repeat(40)], ['wiki', 'wiki-42'], ['docs-vault', 'note-7'], ['research-collection', 'collection-3']] as const) {
    const decision = submission.decideSubmissionAdmission(admissionFacts(source, value));
    assert.deepEqual(decision, { ok: true, diagnostics: [] });
  }
});

test('kernel preserves auto-release recovery without changing unclaimed guidance', () => {
  const unclaimed = submission.decideSubmissionAdmission({
    ...admissionFacts('git', 'a'.repeat(40)),
    authority: { authority: { actor: 'executor', operation: 'submit' }, claimOwner: null, submittedOwner: null, terminal: false, allowSubmittedOwner: false },
  });
  const released = submission.decideSubmissionAdmission({
    ...admissionFacts('git', 'a'.repeat(40)),
    authority: {
      authority: { actor: 'executor', operation: 'submit' },
      claimOwner: null,
      submittedOwner: null,
      claimReleaseDiagnostic: { code: 'not_claimed', message: 'SQ-1916 was auto-released. Recovery: dispatch again.', retryable: true },
      terminal: false,
      allowSubmittedOwner: false,
    },
  });

  assert.equal(unclaimed.ok, false);
  assert.equal(released.ok, false);
  assert.equal(unclaimed.diagnostics[0].message, 'submit: refused SQ-1916; a held claim is required.');
  assert.equal(released.diagnostics[0].message, 'SQ-1916 was auto-released. Recovery: dispatch again.');
});


test('kernel returns every retryable submission diagnostic without mutating facts', () => {
  const originalFacts = admissionFacts('wiki', 'wiki-42');
  const facts: SubmissionAdmissionFacts = {
    ...originalFacts,
    verification: { result: { kind: 'attestation', status: 'failed_check', evidence: '' }, expectedEvidence: null, diagnostic: { code: 'invalid_verify', message: 'evidence is missing' } },
    surfaces: { ...originalFacts.surfaces, pending: ['docs/change.md'] },
  };
  const decision = submission.decideSubmissionAdmission(facts);
  assert.equal(decision.ok, false);
  assert.equal(decision.retryable, true);
  assert.deepEqual(decision.diagnostics.map((diagnostic: any) => diagnostic.code), ['invalid_verify', 'dirty_scope']);
  assert.deepEqual(facts.surfaces.pending, ['docs/change.md']);
  assert.deepEqual(originalFacts.surfaces.pending, []);
});

test('kernel export surface does not claim inline eligibility authority', () => {
  assert.equal('inlineEligibility' in kernel, false);
  assert.match(kernel.transitionAttempt({ state: 'closed' }, 'claim').code, /invalid_transition/);
});
