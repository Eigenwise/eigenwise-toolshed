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
  FILESYSTEM_SNAPSHOT_MAX_BYTES: () => FILESYSTEM_SNAPSHOT_MAX_BYTES,
  FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS: () => FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS,
  FILESYSTEM_SNAPSHOT_MAX_PATHS: () => FILESYSTEM_SNAPSHOT_MAX_PATHS,
  FilesystemSnapshotLimitError: () => FilesystemSnapshotLimitError,
  filesystemSnapshotCapability: () => filesystemSnapshotCapability,
  filesystemSnapshotRevision: () => filesystemSnapshotRevision,
  isFilesystemSnapshotLimitError: () => isFilesystemSnapshotLimitError,
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
const FILESYSTEM_SNAPSHOT_MAX_PATHS = 500;
const FILESYSTEM_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS = 1e4;
class FilesystemSnapshotLimitError extends Error {
  bound;
  observed;
  cap;
  constructor(bound, observed, cap) {
    super(`filesystem snapshot ${bound} exceeded: observed ${observed}, cap ${cap}`);
    this.name = "FilesystemSnapshotLimitError";
    this.bound = bound;
    this.observed = observed;
    this.cap = cap;
  }
}
function isFilesystemSnapshotLimitError(error) {
  return error instanceof FilesystemSnapshotLimitError;
}
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
function snapshotLimit(value, defaultLimit) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultLimit;
}
function filesystemSnapshotState(options) {
  const now = options?.now || performance.now.bind(performance);
  return {
    pathCount: 0,
    bytesRead: 0,
    maxPaths: snapshotLimit(options?.maxPaths, FILESYSTEM_SNAPSHOT_MAX_PATHS),
    maxBytes: snapshotLimit(options?.maxBytes, FILESYSTEM_SNAPSHOT_MAX_BYTES),
    maxElapsedMs: snapshotLimit(options?.maxElapsedMs, FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS),
    startedAt: now(),
    now,
    readFile: options?.readFile || ((entryPath) => (0, import_node_fs.readFileSync)(entryPath))
  };
}
function assertSnapshotDeadline(state) {
  const elapsedMs = Math.max(0, state.now() - state.startedAt);
  if (elapsedMs > state.maxElapsedMs) {
    throw new FilesystemSnapshotLimitError("deadline", elapsedMs, state.maxElapsedMs);
  }
}
function countSnapshotPath(state) {
  state.pathCount += 1;
  if (state.pathCount > state.maxPaths) {
    throw new FilesystemSnapshotLimitError("path cap", state.pathCount, state.maxPaths);
  }
}
function reserveSnapshotBytes(state, byteCount) {
  const observedBytes = state.bytesRead + byteCount;
  if (observedBytes > state.maxBytes) {
    throw new FilesystemSnapshotLimitError("byte cap", observedBytes, state.maxBytes);
  }
}
function updateFilesystemSnapshot(hash, projectPath, entryPath, state) {
  assertSnapshotDeadline(state);
  const entry = (0, import_node_fs.lstatSync)(entryPath);
  assertSnapshotDeadline(state);
  countSnapshotPath(state);
  const relativePath = snapshotPath(projectPath, entryPath);
  if (entry.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    const children = (0, import_node_fs.readdirSync)(entryPath).sort((left, right) => left.localeCompare(right));
    assertSnapshotDeadline(state);
    for (const child of children) updateFilesystemSnapshot(hash, projectPath, (0, import_node_path.resolve)(entryPath, child), state);
    return;
  }
  if (entry.isSymbolicLink()) {
    const target = (0, import_node_fs.readlinkSync)(entryPath);
    assertSnapshotDeadline(state);
    hash.update(`symlink\0${relativePath}\0${target}\0`);
    return;
  }
  if (entry.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    reserveSnapshotBytes(state, entry.size);
    const contents = state.readFile(entryPath);
    assertSnapshotDeadline(state);
    reserveSnapshotBytes(state, contents.byteLength);
    state.bytesRead += contents.byteLength;
    hash.update(contents);
    hash.update("\0");
    return;
  }
  hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}
function filesystemSnapshotRevision(projectPath, observedAt = (/* @__PURE__ */ new Date()).toISOString(), options) {
  const root = (0, import_node_path.resolve)(String(projectPath || "").trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  const state = filesystemSnapshotState(options);
  let rootExists = false;
  try {
    if (!(0, import_node_fs.lstatSync)(root).isDirectory()) return null;
    assertSnapshotDeadline(state);
    rootExists = true;
  } catch (error) {
    if (isFilesystemSnapshotLimitError(error)) throw error;
    if (error.code !== "ENOENT") return null;
  }
  const hash = (0, import_node_crypto.createHash)("sha256");
  hash.update("sidequest-filesystem-snapshot-v1\0");
  try {
    if (rootExists) updateFilesystemSnapshot(hash, root, root, state);
    else hash.update("missing-project-root\0");
  } catch (error) {
    if (isFilesystemSnapshotLimitError(error)) throw error;
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
  FILESYSTEM_SNAPSHOT_MAX_BYTES,
  FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS,
  FILESYSTEM_SNAPSHOT_MAX_PATHS,
  FilesystemSnapshotLimitError,
  filesystemSnapshotCapability,
  filesystemSnapshotRevision,
  isFilesystemSnapshotLimitError,
  isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability,
  sourceRevision,
  sourceRevisionAdapterFacts,
  sourceRevisionBaseline
});
