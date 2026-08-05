import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
const commitScope = require('../lib/commit-scope.js');
const { makeCliRunner } = require('./_helpers.js');
const worktrees = require('../lib/worktrees.js');

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

function windowsShortPath(pathname: string) {
  if (process.platform !== 'win32') return pathname;
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
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

function dispatchedTicket(agentId: string, project: string = slug, files = ['fixture.txt']) {
  const ticket = store.createTicket(project, {
    title: `worktree fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture that binds a dispatch agent to an isolated worktree.',
    files,
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
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, commit], worktree);
  const target = store.integrationTarget(project);
  const range = commitScope.submissionRange(worktree, {
    commit,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.submitTicket(project, ticket.ref, 'fixture-worker', { commit, gitRef, range, worktree }).ok, true);
}

void slug;

test('worktree sweep matches a submitted 8.3 alias', { skip: process.platform !== 'win32' }, async (context: any) => {
  const worktree = agentWorktree('8dot3-alias');
  try {
    const alias = windowsShortPath(worktree);
    if (alias.toLowerCase() === worktree.toLowerCase()) {
      context.skip('8.3 aliases are unavailable on this volume');
      return;
    }
    const result = await worktrees.classifyWorktree(PROJECT, [{
      ref: 'SQ-8DOT3', status: 'doing', submission: { worktree: alias },
    }], { worktree }, path.join(PROJECT, 'current'), 0, 'origin/main');
    assert.equal(result.reason, 'active_ticket');
  } finally {
    git(['worktree', 'remove', worktree]);
  }
});

test('worktree sweep caps orphan branch candidates', async () => {
  const branches = ['worktree-agent-000-cap-a', 'worktree-agent-000-cap-b', 'worktree-agent-000-cap-c'];
  for (const branch of branches) git(['branch', branch]);
  const result = await worktrees.sweep(PROJECT, [], { maxCandidates: 2, upstream: 'origin/main' });
  assert.deepEqual(result.orphanBranches.map((entry: any) => entry.branch), branches.slice(0, 2));
});

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
  assert.equal(entryFor(dryRun, equivalentFresh).reason, 'too_young');
  assert.equal(entryFor(dryRun, equivalentFresh).action, 'keep');
  assert.equal(entryFor(dryRun, unmergedOld).reason, 'not_integrated');
  assert.equal(entryFor(dryRun, dirtyOld).reason, 'branch_reachable');
  assert.equal(entryFor(dryRun, dirtyOld).action, 'remove');
  assert.ok(fs.existsSync(equivalentOld), 'dry run does not remove worktrees');

  const applied = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.deepEqual(
    applied.removed.map((entry: any) => path.resolve(entry)).sort(),
    [path.resolve(equivalentOld), path.resolve(dirtyOld)].sort()
  );
  assert.deepEqual(applied.deletedBranches.sort(), [branchName('equivalent-old'), branchName('dirty-old')].sort());
  assert.equal(applied.counts.removedWorktrees, 2);
  assert.ok(applied.counts.backedUpWorktrees >= 1);
  assert.equal(applied.counts.deletedBranches, 2);
  assert.ok(!fs.existsSync(equivalentOld));
  assert.ok(!branchExists(branchName('equivalent-old')));
  assert.ok(fs.existsSync(equivalentFresh));
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
  const ticket = dispatchedTicket(agentId, slug, ['integrated-close.txt']);
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
  const commit = makeCommit(worktree, 'dirty-completed.txt');
  const ticket = dispatchedTicket(agentId, slug, ['dirty-completed.txt']);
  submitFixture(ticket, worktree, commit);
  integrate(commit);
  fs.writeFileSync(path.join(worktree, 'recovery.txt'), 'recover this diff\n');

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
  assert.equal(store.claimTicket(foreignSlug, ticket.ref, 'fixture-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.completeTicket(foreignSlug, ticket.ref, 'fixture-worker', { source: 'mcp' }).ok, true);

  const swept = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.equal(entryFor(swept, worktree).reason, 'ticket_done');
  assert.ok(!fs.existsSync(worktree));
});

// SQ-826. A ticket reaches a final board state the moment a closure or an
// archive sweep runs, but its executor can still be alive in that tree; only
// the claim knows. Reaping it deletes a live agent's working directory out from
// under it.
test('a finalized ticket that still holds a live claim keeps its worktree', () => {
  const worktree = agentWorktree('live-claim');
  const ticket = dispatchedTicket('live-claim');
  assert.equal(store.claimTicket(slug, ticket.ref, 'live-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.archiveTicket(slug, ticket.ref).ok, true);
  makeOld(worktree);

  const swept = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  const entry = entryFor(swept, worktree);
  assert.equal(entry.reason, 'live_claim');
  assert.equal(entry.action, 'keep');
  assert.ok(fs.existsSync(worktree), 'a live agent keeps its working directory');

  assert.equal(store.releaseTicket(slug, ticket.ref, 'live-worker').ok, true);
  const after = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.equal(entryFor(after, worktree).reason, 'ticket_archived');
  assert.ok(!fs.existsSync(worktree), 'the released tree is collected on the next sweep');
});

test('worktree sweep uses the configured feature integration branch for patch equivalence', () => {
  const worktree = agentWorktree('feature-target');
  const commit = makeCommit(worktree, 'feature-target.txt');

  git(['checkout', '-f', '-B', 'feat/worktree-target', 'origin/main']);
  git(['cherry-pick', commit]);
  git(['push', '-f', '-u', 'origin', 'feat/worktree-target']);
  store.setBoardConfig(slug, { integrationMode: 'remote', integrationBranch: 'feat/worktree-target' });
  makeOld(worktree);

  const swept = cliJson(['worktrees', 'sweep', '--dry-run', '--json']);
  const entry = entryFor(swept, worktree);
  assert.equal(entry.patchEquivalent, true);
  assert.equal(entry.action, 'remove');
  assert.ok(['branch_reachable', 'patch_equivalent'].includes(entry.reason));
});

test('worktree sweep reclaims old unregistered directories and backs up contents', () => {
  const empty = path.join(WORKTREES, 'pub-empty-orphan');
  const dirty = path.join(WORKTREES, 'pub-dirty-orphan');
  fs.mkdirSync(empty);
  fs.mkdirSync(dirty);
  fs.writeFileSync(path.join(dirty, 'recovery.txt'), 'preserve this\n');
  makeOld(empty);
  makeOld(dirty);

  const dryRun = cliJson(['worktrees', 'sweep', '--dry-run', '--json']);
  assert.equal(entryFor(dryRun, empty).reason, 'orphan_directory');
  assert.equal(entryFor(dryRun, dirty).clean, false);

  const applied = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.ok(applied.removed.includes(empty));
  assert.ok(applied.removed.includes(dirty));
  const backup = applied.backups.find((entry: string) => entry.includes('pub-dirty-orphan'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(backup, 'contents', 'recovery.txt'), 'utf8'), 'preserve this\n');
  assert.ok(!fs.existsSync(empty));
  assert.ok(!fs.existsSync(dirty));
});
