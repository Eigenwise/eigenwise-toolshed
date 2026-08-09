import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimePlatformPackage } from '../src/lib/runtime.ts';

const pluginRoot = process.cwd();
const runtimeManifest = path.join(pluginRoot, 'runtime');
const runtimeFixture = path.join(pluginRoot, 'test', 'fixtures', 'runtime');
const runner = path.join(pluginRoot, 'scripts', 'test-full.mjs');
const fixtureTreeIntegrity = 'sha512-JijYZfgG9Rs9+ZIwmYWZ6ZWUORj+2bAl+rDdKZa0PSie6xD2ryUM9YrH/YE/lMGUg5zJMRp9Bgfiu8Czo0TRMA==';

async function prepareManifest(directory: string): Promise<void> {
  await cp(runtimeManifest, directory, { recursive: true });
  const manifestPath = path.join(directory, 'integrity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    engine: { moduleIntegrity: string };
    platformPackages: Record<string, string>;
    installedTreeIntegrity: Record<string, string>;
  };
  const moduleBytes = await readFile(path.join(runtimeFixture, 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js'));
  manifest.engine.moduleIntegrity = `sha512-${createHash('sha512').update(moduleBytes).digest('base64')}`;
  for (const platform of Object.keys(manifest.platformPackages)) manifest.platformPackages[platform] = '@typescript/typescript-win32-x64';
  for (const platform of Object.keys(manifest.installedTreeIntegrity)) manifest.installedTreeIntegrity[platform] = fixtureTreeIntegrity;
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
}

test('fresh install acquires from a local package source on the host platform and reuses its cache', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'codegraph-fresh-install-'));
  const manifestDirectory = path.join(parent, 'manifest');
  const stateDirectory = path.join(parent, 'state');
  try {
    await prepareManifest(manifestDirectory);
    const first = spawnSync(process.execPath, [runner, manifestDirectory, runtimeFixture, stateDirectory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { engineId: 'typescript', engineVersion: '7.0.2' });
    const second = spawnSync(process.execPath, [runner, manifestDirectory, runtimeFixture, stateDirectory], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { engineId: 'typescript', engineVersion: '7.0.2' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('runtime platform mapping covers CI host architectures and rejects unsupported targets', () => {
  const manifest = {
    engine: { id: 'typescript', version: '7.0.2', module: 'typescript/unstable/sync', moduleFile: 'dist/api/sync/api.js', moduleIntegrity: 'sha512-test' },
    installedTreeIntegrity: {},
    packages: { '@typescript/typescript-win32-x64': { version: '7.0.2', integrity: 'sha512-test' } },
    platformPackages: { 'win32-x64': '@typescript/typescript-win32-x64', 'linux-x64': '@typescript/typescript-win32-x64', 'darwin-arm64': '@typescript/typescript-win32-x64' },
  };
  assert.equal(runtimePlatformPackage(manifest, process.platform, process.arch), '@typescript/typescript-win32-x64');
  assert.throws(() => runtimePlatformPackage(manifest, 'linux', 's390x'));
});
