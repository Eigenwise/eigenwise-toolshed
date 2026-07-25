'use strict';

// SQ-826. An executor dispatched with worktree isolation paused for a scope
// request before its first edit, and the harness discarded the unchanged
// worktree when it stopped. The resume put it back in the SHARED checkout with
// no warning, and it wrote nine files onto main believing it was isolated.
// These cover the refusals that now make that loud.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-isolation-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const GUARD_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');
const GUARD_DESTRUCTIVE = path.join(HOOKS, 'guard-destructive-git.js');

function initRepo(prefix: string) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'isolation fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo('sq-isolation-project-');
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

function runCli(args: string[]) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function dispatched(agentId: string, options: { sharedTree?: boolean } = {}) {
  const ticket = store.createTicket(slug, {
    title: `isolation fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch that records whether isolation was promised.',
    files: ['README.md'],
  });
  const sessionId = `session-${agentId}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sharedTree: options.sharedTree === true,
    sessionId,
  });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  const bound = store.getTicket(slug, ticket.ref);
  return { ticket: bound, sessionId, executor: bound.dispatchExecutor };
}

function writePayload(agentId: string, executor: string, sessionId: string, filePath: string, cwd: string) {
  return {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
  };
}

test('a write into the shared checkout is refused when the dispatch promised a worktree', () => {
  const agentId = 'a1isolated';
  const { ticket, sessionId, executor } = dispatched(agentId);
  assert.equal(ticket.dispatch.sharedTree, false);

  const target = path.join(PROJECT, 'README.md');
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(ticket.ref), 'names the ticket');
  assert.ok(reason.includes(path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`)), 'names the expected worktree');
  assert.ok(reason.includes(target), 'names the path it refused to write');
  assert.ok(/re-dispatch/.test(reason), 'names the next legal action');
  assert.ok(/did nothing wrong|platform|harness/i.test(reason), 'blames the platform, not the executor');
});

test('a write inside the agent worktree is allowed', () => {
  const agentId = 'a2isolated';
  const { sessionId, executor } = dispatched(agentId);
  const target = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`, 'README.md');
  assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT)), null);
});

test('a junction alias to the shared checkout is refused', () => {
  const agentId = 'a2alias';
  const { sessionId, executor } = dispatched(agentId);
  const alias = path.join(os.tmpdir(), `sq-isolation-alias-${process.pid}-${Date.now()}`);
  fs.symlinkSync(PROJECT, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const target = path.join(alias, 'README.md');
    const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, alias));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(target));
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
  }
});

