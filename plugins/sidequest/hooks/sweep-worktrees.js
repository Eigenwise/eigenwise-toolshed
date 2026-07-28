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

// src/hooks/shared/worktree-sweep.ts
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));

// src/hooks/shared/input.ts
var import_node_fs = __toESM(require("node:fs"));
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

// src/hooks/shared/worktree-sweep.ts
var MAX_PROJECTS_PER_START = 3;
var MAX_CANDIDATES_PER_PROJECT = 8;
function projectCommand(project) {
  return `node "${pluginRoot()}/bin/sidequest.js" board-config --project "${project.path}" --integration-branch <branch>`;
}
function currentProject(data, store) {
  const start = stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentPath = store.nearestRepoRoot(start);
  const found = store.findProject(currentPath);
  return {
    project: found.ok && found.slug && found.meta?.path ? { slug: found.slug, path: found.meta.path } : null,
    currentPath
  };
}
async function sweepWorktrees(data, includeKnownProjects) {
  const store = require(runtimeModule("store"));
  const { project: current, currentPath } = currentProject(data, store);
  if (!current) return [];
  const projects = includeKnownProjects ? store.worktreeGcProjects(current.slug, MAX_PROJECTS_PER_START) : [current];
  const notices = [];
  const worktrees = require(runtimeModule("worktrees"));
  for (const project of projects) {
    try {
      await (0, import_promises.stat)(import_node_path2.default.join(project.path, ".git"));
    } catch (_) {
      notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the project directory is unavailable or is not a git worktree.`);
      continue;
    }
    try {
      const target = store.integrationTarget(project.slug);
      if (!target) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: no integration target. Configure one with ${projectCommand(project)}.`);
        continue;
      }
      const result = await worktrees.sweep(project.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: current?.slug === project.slug ? currentPath : "",
        integrationTarget: target,
        maxCandidates: MAX_CANDIDATES_PER_PROJECT
      });
      if (result.skipped === "repository_busy") {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the repository has an in-progress git operation.`);
      }
      for (const failure of result.failures || []) {
        notices.push(`sidequest: worktree sweep for ${project.name || project.slug} could not remove ${failure.path || "a git entry"}: ${failure.message}`);
      }
    } catch (error) {
      notices.push(`sidequest: worktree sweep failed for ${project.name || project.slug}: ${error && error.message || error}. Check the repository is available, then run ${projectCommand(project)}.`);
    }
  }
  return notices;
}

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path3.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path3.default.join(stateDirectory(), `${key}.json`);
}
function writeReport(cwd, notices) {
  try {
    import_node_fs2.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs2.default.writeFileSync(reportFile(cwd), JSON.stringify({ notices, finishedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch (_) {
  }
}

// src/hooks/sweep-worktrees.ts
function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}
async function main() {
  const cwd = argument("cwd") || process.cwd();
  const data = { cwd, session_id: argument("session") };
  let notices;
  try {
    notices = await sweepWorktrees(data, true);
  } catch (error) {
    notices = [`sidequest: worktree sweep failed: ${error && error.message || error}`];
  }
  writeReport(cwd, notices);
}
main().catch((error) => {
  writeReport(argument("cwd") || process.cwd(), [
    `sidequest: worktree sweep failed: ${error && error.message || error}`
  ]);
});
