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
var import_node_crypto = __toESM(require("node:crypto"));
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

// src/hooks/shared/output.ts
function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}
function writeContext(hookEventName, additionalContext) {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext } });
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
function byteCapped(message) {
  return Buffer.byteLength(message) <= MAX_MESSAGE_BYTES ? message : message.slice(0, MAX_MESSAGE_BYTES - 1).trimEnd() + "…";
}
function countLabel(count, singular, plural = singular + "s") {
  return `${count} ${count === 1 ? singular : plural}`;
}
function reminderStateFile(sessionId) {
  const home = process.env.SIDEQUEST_HOME || import_node_path2.default.join(import_node_os.default.homedir(), ".claude", "sidequest");
  const key = import_node_crypto.default.createHash("sha256").update(sessionId).digest("hex");
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
function escalatedMessage(reminder) {
  const refs = reminder.pendingRefs.join(", ");
  const verb = reminder.pendingRefs.length === 1 ? "has" : "have";
  return byteCapped(`Sidequest: ${refs} ${verb} been pending integration for ${ESCALATION_STOP_THRESHOLD} consecutive stops. Integrate or clear them before finishing.`);
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
    const open = store.listTickets(project.slug).filter((ticket) => ticket.status !== "done" && touched(ticket) && (!liveDispatch(ticket, sessionId, store) || pendingSubmission(ticket)));
    const doing = open.filter((ticket) => ticket.status === "doing" && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const pendingRefs = submissions.map((ticket) => String(ticket.ref || "")).filter(Boolean);
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;
    const state = [
      doing.length ? `${countLabel(doing.length, "ticket")} in doing` : "",
      submissions.length ? `${countLabel(submissions.length, "submission")} pending integration` : "",
      otherOpen ? `${countLabel(otherOpen, "ticket")} still open` : ""
    ].filter(Boolean).join(" / ");
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
      message: byteCapped(`Sidequest: ${state} on this board. Update or close them before finishing.`),
      pendingRefs,
      state: signature
    };
  } catch (_) {
    return null;
  }
}
function main() {
  const data = readStdin();
  if (!data || data.stop_hook_active === true) return;
  const reminder = reconciliationMessage(data);
  const kind = reminder && canRemind(reminder);
  if (reminder && kind) writeContext("Stop", kind === "escalated" ? escalatedMessage(reminder) : reminder.message);
}
main();
