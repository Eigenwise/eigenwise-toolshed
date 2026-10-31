import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { integrationCaptureEnvironment, phaseBudgetResult, integrationTestBatches, runImportingIntegrationTests, selectIntegrationTests } from '../src/lib/integration-tests.js';
import { pathToFileURL } from 'node:url';
import type { VerificationResult } from '../src/lib/kernel/verification.js';

test('two live captures stretch the integration full-suite phase budget and dead records do not count', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-live-captures-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixture(directory, {
    [`running-captures/000000000000001-${process.pid}-first.json`]: '{}',
    [`running-captures/000000000000002-${process.pid}-second.json`]: '{}',
    'running-captures/000000000000003-2147483647-dead.json': '{}',
    'running-captures/invalid.json': '{}',
  });
  const environment = integrationCaptureEnvironment(directory, { SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: '0' });
  assert.equal(environment.SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT, '2');
  assert.equal(environment.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT, '0');
  const runner = await import(pathToFileURL(path.join(__dirname, '../scripts/test-full.mjs')).href) as { calculateTestPhaseTimeoutMilliseconds(concurrency: number, captures?: number): number };
  assert.equal(runner.calculateTestPhaseTimeoutMilliseconds(8, Number(environment.SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT)), 2_400_000);
  assert.equal(runner.calculateTestPhaseTimeoutMilliseconds(8), 1_200_000);
  fs.rmSync(path.join(directory, 'running-captures'), { recursive: true });
  assert.equal(integrationCaptureEnvironment(directory, {}).SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT, '0');
});

test('ordinary captures register while running and remove records after success or failure', async (context) => {
  const store = require('../lib/store.js');
  const { runOrdinaryCapture, liveVerificationCaptureCount } = require('../lib/verify-capture.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-capture-lifecycle-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const { slug } = store.ensureProject(project);
  const boardDirectory = store.projectDir(slug);
  const scriptPath = path.join(project, 'observe-captures.cjs');
  const captureModule = path.resolve(__dirname, '../lib/verify-capture.js');
  fs.writeFileSync(scriptPath, `const { liveVerificationCaptureCount } = require(${JSON.stringify(captureModule)}); console.log('live=' + liveVerificationCaptureCount(${JSON.stringify(boardDirectory)})); process.exit(Number(process.argv[2]));`);
  assert.equal(liveVerificationCaptureCount(boardDirectory), 0);
  for (const exitCode of [0, 3]) {
    const capture = await runOrdinaryCapture(`"${process.execPath}" "${scriptPath}" ${exitCode}`, project, 30_000, process.env, path.join(project, `capture-${exitCode}.log`), { slug, path: project });
    assert.equal(capture.exitCode, exitCode);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /live=1/, 'the real child observes its running capture');
    assert.equal(liveVerificationCaptureCount(boardDirectory), 0, 'the completed capture no longer counts');
    assert.deepEqual(fs.readdirSync(path.join(boardDirectory, 'running-captures')), []);
  }
});

test('integration timeout identifies phase budget exhaustion separately from failing assertions', () => {
  const result: VerificationResult = { kind: 'command', status: 'failed_suite', command: 'npm run test:full', evidence: 'exit 1', failureIdentities: ['exit:1'], outputTail: 'Sidequest functional tests exceeded their 1200000ms phase budget at concurrency 8' };
  assert.deepEqual(phaseBudgetResult(result).failureIdentities, ['exit:1', 'phase_budget_exceeded']);
  assert.match(phaseBudgetResult(result).evidence, /Phase budget failure/);
  const assertionFailure = { ...result, outputTail: 'not ok 1 - expected true' };
  assert.equal(phaseBudgetResult(assertionFailure), assertionFailure);
});

