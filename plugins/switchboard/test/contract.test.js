'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../lib/schema.js');
const contract = require('../lib/contract.js');

const category = {
  id: 'spike-investigation',
  name: 'Spike investigation',
  description: 'Timeboxed investigation with findings.',
  contract: 'Record what was tested, ruled out, and recommended.',
  route: { model: 'sonnet', effort: 'high' },
  fallback: { model: 'haiku', effort: null },
  enabled: true,
};

function routed(dispatch) {
  return {
    contractVersion: 1,
    status: 'routed',
    category: { id: category.id, contract: category.contract },
    route: { model: 'sonnet', effort: 'high', source: 'primary' },
    dispatch,
    attempts: [],
    warnings: [],
  };
}

test('defines versioned JSON schemas for the routing boundary', () => {
  assert.equal(schema.ROUTING_CONTRACT_VERSION, 1);
  assert.equal(schema.routingRequestSchema.properties.contractVersion.const, 1);
  assert.equal(schema.routingResultSchema.oneOf[0].properties.status.const, 'routed');
  assert.equal(schema.categoryConfigSchema.required.includes('fallback'), true);
  assert.equal(schema.registryBreadcrumbSchema.properties.name.const, 'switchboard');
  assert.equal(schema.routingPanelSchema.required.includes('availableModels'), true);
});

test('accepts deterministic category requests and complete category rows', () => {
  assert.deepEqual(contract.validateRoutingRequest({
    contractVersion: 1,
    categoryId: category.id,
    projectPath: 'C:/dev/project',
    consumer: 'sidequest',
  }), { valid: true, errors: [] });

  const errors = [];
  contract.validateCategory(category, errors, 'Category');
  assert.deepEqual(errors, []);
  contract.validateCategory(Object.assign({}, category, { fallback: undefined }), errors, 'Category');
  assert.match(errors[0], /must contain a model and effort/);
});

test('accepts native and gateway-marker provider-neutral dispatches', () => {
  assert.deepEqual(contract.validateRoutingResult(routed({ kind: 'native', spawnModel: 'sonnet' })), { valid: true, errors: [] });

  const gateway = routed({
    kind: 'gateway-marker',
    spawnModel: 'claude-codex-auto',
    dispatchModel: 'gpt-5.6-sol',
    marker: '[switchboard-route model=gpt-5.6-sol effort=high]',
  });
  gateway.route.model = 'codex-gpt-5-6-sol';
  assert.deepEqual(contract.validateRoutingResult(gateway), { valid: true, errors: [] });
});

test('keeps consumer executor names out of routing results', () => {
  const result = routed({ kind: 'native', spawnModel: 'sonnet', agent: 'sidequest-exec-high' });
  const checked = contract.validateRoutingResult(result);
  assert.equal(checked.valid, false);
  assert.match(checked.errors.join('\n'), /unsupported fields/);
});

test('models fallback attempts and unrouted explanations', () => {
  const result = routed({ kind: 'native', spawnModel: 'sonnet' });
  result.route.source = 'category-fallback';
  result.attempts = [{
    source: 'primary',
    route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    reason: 'Model is unavailable.',
  }];
  assert.deepEqual(contract.validateRoutingResult(result), { valid: true, errors: [] });

  assert.deepEqual(contract.validateRoutingResult({
    contractVersion: 1,
    status: 'unrouted',
    category: null,
    attempts: [],
    warnings: ['Switchboard routing contract is unavailable.'],
  }), { valid: true, errors: [] });
});

test('builds registry breadcrumbs and reusable routing-panel data', () => {
  const breadcrumb = contract.createRegistryBreadcrumb({ root: 'C:/plugins/switchboard', version: '1.0.0' });
  assert.deepEqual(contract.validateRegistryBreadcrumb(breadcrumb), { valid: true, errors: [] });

  const panel = contract.routingPanelData({
    categories: [category],
    globalFallback: { model: 'sonnet', effort: 'medium' },
    availableModels: [{ model: 'sonnet', available: true }],
    warnings: ['Gateway catalog is stale.'],
  });
  assert.equal(panel.contractVersion, 1);
  assert.deepEqual(panel.categories, [category]);
});
