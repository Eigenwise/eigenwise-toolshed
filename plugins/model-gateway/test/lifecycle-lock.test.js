'use strict';

const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { acquireLifecycleLock, intentionallyStopped, lockOwnerIsDead, readLockOwner, recordIntentionalStop, removeOwnedDirectory, resumeIntentionalStop, withLifecycleLock } = require('../lib/lifecycle-lock.js');

function lockDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-lifecycle-lock-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'lock');
}

function inspectProcess() {
  return Promise.resolve({ startedAt: 'current-process-generation' });
}

function writeOwner(directory, owner) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, owner.token), JSON.stringify(owner));
}

test('lifecycle lock refuses a live owner and releases only its own token', async (context) => {
  const directory = lockDirectory(context);
  const release = await acquireLifecycleLock({ directory, inspectProcess });
  const owner = readLockOwner(directory);
  assert.equal(owner.pid, process.pid);
  await assert.rejects(acquireLifecycleLock({ directory, inspectProcess, timeout: 0 }), /lifecycle is busy/);
  removeOwnedDirectory(directory, 'some-other-owner');
  assert.equal(readLockOwner(directory).token, owner.token);
  release();
  assert.equal(fs.existsSync(directory), false);
});

test('lifecycle lock recovers a stale PID generation without deleting a replacement owner', async (context) => {
  const directory = lockDirectory(context);
  writeOwner(directory, { token: 'old-owner', host: os.hostname(), pid: process.pid, startedAt: 'old-process-generation' });
  const release = await acquireLifecycleLock({ directory, inspectProcess });
  const owner = readLockOwner(directory);
  assert.notEqual(owner.token, 'old-owner');
  removeOwnedDirectory(directory, 'old-owner');
  assert.equal(readLockOwner(directory).token, owner.token);
  release();
});

test('lifecycle lock leaves malformed and unidentifiable owners untouched', async (context) => {
  const directory = lockDirectory(context);
  writeOwner(directory, { token: 'unknown', pid: process.pid, host: os.hostname() });
  await assert.rejects(acquireLifecycleLock({ directory, inspectProcess, timeout: 0 }), /ownership is unknown/);
  assert.equal(readLockOwner(directory).token, 'unknown');
  assert.equal(await lockOwnerIsDead({ host: 'another-host', pid: process.pid }, inspectProcess), false);
  assert.equal(await lockOwnerIsDead({ host: os.hostname(), pid: 0 }, inspectProcess), false);
  assert.equal(await lockOwnerIsDead(null, inspectProcess), false);
  await assert.rejects(acquireLifecycleLock({ directory, inspectProcess: async () => null }), /establish lifecycle lock process identity/);
});

test('lifecycle lock is reentrant only inside its owning async operation and releases on failure', async (context) => {
  const directory = lockDirectory(context);
  const options = { directory, inspectProcess };
  await assert.rejects(withLifecycleLock(async () => {
    await withLifecycleLock(async () => assert.ok(readLockOwner(directory)), options);
    throw new Error('operation failed');
  }, options), /operation failed/);
  assert.equal(fs.existsSync(directory), false);
});

test('expired async ownership cannot bypass a later lifecycle owner', async (context) => {
  const directory = lockDirectory(context);
  const options = { directory, inspectProcess, timeout: 0 };
  const inheritedContext = await withLifecycleLock(async () => AsyncLocalStorage.snapshot(), options);
  const release = await acquireLifecycleLock(options);
  try {
    await assert.rejects(inheritedContext(() => withLifecycleLock(async () => assert.fail('expired owner entered'), options)), /lifecycle is busy/);
  } finally { release(); }
});

test('intentional stop survives repeated reads until explicitly resumed', () => {
  resumeIntentionalStop();
  assert.equal(intentionallyStopped(), false);
  recordIntentionalStop();
  assert.equal(intentionallyStopped(), true);
  assert.equal(intentionallyStopped(), true);
  resumeIntentionalStop();
  assert.equal(intentionallyStopped(), false);
  resumeIntentionalStop();
});

test('lifecycle lock uses native process identity and reclaims a dead child owner', async (context) => {
  const directory = lockDirectory(context);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  writeOwner(directory, { token: 'dead-child', host: os.hostname(), pid: child.pid, startedAt: 'dead-generation' });
  const release = await acquireLifecycleLock({ directory });
  assert.equal(readLockOwner(directory).pid, process.pid);
  release();
});

function runLockChild(directory, ledger) {
  const modulePath = require.resolve('../lib/lifecycle-lock.js');
  const script = `const fs = require('node:fs'); const { withLifecycleLock } = require(${JSON.stringify(modulePath)}); withLifecycleLock(async () => { fs.appendFileSync(process.argv[2], 'enter ' + process.pid + '\\n'); await new Promise(resolve => setTimeout(resolve, 40)); fs.appendFileSync(process.argv[2], 'exit ' + process.pid + '\\n'); }, { directory: process.argv[1], timeout: 5000, inspectProcess: async () => ({ startedAt: 'generation' }) }).catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['-e', script, directory, ledger], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(output)));
  });
}

test('separate lifecycle callers never enter the critical section together', { timeout: 15000 }, async (context) => {
  const directory = lockDirectory(context);
  const ledger = path.join(path.dirname(directory), 'ledger');
  await Promise.all([runLockChild(directory, ledger), runLockChild(directory, ledger)]);
  const entries = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(entries.length, 4);
  assert.equal(entries[0].replace('enter', 'exit'), entries[1]);
  assert.equal(entries[2].replace('enter', 'exit'), entries[3]);
  assert.equal(fs.existsSync(directory), false);
});
