import { createHash } from 'node:crypto';
import path from 'node:path';
import type { API, Checker, Project, Snapshot, Symbol as TypeScriptSymbol } from 'typescript/unstable/sync' with { "resolution-mode": "import" };
import type {
  CallExpression,
  ClassDeclaration,
  ConstructorDeclaration,
  FunctionDeclaration,
  Identifier,
  ImportDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  MethodSignatureDeclaration,
  NamespaceImport,
  Node,
  PropertyAccessExpression,
  SourceFile,
  VariableDeclaration,
  VariableStatement,
} from 'typescript/unstable/ast' with { "resolution-mode": "import" };
import { createGraphNodeId, type FileGraph, type GraphEdge, type GraphEdgeKind, type GraphNode, type GraphNodeKind, type LanguageExtractor, type ProjectDescriptor, type ResolutionState, type SourceSpan } from '../model.js';
import { normalizeProjectRelativePath } from '../paths.js';
import { discoverProjects } from '../projects.js';

interface TypeScriptSyncModule {
  readonly API: new () => API;
  readonly SymbolFlags: { readonly Alias: number };
}

interface TypeScriptAstModule {
  isIdentifier(node: Node): node is Identifier;
  isClassDeclaration(node: Node): node is ClassDeclaration;
  isInterfaceDeclaration(node: Node): node is InterfaceDeclaration;
  isFunctionDeclaration(node: Node): node is FunctionDeclaration;
  isMethodDeclaration(node: Node): node is MethodDeclaration;
  isMethodSignatureDeclaration(node: Node): node is MethodSignatureDeclaration;
  isConstructorDeclaration(node: Node): node is ConstructorDeclaration;
  isVariableDeclaration(node: Node): node is VariableDeclaration;
  isVariableStatement(node: Node): node is VariableStatement;
  isCallExpression(node: Node): node is CallExpression;
  isPropertyAccessExpression(node: Node): node is PropertyAccessExpression;
  isImportDeclaration(node: Node): node is ImportDeclaration;
  isNamespaceImport(node: Node): node is NamespaceImport;
  isExportDeclaration(node: Node): boolean;
}

interface LoadedTypeScript {
  readonly api: API;
  readonly ast: TypeScriptAstModule;
  readonly aliasSymbolFlag: number;
}

// The package is ESM while Codegraph's committed runtime is CommonJS.
function importEsmModule(specifier: string): Promise<unknown> {
  return new Function('moduleSpecifier', 'return import(moduleSpecifier);')(specifier);
}

function isTypeScriptSyncModule(value: unknown): value is TypeScriptSyncModule {
  return typeof value === 'object' && value !== null && 'API' in value && typeof value.API === 'function'
    && 'SymbolFlags' in value && typeof value.SymbolFlags === 'object' && value.SymbolFlags !== null
    && 'Alias' in value.SymbolFlags && typeof value.SymbolFlags.Alias === 'number';
}

function isTypeScriptAstModule(value: unknown): value is TypeScriptAstModule {
  if (typeof value !== 'object' || value === null) return false;
  return 'isIdentifier' in value && typeof value.isIdentifier === 'function'
    && 'isClassDeclaration' in value && typeof value.isClassDeclaration === 'function'
    && 'isInterfaceDeclaration' in value && typeof value.isInterfaceDeclaration === 'function'
    && 'isFunctionDeclaration' in value && typeof value.isFunctionDeclaration === 'function'
    && 'isMethodDeclaration' in value && typeof value.isMethodDeclaration === 'function'
    && 'isMethodSignatureDeclaration' in value && typeof value.isMethodSignatureDeclaration === 'function'
    && 'isConstructorDeclaration' in value && typeof value.isConstructorDeclaration === 'function'
    && 'isVariableDeclaration' in value && typeof value.isVariableDeclaration === 'function'
    && 'isVariableStatement' in value && typeof value.isVariableStatement === 'function'
    && 'isCallExpression' in value && typeof value.isCallExpression === 'function'
    && 'isPropertyAccessExpression' in value && typeof value.isPropertyAccessExpression === 'function'
    && 'isImportDeclaration' in value && typeof value.isImportDeclaration === 'function'
    && 'isNamespaceImport' in value && typeof value.isNamespaceImport === 'function'
    && 'isExportDeclaration' in value && typeof value.isExportDeclaration === 'function';
}

