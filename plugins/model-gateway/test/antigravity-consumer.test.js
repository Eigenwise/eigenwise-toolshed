'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment } = require('./support.js');
const home = isolateInProcessGatewayEnvironment(test);
process.env.SIDEQUEST_HOME = path.join(home, 'sidequest');
process.env.SIDEQUEST_CLAUDE_HOME = path.join(home, '.claude');
process.env.SIDEQUEST_AGENTS_DIR = path.join(home, 'agents');
process.env.SIDEQUEST_DISCOVERY_DIRS = path.join(home, 'external-catalog');
const { buildCatalog } = require('../lib/commands.js');
const discovery = require('../../sidequest/lib/discovery.js');
const { createRouting } = require('../../sidequest/lib/store/routing.js');
const { renderExecAgent, workflowRecipe } = require('../../sidequest/lib/agentsync.js');
const { tiers, picker } = require('./fixtures/antigravity.js');
const catalogFile = path.join(process.env.SIDEQUEST_DISCOVERY_DIRS, 'model-gateway', 'catalog.json');

let publication = 0;
function publish(readiness) {
  fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
  const catalog = buildCatalog(tiers.map(picker), { antigravity: readiness });
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  // The real consumer caches by mtime+size; give each synthetic publication a
  // distinct timestamp even on coarse filesystems and equal-length state names.
  publication++;
  fs.utimesSync(catalogFile, new Date(), new Date(Date.now() + publication * 1000));
  return catalog;
}

test('committed Sidequest generic consumer keeps all exact AGY picker ids, pinned executors and reported-model identity', () => {
  const catalog = publish({ ready: true, state: 'ready', message: 'Local readiness does not verify Google access.' });
  const routing = createRouting({ discoverExternalModels: discovery.discoverExternalModels });
  const models = discovery.discoverExternalModels();
  assert.deepEqual(models.map((row) => row.id), tiers.map(picker));
  assert.equal(models[1].slug, 'antigravity-gemini-4-argo-ff064f');
  for (const row of catalog.models) {
    const exec = routing.resolveExec(row.slug, 'high');
    assert.equal(exec.backend, 'antigravity');
    assert.equal(exec.spawnId, row.id);
    assert.equal(exec.apiModel, row.id);
    assert.equal(exec.dispatchModel, undefined, 'AGY must not join the legacy marker/shim providers');
    assert.equal(routing.normalizeReportedModel(row.id), row.slug);
    const definition = renderExecAgent({ name: exec.agent, effort: exec.effort, modelId: exec.spawnId });
    assert.match(definition, new RegExp(`^model: ${row.id}$`, 'm'));
    assert.doesNotMatch(definition, /^model: claude-codex-auto$/m);
    const recipe = workflowRecipe({ project: 'fixture', id: 'fixture', name: 'Fixture' }, { exec, model: row.slug, effort: 'high' });
    assert.deepEqual(recipe.agent, { model: null, subagentType: exec.agent, promptPrefix: '' });
    assert.equal(recipe.effortCarrier, 'definition');
    assert.equal(recipe.research, null, 'current Sidequest intentionally has no research recipe for discovered non-shim providers');
    const generated = fs.readFileSync(path.join(process.env.SIDEQUEST_AGENTS_DIR, `${exec.agent}.md`), 'utf8');
    assert.match(generated, new RegExp(`^model: ${row.id}$`, 'm'));
  }
});

test('schema4 safe AGY readiness state strings hide unready rows in the actual generic consumer', () => {
  for (const state of ['disabled', 'auth-missing', 'auth-invalid', 'auth-unreadable', 'configuration-invalid', 'project-missing', 'unknown-version', 'transport-error']) {
    publish({ ready: false, state, message: `Antigravity ${state}; local only.` });
    assert.deepEqual(discovery.discoverExternalModels(), []);
    assert.deepEqual(discovery.providerReadiness('antigravity'), { provider: 'antigravity', ready: false, state, message: `Antigravity ${state}; local only.` });
  }
});
