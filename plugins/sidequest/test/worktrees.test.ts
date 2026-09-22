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
    assert.deepEqual(result.retainedBranches.map((retained: any) => [retained.branch, retained.reason]), [['worktree-agent-unique-commits', 'unique_commits']]);
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
    assert.equal(git(repository, ['branch', '--list', 'worktree-agent-clean-node-modules']), '', 'a tip that never moved is deleted exactly as before');
    assert.deepEqual(result.retainedBranches, []);
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

// Deleting the moved copy's files is a read-then-delete and always will be: the reviewer committed
// into the destination 0.6 ms after its last read, and lost the file AND the branch that was the
// commit's only ref (SQ-2962). The file is gone either way. The commit is not, because the branch
// delete is now a compare-and-delete against the tip read at the destination. This seam is the
// progress report after the moved copy is deleted and the registration pruned: the last public point
// inside that window, and strictly later than the destination reads the reviewer beat, so a ref that
// moves anywhere in the window is caught.
function whenTheMovedCopyIsGone(action: () => void) {
  let fired = false;
  return (progress: any) => {
    if (fired || progress.phase !== 'sweeping' || progress.removed < 1) return;
    fired = true;
    action();
  };
}

test('sweep keeps a branch whose tip moved after the sweep read it at the quarantine destination', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-post-read-commit-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'post-read');
  const ticket = integratedTicket('SQ-POST-READ', 'post-read', worktree, baseCommit);
  const branch = 'worktree-agent-post-read';
  let readTip = '';
  let postReadCommit = '';
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget,
      quarantineDir,
      onProgress: whenTheMovedCopyIsGone(() => {
        readTip = git(repository, ['rev-parse', branch]);
        const tree = git(repository, ['rev-parse', `${branch}^{tree}`]);
        postReadCommit = git(repository, ['commit-tree', tree, '-p', readTip, '-m', 'committed after the sweep read the tip']);
        git(repository, ['update-ref', `refs/heads/${branch}`, postReadCommit, readTip]);
      }),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.equal(entry.reachable, true, 'the classification cleared this branch for deletion');
    assert.equal(fs.existsSync(worktree), false, 'the moved copy is still deleted');
    assert.deepEqual(result.removed, [entry.path]);
    assert.deepEqual(result.deletedBranches, [], 'a ref that moved after the read is never deleted');
    assert.deepEqual(result.retainedBranches, [{ branch, path: entry.path, reason: 'tip_moved' }]);
    assert.equal(entry.retainedBranch, branch);
    assert.equal(git(repository, ['rev-parse', branch]), postReadCommit, 'the branch still points at the post-read commit');
    assert.equal(git(repository, ['rev-parse', `${branch}^`]), readTip, 'and that commit sits on the tip the sweep read');
    assert.deepEqual(result.failures, [], 'a tip that moved is a retained branch, not a failure');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// A ref that something else deleted between the destination read and the compare is neither a silent
// success nor a tip_moved retention: `update-ref -d` refuses and the sweep reports it. Packed here
// because git resolves a packed ref through a different path than a loose one, and the compare has to
// hold for both (SQ-2982).
test('sweep reports a failure when the branch it compared against was deleted outside the sweep', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-external-delete-quarantine-'));
  const worktree = createAgentWorktree(repository, worktreeRoot, 'external-delete');
  const ticket = integratedTicket('SQ-EXTERNAL-DELETE', 'external-delete', worktree, baseCommit);
  const branch = 'worktree-agent-external-delete';
  git(repository, ['pack-refs', '--all']);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      onProgress: whenTheMovedCopyIsGone(() => git(repository, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit])),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.equal(fs.existsSync(worktree), false);
    assert.deepEqual(result.deletedBranches, [], 'the sweep did not delete a ref that was already gone');
    assert.deepEqual(result.retainedBranches, [], 'a ref that vanished is not a retained branch');
    assert.deepEqual(result.failures.map((failure: any) => failure.path), [branch]);
    assert.equal(result.counts.deletedBranches, 0);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// A bound review checks its candidate out detached in a worktree that was provisioned on its own
