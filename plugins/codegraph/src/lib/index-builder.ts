import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildRelevantInputManifest, type RelevantInputManifest } from './freshness.js';
import { createGraphEdgeId, type FileGraph, type GraphCoverage, type GraphEdge, type GraphNode, type ProjectDependencyEnvironment, type ProjectDescriptor, type SnapshotIdentity } from './model.js';
import { canonicalFilesystemPath, normalizeProjectRelativePath, normalizeProjectRoot, projectIdentity } from './paths.js';
import type { FreshnessContributor, ProjectGraphSnapshot, ProjectSnapshotStore, SemanticRuntime } from './runtime-contract.js';
import { runtimeEngineIdentities, snapshotEngineIdentity } from './runtime-contract.js';

export interface IndexBuildResult {
  readonly snapshots: readonly ProjectGraphSnapshot[];
  readonly manifest: RelevantInputManifest;
}

export interface IndexBuildDependencies {
  readonly runtime: SemanticRuntime;
  readonly store: ProjectSnapshotStore;
  readonly freshness?: readonly FreshnessContributor[];
  readonly indexedAt?: () => string;
}

interface ExtractedProject {
  readonly project: ProjectDescriptor;
  readonly dependencyEnvironment: ProjectDependencyEnvironment;
  readonly canonicalRoot: string;
  readonly canonicalConfigPath: string;
  readonly files: readonly FileGraph[];
}

function snapshotId(project: ProjectDescriptor, manifest: RelevantInputManifest, runtime: SemanticRuntime): string {
  const engine = snapshotEngineIdentity(runtimeEngineIdentities(runtime));
  return createHash('sha256').update([
    project.id,
    manifest.sourceManifestHash,
    manifest.configHash,
    engine.id,
    engine.version,
  ].join('\0')).digest('hex');
}

function coverageFor(project: ProjectDescriptor, dependencyEnvironment: ProjectDependencyEnvironment, files: readonly FileGraph[]): GraphCoverage {
  const edges = files.flatMap((file) => file.edges);
  return {
    projects: 1,
    files: files.length,
    nodes: files.reduce((total, file) => total + file.nodes.length, 0),
    edges: edges.length,
    unresolvedEdges: edges.filter((edge) => edge.resolution === 'unresolved').length,
    ambiguousEdges: edges.filter((edge) => edge.resolution === 'ambiguous').length,
    dynamicEdges: edges.filter((edge) => edge.resolution === 'dynamic').length,
    externalEdges: edges.filter((edge) => edge.resolution === 'external').length,
    dependencyEnvironments: [{ projectId: project.id, state: dependencyEnvironment.state }],
  };
}

function withRepositoryRelativePaths(
  canonicalProjectRoot: string,
  project: ProjectDescriptor,
  files: readonly FileGraph[],
): FileGraph[] {
  const canonicalProjectPath = canonicalFilesystemPath(project.root === '' ? canonicalProjectRoot : project.root);
  const repositoryRelativePath = (file: string): string =>
    normalizeProjectRelativePath(path.relative(canonicalProjectRoot, path.resolve(canonicalProjectPath, file)));
  return files.map((fileGraph) => ({
    ...fileGraph,
    file: repositoryRelativePath(fileGraph.file),
    nodes: fileGraph.nodes.map((node) => ({
      ...node,
      declaration: { ...node.declaration, file: repositoryRelativePath(node.declaration.file) },
    })),
    edges: fileGraph.edges.map((edge) => ({
      ...edge,
      evidence: { ...edge.evidence, file: repositoryRelativePath(edge.evidence.file) },
    })),
  }));
}

function validateFiles(files: readonly FileGraph[]): void {
  const filePaths = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const file of files) {
    if (filePaths.has(file.file)) throw new Error(`duplicate file graph: ${file.file}`);
    filePaths.add(file.file);
    for (const node of file.nodes) {
      if (nodeIds.has(node.id)) throw new Error(`duplicate graph node: ${node.id}`);
      nodeIds.add(node.id);
    }
    for (const edge of file.edges) {
      if (edgeIds.has(edge.id)) throw new Error(`duplicate graph edge: ${edge.id}`);
      edgeIds.add(edge.id);
    }
  }
  for (const file of files) {
    for (const edge of file.edges) {
      if (!nodeIds.has(edge.sourceId)) throw new Error(`graph edge source is not retained: ${edge.id}`);
      if (edge.resolution === 'resolved' && edge.targetId === null) {
        throw new Error(`resolved graph edge is missing its target: ${edge.id}`);
      }
      if (edge.resolution === 'resolved' && edge.targetId !== null && !nodeIds.has(edge.targetId)) {
        throw new Error(`resolved graph edge target is not retained: ${edge.id}`);
      }
      if (edge.resolution !== 'resolved' && edge.targetId !== null) {
        throw new Error(`non-resolved graph edge has a target: ${edge.id}`);
      }
    }
  }
}

function projectPathDepth(projectRoot: string): number {
  return projectRoot.split('/').filter((part) => part.length > 0).length;
}

function compareProjectOwnership(left: ExtractedProject, right: ExtractedProject): number {
  return projectPathDepth(right.canonicalRoot) - projectPathDepth(left.canonicalRoot)
    || left.canonicalConfigPath.localeCompare(right.canonicalConfigPath)
    || left.project.id.localeCompare(right.project.id);
}

function nodeRepresentationKey(repositoryFile: string, node: GraphNode): string {
  return JSON.stringify([repositoryFile, node.extractor, node.language, node.kind, node.qualifiedName]);
}

function edgeWithIdentity(edge: Omit<GraphEdge, 'id'>): GraphEdge {
  return { ...edge, id: createGraphEdgeId(edge) };
}

