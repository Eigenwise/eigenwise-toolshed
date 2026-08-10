"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var pyright_adapter_exports = {};
__export(pyright_adapter_exports, {
  PyrightCompatibilityError: () => PyrightCompatibilityError,
  loadPyrightAdapter: () => loadPyrightAdapter
});
module.exports = __toCommonJS(pyright_adapter_exports);
var import_node_module = require("node:module");
const internalChunkId = 223;
const vendorChunkId = 474;
const analyzerServiceModuleId = 2439;
const tomlModuleId = 1294;
const programModuleId = 5668;
const analyzerServiceExecutorModuleId = 8779;
const parseTreeWalkerModuleId = 9401;
const uriModuleId = 3252;
const serviceProviderModuleId = 4471;
const nodeFileSystemModuleId = 1784;
const pyrightFileSystemModuleId = 2965;
class PyrightCompatibilityError extends Error {
  constructor(message) {
    super(`Pyright 1.1.411 compatibility error: ${message}`);
    this.name = "PyrightCompatibilityError";
  }
}
function record(value) {
  return typeof value === "object" && value !== null ? value : void 0;
}
function webpackChunk(value, expectedId) {
  const candidate = record(record(value)?.default ?? value);
  const ids = candidate?.ids;
  const modules = candidate?.modules;
  const moduleRecord = record(modules);
  if (!Array.isArray(ids) || !ids.includes(expectedId) || moduleRecord === void 0) {
    throw new PyrightCompatibilityError(`webpack chunk ${expectedId} does not have the pinned registry shape`);
  }
  if (!Object.values(moduleRecord).every((factory) => typeof factory === "function")) {
    throw new PyrightCompatibilityError(`webpack chunk ${expectedId} contains a non-callable module factory`);
  }
  return { ids, modules };
}
function requiredExport(moduleValue, moduleId, name) {
  const value = moduleValue[name];
  if (value === void 0) throw new PyrightCompatibilityError(`module ${moduleId} does not export ${name}`);
  return value;
}
function stringValue(value) {
  return typeof value === "string" ? value : null;
}
function numberValue(value) {
  return typeof value === "number" ? value : 0;
}
function nodeName(node) {
  return stringValue(record(record(node)?.d)?.value);
}
function classBaseTargets(node, evaluator) {
  const classResult = record(evaluator.getTypeOfClass(node));
  const classType = record(classResult?.classType);
  const baseClasses = record(classType?.shared)?.baseClasses;
  if (!Array.isArray(baseClasses)) return [];
  return baseClasses.flatMap((baseClass) => {
    const shared = record(record(baseClass)?.shared);
    if (shared?.fullName === "builtins.object") return [];
    const declaration = shared?.declaration;
    return declaration === void 0 ? [{ target: null, uncertainty: "unresolved" }] : [resolvedDeclarationTarget(evaluator, [declaration])];
  });
}
function resolvedDeclarationTarget(evaluator, declarations) {
  if (declarations.length !== 1) return { target: null, uncertainty: declarations.length === 0 ? "unresolved" : "ambiguous" };
  const resolved = record(evaluator.resolveAliasDeclaration(declarations[0]));
  const uri = record(resolved?.uri);
  const declarationNode = record(resolved?.node);
  const details = record(declarationNode?.d);
  const name = stringValue(resolved?.symbolName) ?? nodeName(details?.name) ?? nodeName(details?.leftExpr);
  if (uri === void 0 || declarationNode === void 0 || name === null) return { target: null, uncertainty: "unresolved" };
  return { target: { path: uri.getFilePath(), name, start: numberValue(declarationNode.start) }, uncertainty: null };
}
function declarationTarget(evaluator, node) {
  return resolvedDeclarationTarget(evaluator, evaluator.getDeclInfoForNameNode(node)?.decls ?? []);
}
function declarationOwnerStart(node) {
  let current = record(node.parent);
  while (current !== void 0) {
    if (current.nodeType === 10 || current.nodeType === 31) return numberValue(current.start);
    current = record(current.parent);
  }
  return null;
}
function isDeclarationName(node) {
  const parent = record(node.parent);
  const details = record(parent?.d);
  return (parent?.nodeType === 10 || parent?.nodeType === 31) && details?.name === node;
}
function expressionName(node) {
  return nodeName(node) ?? nodeName(record(node)?.d);
}
function callUncertainty(node, target) {
  if (target.uncertainty !== null) return target.uncertainty;
  const expression = record(node.d)?.leftExpr;
  const name = expressionName(expression);
  if (name === "__import__" || name === "import_module" || name === "getattr") return "dynamic";
  return name === null ? "dynamic" : "unresolved";
}
function hasUncertainDecorator(decorators) {
  if (!Array.isArray(decorators)) return false;
  return decorators.some((decorator) => {
    const expression = record(record(decorator)?.d)?.expr;
    const name = expressionName(expression);
    return name !== "property" && name !== "classmethod" && name !== "staticmethod";
  });
}
function hasMetaclass(node) {
  const arguments_ = record(node.d)?.arguments;
  return Array.isArray(arguments_) && arguments_.some((argument) => expressionName(record(argument)?.d) === "metaclass");
}
function semanticRelationships(node, evaluator, calls, references, seen = /* @__PURE__ */ new Set()) {
  const candidate = record(node);
  if (candidate === void 0 || seen.has(candidate)) return;
  seen.add(candidate);
  const details = record(candidate.d);
  const ownerStart = declarationOwnerStart(candidate);
  if (candidate.nodeType === 38 && !isDeclarationName(candidate)) {
    const target = declarationTarget(evaluator, candidate);
    references.push({ start: numberValue(candidate.start), length: numberValue(candidate.length), ownerStart, target: target.target, uncertainty: target.uncertainty });
  }
  if (Array.isArray(details?.args) && record(details.leftExpr) !== void 0) {
    const expression = record(details.leftExpr);
    const target = declarationTarget(evaluator, expression === void 0 ? details.leftExpr : expression.d === void 0 ? expression : record(expression.d)?.member ?? expression);
    calls.push({ start: numberValue(candidate.start), length: numberValue(candidate.length), ownerStart, target: target.target, uncertainty: callUncertainty(candidate, target) });
  }
  for (const value of Object.values(details ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) semanticRelationships(item, evaluator, calls, references, seen);
    } else semanticRelationships(value, evaluator, calls, references, seen);
  }
}
function declarationKind(declaration, node) {
  if (declaration.type === 8) return "alias";
  if (node.nodeType === 10) return "class";
  if (node.nodeType === 31) {
    const decorators = record(node.d)?.decorators;
    const isProperty = Array.isArray(decorators) && decorators.some((decorator) => {
      const expression = record(record(decorator)?.d)?.expr;
      return stringValue(record(record(expression)?.d)?.value) === "property";
    });
    return isProperty ? "property" : declaration.isMethod === true ? "method" : "function";
  }
  return declaration.type === 1 ? "variable" : null;
}
function semanticDeclarations(symbolTable, evaluator, seenScopes = /* @__PURE__ */ new Set()) {
  if (!(symbolTable instanceof Map) || seenScopes.has(symbolTable)) return [];
  seenScopes.add(symbolTable);
  const declarations = [];
  for (const [name, symbol] of symbolTable) {
    if (typeof name !== "string" || !record(symbol)) continue;
    if (name === "__doc__" || name === "__module__" || name === "__qualname__") continue;
    const symbolRecord = symbol;
    for (const declarationValue of symbolRecord.getDeclarations()) {
      const declaration = record(declarationValue);
      const node = record(declaration?.node);
      if (declaration === void 0 || node === void 0) continue;
      const kind = declarationKind(declaration, node);
      if (kind === null) continue;
      const uri = record(declaration.uri);
      const scope = record(node.a)?.scope;
      declarations.push({
        name,
        kind,
        start: numberValue(node.start),
        length: numberValue(node.length),
        targetPath: uri?.getFilePath() ?? null,
        targetName: stringValue(declaration.symbolName),
        baseTargets: kind === "class" ? classBaseTargets(node, evaluator) : [],
        uncertain: kind === "class" && hasMetaclass(node) || kind !== "class" && hasUncertainDecorator(record(node.d)?.decorators),
        children: kind === "class" ? semanticDeclarations(record(scope)?.symbolTable, evaluator, seenScopes) : []
      });
    }
  }
  return declarations;
}
function semanticFiles(program) {
  return program.getSourceFileInfoList().map(({ sourceFile }) => {
    const parseOutput = record(sourceFile.getParserOutput());
    const parseTree = record(parseOutput?.parseTree);
    const rootScope = record(record(parseTree?.a)?.scope);
    const calls = [];
    const references = [];
    semanticRelationships(parseTree, program.evaluator, calls, references);
    return {
      absolutePath: sourceFile.getUri().getFilePath(),
      content: sourceFile.getFileContent(),
      moduleName: sourceFile.getModuleName(),
      declarations: semanticDeclarations(rootScope?.symbolTable, program.evaluator),
      calls,
      references
    };
  });
}
function createAnalysisService(AnalyzerService, serviceProvider, Uri, nodeFileSystem, pyrightFileSystem, projectRoot, configFile) {
  const console = { log: (_message) => void 0, info: (_message) => void 0, warn: (_message) => void 0, error: (_message) => void 0 };
  const tempFile = new nodeFileSystem.RealTempFile();
  const fileSystem = new pyrightFileSystem.PyrightFileSystem(nodeFileSystem.createFromRealFileSystem(
    tempFile,
    console,
    new nodeFileSystem.WorkspaceFileWatcherProvider(console)
  ));
  const provider = serviceProvider.createServiceProvider(fileSystem, console, tempFile);
  const service = new AnalyzerService("codegraph", provider, {});
  if (typeof service !== "object" || service === null || !("test_program" in service) || !("dispose" in service) || !("setOptions" in service) || !("enumerateSourceFiles" in service)) {
    throw new PyrightCompatibilityError("AnalyzerService does not expose the pinned analysis program");
  }
  const candidate = service;
  candidate.setOptions({
    executionRoot: projectRoot,
    configFilePath: configFile ?? void 0,
    configSettings: {
      includeFileSpecs: [],
      excludeFileSpecs: [],
      ignoreFileSpecs: [],
      diagnosticSeverityOverrides: {},
      diagnosticBooleanOverrides: {}
    },
    languageServerSettings: {}
  });
  while (!candidate.enumerateSourceFiles()) ;
  return {
    analyze() {
      return candidate.test_program.analyze();
    },
    semanticFiles() {
      return semanticFiles(candidate.test_program);
    },
    dispose() {
      candidate.dispose();
    }
  };
}
function nodeModuleFactory(specifier) {
  const nodeRequire = (0, import_node_module.createRequire)(__filename);
  return (module2) => {
    module2.exports = nodeRequire(specifier);
  };
}
function externalFactories() {
  return {
    8240: nodeModuleFactory("fsevents"),
    5317: nodeModuleFactory("node:child_process"),
    6982: nodeModuleFactory("node:crypto"),
    4434: nodeModuleFactory("node:events"),
    9896: nodeModuleFactory("node:fs"),
    857: nodeModuleFactory("node:os"),
    6928: nodeModuleFactory("node:path"),
    932: nodeModuleFactory("node:process"),
    3785: nodeModuleFactory("node:readline"),
    2203: nodeModuleFactory("node:stream"),
    2018: nodeModuleFactory("node:tty"),
    7016: nodeModuleFactory("node:url"),
    9023: nodeModuleFactory("node:util"),
    1493: nodeModuleFactory("node:v8"),
    8167: nodeModuleFactory("node:worker_threads"),
    3106: nodeModuleFactory("node:zlib")
  };
}
function webpackLoader(chunks) {
  const factories = /* @__PURE__ */ new Map();
  const cache = /* @__PURE__ */ new Map();
  for (const [moduleId, factory] of Object.entries(externalFactories())) factories.set(Number(moduleId), factory);
  for (const chunk of chunks) {
    for (const [moduleId, factory] of Object.entries(chunk.modules)) factories.set(Number(moduleId), factory);
  }
  const load = ((moduleId) => {
    const cached = cache.get(moduleId);
    if (cached !== void 0) return cached.exports;
    const factory = factories.get(moduleId);
    if (factory === void 0) throw new PyrightCompatibilityError(`required webpack module ${moduleId} is absent`);
    const module2 = { exports: {} };
    cache.set(moduleId, module2);
    try {
      factory(module2, module2.exports, load);
      return module2.exports;
    } catch (error) {
      cache.delete(moduleId);
      const detail = error instanceof Error ? error.message : String(error);
      throw new PyrightCompatibilityError(`required webpack module ${moduleId} could not execute: ${detail}`);
    }
  });
  load.d = (exports2, definitions) => {
    for (const [key, definition] of Object.entries(definitions)) {
      if (!load.o(exports2, key)) Object.defineProperty(exports2, key, { enumerable: true, get: definition });
    }
  };
  load.g = globalThis;
  load.n = (moduleValue) => {
    const moduleRecord = record(moduleValue);
    const getter = moduleRecord?.__esModule === true ? () => moduleRecord.default : () => moduleValue;
    const getterWithDefault = Object.assign(getter, { a: getter });
    load.d(getterWithDefault, { a: getter });
    return getterWithDefault;
  };
  load.o = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  load.r = (exports2) => {
    Object.defineProperty(exports2, "__esModule", { value: true });
    Object.defineProperty(exports2, Symbol.toStringTag, { value: "Module" });
  };
  return load;
}
async function loadPyrightAdapter(runtime) {
  if (runtime.id !== "pyright" || runtime.version !== "1.1.411") {
    throw new PyrightCompatibilityError(`expected pyright@1.1.411, received ${runtime.id}@${runtime.version}`);
  }
  const [vendor, internal] = await Promise.all([
    runtime.importModule("pyright/dist/vendor.js"),
    runtime.importModule("pyright/dist/pyright-internal.js")
  ]);
  const require2 = webpackLoader([webpackChunk(vendor, vendorChunkId), webpackChunk(internal, internalChunkId)]);
  const analyzerService = require2(analyzerServiceModuleId);
  const toml = require2(tomlModuleId);
  const executor = require2(analyzerServiceExecutorModuleId);
  const program = require2(programModuleId);
  const walker = require2(parseTreeWalkerModuleId);
  const uri = require2(uriModuleId);
  const serviceProvider = require2(serviceProviderModuleId);
  const nodeFileSystem = require2(nodeFileSystemModuleId);
  const pyrightFileSystem = require2(pyrightFileSystemModuleId);
  await requiredExport(toml, tomlModuleId, "ensureTomlModuleLoaded")();
  const AnalyzerService = requiredExport(analyzerService, analyzerServiceModuleId, "AnalyzerService");
  const Uri = requiredExport(uri, uriModuleId, "Uri");
  return {
    AnalyzerService,
    AnalyzerServiceExecutor: requiredExport(executor, analyzerServiceExecutorModuleId, "AnalyzerServiceExecutor"),
    ParseTreeWalker: requiredExport(walker, parseTreeWalkerModuleId, "ParseTreeWalker"),
    Program: requiredExport(program, programModuleId, "Program"),
    Uri,
    createAnalysisService(projectRoot, configFile) {
      return createAnalysisService(
        AnalyzerService,
        { createServiceProvider: requiredExport(serviceProvider, serviceProviderModuleId, "createServiceProvider") },
        Uri,
        {
          RealTempFile: requiredExport(nodeFileSystem, nodeFileSystemModuleId, "RealTempFile"),
          WorkspaceFileWatcherProvider: requiredExport(nodeFileSystem, nodeFileSystemModuleId, "WorkspaceFileWatcherProvider"),
          createFromRealFileSystem: requiredExport(nodeFileSystem, nodeFileSystemModuleId, "createFromRealFileSystem")
        },
        { PyrightFileSystem: requiredExport(pyrightFileSystem, pyrightFileSystemModuleId, "PyrightFileSystem") },
        projectRoot,
        configFile
      );
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PyrightCompatibilityError,
  loadPyrightAdapter
});
