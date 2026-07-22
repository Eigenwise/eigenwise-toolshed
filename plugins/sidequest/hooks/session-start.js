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
    const priority = /* @__PURE__ */ new Set(["codebase-exploration", "debugging", "spike-investigation", "deep-research", "web-research"]);
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
function emit(context, notice) {
  const output = notice ? context + "\n" + notice : context;
  writeContext("SessionStart", withWorkforce(output));
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
      '=== sidequest (active — context restored) ===\nROLE: ORCHESTRATOR. Reload Sidequest. Substantive work needs a ticket; each Agent launch uses fresh dispatch\'s token-gated executor/spawn. Ticket + dispatch BEFORE multi-file exploration: second file is the boundary. Tiny lookup: Read, Glob, Grep, or WebFetch inline. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, stated mechanical content, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Routed direct:true needs `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Use mcp__plugin_sidequest_board__list with status=doing FIRST; CLI fallback: `' + cli + " list --status doing`.\nNative results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. one background timer, never foreground sleep loop.\n",
      restartNotice
    );
    return;
  }
  emit(
    '=== sidequest (active) ===\nREQUIRED: Substantive changes/investigations need tickets; fresh `dispatch` returns executor/spawn/token. Every Agent uses it.\nOperational requests (run/build/test app; start/stop dev server; open dashboard; answer from visible context): act inline, without the Sidequest skill, category_list, or board reads.\nROLE: you are this project\'s ORCHESTRATOR; write tickets, offload work.\nReload the Sidequest skill before board work. Plan multi-part work as independently checkable ATOMIC tickets: one change, investigation, spike, or review. Specs need anchors, contract, bounds, decisions, and verify. several deliverables on one ticket is a smell: use a ticketed planning investigation that pins the shared contract, then a wave fanning the pieces out. An external tracker such as Jira still uses Sidequest.\nExecution economy:\n• Tiny lookup: Read, Glob, Grep, or WebFetch inline. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, stated mechanical content, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Ticket + dispatch MUST precede multi-file exploration: second file is the boundary, never ten-read retrospective. Delegated work, even a quick investigation, is a spike ticket (`codebase-exploration`): file, route, dispatch. `Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness reconnaissance utilities; other delegated implementation or investigation work needs a ticketed route. Routed direct:true needs user `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Never proxy-wait: no Bash/PowerShell/Monitor/cron executor/report poll or blocking TaskOutput. Denied: pulse + deny, ONE diagnose-first retry only, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Inline: trivial; beyond it, substantive actions are BLOCKED until claim. Use `bypassPermissions`; do not use `native_agent`.\n• SHORT: category description; ticket description is executor brief; bounce back.\n• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n• File issues with mcp__plugin_sidequest_board__add, continue.\nBoard actions go through the mcp__plugin_sidequest_board__* MCP tools whenever available — reach for them FIRST; Bash+CLI is the fallback. Open the board: `' + cli + " dashboard`.",
    restartNotice
  );
}
try {
  main();
} catch (_) {
  process.exit(0);
}
