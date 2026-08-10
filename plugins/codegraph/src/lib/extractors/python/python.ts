import { createHash } from 'node:crypto';
import path from 'node:path';
import { createGraphEdgeId, createGraphNodeId, type FileGraph, type GraphEdge, type GraphNode, type GraphNodeKind, type LanguageExtractor, type ProjectDescriptor, type SourceSpan } from '../../model.js';
import { normalizeProjectRelativePath } from '../../paths.js';
import { pythonFreshnessContributor } from '../../languages/python/freshness.js';
import { discoverPythonProjects } from '../../languages/python/projects.js';
import { PyrightRuntimeAcquirer } from '../../languages/python/runtime.js';
import { isSemanticEngineRuntime, type RuntimeAcquirer, type SemanticEngineRuntime, type SemanticLanguageProvider } from '../../runtime-contract.js';
import { loadPyrightAdapter, type PyrightSemanticCall, type PyrightSemanticDeclaration, type PyrightSemanticFile, type PyrightSemanticReference } from './pyright-adapter.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sourceSpan(file: string, content: string, start: number, length: number): SourceSpan {
  const before = content.slice(0, start);
  const line = before.split(/\r?\n/).length;
  const column = start - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
  return { file, startLine: line, startColumn: column, endLine: line, endColumn: column + length };
}

function addEdge(edges: GraphEdge[], edge: Omit<GraphEdge, 'id'>): void {
  const id = createGraphEdgeId(edge);
  if (!edges.some((candidate) => candidate.id === id)) edges.push({ ...edge, id });
}

function declarationNode(project: ProjectDescriptor, file: string, contentHash: string, declaration: PyrightSemanticDeclaration, qualifiedName: string, content: string): GraphNode {
  const kind: GraphNodeKind = declaration.kind === 'alias' ? 'variable' : declaration.kind;
  return {
    id: createGraphNodeId({ extractor: 'python', projectId: project.id, declarationFile: file, kind, qualifiedName }),
    extractor: 'python', language: 'python', kind, name: declaration.name, qualifiedName, projectId: project.id,
    declaration: sourceSpan(file, content, declaration.start, declaration.length), exported: !declaration.name.startsWith('_'), contentHash,
  };
}

interface ParsedFile {
  readonly absolutePath: string;
  readonly content: string;
  readonly graph: FileGraph;
  readonly aliases: readonly { readonly sourceId: string; readonly declaration: PyrightSemanticDeclaration }[];
  readonly classBases: readonly { readonly sourceId: string; readonly ownerId: string; readonly declaration: PyrightSemanticDeclaration }[];
  readonly calls: readonly PyrightSemanticCall[];
  readonly references: readonly PyrightSemanticReference[];
  readonly ownerNodeIds: ReadonlyMap<number, string>;
  readonly uncertainOwnerStarts: ReadonlySet<number>;
  readonly moduleDynamic: boolean;
}

function parseSemanticFile(project: ProjectDescriptor, semanticFile: PyrightSemanticFile): ParsedFile {
  const file = normalizeProjectRelativePath(path.relative(project.root, semanticFile.absolutePath));
  const contentHash = hash(semanticFile.content);
  const module = {
    id: createGraphNodeId({ extractor: 'python', projectId: project.id, declarationFile: file, kind: 'module', qualifiedName: semanticFile.moduleName }),
    extractor: 'python' as const, language: 'python' as const, kind: 'module' as const, name: file, qualifiedName: semanticFile.moduleName, projectId: project.id,
    declaration: sourceSpan(file, semanticFile.content, 0, 0), exported: true, contentHash,
  };
  const graph: FileGraph = { file, contentHash, nodes: [module], edges: [], unresolvedCount: 0, diagnostics: [] };
  const aliases: { sourceId: string; declaration: PyrightSemanticDeclaration }[] = [];
  const classBases: { sourceId: string; ownerId: string; declaration: PyrightSemanticDeclaration }[] = [];
  const ownerNodeIds = new Map<number, string>();
  const uncertainOwnerStarts = new Set<number>();
  let moduleDynamic = false;

  const addDeclarations = (declarations: readonly PyrightSemanticDeclaration[], ownerId: string, ownerName: string, inheritedUncertainty = false): void => {
    for (const declaration of declarations) {
      const uncertain = inheritedUncertainty || declaration.uncertain;
      if (declaration.name === '__getattr__' && ownerId === module.id) moduleDynamic = true;
      if (uncertain) uncertainOwnerStarts.add(declaration.start);
      if (declaration.kind === 'alias') {
        aliases.push({ sourceId: ownerId, declaration });
        continue;
      }
      const qualifiedName = `${ownerName}.${declaration.name}`;
      const node = declarationNode(project, file, contentHash, declaration, qualifiedName, semanticFile.content);
      graph.nodes.push(node);
      ownerNodeIds.set(declaration.start, node.id);
      addEdge(graph.edges, { kind: 'contains', sourceId: ownerId, targetId: node.id, resolution: 'resolved', evidence: node.declaration });
      if (node.exported && ownerId === module.id) addEdge(graph.edges, { kind: 'exports', sourceId: module.id, targetId: node.id, resolution: 'resolved', evidence: node.declaration });
      if (declaration.kind === 'class') classBases.push({ sourceId: node.id, ownerId, declaration });
      addDeclarations(declaration.children, node.id, qualifiedName, uncertain);
    }
  };
  addDeclarations(semanticFile.declarations, module.id, semanticFile.moduleName);
  return {
    absolutePath: semanticFile.absolutePath,
    content: semanticFile.content,
    graph,
    aliases,
    classBases,
    calls: semanticFile.calls,
    references: semanticFile.references,
    ownerNodeIds,
    uncertainOwnerStarts,
    moduleDynamic,
  };
}

