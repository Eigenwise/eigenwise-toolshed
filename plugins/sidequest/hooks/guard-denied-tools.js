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

// src/lib/exec-names.ts
var EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_PREFIX = "sidequest-exec-";
var DISPATCH_PREFIX = "sidequest-exec-dispatch-";
var READ_ONLY_CLAUDE_PREFIX = "sidequest-exec-readonly-";
var READ_ONLY_DISPATCH_PREFIX = "sidequest-exec-dispatch-readonly-";
var TICKET_PREFIX = "sidequest-sq-";
var LEGACY_TICKET_PREFIX = "sidequest-ticket-";
var DIAGNOSTIC_PROBE_NAME = "sidequest-diagnostic-probe";
function isEffort(value) {
  return typeof value === "string" && EFFORTS.includes(value);
}
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
function isReadOnlyExecutor(name) {
  const kind = classify(name).kind;
  return kind === "read_only_codex_dispatch" || kind === "read_only_claude_builtin";
}
function classify(value) {
  if (typeof value !== "string" || !value) return { kind: "unknown", effort: null };
  const name = canonicalExecutorName(value);
  if (name === READ_ONLY_DISPATCH_NAME) return { kind: "read_only_codex_dispatch", effort: null };
  if (name === DISPATCH_NAME) return { kind: "codex_dispatch", effort: null };
  if (name === DIAGNOSTIC_PROBE_NAME) return { kind: "unknown", effort: null };
  if (name.startsWith(READ_ONLY_DISPATCH_PREFIX)) {
    const effort = name.slice(READ_ONLY_DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(READ_ONLY_CLAUDE_PREFIX)) {
    const effort = name.slice(READ_ONLY_CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "read_only_claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: "codex_dispatch", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const effort = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(effort)) return { kind: "claude_builtin", effort };
    return { kind: "ticket", effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: "ticket", effort: null };
  if (name.startsWith(LEGACY_TICKET_PREFIX)) return { kind: "legacy_ticket", effort: null };
  return { kind: "unknown", effort: null };
}

// src/lib/denied-tools.ts
function toolDeniedBy(toolName, pattern) {
  return toolName === pattern || toolName.startsWith(`${pattern}__`);
}
function deniedToolMatch(toolName, patterns) {
  return patterns.find((pattern) => toolDeniedBy(toolName, pattern)) ?? null;
}

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
function isSubagent(input) {
  return ["agent_id", "agentId", "agent_type", "agentType"].some((name) => {
    const identity = String(input[name] || "").trim().toLowerCase();
    return identity && identity !== "main" && identity !== "main-thread";
  });
}

// src/hooks/shared/output.ts
var import_node_crypto = __toESM(require("node:crypto"));
var CONTEXT_BUDGETS = Object.freeze({
  SessionStart: 4 * 1024,
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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason: projectedText(hookEventName, permissionDecisionReason)
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

// src/hooks/shared/runtime-identity.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
function hookSessionId(input) {
  return stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || "";
}
function isolationExpectation(input, agentId, executor, includeSessionFallback = true, observedWorktree = "") {
  try {
    const store = require(runtimeModule("store"));
    const found = store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input), observedWorktree });
    return agentId && !includeSessionFallback && found?.matchedBy === "session" ? null : found;
  } catch (_) {
    return null;
  }
}

// src/hooks/guard-denied-tools.ts
function ticketCategoryId(ticket) {
  return ticket?.categoryId || ticket?.category?.id || "";
}
function listOf(value) {
  return Array.isArray(value) ? value : [];
}
function executorDeniedTools(store, project, ref, readOnly) {
  const config = store.boardConfig(project) || {};
  const categoryId = ticketCategoryId(store.getTicket(project, ref));
  const category = categoryId && store.getCategory(categoryId, { project }) || {};
  return [...listOf(config.deniedTools), ...listOf(category.deniedTools), ...readOnly ? listOf(config.readOnlyDeniedTools) : []];
}
function ticketDenial(input, executor, toolName) {
  const found = isolationExpectation(input, stringField(input, "agent_id", "agentId"), executor, false, stringField(input, "cwd"));
  if (!found || found.terminal) return null;
  const store = require(runtimeModule("store"));
  const pattern = deniedToolMatch(toolName, executorDeniedTools(store, found.project, found.ref, isReadOnlyExecutor(executor)));
  return pattern ? { ref: found.ref, pattern } : null;
}
function main(input) {
  const executor = stringField(input, "agent_type", "agentType");
  if (!isSubagent(input) || classify(executor).kind === "unknown") return;
  const toolName = stringField(input, "tool_name");
  const denial = ticketDenial(input, executor, toolName);
  if (denial) {
    writeDeny("PreToolUse", `sidequest: ${toolName} is denied to executors on ${denial.ref} by the board deniedTools setting (${denial.pattern}). Finish the ticket with the remaining tools; when it needs ${toolName}, comment why on the ticket and release it.`);
  }
}
try {
  const input = readStdin();
  if (input) main(input);
} catch (_) {
  process.exit(0);
}
