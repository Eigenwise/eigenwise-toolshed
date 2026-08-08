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

// src/hooks/diagnostic-worktree-warning.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var WARNING = "sidequest: foreign agent worktrees detected; diagnostics under `.claude/worktrees/agent-*` are stale and false when their path is gone from disk, otherwise ignore them unless the live worktree belongs to a ticket you are about to integrate, where they are actionable and outweigh an executor's `verify passed` claim. Keep error-severity diagnostics in your own files actionable.";
function gitDirectory(entry) {
  try {
    if (import_node_fs2.default.statSync(entry).isDirectory()) return entry;
    const gitDir = /^gitdir:\s*(.+)$/m.exec(import_node_fs2.default.readFileSync(entry, "utf8"))?.[1];
    return gitDir ? import_node_path2.default.resolve(import_node_path2.default.dirname(entry), gitDir.trim()) : null;
  } catch (_) {
    return null;
  }
}
function checkoutLocation(start) {
  let current = import_node_path2.default.resolve(start);
  while (true) {
    const gitDir = gitDirectory(import_node_path2.default.join(current, ".git"));
    if (gitDir) {
      if (import_node_path2.default.basename(gitDir) === ".git") return { checkoutRoot: current, projectRoot: current };
      const commonGitDir = import_node_path2.default.resolve(gitDir, "..", "..");
      if (import_node_path2.default.basename(commonGitDir) === ".git") return { checkoutRoot: current, projectRoot: import_node_path2.default.dirname(commonGitDir) };
      return null;
    }
    const parent = import_node_path2.default.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function isOwnWorktree(checkoutRoot, worktreesRoot, name) {
  return import_node_path2.default.resolve(import_node_path2.default.dirname(checkoutRoot)) === import_node_path2.default.resolve(worktreesRoot) && import_node_path2.default.basename(checkoutRoot) === name;
}
function diagnosticWorktreeWarning(input) {
  const start = stringField(input, "cwd", "project_dir", "projectDir") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const location = checkoutLocation(start);
  if (!location) return "";
  const worktreesRoot = import_node_path2.default.join(location.projectRoot, ".claude", "worktrees");
  try {
    return import_node_fs2.default.readdirSync(worktreesRoot, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name.startsWith("agent-") && !isOwnWorktree(location.checkoutRoot, worktreesRoot, entry.name)
    ) ? WARNING : "";
  } catch (_) {
    return "";
  }
}

// src/hooks/subagent-start.ts
function fallbackClassify(type) {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: "read_only_codex_dispatch", effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: "read_only_claude_builtin", effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: "codex_dispatch", effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: "claude_builtin", effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: "legacy_ticket", effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: "ticket", effort: null };
  return { kind: "unknown", effort: null };
}
function classifyExecutor(type) {
  try {
    return require(runtimeModule("exec-names")).classify(type);
  } catch (_) {
    return fallbackClassify(type);
  }
}
function main() {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  const executor = stringField(data, "agent_type", "agentType", "subagent_type");
  const agentId = stringField(data, "agent_id", "agentId");
  const agentName = stringField(data, "agent_name", "agentName", "name");
  if (!sessionId || !executor || !agentId && !agentName || classifyExecutor(executor).kind === "unknown") return;
  try {
    const store = require(runtimeModule("store"));
    store.bindDispatchAgent(sessionId, executor, agentId || null, agentName || null);
  } catch (_) {
  }
  const warning = diagnosticWorktreeWarning(data);
  if (warning) writeContext("SubagentStart", warning);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
