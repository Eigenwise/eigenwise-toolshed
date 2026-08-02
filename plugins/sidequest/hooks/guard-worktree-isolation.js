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

// src/hooks/guard-worktree-isolation.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));

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

// src/hooks/guard-worktree-isolation.ts
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var AGENT_WORKTREE = `${import_node_path2.default.sep}.claude${import_node_path2.default.sep}worktrees${import_node_path2.default.sep}agent-`;
function targetPath(input) {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return "";
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? "" : String(value);
  return target && import_node_path2.default.isAbsolute(target) ? import_node_path2.default.resolve(target) : "";
}
function insideAgentWorktree(target) {
  return `${target}${import_node_path2.default.sep}`.includes(AGENT_WORKTREE);
}
function canonicalPath(value) {
  let candidate = import_node_path2.default.resolve(value);
  const missing = [];
  for (; ; ) {
    try {
      const real = import_node_fs2.default.realpathSync.native(candidate);
      return import_node_path2.default.join(real, ...missing.reverse());
    } catch (_) {
      const parent = import_node_path2.default.dirname(candidate);
      if (parent === candidate) return import_node_path2.default.resolve(value);
      missing.push(import_node_path2.default.basename(candidate));
      candidate = parent;
    }
  }
}
function repoRootFor(target) {
  let directory = import_node_path2.default.dirname(canonicalPath(target));
  for (; ; ) {
    const gitEntry = import_node_path2.default.join(directory, ".git");
    let stats = null;
    try {
      stats = import_node_fs2.default.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = import_node_path2.default.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function samePath(a, b) {
  const normalize = (value) => {
    const resolved = canonicalPath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
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
function refusal(found, target, repoRoot, agentId, cwd) {
  const expected = found.expectedWorktree || import_node_path2.default.join(repoRoot, ".claude", "worktrees", `agent-${agentId || "<agent id>"}`);
  return [
    `sidequest: refusing this write. ${found.ref} was dispatched with worktree isolation, but this write lands in the SHARED checkout.`,
    `  expected worktree: ${expected}`,
    `  writing to:        ${target}`,
    `  shared checkout:   ${repoRoot}${cwd && !samePath(cwd, repoRoot) ? ` (cwd ${cwd})` : ""}`,
    "You did nothing wrong: the worktree you were given is gone. The harness deletes an isolated worktree when an agent stops with it unchanged, so a pause-and-resume before your first edit lands you here silently.",
    `Do not work around this. Stop writing, tell the orchestrator "${found.ref} lost its worktree, re-dispatch it", and leave the shared tree untouched. If you already have staged work here, say so: the orchestrator commits it out of the shared tree, releases the claim, then closes with the shipped commit as evidence.`
  ].join("\n");
}
function terminalRefusal(found, target) {
  return [
    `sidequest: refusing this write. ${found.ref} already reached a terminal board state, so this executor has no legal write target.`,
    `  writing to: ${target}`,
    "Do not work around this or re-arm any Monitor. Stop owned background tasks and end this executor. Redispatch the ticket if more work is needed."
  ].join("\n");
}
function unknownRefusal(target) {
  return [
    "sidequest: refusing this shared-checkout write because this executor has no active dispatch record.",
    `  writing to: ${target}`,
    "Do not work around this. Stop any owned background tasks and end the executor. Redispatch before making more changes."
  ].join("\n");
}
function projectRefusal(found, target) {
  return [
    `sidequest: refusing this write. ${found.ref} belongs to a different project than this target.`,
    `  writing to: ${target}`,
    "Do not work around this. End the executor and redispatch the ticket for the correct project."
  ].join("\n");
}
function main() {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, "tool_name"))) return;
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executorAgent(executor)) return;
  const target = targetPath(input);
  if (!target) return;
  const found = expectation(input, agentId, executor);
  if (found?.terminal) {
    writeDeny("PreToolUse", terminalRefusal(found, target));
    return;
  }
  if (insideAgentWorktree(target)) return;
  const repo = repoRootFor(target);
  if (!repo) return;
  if (!found) {
    if (!repo.linked) writeDeny("PreToolUse", unknownRefusal(target));
    return;
  }
  if (repo.linked || found.sharedTree) return;
  if (found.projectPath && !samePath(found.projectPath, repo.root)) {
    writeDeny("PreToolUse", projectRefusal(found, target));
    return;
  }
  writeDeny("PreToolUse", refusal(found, target, repo.root, agentId, stringField(input, "cwd")));
}
try {
  main();
} catch (_) {
  process.exit(0);
}
