import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const worktrees = require('../src/lib/worktrees.ts');
const worktreeLease = require('../src/lib/kernel/worktree.ts');

function git(repository: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function repositoryFixture() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktree-lease-'));
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'base']);
  const baseCommit = git(repository, ['rev-parse', 'HEAD']);
  return { repository, baseCommit, worktreeRoot: path.join(repository, '.claude', 'worktrees') };
}

function checkoutIdentity(worktree: string) {
  const resolveGitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(worktree, value);
  const gitDirectory = resolveGitPath(git(worktree, ['rev-parse', '--git-dir']));
  const checkoutInstance = worktreeLease.checkoutInstanceIdentity(gitDirectory);
  if (!checkoutInstance) throw new Error(`checkout instance is unavailable for ${worktree}`);
  return {
    gitDirectory,
    commonGitDirectory: resolveGitPath(git(worktree, ['rev-parse', '--git-common-dir'])),
    checkoutInstance,
  };
}

function createAgentWorktree(repository: string, root: string, name: string): string {
  const worktree = path.join(root, `agent-${name}`);
  fs.mkdirSync(root, { recursive: true });
  git(repository, ['worktree', 'add', '-b', `worktree-agent-${name}`, worktree, 'HEAD']);
  const gitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  return worktree;
}

function integratedTicket(ref: string, agentId: string, worktree: string, baseCommit: string, suppliedIdentity?: { gitDirectory: string; commonGitDirectory: string; checkoutInstance: string }) {
  const identity = suppliedIdentity || checkoutIdentity(worktree);
  const terminalAt = new Date().toISOString();
  const terminalSource = 'test-store-transition';
  const outcome = 'done';
  return {
    ref,
    status: 'done',
    claimLive: false,
    dispatch: {
      agentId,
      worktree,
      baseCommit,
      worktreeBindingSource: 'worktree-create',
      worktreeCreationCompletedAt: terminalAt,
      worktreeGitDirectory: identity.gitDirectory,
      worktreeCommonGitDirectory: identity.commonGitDirectory,
      worktreeCheckoutInstance: identity.checkoutInstance,
      worktreeObservedRevision: baseCommit,
      terminalAt,
      terminalSource,
      outcome,
      attempts: [{ terminalAt, terminalSource, outcome }],
    },
  };
}

const integrationTarget = { upstream: 'HEAD', branch: 'main' };

test('sweep leaves an unbound registered worktree untouched', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'unknown');
  try {
    const result = await worktrees.sweep(repository, [], { execute: true, minAgeMs: 0, integrationTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    assert.equal(entry.reason, 'unknown_identity');
    assert.equal(entry.action, 'keep');
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep removes only the terminal bound registered worktree', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'bound');
  const ticket = integratedTicket('SQ-BOUND', 'bound', worktree, baseCommit);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    assert.deepEqual(result.removed.map((candidate: string) => worktrees.canonicalPath(candidate)), [worktrees.canonicalPath(worktree)]);
    assert.equal(fs.existsSync(worktree), false);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep preserves an exact completed binding without terminal lifecycle authority', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'bound-nonterminal');
  const ticket = integratedTicket('SQ-BOUND-NONTERMINAL', 'bound-nonterminal', worktree, baseCommit);
  ticket.status = 'done';
  const nonterminalDispatch: any = ticket.dispatch;
  nonterminalDispatch.outcome = 'launched';
  delete nonterminalDispatch.terminalAt;
  delete nonterminalDispatch.terminalSource;
  delete nonterminalDispatch.attempts;
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'active_ticket');
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep refuses cleanup after a bound checkout is recreated at the exact path', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'replaced');
  const identity = checkoutIdentity(worktree);
  const ticket = integratedTicket('SQ-REPLACED', 'replaced', worktree, baseCommit, identity);
  try {
    git(repository, ['worktree', 'remove', '--force', worktree]);
    git(repository, ['worktree', 'add', '--detach', worktree, baseCommit]);
    const replacementGitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
    const replacementGitDirectory = path.isAbsolute(replacementGitDirectoryValue)
      ? replacementGitDirectoryValue
      : path.resolve(worktree, replacementGitDirectoryValue);
    assert.equal(worktrees.canonicalPath(replacementGitDirectory), worktrees.canonicalPath(identity.gitDirectory));
    assert.equal(worktreeLease.checkoutInstanceIdentity(replacementGitDirectory), null);

    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'checkout_instance_mismatch');
    assert.match(entry.leaseDecision, /checkout instance/);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep treats a live path as live lease evidence', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'live');
  const ticket = integratedTicket('SQ-LIVE', 'live', worktree, baseCommit);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, livePaths: [worktree], integrationTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    assert.equal(entry.reason, 'live_session');
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unclaimed dispatch cleanup is denied by its unknown lease identity', () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'unclaimed');
  try {
    const result = worktrees.reclaimUnclaimedDispatchWorktree(repository, { sharedTree: false, worktree, baseCommit, ref: 'SQ-UNCLAIMED' });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, 'lease_refused');
    assert.match(result.message, /store-owned terminal dispatch transition/);
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
