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
  SessionStart: 2 * 1024,
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
function writeSystemMessage(hookEventName, systemMessage) {
  writeJson({ systemMessage: projectedText(hookEventName, systemMessage), hookSpecificOutput: { hookEventName } });
}

// src/hooks/shared/paths.ts
var import_node_path = __toESM(require("node:path"));
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || import_node_path.default.join(__dirname, "..");
}
function runtimeModule(name) {
  return import_node_path.default.join(pluginRoot(), "lib", `${name}.js`);
}

// src/hooks/quota-fallback.ts
function projectFromPrompt(prompt) {
  const matches = [...String(prompt || "").matchAll(/--project\s+"([^"]+)"|--project[=\s]+(\S+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || match[2] || null : null;
}
function tokenFromPrompt(prompt) {
  const matches = [...String(prompt || "").matchAll(/--token\s+([^\s`"']+)/g)];
  const match = matches.at(-1);
  return match ? match[1] || null : null;
}
function dispatchLaunches(prompt) {
  const text = String(prompt || "");
  const headings = [...text.matchAll(/^Ref:\s*(SQ-\d+)\s*$/gim)];
  const sectioned = headings.map((match, index) => {
    const next = headings[index + 1];
    const section = text.slice(match.index, next ? next.index : text.length);
    return { ref: (match[1] || "").toUpperCase(), token: tokenFromPrompt(section) };
  }).filter((launch) => Boolean(launch.ref && launch.token));
  if (sectioned.length) return sectioned;
  const refs = [...new Set((text.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()))];
  const tokens = [...text.matchAll(/--token\s+([^\s`"']+)/g)].map((match) => match[1] || "");
  if (refs.length === tokens.length) return refs.map((ref, index) => ({ ref, token: tokens[index] || "" }));
  return refs.length === 1 && tokens.length === 1 ? [{ ref: refs[0] || "", token: tokens[0] || "" }] : [];
}
function main() {
  const input = readStdin();
  if (!input || input.tool_name !== "Agent" || !isRecord(input.tool_input)) return;
  const toolInput = input.tool_input;
  const launches = dispatchLaunches(toolInput.prompt);
  const projectArg = projectFromPrompt(toolInput.prompt) || stringField(input, "cwd") || process.env.CLAUDE_PROJECT_DIR;
  const executor = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "";
  if (!launches.length || !projectArg || !executor) return;
  const store = require(runtimeModule("store"));
  const error = stringField(input, "error");
  const project = store.findProject(projectArg);
  if (!project.ok || !project.slug) return;
  if (store.claudeQuotaFailure(error)) {
    const recovered = [];
    for (const launch of launches) {
      const result = store.recoverDispatchQuotaFailure(project.slug, launch.ref, {
        token: launch.token,
        executor,
        sessionId: stringField(input, "session_id", "sessionId") || null,
        error,
        source: "agent-launch-failure"
      });
      if (result.ok && result.recovery) recovered.push({ ref: launch.ref, recovery: result.recovery });
    }
    if (!recovered.length) return;
    const routes = recovered.map(({ ref, recovery }) => `${ref} → ${recovery.model}·${recovery.effort}`).join(", ");
    const refs = recovered.map(({ ref }) => ref).join(", ");
    const message2 = `sidequest: Claude quota blocked ${refs} before claim. Prepared the configured fallback dispatch (${routes}) with a fresh token and kept the failed primary attempt in the dispatch ledger. Run dispatch again for each ref and spawn the returned spec. Category policy is unchanged.`;
    writeSystemMessage("PostToolUseFailure", message2);
    return;
  }
  const failed = [];
  for (const launch of launches) {
    const result = store.recordDispatchAgentFailure(project.slug, launch.ref, {
      token: launch.token,
      executor,
      sessionId: stringField(input, "session_id", "sessionId") || null,
      error,
      source: "agent-terminal-failure"
    });
    const failureShape = result.ticket?.dispatch?.failureShape;
    if (result.ok && failureShape) failed.push({ ref: launch.ref, failureShape });
  }
  if (!failed.length) return;
  const outcomes = failed.map(({ ref, failureShape }) => `${ref} (${failureShape})`).join(", ");
  const message = `sidequest: Agent terminated with an observed terminal failure for ${outcomes}. The dispatch now records died, so its claimed work can be reclaimed safely.`;
  writeSystemMessage("PostToolUseFailure", message);
}
try {
  main();
} catch (_) {
  process.exit(0);
}
