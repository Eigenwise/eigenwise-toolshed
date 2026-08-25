'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { recordSessionTally } = require('../lib/state.js');

const CLI = path.resolve(__dirname, '../bin/quartermaster.js');

function run(command, projectPath, stateDir = null) {
  return spawnSync(process.execPath, [CLI, command, '--project', projectPath], {
    encoding: 'utf8',
    env: stateDir ? { ...process.env, QUARTERMASTER_STATE_DIR: stateDir } : process.env,
  });
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

test('decline-resupply records the decline and clears the current accumulation', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-test-'));
  const environment = { QUARTERMASTER_STATE_DIR: stateDir };
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectPath, `session-${index}`, { prompts: 4, toolCalls: 8 }, environment);
  }

  const declined = run('decline-resupply', projectPath, stateDir);
  assert.equal(declined.status, 0, declined.stderr);
  assert.ok(JSON.parse(declined.stdout).lastDeclinedAt);

  const status = run('status', projectPath, stateDir);
  assert.equal(status.status, 0, status.stderr);
  const parsedStatus = JSON.parse(status.stdout);
  assert.equal(parsedStatus.unanalyzedSessions, 0);
  assert.ok(parsedStatus.lastDeclinedAt);
});
