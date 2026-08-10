import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRelevantInputManifest, snapshotIsFresh } from './freshness.js';
import { buildProjectIndex, type IndexBuildResult } from './index-builder.js';
import type { GraphAvailability, GraphCoverage, GraphResponse, SnapshotIdentity } from './model.js';
import { createTypeScriptSemanticExtractor } from './extractors/typescript.js';
import { impact, shortestPath, hierarchy, modules, context, type SymbolSelector, type TraversalOptions } from './queries.js';
import type { QueryLimits } from './ranking.js';
import type { RuntimeAcquirer, SemanticRuntime } from './runtime-contract.js';
import { GraphStore } from './store.js';
import { canonicalFilesystemPath, projectStateDirectory } from './paths.js';

export interface CodegraphServiceOptions {
  readonly projectRoot: string;
  readonly store: GraphStore;
  readonly runtime: RuntimeAcquirer;
  readonly index?: (projectRoot: string, runtime: SemanticRuntime) => Promise<IndexBuildResult>;
}

interface ServiceState {
  readonly status: GraphAvailability;
  readonly message: string;
}

function messageFor(status: GraphAvailability): string {
  if (status === 'missing') return 'Codegraph has no indexed snapshot. Run codegraph_index first.';
  if (status === 'stale') return 'Codegraph snapshot is stale. Run codegraph_index to refresh it.';
  if (status === 'indexing') return 'Codegraph is building an index.';
  if (status === 'acquiring-runtime') return 'Codegraph is acquiring its pinned semantic runtime.';
  if (status === 'unavailable') return 'Codegraph semantic runtime is unavailable.';
  if (status === 'error') return 'Codegraph could not read the graph.';
  return 'ok';
}

function emptyResponse<Result>(state: ServiceState, snapshot: SnapshotIdentity | null, coverage: GraphCoverage | null): GraphResponse<Result> {
  return { status: state.status, snapshot, coverage, results: [], omitted: 0, nextCursor: null, tokenEstimate: 0, message: state.message };
}

function aggregateSnapshot(result: IndexBuildResult, runtime: SemanticRuntime, projectRoot: string): SnapshotIdentity {
  const source = result.manifest.sourceManifestHash;
  const configuration = result.manifest.configHash;
  const snapshotId = createHash('sha256').update([projectRoot, source, configuration, runtime.engineId, runtime.engineVersion].join('\0')).digest('hex');
  return {
    schemaVersion: 1,
    snapshotId,
    projectRootHash: createHash('sha256').update(projectRoot).digest('hex'),
    sourceManifestHash: source,
    configHash: configuration,
    engineId: runtime.engineId,
    engineVersion: runtime.engineVersion,
    indexedAt: new Date().toISOString(),
  };
}

export class CodegraphService {
  private readonly projectRoot: string;
  private readonly store: GraphStore;
  private readonly runtime: RuntimeAcquirer;
  private readonly stateDirectory: string;
  private readonly buildIndex: (projectRoot: string, runtime: SemanticRuntime) => Promise<IndexBuildResult>;
  private state: ServiceState = { status: 'missing', message: messageFor('missing') };
  private indexing: Promise<GraphResponse<never>> | undefined;

  constructor(options: CodegraphServiceOptions) {
    this.projectRoot = canonicalFilesystemPath(options.projectRoot);
    this.store = options.store;
    this.runtime = options.runtime;
    this.stateDirectory = projectStateDirectory(this.projectRoot);
    this.buildIndex = options.index ?? ((projectRoot, runtime) => buildProjectIndex(projectRoot, {
      runtime,
      store: { readSnapshot: async () => null, replaceSnapshot: async () => undefined },
    }));
  }

  private async response<Result>(state: ServiceState, snapshot: SnapshotIdentity | null, coverage: GraphCoverage | null): Promise<GraphResponse<Result>> {
    try {
      await mkdir(this.stateDirectory, { recursive: true });
      await writeFile(path.join(this.stateDirectory, 'status.json'), JSON.stringify({ status: state.status, snapshotId: snapshot?.snapshotId }), 'utf8');
    } catch { }
    return emptyResponse(state, snapshot, coverage);
  }

  async status(): Promise<GraphResponse<never>> {
    const snapshot = this.store.snapshot();
    if (snapshot === null) {
      this.state = { status: 'missing', message: messageFor('missing') };
      return this.response(this.state, null, null);
    }
    try {
      const manifest = await buildRelevantInputManifest(this.projectRoot);
      this.state = snapshotIsFresh(snapshot, manifest)
        ? { status: 'ready', message: messageFor('ready') }
        : { status: 'stale', message: messageFor('stale') };
    } catch (error: unknown) {
      this.state = { status: 'error', message: error instanceof Error ? error.message : messageFor('error') };
    }
    return this.response(this.state, snapshot, this.store.coverage(snapshot.snapshotId));
  }

  async index(): Promise<GraphResponse<never>> {
    if (this.indexing !== undefined) return this.indexing;
    this.indexing = this.rebuild().finally(() => { this.indexing = undefined; });
    return this.indexing;
  }

  private async rebuild(): Promise<GraphResponse<never>> {
    this.state = { status: 'acquiring-runtime', message: messageFor('acquiring-runtime') };
    try {
      const acquired = await this.runtime.acquire();
      this.state = { status: 'indexing', message: messageFor('indexing') };
      const runtime: SemanticRuntime = { ...acquired, extractors: [createTypeScriptSemanticExtractor()] };
      const result = await this.buildIndex(this.projectRoot, runtime);
      const snapshot = aggregateSnapshot(result, runtime, this.projectRoot);
      this.store.replaceSnapshot({
        snapshot,
        projects: result.snapshots.map((entry) => entry.project),
        files: result.snapshots.flatMap((entry) => entry.files),
      });
      this.state = { status: 'ready', message: messageFor('ready') };
      return this.response(this.state, snapshot, this.store.coverage(snapshot.snapshotId));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : messageFor('error');
      this.state = { status: 'error', message };
      return this.response(this.state, this.store.snapshot(), this.store.coverage());
    }
  }

  private async ready<Result>(action: () => GraphResponse<Result>): Promise<GraphResponse<Result>> {
    const status = await this.status();
    if (status.status !== 'ready') return this.response({ status: status.status, message: status.message }, status.snapshot, status.coverage);
    try {
      return action();
    } catch (error: unknown) {
      return this.response({ status: 'error', message: error instanceof Error ? error.message : messageFor('error') }, status.snapshot, status.coverage);
    }
  }

  impact(selector: SymbolSelector, options: TraversalOptions): Promise<GraphResponse<unknown>> { return this.ready(() => impact(this.store, selector, options)); }
  path(from: SymbolSelector, to: SymbolSelector, options: Omit<TraversalOptions, 'direction'>): Promise<GraphResponse<unknown>> { return this.ready(() => shortestPath(this.store, from, to, options)); }
  hierarchy(selector: SymbolSelector, options: Omit<TraversalOptions, 'edgeKinds'>): Promise<GraphResponse<unknown>> { return this.ready(() => hierarchy(this.store, selector, options)); }
  modules(mode: 'cycles' | 'layers' | 'fanout', options: QueryLimits & { cursor?: string }): Promise<GraphResponse<unknown>> { return this.ready(() => modules(this.store, mode, options)); }
  context(query: string, options: QueryLimits & { seedFiles?: readonly string[]; maxDepth?: number; cursor?: string }): Promise<GraphResponse<unknown>> { return this.ready(() => context(this.store, query, options)); }
}
