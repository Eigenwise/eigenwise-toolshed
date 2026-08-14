import test from 'node:test';
import assert from 'node:assert/strict';

const kernel = require('../src/lib/kernel/index.ts');

test('kernel transitions artifact attempts through the full project-neutral lifecycle', () => {
  const baseline = { revision: { source: 'wiki', value: 'revision-4', observedAt: '2026-08-13T00:00:00.000Z' }, purpose: 'dispatch' };
  let attempt = kernel.prepareAttempt(baseline, { actor: 'editor', operation: 'prepare' });
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

test('inline eligibility only permits a narrow pre-attempt request', () => {
  assert.equal(kernel.inlineEligibility({ namedFiles: ['notes/plan.md'], requestedResult: 'Fix the heading.' }).eligible, true);
  assert.deepEqual(kernel.inlineEligibility({ namedFiles: ['notes/plan.md'], requestedResult: 'Fix it.', attempt: { state: 'working' } }).reasons, ['attempt_exists']);
  assert.match(kernel.transitionAttempt({ state: 'closed' }, 'claim').code, /invalid_transition/);
});
