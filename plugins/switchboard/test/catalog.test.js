'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelCatalog, parseGatewayCatalog } = require('../lib/catalog.js');

function gatewayCatalog(models = [{ slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' }]) {
  return {
    schemaVersion: 3,
    source: 'codex-gateway',
    updatedAt: '2026-07-18T00:00:00.000Z',
    models,
  };
}

test('native Claude routes remain available without a gateway catalog', () => {
  const catalog = createModelCatalog();
  assert.equal(catalog.status, 'missing');
  assert.equal(catalog.checkRoute({ model: 'sonnet', effort: 'high' }).available, true);
  assert.equal(catalog.checkRoute({ model: 'haiku', effort: null }).available, true);
  assert.match(catalog.checkRoute({ model: 'haiku', effort: 'high' }).reason, /must use a null effort/);
  assert.deepEqual(catalog.dispatchFor(catalog.checkRoute({ model: 'sonnet', effort: 'high' }).entry, 'high'), {
    kind: 'native',
    spawnModel: 'sonnet',
  });
});

test('validates catalog v3 and builds provider-neutral gateway dispatch', () => {
  const catalog = createModelCatalog({ gatewayCatalog: gatewayCatalog() });
  const checked = catalog.checkRoute({ model: 'codex-gpt-5-6-sol', effort: 'xhigh' });
  assert.equal(checked.available, true);
  assert.deepEqual(catalog.dispatchFor(checked.entry, checked.route.effort), {
    kind: 'gateway-marker',
    spawnModel: 'claude-codex-auto',
    dispatchModel: 'gpt-5.6-sol',
    marker: '[switchboard-route model=gpt-5.6-sol effort=xhigh]',
  });
  assert.equal(catalog.models.find((model) => model.model === 'codex-gpt-5-6-sol').available, true);
});

test('rejects future catalogs and malformed model rows without inventing routes', () => {
  assert.deepEqual(parseGatewayCatalog({ schemaVersion: 4, source: 'codex-gateway', models: [] }).entries, []);
  const future = createModelCatalog({ gatewayCatalog: { schemaVersion: 4, source: 'codex-gateway', models: [] } });
  assert.match(future.warnings.join('\n'), /schemaVersion 4 is unsupported/);
  assert.match(future.checkRoute({ model: 'codex-gpt-5-6-sol', effort: 'high' }).reason, /not available/);

  const malformed = createModelCatalog({ gatewayCatalog: gatewayCatalog([{ slug: 'bad slug', id: 'other-model', label: '' }]) });
  assert.match(malformed.warnings.join('\n'), /entry 0 is malformed/);
  assert.match(malformed.checkRoute({ model: 'bad-slug', effort: 'high' }).reason, /not available/);
});

test('intersects user and project model caps so a project cannot widen access', () => {
  const catalog = createModelCatalog({
    userAllowedModels: ['sonnet'],
    projectAllowedModels: ['sonnet', 'opus'],
  });
  assert.equal(catalog.checkRoute({ model: 'sonnet', effort: 'high' }).available, true);
  const opus = catalog.checkRoute({ model: 'opus', effort: 'high' });
  assert.equal(opus.available, false);
  assert.match(opus.reason, /user allowedModels cap/);
});

test('intersects route caps independently from model caps', () => {
  const catalog = createModelCatalog({
    userAllowedModels: ['sonnet'],
    projectAllowedModels: ['sonnet'],
    userAllowedRoutes: [{ model: 'sonnet', effort: 'high' }],
    projectAllowedRoutes: [
      { model: 'sonnet', effort: 'medium' },
      { model: 'sonnet', effort: 'high' },
    ],
  });
  assert.equal(catalog.checkRoute({ model: 'sonnet', effort: 'high' }).available, true);
  const medium = catalog.checkRoute({ model: 'sonnet', effort: 'medium' });
  assert.equal(medium.available, false);
  assert.match(medium.reason, /user allowedRoutes cap/);
});

test('requires an explicit gateway effort', () => {
  const catalog = createModelCatalog({ gatewayCatalog: gatewayCatalog() });
  const checked = catalog.checkRoute({ model: 'codex-gpt-5-6-sol', effort: null });
  assert.equal(checked.available, false);
  assert.match(checked.reason, /requires an explicit effort/);
});
