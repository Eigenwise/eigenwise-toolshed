'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelCatalog } = require('../lib/catalog.js');
const { resolveCategoryRoute } = require('../lib/resolve.js');
const { resolveRoutingRequest, validateRoutingResult } = require('../lib/contract.js');

function category(id, route, fallback = null, enabled = true) {
  return {
    id,
    name: id,
    description: `${id} description`,
    contract: `${id} contract`,
    route,
    fallback,
    enabled,
  };
}

function request(categoryId = 'focused') {
  return { contractVersion: 1, categoryId, consumer: 'test' };
}

function gatewayCatalog() {
  return {
    schemaVersion: 3,
    source: 'codex-gateway',
    updatedAt: '2026-07-18T00:00:00.000Z',
    models: [{ slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
  };
}

test('resolves contract v1 requests through the native primary route', () => {
  const result = resolveRoutingRequest(request(), {
    categories: [category('focused', { model: 'sonnet', effort: 'high' })],
  });
  assert.equal(result.status, 'routed');
  assert.deepEqual(result.route, { model: 'sonnet', effort: 'high', source: 'primary' });
  assert.deepEqual(result.dispatch, { kind: 'native', spawnModel: 'sonnet' });
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(validateRoutingResult(result), { valid: true, errors: [] });
});

test('resolves catalog-backed primary routes with a gateway marker', () => {
  const result = resolveRoutingRequest(request(), {
    categories: [category('focused', { model: 'codex-gpt-5-6-sol', effort: 'xhigh' })],
    gatewayCatalog: gatewayCatalog(),
  });
  assert.equal(result.status, 'routed');
  assert.equal(result.route.source, 'primary');
  assert.deepEqual(result.dispatch, {
    kind: 'gateway-marker',
    spawnModel: 'claude-codex-auto',
    dispatchModel: 'gpt-5.6-sol',
    marker: '[switchboard-route model=gpt-5.6-sol effort=xhigh]',
  });
});

test('walks primary, category fallback, global fallback, then hard default', () => {
  const focused = category(
    'focused',
    { model: 'missing-model', effort: 'high' },
    { model: 'haiku', effort: 'high' },
  );
  const result = resolveCategoryRoute({
    categoryId: 'focused',
    categories: { focused },
    globalFallback: { model: 'other-missing', effort: 'medium' },
    catalog: createModelCatalog(),
  });

  assert.equal(result.status, 'routed');
  assert.deepEqual(result.route, { model: 'sonnet', effort: 'high', source: 'hard-default' });
  assert.deepEqual(result.attempts.map((attempt) => attempt.source), ['primary', 'category-fallback', 'global-fallback']);
  assert.match(result.warnings.join('\n'), /using hardwired sonnet\/high/);
  assert.deepEqual(validateRoutingResult(result), { valid: true, errors: [] });
});

test('returns unrouted when user caps exhaust the full chain', () => {
  const focused = category('focused', { model: 'opus', effort: 'high' });
  const result = resolveCategoryRoute({
    categoryId: 'focused',
    categories: { focused },
    catalog: createModelCatalog({ userAllowedModels: [] }),
  });
  assert.equal(result.status, 'unrouted');
  assert.deepEqual(result.attempts.map((attempt) => attempt.source), ['primary', 'hard-default']);
  assert.match(result.warnings.join('\n'), /Every route in the fallback chain is unavailable/);
  assert.deepEqual(validateRoutingResult(result), { valid: true, errors: [] });
});

test('returns unrouted for missing, disabled, and incompatible requests', () => {
  const focused = category('focused', { model: 'sonnet', effort: 'high' }, null, false);
  assert.equal(resolveRoutingRequest(request('missing'), { categories: [focused] }).status, 'unrouted');
  assert.match(resolveRoutingRequest(request(), { categories: [focused] }).warnings[0], /disabled/);

  const incompatible = resolveRoutingRequest({ contractVersion: 2, categoryId: 'focused' }, { categories: [focused] });
  assert.equal(incompatible.status, 'unrouted');
  assert.match(incompatible.warnings.join('\n'), /Unsupported routing contract version/);
  assert.deepEqual(validateRoutingResult(incompatible), { valid: true, errors: [] });
});

test('honors category overlays and config routing guards without classifying text', () => {
  const shipped = [
    category('general', { model: 'sonnet', effort: 'high' }),
    category('focused', { model: 'opus', effort: 'high' }),
  ];
  const result = resolveRoutingRequest(request(), {
    shippedCategories: shipped,
    globalCategories: { focused: { route: { model: 'sonnet', effort: 'medium' } } },
    projectCategories: { focused: { contract: 'project contract' } },
  });
  assert.deepEqual(result.route, { model: 'sonnet', effort: 'medium', source: 'primary' });
  assert.deepEqual(result.category, { id: 'focused', contract: 'project contract' });

  const disabled = resolveRoutingRequest(request(), { config: { schemaVersion: 1, routing: false } });
  assert.equal(disabled.status, 'unrouted');
  assert.match(disabled.warnings[0], /routing is disabled/);

  const textInput = resolveRoutingRequest({ contractVersion: 1, categoryId: 'focused', text: 'Classify me' }, { categories: shipped });
  assert.equal(textInput.status, 'unrouted');
  assert.match(textInput.warnings.join('\n'), /known fields/);
});

test('rejects future config schemas before resolving a route', () => {
  const result = resolveRoutingRequest(request(), {
    config: { schemaVersion: 2, routing: true },
    categories: [category('focused', { model: 'sonnet', effort: 'high' })],
  });
  assert.equal(result.status, 'unrouted');
  assert.match(result.warnings[0], /schemaVersion 2 is unsupported/);
});
