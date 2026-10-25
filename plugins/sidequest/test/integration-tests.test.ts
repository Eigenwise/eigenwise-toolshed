import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { integrationTestBatches, runImportingIntegrationTests, selectIntegrationTests } from '../src/lib/integration-tests.js';

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
