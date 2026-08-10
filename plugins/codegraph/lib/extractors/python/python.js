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
var python_exports = {};
__export(python_exports, {
  PyrightSemanticExtractor: () => PyrightSemanticExtractor,
  PythonLanguageProvider: () => PythonLanguageProvider
});
module.exports = __toCommonJS(python_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_model = require("../../model.js");
var import_paths = require("../../paths.js");
var import_freshness = require("../../languages/python/freshness.js");
var import_projects = require("../../languages/python/projects.js");
var import_runtime = require("../../languages/python/runtime.js");
var import_runtime_contract = require("../../runtime-contract.js");
var import_pyright_adapter = require("./pyright-adapter.js");
function hash(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
function sourceSpan(file, content, start, length) {
  const before = content.slice(0, start);
  const line = before.split(/\r?\n/).length;
  const column = start - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  return { file, startLine: line, startColumn: column, endLine: line, endColumn: column + length };
}
function resolvedRelationship(targetId, resolutionWithoutTarget) {
  return targetId === null ? { resolution: resolutionWithoutTarget, targetId: null } : { resolution: "resolved", targetId };
}
function addEdge(edges, edge) {
  const id = (0, import_model.createGraphEdgeId)(edge);
  if (!edges.some((candidate) => candidate.id === id)) edges.push({ ...edge, id });
}
function declarationNode(project, file, contentHash, declaration, qualifiedName, content) {
  const kind = declaration.kind === "alias" ? "variable" : declaration.kind;
  return {
    id: (0, import_model.createGraphNodeId)({ extractor: "python", projectId: project.id, declarationFile: file, kind, qualifiedName }),
    extractor: "python",
    language: "python",
    kind,
    name: declaration.name,
    qualifiedName,
    projectId: project.id,
    declaration: sourceSpan(file, content, declaration.start, declaration.length),
    exported: !declaration.name.startsWith("_"),
    contentHash
  };
}
function parseSemanticFile(project, semanticFile) {
  const file = (0, import_paths.normalizeProjectRelativePath)(import_node_path.default.relative(project.root, semanticFile.absolutePath));
  const contentHash = hash(semanticFile.content);
  const module2 = {
    id: (0, import_model.createGraphNodeId)({ extractor: "python", projectId: project.id, declarationFile: file, kind: "module", qualifiedName: semanticFile.moduleName }),
    extractor: "python",
    language: "python",
    kind: "module",
    name: file,
    qualifiedName: semanticFile.moduleName,
    projectId: project.id,
    declaration: sourceSpan(file, semanticFile.content, 0, 0),
    exported: true,
    contentHash
  };
  const graph = { file, contentHash, nodes: [module2], edges: [], unresolvedCount: 0, diagnostics: [] };
  const aliases = [];
  const classBases = [];
  const ownerNodeIds = /* @__PURE__ */ new Map();
  const uncertainOwnerStarts = /* @__PURE__ */ new Set();
  let moduleDynamic = false;
  const addDeclarations = (declarations, ownerId, ownerName, inheritedUncertainty = false) => {
    for (const declaration of declarations) {
      const uncertain = inheritedUncertainty || declaration.uncertain;
      if (declaration.name === "__getattr__" && ownerId === module2.id) moduleDynamic = true;
      if (uncertain) uncertainOwnerStarts.add(declaration.start);
      if (declaration.kind === "alias") {
        aliases.push({ sourceId: ownerId, declaration });
        continue;
      }
      const qualifiedName = `${ownerName}.${declaration.name}`;
      const node = declarationNode(project, file, contentHash, declaration, qualifiedName, semanticFile.content);
      graph.nodes.push(node);
      ownerNodeIds.set(declaration.start, node.id);
      addEdge(graph.edges, { kind: "contains", sourceId: ownerId, targetId: node.id, resolution: "resolved", evidence: node.declaration });
      if (node.exported && ownerId === module2.id) addEdge(graph.edges, { kind: "exports", sourceId: module2.id, targetId: node.id, resolution: "resolved", evidence: node.declaration });
      if (declaration.kind === "class") classBases.push({ sourceId: node.id, ownerId, declaration });
      addDeclarations(declaration.children, node.id, qualifiedName, uncertain);
    }
  };
  addDeclarations(semanticFile.declarations, module2.id, semanticFile.moduleName);
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
    moduleDynamic
  };
}
function addResolvedAliases(parsedFiles) {
  const targetNodes = /* @__PURE__ */ new Map();
  const targetsByLocation = /* @__PURE__ */ new Map();
  const projectFiles = /* @__PURE__ */ new Set();
  for (const parsedFile of parsedFiles) {
    const absolutePath = import_node_path.default.resolve(parsedFile.absolutePath);
    projectFiles.add(absolutePath);
    for (const node of parsedFile.graph.nodes) targetNodes.set(`${absolutePath}:${node.name}`, node.id);
    for (const [start, nodeId] of parsedFile.ownerNodeIds) targetsByLocation.set(`${absolutePath}:${start}`, nodeId);
  }
  const aliasTargets = /* @__PURE__ */ new Map();
  for (const parsedFile of parsedFiles) {
    for (const { sourceId, declaration } of parsedFile.aliases) {
      const targetId = declaration.targetPath === null || declaration.targetName === null ? null : targetNodes.get(`${import_node_path.default.resolve(declaration.targetPath)}:${declaration.targetName}`) ?? null;
      const resolution = targetId !== null ? "resolved" : declaration.targetPath === null || projectFiles.has(import_node_path.default.resolve(declaration.targetPath)) ? "unresolved" : "external";
      const reason = resolution === "resolved" ? void 0 : resolution === "external" ? "Pyright resolved a target outside this project" : "Pyright did not prove a project-owned target";
      const evidence = sourceSpan(parsedFile.graph.file, "", declaration.start, declaration.length);
      addEdge(parsedFile.graph.edges, { kind: "imports", sourceId, targetId, resolution, evidence, reason });
      addEdge(parsedFile.graph.edges, { kind: "aliases", sourceId, targetId, resolution, evidence, reason });
      if (targetId !== null) {
        aliasTargets.set(`${parsedFile.absolutePath}:${sourceId}:${declaration.name}`, targetId);
        addEdge(parsedFile.graph.edges, { kind: "exports", sourceId, targetId, resolution, evidence });
      }
    }
  }
  for (const parsedFile of parsedFiles) {
    for (const { sourceId: sourceId2, ownerId, declaration } of parsedFile.classBases) {
      const evidence = parsedFile.graph.nodes.find((node) => node.id === sourceId2)?.declaration ?? sourceSpan(parsedFile.graph.file, "", declaration.start, declaration.length);
      for (const baseTarget of declaration.baseTargets) {
        const targetId2 = baseTarget.target === null ? null : targetsByLocation.get(`${import_node_path.default.resolve(baseTarget.target.path)}:${baseTarget.target.start}`) ?? targetNodes.get(`${import_node_path.default.resolve(baseTarget.target.path)}:${baseTarget.target.name}`) ?? null;
        const relationship = baseTarget.uncertainty === null ? resolvedRelationship(targetId2, "external") : resolvedRelationship(null, baseTarget.uncertainty);
        addEdge(parsedFile.graph.edges, {
          kind: "extends",
          sourceId: sourceId2,
          targetId: relationship.targetId,
          resolution: relationship.resolution,
          evidence,
          reason: relationship.resolution === "resolved" ? void 0 : relationship.resolution === "external" ? "Pyright resolved a base class outside this project" : "Pyright did not prove one project-owned base class"
        });
      }
    }
    const moduleId = parsedFile.graph.nodes[0].id;
    const sourceId = (ownerStart) => ownerStart === null ? moduleId : parsedFile.ownerNodeIds.get(ownerStart) ?? moduleId;
    const targetId = (target) => targetsByLocation.get(`${import_node_path.default.resolve(target.path)}:${target.start}`) ?? targetNodes.get(`${import_node_path.default.resolve(target.path)}:${target.name}`) ?? null;
    const callResolution = (target, resolvedTargetId, uncertainty) => {
      if (uncertainty !== null || parsedFile.moduleDynamic) return resolvedRelationship(null, uncertainty ?? "ambiguous");
      if (target === null) return resolvedRelationship(null, "dynamic");
      return resolvedRelationship(resolvedTargetId, projectFiles.has(import_node_path.default.resolve(target.path)) ? "unresolved" : "external");
    };
    for (const call of parsedFile.calls) {
      const resolvedTargetId = call.target === null ? null : targetId(call.target);
      const relationship = callResolution(call.target, resolvedTargetId, parsedFile.uncertainOwnerStarts.has(call.ownerStart ?? -1) ? "ambiguous" : call.uncertainty);
      addEdge(parsedFile.graph.edges, {
        kind: "calls",
        sourceId: sourceId(call.ownerStart),
        targetId: relationship.targetId,
        resolution: relationship.resolution,
        evidence: sourceSpan(parsedFile.graph.file, parsedFile.content, call.start, call.length),
        reason: relationship.resolution === "resolved" ? void 0 : relationship.resolution === "external" ? "Pyright resolved a target outside this project" : "Pyright could not prove a stable project-owned call target"
      });
    }
    for (const reference of parsedFile.references) {
      const resolvedTargetId = reference.target === null ? null : targetId(reference.target);
      const relationship = reference.uncertainty !== null ? resolvedRelationship(null, reference.uncertainty) : parsedFile.moduleDynamic || parsedFile.uncertainOwnerStarts.has(reference.ownerStart ?? -1) ? resolvedRelationship(null, "ambiguous") : resolvedRelationship(resolvedTargetId, reference.target !== null && projectFiles.has(import_node_path.default.resolve(reference.target.path)) ? "unresolved" : "external");
      addEdge(parsedFile.graph.edges, {
        kind: "references",
        sourceId: sourceId(reference.ownerStart),
        targetId: relationship.targetId,
        resolution: relationship.resolution,
        evidence: sourceSpan(parsedFile.graph.file, parsedFile.content, reference.start, reference.length),
        reason: relationship.resolution === "resolved" ? void 0 : relationship.resolution === "external" ? "Pyright resolved a target outside this project" : "Pyright could not prove a stable project-owned reference target"
      });
    }
    parsedFile.graph.unresolvedCount = parsedFile.graph.edges.filter((edge) => edge.resolution === "unresolved").length;
  }
}
class PyrightSemanticExtractor {
  constructor(runtime) {
    this.runtime = runtime;
  }
  runtime;
  id = "python";
  languages = ["python"];
  async discoverProjects(projectRoot) {
    return (0, import_projects.discoverPythonProjects)(projectRoot);
  }
  async extractProject(project) {
    const adapter = await (0, import_pyright_adapter.loadPyrightAdapter)(this.runtime);
    const service = adapter.createAnalysisService(project.root, project.configFile);
    try {
      while (service.analyze()) ;
      const parsedFiles = service.semanticFiles().map((semanticFile) => parseSemanticFile(project, semanticFile));
      addResolvedAliases(parsedFiles);
      return parsedFiles.map((parsed) => parsed.graph).sort((left, right) => left.file.localeCompare(right.file));
    } finally {
      service.dispose();
    }
  }
}
function configuredEnvironmentValues(contents) {
  const venvPath = contents.match(/(?:"venvPath"|venvPath)\s*[:=]\s*["']([^"']+)["']/)?.[1];
  const venv = contents.match(/(?:"venv"|venv)\s*[:=]\s*["']([^"']+)["']/)?.[1];
  const pythonPath = contents.match(/(?:"pythonPath"|pythonPath)\s*[:=]\s*["']([^"']+)["']/)?.[1];
  if (venvPath === void 0 && venv === void 0 && pythonPath === void 0) return null;
  return [venvPath === void 0 ? void 0 : venv === void 0 ? venvPath : import_node_path.default.join(venvPath, venv), pythonPath].filter((candidate) => candidate !== void 0);
}
async function accessiblePaths(candidates) {
  const accessible = await Promise.all(candidates.map(async (candidate) => {
    try {
      await (0, import_promises.access)(candidate);
      return candidate;
    } catch {
      return null;
    }
  }));
  return accessible.filter((candidate) => candidate !== null);
}
async function configuredPythonDependencyPaths(project) {
  if (project.configFile === null) return null;
  let configured;
  try {
    configured = configuredEnvironmentValues(await (0, import_promises.readFile)(project.configFile, "utf8"));
  } catch {
    return null;
  }
  if (configured === null) return null;
  const configurationRoot = import_node_path.default.dirname(project.configFile);
  return accessiblePaths(configured.map((candidate) => import_node_path.default.resolve(configurationRoot, candidate)));
}
async function conventionalPythonDependencyPaths(project) {
  const candidates = [import_node_path.default.join(project.root, ".venv"), import_node_path.default.join(project.root, "venv")];
  const environments = await Promise.all(candidates.map(async (candidate) => {
    try {
      await (0, import_promises.access)(import_node_path.default.join(candidate, "pyvenv.cfg"));
      return candidate;
    } catch {
      return null;
    }
  }));
  return environments.filter((candidate) => candidate !== null);
}
const pythonDependencyEnvironment = {
  async discover(project) {
    const configured = await configuredPythonDependencyPaths(project);
    if (configured !== null) {
      return configured.length === 0 ? { state: "absent", absolutePaths: [] } : { state: "configured", absolutePaths: configured };
    }
    const conventional = await conventionalPythonDependencyPaths(project);
    return conventional.length === 0 ? { state: "absent", absolutePaths: [] } : { state: "conventional", absolutePaths: conventional };
  }
};
class PythonLanguageProvider {
  constructor(runtime = new import_runtime.PyrightRuntimeAcquirer()) {
    this.runtime = runtime;
  }
  runtime;
  id = "python";
  languages = ["python"];
  freshness = import_freshness.pythonFreshnessContributor;
  dependencyEnvironment = pythonDependencyEnvironment;
  async acquireEngine() {
    const runtime = await this.runtime.acquire();
    if (!(0, import_runtime_contract.isSemanticEngineRuntime)(runtime)) throw new Error("Pyright runtime must provide module loading");
    return runtime;
  }
  createExtractor(runtime) {
    return new PyrightSemanticExtractor(runtime);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PyrightSemanticExtractor,
  PythonLanguageProvider
});
