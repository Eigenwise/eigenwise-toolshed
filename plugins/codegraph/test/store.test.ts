import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FileGraph, GraphNode, ProjectDescriptor, SnapshotIdentity } from '../src/lib/model.ts';
import { GraphStore } from '../src/lib/store.ts';

const project: ProjectDescriptor = { id: 'project', root: '.', configFile: 'tsconfig.json', language: 'typescript' };
const snapshot = (snapshotId: string): SnapshotIdentity => ({ schemaVersion: 1, snapshotId, projectRootHash: 'root', sourceManifestHash: 'manifest', configHash: 'config', engineId: 'typescript', engineVersion: '7', indexedAt: '2026-08-09T00:00:00.000Z' });
const node = (id: string, name: string): GraphNode => ({ id, extractor: 'typescript', language: 'typescript', kind: 'function', name, qualifiedName: name, projectId: 'project', declaration: { file: 'src/a.ts', startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 }, exported: true, contentHash: id });
const graph = (snapshotId = 'first'): { snapshot: SnapshotIdentity; projects: ProjectDescriptor[]; files: FileGraph[] } => ({ snapshot: snapshot(snapshotId), projects: [project], files: [{ file: 'src/a.ts', contentHash: 'file', nodes: [node('a', 'alpha'), node('b', 'beta')], edges: [{ id: 'resolved', kind: 'calls', sourceId: 'a', targetId: 'b', resolution: 'resolved', evidence: { file: 'src/a.ts', startLine: 2, startColumn: 0, endLine: 2, endColumn: 5 } }, { id: 'unresolved', kind: 'calls', sourceId: 'b', targetId: null, resolution: 'unresolved', evidence: { file: 'src/a.ts', startLine: 3, startColumn: 0, endLine: 3, endColumn: 5 }, reason: 'dynamic receiver' }], unresolvedCount: 1, diagnostics: [] }] });

test('writes, validates, replaces, and reopens a complete snapshot', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codegraph-store-'));
  const databasePath = path.join(directory, 'graph.sqlite');
  try {
    const store = GraphStore.open(databasePath);
    store.replaceSnapshot(graph());
    assert.deepEqual(store.coverage(), { projects: 1, files: 1, nodes: 2, edges: 2, unresolvedEdges: 1, ambiguousEdges: 0, dynamicEdges: 0, externalEdges: 0, dependencyEnvironments: [{ projectId: 'project', state: 'absent' }] });
    store.validate();
    store.replaceSnapshot(graph('second'));
    assert.equal(store.snapshot()?.snapshotId, 'second');
    store.close();
    const reopened = GraphStore.open(databasePath);
    assert.equal(reopened.snapshot()?.snapshotId, 'second');
    assert.equal(reopened.edges('second')[1]?.reason, 'dynamic receiver');
    reopened.close();
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} }
});

test('rejects a partial replacement without losing the previous snapshot', () => {
  const store = GraphStore.open(':memory:');
  store.replaceSnapshot(graph());
  const invalid = graph('invalid');
  invalid.files[0]!.edges[0]!.targetId = 'missing';
  assert.throws(() => store.replaceSnapshot(invalid), /target is not in snapshot/);
  assert.equal(store.snapshot()?.snapshotId, 'first');
  store.close();
});
