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
var import_model = require("./model.js");
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
    }
  }
  for (const file of files) {
    for (const edge of file.edges) {
      if (!nodeIds.has(edge.sourceId)) throw new Error(`graph edge source is not retained: ${edge.id}`);
      if (edge.resolution === "resolved" && edge.targetId === null) {
        throw new Error(`resolved graph edge is missing its target: ${edge.id}`);
      }
      if (edge.resolution === "resolved" && edge.targetId !== null && !nodeIds.has(edge.targetId)) {
        throw new Error(`resolved graph edge target is not retained: ${edge.id}`);
      }
      if (edge.resolution !== "resolved" && edge.targetId !== null) {
        throw new Error(`non-resolved graph edge has a target: ${edge.id}`);
      }
    }
  }
}
function projectPathDepth(projectRoot) {
  return projectRoot.split("/").filter((part) => part.length > 0).length;
}
function compareProjectOwnership(left, right) {
  return projectPathDepth(right.canonicalRoot) - projectPathDepth(left.canonicalRoot) || left.canonicalConfigPath.localeCompare(right.canonicalConfigPath) || left.project.id.localeCompare(right.project.id);
}
function nodeRepresentationKey(repositoryFile, node) {
  return JSON.stringify([repositoryFile, node.extractor, node.language, node.kind, node.qualifiedName]);
}
function edgeWithIdentity(edge) {
  return { ...edge, id: (0, import_model.createGraphEdgeId)(edge) };
}
function retainCanonicalFileOwnership(extractedProjects) {
  const orderedProjects = [...extractedProjects].sort(compareProjectOwnership);
  const ownerByFile = /* @__PURE__ */ new Map();
  for (const extractedProject of orderedProjects) {
    for (const file of extractedProject.files) {
      if (!ownerByFile.has(file.file)) ownerByFile.set(file.file, extractedProject);
    }
  }
  const representationByNodeId = /* @__PURE__ */ new Map();
  const retainedNodeByRepresentation = /* @__PURE__ */ new Map();
  const retainedNodeIds = /* @__PURE__ */ new Set();
  for (const extractedProject of extractedProjects) {
    for (const file of extractedProject.files) {
      const retained = ownerByFile.get(file.file) === extractedProject;
      for (const node of file.nodes) {
        const representation = nodeRepresentationKey(file.file, node);
        const existingRepresentation = representationByNodeId.get(node.id);
        if (existingRepresentation !== void 0 && existingRepresentation !== representation) {
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
    files: extractedProject.files.filter((file) => ownerByFile.get(file.file) === extractedProject).map((file) => {
      const edges = file.edges.map((edge) => {
        if (edge.targetId === null || retainedNodeIds.has(edge.targetId)) return edge;
        const targetRepresentation = representationByNodeId.get(edge.targetId);
        const retainedTarget = targetRepresentation === void 0 ? void 0 : retainedNodeByRepresentation.get(targetRepresentation);
        if (retainedTarget !== void 0) {
          return edgeWithIdentity({
            kind: edge.kind,
            sourceId: edge.sourceId,
            targetId: retainedTarget.id,
            resolution: edge.resolution,
            evidence: edge.evidence,
            ...edge.reason === void 0 ? {} : { reason: edge.reason }
          });
        }
        return edgeWithIdentity({
          kind: edge.kind,
          sourceId: edge.sourceId,
          targetId: null,
          resolution: "unresolved",
          evidence: edge.evidence,
          reason: "overlapping project target has no retained declaration"
        });
      });
      return {
        ...file,
        edges,
        unresolvedCount: edges.filter((edge) => edge.resolution === "unresolved").length
      };
    })
  }));
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
    canonicalRoot: (0, import_paths.normalizeProjectRoot)(project.root === "" ? canonicalRoot : project.root),
    canonicalConfigPath: project.configFile === null ? "" : (0, import_paths.normalizeProjectRoot)(project.configFile),
    files: withRepositoryRelativePaths(canonicalRoot, project, await extractProject(dependencies.runtime, project))
  })));
  for (const result of extracted) validateFiles(result.files);
  const retained = retainCanonicalFileOwnership(extracted);
  validateFiles(retained.flatMap((result) => result.files));
  const indexedAt = (dependencies.indexedAt ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
  const snapshots = retained.map(({ project, files }) => createSnapshot(
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
