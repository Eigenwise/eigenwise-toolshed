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

// src/hooks/guard-shared-tree-commit.ts
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

// src/hooks/guard-shared-tree-commit.ts
var GIT_COMMIT = /(?:^|[;&|\n]\s*|\$\(\s*)(?:&\s*)?git\s+(?:(?:-C|-c|--config-env)\s+(?:"[^"]+"|'[^']+'|\S+)\s+)*commit\b/gi;
function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}
function quotedAt(command, index) {
  let quote = "";
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = command[cursor];
    if (character === "\\") cursor += 1;
    else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
  }
  return Boolean(quote);
}
function targetRepo(command, cwd, index) {
  const before = command.slice(0, index);
  const dashCs = Array.from(before.matchAll(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/gi));
  const dashC = dashCs.at(-1);
  if (dashC?.[1]) return import_node_path2.default.resolve(cwd, unquote(dashC[1]));
  const cds = Array.from(before.matchAll(/(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/gi));
  const cd = cds.at(-1);
  return cd?.[1] ? import_node_path2.default.resolve(cwd, unquote(cd[1])) : import_node_path2.default.resolve(cwd);
}
function repoRoot(repo) {
  try {
    return (0, import_node_child_process.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function sharedCheckout(repo) {
  try {
    return import_node_fs2.default.statSync(import_node_path2.default.join(repo, ".git")).isDirectory();
  } catch {
    return false;
  }
}
function canonicalPath(value) {
  const resolved = import_node_path2.default.resolve(value);
  try {
    return import_node_fs2.default.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = canonicalPath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
function activeClaim(input) {
  const agentId = stringField(input, "agent_id", "agentId");
  const executor = stringField(input, "agent_type", "agentType", "subagent_type");
  if (!agentId || !executor) return null;
  const store = require(runtimeModule("store"));
  return store.activeSharedTreeClaim({ agentId, executor });
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return;
  const command = String(toolInput.command || "");
  const cwd = stringField(input, "cwd") || process.cwd();
  for (const match of command.matchAll(GIT_COMMIT)) {
    if (quotedAt(command, match.index || 0)) continue;
    const repo = repoRoot(targetRepo(command, cwd, match.index || 0));
    if (!repo || !sharedCheckout(repo)) continue;
    const claim = activeClaim(input);
    if (!claim || !claim.projectPath || !samePath(claim.projectPath, repo)) continue;
    writeDeny("PreToolUse", [
      `sidequest: refusing raw git commit for ${claim.ref} in the shared checkout.`,
      "Use mcp__plugin_sidequest_board__commit so Sidequest stages and commits only the approved ticket scope.",
      "If the path needs approval first, request scope before committing."
    ].join("\n"));
    return;
  }
}
try {
  main();
} catch {
}
