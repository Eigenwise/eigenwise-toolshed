import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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

interface RangeResult {
  ok: boolean;
  reason?: string;
  base?: string;
  commit?: string;
  commits?: string[];
  changedPaths?: string[];
  upstream?: string;
  upstreamCommit?: string;
  gitRef?: string;
  reconciled?: boolean;
  divergedPath?: string;
  message?: string;
}

const commitScope = require('../lib/commit-scope.js') as {
  commitScoped(cwd: string, message: string, files: string[]): ScopeResult;
  commitPaths(cwd: string, commit: string): string[];
  validateCommitScope(cwd: string, commit: string, files: string[]): ScopeResult;
  validateScopeResolution(cwd: string, files: string[], opts?: { inspectDescendants?: boolean }): { ok: boolean; reason: string | null; outside: string[]; indirect: string[] };
  isInScope(file: string, files: string[]): boolean;
  validateCommitRangeScope(cwd: string, commits: string[], files: string[]): ScopeResult;
  submissionRange(cwd: string, opts: Record<string, unknown>): RangeResult;
  validateStoredSubmissionRange(cwd: string, submission: unknown): RangeResult;
  scopedWorkPending(cwd: string, files: unknown, opts?: unknown): any;
  headCommit(cwd: string): string | null;
  preserveCommitRef(cwd: string, commit: string, gitRef: string): { ok: boolean; reason?: string; commit?: string; gitRef?: string };
};

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

test('configured generated pairs add only tracked outputs to effective scope and scoped commits', () => {
  const root = repo();
  const source = 'plugins/sidequest/src/lib/worker.ts';
  const output = 'plugins/sidequest/lib/worker.js';
  fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
  fs.writeFileSync(path.join(root, source), 'export const worker = true;\n');
  fs.writeFileSync(path.join(root, output), 'exports.worker = true;\n');
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'esbuild --outdir lib' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'tracked source and output']);
  const slug = store.ensureProject(root, 'generated pairs').slug;
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }] });

  const scope = store.effectiveScope(slug, [source]);
  assert.deepEqual(scope, [source, output]);
  assert.deepEqual(store.effectiveScope(slug, [output]), [output], 'a generated output does not admit its source');
  const outputDirectoryScope = store.effectiveScope(slug, ['plugins/sidequest/lib']);
  assert.equal(commitScope.isInScope(source, outputDirectoryScope), false, 'output scope does not admit paired sources');
  assert.equal(commitScope.isInScope('plugins/sidequest/src/hooks/worker.ts', outputDirectoryScope), false, 'output scope does not admit unrelated sources');
  fs.writeFileSync(path.join(root, source), 'export const worker = false;\n');
  fs.writeFileSync(path.join(root, output), 'exports.worker = false;\n');
  const committed = commitScope.commitScoped(root, 'paired output', scope);
  assert.equal(committed.ok, true, committed.message as string);
  assert.deepEqual(committed.paths.sort(), [output, source]);
});

test('the Sidequest build layout expands tracked source paths without granting sources from output paths', () => {
  const root = repo();
  const source = 'plugins/sidequest/src/lib/worker.ts';
  const output = 'plugins/sidequest/lib/worker.js';
  for (const file of [source, output]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export const worker = true;\n');
  }
  const buildScript = path.join(root, 'plugins', 'sidequest', 'scripts', 'build.mjs');
  fs.mkdirSync(path.dirname(buildScript), { recursive: true });
  fs.writeFileSync(buildScript, "export const nonBundledBuildDirectories = ['lib', 'bin'];\n");
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Sidequest build output fixture']);

  const slug = store.ensureProject(root, 'Sidequest build layout').slug;
  assert.deepEqual(store.effectiveScope(slug, [source]), [source, output]);
  assert.deepEqual(store.effectiveScope(slug, [output]), [output]);
  const exploration = store.getCategory('codebase-exploration');
  store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
  const ticket = store.createTicket(slug, {
    title: 'build output scope',
    category: 'codebase-exploration',
    files: [source],
    complexity: 2,
    complexityWhy: 'The dispatch snapshot must include the tracked output.',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  assert.deepEqual(prepared.ticket.dispatch.declaredFiles, [source, output]);
});

test('ambiguous generated output mappings do not admit a source', () => {
  const root = repo();
  const sourceA = 'plugins/sidequest/src/lib-a/worker.ts';
  const sourceB = 'plugins/sidequest/src/lib-b/worker.ts';
  const output = 'plugins/sidequest/lib/worker.js';
  for (const file of [sourceA, sourceB, output]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export const worker = true;\n');
  }
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'esbuild --outdir lib' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'ambiguous generated pair fixture']);
  const slug = store.ensureProject(root, 'ambiguous generated pairs').slug;
  store.setBoardConfig(slug, { generatedPairs: [
    { from: 'plugins/*/src/lib-a/*.ts', to: 'plugins/*/lib/*.js' },
    { from: 'plugins/*/src/lib-b/*.ts', to: 'plugins/*/lib/*.js' },
  ] });

  assert.deepEqual(store.effectiveScope(slug, [output]), [output]);
});

