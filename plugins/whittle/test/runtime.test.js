'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'hooks', 'whittle.js');
const runtime = require(path.join(root, 'hooks', 'lib', 'runtime'));
const statusline = path.join(root, 'bin', 'whittle-status.js');

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function runHook(eventName, projectDir, stateDir, input, ambientProjectDir = projectDir) {
  return childProcess.execFileSync(process.execPath, [hook, eventName], {
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: ambientProjectDir,
      WHITTLE_STATE_DIR: stateDir,
      WHITTLE_ENABLED: '0',
    },
    input: JSON.stringify({ cwd: projectDir, ...input }),
    encoding: 'utf8',
  });
}

function context(output) {
  return output ? JSON.parse(output).hookSpecificOutput.additionalContext : '';
}

function runStatusline(projectDir, stateDir, session, ambientProjectDir) {
  return childProcess.execFileSync(process.execPath, [statusline, '--statusline', '--project', projectDir, '--session', session], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: ambientProjectDir,
      WHITTLE_STATE_DIR: stateDir,
    },
    encoding: 'utf8',
  });
}

test('full starts when the installed hook runs without WHITTLE_ENABLED', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const stateDir = path.join(projectDir, 'state');

  assert.match(context(runHook('SessionStart', projectDir, stateDir, { session_id: 'one' })), /Whittle mode: full\./);
});

test('help keeps Sidequest reports available while Whittle is off', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const stateDir = path.join(projectDir, 'state');

  runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle off' });
  const help = context(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle help' }));

  assert.match(help, /Reports stay available while mode is off/);
  assert.match(help, /immutable reviewTarget/);
  assert.match(help, /named-scope repository audits/);
  assert.match(help, /source-comment debt scans/);
  assert.match(help, /routed report capability is unavailable/);
  assert.match(help, /Gain is unmeasured without a matched baseline/);
});

test('mode changes inject once, default persists, and off stays silent', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const stateDir = path.join(projectDir, 'state');

  assert.match(context(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle lite' })), /Whittle mode: lite\./);
  assert.match(context(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle status' })), /Whittle mode: lite\./);
  assert.equal(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: 'continue' }), '');
  assert.match(context(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle default ultra' })), /Whittle mode: ultra\./);
  assert.match(context(runHook('SessionStart', projectDir, stateDir, { session_id: 'two' })), /Whittle mode: ultra\./);
  assert.equal(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'one', user_prompt: '/whittle off' }), '');
  assert.equal(runHook('SessionStart', projectDir, stateDir, { session_id: 'one' }), '');
  assert.equal(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'two', user_prompt: 'normal mode' }), '');
});

test('sessions and projects keep separate active modes', () => {
  const firstProject = temporaryDirectory('whittle-project-');
  const secondProject = temporaryDirectory('whittle-project-');
  const stateDir = temporaryDirectory('whittle-state-');

  runHook('UserPromptSubmit', firstProject, stateDir, { session_id: 'first', user_prompt: '/whittle lite' });
  runHook('UserPromptSubmit', firstProject, stateDir, { session_id: 'second', user_prompt: '/whittle ultra' });
  assert.match(context(runHook('SessionStart', firstProject, stateDir, { session_id: 'first' })), /Whittle mode: lite\./);
  assert.match(context(runHook('SessionStart', firstProject, stateDir, { session_id: 'second' })), /Whittle mode: ultra\./);
  assert.match(context(runHook('SessionStart', secondProject, stateDir, { session_id: 'first' })), /Whittle mode: full\./);
});

test('native hooks prefer their ambient project root', () => {
  const inputProjectDir = temporaryDirectory('whittle-project-');
  const ambientProjectDir = temporaryDirectory('whittle-ambient-project-');
  const stateDir = temporaryDirectory('whittle-state-');

  runHook('UserPromptSubmit', ambientProjectDir, stateDir, { session_id: 'one', user_prompt: '/whittle ultra' });
  assert.match(context(runHook('SessionStart', inputProjectDir, stateDir, { session_id: 'one' }, ambientProjectDir)), /Whittle mode: ultra\./);
});

test('subagents inherit their parent selection and statusline honors its explicit project', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const ambientProjectDir = temporaryDirectory('whittle-ambient-project-');
  const stateDir = temporaryDirectory('whittle-state-');

  runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'parent', user_prompt: '/whittle lite' });
  assert.match(context(runHook('SubagentStart', projectDir, stateDir, { session_id: 'child', parent_session_id: 'parent' })), /Whittle mode: lite\./);
  assert.match(context(runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'child', user_prompt: '/whittle status' })), /Whittle mode: lite\./);
  assert.equal(runStatusline(projectDir, stateDir, 'child', ambientProjectDir), '[WHITTLE:LITE]\n');
  runHook('UserPromptSubmit', projectDir, stateDir, { session_id: 'child', user_prompt: '/whittle off' });
  assert.equal(runStatusline(projectDir, stateDir, 'child', ambientProjectDir), '\n');
});

test('missing session identity never creates shared active state', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const stateDir = path.join(projectDir, 'state');

  assert.match(context(runHook('SessionStart', projectDir, stateDir, {})), /Whittle mode: full\./);
  const selection = context(runHook('UserPromptSubmit', projectDir, stateDir, { user_prompt: '/whittle lite' }));
  assert.match(selection, /Whittle mode: lite\./);
  assert.match(selection, /could not save the session selection\./);
  assert.equal(fs.existsSync(stateDir), false);
});

test('instructionsForMode renders policy without state changes', () => {
  const stateDir = path.join(temporaryDirectory('whittle-project-'), 'state');
  const originalStateDir = process.env.WHITTLE_STATE_DIR;
  process.env.WHITTLE_STATE_DIR = stateDir;
  try {
    assert.match(runtime.instructionsForMode('full'), /Whittle mode: full\./);
    assert.equal(fs.existsSync(stateDir), false);
  } finally {
    if (originalStateDir === undefined) delete process.env.WHITTLE_STATE_DIR;
    else process.env.WHITTLE_STATE_DIR = originalStateDir;
  }
});

test('failed default and session persistence is reported truthfully', () => {
  const projectDir = temporaryDirectory('whittle-project-');
  const stateFile = path.join(projectDir, 'state-file');
  fs.writeFileSync(stateFile, 'not a directory');

  const selection = context(runHook('UserPromptSubmit', projectDir, stateFile, { session_id: 'one', user_prompt: '/whittle default ultra' }));
  assert.match(selection, /Whittle mode: ultra\./);
  assert.match(selection, /could not save the default or session selection\./);
});
