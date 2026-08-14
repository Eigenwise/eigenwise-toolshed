'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const CLI = path.resolve(__dirname, '../bin/quartermaster.js');

function run(command, projectPath) {
  return spawnSync(process.execPath, [CLI, command, '--project', projectPath], { encoding: 'utf8' });
}

test('the retired mark-retro command stays unavailable', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));

  const retired = run('mark-retro', projectPath);
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /Unknown command: mark-retro/);

  const current = run('mark-resupply', projectPath);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).ok, true);
});