async function loadTypeScript(): Promise<LoadedTypeScript> {
  const [syncModule, astModule] = await Promise.all([
    importEsmModule('typescript/unstable/sync'),
    importEsmModule('typescript/unstable/ast'),
  ]);
  if (!isTypeScriptSyncModule(syncModule) || !isTypeScriptAstModule(astModule)) {
    throw new Error('the pinned TypeScript runtime does not expose its sync semantic API');
  }
  return { api: new syncModule.API(), ast: astModule, aliasSymbolFlag: syncModule.SymbolFlags.Alias };
}

function relativeFile(project: ProjectDescriptor, fileName: string): string {
  return normalizeProjectRelativePath(path.relative(project.root, fileName));
}

function sourceSpan(project: ProjectDescriptor, sourceFile: SourceFile, node: Node): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: relativeFile(project, sourceFile.fileName),
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isProjectSource(project: ProjectDescriptor, sourceFile: SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return false;
  const relative = path.relative(project.root, sourceFile.fileName);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    && /\.[cm]?[jt]sx?$/i.test(sourceFile.fileName);
}

function declarationName(node: Node, ast: TypeScriptAstModule): Identifier | undefined {
  if (ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isFunctionDeclaration(node)
    || ast.isMethodDeclaration(node) || ast.isMethodSignatureDeclaration(node) || ast.isVariableDeclaration(node)) {
    return node.name !== undefined && ast.isIdentifier(node.name) ? node.name : undefined;
  }
  return undefined;
}

function declarationKind(node: Node, ast: TypeScriptAstModule): GraphNodeKind | undefined {
  if (ast.isClassDeclaration(node)) return 'class';
  if (ast.isInterfaceDeclaration(node)) return 'interface';
  if (ast.isFunctionDeclaration(node)) return 'function';
  if (ast.isMethodDeclaration(node) || ast.isMethodSignatureDeclaration(node)) return 'method';
  if (ast.isConstructorDeclaration(node)) return 'constructor';
  if (ast.isVariableDeclaration(node)) return 'variable';
  return undefined;
}

function isIndexableDeclaration(node: Node, kind: GraphNodeKind, sourceFile: SourceFile, ast: TypeScriptAstModule): boolean {
  if (kind === 'variable') return ast.isVariableStatement(node.parent.parent) && node.parent.parent.parent === sourceFile;
  if (kind === 'method') return ast.isClassDeclaration(node.parent) || ast.isInterfaceDeclaration(node.parent);
  return true;
}

function declarationQualifier(symbol: TypeScriptSymbol, fallbackName: string): string {
  const names: string[] = [fallbackName];
  let parent = symbol.getParent();
  while (parent !== undefined && parent.name !== '__global') {
    names.unshift(parent.name);
    parent = parent.getParent();
  }
  return names.join('.');
}

function edgeId(kind: GraphEdgeKind, sourceId: string, targetId: string | null, resolution: ResolutionState, evidence: SourceSpan, reason: string | undefined): string {
  return createHash('sha256').update([
    kind,
    sourceId,
    targetId ?? '',
    resolution,
    evidence.file,
    String(evidence.startLine),
    String(evidence.startColumn),
    reason ?? '',
  ].join('\0')).digest('hex');
}

function isExported(node: Node, sourceFile: SourceFile): boolean {
  return /^export\s/.test(node.getText(sourceFile).trimStart());
}

function nearestOwner(node: Node, declarations: ReadonlyMap<Node, string>, moduleId: string): string {
  let current: Node | undefined = node;
  while (current !== undefined) {
    const declarationId = declarations.get(current);
    if (declarationId !== undefined) return declarationId;
    current = current.parent;
  }
  return moduleId;
}

function resolvedTarget(
  checker: Checker,
  node: Node,
  declarationIds: ReadonlyMap<number, string>,
  declarationNodes: ReadonlyMap<Node, string>,
  aliasSymbolFlag: number,
): { readonly targetId: string | null; readonly resolution: ResolutionState; readonly reason?: string } {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return { targetId: null, resolution: 'unresolved', reason: 'TypeScript could not resolve this symbol' };
  const canonical = (symbol.flags & aliasSymbolFlag) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  if (checker.isUnknownSymbol(canonical)) {
    return { targetId: null, resolution: 'unresolved', reason: 'TypeScript reported an unresolved alias' };
  }
  const declaration = canonical.declarations[0]?.resolve();
  const targetId = declarationIds.get(canonical.id) ?? declarationIds.get(symbol.id)
    ?? (declaration === undefined ? undefined : declarationNodes.get(declaration));
  if (targetId !== undefined) return { targetId, resolution: 'resolved' };
  if (declaration !== undefined && declaration.getSourceFile().isDeclarationFile) {
    return { targetId: null, resolution: 'external', reason: 'symbol resolves to an external declaration' };
  }
  return { targetId: null, resolution: 'unresolved', reason: 'symbol has no project-owned declaration' };
}

