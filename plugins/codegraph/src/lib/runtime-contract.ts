import type {
  FileGraph,
  GraphCoverage,
  LanguageExtractor,
  ProjectDescriptor,
  SnapshotIdentity,
} from './model.js';

export interface SemanticRuntime {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly extractors: readonly LanguageExtractor[];
}

export interface RuntimeAcquirer {
  acquire(): Promise<SemanticRuntime>;
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
