'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { STATE } = require('./runtime.js');

const ownedLifecycle = new AsyncLocalStorage();
const STOP_PATH = path.join(STATE, 'intentionally-stopped.json');
const LOCK_PATH = path.join(STATE, 'lifecycle.lock');

function readLockOwner(directory) {
  try {
    const files = fs.readdirSync(directory);
    if (files.length !== 1) return null;
    const file = path.join(directory, files[0]);
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return owner.token === files[0] ? { ...owner, file } : null;
  } catch { return null; }
}

function processAbsent(identifier) {
  try { process.kill(identifier, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function identifiableLocalOwner(owner) {
  if (owner?.host !== os.hostname()) return false;
  return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.startedAt === 'string';
}

async function lockOwnerIsDead(owner, inspectProcess) {
  if (!identifiableLocalOwner(owner)) return false;
  if (processAbsent(owner.pid)) return true;
  const current = await inspectProcess(owner.pid);
  if (!current?.startedAt) return false;
  return current.startedAt !== owner.startedAt;
}

function removeOwnedDirectory(directory, token) {
  try { fs.unlinkSync(path.join(directory, token)); } catch { return; }
  // Remove only an empty directory. A delayed release/reaper must never remove a replacement owner's file.
  try { fs.rmdirSync(directory); } catch {}
}

function installLock(prepared, directory) {
  try { fs.renameSync(prepared, directory); return true; }
  catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

function prepareLock(directory, identity) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const token = crypto.randomUUID();
  const prepared = fs.mkdtempSync(`${directory}.candidate-`);
  fs.writeFileSync(path.join(prepared, token), JSON.stringify({ token, pid: process.pid, startedAt: identity.startedAt, host: os.hostname() }), { mode: 0o600 });
  return { token, prepared };
}

async function waitForLock(prepared, directory, timeout, inspect) {
  const deadline = Date.now() + timeout;
  while (!installLock(prepared, directory)) {
    const owner = readLockOwner(directory);
    if (await lockOwnerIsDead(owner, inspect)) removeOwnedDirectory(directory, owner.token);
    if (Date.now() >= deadline) throw new Error(`gateway lifecycle is busy or ownership is unknown (${directory}); retry recover or run doctor`);
    await pause(50);
  }
}

async function acquireLifecycleLock({ directory = LOCK_PATH, timeout = 15000, inspectProcess } = {}) {
  const inspect = inspectProcess || ((identifier) => require('./process-supervision.js').processInfoAsync(identifier, { timeout: 8000 }));
  const identity = await inspect(process.pid);
  if (!identity?.startedAt) throw new Error('could not establish lifecycle lock process identity; run doctor');
  const { token, prepared } = prepareLock(directory, identity);
  try {
    await waitForLock(prepared, directory, timeout, inspect);
    return () => removeOwnedDirectory(directory, token);
  } finally {
    removeOwnedDirectory(prepared, token);
  }
}

async function withLifecycleLock(operation, options) {
  if (ownedLifecycle.getStore()?.active) return operation();
  const release = await acquireLifecycleLock(options);
  const ownership = { active: true };
  try { return await ownedLifecycle.run(ownership, operation); }
  finally { ownership.active = false; release(); }
}

function intentionallyStopped() {
  return fs.existsSync(STOP_PATH);
}

function recordIntentionalStop() {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(STOP_PATH, JSON.stringify({ stoppedAt: new Date().toISOString() }), { mode: 0o600 });
}

function resumeIntentionalStop() {
  try { fs.unlinkSync(STOP_PATH); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { LOCK_PATH, STOP_PATH, acquireLifecycleLock, intentionallyStopped, lockOwnerIsDead, readLockOwner, recordIntentionalStop, removeOwnedDirectory, resumeIntentionalStop, withLifecycleLock };
