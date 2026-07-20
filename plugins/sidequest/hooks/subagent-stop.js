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
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
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
function stopVerdict(store, claims, classification, dispatchStopped) {
  const now = Date.now();
  for (const claim of claims) {
    if (!claim || claim.status !== "done") continue;
    const ticket = store.getTicket(claim.slug, claim.ticketId);
    const comment = ticket && doneComment(ticket, claim.by);
    if (!ticket || !comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash ? " done WITHOUT commit hash" : ` done${hash ? ` (${hash})` : ""}`;
    return `exec stopped clean: ${ticket.ref}${suffix}; verify, then TaskStop this executor so it doesn't linger idle`;
  }
  for (const claim of claims) {
    if (!claim || claim.held) continue;
    let ticket = null;
    try {
      ticket = store.getTicket(claim.slug, claim.ticketId);
    } catch (_) {
      continue;
    }
    const submission = ticket?.submission;
    if (!ticket || !submission?.commit || submission.integratedAt) continue;
    return `exec stopped clean: ${ticket.ref} READY_FOR_INTEGRATION (${submission.commit.slice(0, 12)}); run the publish transaction (references/publishing.md), then TaskStop this executor`;
  }
  const held = claims.find((claim) => claim && claim.held && claim.status === "doing");
  if (held) {
    const started = Date.parse(held.at || "");
    const minutes = Number.isFinite(started) ? Math.max(1, Math.round((now - started) / 6e4)) : 0;
    const label = held.ref || held.ticketId || "a ticket";
    return `exec stopped HOLDING ${label} claim (age ${minutes}m), likely dead: release + respawn, then TaskStop it`;
  }
  if (dispatchStopped && classification.kind !== "unknown") return "exec stopped without ever claiming, TaskStop it first, then redispatch and spawn the returned spec";
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
  if (data.stop_hook_active) return;
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
  let dispatchStopped = false;
  try {
    dispatchStopped = Boolean(store.markDispatchStopped(sessionId, agentType, agentId || null, agentName || null).ok);
  } catch (_) {
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
  let verdict;
  try {
    verdict = stopVerdict(store, claims, classification, dispatchStopped);
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
