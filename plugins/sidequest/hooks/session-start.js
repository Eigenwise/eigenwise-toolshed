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

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
var DEFAULT_DEADLINE_MS = 2500;
var DEFERRAL_NOTICE = "sidequest: worktree sweep exceeded its SessionStart budget and is still running in the background. Its report arrives on the next session start.";
var HANDOFF_FAILED_NOTICE = "sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.";
function deadlineMs() {
  const raw = Number(process.env.SIDEQUEST_SWEEP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEADLINE_MS;
}
function stateDirectory2() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "sweep-reports");
}
function reportFile(cwd) {
  const key = import_node_crypto.default.createHash("sha1").update(import_node_path3.default.resolve(cwd || ".")).digest("hex").slice(0, 16);
  return import_node_path3.default.join(stateDirectory2(), `${key}.json`);
}
function drainReport(cwd) {
  const file = reportFile(cwd);
  let raw;
  try {
    raw = import_node_fs3.default.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
  import_node_fs3.default.rmSync(file, { force: true });
  try {
    const parsed = JSON.parse(raw);
    const notices = parsed?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}
function sweepCwd(data) {
  return stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
async function runSweep(data) {
  const cwd = sweepCwd(data);
  const carried = drainReport(cwd) || [];
  const budget = deadlineMs();
  let child;
  try {
    child = (0, import_node_child_process.spawn)(process.execPath, [
      import_node_path3.default.join(pluginRoot(), "hooks", "sweep-worktrees.js"),
      "--cwd",
      cwd,
      "--session",
      stringField(data, "session_id", "sessionId")
    ], { detached: true, stdio: "ignore", windowsHide: true });
  } catch (_) {
    return [...carried, HANDOFF_FAILED_NOTICE];
  }
  const outcome = await new Promise((resolve) => {
    if (budget === 0) return resolve("deferred");
    const timer = setTimeout(() => resolve("deferred"), budget);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve("exited");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve("failed");
    });
  });
  if (outcome === "failed") return [...carried, HANDOFF_FAILED_NOTICE];
  if (outcome === "deferred") {
    child.unref();
    return [...carried, DEFERRAL_NOTICE];
  }
  const report = drainReport(cwd);
  return report === null ? [...carried, HANDOFF_FAILED_NOTICE] : [...carried, ...report];
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
    sweepNotices = await runSweep(data);
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
      '=== sidequest (active — context restored) ===\nROLE: ORCHESTRATOR. Reload Sidequest. Use dispatch executor/spawn verbatim. Ticket + dispatch BEFORE multi-file exploration. Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. `direct:true` needs a 20+ character inline-safe reason, not `direct-ok`; only pinpointed integration mechanical fixes, release bookkeeping, or the user-directed 1–2 named-file carve-out qualify. Work needing investigation or other-file reading, new behavior/API, or an unpinpointed failing test is never inline. "context already loaded", "small change", and "faster myself" do not; mcp__plugin_sidequest_board__list status=doing FIRST; `' + cli + " list --status=doing`; mcp__plugin_sidequest_board__* absent (not errors)? Ask USER to `/reload-plugins`.\nnever TaskOutput; pulse ref/changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. BOOKEND dispatch→submission: no unprompted reads/pulses/peeks; oracle=verify+wave suite+submit report; never re-review diffs/source.\n" + checkpointingGuidance(data),
      restartNotice
    );
    return;
  }
  emit(
    "=== sidequest (active) ===\nREQUIRED: Substantive changes/investigations need tickets; fresh `dispatch` returns executor/spawn/token. Every Agent uses it.\nOperational requests (run/build/test app; start/stop dev server; open dashboard; answer from visible context): act inline, without the Sidequest skill, category_list, or board reads.\nROLE: you are this project's ORCHESTRATOR.\n" + checkpointingGuidance(data) + '\nReload the Sidequest skill before board work. SOLO-FIT picks one-executor vs wave; it NEVER means you implement inline. Small coherent work, or work whose contract cannot be pinned without doing it: ONE ticket, ONE executor. If spec pins shared types/interfaces, file bounds, and per-piece verifies, 3+ independently checkable pieces use contract-first: pin contract, one parallel wave to category-appropriate cheaper models, integrate once. Unpinnable only after a completed planning ticket that tried and names the specific resisting interface, or with no written contract surface; “feels coupled” is not evidence. Plan first when unsure. Wave mode: pre-dispatch, file COMPLETE backlog under a story; pin its contract: all tickets, declared files, dependencies, per-ticket verify. Dispatch every dependency-ready ticket in parallel; same-file overlap in isolated worktrees needs assessment, not auto-serialization; never drip-file/dispatch/wait. Discoveries still file mid-run. Otherwise use checkable ATOMIC tickets; several deliverables are a smell. Passing done-oracle skips audit/fix unless high-stakes; full suite once/wave. An external tracker like Jira still uses Sidequest.\n• Tiny lookup: Read, Glob, Grep, or WebFetch inline, not WebSearch. WebSearch is executor-only: file and dispatch a research ticket. USER-DIRECTED TRIVIAL EDIT: 1–2 exact user-named files, no investigation: Edit inline, no ticket/dispatch. Need other-file reading? Ticket it. Ticket + dispatch MUST precede multi-file exploration. `Explore`/`claude-code-guide`/`statusline-setup`: narrow harness recon. direct:true claims need a recorded inline-safe reason, not `direct-ok`. Inline-safe is only a pinpointed integration mechanical fix, release bookkeeping, or the user-directed 1–2 named-file carve-out. Work needing investigation or other-file reading, new behavior/API, or an unpinpointed failing test is never inline. "context already loaded", "small change", and "faster myself" do not qualify. Native results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence; never proxy-wait via shell/Monitor/cron polls or blocking TaskOutput. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. BOOKEND: between dispatch and submission, no unprompted ticket reads, pulses, or worktree peeks. Integrate by oracle: verify + wave suite + submit report; never re-review diffs or source. substantive actions are BLOCKED until claim. Use `bypassPermissions`; never `native_agent`.\n• Batch small same-model tickets into ONE executor.\n• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\nmcp__plugin_sidequest_board__ MCP tools FIRST; CLI fallback. If those tools are absent (not errors), ask USER to run `/reload-plugins`.',
    restartNotice
  );
}
main().catch((error) => {
  console.error(`sidequest: session-start failed: ${error && error.message || error}`);
});
