import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const worktree = require('../src/lib/kernel/worktree.ts');

function terminalLease(overrides: Record<string, unknown> = {}) {
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-lease-')));
  const observedWorktree = path.join(repository, 'agent-bound');
  fs.mkdirSync(observedWorktree);
  return worktree.createWorktreeLease({
    repository,
    gitDirectory: path.join(repository, '.git'),
    commonGitDirectory: path.join(repository, '.git'),
    dispatchRef: 'SQ-1917',
    dispatchBaseline: 'a'.repeat(40),
    observedRevision: 'a'.repeat(40),
    observedWorktree,
    identity: { status: 'bound', agentId: 'agent-1' },
    phase: 'terminal',
    locked: false,
    liveness: { status: 'terminal', evidence: 'SubagentStop' },
    provisioning: 'host',
    ...overrides,
  });
}

test('a worktree lease pins canonical identity and allows only the bound root', () => {
  const lease = terminalLease();
  assert.equal(worktree.worktreeWriteDecision(lease, path.join(lease.observedWorktree, 'file.ts')).allowed, true);
  assert.equal(worktree.worktreeWriteDecision(lease, path.dirname(lease.observedWorktree)).reason, 'target is outside the bound worktree.');
  assert.equal(worktree.isCanonicalRegisteredWorktree(lease, [lease.observedWorktree]), true);
});

test('unknown identity refuses writes, resume, and cleanup', () => {
  const lease = terminalLease({ identity: { status: 'unknown' } });
  for (const decision of [
    worktree.worktreeWriteDecision(lease, path.join(lease.observedWorktree, 'file.ts')),
    worktree.worktreeResumeDecision(lease),
    worktree.worktreeCleanupDecision(lease, [lease.observedWorktree]),
  ]) assert.equal(decision.allowed, false);
});

test('cleanup requires the terminal bound registered worktree', () => {
  const lease = terminalLease();
  assert.equal(worktree.worktreeCleanupDecision(lease, []).allowed, false);
  for (const overrides of [
    { phase: 'working' },
    { locked: true },
    { liveness: { status: 'live', evidence: 'SubagentStart' } },
    { provisioning: 'unknown' },
  ]) {
    const candidate = terminalLease(overrides);
    assert.equal(worktree.worktreeCleanupDecision(candidate, [candidate.observedWorktree]).allowed, false);
  }
  assert.equal(worktree.worktreeCleanupDecision(lease, [lease.observedWorktree]).allowed, true);
});

test('a changed worktree revision cannot write or resume against its dispatch baseline', () => {
  const lease = terminalLease({ observedRevision: 'b'.repeat(40) });
  assert.match(worktree.worktreeWriteDecision(lease, path.join(lease.observedWorktree, 'file.ts')).reason, /dispatch baseline/);
  assert.match(worktree.worktreeResumeDecision(lease).reason, /observed worktree revision/);
});
