'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLAIM_REFUSAL_MESSAGES, claimRefusalMessage, routingDisabledMessage } = require('../lib/refusal-guidance.js');

test('claim refusal guidance always gives an actionable next step', () => {
  for (const [reason, message] of Object.entries(CLAIM_REFUSAL_MESSAGES)) {
    assert.match(message('SQ-42', { by: 'other-worker', at: '2026-07-20T00:00:00.000Z' }), /sidequest [a-z]+|--[a-z]+|direct:true/i, reason);
  }
});

test('dispatch-required guidance names both routed and direct claim paths', () => {
  const message = claimRefusalMessage('dispatch_required', 'SQ-42');
  assert.match(message, /dispatch/i);
  assert.match(message, /--direct/i);
  assert.match(message, /direct:true/i);
});

test('routing-disabled guidance names the enabled and direct paths', () => {
  const message = routingDisabledMessage('SQ-42');
  assert.match(message, /sidequest routing enabled/i);
  assert.match(message, /sidequest claim SQ-42 --direct/i);
});
