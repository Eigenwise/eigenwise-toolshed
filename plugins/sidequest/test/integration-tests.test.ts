import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { integrationTestBatches, selectIntegrationTests } from '../src/lib/integration-tests.js';

test('integration test batches cap each file at the capture budget and exclude pinned files', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-import-batches-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFixture(project, { 'plugins/sidequest/package.json': JSON.stringify({ scripts: { 'test:files': 'node --test' } }) });
  const selections = [{ plugin: 'plugins/sidequest', files: ['test/first.test.ts', 'test/second.test.ts', 'test/third.test.ts'] }];
  const batches = integrationTestBatches(project, selections, 'npm --prefix plugins/sidequest run test:files -- test/first.test.ts', 900_000);
  assert.deepEqual(batches.map((batch) => batch.file), ['test/second.test.ts', 'test/third.test.ts']);
  assert.deepEqual(batches.map((batch) => batch.timeoutMilliseconds), [600_000, 600_000]);
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
