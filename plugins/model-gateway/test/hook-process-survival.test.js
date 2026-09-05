'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const path = require('node:path');
const { spawnGatewayProcess } = require('./support.js');

const PROCESS_SUPERVISION = path.join(__dirname, '..', 'lib', 'process-supervision.js');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (!pid || !processIsRunning(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function waitForProcess(pid, running, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (processIsRunning(pid) === running) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`PID ${pid} did not become ${running ? 'running' : 'stopped'}`));
      setTimeout(check, 20);
    };
    check();
  });
}

function grandchildPidFrom(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const pid = Number(output.trim());
      if (pid) resolve(pid);
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`hook helper exited ${code ?? signal}: ${output}`)));
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

test('hook timeout tree kill leaves the double-forked supervisor alive', async (t) => {
  const helper = `
    const fs = require('node:fs');
    const { spawnDetached, pidFile, readPid } = require(${JSON.stringify(PROCESS_SUPERVISION)});
    fs.mkdirSync(require('node:path').dirname(pidFile('hook-survival')), { recursive: true });
    spawnDetached('hook-survival', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {});
    const deadline = Date.now() + 5000;
    const report = () => {
      const pid = readPid('hook-survival');
      if (pid) return process.stdout.write(String(pid));
      if (Date.now() >= deadline) process.exit(1);
      else setTimeout(report, 20);
    };
    report();
    setInterval(() => {}, 1000);
  `;
  const hook = spawnGatewayProcess(t, process.execPath, ['-e', helper], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const grandchildPid = await grandchildPidFrom(hook);
  t.after(() => killProcessTree(grandchildPid));

  await delay(150);
  killProcessTree(hook.pid);
  await waitForExit(hook);
  await waitForProcess(grandchildPid, true);
  assert.equal(processIsRunning(grandchildPid), true);
});
