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
    assert.equal(agentsync.agentSpawn('binding-worker', undefined, null, prepared.ticket.dispatchExecutor, 'claim first').subagent_type, prepared.ticket.dispatchExecutor);
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

test('terminal retry preserves a markerless linked checkout', () => {
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
    assert.throws(
      () => store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-retry`, sharedTree: false }),
      /cannot retry because immutable recovery fact: cleanup requires the completed WorktreeCreate checkout binding/,
    );
    assert.equal(fs.existsSync(worktree), true);
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
    assert.match(result.message, /completed WorktreeCreate checkout binding/);
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
