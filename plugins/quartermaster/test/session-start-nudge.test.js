'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { recordSessionTally } = require('../lib/state.js');

const HOOK = path.join(__dirname, '..', 'hooks', 'session-start-nudge.js');

function runHook(projectDir, stateDir) {
  const result = spawnSync(process.execPath, [HOOK], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      QUARTERMASTER_STATE_DIR: stateDir,
    },
    input: JSON.stringify({ source: 'startup', cwd: projectDir }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

test('session-start proactively offers an optimization round and waits for approval', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-'));
  const environment = { QUARTERMASTER_STATE_DIR: stateDir };
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `session-${index}`, { prompts: 4, toolCalls: 8 }, environment);
  }

  const context = runHook(projectDir, stateDir);
  assert.match(context, /proactively ask whether the user wants a focused optimization round/i);
  assert.match(context, /development system, setup, tooling, or workflow/i);
  assert.match(context, /after they say yes, or automatically if they have explicitly given standing permission/i);
  assert.match(context, /each recommendation still needs separate approval unless their standing permission also covers that exact class of change/i);
});
