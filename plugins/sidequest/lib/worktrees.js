'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function normalize(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseWorktreeList(output) {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const entry = {};
    for (const line of block.split(/\r?\n/)) {
      const match = /^(worktree|HEAD|branch|locked)\s*(.*)$/.exec(line);
      if (match) entry[match[1].toLowerCase()] = match[2];
    }
    return entry;
  }).filter((entry) => entry.worktree);
}

function isAgentWorktree(repo, worktree) {
  const parent = path.join(repo, '.claude', 'worktrees');
  const relative = path.relative(parent, worktree);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && !relative.includes(path.sep) && path.basename(relative).startsWith('agent-');
}

function ticketForWorktree(tickets, entry) {
  const worktree = normalize(entry.worktree);
  const submitted = tickets.find((ticket) => ticket.submission && ticket.submission.worktree
    && normalize(ticket.submission.worktree) === worktree);
  if (submitted) return submitted;
  const ref = /(?:^|[^A-Z0-9])(SQ-\d+)(?:$|[^A-Z0-9])/i.exec(entry.branch || '');
  return ref ? tickets.find((ticket) => ticket.ref.toUpperCase() === ref[1].toUpperCase()) || null : null;
}

function classifyWorktree(repo, tickets, entry, currentPath) {
  const ticket = ticketForWorktree(tickets, entry);
  const cleanResult = git(entry.worktree, ['status', '--porcelain']);
  const clean = cleanResult.ok ? cleanResult.stdout === '' : false;
  const ancestor = git(entry.worktree, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).ok;
  const aheadResult = git(entry.worktree, ['rev-list', '--count', 'origin/main..HEAD']);
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

function sweep(repo, tickets, options) {
  const listed = git(repo, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(listed.stderr || 'could not list git worktrees');
  const entries = parseWorktreeList(listed.stdout)
    .filter((entry) => isAgentWorktree(repo, entry.worktree))
    .map((entry) => classifyWorktree(repo, tickets, entry, (options && options.currentPath) || process.cwd()));
  const execute = !!(options && options.execute);
  const removed = [];
  const failures = [];

  if (execute) {
    for (const entry of entries.filter((entry) => entry.action === 'remove')) {
      const result = git(repo, ['worktree', 'remove', '--force', entry.path]);
      if (result.ok) removed.push(entry.path);
      else failures.push({ path: entry.path, message: result.stderr || 'git worktree remove failed' });
    }
    if (removed.length) {
      const prune = git(repo, ['worktree', 'prune']);
      if (!prune.ok) failures.push({ path: null, message: prune.stderr || 'git worktree prune failed' });
    }
  }

  return { dryRun: !execute, entries, removed, failures };
}

module.exports = { parseWorktreeList, isAgentWorktree, classifyWorktree, sweep };
