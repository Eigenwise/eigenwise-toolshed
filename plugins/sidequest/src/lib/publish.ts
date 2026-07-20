'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const LOCK_BASENAME = 'sidequest-publish.lock';
const DEFAULT_PUBLISH_TTL_MIN = 30;

function publishTtlMs(): number {
  const min = Number(process.env.SIDEQUEST_PUBLISH_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_PUBLISH_TTL_MIN) * 60 * 1000;
}

async function gitCommonDir(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  });
  return path.resolve(repoPath, String(stdout).trim());
}

async function lockFile(repoPath: string): Promise<string> {
  return path.join(await gitCommonDir(repoPath), LOCK_BASENAME);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function readHolder(file: string): Promise<any | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function holderStale(holder: any): boolean {
  if (!holder) return true;
  const at = Date.parse(holder.at);
  if (!Number.isFinite(at) || Date.now() - at > publishTtlMs()) return true;
  const pid = Number(holder.pid);
  return !holder.transient
    && holder.host === os.hostname()
    && Number.isFinite(pid)
    && pid > 0
    && !pidAlive(pid);
}

function sameOwner(holder: any, opts: any): boolean {
  if (!holder) return false;
  const sessionId = opts.sessionId != null ? String(opts.sessionId).trim() : '';
  const by = opts.by != null ? String(opts.by).trim() : '';
  if (sessionId && holder.sessionId) return String(holder.sessionId) === sessionId;
  if (by && holder.by) return String(holder.by) === by;
  if (sessionId || by || holder.sessionId || holder.by) return false;
  return holder.host === os.hostname() && Number(holder.pid) === process.pid;
}

async function acquirePublishLock(repoPath: string, opts: any = {}): Promise<any> {
  const file = await lockFile(repoPath);
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
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info, null, 2));
      } finally {
        await handle.close();
      }
      return { ok: true, file, lock: info };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = await readHolder(file);
      if (sameOwner(holder, info)) {
        await fs.writeFile(file, JSON.stringify(Object.assign({}, holder, info), null, 2));
        return { ok: true, file, lock: info, reacquired: true };
      }
      if (holderStale(holder) || opts.steal) {
        try {
          await fs.unlink(file);
        } catch {
          // Another publisher may have reclaimed the lock before this unlink.
        }
        continue;
      }
      return { ok: false, reason: 'held', file, holder, stale: false };
    }
  }
  return { ok: false, reason: 'busy', file };
}

async function releasePublishLock(repoPath: string, opts: any = {}): Promise<any> {
  const file = await lockFile(repoPath);
  const holder = await readHolder(file);
  if (!holder && !(await fileExists(file))) return { ok: true, file, released: null };
  if (holder && !sameOwner(holder, opts) && !opts.force) {
    return { ok: false, reason: 'not_owner', file, holder };
  }
  try {
    await fs.unlink(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { ok: true, file, released: holder };
}

async function publishLockStatus(repoPath: string): Promise<any> {
  const file = await lockFile(repoPath);
  const exists = await fileExists(file);
  const holder = exists ? await readHolder(file) : null;
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
