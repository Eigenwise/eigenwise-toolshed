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

function agentWorktree(name: any) {
  const dir = path.join(WORKTREES, `agent-${name}`);
  git(['worktree', 'add', '-b', `fixture-${name}`, dir, 'origin/main']);
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
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT }, { cwd: PROJECT });

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
  assert.equal(entryFor(dryRun, equivalentOld).reason, 'clean_patch_equivalent_old');
  assert.equal(entryFor(dryRun, equivalentFresh).reason, 'too_recent');
  assert.equal(entryFor(dryRun, unmergedOld).reason, 'not_patch_equivalent');
  assert.equal(entryFor(dryRun, dirtyOld).reason, 'dirty');
  assert.ok(fs.existsSync(equivalentOld), 'dry run does not remove worktrees');

  const applied = cliJson(['worktrees', 'sweep', '--yes', '--json']);
  assert.deepEqual(
    applied.removed.map((entry: any) => path.resolve(entry)),
    [path.resolve(equivalentOld)]
  );
  assert.ok(!fs.existsSync(equivalentOld));
  assert.ok(fs.existsSync(equivalentFresh));
  assert.ok(fs.existsSync(unmergedOld));
  assert.ok(fs.existsSync(dirtyOld));
});
