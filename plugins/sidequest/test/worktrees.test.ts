import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The sweep now also enumerates and reclaims stray directories under the worktree
// home, so every test in this file has to run against a throwaway home or it would
// mutate the developer's real ~/.claude/sidequest (SQ-2924).
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktree-home-'));

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
  fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\nnested-clean/\n');
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
      sharedTree: false,
      worktree,
      baseCommit,
      worktreeBindingSource: 'worktree-create',
      worktreeCreationCompletedAt: terminalAt,
      worktreeGitDirectory: identity.gitDirectory,
      worktreeCommonGitDirectory: identity.commonGitDirectory,
      worktreeCheckoutInstance: identity.checkoutInstance,
      worktreeObservedRevision: baseCommit,
      ownedDependencyLinks: [] as Array<Record<string, string>>,
      terminalAt,
      terminalSource,
      outcome,
      attempts: [{ terminalAt, terminalSource, outcome }],
    },
  };
}

function recordedDependencyLink(ticket: any, worktree: string, relativePath: string, target: string): void {
  const dispatch = ticket.dispatch;
  dispatch.ownedDependencyLinks = [{
    relativePath,
    target: worktrees.canonicalPath(target),
    worktree: worktrees.canonicalPath(worktree),
    gitDirectory: worktrees.canonicalPath(dispatch.worktreeGitDirectory),
    commonGitDirectory: worktrees.canonicalPath(dispatch.worktreeCommonGitDirectory),
    checkoutInstance: dispatch.worktreeCheckoutInstance,
    revision: dispatch.worktreeObservedRevision,
  }];
}

function createDependencyLink(worktree: string, relativePath: string, target: string): string {
  const link = path.join(worktree, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

function dependencyTarget(repository: string, name: string): string {
  const target = path.join(repository, 'dependency-targets', name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'sentinel.txt'), name);
  return target;
}

const integrationTarget = { upstream: 'HEAD', branch: 'main' };

test('sweep reports an observed classification before its final result', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'progress');
  const ticket = integratedTicket('SQ-PROGRESS', 'progress', worktree, baseCommit);
  const progress: any[] = [];
  let completed = false;
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: false,
      minAgeMs: 0,
      integrationTarget,
      onProgress: (update: any) => {
        assert.equal(completed, false);
        progress.push(update);
      },
    });
    completed = true;

    assert.equal(result.entries.length, 1);
    assert.deepEqual(progress.filter((update) => update.phase === 'classifying').map((update) => update.observed), [0, 1]);
    const observed = progress.find((update) => update.phase === 'classifying' && update.observed === 1);
    assert.equal(worktrees.canonicalPath(observed.current), worktrees.canonicalPath(worktree));
    assert.equal(observed.reason, 'ticket_done');
    assert.equal(progress.at(-1).phase, 'complete');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep removes a recorded dependency link without following its target', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const target = dependencyTarget(repository, 'owned');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'owned-link');
  const ticket = integratedTicket('SQ-OWNED-LINK', 'owned-link', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/link', target);
  recordedDependencyLink(ticket, worktree, 'node_modules/link', target);
  try {
    const first = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    const second = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });

    assert.deepEqual(first.removed.map((candidate: string) => worktrees.canonicalPath(candidate)), [worktrees.canonicalPath(worktree)]);
    assert.deepEqual(second.removed, []);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.lstatSync(target).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'owned');
    assert.equal(fs.existsSync(link), false);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