// branch, and submit pinned that candidate to refs/sidequest/<ref> before the reviewer ever saw it.
// The pin, not the worktree, is what holds the commit and its content, which is why removing a
// detached review checkout is safe and why the branch compare-and-delete has nothing to do here
// (SQ-2982).
test('sweep keeps a pinned review candidate and its unique content after removing the detached worktree', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pinned-review-quarantine-'));
  const { worktree, commit: candidate } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'review', 'candidate');
  const ticket = integratedTicket('SQ-REVIEW', 'review', worktree, baseCommit);
  git(repository, ['update-ref', 'refs/sidequest/SQ-REVIEW', candidate]);
  const containingRefs = () => refsContaining(repository, candidate);
  assert.deepEqual(containingRefs(), ['refs/sidequest/SQ-REVIEW'], 'the pin is the only ref holding the candidate before the sweep');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidateEntry: any) => worktrees.canonicalPath(candidateEntry.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'remove');
    assert.equal(entry.reason, 'ticket_done');
    assert.equal(entry.branch, null, 'a detached review checkout has no branch of its own');
    assert.equal(fs.existsSync(worktree), false, 'the review worktree and its private HEAD are gone');
    assert.deepEqual(containingRefs(), ['refs/sidequest/SQ-REVIEW'], 'the pin still holds the candidate after the sweep');
    assert.equal(git(repository, ['rev-parse', 'refs/sidequest/SQ-REVIEW']), candidate);
    assert.equal(git(repository, ['show', `${candidate}:candidate.txt`]), 'candidate', 'and the content committed only on that candidate is still readable');
    assert.deepEqual(result.retainedBranches, [], 'nothing was retained: no branch of the removed worktree held the candidate');
    assert.deepEqual(result.failures, []);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

function detachedCheckoutHoldingItsOwnCommit(repository: string, worktreeRoot: string, name: string, file: string): { worktree: string; commit: string } {
  const worktree = createAgentWorktree(repository, worktreeRoot, name);
  commitInWorktree(worktree, file);
  const commit = git(worktree, ['rev-parse', 'HEAD']);
  git(worktree, ['checkout', '--detach', commit]);
  // Back to base, so the branch the checkout was provisioned on is not what holds the commit.
  git(repository, ['update-ref', `refs/heads/worktree-agent-${name}`, git(repository, ['rev-parse', 'HEAD']), commit]);
  return { worktree, commit };
}

function refsContaining(repository: string, commit: string): string[] {
  return git(repository, ['for-each-ref', '--contains', commit, '--format=%(refname)']).split(/\r?\n/).filter(Boolean);
}

function registeredWorktreePaths(repository: string): string[] {
  return git(repository, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => worktrees.canonicalPath(line.slice('worktree '.length)));
}

// What the whole retention promise comes down to: git can still reach the commit from the repository,
// without a rescue ref anyone had to invent.
function reachableFromEveryRef(repository: string, commit: string): boolean {
  return git(repository, ['rev-list', '--all']).split(/\r?\n/).includes(commit);
}

