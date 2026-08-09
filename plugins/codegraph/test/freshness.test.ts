import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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