// Was 'sweep unlinks a config-only dependency link and keeps its target', which asserted
// action 'remove' / reason 'ticket_done'. A junction the dispatch never recorded is content the
// sweep did not put there, so it is data at risk: the tree moves whole into quarantine with the
// link, instead of being deleted around it (SQ-2952 CRITICAL 1).
test('sweep quarantines a settled worktree holding a config-only dependency link', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unrecorded-link-quarantine-'));
  const target = dependencyTarget(repository, 'config-only');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'unrecorded-link');
  const ticket = integratedTicket('SQ-UNRECORDED-LINK', 'unrecorded-link', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/link', target);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.lstatSync(path.join(entry.quarantine, 'node_modules', 'link')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'config-only');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Was 'sweep unlinks a swapped recorded dependency link and keeps its foreign target', which
// asserted action 'remove' and that the link was gone. A link whose target no longer matches its
// record is not the link the sweep provisioned, so it counts as data at risk and travels with the
// quarantined tree; rename never follows it, which is what keeps both targets safe (SQ-2952).
test('sweep quarantines a worktree whose recorded dependency link was swapped and keeps both targets', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-swapped-link-quarantine-'));
  const expectedTarget = dependencyTarget(repository, 'expected');
  const swappedTarget = dependencyTarget(repository, 'swapped');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'swapped-link');
  const ticket = integratedTicket('SQ-SWAPPED-LINK', 'swapped-link', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/link', swappedTarget);
  recordedDependencyLink(ticket, worktree, 'node_modules/link', expectedTarget);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readlinkSync(path.join(entry.quarantine, 'node_modules', 'link')).replace(/^\\\\\?\\/, ''), swappedTarget);
    assert.equal(fs.readFileSync(path.join(swappedTarget, 'sentinel.txt'), 'utf8'), 'swapped');
    assert.equal(fs.readFileSync(path.join(expectedTarget, 'sentinel.txt'), 'utf8'), 'expected');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Was 'sweep preserves a recorded dependency link after checkout identity changes',
// which kept the worktree for checkout_instance_mismatch. A recreated checkout is
// metadata confidence, not data at risk: the tree is clean and settled, so it is
// reclaimed and only the link target has to survive (SQ-2924).
test('sweep reclaims a clean worktree whose checkout identity changed, keeping the link target', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const target = dependencyTarget(repository, 'identity');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'identity-link');
  const ticket = integratedTicket('SQ-IDENTITY-LINK', 'identity-link', worktree, baseCommit);
  recordedDependencyLink(ticket, worktree, 'node_modules/link', target);
  git(repository, ['worktree', 'remove', '--force', worktree]);
  git(repository, ['worktree', 'add', '--detach', worktree, baseCommit]);
  const link = createDependencyLink(worktree, 'node_modules/link', target);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.match(entry.leaseDecision, /checkout instance/);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'identity');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep leaves an owned link intact when salvage fails', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const target = dependencyTarget(repository, 'salvage');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'salvage-link');
  const ticket = integratedTicket('SQ-SALVAGE-LINK', 'salvage-link', worktree, baseCommit);
  fs.writeFileSync(path.join(worktree, 'conflict.txt'), 'worktree\n');
  git(worktree, ['add', 'conflict.txt']);
  git(worktree, ['commit', '-m', 'worktree change']);
  fs.writeFileSync(path.join(repository, 'conflict.txt'), 'repository\n');
  git(repository, ['add', 'conflict.txt']);
  git(repository, ['commit', '-m', 'repository change']);
  const merge = spawnSync('git', ['merge', 'main'], { cwd: worktree, windowsHide: true });
  assert.notEqual(merge.status, 0);
  const link = createDependencyLink(worktree, 'node_modules/link', target);
  recordedDependencyLink(ticket, worktree, 'node_modules/link', target);
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      notIntegratedSalvageAgeMs: 0,
      integrationTarget: { upstream: 'main', branch: 'main' },
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'tracked_changes');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(worktree, 'conflict.txt'), 'utf8').includes('worktree'), true);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'salvage');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provisionWorktree reports every created link before a setup failure', async () => {
  const { repository } = repositoryFixture();
  const target = dependencyTarget(repository, 'partial');
  const worktree = path.join(repository, 'provisioned-worktree');
  fs.mkdirSync(worktree);
  const recorded: { relativePath: string; target: string }[] = [];
  try {
    const failure = await worktrees.provisionWorktree(repository, worktree, {
      worktreeDependencyPaths: [{ path: 'dependency-targets/partial', mode: 'link' }],
      worktreeSetup: 'node -e "process.exit(7)"',
    }, { onDependencyLink: (link: { relativePath: string; target: string }) => recorded.push(link) });

    assert.equal(failure?.reason, 'exited with status 7');
    assert.deepEqual(recorded, [{ relativePath: 'dependency-targets/partial', target: worktrees.canonicalPath(target) }]);
    assert.equal(fs.lstatSync(path.join(worktree, 'dependency-targets', 'partial')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

// Was 'sweep reclaims clean legacy worktrees and reports facts for retained legacy
// worktrees', which pinned legacy_no_lease / legacy_unreclaimed. Legacy status no
// longer decides anything: an old worktree with no lease is classified by the same
// data-at-risk facts as any other, and untracked work follows the same age gate.
test('sweep classifies unleased worktrees by data at risk', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const boundWorktree = createAgentWorktree(repository, worktreeRoot, 'bound-fixture');
  const cleanLegacyWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-clean', false);
  const untrackedLegacyWorktree = createAgentWorktree(repository, worktreeRoot, 'legacy-dirty', false);
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const boundTicket = integratedTicket('SQ-BOUND-FIXTURE', 'bound-fixture', boundWorktree, baseCommit);
  fs.utimesSync(boundWorktree, oldTimestamp, oldTimestamp);
  fs.utimesSync(cleanLegacyWorktree, oldTimestamp, oldTimestamp);
  fs.writeFileSync(path.join(untrackedLegacyWorktree, 'unfinished.txt'), 'keep this work\n');
  fs.utimesSync(untrackedLegacyWorktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [boundTicket], { execute: true, minAgeMs: 3 * 60 * 60 * 1000, integrationTarget });
    const entryFor = (worktree: string) => result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    const cleanLegacy = entryFor(cleanLegacyWorktree);
    const untrackedLegacy = entryFor(untrackedLegacyWorktree);

    assert.equal(entryFor(boundWorktree).reason, 'ticket_done');
    assert.equal(cleanLegacy.action, 'remove');
    assert.equal(cleanLegacy.reason, 'branch_reachable');
    assert.equal(cleanLegacy.clean, true);
    assert.equal(cleanLegacy.ahead, 0);
    assert.equal(cleanLegacy.ageMs >= 3 * 60 * 60 * 1000, true);
    assert.equal(untrackedLegacy.action, 'keep');
    assert.equal(untrackedLegacy.reason, 'untracked_recent');
    assert.equal(untrackedLegacy.clean, false);
    assert.equal(fs.existsSync(boundWorktree), false);
    assert.equal(fs.existsSync(cleanLegacyWorktree), false);
    assert.equal(fs.existsSync(untrackedLegacyWorktree), true);
  } finally {
    for (const worktree of [boundWorktree, cleanLegacyWorktree, untrackedLegacyWorktree]) {
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

// Was 'sweep refuses cleanup after a bound checkout is recreated at the exact path'.
// The recreated checkout still fails the lease, and the report still says so, but a
// clean settled tree is reclaimed anyway: nothing there is at risk (SQ-2924).
test('sweep reclaims a clean worktree after a bound checkout is recreated at the exact path', async () => {
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
    assert.equal(entry.action, 'remove');
    assert.equal(entry.reason, 'ticket_done');
    assert.match(entry.leaseDecision, /checkout instance/);
    assert.equal(fs.existsSync(worktree), false);
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

test('unclaimed dispatch recovery removes a recorded dependency link without following its target', () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const target = dependencyTarget(repository, 'recovery-owned');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'recovery-owned');
  const ticket = integratedTicket('SQ-RECOVERY-OWNED', 'recovery-owned', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/link', target);
  recordedDependencyLink(ticket, worktree, 'node_modules/link', target);
  try {
    const result = worktrees.reclaimUnclaimedDispatchWorktree(repository, ticket.dispatch);

    assert.equal(result.reclaimed, true);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'recovery-owned');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep prunes expired quarantine entries and preserves live agents', async () => {
  const { repository } = repositoryFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-recovery-retention-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  const previousAge = process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS;
  process.env.SIDEQUEST_HOME = home;
  process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS = String(24 * 60 * 60 * 1000);
  const timestamp = (ageMs: number) => new Date(Date.now() - ageMs).toISOString().replace(/[:.]/g, '-');
  const quarantineRoot = path.join(home, 'worktree-quarantine');
  const createEntry = (name: string) => {
    const entry = path.join(quarantineRoot, name);
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'preserved.txt'), 'preserved\n');
    return entry;
  };
  const old = createEntry(`agent-a-${timestamp(48 * 60 * 60 * 1000)}`);
  const middle = createEntry(`agent-a-${timestamp(3 * 60 * 60 * 1000)}`);
  const recent = createEntry(`agent-a-${timestamp(2 * 60 * 60 * 1000)}`);
  const newest = createEntry(`agent-a-${timestamp(60 * 60 * 1000)}`);
  const oldQuarantine = createEntry(`agent-b-${timestamp(48 * 60 * 60 * 1000)}`);
  const liveQuarantine = createEntry(`agent-live-${timestamp(48 * 60 * 60 * 1000)}`);
  const sourceWorktree = path.join(home, 'agent-b-source');
  fs.mkdirSync(sourceWorktree, { recursive: true });
  fs.writeFileSync(path.join(home, 'worktree-sweep-failures.json'), JSON.stringify({
    [worktrees.canonicalPath(sourceWorktree)]: { fingerprint: 'failed', attempts: 1, quarantinedPath: oldQuarantine },
  }));
  const liveTicket = { claimLive: true, dispatch: { agentId: 'live' } };
  try {
    const dryRun = await worktrees.sweep(repository, [liveTicket], { execute: false, integrationTarget, includeStoreUsage: true });
    assert.equal(dryRun.recovery.quarantine.entries.filter((entry: any) => entry.action === 'remove').length, 2);
    assert.equal(dryRun.recovery.quarantine.entries.find((entry: any) => entry.path === liveQuarantine).reason, 'live_claim');
    assert.equal(dryRun.storage.quarantine.bytes > 0, true);

    const result = await worktrees.sweep(repository, [liveTicket], { execute: true, integrationTarget, includeStoreUsage: true });
    assert.equal(result.counts.removedQuarantineEntries, 2);
    assert.equal(result.counts.reclaimedBytes > 0, true);
    assert.equal(fs.existsSync(old), false);
    // Was `assert.equal(fs.existsSync(middle), false)`, when the per-agent cap deleted a
    // within-retention entry as the fourth for agent-a. Retention is age alone now (SQ-2952).
    assert.equal(fs.existsSync(middle), true);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(newest), true);
    assert.equal(fs.existsSync(oldQuarantine), false);
    assert.equal(fs.existsSync(liveQuarantine), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'worktree-sweep-failures.json'), 'utf8')), {});
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    if (previousAge == null) delete process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS;
    else process.env.SIDEQUEST_TEST_WORKTREE_RECOVERY_RETENTION_AGE_MS = previousAge;
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The reviewer's retention probe, at the shipped defaults: four entries for one agent, none of them
// 14 days old, all of them kept. The per-agent cap used to delete the 4-day-old one (SQ-2952).
test('retention keeps every quarantine entry younger than fourteen days regardless of count', async () => {
  const { repository } = repositoryFixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-retention-age-only-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  const timestamp = (ageMs: number) => new Date(Date.now() - ageMs).toISOString().replace(/[:.]/g, '-');
  const day = 24 * 60 * 60 * 1000;
  const createEntry = (ageDays: number) => {
    const entry = path.join(home, 'worktree-quarantine', `agent-crowded-${timestamp(ageDays * day)}`);
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'unfinished.txt'), `aged ${ageDays} days\n`);
    return entry;
  };
  const withinRetention = [1, 2, 3, 4].map(createEntry);
  const expired = createEntry(15);
  try {
    const result = await worktrees.sweep(repository, [], { execute: true, integrationTarget });
    const reasonFor = (entry: string) => result.recovery.quarantine.entries.find((candidate: any) => candidate.path === entry).reason;

    assert.equal(result.counts.removedQuarantineEntries, 1);
    for (const entry of withinRetention) {
      assert.equal(fs.existsSync(entry), true, `${entry} is younger than the retention age`);
      assert.equal(reasonFor(entry), 'within_retention');
    }
    assert.equal(fs.existsSync(expired), false);
    assert.equal(reasonFor(expired), 'retention_age');
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('quarantine keeps ignored build output and dependency directories', async () => {
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
    assert.equal(fs.existsSync(path.join(result.destination, 'node_modules')), true);
    assert.equal(fs.existsSync(path.join(result.destination, '.venv')), true);
    assert.equal(fs.existsSync(path.join(result.destination, 'dist')), true);
    assert.equal(fs.existsSync(path.join(result.destination, 'tracked.txt')), true);
  } finally {
    if (previousHome == null) delete process.env.SIDEQUEST_HOME;
    else process.env.SIDEQUEST_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function commitInWorktree(worktree: string, name: string): void {
  fs.writeFileSync(path.join(worktree, `${name}.txt`), `${name}\n`);
  git(worktree, ['add', `${name}.txt`]);
  git(worktree, ['commit', '-m', `${name} change`]);
}

const localMainTarget = { upstream: 'main', branch: 'main' };

// Reclaim class (b): clean, but the branch carries commits the integration branch
// does not have. The worktree goes, the branch stays, and the report names it.
test('sweep reclaims a clean worktree with unique commits and keeps its branch', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'unique-commits', false);
  commitInWorktree(worktree, 'unique');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [], { execute: true, minAgeMs: 3 * 60 * 60 * 1000, integrationTarget: localMainTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.equal(entry.reason, 'commits_on_branch');
    assert.equal(fs.existsSync(worktree), false);
    assert.deepEqual(result.retainedBranches.map((retained: any) => retained.branch), ['worktree-agent-unique-commits']);
    assert.equal(result.counts.deletedBranches, 0);
    assert.match(git(repository, ['branch', '--list', 'worktree-agent-unique-commits']), /worktree-agent-unique-commits/);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

// Reclaim class (c): tracked changes keep the worktree, unchanged by SQ-2924.
test('sweep keeps a settled worktree that still has tracked changes', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'tracked', false);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'edited in the worktree\n');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [], { execute: true, minAgeMs: 3 * 60 * 60 * 1000, integrationTarget: localMainTarget });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'tracked_changes');
    assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'edited in the worktree\n');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function treeFingerprint(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const pathname = path.join(directory, entry.name);
      const relativePath = path.relative(root, pathname).split(path.sep).join('/');
      const status = fs.lstatSync(pathname);
      if (status.isSymbolicLink()) {
        entries.push(`link ${relativePath} ${fs.readlinkSync(pathname)}`);
      } else if (status.isDirectory()) {
        entries.push(`directory ${relativePath}`);
        visit(pathname);
      } else {
        entries.push('file ' + relativePath + ' ' + createHash('sha256').update(fs.readFileSync(pathname)).digest('hex'));
      }
    }
  };
  visit(root);
  return entries;
}

test('sweep quarantines an untracked tree whole after seven days', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-untracked-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'untracked-only', false);
  const nested = path.join(worktree, 'nested');
  const externalTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-untracked-link-target-'));
  const externalSentinel = path.join(externalTarget, 'sentinel.txt');
  fs.writeFileSync(path.join(worktree, 'binary.bin'), Buffer.alloc(2 * 1024 * 1024, 0xa5));
  fs.writeFileSync(path.join(worktree, 'trailing.txt'), 'first line\nlast line   ');
  fs.mkdirSync(path.join(worktree, 'empty-directory'));
  fs.mkdirSync(nested);
  git(nested, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested repository\n');
  fs.writeFileSync(externalSentinel, 'outside the worktree\n');
  fs.symlinkSync(externalTarget, path.join(worktree, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = treeFingerprint(worktree);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [], {
      execute: true,
      minAgeMs: 3 * 60 * 60 * 1000,
      notIntegratedSalvageAgeMs: 7 * 24 * 60 * 60 * 1000,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    const quarantine = result.quarantined.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    const ledger = JSON.parse(fs.readFileSync(path.join(String(process.env.SIDEQUEST_HOME), 'worktree-sweep-failures.json'), 'utf8'));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(fs.existsSync(worktree), false);
    assert.ok(quarantine.destination);
    assert.deepEqual(treeFingerprint(quarantine.destination), before);
    assert.equal(fs.readFileSync(externalSentinel, 'utf8'), 'outside the worktree\n');
    assert.equal(ledger[worktrees.canonicalPath(worktree)].quarantinedPath, quarantine.destination);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
    fs.rmSync(externalTarget, { recursive: true, force: true });
  }
});

// The reviewer's cleanNestedRepository probe: `git status --porcelain` says clean, so the sweep used
// to hand the checkout to `git worktree remove`, which deleted the gitignored nested repository with
// it (SQ-2952 CRITICAL 1). Ignored content is data at risk, so the tree is quarantined whole.
test('sweep quarantines a clean tree whose gitignored nested repository holds commits', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-clean-nested-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'clean-nested');
  const ticket = integratedTicket('SQ-CLEAN-NESTED', 'clean-nested', worktree, baseCommit);
  const nested = path.join(worktree, 'nested-clean');
  fs.mkdirSync(nested);
  git(nested, ['init', '-b', 'main']);
  git(nested, ['config', 'user.name', 'Sidequest Test']);
  git(nested, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(nested, 'unfinished.txt'), 'work only this nested repository has\n');
  git(nested, ['add', '.']);
  git(nested, ['commit', '-m', 'nested work']);
  const nestedHead = git(nested, ['rev-parse', 'HEAD']);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    assert.equal(git(worktree, ['status', '--porcelain']), '', 'the checkout is clean by the read that lost the nested repository');

    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(entry.clean, false);
    assert.equal(fs.existsSync(worktree), false);
    assert.deepEqual(result.removed, []);
    assert.equal(git(path.join(entry.quarantine, 'nested-clean'), ['rev-parse', 'HEAD']), nestedHead);
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'nested-clean', 'unfinished.txt'), 'utf8'), 'work only this nested repository has\n');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

