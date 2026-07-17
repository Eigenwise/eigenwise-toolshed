'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const STALE_LOCK_MS = 60 * 1000;

function stale(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch (_) {
    return false;
  }
}

function acquire(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: crypto.randomBytes(8).toString('hex') }) + '\n');
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || !stale(lockPath)) return false;
      try {
        fs.renameSync(lockPath, lockPath + '.stale-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
      } catch (_) {
        return false;
      }
    }
  }
  return false;
}

function withMigrationLock(lockPath, work) {
  if (!acquire(lockPath)) return { locked: true, migrated: false };
  try {
    return work();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (_) {
    }
  }
}

module.exports = { STALE_LOCK_MS, withMigrationLock };
