'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CATEGORIES } = require('../lib/category-defaults.js');
const { normalizeCategory, normalizeRoute, resolveCategories } = require('../lib/categories.js');

function category(id, route = { model: 'sonnet', effort: 'high' }) {
  return {
    id,
    name: id,
    description: `${id} description`,
    contract: `${id} contract`,
    route,
    fallback: null,
    enabled: true,
  };
}

test('ships the category taxonomy owned by Switchboard', () => {
  const ids = DEFAULT_CATEGORIES.map((row) => row.id);
  assert.equal(ids.length, 17);
  assert.deepEqual(ids, [
    'architecture-design', 'codebase-exploration', 'dataviz', 'debugging', 'deep-research',
    'docs-writing', 'general', 'coding.hard', 'mechanical', 'review-audit', 'security-audit',
    'spike-investigation', 'coding.normal', 'coding.easy', 'testing', 'ui-frontend', 'web-research',
  ]);
  assert.equal(DEFAULT_CATEGORIES.find((row) => row.id === 'coding.hard').route.model, 'codex-gpt-5-6-sol');
});

test('normalizes complete category rows and rejects incomplete routes', () => {
  assert.deepEqual(normalizeRoute({ model: ' SONNET ', effort: 'HIGH' }), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(normalizeRoute({ model: 'haiku', effort: null }), { model: 'haiku', effort: null });
  assert.equal(normalizeRoute({ model: 'sonnet', effort: 'turbo' }), null);
  assert.equal(normalizeCategory(Object.assign(category('broken'), { fallback: undefined })), null);
});

test('applies global and project category overlays by category id', () => {
  const shipped = [category('general'), category('alpha'), category('remove-me')];
  const global = {
    alpha: { route: { model: 'opus', effort: 'high' } },
    custom: category('custom', { model: 'haiku', effort: null }),
    'remove-me': null,
  };
  const project = {
    alpha: { kind: 'OVERRIDE', data: { contract: 'project contract' } },
    custom: { kind: 'DISABLE', data: {} },
    local: { kind: 'ADD', data: category('local') },
    detached: { kind: 'DETACH', data: category('detached', { model: 'fable', effort: 'xhigh' }) },
  };

  const resolved = resolveCategories({ shipped, global, project });
  assert.deepEqual(resolved.byId.alpha.route, { model: 'opus', effort: 'high' });
  assert.equal(resolved.byId.alpha.contract, 'project contract');
  assert.equal(resolved.byId.custom.enabled, false);
  assert.equal(resolved.byId['remove-me'].enabled, false);
  assert.equal(resolved.states.alpha, 'customized');
  assert.equal(resolved.states.custom, 'disabled');
  assert.equal(resolved.states.local, 'added');
  assert.equal(resolved.states.detached, 'detached');
});

test('relink leaves the inherited row and general cannot be disabled', () => {
  const shipped = [category('general'), category('alpha')];
  const resolved = resolveCategories({
    shipped,
    global: { alpha: { route: { model: 'opus', effort: 'high' } } },
    project: {
      alpha: { kind: 'RELINK' },
      general: { kind: 'DISABLE', data: {} },
      missing: { kind: 'OVERRIDE', data: { contract: 'dangling' } },
    },
  });

  assert.deepEqual(resolved.byId.alpha.route, { model: 'opus', effort: 'high' });
  assert.equal(resolved.byId.general.enabled, true);
  assert.match(resolved.warnings.join('\n'), /general.*cannot be disabled/);
  assert.match(resolved.warnings.join('\n'), /OVERRIDE "missing" has no inherited category/);
});

test('can exclude disabled categories without mutating effective state', () => {
  const resolved = resolveCategories({
    shipped: [category('general'), category('alpha')],
    project: { alpha: null },
    includeDisabled: false,
  });
  assert.deepEqual(resolved.categories.map((row) => row.id), ['general']);
  assert.equal(resolved.byId.alpha.enabled, false);
});
