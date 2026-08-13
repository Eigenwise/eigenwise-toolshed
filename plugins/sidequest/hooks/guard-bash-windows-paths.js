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
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, additionalContext) } });
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

// src/hooks/shared/heredocs.ts
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

// src/hooks/guard-bash-windows-paths.ts
var WINDOWS_PATH = /^[A-Za-z]:\\[^\\\s"'`|&;(){}<>]+\\[^\s"'`|&;(){}<>]*/;
var CONTAINER_PATH_FLAG = /(?:^|[;&|(]\s*)(?:docker\s+(?:exec|run)|kubectl\s+exec)\b[^\r\n;&|]*?(?:\s(?:-w|-v)\s+|\s--(?:workdir|volume|cwd)(?:=|\s+))(?:"|')?\/(?!\/)[^\s"'`|&;(){}<>]*/im;
function containerPathIsRewritten(command) {
  return CONTAINER_PATH_FLAG.test(command);
}
function escapedNewline(command, index) {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}
function commentStart(command, index) {
  if (command[index] !== "#") return false;
  const previous = command[index - 1];
  return previous === void 0 || /[\s;&|(]/.test(previous);
}
function mangledInsideDoubleQuotes(command, token, index) {
  if (/\\\$/.test(token)) return true;
  return token.endsWith("\\") && command[index + token.length] === "\n";
}
function windowsPath(command) {
  let quote = null;
  let hereDocs = [];
  const substitutions = [];
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
    if (character === "$" && command[index + 1] === "(") {
      substitutions.push(quote);
      quote = null;
      index += 1;
      continue;
    }
    if (character === ")" && substitutions.length > 0) {
      quote = substitutions.pop() ?? null;
      continue;
    }
    if (quote === "double") {
      const token2 = command.slice(index).match(WINDOWS_PATH)?.[0];
      if (token2 && mangledInsideDoubleQuotes(command, token2, index)) return { token: token2, quoted: true };
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (commentStart(command, index)) {
      const lineEnd = command.indexOf("\n", index);
      if (lineEnd < 0) break;
      index = lineEnd - 1;
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
    const token = command.slice(index).match(WINDOWS_PATH)?.[0];
    if (token) return { token, quoted: false };
  }
  return null;
}
function main() {
  if (process.platform !== "win32") return;
  const input = readStdin();
  if (!input || stringField(input, "tool_name") !== "Bash") return;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput) ? String(toolInput.command || "") : "";
  if (containerPathIsRewritten(command)) {
    writeContext("PreToolUse", "sidequest: Git Bash rewrites this POSIX container path before Docker or kubectl sees it. Use `MSYS_NO_PATHCONV=1 docker exec -w /app contractify-docai ...` or spell the container path as `docker exec -w //app contractify-docai ...`.");
    return;
  }
  const found = windowsPath(command);
  if (!found) return;
  writeDeny("PreToolUse", found.quoted ? `sidequest: double quotes eat the backslash in this Windows path (${found.token}) - a backslash before $ or a line break is not literal there; single-quote it or write it with forward slashes (C:/Users/...).` : `sidequest: unquoted Windows path in a POSIX shell (${found.token}) - backslashes are eaten and the path collapses into a literal filename in cwd; quote the path or write it with forward slashes (C:/Users/...).`);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
