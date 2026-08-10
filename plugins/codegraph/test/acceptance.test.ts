import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRelevantInputManifest } from '../src/lib/freshness.ts';
import type { IndexBuildResult } from '../src/lib/index-builder.ts';
import { invokeCodegraphTool } from '../src/lib/mcp.ts';
import type { GraphResponse } from '../src/lib/model.ts';
import { createTypeScriptSemanticExtractor } from '../src/lib/extractors/typescript.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { TypeScriptRuntimeAcquirer, type RuntimeInstaller } from '../src/lib/runtime.ts';
import { GraphStore } from '../src/lib/store.ts';

const pluginRoot = process.cwd();
const acceptanceFixture = path.join(pluginRoot, 'test', 'fixtures', 'acceptance');
const runtimeFixture = path.join(pluginRoot, 'test', 'fixtures', 'runtime');
const runtimeManifest = path.join(pluginRoot, 'runtime');
const fixtureTreeIntegrity = 'sha512-JijYZfgG9Rs9+ZIwmYWZ6ZWUORj+2bAl+rDdKZa0PSie6xD2ryUM9YrH/YE/lMGUg5zJMRp9Bgfiu8Czo0TRMA==';

interface StructuredResponse {
  readonly structuredContent: unknown;
}

interface FixtureRuntimeInstaller extends RuntimeInstaller {
  readonly calls: number;
}

class LocalPackageSource implements FixtureRuntimeInstaller {
  calls = 0;

  constructor(private readonly sourceDirectory: string) {}

