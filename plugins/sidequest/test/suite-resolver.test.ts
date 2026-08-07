import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveSuite } = require('../lib/suite-resolver');

function makePlugin(suiteTimeout?: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'suite-resolver-'));
  const pluginDirectory = path.join(root, 'plugins', 'example');
  mkdirSync(path.join(pluginDirectory, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(pluginDirectory, 'test'));
  writeFileSync(path.join(pluginDirectory, 'test', 'example.test.js'), '');
  writeFileSync(
    path.join(pluginDirectory, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'example', suiteTimeout }),
  );
  return { root, plugin: { name: 'example', dir: 'plugins/example' } };
}

test('default suites use a two-minute test timeout', (t) => {
  const fixture = makePlugin();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(
    resolveSuite(fixture.root, fixture.plugin)?.command,
    'node --test --test-timeout=120000 "test/*.test.js"',
  );
});

test('plugin manifests can override the default suite timeout', (t) => {
  const fixture = makePlugin(180000);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(
    resolveSuite(fixture.root, fixture.plugin)?.command,
    'node --test --test-timeout=180000 "test/*.test.js"',
  );
});
