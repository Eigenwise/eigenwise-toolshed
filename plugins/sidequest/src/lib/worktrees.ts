'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

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

async function classifyWorktree(repo: string, tickets: any[], entry: any, currentPath: string): Promise<any> {
  const ticket = ticketForWorktree(tickets, entry);
  const [cleanResult, ancestorResult, aheadResult] = await Promise.all([
    git(entry.worktree, ['status', '--porcelain']),
    git(entry.worktree, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']),
    git(entry.worktree, ['rev-list', '--count', 'origin/main..HEAD']),
  ]);
  const clean = cleanResult.ok ? cleanResult.stdout === '' : false;
  const ancestor = ancestorResult.ok;
  const ahead = aheadResult.ok ? Number(aheadResult.stdout) : null;
  const current = normalize(entry.worktree) === normalize(currentPath);
  const integrated = !!(ticket && ticket.submission && ticket.submission.integratedAt);

  let action = 'keep';
  let reason = 'not_merged';
  if (current) reason = 'current_worktree';
  else if (entry.locked) reason = 'locked';
  else if (!clean) reason = 'dirty';
  else if (integrated) {
    action = 'remove';
    reason = 'integrated';
  } else if (ticket && ticket.status === 'done') {
    action = 'remove';
    reason = 'done';
  } else if (ancestor) {
    action = 'remove';
    reason = 'merged';
  } else if (ahead != null && ahead > 0) reason = 'ahead';

  return {
    path: entry.worktree,
    branch: entry.branch || null,
    ticket: ticket ? ticket.ref : null,
    clean,
    ancestor,
    ahead,
    locked: entry.locked || null,
    action,
    reason,
  };
}

async function sweep(repo: string, tickets: any[], options: any = {}): Promise<any> {
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(listed.stderr || 'could not list git worktrees');
  const candidates = parseWorktreeList(listed.stdout)
    .filter((entry) => isAgentWorktree(repo, entry.worktree));
  const entries = await Promise.all(candidates.map((entry) => (
    classifyWorktree(repo, tickets, entry, options.currentPath || process.cwd())
  )));
  const execute = !!options.execute;
  const removed: string[] = [];
  const failures: Array<{ path: string | null; message: string }> = [];

  if (execute) {
    for (const entry of entries.filter((candidate) => candidate.action === 'remove')) {
      const result = await git(repo, ['worktree', 'remove', '--force', entry.path]);
      if (result.ok) removed.push(entry.path);
      else failures.push({ path: entry.path, message: result.stderr || 'git worktree remove failed' });
    }
    if (removed.length) {
      const prune = await git(repo, ['worktree', 'prune']);
      if (!prune.ok) failures.push({ path: null, message: prune.stderr || 'git worktree prune failed' });
    }
  }

  return { dryRun: !execute, entries, removed, failures };
}

module.exports = { parseWorktreeList, isAgentWorktree, classifyWorktree, sweep };