test('a linked worktree remains allowed', () => {
  const agentId = 'a2linked';
  const { sessionId, executor } = dispatched(agentId);
  const linked = path.join(os.tmpdir(), `sq-isolation-linked-${process.pid}-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(linked, 'README.md');
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, linked)), null);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('a missing target under the shared checkout is refused', () => {
  const agentId = 'a2missing';
  const { sessionId, executor } = dispatched(agentId);
  const target = path.join(PROJECT, 'new-folder', 'missing.txt');
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a shared-tree dispatch writes in the shared checkout without complaint', () => {
  const agentId = 'a3shared';
  const { ticket, sessionId, executor } = dispatched(agentId, { sharedTree: true });
  assert.equal(ticket.dispatch.sharedTree, true);
  const target = path.join(PROJECT, 'README.md');
  assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT)), null);
});

test('the isolation guard ignores the main thread, non-executors, and scratchpad writes', () => {
  const agentId = 'a4isolated';
  const { sessionId, executor } = dispatched(agentId);
  const target = path.join(PROJECT, 'README.md');

  const mainThread = writePayload(agentId, executor, sessionId, target, PROJECT);
  delete (mainThread as any).agent_id;
  assert.equal(runHook(GUARD_ISOLATION, mainThread), null, 'main thread is never guarded');

  const helper = writePayload(agentId, 'svelte:svelte-file-editor', sessionId, target, PROJECT);
  assert.equal(runHook(GUARD_ISOLATION, helper), null, 'a non-executor subagent is never guarded');

  const scratchpad = writePayload(agentId, executor, sessionId, path.join(os.tmpdir(), 'sq-scratch-note.md'), PROJECT);
  assert.equal(runHook(GUARD_ISOLATION, scratchpad), null, 'writes outside any repo stay allowed');
});

test('a terminal dispatch no longer expects isolation once nobody holds the claim', () => {
  const agentId = 'a5isolated';
  const { sessionId, executor } = dispatched(agentId);
  assert.ok(store.dispatchIsolationExpectation({ agentId, sessionId, executor }));
  assert.equal(store.markDispatchStopped(sessionId, executor, agentId, agentId).ok, true);
  assert.equal(store.dispatchIsolationExpectation({ agentId, sessionId, executor }), null);
});

// The incident's own shape: an executor that pauses for a scope request is
// stopped-and-claimed, and its next write happens after a resume. If a stamped
// terminalAt ended the contract, the guard would go quiet at the one moment the
// worktree is already gone.
test('an executor paused mid-ticket still expects its worktree after a resume', () => {
  const agentId = 'a9paused';
  const { ticket, sessionId, executor } = dispatched(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'paused-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.markDispatchStopped(sessionId, executor, agentId, agentId).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'stopped_claimed');

  const expectation = store.dispatchIsolationExpectation({ agentId, sessionId, executor });
  assert.equal(expectation && expectation.ref, ticket.ref);
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(PROJECT, 'README.md'), PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('the dispatch briefing states the isolation contract and the resume trap', () => {
  const agentId = 'a6isolated';
  const { ticket } = dispatched(agentId);
  const briefing = agentsync.renderTicketBriefing(ticket, 'isolation-briefing-token', slug, PROJECT);
  assert.ok(briefing.includes('Worktree isolation contract'), 'the contract is stated');
  assert.ok(briefing.includes('--git-common-dir'), 'the check is named');
  assert.ok(/after any resume/i.test(briefing), 'the resume trap is named');

  const shared = dispatched('a7shared', { sharedTree: true });
  const sharedBriefing = agentsync.renderTicketBriefing(shared.ticket, 'shared-briefing-token', slug, PROJECT);
  assert.ok(!sharedBriefing.includes('Worktree isolation contract'), 'a shared-tree dispatch is not told it is isolated');
});

test('a destructive git command is refused while the shared checkout carries uncommitted work', () => {
  const repo = initRepo('sq-destructive-repo-');
  const clean = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard origin/main' },
  });
  assert.equal(clean, null, 'a clean tree is not guarded');

  fs.writeFileSync(path.join(repo, 'executor-work.txt'), 'nine files of finished work\n');
  const out = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard origin/main' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes('executor-work.txt'), 'lists what would be destroyed');
  assert.ok(reason.includes('git stash push'), 'names the recoverable alternative');
  assert.ok(reason.includes('sidequest recover-shared'), 'names the exact recovery action');

  const narrow = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git checkout -- README.md' },
  });
  assert.equal(narrow, null, 'discarding one named path stays allowed');

  const elsewhere = runHook(GUARD_DESTRUCTIVE, {
    cwd: os.tmpdir(),
    tool_name: 'Bash',
    tool_input: { command: `git -C "${repo.replace(/\\/g, '/')}" clean -fd` },
  });
  assert.equal(elsewhere.hookSpecificOutput.permissionDecision, 'deny', 'git -C targets the named repo');
});

test('recover-shared refuses a named stash that misses dirty paths', () => {
  const repo = initRepo('sq-recover-missing-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, 'preserved.txt'), 'saved first\n');
  git(['stash', 'push', '-u', '-m', 'sidequest incomplete recovery fixture']);
  fs.writeFileSync(path.join(repo, 'unpreserved.txt'), 'still at risk\n');

  assert.throws(
    () => runCli(['recover-shared', '--project', repo, '--stash', 'stash@{0}', '--yes']),
    /does not preserve: unpreserved\.txt/
  );
  assert.equal(fs.existsSync(path.join(repo, 'unpreserved.txt')), true, 'the dirty file stays in place after a failed recovery check');
});

test('recover-shared verifies a named stash before cleaning a dirty shared checkout', () => {
  const repo = initRepo('sq-recover-shared-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, 'executor-work.txt'), 'preserved executor work\n');
  git(['stash', 'push', '-u', '-m', 'sidequest recovery fixture']);
  git(['stash', 'apply', 'stash@{0}']);

  const output = runCli(['recover-shared', '--project', repo, '--stash', 'stash@{0}', '--yes']);
  assert.equal(git(['status', '--porcelain']), '', 'the shared checkout is clean after recovery');
  assert.equal(fs.existsSync(path.join(repo, 'executor-work.txt')), false, 'the destructive cleanup ran only after verification');
  assert.ok(output.includes('stash stash@{0}'), 'prints the named stash evidence');
  assert.ok(output.includes('executor-work.txt'), 'prints the covered path evidence');
  assert.ok(git(['stash', 'list', '--format=%gd']).includes('stash@{0}'), 'the preserved stash remains recoverable');
});

test('closure refusals name the next legal action instead of only their precondition', () => {
  const agentId = 'a8closure';
  const { ticket } = dispatched(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'sq826-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);

  const grooming = store.completeTicketAsControlPlane(slug, ticket.ref, {
    by: 'orchestrator',
    purpose: 'grooming',
    reason: 'The work already shipped in a manual commit.',
  });
  assert.equal(grooming.reason, 'active_dispatch');
  assert.ok(grooming.message.includes(`sidequest release ${ticket.ref} --by sq826-worker`), 'names the release that unblocks it');

  const integration = store.completeTicketAsControlPlane(slug, ticket.ref, {
    by: 'orchestrator',
    purpose: 'integration',
    reason: 'Integrated by hand out of the shared tree.',
  });
  assert.equal(integration.reason, 'submission_required');
  assert.ok(/commit .*then submit|commit and then submit/i.test(integration.message), 'says what produces a submission');
  assert.ok(integration.message.includes('without --integration'), 'names the closure that does work here');
});
