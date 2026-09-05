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

function createAgentWorktree(repository: string, root: string, name: string, withCheckoutMarker = true): string {
  const worktree = path.join(root, `agent-${name}`);
  fs.mkdirSync(root, { recursive: true });
  git(repository, ['worktree', 'add', '-b', `worktree-agent-${name}`, worktree, 'HEAD']);
  if (withCheckoutMarker) {
    const gitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
    const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
    worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  }
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

test('sweep reclaims clean legacy worktrees and reports facts for retained legacy worktrees', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const boundWorktree = createAgentWorktree(repository, worktreeRoot, 'bound-fixture');
  const cleanLegacyWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-clean', false);
  const dirtyLegacyWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-dirty', false);
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const boundTicket = integratedTicket('SQ-BOUND-FIXTURE', 'bound-fixture', boundWorktree, baseCommit);
  fs.utimesSync(cleanLegacyWorktree, oldTimestamp, oldTimestamp);
  fs.writeFileSync(path.join(dirtyLegacyWorktree, 'unfinished.txt'), 'keep this work\n');
  fs.utimesSync(dirtyLegacyWorktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [boundTicket], { execute: true, minAgeMs: 3 * 60 * 60 * 1000, integrationTarget });
    const entryFor = (worktree: string) => result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    const cleanLegacy = entryFor(cleanLegacyWorktree);
    const dirtyLegacy = entryFor(dirtyLegacyWorktree);

    assert.equal(entryFor(boundWorktree).reason, 'ticket_done');
    assert.equal(cleanLegacy.action, 'remove');
    assert.equal(cleanLegacy.reason, 'legacy_no_lease');
    assert.equal(cleanLegacy.clean, true);
    assert.equal(cleanLegacy.ahead, 0);
    assert.equal(cleanLegacy.ageMs >= 3 * 60 * 60 * 1000, true);
    assert.equal(dirtyLegacy.action, 'keep');
    assert.equal(dirtyLegacy.reason, 'legacy_unreclaimed');
    assert.equal(dirtyLegacy.clean, false);
    assert.equal(dirtyLegacy.ahead, 0);
    assert.equal(dirtyLegacy.ageMs >= 3 * 60 * 60 * 1000, true);
    assert.equal(fs.existsSync(boundWorktree), false);
    assert.equal(fs.existsSync(cleanLegacyWorktree), false);
    assert.equal(fs.existsSync(dirtyLegacyWorktree), true);
  } finally {
    for (const worktree of [boundWorktree, cleanLegacyWorktree, dirtyLegacyWorktree]) {
      if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep preserves locked and live legacy worktrees without lease identity', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const lockedWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-locked', false);
  const liveWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-live', false);
  git(repository, ['worktree', 'lock', lockedWorktree]);
  try {
    const result = await worktrees.sweep(repository, [], {
      execute: true,
      minAgeMs: 0,
      livePaths: [liveWorktree],
      integrationTarget,
    });
    const entryFor = (worktree: string) => result.entries.find((candidate: { path: string }) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entryFor(lockedWorktree).reason, 'locked');
    assert.equal(entryFor(liveWorktree).reason, 'live_session');
    assert.equal(fs.existsSync(lockedWorktree), true);
    assert.equal(fs.existsSync(liveWorktree), true);
  } finally {
    git(repository, ['worktree', 'unlock', lockedWorktree]);
    for (const worktree of [lockedWorktree, liveWorktree]) {
      if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    }
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

test('sweep prunes expired recovery entries, preserves live agents, and clears removed quarantine failures', async () => {
  const { repository } = repositoryFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-recovery-retention-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  const previousAge = process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS;
  const previousCount = process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_MAX_PER_AGENT;
  process.env.SIDEQUEST_HOME = home;
  process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS = String(24 * 60 * 60 * 1000);
  process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_MAX_PER_AGENT = '2';
  const timestamp = (ageMs: number) => new Date(Date.now() - ageMs).toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(home, 'worktree-backups');
  const quarantineRoot = path.join(home, 'worktree-quarantine');
  const createEntry = (root: string, name: string) => {
    const entry = path.join(root, name);
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'evidence.patch'), 'preserved\n');
    return entry;
  };
  const oldBackup = createEntry(backupRoot, `agent-a-${timestamp(48 * 60 * 60 * 1000)}`);
  const middleBackup = createEntry(backupRoot, `agent-a-${timestamp(3 * 60 * 60 * 1000)}`);
  const recentBackup = createEntry(backupRoot, `agent-a-${timestamp(2 * 60 * 60 * 1000)}`);
  const newestBackup = createEntry(backupRoot, `agent-a-${timestamp(60 * 60 * 1000)}`);
  const oldQuarantine = createEntry(quarantineRoot, `agent-b-${timestamp(48 * 60 * 60 * 1000)}`);
  const liveQuarantine = createEntry(quarantineRoot, `agent-live-${timestamp(48 * 60 * 60 * 1000)}`);
  const sourceWorktree = path.join(home, 'agent-b-source');
  fs.mkdirSync(sourceWorktree, { recursive: true });
  fs.writeFileSync(path.join(home, 'worktree-sweep-failures.json'), JSON.stringify({
    [worktrees.canonicalPath(sourceWorktree)]: { fingerprint: 'failed', attempts: 1, quarantinedPath: oldQuarantine },
  }));
  const liveTicket = { claimLive: true, dispatch: { agentId: 'live' } };
  try {
    const dryRun = await worktrees.sweep(repository, [liveTicket], { execute: false, integrationTarget, includeStoreUsage: true });
    assert.equal(dryRun.recovery.backups.entries.filter((entry: any) => entry.action === 'remove').length, 2);
    assert.equal(dryRun.recovery.quarantine.entries.find((entry: any) => entry.path === liveQuarantine).reason, 'live_claim');
    assert.equal(fs.existsSync(oldBackup), true);
    assert.equal(dryRun.storage.backups.bytes > 0, true);
    assert.equal(dryRun.storage.quarantine.bytes > 0, true);

    const result = await worktrees.sweep(repository, [liveTicket], { execute: true, integrationTarget, includeStoreUsage: true });
    assert.equal(result.counts.removedBackupEntries, 2);
    assert.equal(result.counts.removedQuarantineEntries, 1);
    assert.equal(result.counts.reclaimedBytes > 0, true);
    assert.equal(fs.existsSync(oldBackup), false);
    assert.equal(fs.existsSync(middleBackup), false);
    assert.equal(fs.existsSync(recentBackup), true);
    assert.equal(fs.existsSync(newestBackup), true);
    assert.equal(fs.existsSync(oldQuarantine), false);
    assert.equal(fs.existsSync(liveQuarantine), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'worktree-sweep-failures.json'), 'utf8')), {});
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    if (previousAge == null) delete process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS;
    else process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS = previousAge;
    if (previousCount == null) delete process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_MAX_PER_AGENT;
    else process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_MAX_PER_AGENT = previousCount;
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('quarantine removes ignored build output and dependency directories', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-quarantine-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  const source = path.join(home, 'agent-quarantine-source');
  const destinationRoot = path.join(home, 'worktree-quarantine');
  fs.mkdirSync(source, { recursive: true });
  git(source, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(source, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'keep\n');
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(source, '.venv'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'node_modules', 'package.json'), '{}\n');
  fs.writeFileSync(path.join(source, '.venv', 'state'), 'generated\n');
  fs.writeFileSync(path.join(source, 'dist', 'bundle.js'), 'generated\n');
  try {
    const result = await worktrees.quarantineCandidate({ path: source }, 'fixture remove failure', { quarantineDir: destinationRoot });
    assert.equal(result.ok, true);
    assert.ok(result.destination);
    assert.equal(fs.existsSync(path.join(result.destination, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(result.destination, '.venv')), false);
    assert.equal(fs.existsSync(path.join(result.destination, 'dist')), false);
    assert.equal(fs.existsSync(path.join(result.destination, 'tracked.txt')), true);
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dirty worktree backup contains patches and recovery metadata without a copied checkout', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktree-backup-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  const worktree = createAgentWorktree(repository, worktreeRoot, 'dirty-backup');
  const ticket = integratedTicket('SQ-DIRTY-BACKUP', 'dirty-backup', worktree, baseCommit);
  fs.writeFileSync(path.join(worktree, 'unfinished.txt'), 'preserve me\n');
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    assert.equal(result.backups.length, 1);
    const backup = result.backups[0];
    const metadata = JSON.parse(fs.readFileSync(path.join(backup, 'metadata.json'), 'utf8'));
    assert.equal(metadata.agentId, 'dirty-backup');
    assert.equal(metadata.ticket, 'SQ-DIRTY-BACKUP');
    assert.equal(metadata.branch, 'worktree-agent-dirty-backup');
    assert.equal(metadata.upstream, 'HEAD');
    assert.equal(typeof metadata.backedUpAt, 'string');
    assert.equal(fs.existsSync(path.join(backup, 'working-tree.patch')), true);
    assert.equal(fs.existsSync(path.join(backup, 'commits.patch')), true);
    assert.equal(fs.existsSync(path.join(backup, 'contents')), false);
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
