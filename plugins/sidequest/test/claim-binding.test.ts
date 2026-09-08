import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-binding-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-binding-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-claim-binding-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'ready' },
  models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
process.env.CLAUDE_PROJECT_DIR = PROJECT;

function git(directory: string, args: string[]) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
}

git(PROJECT, ['init', '--quiet', '-b', 'main']);
git(PROJECT, ['config', 'user.email', 'test@example.invalid']);
git(PROJECT, ['config', 'user.name', 'Claim Binding Test']);
fs.writeFileSync(path.join(PROJECT, 'tracked.txt'), 'seed\n');
git(PROJECT, ['add', 'tracked.txt']);
git(PROJECT, ['commit', '--quiet', '-m', 'seed']);

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');
const { claimRefusalMessage } = require('../lib/refusal-guidance.js');
const db = require('../lib/db.js');
const worktrees = require('../lib/worktrees.js');
const worktreeKernel = require('../lib/kernel/worktree.js');
const slug = store.ensureProject(PROJECT).slug;
store.setCategory({ id: 'binding.write', name: 'Binding write', route: { model: 'codex-gpt-test', effort: 'high' }, enabled: true });
store.setCategory({ id: 'binding.readonly', name: 'Binding readonly', route: { model: 'codex-gpt-test', effort: 'high' }, readonly: true, enabled: true });

function createFixture(title: string, category = 'binding.write') {
  return store.createTicket(slug, { title, category, files: ['tracked.txt'], source: 'test' });
}

function persist(ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim?.by || null,
    data: ticket,
  });
}

function recoveryFixture(kind: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-claim-binding-${kind}-`));
  git(repository, ['init', '--quiet', '-b', 'main']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'Claim Binding Recovery']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'seed\n');
  git(repository, ['add', 'tracked.txt']);
  git(repository, ['commit', '--quiet', '-m', 'seed']);
  const baseCommit = git(repository, ['rev-parse', 'HEAD']);
  const worktree = path.join(repository, '.claude', 'worktrees', `agent-${kind}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repository, ['worktree', 'add', '--quiet', '-b', `agent-${kind}`, worktree, baseCommit]);
  return { repository, worktree, baseCommit };
}

function completedWorktreeBinding(candidate: { worktree: string }) {
  const resolveGitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(candidate.worktree, value);
  const gitDirectory = resolveGitPath(git(candidate.worktree, ['rev-parse', '--git-dir']));
  return {
    worktree: candidate.worktree,
    worktreeBindingSource: 'worktree-create',
    worktreeGitDirectory: gitDirectory,
    worktreeCommonGitDirectory: resolveGitPath(git(candidate.worktree, ['rev-parse', '--git-common-dir'])),
    worktreeCheckoutInstance: worktreeKernel.createCheckoutInstanceMarker(gitDirectory),
    worktreeObservedRevision: git(candidate.worktree, ['rev-parse', 'HEAD']),
    worktreeCreationCompletedAt: new Date().toISOString(),
  };
}

function terminalLifecycleState() {
  const terminalAt = new Date().toISOString();
  const terminalSource = 'test-store-transition';
  const outcome = 'failed';
  return {
    terminalAt,
    terminalSource,
    outcome,
    attempts: [{ terminalAt, terminalSource, outcome }],
  };
}

