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
  runSnapshotChild: () => runSnapshotChild,
  snapshotChildResult: () => snapshotChildResult
});
module.exports = __toCommonJS(source_revision_snapshot_child_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
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
function snapshotPath(root, entryPath) {
  return (0, import_node_path.relative)(root, entryPath).split(import_node_path.sep).join("/");
}
function countSnapshotPath(walk) {
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
function updateFilesystemSnapshot(walk, entryPath) {
  const entry = (0, import_node_fs.lstatSync)(entryPath);
  countSnapshotPath(walk);
  const relativePath = snapshotPath(walk.root, entryPath);
  if (entry.isDirectory()) {
    walk.hash.update(`directory\0${relativePath}\0`);
    const children = (0, import_node_fs.readdirSync)(entryPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) updateFilesystemSnapshot(walk, (0, import_node_path.resolve)(entryPath, child));
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
function snapshotChildResult(payload, read = import_node_fs.readFileSync) {
  const root = (0, import_node_path.resolve)(payload.root);
  let rootExists = false;
  try {
    if (!(0, import_node_fs.lstatSync)(root).isDirectory()) return Object.freeze({ unavailable: true });
    rootExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") return Object.freeze({ unavailable: true });
  }
  const hash = (0, import_node_crypto.createHash)("sha256");
  hash.update("sidequest-filesystem-snapshot-v1\0");
  try {
    if (rootExists) updateFilesystemSnapshot({ hash, root, payload, read, pathCount: 0, bytesRead: 0 }, root);
    else hash.update("missing-project-root\0");
  } catch (error) {
    if (error instanceof SnapshotCapReached) {
      return Object.freeze({
        limit: Object.freeze({ bound: error.bound, observed: error.observed, cap: error.cap })
      });
    }
    return Object.freeze({ unavailable: true });
  }
  return Object.freeze({ digest: hash.digest("hex") });
}
function runSnapshotChild(serializedPayload, read = import_node_fs.readFileSync) {
  const payload = JSON.parse(String(serializedPayload || "{}"));
  (0, import_node_fs.writeSync)(1, JSON.stringify(snapshotChildResult(payload, read)));
}
if (require.main === module) runSnapshotChild(process.argv[2]);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runSnapshotChild,
  snapshotChildResult
});
