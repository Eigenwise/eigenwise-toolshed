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
var worktree_sweep_lock_exports = {};
__export(worktree_sweep_lock_exports, {
  withWorktreeSweepLock: () => withWorktreeSweepLock
});
module.exports = __toCommonJS(worktree_sweep_lock_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
function sweepLockFile() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path.default.join(home, "worktree-sweep.lock");
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function lockHolderAlive(file) {
  let holder = 0;
  try {
    holder = Number(import_node_fs.default.readFileSync(file, "utf8"));
  } catch (_) {
  }
  return Number.isInteger(holder) && holder > 0 && processAlive(holder);
}
function createSweepLock(file) {
  try {
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
    import_node_fs.default.writeFileSync(file, String(process.pid), { flag: "wx" });
    return "acquired";
  } catch (error) {
    return error?.code === "EEXIST" ? "held" : "unwritable";
  }
}
function removeStaleSweepLock(file) {
  try {
    if (!lockHolderAlive(file)) import_node_fs.default.rmSync(file, { force: true });
  } catch (_) {
  }
}
function releaseSweepLock(file) {
  try {
    if (import_node_fs.default.readFileSync(file, "utf8") === String(process.pid)) import_node_fs.default.rmSync(file, { force: true });
  } catch (_) {
  }
}
function acquireSweepLock(file) {
  let outcome = createSweepLock(file);
  if (outcome === "held") {
    removeStaleSweepLock(file);
    outcome = createSweepLock(file);
  }
  if (outcome === "held") return null;
  return outcome === "acquired" ? () => releaseSweepLock(file) : () => {
  };
}
async function withWorktreeSweepLock(sweep) {
  const release = acquireSweepLock(sweepLockFile());
  if (!release) return [];
  try {
    return await sweep();
  } finally {
    release();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  withWorktreeSweepLock
});
