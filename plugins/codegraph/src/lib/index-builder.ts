import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildRelevantInputManifest, type RelevantInputManifest } from './freshness.js';
import { normalizeProjectRelativePath, projectIdentity } from './paths.js';
import type { FileGraph, GraphCoverage, ProjectDescriptor, SnapshotIdentity } from './model.js';
import type { ProjectGraphSnapshot, ProjectSnapshotStore, SemanticRuntime } from './runtime-contract.js';

export interface IndexBuildResult {
  readonly snapshots: readonly ProjectGraphSnapshot[];
  readonly manifest: RelevantInputManifest;
}

export interface IndexBuildDependencies {
  readonly runtime: SemanticRuntime;
  readonly store: ProjectSnapshotStore;
  readonly indexedAt?: () => string;
}

function snapshotId(project: ProjectDescriptor, manifest: RelevantInputManifest, runtime: SemanticRuntime): string {
  return createHash('sha256').update([
    project.id,
    manifest.sourceManifestHash,
    manifest.configHash,
    runtime.engineId,
    runtime.engineVersion,
  ].join('\0')).digest('hex');
}

function coverageFor(files: readonly FileGraph[]): GraphCoverage {
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
  };
}

function repositoryRelativePath(projectRoot: string, project: ProjectDescriptor, file: string): string {
  return normalizeProjectRelativePath(path.relative(projectRoot, path.resolve(project.root || projectRoot, file)));
}

function withRepositoryRelativePaths(
  projectRoot: string,
  project: ProjectDescriptor,
  files: readonly FileGraph[],
): FileGraph[] {
  return files.map((fileGraph) => ({
    ...fileGraph,
    file: repositoryRelativePath(projectRoot, project, fileGraph.file),
    nodes: fileGraph.nodes.map((node) => ({
      ...node,
      declaration: { ...node.declaration, file: repositoryRelativePath(projectRoot, project, node.declaration.file) },
    })),
    edges: fileGraph.edges.map((edge) => ({
      ...edge,
      evidence: { ...edge.evidence, file: repositoryRelativePath(projectRoot, project, edge.evidence.file) },
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
      if (edge.resolution === 'resolved' && edge.targetId === null) {
        throw new Error(`resolved graph edge is missing its target: ${edge.id}`);
      }
      if (edge.resolution !== 'resolved' && edge.targetId !== null) {
        throw new Error(`non-resolved graph edge has a target: ${edge.id}`);
      }
    }
  }
}

async function extractProject(runtime: SemanticRuntime, project: ProjectDescriptor): Promise<FileGraph[]> {
  const extractor = runtime.extractors.find((candidate) => candidate.languages.includes(project.language));
  if (extractor === undefined) throw new Error(`no extractor for ${project.language}`);
  return extractor.extractProject(project);
}

function createSnapshot(
  project: ProjectDescriptor,
  files: readonly FileGraph[],
  manifest: RelevantInputManifest,
  runtime: SemanticRuntime,
  indexedAt: string,
): ProjectGraphSnapshot {
  const snapshot: SnapshotIdentity = {
    schemaVersion: 1,
    snapshotId: snapshotId(project, manifest, runtime),
    projectRootHash: projectIdentity(project.root),
    sourceManifestHash: manifest.sourceManifestHash,
    configHash: manifest.configHash,
    engineId: runtime.engineId,
    engineVersion: runtime.engineVersion,
    indexedAt,
  };
  return { project, snapshot, coverage: coverageFor(files), files };
}

/** Extracts and validates every project before replacing any readable snapshot. */
export async function buildProjectIndex(
  projectRoot: string,
  dependencies: IndexBuildDependencies,
): Promise<IndexBuildResult> {
  const manifest = await buildRelevantInputManifest(projectRoot);
  const projects = (await Promise.all(dependencies.runtime.extractors.map((extractor) => extractor.discoverProjects(projectRoot))))
    .flat()
    .sort((left, right) => left.id.localeCompare(right.id));
  const extracted = await Promise.all(projects.map(async (project) => ({
    project,
    files: withRepositoryRelativePaths(projectRoot, project, await extractProject(dependencies.runtime, project)),
  })));
  for (const result of extracted) validateFiles(result.files);

  const indexedAt = (dependencies.indexedAt ?? (() => new Date().toISOString()))();
  const snapshots = extracted.map(({ project, files }) => createSnapshot(
    project,
    files,
    manifest,
    dependencies.runtime,
    indexedAt,
  ));
  for (const snapshot of snapshots) await dependencies.store.replaceSnapshot(snapshot);
  return { snapshots, manifest };
}
