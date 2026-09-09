'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'hooks', 'whittle.js');
const runtime = require(path.join(root, 'hooks', 'lib', 'runtime'));

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function runHook(eventName, input = {}) {
  return childProcess.execFileSync(process.execPath, [hook, eventName], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function context(output) {
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext : '';
}

test('one canonical policy renders without input or state', () => {
  const stateDirectory = temporaryDirectory('whittle-state-');
  const oldStateDirectory = process.env.WHITTLE_STATE_DIR;
  process.env.WHITTLE_STATE_DIR = stateDirectory;
  try {
    const policy = runtime.instructions();
    assert.match(policy, /Understand the flow before changing it/);
    assert.match(policy, /integration owner runs the full gate/);
    assert.equal(fs.readdirSync(stateDirectory).length, 0);
  } finally {
    if (oldStateDirectory === undefined) delete process.env.WHITTLE_STATE_DIR;
    else process.env.WHITTLE_STATE_DIR = oldStateDirectory;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('Claude lifecycle hooks inject the canonical policy once per entry point', () => {
  const policy = runtime.instructions();

  assert.equal(context(runHook('SessionStart')), policy);
  assert.equal(context(runHook('SubagentStart')), policy);
  assert.equal(runHook('UserPromptSubmit', { user_prompt: 'continue' }), '');
  assert.equal(runHook('UserPromptSubmit', { user_prompt: '/whittle status' }), '');
});

test('policy source retains optional Sidequest report recipes without Whittle commands', () => {
  const source = fs.readFileSync(path.join(root, 'skills', 'whittle', 'SKILL.md'), 'utf8');

  assert.match(source, /readonly submitted-candidate review/);
  assert.match(source, /named-scope repository audit/);
  assert.match(source, /source-comment debt scan/);
  assert.doesNotMatch(source, /lite|ultra|default <mode>|statusline/i);
});