test('sweep removes a clean tree whose only ignored content is an installed node_modules', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-clean-node-modules-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'clean-node-modules');
  const ticket = integratedTicket('SQ-CLEAN-NODE-MODULES', 'clean-node-modules', worktree, baseCommit);
  fs.mkdirSync(path.join(worktree, 'node_modules', 'installed'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'node_modules', 'installed', 'index.js'), 'module.exports = 1;\n');
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    assert.match(git(worktree, ['status', '--porcelain', '--ignored']), /^!! node_modules\//m, 'the installed cache is ignored content');

    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.equal(entry.clean, true);
    assert.equal(fs.existsSync(worktree), false);
    assert.deepEqual(result.quarantined, [], 'a tree still clean at the destination is deleted, not parked');
    assert.deepEqual(fs.readdirSync(quarantineDir), []);
    assert.doesNotMatch(git(repository, ['worktree', 'list', '--porcelain']), /agent-clean-node-modules/, 'the registration is pruned');
    assert.deepEqual(result.deletedBranches, ['worktree-agent-clean-node-modules'], 'branch handling runs once the moved tree is actually deleted');
    assert.deepEqual(result.failures, []);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

test('sweep quarantines a clean tree whose node_modules hides a nested repository', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-node-modules-nested-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'node-modules-nested');
  const ticket = integratedTicket('SQ-NODE-MODULES-NESTED', 'node-modules-nested', worktree, baseCommit);
  const nested = path.join(worktree, 'node_modules', 'linked-package');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-b', 'main']);
  git(nested, ['config', 'user.name', 'Sidequest Test']);
  git(nested, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(nested, 'unfinished.txt'), 'work only this nested repository has\n');
  git(nested, ['add', '.']);
  git(nested, ['commit', '-m', 'nested work']);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'node_modules', 'linked-package', 'unfinished.txt'), 'utf8'), 'work only this nested repository has\n');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