function resolvedModuleTarget(
  checker: Checker,
  node: Node,
  moduleIds: ReadonlyMap<string, string>,
  aliasSymbolFlag: number,
): { readonly targetId: string | null; readonly resolution: ResolutionState; readonly reason?: string } {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return { targetId: null, resolution: 'unresolved', reason: 'TypeScript could not resolve this module' };
  const canonical = (symbol.flags & aliasSymbolFlag) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  if (checker.isUnknownSymbol(canonical)) {
    return { targetId: null, resolution: 'unresolved', reason: 'TypeScript reported an unresolved module alias' };
  }
  const declaration = canonical.declarations[0]?.resolve();
  if (declaration === undefined) return { targetId: null, resolution: 'unresolved', reason: 'module has no resolved declaration' };
  const targetId = moduleIds.get(declaration.getSourceFile().fileName);
  if (targetId !== undefined) return { targetId, resolution: 'resolved' };
  if (declaration.getSourceFile().isDeclarationFile) {
    return { targetId: null, resolution: 'external', reason: 'module resolves to an external declaration' };
  }
  return { targetId: null, resolution: 'unresolved', reason: 'module has no project-owned declaration' };
}

function identifiersWithin(node: Node, ast: TypeScriptAstModule): Identifier[] {
  const identifiers: Identifier[] = [];
  const visit = (current: Node): void => {
    if (ast.isIdentifier(current)) identifiers.push(current);
    current.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(node);
  return identifiers;
}

function addEdge(edges: GraphEdge[], edge: Omit<GraphEdge, 'id'>): void {
  const id = edgeId(edge.kind, edge.sourceId, edge.targetId, edge.resolution, edge.evidence, edge.reason);
  if (!edges.some((candidate) => candidate.id === id)) edges.push({ ...edge, id });
}

function collectNodes(
  project: ProjectDescriptor,
  checker: Checker,
  ast: TypeScriptAstModule,
  sourceFiles: readonly SourceFile[],
): { readonly graphs: Map<string, FileGraph>; readonly declarationIds: Map<number, string>; readonly declarationNodes: Map<Node, string>; readonly classMembers: Map<string, Map<string, string>>; readonly moduleIds: Map<string, string> } {
  const graphs = new Map<string, FileGraph>();
  const declarationIds = new Map<number, string>();
  const declarationNodes = new Map<Node, string>();
  const classMembers = new Map<string, Map<string, string>>();
  const moduleIds = new Map<string, string>();

  for (const sourceFile of sourceFiles) {
    const file = relativeFile(project, sourceFile.fileName);
    const moduleId = createGraphNodeId({ extractor: 'typescript', projectId: project.id, declarationFile: file, kind: 'module', qualifiedName: file });
    const moduleNode: GraphNode = {
      id: moduleId,
      extractor: 'typescript',
      language: project.language,
      kind: 'module',
      name: file,
      qualifiedName: file,
      projectId: project.id,
      declaration: sourceSpan(project, sourceFile, sourceFile),
      exported: true,
      contentHash: hash(sourceFile.text),
    };
    const graph: FileGraph = { file, contentHash: hash(sourceFile.text), nodes: [moduleNode], edges: [], unresolvedCount: 0, diagnostics: [] };
    graphs.set(sourceFile.fileName, graph);
    moduleIds.set(sourceFile.fileName, moduleId);

    const visit = (node: Node): void => {
      const kind = declarationKind(node, ast);
      const name = declarationName(node, ast);
      if (kind !== undefined && name !== undefined && isIndexableDeclaration(node, kind, sourceFile, ast)) {
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol !== undefined) {
          const qualifiedName = declarationQualifier(symbol, name.text);
          const id = createGraphNodeId({ extractor: 'typescript', projectId: project.id, declarationFile: file, kind, qualifiedName });
          const graphNode: GraphNode = {
            id,
            extractor: 'typescript',
            language: project.language,
            kind,
            name: name.text,
            qualifiedName,
            projectId: project.id,
            declaration: sourceSpan(project, sourceFile, node),
            exported: isExported(node, sourceFile),
            contentHash: hash(sourceFile.text),
          };
          graph.nodes.push(graphNode);
          declarationIds.set(symbol.id, id);
          declarationNodes.set(node, id);
          if (ast.isClassDeclaration(node)) classMembers.set(id, new Map());
          const enclosingClass = node.parent;
          const parentId = declarationNodes.get(enclosingClass);
          if (parentId !== undefined && (ast.isMethodDeclaration(node) || ast.isConstructorDeclaration(node))) {
            classMembers.get(parentId)?.set(name.text, id);
          }
        }
      }
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(sourceFile);
  }
  return { graphs, declarationIds, declarationNodes, classMembers, moduleIds };
}

function extractEdges(
  project: ProjectDescriptor,
  checker: Checker,
  ast: TypeScriptAstModule,
  sourceFiles: readonly SourceFile[],
  graphs: ReadonlyMap<string, FileGraph>,
  declarationIds: ReadonlyMap<number, string>,
  declarationNodes: ReadonlyMap<Node, string>,
  classMembers: ReadonlyMap<string, ReadonlyMap<string, string>>,
  moduleIds: ReadonlyMap<string, string>,
  aliasSymbolFlag: number,
): void {
  for (const sourceFile of sourceFiles) {
    const graph = graphs.get(sourceFile.fileName);
    if (graph === undefined) continue;
    const moduleId = graph.nodes[0]?.id;
    if (moduleId === undefined) continue;

    const addResolution = (kind: GraphEdgeKind, sourceId: string, node: Node): void => {
      const target = resolvedTarget(checker, node, declarationIds, declarationNodes, aliasSymbolFlag);
      addEdge(graph.edges, { kind, sourceId, ...target, evidence: sourceSpan(project, sourceFile, node) });
    };

    const visit = (node: Node): void => {
      const ownerId = nearestOwner(node, declarationNodes, moduleId);
      if (ast.isIdentifier(node) && declarationNodes.get(node.parent) === undefined) {
        addResolution('references', ownerId, node);
      }
      if (ast.isCallExpression(node)) {
        const expression = node.expression;
        if (ast.isIdentifier(expression)) {
          addResolution('calls', ownerId, expression);
        } else if (ast.isPropertyAccessExpression(expression)) {
          addResolution('calls', ownerId, expression.name);
        } else {
          addEdge(graph.edges, {
            kind: 'calls', sourceId: ownerId, targetId: null, resolution: 'dynamic',
            evidence: sourceSpan(project, sourceFile, node), reason: 'callee is dynamically computed',
          });
        }
      }
      if (ast.isImportDeclaration(node)) {
        const importIdentifiers = identifiersWithin(node, ast);
        if (importIdentifiers.length === 0) {
          const target = resolvedModuleTarget(checker, node.moduleSpecifier, moduleIds, aliasSymbolFlag);
          addEdge(graph.edges, { kind: 'imports', sourceId: moduleId, ...target, evidence: sourceSpan(project, sourceFile, node.moduleSpecifier) });
        } else {
          const namedBindings = node.importClause?.namedBindings;
          const namespaceIdentifier = namedBindings !== undefined && ast.isNamespaceImport(namedBindings)
            ? namedBindings.name
            : undefined;
          for (const identifier of importIdentifiers) {
            const target = identifier === namespaceIdentifier
              ? resolvedModuleTarget(checker, node.moduleSpecifier, moduleIds, aliasSymbolFlag)
              : resolvedTarget(checker, identifier, declarationIds, declarationNodes, aliasSymbolFlag);
            addEdge(graph.edges, { kind: 'imports', sourceId: moduleId, ...target, evidence: sourceSpan(project, sourceFile, identifier) });
            addEdge(graph.edges, { kind: 'aliases', sourceId: nearestOwner(identifier, declarationNodes, moduleId), ...target, evidence: sourceSpan(project, sourceFile, identifier) });
          }
        }
      }
      if (ast.isExportDeclaration(node)) {
        const exportIdentifiers = identifiersWithin(node, ast);
        for (const identifier of exportIdentifiers) addResolution('exports', moduleId, identifier);
      }
      if ((ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node)) && node.heritageClauses !== undefined) {
        for (const clause of node.heritageClauses) {
          const kind: GraphEdgeKind = clause.getText(sourceFile).trimStart().startsWith('implements') ? 'implements' : 'extends';
          for (const type of clause.types) {
            addResolution(kind, ownerId, type.expression);
          }
        }
      }
      if (ast.isMethodDeclaration(node) && /^override\b/.test(node.getText(sourceFile).trimStart())) {
        const classNode = node.parent;
        const classId = declarationNodes.get(classNode);
        const methodName = declarationName(node, ast);
        const heritage = ast.isClassDeclaration(classNode) ? classNode.heritageClauses?.[0]?.types[0] : undefined;
        if (classId !== undefined && methodName !== undefined && heritage !== undefined) {
          const base = resolvedTarget(checker, heritage.expression, declarationIds, declarationNodes, aliasSymbolFlag);
          const targetId = base.targetId === null ? null : classMembers.get(base.targetId)?.get(methodName.text) ?? null;
          addEdge(graph.edges, {
            kind: 'overrides', sourceId: classMembers.get(classId)?.get(methodName.text) ?? ownerId,
            targetId,
            resolution: targetId === null ? 'unresolved' : 'resolved',
            evidence: sourceSpan(project, sourceFile, methodName),
            reason: targetId === null ? 'base member is not project-owned' : undefined,
          });
        }
      }
      node.forEachChild((child) => {
        visit(child);
        return undefined;
      });
    };
    visit(sourceFile);
    for (const node of graph.nodes.slice(1)) {
      addEdge(graph.edges, { kind: 'contains', sourceId: moduleId, targetId: node.id, resolution: 'resolved', evidence: node.declaration });
      if (node.exported) addEdge(graph.edges, { kind: 'exports', sourceId: moduleId, targetId: node.id, resolution: 'resolved', evidence: node.declaration });
    }
    graph.unresolvedCount = graph.edges.filter((edge) => edge.resolution === 'unresolved').length;
  }
}

