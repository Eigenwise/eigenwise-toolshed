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

// src/hooks/repeated-command-warn.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));

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
var import_node_crypto = __toESM(require("node:crypto"));
var CONTEXT_BUDGETS = Object.freeze({
  SessionStart: 2 * 1024,
  UserPromptSubmit: 1024,
  PreToolUse: 768,
  PreCompact: 1500,
  PostCompact: 1500,
  SubagentStart: 512,
  SubagentStop: 512,
  Stop: 512,
  PostToolUseFailure: 512,
  TeammateIdle: 512
});
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function contextBudget(hookEventName) {
  return CONTEXT_BUDGETS[hookEventName] || 512;
}
function stableWatermark(value) {
  return import_node_crypto.default.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
function truncateUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    truncated += character;
    bytes += characterBytes;
  }
  return truncated;
}
function projectedText(hookEventName, value) {
  const budget = contextBudget(hookEventName);
  if (byteLength(value) <= budget) return value;
  const watermark = stableWatermark(value);
  const omission = `
[sidequest context v1 id=${hookEventName} revision=${watermark} watermark=${watermark}; content omitted for ${budget}B budget. Retrieve current board state with mcp__plugin_sidequest_board__comments({ref:"<ticket-ref>"}).]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(omission)))}${omission}`;
}
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, additionalContext) } });
}

// src/hooks/repeated-command-warn.ts
var STATE_DIR = import_node_path.default.join(import_node_os.default.tmpdir(), "sidequest-repeated-command-warn");
var WARNING = "sidequest: you have run this exact command 3 times; if you are waiting on something, run it with run_in_background and let the completion notification wake you — polling burns ~14s and ~60k tokens per call";
function normalizedCommand(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  return stringField(toolInput, "command").trim().replace(/\s+/g, " ");
}
function readState(file) {
  try {
    const parsed = JSON.parse(import_node_fs2.default.readFileSync(file, "utf8"));
    if (!isRecord(parsed)) return null;
    const command = stringField(parsed, "command");
    const count = Number(parsed.count);
    const lastWarning = Number(parsed.lastWarning);
    if (!command || !Number.isInteger(count) || count < 1 || !Number.isInteger(lastWarning) || lastWarning < 0) return null;
    return { command, count, lastWarning };
  } catch (_) {
    return null;
  }
}
function main() {
  const input = readStdin();
  if (!input) return;
  const agentType = stringField(input, "agent_type", "agentType");
  const agentId = stringField(input, "agent_id", "agentId");
  const toolName = stringField(input, "tool_name", "toolName");
  if (!agentType.startsWith("sidequest-") || !agentId || toolName !== "Bash" && toolName !== "PowerShell") return;
  const command = normalizedCommand(input);
  if (!command) return;
  import_node_fs2.default.mkdirSync(STATE_DIR, { recursive: true });
  const file = import_node_path.default.join(STATE_DIR, encodeURIComponent(agentId));
  const previous = readState(file);
  const count = previous?.command === command ? previous.count + 1 : 1;
  const lastWarning = previous?.command === command ? previous.lastWarning : 0;
  const warn = count >= 3 && (lastWarning === 0 || count - lastWarning >= 5);
  import_node_fs2.default.writeFileSync(file, JSON.stringify({ command, count, lastWarning: warn ? count : lastWarning }));
  if (warn) writeContext("PreToolUse", WARNING);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
