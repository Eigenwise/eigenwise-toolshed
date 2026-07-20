'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const { makeCliRunner } = require('./_helpers.js');

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-project-'));
const REMOTE = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-worktrees-remote-'));
const WORKTREES = path.join(PROJECT, '.claude', 'worktrees');

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || PROJECT, encoding: 'utf8', windowsHide: true }).trim();
}

function agentWorktree(ref) {
  const dir = path.join(WORKTREES, `agent-${ref.toLowerCase()}`);
  git(['worktree', 'add', '-b', ref, dir, 'origin/main']);
  return dir;
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

function ticket(title) {
  return store.createTicket(slug, {
    title,
    complexity: 3,
    complexityWhy: 'fixture ticket for stale executor worktree cleanup coverage',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function complete(t) {
  assert.equal(store.claimTicket(slug, t.ref, 'worker', { direct: true }).ok, true);
  assert.equal(store.completeTicket(slug, t.ref, 'worker', {}).ok, true);
}

test('worktrees sweep classifies done, integrated, dirty, and ahead agent worktrees', () => {
  const done = ticket('done worktree');
  complete(done);
  const donePath = agentWorktree(done.ref);

  const integrated = ticket('integrated worktree');
  const integratedPath = agentWorktree(integrated.ref);
  assert.equal(store.claimTicket(slug, integrated.ref, 'worker', { direct: true }).ok, true);
  assert.equal(store.submitTicket(slug, integrated.ref, 'worker', {
    commit: 'abc1234def5678abc1234def5678abc1234def56',
    worktree: integratedPath,
  }).ok, true);
  assert.equal(store.completeTicket(slug, integrated.ref, 'orchestrator', {}).ok, true);

  const dirty = ticket('dirty worktree');
  const dirtyPath = agentWorktree(dirty.ref);
  fs.writeFileSync(path.join(dirtyPath, 'dirty.txt'), 'keep me\n');

  const ahead = ticket('ahead worktree');
  const aheadPath = agentWorktree(ahead.ref);
  fs.writeFileSync(path.join(aheadPath, 'ahead.txt'), 'ahead\n');
  git(['add', 'ahead.txt'], aheadPath);
  git(['commit', '-m', 'ahead fixture'], aheadPath);

  const dryRun = cliJson(['worktrees', '--sweep', '--json']);
  const byTicket = new Map(dryRun.entries.map((entry) => [entry.ticket, entry]));
  assert.deepEqual(
    [byTicket.get(done.ref).action, byTicket.get(integrated.ref).action, byTicket.get(dirty.ref).action, byTicket.get(ahead.ref).action],
    ['remove', 'remove', 'keep', 'keep']
  );
  assert.equal(byTicket.get(done.ref).reason, 'done');
  assert.equal(byTicket.get(integrated.ref).reason, 'integrated');
  assert.equal(byTicket.get(dirty.ref).reason, 'dirty');
  assert.equal(byTicket.get(ahead.ref).reason, 'ahead');
  assert.equal(byTicket.get(ahead.ref).ahead, 1);
  assert.ok(fs.existsSync(donePath), 'dry runs do not remove worktrees');

  const applied = cliJson(['worktrees', '--sweep', '--yes', '--json']);
  assert.deepEqual(
    new Set(applied.removed.map((entry) => entry.replace(/\\/g, '/'))),
    new Set([donePath, integratedPath].map((entry) => entry.replace(/\\/g, '/')))
  );
  assert.ok(!fs.existsSync(donePath));
  assert.ok(!fs.existsSync(integratedPath));
  assert.ok(fs.existsSync(dirtyPath));
  assert.ok(fs.existsSync(aheadPath));
});
