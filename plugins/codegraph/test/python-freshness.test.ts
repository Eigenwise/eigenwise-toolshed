import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest, snapshotIsFresh } from '../src/lib/freshness.ts';
import { PythonFreshnessContributor } from '../src/lib/languages/python/freshness.ts';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'python-discovery');
const contributor = new PythonFreshnessContributor();

test('collects Python sources, stubs, and inherited Pyright configuration paths', async () => {
  const root = path.join(fixtureRoot, 'inherited', 'project');
  const inputs = await contributor.collect(root);
  const inputPaths = inputs.map((input) => input.absolutePath.replaceAll('\\', '/'));

  assert.equal(inputPaths.some((inputPath) => inputPath.endsWith('/module.py')), true);
  assert.equal(inputPaths.some((inputPath) => inputPath.endsWith('/pyrightconfig.json')), true);
  assert.equal(inputPaths.some((inputPath) => inputPath.endsWith('/base/pyright-base.json')), true);
  assert.equal(inputs.filter((input) => input.configuration).length, 2);
});

test('excludes virtual environments from Python freshness candidates', async () => {
  const inputs = await contributor.collect(path.join(fixtureRoot, 'virtualenv'));
  assert.equal(inputs.some((input) => input.absolutePath.endsWith('ignored.py')), false);
});

test('invalidates a snapshot for Python source, stub, and config changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-python-freshness-'));
  try {
    const pyrightConfig = path.join(root, 'pyrightconfig.json');
    const source = path.join(root, 'module.py');
    const stub = path.join(root, 'module.pyi');
    await writeFile(pyrightConfig, '{}\n');
    await writeFile(source, 'value = 1\n');
    await writeFile(stub, 'value: int\n');
    const original = await buildRelevantInputManifest(root, [contributor]);
    const snapshot = {
      schemaVersion: 1, snapshotId: 'snapshot', projectRootHash: 'project',
      sourceManifestHash: original.sourceManifestHash, configHash: original.configHash,
      engineId: 'python', engineVersion: 'fixture', indexedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(snapshotIsFresh(snapshot, original), true);

    await writeFile(stub, 'value: str\n');
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root, [contributor])), false);
    await writeFile(pyrightConfig, '{"typeCheckingMode":"strict"}\n');
    assert.equal(snapshotIsFresh(snapshot, await buildRelevantInputManifest(root, [contributor])), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
