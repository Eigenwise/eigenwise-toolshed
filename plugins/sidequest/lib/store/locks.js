"use strict";
function createLocks(dependencies) {
  const { fs, path, ticketsDir, transaction } = dependencies;
  function ticketLockPath(slug, id) {
    return path.join(ticketsDir(slug), "." + path.basename(String(id)) + ".lock");
  }
  const lockSleep = new Int32Array(new SharedArrayBuffer(4));
  function busyWait(ms) {
    Atomics.wait(lockSleep, 0, 0, ms);
  }
  function testClaimLockDelayMs() {
    const delay = Number(process.env.SIDEQUEST_TEST_CLAIM_LOCK_DELAY_MS);
    return Number.isInteger(delay) && delay > 0 ? delay : 0;
  }
  function acquireLock(lockPath, options = {}) {
    const STALE_LOCK_MS = 3e4;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = options.wait === false ? 2 : STALE_LOCK_MS / RETRY_MS;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeSync(fd, String(process.pid) + " " + (/* @__PURE__ */ new Date()).toISOString());
        } catch (_) {
        }
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if (!e || e.code !== "EEXIST") return false;
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            try {
              fs.unlinkSync(lockPath);
            } catch (_) {
            }
            continue;
          }
        } catch (_) {
          continue;
        }
        busyWait(RETRY_MS);
      }
    }
    return false;
  }
  function releaseLock(lockPath) {
    const RETRY_MS = 5;
    for (let attempt = 0; attempt < 1e3; attempt++) {
      try {
        fs.unlinkSync(lockPath);
        return;
      } catch (error) {
        if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) return;
        busyWait(RETRY_MS);
      }
    }
  }
  function withTicketLock(slug, id, fn) {
    const lock = ticketLockPath(slug, id);
    if (!acquireLock(lock)) return { ok: false, reason: "busy" };
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
    withTicketLock
  };
}
module.exports = { createLocks };
