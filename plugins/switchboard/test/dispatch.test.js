'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GATEWAY_SPAWN_MODEL, gatewayDispatch, nativeDispatch } = require('../lib/dispatch.js');

test('creates provider-neutral dispatch results for native Claude routes', () => {
  assert.deepEqual(nativeDispatch('sonnet'), {
    kind: 'native',
    spawnModel: 'sonnet',
  });
});

test('creates a canonical Switchboard marker for Codex Gateway routes', () => {
  assert.deepEqual(gatewayDispatch('gpt-5.6-terra', 'high'), {
    kind: 'gateway-marker',
    spawnModel: GATEWAY_SPAWN_MODEL,
    dispatchModel: 'gpt-5.6-terra',
    marker: '[switchboard-route model=gpt-5.6-terra effort=high]',
  });
});

test('rejects unsafe gateway marker values', () => {
  assert.throws(() => gatewayDispatch('GPT-5.6-terra', 'high'), /marker-safe/);
  assert.throws(() => gatewayDispatch('gpt-5.6-terra', 'fast'), /marker-safe/);
});