test('integration test batches honour the board deadline and exclude pinned files', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-batches-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, { 'plugins/sidequest/package.json': JSON.stringify({ scripts: { 'test:files': 'node --test' } }) });
  const selections = [{ plugin: 'plugins/sidequest', files: ['test/first.test.ts', 'test/second.test.ts', 'test/third.test.ts'] }];
  const batches = integrationTestBatches(project, selections, 'npm --prefix plugins/sidequest run test:files -- test/first.test.ts', 900_000);
  assert.deepEqual(batches.map((batch) => batch.files), [['test/second.test.ts', 'test/third.test.ts']]);
  assert.deepEqual(batches.map((batch) => batch.timeoutMilliseconds), [900_000]);
  assert.ok(batches.every((batch) => batch.command.startsWith('npm run test:files -- --test-concurrency=1')));
  assert.deepEqual(integrationTestBatches(project, selections, 'node --test "plugins/sidequest/test/*.test.ts"', 10_000), []);
  assert.equal(integrationTestBatches(project, selections, 'node --version', 10_000)[0]!.timeoutMilliseconds, 10_000);
});

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test('integration test selection follows static imports transitively through compiled Sidequest identities', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-selection-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, {
    'plugins/sidequest/src/lib/store/submissions.ts': 'export const delivery = true;',
    'plugins/sidequest/src/lib/store.ts': "const submissions = require('./store/submissions.js');",
    'plugins/sidequest/src/lib/cycle.ts': "export * from './store.js'; export * from './cycle.js';",
    'plugins/sidequest/lib/store.js': "require('./store/submissions.js');",
    'plugins/sidequest/test/submission.test.ts': "import { delivery } from '../lib/store.js';",
    'plugins/sidequest/test/nested/store.test.ts': "const store = require('../../lib/store.js');",
    'plugins/sidequest/test/cycle.test.ts': "import '../src/lib/cycle.js';",
    'plugins/sidequest/test/unrelated.test.ts': "import fs from 'node:fs';",
    'plugins/other/test/unrelated.test.js': "require('../lib/source.js');",
  });
  assert.deepEqual(selectIntegrationTests(project, ['plugins/sidequest/src/lib/store/submissions.ts']), [{
    plugin: 'plugins/sidequest',
    files: ['test/cycle.test.ts', 'test/nested/store.test.ts', 'test/submission.test.ts'],
  }]);
  assert.deepEqual(selectIntegrationTests(project, ['plugins/sidequest/lib/store/submissions.js']), [{
    plugin: 'plugins/sidequest',
    files: ['test/cycle.test.ts', 'test/nested/store.test.ts', 'test/submission.test.ts'],
  }]);
});

test('integration test selection handles JavaScript directory imports and plugins independently', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-selection-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, {
    'plugins/example/lib/source.js': 'module.exports = 1;',
    'plugins/example/lib/api/index.js': "module.exports = require('../source');",
    'plugins/example/test/source.test.js': "const source = require('../lib/api');",
    'plugins/example/test/other.test.js': "require('external-package');",
  });
  assert.deepEqual(selectIntegrationTests(project, ['plugins/example/lib/source.js', 'docs/guide.md']), [{
    plugin: 'plugins/example', files: ['test/source.test.js'],
  }, { plugin: 'plugins/sidequest', files: [] }]);
  assert.deepEqual(selectIntegrationTests(project, ['plugins/example/lib/unreached.js']), [{ plugin: 'plugins/example', files: [] }]);
  assert.deepEqual(selectIntegrationTests(project, ['docs/guide.md']), [{ plugin: 'plugins/sidequest', files: [] }]);
  assert.deepEqual(selectIntegrationTests(project, ['plugins/missing/lib/source.js']), [{ plugin: 'plugins/missing', files: [] }]);
});

function manyTestFixture(project: string, scripts: Record<string, string>): void {
  writeFixture(project, {
    'plugins/example/package.json': JSON.stringify({ scripts }),
    'plugins/example/src/store.ts': 'export const store = true;',
    'plugins/example/test/hooks.perf.test.ts': "import '../src/store.js';",
    'plugins/example/test/context-budget-benchmark.test.ts': "import '../src/store.js';",
  });
  for (let index = 0; index < 45; index++) {
    writeFixture(project, { ['plugins/example/test/store-' + index + '.test.ts']: "import '../src/store.js';" });
  }
}

