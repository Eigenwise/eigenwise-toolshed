import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';

// SQ-3436. A read-only reviewer cloned the project under its ticket's verification directory with
// `git clone --no-checkout`, and `git restore --worktree -- .` was refused as a destructive write to the
// shared checkout with 896 doomed changes. Only the checkouts the board hands out are shared: the
// registered root and other executors' agent worktrees. Anything the executor cloned itself is admitted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-guard-isolation-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const GUARD_SHARED_CHECKOUT_GIT = path.join(HOOKS, 'guard-shared-checkout-git.js');
const GUARD_DESTRUCTIVE = path.join(HOOKS, 'guard-destructive-git.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(prefix: string): string {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Sidequest Test']);
  git(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'isolation fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo('sq-guard-isolation-project-');
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function runHook(script: string, payload: unknown) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME },
    windowsHide: true,
  });
  return out.trim() ? JSON.parse(out) : null;
}

function reason(out: any): string {
  return out ? out.hookSpecificOutput.permissionDecisionReason : '';
}

// The SQ-3436 shape: an index-only clone whose every tracked file reads as deleted until restored.
function evidenceClone(ref: string): string {
  const clone = path.join(SIDEQUEST_HOME, 'projects', slug, 'verification', ref, 'pr450');
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(path.dirname(clone), ['clone', '--no-checkout', '--no-hardlinks', PROJECT, clone]);
  return fs.realpathSync.native(clone);
}

function wholeTreeWrites(target: string): string[] {
  const shellPath = target.replace(/\\/g, '/');
  return [
    `git -C "${shellPath}" restore --source HEAD --worktree -- .`,
    `git -C "${shellPath}" checkout -- .`,
    `git -C "${shellPath}" reset --hard HEAD`,
  ];
}

function dispatched(agentId: string) {
  const ticket = store.createTicket(slug, {
    title: `guard fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch with worktree isolation.',
    files: ['README.md'],
  });
  const sessionId = `session-${agentId}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  const worktree = worktrees.resolvedAgentWorktree(PROJECT, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  return { sessionId, executor: store.getTicket(slug, ticket.ref).dispatchExecutor, worktree };
}

function linkedWorktree(target: string, branch: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(PROJECT, ['worktree', 'add', '-b', branch, target]);
  return fs.realpathSync.native(target);
}

test('destructive-git guard: an evidence clone under the ticket verification directory is not the shared checkout', () => {
  const clone = evidenceClone('SQ-3436');
  assert.ok(git(clone, ['status', '--porcelain']).length > 0, 'the --no-checkout clone reads as entirely dirty');
  for (const command of wholeTreeWrites(clone)) {
    assert.equal(runHook(GUARD_DESTRUCTIVE, { cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command } }), null, command);
  }
  assert.equal(runHook(GUARD_DESTRUCTIVE, { cwd: clone, tool_name: 'Bash', tool_input: { command: 'git restore --worktree -- .' } }), null, 'cwd inside the clone');
});

test('destructive-git guard: the same commands against the registered root with dirty work stay refused', () => {
  fs.writeFileSync(path.join(PROJECT, 'finished-work.txt'), 'nine files of finished work\n');
  try {
    for (const command of wholeTreeWrites(PROJECT)) {
      const out = runHook(GUARD_DESTRUCTIVE, { cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command } });
      assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny', command);
      assert.match(reason(out), /board-registered project root; your evidence clone is not one/);
      assert.match(reason(out), /git stash push/, 'the recovery step still fits the refusal budget');
    }
  } finally {
    fs.rmSync(path.join(PROJECT, 'finished-work.txt'));
  }
});

test('destructive-git guard: a dirty repository the board never registered is admitted', () => {
  const repo = initRepo('sq-guard-unregistered-');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'scratch\n');
  assert.equal(runHook(GUARD_DESTRUCTIVE, { cwd: repo, tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' } }), null);
});

test('shared-checkout git guard: an isolated executor mutates its evidence clone and own worktree, never the root or another executor\'s worktree', () => {
  const agentId = 'guard-own';
  const { sessionId, executor, worktree } = dispatched(agentId);
  const own = linkedWorktree(worktree, 'guard-own');
  const other = linkedWorktree(worktrees.resolvedAgentWorktree(PROJECT, 'guard-other'), 'guard-other');
  const clone = evidenceClone('SQ-3518');
  const run = (command: string) => runHook(GUARD_SHARED_CHECKOUT_GIT, {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd: own,
    tool_name: 'Bash',
    tool_input: { command },
  });

  for (const command of [...wholeTreeWrites(clone), ...wholeTreeWrites(own), 'git checkout -- .']) {
    assert.equal(run(command), null, command);
  }
  for (const target of [PROJECT, other]) {
    for (const command of wholeTreeWrites(target)) {
      const out = run(command);
      assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny', command);
      assert.match(reason(out), /mutating git command against the shared checkout/);
      assert.match(reason(out), /registered root and every other executor's worktree/);
      assert.match(reason(out), /verification directory or scratchpad is not it/);
    }
  }
  assert.equal(run(`git -C "${PROJECT.replace(/\\/g, '/')}" log --oneline`), null, 'read-only git against the root stays available');
});