// Null rather than a thrown command failure, so a parked tree that lost its registration reads as a
// failed assertion about the HEAD instead of a crashed test.
function headAt(worktree: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The reviewer's probe against the previous candidate: the commit was already on a detached HEAD, in
// no ref at all, before the sweep classified anything. The ticket was done, so the tree was deleted
// and the prune took the private HEAD that was the commit's only root (SQ-2985). A terminal ticket
// says the ticket finished, never that the commit was preserved.
test('sweep keeps a terminal detached checkout whose commit no ref holds', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-existing-quarantine-'));
  const { worktree, commit } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'detached-existing', 'unheld');
  const ticket = integratedTicket('SQ-DETACHED-EXISTING', 'detached-existing', worktree, baseCommit);
  assert.deepEqual(refsContaining(repository, commit), [], 'no ref holds the commit before the sweep classifies the checkout');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.equal(entry.branch, null, 'this is a detached checkout, so no branch could have been retained instead');
    assert.equal(entry.ticket, 'SQ-DETACHED-EXISTING');
    assert.equal(entry.clean, true, 'and it is the clean settled tree the sweep used to delete on ticket status alone');
    assert.deepEqual(result.removed, [], 'nothing was deleted');
    assert.deepEqual(result.quarantined, [], 'and nothing was moved either: the checkout stays where it stands');
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(git(worktree, ['rev-parse', 'HEAD']), commit);
    assert.match(git(repository, ['worktree', 'list', '--porcelain']), new RegExp(`HEAD ${commit}`), 'the private HEAD that roots the commit is still registered');
    assert.equal(git(repository, ['show', `${commit}:unheld.txt`]), 'unheld', 'and the content only that commit has is still readable');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Same commit, same checkout, but the pin that made it safe at classification is deleted in the window
// before the destination read. The tree has already moved by then, so it parks instead of going.
test('sweep parks a detached checkout whose only ref disappeared while the sweep ran', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-unpinned-quarantine-'));
  const { worktree, commit } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'detached-unpinned', 'candidate');
  const ticket = integratedTicket('SQ-DETACHED-UNPINNED', 'detached-unpinned', worktree, baseCommit);
  git(repository, ['update-ref', 'refs/sidequest/SQ-DETACHED-UNPINNED', commit]);
  assert.deepEqual(refsContaining(repository, commit), ['refs/sidequest/SQ-DETACHED-UNPINNED'], 'the pin is what clears this checkout for deletion');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => git(repository, ['update-ref', '-d', 'refs/sidequest/SQ-DETACHED-UNPINNED', commit])),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));
    const quarantine = result.quarantined.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.deepEqual(refsContaining(repository, commit), [], 'the pin was gone before the moved tree was read');
    // Parking used to keep the files and lose the commit: the rename moved the tree out from under its
    // registration, and the prune at the end of the sweep then took the private HEAD that was the
    // commit's last home (SQ-2986). The park repairs the registration to the destination first.
    assert.equal(reachableFromEveryRef(repository, commit), true, 'the exact detached commit is still reachable from the repository after the whole sweep');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(entry.quarantine)), true, 'because the registration was moved to the destination');
    assert.equal(headAt(entry.quarantine), commit, 'so the parked tree still answers for its own HEAD');
    assert.equal(git(repository, ['show', `${commit}:candidate.txt`]), 'candidate', 'and its content is still readable');
    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.deepEqual(result.removed, []);
    assert.match(quarantine.message, /^classified ticket_done, but its detached HEAD /, 'the report says the classification was overruled at the destination');
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'candidate.txt'), 'utf8'), 'candidate\n', 'and the parked tree still holds what that commit carried');
    assert.deepEqual(refsContaining(repository, commit), [], 'no rescue ref was invented to hold the commit');
    assert.deepEqual(result.failures, []);

    // Retention is the one thing that may take it, and it takes the registration with the files rather
    // than leaving an entry pointing at work that is gone.
    const expired = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      recoveryRetentionAgeMs: 0,
    });

    assert.equal(expired.counts.removedQuarantineEntries, 1);
    assert.equal(fs.existsSync(entry.quarantine), false, 'the expired entry is gone');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(entry.quarantine)), false, 'and it left no stranded registration behind');
    assert.equal(reachableFromEveryRef(repository, commit), false, 'the HEAD the park retained went with the work it pointed at');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// A branch this same sweep is about to delete is not independent authority for a detached commit,