function addResolvedAliases(parsedFiles: readonly ParsedFile[]): void {
  const targetNodes = new Map<string, string>();
  const targetsByLocation = new Map<string, string>();
  const projectFiles = new Set<string>();
  for (const parsedFile of parsedFiles) {
    const absolutePath = path.resolve(parsedFile.absolutePath);
    projectFiles.add(absolutePath);
    for (const node of parsedFile.graph.nodes) targetNodes.set(`${absolutePath}:${node.name}`, node.id);
    for (const [start, nodeId] of parsedFile.ownerNodeIds) targetsByLocation.set(`${absolutePath}:${start}`, nodeId);
  }
  const aliasTargets = new Map<string, string>();
  for (const parsedFile of parsedFiles) {
    for (const { sourceId, declaration } of parsedFile.aliases) {
      const targetId = declaration.targetPath === null || declaration.targetName === null
        ? null
        : targetNodes.get(`${path.resolve(declaration.targetPath)}:${declaration.targetName}`) ?? null;
      const resolution = targetId !== null ? 'resolved' as const
        : declaration.targetPath === null || projectFiles.has(path.resolve(declaration.targetPath)) ? 'unresolved' as const : 'external' as const;
      const reason = resolution === 'resolved' ? undefined : resolution === 'external' ? 'Pyright resolved a target outside this project' : 'Pyright did not prove a project-owned target';
      const evidence = sourceSpan(parsedFile.graph.file, '', declaration.start, declaration.length);
      addEdge(parsedFile.graph.edges, { kind: 'imports', sourceId, targetId, resolution, evidence, reason });
      addEdge(parsedFile.graph.edges, { kind: 'aliases', sourceId, targetId, resolution, evidence, reason });
      if (targetId !== null) {
        aliasTargets.set(`${parsedFile.absolutePath}:${sourceId}:${declaration.name}`, targetId);
        addEdge(parsedFile.graph.edges, { kind: 'exports', sourceId, targetId, resolution, evidence });
      }
    }
  }
  for (const parsedFile of parsedFiles) {
    for (const { sourceId, ownerId, declaration } of parsedFile.classBases) {
      const evidence = parsedFile.graph.nodes.find((node) => node.id === sourceId)?.declaration
        ?? sourceSpan(parsedFile.graph.file, '', declaration.start, declaration.length);
      for (const baseTarget of declaration.baseTargets) {
        const targetId = baseTarget.target === null ? null : targetsByLocation.get(`${path.resolve(baseTarget.target.path)}:${baseTarget.target.start}`) ?? targetNodes.get(`${path.resolve(baseTarget.target.path)}:${baseTarget.target.name}`) ?? null;
        const resolution = baseTarget.uncertainty ?? (targetId === null ? 'external' : 'resolved');
        addEdge(parsedFile.graph.edges, {
          kind: 'extends', sourceId, targetId: resolution === 'resolved' ? targetId : null, resolution, evidence,
          reason: resolution === 'resolved' ? undefined : resolution === 'external' ? 'Pyright resolved a base class outside this project' : 'Pyright did not prove one project-owned base class',
        });
      }
    }
    const moduleId = parsedFile.graph.nodes[0]!.id;
    const sourceId = (ownerStart: number | null): string => ownerStart === null ? moduleId : parsedFile.ownerNodeIds.get(ownerStart) ?? moduleId;
    const targetId = (target: { path: string; name: string; start: number }): string | null => targetsByLocation.get(`${path.resolve(target.path)}:${target.start}`) ?? targetNodes.get(`${path.resolve(target.path)}:${target.name}`) ?? null;
    const relationResolution = (target: { path: string; start: number } | null, uncertainty: 'unresolved' | 'dynamic' | 'ambiguous' | null): 'resolved' | 'unresolved' | 'dynamic' | 'ambiguous' | 'external' => {
      if (uncertainty !== null || parsedFile.moduleDynamic) return uncertainty ?? 'ambiguous';
      if (target === null) return 'dynamic';
      return projectFiles.has(path.resolve(target.path)) ? 'resolved' : 'external';
    };
    for (const call of parsedFile.calls) {
      const resolvedTargetId = call.target === null ? null : targetId(call.target);
      const resolution = relationResolution(call.target, parsedFile.uncertainOwnerStarts.has(call.ownerStart ?? -1) ? 'ambiguous' : call.uncertainty);
      addEdge(parsedFile.graph.edges, {
        kind: 'calls', sourceId: sourceId(call.ownerStart), targetId: resolution === 'resolved' ? resolvedTargetId : null, resolution,
        evidence: sourceSpan(parsedFile.graph.file, parsedFile.content, call.start, call.length),
        reason: resolution === 'resolved' ? undefined : resolution === 'external' ? 'Pyright resolved a target outside this project' : 'Pyright could not prove a stable project-owned call target',
      });
    }
    for (const reference of parsedFile.references) {
      const resolvedTargetId = reference.target === null ? null : targetId(reference.target);
      const resolution = reference.uncertainty ?? (parsedFile.moduleDynamic || parsedFile.uncertainOwnerStarts.has(reference.ownerStart ?? -1)
        ? 'ambiguous' as const
        : resolvedTargetId !== null ? 'resolved' as const : reference.target !== null && projectFiles.has(path.resolve(reference.target.path)) ? 'unresolved' as const : 'external' as const);
      addEdge(parsedFile.graph.edges, {
        kind: 'references', sourceId: sourceId(reference.ownerStart), targetId: resolution === 'resolved' ? resolvedTargetId : null, resolution,
        evidence: sourceSpan(parsedFile.graph.file, parsedFile.content, reference.start, reference.length),
        reason: resolution === 'resolved' ? undefined : resolution === 'external' ? 'Pyright resolved a target outside this project' : 'Pyright could not prove a stable project-owned reference target',
      });
    }
    parsedFile.graph.unresolvedCount = parsedFile.graph.edges.filter((edge) => edge.resolution === 'unresolved').length;
  }

}

