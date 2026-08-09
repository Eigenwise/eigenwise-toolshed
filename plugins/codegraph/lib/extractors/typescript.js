"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var typescript_exports = {};
__export(typescript_exports, {
  TypeScriptSemanticExtractor: () => TypeScriptSemanticExtractor,
  createTypeScriptSemanticExtractor: () => createTypeScriptSemanticExtractor
});
module.exports = __toCommonJS(typescript_exports);
var import_node_crypto = require("node:crypto");
var import_node_path = __toESM(require("node:path"));
var import_model = require("../model.js");
var import_paths = require("../paths.js");
var import_projects = require("../projects.js");
function importEsmModule(specifier) {
  return new Function("moduleSpecifier", "return import(moduleSpecifier);")(specifier);
}
function isTypeScriptSyncModule(value) {
  return typeof value === "object" && value !== null && "API" in value && typeof value.API === "function" && "SymbolFlags" in value && typeof value.SymbolFlags === "object" && value.SymbolFlags !== null && "Alias" in value.SymbolFlags && typeof value.SymbolFlags.Alias === "number";
}
function isTypeScriptAstModule(value) {
  if (typeof value !== "object" || value === null) return false;
  return "isIdentifier" in value && typeof value.isIdentifier === "function" && "isClassDeclaration" in value && typeof value.isClassDeclaration === "function" && "isInterfaceDeclaration" in value && typeof value.isInterfaceDeclaration === "function" && "isFunctionDeclaration" in value && typeof value.isFunctionDeclaration === "function" && "isMethodDeclaration" in value && typeof value.isMethodDeclaration === "function" && "isConstructorDeclaration" in value && typeof value.isConstructorDeclaration === "function" && "isVariableDeclaration" in value && typeof value.isVariableDeclaration === "function" && "isCallExpression" in value && typeof value.isCallExpression === "function" && "isPropertyAccessExpression" in value && typeof value.isPropertyAccessExpression === "function" && "isImportDeclaration" in value && typeof value.isImportDeclaration === "function" && "isNamespaceImport" in value && typeof value.isNamespaceImport === "function" && "isExportDeclaration" in value && typeof value.isExportDeclaration === "function";
}
async function loadTypeScript() {
  const [syncModule, astModule] = await Promise.all([
    importEsmModule("typescript/unstable/sync"),
    importEsmModule("typescript/unstable/ast")
  ]);
  if (!isTypeScriptSyncModule(syncModule) || !isTypeScriptAstModule(astModule)) {
    throw new Error("the pinned TypeScript runtime does not expose its sync semantic API");
  }
  return { api: new syncModule.API(), ast: astModule, aliasSymbolFlag: syncModule.SymbolFlags.Alias };
}
function relativeFile(project, fileName) {
  return (0, import_paths.normalizeProjectRelativePath)(import_node_path.default.relative(project.root, fileName));
}
function sourceSpan(project, sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: relativeFile(project, sourceFile.fileName),
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1
  };
}
function hash(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
function isProjectSource(project, sourceFile) {
  if (sourceFile.isDeclarationFile) return false;
  const relative = import_node_path.default.relative(project.root, sourceFile.fileName);
  return relative !== "" && !relative.startsWith("..") && !import_node_path.default.isAbsolute(relative) && /\.[cm]?[jt]sx?$/i.test(sourceFile.fileName);
}
function declarationName(node, ast) {
  if (ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isFunctionDeclaration(node) || ast.isMethodDeclaration(node) || ast.isVariableDeclaration(node)) {
    return node.name !== void 0 && ast.isIdentifier(node.name) ? node.name : void 0;
  }
  return void 0;
}
function declarationKind(node, ast) {
  if (ast.isClassDeclaration(node)) return "class";
  if (ast.isInterfaceDeclaration(node)) return "interface";
  if (ast.isFunctionDeclaration(node)) return "function";
  if (ast.isMethodDeclaration(node)) return "method";
  if (ast.isConstructorDeclaration(node)) return "constructor";
  if (ast.isVariableDeclaration(node)) return "variable";
  return void 0;
}
function declarationQualifier(symbol, fallbackName) {
  const names = [fallbackName];
  let parent = symbol.getParent();
  while (parent !== void 0 && parent.name !== "__global") {
    names.unshift(parent.name);
    parent = parent.getParent();
  }
  return names.join(".");
}
function edgeId(kind, sourceId, targetId, resolution, evidence, reason) {
  return (0, import_node_crypto.createHash)("sha256").update([
    kind,
    sourceId,
    targetId ?? "",
    resolution,
    evidence.file,
    String(evidence.startLine),
    String(evidence.startColumn),
    reason ?? ""
  ].join("\0")).digest("hex");
}
function isExported(node, sourceFile) {
  return /^export\s/.test(node.getText(sourceFile).trimStart());
}
function nearestOwner(node, declarations, moduleId) {
  let current = node;
  while (current !== void 0) {
    const declarationId = declarations.get(current);
    if (declarationId !== void 0) return declarationId;
    current = current.parent;
  }
  return moduleId;
}
function resolvedTarget(checker, node, declarationIds, declarationNodes, aliasSymbolFlag) {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === void 0) return { targetId: null, resolution: "unresolved", reason: "TypeScript could not resolve this symbol" };
  const canonical = (symbol.flags & aliasSymbolFlag) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  if (checker.isUnknownSymbol(canonical)) {
    return { targetId: null, resolution: "unresolved", reason: "TypeScript reported an unresolved alias" };
  }
  const declaration = canonical.declarations[0]?.resolve();
  const targetId = declarationIds.get(canonical.id) ?? declarationIds.get(symbol.id) ?? (declaration === void 0 ? void 0 : declarationNodes.get(declaration));
  if (targetId !== void 0) return { targetId, resolution: "resolved" };
  if (declaration !== void 0 && declaration.getSourceFile().isDeclarationFile) {
    return { targetId: null, resolution: "external", reason: "symbol resolves to an external declaration" };
  }
  return { targetId: null, resolution: "unresolved", reason: "symbol has no project-owned declaration" };
}
function resolvedModuleTarget(checker, node, moduleIds, aliasSymbolFlag) {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === void 0) return { targetId: null, resolution: "unresolved", reason: "TypeScript could not resolve this module" };
  const canonical = (symbol.flags & aliasSymbolFlag) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  if (checker.isUnknownSymbol(canonical)) {
    return { targetId: null, resolution: "unresolved", reason: "TypeScript reported an unresolved module alias" };
  }
  const declaration = canonical.declarations[0]?.resolve();
  if (declaration === void 0) return { targetId: null, resolution: "unresolved", reason: "module has no resolved declaration" };
  const targetId = moduleIds.get(declaration.getSourceFile().fileName);
  if (targetId !== void 0) return { targetId, resolution: "resolved" };
  if (declaration.getSourceFile().isDeclarationFile) {
    return { targetId: null, resolution: "external", reason: "module resolves to an external declaration" };
  }
  return { targetId: null, resolution: "unresolved", reason: "module has no project-owned declaration" };
}
function identifiersWithin(node, ast) {
  const identifiers = [];
  const visit = (current) => {
    if (ast.isIdentifier(current)) identifiers.push(current);
    current.forEachChild((child) => {
      visit(child);
      return void 0;
    });
  };
  visit(node);
  return identifiers;
}
function addEdge(edges, edge) {
  const id = edgeId(edge.kind, edge.sourceId, edge.targetId, edge.resolution, edge.evidence, edge.reason);
  if (!edges.some((candidate) => candidate.id === id)) edges.push({ ...edge, id });
}
function collectNodes(project, checker, ast, sourceFiles) {
  const graphs = /* @__PURE__ */ new Map();
  const declarationIds = /* @__PURE__ */ new Map();
  const declarationNodes = /* @__PURE__ */ new Map();
  const classMembers = /* @__PURE__ */ new Map();
  const moduleIds = /* @__PURE__ */ new Map();
  for (const sourceFile of sourceFiles) {
    const file = relativeFile(project, sourceFile.fileName);
    const moduleId = (0, import_model.createGraphNodeId)({ extractor: "typescript", projectId: project.id, declarationFile: file, kind: "module", qualifiedName: file });
    const moduleNode = {
      id: moduleId,
      extractor: "typescript",
      language: project.language,
      kind: "module",
      name: file,
      qualifiedName: file,
      projectId: project.id,
      declaration: sourceSpan(project, sourceFile, sourceFile),
      exported: true,
      contentHash: hash(sourceFile.text)
    };
    const graph = { file, contentHash: hash(sourceFile.text), nodes: [moduleNode], edges: [], unresolvedCount: 0, diagnostics: [] };
    graphs.set(sourceFile.fileName, graph);
    moduleIds.set(sourceFile.fileName, moduleId);
    const visit = (node) => {
      const kind = declarationKind(node, ast);
      const name = declarationName(node, ast);
      if (kind !== void 0 && name !== void 0) {
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol !== void 0) {
          const qualifiedName = declarationQualifier(symbol, name.text);
          const id = (0, import_model.createGraphNodeId)({ extractor: "typescript", projectId: project.id, declarationFile: file, kind, qualifiedName });
          const graphNode = {
            id,
            extractor: "typescript",
            language: project.language,
            kind,
            name: name.text,
            qualifiedName,
            projectId: project.id,
            declaration: sourceSpan(project, sourceFile, node),
            exported: isExported(node, sourceFile),
            contentHash: hash(sourceFile.text)
          };
          graph.nodes.push(graphNode);
          declarationIds.set(symbol.id, id);
          declarationNodes.set(node, id);
          if (ast.isClassDeclaration(node)) classMembers.set(id, /* @__PURE__ */ new Map());
          const enclosingClass = node.parent;
          const parentId = declarationNodes.get(enclosingClass);
          if (parentId !== void 0 && (ast.isMethodDeclaration(node) || ast.isConstructorDeclaration(node))) {
            classMembers.get(parentId)?.set(name.text, id);
          }
        }
      }
      node.forEachChild((child) => {
        visit(child);
        return void 0;
      });
    };
    visit(sourceFile);
  }
  return { graphs, declarationIds, declarationNodes, classMembers, moduleIds };
}
function extractEdges(project, checker, ast, sourceFiles, graphs, declarationIds, declarationNodes, classMembers, moduleIds, aliasSymbolFlag) {
  for (const sourceFile of sourceFiles) {
    const graph = graphs.get(sourceFile.fileName);
    if (graph === void 0) continue;
    const moduleId = graph.nodes[0]?.id;
    if (moduleId === void 0) continue;
    const addResolution = (kind, sourceId, node) => {
      const target = resolvedTarget(checker, node, declarationIds, declarationNodes, aliasSymbolFlag);
      addEdge(graph.edges, { kind, sourceId, ...target, evidence: sourceSpan(project, sourceFile, node) });
    };
    const visit = (node) => {
      const ownerId = nearestOwner(node, declarationNodes, moduleId);
      if (ast.isIdentifier(node) && declarationNodes.get(node.parent) === void 0) {
        addResolution("references", ownerId, node);
      }
      if (ast.isCallExpression(node)) {
        const expression = node.expression;
        if (ast.isIdentifier(expression)) {
          addResolution("calls", ownerId, expression);
        } else if (ast.isPropertyAccessExpression(expression)) {
          addResolution("calls", ownerId, expression.name);
        } else {
          addEdge(graph.edges, {
            kind: "calls",
            sourceId: ownerId,
            targetId: null,
            resolution: "dynamic",
            evidence: sourceSpan(project, sourceFile, node),
            reason: "callee is dynamically computed"
          });
        }
      }
      if (ast.isImportDeclaration(node)) {
        const importIdentifiers = identifiersWithin(node, ast);
        if (importIdentifiers.length === 0) {
          const target = resolvedModuleTarget(checker, node.moduleSpecifier, moduleIds, aliasSymbolFlag);
          addEdge(graph.edges, { kind: "imports", sourceId: moduleId, ...target, evidence: sourceSpan(project, sourceFile, node.moduleSpecifier) });
        } else {
          const namedBindings = node.importClause?.namedBindings;
          const namespaceIdentifier = namedBindings !== void 0 && ast.isNamespaceImport(namedBindings) ? namedBindings.name : void 0;
          for (const identifier of importIdentifiers) {
            const target = identifier === namespaceIdentifier ? resolvedModuleTarget(checker, node.moduleSpecifier, moduleIds, aliasSymbolFlag) : resolvedTarget(checker, identifier, declarationIds, declarationNodes, aliasSymbolFlag);
            addEdge(graph.edges, { kind: "imports", sourceId: moduleId, ...target, evidence: sourceSpan(project, sourceFile, identifier) });
            addEdge(graph.edges, { kind: "aliases", sourceId: nearestOwner(identifier, declarationNodes, moduleId), ...target, evidence: sourceSpan(project, sourceFile, identifier) });
          }
        }
      }
      if (ast.isExportDeclaration(node)) {
        const exportIdentifiers = identifiersWithin(node, ast);
        for (const identifier of exportIdentifiers) addResolution("exports", moduleId, identifier);
      }
      if ((ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node)) && node.heritageClauses !== void 0) {
        for (const clause of node.heritageClauses) {
          const kind = clause.getText(sourceFile).trimStart().startsWith("implements") ? "implements" : "extends";
          for (const type of clause.types) {
            addResolution(kind, ownerId, type.expression);
          }
        }
      }
      if (ast.isMethodDeclaration(node) && /^override\b/.test(node.getText(sourceFile).trimStart())) {
        const classNode = node.parent;
        const classId = declarationNodes.get(classNode);
        const methodName = declarationName(node, ast);
        const heritage = ast.isClassDeclaration(classNode) ? classNode.heritageClauses?.[0]?.types[0] : void 0;
        if (classId !== void 0 && methodName !== void 0 && heritage !== void 0) {
          const base = resolvedTarget(checker, heritage.expression, declarationIds, declarationNodes, aliasSymbolFlag);
          const targetId = base.targetId === null ? null : classMembers.get(base.targetId)?.get(methodName.text) ?? null;
          addEdge(graph.edges, {
            kind: "overrides",
            sourceId: classMembers.get(classId)?.get(methodName.text) ?? ownerId,
            targetId,
            resolution: targetId === null ? "unresolved" : "resolved",
            evidence: sourceSpan(project, sourceFile, methodName),
            reason: targetId === null ? "base member is not project-owned" : void 0
          });
        }
      }
      node.forEachChild((child) => {
        visit(child);
        return void 0;
      });
    };
    visit(sourceFile);
    for (const node of graph.nodes.slice(1)) {
      addEdge(graph.edges, { kind: "contains", sourceId: moduleId, targetId: node.id, resolution: "resolved", evidence: node.declaration });
      if (node.exported) addEdge(graph.edges, { kind: "exports", sourceId: moduleId, targetId: node.id, resolution: "resolved", evidence: node.declaration });
    }
    graph.unresolvedCount = graph.edges.filter((edge) => edge.resolution === "unresolved").length;
  }
}
function projectForDescriptor(snapshot, descriptor) {
  const configFile = descriptor.configFile?.replaceAll("\\", "/");
  const projects = snapshot.getProjects();
  if (configFile !== void 0) {
    return projects.find((project) => project.configFileName.replaceAll("\\", "/") === configFile);
  }
  return projects.length === 1 ? projects[0] : void 0;
}
class TypeScriptSemanticExtractor {
  id = "typescript";
  languages = ["typescript", "javascript"];
  async discoverProjects(projectRoot) {
    return (0, import_projects.discoverProjects)(projectRoot);
  }
  async extractProject(descriptor) {
    const loaded = await loadTypeScript();
    const snapshot = loaded.api.updateSnapshot(descriptor.configFile === null ? { openFiles: [import_node_path.default.join(descriptor.root, "index.ts")] } : { openProjects: [descriptor.configFile] });
    try {
      const project = projectForDescriptor(snapshot, descriptor);
      if (project === void 0) throw new Error(`TypeScript could not open project ${descriptor.configFile ?? descriptor.root}`);
      const sourceFiles = project.program.getSourceFileNames().map((fileName) => project.program.getSourceFile(fileName)).filter((sourceFile) => sourceFile !== void 0 && isProjectSource(descriptor, sourceFile));
      const collected = collectNodes(descriptor, project.checker, loaded.ast, sourceFiles);
      extractEdges(descriptor, project.checker, loaded.ast, sourceFiles, collected.graphs, collected.declarationIds, collected.declarationNodes, collected.classMembers, collected.moduleIds, loaded.aliasSymbolFlag);
      return [...collected.graphs.values()].sort((left, right) => left.file.localeCompare(right.file));
    } finally {
      snapshot.dispose();
      loaded.api.close();
    }
  }
}
function createTypeScriptSemanticExtractor() {
  return new TypeScriptSemanticExtractor();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TypeScriptSemanticExtractor,
  createTypeScriptSemanticExtractor
});
