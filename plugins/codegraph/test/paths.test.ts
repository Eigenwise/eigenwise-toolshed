import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
