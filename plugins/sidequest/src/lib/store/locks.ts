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

  function acquireLock(lockPath?: any) {
    const STALE_LOCK_MS = 30000;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = STALE_LOCK_MS / RETRY_MS;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
        } catch (_: any) {
          /* ignore */
        }
        fs.closeSync(fd);
        return true;
      } catch (e: any) {
        if (!e || e.code !== 'EEXIST') return false;
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            try {
              fs.unlinkSync(lockPath);
            } catch (_: any) {
              /* ignore */
            }
            continue;
          }
        } catch (_: any) {
          continue;
        }
        busyWait(RETRY_MS);
      }
    }
    return false;
  }

  function releaseLock(lockPath?: any) {
    const RETRY_MS = 5;
    for (let attempt = 0; attempt < 1000; attempt++) {
      try {
        fs.unlinkSync(lockPath);
        return;
      } catch (error: any) {
        if (!error || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) return;
        busyWait(RETRY_MS);
      }
    }
  }

  function withTicketLock(slug?: any, id?: any, fn?: any) {
    const lock = ticketLockPath(slug, id);
    if (!acquireLock(lock)) return { ok: false, reason: 'busy' };
    try {
      return transaction(fn);
    } finally {
      releaseLock(lock);
    }
  }

  return {
    acquireLock,
    busyWait,
    releaseLock,
    testClaimLockDelayMs,
    ticketLockPath,
    withTicketLock,
  };
}

module.exports = { createLocks };