  async install(stageDirectory: string, _runtimeManifestDirectory: string): Promise<void> {
    this.calls += 1;
    await cp(path.join(this.sourceDirectory, 'node_modules'), path.join(stageDirectory, 'node_modules'), { recursive: true });
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function prepareRuntimeManifest(directory: string): Promise<void> {
  await cp(runtimeManifest, directory, { recursive: true });
  const manifestPath = path.join(directory, 'integrity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    engine: { moduleIntegrity: string };
    installedTreeIntegrity: Record<string, string>;
  };
  const moduleBytes = await readFile(path.join(runtimeFixture, 'node_modules', 'typescript', 'dist', 'api', 'sync', 'api.js'));
  const moduleIntegrity = `sha512-${createHash('sha512').update(moduleBytes).digest('base64')}`;
  manifest.engine.moduleIntegrity = moduleIntegrity;
  for (const platform of Object.keys(manifest.installedTreeIntegrity)) manifest.installedTreeIntegrity[platform] = fixtureTreeIntegrity;
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
}

async function copyAcceptanceProject(): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await temporaryDirectory('codegraph-acceptance-');
  const root = path.join(parent, 'project');
  await cp(acceptanceFixture, root, { recursive: true });
  return { parent, root };
}

async function createService(root: string, stateDirectory: string, manifestDirectory: string, storePath = ':memory:', installer = new LocalPackageSource(runtimeFixture)): Promise<{ readonly service: CodegraphService; readonly store: GraphStore; readonly installer: FixtureRuntimeInstaller }> {
  const store = GraphStore.open(storePath);
  const acquirer = new TypeScriptRuntimeAcquirer({
    architecture: 'x64',
    installer,
    platform: 'win32',
    runtimeManifestDirectory: manifestDirectory,
    stateDirectory,
  });
  const service = new CodegraphService({ projectRoot: root, store, runtime: acquirer });
  return { service, store, installer };
}

function selectorFor(store: GraphStore, snapshotId: string, name: string, kind: 'class' | 'function'): { qualifiedName: string; kind: 'class' | 'function' } {
  const candidates = store.nodes(snapshotId).filter((node) => node.name === name && node.kind === kind);
  assert.equal(candidates.length, 1, `expected one ${kind} named ${name}`);
  return { qualifiedName: candidates[0]!.qualifiedName, kind };
}

function responseOf(response: StructuredResponse | GraphResponse<never>): GraphResponse<unknown> {
  if ('structuredContent' in response) {
    if (typeof response.structuredContent !== 'object' || response.structuredContent === null) throw new Error('MCP response did not include structured content');
    return response.structuredContent as GraphResponse<unknown>;
  }
  return response;
}

function responseText(response: StructuredResponse): string {
  return JSON.stringify(response.structuredContent);
}

test('Codegraph US-50 acceptance oracle exercises the real runtime, graph, lifecycle, and MCP boundary', async () => {
  const { parent, root } = await copyAcceptanceProject();
  const manifestDirectory = await temporaryDirectory('codegraph-acceptance-manifest-');
  const stateDirectory = await temporaryDirectory('codegraph-acceptance-state-');
  const installer = new LocalPackageSource(runtimeFixture);
  let store: GraphStore | undefined;
  try {
    await prepareRuntimeManifest(manifestDirectory);
    const created = await createService(root, stateDirectory, manifestDirectory, ':memory:', installer);
    store = created.store;
    const { service } = created;

    const missing = responseOf(await invokeCodegraphTool(service, 'codegraph_status'));
    assert.equal(missing.status, 'missing');
    assert.equal(missing.results.length, 0);

    const indexed = responseOf(await invokeCodegraphTool(service, 'codegraph_index'));
    assert.equal(indexed.status, 'ready', indexed.message);
    assert.equal(indexed.snapshot?.engineId, 'typescript');
    assert.equal(indexed.snapshot?.engineVersion, '7.0.2');
    assert.equal(indexed.coverage?.projects, 2);
    assert.ok((indexed.coverage?.files ?? 0) >= 10);
    assert.ok((indexed.coverage?.nodes ?? 0) >= 20);
    assert.ok((indexed.coverage?.unresolvedEdges ?? 0) > 0);
    assert.ok((indexed.coverage?.dynamicEdges ?? 0) > 0);
    assert.ok((indexed.coverage?.externalEdges ?? 0) > 0);
    assert.equal(installer.calls, 1);

    const childSelector = selectorFor(store, indexed.snapshot!.snapshotId, 'Child', 'class');
    const baseSelector = selectorFor(store, indexed.snapshot!.snapshotId, 'Base', 'class');
    const concurrentState = await temporaryDirectory('codegraph-concurrent-state-');
    const concurrentFirstInstaller = new LocalPackageSource(runtimeFixture);
    const concurrentSecondInstaller = new LocalPackageSource(runtimeFixture);
    const concurrentFirst = await createService(root, concurrentState, manifestDirectory, ':memory:', concurrentFirstInstaller);
    const concurrentSecond = await createService(root, concurrentState, manifestDirectory, ':memory:', concurrentSecondInstaller);
    try {
      const [concurrentFirstResult, concurrentSecondResult] = await Promise.all([concurrentFirst.service.index(), concurrentSecond.service.index()]);
      assert.equal(concurrentFirstResult.status, 'ready');
      assert.equal(concurrentSecondResult.status, 'ready');
      assert.equal(concurrentFirstInstaller.calls + concurrentSecondInstaller.calls, 1);
    } finally {
      concurrentFirst.store.close();
      concurrentSecond.store.close();
      await rm(concurrentState, { recursive: true, force: true });
    }

    const status = responseOf(await invokeCodegraphTool(service, 'codegraph_status'));
    assert.equal(status.status, 'ready');
    assert.deepEqual(status.snapshot, indexed.snapshot);
    const sessionStart = spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', 'session-start.js')], { input: JSON.stringify({ cwd: root }), encoding: 'utf8' });
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.ok(Buffer.byteLength(sessionStart.stdout, 'utf8') <= 1_024);
    assert.match(sessionStart.stdout, /Codegraph: ready/);
    assert.doesNotMatch(sessionStart.stdout, /Child|Base|edgeCases/);
    assert.match(responseText(await invokeCodegraphTool(service, 'codegraph_context', { query: 'Child helper', maxResults: 10 })), /Child/);

    const impact = responseOf(await invokeCodegraphTool(service, 'codegraph_impact', {
      symbol: childSelector,
      direction: 'both',
      maxDepth: 3,
      maxResults: 100,
    }));
    assert.equal(impact.status, 'ready');
    assert.match(responseText({ structuredContent: impact }), /Base/);

    const pathResponse = responseOf(await invokeCodegraphTool(service, 'codegraph_path', {
      from: childSelector,
      to: baseSelector,
      maxDepth: 3,
    }));
    assert.equal(pathResponse.status, 'ready');
    assert.equal(pathResponse.results.length, 1);
    assert.match(JSON.stringify(pathResponse.results), /Child/);
    assert.match(JSON.stringify(pathResponse.results), /Base/);

    const hierarchy = responseOf(await invokeCodegraphTool(service, 'codegraph_hierarchy', {
      symbol: childSelector,
      direction: 'both',
      maxDepth: 3,
    }));
    assert.equal(hierarchy.status, 'ready');
    assert.match(JSON.stringify(hierarchy.results), /Base/);

    const cycles = responseOf(await invokeCodegraphTool(service, 'codegraph_modules', { mode: 'cycles', maxResults: 10 }));
    const layers = responseOf(await invokeCodegraphTool(service, 'codegraph_modules', { mode: 'layers', maxResults: 100 }));
    const fanout = responseOf(await invokeCodegraphTool(service, 'codegraph_modules', { mode: 'fanout', maxResults: 100 }));
    assert.equal(cycles.status, 'ready');
    assert.equal(layers.status, 'ready');
    assert.equal(fanout.status, 'ready');
    assert.match(JSON.stringify(cycles.results), /cycle-a/);
    assert.ok(layers.results.length > 0);
    assert.ok(fanout.results.length > 0);

    const context = responseOf(await invokeCodegraphTool(service, 'codegraph_context', { query: 'Child helper Duplicate', maxResults: 1, tokenBudget: 500 }));
    assert.equal(context.status, 'ready');
    assert.ok(context.results.length <= 1);
    assert.ok(context.omitted > 0);
    assert.ok(context.nextCursor !== null);
    assert.ok(context.tokenEstimate <= 500);
    const repeated = responseOf(await invokeCodegraphTool(service, 'codegraph_context', { query: 'Child helper Duplicate', maxResults: 1, tokenBudget: 500 }));
    assert.deepEqual(repeated.results, context.results);
    assert.equal(Buffer.byteLength(JSON.stringify(repeated), 'utf8') < 256 * 1024, true);

    const duplicateNodes = store.nodes(indexed.snapshot!.snapshotId).filter((node) => node.name === 'Duplicate' && node.kind === 'class');
    assert.equal(duplicateNodes.length, 3);
    const duplicateQueries = await Promise.all(duplicateNodes.map((node) => invokeCodegraphTool(service, 'codegraph_impact', { symbol: { qualifiedName: node.qualifiedName, kind: 'class' }, edgeKinds: [], maxResults: 10 })));
    for (const duplicateQuery of duplicateQueries) {
      assert.equal(responseOf(duplicateQuery).status, 'ready');
    }
    for (const node of duplicateNodes) assert.equal(store.symbolCandidates(indexed.snapshot!.snapshotId, node.qualifiedName, undefined, 'class').length, 1);
    const unqualifiedDuplicate = responseOf(await invokeCodegraphTool(service, 'codegraph_impact', { symbol: { qualifiedName: 'Duplicate', kind: 'class' }, maxResults: 10 }));
    assert.equal(unqualifiedDuplicate.status, 'ready');
    assert.equal(unqualifiedDuplicate.results.length, 0);

    const staleSource = path.join(root, 'packages', 'core', 'src', 'domain.ts');
    await writeFile(staleSource, `${await readFile(staleSource, 'utf8')}\nexport const changedMarker = 'changed';\n`, 'utf8');
    const stale = responseOf(await invokeCodegraphTool(service, 'codegraph_status'));
    assert.equal(stale.status, 'stale');
    const refused = responseOf(await invokeCodegraphTool(service, 'codegraph_context', { query: 'changedMarker' }));
    assert.equal(refused.status, 'stale');
    assert.equal(refused.results.length, 0);
    const staleSnapshot = stale.snapshot;

    const removedFile = path.join(root, 'packages', 'core', 'src', 'remove-me.ts');
    const renamedFile = path.join(root, 'packages', 'core', 'src', 'rename-me.ts');
    await rm(removedFile);
    await rename(renamedFile, path.join(root, 'packages', 'core', 'src', 'renamed.ts'));
    await writeFile(path.join(root, 'packages', 'core', 'src', 'added.ts'), 'export function addedAfterRefresh(): string { return \'added\'; }\n', 'utf8');
    const refreshed = responseOf(await invokeCodegraphTool(service, 'codegraph_index'));
    assert.equal(refreshed.status, 'ready');
    assert.notEqual(refreshed.snapshot?.snapshotId, staleSnapshot?.snapshotId);
    assert.equal(responseOf(await invokeCodegraphTool(service, 'codegraph_status')).status, 'ready');
    assert.equal(responseOf(await invokeCodegraphTool(service, 'codegraph_context', { query: 'removed Before Refresh' })).results.length, 0);
    assert.match(responseText(await invokeCodegraphTool(service, 'codegraph_context', { query: 'added After Refresh' })), /addedAfterRefresh/);
    assert.match(responseText(await invokeCodegraphTool(service, 'codegraph_context', { query: 'renamed Before Refresh' })), /renamedBeforeRefresh/);

    const oldCursor = context.nextCursor;
    assert.ok(oldCursor !== null);
    const invalidated = responseOf(await invokeCodegraphTool(service, 'codegraph_context', { query: 'Child helper Duplicate', maxResults: 1, tokenBudget: 500, cursor: oldCursor }));
    assert.equal(invalidated.status, 'error');
    assert.match(invalidated.message, /cursor/);

    let failRebuild = true;
    const failingService = new CodegraphService({
      projectRoot: root,
      store,
      runtime: { acquire: async () => ({ engineId: 'test', engineVersion: '1', extractors: [] }) },
      index: async (): Promise<IndexBuildResult> => {
        if (failRebuild) throw new Error('simulated interrupted rebuild');
        throw new Error('unreachable');
      },
    });
    const failed = responseOf(await failingService.index());
    assert.equal(failed.status, 'error');
    assert.equal(store.snapshot()?.snapshotId, refreshed.snapshot?.snapshotId);
    failRebuild = false;

    const snapshotBeforeAtomicFailure = store.snapshot();
    const atomicService = new CodegraphService({
      projectRoot: root,
      store,
      runtime: { acquire: async () => ({ engineId: 'test', engineVersion: '1', extractors: [] }) },
      index: async (): Promise<IndexBuildResult> => {
        const manifest = await buildRelevantInputManifest(root);
        const runtime = { engineId: 'test', engineVersion: '1', extractors: [createTypeScriptSemanticExtractor()] };
        const files = await runtime.extractors[0]!.extractProject({ id: 'atomic', root, configFile: path.join(root, 'packages', 'core', 'tsconfig.json'), language: 'typescript' });
        return { manifest, snapshots: [{ project: { id: 'atomic', root, configFile: path.join(root, 'packages', 'core', 'tsconfig.json'), language: 'typescript' }, snapshot: snapshotBeforeAtomicFailure!, coverage: { projects: 1, files: files.length, nodes: files.reduce((total, file) => total + file.nodes.length, 0), edges: files.reduce((total, file) => total + file.edges.length, 0), unresolvedEdges: 0, ambiguousEdges: 0, dynamicEdges: 0, externalEdges: 0 }, files: [...files, files[0]!] }] };
      },
    });
    const atomicFailure = responseOf(await atomicService.index());
    assert.equal(atomicFailure.status, 'error');
    assert.equal(store.snapshot()?.snapshotId, snapshotBeforeAtomicFailure?.snapshotId);

    const reopenPath = path.join(parent, 'reopen.sqlite');
    const reopenSetup = await createService(root, stateDirectory, manifestDirectory, reopenPath, new LocalPackageSource(runtimeFixture));
    const reopenedIndexed = responseOf(await invokeCodegraphTool(reopenSetup.service, 'codegraph_index'));
    assert.equal(reopenedIndexed.status, 'ready');
    const persistedPage = responseOf(await invokeCodegraphTool(reopenSetup.service, 'codegraph_context', { query: 'Child helper Duplicate', maxResults: 1, tokenBudget: 500 }));
    assert.ok(persistedPage.nextCursor !== null);
    reopenSetup.store.close();
    const persistedSetup = await createService(root, stateDirectory, manifestDirectory, reopenPath, new LocalPackageSource(runtimeFixture));
    try {
      const reopenedStatus = responseOf(await invokeCodegraphTool(persistedSetup.service, 'codegraph_status'));
      assert.equal(reopenedStatus.status, 'ready');
      assert.deepEqual(reopenedStatus.snapshot, reopenedIndexed.snapshot);
      const reopenedPage = responseOf(await invokeCodegraphTool(persistedSetup.service, 'codegraph_context', { query: 'Child helper Duplicate', maxResults: 1, tokenBudget: 500, cursor: persistedPage.nextCursor! }));
      assert.equal(reopenedPage.status, 'ready');
    } finally {
      persistedSetup.store.close();
    }
  } finally {
    store?.close();
    await Promise.all([
      rm(parent, { recursive: true, force: true }),
      rm(manifestDirectory, { recursive: true, force: true }),
      rm(stateDirectory, { recursive: true, force: true }),
    ]);
  }
});
