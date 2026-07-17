'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function consumeRoutingResult(value) {
  if (!hasOnlyKeys(value, value && value.status === 'routed'
    ? ['contractVersion', 'status', 'category', 'route', 'dispatch', 'attempts', 'warnings']
    : ['contractVersion', 'status', 'category', 'attempts', 'warnings'])) return { ok: false, reason: 'invalid-result-fields' };
  if (value.contractVersion !== 1) return { ok: false, reason: 'incompatible-contract-version' };
  if (!['routed', 'unrouted'].includes(value.status)) return { ok: false, reason: 'invalid-status' };
  if (!Array.isArray(value.attempts) || !Array.isArray(value.warnings)) return { ok: false, reason: 'invalid-diagnostics' };
  if (value.status === 'unrouted') return { ok: true, status: 'unrouted' };
  if (!hasOnlyKeys(value.route, ['model', 'effort', 'source']) || !isText(value.route.model) || !isText(value.route.effort)) return { ok: false, reason: 'invalid-route' };
  if (!hasOnlyKeys(value.dispatch, value.dispatch && value.dispatch.kind === 'native'
    ? ['kind', 'spawnModel']
    : ['kind', 'spawnModel', 'dispatchModel', 'marker'])) return { ok: false, reason: 'consumer-executor-leak' };
  if (value.dispatch.kind === 'native' && isText(value.dispatch.spawnModel)) return { ok: true, status: 'routed' };
  if (value.dispatch.kind === 'gateway-marker' && isText(value.dispatch.spawnModel) && isText(value.dispatch.dispatchModel) && value.dispatch.marker === `[switchboard-route model=${value.dispatch.dispatchModel} effort=${value.route.effort}]`) return { ok: true, status: 'routed' };
  return { ok: false, reason: 'invalid-dispatch' };
}

function result(dispatch) {
  return {
    contractVersion: 1,
    status: 'routed',
    category: { id: 'general', contract: 'Work the assigned task.' },
    route: { model: 'sonnet', effort: 'high', source: 'primary' },
    dispatch,
    attempts: [],
    warnings: [],
  };
}

test('consumer fixture: native result', () => {
  assert.deepEqual(consumeRoutingResult(result({ kind: 'native', spawnModel: 'sonnet' })), { ok: true, status: 'routed' });
});

test('consumer fixture: gateway-marker result', () => {
  const fixture = result({
    kind: 'gateway-marker',
    spawnModel: 'claude-codex-auto',
    dispatchModel: 'gpt-5.6-sol',
    marker: '[switchboard-route model=gpt-5.6-sol effort=high]',
  });
  fixture.route.model = 'codex-gpt-5-6-sol';
  assert.deepEqual(consumeRoutingResult(fixture), { ok: true, status: 'routed' });
});

test('consumer fixture: unrouted result', () => {
  assert.deepEqual(consumeRoutingResult({
    contractVersion: 1,
    status: 'unrouted',
    category: null,
    attempts: [],
    warnings: ['Switchboard is not installed.'],
  }), { ok: true, status: 'unrouted' });
});

test('consumer fixture: fallback-attempt result', () => {
  const fixture = result({ kind: 'native', spawnModel: 'sonnet' });
  fixture.route.source = 'category-fallback';
  fixture.attempts = [{
    source: 'primary',
    route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    reason: 'Model is unavailable.',
  }];
  assert.deepEqual(consumeRoutingResult(fixture), { ok: true, status: 'routed' });
});

test('consumer fixture: incompatible-version result', () => {
  const fixture = result({ kind: 'native', spawnModel: 'sonnet' });
  fixture.contractVersion = 2;
  assert.deepEqual(consumeRoutingResult(fixture), { ok: false, reason: 'incompatible-contract-version' });
});

test('consumer fixture: rejects consumer-specific executor names', () => {
  assert.deepEqual(consumeRoutingResult(result({ kind: 'native', spawnModel: 'sonnet', agent: 'sidequest-exec-high' })), { ok: false, reason: 'consumer-executor-leak' });
});