test('sweep quarantines a clean tree holding an installed node_modules next to other ignored content', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-node-modules-plus-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'node-modules-plus');
  const ticket = integratedTicket('SQ-NODE-MODULES-PLUS', 'node-modules-plus', worktree, baseCommit);
  fs.mkdirSync(path.join(worktree, 'node_modules', 'installed'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'node_modules', 'installed', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(worktree, 'nested-clean'));
  fs.writeFileSync(path.join(worktree, 'nested-clean', 'notes.txt'), 'ignored, and only here\n');
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], { execute: true, minAgeMs: 0, integrationTarget, quarantineDir });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'untracked_quarantined');
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'nested-clean', 'notes.txt'), 'utf8'), 'ignored, and only here\n');
    assert.equal(fs.existsSync(path.join(entry.quarantine, 'node_modules', 'installed', 'index.js')), true, 'the cache travels with the tree');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Everything below runs at the seam the reviewer used: the sweep classifies from one status
// snapshot and acts on it later, so the progress callback at `phase: 'sweeping'` stands in for any
// concurrent writer in that window. The tree is already classified for deletion when the callback
// runs (SQ-2958).
function whenSweepStartsActing(action: () => void) {
  let fired = false;
  return (progress: any) => {
    if (fired || progress.phase !== 'sweeping') return;
    fired = true;
    action();
  };
}

