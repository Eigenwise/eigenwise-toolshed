import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runtimePlatformPackage,
  SemanticRuntimeError,
  TypeScriptRuntimeAcquirer,
  UnsupportedRuntimePlatformError,
  type RuntimeInstaller,
} from '../src/lib/runtime.ts';

const pluginRoot = process.cwd();
const runtimeManifestDirectory = path.join(pluginRoot, 'runtime');
const fixtureRuntimeDirectory = path.join(pluginRoot, 'test', 'fixtures', 'runtime');

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

class FixtureInstaller implements RuntimeInstaller {
  calls = 0;
  private readonly mutate?: (stageDirectory: string) => Promise<void>;

  constructor(mutate?: (stageDirectory: string) => Promise<void>) {
    this.mutate = mutate;
  }

  async install(stageDirectory: string): Promise<void> {
    this.calls += 1;
    await cp(path.join(fixtureRuntimeDirectory, 'node_modules'), path.join(stageDirectory, 'node_modules'), { recursive: true });
    await this.mutate?.(stageDirectory);
  }
}

function createAcquirer(stateDirectory: string, installer: RuntimeInstaller, manifestDirectory = runtimeManifestDirectory) {
  return new TypeScriptRuntimeAcquirer({
    architecture: 'x64',
    installer,
    platform: 'win32',
    runtimeManifestDirectory: manifestDirectory,
    stateDirectory,
  });
}

test('acquires the pinned runtime from a local fixture and reuses the complete cache', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    const runtime = await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(runtime.engineId, 'typescript');
    assert.equal(runtime.engineVersion, '7.0.2');
    assert.deepEqual(runtime.extractors, []);
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('rejects a runtime lock whose integrity differs from the committed manifest', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const manifestDirectory = await temporaryDirectory('codegraph-runtime-manifest-');
  const installer = new FixtureInstaller();
  try {
    await cp(runtimeManifestDirectory, manifestDirectory, { recursive: true });
    const lockPath = path.join(manifestDirectory, 'package-lock.json');
    const lock = await readFile(lockPath, 'utf8');
    await writeFile(lockPath, lock.replace('sha512-8FYau96o3', 'sha512-rejected'), 'utf8');

    await assert.rejects(createAcquirer(stateDirectory, installer, manifestDirectory).acquire(), SemanticRuntimeError);
    assert.equal(installer.calls, 0);
  } finally {
    await Promise.all([
      rm(stateDirectory, { recursive: true, force: true }),
      rm(manifestDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('rejects an installed runtime with the wrong package version without publishing its stage', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller(async (stageDirectory) => {
    await writeFile(
      path.join(stageDirectory, 'node_modules', 'typescript', 'package.json'),
      '{"name":"typescript","version":"7.0.1"}',
      'utf8',
    );
  });
  try {
    await assert.rejects(createAcquirer(stateDirectory, installer).acquire(), SemanticRuntimeError);
    const cacheDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64');
    await assert.rejects(readFile(path.join(cacheDirectory, 'node_modules', 'typescript', 'package.json')));
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('maps supported platforms and rejects unsupported combinations before installation', async () => {
  const manifest = {
    engine: { id: 'typescript', module: 'typescript/unstable/sync', version: '7.0.2' },
    packages: {},
    platformPackages: {
      'darwin-arm64': '@typescript/typescript-darwin-arm64',
      'linux-x64': '@typescript/typescript-linux-x64',
      'win32-x64': '@typescript/typescript-win32-x64',
    },
  };
  assert.equal(runtimePlatformPackage(manifest, 'darwin', 'arm64'), '@typescript/typescript-darwin-arm64');
  assert.throws(() => runtimePlatformPackage(manifest, 'linux', 's390x'), UnsupportedRuntimePlatformError);

  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    const acquirer = new TypeScriptRuntimeAcquirer({
      architecture: 's390x',
      installer,
      platform: 'linux',
      runtimeManifestDirectory,
      stateDirectory,
    });
    await assert.rejects(acquirer.acquire(), UnsupportedRuntimePlatformError);
    assert.equal(installer.calls, 0);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('leaves no cache after an interrupted stage and recovers a partial cache on the next attempt', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const interruptedInstaller = new FixtureInstaller(async () => {
    throw new Error('interrupted download');
  });
  try {
    await assert.rejects(createAcquirer(stateDirectory, interruptedInstaller).acquire(), /interrupted download/);
    const cacheDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64');
    await assert.rejects(readFile(path.join(cacheDirectory, 'node_modules', 'typescript', 'package.json')));

    await cp(path.join(fixtureRuntimeDirectory, 'node_modules'), path.join(cacheDirectory, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(cacheDirectory, 'node_modules', 'typescript', 'package.json'),
      '{"name":"typescript","version":"partial"}',
      'utf8',
    );

    const recoveryInstaller = new FixtureInstaller();
    await createAcquirer(stateDirectory, recoveryInstaller).acquire();
    assert.equal(recoveryInstaller.calls, 1);
    assert.match(
      await readFile(path.join(cacheDirectory, 'node_modules', 'typescript', 'package.json'), 'utf8'),
      /7\.0\.2/,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('concurrent callers share one acquisition', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  let unblockInstall: (() => void) | undefined;
  const installStarted = new Promise<void>((resolve) => {
    unblockInstall = resolve;
  });
  let continueInstall: (() => void) | undefined;
  const releaseInstall = new Promise<void>((resolve) => {
    continueInstall = resolve;
  });
  const installer = new FixtureInstaller(async () => {
    unblockInstall?.();
    await releaseInstall;
  });
  try {
    const acquirer = createAcquirer(stateDirectory, installer);
    const first = acquirer.acquire();
    await installStarted;
    const second = acquirer.acquire();
    continueInstall?.();
    await Promise.all([first, second]);
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
