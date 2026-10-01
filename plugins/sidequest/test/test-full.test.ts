import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runnerModuleUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'test-full.mjs')).href;
const pluginRoot = path.join(__dirname, '..');

function loadBudgetHelpers() {
  const script = `
    import {
      calculateTestConcurrency,
      calculateTestPhaseTimeoutMilliseconds,
      describePhaseFailure,
      formatTestPhaseTimeoutError,
      formatTestPhaseWarning,
      formatTestPhaseSummary,
      fullSuiteGatewayCatalog,
    } from ${JSON.stringify(runnerModuleUrl)};
    const describe = (result) => describePhaseFailure('functional', result, 960000, 4, 4);
    console.log(JSON.stringify({
      concurrency: [calculateTestConcurrency(1), calculateTestConcurrency(4), calculateTestConcurrency(12)],
      timeouts: [calculateTestPhaseTimeoutMilliseconds(8), calculateTestPhaseTimeoutMilliseconds(4), calculateTestPhaseTimeoutMilliseconds(2)],
      timeoutError: formatTestPhaseTimeoutError('functional', 960000, 4, 4),
      warning: formatTestPhaseWarning('functional', 800000, 720000, 960000, 4, 4),
      summary: formatTestPhaseSummary('functional', 800000, 720000, 960000, 4, 4),
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
    summary: string;
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
  assert.deepEqual(helpers.timeouts, [1_200_000, 2_400_000, 2_400_000]);
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
      ['codex-gpt-5-6-terra', 'claude-codex-gpt-5-6-terra', 'codex'],
      ['codex-gpt-6-1-sol', 'claude-codex-gpt-6-1-sol', 'codex'],
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
  assert.equal(
    helpers.summary,
    '### Sidequest functional test phase\n- Duration: 800000 ms\n- Warning threshold: 720000 ms\n- Phase budget: 960000 ms\n- Concurrency: 4 on 4 available cores',
  );
});

// SQ-3204: test:files ran the TS loader without ever invoking tsc, so a tsc error in a named
// test file (SQ-3178, SQ-3184) passed every scoped verify and only failed at `npm run test:full`
// or the release cut.
test('test:files fails a named test file that has a type error, instead of only test:full catching it', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const fixture = fs.mkdtempSync(path.join(pluginRoot, 'test', '.test-files-typecheck-'));
  try {
    fs.mkdirSync(path.join(fixture, 'test'));
    fs.writeFileSync(path.join(fixture, 'test', '_sidequest-test-home.ts'), '');
    fs.writeFileSync(path.join(fixture, 'test', 'broken.test.ts'), "const brokenTypeError: number = 'not a number';\nconsole.log(brokenTypeError);\n");
    fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true, skipLibCheck: true, types: ['node'], noEmit: true,
      },
      include: ['test/**/*.ts'],
    }));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      private: true,
      type: 'commonjs',
      scripts: { typecheck: packageJson.scripts.typecheck, 'test:files': packageJson.scripts['test:files'] },
    }));

    const result = spawnSync('npm', ['run', 'test:files', '--', 'test/broken.test.ts'], {
      cwd: fixture, encoding: 'utf8', windowsHide: true, shell: true,
    });

    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /error TS2322/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
