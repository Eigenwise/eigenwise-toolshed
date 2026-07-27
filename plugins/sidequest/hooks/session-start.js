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
function isSubagent(input) {
  return ["agent_id", "agentId", "agent_type", "agentType"].some((name) => {
    const identity = String(input[name] || "").trim().toLowerCase();
    return identity && identity !== "main" && identity !== "main-thread";
  });
}

// src/hooks/shared/output.ts
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/compaction.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
var TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
function disabledValue(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}
function compactionSuggestionsEnabled() {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}
function isPrimarySession(input) {
  return !isSubagent(input);
}
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "compaction-suggestions");
}
function stateFile(sessionId) {
  return import_node_path2.default.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}
function transcriptBytes(transcriptPath) {
  try {
    return import_node_fs2.default.statSync(String(transcriptPath || "")).size;
  } catch (_) {
    return 0;
  }
}
function writeState(sessionId, state) {
  try {
    import_node_fs2.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs2.default.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}
function initializeCompactionState(sessionId, transcriptPath) {
  if (!sessionId || !compactionSuggestionsEnabled()) return;
  const file = stateFile(sessionId);
  if (import_node_fs2.default.existsSync(file)) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  writeState(sessionId, { resetAt: now, ticketBaselineAt: now, transcriptBytes: transcriptBytes(transcriptPath) });
}

// src/hooks/shared/worktree-sweep.ts
var import_promises = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"));
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
      await (0, import_promises.stat)(import_node_path3.default.join(project.path, ".git"));
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

// src/hooks/session-start.ts
var MAX_WORKFORCE_BYTES = 1800;
var MAX_WORKFORCE_DESCRIPTION = 90;
function truncateText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}
function workforceSection() {
  try {
    const store = require(runtimeModule("store"));
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok && found.slug ? found.slug : "";
    const header = "YOUR EXECUTORS — delegate work AND investigation to them:";
    const entries = store.getCategories({ project, includeDisabled: false }).map((category) => {
      const route = store.resolveCategoryRoute(category);
      return {
        id: String(category.id || "").trim(),
        route: `(${route.model}·${route.effort})`,
        description: truncateText(category.description, MAX_WORKFORCE_DESCRIPTION)
      };
    });
    const bytesFor = (lines) => Buffer.byteLength([header, ...lines].join("\n"));
    const base = entries.map((entry) => `${entry.id} — ${entry.route}`);
    if (bytesFor(base) > MAX_WORKFORCE_BYTES) {
      const bounded = [];
      for (let index = 0; index < base.length; index += 1) {
        const line = base[index] || "";
        const truncation = `… ${base.length - index} more enabled categories.`;
        if (bytesFor([...bounded, line, truncation]) > MAX_WORKFORCE_BYTES) return [header, ...bounded, truncation].join("\n");
        bounded.push(line);
      }
    }
    const priority = /* @__PURE__ */ new Set(["codebase-exploration", "debugging", "spike-investigation", "research"]);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const descriptions = /* @__PURE__ */ new Map();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = entries.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + " " : ""}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...entries.map((entry) => `${entry.id} — ${descriptions.get(entry.id) ? descriptions.get(entry.id) + " " : ""}${entry.route}`)].join("\n");
  } catch (_) {
    return "";
  }
}
function withWorkforce(context) {
  const section = workforceSection();
  return section ? context + "\n" + section : context;
}
function provisionExecAgents() {
  try {
    const store = require(runtimeModule("store"));
    const sync = require(runtimeModule("agentsync"));
    store.sweepStaleClaims({ source: "session-start" });
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1e3 });
    return sync.syncExecAgentsIfChanged();
  } catch (_) {
    return null;
  }
}
function reconcileLostLaunches(data) {
  try {
    const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
    const store = require(runtimeModule("store"));
    const result = store.reconcileLaunchedDispatches(sessionId, { source: "session-start" });
    return result && Array.isArray(result.reconciled) ? result.reconciled : [];
  } catch (_) {
    return [];
  }
}
function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}
function checkpointingGuidance(data) {
  const model = stringField(data, "model").toLowerCase();
  const tier = model.includes("haiku") ? "Haiku" : model.includes("sonnet") ? "Sonnet" : "";
  if (!tier) return "";
  return "\nCHECKPOINT MODE (" + tier + "): state your read and proceed on cheap-to-reverse config, category, or route edits. Ask only before an incomplete-evidence judgment ships, deletes data or refs, spends irreversible quota, or locks in work others build on. Do not ask for routine ticket filing, an exact user spec, or mechanical single-project work. `references/orchestrator-checkpointing.md`.";
}
function emit(context, notice) {
  const output = notice ? context + "\n" + notice : context;
  writeContext("SessionStart", withWorkforce(output));
}
async function main() {
  const data = readStdin();
  if (!data) return;
  if (isPrimarySession(data)) {
    const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
    initializeCompactionState(sessionId, data.transcript_path || data.transcriptPath);
  }
  const syncResult = provisionExecAgents();
  const lostLaunches = reconcileLostLaunches(data);
  let sweepNotices = [];
  try {
    sweepNotices = await sweepWorktrees(data, true);
  } catch (error) {
    sweepNotices = [`sidequest: worktree sweep failed: ${error && error.message || error}`];
  }
  const restartNotice = [
    syncResult && syncResult.written > 0 ? require(runtimeModule("agentsync")).RESTART_NOTICE : "",
    lostLaunches.length ? `sidequest: ${lostLaunches.join(", ")} launched but never claimed before this reload. Their native task is gone; re-dispatch and spawn them, then pulse to confirm the token claim.` : "",
    ...sweepNotices
  ].filter(Boolean).join("\n");
  if (nudgeOff()) return;
  const cli = `node "${pluginRoot()}/bin/sidequest.js"`;
  const source = stringField(data, "source");
  if (source === "compact" || source === "resume") {
    emit(
      "=== sidequest (active — context restored) ===\nROLE: ORCHESTRATOR. Reload Sidequest. Agent launches use dispatch's executor/spawn. Ticket + dispatch BEFORE multi-file exploration. Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Routed direct:true needs `direct-ok` + a reason; invalid: context, patch, handoff cost. mcp__plugin_sidequest_board__list status=doing FIRST; CLI: `" + cli + " list --status doing`; mcp__plugin_sidequest_board__* absent (not errors)? Ask USER to `/reload-plugins`.\nNative results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. one background timer, never foreground sleep loop.\n" + checkpointingGuidance(data),
      restartNotice
    );
    return;
  }
  emit(
    "=== sidequest (active) ===\nREQUIRED: Substantive changes/investigations need tickets; fresh `dispatch` returns executor/spawn/token. Every Agent uses it.\nOperational requests (run/build/test app; start/stop dev server; open dashboard; answer from visible context): act inline, without the Sidequest skill, category_list, or board reads.\nROLE: you are this project's ORCHESTRATOR; write tickets, offload work.\n" + checkpointingGuidance(data) + "\nReload the Sidequest skill before board work. SOLO-FIT picks one-executor vs wave; it NEVER means you implement inline. Small coherent work, or work whose contract cannot be pinned without doing it: ONE ticket, ONE executor. Otherwise, if a written spec pins shared types/interfaces, file bounds, and per-piece verifies, 3+ independently checkable pieces use contract-first: pin contract, one parallel wave to category-appropriate cheaper models, integrate once. Otherwise use checkable ATOMIC tickets; several deliverables are a smell, so plan then wave. Passing done-oracle skips audit/fix unless high-stakes; full suite once/wave. An external tracker like Jira still uses Sidequest.\nExecution economy:\n• Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Ticket + dispatch MUST precede multi-file exploration: second file is the boundary. Delegated investigation: spike ticket (`codebase-exploration`), route and dispatch. `Explore`/`claude-code-guide`/`statusline-setup`: narrow harness recon. direct:true claims need user `direct-ok` + reason. Native results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence; never proxy-wait via shell/Monitor/cron polls or blocking TaskOutput. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. one background timer, never foreground sleep loop. Inline: trivial; beyond it, substantive actions are BLOCKED until claim. Use `bypassPermissions`; never `native_agent`.\n• SHORT: category description; ticket description is executor brief; bounce back.\n• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n• File issues with mcp__plugin_sidequest_board__add, continue.\nBoard actions go through the mcp__plugin_sidequest_board__* MCP tools whenever available — reach for them FIRST; Bash+CLI is the fallback. If those tools are absent (not errors), ask USER to run `/reload-plugins`. Open the board: `" + cli + " dashboard`.",
    restartNotice
  );
}
main().catch((error) => {
  console.error(`sidequest: session-start failed: ${error && error.message || error}`);
});