test('prepared executor identity is projected unchanged for writing and readonly claims', () => {
  const writing = createFixture('writing executor identity');
  const readonly = createFixture('readonly executor identity', 'binding.readonly');
  const preparedWriting = store.prepareDispatch(slug, writing.ref, { sessionId: 'writing-identity' });
  const preparedReadonly = store.prepareDispatch(slug, readonly.ref, { sessionId: 'readonly-identity' });

  assert.equal(preparedWriting.ticket.dispatchExecutor, 'sidequest-exec-dispatch');
  assert.equal(preparedReadonly.ticket.dispatchExecutor, 'sidequest-exec-dispatch-readonly');
  for (const prepared of [preparedWriting, preparedReadonly]) {
    assert.equal(prepared.ticket.dispatch.executor, prepared.ticket.dispatchExecutor);
    assert.equal(agentsync.agentSpawn('binding-worker', undefined, null, prepared.ticket.dispatchExecutor, 'claim first').subagent_type, `sidequest:${prepared.ticket.dispatchExecutor}`);
    assert.match(agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT), new RegExp(`executor: "${prepared.ticket.dispatchExecutor}"`));
  }

  const mismatch = store.claimTicket(slug, readonly.ref, 'wrong-readonly-worker', {
    token: preparedReadonly.token,
    executor: preparedWriting.ticket.dispatchExecutor,
  });
  assert.equal(mismatch.reason, 'executor_mismatch');
  assert.equal(store.claimTicket(slug, readonly.ref, 'readonly-worker', {
    token: preparedReadonly.token,
    executor: preparedReadonly.ticket.dispatchExecutor,
  }).ok, true);
});

