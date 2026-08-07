import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runVerifyCapture, shellCommand } = require('../lib/verify-capture.js');

function deleteLog(capture: { logPath: string }) {
  fs.rmSync(capture.logPath, { force: true });
}

test('verify capture wraps POSIX commands before recording their exit code', () => {
  const shell = shellCommand('exit 7', 'linux');
  assert.deepStrictEqual(shell.arguments, ['-c', `(exit 7); printf '\\n__SIDEQUEST_VERIFY_EXIT__=%s\\n' "$?"`]);
});

test('verify capture executes through the host shell and separates failed suites from unavailable capture shells', async () => {
  const passed = await runVerifyCapture('cd . && echo verify-capture-ran');
  try {
    assert.deepStrictEqual({ status: passed.status, exitCode: passed.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(passed.logPath, 'utf8'), /verify-capture-ran/);
  } finally {
    deleteLog(passed);
  }

  const failed = await runVerifyCapture(process.platform === 'win32' ? 'cmd /d /s /c exit 7' : 'exit 7');
  try {
    assert.deepStrictEqual({ status: failed.status, exitCode: failed.exitCode }, { status: 'failed-suite', exitCode: 7 });
  } finally {
    deleteLog(failed);
  }

  const shellEnvironment = process.platform === 'win32' ? 'ComSpec' : 'SHELL';
  const originalShell = process.env[shellEnvironment];
  process.env[shellEnvironment] = path.join(os.tmpdir(), 'sidequest-missing-capture-shell');
  try {
    const unavailable = await runVerifyCapture('echo unreachable');
    try {
      assert.equal(unavailable.status, 'could-not-run');
      assert.equal(unavailable.exitCode, 2);
    } finally {
      deleteLog(unavailable);
    }
  } finally {
    if (originalShell === undefined) delete process.env[shellEnvironment];
    else process.env[shellEnvironment] = originalShell;
  }
});
