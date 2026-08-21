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
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const GUARD_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');
const BIND_RUNTIME_IDENTITY = path.join(HOOKS, 'bind-runtime-identity.js');
const GUARD_SHARED_CHECKOUT_GIT = path.join(HOOKS, 'guard-shared-checkout-git.js');
const GUARD_DESTRUCTIVE = path.join(HOOKS, 'guard-destructive-git.js');

function initRepo(prefix: string) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
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

// The commit command reads its checkout from the working directory, so a test that drives it has to say
// which worktree it is standing in rather than inheriting the runner's.
function runCli(args: string[], cwd?: string) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  }).trim();
}

function completeCheckoutCreation(sessionId: string, worktree: string): void {
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
}

function removeWorktreeBranch(worktree: string, branch: string): void {
  if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT, windowsHide: true });
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: PROJECT, windowsHide: true, stdio: 'ignore' });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT, windowsHide: true, stdio: 'ignore' });
  } catch (_) {
  }
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
  if (options.sharedTree !== true) {
    const expectedWorktree = worktrees.resolvedAgentWorktree(PROJECT, agentId);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, expectedWorktree).ok, true);
  }
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  const bound = store.getTicket(slug, ticket.ref);
  return { ticket: bound, sessionId, executor: bound.dispatchExecutor };
}