test('bundled plugin types survive launch, runtime binding and claim without changing board identity', () => {
  const pluginRoot = path.resolve(__dirname, '..');
  function runHook(filename: string, input: Record<string, unknown>): string {
    return execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', filename)], {
      cwd: PROJECT,
      input: JSON.stringify(input),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_CODE_SUBAGENT_MODEL: '' },
    });
  }
  for (const category of ['binding.write', 'binding.readonly']) {
    const ticket = createFixture(`namespaced ${category}`, category);
    const sessionId = `namespaced-${ticket.ref}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
    const executor = prepared.ticket.dispatchExecutor;
    const prompt = agentsync.renderDispatchStub(prepared.ticket, PROJECT);
    const spawn = agentsync.agentSpawn(prepared.ticket.dispatch.launchName, null, null, executor, prompt, prepared.ticket.dispatch.description);
    assert.equal(spawn.subagent_type, `sidequest:${executor}`);
    for (const rejectedType of [`other:${executor}`, `${spawn.subagent_type}-extra`, 'sidequest:general-purpose']) {
      const rejected: { hookSpecificOutput: { permissionDecision: string } } = JSON.parse(runHook('force-exec-bypass.js', {
        tool_name: 'Agent', cwd: PROJECT, session_id: sessionId, tool_input: { ...spawn, subagent_type: rejectedType },
      }));
      assert.equal(rejected.hookSpecificOutput.permissionDecision, 'deny', rejectedType);
    }
    const admitted: { hookSpecificOutput: { permissionDecision?: string; updatedInput?: { subagent_type: string } } } = JSON.parse(runHook('force-exec-bypass.js', {
      tool_name: 'Agent', cwd: PROJECT, session_id: sessionId, tool_input: spawn,
    }));
    assert.notEqual(admitted.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(admitted.hookSpecificOutput.updatedInput?.subagent_type, spawn.subagent_type);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.executor, executor);
    const agentId = `agent-${ticket.ref}`;
    runHook('subagent-start.js', { cwd: PROJECT, session_id: sessionId, agent_id: agentId, agent_type: spawn.subagent_type, agent_name: spawn.name });
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, agentId);
    const claimed = store.claimTicket(slug, ticket.ref, `worker-${ticket.ref}`, { token: prepared.token, executor, effort: 'high' });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    runHook('subagent-stop.js', { cwd: PROJECT, session_id: sessionId, agent_id: agentId, agent_type: spawn.subagent_type, agent_name: spawn.name });
    const stopped = store.getTicket(slug, ticket.ref);
    assert.ok(stopped.dispatch.turnEndedAt);
    assert.equal(stopped.claim.by, `worker-${ticket.ref}`);
  }
});

test('plugin namespace normalization recognizes only the shipped definitions', () => {
  const names = require('../lib/exec-names.js');
  for (const filename of agentsync.bundledExecutorSources().keys()) {
    const name = filename.replace(/\.md$/, '');
    assert.equal(names.bundledAgentType(name), `sidequest:${name}`);
    assert.equal(names.canonicalExecutorName(`sidequest:${name}`), name);
    assert.deepEqual(names.classify(`sidequest:${name}`), names.classify(name));
  }
  for (const name of ['other:sidequest-exec-high', 'sidequest:sidequest-exec-high-extra', 'sidequest:sidequest-sq-1', 'sidequest:sidequest-exec-dispatch-high', 'sidequest:sidequest:sidequest-exec-high', 'sidequest:general-purpose']) {
    assert.equal(names.canonicalExecutorName(name), name);
    assert.equal(names.classify(name).kind, 'unknown');
  }
});

test('empty-scope readonly dispatch uses the shared project when Git has no HEAD', () => {
  const repository = fs.mkdtempSync(path.join(SIDEQUEST_HOME, 'unborn-readonly-'));
  git(repository, ['init', '--quiet', '-b', 'main']);
  const originalContents = 'User notes must remain uncommitted.\n';
  fs.writeFileSync(path.join(repository, 'notes.md'), originalContents);
  const originalStatus = git(repository, ['status', '--porcelain']);
  const project = store.ensureProject(repository).slug;
  const ticket = store.createTicket(project, { title: 'Read-only catalogue research', category: 'binding.readonly', files: [] });
  const sessionId = `unborn-readonly-${ticket.ref}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId, runtimeCwd: repository });

  assert.equal(prepared.ticket.dispatch.sharedTree, true);
  assert.match(prepared.ticket.dispatch.worktreeWarning, /repo has no commits or HEAD cannot be resolved/);
  assert.match(prepared.ticket.dispatch.worktreeWarning, /Read-only/);
  assert.doesNotMatch(prepared.ticket.dispatch.worktreeWarning, /must scoped-commit|git (?:init|add|commit)/);
  assert.equal(prepared.ticket.dispatch.readonly, true);
  assert.equal(prepared.ticket.dispatch.baseCommit, null);
  const spawn = agentsync.agentSpawn(
    prepared.ticket.dispatch.launchName,
    agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree),
    null,
    prepared.ticket.dispatchExecutor,
    agentsync.renderDispatchStub(prepared.ticket, repository),
    prepared.ticket.dispatch.description,
  );
  assert.equal(Object.hasOwn(spawn, 'isolation'), false);
  const pluginRoot = path.resolve(__dirname, '..');
  function runHook(filename: string, input: Record<string, unknown>): string {
    return execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', filename)], {
      cwd: repository,
      input: JSON.stringify({ cwd: repository, session_id: sessionId, ...input }),
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: repository, CLAUDE_CODE_SUBAGENT_MODEL: '' },
    });
  }
  const admitted: { hookSpecificOutput: { permissionDecision?: string; updatedInput?: { isolation?: string } } } = JSON.parse(runHook('force-exec-bypass.js', {
    tool_name: 'Agent', tool_input: spawn,
  }));
  assert.notEqual(admitted.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(Object.hasOwn(admitted.hookSpecificOutput.updatedInput || {}, 'isolation'), false);
  const agentId = 'unborn-readonly-agent';
  runHook('subagent-start.js', { agent_id: agentId, agent_name: spawn.name, agent_type: spawn.subagent_type });
  const claimed = store.claimTicket(project, ticket.ref, 'unborn-readonly-worker', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, effort: 'high',
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(store.getTicket(project, ticket.ref).dispatch.agentId, agentId);
  assert.equal(fs.readFileSync(path.join(repository, 'notes.md'), 'utf8'), originalContents);
  assert.equal(git(repository, ['status', '--porcelain']), originalStatus);
  assert.throws(() => git(repository, ['rev-parse', '--verify', 'HEAD']));
});

