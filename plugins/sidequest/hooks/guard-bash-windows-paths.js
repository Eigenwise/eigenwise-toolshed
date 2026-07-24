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
function hereDocAt(command, index) {
  let cursor = index + 2;
  const stripTabs = command[cursor] === "-";
  if (stripTabs) cursor += 1;
  while (command[cursor] === " " || command[cursor] === "	") cursor += 1;
  const quote = command[cursor];
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    return { hereDoc: { delimiter: command.slice(cursor + 1, end), stripTabs }, end: end + 1 };
  }
  const match = command.slice(cursor).match(/^[^\s|&;()<>]+/);
  if (!match) return null;
  return { hereDoc: { delimiter: match[0], stripTabs }, end: cursor + match[0].length };
}
function skipHereDocBodies(command, index, hereDocs) {
  let cursor = index;
  for (const { delimiter, stripTabs } of hereDocs) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf("\n", cursor);
      const end = lineEnd < 0 ? command.length : lineEnd;
      let line = command.slice(cursor, end).replace(/\r$/, "");
      if (stripTabs) line = line.replace(/^\t+/, "");
      cursor = lineEnd < 0 ? command.length : lineEnd + 1;
      if (line === delimiter) break;
    }
  }
  return cursor;
}
function escapedNewline(command, index) {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}
function unquotedWindowsPath(command) {
  let quote = null;
  let hereDocs = [];
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "\n" && hereDocs.length > 0 && !escapedNewline(command, index)) {
      index = skipHereDocBodies(command, index + 1, hereDocs) - 1;
      hereDocs = [];
      continue;
    }
    if (quote === "double") {
      const token2 = command.slice(index).match(/^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/)?.[0];
      if (token2) return token2;
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
    if (character === "<" && command[index - 1] !== "<" && command[index + 1] === "<") {
      const parsed = hereDocAt(command, index);
      if (parsed) {
        hereDocs.push(parsed.hereDoc);
        index = parsed.end - 1;
        continue;
      }
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
