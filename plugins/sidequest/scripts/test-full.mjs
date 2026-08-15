import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suiteEnvironment } from '../../../scripts/release/cut.mjs';

const require = createRequire(import.meta.url);
const { STARTER_GATEWAY_MODEL_SLUGS } = require('../lib/category-defaults.js');
const { runOwnedPhase } = require('./owned-process-tree.js');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
const baselineTestPhaseTimeoutMilliseconds = 480_000;
const maximumTestPhaseTimeoutMilliseconds = 1_200_000;

export function fullSuiteGatewayCatalog() {
  return {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    source: 'sidequest-full-suite',
    providers: {
      codex: {
        ready: true,
        state: 'ready',
        message: 'The full-suite fixture provides the Codex dispatch capability.',
      },
    },
    models: STARTER_GATEWAY_MODEL_SLUGS.map((slug) => ({
      slug,
      id: `claude-${slug}`,
      label: slug,
      provider: 'codex',
    })),
  };
}

export function calculateTestConcurrency(availableParallelism) {
  return Math.min(maximumTestConcurrency, Math.max(minimumTestConcurrency, availableParallelism));
}

export function calculateTestPhaseTimeoutMilliseconds(testConcurrency) {
  const concurrencyScale = maximumTestConcurrency / testConcurrency;
  return Math.min(
    maximumTestPhaseTimeoutMilliseconds,
    Math.ceil(baselineTestPhaseTimeoutMilliseconds * concurrencyScale),
  );
}

export function formatTestPhaseTimeoutError(phase, testPhaseTimeoutMilliseconds, testConcurrency, availableParallelism) {
  return `Sidequest ${phase} tests exceeded their ${testPhaseTimeoutMilliseconds}ms phase budget at concurrency ${testConcurrency} on ${availableParallelism} available cores.`;
}

export function formatTestPhaseWarning(
  phase,
  phaseDurationMilliseconds,
  testPhaseWarningMilliseconds,
  testPhaseTimeoutMilliseconds,
  testConcurrency,
  availableParallelism,
) {
  return `WARNING: Sidequest ${phase} tests completed in ${Math.round(phaseDurationMilliseconds)}ms, over the ${testPhaseWarningMilliseconds}ms warning threshold for their ${testPhaseTimeoutMilliseconds}ms phase budget at concurrency ${testConcurrency} on ${availableParallelism} available cores.`;
}

const availableParallelism = os.availableParallelism();
const testConcurrency = calculateTestConcurrency(availableParallelism);
const testPhaseTimeoutMilliseconds = calculateTestPhaseTimeoutMilliseconds(testConcurrency);
const testPhaseWarningMilliseconds = testPhaseTimeoutMilliseconds * 0.75;
// Benchmarks live behind `npm run test:perf`. Without this exclusion the glob
// below sweeps them back into the default suite, which is the 23 seconds
// SQ-1387 exists to remove.
const testFiles = (await fs.readdir(testDirectory))
  .filter((name) => name.endsWith('.test.ts') && !name.endsWith('.perf.test.ts'))
  .sort()
  .map((name) => path.join(testDirectory, name));

// A deadline is a failed phase whatever the root managed to report on its way out.
// Accepting a timeout that happened to carry status 0 is how a killed gate phase passed
// as green in SQ-2050: a root can handle SIGTERM and exit 0, and a phase the clock ended
// never finished its tests.
export function describePhaseFailure(phase, result, phaseTimeoutMilliseconds, concurrency, cores) {
  if (result.timedOut) return formatTestPhaseTimeoutError(phase, phaseTimeoutMilliseconds, concurrency, cores);
  if (result.cleanupError) return `Sidequest ${phase} tests could not be cleaned up: ${result.cleanupError}`;
  if (result.status !== 0) {
    return `Sidequest ${phase} tests exited ${result.status ?? `on signal ${result.signal ?? 'unknown'}`}.`;
  }
  return null;
}

// The phase runs over pipes so its output stays bounded and its tree stays owned, which
// costs the TTY detection node:test uses to pick the readable reporter. Ask for it back
// when a human is watching.
const interactiveReporterArguments = process.stdout.isTTY ? ['--test-reporter=spec'] : [];

async function runTests(phase, files, environment) {
  const phaseStartTime = performance.now();
  const result = await runOwnedPhase({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', './test/_sidequest-test-home.ts', '--test', `--test-concurrency=${testConcurrency}`, ...interactiveReporterArguments, ...files],
    cwd: pluginRoot,
    env: environment,
    timeoutMilliseconds: testPhaseTimeoutMilliseconds,
  });
  const phaseDurationMilliseconds = performance.now() - phaseStartTime;
  if (result.error) throw result.error;
  const failure = describePhaseFailure(phase, result, testPhaseTimeoutMilliseconds, testConcurrency, availableParallelism);
  if (failure) throw new Error(failure);
  // Warn, never throw: a passing run that is merely close to its budget must not
  // become a red build. Turning slowness into a failure is the false red SQ-1537
  // exists to remove.
  if (phaseDurationMilliseconds > testPhaseWarningMilliseconds) {
    console.error(
      formatTestPhaseWarning(
        phase,
        phaseDurationMilliseconds,
        testPhaseWarningMilliseconds,
        testPhaseTimeoutMilliseconds,
        testConcurrency,
        availableParallelism,
      ),
    );
  }
}

async function main() {
  const suiteTemporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidequest-full-suite-'));
  const suiteHomeDirectory = path.join(suiteTemporaryDirectory, 'home');
  const suiteClaudeDirectory = path.join(suiteHomeDirectory, '.claude');
  const suiteSidequestDirectory = path.join(suiteClaudeDirectory, 'sidequest');
  const suiteGatewayCatalogDirectory = path.join(suiteTemporaryDirectory, 'gateway-catalog');
  await fs.mkdir(suiteSidequestDirectory, { recursive: true });
  await fs.mkdir(path.join(suiteGatewayCatalogDirectory, 'model-gateway'), { recursive: true });
  await fs.writeFile(
    path.join(suiteGatewayCatalogDirectory, 'model-gateway', 'catalog.json'),
    JSON.stringify(fullSuiteGatewayCatalog()),
  );
  const suiteTestEnvironment = {
    ...suiteEnvironment(),
    HOME: suiteHomeDirectory,
    USERPROFILE: suiteHomeDirectory,
    SIDEQUEST_HOME: suiteSidequestDirectory,
    SIDEQUEST_CLAUDE_HOME: suiteClaudeDirectory,
    TMPDIR: suiteTemporaryDirectory,
    TMP: suiteTemporaryDirectory,
    TEMP: suiteTemporaryDirectory,
    SIDEQUEST_DISCOVERY_DIRS: suiteGatewayCatalogDirectory,
  };

  try {
    await runTests('functional', testFiles, suiteTestEnvironment);
  } finally {
    await fs.rm(suiteTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
