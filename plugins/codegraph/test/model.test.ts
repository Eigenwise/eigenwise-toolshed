import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertGraphResponseInvariants,
  createGraphNodeId,
  sortGraphResults,
  type GraphCoverage,
  type GraphResponse,
  type SnapshotIdentity,
} from '../src/lib/model.ts';
import { SemanticLanguageProviderRegistry, snapshotEngineIdentity } from '../src/lib/runtime-contract.ts';
import type { LanguageExtractor } from '../src/lib/model.ts';

const snapshot: SnapshotIdentity = {
  schemaVersion: 1,
  snapshotId: 'snapshot-1',
  projectRootHash: 'root-hash',
  sourceManifestHash: 'source-hash',
  configHash: 'config-hash',
  engineId: 'typescript',
  engineVersion: '7.0.2',
  indexedAt: '2026-08-09T00:00:00.000Z',
};

const coverage: GraphCoverage = {
  projects: 1,
  files: 1,
  nodes: 1,
  edges: 0,
  unresolvedEdges: 0,
  ambiguousEdges: 0,
  dynamicEdges: 0,
  externalEdges: 0,
  dependencyEnvironments: [],
};

test('stable node identity excludes mutable span and content data', () => {
  const identity = {
    extractor: 'typescript',
    projectId: 'project-id',
    declarationFile: 'src/index.ts',
    kind: 'function' as const,
    qualifiedName: 'run',
  };

  assert.equal(createGraphNodeId(identity), createGraphNodeId({ ...identity }));
  assert.notEqual(
    createGraphNodeId(identity),
    createGraphNodeId({ ...identity, declarationFile: 'src/other.ts' }),
  );
});

test('graph result ordering is deterministic', () => {
  const ordered = sortGraphResults([
    { rank: 2, file: 'src/b.ts', startLine: 1, kind: 'class', qualifiedName: 'B', id: 'b' },
    { rank: 2, file: 'src/a.ts', startLine: 2, kind: 'function', qualifiedName: 'z', id: 'z' },
    { rank: 4, file: 'src/z.ts', startLine: 1, kind: 'function', qualifiedName: 'A', id: 'a' },
    { rank: 2, file: 'src/a.ts', startLine: 2, kind: 'function', qualifiedName: 'z', id: 'a' },
  ]);

  assert.deepEqual(ordered.map((result) => result.id), ['a', 'a', 'z', 'b']);
});

test('non-ready graph responses expose no facts', () => {
  const response: GraphResponse<string> = {
    status: 'stale',
    snapshot,
    coverage,
    results: [],
    omitted: 0,
    nextCursor: null,
    tokenEstimate: 0,
    message: 'Run codegraph_index before querying.',
  };

  assert.doesNotThrow(() => assertGraphResponseInvariants(response));
  assert.throws(() => assertGraphResponseInvariants({ ...response, results: ['fact'] }));
  assert.throws(() => assertGraphResponseInvariants({ ...response, status: 'ready', snapshot: null }));
});

test('provider registry orders engines and extractors by provider identity', async () => {
  const extractor = (id: string): LanguageExtractor => ({
    id,
    languages: ['fixture'],
    discoverProjects: async () => [],
    extractProject: async () => [],
  });
  const provider = (id: string, version: string) => ({
    id,
    languages: [id],
    freshness: { collect: async () => [] },
    dependencyEnvironment: { discover: async () => id === 'zeta'
      ? { state: 'configured' as const, absolutePaths: ['/fixture/zeta'] }
      : { state: 'absent' as const, absolutePaths: [] as const } },
    acquireEngine: async () => ({
      id,
      version,
      engineId: id,
      engineVersion: version,
      extractors: [],
      importModule: async () => ({}),
    }),
    createExtractor: () => extractor(id),
  });
  const registry = new SemanticLanguageProviderRegistry([provider('zeta', '2.0.0'), provider('alpha', '1.0.0')]);
  const runtime = await registry.acquireRuntime();

  assert.deepEqual(runtime.engines?.map((engine) => `${engine.id}@${engine.version}`), ['alpha@1.0.0', 'zeta@2.0.0']);
  assert.deepEqual(runtime.extractors.map((candidate) => candidate.id), ['alpha', 'zeta']);
  assert.equal(snapshotEngineIdentity(runtime.engines ?? []).version, '[{"id":"alpha","version":"1.0.0"},{"id":"zeta","version":"2.0.0"}]');
  assert.deepEqual(await runtime.dependencyEnvironmentFor?.({
    id: 'zeta-project', root: '/fixture/zeta', configFile: null, language: 'zeta',
  }), { state: 'configured', absolutePaths: ['/fixture/zeta'] });
});
