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

// src/hooks/session-start.ts
var MAX_TAXONOMY_BYTES = 400;
var MAX_TAXONOMY_IDS = 10;
function taxonomyIds(ids) {
  const shown = ids.slice(0, MAX_TAXONOMY_IDS);
  return shown.join(", ") + (shown.length < ids.length ? `, +${ids.length - shown.length} more` : "");
}
function taxonomyLine() {
  try {
    const store = require(runtimeModule("store"));
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok && found.slug ? found.slug : "";
    const globalIds = store.getCategories({ includeDisabled: false }).map((category) => category.id);
    const effectiveIds = new Set(store.getCategories({ project, includeDisabled: false }).map((category) => category.id));
    const projectIds = project ? store.getProjectCategories(project).rows.filter((row) => row.kind === "ADD" && effectiveIds.has(row.id)).map((row) => row.id) : [];
    const line = "taxonomy (" + globalIds.length + "): " + taxonomyIds(globalIds) + (projectIds.length ? " | project: " + taxonomyIds(projectIds) : "");
    return Buffer.byteLength(line) <= MAX_TAXONOMY_BYTES ? line : "";
  } catch (_) {
    return "";
  }
}
function withTaxonomy(context) {
  const line = taxonomyLine();
  return line ? context + "\n" + line : context;
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
function emit(context, notice) {
  const output = notice ? context + "\n" + notice : context;
  writeContext("SessionStart", withTaxonomy(output));
}
function main() {
  const data = readStdin();
  if (!data) return;
  const syncResult = provisionExecAgents();
  const lostLaunches = reconcileLostLaunches(data);
  const restartNotice = [
    syncResult && syncResult.written > 0 ? require(runtimeModule("agentsync")).RESTART_NOTICE : "",
    lostLaunches.length ? `sidequest: ${lostLaunches.join(", ")} launched but never claimed before this reload. Their native task is gone; re-dispatch and spawn them, then pulse to confirm the token claim.` : ""
  ].filter(Boolean).join("\n");
  if (nudgeOff()) return;
  const cli = 'node "${CLAUDE_PLUGIN_ROOT}/bin/sidequest.js"';
  const source = stringField(data, "source");
  if (source === "compact" || source === "resume") {
    emit(
      "=== sidequest (active — context restored) ===\nReload Sidequest. Substantive work needs a board ticket; fresh dispatch's exact token-gated executor and spawn. Every Agent launch must use that executor. Tiny lookup: Read, Glob, Grep, or WebFetch inline, two calls for one question; tracing code across files needs a spike ticket. Use mcp__plugin_sidequest_board__list with status=doing FIRST; CLI fallback: `" + cli + " list --status doing`.\nNative results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Denied/unclaimed: pulse + deny verbatim, ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Ack launch: confirm holder/token.\n",
      restartNotice
    );
    return;
  }
  emit(
    "=== sidequest (active) ===\nReload the Sidequest skill before acting. Plan multi-part requests as independently checkable ATOMIC tickets. Atomic = one change, investigation, spike, or review a single agent finishes and checks. Split for parallelism: independent tickets fan out; keep tightly coupled work together. Specs need exact anchors, contract, bounds/non-goals, dependencies/decisions, and a verify command, or the artifact/answer. One ticket owning several deliverables (CLI + wiring + tests) is a smell: use a ticketed planning investigation that pins the shared contract, then a wave fanning the pieces out. An external tracker such as Jira still uses Sidequest locally.\nExecution economy — expensive orchestrator, cheap executors:\n• Route execution DOWN: substantive investigations and changes are board tickets, then fresh `dispatch` returns exact stable executor, spawn, and token to spawn immediately. Dispatch is instant: no registration/watcher wait. Every Agent launch uses that executor. Tiny lookup: Read, Glob, Grep, or WebFetch inline, two calls for one question; tracing code across files needs a spike ticket. Any delegated work, including a quick investigation, is a spike ticket (usually `codebase-exploration`): file it, then route and dispatch. Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Never proxy-wait: no Bash/PowerShell/Monitor/cron executor/report poll or blocking TaskOutput on a proxy. Denied/unclaimed: pulse + deny reason verbatim; ONE diagnose-first retry only, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Inline: trivial one-step work. Claude passes `model: exec.model`; Codex omits it. Use `bypassPermissions`; do not use `native_agent`.\n• SHORT: categories by description, not name; ticket description is executor brief; bounce back.\n• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n• File side issues with mcp__plugin_sidequest_board__add (or the CLI fallback), then keep working. Filing never asks you to work it.\nBoard actions go through the mcp__plugin_sidequest_board__* MCP tools whenever available — reach for them FIRST; Bash+CLI is the fallback. Open the board: `" + cli + " dashboard`.",
    restartNotice
  );
}
try {
  main();
} catch (_) {
  process.exit(0);
}