test('empty-scope readonly dispatch works in a non-Git workspace without creating a repository', () => {
  const workspace = fs.mkdtempSync(path.join(SIDEQUEST_HOME, 'non-git-readonly-'));
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'Unversioned notes.\n');
  const project = store.ensureProject(workspace).slug;
  const ticket = store.createTicket(project, { title: 'Read-only unversioned research', category: 'binding.readonly', files: [] });
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId: 'non-git-readonly', runtimeCwd: workspace });
  assert.equal(prepared.ticket.dispatch.sharedTree, true);
  assert.equal(prepared.ticket.dispatch.readonly, true);
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), null);
  assert.match(prepared.ticket.dispatch.worktreeWarning, /not a Git work tree/);
  assert.doesNotMatch(prepared.ticket.dispatch.worktreeWarning, /must scoped-commit/);
  assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8'), 'Unversioned notes.\n');
});

test('empty-scope readonly dispatch keeps worktree isolation when Git has a HEAD', () => {
  const ticket = store.createTicket(slug, { title: 'Read-only committed repository', category: 'binding.readonly', files: [] });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'committed-readonly', runtimeCwd: PROJECT });
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(prepared.ticket.dispatch.baseCommit, git(PROJECT, ['rev-parse', 'HEAD']));
  assert.equal(prepared.ticket.dispatch.worktreeWarning, undefined);
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), 'worktree');
});

test('legacy scalar-only prepared executor identity hydrates into current dispatch state', () => {
  const ticket = createFixture('legacy prepared executor');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'legacy-prepared' });
  const legacy = store.getTicket(slug, ticket.ref);
  legacy.dispatch = null;
  persist(legacy);

  const hydrated = store.getTicket(slug, ticket.ref);
  assert.equal(hydrated.dispatch.executor, prepared.ticket.dispatchExecutor);
  assert.equal(store.claimTicket(slug, ticket.ref, 'legacy-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
});

test('live prepared dispatch executor wins over divergent legacy scalar identity', () => {
  const attempts = [
    { category: 'binding.readonly', current: 'sidequest-exec-dispatch-readonly', stale: 'sidequest-exec-dispatch' },
    { category: 'binding.write', current: 'sidequest-exec-dispatch', stale: 'sidequest-exec-dispatch-readonly' },
  ];
  for (const attempt of attempts) {
    const ticket = createFixture(`divergent ${attempt.category}`, attempt.category);
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `divergent-${attempt.category}` });
    const divergent = store.getTicket(slug, ticket.ref);
    divergent.dispatchExecutor = attempt.stale;
    divergent.dispatch.executor = attempt.current;
    persist(divergent);

    const current = store.getTicket(slug, ticket.ref);
    const briefing = agentsync.renderTicketBriefing(current, prepared.token, slug, PROJECT);
    assert.match(briefing, new RegExp(`executor: "${attempt.current}"`), attempt.category);
    const mismatch = store.claimTicket(slug, ticket.ref, `wrong-${attempt.category}`, {
      token: prepared.token,
      executor: attempt.stale,
    });
    assert.equal(mismatch.reason, 'executor_mismatch', attempt.category);
    assert.equal(mismatch.expectedExecutor, attempt.current, attempt.category);
    const guidance = claimRefusalMessage('executor_mismatch', ticket.ref, mismatch.ticket, PROJECT);
    assert.match(guidance, new RegExp(`executor: ${JSON.stringify(attempt.current)}`), attempt.category);
    assert.equal(store.claimTicket(slug, ticket.ref, `right-${attempt.category}`, {
      token: prepared.token,
      executor: attempt.current,
    }).ok, true, attempt.category);
  }
});

