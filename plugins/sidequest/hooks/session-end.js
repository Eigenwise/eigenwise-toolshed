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

// src/hooks/shared/worktree-sweep.ts
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));
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

// src/hooks/session-end.ts
async function main() {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!sessionId) return;
  const reasonValue = data.reason;
  const reason = reasonValue ? `session ended (${String(reasonValue)})` : "session ended";
  const notices = [];
  try {
    const store = require(runtimeModule("store"));
    store.reconcileSession(sessionId, { reason, source: "session-end" });
    const agentsync = require(runtimeModule("agentsync"));
    agentsync.cleanupNativeAgents({ sessionId });
  } catch (error) {
    notices.push(`sidequest: session-end reconciliation failed: ${error && error.message || error}`);
  }
  try {
    notices.push(...await sweepWorktrees(data, false));
  } catch (error) {
    notices.push(`sidequest: session-end worktree sweep failed: ${error && error.message || error}`);
  }
  if (notices.length) console.error(notices.join("\n"));
}
main().catch((error) => {
  console.error(`sidequest: session-end failed: ${error && error.message || error}`);
});
