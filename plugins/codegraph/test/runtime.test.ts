import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NpmRuntimeInstaller,
  reclaimObservedRuntimeLock,
  recoverLegacyRuntimeReclaim,
  recoverRuntimeReclaim,
  resolveNpmCliPath,
  runtimePlatformPackage,
  SemanticRuntimeError,
  TypeScriptRuntimeAcquirer,
  UnsupportedRuntimePlatformError,
  type RuntimeInstaller,
} from '../src/lib/runtime.ts';

const pluginRoot = process.cwd();
const runtimeManifestDirectory = path.join(pluginRoot, 'runtime');
const fixtureRuntimeDirectory = path.join(pluginRoot, 'test', 'fixtures', 'runtime');
const fixtureAcquirerScript = path.join(fixtureRuntimeDirectory, 'acquire-runtime.mjs');
const fixtureCrashReclaimScript = path.join(fixtureRuntimeDirectory, 'crash-after-reclaim.mjs');
const unconfirmedReclaimResponses = [
  { behavior: 'wrong', description: 'wrong nonce' },
  { behavior: 'empty', description: 'immediate EOF with an empty response' },
  { behavior: 'truncated', description: 'truncated nonce' },
  { behavior: 'trailing', description: 'nonce with trailing bytes' },
] as const;
let fixtureManifestDirectory = '';

function acquireRuntimeInSeparateProcess(
  stateDirectory: string,
  runtimeManifestDirectory: string,
  installRecordFile: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, [fixtureAcquirerScript, stateDirectory, runtimeManifestDirectory, installRecordFile, '100'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let standardError = '';
    childProcess.stderr.on('data', (data: Buffer) => {
      standardError += data.toString();
    });
    childProcess.once('error', reject);
    childProcess.once('exit', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`fixture runtime acquirer exited ${exitCode}: ${standardError}`));
      }
    });
  });
}

function crashAfterRuntimeReclaimClaim(
  mode: 'generated' | 'legacy',
  lockDirectory: string,
  ownerToken?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const childArguments = [fixtureCrashReclaimScript, mode, lockDirectory];
    if (ownerToken !== undefined) childArguments.push(ownerToken);
    const childProcess = spawn(process.execPath, childArguments, { stdio: ['ignore', 'ignore', 'pipe'] });
    let standardError = '';
    childProcess.stderr.on('data', (data: Buffer) => {
      standardError += data.toString();
    });
    childProcess.once('error', reject);
    childProcess.once('exit', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`crash reclaim fixture exited ${exitCode}: ${standardError}`));
      }
    });
  });
}

function holdAfterRuntimeReclaimClaim(
  mode: 'generated' | 'legacy',
  lockDirectory: string,
  ownerToken?: string,
  behavior: 'hold' | 'silent' | 'wrong' | 'empty' | 'truncated' | 'trailing' = 'hold',
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(
      process.execPath,
      [fixtureCrashReclaimScript, mode, lockDirectory, ownerToken ?? '', behavior],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let standardError = '';
    let ready = false;
    childProcess.stderr.on('data', (data: Buffer) => {
      standardError += data.toString();
    });
    childProcess.stdout.on('data', (data: Buffer) => {
      if (ready || !data.toString().includes('claimed')) return;
      ready = true;
      resolve(async () => {
        if (childProcess.exitCode !== null) return;
        const exited = new Promise<void>((exitResolve) => childProcess.once('exit', () => exitResolve()));
        childProcess.kill();
        await exited;
      });
    });
    childProcess.once('error', reject);
    childProcess.once('exit', (exitCode) => {
      if (!ready) reject(new Error(`live reclaim fixture exited ${exitCode}: ${standardError}`));
    });
  });
}

