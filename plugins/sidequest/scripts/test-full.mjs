import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteEnvironment } from '../../../scripts/release/cut.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(pluginRoot, 'test');
const availableParallelism = os.availableParallelism();
const testConcurrency = Math.min(8, Math.max(2, availableParallelism));
const testPhaseTimeoutMilliseconds = 480_000;
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
    throw new Error(
      `Sidequest ${phase} tests exceeded their ${testPhaseTimeoutMilliseconds}ms phase budget at concurrency ${testConcurrency} on ${availableParallelism} available cores.`,
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Sidequest ${phase} tests exited ${result.status ?? 1}.`);
  // Warn, never throw: a passing run that is merely close to its budget must not
  // become a red build. Turning slowness into a failure is the false red SQ-1537
  // exists to remove.
  if (phaseDurationMilliseconds > testPhaseWarningMilliseconds) {
    console.error(
      `WARNING: Sidequest ${phase} tests completed in ${Math.round(phaseDurationMilliseconds)}ms, over the ${testPhaseWarningMilliseconds}ms warning threshold for their ${testPhaseTimeoutMilliseconds}ms phase budget at concurrency ${testConcurrency} on ${availableParallelism} available cores.`,
    );
  }
}

const suiteTemporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidequest-full-suite-'));
const suiteHomeDirectory = path.join(suiteTemporaryDirectory, 'home');
const suiteClaudeDirectory = path.join(suiteHomeDirectory, '.claude');
const suiteSidequestDirectory = path.join(suiteClaudeDirectory, 'sidequest');
const emptyDiscoveryDirectory = path.join(suiteTemporaryDirectory, 'empty-discovery');
await fs.mkdir(suiteSidequestDirectory, { recursive: true });
await fs.mkdir(emptyDiscoveryDirectory);
const suiteTestEnvironment = {
  ...suiteEnvironment(),
  HOME: suiteHomeDirectory,
  USERPROFILE: suiteHomeDirectory,
  SIDEQUEST_HOME: suiteSidequestDirectory,
  SIDEQUEST_CLAUDE_HOME: suiteClaudeDirectory,
  TMPDIR: suiteTemporaryDirectory,
  TMP: suiteTemporaryDirectory,
  TEMP: suiteTemporaryDirectory,
  SIDEQUEST_DISCOVERY_DIRS: emptyDiscoveryDirectory,
};

try {
  runTests('functional', testFiles, suiteTestEnvironment);
} finally {
  await fs.rm(suiteTemporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