test('store-level selection falls back once to the normal plugin test script', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-many-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  manyTestFixture(project, { test: 'node --test', 'test:files': 'npm run typecheck && node --test' });
  const selections = selectIntegrationTests(project, ['plugins/example/src/store.ts']);
  assert.equal(selections[0]!.files.length, 47);
  const batches = integrationTestBatches(project, selections, 'node --version', 10_000);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.command, 'npm test');
  assert.equal(batches[0]!.files.length, 45);
  assert.ok(batches[0]!.files.every((file) => !file.includes('perf') && !file.includes('benchmark')));
});

test('large selection prefers the documented full gate and configurable threshold', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-fallback-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  manyTestFixture(project, { 'test:full': 'node full.cjs', 'test:files': 'npm run typecheck && node --test' });
  const batches = integrationTestBatches(project, selectIntegrationTests(project, ['plugins/example/src/store.ts']), 'node --version', 10_000);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.command, 'npm run test:full');
  assert.equal(batches[0]!.shape, 'test:full');
  const selected = selectIntegrationTests(project, ['plugins/example/src/store.ts']);
  assert.match(integrationTestBatches(project, selected, 'node --version', 10_000, 45)[0]!.command, /test:files/);
  assert.equal(integrationTestBatches(project, selected, 'node --version', 10_000, 44)[0]!.command, 'npm run test:full');
  assert.equal(batches[0]!.files.length, 45);
  assert.ok(!batches[0]!.command.includes('perf'));
  assert.ok(!batches[0]!.command.includes('benchmark'));
});

test('full-gate receipts preserve the live capture count and phase budget failure identity', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-budget-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  manyTestFixture(project, { 'test:full': 'node full.cjs' });
  writeFixture(project, { 'plugins/example/full.cjs': "console.log('live=' + process.env.SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT); console.error('Sidequest functional tests exceeded their 1200000ms phase budget at concurrency 8'); process.exit(1);" });
  const environment: NodeJS.ProcessEnv = { ...process.env, SIDEQUEST_LIVE_VERIFY_CAPTURE_COUNT: '2' };
  delete environment.NODE_TEST_CONTEXT;
  const logPath = path.join(project, 'gate.log');
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath };
  const result = runImportingIntegrationTests(project, ['plugins/example/src/store.ts'], pinned, 30_000, environment);
  assert.equal(result.status, 'failed_suite');
  assert.ok(result.failureIdentities!.includes('phase_budget_exceeded'));
  assert.match(result.evidence, /Phase budget failure/);
  assert.match(fs.readFileSync(logPath + '.import-0.log', 'utf8'), /live=2/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /"liveVerifyCaptureCount":2/);
});

test('import gate executes one batch and records exclusions timing and only failures', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-run-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, {
    'plugins/example/package.json': JSON.stringify({ scripts: { typecheck: 'node check.cjs', 'test:files': 'npm run typecheck && node --test' } }),
    'plugins/example/check.cjs': "require('node:fs').appendFileSync('typechecks.txt', 'checked\\n');",
    'plugins/example/lib/store.js': 'module.exports = true;',
    'plugins/example/test/first.test.js': "require('../lib/store.js'); require('node:test')('first importing test', () => {});",
    'plugins/example/test/second.test.js': "require('../lib/store.js'); require('node:test')('second importing test', () => {});",
    'plugins/example/test/hooks.perf.test.js': "require('../lib/store.js'); throw new Error('benchmark must not run');",
  });
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const logPath = path.join(project, 'gate.log');
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath };
  const result = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 30_000, environment);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.importingTestResults, []);
  assert.equal(fs.readFileSync(path.join(project, 'plugins/example/typechecks.txt'), 'utf8'), 'checked\n');
  assert.deepEqual(result.integrationTests[0]!.excludedFiles, ['test/hooks.perf.test.js']);
  assert.equal(result.importingTestSummary.selectedFiles, 3);
  assert.ok(result.importingTestSummary.durationMilliseconds >= 0);
  assert.equal(result.importingTestSummary.timeoutMilliseconds, 30_000);
  assert.match(fs.readFileSync(logPath, 'utf8'), /Wall-clock performance/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /"batchShape":"selected-files"/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /"timeoutMilliseconds":30000/);
  assert.match(fs.readFileSync(logPath + '.import-0.log', 'utf8'), /second importing test/);
  assert.ok(!fs.existsSync(logPath + '.import-1.log'));
  writeFixture(project, { 'plugins/example/test/second.test.js': "require('../lib/store.js'); require('node:test')('second importing test', () => { require('node:assert/strict').fail('broken'); });" });
  const failed = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 30_000, environment);
  assert.equal(failed.status, 'failed_suite');
  assert.equal(failed.importingTestResults.length, 1);
  assert.match(failed.importingTestResults[0]!.outputTail!, /second importing test/);
});