// The harness reports the agent identity and the checkout it placed the agent
// in; the ticket ref in tool_input is the executor's own claim and is never
// read for identity.
function boardCallPayload(agentId: string, executor: string, sessionId: string, cwd: string) {
  return {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd,
    tool_name: 'mcp__plugin_sidequest_board__done',
    tool_input: { ref: 'SQ-1', by: agentId },
  };
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
  completeCheckoutCreation(sessionId, linked);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
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
test('an exact-path replacement checkout cannot inherit the bound write lease', () => {
  const agentId = 'a2replaced';
  const sessionId = `session-${agentId}`;
  const ticket = store.createTicket(slug, {
    title: `replacement fixture ${agentId}`,
    category: 'codebase-exploration',
    files: ['README.md'],
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const linked = worktrees.resolvedAgentWorktree(PROJECT, agentId);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, linked).ok, true);
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  const linkedGitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: linked, encoding: 'utf8', windowsHide: true }).trim();
  const linkedGitDirectory = path.isAbsolute(linkedGitDirectoryValue) ? linkedGitDirectoryValue : path.resolve(linked, linkedGitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(linkedGitDirectory);
  assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, linked).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
  const boundDispatch = store.getTicket(slug, ticket.ref).dispatch;
  const boundGitDirectory = worktrees.canonicalPath(boundDispatch.worktreeGitDirectory);
  assert.match(boundDispatch.worktreeCheckoutInstance, /^[a-f0-9]{64}$/);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
    const replacementGitDirectory = worktrees.canonicalPath(path.resolve(linked, execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: linked,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()));
    assert.equal(replacementGitDirectory, boundGitDirectory);
    assert.equal(worktreeLease.checkoutInstanceIdentity(replacementGitDirectory), null);

    const refusal = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, 'README.md'), linked));
    assert.equal(refusal.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refusal.hookSpecificOutput.permissionDecisionReason, /checkout instance/);
  } finally {
    if (fs.existsSync(linked)) execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('an assigned worktree at a changed dispatch revision is refused', () => {
  const agentId = 'a2baseline';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = ticket.dispatch.worktree;
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  completeCheckoutCreation(sessionId, linked);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
  try {
    fs.appendFileSync(path.join(linked, 'README.md'), 'changed revision\n');
    execFileSync('git', ['add', 'README.md'], { cwd: linked, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'changed dispatch revision'], { cwd: linked, windowsHide: true });
    const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, 'README.md'), linked));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    // This fixture never claims the ticket, and since SQ-2193 that is the operative reason: forward history
    // buys a write lease only while the claim that authorized the worktree is held. Foreign history is
    // refused whether or not a claim exists, which the SQ-2193 test covers separately.
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /claim that authorized this worktree is no longer held/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

// SQ-2182. An executor committed through the board, verified clean, and was then told submit needed
// `.release/unreleased/<REF>.md`. Writing it was refused because the lease still expected the dispatch
// baseline while its own sanctioned commit had moved HEAD, so submit demanded an artifact the lifecycle
// forbade creating. The negative control matters as much as the fix: the rebind follows the claim.
test('SQ-2182: a sanctioned commit keeps the write lease, and losing the claim takes it away again', () => {
  const agentId = 'a2sanctioned';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = ticket.dispatch.worktree;
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  completeCheckoutCreation(sessionId, linked);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
  const worker = `${agentId}-worker`;
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: store.getTicket(slug, ticket.ref).dispatchNonce,
      executor,
    }).ok, true);

    fs.appendFileSync(path.join(linked, 'README.md'), 'sanctioned work\n');
    execFileSync('git', ['add', 'README.md'], { cwd: linked, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'sanctioned work'], { cwd: linked, windowsHide: true });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked, encoding: 'utf8', windowsHide: true }).trim();
    assert.notEqual(head, ticket.dispatch.baseCommit, 'the fixture must move HEAD off the dispatch baseline');

    // This used to be a refusal, on the grounds that an unrecorded commit was indistinguishable from
    // foreign drift. It is distinguishable: it descends from the baseline, which SQ-2193 now allows on its
    // own. What this test is really about is the rebind following the claim, asserted below.
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, 'README.md'), linked)), null);

    const wrongOwner = store.recordSanctionedCommit(slug, ticket.ref, { by: `${worker}-impostor`, commit: head });
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.reason, 'not_owner');

    assert.equal(store.recordSanctionedCommit(slug, ticket.ref, { by: worker, commit: head }).ok, true);
    // The whole point: the release fragment the submit gate demands is now writable from inside the claim.
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, '.release', 'unreleased', `${ticket.ref}.md`), linked)), null);

    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo' }).ok, true);
    const afterRelease = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, 'README.md'), linked));
    assert.equal(afterRelease.hookSpecificOutput.permissionDecision, 'deny', 'a recorded commit must not keep granting writes once the claim is gone');
    // Releasing makes the dispatch terminal, and the terminal-state refusal fires ahead of any lease
    // decision, so this is what actually stops the write. Worth naming: the lease path that revokes a
    // moved HEAD when the claim is gone is reached while the dispatch is still live, and the bound-but-
    // never-claimed test above is what covers it.
    assert.match(afterRelease.hookSpecificOutput.permissionDecisionReason, /already reached a terminal board state/);
  } finally {
    store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

// SQ-2182 again, one layer out. The test above proves the kernel and the store agree, but it records the
// commit itself, so it would still pass with the recording call missing from the commit command, and that
// missing call IS the defect. This drives the real command and then writes the file submit asks for.
test('SQ-2182: committing through the board leaves the worktree writable', () => {
  const agentId = 'a2boardcommit';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = ticket.dispatch.worktree;
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  completeCheckoutCreation(sessionId, linked);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
  const worker = `${agentId}-worker`;
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: store.getTicket(slug, ticket.ref).dispatchNonce,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(linked, 'README.md'), 'work committed through the board\n');
    runCli(['commit', ticket.ref, '--project', PROJECT, '--by', worker, '--message', 'work committed through the board'], linked);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked, encoding: 'utf8', windowsHide: true }).trim();
    assert.notEqual(head, ticket.dispatch.baseCommit, 'the board commit must move HEAD off the dispatch baseline');
    assert.deepEqual(store.getTicket(slug, ticket.ref).dispatch.sanctionedCommits, [head.toLowerCase()]);
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, '.release', 'unreleased', `${ticket.ref}.md`), linked)), null);
  } finally {
    store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

// SQ-2193. SQ-2182 fixed the commit path the board owns, and a raw `git commit` reached the identical dead
// end by a route no guard covered: guard-shared-tree-commit skips any checkout whose `.git` is a file, so
// the commit succeeds, records nothing, and every later write is refused for the rest of the run. That is
// not optional to allow either, since a dirty continuation's preserve step is told to run exactly this
// command. The orphan branch is the negative control: forward history stays allowed, foreign history does
// not.
test('SQ-2193: a raw commit that descends from the baseline keeps the write lease, foreign history does not', () => {
  const agentId = 'a2rawcommit';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = ticket.dispatch.worktree;
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  completeCheckoutCreation(sessionId, linked);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, linked).ok, true);
  const worker = `${agentId}-worker`;
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: store.getTicket(slug, ticket.ref).dispatchNonce,
      executor,
    }).ok, true);

    fs.appendFileSync(path.join(linked, 'README.md'), 'preserved by a raw commit\n');
    execFileSync('git', ['add', '-A'], { cwd: linked, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'preserved by a raw commit'], { cwd: linked, windowsHide: true });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked, encoding: 'utf8', windowsHide: true }).trim();
    assert.notEqual(head, ticket.dispatch.baseCommit, 'the fixture must move HEAD off the dispatch baseline');
    assert.deepEqual(store.getTicket(slug, ticket.ref).dispatch.sanctionedCommits ?? [], [], 'a raw commit must not be recorded, or this proves nothing about ancestry');

    // The file submit demands once the range touches shipped plugin paths. Refusing it here is the whole
    // catch-22: verified work that cannot be submitted.
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, '.release', 'unreleased', `${ticket.ref}.md`), linked)), null);

    execFileSync('git', ['checkout', '--quiet', '--orphan', 'foreign-history'], { cwd: linked, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'unrelated root commit'], { cwd: linked, windowsHide: true });
    const foreign = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, path.join(linked, 'README.md'), linked));
    assert.equal(foreign.hookSpecificOutput.permissionDecision, 'deny', 'a parentless commit is not this dispatch history moving forward');
    assert.match(foreign.hookSpecificOutput.permissionDecisionReason, /left the history the board dispatched/);
    assert.match(foreign.hookSpecificOutput.permissionDecisionReason, /not a scope decision/);
  } finally {
    store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('a same-repository agent-name lookalike without the server binding is refused', () => {
  const agentId = 'a2harnessroot';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const lookalikeWorktree = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  assert.notEqual(lookalikeWorktree, ticket.dispatch.worktree, 'fixture must exercise an unbound lookalike');
  fs.mkdirSync(path.dirname(lookalikeWorktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', lookalikeWorktree], { cwd: PROJECT, windowsHide: true });
  try {
    const target = path.join(lookalikeWorktree, 'README.md');
    const refusal = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, lookalikeWorktree));
    assert.equal(refusal.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refusal.hookSpecificOutput.permissionDecisionReason, /no write lease for this linked worktree/);
    assert.match(refusal.hookSpecificOutput.permissionDecisionReason, /observed worktree differs from the dispatch-bound worktree/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', lookalikeWorktree], { cwd: PROJECT, windowsHide: true });
  }
});

test('SubagentStart cannot mint authority for an unreserved same-repository lookalike', () => {
  const agentId = 'a2unreservedstart';
  const sessionId = `session-${agentId}`;
  const ticket = store.createTicket(slug, {
    title: `isolation fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch whose creation hook never reserved a checkout.',
    files: ['README.md'],
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  const lookalikeWorktree = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  fs.mkdirSync(path.dirname(lookalikeWorktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', lookalikeWorktree], { cwd: PROJECT, windowsHide: true });
  try {
    const binding = store.bindDispatchAgent(sessionId, executor, agentId, agentId, lookalikeWorktree);
    assert.equal(binding.ok, false);
    assert.equal(binding.reason, 'worktree_binding_unavailable');
    const unbound = store.getTicket(slug, ticket.ref).dispatch;
    assert.equal(unbound.agentId, undefined);
    assert.equal(unbound.worktree, undefined);
    assert.equal(unbound.worktreeBindingSource, undefined);
    const target = path.join(lookalikeWorktree, 'README.md');
    const refusal = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, lookalikeWorktree));
    assert.equal(refusal.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refusal.hookSpecificOutput.permissionDecisionReason, /requires a bound worktree identity/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', lookalikeWorktree], { cwd: PROJECT, windowsHide: true });
  }
});

test('a completed linked worktree write retries its exact runtime identity binding', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const sessionId = `retry-session-${sequence}`;
  const prepareTarget = (agentId: string) => {
    const ticket = store.createTicket(slug, {
      title: `retry binding fixture ${agentId}`,
      category: 'codebase-exploration',
      description: 'A fixture whose native agent starts before its worktree is available.',
      files: ['README.md'],
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worktree = path.join(SIDEQUEST_HOME, 'retry-binding-targets', agentId);
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      agentName: agentId,
    }).ok, true);
    return { ticket, executor, agentId, worktree };
  };
  const first = prepareTarget(`retry-first-${sequence}`);
  const second = prepareTarget(`retry-second-${sequence}`);
  assert.equal(first.executor, second.executor);

  try {
    for (const target of [first, second]) {
      const initialBinding = store.bindDispatchAgent(sessionId, target.executor, target.agentId, target.agentId, target.worktree);
      assert.equal(initialBinding.ok, false);
      assert.equal(initialBinding.reason, 'worktree_binding_unavailable');
      assert.equal(store.getTicket(slug, target.ticket.ref).dispatch.agentId, undefined);
    }

    for (const target of [first, second]) {
      assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, target.worktree).ok, true);
      fs.mkdirSync(path.dirname(target.worktree), { recursive: true });
      execFileSync('git', ['worktree', 'add', '--detach', target.worktree], { cwd: PROJECT, windowsHide: true });
      completeCheckoutCreation(sessionId, target.worktree);
    }

    assert.equal(runHook(GUARD_ISOLATION, writePayload(
      first.agentId,
      first.executor,
      sessionId,
      path.join(first.worktree, 'README.md'),
      first.worktree,
    )), null);

    const siblingWrite = runHook(GUARD_ISOLATION, writePayload(
      first.agentId,
      first.executor,
      sessionId,
      path.join(second.worktree, 'README.md'),
      second.worktree,
    ));
    assert.equal(siblingWrite?.hookSpecificOutput.permissionDecision, 'deny', 'bound agent cannot use sibling worktree');

    const sharedCheckoutWrite = runHook(GUARD_ISOLATION, writePayload(
      first.agentId,
      first.executor,
      sessionId,
      path.join(PROJECT, 'README.md'),
      PROJECT,
    ));
    assert.equal(sharedCheckoutWrite?.hookSpecificOutput.permissionDecision, 'deny', 'bound agent cannot use shared checkout');

    const foreignWrite = runHook(GUARD_ISOLATION, writePayload(
      `foreign-${sequence}`,
      first.executor,
      sessionId,
      path.join(first.worktree, 'README.md'),
      first.worktree,
    ));
    assert.equal(foreignWrite?.hookSpecificOutput.permissionDecision, 'deny', 'foreign agent cannot inherit runtime binding');
  } finally {
    for (const target of [first, second]) {
      store.releaseTicket(slug, target.ticket.ref, 'retry-binding-cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(target.worktree)) execFileSync('git', ['worktree', 'remove', '--force', target.worktree], { cwd: PROJECT, windowsHide: true });
    }
  }
});

// SQ-2159. SQ-2153 repaired the pre-completion identity race in the declared-
// write guard, which a read-only review never reaches: SQ-2156 completed its
// exact review with no hook-bound identity and SQ-2137 integration still
// refused. A read-only run always reaches the board, so its board call is where
// the binding gets a second chance.
test('a read-only isolated executor rebinds its exact runtime identity before its terminal done', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const sessionId = `readonly-review-session-${sequence}`;
  const created: Array<{ ref: string; worktree: string }> = [];
  const reserve = (name: string) => {
    const agentId = `${name}-${sequence}`;
    const ticket = store.createTicket(slug, {
      title: `read-only review fixture ${agentId}`,
      category: 'codebase-exploration',
      description: 'A read-only review whose native agent starts before its worktree finished being created.',
      files: ['README.md'],
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worktree = path.join(SIDEQUEST_HOME, 'readonly-review-targets', agentId);
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    created.push({ ref: ticket.ref, worktree });
    return { ticket, executor, agentId, worktree };
  };
  const createCheckout = (target: { worktree: string }) => {
    fs.mkdirSync(path.dirname(target.worktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', target.worktree], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(sessionId, target.worktree);
  };
  const boundAgent = (ref: string) => store.getTicket(slug, ref).dispatch.agentId;
  const terminalAttempt = (ref: string) => (store.getTicket(slug, ref).dispatch.attempts || []).at(-1);

  const review = reserve('readonly-review');
  const control = reserve('readonly-control');
  const changed = reserve('readonly-changed');
  const replaced = reserve('readonly-replaced');
  const terminal = reserve('readonly-terminal');
  assert.match(review.executor, /^sidequest-exec(?:-dispatch)?-readonly-/, 'the fixture routes a read-only executor');

  try {
    // The delivered race: SubagentStart reaches the store from the parent
    // checkout while the reserved worktree is still being created.
    const race = store.bindDispatchAgent(sessionId, review.executor, review.agentId, review.agentId, PROJECT);
    assert.equal(race.ok, false);
    assert.equal(race.reason, 'worktree_binding_unavailable');

    for (const target of [review, control, changed, replaced, terminal]) createCheckout(target);
    assert.equal(boundAgent(review.ticket.ref), undefined, 'finishing the worktree rebinds nothing by itself');

    assert.equal(runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(review.agentId, review.executor, sessionId, PROJECT)), null);
    assert.equal(boundAgent(review.ticket.ref), undefined, 'a board call from the shared checkout cannot bind an isolated target');

    assert.equal(runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(review.agentId, review.executor, sessionId, review.worktree)), null);
    assert.equal(boundAgent(review.ticket.ref), review.agentId, 'the exact reserved worktree binds its own native agent');

    runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(control.agentId, control.executor, sessionId, review.worktree));
    assert.equal(boundAgent(control.ticket.ref), undefined, 'an unbound agent cannot claim a sibling worktree');
    assert.equal(boundAgent(review.ticket.ref), review.agentId, 'the sibling attempt left the bound target alone');

    runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(`foreign-${sequence}`, review.executor, sessionId, review.worktree));
    assert.equal(boundAgent(review.ticket.ref), review.agentId, 'a foreign agent cannot inherit a bound runtime identity');

    fs.appendFileSync(path.join(changed.worktree, 'README.md'), 'changed after creation\n');
    execFileSync('git', ['add', 'README.md'], { cwd: changed.worktree, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'changed after creation'], { cwd: changed.worktree, windowsHide: true });
    runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(changed.agentId, changed.executor, sessionId, changed.worktree));
    assert.equal(boundAgent(changed.ticket.ref), undefined, 'a worktree at a changed revision cannot bind');

    execFileSync('git', ['worktree', 'remove', '--force', replaced.worktree], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['worktree', 'add', '--detach', replaced.worktree], { cwd: PROJECT, windowsHide: true });
    runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(replaced.agentId, replaced.executor, sessionId, replaced.worktree));
    assert.equal(boundAgent(replaced.ticket.ref), undefined, 'an exact-path replacement checkout cannot bind');

    const terminalDispatch = store.getTicket(slug, terminal.ticket.ref);
    assert.equal(store.claimTicket(slug, terminal.ticket.ref, `${terminal.agentId}-worker`, {
      token: terminalDispatch.dispatchNonce,
      executor: terminal.executor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, terminal.ticket.ref, `${terminal.agentId}-worker`, { status: 'todo' }).ok, true);
    runHook(BIND_RUNTIME_IDENTITY, boardCallPayload(terminal.agentId, terminal.executor, sessionId, terminal.worktree));
    assert.equal(boundAgent(terminal.ticket.ref), undefined, 'a terminal attempt cannot bind a runtime identity');

    // The repaired identity is what the terminal done snapshots, which is the
    // half of review provenance the integration gate reads.
    for (const target of [review, control]) {
      const dispatched = store.getTicket(slug, target.ticket.ref);
      assert.equal(store.claimTicket(slug, target.ticket.ref, `${target.agentId}-worker`, {
        token: dispatched.dispatchNonce,
        executor: target.executor,
      }).ok, true);
      const done = store.completeTicket(slug, target.ticket.ref, `${target.agentId}-worker`, { model: 'sonnet', effort: 'medium' });
      assert.equal(done.ok, true, done.message);
    }
    assert.equal(terminalAttempt(review.ticket.ref).outcome, 'done');
    assert.equal(terminalAttempt(review.ticket.ref).agentId, review.agentId, 'the repaired read-only done carries its hook-bound identity');
    assert.equal(terminalAttempt(control.ticket.ref).outcome, 'done');
    assert.equal(terminalAttempt(control.ticket.ref).agentId, null, 'a read-only done that never reached the binding stays identity-less');
  } finally {
    for (const target of created) {
      store.releaseTicket(slug, target.ref, 'readonly-review-cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(target.worktree)) execFileSync('git', ['worktree', 'remove', '--force', target.worktree], { cwd: PROJECT, windowsHide: true });
    }
  }
});

// SQ-2189. A fan-out of two write executors from one orchestrator session gives both dispatches the same
// session id and the same executor name, so session matching alone reported two candidates and the store
// resolved that to no dispatch at all. Both executors were then refused their FIRST edit, inside their own
// isolated worktree, and told they had no dispatch record for a shared-checkout write.
test('SQ-2189: concurrent dispatches from one session each resolve to the worktree its write lands in', () => {
  const created: Array<{ ref: string; worktree: string }> = [];
  const sequence = `${process.pid}-${Date.now()}`;
  const sessionId = `sq2189-session-${sequence}`;
  const dispatchInto = (label: string) => {
    const ticket = store.createTicket(slug, {
      title: `concurrent fan-out fixture ${label}`,
      category: 'codebase-exploration',
      description: 'One of two dispatches launched from a single orchestrator session.',
      files: ['README.md'],
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const agentName = `sq2189-${label}-${sequence}`;
    const worktree = path.join(SIDEQUEST_HOME, 'sq2189-targets', `${label}-${sequence}`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      agentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(sessionId, worktree);
    created.push({ ref: ticket.ref, worktree });
    return { ticket, executor, agentName, worktree };
  };

  try {
    const first = dispatchInto('first');
    const second = dispatchInto('second');
    assert.equal(first.executor, second.executor, 'the fixture only reproduces SQ-2189 while both dispatches share an executor name');

    // What the store saw before the fix: session matching alone cannot separate them.
    assert.equal(store.dispatchIsolationExpectation({ sessionId, executor: first.executor }), null);
    for (const target of [first, second]) {
      const expectation = store.dispatchIsolationExpectation({
        sessionId,
        executor: target.executor,
        observedWorktree: target.worktree,
      });
      assert.equal(expectation?.ref, target.ticket.ref);
      assert.equal(expectation.expectedWorktree, worktrees.canonicalPath(target.worktree));
    }

    // The harness agent id is never the one the board recorded, so each executor arrives unbound. The
    // guard must still let it write inside its own worktree, and must still refuse the other's.
    for (const target of [first, second]) {
      const agentId = `a2189${target.agentName.replace(/[^a-z0-9]/g, '')}`;
      const other = target === first ? second : first;
      const ownWrite = writePayload(agentId, target.executor, sessionId, path.join(target.worktree, 'README.md'), target.worktree);
      Object.assign(ownWrite, { agent_name: target.agentName });
      assert.equal(runHook(GUARD_ISOLATION, ownWrite), null, `${target.ticket.ref} was refused a write inside its own worktree`);
      const foreignWrite = writePayload(agentId, target.executor, sessionId, path.join(other.worktree, 'README.md'), other.worktree);
      Object.assign(foreignWrite, { agent_name: target.agentName });
      assert.equal(runHook(GUARD_ISOLATION, foreignWrite).hookSpecificOutput.permissionDecision, 'deny');
    }

    // An identity that genuinely resolves to nothing still gets refused, but the refusal has to name the
    // checkout it observed and carry the counts that separate a wrong session id from an unbound agent.
    const stray = runHook(GUARD_ISOLATION, writePayload(
      'a2189stray',
      first.executor,
      `sq2189-unrecorded-session-${sequence}`,
      path.join(first.worktree, 'README.md'),
      first.worktree,
    ));
    assert.equal(stray.hookSpecificOutput.permissionDecision, 'deny');
    const strayReason = stray.hookSpecificOutput.permissionDecisionReason;
    assert.match(strayReason, /isolated worktree/);
    assert.ok(!/shared-checkout write/.test(strayReason), `a write inside a linked worktree was called a shared-checkout write: ${strayReason}`);
    assert.match(strayReason, /session 0, session\+executor 0/);
    assert.match(strayReason, /worktree 1/);
  } finally {
    for (const target of created) {
      store.releaseTicket(slug, target.ref, 'sq2189-cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(target.worktree)) execFileSync('git', ['worktree', 'remove', '--force', target.worktree], { cwd: PROJECT, windowsHide: true });
    }
  }
});

test('SQ-2190: a creation order that crossed two siblings is exchanged for the checkout each one reports', () => {
  const created: Array<{ ref: string; worktree: string }> = [];
  const sequence = `${process.pid}-${Date.now()}`;
  const sessionId = `sq2190-session-${sequence}`;
  const canonical = (worktree: string) => worktrees.canonicalPath(worktree);
  const boundWorktree = (ref: string) => store.getTicket(slug, ref).dispatch.worktree;
  const reserve = (label: string) => {
    const ticket = store.createTicket(slug, {
      title: `crossed creation fixture ${label}`,
      category: 'codebase-exploration',
      description: 'One of several dispatches launched from a single orchestrator session.',
      files: ['README.md'],
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const agentName = `sq2190-${label}-${sequence}`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
      agentName,
    }).ok, true);
    const worktree = path.join(SIDEQUEST_HOME, 'sq2190-targets', `${label}-${sequence}`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    created.push({ ref: ticket.ref, worktree });
    return { ref: ticket.ref, executor: prepared.ticket.dispatchExecutor, agentName, worktree, agentId: `a2190${label}${sequence}`.replace(/[^a-z0-9]/g, '') };
  };
  const create = (worktree: string) => {
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(sessionId, worktree);
  };

  try {
    const first = reserve('first');
    const second = reserve('second');
    assert.equal(first.executor, second.executor, 'the crossing only happens between siblings sharing an executor');

    // Both reservations are unbound at the same time, which is the whole defect: creation has nothing to tell them
    // apart, so it takes them in board order. Creating them against that order is what crosses the pair, and the
    // assertion below is what proves this fixture still reproduces it.
    create(first.worktree);
    create(second.worktree);
    assert.equal(boundWorktree(first.ref), canonical(second.worktree), `the fixture reproduces the crossing: ${boundWorktree(first.ref)} / ${boundWorktree(second.ref)} vs ${canonical(first.worktree)} / ${canonical(second.worktree)}`);
    assert.equal(boundWorktree(second.ref), canonical(first.worktree));

    // SubagentStart carries the one fact creation lacked: the checkout the agent is actually running in.
    const bound = store.bindDispatchAgent(sessionId, first.executor, first.agentId, first.agentName, first.worktree);
    assert.equal(bound.ok, true, `a reported checkout must outrank the creation-order guess: ${bound.reason}`);
    assert.equal(boundWorktree(first.ref), canonical(first.worktree));
    assert.equal(boundWorktree(second.ref), canonical(second.worktree), 'the exchange hands the sibling its own checkout');
    assert.equal(store.getTicket(slug, first.ref).dispatch.worktreeBindingSource, 'worktree-create', 'downstream reads still require the creation source');

    // The facts follow the path, or the guard refuses the write it just authorized.
    const expectation = store.dispatchIsolationExpectation({
      sessionId,
      executor: first.executor,
      agentId: first.agentId,
      observedWorktree: first.worktree,
    });
    assert.equal(expectation?.ref, first.ref);
    assert.equal(expectation.expectedWorktree, canonical(first.worktree));

    // The sibling now finds its own record correct and binds without a second exchange.
    const boundSibling = store.bindDispatchAgent(sessionId, second.executor, second.agentId, second.agentName, second.worktree);
    assert.equal(boundSibling.ok, true, boundSibling.reason);
    assert.equal(boundWorktree(second.ref), canonical(second.worktree));

    // A checkout whose reservation already proved its identity is never handed to anyone else.
    const third = reserve('third');
    create(third.worktree);
    const theft = store.bindDispatchAgent(sessionId, third.executor, third.agentId, third.agentName, first.worktree);
    assert.equal(theft.ok, false, 'an owned checkout stays owned');
    assert.equal(theft.reason, 'worktree_binding_mismatch');
    assert.equal(boundWorktree(first.ref), canonical(first.worktree));
    assert.equal(boundWorktree(third.ref), canonical(third.worktree));
  } finally {
    for (const target of created) {
      store.releaseTicket(slug, target.ref, 'sq2190-cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(target.worktree)) execFileSync('git', ['worktree', 'remove', '--force', target.worktree], { cwd: PROJECT, windowsHide: true });
    }
  }
});

test('a fresh re-dispatch binds its created checkout when the runtime reports the prior retained identity', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const ticket = store.createTicket(slug, {
    title: `stale retained identity fixture ${sequence}`,
    category: 'codebase-exploration',
    description: 'A fresh retry after a terminal isolated run retained its old checkout.',
    files: ['README.md'],
  });
  const priorSessionId = `stale-retained-prior-session-${sequence}`;
  const priorAgentId = `stale-retained-prior-agent-${sequence}`;
  const priorAgentName = `stale-retained-prior-name-${sequence}`;
  const priorBranch = `stale-retained-prior-${sequence}`;
  const priorWorktree = path.join(SIDEQUEST_HOME, 'stale-retained-targets', `prior-${sequence}`);
  const freshSessionId = `stale-retained-fresh-session-${sequence}`;
  const freshAgentName = `stale-retained-fresh-name-${sequence}`;
  const freshBranch = `stale-retained-fresh-${sequence}`;
  const freshWorktree = path.join(SIDEQUEST_HOME, 'stale-retained-targets', `fresh-${sequence}`);
  fs.mkdirSync(path.dirname(priorWorktree), { recursive: true });

  try {
    const prior = store.prepareDispatch(slug, ticket.ref, { sessionId: priorSessionId });
    const executor = prior.ticket.dispatchExecutor;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prior.token,
      executor,
      sessionId: priorSessionId,
      agentName: priorAgentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, priorSessionId, priorWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', priorBranch, priorWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(priorSessionId, priorWorktree);
    assert.equal(store.bindDispatchAgent(priorSessionId, executor, priorAgentId, priorAgentName, priorWorktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'stale-retained-prior-worker', {
      token: prior.token,
      executor,
      sessionId: priorSessionId,
      requireBoundAgent: true,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, 'stale-retained-prior-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'No committed progress to retain.',
    }).ok, true);

    const fresh = store.prepareDispatch(slug, ticket.ref, { sessionId: freshSessionId });
    assert.equal(fresh.ticket.dispatch.continuation, undefined);
    assert.equal(agentsync.ticketIsolation(fresh.ticket, fresh.ticket.dispatch.sharedTree), 'worktree');
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: fresh.token,
      executor: fresh.ticket.dispatchExecutor,
      sessionId: freshSessionId,
      agentName: freshAgentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, freshSessionId, freshWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', freshBranch, freshWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(freshSessionId, freshWorktree);

    const bound = store.bindDispatchAgent(freshSessionId, fresh.ticket.dispatchExecutor, priorAgentId, priorAgentName, freshWorktree);
    assert.equal(bound.ok, true, `a stale runtime identity must bind through its fresh checkout: ${bound.reason}`);
    const expectation = store.dispatchIsolationExpectation({
      sessionId: freshSessionId,
      executor: fresh.ticket.dispatchExecutor,
      agentId: priorAgentId,
      observedWorktree: freshWorktree,
    });
    assert.equal(expectation?.matchedBy, 'agent');
    assert.equal(expectation?.expectedWorktree, worktrees.canonicalPath(freshWorktree));
    assert.notEqual(expectation?.expectedWorktree, worktrees.canonicalPath(priorWorktree));
  } finally {
    store.releaseTicket(slug, ticket.ref, 'stale-retained-cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(freshWorktree, freshBranch);
    removeWorktreeBranch(priorWorktree, priorBranch);
  }
});

test('a release-fragment-only checkpoint cannot permanently block a fresh retry', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const ticket = store.createTicket(slug, {
    title: `release-only checkpoint fixture ${sequence}`,
    category: 'codebase-exploration',
    description: 'A rejected candidate left only its implicit release fragment behind.',
    files: ['README.md'],
  });
  const candidateSessionId = `release-only-candidate-session-${sequence}`;
  const candidateAgentName = `release-only-candidate-agent-${sequence}`;
  const candidateBranch = `release-only-candidate-${sequence}`;
  const candidateWorktree = path.join(SIDEQUEST_HOME, 'release-only-targets', `candidate-${sequence}`);
  const abandonedSessionId = `release-only-abandoned-session-${sequence}`;
  const abandonedAgentName = `release-only-abandoned-agent-${sequence}`;
  const abandonedBranch = `release-only-abandoned-${sequence}`;
  const abandonedWorktree = path.join(SIDEQUEST_HOME, 'release-only-targets', `abandoned-${sequence}`);
  fs.mkdirSync(path.dirname(candidateWorktree), { recursive: true });

  try {
    const candidate = store.prepareDispatch(slug, ticket.ref, { sessionId: candidateSessionId });
    const executor = candidate.ticket.dispatchExecutor;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: candidate.token,
      executor,
      sessionId: candidateSessionId,
      agentName: candidateAgentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, candidateSessionId, candidateWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', candidateBranch, candidateWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(candidateSessionId, candidateWorktree);
    assert.equal(store.bindDispatchAgent(candidateSessionId, executor, candidateAgentName, candidateAgentName, candidateWorktree).ok, true);
    const candidateOwner = `release-only-owner-${sequence}`;
    assert.equal(store.claimTicket(slug, ticket.ref, candidateOwner, {
      token: candidate.token,
      executor,
      sessionId: candidateSessionId,
      requireBoundAgent: true,
    }).ok, true);
    const releaseFragment = path.join(candidateWorktree, '.release', 'unreleased', `${ticket.ref}.md`);
    fs.mkdirSync(path.dirname(releaseFragment), { recursive: true });
    fs.writeFileSync(releaseFragment, '---\ntype: fix\n---\n\nRelease-only checkpoint fixture.\n');
    execFileSync('git', ['add', path.relative(candidateWorktree, releaseFragment)], { cwd: candidateWorktree, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', `chore(release): add ${ticket.ref} fragment`], { cwd: candidateWorktree, windowsHide: true });
    const checkpointCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateWorktree, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(store.checkpointTicket(slug, ticket.ref, candidateOwner, {
      commit: checkpointCommit,
      verify: 'release fragment fixture inspected',
      source: 'test',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, candidateOwner, {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'The release-only checkpoint has no implementation to retain.',
    }).ok, true);
    removeWorktreeBranch(candidateWorktree, candidateBranch);

    const abandoned = store.prepareDispatch(slug, ticket.ref, { sessionId: abandonedSessionId });
    assert.equal(abandoned.ticket.dispatch.continuation, undefined);
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: abandoned.token,
      executor: abandoned.ticket.dispatchExecutor,
      sessionId: abandonedSessionId,
      agentName: abandonedAgentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, abandonedSessionId, abandonedWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', abandonedBranch, abandonedWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(abandonedSessionId, abandonedWorktree);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: abandoned.token,
      executor: abandoned.ticket.dispatchExecutor,
      sessionId: abandonedSessionId,
      taskName: abandonedAgentName,
      error: 'Subagent terminated unexpectedly',
      source: 'test',
    }).ok, true);

    const retry = store.prepareDispatch(slug, ticket.ref, { sessionId: `${abandonedSessionId}-retry` });
    assert.equal(retry.ok, true);
    assert.equal(retry.ticket.dispatch.continuation, undefined);
    assert.equal(agentsync.ticketIsolation(retry.ticket, retry.ticket.dispatch.sharedTree), 'worktree');
    assert.equal(fs.existsSync(abandonedWorktree), false);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'release-only-cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(abandonedWorktree, abandonedBranch);
    removeWorktreeBranch(candidateWorktree, candidateBranch);
  }
});

test('a meaningful checkpoint stays protected and names its retained-resume escape', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const ticket = store.createTicket(slug, {
    title: `meaningful checkpoint fixture ${sequence}`,
    category: 'codebase-exploration',
    description: 'A checkpoint with implementation work must survive an unrelated failed retry.',
    files: ['README.md'],
  });
  const candidateSessionId = `meaningful-candidate-session-${sequence}`;
  const candidateAgentName = `meaningful-candidate-agent-${sequence}`;
  const candidateBranch = `meaningful-candidate-${sequence}`;
  const candidateWorktree = path.join(SIDEQUEST_HOME, 'meaningful-checkpoint-targets', `candidate-${sequence}`);
  const abandonedSessionId = `meaningful-abandoned-session-${sequence}`;
  const abandonedBranch = `meaningful-abandoned-${sequence}`;
  const abandonedWorktree = path.join(SIDEQUEST_HOME, 'meaningful-checkpoint-targets', `abandoned-${sequence}`);
  fs.mkdirSync(path.dirname(candidateWorktree), { recursive: true });

  try {
    const candidate = store.prepareDispatch(slug, ticket.ref, { sessionId: candidateSessionId });
    const executor = candidate.ticket.dispatchExecutor;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: candidate.token,
      executor,
      sessionId: candidateSessionId,
      agentName: candidateAgentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, candidateSessionId, candidateWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', candidateBranch, candidateWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(candidateSessionId, candidateWorktree);
    assert.equal(store.bindDispatchAgent(candidateSessionId, executor, candidateAgentName, candidateAgentName, candidateWorktree).ok, true);
    const candidateOwner = `meaningful-owner-${sequence}`;
    assert.equal(store.claimTicket(slug, ticket.ref, candidateOwner, {
      token: candidate.token,
      executor,
      sessionId: candidateSessionId,
      requireBoundAgent: true,
    }).ok, true);
    fs.appendFileSync(path.join(candidateWorktree, 'README.md'), `\nMeaningful checkpoint ${sequence}.\n`);
    execFileSync('git', ['add', 'README.md'], { cwd: candidateWorktree, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', `test: preserve ${ticket.ref} checkpoint`], { cwd: candidateWorktree, windowsHide: true });
    const releaseFragment = path.join(candidateWorktree, '.release', 'unreleased', `${ticket.ref}.md`);
    fs.mkdirSync(path.dirname(releaseFragment), { recursive: true });
    fs.writeFileSync(releaseFragment, '---\ntype: fix\n---\n\nMeaningful candidate release fragment.\n');
    execFileSync('git', ['add', path.relative(candidateWorktree, releaseFragment)], { cwd: candidateWorktree, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', `chore(release): add ${ticket.ref} fragment`], { cwd: candidateWorktree, windowsHide: true });
    const checkpointCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateWorktree, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(store.checkpointTicket(slug, ticket.ref, candidateOwner, {
      commit: checkpointCommit,
      verify: 'meaningful checkpoint fixture inspected',
      source: 'test',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, candidateOwner, {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Keep the implementation checkpoint available.',
    }).ok, true);
    removeWorktreeBranch(candidateWorktree, candidateBranch);

    const abandoned = store.prepareDispatch(slug, ticket.ref, { sessionId: abandonedSessionId });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: abandoned.token,
      executor: abandoned.ticket.dispatchExecutor,
      sessionId: abandonedSessionId,
      agentName: `meaningful-abandoned-agent-${sequence}`,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, abandonedSessionId, abandonedWorktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', abandonedBranch, abandonedWorktree, 'HEAD'], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(abandonedSessionId, abandonedWorktree);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: abandoned.token,
      executor: abandoned.ticket.dispatchExecutor,
      sessionId: abandonedSessionId,
      taskName: `meaningful-abandoned-agent-${sequence}`,
      error: 'Subagent terminated unexpectedly',
      source: 'test',
    }).ok, true);

    assert.throws(
      () => store.prepareDispatch(slug, ticket.ref, { sessionId: `${abandonedSessionId}-retry` }),
      (error: any) => {
        assert.match(error.message, new RegExp(`checkpoint ${checkpointCommit}`));
        assert.match(error.message, /Restore .* to checkpoint .* then dispatch again; the board will resume that retained checkout/);
        return true;
      },
    );
    assert.equal(fs.existsSync(abandonedWorktree), true);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'meaningful-checkpoint-cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(abandonedWorktree, abandonedBranch);
    removeWorktreeBranch(candidateWorktree, candidateBranch);
  }
});

test('a token-validated failed claimant can surrender an unclaimed dispatch immediately', () => {
  const sequence = `${process.pid}-${Date.now()}`;
  const ticket = store.createTicket(slug, {
    title: `tokened surrender fixture ${sequence}`,
    category: 'codebase-exploration',
    description: 'The claiming runtime has a valid token but cannot bind its runtime session.',
    files: ['README.md'],
  });
  const dispatchSessionId = `tokened-surrender-dispatch-${sequence}`;
  const by = `tokened-surrender-worker-${sequence}`;

  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: dispatchSessionId });
    const refusedClaim = store.claimTicket(slug, ticket.ref, by, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      requireBoundAgent: true,
    });
    assert.equal(refusedClaim.ok, false);
    assert.equal(refusedClaim.reason, 'unbound_dispatch');

    const wrongClaimant = store.releaseTicket(slug, ticket.ref, `${by}-other`, {
      status: 'todo',
      source: 'test',
      releaseKind: 'technical_blocker',
      releaseReason: 'A different claimant must not consume this failed claim.',
    });
    assert.equal(wrongClaimant.ok, false);
    assert.equal(wrongClaimant.reason, 'unclaimed_active_dispatch');

    const surrendered = store.releaseTicket(slug, ticket.ref, by, {
      status: 'todo',
      source: 'test',
      releaseKind: 'technical_blocker',
      releaseReason: 'The current token could not bind this runtime.',
      releaseEvidence: {
        kind: 'technical_blocker',
        command: 'claim',
        exitCode: 1,
        outputTail: 'unbound_dispatch',
      },
    });
    assert.equal(surrendered.ok, true, surrendered.message);
    assert.equal(surrendered.ticket.claim, null);
    assert.equal(surrendered.ticket.dispatchNonce, null);
    assert.equal(surrendered.ticket.dispatch.outcome, 'released');

    const retry = store.prepareDispatch(slug, ticket.ref, { sessionId: `${dispatchSessionId}-retry` });
    assert.equal(retry.ok, true);
    assert.notEqual(retry.token, prepared.token);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'tokened-surrender-cleanup', { status: 'todo', source: 'test', force: true });
  }
});

test('parent-checkout SubagentStart binds each completed isolated target to its reserved native agent', () => {
  const created: Array<{ ref: string; worktree: string }> = [];
  const sequence = `${process.pid}-${Date.now()}`;
  const reserveTarget = (agentId: string, sessionId: string) => {
    const ticket = store.createTicket(slug, {
      title: `parent checkout fixture ${agentId}`,
      category: 'codebase-exploration',
      description: 'A fixture dispatch with a native target created by the parent checkout.',
      files: ['README.md'],
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worktree = path.join(SIDEQUEST_HOME, 'parent-checkout-targets', agentId);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    created.push({ ref: ticket.ref, worktree });
    return { ticket, executor, sessionId, agentId, worktree };
  };
  const createTarget = (agentId: string, sessionId: string) => {
    const target = reserveTarget(agentId, sessionId);
    execFileSync('git', ['worktree', 'add', '--detach', target.worktree], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(target.sessionId, target.worktree);
    return target;
  };

  try {
    const incomplete = reserveTarget(`parent-incomplete-${sequence}`, `parent-incomplete-session-${sequence}`);

    const first = createTarget(`parent-first-${sequence}`, `parent-first-session-${sequence}`);
    const second = createTarget(`parent-second-${sequence}`, `parent-second-session-${sequence}`);
    const foreignProject = initRepo(`sq-parent-foreign-${sequence}-`);
    const wrongProjectBinding = store.bindDispatchAgent(
      first.sessionId,
      first.executor,
      first.agentId,
      first.agentId,
      foreignProject,
    );
    assert.equal(wrongProjectBinding.ok, false);

    assert.equal(store.bindDispatchAgent(first.sessionId, first.executor, first.agentId, first.agentId, PROJECT).ok, true);
    assert.equal(store.bindDispatchAgent(second.sessionId, second.executor, second.agentId, second.agentId, PROJECT).ok, true);
    const preCompletionBinding = store.bindDispatchAgent(
      incomplete.sessionId,
      incomplete.executor,
      incomplete.agentId,
      incomplete.agentId,
      PROJECT,
    );
    assert.equal(preCompletionBinding.ok, false);
    assert.equal(preCompletionBinding.reason, 'worktree_binding_unavailable');
    const firstExpectation = store.dispatchIsolationExpectation({
      agentId: first.agentId,
      sessionId: first.sessionId,
      executor: first.executor,
    });
    const secondExpectation = store.dispatchIsolationExpectation({
      agentId: second.agentId,
      sessionId: second.sessionId,
      executor: second.executor,
    });
    assert.equal(firstExpectation.expectedWorktree, worktrees.canonicalPath(first.worktree));
    assert.equal(secondExpectation.expectedWorktree, worktrees.canonicalPath(second.worktree));
    assert.notEqual(firstExpectation.expectedWorktree, secondExpectation.expectedWorktree);

    assert.equal(runHook(GUARD_ISOLATION, writePayload(first.agentId, first.executor, first.sessionId, path.join(first.worktree, 'README.md'), first.worktree)), null);
    assert.equal(runHook(GUARD_ISOLATION, writePayload(second.agentId, second.executor, second.sessionId, path.join(second.worktree, 'README.md'), second.worktree)), null);
    for (const deniedWrite of [
      writePayload(first.agentId, first.executor, first.sessionId, path.join(second.worktree, 'README.md'), second.worktree),
      writePayload(second.agentId, second.executor, second.sessionId, path.join(first.worktree, 'README.md'), first.worktree),
      writePayload(first.agentId, first.executor, first.sessionId, path.join(PROJECT, 'README.md'), PROJECT),
    ]) {
      assert.equal(runHook(GUARD_ISOLATION, deniedWrite).hookSpecificOutput.permissionDecision, 'deny');
    }

    const foreignAgentBinding = store.bindDispatchAgent(first.sessionId, first.executor, `foreign-agent-${sequence}`, first.agentId, PROJECT);
    assert.equal(foreignAgentBinding.ok, false);

    const changed = createTarget(`parent-changed-${sequence}`, `parent-changed-session-${sequence}`);
    fs.appendFileSync(path.join(changed.worktree, 'README.md'), 'changed before binding\n');
    execFileSync('git', ['add', 'README.md'], { cwd: changed.worktree, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'changed before parent binding'], { cwd: changed.worktree, windowsHide: true });
    const changedRevisionBinding = store.bindDispatchAgent(changed.sessionId, changed.executor, changed.agentId, changed.agentId, PROJECT);
    assert.equal(changedRevisionBinding.ok, false);
    assert.equal(changedRevisionBinding.reason, 'worktree_binding_mismatch');

    const replacement = createTarget(`parent-replacement-${sequence}`, `parent-replacement-session-${sequence}`);
    execFileSync('git', ['worktree', 'remove', '--force', replacement.worktree], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['worktree', 'add', '--detach', replacement.worktree], { cwd: PROJECT, windowsHide: true });
    const checkoutInstanceBinding = store.bindDispatchAgent(replacement.sessionId, replacement.executor, replacement.agentId, replacement.agentId, PROJECT);
    assert.equal(checkoutInstanceBinding.ok, false);

    const ambiguousAgent = `parent-ambiguous-${sequence}`;
    const ambiguousSession = `parent-ambiguous-session-${sequence}`;
    const ambiguousFirst = reserveTarget(ambiguousAgent, ambiguousSession);
    reserveTarget(ambiguousAgent, ambiguousSession);
    const ambiguousBinding = store.bindDispatchAgent(ambiguousFirst.sessionId, ambiguousFirst.executor, ambiguousAgent, ambiguousAgent, PROJECT);
    assert.equal(ambiguousBinding.ok, false);
    assert.equal(ambiguousBinding.reason, 'ambiguous');

    const firstDispatch = store.getTicket(slug, first.ticket.ref);
    assert.equal(store.claimTicket(slug, first.ticket.ref, 'parent-terminal-worker', {
      token: firstDispatch.dispatchNonce,
      executor: first.executor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, first.ticket.ref, 'parent-terminal-worker', { status: 'todo' }).ok, true);
    const terminalBinding = store.bindDispatchAgent(first.sessionId, first.executor, first.agentId, first.agentId, PROJECT);
    assert.equal(terminalBinding.ok, false);
  } finally {
    for (const target of created) {
      store.releaseTicket(slug, target.ref, 'parent-checkout-cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(target.worktree)) execFileSync('git', ['worktree', 'remove', '--force', target.worktree], { cwd: PROJECT, windowsHide: true });
    }
  }
});

test('a harness worktree beneath the invoking linked worktree is allowed', () => {
  const agentId = 'a2nestedharnessroot';
  const sessionId = `session-${agentId}`;
  const ticket = store.createTicket(slug, {
    title: `isolation fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch that records whether isolation was promised.',
    files: ['README.md'],
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const invokingWorktree = path.join(os.tmpdir(), `sq-isolation-invoking-${process.pid}-${Date.now()}`);
  const harnessWorktree = path.join(invokingWorktree, '.claude', 'worktrees', `agent-${agentId}`);
  execFileSync('git', ['worktree', 'add', '--detach', invokingWorktree], { cwd: PROJECT, windowsHide: true });
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, harnessWorktree).ok, true);
    fs.mkdirSync(path.dirname(harnessWorktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', harnessWorktree], { cwd: PROJECT, windowsHide: true });
    completeCheckoutCreation(sessionId, harnessWorktree);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, harnessWorktree).ok, true);
    assert.equal(
      store.getTicket(slug, ticket.ref).dispatch.worktree,
      // realpathSync.native expands 8.3 short names (runner~1) the way the store's
      // canonicalization does; plain realpathSync leaves them and diverges on CI.
      process.platform === 'win32' ? fs.realpathSync.native(harnessWorktree).toLowerCase() : fs.realpathSync(harnessWorktree),
    );
    const target = path.join(harnessWorktree, 'README.md');
    assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, harnessWorktree)), null);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', harnessWorktree], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['worktree', 'remove', '--force', invokingWorktree], { cwd: PROJECT, windowsHide: true });
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

test('a terminally failed executor releases its claim and still cannot resume in the shared checkout', () => {
  const agentId = 'a9dead';
  const { ticket, sessionId, executor } = dispatched(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'dead-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
    token: ticket.dispatchNonce,
    executor,
    sessionId,
    taskName: agentId,
    error: 'Subagent terminated unexpectedly',
  }).ok, true);
  const failedTicket = store.getTicket(slug, ticket.ref);
  assert.equal(failedTicket.dispatch.outcome, 'died');
  assert.equal(failedTicket.claim, null);
  assert.equal(failedTicket.status, 'todo');

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




test('an isolated executor can inspect but not mutate the shared checkout with git', () => {
  const agentId = 'shared-git';
  const { sessionId, executor } = dispatched(agentId);
  const command = (value: string) => runHook(GUARD_SHARED_CHECKOUT_GIT, {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd: path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`),
    tool_name: 'Bash',
    tool_input: { command: value },
  });

  assert.equal(command(`git -C "${PROJECT}" log --oneline`), null, 'read-only Git against the shared checkout stays available');
  const denied = command(`git -C "${PROJECT}" reset --hard HEAD`);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /mutating git command against the shared checkout/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Read-only git commands/);
});

test('an unrelated executor subagent does not inherit a session fallback claim', () => {
  const activeAgentId = 'active-shared-git';
  const { sessionId, executor } = dispatched(activeAgentId);
  const integratorAgentId = 'integrator-subagent';

  const command = (agentId: string) => runHook(GUARD_SHARED_CHECKOUT_GIT, {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd: path.join(PROJECT, '.claude', 'worktrees', `agent-${activeAgentId}`),
    tool_name: 'Bash',
    tool_input: { command: `git -C "${PROJECT}" reset --hard HEAD` },
  });

  assert.equal(command(integratorAgentId), null, 'the integrator subagent retains shared-checkout access');
  const denied = command(activeAgentId);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', 'a live isolated executor remains blocked');
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

test('destructive Git guard ignores heredoc prose but refuses executable publication commands', () => {
  const repo = initRepo('sq-destructive-heredoc-');
  const project = store.ensureProject(repo);
  store.setBoardConfig(project.slug, { integrationBranch: 'dev' });
  const payload = (command: string) => ({
    cwd: repo,
    session_id: 'other-session',
    tool_name: 'Bash',
    tool_input: { command },
  });
  const proseOnly = `git commit -F - <<'MESSAGE'\ngit push --force origin main\ngit reset --hard and rm -rf remain guarded in this security note\nMESSAGE`;
  assert.equal(runHook(GUARD_DESTRUCTIVE, payload(proseOnly)), null, 'commit message prose is not shell code');

  const executablePush = `git commit -F - <<'MESSAGE'\nsecurity note: git push --force remains guarded\nMESSAGE\ngit push --force origin HEAD:main`;
  const out = runHook(GUARD_DESTRUCTIVE, payload(executablePush));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /publish lock/);
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

test('SQ-2089: the configured integration authority decides the isolated baseline, or the dispatch refuses', () => {
  const repository = initRepo('sq-baseline-authority-');
  const git = (args: string[], cwd = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const commit = (message: string) => {
    fs.appendFileSync(path.join(repository, 'README.md'), `${message}\n`);
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };

  // The incident shape: a remote pinned at a stale commit, a local main ahead of it, and a third branch
  // configured as the integration authority. All three commits differ, so any baseline names its own source.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-baseline-remote-'));
  git(['init', '-b', 'main', '--bare', '--quiet'], remote);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  const staleRemoteMain = git(['rev-parse', 'refs/remotes/origin/main']);
  const localMain = commit('local main advance');
  git(['branch', 'terminal-wave', 'HEAD']);
  git(['checkout', '--quiet', 'terminal-wave']);
  const terminalTip = commit('terminal wave advance');
  git(['checkout', '--quiet', 'main']);
  assert.equal(new Set([staleRemoteMain, localMain, terminalTip]).size, 3, 'the fixture must keep all three refs distinct');

  const commitNames = new Map([[staleRemoteMain, 'stale origin/main'], [localMain, 'local main'], [terminalTip, 'terminal-wave tip']]);
  const baselineSlug = store.ensureProject(repository, 'baseline authority').slug;
  store.setCategory({ id: 'baseline-authority', name: 'baseline authority', route: { model: 'sonnet', effort: 'medium' }, fallback: null, enabled: true });
  const dispatchBaseline = (worktreeBase: string, integrationBranch: string, label: string) => {
    store.setBoardConfig(baselineSlug, { worktreeBase, integrationBranch, worktreeIsolation: true });
    const ticket = store.createTicket(baselineSlug, { title: label, category: 'baseline-authority', files: ['README.md'], source: 'test' });
    store.prepareDispatch(baselineSlug, ticket.ref, { sessionId: `baseline-${label}`, sharedTree: false });
    const baseCommit = store.getTicket(baselineSlug, ticket.ref).dispatch.baseCommit;
    return commitNames.get(baseCommit) || `an unconfigured commit (${baseCommit})`;
  };

  assert.equal(dispatchBaseline('origin-main', 'main', 'remote-main'), 'stale origin/main', 'origin-main forks the remote ref even when local main is ahead');
  assert.equal(dispatchBaseline('local-main', 'main', 'local-main'), 'local main', 'local-main forks the local branch');
  assert.equal(dispatchBaseline('local-main', 'terminal-wave', 'local-terminal'), 'terminal-wave tip', 'a configured non-main branch is the authority, not main');

  // A configured branch with no remote ref used to silently fall back to whatever main happened to be, which
  // is how an isolated executor produced a candidate parented on a commit nobody configured.
  store.setBoardConfig(baselineSlug, { worktreeBase: 'origin-main', integrationBranch: 'terminal-wave', worktreeIsolation: true });
  const unpushed = store.createTicket(baselineSlug, { title: 'unpushed authority', category: 'baseline-authority', files: ['README.md'], source: 'test' });
  assert.throws(
    () => store.prepareDispatch(baselineSlug, unpushed.ref, { sessionId: 'baseline-unpushed', sharedTree: false }),
    /refs\/remotes\/origin\/terminal-wave" for branch "terminal-wave" does not exist[\s\S]*worktreeBase is "origin-main"[\s\S]*--worktree-base local-main/,
  );
  assert.equal(store.getTicket(baselineSlug, unpushed.ref).dispatchNonce, null, 'a refused baseline mints no token');

  // Pushing it makes the same configuration legal, so the refusal is about the missing ref and nothing else.
  git(['push', '--quiet', 'origin', 'terminal-wave:refs/heads/terminal-wave']);
  assert.equal(dispatchBaseline('origin-main', 'terminal-wave', 'remote-terminal'), 'terminal-wave tip', 'origin-main forks the configured branch once its remote ref exists');
});