export class PyrightSemanticExtractor implements LanguageExtractor {
  readonly id = 'python';
  readonly languages = ['python'] as const;

  constructor(private readonly runtime: SemanticEngineRuntime) {}

  async discoverProjects(projectRoot: string): Promise<ProjectDescriptor[]> {
    return discoverPythonProjects(projectRoot);
  }

  async extractProject(project: ProjectDescriptor): Promise<FileGraph[]> {
    const adapter = await loadPyrightAdapter(this.runtime);
    const service = adapter.createAnalysisService(project.root, project.configFile);
    try {
      while (service.analyze()) undefined;
      const parsedFiles = service.semanticFiles().map((semanticFile) => parseSemanticFile(project, semanticFile));
      addResolvedAliases(parsedFiles);
      return parsedFiles.map((parsed) => parsed.graph).sort((left, right) => left.file.localeCompare(right.file));
    } finally {
      service.dispose();
    }
  }
}

export class PythonLanguageProvider implements SemanticLanguageProvider {
  readonly id = 'python';
  readonly languages = ['python'] as const;
  readonly freshness = pythonFreshnessContributor;

  constructor(private readonly runtime: RuntimeAcquirer = new PyrightRuntimeAcquirer()) {}

  async acquireEngine(): Promise<SemanticEngineRuntime> {
    const runtime = await this.runtime.acquire();
    if (!isSemanticEngineRuntime(runtime)) throw new Error('Pyright runtime must provide module loading');
    return runtime;
  }

  createExtractor(runtime: SemanticEngineRuntime): PyrightSemanticExtractor {
    return new PyrightSemanticExtractor(runtime);
  }
}
