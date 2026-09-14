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
var worktree_placement_exports = {};
__export(worktree_placement_exports, {
  configuredWorktreeRoot: () => configuredWorktreeRoot,
  normalizeWorktreeDirectory: () => normalizeWorktreeDirectory
});
module.exports = __toCommonJS(worktree_placement_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
var import_worktree = require("./kernel/worktree.js");
function normalizeWorktreeDirectory(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("worktreeDirectory must be a relative directory or null.");
  const directory = value.trim().replace(/\\/g, "/");
  const segments = directory.split("/");
  if (import_node_path.default.posix.isAbsolute(directory) || import_node_path.default.win32.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory) || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    throw new Error("worktreeDirectory must stay below the repository without traversal or Git metadata paths.");
  }
  return directory;
}
function configuredWorktreeRoot(repository, value) {
  const directory = normalizeWorktreeDirectory(value);
  if (directory == null) return null;
  const root = (0, import_worktree.canonicalPath)(repository);
  let target = root;
  for (const segment of directory.split("/")) {
    target = import_node_path.default.join(target, segment);
    try {
      const stat = import_node_fs.default.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`worktreeDirectory contains a symlink or reparse point: ${target}`);
      if (!stat.isDirectory()) throw new Error(`worktreeDirectory is not a directory: ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error("worktreeDirectory must already exist; create the ignored directory before configuring it.");
    }
  }
  const tracked = (0, import_node_child_process.execFileSync)("git", ["--literal-pathspecs", "ls-files", "-z", "--", directory], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe"
  });
  if (tracked) throw new Error("worktreeDirectory contains tracked content; choose an ignored, untracked directory.");
  try {
    (0, import_node_child_process.execFileSync)("git", ["check-ignore", "--quiet", "--no-index", "--", directory], {
      cwd: root,
      windowsHide: true,
      stdio: "pipe"
    });
  } catch (_) {
    throw new Error("worktreeDirectory must be Git-ignored before configuration or provisioning; Sidequest will not edit ignore rules.");
  }
  return target;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  configuredWorktreeRoot,
  normalizeWorktreeDirectory
});
