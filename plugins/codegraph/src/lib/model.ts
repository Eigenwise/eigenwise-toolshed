import { createHash } from 'node:crypto';

export type GraphLanguage = string;

export type GraphNodeKind =
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  | 'parameter';

export type GraphEdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'references'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'overrides'
  | 'aliases';

export type ResolutionState =
  | 'resolved'
  | 'unresolved'
  | 'ambiguous'
  | 'dynamic'
  | 'external';

export interface SourceSpan {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface GraphNode {
  id: string;
  extractor: string;
  language: GraphLanguage;
  kind: GraphNodeKind;
  name: string;
  qualifiedName: string;
  projectId: string;
  declaration: SourceSpan;
  exported: boolean;
  contentHash: string;
}

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  sourceId: string;
  targetId: string | null;
  resolution: ResolutionState;
  evidence: SourceSpan;
  reason?: string;
}

export interface FileGraph {
  file: string;
  contentHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedCount: number;
  diagnostics: string[];
}

export interface ProjectDescriptor {
  id: string;
  root: string;
  configFile: string | null;
  language: GraphLanguage;
}

export interface LanguageExtractor {
  readonly id: string;
  readonly languages: readonly GraphLanguage[];
  discoverProjects(projectRoot: string): Promise<ProjectDescriptor[]>;
  extractProject(project: ProjectDescriptor): Promise<FileGraph[]>;
}

export type GraphAvailability =
  | 'missing'
  | 'acquiring-runtime'
  | 'indexing'
  | 'ready'
  | 'stale'
  | 'unavailable'
  | 'error';

export interface SnapshotIdentity {
  schemaVersion: number;
  snapshotId: string;
  projectRootHash: string;
  sourceManifestHash: string;
  configHash: string;
  engineId: string;
  engineVersion: string;
  indexedAt: string;
}

export interface GraphCoverage {
  projects: number;
  files: number;
  nodes: number;
  edges: number;
  unresolvedEdges: number;
  ambiguousEdges: number;
  dynamicEdges: number;
  externalEdges: number;
}

export interface GraphResponse<Result> {
  status: GraphAvailability;
  snapshot: SnapshotIdentity | null;
  coverage: GraphCoverage | null;
  results: Result[];
  omitted: number;
  nextCursor: string | null;
  tokenEstimate: number;
  message: string;
}

export interface GraphResultOrder {
  rank: number;
  file: string;
  startLine: number;
  kind: string;
  qualifiedName: string;
  id: string;
}

export type GraphNodeIdentity = Pick<
  GraphNode,
  'extractor' | 'projectId' | 'kind' | 'qualifiedName'
> & { declarationFile: string };

export function createGraphNodeId(identity: GraphNodeIdentity): string {
  const identityParts = [
    identity.extractor,
    identity.projectId,
    identity.declarationFile,
    identity.kind,
    identity.qualifiedName,
  ];
  return createHash('sha256').update(identityParts.join('\0')).digest('hex');
}

export function compareGraphResults(
  left: GraphResultOrder,
  right: GraphResultOrder,
): number {
  return right.rank - left.rank
    || left.file.localeCompare(right.file)
    || left.startLine - right.startLine
    || left.kind.localeCompare(right.kind)
    || left.qualifiedName.localeCompare(right.qualifiedName)
    || left.id.localeCompare(right.id);
}

export function sortGraphResults<Result extends GraphResultOrder>(results: readonly Result[]): Result[] {
  return [...results].sort(compareGraphResults);
}

export function assertGraphResponseInvariants<Result>(response: GraphResponse<Result>): void {
  if (response.status !== 'ready' && response.results.length > 0) {
    throw new Error(`${response.status} graph responses cannot include graph results`);
  }
  if (response.status === 'ready' && (response.snapshot === null || response.coverage === null)) {
    throw new Error('ready graph responses require snapshot and coverage');
  }
  if (!Number.isInteger(response.omitted) || response.omitted < 0) {
    throw new Error('graph response omitted count must be a non-negative integer');
  }
  if (!Number.isInteger(response.tokenEstimate) || response.tokenEstimate < 0) {
    throw new Error('graph response token estimate must be a non-negative integer');
  }
}
