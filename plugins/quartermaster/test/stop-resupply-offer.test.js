'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { markNudged, recordSessionTally } = require('../lib/state.js');

const CLI = path.join(__dirname, '..', 'bin', 'quartermaster.js');
const HOOK = path.join(__dirname, '..', 'hooks', 'stop-resupply-offer.js');

function stateEnvironment(stateDir) {
  return { QUARTERMASTER_STATE_DIR: stateDir };
}

function overdueProject() {
  return {
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-')),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-')),
  };
}

function recordOverdueTallies(projectDir, stateDir) {
  const environment = stateEnvironment(stateDir);
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `session-${index}`, { prompts: 4, toolCalls: 8 }, environment);
  }
}

function runHook(projectDir, stateDir, overrides = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      QUARTERMASTER_STATE_DIR: stateDir,
    },
    input: JSON.stringify({ session_id: 'stop-session', stop_hook_active: false, cwd: projectDir, ...overrides }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runDecline(projectDir, stateDir) {
  const result = spawnSync(process.execPath, [CLI, 'decline-resupply', '--project', projectDir], {
    env: { ...process.env, QUARTERMASTER_STATE_DIR: stateDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Stop offer stays silent below the resupply thresholds', () => {
  const { projectDir, stateDir } = overdueProject();
  recordSessionTally(projectDir, 'only-session', { prompts: 4, toolCalls: 8 }, stateEnvironment(stateDir));

  assert.equal(runHook(projectDir, stateDir), '');
});

test('Stop offer blocks once with the resupply skill and decline escape hatch', () => {
  const { projectDir, stateDir } = overdueProject();
  recordOverdueTallies(projectDir, stateDir);

  const output = JSON.parse(runHook(projectDir, stateDir));
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /\/quartermaster:resupply/);
  assert.match(output.reason, /decline-resupply/);
  assert.match(output.reason, /4 sessions/);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 512, 'Stop guidance stays inside the hook output budget');
});

test('Stop offer stays silent while handling its own continuation', () => {
  const { projectDir, stateDir } = overdueProject();
  recordOverdueTallies(projectDir, stateDir);

  assert.equal(runHook(projectDir, stateDir, { stop_hook_active: true }), '');
});

test('Stop offer runs once per session', () => {
  const { projectDir, stateDir } = overdueProject();
  recordOverdueTallies(projectDir, stateDir);

  assert.equal(JSON.parse(runHook(projectDir, stateDir)).decision, 'block');
  assert.equal(runHook(projectDir, stateDir), '');
});

test('Stop offer observes its cross-session cooldown', () => {
  const { projectDir, stateDir } = overdueProject();
  recordOverdueTallies(projectDir, stateDir);

  assert.equal(JSON.parse(runHook(projectDir, stateDir)).decision, 'block');
  assert.equal(runHook(projectDir, stateDir, { session_id: 'next-stop-session' }), '');
});

test('a SessionStart nudge does not suppress its first Stop offer', () => {
  const { projectDir, stateDir } = overdueProject();
  const environment = stateEnvironment(stateDir);
  recordOverdueTallies(projectDir, stateDir);
  markNudged(projectDir, environment);

  assert.equal(JSON.parse(runHook(projectDir, stateDir)).decision, 'block');
});

test('declining a resupply round resets the offer accumulation window', () => {
  const { projectDir, stateDir } = overdueProject();
  recordOverdueTallies(projectDir, stateDir);

  assert.equal(JSON.parse(runHook(projectDir, stateDir)).decision, 'block');
  const result = runDecline(projectDir, stateDir);
  assert.ok(result.lastDeclinedAt);
  assert.equal(runHook(projectDir, stateDir, { session_id: 'after-decline' }), '');
});
