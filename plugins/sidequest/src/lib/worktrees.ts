'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const DEFAULT_MIN_AGE_MS = 3 * 60 * 60 * 1000;

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, status: null, stdout: '', stderr: String(error.message || '').trim() });
    });
    child.once('close', (status: number | null) => {
      resolve({
        ok: status === 0,
        status,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

function normalize(value: unknown): string {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseWorktreeList(output: string): any[] {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const entry: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^(worktree|HEAD|branch|locked)\s*(.*)$/.exec(line);
      if (match?.[1] && match[2] != null) entry[match[1].toLowerCase()] = match[2];
    }
    return entry;
  }).filter((entry) => entry.worktree);
}

function isAgentWorktree(repo: string, worktree: string): boolean | string {
  const parent = path.join(repo, '.claude', 'worktrees');
  const relative = path.relative(parent, worktree);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && !relative.includes(path.sep) && path.basename(relative).startsWith('agent-');
}

function ticketForWorktree(tickets: any[], entry: any): any | null {
  const worktree = normalize(entry.worktree);
  const submitted = tickets.find((ticket) => ticket.submission && ticket.submission.worktree
    && normalize(ticket.submission.worktree) === worktree);
  if (submitted) return submitted;
  const ref = /(?:^|[^A-Z0-9])(SQ-\d+)(?:$|[^A-Z0-9])/i.exec(entry.branch || '');
  return ref?.[1]
    ? tickets.find((ticket) => ticket.ref.toUpperCase() === ref[1]!.toUpperCase()) || null
    : null;
}

function localBranchName(ref: unknown): string | null {
  const match = /^refs\/heads\/(.+)$/.exec(String(ref || ''));
  return match?.[1] || null;
}

function integrationUpstream(options: any): string {
  const target = options.integrationTarget || {};
  return String(target.upstream || options.upstream || 'main');
}

async function worktreeAge(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Math.max(0, Date.now() - stat.mtimeMs);
  } catch (_) {
    return null;
  }
}

async function patchEquivalence(repo: string, revision: string, upstream: string): Promise<any> {
  const base = await git(repo, ['merge-base', revision, upstream]);
  if (!base.ok || !base.stdout) return { equivalent: false, ahead: null, equivalentCommits: 0, unmatchedCommits: null };

  const [ahead, cherry] = await Promise.all([
    git(repo, ['rev-list', '--count', `${base.stdout}..${revision}`]),
    git(repo, ['cherry', upstream, revision, base.stdout]),
  ]);
  const aheadCount = ahead.ok && /^\d+$/.test(ahead.stdout) ? Number(ahead.stdout) : null;
  if (aheadCount == null || !cherry.ok) {
    return { equivalent: false, ahead: aheadCount, equivalentCommits: 0, unmatchedCommits: null };
  }

  const marks = cherry.stdout ? cherry.stdout.split(/\r?\n/).filter(Boolean).map((line) => line[0]) : [];
  const equivalentCommits = marks.filter((mark) => mark === '-').length;
  const unmatchedCommits = marks.filter((mark) => mark !== '-').length;
  return {
    equivalent: marks.length === aheadCount && unmatchedCommits === 0,
    ahead: aheadCount,
    equivalentCommits,
    unmatchedCommits,
  };
}

async function classifyWorktree(repo: string, tickets: any[], entry: any, currentPath: string, minAgeMs: number, upstream: string): Promise<any> {
  const ticket = ticketForWorktree(tickets, entry);
  const [cleanResult, ageMs, patch] = await Promise.all([
    git(entry.worktree, ['status', '--porcelain']),
    worktreeAge(entry.worktree),
    patchEquivalence(entry.worktree, 'HEAD', upstream),
  ]);
  const clean = cleanResult.ok ? cleanResult.stdout === '' : false;
  const current = normalize(entry.worktree) === normalize(currentPath);
  const oldEnough = ageMs != null && ageMs >= minAgeMs;

  let action = 'keep';
  let reason = 'not_patch_equivalent';
  if (current) reason = 'current_worktree';
  else if (entry.locked) reason = 'locked';
  else if (!clean) reason = 'dirty';
  else if (!patch.equivalent) reason = 'not_patch_equivalent';
  else if (!oldEnough) reason = ageMs == null ? 'age_unknown' : 'too_recent';
  else {
    action = 'remove';
    reason = 'clean_patch_equivalent_old';
  }

  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean,
    ahead: patch.ahead,
    patchEquivalent: patch.equivalent,
    equivalentCommits: patch.equivalentCommits,
    unmatchedCommits: patch.unmatchedCommits,
    ageMs,
    minAgeMs,
    oldEnough,
    locked: entry.locked || null,
    action,
    reason,
  };
}

