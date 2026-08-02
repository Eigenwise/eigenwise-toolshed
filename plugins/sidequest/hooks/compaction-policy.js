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

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/shared/compaction-policy.ts
var MAX_INSTRUCTION_BYTES = 1500;
function policy() {
  return String(process.env.SIDEQUEST_COMPACTION_POLICY || "").trim().toLowerCase() === "off" ? "off" : "pin";
}
function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function ticketLine(ticket) {
  return `- ${compactText(ticket?.ref, 40)} — ${compactText(ticket?.title, 220)}`;
}
function boundedInstruction(lines) {
  const kept = ["Preserve verbatim in the summary:"];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > MAX_INSTRUCTION_BYTES) {
      const omitted = `… ${lines.length - (kept.length - 1)} more board entries omitted.`;
      if (Buffer.byteLength([...kept, omitted].join("\n"), "utf8") <= MAX_INSTRUCTION_BYTES) kept.push(omitted);
      break;
    }
    kept.push(line);
  }
  return kept.length > 1 ? kept.join("\n") : "";
}
function boardState(cwd) {
  const store = require(runtimeModule("store"));
  const found = store.findProject(store.nearestRepoRoot(cwd));
  if (!found.ok || !found.slug) return "";
  const doing = store.listTickets(found.slug).filter((ticket) => ticket?.status === "doing");
  return doing.length ? boundedInstruction(doing.map(ticketLine)) : "";
}
var CONTINUITY = "Do not record low context, compaction, or summarization as a decision, a stopping point, or a reason to wait for the user. Summarization is how this session continues. Record unfinished work as in-progress, never as a handoff.";
function compactionPolicyOutput(input) {
  if (input.hook_event_name !== "PreCompact" || input.trigger !== "auto") return "";
  if (policy() === "off") return "";
  let board = "";
  try {
    board = boardState(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  } catch (error) {
    console.error(`sidequest: compaction policy could not read board state: ${String(error)}`);
  }
  return board ? `${CONTINUITY}
${board}` : CONTINUITY;
}

// src/hooks/compaction-policy.ts
async function main() {
  const input = readStdin() || {};
  if (input.hook_event_name !== "PreCompact" || input.trigger !== "auto") return;
  const output = await compactionPolicyOutput(input);
  if (output) process.stdout.write(output);
}
main().catch((error) => {
  console.error(`sidequest: compaction policy failed: ${String(error)}`);
});
