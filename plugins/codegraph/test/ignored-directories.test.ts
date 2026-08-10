import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ignoredDirectoriesUnder, isIgnoredDirectory } from '../src/lib/ignored-directories.ts';
import { discoverPythonProjects } from '../src/lib/languages/python/projects.ts';
import { discoverProjects } from '../src/lib/projects.ts';

async function checkoutTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-nested-checkout-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'module.py'), 'value = 1\n');
  await writeFile(path.join(root, 'tsconfig.json'), '{"include":["**/*"]}\n');
  await writeFile(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/root\n');

  const worktree = path.join(root, 'worktrees', 'agent-1');
  await mkdir(path.join(worktree, 'src'), { recursive: true });
  await writeFile(path.join(worktree, 'src', 'module.py'), 'value = 2\n');
  await writeFile(path.join(worktree, 'pyproject.toml'), '[tool.pyright]\n');
  await writeFile(path.join(worktree, 'tsconfig.json'), '{}\n');
  await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/agent-1\n');

  const clone = path.join(root, 'vendor', 'library');
  await mkdir(path.join(clone, '.git'), { recursive: true });
  await writeFile(path.join(clone, 'pyproject.toml'), '[tool.pyright]\n');

  // An agent worktree can be a plain copy of a subdirectory, carrying no git
  // marker of its own. Observed at .claude/worktrees/agent-<id>/poker-arena.
  const copied = path.join(root, '.claude', 'worktrees', 'agent-2', 'package');
  await mkdir(path.join(copied, 'src'), { recursive: true });
  await writeFile(path.join(copied, 'src', 'module.py'), 'value = 3\n');
  await writeFile(path.join(copied, 'pyproject.toml'), '[tool.pyright]\n');
  return root;
}

test('a nested checkout is ignored wherever it sits, and the project root itself is not', async () => {
  const root = await checkoutTree();
  try {
    assert.equal(await isIgnoredDirectory(path.join(root, 'worktrees')), true);
    assert.equal(await isIgnoredDirectory(path.join(root, 'worktrees', 'agent-1')), true);
    assert.equal(await isIgnoredDirectory(path.join(root, 'vendor', 'library')), true);
    assert.equal(await isIgnoredDirectory(path.join(root, 'src')), false);

    // The root carries a `.git` of its own, and the walk must never exclude the
    // project it was asked about.
    assert.deepEqual(
      (await ignoredDirectoriesUnder(root)).map((directory) => path.relative(root, directory).replaceAll('\\', '/')),
      ['.claude/worktrees', 'vendor/library', 'worktrees'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('project discovery never returns a project from a nested checkout', async () => {
  const root = await checkoutTree();
  try {
    // The only pyproject.toml files live in the checkouts, so finding none is
    // what makes discovery fall back to the root's own source layout.
    const pythonRoots = (await discoverPythonProjects(root)).map((project) => path.relative(root, project.root));
    assert.deepEqual(pythonRoots, ['src']);

    const typeScriptConfigs = (await discoverProjects(root))
      .map((project) => path.relative(root, project.configFile ?? '').replaceAll('\\', '/'));
    assert.deepEqual(typeScriptConfigs, ['tsconfig.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a virtual environment is ignored by its marker rather than its name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-venv-marker-'));
  try {
    const environment = path.join(root, 'python-3.12');
    await mkdir(environment, { recursive: true });
    await writeFile(path.join(environment, 'pyvenv.cfg'), 'home = /usr\n');
    assert.equal(await isIgnoredDirectory(environment), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
