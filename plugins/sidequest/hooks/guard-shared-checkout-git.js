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

// src/hooks/guard-shared-checkout-git.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");

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

// src/hooks/guard-shared-checkout-git.ts
var MUTATING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "sparse-checkout",
  "stash",
  "switch",
  "tag",
  "update-ref",
  "worktree"
]);
function commandText(input) {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || "") : "";
}
function executorAgent(type) {
  if (!type) return false;
  try {
    return require(runtimeModule("exec-names")).classify(type).kind !== "unknown";
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}
function expectation(input, agentId, executor) {
  try {
    const store = require(runtimeModule("store"));
    return store.dispatchIsolationExpectation({
      agentId,
      executor,
      sessionId: stringField(input, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || ""
    });
  } catch (_) {
    return null;
  }
}
function canonicalPath(value) {
  try {
    return import_node_fs2.default.realpathSync.native(value);
  } catch (_) {
    return import_node_path2.default.resolve(value);
  }
}
function samePath(left, right) {
  const normalizedLeft = canonicalPath(left);
  const normalizedRight = canonicalPath(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}
function gitInvocation(command) {
  const match = /(?:^|[;&|\n]\s*)git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?([a-z-]+)/i.exec(command);
  if (!match?.[2]) return null;
  const target = match[1] ? match[1].replace(/^["']|["']$/g, "") : ".";
  return { target, subcommand: match[2].toLowerCase() };
}
function targetRoot(target, cwd) {
  const directory = import_node_path2.default.resolve(cwd || ".", target);
  try {
    return canonicalPath((0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch (_) {
    return canonicalPath(directory);
  }
}
function refusal() {
  return "sidequest: refusing a mutating git command against the shared checkout from an isolated worktree. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree.";
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const found = expectation(input, agentId, executor);
  if (!found || found.sharedTree || found.terminal || !found.projectPath) return;
  const invocation = gitInvocation(commandText(input));
  if (!invocation || !MUTATING_SUBCOMMANDS.has(invocation.subcommand)) return;
  if (samePath(targetRoot(invocation.target, stringField(input, "cwd")), found.projectPath)) {
    writeDeny("PreToolUse", refusal());
  }
}
try {
  main();
} catch (_) {
  process.exit(0);
}