test('Markdown guidance selects guidance skill and compatibility tests without store importers', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-guidance-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, {
    'plugins/sidequest/src/store.ts': 'export const store = true;',
    'plugins/sidequest/test/store.test.ts': "import '../src/store.js';",
    'plugins/sidequest/test/agent-guidance.test.ts': "import '../src/store.js';",
    'plugins/sidequest/test/skill.test.ts': "import '../src/store.js';",
    'plugins/sidequest/test/compatibility.test.ts': "import '../src/store.js';",
  });
  const expected = [{ plugin: 'plugins/sidequest', files: ['test/agent-guidance.test.ts', 'test/compatibility.test.ts', 'test/skill.test.ts'] }];
  assert.deepEqual(selectIntegrationTests(project, ['plugins/sidequest/skills/sidequest/references/publishing.md', '.release/unreleased/SQ-123.md']), expected);
  assert.deepEqual(selectIntegrationTests(project, ['docs/guide.md']), expected);
  assert.equal(selectIntegrationTests(project, ['plugins/sidequest/src/store.ts'])[0]!.files.length, 4);
});

test('fallback timeout receipt names the full gate deadline and elapsed time', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-timeout-'));
  context.after(() => fs.promises.rm(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  writeFixture(project, {
    'plugins/example/package.json': JSON.stringify({ scripts: { 'test:full': 'node wait.cjs' } }),
    'plugins/example/wait.cjs': 'setTimeout(() => {}, 1500);',
    'plugins/example/lib/store.js': 'module.exports = true;',
    'plugins/example/test/first.test.js': "require('../lib/store.js');",
    'plugins/example/test/second.test.js': "require('../lib/store.js');",
  });
  const logPath = path.join(project, 'gate.log');
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath };
  const result = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 500, { ...process.env }, 1);
  assert.equal(result.status, 'timeout');
  assert.equal(result.command, 'npm run test:full');
  assert.equal(result.timeoutMilliseconds, 500);
  assert.equal(result.importingTestSummary.timeoutMilliseconds, 500);
  const receipt = JSON.parse(fs.readFileSync(logPath, 'utf8').split('Import-walk batch: ')[1]!.split('\n')[0]!);
  assert.equal(receipt.batchShape, 'test:full');
  assert.equal(receipt.timeoutMilliseconds, 500);
  assert.ok(receipt.durationMilliseconds >= 500);
});

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

