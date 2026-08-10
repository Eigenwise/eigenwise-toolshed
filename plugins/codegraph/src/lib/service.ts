import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRelevantInputManifest, snapshotIsFresh, typeScriptFreshnessContributor } from './freshness.js';
import { buildProjectIndex, type IndexBuildResult } from './index-builder.js';
import type { GraphAvailability, GraphCoverage, GraphResponse, PersistedGraphStatus, PersistedIndexFailure, SnapshotIdentity } from './model.js';
import type { FreshnessContributor, RuntimeAcquirer, SemanticRuntime } from './runtime-contract.js';
import { runtimeEngineIdentities, SemanticLanguageProviderRegistry, snapshotEngineIdentity } from './runtime-contract.js';
import { createTypeScriptSemanticExtractor } from './extractors/typescript.js';
import { impact, shortestPath, hierarchy, modules, context, type SymbolSelector, type TraversalOptions } from './queries.js';
import type { QueryLimits } from './ranking.js';
import { GraphStore } from './store.js';
import { canonicalFilesystemPath, projectStateDirectory } from './paths.js';

export interface CodegraphServiceOptions {
  readonly projectRoot: string;
  readonly store: GraphStore;
  readonly runtime?: RuntimeAcquirer;
  readonly providers?: SemanticLanguageProviderRegistry;
  readonly index?: (projectRoot: string, runtime: SemanticRuntime) => Promise<IndexBuildResult>;
}

interface ServiceState {
  readonly status: GraphAvailability;
  readonly message: string;
  readonly failure?: PersistedIndexFailure;
}

