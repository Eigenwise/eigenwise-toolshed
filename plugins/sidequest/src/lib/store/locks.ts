'use strict';

function createLocks(dependencies: any) {
  const { fs, path, ticketsDir, transaction } = dependencies;

  function ticketLockPath(slug?: any, id?: any) {
    return path.join(ticketsDir(slug), '.' + path.basename(String(id)) + '.lock');
  }

  const lockSleep = new Int32Array(new SharedArrayBuffer(4));

  function busyWait(ms?: any) {
    Atomics.wait(lockSleep, 0, 0, ms);
  }

  function testClaimLockDelayMs() {
    const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
    return Number.isInteger(delay) && delay > 0 ? delay : 0;
  }

  function newLockOwnerToken() {
    return `${process.pid}-${Date.now()}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`;
  }

  function readLockOwner(lockPath?: any) {
    try {
      const content = fs.readFileSync(lockPath, 'utf8').trim();
      const parsed = JSON.parse(content);
      const pid = Number(parsed?.pid);
      const token = typeof parsed?.token === 'string' ? parsed.token : null;
      return Number.isInteger(pid) && pid > 0 ? { pid, token } : null;
    } catch (_: any) {
      return null;
    }
  }

  function lockOwnerIsAlive(owner?: any) {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return null;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === 'EPERM';
    }
  }

  function lockCanBeReclaimed(lockPath?: any) {
    const owner = readLockOwner(lockPath);
    const ownerIsAlive = lockOwnerIsAlive(owner);
    if (ownerIsAlive != null) return !ownerIsAlive;
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 30000;
    } catch (_: any) {
      return true;
    }
  }

  function ownerTokenValue(ownerToken?: any) {
    if (typeof ownerToken === 'string') return ownerToken;
    return typeof ownerToken?.token === 'string' ? ownerToken.token : null;
  }

  function lockOwnerMatches(lockPath?: any, ownerToken?: any) {
    const owner = readLockOwner(lockPath);
    return ownerTokenValue(ownerToken) != null && owner?.token === ownerTokenValue(ownerToken);
  }

  function acquireLock(lockPath?: any, options: any = {}) {
    const STALE_LOCK_MS = 30000;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = options.wait === false ? 2 : STALE_LOCK_MS / RETRY_MS;
    const ownerToken = newLockOwnerToken();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken }));
        } catch (_: any) {
          fs.closeSync(fd);
          try { fs.unlinkSync(lockPath); } catch (_: any) { /* ignore */ }
          return false;
        }
        fs.closeSync(fd);
        return { token: ownerToken, refresh: () => refreshLock(lockPath, ownerToken) };
      } catch (error: any) {
        if (!error || error.code !== 'EEXIST') return false;
        if (lockCanBeReclaimed(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_: any) {
            /* ignore */
          }
          continue;
        }
        busyWait(RETRY_MS);
      }
    }
    return false;
  }

  function refreshLock(lockPath?: any, ownerToken?: any) {
    if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: 'lock_owner_lost' };
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
      return { ok: true };
    } catch (_: any) {
      return { ok: false, reason: 'lock_owner_lost' };
    }
  }

  function releaseLock(lockPath?: any, ownerToken?: any) {
    const RETRY_MS = 5;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: 'lock_owner_lost' };
      try {
        fs.unlinkSync(lockPath);
        return { ok: true };
      } catch (error: any) {
        if (!error || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) return { ok: false, reason: 'lock_owner_lost' };
        busyWait(RETRY_MS);
      }
    }
    return { ok: false, reason: 'lock_owner_lost' };
  }

  function withTicketLock(slug?: any, id?: any, fn?: any) {
    const lock = ticketLockPath(slug, id);
    const ownerToken = acquireLock(lock);
    if (!ownerToken) return { ok: false, reason: 'busy' };
    try {
      return transaction(fn);
    } finally {
      releaseLock(lock, ownerToken);
    }
  }

  return {
    acquireLock,
    busyWait,
    refreshLock,
    releaseLock,
    testClaimLockDelayMs,
    ticketLockPath,
    withTicketLock,
  };
}

module.exports = { createLocks };
