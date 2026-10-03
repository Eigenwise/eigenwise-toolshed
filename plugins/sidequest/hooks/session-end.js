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

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
var DISPATCH_NAME = "sidequest-exec-dispatch";
var READ_ONLY_DISPATCH_NAME = "sidequest-exec-dispatch-readonly";
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}
function stableReadOnlyClaudeName(effort) {
  return `${READ_ONLY_CLAUDE_PREFIX}${effort}`;
}
var BUNDLED_AGENT_NAMES = /* @__PURE__ */ new Set([
  DISPATCH_NAME,
  READ_ONLY_DISPATCH_NAME,
  DIAGNOSTIC_PROBE_NAME,
  ...EFFORTS.map(stableClaudeName),
  ...EFFORTS.map(stableReadOnlyClaudeName)
]);
var PLUGIN_NAMESPACE = "sidequest:";
function canonicalExecutorName(name) {
  if (!name.startsWith(PLUGIN_NAMESPACE)) return name;
  const unqualifiedName = name.slice(PLUGIN_NAMESPACE.length);
  return BUNDLED_AGENT_NAMES.has(unqualifiedName) ? unqualifiedName : name;
}

// src/hooks/shared/input.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readStdin() {
  try {
    const raw = import_node_fs.default.readFileSync(0, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    for (const field of ["agent_type", "agentType", "subagent_type"]) {
      const executor = parsed[field];
      if (typeof executor === "string") parsed[field] = canonicalExecutorName(executor);
    }
    return parsed;
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

// src/hooks/shared/sweep-handoff.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
var HANDOFF_FAILED_NOTICE = "sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.";
function sweepCwd(data) {
  return stringField(data, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function detachSessionEndSweep(data) {
  try {
    const child = (0, import_node_child_process.spawn)(process.execPath, [
      import_node_path2.default.join(pluginRoot(), "hooks", "sweep-worktrees.js"),
      "--cwd",
      sweepCwd(data),
      "--session",
      stringField(data, "session_id", "sessionId"),
      "--mode",
      "session-end"
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// src/hooks/shared/worktree-sweep.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs3 = __toESM(require("node:fs"));
var import_promises = require("node:fs/promises");
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
var DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
function stateFile() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "worktree-sweep-sessions.json");
}
function readState() {
  try {
    return JSON.parse(import_node_fs3.default.readFileSync(stateFile(), "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState(state) {
  try {
    import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(stateFile()), { recursive: true });
    import_node_fs3.default.writeFileSync(stateFile(), JSON.stringify(state), "utf8");
  } catch (_) {
  }
}
function sessionId(data) {
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function unregisterSweepSession(data) {
  const id = sessionId(data);
  if (!id) return;
  const state = readState();
  if (state.sessions) delete state.sessions[id];
  if (state.reportedOrphans) delete state.reportedOrphans[id];
  writeState(state);
}

// src/hooks/session-end.ts
function endedSessionId(data) {
  if (!data) return "";
  return stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}
function endReason(data) {
  return data.reason ? `session ended (${String(data.reason)})` : "session ended";
}
function reconcileEndedSession(sessionId2, reason) {
  try {
    const store = require(runtimeModule("store"));
    store.reconcileSession(sessionId2, { reason, source: "session-end" });
    const agentsync = require(runtimeModule("agentsync"));
    agentsync.cleanupNativeAgents({ sessionId: sessionId2 });
    return [];
  } catch (error) {
    return [`sidequest: session-end reconciliation failed: ${error && error.message || error}`];
  }
}
async function main() {
  const data = readStdin();
  const sessionId2 = endedSessionId(data);
  if (!data || !sessionId2) return;
  const notices = reconcileEndedSession(sessionId2, endReason(data));
  if (!detachSessionEndSweep(data)) {
    unregisterSweepSession(data);
    notices.push(HANDOFF_FAILED_NOTICE);
  }
  if (notices.length) console.error(notices.join("\n"));
}
main().catch((error) => {
  console.error(`sidequest: session-end failed: ${error && error.message || error}`);
});
