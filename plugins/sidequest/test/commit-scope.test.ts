import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

interface ScopeResult {
  ok: boolean;
  reason?: string | null;
  message?: string;
  commit: string;
  paths: string[];
  outside: string[];
  missingScopes: string[];
  unscopedPaths: string[];
}

const commitScope = require('../lib/commit-scope.js') as {
  commitScoped(cwd: string, message: string, files: string[]): ScopeResult;
  commitPaths(cwd: string, commit: string): string[];
  validateCommitScope(cwd: string, commit: string, files: string[]): ScopeResult;
  validateScopeResolution(cwd: string, files: string[], opts?: { inspectDescendants?: boolean }): { ok: boolean; reason: string | null; outside: string[]; indirect: string[] };
  isInScope(file: string, files: string[]): boolean;
};

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-commit-scope-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Sidequest Test']);
  git(root, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.mkdirSync(path.join(root, 'plugins', 'sidequest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'other-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

test('missing declared paths warn while existing declared paths commit', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  git(root, ['add', '.']);

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest/worker-a.js', 'plugins/sidequest/phantom.js']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.missingScopes, ['plugins/sidequest/phantom.js']);
});

test('exact declared paths commit untracked additions', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest/worker-a.js']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.missingScopes, []);
});

test('exact declared paths commit tracked deletions', () => {
  const root = repo();
  const worker = path.join(root, 'plugins', 'sidequest', 'worker-a.js');
  fs.writeFileSync(worker, 'a\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add worker']);
  fs.unlinkSync(worker);

  const committed = commitScope.commitScoped(root, 'remove worker', ['plugins/sidequest/worker-a.js']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.missingScopes, []);
});


test('scoped commit leaves another executor’s staged file in the shared index', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'worker-b.js'), 'b\n');
  git(root, ['add', '.']);

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest']);
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.unscopedPaths, ['plugins/other-plugin/worker-b.js']);
  assert.equal(git(root, ['diff', '--cached', '--name-only']), 'plugins/other-plugin/worker-b.js');
  assert.deepEqual(commitScope.commitPaths(root, committed.commit), ['plugins/sidequest/worker-a.js']);
});

test('scoped commit preserves an uppercase tracked path from a nested directory', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');
  git(root, ['add', 'README.md']);

  const committed = commitScope.commitScoped(path.join(root, 'plugins', 'sidequest'), 'preserve README case', ['README.md']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['README.md']);
  assert.equal(git(root, ['show', '--format=', '--name-only', 'HEAD']), 'README.md');
});

test('Windows scope matching emits canonical tracked casing', { skip: process.platform !== 'win32' }, () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');
  git(root, ['add', 'README.md']);

  const committed = commitScope.commitScoped(path.join(root, 'plugins', 'sidequest'), 'canonical README case', ['readme.md']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['README.md']);
  assert.equal(git(root, ['show', '--format=', '--name-only', 'HEAD']), 'README.md');
});

test('out-of-scope commits are refused before submission', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'worker-b.js'), 'b\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'contaminated']);

  const verdict = commitScope.validateCommitScope(root, 'HEAD', ['plugins/sidequest']);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'outside_scope');
  assert.deepEqual(verdict.outside, ['plugins/other-plugin/worker-b.js']);
});

test('scope resolution rejects absolute and traversal forms without prefix confusion', () => {
  const root = repo();
  for (const scope of [path.resolve(root, '..', 'outside'), 'C:\\outside', '../outside', 'plugins/sidequest/../other-plugin']) {
    const verdict = commitScope.validateScopeResolution(root, [scope]);
    assert.equal(verdict.ok, false, scope);
    assert.equal(verdict.reason, 'outside_scope', scope);
  }
  assert.equal(commitScope.validateScopeResolution(root, ['plugins\\sidequest\\new-artifact'], { inspectDescendants: true }).ok, true);
  assert.equal(commitScope.isInScope('plugins/sidequest-map', ['plugins/sidequest']), false);
  assert.equal(commitScope.isInScope('plugins/sidequest/map', ['plugins/sidequest']), true);
  assert.equal(commitScope.isInScope('PLUGINS/SIDEQUEST/map', ['plugins/sidequest']), process.platform === 'win32');
});

test('descendant inspection rejects a junction or symlink while allowing a new directory', () => {
  const root = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-outside-'));
  const scope = path.join(root, 'plugins', 'sidequest', 'artifact-link');
  assert.equal(commitScope.validateScopeResolution(root, ['plugins/sidequest/new-artifact'], { inspectDescendants: true }).ok, true);
  fs.symlinkSync(outside, scope, process.platform === 'win32' ? 'junction' : 'dir');
  const verdict = commitScope.validateScopeResolution(root, ['plugins/sidequest'], { inspectDescendants: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'filesystem_indirection');
  assert.deepEqual(verdict.indirect, ['plugins/sidequest/artifact-link']);
  fs.unlinkSync(scope);
});
