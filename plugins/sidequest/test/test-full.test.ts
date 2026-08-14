import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runnerModuleUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'test-full.mjs')).href;

function loadBudgetHelpers() {
  const script = `
    import {
      calculateTestConcurrency,
      calculateTestPhaseTimeoutMilliseconds,
      formatTestPhaseTimeoutError,
      formatTestPhaseWarning,
      fullSuiteGatewayCatalog,
    } from ${JSON.stringify(runnerModuleUrl)};
    console.log(JSON.stringify({
      concurrency: [calculateTestConcurrency(1), calculateTestConcurrency(4), calculateTestConcurrency(12)],
      timeouts: [calculateTestPhaseTimeoutMilliseconds(8), calculateTestPhaseTimeoutMilliseconds(4), calculateTestPhaseTimeoutMilliseconds(2)],
      timeoutError: formatTestPhaseTimeoutError('functional', 960000, 4, 4),
      warning: formatTestPhaseWarning('functional', 800000, 720000, 960000, 4, 4),
      gatewayCatalog: fullSuiteGatewayCatalog(),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })) as {
    concurrency: number[];
    timeouts: number[];
    timeoutError: string;
    warning: string;
    gatewayCatalog: {
      schemaVersion: number;
      updatedAt: string;
      providers: { codex: { ready: boolean; state: string; message: string } };
      models: Array<{ slug: string; id: string; provider: string }>;
    };
  };
}

test('full-suite budget scales down-core runners and stays bounded', () => {
  const helpers = loadBudgetHelpers();

  assert.deepEqual(helpers.concurrency, [2, 4, 8]);
  assert.deepEqual(helpers.timeouts, [480000, 960000, 1200000]);
});

test('full-suite catalog supplies the ready Codex capability and every default Codex route', () => {
  const { gatewayCatalog } = loadBudgetHelpers();

  assert.equal(Number.isFinite(Date.parse(gatewayCatalog.updatedAt)), true);
  assert.deepEqual(gatewayCatalog.providers.codex, {
    ready: true,
    state: 'ready',
    message: 'The full-suite fixture provides the Codex dispatch capability.',
  });
  assert.deepEqual(
    gatewayCatalog.models.map((model) => [model.slug, model.id, model.provider]),
    [
      ['codex-gpt-5-6-luna', 'claude-codex-gpt-5-6-luna', 'codex'],
      ['codex-gpt-5-6-sol', 'claude-codex-gpt-5-6-sol', 'codex'],
      ['codex-gpt-5-6-terra', 'claude-codex-gpt-5-6-terra', 'codex'],
    ],
  );
});

test('full-suite budget keeps actionable timeout and warning copy', () => {
  const helpers = loadBudgetHelpers();

  assert.equal(
    helpers.timeoutError,
    'Sidequest functional tests exceeded their 960000ms phase budget at concurrency 4 on 4 available cores.',
  );
  assert.equal(
    helpers.warning,
    'WARNING: Sidequest functional tests completed in 800000ms, over the 720000ms warning threshold for their 960000ms phase budget at concurrency 4 on 4 available cores.',
  );
});