const persistedStatuses = new Set(['missing', 'ready', 'stale', 'unavailable', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPersistedIndexFailure(value: unknown): value is PersistedIndexFailure {
  return isRecord(value)
    && typeof value.reason === 'string'
    && value.reason.length > 0
    && typeof value.failedAt === 'string'
    && value.failedAt.length > 0;
}

function malformedStatusState(): ServiceState {
  return { status: 'error', message: 'Codegraph status metadata is malformed. Run codegraph_index to recover.' };
}

function persistedFailureState(value: unknown): ServiceState | undefined {
  if (!isRecord(value) || typeof value.status !== 'string' || !persistedStatuses.has(value.status)) {
    return malformedStatusState();
  }
  if (value.status !== 'error') return value.failure === undefined ? undefined : malformedStatusState();
  if (!isPersistedIndexFailure(value.failure)) return malformedStatusState();
  return { status: 'error', message: value.failure.reason, failure: value.failure };
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

function emptySnapshotMessage(): string {
  return 'Codegraph snapshot has no indexed source files. Check project configuration, then run codegraph_index.';
}

function emptyResponse<Result>(state: ServiceState, snapshot: SnapshotIdentity | null, coverage: GraphCoverage | null): GraphResponse<Result> {
  return { status: state.status, snapshot, coverage, results: [], omitted: 0, nextCursor: null, tokenEstimate: 0, message: state.message };
}

function aggregateSnapshot(result: IndexBuildResult, runtime: SemanticRuntime, projectRoot: string): SnapshotIdentity {
  const source = result.manifest.sourceManifestHash;
  const configuration = result.manifest.configHash;
  const engine = snapshotEngineIdentity(runtimeEngineIdentities(runtime));
  const snapshotId = createHash('sha256').update([projectRoot, source, configuration, engine.id, engine.version].join('\0')).digest('hex');
  return {
    schemaVersion: 1,
    snapshotId,
    projectRootHash: createHash('sha256').update(projectRoot).digest('hex'),
    sourceManifestHash: source,
    configHash: configuration,
    engineId: engine.id,
    engineVersion: engine.version,
    indexedAt: new Date().toISOString(),
  };
}

export class CodegraphService {
  private readonly projectRoot: string;
  private readonly store: GraphStore;
  private readonly providers: SemanticLanguageProviderRegistry | undefined;
  private readonly legacyRuntime: RuntimeAcquirer | undefined;
  private readonly freshness: readonly FreshnessContributor[];
  private readonly stateDirectory: string;
  private readonly buildIndex: (projectRoot: string, runtime: SemanticRuntime) => Promise<IndexBuildResult>;
  private readonly persistedState: Promise<ServiceState | undefined>;
  private state: ServiceState = { status: 'missing', message: messageFor('missing') };
  private statusPointerMissing = false;
  private persistedFailureCleared = false;
  private indexing: Promise<GraphResponse<never>> | undefined;

  constructor(options: CodegraphServiceOptions) {
    this.projectRoot = canonicalFilesystemPath(options.projectRoot);
    this.store = options.store;
    if (options.providers === undefined && options.runtime === undefined) {
      throw new Error('Codegraph requires a semantic language provider registry or runtime acquirer');
    }
    this.providers = options.providers;
    this.legacyRuntime = options.providers === undefined ? options.runtime : undefined;
    this.freshness = this.providers?.freshnessContributors() ?? [typeScriptFreshnessContributor];
    this.stateDirectory = projectStateDirectory(this.projectRoot);
    this.persistedState = this.readPersistedState();
    this.buildIndex = options.index ?? ((projectRoot, runtime) => buildProjectIndex(projectRoot, {
      runtime,
      freshness: this.freshness,
      store: { readSnapshot: async () => null, replaceSnapshot: async () => undefined },
    }));
  }

  private async readPersistedState(): Promise<ServiceState | undefined> {
    try {
      const raw = await readFile(path.join(this.stateDirectory, 'status.json'), 'utf8');
      const value: unknown = JSON.parse(raw);
      return persistedFailureState(value);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.statusPointerMissing = true;
        return undefined;
      }
      return malformedStatusState();
    }
  }

  private async persistStatus(state: ServiceState, snapshot: SnapshotIdentity | null): Promise<void> {
    const pointer: PersistedGraphStatus = {
      status: state.status,
      ...(snapshot === null ? {} : { snapshotId: snapshot.snapshotId }),
      ...(state.failure === undefined ? {} : { failure: state.failure }),
    };
    try {
      await mkdir(this.stateDirectory, { recursive: true });
      await writeFile(path.join(this.stateDirectory, 'status.json'), JSON.stringify(pointer), 'utf8');
      this.statusPointerMissing = false;
    } catch { }
  }

  private async response<Result>(state: ServiceState, snapshot: SnapshotIdentity | null, coverage: GraphCoverage | null): Promise<GraphResponse<Result>> {
    return emptyResponse(state, snapshot, coverage);
  }

  private async persistAndRespond<Result>(state: ServiceState, snapshot: SnapshotIdentity | null, coverage: GraphCoverage | null): Promise<GraphResponse<Result>> {
    await this.persistStatus(state, snapshot);
    return this.response(state, snapshot, coverage);
  }

  async status(): Promise<GraphResponse<never>> {
    const persistedState = await this.persistedState;
    const snapshot = this.store.snapshot();
    const coverage = snapshot === null ? null : this.store.coverage(snapshot.snapshotId);
    const failedState = this.state.status === 'error'
      ? this.state
      : this.persistedFailureCleared ? undefined : persistedState;
    if (failedState?.status === 'error') {
      this.state = failedState;
      return this.response(this.state, snapshot, coverage);
    }
    if (this.statusPointerMissing && snapshot !== null) {
      this.state = { status: 'error', message: 'Codegraph status metadata is missing. Run codegraph_index to recover.' };
      return this.response(this.state, snapshot, coverage);
    }
    if (snapshot === null) {
      this.state = { status: 'missing', message: messageFor('missing') };
      return this.response(this.state, null, null);
    }
    if (coverage?.files === 0) {
      this.state = { status: 'missing', message: emptySnapshotMessage() };
      return this.response(this.state, snapshot, coverage);
    }
    try {
      const manifest = await buildRelevantInputManifest(this.projectRoot, this.freshness);
      this.state = snapshotIsFresh(snapshot, manifest)
        ? { status: 'ready', message: messageFor('ready') }
        : { status: 'stale', message: messageFor('stale') };
      return this.response(this.state, snapshot, coverage);
    } catch (error: unknown) {
      this.state = { status: 'error', message: error instanceof Error ? error.message : messageFor('error') };
      return this.response(this.state, snapshot, coverage);
    }
  }

  async index(): Promise<GraphResponse<never>> {
    if (this.indexing !== undefined) return this.indexing;
    this.indexing = this.rebuild().finally(() => { this.indexing = undefined; });
    return this.indexing;
  }

  private async rebuild(): Promise<GraphResponse<never>> {
    await this.persistedState;
    this.state = { status: 'acquiring-runtime', message: messageFor('acquiring-runtime') };
    try {
      const acquired = this.providers !== undefined
        ? await this.providers.acquireRuntime()
        : await this.legacyRuntime!.acquire();
      const runtime = this.providers === undefined && acquired.extractors.length === 0
        ? { ...acquired, extractors: [createTypeScriptSemanticExtractor()] }
        : acquired;
      this.state = { status: 'indexing', message: messageFor('indexing') };
      const result = await this.buildIndex(this.projectRoot, runtime);
      const snapshot = aggregateSnapshot(result, runtime, this.projectRoot);
      this.store.replaceSnapshot({
        snapshot,
        projects: result.snapshots.map((entry) => entry.project),
        dependencyEnvironments: result.snapshots.flatMap((entry) => entry.coverage.dependencyEnvironments),
        files: result.snapshots.flatMap((entry) => entry.files),
      });
      this.persistedFailureCleared = true;
      const coverage = this.store.coverage(snapshot.snapshotId);
      this.state = coverage?.files === 0
        ? { status: 'missing', message: emptySnapshotMessage() }
        : { status: 'ready', message: messageFor('ready') };
      return this.persistAndRespond(this.state, snapshot, coverage);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : messageFor('error');
      this.state = { status: 'error', message, failure: { reason: message, failedAt: new Date().toISOString() } };
      return this.persistAndRespond(this.state, this.store.snapshot(), this.store.coverage());
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
