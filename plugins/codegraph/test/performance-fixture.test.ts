import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FileGraph, GraphNode, SnapshotIdentity } from '../src/lib/model.ts';
import { impact } from '../src/lib/queries.ts';
import { GraphStore } from '../src/lib/store.ts';

const snapshot: SnapshotIdentity = { schemaVersion: 1, snapshotId: 'large', projectRootHash: 'root', sourceManifestHash: 'manifest', configHash: 'config', engineId: 'typescript', engineVersion: '7', indexedAt: '2026-08-09T00:00:00.000Z' };

test('persists and traverses a 5k-node, 15k-edge fixture', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codegraph-large-'));
  try {
    const nodes: GraphNode[] = Array.from({ length: 5_000 }, (_, index) => ({ id: `node-${index}`, extractor: 'typescript', language: 'typescript', kind: 'function', name: `symbol${index}`, qualifiedName: `symbol${index}`, projectId: 'project', declaration: { file: 'src/large.ts', startLine: index + 1, startColumn: 0, endLine: index + 1, endColumn: 1 }, exported: false, contentHash: String(index) }));
    const edges = Array.from({ length: 15_000 }, (_, index) => ({ id: `edge-${index}`, kind: 'calls' as const, sourceId: `node-${index % 5_000}`, targetId: `node-${(index + 1) % 5_000}`, resolution: 'resolved' as const, evidence: { file: 'src/large.ts', startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } }));
    const graph: FileGraph = { file: 'src/large.ts', contentHash: 'large', nodes, edges, unresolvedCount: 0, diagnostics: [] };
    const store = GraphStore.open(path.join(directory, 'graph.sqlite'));
    const startedAt = performance.now();
    store.replaceSnapshot({ snapshot, projects: [{ id: 'project', root: '.', configFile: 'tsconfig.json', language: 'typescript' }], files: [graph] });
    const response = impact(store, { qualifiedName: 'symbol0' }, { direction: 'forward', maxDepth: 3, tokenBudget: 500 });
    assert.equal(response.status, 'ready');
    assert.ok(response.results.length > 0 && response.results.length <= 3);
    assert.ok(performance.now() - startedAt < 10_000);
    store.close();
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} }
});
