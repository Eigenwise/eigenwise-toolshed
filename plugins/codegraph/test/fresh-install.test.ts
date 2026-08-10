import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimePlatformPackage, TypeScriptRuntimeAcquirer } from '../src/lib/runtime.ts';

const pluginRoot = process.cwd();
const runtimeManifest = path.join(pluginRoot, 'runtime');

test('fresh install acquires the pinned runtime from npm in two isolated state directories', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'codegraph-fresh-install-'));
  try {
    const first = await new TypeScriptRuntimeAcquirer({
      runtimeManifestDirectory: runtimeManifest,
      stateDirectory: path.join(parent, 'first-state'),
    }).acquire();
    assert.equal(first.engineId, 'typescript');
    assert.equal(first.engineVersion, '7.0.2');

    const second = await new TypeScriptRuntimeAcquirer({
      runtimeManifestDirectory: runtimeManifest,
      stateDirectory: path.join(parent, 'second-state'),
    }).acquire();
    assert.equal(second.engineId, 'typescript');
    assert.equal(second.engineVersion, '7.0.2');
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
