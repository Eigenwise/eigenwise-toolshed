import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSuiteResolver } from '../lib/suites.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const resolveSuite = createSuiteResolver(root);

test('published module plugins resolve their module test commands', () => {
  for (const name of ['observability', 'quality-gate']) {
    const suite = resolveSuite({ name, dir: `plugins/${name}` });
    assert.equal(suite.moduleTest, 'claude plugin test .', name);
    assert.match(suite.command, /test/);
  }
  const sidequest = resolveSuite({ name: 'sidequest', dir: 'plugins/sidequest' });
  assert.equal(sidequest.moduleTest, 'node scripts/test-guards-module.mjs');
  assert.equal(sidequest.command, 'npm run test:full');
});
