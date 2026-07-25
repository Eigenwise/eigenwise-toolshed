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

// src/hooks/guard-destructive-git.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
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

// src/hooks/guard-destructive-git.ts
var GIT = String.raw`git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?`;
var DESTRUCTIVE = [
  { pattern: new RegExp(`${GIT}reset\\s+[^\\n;|&]*--hard`, "i"), label: "git reset --hard" },
  { pattern: new RegExp(`${GIT}clean\\s+-[a-z]*f`, "i"), label: "git clean -f" },
  { pattern: new RegExp(`${GIT}(?:checkout|restore)\\s+(?:[^\\n;|&]*\\s)?(?:--\\s+)?(?:\\.|:/)(?:\\s|$|;|&|\\|)`, "i"), label: "a whole-tree checkout/restore" },
  { pattern: new RegExp(`${GIT}(?:checkout|switch)\\s+[^\\n;|&]*(?:--force|\\s-f)\\b`, "i"), label: "a forced checkout/switch" }
];
function commandText(input) {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || "") : "";
}
function destructive(command) {
  for (const { pattern, label } of DESTRUCTIVE) if (pattern.test(command)) return label;
  return null;
}
function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}
function targetRepo(command, cwd) {
  const dashC = /git\s+-C\s+("[^"]+"|'[^']+'|\S+)/i.exec(command);
  if (dashC?.[1]) return import_node_path.default.resolve(cwd || ".", unquote(dashC[1]));
  const cd = /(?:^|[\n;&|])\s*cd\s+("[^"]+"|'[^']+'|\S+)/i.exec(command);
  if (cd?.[1]) return import_node_path.default.resolve(cwd || ".", unquote(cd[1]));
  return import_node_path.default.resolve(cwd || ".");
}
function sharedCheckout(repo) {
  try {
    return import_node_fs2.default.statSync(import_node_path.default.join(repo, ".git")).isDirectory();
  } catch (_) {
    return false;
  }
}
function dirtyPaths(repo) {
  try {
    return (0, import_node_child_process.execFileSync)("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}
function refusal(label, repo, dirty) {
  const shown = dirty.slice(0, 10).map((line) => `  ${line}`);
  if (dirty.length > shown.length) shown.push(`  … +${dirty.length - shown.length} more`);
  return [
    `sidequest: refusing ${label} — the shared checkout has ${dirty.length} uncommitted change(s) that this operation would destroy.`,
    `  repo: ${repo}`,
    ...shown,
    "Some of this may be a live executor's finished work that lost its worktree; the shared tree is not yours alone.",
    `Next step: preserve every dirty path in a named stash (for example, \`git stash push -u -m "sidequest recovery"\`), then run \`sidequest recover-shared --project "${repo}" --stash <stash@{n}> --yes\`. That exact recovery action verifies the stash before it runs \`git reset --hard && git clean -fd\`.`
  ].join("\n");
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const command = commandText(input);
  const label = destructive(command);
  if (!label) return;
  const repo = targetRepo(command, stringField(input, "cwd"));
  if (!sharedCheckout(repo)) return;
  const dirty = dirtyPaths(repo);
  if (!dirty.length) return;
  writeDeny("PreToolUse", refusal(label, repo, dirty));
}
try {
  main();
} catch (_) {
  process.exit(0);
}
