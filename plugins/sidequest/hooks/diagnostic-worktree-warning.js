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

// src/hooks/diagnostic-worktree-warning.ts
var diagnostic_worktree_warning_exports = {};
__export(diagnostic_worktree_warning_exports, {
  diagnosticWorktreeWarning: () => diagnosticWorktreeWarning
});
module.exports = __toCommonJS(diagnostic_worktree_warning_exports);
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}

// src/hooks/diagnostic-worktree-warning.ts
var WARNING = "sidequest: foreign agent worktrees detected; diagnostics under `.claude/worktrees/agent-*` are stale and false when their path is gone from disk, otherwise ignore them unless the live worktree belongs to a ticket you are about to integrate, where they are actionable and outweigh an executor's `verify passed` claim. Keep error-severity diagnostics in your own files actionable.";
function gitDirectory(entry) {
  try {
    if (import_node_fs2.default.statSync(entry).isDirectory()) return entry;
    const gitDir = /^gitdir:\s*(.+)$/m.exec(import_node_fs2.default.readFileSync(entry, "utf8"))?.[1];
    return gitDir ? import_node_path.default.resolve(import_node_path.default.dirname(entry), gitDir.trim()) : null;
  } catch (_) {
    return null;
  }
}
function checkoutLocation(start) {
  let current = import_node_path.default.resolve(start);
  while (true) {
    const gitDir = gitDirectory(import_node_path.default.join(current, ".git"));
    if (gitDir) {
      if (import_node_path.default.basename(gitDir) === ".git") return { checkoutRoot: current, projectRoot: current };
      const commonGitDir = import_node_path.default.resolve(gitDir, "..", "..");
      if (import_node_path.default.basename(commonGitDir) === ".git") return { checkoutRoot: current, projectRoot: import_node_path.default.dirname(commonGitDir) };
      return null;
    }
    const parent = import_node_path.default.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function isOwnWorktree(checkoutRoot, worktreesRoot, name) {
  return import_node_path.default.resolve(import_node_path.default.dirname(checkoutRoot)) === import_node_path.default.resolve(worktreesRoot) && import_node_path.default.basename(checkoutRoot) === name;
}
function diagnosticWorktreeWarning(input) {
  const start = stringField(input, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const location = checkoutLocation(start);
  if (!location) return "";
  const worktreesRoot = import_node_path.default.join(location.projectRoot, ".claude", "worktrees");
  try {
    return import_node_fs2.default.readdirSync(worktreesRoot, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name.startsWith("agent-") && !isOwnWorktree(location.checkoutRoot, worktreesRoot, entry.name)
    ) ? WARNING : "";
  } catch (_) {
    return "";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  diagnosticWorktreeWarning
});