async function fixtureModuleIntegrity(): Promise<string> {
  const moduleContent = await readFile(path.join(fixtureRuntimeDirectory, 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js'));
  return `sha512-${createHash('sha512').update(moduleContent).digest('base64')}`;
}

test.before(async () => {
  fixtureManifestDirectory = await temporaryDirectory('codegraph-runtime-fixture-manifest-');
  await cp(runtimeManifestDirectory, fixtureManifestDirectory, { recursive: true });
  const manifestPath = path.join(fixtureManifestDirectory, 'integrity.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(
    manifestPath,
    manifest
      .replace(/"moduleIntegrity": "[^"]+"/, `"moduleIntegrity": "${await fixtureModuleIntegrity()}"`)
      .replace(/"installedTreeIntegrity": \{[\s\S]*?\n  \},\n  "packages"/, '"installedTreeIntegrity": {\n    "win32-x64": "sha512-JijYZfgG9Rs9+ZIwmYWZ6ZWUORj+2bAl+rDdKZa0PSie6xD2ryUM9YrH/YE/lMGUg5zJMRp9Bgfiu8Czo0TRMA=="\n  },\n  "packages"'),
    'utf8',
  );
});

test.after(async () => {
  await rm(fixtureManifestDirectory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function currentRuntimeDirectory(stateDirectory: string): Promise<string> {
  const cacheDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64');
  const pointer = JSON.parse(await readFile(path.join(cacheDirectory, 'current.json'), 'utf8')) as { generation: string };
  return path.join(cacheDirectory, 'generations', pointer.generation);
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

function createAcquirer(
  stateDirectory: string,
  installer: RuntimeInstaller,
  manifestDirectory = fixtureManifestDirectory,
) {
  return new TypeScriptRuntimeAcquirer({
    architecture: 'x64',
    installer,
    platform: 'win32',
    runtimeManifestDirectory: manifestDirectory,
    stateDirectory,
  });
}

test('resolves npm CLI candidates from injected Windows and Unix runtime layouts', async () => {
  const runtimeDirectory = await temporaryDirectory('codegraph-npm-runtime-');
  try {
    const layouts = [
      {
        nodeExecutablePath: path.join(runtimeDirectory, 'windows', 'node.exe'),
        npmCliPath: path.join(runtimeDirectory, 'windows', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      },
      {
        nodeExecutablePath: path.join(runtimeDirectory, 'unix', 'bin', 'node'),
        npmCliPath: path.join(runtimeDirectory, 'unix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      },
      {
        nodeExecutablePath: path.join(runtimeDirectory, 'debian', 'bin', 'node'),
        npmCliPath: path.join(runtimeDirectory, 'debian', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
      },
    ];
    for (const layout of layouts) {
      await mkdir(path.dirname(layout.npmCliPath), { recursive: true });
      await writeFile(layout.npmCliPath, '', 'utf8');
      assert.equal(await resolveNpmCliPath(layout.nodeExecutablePath), layout.npmCliPath);
    }
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test('names every npm CLI candidate when no layout matches', async () => {
  const nodeExecutablePath = path.join('missing', 'bin', 'node');
  const expectedCandidates = [
    path.join('missing', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join('missing', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join('missing', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ];
  await assert.rejects(
    resolveNpmCliPath(nodeExecutablePath),
    (error: unknown) => {
      assert.ok(error instanceof SemanticRuntimeError);
      assert.equal(error.message, `npm CLI was not found; checked: ${expectedCandidates.join(', ')}`);
      return true;
    },
  );
});

test('surfaces failed npm install output', async () => {
  const stageDirectory = await temporaryDirectory('codegraph-npm-stage-');
  const npmCliScript = path.join(stageDirectory, 'failing-npm-cli.js');
  try {
    await writeFile(npmCliScript, "process.stdout.write('npm install output\\n'); process.stderr.write('npm install error\\n'); process.exit(19);", 'utf8');

    await assert.rejects(
      new NpmRuntimeInstaller({ npmCliPath: npmCliScript }).install(stageDirectory, fixtureManifestDirectory),
      (error: unknown) => {
        assert.ok(error instanceof SemanticRuntimeError);
        assert.match(error.message, /npm install output/);
        assert.match(error.message, /npm install error/);
        assert.match(error.message, /cwd:/);
        assert.match(error.message, /exit code: 19/);
        return true;
      },
    );
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
});

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

test('repairs a cached runtime whose ESM entrypoint content was changed', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    await createAcquirer(stateDirectory, installer).acquire();
    const modulePath = path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js');
    await writeFile(modulePath, 'export const semanticRuntimeFixture = false;\n', 'utf8');

    await createAcquirer(stateDirectory, installer).acquire();

    assert.equal(installer.calls, 2);
    assert.match(await readFile(path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js'), 'utf8'), /semanticRuntimeFixture = true/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('repairs a cached runtime after a TypeScript import-map tamper', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    await createAcquirer(stateDirectory, installer).acquire();
    const packagePath = path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'package.json');
    const packageMetadata = await readFile(packagePath, 'utf8');
    await writeFile(packagePath, packageMetadata.replace('./dist/api/sync/api.js', '#enums/completionItemKind'), 'utf8');

    await createAcquirer(stateDirectory, installer).acquire();

    assert.equal(installer.calls, 2);
    assert.match(await readFile(path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'package.json'), 'utf8'), /dist\/api\/sync\/api\.js/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('validates acquired runtime bytes without dynamically executing them', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    await createAcquirer(stateDirectory, installer).acquire();
    const modulePath = path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js');
    await writeFile(modulePath, 'throw new Error("runtime-tamper-executed");\n', 'utf8');

    await createAcquirer(stateDirectory, installer).acquire();

    assert.equal(installer.calls, 2);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('rejects a runtime lock whose integrity differs from the committed manifest', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const manifestDirectory = await temporaryDirectory('codegraph-runtime-manifest-');
  const installer = new FixtureInstaller();
  try {
    await cp(fixtureManifestDirectory, manifestDirectory, { recursive: true });
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

test('maps malformed runtime metadata to a typed acquisition failure', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const manifestDirectory = await temporaryDirectory('codegraph-runtime-manifest-');
  try {
    await cp(fixtureManifestDirectory, manifestDirectory, { recursive: true });
    await writeFile(path.join(manifestDirectory, 'integrity.json'), '{', 'utf8');
    await assert.rejects(createAcquirer(stateDirectory, new FixtureInstaller(), manifestDirectory).acquire(), SemanticRuntimeError);
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
    engine: {
      id: 'typescript',
      module: 'typescript/unstable/sync',
      moduleFile: 'dist/api/sync/api.js',
      moduleIntegrity: 'sha512-test',
      version: '7.0.2',
    },
    installedTreeIntegrity: {},
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
      runtimeManifestDirectory: fixtureManifestDirectory,
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
      await readFile(path.join(await currentRuntimeDirectory(stateDirectory), 'node_modules', 'typescript', 'package.json'), 'utf8'),
      /7\.0\.2/,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('separate processes serialize cache acquisition', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installRecordFile = path.join(stateDirectory, 'install-record.txt');
  try {
    await Promise.all([
      acquireRuntimeInSeparateProcess(stateDirectory, fixtureManifestDirectory, installRecordFile),
      acquireRuntimeInSeparateProcess(stateDirectory, fixtureManifestDirectory, installRecordFile),
    ]);
    assert.equal((await readFile(installRecordFile, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('a stale holder cannot replace a cache published by its successor', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const cacheDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64');
  const installRecordFile = path.join(stateDirectory, 'successor-install.txt');
  let releaseFirstInstall: (() => void) | undefined;
  const firstInstallReady = new Promise<void>((resolve) => {
    releaseFirstInstall = resolve;
  });
  let signalFirstInstall: (() => void) | undefined;
  const firstInstallStarted = new Promise<void>((resolve) => {
    signalFirstInstall = resolve;
  });
  const firstInstaller = new FixtureInstaller(async () => {
    signalFirstInstall?.();
    await firstInstallReady;
  });
  const verifierInstaller = new FixtureInstaller();
  try {
    await cp(path.join(fixtureRuntimeDirectory, 'node_modules'), path.join(cacheDirectory, 'node_modules'), { recursive: true });
    await writeFile(path.join(cacheDirectory, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript","version":"partial"}', 'utf8');

    const firstAcquisition = createAcquirer(stateDirectory, firstInstaller).acquire();
    await firstInstallStarted;
    const ownerToken = await readFile(path.join(`${cacheDirectory}.lock`, 'owner'), 'utf8');
    await utimes(path.join(`${cacheDirectory}.lock`, `owner-${ownerToken}`), new Date(0), new Date(0));

    await acquireRuntimeInSeparateProcess(stateDirectory, fixtureManifestDirectory, installRecordFile);
    const successorRuntimeDirectory = await currentRuntimeDirectory(stateDirectory);
    releaseFirstInstall?.();
    await firstAcquisition;
    assert.equal(await currentRuntimeDirectory(stateDirectory), successorRuntimeDirectory);

    await createAcquirer(stateDirectory, verifierInstaller).acquire();
    assert.equal((await readFile(installRecordFile, 'utf8')).trim().split('\n').length, 1);
    assert.equal(verifierInstaller.calls, 0);
  } finally {
    releaseFirstInstall?.();
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

test('recovers an empty runtime lock left by a crashed owner', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  try {
    await mkdir(path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock'), { recursive: true });
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('recovers a runtime lock with an owner but no heartbeat after a crash', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const installer = new FixtureInstaller();
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), '123e4567-e89b-12d3-a456-426614174000', 'utf8');
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('keeps a live generated reclaim claim and recovers it after exact process death', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const ownerToken = '123e4567-e89b-12d3-a456-426614174000';
  const installer = new FixtureInstaller();
  let stopReclaimer: (() => Promise<void>) | undefined;
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), ownerToken, 'utf8');
    await writeFile(path.join(lockDirectory, `generation-${ownerToken}`), ownerToken, 'utf8');
    const heartbeatFile = path.join(lockDirectory, `owner-${ownerToken}`);
    await writeFile(heartbeatFile, ownerToken, 'utf8');
    await utimes(heartbeatFile, new Date(0), new Date(0));

    stopReclaimer = await holdAfterRuntimeReclaimClaim('generated', lockDirectory, ownerToken);
    assert.equal(await recoverRuntimeReclaim(lockDirectory), 'active');
    assert.equal(await readFile(path.join(lockDirectory, 'owner'), 'utf8'), ownerToken);

    await stopReclaimer();
    stopReclaimer = undefined;
    assert.equal(await recoverRuntimeReclaim(lockDirectory), 'reclaimed');
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await stopReclaimer?.();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('preserves a silent generated reclaim claim and fails acquisition within the identity probe bound', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const ownerToken = '123e4567-e89b-12d3-a456-426614174000';
  const installer = new FixtureInstaller();
  let stopReclaimer: (() => Promise<void>) | undefined;
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), ownerToken, 'utf8');
    await writeFile(path.join(lockDirectory, `generation-${ownerToken}`), ownerToken, 'utf8');
    const heartbeatFile = path.join(lockDirectory, `owner-${ownerToken}`);
    await writeFile(heartbeatFile, ownerToken, 'utf8');
    await utimes(heartbeatFile, new Date(0), new Date(0));

    stopReclaimer = await holdAfterRuntimeReclaimClaim('generated', lockDirectory, ownerToken, 'silent');
    assert.equal(await recoverRuntimeReclaim(lockDirectory), 'unknown');
    const startedAt = Date.now();
    await assert.rejects(
      createAcquirer(stateDirectory, installer).acquire(),
      (error: unknown) => error instanceof SemanticRuntimeError && /claim was preserved/.test(error.message),
    );
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(await readFile(path.join(lockDirectory, 'owner'), 'utf8'), ownerToken);
    assert.equal(installer.calls, 0);
  } finally {
    await stopReclaimer?.();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

for (const response of unconfirmedReclaimResponses) {
  test(`preserves a generated claim after a ${response.description} response`, async () => {
    const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
    const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
    const ownerToken = '123e4567-e89b-12d3-a456-426614174000';
    let stopReclaimer: (() => Promise<void>) | undefined;
    try {
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(path.join(lockDirectory, 'owner'), ownerToken, 'utf8');
      await writeFile(path.join(lockDirectory, `generation-${ownerToken}`), ownerToken, 'utf8');
      const heartbeatFile = path.join(lockDirectory, `owner-${ownerToken}`);
      await writeFile(heartbeatFile, ownerToken, 'utf8');
      await utimes(heartbeatFile, new Date(0), new Date(0));

      stopReclaimer = await holdAfterRuntimeReclaimClaim('generated', lockDirectory, ownerToken, response.behavior);
      assert.equal(await recoverRuntimeReclaim(lockDirectory), 'unknown');
      assert.equal(await readFile(path.join(lockDirectory, 'owner'), 'utf8'), ownerToken);
      assert.equal(await recoverRuntimeReclaim(lockDirectory), 'unknown');
    } finally {
      await stopReclaimer?.();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
}

test('recovers when a generated-lock reclaimer crashes after claiming a now-closed port', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const ownerToken = '123e4567-e89b-12d3-a456-426614174000';
  const installer = new FixtureInstaller();
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), ownerToken, 'utf8');
    await writeFile(path.join(lockDirectory, `generation-${ownerToken}`), ownerToken, 'utf8');
    const heartbeatFile = path.join(lockDirectory, `owner-${ownerToken}`);
    await writeFile(heartbeatFile, ownerToken, 'utf8');
    await utimes(heartbeatFile, new Date(0), new Date(0));
    await crashAfterRuntimeReclaimClaim('generated', lockDirectory, ownerToken);

    assert.equal(await recoverRuntimeReclaim(lockDirectory), 'reclaimed');
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('keeps a live legacy reclaim claim and recovers it after exact process death', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const installer = new FixtureInstaller();
  let stopReclaimer: (() => Promise<void>) | undefined;
  try {
    await mkdir(lockDirectory, { recursive: true });
    stopReclaimer = await holdAfterRuntimeReclaimClaim('legacy', lockDirectory);
    assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'active');

    await stopReclaimer();
    stopReclaimer = undefined;
    assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'reclaimed');
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await stopReclaimer?.();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('preserves a silent legacy reclaim claim and fails acquisition within the identity probe bound', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const installer = new FixtureInstaller();
  let stopReclaimer: (() => Promise<void>) | undefined;
  try {
    await mkdir(lockDirectory, { recursive: true });
    stopReclaimer = await holdAfterRuntimeReclaimClaim('legacy', lockDirectory, undefined, 'silent');
    const claimBeforeProbe = await readFile(path.join(lockDirectory, 'legacy-reclaim'), 'utf8');
    assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'unknown');
    const startedAt = Date.now();
    await assert.rejects(
      createAcquirer(stateDirectory, installer).acquire(),
      (error: unknown) => error instanceof SemanticRuntimeError && /claim was preserved/.test(error.message),
    );
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(await readFile(path.join(lockDirectory, 'legacy-reclaim'), 'utf8'), claimBeforeProbe);
    assert.equal(installer.calls, 0);
  } finally {
    await stopReclaimer?.();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

for (const response of unconfirmedReclaimResponses) {
  test(`preserves a legacy claim after a ${response.description} response`, async () => {
    const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
    const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
    let stopReclaimer: (() => Promise<void>) | undefined;
    try {
      await mkdir(lockDirectory, { recursive: true });
      stopReclaimer = await holdAfterRuntimeReclaimClaim('legacy', lockDirectory, undefined, response.behavior);
      const claimBeforeProbe = await readFile(path.join(lockDirectory, 'legacy-reclaim'), 'utf8');
      assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'unknown');
      assert.equal(await readFile(path.join(lockDirectory, 'legacy-reclaim'), 'utf8'), claimBeforeProbe);
      assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'unknown');
    } finally {
      await stopReclaimer?.();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
}

test('recovers when an ownerless-lock reclaimer crashes after publishing a claim with a now-closed port', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const installer = new FixtureInstaller();
  try {
    await mkdir(lockDirectory, { recursive: true });
    await crashAfterRuntimeReclaimClaim('legacy', lockDirectory);

    assert.equal(await recoverLegacyRuntimeReclaim(lockDirectory), 'reclaimed');
    await createAcquirer(stateDirectory, installer).acquire();
    assert.equal(installer.calls, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('a forced A/B/C interleaving cannot reclaim B from C stale observation of A', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const cacheDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64');
  const lockDirectory = `${cacheDirectory}.lock`;
  const staleOwnerToken = '123e4567-e89b-12d3-a456-426614174000';
  let signalReplacementInstall: (() => void) | undefined;
  const replacementInstallStarted = new Promise<void>((resolve) => {
    signalReplacementInstall = resolve;
  });
  let releaseReplacementInstall: (() => void) | undefined;
  const replacementInstallReleased = new Promise<void>((resolve) => {
    releaseReplacementInstall = resolve;
  });
  const replacementInstaller = new FixtureInstaller(async () => {
    signalReplacementInstall?.();
    await replacementInstallReleased;
  });
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), staleOwnerToken, 'utf8');
    await writeFile(path.join(lockDirectory, `generation-${staleOwnerToken}`), staleOwnerToken, 'utf8');
    const staleHeartbeat = path.join(lockDirectory, `owner-${staleOwnerToken}`);
    await writeFile(staleHeartbeat, staleOwnerToken, 'utf8');
    await utimes(staleHeartbeat, new Date(0), new Date(0));

    const replacementAcquisition = createAcquirer(stateDirectory, replacementInstaller).acquire();
    await replacementInstallStarted;
    const replacementOwnerToken = await readFile(path.join(lockDirectory, 'owner'), 'utf8');
    assert.notEqual(replacementOwnerToken, staleOwnerToken);

    assert.equal(await reclaimObservedRuntimeLock(lockDirectory, staleOwnerToken), false);
    assert.equal(await readFile(path.join(lockDirectory, 'owner'), 'utf8'), replacementOwnerToken);

    releaseReplacementInstall?.();
    await replacementAcquisition;
    assert.equal(replacementInstaller.calls, 1);
  } finally {
    releaseReplacementInstall?.();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('concurrent contenders reclaim an owner-only crash lock without stealing the winner lease', async () => {
  const stateDirectory = await temporaryDirectory('codegraph-runtime-state-');
  const lockDirectory = path.join(stateDirectory, 'runtime', '7.0.2', 'win32-x64.lock');
  const installRecordFile = path.join(stateDirectory, 'install-record.txt');
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, 'owner'), '123e4567-e89b-12d3-a456-426614174000', 'utf8');
    await Promise.all([
      acquireRuntimeInSeparateProcess(stateDirectory, fixtureManifestDirectory, installRecordFile),
      acquireRuntimeInSeparateProcess(stateDirectory, fixtureManifestDirectory, installRecordFile),
    ]);
    assert.equal((await readFile(installRecordFile, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
