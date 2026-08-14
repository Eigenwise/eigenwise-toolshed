import test from 'node:test';
import assert from 'node:assert/strict';

const sourceRevisionCapability = require('../src/lib/source-revision-capability.ts');

const candidate = Object.freeze({ source: 'git', value: 'delivered-commit', observedAt: '2026-08-14T00:00:00.000Z' });
const integrationBaseline = Object.freeze({
  revision: Object.freeze({ source: 'git', value: 'current-integration-tip', observedAt: '2026-08-14T00:01:00.000Z' }),
  purpose: 'submission',
});

test('source revision capability resolves the current integration revision at action time', () => {
  const project = `source-revision-current-tip-${process.pid}-${Date.now()}`;
  let currentIntegrationTip = 'previous-integration-tip';
  const unregister = sourceRevisionCapability.registerSourceRevisionCapability(project, (resolvedCandidate: any, baseline: any) => ({
    candidateExists: resolvedCandidate.value === candidate.value,
    containsCandidate: baseline.revision.value === currentIntegrationTip,
  }));
  try {
    currentIntegrationTip = integrationBaseline.revision.value;
    const facts = sourceRevisionCapability.sourceRevisionAdapterFacts(project, candidate, integrationBaseline);
    assert.ok(facts, 'the authority returns a branded immutable resolution');
    assert.equal(facts.baseline?.candidateExists, true, 'the authority resolves the delivered candidate');
    assert.equal(facts.baseline?.containsCandidate, true, 'the authority uses the integration tip available at closure time');
    assert.deepEqual(facts.dispatchBaseline, integrationBaseline, 'the closure retains the exact integration revision it checked');
    assert.equal(sourceRevisionCapability.isSourceRevisionAdapterFacts(facts), true, 'only authority-produced facts can cross the lifecycle boundary');
  } finally {
    unregister();
  }
});
