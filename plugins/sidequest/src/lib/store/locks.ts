'use strict';

type TicketLockKey = { slug: string; id: string };
type BusyTicketLock = { ok: false; reason: 'busy' };
const LOCK_HELD_ELSEWHERE = Symbol('lock held elsewhere');

function createLocks(dependencies: any) {
  const { fs, path, ticketsDir, transaction, refuseUnderGuardedWrite = () => {} } = dependencies;

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

  // Every lock file (ticket, workers, notifications) can wait for seconds, so none is taken inside a guarded write:
  // that waiter would hold the SQLite write lock while the lock's holder waits on SQLite (SQ-3449).
  function acquireLock(lockPath?: any, options: any = {}) {
    refuseUnderGuardedWrite(`waiting on lock file ${path.basename(String(lockPath))}`);
    const STALE_LOCK_MS = 30000;
    const RETRY_MS = 10;
    const MAX_ATTEMPTS = options.wait === false ? 2 : STALE_LOCK_MS / RETRY_MS;
    const ownerToken = newLockOwnerToken();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const created = createLockFile(lockPath, ownerToken);
      if (created !== LOCK_HELD_ELSEWHERE) return created;
      if (!removeReclaimableLock(lockPath)) busyWait(RETRY_MS);
    }
    return false;
  }

  function createLockFile(lockPath: string, ownerToken: string) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error: any) {
      return error?.code === 'EEXIST' ? LOCK_HELD_ELSEWHERE : false;
    }
    if (!writeLockOwner(lockPath, fd, ownerToken)) return false;
    return { token: ownerToken, refresh: () => refreshLock(lockPath, ownerToken) };
  }

  function writeLockOwner(lockPath: string, fd: number, ownerToken: string): boolean {
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken }));
    } catch (_: any) {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch (_: any) { /* ignore */ }
      return false;
    }
    fs.closeSync(fd);
    return true;
  }

  function removeReclaimableLock(lockPath: string): boolean {
    if (!lockCanBeReclaimed(lockPath)) return false;
    try {
      fs.unlinkSync(lockPath);
    } catch (_: any) {
      /* ignore */
    }
    return true;
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

  function orderedTicketLockPaths(keys: readonly TicketLockKey[]): string[] {
    return [...new Set(keys.map((key) => ticketLockPath(key.slug, key.id)))].sort();
  }

  // Every ticket file lock is taken, in one path order, before anything opens the SQLite write lock. Taking a
  // second file lock inside an open transaction ordered file(A) -> SQLite -> file(B) against plain writers'
  // file(B) -> SQLite, and that ABBA spun a whole retry budget while holding every project's writers (SQ-3348).
  function withTicketFileLocks<Result>(keys: readonly TicketLockKey[], fn: () => Result): Result | BusyTicketLock {
    const held: Array<{ lockPath: string; owner: { token: string } }> = [];
    try {
      for (const lockPath of orderedTicketLockPaths(keys)) {
        const owner = acquireLock(lockPath);
        if (!owner) return { ok: false, reason: 'busy' };
        held.push({ lockPath, owner });
      }
      return fn();
    } finally {
      for (const { lockPath, owner } of held.reverse()) releaseLock(lockPath, owner);
    }
  }

  function withTicketLocks<Result>(keys: readonly TicketLockKey[], fn: () => Result): Result | BusyTicketLock {
    return withTicketFileLocks(keys, () => transaction(fn));
  }

  function withTicketLock(slug?: any, id?: any, fn?: any) {
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
    withTicketLocks,
  };
}

module.exports = { createLocks };
