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

// src/hooks/subagent-stop.ts
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

// src/hooks/subagent-stop.ts
function fallbackClassify(type) {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: "read_only_codex_dispatch", effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: "read_only_claude_builtin", effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: "codex_dispatch", effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: "claude_builtin", effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: "legacy_ticket", effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: "ticket", effort: null };
  return { kind: "unknown", effort: null };
}
function classifyExecutor(type) {
  try {
    return require(runtimeModule("exec-names")).classify(type);
  } catch (_) {
    return fallbackClassify(type);
  }
}
function thresholdMs(effort) {
  const raw = process.env.SIDEQUEST_LONG_RUN_MIN;
  const configured = raw != null && raw.trim() !== "" ? Number(raw) : Number.NaN;
  const defaults = { low: 10, medium: 15, high: 25, xhigh: 40 };
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : defaults[String(effort || "").trim().toLowerCase()] || 15;
  return minutes * 60 * 1e3;
}
function doneComment(ticket, by) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  return comments.slice().reverse().find(
    (comment) => comment.kind === "comment" && (!by || comment.by === by) && /\b(done|shipped|commit)\b/i.test(String(comment.body || ""))
  ) || null;
}
function commitHash(comment) {
  const match = comment && String(comment.body || "").match(/\b[0-9a-f]{7,40}\b/i);
  return match ? match[0] || null : null;
}
function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
function diedVerdict(store, claim, ticket) {
  const label = ticket?.ref || claim.ref || claim.ticketId || "a ticket";
  const activityMs = ticket ? store.claimActivityMs(ticket) : Date.parse(claim.at || "");
  const quietSince = Number.isFinite(activityMs) ? new Date(activityMs).toISOString() : "unknown";
  const checkpoint = ticket?.checkpoint;
  const checkpointLabel = checkpoint?.id ? compactText(checkpoint.id, 28) : "none";
  const commit = checkpoint?.commit ? compactText(checkpoint.commit, 12) : "none";
  const holder = ticket?.claim?.by || claim.by;
  const comment = (Array.isArray(ticket?.comments) ? ticket.comments : []).slice().reverse().find((entry) => !holder || entry.by === holder);
  const commentLabel = comment?.body ? `"${compactText(comment.body, 64)}"` : "none";
  const diedAt = ticket?.dispatch?.terminalAt || (/* @__PURE__ */ new Date()).toISOString();
  const worktree = ticket?.dispatch?.worktree ? `; worktree ${ticket.dispatch.worktree}` : "";
  return `exec DIED: ${label} at ${diedAt}; board quiet since ${quietSince}; checkpoint ${checkpointLabel}; commit ${commit}; comment ${commentLabel}${worktree}. Next: recover the worktree diff, or release + fresh dispatch.`;
}
function submissionVerdict(store, ticket) {
  const submission = ticket?.submission;
  if (!submission?.commit || submission.integratedAt) return null;
  const readiness = store.submissionReadiness(submission);
  if (!readiness.ok) {
    return `exec FINISHED with PARTIAL_SUBMISSION: ${ticket.ref} has scope-gated paths (${(readiness.unscopedPaths || []).join(", ")}); do not integrate it`;
  }
  return `exec FINISHED: ${ticket.ref} READY_FOR_INTEGRATION (${submission.commit.slice(0, 12)}); run the publish transaction (references/publishing.md), then TaskStop this executor`;
}
function terminalDispatchVerdict(store, tickets) {
  for (const ticket of tickets) {
    const submissionVerdictText = submissionVerdict(store, ticket);
    if (submissionVerdictText) return submissionVerdictText;
    if (ticket?.dispatch?.terminalAt && ticket.dispatch.outcome === "released") {
      return `exec FINISHED after terminal release: ${ticket.ref}; TaskStop this executor so an owned Monitor cannot resume it`;
    }
    if (!ticket || ticket.status !== "done") continue;
    const comment = doneComment(ticket);
    if (!comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash ? " done WITHOUT commit hash" : ` done${hash ? ` (${hash})` : ""}`;
    return `exec FINISHED: ${ticket.ref}${suffix}; verify, then TaskStop this executor so it doesn't linger idle`;
  }
  return null;
}
function stopVerdict(store, claims, classification, dispatchStopped, terminalTickets) {
  for (const claim of claims) {
    if (!claim || claim.status !== "done") continue;
    const ticket = store.getTicket(claim.slug, claim.ticketId);
    const comment = ticket && doneComment(ticket, claim.by);
    if (!ticket || !comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash ? " done WITHOUT commit hash" : ` done${hash ? ` (${hash})` : ""}`;
    return `exec FINISHED: ${ticket.ref}${suffix}; verify, then TaskStop this executor so it doesn't linger idle`;
  }
  for (const claim of claims) {
    if (!claim || claim.held) continue;
    let ticket = null;
    try {
      ticket = store.getTicket(claim.slug, claim.ticketId);
    } catch (_) {
      continue;
    }
    const submissionVerdictText = ticket && submissionVerdict(store, ticket);
    if (!submissionVerdictText) continue;
    return submissionVerdictText;
  }
  const terminal = terminalDispatchVerdict(store, terminalTickets);
  if (terminal) return terminal;
  const held = claims.find((claim) => claim && claim.held && claim.status === "doing");
  if (held) {
    let ticket = null;
    try {
      ticket = store.getTicket(held.slug, held.ticketId);
    } catch (_) {
    }
    const label = held.ref || held.ticketId || "a ticket";
    if (ticket?.dispatch?.outcome === "died" && ticket.dispatch.terminalAt) return diedVerdict(store, held, ticket);
    return `exec WAITING: ${label} ended a turn while holding its claim; it may resume. Do not re-dispatch or release it without a recorded terminal Agent failure.`;
  }
  if (dispatchStopped && classification.kind !== "unknown") return "exec DIED before claiming; TaskStop it first, then fresh-dispatch and spawn the returned spec";
  return null;
}
function clearNearTurnCapCounter(agentId) {
  if (!agentId) return;
  const counter = import_node_path2.default.join(import_node_os.default.tmpdir(), "sidequest-near-turn-cap", encodeURIComponent(agentId));
  try {
    import_node_fs2.default.unlinkSync(counter);
  } catch (_) {
  }
}
function main() {
  const data = readStdin();
  if (!data) return;
  const agentId = stringField(data, "agent_id", "agentId");
  const agentName = stringField(data, "agent_name", "agentName", "name");
  clearNearTurnCapCounter(agentId);
  const agentType = stringField(data, "agent_type", "agentType");
  const classification = classifyExecutor(agentType);
  if (agentType && classification.kind === "unknown" || !agentId && !agentName) return;
  const sessionId = stringField(data, "session_id", "sessionId") || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (!sessionId) return;
  let store;
  try {
    store = require(runtimeModule("store"));
  } catch (_) {
    return;
  }
  let claims;
  try {
    claims = store.sessionClaims(sessionId, {
      agentId: agentId || null,
      agentName: agentName || null,
      executor: agentType || null
    });
  } catch (_) {
    return;
  }
  if (!Array.isArray(claims)) return;
  if (data.stop_hook_active) return;
  let dispatchStopped = false;
  let terminalTickets = [];
  try {
    const result = store.markDispatchStopped(sessionId, agentType, agentId || null, agentName || null);
    dispatchStopped = Boolean(result.ok && result.stopped !== false);
    terminalTickets = Array.isArray(result.tickets) ? result.tickets : [];
  } catch (_) {
  }
  let verdict;
  try {
    verdict = stopVerdict(store, claims, classification, dispatchStopped, terminalTickets);
  } catch (_) {
    return;
  }
  if (verdict) {
    writeContext("SubagentStop", verdict);
    return;
  }
  if (!claims.length) return;
  const now = Date.now();
  let worst = null;
  for (const claim of claims) {
    if (!claim || !claim.held || claim.status === "done") continue;
    const started = claim.at ? Date.parse(claim.at) : Number.NaN;
    if (!Number.isFinite(started)) continue;
    let ticket = null;
    if (!claim.effort) {
      try {
        ticket = store.getTicket(claim.slug, claim.ticketId);
      } catch (_) {
      }
    }
    const cutoff = thresholdMs(claim.effort || ticket?.effort);
    const elapsed = now - started;
    if (elapsed <= cutoff) continue;
    if (!worst || elapsed > worst.elapsed) {
      worst = { elapsed, cutoff, ref: claim.ref, ticketId: claim.ticketId, slug: claim.slug, at: claim.at };
    }
  }
  if (!worst || !store.markLongRunFlagged(sessionId, worst.slug, worst.ticketId, worst.at)) return;
  const minutes = Math.max(1, Math.round(worst.elapsed / 6e4));
  const label = worst.ref || worst.ticketId || "a claimed ticket";
  const budgetMinutes = Math.round(worst.cutoff / 6e4);
  writeContext(
    "SubagentStop",
    `⚠️ sidequest: the executor for ${label} held its claim ~${minutes}m (over the ${budgetMinutes}m long-run mark). Was that ticket really atomic, or should it have been split? Check its diff/report before trusting the result.`
  );
}
try {
  main();
} catch (_) {
  process.exit(0);
}