function retainCanonicalFileOwnership(extractedProjects: readonly ExtractedProject[]): ExtractedProject[] {
  const orderedProjects = [...extractedProjects].sort(compareProjectOwnership);
  const ownerByFile = new Map<string, ExtractedProject>();
  for (const extractedProject of orderedProjects) {
    for (const file of extractedProject.files) {
      if (!ownerByFile.has(file.file)) ownerByFile.set(file.file, extractedProject);
    }
  }

  const representationByNodeId = new Map<string, string>();
  const retainedNodeByRepresentation = new Map<string, GraphNode>();
  const retainedNodeIds = new Set<string>();
  for (const extractedProject of extractedProjects) {
    for (const file of extractedProject.files) {
      const retained = ownerByFile.get(file.file) === extractedProject;
      for (const node of file.nodes) {
        const representation = nodeRepresentationKey(file.file, node);
        const existingRepresentation = representationByNodeId.get(node.id);
        if (existingRepresentation !== undefined && existingRepresentation !== representation) {
          throw new Error(`graph node identity has inconsistent representations: ${node.id}`);
        }
        representationByNodeId.set(node.id, representation);
        if (retained) {
          retainedNodeByRepresentation.set(representation, node);
          retainedNodeIds.add(node.id);
        }
      }
    }
  }

  return extractedProjects.map((extractedProject) => ({
    ...extractedProject,
    files: extractedProject.files
      .filter((file) => ownerByFile.get(file.file) === extractedProject)
      .map((file) => {
        const edges = file.edges.map((edge) => {
          if (edge.targetId === null || retainedNodeIds.has(edge.targetId)) return edge;
          const targetRepresentation = representationByNodeId.get(edge.targetId);
          const retainedTarget = targetRepresentation === undefined
            ? undefined
            : retainedNodeByRepresentation.get(targetRepresentation);
          if (retainedTarget !== undefined) {
            return edgeWithIdentity({
              kind: edge.kind,
              sourceId: edge.sourceId,
              targetId: retainedTarget.id,
              resolution: edge.resolution,
              evidence: edge.evidence,
              ...(edge.reason === undefined ? {} : { reason: edge.reason }),
            });
          }
          return edgeWithIdentity({
            kind: edge.kind,
            sourceId: edge.sourceId,
            targetId: null,
            resolution: 'unresolved',
            evidence: edge.evidence,
            reason: 'overlapping project target has no retained declaration',
          });
        });
        return {
          ...file,
          edges,
          unresolvedCount: edges.filter((edge) => edge.resolution === 'unresolved').length,
        };
      }),
  }));
}

async function extractProject(runtime: SemanticRuntime, project: ProjectDescriptor): Promise<FileGraph[]> {
  const extractor = runtime.extractors.find((candidate) => candidate.languages.includes(project.language));
  if (extractor === undefined) throw new Error(`no extractor for ${project.language}`);
  return extractor.extractProject(project);
}

function createSnapshot(
  project: ProjectDescriptor,
  dependencyEnvironment: ProjectDependencyEnvironment,
  files: readonly FileGraph[],
  manifest: RelevantInputManifest,
  runtime: SemanticRuntime,
  indexedAt: string,
): ProjectGraphSnapshot {
  const engine = snapshotEngineIdentity(runtimeEngineIdentities(runtime));
  const snapshot: SnapshotIdentity = {
    schemaVersion: 1,
    snapshotId: snapshotId(project, manifest, runtime),
    projectRootHash: projectIdentity(project.root),
    sourceManifestHash: manifest.sourceManifestHash,
    configHash: manifest.configHash,
    engineId: engine.id,
    engineVersion: engine.version,
    indexedAt,
  };
  return { project, snapshot, coverage: coverageFor(project, dependencyEnvironment, files), files };
}

/** Extracts and validates every project before replacing any readable snapshot. */
export async function buildProjectIndex(
  projectRoot: string,
  dependencies: IndexBuildDependencies,
): Promise<IndexBuildResult> {
  const canonicalRoot = canonicalFilesystemPath(projectRoot);
  const manifest = await buildRelevantInputManifest(canonicalRoot, dependencies.freshness);
  const projects = (await Promise.all(dependencies.runtime.extractors.map((extractor) => extractor.discoverProjects(canonicalRoot))))
    .flat()
    .sort((left, right) => left.id.localeCompare(right.id));
  const extracted = await Promise.all(projects.map(async (project): Promise<ExtractedProject> => ({
    project,
    dependencyEnvironment: dependencies.runtime.dependencyEnvironmentFor === undefined
      ? { state: 'absent', absolutePaths: [] }
      : await dependencies.runtime.dependencyEnvironmentFor(project),
    canonicalRoot: normalizeProjectRoot(project.root === '' ? canonicalRoot : project.root),
    canonicalConfigPath: project.configFile === null ? '' : normalizeProjectRoot(project.configFile),
    files: withRepositoryRelativePaths(canonicalRoot, project, await extractProject(dependencies.runtime, project)),
  })));
  for (const result of extracted) validateFiles(result.files);

  const retained = retainCanonicalFileOwnership(extracted);
  validateFiles(retained.flatMap((result) => result.files));

  const indexedAt = (dependencies.indexedAt ?? (() => new Date().toISOString()))();
  const snapshots = retained.map(({ project, dependencyEnvironment, files }) => createSnapshot(
    project,
    dependencyEnvironment,
    files,
    manifest,
    dependencies.runtime,
    indexedAt,
  ));
  for (const snapshot of snapshots) await dependencies.store.replaceSnapshot(snapshot);
  return { snapshots, manifest };
}
