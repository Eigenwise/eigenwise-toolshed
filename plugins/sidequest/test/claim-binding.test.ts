import './_temp-cleanup.js';
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
const worktrees = require('../lib/worktrees.js');
const slug = store.ensureProject(PROJECT).slug;
store.setCategory({ id: 'binding.write', name: 'Binding write', route: { model: 'codex-gpt-test', effort: 'high' }, enabled: true });
store.setCategory({ id: 'binding.readonly', name: 'Binding readonly', route: { model: 'codex-gpt-test', effort: 'high' }, readonly: true, enabled: true });

function createFixture(title: string, category = 'binding.write') {
  return store.createTicket(slug, { title, category, files: ['tracked.txt'], source: 'test' });
}

function recoveryFixture(kind: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-claim-binding-${kind}-`));
  git(repository, ['init', '--quiet', '-b', 'main']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'Claim Binding Recovery']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'seed\n');
  git(repository, ['add', 'tracked.txt']);
  git(repository, ['commit', '--quiet', '-m', 'seed']);
  const initial = git(repository, ['rev-parse', 'HEAD']);
  if (kind === 'ancestor') {
    fs.appendFileSync(path.join(repository, 'tracked.txt'), 'base\n');
    git(repository, ['add', 'tracked.txt']);
    git(repository, ['commit', '--quiet', '-m', 'base']);
  }
  const baseCommit = git(repository, ['rev-parse', 'HEAD']);
  const worktree = path.join(repository, '.claude', 'worktrees', `agent-${kind}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repository, ['worktree', 'add', '--quiet', '-b', `agent-${kind}`, worktree, kind === 'ancestor' ? initial : baseCommit]);
  if (kind === 'dirty') fs.appendFileSync(path.join(worktree, 'tracked.txt'), 'dirty\n');
  if (kind === 'advanced') {
    fs.appendFileSync(path.join(worktree, 'tracked.txt'), 'progress\n');
    git(worktree, ['add', 'tracked.txt']);
    git(worktree, ['commit', '--quiet', '-m', 'progress']);
  }
  return { repository, worktree, baseCommit };
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

test('terminal recovery names the immutable fact that prevents a retry', () => {
  const ticket = createFixture('dirty terminal recovery');
  const sessionId = 'dirty-terminal-recovery';
  const agentName = 'dirty-terminal-agent';
  const branch = `agent-${agentName}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentName);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(PROJECT, ['worktree', 'add', '--quiet', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit]);
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentName, agentName).ok, true);
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

test('unclaimed recovery reclaims only exact no-progress worktrees', () => {
  const cases: Array<[string, string, string]> = [
    ['clean-base', 'clean-base', 'reclaimed'],
    ['clean-ancestor', 'ancestor', 'reclaimed'],
    ['dirty', 'dirty', 'dirty_worktree'],
    ['advanced', 'advanced', 'candidate_commit'],
  ];
  for (const [name, kind, expected] of cases) {
    const candidate = recoveryFixture(kind);
    try {
      const result = worktrees.reclaimUnclaimedDispatchWorktree(candidate.repository, {
        sharedTree: false,
        worktree: candidate.worktree,
        baseCommit: candidate.baseCommit,
      });
      if (expected === 'reclaimed') {
        assert.equal(result.reclaimed, true, name);
        assert.equal(fs.existsSync(candidate.worktree), false, name);
      } else {
        assert.equal(result.reclaimed, false, name);
        assert.equal(result.reason, expected, name);
        assert.equal(fs.existsSync(candidate.worktree), true, name);
        assert.match(result.message, /immutable recovery fact/, name);
      }
    } finally {
      fs.rmSync(candidate.repository, { recursive: true, force: true });
    }
  }
});