test('tracked generated pairs outside a package build output do not admit sources', () => {
  const root = repo();
  const source = 'plugins/sidequest/src/lib/worker.ts';
  const output = 'plugins/sidequest/lib/worker.js';
  for (const file of [source, output]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export const worker = true;\n');
  }
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'esbuild --outdir dist' } }));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'non-build generated pair fixture']);
  const slug = store.ensureProject(root, 'non-build generated pair').slug;
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }] });

  assert.deepEqual(store.effectiveScope(slug, [output]), [output]);
});

test('generated pairs leave unmapped boards and untracked counterparts unchanged', () => {
  const root = repo();
  const source = 'plugins/sidequest/src/hooks/worker.ts';
  const output = 'plugins/sidequest/hooks/worker.js';
  fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
  fs.writeFileSync(path.join(root, source), 'export const worker = true;\n');
  git(root, ['add', source]);
  git(root, ['commit', '-m', 'tracked source only']);
  const slug = store.ensureProject(root, 'untracked generated pair').slug;
  assert.deepEqual(store.effectiveScope(slug, [source]), [source]);
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/hooks/*.ts', to: 'plugins/*/hooks/*.js' }] });
  assert.deepEqual(store.effectiveScope(slug, [source]), [source]);
});

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

// SQ-923. `submit` refused verified work with `empty_range` on two shapes that
// are really one bug: the scoped commit is not AHEAD of the integration branch
// because it IS the branch tip. Greenfield boards hit it on their root commit
// (terge SQ-95/100/107/109/121/124/126) and shared-tree boards hit it whenever
// the scoped commit advanced main (terge SQ-146/185/188/191/200/206). Every
// recovery was the same manual move: resubmit against the tip's own parent.

function branchOf(root: string): string {
  return git(root, ['symbolic-ref', '--short', 'HEAD']);
}

function pin(root: string, ref: string, commit: string): void {
  git(root, ['update-ref', ref, commit]);
}

function greenfieldRepo(file: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-commit-scope-root-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Sidequest Test']);
  git(root, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), 'first\n');
  git(root, ['add', '--', file]);
  git(root, ['commit', '-m', 'root commit']);
  return root;
}

test('SQ-923: a greenfield root commit submits against the empty tree instead of empty_range', () => {
  const root = greenfieldRepo('src/only.rs');
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-1', tip);

  const range = commitScope.submissionRange(root, { commit: tip, gitRef: 'refs/sidequest/SQ-1', upstream: branchOf(root) });
  assert.equal(range.ok, true, `root commit was refused: ${range.reason}`);
  assert.equal(range.base, EMPTY_TREE, 'a parentless commit bases on the empty tree');
  assert.deepEqual(range.commits, [tip]);
  assert.deepEqual(range.changedPaths, ['src/only.rs'], 'the root tree still resolves its scoped paths');

  const stored = {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1',
    upstream: range.upstream,
    upstreamCommit: range.upstreamCommit,
    base: range.base,
    commits: range.commits,
    changedPaths: range.changedPaths,
    admittedScope: ['src'],
  };
  const revalidated = commitScope.validateStoredSubmissionRange(root, stored);
  assert.equal(revalidated.ok, true, `stored root-commit submission failed revalidation: ${revalidated.reason}`);
  assert.deepEqual(revalidated.commits, [tip]);
  assert.equal(commitScope.validateCommitRangeScope(root, range.commits!, ['src']).ok, true);
});

test('SQ-1743: a patch already replayed after an upstream reset revalidates for closure', () => {
  const root = repo();
  const main = branchOf(root);
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'discarded-base.js'), 'discarded\n');
  git(root, ['add', '--', 'plugins/other-plugin/discarded-base.js']);
  git(root, ['commit', '-m', 'discarded integration base']);
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'replayed.js'), 'replayed\n');
  git(root, ['add', '--', 'plugins/sidequest/replayed.js']);
  git(root, ['commit', '-m', 'ticket work']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-1743', tip);
  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1743',
    upstream: main,
    integrationBranch: main,
  });
  assert.equal(range.ok, true, `ticket range was refused: ${range.reason}`);

  git(root, ['checkout', '-q', main]);
  git(root, ['reset', '--hard', 'HEAD~1']);
  git(root, ['cherry-pick', tip]);

  const revalidated = commitScope.validateStoredSubmissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1743',
    upstream: range.upstream,
    upstreamCommit: range.upstreamCommit,
    integrationBranch: main,
    base: range.base,
    commits: range.commits,
    changedPaths: range.changedPaths,
    admittedScope: ['plugins/sidequest/replayed.js'],
  });
  assert.equal(revalidated.ok, true, `replayed patch was refused: ${revalidated.reason}`);
  assert.equal(revalidated.reconciled, true);
  assert.deepEqual(revalidated.changedPaths, ['plugins/sidequest/replayed.js']);
});

test('SQ-1749: reconciliation refuses a patch that the integration branch reverted', () => {
  const root = repo();
  const main = branchOf(root);
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'discarded-base.js'), 'discarded\n');
  git(root, ['add', '--', 'plugins/other-plugin/discarded-base.js']);
  git(root, ['commit', '-m', 'discarded integration base']);
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'reverted.js'), 'submitted\n');
  git(root, ['add', '--', 'plugins/sidequest/reverted.js']);
  git(root, ['commit', '-m', 'ticket work']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-1749', tip);
  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1749',
    upstream: main,
    integrationBranch: main,
  });
  assert.equal(range.ok, true, `ticket range was refused: ${range.reason}`);

  git(root, ['checkout', '-q', main]);
  git(root, ['reset', '--hard', 'HEAD~1']);
  git(root, ['cherry-pick', tip]);
  git(root, ['revert', '--no-edit', 'HEAD']);

  const revalidated = commitScope.validateStoredSubmissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1749',
    upstream: range.upstream,
    upstreamCommit: range.upstreamCommit,
    integrationBranch: main,
    base: range.base,
    commits: range.commits,
    changedPaths: range.changedPaths,
    admittedScope: ['plugins/sidequest/reverted.js'],
  });
  assert.equal(revalidated.ok, false);
  assert.equal(revalidated.reason, 'reconciled_path_diverged');
  assert.equal(revalidated.divergedPath, 'plugins/sidequest/reverted.js');
  assert.match(revalidated.message || '', /plugins\/sidequest\/reverted\.js/);
});

test('SQ-1749: reconciliation refuses a whitespace-variant patch', () => {
  const root = repo();
  const main = branchOf(root);
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'discarded-base.js'), 'discarded\n');
  git(root, ['add', '--', 'plugins/other-plugin/discarded-base.js']);
  git(root, ['commit', '-m', 'discarded integration base']);
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'whitespace.js'), 'base \n');
  git(root, ['add', '--', 'plugins/sidequest/whitespace.js']);
  git(root, ['commit', '-m', 'ticket whitespace']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-1749', tip);
  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1749',
    upstream: main,
    integrationBranch: main,
  });
  assert.equal(range.ok, true, `ticket range was refused: ${range.reason}`);

  git(root, ['checkout', '-q', main]);
  git(root, ['reset', '--hard', 'HEAD~1']);
  fs.mkdirSync(path.join(root, 'plugins', 'sidequest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'whitespace.js'), ' base\n');
  git(root, ['add', '--', 'plugins/sidequest/whitespace.js']);
  git(root, ['commit', '-m', 'integration whitespace']);

  const revalidated = commitScope.validateStoredSubmissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-1749',
    upstream: range.upstream,
    upstreamCommit: range.upstreamCommit,
    integrationBranch: main,
    base: range.base,
    commits: range.commits,
    changedPaths: range.changedPaths,
    admittedScope: ['plugins/sidequest/whitespace.js'],
  });
  assert.equal(revalidated.ok, false);
  assert.equal(revalidated.reason, 'reconciled_path_diverged');
  assert.equal(revalidated.divergedPath, 'plugins/sidequest/whitespace.js');
});

test('SQ-923: a scoped commit that advanced the integration branch submits against its own parent', () => {
  const root = repo();
  const parent = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'engine.js'), 'shared tree work\n');
  const committed = commitScope.commitScoped(root, 'scoped shared-tree work', ['plugins/sidequest']);
  assert.equal(committed.ok, true, committed.message as string);
  const tip = committed.commit;
  pin(root, 'refs/sidequest/SQ-2', tip);
  assert.equal(git(root, ['rev-parse', branchOf(root)]), tip, 'the scoped commit is the branch tip');

  const range = commitScope.submissionRange(root, { commit: tip, gitRef: 'refs/sidequest/SQ-2', upstream: branchOf(root) });
  assert.equal(range.ok, true, `shared-tree tip was refused: ${range.reason}`);
  assert.equal(range.base, parent, "the tip's own parent bounds the range");
  assert.deepEqual(range.commits, [tip]);
  assert.deepEqual(range.changedPaths, ['plugins/sidequest/engine.js']);
});

test('SQ-1339: an explicit base equal to the tip records a no-op without weakening merge-tip refusal', () => {
  const root = repo();
  const main = branchOf(root);
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-3', tip);
  const explicit = commitScope.submissionRange(root, { commit: tip, gitRef: 'refs/sidequest/SQ-3', upstream: main, base: tip });
  assert.equal(explicit.ok, true, `explicit no-op was refused: ${explicit.reason}`);
  assert.equal('noOp' in explicit && explicit.noOp, true);
  assert.deepEqual(explicit.commits, []);
  assert.deepEqual(explicit.changedPaths, []);
  assert.equal(commitScope.validateStoredSubmissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-3',
    upstream: explicit.upstream,
    upstreamCommit: explicit.upstreamCommit,
    base: explicit.base,
    commits: explicit.commits,
    changedPaths: explicit.changedPaths,
    noOp: true,
    admittedScope: ['plugins/sidequest'],
  }).ok, true);

  git(root, ['checkout', '-q', '-b', 'side']);
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'side.js'), 'side\n');
  git(root, ['add', '--', 'plugins/other-plugin/side.js']);
  git(root, ['commit', '-m', 'side work']);
  git(root, ['checkout', '-q', main]);
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'main.js'), 'main\n');
  git(root, ['add', '--', 'plugins/sidequest/main.js']);
  git(root, ['commit', '-m', 'main work']);
  git(root, ['merge', '--no-ff', '-m', 'merge side', 'side']);
  const mergeTip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-4', mergeTip);

  const merged = commitScope.submissionRange(root, { commit: mergeTip, gitRef: 'refs/sidequest/SQ-4', upstream: main });
  assert.equal(merged.ok, false, 'a merge tip is never rewritten into a one-commit range');
  assert.equal(merged.reason, 'merge_commit');
});

test('SQ-971: a dispatch baseline excludes merge commits from parent history', () => {
  const root = repo();
  const main = branchOf(root);
  git(root, ['checkout', '-q', '-b', 'feature-parent']);
  git(root, ['checkout', '-q', '-b', 'feature-side']);
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'side.js'), 'side\n');
  git(root, ['add', '--', 'plugins/other-plugin/side.js']);
  git(root, ['commit', '-m', 'feature side']);
  git(root, ['checkout', '-q', 'feature-parent']);
  fs.mkdirSync(path.join(root, 'plugins', 'other-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'parent.js'), 'parent\n');
  git(root, ['add', '--', 'plugins/other-plugin/parent.js']);
  git(root, ['commit', '-m', 'feature parent']);
  git(root, ['merge', '--no-ff', '-m', 'merge feature side', 'feature-side']);
  const dispatchBase = git(root, ['rev-parse', 'HEAD']);
  git(root, ['branch', 'feature-integration', dispatchBase]);
  git(root, ['checkout', '-q', '-b', 'ticket-work']);
  fs.mkdirSync(path.join(root, 'plugins', 'sidequest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'ticket.js'), 'ticket\n');
  git(root, ['add', '--', 'plugins/sidequest/ticket.js']);
  git(root, ['commit', '-m', 'ticket work']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  pin(root, 'refs/sidequest/SQ-971', tip);

  git(root, ['checkout', '-q', main]);
  fs.mkdirSync(path.join(root, 'plugins', 'other-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'target.js'), 'target advanced after dispatch\n');
  git(root, ['add', '--', 'plugins/other-plugin/target.js']);
  git(root, ['commit', '-m', 'advance rewritten integration target']);
  const targetTip = git(root, ['rev-parse', 'HEAD']);
  git(root, ['branch', '-f', 'feature-integration', targetTip]);
  git(root, ['checkout', '-q', 'ticket-work']);

  const withoutDispatchBase = commitScope.submissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-971',
    upstream: 'feature-integration',
    integrationBranch: 'feature-integration',
  });
  assert.equal(withoutDispatchBase.ok, false, 'the rewritten target must expose the parent merge without the recorded baseline');
  assert.equal(withoutDispatchBase.reason, 'merge_commit');

  const range = commitScope.submissionRange(root, {
    commit: tip,
    gitRef: 'refs/sidequest/SQ-971',
    upstream: 'feature-integration',
    integrationBranch: 'feature-integration',
    dispatchBase,
  });
  assert.equal(range.ok, true, `parent-history merge was refused: ${range.reason}`);
  assert.equal(range.base, dispatchBase);
  assert.deepEqual(range.commits, [tip]);
  assert.deepEqual(range.changedPaths, ['plugins/sidequest/ticket.js']);

  const preserved = commitScope.preserveCommitRef(root, tip, 'refs/sidequest/SQ-971-rejected');
  assert.equal(preserved.ok, true, preserved.reason || 'commit was not preserved');
  assert.equal(git(root, ['rev-parse', 'refs/sidequest/SQ-971-rejected']), tip);
  assert.notEqual(dispatchBase, git(root, ['merge-base', main, tip]));
  assert.notEqual(dispatchBase, git(root, ['merge-base', targetTip, tip]));
});

// SQ-923. `done` on a write-routed dispatch that produced nothing used to be a
// dead end (27 tickets in three days). Closing it needs proof that the run is a
// no-op, and that proof is exactly this: nothing uncommitted and nothing
// committed past the dispatch baseline, inside the declared scope.
test('SQ-923: pending scoped work separates a genuine no-op from uncommitted and committed work', () => {
  const root = repo();
  const base = commitScope.headCommit(root);
  assert.equal(base, git(root, ['rev-parse', 'HEAD']));

  const clean = commitScope.scopedWorkPending(root, ['plugins/sidequest'], { base });
  assert.equal(clean.ok, true, clean.message);
  assert.equal(clean.pending, false, 'an untouched scope owes no submission');

  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'draft.js'), 'draft\n');
  fs.writeFileSync(path.join(root, 'plugins', 'other-plugin', 'noise.js'), 'noise\n');
  const dirty = commitScope.scopedWorkPending(root, ['plugins/sidequest'], { base });
  assert.equal(dirty.pending, true, 'an uncommitted in-scope file owes a submission');
  assert.deepEqual(dirty.working, ['plugins/sidequest/draft.js'], "out-of-scope noise is not this ticket's work");
  assert.deepEqual(dirty.committed, []);

  assert.equal(commitScope.commitScoped(root, 'scoped work', ['plugins/sidequest']).ok, true);
  const committed = commitScope.scopedWorkPending(root, ['plugins/sidequest'], { base });
  assert.equal(committed.pending, true, 'committed-but-unsubmitted work still owes a submission');
  assert.deepEqual(committed.working, []);
  assert.deepEqual(committed.committed, ['plugins/sidequest/draft.js']);

  assert.equal(commitScope.scopedWorkPending(root, ['plugins/sidequest'], {}).ok, false, 'no baseline means no proof');
  assert.equal(commitScope.scopedWorkPending(root, [], { base }).reason, 'missing_scope');
});