function projectForDescriptor(snapshot: Snapshot, descriptor: ProjectDescriptor): Project | undefined {
  const configFile = descriptor.configFile?.replaceAll('\\', '/');
  const projects = snapshot.getProjects();
  if (configFile !== undefined) {
    return projects.find((project) => project.configFileName.replaceAll('\\', '/') === configFile);
  }
  return projects.length === 1 ? projects[0] : undefined;
}

/** Uses the pinned TypeScript 7 sync API and emits only file-owned semantic graph facts. */
export class TypeScriptSemanticExtractor implements LanguageExtractor {
  readonly id = 'typescript';
  readonly languages = ['typescript', 'javascript'] as const;

  async discoverProjects(projectRoot: string): Promise<ProjectDescriptor[]> {
    return discoverProjects(projectRoot);
  }

  async extractProject(descriptor: ProjectDescriptor): Promise<FileGraph[]> {
    const loaded = await loadTypeScript();
    const snapshot = loaded.api.updateSnapshot(descriptor.configFile === null
      ? { openFiles: [path.join(descriptor.root, 'index.ts')] }
      : { openProjects: [descriptor.configFile] });
    try {
      const project = projectForDescriptor(snapshot, descriptor);
      if (project === undefined) throw new Error(`TypeScript could not open project ${descriptor.configFile ?? descriptor.root}`);
      const sourceFiles = project.program.getSourceFileNames()
        .map((fileName) => project.program.getSourceFile(fileName))
        .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined && isProjectSource(descriptor, sourceFile));
      const collected = collectNodes(descriptor, project.checker, loaded.ast, sourceFiles);
      extractEdges(descriptor, project.checker, loaded.ast, sourceFiles, collected.graphs, collected.declarationIds, collected.declarationNodes, collected.classMembers, collected.moduleIds, loaded.aliasSymbolFlag);
      return [...collected.graphs.values()].sort((left, right) => left.file.localeCompare(right.file));
    } finally {
      snapshot.dispose();
      loaded.api.close();
    }
  }
}

export function createTypeScriptSemanticExtractor(): TypeScriptSemanticExtractor {
  return new TypeScriptSemanticExtractor();
}
