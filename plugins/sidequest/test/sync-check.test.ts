import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Loaded per call so a tree without lib/sync-check.js fails each test on its assertion, not the whole file on import.
const syncCheck = (input: Record<string, unknown>): { ok: boolean; line: string } => require('../lib/sync-check').syncCheck(input);

const CLI = path.resolve(__dirname, '..', 'bin', 'sidequest.js');

// Identity is pinned on every call: git refuses to merge, even into a conflict, when it cannot resolve one (a CI runner has none).
function gitRun(cwd: string, args: string[]) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

function git(cwd: string, args: string[]): string {
  const result = gitRun(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(repo: string, name: string, body: string): string {
  fs.writeFileSync(path.join(repo, name), body);
  git(repo, ['add', name]);
  git(repo, ['commit', '-m', `${name} ${body}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

// first <- second on main, with `side` branching from first so `second` is not its ancestor.
function fixture() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sync-check-')));
  git(repo, ['init', '-q', '-b', 'main']);
  const first = commitFile(repo, 'shared.txt', 'one\n');
  const second = commitFile(repo, 'second.txt', 'two\n');
  git(repo, ['checkout', '-q', '-b', 'side', first]);
  const sideTip = commitFile(repo, 'shared.txt', 'side\n');
  git(repo, ['checkout', '-q', 'main']);
  return { repo, first, second, sideTip };
}

function cli(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test('sync-check passes when the dispatch base is an ancestor of HEAD, in the cwd or a named worktree', () => {
  const { repo, first, second } = fixture();
  const inCwd = cli(['sync-check', first], repo);
  assert.equal(inCwd.status, 0);
  assert.equal(inCwd.stdout, `sync-check: ok (${first.slice(0, 7)} is an ancestor of HEAD ${second.slice(0, 7)})`);

  const elsewhere = cli(['sync-check', first, '--worktree', repo], os.tmpdir());
  assert.equal(elsewhere.status, 0);
  assert.match(elsewhere.stdout, /^sync-check: ok /);
});

test('sync-check exits 1 and names not-ancestor when HEAD is on a history without the base', () => {
  const { repo, second, sideTip } = fixture();
  git(repo, ['checkout', '-q', '--detach', sideTip]);
  const result = cli(['sync-check', second], repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `sync-check: FAILED not-ancestor (${second.slice(0, 7)} is not an ancestor of HEAD ${sideTip.slice(0, 7)})`);
});

test('sync-check exits 1 for a ref that is not a commit, and never hands a dash-led value to git', () => {
  const { repo } = fixture();
  const missing = cli(['sync-check', 'f'.repeat(40)], repo);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^sync-check: FAILED unknown-revision \(f{40} is not a commit in /);

  const dashLed = syncCheck({ commit: '--all', worktree: repo });
  assert.equal(dashLed.ok, false);
  assert.match(dashLed.line, /^sync-check: FAILED unknown-revision/);
});

test('sync-check reports a missing worktree and a directory that is no repository', () => {
  const { repo } = fixture();
  const absent = syncCheck({ commit: 'main', worktree: path.join(repo, 'does-not-exist') });
  assert.match(absent.line, /^sync-check: FAILED no-worktree/);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sync-check-plain-'));
  const notRepo = syncCheck({ commit: 'main', worktree: plain });
  assert.match(notRepo.line, /^sync-check: FAILED not-a-worktree/);
});

test('sync-check without a commit is a usage error', () => {
  const { repo } = fixture();
  const result = cli(['sync-check'], repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sync-check: pass the base commit/);
});

test('the continuation variant requires HEAD in the named worktree to equal the retained commit', () => {
  const { repo, first, second } = fixture();
  const ok = cli(['sync-check', first, '--worktree', repo, '--head', second], os.tmpdir());
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /HEAD is the expected commit\)$/);

  const wrong = cli(['sync-check', first, '--worktree', repo, '--head', first], os.tmpdir());
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stdout, `sync-check: FAILED head-mismatch (HEAD is ${second.slice(0, 7)}, expected ${first.slice(0, 7)})`);

  const unknown = syncCheck({ commit: first, worktree: repo, head: 'e'.repeat(40) });
  assert.match(unknown.line, /^sync-check: FAILED head-mismatch \(HEAD is [0-9a-f]{7}, expected e{40}\)$/);
});

test('the retained-candidate variant needs uncommitted changes with no unmerged entries, and tests the base last', () => {
  const { repo, first, second, sideTip } = fixture();
  const clean = cli(['sync-check', first, '--head', second, '--retained'], repo);
  assert.equal(clean.status, 1);
  assert.match(clean.stdout, /^sync-check: FAILED retained-changes-missing/);

  fs.writeFileSync(path.join(repo, 'retained.txt'), 'uncommitted\n');
  const retained = cli(['sync-check', first, '--head', second, '--retained'], repo);
  assert.equal(retained.status, 0);
  assert.match(retained.stdout, /retained changes present, none unmerged\)$/);

  // The candidate is proven before ancestry runs, so a base that has to move reports not-ancestor only
  // once HEAD and the retained changes are known good.
  const needsMove = cli(['sync-check', sideTip, '--head', second, '--retained'], repo);
  assert.equal(needsMove.status, 1);
  assert.match(needsMove.stdout, /^sync-check: FAILED not-ancestor /);

  const wrongHead = cli(['sync-check', first, '--head', first, '--retained'], repo);
  assert.match(wrongHead.stdout, /^sync-check: FAILED head-mismatch /);
});

test('the retained-candidate variant refuses a checkout that is mid-merge', () => {
  const { repo, first } = fixture();
  commitFile(repo, 'shared.txt', 'main\n');
  const head = git(repo, ['rev-parse', 'HEAD']);
  const merge = gitRun(repo, ['merge', 'side']);
  assert.equal(merge.status, 1, `the fixture merge must stop on a conflict (exit 1), got ${merge.status}: ${merge.stderr}`);
  assert.match(git(repo, ['status', '--porcelain']), /^UU shared\.txt/m);

  const result = cli(['sync-check', first, '--head', head, '--retained'], repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^sync-check: FAILED unmerged /);
});