function nestedRepositoryWithCommit(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Sidequest Test']);
  git(directory, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(directory, 'unfinished.txt'), 'work only this nested repository has\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'nested work']);
  return git(directory, ['rev-parse', 'HEAD']);
}

// The reviewer's probe: a gitignored nested repository committed after classification was deleted
// with the tree, losing its only commit. The moved tree is read again before anything is deleted.
test('sweep parks a tree whose gitignored nested repository was committed while the sweep ran', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-late-nested-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'late-nested');
  const ticket = integratedTicket('SQ-LATE-NESTED', 'late-nested', worktree, baseCommit);
  let nestedHead = '';
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => {
        nestedHead = nestedRepositoryWithCommit(path.join(worktree, 'nested-clean'));
      }),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'late_content_quarantined');
    assert.deepEqual(result.removed, []);
    assert.equal(git(path.join(entry.quarantine, 'nested-clean'), ['rev-parse', 'HEAD']), nestedHead);
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'nested-clean', 'unfinished.txt'), 'utf8'), 'work only this nested repository has\n');
    const quarantine = result.quarantined.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    assert.match(quarantine.message, /^classified ticket_done, but /, 'the tree was classified for deletion before the nested repository existed');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

test('sweep parks a tree that gained an untracked file while the sweep ran', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-late-untracked-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'late-untracked');
  const ticket = integratedTicket('SQ-LATE-UNTRACKED', 'late-untracked', worktree, baseCommit);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => {
        fs.writeFileSync(path.join(worktree, 'late.txt'), 'written after the classification\n');
      }),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'late_content_quarantined');
    assert.deepEqual(result.removed, []);
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'late.txt'), 'utf8'), 'written after the classification\n');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Tracked work committed in the window leaves the status clean, so only the commit the
// classification recorded can tell the sweep that this is no longer the tree it decided about.
test('sweep parks a tree that was committed to while the sweep ran', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-late-commit-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'late-commit');
  const ticket = integratedTicket('SQ-LATE-COMMIT', 'late-commit', worktree, baseCommit);
  let lateCommit = '';
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => {
        commitInWorktree(worktree, 'late');
        lateCommit = git(worktree, ['rev-parse', 'HEAD']);
      }),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.notEqual(lateCommit, entry.head);
    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'late_content_quarantined');
    assert.deepEqual(result.removed, []);
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'late.txt'), 'utf8'), 'late\n');
    assert.equal(git(repository, ['rev-parse', 'worktree-agent-late-commit']), lateCommit, 'the branch still carries the late commit');
    assert.deepEqual(result.deletedBranches, [], 'branch deletion runs only after a tree is actually deleted');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// A junction the sweep did not provision is data at risk wherever it turns up, including in the
