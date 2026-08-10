import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverPythonProjects } from '../src/lib/languages/python/projects.ts';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'python-discovery');

test('discovers Python pyproject projects with source and stub inputs', async () => {
  const projects = await discoverPythonProjects(path.join(fixtureRoot, 'src-layout'));

  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.language, 'python');
  assert.equal(path.basename(projects[0]?.configFile ?? ''), 'pyproject.toml');
});

test('ignores Python projects nested in dot-directories', async () => {
  const projects = await discoverPythonProjects(path.join(fixtureRoot, 'dot-directory'));

  assert.deepEqual(projects.map((project) => path.relative(path.join(fixtureRoot, 'dot-directory'), project.root)), ['']);
});

test('uses source roots and a deterministic namespace-package fallback without configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-python-source-root-'));
  try {
    await mkdir(path.join(root, 'src', 'package'), { recursive: true });
    await writeFile(path.join(root, 'src', 'package', 'module.py'), 'value = 1\n');
    const sourceProjects = await discoverPythonProjects(root);
    assert.equal(sourceProjects.length, 1);
    assert.equal(path.basename(sourceProjects[0]!.root), 'src');

    const namespaceProjects = await discoverPythonProjects(path.join(fixtureRoot, 'namespace'));
    assert.equal(namespaceProjects.length, 1);
    assert.equal(path.basename(namespaceProjects[0]!.root), 'namespace');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prefers pyrightconfig and returns configured projects in path order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-python-configured-'));
  try {
    await mkdir(path.join(root, 'package'), { recursive: true });
    await writeFile(path.join(root, 'package', 'pyrightconfig.json'), '{}\n');
    await writeFile(path.join(root, 'package', 'pyproject.toml'), '[project]\nrequires-python = ">=3.11"\n');
    await writeFile(path.join(root, 'package', 'module.py'), 'value = 1\n');
    const projects = await discoverPythonProjects(root);
    assert.deepEqual(projects.map((project) => path.basename(project.configFile ?? '')), ['pyrightconfig.json']);

    const ordered = await discoverPythonProjects(path.join(fixtureRoot, 'ordered'));
    assert.deepEqual(ordered.map((project) => project.configFile?.replaceAll('\\', '/').split('/').slice(-2).join('/')), [
      'a/pyrightconfig.json',
      'b/pyrightconfig.json',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
