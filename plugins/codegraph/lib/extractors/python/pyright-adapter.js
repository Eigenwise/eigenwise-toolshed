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
const programModuleId = 5668;
const analyzerServiceExecutorModuleId = 8779;
const parseTreeWalkerModuleId = 9401;
const uriModuleId = 3252;
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
  const executor = require2(analyzerServiceExecutorModuleId);
  const program = require2(programModuleId);
  const walker = require2(parseTreeWalkerModuleId);
  const uri = require2(uriModuleId);
  return {
    AnalyzerService: requiredExport(analyzerService, analyzerServiceModuleId, "AnalyzerService"),
    AnalyzerServiceExecutor: requiredExport(executor, analyzerServiceExecutorModuleId, "AnalyzerServiceExecutor"),
    ParseTreeWalker: requiredExport(walker, parseTreeWalkerModuleId, "ParseTreeWalker"),
    Program: requiredExport(program, programModuleId, "Program"),
    Uri: requiredExport(uri, uriModuleId, "Uri")
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PyrightCompatibilityError,
  loadPyrightAdapter
});
