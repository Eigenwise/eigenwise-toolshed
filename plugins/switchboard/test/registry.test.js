'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const writer = require('../hooks/registry-writer.js');
const contract = require('../lib/contract.js');

function home(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('writes a valid atomic Switchboard registry breadcrumb', (t) => {
  const directory = home(t);
  const result = writer.writeBreadcrumb({ root, home: directory, version: '1.2.3' });
  const file = writer.registryPath(directory);
  const breadcrumb = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(result.written, true);
  assert.deepEqual(contract.validateRegistryBreadcrumb(breadcrumb), { valid: true, errors: [] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['switchboard.json']);
});

test('preserves a future Switchboard registry schema for consumers to reject safely', (t) => {
  const directory = home(t);
  const file = writer.registryPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, name: 'switchboard' }));

  const result = writer.writeBreadcrumb({ root, home: directory, version: '1.2.3' });

  assert.deepEqual(result, { written: false, reason: 'future-schema', file });
  assert.equal(contract.validateRegistryBreadcrumb(JSON.parse(fs.readFileSync(file, 'utf8'))).valid, false);
});

test('does not fail SessionStart when registry state cannot be initialized', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'hooks', 'registry-writer.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(root, 'missing-plugin-root') },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
