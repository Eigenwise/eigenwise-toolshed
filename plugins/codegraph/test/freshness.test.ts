import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest, snapshotIsFresh } from '../src/lib/freshness.ts';

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-'));
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
  return root;
}

test('manifest includes inherited local TypeScript configuration files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-extends-'));
  try {
    await writeFile(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ES2020' } }));
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['entry.ts'] }));
    await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
    const original = await buildRelevantInputManifest(root);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(original.inputs.some((input) => input.path === 'base.json' && input.configuration), true);
    await writeFile(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ESNext' } }));
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest includes package-resolved TypeScript configuration files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-package-'));
  try {
    const packageDirectory = path.join(root, 'node_modules', '@fixture');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020' } }));
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '@fixture/tsconfig.json', files: ['entry.ts'] }));
    await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
    const original = await buildRelevantInputManifest(root);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(original.inputs.some((input) => input.path === 'node_modules/@fixture/tsconfig.json' && input.configuration), true);
    await writeFile(path.join(packageDirectory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ESNext' } }));
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest includes package-root TypeScript configuration files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-package-root-'));
  try {
    const packageDirectory = path.join(root, 'node_modules', 'fixture');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ tsconfig: './base.json' }));
    await writeFile(path.join(packageDirectory, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ES2020' } }));
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: 'fixture', files: ['entry.ts'] }));
    await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
    const original = await buildRelevantInputManifest(root);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(original.inputs.some((input) => input.path === 'node_modules/fixture/base.json' && input.configuration), true);
    await writeFile(path.join(packageDirectory, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ESNext' } }));
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest excludes Node runtime entry points rejected as TypeScript configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-runtime-main-'));
  try {
    const packageDirectory = path.join(root, 'node_modules', 'fixture');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ main: './index.js' }));
    await writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = { version: 1 };\n');
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: 'fixture', files: ['entry.ts'] }));
    await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
    const original = await buildRelevantInputManifest(root);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(original.inputs.some((input) => input.path === 'node_modules/fixture/index.js' && input.configuration), false);
    await writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = { version: 2 };\n');
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest preserves inherited configuration after JSONC strings containing comment markers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-freshness-jsonc-string-'));
  try {
    await writeFile(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ES2020' } }));
    await writeFile(path.join(root, 'tsconfig.json'), `{
      "extends": "./base.json",
      "compilerOptions": { "outDir": "foo//bar" },
      "files": ["entry.ts"]
    }`);
    await writeFile(path.join(root, 'entry.ts'), 'export const version = 1;\n');
    const original = await buildRelevantInputManifest(root);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(original.inputs.some((input) => input.path === 'base.json' && input.configuration), true);
    await writeFile(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { target: 'ESNext' } }));
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest invalidates snapshots for edits, additions, renames, removals, and config changes', async () => {
  const root = await fixtureRoot();
  const original = await buildRelevantInputManifest(root);
  const snapshot = {
    schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
    sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
    engineId: 'typescript', engineVersion: '7.0.2', indexedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(snapshotIsFresh(snapshot, original), true);

  await writeFile(path.join(root, 'entry.ts'), 'export const version = 2;\n');
  assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  await writeFile(path.join(root, 'added.ts'), 'export {};\n');
  assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  await rename(path.join(root, 'added.ts'), path.join(root, 'renamed.ts'));
  assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
  await rm(path.join(root, 'renamed.ts'));
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['entry.ts'] }));
  assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root)), false);
});