// even while it still resolves during classification.
test('sweep keeps a detached checkout held only by a branch it deletes in the same pass', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-sibling-quarantine-'));
  const sibling = createAgentWorktree(repository, worktreeRoot, 'sibling-branch', false);
  commitInWorktree(sibling, 'shared');
  const commit = git(sibling, ['rev-parse', 'HEAD']);
  // main moves first, so the cherry-pick lands the same patch as a different commit: the sibling
  // branch is patch-equivalent and goes, while nothing upstream holds the commit itself.
  commitInWorktree(repository, 'divergence');
  git(repository, ['cherry-pick', commit]);
  // Provisioned after the cherry-pick, so this checkout's own branch sits on main and cannot be what
  // holds the commit it is detached onto.
  const detached = createAgentWorktree(repository, worktreeRoot, 'detached-sibling');
  git(detached, ['checkout', '--detach', commit]);
  const ticket = integratedTicket('SQ-DETACHED-SIBLING', 'detached-sibling', detached, baseCommit);
  assert.deepEqual(refsContaining(repository, commit), ['refs/heads/worktree-agent-sibling-branch'], 'the sibling branch is the only ref holding the commit');
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(detached));
    const siblingEntry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(sibling));

    assert.equal(siblingEntry.reason, 'patch_equivalent');
    assert.deepEqual(result.deletedBranches, ['worktree-agent-sibling-branch'], 'the sibling branch went as it always did');
    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.equal(fs.existsSync(detached), true, 'so the checkout is all that roots the commit, and it stays');
    assert.equal(git(detached, ['rev-parse', 'HEAD']), commit);
  } finally {
    for (const worktree of [sibling, detached]) {
      if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// The probe is the last thing between a detached commit and deletion, so it fails closed: this
// fixture is the pinned review checkout the sweep does reclaim, with the repository's refs made
// unreadable in the instant the probe runs.
test('sweep keeps a pinned detached checkout when the containing-ref probe cannot answer', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-probe-quarantine-'));
  const { worktree, commit } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'detached-probe', 'candidate');
  const ticket = integratedTicket('SQ-DETACHED-PROBE', 'detached-probe', worktree, baseCommit);
  git(repository, ['update-ref', 'refs/sidequest/SQ-DETACHED-PROBE', commit]);
  const packedRefs = path.join(repository, '.git', 'packed-refs');
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      onProgress: (progress: any) => {
        if (progress.phase === 'classifying' && progress.reason) fs.writeFileSync(packedRefs, 'this repository cannot be asked which refs contain a commit\n');
        else if (progress.phase === 'sweeping') fs.rmSync(packedRefs, { force: true });
      },
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.deepEqual(result.removed, [], 'an unanswered probe deletes nothing');
    assert.equal(fs.existsSync(worktree), true);
    assert.deepEqual(refsContaining(repository, commit), ['refs/sidequest/SQ-DETACHED-PROBE'], 'the pin the probe could not read is still there');
  } finally {
    fs.rmSync(packedRefs, { force: true });
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// The pin that cleared the previous candidate's detached commit was a worktree-agent branch with no
// worktree left, which the orphan pass at the end of the same sweep then pruned: the tree went, the
// branch went, and the commit was in no ref at all (SQ-2986). Every branch that pass can take counts
// as this sweep's, not as independent authority.
test('sweep keeps a detached checkout whose only pin is an orphan branch the same sweep prunes', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-orphan-quarantine-'));
  const pinned = createAgentWorktree(repository, worktreeRoot, 'orphan-pin', false);
  commitInWorktree(pinned, 'shared');
  const commit = git(pinned, ['rev-parse', 'HEAD']);
  // main moves first, so the cherry-pick lands the same patch as a different commit: the pin branch is
  // patch-equivalent and the orphan pass takes it, while nothing upstream holds the commit itself.
  commitInWorktree(repository, 'divergence');
  git(repository, ['cherry-pick', commit]);
  // Unregistering the tree leaves the branch behind with no worktree, which is what makes it an orphan
  // rather than one of the sweep's own entries.
  git(repository, ['worktree', 'remove', '--force', pinned]);
  const detached = createAgentWorktree(repository, worktreeRoot, 'detached-orphan');
  git(detached, ['checkout', '--detach', commit]);
  const ticket = integratedTicket('SQ-DETACHED-ORPHAN', 'detached-orphan', detached, baseCommit);
  assert.deepEqual(refsContaining(repository, commit), ['refs/heads/worktree-agent-orphan-pin'], 'an unregistered branch is the only ref holding the commit');
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      maxCandidates: 10,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(detached));

    assert.equal(result.prunedOrphanBranches.includes('worktree-agent-orphan-pin'), true, 'the sweep did delete the branch that was holding the commit');
    assert.deepEqual(refsContaining(repository, commit), [], 'so nothing is left holding the commit but the checkout');
    assert.equal(reachableFromEveryRef(repository, commit), true, 'which is why the exact commit is still reachable from the repository');
    assert.equal(headAt(detached), commit, 'the checkout that roots it is still registered and readable');
    assert.equal(git(repository, ['show', `${commit}:shared.txt`]), 'shared', 'and its content readable');
    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.deepEqual(result.removed, [], 'because the checkout the branch was vouching for was never deleted');
  } finally {
    if (fs.existsSync(detached)) git(repository, ['worktree', 'remove', '--force', detached]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// refs/worktree, refs/bisect and refs/rewritten belong to whichever checkout is being asked, and the
// probe asks the main checkout, so its own per-worktree refs came back as if they were independent
// homes for the commit (SQ-2986). They are not: they are transient and private to that one checkout.
test('sweep keeps a detached checkout held only by the main checkout private ref', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-private-quarantine-'));
  const { worktree, commit } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'detached-private', 'candidate');
  const ticket = integratedTicket('SQ-DETACHED-PRIVATE', 'detached-private', worktree, baseCommit);
  git(repository, ['update-ref', 'refs/worktree/main-private', commit]);
  assert.deepEqual(refsContaining(repository, commit), ['refs/worktree/main-private'], 'the main checkout private ref is the only ref the probe can see holding the commit');
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(reachableFromEveryRef(repository, commit), true, 'the exact commit is still reachable from the repository');
    assert.equal(headAt(worktree), commit, 'because the checkout holding it is still registered');
    assert.equal(git(repository, ['show', `${commit}:candidate.txt`]), 'candidate', 'and its content readable');
    assert.equal(entry.action, 'keep');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.deepEqual(result.removed, [], 'a private ref authorizes nothing');
    assert.deepEqual(result.quarantined, []);
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

// Repair is what carries a park's registration to the destination, so a repair that cannot happen has
// to leave everything standing: the files at the destination, the registration at the path they came
// from, and the private HEAD rooting the commit. Withholding the sweep's prunes is what keeps that
// last one true. Here git cannot rewrite the gitdir record because it is read-only.
test('a park whose registration cannot be repaired keeps the commit and reports the failure', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-repair-quarantine-'));
  const { worktree, commit } = detachedCheckoutHoldingItsOwnCommit(repository, worktreeRoot, 'detached-repair', 'candidate');
  const ticket = integratedTicket('SQ-DETACHED-REPAIR', 'detached-repair', worktree, baseCommit);
  const registration = path.join(repository, '.git', 'worktrees', 'agent-detached-repair');
  git(repository, ['update-ref', 'refs/sidequest/SQ-DETACHED-REPAIR', commit]);
  fs.chmodSync(path.join(registration, 'gitdir'), 0o444);
  const oldTimestamp = new Date(Date.now() - 4 * 60 * 60 * 1000);
  let ordinary: string | null = null;
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const result = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      onProgress: whenSweepStartsActing(() => git(repository, ['update-ref', '-d', 'refs/sidequest/SQ-DETACHED-REPAIR', commit])),
    });
    const entry = result.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.deepEqual(refsContaining(repository, commit), [], 'no rescue ref was invented');
    assert.equal(reachableFromEveryRef(repository, commit), true, 'the exact commit is still reachable from the repository');
    assert.equal(fs.existsSync(registration), true, 'because the registration the tree came from is still there');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(worktree)), true, 'still naming the path it came from, since the failure withheld every prune');
    assert.equal(git(repository, ['show', `${commit}:candidate.txt`]), 'candidate', 'and its content readable');
    assert.equal(fs.readFileSync(path.join(entry.quarantine, 'candidate.txt'), 'utf8'), 'candidate\n', 'the files are at the destination');
    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.reason, 'detached_head_unpinned');
    assert.equal(entry.quarantineRegistrationRepaired, false);
    assert.equal(result.failures.length, 1, 'and the park is reported as a failure rather than a clean quarantine');
    assert.equal(result.failures[0].path, entry.quarantine);
    assert.match(result.failures[0].message, /git worktree repair could not move its registration/);

    ordinary = createAgentWorktree(repository, worktreeRoot, 'ordinary-prune');
    const ordinaryTicket = integratedTicket('SQ-ORDINARY-PRUNE', 'ordinary-prune', ordinary, baseCommit);
    fs.utimesSync(ordinary, oldTimestamp, oldTimestamp);
    const second = await worktrees.sweep(repository, [ticket, ordinaryTicket], {
      execute: true,
      minAgeMs: 0,
      maxCandidates: 1,
      integrationTarget: localMainTarget,
      quarantineDir,
    });

    assert.equal(fs.existsSync(ordinary), false, 'the bounded later sweep can reclaim a different worktree');
    assert.equal(reachableFromEveryRef(repository, commit), true, 'that later sweep still cannot prune the unrepaired park registration');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(worktree)), true, 'the stale registration stays until repair can move it');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(ordinary)), true, 'the unrelated missing registration stays while repair is unresolved');
    assert.match(second.failures.map((failure: any) => failure.message).join('\n'), /metadata pruning is deferred/, 'the later sweep reports why it deferred repository metadata cleanup');

    fs.chmodSync(path.join(registration, 'gitdir'), 0o644);
    const retried = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });

    assert.equal(retried.recovery.quarantine.entries.find((candidate: any) => candidate.path === entry.quarantine).registrationRepaired, true, 'the next invocation retries native repair from the retained recovery entry');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(entry.quarantine)), true, 'successful retry moves the registration to the parked destination');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(worktree)), false, 'safe metadata pruning removes the original missing registration');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(ordinary)), false, 'safe empty cleanup removes the unrelated deferred registration');
    assert.equal(reachableFromEveryRef(repository, commit), true, 'the exact parked commit remains reachable after repair succeeds');

    git(repository, ['worktree', 'add', '-b', 'worktree-agent-ordinary-prune', ordinary, baseCommit]);
    assert.equal(headAt(ordinary), baseCommit, 'the deferred branch and checkout path are usable after metadata cleanup');
    git(repository, ['worktree', 'remove', '--force', ordinary]);
    git(repository, ['branch', '-D', 'worktree-agent-ordinary-prune']);

    const idempotent = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });

    assert.equal(idempotent.entries.length, 0, 'the follow-up has no ordinary candidates');
    assert.deepEqual(idempotent.failures, [], 'safe metadata cleanup is idempotent once every retained park is reconciled');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(entry.quarantine)), true, 'the retained parked worktree stays registered after the idempotent sweep');
  } finally {
    if (fs.existsSync(path.join(registration, 'gitdir'))) fs.chmodSync(path.join(registration, 'gitdir'), 0o644);
    if (ordinary && fs.existsSync(ordinary)) git(repository, ['worktree', 'remove', '--force', ordinary]);
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }
});