// SQ-3927: a bare spawnSync deadline killed only the shell, so npm and the test runner under it kept
// running for hours after the gate reported timeout.
test('a timed-out import gate ends the test tree under npm before it reports', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-orphans-'));
  const processIdsFile = path.join(project, 'plugins/example/pids.txt');
  const recordedProcessIds = () => (fs.existsSync(processIdsFile) ? fs.readFileSync(processIdsFile, 'utf8').trim().split('\n').map((line) => line.split(' ')) : []);
  context.after(() => {
    for (const [, processId] of recordedProcessIds()) {
      try { process.kill(Number(processId)); } catch { /* already ended */ }
    }
    return fs.promises.rm(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const recordAndSleep = (role: string) => `require('node:fs').appendFileSync('pids.txt', '${role} ' + process.pid + '\\n'); setTimeout(() => {}, 120000);`;
  writeFixture(project, {
    'plugins/example/package.json': JSON.stringify({ scripts: { 'test:full': 'node child.cjs' } }),
    'plugins/example/child.cjs': `require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], { stdio: 'ignore' }); ${recordAndSleep('child')}`,
    'plugins/example/grandchild.cjs': recordAndSleep('grandchild'),
    'plugins/example/lib/store.js': 'module.exports = true;',
    'plugins/example/test/first.test.js': "require('../lib/store.js');",
    'plugins/example/test/second.test.js': "require('../lib/store.js');",
  });
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath: path.join(project, 'gate.log') };

  const result = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 5_000, { ...process.env }, 1);

  assert.equal(result.status, 'timeout');
  const recorded = recordedProcessIds();
  assert.deepEqual(recorded.map(([role]) => role).sort(), ['child', 'grandchild'], 'both test processes started before the deadline');
  assert.deepEqual(recorded.filter(([, processId]) => processAlive(Number(processId))), [], 'no test process outlives the reported timeout');
  if (process.platform === 'win32') {
    for (const [, processId] of recorded) assert.match(result.evidence, new RegExp(`processes [\\d, ]*\\b${processId}\\b`), 'the timeout names every pid the job ended');
  }
});


test('import-walk file threshold is a validated board setting', (context) => {
  const store = require('../lib/store.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-config-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const { slug } = store.ensureProject(project);
  assert.equal(store.boardConfig(slug).integrationTestFileThreshold, 40);
  store.setBoardConfig(slug, { integrationTestFileThreshold: 12 });
  assert.equal(store.boardConfig(slug).integrationTestFileThreshold, 12);
  assert.throws(() => store.setBoardConfig(slug, { integrationTestFileThreshold: 0 }), /positive integer/);
  assert.throws(() => store.setBoardConfig(slug, { integrationTestFileThreshold: 1.5 }), /positive integer/);
});

// Spelled through a variable so the import walk never reads this file itself as a plugin-runner test.
const runnerPackage = ['claude', 'code'].join('-');

function pluginRunnerFixture(project: string): void {
  writeFixture(project, {
    'plugins/example/package.json': JSON.stringify({ scripts: { test: 'node --test test/*.test.js' } }),
    'plugins/example/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
    'plugins/example/hooks/register.ts': "export const register = true;",
    'plugins/example/hooks/register.test.ts': "import { register } from './register.js';",
    'plugins/example/lib/store.js': 'module.exports = true;',
    'plugins/example/test/node.test.js': "require('../lib/store.js'); require('node:test')('node importing test', () => {});",
    'plugins/example/test/module.test.ts': `import { expect, test } from '${runnerPackage}/testing'\nimport type { On } from '${runnerPackage}'\nimport '../lib/store.js'\nimport '../hooks/register.js'`,
  });
}

function environmentWithPath(directories: string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH' && key !== 'NODE_TEST_CONTEXT') environment[key] = value;
  environment.PATH = directories.join(path.delimiter);
  return environment;
}

function fakeClaude(directory: string, exitCode: number): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'claude'), `#!/bin/sh\necho fake plugin runner "$@"\nexit ${exitCode}\n`, { mode: 0o755 });
  // Windows verifiers run under Git Bash when it exists and under Command Prompt otherwise.
  if (process.platform === 'win32') fs.writeFileSync(path.join(directory, 'claude.cmd'), `@echo fake plugin runner %*\r\n@exit /b ${exitCode}\r\n`);
}