// window between classification and deletion. Nothing is unlinked and nothing is deleted.
test('sweep parks a tree that gained an unrecorded junction while the sweep ran', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-late-link-quarantine-'));
  const recordedTarget = dependencyTarget(repository, 'recorded');
  const foreignTarget = dependencyTarget(repository, 'foreign');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'late-link');
  const ticket = integratedTicket('SQ-LATE-LINK', 'late-link', worktree, baseCommit);
  createDependencyLink(worktree, 'node_modules/recorded', recordedTarget);
  recordedDependencyLink(ticket, worktree, 'node_modules/recorded', recordedTarget);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => {
        createDependencyLink(worktree, 'node_modules/foreign', foreignTarget);
      }),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'late_content_quarantined');
    assert.deepEqual(result.removed, []);
    assert.equal(fs.lstatSync(path.join(entry.quarantine, 'node_modules', 'foreign')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(entry.quarantine, 'node_modules', 'recorded')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(foreignTarget, 'sentinel.txt'), 'utf8'), 'foreign');
    assert.equal(fs.readFileSync(path.join(recordedTarget, 'sentinel.txt'), 'utf8'), 'recorded');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// The remove path used to unlink the live tree's links before it knew removal could succeed, so a
// refused removal and a failed fallback left a retained tree without them (SQ-2958). The move is now
// the first thing that happens, so a move that cannot happen changes nothing at all.
test('a failed quarantine move leaves a reclaimable tree and its recorded link untouched', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const unusableQuarantineRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-reclaim-move-failure-')), 'not-a-directory');
  fs.writeFileSync(unusableQuarantineRoot, 'the quarantine root cannot be created here\n');
  const target = dependencyTarget(repository, 'reclaim');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'reclaim-move-failure');
  const ticket = integratedTicket('SQ-RECLAIM-MOVE-FAILURE', 'reclaim-move-failure', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/recorded', target);
  recordedDependencyLink(ticket, worktree, 'node_modules/recorded', target);
  const recordsBefore = JSON.stringify(ticket.dispatch.ownedDependencyLinks);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir: unusableQuarantineRoot,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'quarantine_failed');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(link, 'sentinel.txt'), 'utf8'), 'reclaim');
    assert.equal(JSON.stringify(ticket.dispatch.ownedDependencyLinks), recordsBefore);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.quarantined, []);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(path.dirname(unusableQuarantineRoot), { recursive: true, force: true });
  }
});

