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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason
    }
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

// src/hooks/guard-task-output.ts
function sessionDispatchIds(sessionId) {
  if (!sessionId) return /* @__PURE__ */ new Set();
  try {
    const store = require(runtimeModule("store"));
    const ids = /* @__PURE__ */ new Set();
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        const dispatch = ticket.dispatch;
        if (!dispatch || dispatch.sessionId !== sessionId) continue;
        for (const value of [dispatch.agentName, dispatch.agentId]) {
          if (typeof value === "string" && value) ids.add(value);
        }
      }
    }
    return ids;
  } catch (_) {
    return /* @__PURE__ */ new Set();
  }
}
function sidequestTaskId(value, dispatchedIds) {
  if (typeof value !== "string" || !value) return false;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("sidequest-")) return true;
  if (dispatchedIds.has(value)) return true;
  return lowered.includes("sidequest") && /@session-[^\s]+/i.test(value);
}
function main() {
  const data = readStdin();
  if (!data || isSubagent(data) || data.tool_name !== "TaskOutput" || !isRecord(data.tool_input)) return;
  const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  const dispatchedIds = sessionDispatchIds(sessionId);
  if (sidequestTaskId(data.tool_input.task_id, dispatchedIds) || sidequestTaskId(data.tool_input.id, dispatchedIds)) {
    writeDeny("PreToolUse", "sidequest: native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.");
  }
}
try {
  main();
} catch (_) {
  process.exit(0);
}
