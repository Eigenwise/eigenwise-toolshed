import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { integrationTestBatches, runImportingIntegrationTests, selectIntegrationTests } from '../src/lib/integration-tests.js';

test('integration test batches batch files at the capture budget and exclude pinned files', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-batches-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, { 'plugins/sidequest/package.json': JSON.stringify({ scripts: { 'test:files': 'node --test' } }) });
  const selections = [{ plugin: 'plugins/sidequest', files: ['test/first.test.ts', 'test/second.test.ts', 'test/third.test.ts'] }];
  const batches = integrationTestBatches(project, selections, 'npm --prefix plugins/sidequest run test:files -- test/first.test.ts', 900_000);
  assert.deepEqual(batches.map((batch) => batch.files), [['test/second.test.ts', 'test/third.test.ts']]);
  assert.deepEqual(batches.map((batch) => batch.timeoutMilliseconds), [600_000]);
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
  }]);
  assert.deepEqual(selectIntegrationTests(project, ['plugins/example/lib/unreached.js']), [{ plugin: 'plugins/example', files: [] }]);
  assert.deepEqual(selectIntegrationTests(project, ['docs/guide.md']), []);
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

test('large selection without npm test uses one typechecking test-files invocation', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-fallback-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  manyTestFixture(project, { 'test:files': 'npm run typecheck && node --test' });
  const batches = integrationTestBatches(project, selectIntegrationTests(project, ['plugins/example/src/store.ts']), 'node --version', 10_000);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.command.match(/npm run test:files/g)!.length, 1);
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
  assert.match(fs.readFileSync(logPath, 'utf8'), /Wall-clock performance/);
  assert.match(fs.readFileSync(logPath + '.import-0.log', 'utf8'), /second importing test/);
  assert.ok(!fs.existsSync(logPath + '.import-1.log'));
  writeFixture(project, { 'plugins/example/test/second.test.js': "require('../lib/store.js'); require('node:test')('second importing test', () => { require('node:assert/strict').fail('broken'); });" });
  const failed = runImportingIntegrationTests(project, ['plugins/example/lib/store.js'], pinned, 30_000, environment);
  assert.equal(failed.status, 'failed_suite');
  assert.equal(failed.importingTestResults.length, 1);
  assert.match(failed.importingTestResults[0]!.outputTail!, /second importing test/);
});