test('SubagentStop before claim clears admission and allows a fresh retry', () => {
  const ticket = createFixture('terminal preclaim retry');
  const sessionId = 'terminal-preclaim';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const agentName = 'terminal-preclaim-agent';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);
  assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).stopped, true);
  const terminal = store.getTicket(slug, ticket.ref);
  assert.equal(terminal.dispatch.outcome, 'failed');
  assert.equal(terminal.dispatch.failureShape, 'stopped_before_claim');
  assert.equal(terminal.dispatchNonce, null);
  assert.equal(terminal.dispatchExecutor, null);

  const retry = store.prepareDispatch(slug, ticket.ref, { sessionId: 'terminal-preclaim-retry', sharedTree: false });
  assert.notEqual(retry.token, prepared.token);
  assert.equal(retry.ticket.dispatch.attempts.at(-1).failureShape, 'stopped_before_claim');
});

test('recovery evidence immediately retires an incomplete WorktreeCreate checkout', () => {
  const ticket = createFixture('incomplete worktree creation recovery');
  const sessionId = `incomplete-worktree-recovery-${Date.now()}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, `incomplete-${ticket.id}`);
  const branch = `worktree-incomplete-${ticket.id}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    git(PROJECT, ['worktree', 'add', '--quiet', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit]);

    const replacement = store.prepareDispatch(slug, ticket.ref, {
      sessionId: `${sessionId}-retry`,
      sharedTree: false,
      recoveryEvidence: 'WorktreeCreate was cancelled after git worktree add and before completion.',
    });
    assert.notEqual(replacement.token, prepared.token);
    assert.equal(replacement.ticket.dispatch.attempts.at(-1).failureShape, 'stranded_bound_launch_superseded');
    assert.equal(fs.existsSync(worktree), false, 'recovery must retire a clean incomplete checkout immediately');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'incomplete-worktree-recovery-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) git(PROJECT, ['worktree', 'remove', '--force', worktree]);
    try { git(PROJECT, ['branch', '-D', branch]); } catch (_) {}
  }
});

test('terminal retry cleans a markerless linked checkout after a store-owned stop', () => {
  const ticket = createFixture('markerless terminal retry');
  const sessionId = `markerless-terminal-${Date.now()}`;
  const agentName = `markerless-terminal-agent-${ticket.id}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentName);
  const branch = `worktree-agent-${agentName}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    git(PROJECT, ['worktree', 'add', '--quiet', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit]);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);
    assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).stopped, true);
    const retry = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-retry`, sharedTree: false });
    assert.notEqual(retry.token, prepared.token);
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'markerless-terminal-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) git(PROJECT, ['worktree', 'remove', '--force', worktree]);
    try { git(PROJECT, ['branch', '-D', branch]); } catch (_) {}
  }
});

test('terminal retry cleans the exact completed-bound checkout', () => {
  const ticket = createFixture('bound terminal retry');
  const sessionId = `bound-terminal-${Date.now()}`;
  const agentName = `bound-terminal-agent-${ticket.id}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentName);
  const branch = `worktree-agent-${agentName}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    git(PROJECT, ['worktree', 'add', '--quiet', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit]);
    const gitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
    const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
    worktreeKernel.createCheckoutInstanceMarker(gitDirectory);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName, worktree).ok, true);
    assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).stopped, true);
    const retry = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-retry`, sharedTree: false });
    assert.notEqual(retry.token, prepared.token);
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'bound-terminal-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) git(PROJECT, ['worktree', 'remove', '--force', worktree]);
    try { git(PROJECT, ['branch', '-D', branch]); } catch (_) {}
  }
});

