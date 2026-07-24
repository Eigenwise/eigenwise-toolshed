'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const { makeCliRunner } = require('./_helpers.js');

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-project-'));
const REMOTE = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-remote-'));
const WORKTREES = path.join(PROJECT, '.claude', 'worktrees');
const OLD = new Date(Date.now() - 4 * 60 * 60 * 1000);

function git(args: any, cwd?: any) {
  return execFileSync('git', args, { cwd: cwd || PROJECT, encoding: 'utf8', windowsHide: true }).trim();
}

function branchName(name: any) {
  return `worktree-agent-${name}`;
}

function agentWorktree(name: any) {
  const dir = path.join(WORKTREES, `agent-${name}`);
  git(['worktree', 'add', '-b', branchName(name), dir, 'origin/main']);
  return dir;
}

function makeCommit(worktree: any, filename: any) {
  fs.writeFileSync(path.join(worktree, filename), `${filename}\n`);
  git(['add', filename], worktree);
  git(['commit', '-m', `fixture ${filename}`], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

function integrate(commit: any) {
  git(['cherry-pick', commit]);
  git(['push', 'origin', 'main']);
  git(['fetch', 'origin']);
}

function makeOld(worktree: any) {
  fs.utimesSync(worktree, OLD, OLD);
}

function entryFor(result: any, worktree: any) {
  return result.entries.find((entry: any) => path.resolve(entry.path) === path.resolve(worktree));
}

function branchExists(branch: any) {
  return git(['branch', '--list', branch]).split(/\r?\n/).some((line: any) => line.trim().replace(/^[*+]\s+/, '') === branch);
}

git(['init']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.writeFileSync(path.join(PROJECT, 'README.md'), 'worktree fixture\n');
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'main']);
execFileSync('git', ['init', '--bare', REMOTE], { encoding: 'utf8', windowsHide: true });
git(['remote', 'add', 'origin', REMOTE]);
git(['push', '-u', 'origin', 'main']);
fs.mkdirSync(WORKTREES, { recursive: true });

const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT }, { cwd: PROJECT });

