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
var temp_cleanup_exports = {};
__export(temp_cleanup_exports, {
  TEMP_CLEANUP_RECENT_MS: () => TEMP_CLEANUP_RECENT_MS,
  cleanupTempRoots: () => cleanupTempRoots
});
module.exports = __toCommonJS(temp_cleanup_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
const TEMP_CLEANUP_RECENT_MS = 5 * 60 * 1e3;
function samePath(left, right) {
  const normalizedLeft = import_node_path.default.normalize(left);
  const normalizedRight = import_node_path.default.normalize(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}
function realPath(candidate) {
  return import_node_fs.default.realpathSync.native(candidate);
}
function isReparsePoint(candidate, stats) {
  const info = stats || import_node_fs.default.lstatSync(candidate);
  if (info.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  return !samePath(realPath(candidate), import_node_path.default.resolve(candidate));
}
function containsReparsePoint(candidate) {
  const stats = import_node_fs.default.lstatSync(candidate);
  if (isReparsePoint(candidate, stats)) return true;
  if (!stats.isDirectory()) return false;
  let names;
  try {
    names = import_node_fs.default.readdirSync(candidate);
  } catch (error) {
    throw new Error(`could not inspect ${candidate}: ${error?.message || String(error)}`);
  }
  for (const name of names) {
    if (containsReparsePoint(import_node_path.default.join(candidate, name))) return true;
  }
  return false;
}
function removeTree(candidate) {
  const stats = import_node_fs.default.lstatSync(candidate);
  if (isReparsePoint(candidate, stats)) throw new Error("reparse point");
  if (!stats.isDirectory()) {
    import_node_fs.default.unlinkSync(candidate);
    return 1;
  }
  let removed = 0;
  for (const name of import_node_fs.default.readdirSync(candidate)) removed += removeTree(import_node_path.default.join(candidate, name));
  import_node_fs.default.rmdirSync(candidate);
  return removed + 1;
}
function resolveCleanupRoot(candidate) {
  const expected = realPath(import_node_os.default.tmpdir());
  const requested = candidate ? import_node_path.default.resolve(candidate) : expected;
  let resolved;
  try {
    resolved = realPath(requested);
  } catch {
    throw new Error(`temp cleanup refused: root does not exist: ${requested}`);
  }
  if (!samePath(resolved, expected)) {
    throw new Error(`temp cleanup refused: root must resolve to the OS temp directory (${expected})`);
  }
  if (isReparsePoint(requested)) {
    throw new Error("temp cleanup refused: the OS temp directory is a symlink or reparse point");
  }
  return expected;
}
function cleanupTempRoots(options = {}) {
  const root = resolveCleanupRoot(options.root);
  const now = options.now ?? Date.now();
  const recentMs = options.recentMs ?? TEMP_CLEANUP_RECENT_MS;
  const report = {
    root,
    recentMs,
    scanned: 0,
    removed: 0,
    removedEntries: 0,
    skippedRecent: [],
    skippedUnsafe: [],
    failed: []
  };
  for (const name of import_node_fs.default.readdirSync(root)) {
    if (!name.startsWith("sq-")) continue;
    const candidate = import_node_path.default.join(root, name);
    report.scanned++;
    let stats;
    try {
      stats = import_node_fs.default.lstatSync(candidate);
    } catch (error) {
      report.failed.push({ path: candidate, error: error?.message || String(error) });
      continue;
    }
    if (stats.mtimeMs > now - recentMs) {
      report.skippedRecent.push(candidate);
      continue;
    }
    try {
      if (isReparsePoint(candidate, stats) || containsReparsePoint(candidate)) {
        report.skippedUnsafe.push(candidate);
        continue;
      }
    } catch (error) {
      report.skippedUnsafe.push(candidate);
      report.failed.push({ path: candidate, error: error?.message || String(error) });
      continue;
    }
    try {
      report.removedEntries += removeTree(candidate);
      report.removed++;
    } catch (error) {
      report.failed.push({ path: candidate, error: error?.message || String(error) });
    }
  }
  return report;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TEMP_CLEANUP_RECENT_MS,
  cleanupTempRoots
});
