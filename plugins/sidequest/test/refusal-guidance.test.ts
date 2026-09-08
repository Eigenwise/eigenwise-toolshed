import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

interface ClaimIdentity {
  by?: string;
  at?: string;
}

interface ClaimContext extends ClaimIdentity {
  claim?: ClaimIdentity;
  submission?: ClaimIdentity;
}

type RefusalMessage = (ref: string, claim: ClaimContext) => string;

const { CLAIM_REFUSAL_MESSAGES, claimRefusalMessage, routingDisabledMessage } = require('../lib/refusal-guidance.js') as {
  CLAIM_REFUSAL_MESSAGES: Record<string, RefusalMessage>;
  claimRefusalMessage(reason: string, ref: string, claim?: ClaimContext): string;
  routingDisabledMessage(ref: string): string;
};

test('claim refusal guidance always gives an actionable next step', () => {
  for (const [reason, message] of Object.entries(CLAIM_REFUSAL_MESSAGES)) {
    assert.match(message('SQ-42', { by: 'other-worker', at: '2026-07-20T00:00:00.000Z' }), /sidequest [a-z]+|--[a-z]+|direct:true|token file/i, reason);
  }
});

test('terminal claim guidance names immediate safe recovery', () => {
  const message = claimRefusalMessage('terminal_claim_takeover_required', 'SQ-42');
  assert.match(message, /should already have been released/i);
  assert.match(message, /sidequest pulse SQ-42/);
  assert.match(message, /Do not wait for an idle timeout/i);
});

test('not-owner guidance separates a live claim from a parked submission', () => {
  const liveClaim = claimRefusalMessage('not_owner', 'SQ-42', { by: 'other-worker', claim: { by: 'other-worker' } });
  assert.match(liveClaim, /live claim/i);
  assert.match(liveClaim, /Ask the claim holder to release/i);
  assert.doesNotMatch(liveClaim, /--by <claim-owner>|--by other-worker/i);

  const parkedSubmission = claimRefusalMessage('not_owner', 'SQ-42', { submission: { by: 'terminal-producer' } });
  assert.match(parkedSubmission, /parked submission/i);
  assert.match(parkedSubmission, /producer is terminal/i);
  assert.match(parkedSubmission, /publish it, use `sidequest rework SQ-42`/i);
  assert.match(parkedSubmission, /do not ask it to release or resume/i);
  assert.doesNotMatch(parkedSubmission, /Ask the candidate owner/i);
  assert.doesNotMatch(parkedSubmission, /sidequest release SQ-42/i);
});

test('unbound dispatch guidance tells an executor to present its prepared token', () => {
  const message = claimRefusalMessage('unbound_dispatch', 'SQ-42');
  assert.match(message, /dispatched token file/i);
  assert.match(message, /binds the claiming runtime/i);
  assert.match(message, /comment the refusal evidence and release SQ-42 with kind `technical_blocker`/i);
  assert.match(message, /Do not hand a command to the user/i);
  assert.doesNotMatch(message, /Do not.*token/i);
});

test('dispatch-required guidance names both routed and direct claim paths', () => {
  const message = claimRefusalMessage('dispatch_required', 'SQ-42');
  assert.match(message, /dispatch/i);
  assert.match(message, /--direct/i);
  assert.match(message, /direct:true/i);
});

test('bound-candidate guidance sends a failed review to the oracle instead of a rejection', () => {
  const message = claimRefusalMessage('candidate_review_locked', 'SQ-42');
  assert.match(message, /bound to a review-audit ticket/i);
  assert.match(message, /--kind oracle/);
  assert.match(message, /oracle accepts that defect conclusion/i);
  assert.match(message, /integrated repair can supersede/i);
  assert.doesNotMatch(message, /sidequest rework/i);
});

test('submitted guidance separates unbound rework from a locked bound candidate', () => {
  const message = claimRefusalMessage('submitted', 'SQ-42');
  assert.match(message, /While it is UNBOUND/);
  assert.match(message, /rework, clear, reclaim, and amendment all refuse without writing/i);
  assert.match(message, /kind `oracle`/);
});

test('routing-disabled guidance names the enabled and direct paths', () => {
  const message = routingDisabledMessage('SQ-42');
  assert.match(message, /sidequest routing enabled/i);
  assert.match(message, /sidequest claim SQ-42 --direct/i);
});
