import './_temp-cleanup.js';
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

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-commit-scope-home-'));
const store = require('../lib/store.js') as any;

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

// SQ-900: the store used to keep only the first 20 declared paths, so an approved
// 28-path scope reached the commit gate 8 paths short and the executor's commit was
// refused for work the orchestrator had signed off on.
test('a declared scope beyond 20 entries survives the store and gates the commit it approved', () => {
  const root = repo();
  const slug = store.ensureProject(root, 'SQ-900 scope cap').slug;
  const scope = Array.from({ length: 28 }, (_, i) => `plugins/sidequest/part-${String(i).padStart(2, '0')}.js`);
  const ticket = store.createTicket(slug, {
    title: 'wide declared scope',
    files: scope.slice(0, 25),
    complexity: 2,
    complexityWhy: 'A declared scope wider than the old cap, approved in two passes like the real ticket.',
  });
  assert.deepEqual(ticket.files, scope.slice(0, 25));
  assert.deepEqual(store.updateTicket(slug, ticket.ref, { files: scope }).files, scope);
  assert.deepEqual(store.getTicket(slug, ticket.ref).files, scope, 'the approved scope round-trips whole');

  const approved = store.effectiveScope(slug, store.getTicket(slug, ticket.ref).files);
  const last = scope[scope.length - 1]!;
  assert.ok(commitScope.isInScope(last, approved), 'the last approved path is in scope');
  fs.writeFileSync(path.join(root, last), 'tail\n');
  const committed = commitScope.commitScoped(root, 'tail of a wide scope', approved);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, [last]);
});

test('an over-limit declared scope is refused with the cap, the overflow and the directory-scope way out', () => {
  const slug = store.ensureProject(repo(), 'SQ-900 over limit').slug;
  const scope = (count: number) => Array.from({ length: count }, (_, i) => `plugins/sidequest/part-${String(i).padStart(3, '0')}.js`);
  const ticket = store.createTicket(slug, {
    title: 'scope ceiling',
    files: scope(3),
    complexity: 2,
    complexityWhy: 'A ticket whose scope list is pushed past the declared ceiling on purpose.',
  });

  assert.throws(
    () => store.updateTicket(slug, ticket.ref, { files: scope(store.DECLARED_FILES_MAX + 5) }),
    (error: Error) => /accepts at most 100 entries; this write declared 105 \(5 over\)/.test(error.message) && /directory/.test(error.message),
  );
  assert.deepEqual(store.getTicket(slug, ticket.ref).files, scope(3), 'the refused write changed nothing');
  assert.throws(
    () => store.createTicket(slug, { title: 'born too wide', files: scope(store.DECLARED_FILES_MAX + 1), complexity: 2, complexityWhy: 'A create whose declared scope is one entry over the ceiling.' }),
    /declared file scope accepts at most/,
  );
});

test('missing declared paths warn while existing declared paths commit', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  git(root, ['add', '.']);

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest/worker-a.js', 'plugins/sidequest/phantom.js']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.missingScopes, ['plugins/sidequest/phantom.js']);
});

test('ignored declared files do not block tracked scoped commits', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/settings.local.json\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-m', 'ignore local settings']);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"enabled":true}\n');

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest/worker-a.js', '.claude/settings.local.json']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(commitScope.commitPaths(root, committed.commit), ['plugins/sidequest/worker-a.js']);
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


test('exact declared paths commit staged deletions', () => {
  const root = repo();
  const worker = path.join(root, 'plugins', 'sidequest', 'worker-a.js');
  fs.writeFileSync(worker, 'a\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add worker']);
  git(root, ['rm', 'plugins/sidequest/worker-a.js']);

  const committed = commitScope.commitScoped(root, 'remove worker', ['plugins/sidequest/worker-a.js']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.deepEqual(committed.missingScopes, []);
  assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
  assert.deepEqual(commitScope.commitPaths(root, committed.commit), ['plugins/sidequest/worker-a.js']);
});

test('exact declared rename paths commit staged renames atomically', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'old.txt'), 'old\n');
  git(root, ['add', 'old.txt']);
  git(root, ['commit', '-m', 'add old']);
  git(root, ['mv', 'old.txt', 'new.txt']);

  const committed = commitScope.commitScoped(root, 'rename', ['old.txt', 'new.txt']);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.missingScopes, []);
  assert.deepEqual(committed.paths.sort(), ['new.txt', 'old.txt']);
  assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
  assert.deepEqual(commitScope.commitPaths(root, committed.commit).sort(), ['new.txt', 'old.txt']);
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