test('expiry removes a parked junction without following its external repository', async () => {
  const { repository, baseCommit, worktreeRoot } = repositoryFixture();
  const quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-expiry-link-quarantine-'));
  const externalRepository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-expiry-link-external-'));
  git(externalRepository, ['init', '-b', 'main']);
  git(externalRepository, ['config', 'user.name', 'Sidequest Test']);
  git(externalRepository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(externalRepository, 'sentinel.txt'), 'external repository stays intact\n');
  git(externalRepository, ['add', '.']);
  git(externalRepository, ['commit', '-m', 'external']);
  const externalCommit = git(externalRepository, ['rev-parse', 'HEAD']);
  const worktree = createAgentWorktree(repository, worktreeRoot, 'expiry-link');
  const ticket = integratedTicket('SQ-EXPIRY-LINK', 'expiry-link', worktree, baseCommit);
  createDependencyLink(worktree, 'node_modules/external-repository', externalRepository);
  const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(worktree, oldTimestamp, oldTimestamp);
  try {
    const parked = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      notIntegratedSalvageAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
    });
    const entry = parked.entries.find((candidate: any) => worktrees.canonicalPath(candidate.path) === worktrees.canonicalPath(worktree));

    assert.equal(entry.action, 'quarantine');
    assert.equal(entry.quarantineRegistrationRepaired, true);
    assert.equal(fs.lstatSync(path.join(entry.quarantine, 'node_modules', 'external-repository')).isSymbolicLink(), true);

    const expired = await worktrees.sweep(repository, [ticket], {
      execute: true,
      minAgeMs: 0,
      integrationTarget: localMainTarget,
      quarantineDir,
      recoveryRetentionAgeMs: 0,
    });

    assert.equal(expired.counts.removedQuarantineEntries, 1);
    assert.equal(fs.existsSync(entry.quarantine), false, 'expiry removes the parked directory');
    assert.equal(registeredWorktreePaths(repository).includes(worktrees.canonicalPath(entry.quarantine)), false, 'safe metadata pruning removes the expired registration');
    assert.equal(fs.existsSync(path.join(externalRepository, 'sentinel.txt')), true, 'expiry never follows the junction to the external sentinel');
    assert.equal(fs.readFileSync(path.join(externalRepository, 'sentinel.txt'), 'utf8'), 'external repository stays intact\n', 'expiry preserves the external sentinel content');
    assert.equal(git(externalRepository, ['rev-parse', 'HEAD']), externalCommit, 'expiry leaves the external nested repository commit untouched');
  } finally {
    if (fs.existsSync(worktree)) git(repository, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(quarantineDir, { recursive: true, force: true });
    fs.rmSync(externalRepository, { recursive: true, force: true });
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
