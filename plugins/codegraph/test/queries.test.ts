import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileGraph, GraphNode, ProjectDescriptor, SnapshotIdentity } from '../src/lib/model.ts';
import { context, hierarchy, impact, modules, resolveSymbolCandidates, shortestPath } from '../src/lib/queries.ts';
import { GraphStore } from '../src/lib/store.ts';

const project: ProjectDescriptor = { id: 'project', root: '.', configFile: 'tsconfig.json', language: 'typescript' };
const snapshot: SnapshotIdentity = { schemaVersion: 1, snapshotId: 'graph', projectRootHash: 'root', sourceManifestHash: 'manifest', configHash: 'config', engineId: 'typescript', engineVersion: '7', indexedAt: '2026-08-09T00:00:00.000Z' };
const node = (id: string, name: string, file: string, line: number): GraphNode => ({ id, extractor: 'typescript', language: 'typescript', kind: 'function', name, qualifiedName: name, projectId: 'project', declaration: { file, startLine: line, startColumn: 0, endLine: line, endColumn: 1 }, exported: true, contentHash: id });
const edge = (id: string, sourceId: string, targetId: string | null, kind: 'calls' | 'extends' | 'imports' = 'calls', resolution: 'resolved' | 'unresolved' = 'resolved') => ({ id, kind, sourceId, targetId, resolution, evidence: { file: sourceId === 'gamma' ? 'src/c.ts' : 'src/a.ts', startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, ...(resolution === 'unresolved' ? { reason: 'unknown target' } : {}) });

function storeWithGraph(): GraphStore {
  const files: FileGraph[] = [
    { file: 'src/a.ts', contentHash: 'a', nodes: [node('alpha', 'alpha', 'src/a.ts', 1), node('beta', 'beta', 'src/a.ts', 2)], edges: [edge('alpha-beta', 'alpha', 'beta'), edge('beta-gamma', 'beta', 'gamma'), edge('alpha-unresolved', 'alpha', null, 'calls', 'unresolved'), edge('alpha-import', 'alpha', 'gamma', 'imports')], unresolvedCount: 1, diagnostics: [] },
    { file: 'src/c.ts', contentHash: 'c', nodes: [node('gamma', 'gamma', 'src/c.ts', 1)], edges: [edge('gamma-alpha', 'gamma', 'alpha', 'extends'), edge('gamma-import', 'gamma', 'alpha', 'imports')], unresolvedCount: 0, diagnostics: [] },
  ];
  const store = GraphStore.open(':memory:'); store.replaceSnapshot({ snapshot, projects: [project], files }); return store;
}

test('resolves ambiguity before traversal and never traverses unresolved edges', () => {
  const store = storeWithGraph();
  assert.equal(resolveSymbolCandidates(store, { qualifiedName: 'alpha' }).results.length, 1);
  const results = impact(store, { qualifiedName: 'alpha' }, { direction: 'forward', maxDepth: 3 }).results;
  assert.deepEqual(results.map((result) => 'node' in result ? result.node.id : result.id), ['beta', 'gamma']);
  store.close();
});

test('finds bounded shortest paths and hierarchy', () => {
  const store = storeWithGraph();
  const path = shortestPath(store, { qualifiedName: 'alpha' }, { qualifiedName: 'gamma' }, { maxDepth: 2, edgeKinds: ['calls'] });
  assert.equal(path.results.length, 1);
  assert.deepEqual(('edges' in path.results[0]! ? path.results[0]!.edges : []).map((edge) => edge.id), ['alpha-beta', 'beta-gamma']);
  assert.equal(hierarchy(store, { qualifiedName: 'gamma' }, { direction: 'forward' }).results[0] && ('node' in hierarchy(store, { qualifiedName: 'gamma' }).results[0]! ? true : false), true);
  store.close();
});

test('returns module cycles and lexical context with a snapshot-bound cursor', () => {
  const store = storeWithGraph();
  assert.deepEqual(modules(store, 'cycles').results[0]?.files, ['src/a.ts', 'src/c.ts']);
  assert.equal(store.lexicalMatches('graph', ['alpha', 'beta', 'gamma']).length, 3);
  const first = context(store, 'alpha beta gamma', { maxResults: 1, tokenBudget: 500 });
  assert.equal(first.results.length, 1);
  assert.notEqual(first.nextCursor, null);
  const second = context(store, 'alpha beta gamma', { maxResults: 1, tokenBudget: 500, cursor: first.nextCursor! });
  assert.notEqual(second.results[0]?.id, first.results[0]?.id);
  assert.throws(() => context(store, 'different', { cursor: first.nextCursor! }), /cursor/);
  store.close();
});
