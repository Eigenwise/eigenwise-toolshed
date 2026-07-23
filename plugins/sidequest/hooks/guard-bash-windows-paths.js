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
function writeDeny(hookEventName, permissionDecisionReason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny",
      permissionDecisionReason
    }
  });
}

// src/hooks/guard-bash-windows-paths.ts
function unquotedWindowsPath(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    const token = command.slice(index).match(/^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/)?.[0];
    if (token) return token;
  }
  return null;
}
function main() {
  if (process.platform !== "win32") return;
  const input = readStdin();
  if (!input || stringField(input, "tool_name") !== "Bash") return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? String(toolInput.command || "") : "";
  const token = unquotedWindowsPath(command);
  if (!token) return;
  writeDeny("PreToolUse", `sidequest: unquoted Windows path in a POSIX shell (${token}) - backslashes are eaten and the path collapses into a literal filename in cwd; quote the path or write it with forward slashes (C:/Users/...).`);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
