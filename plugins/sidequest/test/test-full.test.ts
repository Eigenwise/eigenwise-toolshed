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
      describePhaseFailure,
      formatTestPhaseTimeoutError,
      formatTestPhaseWarning,
      fullSuiteGatewayCatalog,
    } from ${JSON.stringify(runnerModuleUrl)};
    const describe = (result) => describePhaseFailure('functional', result, 960000, 4, 4);
    console.log(JSON.stringify({
      concurrency: [calculateTestConcurrency(1), calculateTestConcurrency(4), calculateTestConcurrency(12)],
      timeouts: [calculateTestPhaseTimeoutMilliseconds(8), calculateTestPhaseTimeoutMilliseconds(4), calculateTestPhaseTimeoutMilliseconds(2)],
      timeoutError: formatTestPhaseTimeoutError('functional', 960000, 4, 4),
      warning: formatTestPhaseWarning('functional', 800000, 720000, 960000, 4, 4),
      gatewayCatalog: fullSuiteGatewayCatalog(),
      phaseFailures: {
        timedOutWithStatusZero: describe({ timedOut: true, status: 0, signal: null, cleanupError: null }),
        timedOutAfterKill: describe({ timedOut: true, status: null, signal: 'SIGKILL', cleanupError: null }),
        cleanupFailed: describe({ timedOut: false, status: 0, signal: null, cleanupError: 'The owned process group 42 was still alive.' }),
        cleanupSignalFailed: describe({ timedOut: false, status: 0, signal: null, cleanupError: 'The phase owner could not send SIGTERM to its owned process group: EPERM.' }),
        rootExitedNonZero: describe({ timedOut: false, status: 3, signal: null, cleanupError: null }),
        rootDiedOnSignal: describe({ timedOut: false, status: null, signal: 'SIGSEGV', cleanupError: null }),
        passed: describe({ timedOut: false, status: 0, signal: null, cleanupError: null }),
      },
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })) as {
    concurrency: number[];
    timeouts: number[];
    timeoutError: string;
    warning: string;
    phaseFailures: Record<string, string | null>;
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

test('a timed-out phase fails the full gate whatever status its root reported', () => {
  const { phaseFailures, timeoutError } = loadBudgetHelpers();

  // SQ-2050 shipped `timedOut && status !== 0`, so a root whose SIGTERM handler exited 0
  // passed the gate after the deadline had already killed it mid-suite.
  assert.equal(phaseFailures.timedOutWithStatusZero, timeoutError);
  assert.equal(phaseFailures.timedOutAfterKill, timeoutError);
  assert.equal(phaseFailures.cleanupFailed, 'Sidequest functional tests could not be cleaned up: The owned process group 42 was still alive.');
  assert.equal(phaseFailures.cleanupSignalFailed, 'Sidequest functional tests could not be cleaned up: The phase owner could not send SIGTERM to its owned process group: EPERM.');
  assert.equal(phaseFailures.rootExitedNonZero, 'Sidequest functional tests exited 3.');
  assert.equal(phaseFailures.rootDiedOnSignal, 'Sidequest functional tests exited on signal SIGSEGV.');
  assert.equal(phaseFailures.passed, null);
});

test('full-suite budget keeps actionable timeout and warning copy', () => {
  const helpers = loadBudgetHelpers();

  assert.equal(
    helpers.timeoutError,
    'Sidequest functional tests exceeded their 960000ms phase budget at concurrency 4 on 4 available cores after waiting behind 0 sibling full-suite captures.',
  );
  assert.equal(
    helpers.warning,
    'WARNING: Sidequest functional tests completed in 800000ms, over the 720000ms warning threshold for their 960000ms phase budget at concurrency 4 on 4 available cores.',
  );
});
