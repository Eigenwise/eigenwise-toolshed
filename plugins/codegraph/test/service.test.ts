import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest } from '../src/lib/freshness.ts';
import { buildProjectIndex, type IndexBuildResult } from '../src/lib/index-builder.ts';
import type { FileGraph, LanguageExtractor, ProjectDescriptor } from '../src/lib/model.ts';
import type { SemanticRuntime } from '../src/lib/runtime-contract.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { GraphStore } from '../src/lib/store.ts';

test('index publishes a ready zero-fact snapshot', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-service-'));
  try {
    const service = new CodegraphService({
      projectRoot,
      store: GraphStore.open(':memory:'),
      runtime: { acquire: async () => ({ engineId: 'test-engine', engineVersion: '1.0.0', extractors: [] }) },
      index: async (root): Promise<IndexBuildResult> => ({ snapshots: [], manifest: await buildRelevantInputManifest(root) }),
    });
    const indexed = await service.index();
    assert.equal(indexed.status, 'ready');
    assert.equal(indexed.results.length, 0);
    const status = await service.status();
    assert.equal(status.status, 'ready');
    assert.equal(status.coverage?.files, 0);
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
