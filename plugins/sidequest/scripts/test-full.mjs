import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { suiteEnvironment } from '../../../scripts/release/cut.mjs';

const require = createRequire(import.meta.url);
const { DEFAULT_CATEGORIES } = require('../lib/category-defaults.js');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
const minimumTestConcurrency = 2;
const maximumTestConcurrency = 8;
const baselineTestPhaseTimeoutMilliseconds = 480_000;
const maximumTestPhaseTimeoutMilliseconds = 1_200_000;

export function fullSuiteGatewayCatalog() {
  const codexModels = new Set(
    DEFAULT_CATEGORIES
      .flatMap((category) => [category.route, category.fallback])
      .map((route) => route?.model)
      .filter((model) => typeof model === 'string' && model.startsWith('codex-')),
  );
  return {
    schemaVersion: 4,
    source: 'sidequest-full-suite',
    providers: {
      codex: {
        ready: true,
        state: 'ready',
        message: 'The full-suite fixture provides the Codex dispatch capability.',
      },
    },
    models: Array.from(codexModels).sort().map((slug) => ({
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

function runTests(phase, files, environment) {
  const phaseStartTime = performance.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${testConcurrency}`, ...files], {
    cwd: pluginRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: environment,
    timeout: testPhaseTimeoutMilliseconds,
  });
  const phaseDurationMilliseconds = performance.now() - phaseStartTime;
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(formatTestPhaseTimeoutError(phase, testPhaseTimeoutMilliseconds, testConcurrency, availableParallelism));
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Sidequest ${phase} tests exited ${result.status ?? 1}.`);
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
    runTests('functional', testFiles, suiteTestEnvironment);
  } finally {
    await fs.rm(suiteTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