// A quarantine move that fails must leave the source record-for-record, not just byte-for-byte: the
// links used to be released first, so a cross-volume rename failure kept the tree without them
// (SQ-2952 MEDIUM 2). The injection here is a quarantine root that is a file, so the move cannot
// happen on any platform; EXDEV needs a second volume no fixture can assume.
test('a failed quarantine move leaves the recorded dependency link and its record intact', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const unusableQuarantineRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-quarantine-failure-')), 'not-a-directory');
  fs.writeFileSync(unusableQuarantineRoot, 'the quarantine root cannot be created here\n');
  const target = dependencyTarget(repository, 'retained');
  const worktree = createAgentWorktree(repository, worktreeRoot, 'quarantine-failure');
  const ticket = integratedTicket('SQ-QUARANTINE-FAILURE', 'quarantine-failure', worktree, baseCommit);
  const link = createDependencyLink(worktree, 'node_modules/recorded', target);
  recordedDependencyLink(ticket, worktree, 'node_modules/recorded', target);
  fs.writeFileSync(path.join(worktree, 'unfinished.txt'), 'keep this work\n');
  const recordsBefore = JSON.stringify(ticket.dispatch.ownedDependencyLinks);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir: unusableQuarantineRoot,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'quarantine_failed');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(link, 'sentinel.txt'), 'utf8'), 'retained');
    assert.equal(fs.readFileSync(path.join(worktree, 'unfinished.txt'), 'utf8'), 'keep this work\n');
    assert.equal(JSON.stringify(ticket.dispatch.ownedDependencyLinks), recordsBefore);
    assert.deepEqual(result.quarantined, []);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(path.dirname(unusableQuarantineRoot), { recursive: true, force: true });
  }
});