// SQ-3940: node --test cannot load a claude-code/testing import, so the gate rolled back correct hooks-module deliveries.
test('plugin-runner tests leave the node batch and run through the plugin runner', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-runner-'));
  context.after(() => fs.promises.rm(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  pluginRunnerFixture(project);
  const selections = selectIntegrationTests(project, ['plugins/example/lib/store.js']);
  assert.deepEqual(selections, [{ plugin: 'plugins/example', files: ['test/node.test.js'], pluginRunnerFiles: ['test/module.test.ts'] }]);
  const batches = integrationTestBatches(project, selections, 'node --version', 30_000);
  assert.deepEqual(batches.map((batch) => [batch.shape, batch.files]), [['selected-files', ['test/node.test.js']], ['plugin-runner', ['test/module.test.ts']]]);
  assert.ok(!batches[0]!.command.includes('module.test.ts'), 'node --test never receives a claude-code/testing file');
  assert.equal(batches[1]!.command, 'claude plugin test .');
  assert.deepEqual(selectIntegrationTests(project, ['plugins/example/hooks/register.ts']), [{ plugin: 'plugins/example', files: [], pluginRunnerFiles: ['hooks/register.test.ts', 'test/module.test.ts'] }]);

  const fakeBin = path.join(project, 'fake-bin');
  fakeClaude(fakeBin, 0);
  const logPath = path.join(project, 'gate.log');
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath };
  const result = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 30_000, environmentWithPath([fakeBin, path.dirname(process.execPath)]));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.pluginRunnerResults.map((receipt) => [receipt.plugin, receipt.files, receipt.command, receipt.status]), [['plugins/example', ['test/module.test.ts'], 'claude plugin test .', 'passed']]);
  assert.match(fs.readFileSync(logPath + '.plugin-runner-0.log', 'utf8'), /fake plugin runner plugin test \./);
  assert.match(fs.readFileSync(logPath + '.import-0.log', 'utf8'), /node importing test/);
  assert.match(result.importingTestSummary.pluginRunnerSplit, /claude-code.*plugin runner/);
  assert.equal(result.importingTestSummary.selectedFiles, 2);

  fakeClaude(fakeBin, 3);
  const failed = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 30_000, environmentWithPath([fakeBin, path.dirname(process.execPath)]));
  assert.equal(failed.status, 'failed_suite');
  assert.equal(failed.importingTestResults.length, 1);
  assert.equal(failed.importingTestResults[0]!.command, 'claude plugin test .');
});

test('without the claude CLI plugin-runner tests are recorded as unverified instead of failing', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-runner-missing-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  pluginRunnerFixture(project);
  const emptyPath = path.join(project, 'no-claude');
  fs.mkdirSync(emptyPath);
  const pinned = { kind: 'command', status: 'passed' as const, command: 'node --version', evidence: 'baseline', logPath: path.join(project, 'gate.log') };
  const result = runImportingIntegrationTests(project, ['plugins/example/hooks/register.ts'], pinned, 30_000, environmentWithPath([emptyPath]));
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.importingTestResults, []);
  assert.deepEqual(result.pluginRunnerResults.map((receipt) => [receipt.files, receipt.status]), [[['hooks/register.test.ts', 'test/module.test.ts'], 'unverified']]);
  assert.match(result.pluginRunnerResults[0]!.evidence, /claude CLI is not on PATH/);
});

test('a plugin that declares its own module runner gets it for tests under its hooks module root', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-runner-declared-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, {
    'plugins/sidequest/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'plugins/sidequest/hooks/hooks.json': JSON.stringify({ modules: ['./guards/register.ts'] }),
    'plugins/sidequest/hooks/guards/git-guards.ts': 'export const guard = true;',
    'plugins/sidequest/hooks/guards/git-guards.test.ts': "import { guard } from './git-guards.js';",
    'plugins/sidequest/hooks/session-start.test.js': "require('./guards/git-guards.ts');",
  });
  const selections = selectIntegrationTests(project, ['plugins/sidequest/hooks/guards/git-guards.ts']);
  assert.deepEqual(selections, [{ plugin: 'plugins/sidequest', files: [], pluginRunnerFiles: ['hooks/guards/git-guards.test.ts'] }]);
  assert.deepEqual(integrationTestBatches(project, selections, 'node --version', 30_000).map((batch) => [batch.shape, batch.command]), [['plugin-runner', 'node scripts/test-guards-module.mjs']]);
});
