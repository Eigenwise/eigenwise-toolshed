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

// src/hooks/guard-home-delete.ts
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

// src/hooks/guard-home-delete.ts
function hasRecursiveDelete(command) {
  const deletes = /(?:^|[;&|{}()\n])\s*(?:[\w.-]+\s+)*(?:remove-item|rm|rmdir|rd|ri|del|erase)\b/i;
  const recursive = /(?:--recursive\b|-[a-z]*r[a-z]*\b|-recurse\b|\/s\b)/i;
  return deletes.test(command) && recursive.test(command);
}
function normalizePath(value) {
  return value.toLowerCase().replace(/[\\/]+$/, "");
}
function isProtectedPath(command) {
  if (/\$home\b|\$env:userprofile\b|%userprofile%|(?<!\w)~(?=[\\/\s"']|$)/i.test(command)) return true;
  const home = import_node_path.default.resolve(import_node_os.default.homedir());
  const protectedRoots = [home, import_node_path.default.join(home, ".claude"), import_node_path.default.dirname(home), import_node_path.default.parse(home).root].map(normalizePath);
  return command.replace(/["']/g, "").split(/\s+/).filter((target) => target !== "\\" && import_node_path.default.isAbsolute(target)).map((target) => normalizePath(import_node_path.default.resolve(target))).some((target) => protectedRoots.some((root) => root === target || root.startsWith(`${target}${import_node_path.default.sep}`)));
}
function main() {
  const input = readStdin();
  if (!input || !["Bash", "PowerShell"].includes(stringField(input, "tool_name"))) return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? String(toolInput.command || "") : "";
  if (!hasRecursiveDelete(command) || !isProtectedPath(command)) return;
  writeDeny("PreToolUse", "sidequest: blocked a recursive delete aimed at the user profile or .claude root. Use a specific project or scratchpad path instead.");
}
try {
  main();
} catch (_) {
  process.exit(0);
}
