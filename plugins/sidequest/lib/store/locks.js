"use strict";
function createLocks(dependencies) {
  const { fs, path, ticketsDir, transaction, refuseUnderGuardedWrite = () => {
  } } = dependencies;
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
  function newLockOwnerToken() {
    return `${process.pid}-${Date.now()}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`;
  }
  function readLockOwner(lockPath) {
    try {
      const content = fs.readFileSync(lockPath, "utf8").trim();
      const parsed = JSON.parse(content);
      const pid = Number(parsed?.pid);
      const token = typeof parsed?.token === "string" ? parsed.token : null;
      return Number.isInteger(pid) && pid > 0 ? { pid, token } : null;
    } catch (_) {
      return null;
    }
  }
  function lockOwnerIsAlive(owner) {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return null;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  function lockCanBeReclaimed(lockPath) {
    const owner = readLockOwner(lockPath);
    const ownerIsAlive = lockOwnerIsAlive(owner);
    if (ownerIsAlive != null) return !ownerIsAlive;
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > 3e4;
    } catch (_) {
      return true;
    }
  }
  function ownerTokenValue(ownerToken) {
    if (typeof ownerToken === "string") return ownerToken;
    return typeof ownerToken?.token === "string" ? ownerToken.token : null;
  }
  function lockOwnerMatches(lockPath, ownerToken) {
    const owner = readLockOwner(lockPath);
    return ownerTokenValue(ownerToken) != null && owner?.token === ownerTokenValue(ownerToken);
  }
  function acquireLock(lockPath, options = {}) {
    refuseUnderGuardedWrite(`waiting on lock file ${path.basename(String(lockPath))}`);
    const STALE_LOCK_MS = 3e4;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = options.wait === false ? 2 : STALE_LOCK_MS / RETRY_MS;
    const ownerToken = newLockOwnerToken();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken }));
        } catch (_) {
          fs.closeSync(fd);
          try {
            fs.unlinkSync(lockPath);
          } catch (_2) {
          }
          return false;
        }
        fs.closeSync(fd);
        return { token: ownerToken, refresh: () => refreshLock(lockPath, ownerToken) };
      } catch (error) {
        if (!error || error.code !== "EEXIST") return false;
        if (lockCanBeReclaimed(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {
          }
          continue;
        }
        busyWait(RETRY_MS);
      }
    }
    return false;
  }
  function refreshLock(lockPath, ownerToken) {
    if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: "lock_owner_lost" };
    try {
      const now = /* @__PURE__ */ new Date();
      fs.utimesSync(lockPath, now, now);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: "lock_owner_lost" };
    }
  }
  function releaseLock(lockPath, ownerToken) {
    const RETRY_MS = 5;
    for (let attempt = 0; attempt < 1e3; attempt++) {
      if (!lockOwnerMatches(lockPath, ownerToken)) return { ok: false, reason: "lock_owner_lost" };
      try {
        fs.unlinkSync(lockPath);
        return { ok: true };
      } catch (error) {
        if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) return { ok: false, reason: "lock_owner_lost" };
        busyWait(RETRY_MS);
      }
    }
    return { ok: false, reason: "lock_owner_lost" };
  }
  function orderedTicketLockPaths(keys) {
    return [...new Set(keys.map((key) => ticketLockPath(key.slug, key.id)))].sort();
  }
  function withTicketFileLocks(keys, fn) {
    const held = [];
    try {
      for (const lockPath of orderedTicketLockPaths(keys)) {
        const owner = acquireLock(lockPath);
        if (!owner) return { ok: false, reason: "busy" };
        held.push({ lockPath, owner });
      }
      return fn();
    } finally {
      for (const { lockPath, owner } of held.reverse()) releaseLock(lockPath, owner);
    }
  }
  function withTicketLocks(keys, fn) {
    return withTicketFileLocks(keys, () => transaction(fn));
  }
  function withTicketLock(slug, id, fn) {
    return withTicketLocks([{ slug, id }], fn);
  }
  return {
    acquireLock,
    busyWait,
    refreshLock,
    releaseLock,
    testClaimLockDelayMs,
    ticketLockPath,
    withTicketFileLocks,
    withTicketLock,
    withTicketLocks
  };
}
module.exports = { createLocks };
