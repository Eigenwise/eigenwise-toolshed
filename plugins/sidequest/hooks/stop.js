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

// src/hooks/board-reconciliation-reminder.ts
var import_node_crypto2 = __toESM(require("node:crypto"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

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
function isSubagent(input) {
  return ["agent_id", "agentId", "agent_type", "agentType"].some((name) => {
    const identity = String(input[name] || "").trim().toLowerCase();
    return identity && identity !== "main" && identity !== "main-thread";
  });
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
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, additionalContext) } });
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

// src/hooks/board-reconciliation-reminder.ts
var MAX_MESSAGE_BYTES = 360;
var ESCALATION_STOP_THRESHOLD = 3;
function nudgeOff() {
  const value = String(process.env.SIDEQUEST_NUDGE || "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "no";
}
function pendingSubmission(ticket) {
  return Boolean(ticket.submission?.commit && !ticket.submission.integratedAt);
}
function liveDispatch(ticket, sessionId, store) {
  return ticket.dispatch?.sessionId === sessionId && !ticket.dispatch.terminalAt && !store.claimPulse(ticket)?.reclaimable;
}
function heldByLiveExecutor(ticket, store) {
  if (!ticket.claim?.by || !ticket.dispatch || ticket.dispatch.terminalAt) return false;
  return !store.claimPulse(ticket)?.reclaimable;
}
function byteCapped(message) {
  return Buffer.byteLength(message) <= MAX_MESSAGE_BYTES ? message : message.slice(0, MAX_MESSAGE_BYTES - 1).trimEnd() + "…";
}
function countLabel(count, singular, plural = singular + "s") {
  return `${count} ${count === 1 ? singular : plural}`;
}
function reminderStateFile(sessionId) {
  const home = process.env.SIDEQUEST_HOME || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  const key = import_node_crypto2.default.createHash("sha256").update(sessionId).digest("hex");
  return import_node_path2.default.join(home, "hook-state", `stop-reminder-${key}.json`);
}
function canRemind(reminder) {
  const file = reminderStateFile(reminder.sessionId);
  try {
    let prior = null;
    try {
      prior = JSON.parse(import_node_fs2.default.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
    const priorCount = prior?.state === reminder.state && Number.isInteger(prior.count) ? prior.count : 0;
    const count = Math.min(priorCount + 1, ESCALATION_STOP_THRESHOLD);
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(file), { recursive: true });
    import_node_fs2.default.writeFileSync(file, JSON.stringify({ state: reminder.state, count }));
    if (count === 1) return "initial";
    if (reminder.pendingRefs.length && count === ESCALATION_STOP_THRESHOLD && priorCount < count) return "escalated";
    return null;
  } catch (_) {
    return null;
  }
}
function acknowledgementFreeContinuation(action) {
  return `${action} Continue working without replying to this reminder; do not send an acknowledgment-only or progress reply.`;
}
function escalatedMessage(reminder) {
  const refs = reminder.pendingRefs.join(", ");
  const verb = reminder.pendingRefs.length === 1 ? "is" : "are";
  return byteCapped(`Sidequest: ${acknowledgementFreeContinuation("Integrate pending submissions now.")} ${refs} ${verb} still pending integration after ${ESCALATION_STOP_THRESHOLD} consecutive stops. If integration cannot proceed, checkpoint and hold; never release it as complete.`);
}
function reconciliationMessage(data) {
  if (nudgeOff()) return null;
  const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!sessionId) return null;
  try {
    const store = require(runtimeModule("store"));
    const start = stringField(data, "cwd") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    if (!project.ok || !project.slug) return null;
    const claimedRefs = new Set(store.sessionClaims(sessionId).map((claim) => String(claim.ref || "")).filter(Boolean));
    const touched = (ticket) => claimedRefs.has(String(ticket.ref || "")) || ticket.dispatch?.sessionId === sessionId;
    const open = store.listTickets(project.slug).filter((ticket) => ticket.status !== "done" && touched(ticket) && (!liveDispatch(ticket, sessionId, store) && !heldByLiveExecutor(ticket, store) || pendingSubmission(ticket)));
    const doing = open.filter((ticket) => ticket.status === "doing" && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const pendingRefs = submissions.map((ticket) => String(ticket.ref || "")).filter(Boolean);
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;
    const actionable = [
      doing.length ? `${countLabel(doing.length, "ticket")} in doing` : "",
      otherOpen ? `${countLabel(otherOpen, "ticket")} still open` : ""
    ].filter(Boolean);
    const waits = [
      submissions.length ? `${countLabel(submissions.length, "submission")} pending integration` : ""
    ].filter(Boolean);
    const state = [...actionable, ...waits].join(" / ");
    const closeActionable = actionable.length ? `Update or close ${actionable.length === 1 && doing.length === 1 ? "it" : "them"} before finishing.` : "Continue working on the board.";
    const action = submissions.length ? "Integrate pending submissions now." : closeActionable;
    const holdWaits = waits.length ? " If integration cannot proceed, checkpoint and hold; never release it as complete." : "";
    const signature = JSON.stringify(open.map((ticket) => ({
      ref: ticket.ref || "",
      status: ticket.status || "",
      claimBy: ticket.claim?.by || "",
      dispatchSessionId: ticket.dispatch?.sessionId || "",
      submissionCommit: ticket.submission?.commit || "",
      integratedAt: ticket.submission?.integratedAt || ""
    })).sort((left, right) => left.ref.localeCompare(right.ref)));
    return {
      sessionId,
      message: byteCapped(`Sidequest: ${acknowledgementFreeContinuation(action)} ${state}.${holdWaits}`),
      pendingRefs,
      state: signature
    };
  } catch (_) {
    return null;
  }
}
function boardReconciliationReminder(data) {
  const reminder = reconciliationMessage(data);
  const kind = reminder && canRemind(reminder);
  if (!reminder || !kind) return null;
  return kind === "escalated" ? escalatedMessage(reminder) : reminder.message;
}
function main() {
  const data = readStdin();
  if (!data || data.stop_hook_active === true) return;
  const message = boardReconciliationReminder(data);
  if (message) writeContext("Stop", message);
}
if (import_node_path2.default.basename(process.argv[1] || "") === "board-reconciliation-reminder.js") main();

// src/hooks/shared/compaction.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
var CLOSED_TICKETS_THRESHOLD = 3;
var TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
var RETRY_MULTIPLIER = 2;
function disabledValue(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}
function compactionSuggestionsEnabled() {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}
function isPrimarySession(input) {
  return !isSubagent(input);
}
function stateDirectory() {
  const home = String(process.env.SIDEQUEST_HOME || "").trim() || import_node_path3.default.join(import_node_os2.default.homedir(), ".claude", "sidequest");
  return import_node_path3.default.join(home, "compaction-suggestions");
}
function stateFile(sessionId) {
  return import_node_path3.default.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}
function transcriptBytes(transcriptPath) {
  try {
    return import_node_fs3.default.statSync(String(transcriptPath || "")).size;
  } catch (_) {
    return 0;
  }
}
function readState(sessionId, currentBytes) {
  try {
    const parsed = JSON.parse(import_node_fs3.default.readFileSync(stateFile(sessionId), "utf8"));
    if (parsed && Number.isFinite(parsed.transcriptBytes) && Number.isFinite(Date.parse(parsed.resetAt))) {
      return { ...parsed, ticketBaselineAt: parsed.ticketBaselineAt || parsed.resetAt };
    }
  } catch (_) {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return { resetAt: now, ticketBaselineAt: now, transcriptBytes: currentBytes };
}
function writeState(sessionId, state) {
  try {
    import_node_fs3.default.mkdirSync(stateDirectory(), { recursive: true });
    import_node_fs3.default.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}
function completionAt(ticket) {
  const values = [ticket?.submission?.integratedAt, ticket?.completion?.at, ticket?.updatedAt];
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}
function versionFor(ticket) {
  const text = Array.isArray(ticket?.comments) ? ticket.comments.map((comment) => String(comment?.body || "")).join("\n") : "";
  const matched = text.match(/\b(?:sidequest|release)\s+v?(\d+\.\d+\.\d+)\b/i);
  if (matched?.[1]) return `v${matched[1]}`;
  const commit = String(ticket?.submission?.commit || "").trim();
  return commit ? commit.slice(0, 10) : "closed";
}
function recentlyClosed(tickets, resetAt) {
  const since = Date.parse(resetAt);
  return tickets.filter((ticket) => ticket?.status === "done" && completionAt(ticket) >= since);
}
function closedAfter(tickets, baselineAt) {
  const since = Date.parse(baselineAt);
  return tickets.filter((ticket) => ticket?.status === "done" && completionAt(ticket) > since);
}
function activeBoardWork(tickets, liveClaimRefs) {
  return tickets.some((ticket) => {
    if (ticket?.status === "doing" && liveClaimRefs.has(ticket.ref)) return true;
    return Boolean(ticket?.dispatch && !ticket.dispatch.terminalAt);
  });
}
function projectFor(cwd) {
  try {
    const store = require(runtimeModule("store"));
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return null;
    return { slug: found.slug, path: found.meta.path };
  } catch (_) {
    return null;
  }
}
async function publishLockHeld(repoPath) {
  try {
    const publish = require(runtimeModule("publish"));
    return Boolean((await publish.publishLockStatus(repoPath)).locked);
  } catch (_) {
    return false;
  }
}
function byteLabel(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
function compactedRefs(tickets) {
  return tickets.slice(0, 5).map((ticket) => `${ticket.ref} (${versionFor(ticket)})`).join(", ") + (tickets.length > 5 ? `, +${tickets.length - 5} more` : "");
}
async function compactionSuggestion(input) {
  if (!compactionSuggestionsEnabled() || !isPrimarySession(input)) return null;
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (!sessionId) return null;
  const currentBytes = transcriptBytes(input.transcript_path || input.transcriptPath);
  const state = readState(sessionId, currentBytes);
  const project = projectFor(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  if (!project) return null;
  try {
    const store = require(runtimeModule("store"));
    const tickets = store.listTickets(project.slug);
    const liveClaimRefs = new Set(store.worktreeGcTickets().filter((ticket) => ticket.project === project.slug && ticket.claimLive && ticket.ref).map((ticket) => String(ticket.ref)));
    if (activeBoardWork(tickets, liveClaimRefs) || await publishLockHeld(project.path)) return null;
    const closed = recentlyClosed(tickets, state.resetAt);
    const newlyClosed = closedAfter(tickets, state.ticketBaselineAt);
    const growth = Math.max(0, currentBytes - state.transcriptBytes);
    const multiplier = state.suggestedAt ? RETRY_MULTIPLIER : 1;
    const enoughClosed = newlyClosed.length >= CLOSED_TICKETS_THRESHOLD * multiplier;
    const enoughTranscript = growth >= TRANSCRIPT_BYTES_THRESHOLD * multiplier;
    if (!enoughClosed && !enoughTranscript) return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    state.suggestedAt = now;
    state.ticketBaselineAt = now;
    state.transcriptBytes = currentBytes;
    if (!writeState(sessionId, state)) return null;
    const accumulated = [
      closed.length ? `Closed/shipped: ${compactedRefs(closed)}.` : "",
      growth ? `Transcript growth: ${byteLabel(growth)}.` : ""
    ].filter(Boolean).join(" ");
    return [
      "sidequest: compaction is safe at this boundary.",
      accumulated,
      "Safe to lose: completed-ticket screenshots, CI output, superseded dispatch chatter.",
      "Keep: open ticket specs, board decisions, and pending submission details. Run /compact when ready."
    ].join("\n");
  } catch (_) {
    return null;
  }
}

// src/hooks/stop.ts
async function main2() {
  const input = readStdin();
  if (!input || input.stop_hook_active === true) return;
  const [reconciliation, compaction] = await Promise.all([
    Promise.resolve(boardReconciliationReminder(input)),
    compactionSuggestion(input)
  ]);
  if (reconciliation) {
    writeContext("Stop", reconciliation);
  } else if (compaction) {
    writeSystemMessage("Stop", compaction);
  }
}
void main2().catch(() => {
});
