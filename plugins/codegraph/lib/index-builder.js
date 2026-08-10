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
var index_builder_exports = {};
__export(index_builder_exports, {
  buildProjectIndex: () => buildProjectIndex
});
module.exports = __toCommonJS(index_builder_exports);
var import_node_crypto = require("node:crypto");
var import_node_path = __toESM(require("node:path"));
var import_freshness = require("./freshness.js");
var import_paths = require("./paths.js");
function snapshotId(project, manifest, runtime) {
  return (0, import_node_crypto.createHash)("sha256").update([
    project.id,
    manifest.sourceManifestHash,
    manifest.configHash,
    runtime.engineId,
    runtime.engineVersion
  ].join("\0")).digest("hex");
}
function coverageFor(files) {
  const edges = files.flatMap((file) => file.edges);
  return {
    projects: 1,
    files: files.length,
    nodes: files.reduce((total, file) => total + file.nodes.length, 0),
    edges: edges.length,
    unresolvedEdges: edges.filter((edge) => edge.resolution === "unresolved").length,
    ambiguousEdges: edges.filter((edge) => edge.resolution === "ambiguous").length,
    dynamicEdges: edges.filter((edge) => edge.resolution === "dynamic").length,
    externalEdges: edges.filter((edge) => edge.resolution === "external").length
  };
}
function withRepositoryRelativePaths(canonicalProjectRoot, project, files) {
  const canonicalProjectPath = (0, import_paths.canonicalFilesystemPath)(project.root === "" ? canonicalProjectRoot : project.root);
  const repositoryRelativePath = (file) => (0, import_paths.normalizeProjectRelativePath)(import_node_path.default.relative(canonicalProjectRoot, import_node_path.default.resolve(canonicalProjectPath, file)));
  return files.map((fileGraph) => ({
    ...fileGraph,
    file: repositoryRelativePath(fileGraph.file),
    nodes: fileGraph.nodes.map((node) => ({
      ...node,
      declaration: { ...node.declaration, file: repositoryRelativePath(node.declaration.file) }
    })),
    edges: fileGraph.edges.map((edge) => ({
      ...edge,
      evidence: { ...edge.evidence, file: repositoryRelativePath(edge.evidence.file) }
    }))
  }));
}
function validateFiles(files) {
  const filePaths = /* @__PURE__ */ new Set();
  const nodeIds = /* @__PURE__ */ new Set();
  const edgeIds = /* @__PURE__ */ new Set();
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
      if (edge.resolution === "resolved" && edge.targetId === null) {
        throw new Error(`resolved graph edge is missing its target: ${edge.id}`);
      }
      if (edge.resolution !== "resolved" && edge.targetId !== null) {
        throw new Error(`non-resolved graph edge has a target: ${edge.id}`);
      }
    }
  }
}
async function extractProject(runtime, project) {
  const extractor = runtime.extractors.find((candidate) => candidate.languages.includes(project.language));
  if (extractor === void 0) throw new Error(`no extractor for ${project.language}`);
  return extractor.extractProject(project);
}
function createSnapshot(project, files, manifest, runtime, indexedAt) {
  const snapshot = {
    schemaVersion: 1,
    snapshotId: snapshotId(project, manifest, runtime),
    projectRootHash: (0, import_paths.projectIdentity)(project.root),
    sourceManifestHash: manifest.sourceManifestHash,
    configHash: manifest.configHash,
    engineId: runtime.engineId,
    engineVersion: runtime.engineVersion,
    indexedAt
  };
  return { project, snapshot, coverage: coverageFor(files), files };
}
async function buildProjectIndex(projectRoot, dependencies) {
  const canonicalRoot = (0, import_paths.canonicalFilesystemPath)(projectRoot);
  const manifest = await (0, import_freshness.buildRelevantInputManifest)(canonicalRoot);
  const projects = (await Promise.all(dependencies.runtime.extractors.map((extractor) => extractor.discoverProjects(canonicalRoot)))).flat().sort((left, right) => left.id.localeCompare(right.id));
  const extracted = await Promise.all(projects.map(async (project) => ({
    project,
    files: withRepositoryRelativePaths(canonicalRoot, project, await extractProject(dependencies.runtime, project))
  })));
  for (const result of extracted) validateFiles(result.files);
  const indexedAt = (dependencies.indexedAt ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
  const snapshots = extracted.map(({ project, files }) => createSnapshot(
    project,
    files,
    manifest,
    dependencies.runtime,
    indexedAt
  ));
  for (const snapshot of snapshots) await dependencies.store.replaceSnapshot(snapshot);
  return { snapshots, manifest };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildProjectIndex
});
