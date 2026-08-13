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
var import_node_child_process = require("node:child_process");
var import_node_fs2 = __toESM(require("node:fs"));
var import_promises = require("node:fs/promises");
var import_node_os = __toESM(require("node:os"));
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
var DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
var MAX_ORPHAN_SUBJECT_LENGTH = 120;
function windowsProcesses() {
  try {
    const result = (0, import_node_child_process.spawnSync)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CreationDate,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress"
    ], { encoding: "utf8", timeout: 3e3, windowsHide: true });
    if (result.status !== 0) return [];
    const parsed = JSON.parse(String(result.stdout || ""));
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
      const pid = Number(entry?.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const kernelSeconds = Number(entry.KernelModeTime) / 1e7;
      const userSeconds = Number(entry.UserModeTime) / 1e7;
      return [{
        pid,
        imageName: String(entry.Name || "unknown"),
        startTime: String(entry.CreationDate || ""),
        cpuSeconds: Number.isFinite(kernelSeconds + userSeconds) ? Math.floor(kernelSeconds + userSeconds) : null,
        command: String(entry.CommandLine || "")
      }];
    });
  } catch (_) {
    return [];
  }
}
function normalizedWindowsPath(value) {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
function referencesWorktree(command, worktreePath) {
  const target = normalizedWindowsPath(worktreePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${target}(?=$|[\\\\/"'\\s])`, "i").test(normalizedWindowsPath(command));
}
function worktreeRemovalFailureNotice(failure, options = {}) {
  const notice = `could not remove ${failure.path || "a git entry"}: ${failure.message}`;
  if ((options.platform ?? process.platform) !== "win32" || !failure.path || !(options.existsSync || import_node_fs2.default.existsSync)(failure.path)) return notice;
  const processes = (options.listProcesses || windowsProcesses)().filter((entry) => referencesWorktree(entry.command, failure.path));
  if (!processes.length) return notice;
  const details = processes.map((entry) => {
    const started = entry.startTime ? `, started ${entry.startTime}` : "";
    const cpu = entry.cpuSeconds === null ? "" : `, CPU ${entry.cpuSeconds}s`;
    return `pid ${entry.pid} (${entry.imageName}${started}${cpu})`;
  });
  return `${notice}. Processes still using it: ${details.join("; ")}. End those PIDs and re-run the sweep.`;
}
function stateFile() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "worktree-sweep-sessions.json");
}
function readState() {
  try {
    return JSON.parse(import_node_fs2.default.readFileSync(stateFile(), "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState(state) {
  try {
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(stateFile()), { recursive: true });
    import_node_fs2.default.writeFileSync(stateFile(), JSON.stringify(state), "utf8");
  } catch (_) {
  }
}
function sessionId(data) {
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function projectCommand(project) {
  return `node "${pluginRoot()}/bin/sidequest.js" board-config --project "${project.path}" --integration-branch <branch>`;
}
function sessionWorktreePath(start) {
  const resolved = import_node_path2.default.resolve(start);
  let candidate = resolved;
  for (; ; ) {
    try {
      if (import_node_fs2.default.existsSync(import_node_path2.default.join(candidate, ".git"))) return candidate;
    } catch (_) {
      return resolved;
    }
    const parent = import_node_path2.default.dirname(candidate);
    if (parent === candidate) return resolved;
    candidate = parent;
  }
}
function currentProject(data, store) {
  const start = stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentPath = store.nearestRepoRoot(start);
  const found = store.findProject(currentPath);
  return {
    project: found.ok && found.slug && found.meta?.path ? { slug: found.slug, path: found.meta.path } : null,
    sessionPath: sessionWorktreePath(start)
  };
}
function liveSessionPaths() {
  return Object.values(readState().sessions || {});
}
function abbreviated(value) {
  return value.length <= MAX_ORPHAN_SUBJECT_LENGTH ? value : `${value.slice(0, MAX_ORPHAN_SUBJECT_LENGTH - 1)}…`;
}
function orphanNotices(data, project, orphanBranches) {
  const id = sessionId(data);
  if (!id) return [];
  const state = readState();
  const reported = new Set(state.reportedOrphans?.[id] || []);
  const kept = orphanBranches.filter((entry) => entry.action === "keep" && entry.reason === "not_integrated" && !reported.has(`${project.slug}:${entry.branch}`));
  if (!kept.length) return [];
  state.reportedOrphans = state.reportedOrphans || {};
  state.reportedOrphans[id] = [...reported, ...kept.map((entry) => `${project.slug}:${entry.branch}`)];
  writeState(state);
  return kept.map((entry) => `sidequest: unintegrated orphan worktree branch ${entry.branch}: ${abbreviated(String(entry.subject || "no commit subject"))}.`);
}
function salvageNotices(salvaged) {
  return salvaged.map((entry) => `sidequest: salvaged unintegrated worktree ${entry.path} at ${entry.ref}. Recover with ${entry.recovery}.`);
}
function missingIntegrationTarget(error) {
  return /Configured integration ref .+ does not exist\./.test(String(error?.message || error));
}
async function sweepWorktrees(data, includeKnownProjects) {
  const store = require(runtimeModule("store"));
  const { project: current, sessionPath } = currentProject(data, store);
  if (!current) return [];
  const projects = includeKnownProjects ? store.worktreeGcProjects(current.slug, MAX_PROJECTS_PER_START) : [current];
  const notices = [];
  const worktrees = require(runtimeModule("worktrees"));
  const activePaths = liveSessionPaths();
  for (const project of projects) {
    const isCurrentProject = project.slug === current.slug;
    try {
      await (0, import_promises.stat)(import_node_path2.default.join(project.path, ".git"));
    } catch (_) {
      continue;
    }
    let target;
    try {
      target = store.integrationTarget(project.slug);
    } catch (error) {
      if (isCurrentProject && missingIntegrationTarget(error)) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the configured integration branch is unavailable locally.`);
      }
      continue;
    }
    if (!target) {
      if (isCurrentProject) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: no integration target. Configure one with ${projectCommand(project)}.`);
      }
      continue;
    }
    try {
      const config = store.boardConfig(project.slug);
      const result = await worktrees.sweep(project.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: isCurrentProject ? sessionPath : "",
        livePaths: activePaths,
        integrationTarget: target,
        maxCandidates: MAX_CANDIDATES_PER_PROJECT,
        notIntegratedSalvageAgeMs: (config?.notIntegratedSalvageAgeHours || DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS) * 60 * 60 * 1e3
      });
      if (!isCurrentProject) continue;
      if (result.skipped === "repository_busy") {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the repository has an in-progress git operation.`);
      }
      for (const failure of result.failures || []) {
        if (!failure.suppressed) {
          notices.push(`sidequest: worktree sweep for ${project.name || project.slug} ${worktreeRemovalFailureNotice(failure)}`);
        }
      }
      notices.push(...salvageNotices(result.salvaged || []));
      notices.push(...orphanNotices(data, project, result.orphanBranches || []));
    } catch (error) {
      if (isCurrentProject) {
        notices.push(`sidequest: worktree sweep failed for ${project.name || project.slug}: ${error && error.message || error}. Check the repository is available, then run ${projectCommand(project)}.`);
      }
    }
  }
  return notices;
}

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path3.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path3.default.join(stateDirectory(), `${key}.json`);
}
function writeReport(cwd, notices) {
  try {
    import_node_fs3.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs3.default.writeFileSync(reportFile(cwd), JSON.stringify({ notices, finishedAt: (/* @__PURE__ */ new Date()).toISOString() }));
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
