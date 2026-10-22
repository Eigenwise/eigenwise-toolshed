import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { selectIntegrationTests } from '../src/lib/integration-tests.js';

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
  assert.deepEqual(selectIntegrationTests(project, ['docs/guide.md']), []);
  assert.deepEqual(selectIntegrationTests(project, ['plugins/missing/lib/source.js']), [{ plugin: 'plugins/missing', files: [] }]);
});
