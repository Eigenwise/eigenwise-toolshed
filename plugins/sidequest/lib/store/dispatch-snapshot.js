"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomically } = require("./atomic-file.js");
const CLOSED_ROW_RETENTION_MS = 24 * 60 * 60 * 1e3;
function listOf(value) {
  return Array.isArray(value) ? value : [];
}
function liveDispatchState(ticket, state) {
  if (state.claimedAt || ticket.claim?.by) return "claimed";
  return state.boundAt ? "bound" : state.launchedAt ? "launched" : "prepared";
}
function dispatchRowState(ticket, state) {
  const closed = state.terminalAt && (state.outcome === "died" || !ticket.claim?.by);
  return closed ? state.outcome || "terminal" : liveDispatchState(ticket, state);
}
function isListed(ticket, state, rowState, now) {
  if (ticket.archived) return false;
  if (!state.terminalAt || rowState === "claimed") return true;
  return now - Date.parse(state.terminalAt) < CLOSED_ROW_RETENTION_MS;
}
function ticketCategoryId(ticket) {
  return ticket.categoryId || ticket.category?.id || (typeof ticket.category === "string" ? ticket.category : "");
}
function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}
function createDispatchSnapshot({ listTickets, projectDir, boardConfig, getCategory, routed }) {
  function executorDeniedTools(slug, ticket, readonly) {
    const config = boardConfig(slug) || {};
    const categoryId = ticketCategoryId(ticket);
    const category = categoryId && getCategory(categoryId, { project: slug }) || {};
    return [...listOf(config.deniedTools), ...listOf(category.deniedTools), ...readonly ? listOf(config.readOnlyDeniedTools) : []];
  }
  function dispatchRow(slug, ticket, now) {
    const state = ticket.dispatch;
    if (!state || typeof state !== "object") return null;
    const rowState = dispatchRowState(ticket, state);
    if (!isListed(ticket, state, rowState, now)) return null;
    const readonly = state.readonly === true;
    return {
      ref: ticket.ref,
      sessionId: textOrNull(state.sessionId),
      claimSessionId: textOrNull(ticket.claim?.sessionId),
      agentId: textOrNull(state.agentId),
      agentName: textOrNull(state.agentName),
      executor: textOrNull(state.executor),
      worktree: textOrNull(state.worktree),
      sharedTree: state.sharedTree !== false,
      readonly,
      state: rowState,
      deniedTools: executorDeniedTools(slug, ticket, readonly)
    };
  }
  function writeDispatchSnapshot(slug, now = Date.now()) {
    const dispatches = listTickets(slug).map((ticket) => dispatchRow(slug, ticket, now)).filter(Boolean);
    const target = path.join(projectDir(slug), "dispatch-snapshot.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomically(target, `${JSON.stringify({ v: 1, at: new Date(now).toISOString(), routed: routed(slug), dispatches })}
`);
  }
  return { writeDispatchSnapshot };
}
module.exports = { createDispatchSnapshot, dispatchRowState };
