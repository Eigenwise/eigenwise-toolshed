'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonicalPath } = require('./worktrees.js') as { canonicalPath: (value: unknown) => string };

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

function lockTargetsRepository(holder: any, repoPath: string): boolean {
  return !holder?.repo || canonicalPath(holder.repo) === canonicalPath(repoPath);
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
    repo: canonicalPath(repoPath),
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

function publishLockOwnedBySession(repoPath: string, sessionId: unknown): boolean {
  const owner = String(sessionId || '').trim();
  if (!owner) return false;
  try {
    const commonDir = require('node:child_process').execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const file = path.join(path.resolve(repoPath, commonDir), LOCK_BASENAME);
    const holder = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    return sameOwner(holder, { sessionId: owner }) && lockTargetsRepository(holder, repoPath);
  } catch {
    return false;
  }
}

async function publishedBranch(repoPath: string, remote: string = 'origin'): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    const ref = String(stdout).trim();
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  } catch {
    // A clone may not have fetched the remote HEAD yet.
  }
  try {
    const { stdout } = await execFileAsync('git', ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    const branches = String(stdout).split(/\r?\n/)
      .map((branch) => branch.replace(`${remote}/`, ''))
      .filter((branch) => branch && branch !== 'HEAD');
    return ['main', 'master', 'trunk'].find((branch) => branches.includes(branch)) || branches[0] || 'main';
  } catch {
    return 'main';
  }
}

async function latestRelease(repoPath: string): Promise<{ tag: string; at: string } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%00%(creatordate:iso-strict)', 'refs/tags/v*'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    });
    const [tag, at] = String(stdout).trim().split('\0');
    return tag && at ? { tag, at } : null;
  } catch {
    return null;
  }
}

async function releaseWindow(repoPath: string, integrationBranch: string): Promise<any | null> {
  const directory = path.join(repoPath, '.release', 'unreleased');
  let entries: any[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const fragments = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  const held = await Promise.all(fragments.map(async (entry) => {
    try {
      const text = await fs.readFile(path.join(directory, entry.name), 'utf8');
      const closing = text.indexOf('\n---', 3);
      return text.startsWith('---\n') && closing >= 0 && /^hold:\s*true\s*$/mi.test(text.slice(3, closing));
    } catch {
      return false;
    }
  }));
  return {
    fragmentCount: fragments.length,
    heldCount: held.filter(Boolean).length,
    latestRelease: await latestRelease(repoPath),
    integrationBranch,
    publishedBranch: await publishedBranch(repoPath),
    nextScheduledCut: 'daily at 06:00 local',
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
  publishLockOwnedBySession,
  publishedBranch,
  latestRelease,
  releaseWindow,
};
