import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProjectIndex } from '../src/lib/index-builder.ts';
import type { FileGraph, LanguageExtractor, ProjectDescriptor } from '../src/lib/model.ts';
import type { ProjectGraphSnapshot, ProjectSnapshotStore, SemanticRuntime } from '../src/lib/runtime-contract.ts';

class CapturingStore implements ProjectSnapshotStore {
  readonly snapshots: ProjectGraphSnapshot[] = [];

  async readSnapshot(): Promise<null> {
    return null;
  }

  async replaceSnapshot(snapshot: ProjectGraphSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }
}

function extractor(fail: boolean): LanguageExtractor {
  const descriptor: ProjectDescriptor = { id: 'project', root: '', configFile: null, language: 'typescript' };
  return {
    id: 'fixture', languages: ['typescript'],
    async discoverProjects(): Promise<ProjectDescriptor[]> { return [descriptor]; },
    async extractProject(): Promise<FileGraph[]> {
      if (fail) throw new Error('extract failed');
      return [{ file: 'entry.ts', contentHash: 'content', nodes: [], edges: [], unresolvedCount: 0, diagnostics: [] }];
    },
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'codegraph-index-'));
  await writeFile(path.join(root, 'entry.ts'), 'export {};\n');
  return root;
}

test('builds a validated snapshot before replacing it', async () => {
  const store = new CapturingStore();
  const runtime: SemanticRuntime = { engineId: 'typescript', engineVersion: '7.0.2', extractors: [extractor(false)] };
  const result = await buildProjectIndex(await fixtureRoot(), { runtime, store, indexedAt: () => '2026-01-01T00:00:00.000Z' });

  assert.equal(result.snapshots.length, 1);
  assert.equal(store.snapshots.length, 1);
  assert.equal(store.snapshots[0]?.snapshot.indexedAt, '2026-01-01T00:00:00.000Z');
});

test('does not replace a snapshot when extraction fails', async () => {
  const store = new CapturingStore();
  const runtime: SemanticRuntime = { engineId: 'typescript', engineVersion: '7.0.2', extractors: [extractor(true)] };
  await assert.rejects(buildProjectIndex(await fixtureRoot(), { runtime, store }));
  assert.equal(store.snapshots.length, 0);
});
