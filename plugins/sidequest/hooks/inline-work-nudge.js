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

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/session-state.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));
function sessionStateFile(prefix, sessionId) {
  const home = process.env.SIDEQUEST_HOME || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "tmp", "state", `${prefix}-${encodeURIComponent(sessionId)}.json`);
}
function readSessionState(file) {
  try {
    const parsed = JSON.parse(import_node_fs2.default.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}
function writeSessionState(file, state) {
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
  import_node_fs2.default.writeFileSync(file, JSON.stringify(state));
}

// src/hooks/inline-work-nudge.ts
var AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
function boardFor(input) {
  const store = require(runtimeModule("store"));
  const start = stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}
function shellCommand(input) {
  const toolInput = input.tool_input;
  return isRecord(toolInput) && typeof toolInput.command === "string" ? toolInput.command.trim() : "";
}
function isBoardInteraction(toolName, command) {
  if (toolName.startsWith("mcp__plugin_sidequest_board__")) return true;
  if (toolName !== "Bash" || !command) return false;
  return /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}
function isPureRead(command) {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where)\b)/i.test(part));
}
function isSubstantive(toolName, command) {
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") return true;
  return toolName === "Bash" && Boolean(command) && !isPureRead(command);
}
function isReadClass(toolName, command) {
  return toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "Bash" && Boolean(command) && isPureRead(command);
}
function main() {
  const input = readStdin();
  if (!input || isSubagent(input)) return;
  const id = stringField(input, "session_id", "sessionId").trim();
  const toolName = stringField(input, "tool_name", "toolName");
  const command = shellCommand(input);
  const prompt = stringField(input, "prompt").trim();
  if (!id || !toolName || AUTOMATION_TAG.test(prompt) || !boardFor(input)) return;
  const file = sessionStateFile("inline-work", id);
  const state = readSessionState(file);
  if (isBoardInteraction(toolName, command)) {
    state.boardInteraction = true;
  } else if (isSubstantive(toolName, command)) {
    state.substantiveActions = (Number(state.substantiveActions) || 0) + 1;
  } else if (isReadClass(toolName, command)) {
    state.readActions = (Number(state.readActions) || 0) + 1;
  }
  writeSessionState(file, state);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
