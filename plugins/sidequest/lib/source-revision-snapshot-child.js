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
var source_revision_snapshot_child_exports = {};
__export(source_revision_snapshot_child_exports, {
  SNAPSHOT_SKIPPED_NAMES: () => SNAPSHOT_SKIPPED_NAMES,
  runSnapshotChild: () => runSnapshotChild,
  snapshotChildResult: () => snapshotChildResult
});
module.exports = __toCommonJS(source_revision_snapshot_child_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
const SNAPSHOT_SKIPPED_NAMES = Object.freeze([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "vendor"]);
const skippedNames = new Set(SNAPSHOT_SKIPPED_NAMES);
const REPORTED_SKIPPED_MAX = 10;
const REPORTED_COUNTED_MAX = 5;
const UNAVAILABLE = Object.freeze({ unavailable: true });
class SnapshotCapReached extends Error {
  bound;
  observed;
  cap;
  constructor(bound, observed, cap) {
    super(`filesystem snapshot ${bound} exceeded: observed ${observed}, cap ${cap}`);
    this.name = "SnapshotCapReached";
    this.bound = bound;
    this.observed = observed;
    this.cap = cap;
  }
}
function gitignoreRule(line) {
  const directoryOnly = line.endsWith("/");
  const pattern = directoryOnly ? line.slice(0, -1) : line;
  if (!pattern.includes("/")) return Object.freeze({ glob: `**/${pattern}`, directoryOnly });
  return Object.freeze({ glob: pattern.startsWith("/") ? pattern.slice(1) : pattern, directoryOnly });
}
function gitignoreRules(root) {
  let text;
  try {
    text = (0, import_node_fs.readFileSync)((0, import_node_path.join)(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")).map(gitignoreRule);
}
function skippedByWalk(walk, relativePath, isDirectory) {
  return skippedNames.has((0, import_node_path.basename)(relativePath)) || walk.ignoreRules.some((rule) => (isDirectory || !rule.directoryOnly) && (0, import_node_path.matchesGlob)(relativePath, rule.glob));
}
function snapshotPath(root, entryPath) {
  return (0, import_node_path.relative)(root, entryPath).split(import_node_path.sep).join("/");
}
function countSnapshotPath(walk, relativePath) {
  const topLevel = relativePath.split("/")[0] || ".";
  walk.countedByTopLevel.set(topLevel, (walk.countedByTopLevel.get(topLevel) || 0) + 1);
  walk.pathCount += 1;
  if (walk.pathCount > walk.payload.maxPaths) {
    throw new SnapshotCapReached("path cap", walk.pathCount, walk.payload.maxPaths);
  }
}
function reserveSnapshotBytes(walk, byteCount) {
  const observedBytes = walk.bytesRead + byteCount;
  if (observedBytes > walk.payload.maxBytes) {
    throw new SnapshotCapReached("byte cap", observedBytes, walk.payload.maxBytes);
  }
}
function updateDirectorySnapshot(walk, entryPath, relativePath) {
  walk.hash.update(`directory\0${relativePath}\0`);
  const children = (0, import_node_fs.readdirSync)(entryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const childPath = (0, import_node_path.resolve)(entryPath, child.name);
    const childRelativePath = snapshotPath(walk.root, childPath);
    if (skippedByWalk(walk, childRelativePath, child.isDirectory())) walk.skipped.push(childRelativePath);
    else updateFilesystemSnapshot(walk, childPath);
  }
}
function updateFilesystemSnapshot(walk, entryPath) {
  const entry = (0, import_node_fs.lstatSync)(entryPath);
  const relativePath = snapshotPath(walk.root, entryPath);
  countSnapshotPath(walk, relativePath);
  if (entry.isDirectory()) {
    updateDirectorySnapshot(walk, entryPath, relativePath);
    return;
  }
  if (entry.isSymbolicLink()) {
    walk.hash.update(`symlink\0${relativePath}\0${(0, import_node_fs.readlinkSync)(entryPath)}\0`);
    return;
  }
  if (entry.isFile()) {
    walk.hash.update(`file\0${relativePath}\0`);
    reserveSnapshotBytes(walk, entry.size);
    (0, import_node_fs.writeSync)(2, `${walk.payload.readingMarker}${relativePath}
`);
    const contents = walk.read(entryPath);
    reserveSnapshotBytes(walk, contents.byteLength);
    walk.bytesRead += contents.byteLength;
    walk.hash.update(contents);
    walk.hash.update("\0");
    return;
  }
  walk.hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}
function largestCountedEntries(walk) {
  return [...walk.countedByTopLevel].sort((left, right) => right[1] - left[1]).slice(0, REPORTED_COUNTED_MAX).map(([path, paths]) => Object.freeze({ path, paths }));
}
function walkedSnapshotResult(walk) {
  try {
    updateFilesystemSnapshot(walk, walk.root);
  } catch (error) {
    if (!(error instanceof SnapshotCapReached)) return UNAVAILABLE;
    return Object.freeze({
      limit: Object.freeze({
        bound: error.bound,
        observed: error.observed,
        cap: error.cap,
        skipped: walk.skipped.slice(0, REPORTED_SKIPPED_MAX),
        skippedTotal: walk.skipped.length,
        counted: largestCountedEntries(walk)
      })
    });
  }
  return Object.freeze({ digest: walk.hash.digest("hex") });
}
function snapshotRootState(root) {
  try {
    return (0, import_node_fs.lstatSync)(root).isDirectory() ? "directory" : "unavailable";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unavailable";
  }
}
function snapshotChildResult(payload, read = import_node_fs.readFileSync) {
  const root = (0, import_node_path.resolve)(payload.root);
  const rootState = snapshotRootState(root);
  if (rootState === "unavailable") return UNAVAILABLE;
  const hash = (0, import_node_crypto.createHash)("sha256");
  hash.update("sidequest-filesystem-snapshot-v1\0");
  if (rootState === "missing") return Object.freeze({ digest: hash.update("missing-project-root\0").digest("hex") });
  return walkedSnapshotResult({
    hash,
    root,
    payload,
    read,
    ignoreRules: gitignoreRules(root),
    pathCount: 0,
    bytesRead: 0,
    skipped: [],
    countedByTopLevel: /* @__PURE__ */ new Map()
  });
}
function runSnapshotChild(serializedPayload, read = import_node_fs.readFileSync) {
  const payload = JSON.parse(String(serializedPayload || "{}"));
  (0, import_node_fs.writeSync)(1, JSON.stringify(snapshotChildResult(payload, read)));
}
if (require.main === module) runSnapshotChild(process.argv[2]);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SNAPSHOT_SKIPPED_NAMES,
  runSnapshotChild,
  snapshotChildResult
});
