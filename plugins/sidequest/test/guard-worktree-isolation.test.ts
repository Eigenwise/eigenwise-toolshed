import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';

// SQ-3436. A read-only reviewer cloned the project under its ticket's verification directory with
// `git clone --no-checkout`, and `git restore --worktree -- .` was refused as a destructive write to the
// shared checkout with 896 doomed changes. Only the checkouts the board hands out are shared: the
// registered root and other executors' agent worktrees. Anything the executor cloned itself is admitted.
// The git guards now run in the hooks module (hooks/guards/git-guards.test.ts holds their deny texts against
// faked git); these tests pin the real git output and store layout that module reads instead of loading the store.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-guard-isolation-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const { REPO_FACTS_ARGS } = require('../hooks/guards/git-guards.ts');
const { slugify } = require('../hooks/guards/snapshot.ts');

const WINDOWS = process.platform === 'win32';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(prefix: string): string {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Sidequest Test']);
  git(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'isolation fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo('sq-guard-isolation-project-');
const { slug } = store.ensureProject(PROJECT);

// The SQ-3436 shape: an index-only clone whose every tracked file reads as deleted until restored.
function evidenceClone(ref: string): string {
  const clone = path.join(SIDEQUEST_HOME, 'projects', slug, 'verification', ref, 'pr450');
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(path.dirname(clone), ['clone', '--no-checkout', '--no-hardlinks', PROJECT, clone]);
  return fs.realpathSync.native(clone);
}

function linkedWorktree(target: string, branch: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(PROJECT, ['worktree', 'add', '-b', branch, target]);
  return fs.realpathSync.native(target);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (WINDOWS ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

function repoFacts(directory: string): { root: string; commonDir: string } {
  const [root = '', commonDir = ''] = git(directory, REPO_FACTS_ARGS).split(/\r?\n/);
  return { root, commonDir };
}

function moduleRegistered(root: string): Promise<boolean> {
  return slugify(path.resolve(root), WINDOWS).then((moduleSlug: string) => fs.existsSync(path.join(SIDEQUEST_HOME, 'projects', moduleSlug, 'tickets')));
}

test('the module rev-parse names each checkout\'s own root and the common dir its publish lock lives in', () => {
  const clone = evidenceClone('SQ-3436');
  const own = linkedWorktree(worktrees.resolvedAgentWorktree(PROJECT, 'guard-own'), 'guard-own');
  assert.ok(git(clone, ['status', '--porcelain']).length > 0, 'the --no-checkout clone reads as entirely dirty');

  const project = repoFacts(PROJECT);
  assert.ok(samePath(project.root, PROJECT), project.root);
  assert.ok(samePath(project.commonDir, path.join(PROJECT, '.git')), project.commonDir);
  const linked = repoFacts(own);
  assert.ok(samePath(linked.root, own), 'a linked worktree is its own root');
  assert.ok(samePath(linked.commonDir, path.join(PROJECT, '.git')), 'a linked worktree shares the main checkout\'s common dir');
  assert.ok(samePath(repoFacts(clone).root, clone), 'an evidence clone is its own root');
});

test('the module registration check finds the store-registered root and never a clone or linked worktree of it', async () => {
  assert.equal(await slugify(path.resolve(PROJECT), WINDOWS), slug, 'the module slug mirrors the store slug');
  assert.equal(await moduleRegistered(PROJECT), true);
  assert.equal(await moduleRegistered(evidenceClone('SQ-3518')), false);
  assert.equal(await moduleRegistered(linkedWorktree(worktrees.resolvedAgentWorktree(PROJECT, 'guard-other'), 'guard-other')), false);
  assert.equal(await moduleRegistered(initRepo('sq-guard-unregistered-')), false);
});

test('agent worktrees sit where the module looks for another executor\'s checkout', async () => {
  const parent = path.dirname(worktrees.resolvedAgentWorktree(PROJECT, 'guard-parent'));
  const expected = path.join(SIDEQUEST_HOME, 'worktrees', await slugify(path.resolve(PROJECT), WINDOWS));
  assert.ok(samePath(parent, expected) || samePath(parent, path.join(PROJECT, '.claude', 'worktrees')), parent);
});