test('terminal recovery names the immutable fact that prevents a retry', () => {
  const ticket = createFixture('dirty terminal recovery');
  const sessionId = 'dirty-terminal-recovery';
  const agentName = 'dirty-terminal-agent';
  const branch = `agent-${agentName}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentName);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    git(PROJECT, ['worktree', 'add', '--quiet', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit]);
    const gitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
    const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
    worktreeKernel.createCheckoutInstanceMarker(gitDirectory);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName, worktree).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.txt'), 'dirty\n');
    assert.equal(store.markDispatchStopped(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).stopped, true);
    assert.throws(
      () => store.prepareDispatch(slug, ticket.ref, { sessionId: 'dirty-terminal-retry', sharedTree: false }),
      /cannot retry because immutable recovery fact: .* has uncommitted changes/,
    );
  } finally {
    store.releaseTicket(slug, ticket.ref, 'dirty-terminal-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT, windowsHide: true });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT, windowsHide: true });
  }
});

test('exact completed binding without terminal lifecycle preserves the checkout', () => {
  const candidate = recoveryFixture('exact-nonterminal');
  try {
    const binding = completedWorktreeBinding(candidate);
    const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
      sharedTree: false,
      baseCommit: candidate.baseCommit,
      ...binding,
    });
    assert.equal(result.reclaimed, false, 'completed creation identity cannot manufacture terminal cleanup authority');
    assert.match(result.message, /store-owned terminal dispatch transition/);
    assert.equal(fs.existsSync(candidate.worktree), true);
  } finally {
    fs.rmSync(candidate.repository, { recursive: true, force: true });
  }
});

test('terminal lifecycle without a completed marker binding preserves the checkout', () => {
  const candidate = recoveryFixture('terminal-markerless');
  try {
    const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
      sharedTree: false,
      worktree: candidate.worktree,
      baseCommit: candidate.baseCommit,
      ...terminalLifecycleState(),
    });
    assert.equal(result.reclaimed, false);
    assert.match(result.message, /WorktreeCreate binding was incomplete and could not be matched/);
    assert.equal(fs.existsSync(candidate.worktree), true);
  } finally {
    fs.rmSync(candidate.repository, { recursive: true, force: true });
  }
});

test('exact completed binding with terminal lifecycle cleans only that checkout instance', () => {
  const candidate = recoveryFixture('exact-terminal');
  try {
    const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
      sharedTree: false,
      baseCommit: candidate.baseCommit,
      ...completedWorktreeBinding(candidate),
      ...terminalLifecycleState(),
    });
    assert.equal(result.reclaimed, true);
    assert.equal(fs.existsSync(candidate.worktree), false);
  } finally {
    fs.rmSync(candidate.repository, { recursive: true, force: true });
  }
});

test('terminal cleanup preserves a recreated checkout with a mismatched marker digest', () => {
  const candidate = recoveryFixture('recreated-terminal');
  try {
    const binding = completedWorktreeBinding(candidate);
    fs.unlinkSync(path.join(binding.worktreeGitDirectory, 'sidequest-checkout-instance'));
    worktreeKernel.createCheckoutInstanceMarker(binding.worktreeGitDirectory);
    const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
      sharedTree: false,
      baseCommit: candidate.baseCommit,
      ...binding,
      ...terminalLifecycleState(),
    });
    assert.equal(result.reclaimed, false);
    assert.match(result.message, /checkout instance differs/);
    assert.equal(fs.existsSync(candidate.worktree), true);
  } finally {
    fs.rmSync(candidate.repository, { recursive: true, force: true });
  }
});

test('exact terminal cleanup preserves changed worktree contents', () => {
  for (const kind of ['dirty', 'advanced']) {
    const candidate = recoveryFixture(`terminal-${kind}`);
    try {
      const binding = completedWorktreeBinding(candidate);
      fs.appendFileSync(path.join(candidate.worktree, 'tracked.txt'), `${kind}\n`);
      if (kind === 'advanced') {
        git(candidate.worktree, ['add', 'tracked.txt']);
        git(candidate.worktree, ['commit', '--quiet', '-m', 'progress']);
      }
      const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
        sharedTree: false,
        baseCommit: candidate.baseCommit,
        ...binding,
        ...terminalLifecycleState(),
      });
      assert.equal(result.reclaimed, false, kind);
      assert.equal(fs.existsSync(candidate.worktree), true, kind);
    } finally {
      fs.rmSync(candidate.repository, { recursive: true, force: true });
    }
  }
});
