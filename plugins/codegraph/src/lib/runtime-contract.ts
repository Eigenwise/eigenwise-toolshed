import type {
  FileGraph,
  GraphCoverage,
  GraphLanguage,
  LanguageExtractor,
  ProjectDependencyEnvironment,
  ProjectDescriptor,
  SnapshotIdentity,
} from './model.js';

export interface SemanticEngineIdentity {
  readonly id: string;
  readonly version: string;
}

export interface SemanticEngineRuntime extends SemanticEngineIdentity {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly extractors: readonly LanguageExtractor[];
  importModule(specifier: string): Promise<unknown>;
}

export interface RelevantInputCandidate {
  readonly absolutePath: string;
  readonly configuration: boolean;
}

export interface FreshnessContributor {
  collect(projectRoot: string): Promise<readonly RelevantInputCandidate[]>;
}

export interface DependencyEnvironmentDiscovery {
  discover(project: ProjectDescriptor): Promise<ProjectDependencyEnvironment>;
}

export interface SemanticLanguageProvider {
  readonly id: string;
  readonly languages: readonly GraphLanguage[];
  readonly freshness: FreshnessContributor;
  readonly dependencyEnvironment: DependencyEnvironmentDiscovery;
  acquireEngine(): Promise<SemanticEngineRuntime>;
  createExtractor(runtime: SemanticEngineRuntime): LanguageExtractor;
}

export interface SemanticRuntime {
  readonly engines?: readonly SemanticEngineIdentity[];
  readonly engineId: string;
  readonly engineVersion: string;
  readonly extractors: readonly LanguageExtractor[];
  readonly dependencyEnvironmentFor?: (project: ProjectDescriptor) => Promise<ProjectDependencyEnvironment>;
}

export interface RuntimeAcquirer {
  acquire(): Promise<SemanticEngineRuntime | SemanticRuntime>;
}

export function isSemanticEngineRuntime(runtime: SemanticEngineRuntime | SemanticRuntime): runtime is SemanticEngineRuntime {
  return 'importModule' in runtime;
}

export function runtimeEngineIdentities(runtime: SemanticRuntime): readonly SemanticEngineIdentity[] {
  return runtime.engines ?? [{ id: runtime.engineId, version: runtime.engineVersion }];
}

export class SemanticLanguageProviderRegistry {
  readonly providers: readonly SemanticLanguageProvider[];

  constructor(providers: readonly SemanticLanguageProvider[]) {
    const orderedProviders = [...providers].sort((left, right) => left.id.localeCompare(right.id));
    for (let index = 1; index < orderedProviders.length; index += 1) {
      if (orderedProviders[index - 1]!.id === orderedProviders[index]!.id) {
        throw new Error(`duplicate semantic language provider: ${orderedProviders[index]!.id}`);
      }
    }
    this.providers = orderedProviders;
  }

  freshnessContributors(): readonly FreshnessContributor[] {
    return this.providers.map((provider) => provider.freshness);
  }

  async acquireRuntime(): Promise<SemanticRuntime> {
    const acquiredProviders = await Promise.all(this.providers.map(async (provider) => ({
      provider,
      runtime: await provider.acquireEngine(),
    })));
    const engines = acquiredProviders
      .map(({ runtime }) => ({ id: runtime.id, version: runtime.version }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
    const extractors = acquiredProviders
      .sort(({ provider: left }, { provider: right }) => left.id.localeCompare(right.id))
      .map(({ provider, runtime }) => provider.createExtractor(runtime));
    const identity = snapshotEngineIdentity(engines);
    return {
      engines,
      engineId: identity.id,
      engineVersion: identity.version,
      extractors,
      dependencyEnvironmentFor: async (project) => {
        const provider = this.providers.find((candidate) => candidate.languages.includes(project.language));
        return provider === undefined
          ? { state: 'absent', absolutePaths: [] }
          : provider.dependencyEnvironment.discover(project);
      },
    };
  }
}

export function snapshotEngineIdentity(engines: readonly SemanticEngineIdentity[]): SemanticEngineIdentity {
  const orderedEngines = [...engines].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  if (orderedEngines.length === 1) return orderedEngines[0]!;
  return { id: 'codegraph-engines', version: JSON.stringify(orderedEngines) };
}

export interface ProjectGraphSnapshot {
  project: ProjectDescriptor;
  snapshot: SnapshotIdentity;
  coverage: GraphCoverage;
  files: readonly FileGraph[];
}

export interface ProjectSnapshotStore {
  readSnapshot(projectId: string): Promise<SnapshotIdentity | null>;
  replaceSnapshot(snapshot: ProjectGraphSnapshot): Promise<void>;
}

export interface ProjectExtractorResolver {
  extractorsFor(project: ProjectDescriptor): readonly LanguageExtractor[];
}