async function findOrphanBranches(repo: string, checkedOutBranches: Set<string>, upstream: string): Promise<any[]> {
  const result = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-agent-*']);
  if (!result.ok) throw new Error(result.stderr || 'could not list worktree branches');
  const branches = result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  return Promise.all(branches
    .filter((branch) => !checkedOutBranches.has(branch))
    .map(async (branch) => {
      const patch = await patchEquivalence(repo, branch, upstream);
      return {
        branch,
        ahead: patch.ahead,
        patchEquivalent: patch.equivalent,
        equivalentCommits: patch.equivalentCommits,
        unmatchedCommits: patch.unmatchedCommits,
        action: patch.equivalent ? 'prune' : 'keep',
        reason: patch.equivalent ? 'patch_equivalent_orphan' : 'not_patch_equivalent',
      };
    }));
}

async function sweep(repo: string, tickets: any[], options: any = {}): Promise<any> {
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(listed.stderr || 'could not list git worktrees');
  const minAgeMs = Number.isFinite(Number(options.minAgeMs)) && Number(options.minAgeMs) >= 0
    ? Number(options.minAgeMs)
    : DEFAULT_MIN_AGE_MS;
  const upstream = integrationUpstream(options);
  const worktreeList = parseWorktreeList(listed.stdout);
  const candidates = worktreeList.filter((entry) => isAgentWorktree(repo, entry.worktree));
  const entries = await Promise.all(candidates.map((entry) => (
    classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd(), minAgeMs, upstream)
  )));
  const execute = !!options.execute;
  const removed: string[] = [];
  const deletedBranches: string[] = [];
  const prunedOrphanBranches: string[] = [];
  const failures: Array<{ path: string | null; message: string }> = [];

  if (execute) {
    for (const entry of entries.filter((candidate) => candidate.action === 'remove')) {
      const result = await git(repo, ['worktree', 'remove', entry.path]);
      if (!result.ok) {
        failures.push({ path: entry.path, message: result.stderr || 'git worktree remove failed' });
        continue;
      }
      removed.push(entry.path);
      const branch = localBranchName(entry.branch);
      if (!branch) continue;
      const deleted = await git(repo, ['branch', '-D', '--', branch]);
      if (deleted.ok) deletedBranches.push(branch);
      else failures.push({ path: branch, message: deleted.stderr || 'git branch delete failed' });
    }
    if (removed.length) {
      const prune = await git(repo, ['worktree', 'prune']);
      if (!prune.ok) failures.push({ path: null, message: prune.stderr || 'git worktree prune failed' });
    }
  }

  const remainingList = execute ? await git(repo, ['worktree', 'list', '--porcelain']) : listed;
  if (!remainingList.ok) throw new Error(remainingList.stderr || 'could not list git worktrees');
  const remainingWorktrees = parseWorktreeList(remainingList.stdout);
  const checkedOutBranches = new Set<string>(remainingWorktrees
    .map((entry) => localBranchName(entry.branch))
    .filter((branch): branch is string => !!branch));
  const orphanBranches = await findOrphanBranches(repo, checkedOutBranches, upstream);
  if (execute) {
    for (const entry of orphanBranches.filter((candidate) => candidate.action === 'prune')) {
      const deleted = await git(repo, ['branch', '-D', '--', entry.branch]);
      if (deleted.ok) prunedOrphanBranches.push(entry.branch);
      else failures.push({ path: entry.branch, message: deleted.stderr || 'git branch delete failed' });
    }
  }

  return {
    dryRun: !execute,
    minAgeMs,
    upstream,
    entries,
    orphanBranches,
    removed,
    deletedBranches,
    prunedOrphanBranches,
    counts: {
      removedWorktrees: removed.length,
      deletedBranches: deletedBranches.length,
      prunedOrphanBranches: prunedOrphanBranches.length,
    },
    failures,
  };
}

module.exports = { DEFAULT_MIN_AGE_MS, parseWorktreeList, isAgentWorktree, classifyWorktree, sweep };