function dispatchedTicket(agentId: string, project: string = slug) {
  const ticket = store.createTicket(project, {
    title: `worktree fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture that binds a dispatch agent to an isolated worktree.',
    files: ['fixture.txt'],
  });
  const sessionId = `session-${agentId}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree: false, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  return store.getTicket(project, ticket.ref);
}

function submitFixture(ticket: any, worktree: string, commit: string, project: string = slug) {
  assert.equal(store.claimTicket(project, ticket.ref, 'fixture-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.submitTicket(project, ticket.ref, 'fixture-worker', { commit, worktree }).ok, true);
}

void slug;

test('worktrees sweep removes only clean, patch-equivalent, old agent worktrees', () => {
  const equivalentOld = agentWorktree('equivalent-old');
  integrate(makeCommit(equivalentOld, 'equivalent-old.txt'));
  makeOld(equivalentOld);

  const equivalentFresh = agentWorktree('equivalent-fresh');
  integrate(makeCommit(equivalentFresh, 'equivalent-fresh.txt'));

  const unmergedOld = agentWorktree('unmerged-old');
  makeCommit(unmergedOld, 'unmerged-old.txt');
  makeOld(unmergedOld);

  const dirtyOld = agentWorktree('dirty-old');
  fs.writeFileSync(path.join(dirtyOld, 'dirty.txt'), 'keep me\n');
  makeOld(dirtyOld);

  const dryRun = cliJson(['worktrees', 'sweep', '--dry-run', '--json']);
  assert.equal(dryRun.dryRun, true);
  assert.equal(entryFor(dryRun, equivalentOld).action, 'remove');
  assert.equal(entryFor(dryRun, equivalentOld).patchEquivalent, true);
  assert.ok(['branch_reachable', 'patch_equivalent'].includes(entryFor(dryRun, equivalentOld).reason));
  assert.equal(entryFor(dryRun, equivalentFresh).action, 'remove');
  assert.ok(['branch_reachable', 'patch_equivalent'].includes(entryFor(dryRun, equivalentFresh).reason));
  assert.equal(entryFor(dryRun, unmergedOld).reason, 'not_integrated');
  assert.equal(entryFor(dryRun, dirtyOld).reason, 'branch_reachable');
  assert.equal(entryFor(dryRun, dirtyOld).action, 'remove');
  assert.ok(fs.existsSync(equivalentOld), 'dry run does not remove worktrees');

  const applied = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.deepEqual(
    applied.removed.map((entry: any) => path.resolve(entry)).sort(),
    [path.resolve(equivalentOld), path.resolve(equivalentFresh), path.resolve(dirtyOld)].sort()
  );
  assert.deepEqual(applied.deletedBranches.sort(), [branchName('equivalent-old'), branchName('equivalent-fresh'), branchName('dirty-old')].sort());
  assert.equal(applied.counts.removedWorktrees, 3);
  assert.ok(applied.counts.backedUpWorktrees >= 1);
  assert.equal(applied.counts.deletedBranches, 3);
  assert.ok(!fs.existsSync(equivalentOld));
  assert.ok(!branchExists(branchName('equivalent-old')));
  assert.ok(!fs.existsSync(equivalentFresh));
  assert.ok(fs.existsSync(unmergedOld));
  assert.ok(!fs.existsSync(dirtyOld));
});

test('worktrees sweep prunes only patch-equivalent orphan worktree branches', () => {
  const equivalentOrphan = agentWorktree('orphan-equivalent');
  integrate(makeCommit(equivalentOrphan, 'orphan-equivalent.txt'));
  git(['worktree', 'remove', equivalentOrphan]);

  const unintegratedOrphan = agentWorktree('orphan-unintegrated');
  makeCommit(unintegratedOrphan, 'orphan-unintegrated.txt');
  git(['worktree', 'remove', unintegratedOrphan]);

  const checkedOut = agentWorktree('checked-out-equivalent');
  integrate(makeCommit(checkedOut, 'checked-out-equivalent.txt'));
  fs.writeFileSync(path.join(checkedOut, 'still-running.txt'), 'keep this live worktree\n');
  git(['worktree', 'lock', checkedOut, '--reason', 'live fixture']);

  const dryRun = cliJson(['worktrees', 'sweep', '--dry-run', '--json']);
  const orphan = dryRun.orphanBranches.find((entry: any) => entry.branch === branchName('orphan-equivalent'));
  assert.equal(orphan.action, 'prune');
  assert.equal(orphan.patchEquivalent, true);
  const unintegrated = dryRun.orphanBranches.find((entry: any) => entry.branch === branchName('orphan-unintegrated'));
  assert.equal(unintegrated.action, 'keep');
  assert.equal(unintegrated.patchEquivalent, false);
  assert.equal(dryRun.orphanBranches.some((entry: any) => entry.branch === branchName('checked-out-equivalent')), false);

  const applied = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.deepEqual(applied.prunedOrphanBranches, [branchName('orphan-equivalent')]);
  assert.equal(applied.counts.prunedOrphanBranches, 1);
  assert.ok(!branchExists(branchName('orphan-equivalent')));
  assert.ok(branchExists(branchName('orphan-unintegrated')));
  assert.ok(branchExists(branchName('checked-out-equivalent')));
  assert.ok(fs.existsSync(checkedOut));
});

test('groom-close integration sweeps the dispatched worktree immediately', () => {
  const agentId = 'integrated-close';
  const worktree = agentWorktree(agentId);
  const commit = makeCommit(worktree, 'integrated-close.txt');
  const ticket = dispatchedTicket(agentId);
  submitFixture(ticket, worktree, commit);
  integrate(commit);

  const closed = cliJson(['groom-close', ticket.ref, '--by', 'integrator', '--integration', '--reason', `Integrated ${commit} into main.`, '--json']);
  assert.equal(closed.ok, true);
  assert.deepEqual(closed.worktreeSweep.removed.map((entry: string) => path.resolve(entry)), [path.resolve(worktree)]);
  assert.ok(!fs.existsSync(worktree));
  assert.ok(!branchExists(branchName(agentId)));
});

test('a dirty completed worktree is backed up before removal', () => {
  const agentId = 'dirty-completed';
  const worktree = agentWorktree(agentId);
  const ticket = dispatchedTicket(agentId);
  fs.writeFileSync(path.join(worktree, 'recovery.txt'), 'recover this diff\n');
  submitFixture(ticket, worktree, git(['rev-parse', 'HEAD']));

  const closed = cliJson(['groom-close', ticket.ref, '--by', 'integrator', '--integration', '--reason', 'Integrated the fixture state into main.', '--json']);
  assert.equal(closed.worktreeSweep.backups.length, 1);
  const backup = closed.worktreeSweep.backups[0];
  assert.ok(fs.existsSync(path.join(backup, 'working-tree.patch')));
  assert.match(fs.readFileSync(path.join(backup, 'working-tree.patch'), 'utf8'), /recover this diff/);
  assert.ok(!fs.existsSync(worktree));
});

test('a locked worktree is never removed', () => {
  const worktree = agentWorktree('locked-fixture');
  git(['worktree', 'lock', worktree, '--reason', 'live agent fixture']);

  const swept = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.equal(entryFor(swept, worktree).reason, 'locked');
  assert.ok(fs.existsSync(worktree));
});

test('a worktree for an active ticket is left alone', () => {
  const agentId = 'active-fixture';
  const worktree = agentWorktree(agentId);
  const ticket = dispatchedTicket(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'active-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);

  const swept = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.equal(entryFor(swept, worktree).reason, 'active_ticket');
  assert.ok(fs.existsSync(worktree));
});

test('sweep resolves completed dispatches from another board in the same Sidequest home', () => {
  const foreignProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-foreign-project-'));
  const foreignSlug = store.ensureProject(foreignProject).slug;
  const agentId = 'cross-project-fixture';
  const worktree = agentWorktree(agentId);
  const ticket = dispatchedTicket(agentId, foreignSlug);
  submitFixture(ticket, worktree, git(['rev-parse', 'HEAD']), foreignSlug);
  assert.equal(store.completeTicketAsControlPlane(foreignSlug, ticket.ref, {
    by: 'integrator',
    purpose: 'integration',
    reason: 'Integrated the cross-board fixture state.',
  }).ok, true);

  const swept = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.equal(entryFor(swept, worktree).reason, 'ticket_done');
  assert.ok(!fs.existsSync(worktree));
});
