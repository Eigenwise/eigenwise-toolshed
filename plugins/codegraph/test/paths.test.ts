import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  codegraphStateRoot,
  normalizeProjectRelativePath,
  projectIdentity,
  projectStateDirectory,
  runtimeCacheDirectory,
} from '../src/lib/paths.ts';

const pluginRoot = process.cwd();

test('normalizes stored project paths to relative POSIX paths', () => {
  assert.equal(normalizeProjectRelativePath('src\\graph\\model.ts'), 'src/graph/model.ts');
  assert.equal(normalizeProjectRelativePath('./src/../src/model.ts'), 'src/model.ts');
  assert.throws(() => normalizeProjectRelativePath('../outside.ts'));
  assert.throws(() => normalizeProjectRelativePath('C:\\outside.ts'));
  assert.throws(() => normalizeProjectRelativePath('/outside.ts'));
});

test('project identity is stable across equivalent roots', () => {
  assert.equal(
    projectIdentity(path.join('fixture', 'project', '..', 'project')),
    projectIdentity(path.join('fixture', 'project')),
  );
});

test('project identity ignores Windows root casing', { skip: process.platform !== 'win32' }, () => {
  assert.equal(
    projectIdentity('C:\\Codegraph\\Project'),
    projectIdentity('c:\\codegraph\\project'),
  );
});

test('project identity resolves Windows junctions to their target', { skip: process.platform !== 'win32' }, async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codegraph-project-identity-'));
  const targetRoot = path.join(fixtureRoot, 'target');
  const junctionRoot = path.join(fixtureRoot, 'junction');
  try {
    await mkdir(targetRoot);
    await symlink(targetRoot, junctionRoot, 'junction');
    assert.equal(projectIdentity(junctionRoot), projectIdentity(targetRoot));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('state directories use the explicit test override', () => {
  const environment = { CODEGRAPH_STATE_DIR: path.join('state', 'override') };
  const stateRoot = codegraphStateRoot(environment, path.join('home', 'user'));

  assert.equal(stateRoot, path.resolve('state', 'override'));
  assert.equal(
    projectStateDirectory('fixture/project', environment, path.join('home', 'user')),
    path.join(stateRoot, 'projects', projectIdentity('fixture/project')),
  );
  assert.equal(
    runtimeCacheDirectory('7.0.2', 'win32', 'x64', environment, path.join('home', 'user')),
    path.join(stateRoot, 'runtime', '7.0.2', 'win32-x64'),
  );
});

test('committed build output has no drift', () => {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, 'scripts', 'build-check.mjs')], {
    cwd: pluginRoot,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
});