test('sweep falls back to the repository default when the integration ref is unavailable', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'no-integration-ref', false);
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [], { execute: false, minAgeMs: 3 * 60 * 60 * 1000, integrationTarget: null });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(result.upstreamFallback, true);
    assert.equal(result.upstream, 'main');
    assert.equal(entry.upstreamFallback, true);
    assert.equal(entry.action, 'remove');
    assert.equal(entry.reason, 'branch_reachable');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep removes an empty stray worktree home directory and reports the rest', async () => {
  const { repository } = repositoryFixture();
  const home = path.join(String(process.env.SIDEQUEST_HOME), 'worktrees');
  const empty = path.join(home, 'agent-stray-00000000');
  const populated = path.join(home, 'sq9999-recovery-11111111');
  fs.mkdirSync(empty, { recursive: true });
  fs.mkdirSync(populated, { recursive: true });
  fs.writeFileSync(path.join(populated, 'leftover.txt'), 'not a git worktree\n');
  try {
    const result = await worktrees.sweep(repository, [], { execute: true, minAgeMs: 0, integrationTarget: localMainTarget });
    const strayFor = (pathname: string) => result.strayDirectories.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(pathname));

    assert.equal(strayFor(empty).action, 'remove');
    assert.equal(strayFor(empty).reason, 'stray_empty');
    assert.equal(fs.existsSync(empty), false);
    assert.equal(strayFor(populated).action, 'keep');
    assert.equal(strayFor(populated).reason, 'stray_directory');
    assert.equal(result.counts.removedStrayDirectories, 1);
  } finally {
    fs.rmSync(populated, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

// A machine that only ever opens one project still has to drain the rest, so the
// sweep can walk every registered project in one deterministic run (SQ-2924).
test('worktrees sweep --all-projects walks every registered project in slug order', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-all-projects-'));
  const previousHome = String(process.env.SIDEQUEST_HOME);
  process.env.SIDEQUEST_HOME = home;
  const store = require('../src/lib/store.ts');
  const { cmdWorktrees } = require('../src/bin/sidequest-cmd-collaboration.ts');
  const namedRepository = (name: string) => {
    const repository = path.join(home, 'repositories', name);
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.name', 'Sidequest Test']);
    git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'base']);
    store.ensureProject(repository);
    return repository;
  };
  const alpha = namedRepository('alpha');
  const zulu = namedRepository('zulu');
  const alphaWorktree = createAgentWorktree(alpha, path.join(alpha, '.claude', 'worktrees'), 'alpha-stale', false);
  const zuluWorktree = createAgentWorktree(zulu, path.join(zulu, '.claude', 'worktrees'), 'zulu-stale', false);
  const printed: string[] = [];
  const previousLog = console.log;
  console.log = (...parts: unknown[]) => { printed.push(parts.map(String).join(' ')); };
  try {
    await cmdWorktrees({ yes: true, 'all-projects': true, 'min-age-hours': 0, project: alpha }, ['sweep']);
    console.log = previousLog;
    const output = printed.join('\n');
    const alphaHeading = output.indexOf('worktrees sweep: executed for alpha');
    const zuluHeading = output.indexOf('worktrees sweep: executed for zulu');

    assert.ok(alphaHeading >= 0, `alpha was swept:\n${output}`);
    assert.ok(zuluHeading > alphaHeading, `zulu was swept after alpha:\n${output}`);
    assert.equal(fs.existsSync(alphaWorktree), false);
    assert.equal(fs.existsSync(zuluWorktree), false);
  } finally {
    console.log = previousLog;
    process.exitCode = 0;
    process.env.SIDEQUEST_HOME = previousHome;
    // The board keeps its SQLite handle open for the life of the process, so the
    // fixture home cannot always be unlinked here.
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});


test('sweep keeps a unique commit when an upstream name is ambiguous', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'ambiguous-upstream', false);
  commitInWorktree(worktree, 'unique-ambiguous');
  const uniqueCommit = git(worktree, ['rev-parse', 'HEAD']);
  const baseCommit = git(repository, ['rev-parse', 'main']);
  git(repository, ['update-ref', 'refs/heads/origin/main', baseCommit]);
  git(repository, ['update-ref', 'refs/remotes/origin/main', baseCommit]);
  try {
    const result = await worktrees.sweep(repository, [], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: { upstream: 'origin/main', branch: 'main' },
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'upstream_ambiguous');
    git(repository, ['reflog', 'expire', '--expire=now', '--all']);
    git(repository, ['gc', '--prune=now']);
    assert.equal(git(repository, ['cat-file', '-e', `${uniqueCommit}^{commit}`]), '');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    git(repository, ['update-ref', '-d', 'refs/heads/origin/main']);
    git(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep keeps a young done worktree with untracked work', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'young-done');
  const ticket = integratedTicket('SQ-YOUNG-DONE', 'young-done', worktree, baseCommit);
  fs.writeFileSync(path.join(worktree, 'unfinished.txt'), 'young work\n');
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 3 * 60 * 60 * 1000,
      integrationTarget,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'too_young');
    assert.equal(fs.existsSync(worktree), true);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('sweep keeps tracked edits on a branch with unique commits', async () => {
  const { repository, worktreeRoot } = repositoryFixture();
  const worktree = createAgentWorktree(repository, worktreeRoot, 'tracked-unique', false);
  commitInWorktree(worktree, 'unique-tracked');
  fs.writeFileSync(path.join(worktree, 'README.md'), 'uncommitted tracked edit\n');
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [], {
      execute: true,
      minAgeMs: 3 * 60 * 60 * 1000,
      integrationTarget: localMainTarget,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'tracked_changes');
    assert.equal(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'uncommitted tracked edit\n');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});


test('sweep removes an empty unregistered worktree directory directly', async () => {
  const { repository } = repositoryFixture();
  const orphan = path.join(worktrees.worktreeRoot(repository), 'agent-empty-orphan');
  fs.mkdirSync(orphan, { recursive: true });
  try {
    const result = await worktrees.sweep(repository, [], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(orphan));

    assert.equal(entry.action, 'remove');
    assert.equal(entry.reason, 'orphan_directory');
    assert.equal(result.removed.includes(orphan), true);
    assert.equal(result.quarantined.some((candidate: any) => candidate.path === orphan), false);
    assert.equal(fs.existsSync(orphan), false);
  } finally {
    fs.rmSync(orphan, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
