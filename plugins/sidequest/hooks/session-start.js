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

// src/hooks/session-start.ts
function openTicketCount() {
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(store.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    return found.ok && found.slug ? store.countOpenTickets(found.slug) : 0;
  } catch (_) {
    return 0;
  }
}
function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}
function main() {
  const data = readStdin();
  if (!data) return;
  if (isPrimarySession(data)) {
    const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
    initializeCompactionState(sessionId, data.transcript_path || data.transcriptPath);
  }
  if (nudgeOff()) return;
  const open = openTicketCount();
  writeContext("SessionStart", [
    "=== sidequest ===",
    `A tracker for this project: ${open === 1 ? "1 open ticket" : `${open} open tickets`}. \`${pluginRoot()}/bin/sidequest.js list\`, or the MCP tools.`,
    "Capture side issues the user mentions in passing as tickets, so they outlive this session. That is what the board is for.",
    "Do not pick work off the board on your own. Work a ticket when the user asks for that ticket."
  ].join("\n"));
}
main();
