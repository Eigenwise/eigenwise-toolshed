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
var source_revision_capability_exports = {};
__export(source_revision_capability_exports, {
  filesystemSnapshotCapability: () => filesystemSnapshotCapability,
  filesystemSnapshotRevision: () => filesystemSnapshotRevision,
  isSourceRevisionAdapterFacts: () => isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability: () => registerSourceRevisionCapability,
  sourceRevision: () => sourceRevision,
  sourceRevisionAdapterFacts: () => sourceRevisionAdapterFacts,
  sourceRevisionBaseline: () => sourceRevisionBaseline
});
module.exports = __toCommonJS(source_revision_capability_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
const FILESYSTEM_SNAPSHOT_SOURCE = "filesystem-snapshot";
const registrationsByProject = /* @__PURE__ */ new Map();
const resolvedAdapterFacts = /* @__PURE__ */ new WeakSet();
function projectKey(project) {
  return String(project || "").trim().toLowerCase();
}
function baselinePurpose(value) {
  if (value === "dispatch" || value === "wave" || value === "submission") return value;
  return null;
}
function snapshotPath(projectPath, entryPath) {
  return (0, import_node_path.relative)(projectPath, entryPath).split(import_node_path.sep).join("/");
}
function updateFilesystemSnapshot(hash, projectPath, entryPath) {
  const entry = (0, import_node_fs.lstatSync)(entryPath);
  const relativePath = snapshotPath(projectPath, entryPath);
  if (entry.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    const children = (0, import_node_fs.readdirSync)(entryPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) updateFilesystemSnapshot(hash, projectPath, (0, import_node_path.resolve)(entryPath, child));
    return;
  }
  if (entry.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${(0, import_node_fs.readlinkSync)(entryPath)}\0`);
    return;
  }
  if (entry.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update((0, import_node_fs.readFileSync)(entryPath));
    hash.update("\0");
    return;
  }
  hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}
function filesystemSnapshotRevision(projectPath, observedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const root = (0, import_node_path.resolve)(String(projectPath || "").trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  let rootExists = false;
  try {
    if (!(0, import_node_fs.lstatSync)(root).isDirectory()) return null;
    rootExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") return null;
  }
  const hash = (0, import_node_crypto.createHash)("sha256");
  hash.update("sidequest-filesystem-snapshot-v1\0");
  try {
    if (rootExists) updateFilesystemSnapshot(hash, root, root);
    else hash.update("missing-project-root\0");
  } catch {
    return null;
  }
  return Object.freeze({
    source: FILESYSTEM_SNAPSHOT_SOURCE,
    value: hash.digest("hex"),
    observedAt: new Date(observedAt).toISOString()
  });
}
function filesystemSnapshotCapability(projectPath, hasPersistedBaseline) {
  return (candidate, baseline) => {
    if (candidate.source !== FILESYSTEM_SNAPSHOT_SOURCE) return null;
    const current = filesystemSnapshotRevision(projectPath, candidate.observedAt);
    return Object.freeze({
      candidateExists: current?.value === candidate.value,
      containsCandidate: baseline.revision.source === FILESYSTEM_SNAPSHOT_SOURCE && hasPersistedBaseline(baseline)
    });
  };
}
function sourceRevision(value) {
  const source = String(value?.source || "").trim();
  const revisionValue = String(value?.value || "").trim();
  const observedAt = String(value?.observedAt || "").trim();
  if (!source || !revisionValue || !Number.isFinite(Date.parse(observedAt))) return null;
  return Object.freeze({ source, value: revisionValue, observedAt: new Date(observedAt).toISOString() });
}
function immutableBaseline(value) {
  const revision = sourceRevision(value?.revision);
  const purpose = baselinePurpose(value?.purpose);
  if (!revision || !purpose) return null;
  return Object.freeze({ revision, purpose });
}
function sourceRevisionBaseline(ticket) {
  return immutableBaseline(
    ticket?.submissionRetry?.baseline || ticket?.lifecycleAttempt?.baseline || ticket?.dispatch?.lifecycleAttempt?.baseline
  );
}
function registerSourceRevisionCapability(project, capability) {
  const key = projectKey(project);
  if (!key) throw new Error("source revision capability requires a project");
  if (typeof capability !== "function") throw new Error("source revision capability must be a function");
  const token = Symbol(key);
  registrationsByProject.set(key, Object.freeze({ token, capability }));
  return () => {
    if (registrationsByProject.get(key)?.token === token) registrationsByProject.delete(key);
  };
}
function sourceRevisionAdapterFacts(project, candidate, baseline, persistedCapability) {
  const pinnedCandidate = sourceRevision(candidate || void 0);
  const pinnedBaseline = immutableBaseline(baseline || void 0);
  if (!pinnedCandidate || !pinnedBaseline) return null;
  const capability = registrationsByProject.get(projectKey(project))?.capability || persistedCapability;
  let resolution = null;
  if (capability) {
    try {
      const reported = capability(pinnedCandidate, pinnedBaseline);
      if (reported && typeof reported.candidateExists === "boolean" && typeof reported.containsCandidate === "boolean") {
        resolution = Object.freeze({
          candidateExists: reported.candidateExists,
          containsCandidate: reported.containsCandidate
        });
      }
    } catch {
      resolution = null;
    }
  }
  const facts = Object.freeze({
    candidate: pinnedCandidate,
    dispatchBaseline: pinnedBaseline,
    baseline: resolution
  });
  resolvedAdapterFacts.add(facts);
  return facts;
}
function isSourceRevisionAdapterFacts(value) {
  return Boolean(value && typeof value === "object" && resolvedAdapterFacts.has(value));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  filesystemSnapshotCapability,
  filesystemSnapshotRevision,
  isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability,
  sourceRevision,
  sourceRevisionAdapterFacts,
  sourceRevisionBaseline
});
