import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest } from '../src/lib/freshness.ts';
import { buildProjectIndex, type IndexBuildResult } from '../src/lib/index-builder.ts';
import type { FileGraph, LanguageExtractor, ProjectDescriptor } from '../src/lib/model.ts';
import type { SemanticRuntime } from '../src/lib/runtime-contract.ts';
import { projectIdentity } from '../src/lib/paths.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { GraphStore } from '../src/lib/store.ts';

test('reports a zero-file snapshot as missing', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-'));
  try {
    const service = new CodegraphService({
      projectRoot,
      store: GraphStore.open(':memory:'),
      runtime: { acquire: async () => ({ engineId: 'test-engine', engineVersion: '1.0.0', extractors: [] }) },
      index: async (root): Promise<IndexBuildResult> => ({ snapshots: [], manifest: await buildRelevantInputManifest(root) }),
    });
    const indexed = await service.index();
    assert.equal(indexed.status, 'missing');
    assert.match(indexed.message, /no indexed source files/);
    assert.equal(indexed.results.length, 0);
    const status = await service.status();
    assert.equal(status.status, 'missing');
    assert.match(status.message, /no indexed source files/);
    assert.equal(status.coverage?.files, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('reports a failed refresh instead of the previous ready snapshot', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-failed-refresh-'));
  try {
    let shouldFail = false;
    const service = new CodegraphService({
      projectRoot,
      store: GraphStore.open(':memory:'),
      runtime: { acquire: async () => ({ engineId: 'test-engine', engineVersion: '1.0.0', extractors: [] }) },
      index: async (root): Promise<IndexBuildResult> => {
        if (shouldFail) throw new Error('simulated refresh failure');
        return {
          manifest: await buildRelevantInputManifest(root),
          snapshots: [{
            project: { id: 'fixture', root, configFile: null, language: 'typescript' },
            snapshot: {
              schemaVersion: 1,
              snapshotId: 'fixture',
              projectRootHash: 'fixture',
              sourceManifestHash: 'fixture',
              configHash: 'fixture',
              engineId: 'fixture',
              engineVersion: '1.0.0',
              indexedAt: '2026-08-10T00:00:00.000Z',
            },
            coverage: { projects: 1, files: 1, nodes: 0, edges: 0, unresolvedEdges: 0, ambiguousEdges: 0, dynamicEdges: 0, externalEdges: 0 },
            files: [{ file: 'source.ts', contentHash: 'fixture', nodes: [], edges: [], unresolvedCount: 0, diagnostics: [] }],
          }],
        };
      },
    });
    const indexed = await service.index();
    assert.equal(indexed.status, 'ready');

    shouldFail = true;
    const failed = await service.index();
    assert.equal(failed.status, 'error');
    assert.match(failed.message, /simulated refresh failure/);
    assert.equal(failed.snapshot?.snapshotId, indexed.snapshot?.snapshotId);

    const status = await service.status();
    assert.equal(status.status, 'error');
    assert.match(status.message, /simulated refresh failure/);
    const query = await service.context('fixture', { tokenBudget: 500, maxResults: 1 });
    assert.equal(query.status, 'error');
    assert.equal(query.results.length, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('indexes same-named files from separate leaf projects under repository-relative paths', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-multiproject-'));
  try {
    const aRoot = path.join(projectRoot, 'packages', 'a');
    const bRoot = path.join(projectRoot, 'packages', 'b');
    await Promise.all([mkdir(path.join(aRoot, 'src'), { recursive: true }), mkdir(path.join(bRoot, 'src'), { recursive: true })]);
    await Promise.all([writeFile(path.join(aRoot, 'src', 'index.ts'), 'export {};\n'), writeFile(path.join(bRoot, 'src', 'index.ts'), 'export {};\n')]);
    const projects: readonly ProjectDescriptor[] = [
      { id: 'a', root: aRoot, configFile: null, language: 'typescript' },
      { id: 'b', root: bRoot, configFile: null, language: 'typescript' },
    ];
    const extractor: LanguageExtractor = {
      id: 'fixture',
      languages: ['typescript'],
      async discoverProjects(): Promise<ProjectDescriptor[]> { return [...projects]; },
      async extractProject(project): Promise<FileGraph[]> {
        return [{ file: 'src/index.ts', contentHash: project.id, nodes: [], edges: [], unresolvedCount: 0, diagnostics: [] }];
      },
    };
    const semanticRuntime: SemanticRuntime = { engineId: 'fixture', engineVersion: '1.0.0', extractors: [extractor] };
    const store = GraphStore.open(':memory:');
    const service = new CodegraphService({
      projectRoot,
      store,
      runtime: { acquire: async () => semanticRuntime },
      index: async (root) => buildProjectIndex(root, {
        runtime: semanticRuntime,
        store: { readSnapshot: async () => null, replaceSnapshot: async () => undefined },
      }),
    });
    const indexed = await service.index();
    assert.equal(indexed.status, 'ready');
    assert.deepEqual(store.nodes(indexed.snapshot!.snapshotId), []);
    assert.equal(indexed.coverage?.files, 2);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('retains nested project ownership and remaps incoming semantic edges', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-overlapping-projects-'));
  const nestedProjectRoot = path.join(projectRoot, 'packages', 'core');
  try {
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await mkdir(path.join(nestedProjectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
      include: ['src/**/*.ts', 'packages/core/src/**/*.ts'],
    }));
    await writeFile(path.join(nestedProjectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' },
      include: ['src/**/*.ts'],
    }));
    await writeFile(path.join(projectRoot, 'src', 'consumer.ts'), "import { value } from '../packages/core/src/value.js';\nexport const consumed = value;\n");
    await writeFile(path.join(nestedProjectRoot, 'src', 'value.ts'), 'export const value = 42;\n');

    const store = GraphStore.open(':memory:');
    const service = new CodegraphService({
      projectRoot,
      store,
      runtime: { acquire: async () => ({ engineId: 'typescript', engineVersion: '7.0.2', extractors: [] }) },
    });
    const indexed = await service.index();

    assert.equal(indexed.status, 'ready', indexed.message);
    assert.equal(indexed.coverage?.files, 2);
    const snapshotId = indexed.snapshot!.snapshotId;
    const storedFiles = store.database.prepare('SELECT file FROM files ORDER BY file').all() as { file: string }[];
    assert.deepEqual(storedFiles.map((row) => row.file), ['packages/core/src/value.ts', 'src/consumer.ts']);

    const nodes = store.nodes(snapshotId);
    const retainedTarget = nodes.find((node) => node.qualifiedName.endsWith('.value') && node.declaration.file === 'packages/core/src/value.ts');
    const consumerModule = nodes.find((node) => node.kind === 'module' && node.declaration.file === 'src/consumer.ts');
    assert.ok(retainedTarget);
    assert.ok(consumerModule);
    assert.equal(retainedTarget.projectId, projectIdentity(nestedProjectRoot));

    const incomingImport = store.edges(snapshotId).find((edge) => edge.kind === 'imports' && edge.sourceId === consumerModule.id);
    assert.ok(incomingImport);
    assert.equal(incomingImport.resolution, 'resolved');
    assert.equal(incomingImport.targetId, retainedTarget.id);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
