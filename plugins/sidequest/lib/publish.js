'use strict';
/**
 * sidequest - cross-process publish lock (SQ-398)
 *
 * The orchestrator control plane is the ONLY thing that publishes a repository:
 * it integrates submitted executor commits in a clean worktree, assigns
 * plugin/marketplace versions centrally, reverifies, and pushes main. That whole
 * transaction must be serialized across every session and process that can see
 * the repo, so the lock lives in the repository's COMMON git dir — shared by
 * all worktrees — not in any working tree (a lock in the tree would dirty it)
 * and not in SIDEQUEST_HOME (two homes could then publish concurrently).
 *
 * Crash recovery: the lock records owner pid + session metadata. A holder is
 * stale when its record is unreadable, its TTL (SIDEQUEST_PUBLISH_TTL_MIN,
 * default 30m) expired, or — for a long-lived owner process on this host — its
 * pid is dead. CLI acquisitions mark themselves `transient` because the CLI
 * process exits immediately while its session keeps publishing, so their
 * recovery signal is the TTL and the recorded session metadata, never pid
 * liveness. Re-acquiring with the same session id (or the same --by) refreshes
 * the lock instead of failing, so a publisher that lost a tool call mid-
 * transaction can resume without stealing from itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_BASENAME = 'sidequest-publish.lock';
const DEFAULT_PUBLISH_TTL_MIN = 30;

function publishTtlMs() {
  const min = Number(process.env.SIDEQUEST_PUBLISH_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_PUBLISH_TTL_MIN) * 60 * 1000;
}

// The one dir every worktree of a repo shares. Throws (with the git error) when
// repoPath is not inside a git repository — a publish lock outside a repo is
// meaningless, so that is a caller error, never a silent fallback.
function gitCommonDir(repoPath) {
  const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return path.resolve(repoPath, out);
}

function lockFile(repoPath) {
  return path.join(gitCommonDir(repoPath), LOCK_BASENAME);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM'); // alive but not ours
  }
}

function readHolder(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function holderStale(holder) {
  if (!holder) return true; // unreadable/corrupt: the writer crashed mid-write
  const at = Date.parse(holder.at);
  if (!Number.isFinite(at) || Date.now() - at > publishTtlMs()) return true;
  const pid = Number(holder.pid);
  if (!holder.transient && holder.host === os.hostname() && Number.isFinite(pid) && pid > 0 && !pidAlive(pid)) {
    return true;
  }
  return false;
}

// Identity comparison is strict: when both sides carry a session id (or, failing
// that, a --by), that field DECIDES — a mismatch is never rescued by the pid
// fallback, which exists only for anonymous in-process library callers.
function sameOwner(holder, opts) {
  if (!holder) return false;
  const sessionId = opts.sessionId != null ? String(opts.sessionId).trim() : '';
  const by = opts.by != null ? String(opts.by).trim() : '';
  if (sessionId && holder.sessionId) return String(holder.sessionId) === sessionId;
  if (by && holder.by) return String(holder.by) === by;
  if (sessionId || by || holder.sessionId || holder.by) return false;
  return holder.host === os.hostname() && Number(holder.pid) === process.pid;
}

// Acquire the repo's publish lock. Returns { ok:true, file, lock, reacquired? }
// or { ok:false, reason:'held', file, holder, stale:false }. A stale holder is
// reclaimed automatically; a live one is only taken over with opts.steal.
function acquirePublishLock(repoPath, opts) {
  opts = opts || {};
  const file = lockFile(repoPath);
  const info = {
    pid: process.pid,
    transient: !!opts.transient,
    by: opts.by != null && String(opts.by).trim() ? String(opts.by).trim() : null,
    sessionId: opts.sessionId != null && String(opts.sessionId).trim() ? String(opts.sessionId).trim() : null,
    host: os.hostname(),
    at: new Date().toISOString(),
    repo: path.resolve(repoPath),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(info, null, 2));
      fs.closeSync(fd);
      return { ok: true, file, lock: info };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const holder = readHolder(file);
      if (sameOwner(holder, info)) {
        // Same publisher resuming: refresh the timestamp in place.
        fs.writeFileSync(file, JSON.stringify(Object.assign({}, holder, info), null, 2));
        return { ok: true, file, lock: info, reacquired: true };
      }
      if (holderStale(holder) || opts.steal) {
        try {
          fs.unlinkSync(file);
        } catch (_) {
          // Someone else reclaimed it between read and unlink; retry the open.
        }
        continue;
      }
      return { ok: false, reason: 'held', file, holder, stale: false };
    }
  }
  return { ok: false, reason: 'busy', file };
}

// Release the lock. Only the recorded owner (session id, --by, or this pid on
// this host) may release without force. Releasing an unlocked repo is an
// idempotent success — retryable cleanup must never fail on already-clean.
function releasePublishLock(repoPath, opts) {
  opts = opts || {};
  const file = lockFile(repoPath);
  const holder = readHolder(file);
  if (!holder && !fs.existsSync(file)) return { ok: true, file, released: null };
  if (holder && !sameOwner(holder, opts) && !opts.force) {
    return { ok: false, reason: 'not_owner', file, holder };
  }
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  return { ok: true, file, released: holder };
}

function publishLockStatus(repoPath) {
  const file = lockFile(repoPath);
  const exists = fs.existsSync(file);
  const holder = exists ? readHolder(file) : null;
  return {
    locked: exists,
    file,
    holder,
    stale: exists ? holderStale(holder) : false,
    ttlMs: publishTtlMs(),
  };
}

module.exports = {
  LOCK_BASENAME,
  DEFAULT_PUBLISH_TTL_MIN,
  publishTtlMs,
  gitCommonDir,
  lockFile,
  acquirePublishLock,
  releasePublishLock,
  publishLockStatus,
};
