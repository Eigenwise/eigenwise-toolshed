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
var service_exports = {};
__export(service_exports, {
  CodegraphService: () => CodegraphService
});
module.exports = __toCommonJS(service_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_freshness = require("./freshness.js");
var import_index_builder = require("./index-builder.js");
var import_typescript = require("./extractors/typescript.js");
var import_queries = require("./queries.js");
var import_paths = require("./paths.js");
function messageFor(status) {
  if (status === "missing") return "Codegraph has no indexed snapshot. Run codegraph_index first.";
  if (status === "stale") return "Codegraph snapshot is stale. Run codegraph_index to refresh it.";
  if (status === "indexing") return "Codegraph is building an index.";
  if (status === "acquiring-runtime") return "Codegraph is acquiring its pinned semantic runtime.";
  if (status === "unavailable") return "Codegraph semantic runtime is unavailable.";
  if (status === "error") return "Codegraph could not read the graph.";
  return "ok";
}
function emptyResponse(state, snapshot, coverage) {
  return { status: state.status, snapshot, coverage, results: [], omitted: 0, nextCursor: null, tokenEstimate: 0, message: state.message };
}
function aggregateSnapshot(result, runtime, projectRoot) {
  const source = result.manifest.sourceManifestHash;
  const configuration = result.manifest.configHash;
  const snapshotId = (0, import_node_crypto.createHash)("sha256").update([projectRoot, source, configuration, runtime.engineId, runtime.engineVersion].join("\0")).digest("hex");
  return {
    schemaVersion: 1,
    snapshotId,
    projectRootHash: (0, import_node_crypto.createHash)("sha256").update(projectRoot).digest("hex"),
    sourceManifestHash: source,
    configHash: configuration,
    engineId: runtime.engineId,
    engineVersion: runtime.engineVersion,
    indexedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
class CodegraphService {
  projectRoot;
  store;
  runtime;
  stateDirectory;
  buildIndex;
  state = { status: "missing", message: messageFor("missing") };
  indexing;
  constructor(options) {
    this.projectRoot = (0, import_paths.canonicalFilesystemPath)(options.projectRoot);
    this.store = options.store;
    this.runtime = options.runtime;
    this.stateDirectory = (0, import_paths.projectStateDirectory)(this.projectRoot);
    this.buildIndex = options.index ?? ((projectRoot, runtime) => (0, import_index_builder.buildProjectIndex)(projectRoot, {
      runtime,
      store: { readSnapshot: async () => null, replaceSnapshot: async () => void 0 }
    }));
  }
  async response(state, snapshot, coverage) {
    try {
      await (0, import_promises.mkdir)(this.stateDirectory, { recursive: true });
      await (0, import_promises.writeFile)(import_node_path.default.join(this.stateDirectory, "status.json"), JSON.stringify({ status: state.status, snapshotId: snapshot?.snapshotId }), "utf8");
    } catch {
    }
    return emptyResponse(state, snapshot, coverage);
  }
  async status() {
    const snapshot = this.store.snapshot();
    if (snapshot === null) {
      this.state = { status: "missing", message: messageFor("missing") };
      return this.response(this.state, null, null);
    }
    try {
      const manifest = await (0, import_freshness.buildRelevantInputManifest)(this.projectRoot);
      this.state = (0, import_freshness.snapshotIsFresh)(snapshot, manifest) ? { status: "ready", message: messageFor("ready") } : { status: "stale", message: messageFor("stale") };
    } catch (error) {
      this.state = { status: "error", message: error instanceof Error ? error.message : messageFor("error") };
    }
    return this.response(this.state, snapshot, this.store.coverage(snapshot.snapshotId));
  }
  async index() {
    if (this.indexing !== void 0) return this.indexing;
    this.indexing = this.rebuild().finally(() => {
      this.indexing = void 0;
    });
    return this.indexing;
  }
  async rebuild() {
    this.state = { status: "acquiring-runtime", message: messageFor("acquiring-runtime") };
    try {
      const acquired = await this.runtime.acquire();
      this.state = { status: "indexing", message: messageFor("indexing") };
      const runtime = { ...acquired, extractors: [(0, import_typescript.createTypeScriptSemanticExtractor)()] };
      const result = await this.buildIndex(this.projectRoot, runtime);
      const snapshot = aggregateSnapshot(result, runtime, this.projectRoot);
      this.store.replaceSnapshot({
        snapshot,
        projects: result.snapshots.map((entry) => entry.project),
        files: result.snapshots.flatMap((entry) => entry.files)
      });
      this.state = { status: "ready", message: messageFor("ready") };
      return this.response(this.state, snapshot, this.store.coverage(snapshot.snapshotId));
    } catch (error) {
      const message = error instanceof Error ? error.message : messageFor("error");
      this.state = { status: "error", message };
      return this.response(this.state, this.store.snapshot(), this.store.coverage());
    }
  }
  async ready(action) {
    const status = await this.status();
    if (status.status !== "ready") return this.response({ status: status.status, message: status.message }, status.snapshot, status.coverage);
    try {
      return action();
    } catch (error) {
      return this.response({ status: "error", message: error instanceof Error ? error.message : messageFor("error") }, status.snapshot, status.coverage);
    }
  }
  impact(selector, options) {
    return this.ready(() => (0, import_queries.impact)(this.store, selector, options));
  }
  path(from, to, options) {
    return this.ready(() => (0, import_queries.shortestPath)(this.store, from, to, options));
  }
  hierarchy(selector, options) {
    return this.ready(() => (0, import_queries.hierarchy)(this.store, selector, options));
  }
  modules(mode, options) {
    return this.ready(() => (0, import_queries.modules)(this.store, mode, options));
  }
  context(query, options) {
    return this.ready(() => (0, import_queries.context)(this.store, query, options));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CodegraphService
});
