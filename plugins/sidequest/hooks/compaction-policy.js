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

// src/hooks/shared/compaction-policy.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

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
  const value = String(process.env.SIDEQUEST_COMPACTION_POLICY || "").trim().toLowerCase();
  if (value === "off") return "off";
  return value === "veto" ? "veto" : "pin";
}
function stateFile(sessionId) {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  return import_node_path2.default.join(home, "compaction-policy", `${encodeURIComponent(sessionId)}.json`);
}
function readCounter(sessionId) {
  try {
    const parsed = JSON.parse(import_node_fs2.default.readFileSync(stateFile(sessionId), "utf8"));
    return { blocks: Number.isInteger(parsed.blocks) && parsed.blocks > 0 ? parsed.blocks : 0 };
  } catch (_) {
    return { blocks: 0 };
  }
}
function writeCounter(sessionId, blocks) {
  if (!sessionId) return;
  try {
    const file = stateFile(sessionId);
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
    import_node_fs2.default.writeFileSync(file, JSON.stringify({ blocks }));
  } catch (error) {
    console.error(`sidequest: could not persist compaction veto counter: ${String(error)}`);
  }
}
function compactText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function ticketLine(ticket) {
  const claim = ticket?.claim || {};
  const dispatch = ticket?.dispatch || {};
  const details = claim.by ? [
    `claim ${compactText(claim.by, 100)}`,
    dispatch.executor || ticket?.dispatchExecutor ? `executor ${compactText(dispatch.executor || ticket.dispatchExecutor, 100)}` : "",
    dispatch.token || ticket?.dispatchToken ? `dispatch token ${compactText(dispatch.token || ticket.dispatchToken, 160)}` : ""
  ].filter(Boolean).join("; ") : "";
  return `- ${compactText(ticket?.ref, 40)} — ${compactText(ticket?.title, 220)}${details ? ` (${details})` : ""}`;
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
async function boardState(cwd) {
  const store = require(runtimeModule("store"));
  const found = store.findProject(store.nearestRepoRoot(cwd));
  if (!found.ok || !found.slug || !found.meta?.path) return null;
  const tickets = store.listTickets(found.slug);
  const liveRefs = new Set(store.worktreeGcTickets().filter((ticket) => ticket.project === found.slug && ticket.claimLive && ticket.ref).map((ticket) => String(ticket.ref)));
  const doing = tickets.filter((ticket) => ticket?.status === "doing");
  const fresh = doing.filter((ticket) => liveRefs.has(String(ticket.ref)));
  const publish = require(runtimeModule("publish"));
  const lock = await publish.publishLockStatus(found.meta.path);
  const storyIds = [...new Set(doing.map((ticket) => String(ticket?.storyId || "")).filter(Boolean))];
  const stories = storyIds.map((id) => store.getStory(found.slug, id)).filter(Boolean);
  const lines = [
    ...doing.map(ticketLine),
    ...lock.locked ? [`Publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || JSON.stringify(lock.holder || "held"), 260)}`] : [],
    ...stories.map((story) => `Active story: ${compactText(story.ref, 40)} — ${compactText(story.title, 220)}`)
  ];
  if (!lines.length) return null;
  const freshRefs = compactText(fresh.map((ticket) => String(ticket.ref)).join(", "), 300);
  const unsafe = [
    fresh.length ? `fresh claims: ${freshRefs}` : "",
    lock.locked ? `publish lock: ${compactText(lock.holder?.by || lock.holder?.sessionId || "held", 180)}` : ""
  ].filter(Boolean).join("; ");
  return { instruction: boundedInstruction(lines), unsafeReason: unsafe };
}
async function compactionPolicyOutput(input) {
  const mode = policy();
  if (mode === "off") return "";
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  try {
    const state = await boardState(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
    if (!state) {
      writeCounter(sessionId, 0);
      return "";
    }
    if (mode !== "veto" || !state.unsafeReason) {
      writeCounter(sessionId, 0);
      return state.instruction;
    }
    const counter = readCounter(sessionId);
    if (counter.blocks >= 3) {
      writeCounter(sessionId, 0);
      return state.instruction;
    }
    writeCounter(sessionId, counter.blocks + 1);
    return JSON.stringify({ decision: "block", reason: `sidequest compaction delayed: ${state.unsafeReason}` });
  } catch (error) {
    console.error(`sidequest: compaction policy could not read board state: ${String(error)}`);
    return "";
  }
}

// src/hooks/compaction-policy.ts
async function main() {
  const output = await compactionPolicyOutput(readStdin() || {});
  if (output) process.stdout.write(output);
}
main().catch((error) => {
  console.error(`sidequest: compaction policy failed: ${String(error)}`);
});
