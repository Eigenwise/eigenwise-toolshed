import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
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
  assert.match(reason, /expected worktree:/);
  assert.match(reason, /writing to:/);
  assert.ok(/re-dispatch/.test(reason), 'names the next legal action');
  assert.ok(/did nothing wrong|platform|harness/i.test(reason), 'blames the platform, not the executor');
});

test('a write inside the assigned agent worktree is allowed', () => {
  const agentId = 'a2isolated';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const target = path.join(ticket.dispatch.worktree, 'README.md');
  assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, ticket.dispatch.worktree)), null);
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
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /writing to:/);
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
  }
});

test('the assigned linked worktree remains allowed', () => {
  const agentId = 'a2linked';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = ticket.dispatch.worktree;
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(linked, 'README.md');
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, linked)), null);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

// SQ-1546. Claude Code's own `isolation: worktree` provisions under
// <project>/.claude/worktrees/agent-<id>, not under sidequest's worktree root,
// so the guard used to compare the executor's real tree against a path that
// never existed and deny every write it made once its agent id was bound.
test('the harness-provisioned agent worktree is allowed even though sidequest would have placed it elsewhere', () => {
  const agentId = 'a2harnessroot';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const harnessWorktree = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  assert.notEqual(harnessWorktree, ticket.dispatch.worktree, 'fixture must exercise the OTHER root');
  fs.mkdirSync(path.dirname(harnessWorktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', harnessWorktree], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(harnessWorktree, 'README.md');
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, harnessWorktree)), null);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', harnessWorktree], { cwd: PROJECT, windowsHide: true });
  }
});

test('a different linked worktree is refused', () => {
  const agentId = 'a2foreign';
  const { sessionId, executor } = dispatched(agentId);
  const linked = path.join(os.tmpdir(), `sq-isolation-foreign-${process.pid}-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(linked, 'README.md');
    const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, linked));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /expected worktree:/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /actual worktree:/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('a Unicode-sized target preserves linked-worktree recovery facts and action', () => {
  const agentId = 'a2unicode';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = path.join(os.tmpdir(), `sq-isolation-unicode-${process.pid}-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(linked, `${'界'.repeat(1000)}.txt`);
    const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, linked));
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(Buffer.byteLength(reason, 'utf8') <= 768);
    assert.match(reason, new RegExp(ticket.ref));
    assert.match(reason, /expected worktree:/);
    assert.match(reason, /actual worktree:/);
    assert.match(reason, /If it no longer exists, stop and ask the orchestrator to redispatch the ticket\./);
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

test('a terminal dispatch keeps its isolation record and refuses a resumed write', () => {
  for (const terminal of ['release', 'submit'] as const) {
    const agentId = `a5${terminal}`;
    const { ticket, sessionId, executor } = dispatched(agentId);
    const by = `${terminal}-worker`;
    assert.equal(store.claimTicket(slug, ticket.ref, by, {
      token: ticket.dispatchNonce,
      executor: ticket.dispatchExecutor,
    }).ok, true);
    if (terminal === 'release') {
      assert.equal(store.releaseTicket(slug, ticket.ref, by, { status: 'todo' }).ok, true);
    } else {
      assert.equal(store.submitTicket(slug, ticket.ref, by, { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
    }

    const expectation = store.dispatchIsolationExpectation({ agentId, sessionId, executor });
    assert.equal(expectation && expectation.terminal, true);
    const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(PROJECT, 'README.md'), PROJECT));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /terminal board state/);
  }
});

test('an executor without a dispatch record cannot write into the shared checkout', () => {
  const target = path.join(PROJECT, 'README.md');
  const out = runHook(GUARD_ISOLATION, writePayload('missing-agent', 'sidequest-exec-medium', 'missing-session', target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /no active dispatch record/);
});

test('a terminally failed executor still expects its worktree after a resume', () => {
  const agentId = 'a9dead';
  const { ticket, sessionId, executor } = dispatched(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'dead-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: ticket.dispatchNonce,
    executor,
    error: 'Subagent terminated unexpectedly',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'died');

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

test('published-branch pushes and manual tags need the current session publish lock', () => {
  const repo = initRepo('sq-published-branch-');
  const project = store.ensureProject(repo);
  store.setBoardConfig(project.slug, { integrationBranch: 'dev' });
  const sessionId = `release-owner-${Date.now()}`;
  const payload = (command: string, tool_name: string = 'Bash', owner: string = 'other-session', cwd: string = repo) => ({
    cwd,
    session_id: owner,
    tool_name,
    tool_input: { command },
  });
  const denied = [
    'git tag v3.208.0',
    'git tag -a v3.208.0 -m release',
    'git push origin main',
    'git push origin HEAD:main',
    'git push --force origin HEAD:main',
    'git push origin +main',
    'git push origin main:',
    'git push upstream HEAD:main',
    'git push origin --tags',
    'git push origin dev --follow-tags',
  ];
  for (const command of denied) {
    const out = runHook(GUARD_DESTRUCTIVE, payload(command, command.includes('HEAD:main') ? 'PowerShell' : 'Bash'));
    assert.ok(out, command);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /local early warning/);
  }
  for (const command of ['git status', 'git fetch origin', 'git tag --list', 'git push origin dev', 'git push upstream HEAD:dev', 'echo "; git tag v3.208.0"']) {
    assert.equal(runHook(GUARD_DESTRUCTIVE, payload(command)), null, command);
  }

  fs.writeFileSync(path.join(repo, '.git', 'sidequest-publish.lock'), JSON.stringify({
    transient: true,
    sessionId,
    repo,
    at: new Date().toISOString(),
  }));
  const other = initRepo('sq-published-branch-other-');
  const crossRepo = runHook(GUARD_DESTRUCTIVE, payload(`git -C "${repo}" status; git -C "${other}" tag v3.208.0`, 'Bash', sessionId));
  assert.equal(crossRepo.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(crossRepo.hookSpecificOutput.permissionDecisionReason, /entire shell invocation/);
  for (const command of denied) {
    assert.equal(runHook(GUARD_DESTRUCTIVE, payload(command, 'PowerShell', sessionId)), null, command);
  }
  if (process.platform === 'win32') {
    const gitBashCwd = repo.replace(/^([a-zA-Z]):/, '/$1').replace(/\\/g, '/');
    assert.equal(runHook(GUARD_DESTRUCTIVE, payload('git tag -d v3.208.0', 'Bash', sessionId, gitBashCwd)), null);
  }
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
