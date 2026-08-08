#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/hooks/worktree-create.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}
function stringField(input, ...names) {
  for (const name of names) {
    const value = input[name];
    if (value != null) return String(value);
  }
  return "";
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/worktree-create.ts
function git(repository, args) {
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function gitSucceeds(repository, args) {
  try {
    git(repository, args);
    return true;
  } catch (_) {
    return false;
  }
}
function repositoryFor(cwd) {
  return import_node_path2.default.resolve(git(cwd, ["rev-parse", "--show-toplevel"]));
}
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = import_node_fs2.default.realpathSync.native(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function existingWorktreeMatches(repository, target) {
  try {
    const checkout = import_node_path2.default.resolve(git(target, ["rev-parse", "--show-toplevel"]));
    const commonOutput = git(target, ["rev-parse", "--git-common-dir"]);
    const common = import_node_path2.default.resolve(target, commonOutput);
    return samePath(checkout, target) && samePath(common, import_node_path2.default.join(repository, ".git"));
  } catch (_) {
    return false;
  }
}
function baseRef(repository) {
  try {
    return git(repository, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  } catch (_) {
    return "HEAD";
  }
}
function createWorktree(repository, name, target) {
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(target), { recursive: true });
  if (import_node_fs2.default.existsSync(target)) {
    if (existingWorktreeMatches(repository, target)) return;
    if (import_node_fs2.default.statSync(target).isDirectory() && import_node_fs2.default.readdirSync(target).length === 0) import_node_fs2.default.rmdirSync(target);
    else throw new Error(`worktree destination already exists and is not registered to this repository: ${target}`);
  }
  const branch = `worktree-${name}`;
  git(repository, ["check-ref-format", "--branch", branch]);
  if (gitSucceeds(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    git(repository, ["worktree", "add", target, branch]);
    return;
  }
  git(repository, ["worktree", "add", "-b", branch, target, baseRef(repository)]);
}
function main() {
  const input = readStdin();
  if (!input || stringField(input, "hook_event_name") !== "WorktreeCreate") return;
  const name = stringField(input, "name");
  const cwd = stringField(input, "cwd") || process.cwd();
  if (!name) throw new Error("WorktreeCreate requires a worktree name.");
  const repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule("worktrees"));
  const target = worktrees.namedWorktreePath(repository, name);
  createWorktree(repository, name, target);
  process.stdout.write(`${target}
`);
}
try {
  main();
} catch (error) {
  process.stderr.write(`sidequest: could not create external worktree: ${error?.message || String(error)}
`);
  process.exit(1);
}
