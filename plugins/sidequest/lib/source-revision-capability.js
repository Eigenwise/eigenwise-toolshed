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
  FilesystemSnapshotChildError: () => FilesystemSnapshotChildError,
  FilesystemSnapshotLimitError: () => FilesystemSnapshotLimitError,
  filesystemSnapshotCapability: () => filesystemSnapshotCapability,
  filesystemSnapshotRevision: () => filesystemSnapshotRevision,
  isFilesystemSnapshotChildError: () => isFilesystemSnapshotChildError,
  isFilesystemSnapshotLimitError: () => isFilesystemSnapshotLimitError,
  isSourceRevisionAdapterFacts: () => isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability: () => registerSourceRevisionCapability,
  sourceRevision: () => sourceRevision,
  sourceRevisionAdapterFacts: () => sourceRevisionAdapterFacts,
  sourceRevisionBaseline: () => sourceRevisionBaseline
});
module.exports = __toCommonJS(source_revision_capability_exports);
var import_node_child_process = require("node:child_process");
var import_node_path = require("node:path");
const FILESYSTEM_SNAPSHOT_SOURCE = "filesystem-snapshot";
const FILESYSTEM_SNAPSHOT_MAX_PATHS = 500;
const FILESYSTEM_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS = 1e4;
class FilesystemSnapshotLimitError extends Error {
  bound;
  observed;
  cap;
  path;
  constructor(bound, observed, cap, blockingPath = null) {
    super(`filesystem snapshot ${bound} exceeded: observed ${observed}, cap ${cap}${blockingPath ? ` while reading ${blockingPath}` : ""}`);
    this.name = "FilesystemSnapshotLimitError";
    this.bound = bound;
    this.observed = observed;
    this.cap = cap;
    this.path = blockingPath;
  }
}
function isFilesystemSnapshotLimitError(error) {
  return error instanceof FilesystemSnapshotLimitError;
}
class FilesystemSnapshotChildError extends Error {
  kind;
  code;
  status;
  stderr;
  constructor(kind, details = {}) {
    super(`filesystem snapshot child ${kind}`);
    this.name = "FilesystemSnapshotChildError";
    this.kind = kind;
    this.code = details.code ?? null;
    this.status = typeof details.status === "number" ? details.status : null;
    this.stderr = details.stderr || "";
  }
}
function isFilesystemSnapshotChildError(error) {
  return error instanceof FilesystemSnapshotChildError;
}
const SNAPSHOT_READING_MARKER = "sidequest-snapshot-reading	";
const SNAPSHOT_CHILD_STDERR_EXCERPT_MAX_BYTES = 400;
function boundedStderrExcerpt(stderr) {
  const text = String(stderr || "").trim();
  return text.length > SNAPSHOT_CHILD_STDERR_EXCERPT_MAX_BYTES ? `${text.slice(0, SNAPSHOT_CHILD_STDERR_EXCERPT_MAX_BYTES)}…` : text;
}
const snapshotChildExtension = (0, import_node_path.extname)(__filename) || ".js";
const snapshotChildRunsTypeScript = snapshotChildExtension === ".ts";
const defaultSnapshotChildScript = (0, import_node_path.resolve)(__dirname, `source-revision-snapshot-child${snapshotChildExtension}`);
const snapshotChildWorkingDirectory = snapshotChildRunsTypeScript ? (0, import_node_path.resolve)(__dirname, "..", "..") : void 0;
const registrationsByProject = /* @__PURE__ */ new Map();
const resolvedAdapterFacts = /* @__PURE__ */ new WeakSet();
function projectKey(project) {
  return String(project || "").trim().toLowerCase();
}
function baselinePurpose(value) {
  if (value === "dispatch" || value === "wave" || value === "submission") return value;
  return null;
}
function snapshotLimit(value, defaultLimit) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultLimit;
}
function blockingSnapshotPath(stderr) {
  const lines = String(stderr || "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] || "";
    if (line.startsWith(SNAPSHOT_READING_MARKER)) return line.slice(SNAPSHOT_READING_MARKER.length).trim() || null;
  }
  return null;
}
function snapshotChildResult(root, options) {
  const maxElapsedMs = snapshotLimit(options?.maxElapsedMs, FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS);
  const childScript = options?.childScript || defaultSnapshotChildScript;
  const payload = JSON.stringify({
    root,
    maxPaths: snapshotLimit(options?.maxPaths, FILESYSTEM_SNAPSHOT_MAX_PATHS),
    maxBytes: snapshotLimit(options?.maxBytes, FILESYSTEM_SNAPSHOT_MAX_BYTES),
    readingMarker: SNAPSHOT_READING_MARKER
  });
  const startedAt = performance.now();
  const child = (0, import_node_child_process.spawnSync)(
    process.execPath,
    snapshotChildRunsTypeScript ? ["--import", "tsx", childScript, payload] : [childScript, payload],
    // spawnSync reads a zero timeout as "no timeout", which is the unbounded hang this exists to end.
    { encoding: "utf8", timeout: Math.max(1, maxElapsedMs), windowsHide: true, cwd: snapshotChildWorkingDirectory }
  );
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  const spawnErrorCode = child.error?.code ?? null;
  if (spawnErrorCode === "ETIMEDOUT") {
    throw new FilesystemSnapshotLimitError("deadline", elapsedMs, maxElapsedMs, blockingSnapshotPath(child.stderr));
  }
  if (child.error) {
    throw new FilesystemSnapshotChildError("spawn-error", { code: spawnErrorCode });
  }
  if (child.status !== 0) {
    throw new FilesystemSnapshotChildError("exit-status", { status: child.status, stderr: boundedStderrExcerpt(child.stderr) });
  }
  try {
    return JSON.parse(String(child.stdout || ""));
  } catch {
    throw new FilesystemSnapshotChildError("unparseable");
  }
}
function filesystemSnapshotRevision(projectPath, observedAt = (/* @__PURE__ */ new Date()).toISOString(), options) {
  const root = (0, import_node_path.resolve)(String(projectPath || "").trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  const result = snapshotChildResult(root, options);
  if ("limit" in result) {
    throw new FilesystemSnapshotLimitError(result.limit.bound, result.limit.observed, result.limit.cap);
  }
  if (!("digest" in result)) return null;
  return Object.freeze({
    source: FILESYSTEM_SNAPSHOT_SOURCE,
    value: result.digest,
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
  FilesystemSnapshotChildError,
  FilesystemSnapshotLimitError,
  filesystemSnapshotCapability,
  filesystemSnapshotRevision,
  isFilesystemSnapshotChildError,
  isFilesystemSnapshotLimitError,
  isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability,
  sourceRevision,
  sourceRevisionAdapterFacts,
  sourceRevisionBaseline
});
