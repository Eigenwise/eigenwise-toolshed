"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const db = require("./db.js");
const { migrateIfNeeded } = require("./migrate.js");
const telemetry = require("./telemetry.js");
const { createAssets } = require("./store/assets.js");
const { createNotifications } = require("./store/notifications.js");
const { createStories } = require("./store/stories.js");
const { createComments } = require("./store/comments.js");
const { createReads } = require("./store/reads.js");
const { createLocks } = require("./store/locks.js");
const { createPulse } = require("./store/pulse.js");
const { createTickets } = require("./store/tickets.js");
const { createPaths } = require("./store/paths.js");
const { createCache } = require("./store/cache.js");
const { createConfig } = require("./store/config.js");
const { createServer } = require("./store/server.js");
const { createProjects } = require("./store/projects.js");
let cacheLayer;
function sqliteDataVersion(...args) {
  return cacheLayer.sqliteDataVersion(...args);
}
function newStoreCache(...args) {
  return cacheLayer.newStoreCache(...args);
}
function residentCache(...args) {
  return cacheLayer.residentCache(...args);
}
function invalidateStoreCaches(...args) {
  return cacheLayer.invalidateStoreCaches(...args);
}
function putCachedRow(...args) {
  return cacheLayer.putCachedRow(...args);
}
function deleteCachedRow(...args) {
  return cacheLayer.deleteCachedRow(...args);
}
function cloneCached(...args) {
  return cacheLayer.cloneCached(...args);
}
function ensureDir(...args) {
  return cacheLayer.ensureDir(...args);
}
let configLayer;
function defaultProjectName(...args) {
  return configLayer.defaultProjectName(...args);
}
function normalizeAlwaysInScope(...args) {
  return configLayer.normalizeAlwaysInScope(...args);
}
function normalizeReadOnlyDeniedTools(...args) {
  return configLayer.normalizeReadOnlyDeniedTools(...args);
}
function normalizeGeneratedPairPath(...args) {
  return configLayer.normalizeGeneratedPairPath(...args);
}
function normalizeGeneratedPairs(...args) {
  return configLayer.normalizeGeneratedPairs(...args);
}
function generatedPathFor(...args) {
  return configLayer.generatedPathFor(...args);
}
function trackedGeneratedPaths(...args) {
  return configLayer.trackedGeneratedPaths(...args);
}
function defaultAlwaysInScope(...args) {
  return configLayer.defaultAlwaysInScope(...args);
}
function normalizeDeliveryMode(...args) {
  return configLayer.normalizeDeliveryMode(...args);
}
function normalizeIntegrationMode(...args) {
  return configLayer.normalizeIntegrationMode(...args);
}
function normalizeIntegrationBranch(...args) {
  return configLayer.normalizeIntegrationBranch(...args);
}
function normalizeWorktreeIsolation(...args) {
  return configLayer.normalizeWorktreeIsolation(...args);
}
function normalizeAutoApprovePluginTests(...args) {
  return configLayer.normalizeAutoApprovePluginTests(...args);
}
function normalizeWorktreeSetup(...args) {
  return configLayer.normalizeWorktreeSetup(...args);
}
function normalizeIntegrationVerifyTimeoutMs(...args) {
  return configLayer.normalizeIntegrationVerifyTimeoutMs(...args);
}
function hasOriginRemote(...args) {
  return configLayer.hasOriginRemote(...args);
}
function integrationBranchExists(...args) {
  return configLayer.integrationBranchExists(...args);
}
function integrationTarget(...args) {
  return configLayer.integrationTarget(...args);
}
function integrationTargetCommit(...args) {
  return configLayer.integrationTargetCommit(...args);
}
function normalizeBoardName(...args) {
  return configLayer.normalizeBoardName(...args);
}
function boardConfig(...args) {
  return configLayer.boardConfig(...args);
}
function setBoardConfig(...args) {
  return configLayer.setBoardConfig(...args);
}
function effectiveScope(...args) {
  return configLayer.effectiveScope(...args);
}
let projectsLayer;
function ensureProject(...args) {
  return projectsLayer.ensureProject(...args);
}
function readMeta(...args) {
  return projectsLayer.readMeta(...args);
}
function metaLockPath(...args) {
  return projectsLayer.metaLockPath(...args);
}
function withMetaLock(...args) {
  return projectsLayer.withMetaLock(...args);
}
function nextSeq(...args) {
  return projectsLayer.nextSeq(...args);
}
function nextStorySeq(...args) {
  return projectsLayer.nextStorySeq(...args);
}
function setProjectNotify(...args) {
  return projectsLayer.setProjectNotify(...args);
}
function setProjectRouting(...args) {
  return projectsLayer.setProjectRouting(...args);
}
function projectRoutingEnabled(...args) {
  return projectsLayer.projectRoutingEnabled(...args);
}
function archiveProject(...args) {
  return projectsLayer.archiveProject(...args);
}
function unarchiveProject(...args) {
  return projectsLayer.unarchiveProject(...args);
}
function deleteProjectExact(...args) {
  return projectsLayer.deleteProjectExact(...args);
}
function listProjects(...args) {
  return projectsLayer.listProjects(...args);
}
function findProject(...args) {
  return projectsLayer.findProject(...args);
}
function mergeProject(...args) {
  return projectsLayer.mergeProject(...args);
}
let dispatch;
function dispatchState(...args) {
  return dispatch.dispatchState(...args);
}
function activeDispatchRoute(...args) {
  return dispatch.activeDispatchRoute(...args);
}
function refreshPreparedDispatches(...args) {
  return dispatch.refreshPreparedDispatches(...args);
}
const AGENT_DESCRIPTION_MAX_LENGTH = 120;
const ARTIFACT_BASELINE_MAX_PATHS = 500;
const WORKTREE_SETUP_MAX_LENGTH = 1e3;
const SHARED_TREE_ARTIFACT_MARKER = "Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.";
const CONTROL_PLANE_COMPLETION = /* @__PURE__ */ Symbol("sidequest.control-plane-completion");
const DELIVERY_MODES = ["merge", "replay", "apply"];
const DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS = 10 * 60 * 1e3;
const MAX_INTEGRATION_VERIFY_TIMEOUT_MS = 60 * 60 * 1e3;
const INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES = 8 * 1024;
const EXECUTOR_ANCHORS_MAX = 4e3;
const EXECUTOR_VERIFY_MAX = 1e3;
const MANUAL_VERIFY_PREFIX = "manual:";
function descriptionField(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate == null ? "" : candidate).replace(/[\s\[\]]+/g, " ").trim();
    if (value) return value;
  }
  return "";
}
function spawnDescription(ticket, resolved) {
  const title = String(ticket && ticket.title || "Sidequest ticket").replace(/\s+/g, " ").trim();
  const model = descriptionField(resolved && resolved.runsLabel, resolved && resolved.runsModel, ticket && ticket.model) || "unrouted";
  const effort = descriptionField(ticket && ticket.effort, resolved && resolved.effort) || "unset";
  const prefix = `[model=${model} effort=${effort}] `;
  const maxTitleLength = Math.max(1, AGENT_DESCRIPTION_MAX_LENGTH - prefix.length);
  return `${prefix}${title.slice(0, maxTitleLength).trimEnd()}`.slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
}
function nextDispatchLaunchSeq(state) {
  if (!state) return 1;
  const current = Number.isInteger(state.launchSeq) && state.launchSeq > 0 ? state.launchSeq : 1;
  return state.launchedAt ? current + 1 : current;
}
const { homeRoot, projectsRoot, serverFile, normalizeForHash, slugify, mainWorktreeRoot, nearestRepoRoot, projectDir, ticketsDir, assetsDir } = createPaths({ fs, os, path, crypto });
const dbByHome = /* @__PURE__ */ new Map();
const transactionDepth = /* @__PURE__ */ new WeakMap();
cacheLayer = createCache({ database, db, fs });
const {
  acquireLock,
  busyWait,
  releaseLock,
  testClaimLockDelayMs,
  ticketLockPath,
  withTicketLock
} = createLocks({
  fs,
  path,
  ticketsDir,
  transaction
});
const { copyAsset, saveAssetData, assetPath } = createAssets({ assetsDir, ensureDir });
const {
  NOTIFICATION_KINDS,
  addNotification,
  cancelReminder,
  dismiss,
  fireDueReminders,
  getNotifyPrefs,
  getPendingReminder,
  listNotifications,
  markAllRead,
  markRead,
  pendingReminders,
  pruneRead,
  queueEventNotification,
  setNotifyPrefs,
  setReminder
} = createNotifications({
  acquireLock,
  crypto,
  getTicket,
  path,
  projectsRoot,
  readGlobal,
  readMeta,
  releaseLock,
  transaction,
  writeGlobal
});
const {
  addComment,
  createComment,
  isBlocked,
  linkTickets,
  openBlockers,
  openBlockersFromIndex,
  prepareComment,
  stripControlChars,
  stripLinksTo,
  unlinkTickets,
  upperRef
} = createComments({
  crypto,
  getTicket,
  putTicket,
  queueEventNotification,
  withTicketLock
});
function ticketStoryId(...args) {
  return coerceStoryId(...args);
}
const {
  DECLARED_FILES_MAX,
  CONTRACT_NAMES_MAX,
  LABELS_MAX,
  categoryReadOnly,
  readOnlyOverrideActive,
  dispatchReadOnly,
  createTicket,
  normalizeLabels,
  normalizeFiles,
  scopeExpansionFiles,
  scopeExpansionCommand,
  pendingScopeApprovalWarning,
  clearScopeRequestMarker,
  captureScopePauseRecovery,
  requestScope,
  denyScopeRequest,
  overlappingScopePaths,
  scopesOverlap,
  normalizeContracts,
  contractCollisionReasons,
  contractMetadata,
  normalizeAssignee,
  updateTicket,
  deleteTicket,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive
} = createTickets({
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  acquireLock,
  assetPath,
  assetsDir,
  boardConfig,
  coercePriority,
  copyAsset,
  createComment,
  database,
  deleteCachedRow,
  dispatchState,
  effectiveScope,
  execFileSync,
  fs,
  getTicket,
  listTickets,
  newTicketId,
  nextSeq,
  path,
  putTicket,
  queryTickets,
  queueEventNotification,
  releaseLock,
  requireStatus,
  saveAssetData,
  ticketLockPath,
  ticketStoryId,
  upperRef,
  stripLinksTo,
  withTicketLock
});
const {
  briefTicket,
  listPayload,
  readyPayload
} = createReads({
  contractMetadata,
  countTickets,
  database,
  db,
  openBlockers,
  openBlockersFromIndex,
  queryTickets
});
function database() {
  const root = homeRoot();
  let handle = dbByHome.get(root);
  if (!handle) {
    handle = db.openDb(root);
    migrateIfNeeded(handle, root);
    dbByHome.set(root, handle);
  }
  return handle;
}
function transaction(fn) {
  const handle = database();
  if (transactionDepth.get(handle)) return fn();
  transactionDepth.set(handle, 1);
  try {
    return db.txn(handle, fn);
  } finally {
    transactionDepth.delete(handle);
  }
}
function putProject(slug, meta) {
  putCachedRow(database(), "projects", { slug, data: meta });
}
function ticketStorageRow(slug, ticket) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === "object") stored.category = stored.categoryId || stored.category.id;
  delete stored.categoryId;
  delete stored.warnings;
  delete stored.exec;
  delete stored.model;
  delete stored.effort;
  return {
    id: stored.id,
    project: slug,
    ref: stored.ref || null,
    status: stored.status || null,
    archived: stored.archived ? 1 : 0,
    ord: Number(stored.order) || 0,
    claim_by: stored.claim && stored.claim.by ? stored.claim.by : null,
    data: stored
  };
}
function putTicket(slug, ticket) {
  putCachedRow(database(), "tickets", ticketStorageRow(slug, ticket));
  const project = readMeta(slug);
  telemetry.emitTicket({ slug, path: project && project.path }, Object.assign({}, ticket));
}
function putStory(slug, story) {
  putCachedRow(database(), "stories", { id: story.id, project: slug, data: story });
}
function readGlobal(key, fallback) {
  const value = db.getRow(database(), "globals", key);
  return value == null ? fallback : value;
}
function writeGlobal(key, value) {
  putCachedRow(database(), "globals", { key, data: value });
}
function newTicketId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString("hex");
  return `tk_${t}_${r}`;
}
const VALID_STATUS = ["todo", "doing", "done"];
const VALID_PRIORITY = ["low", "normal", "high", "urgent"];
const STORY_PALETTE = ["#c2683f", "#3f8f8a", "#7a5ba8", "#7d8a3f", "#b45573", "#4a72a8", "#c19a3e", "#4f8f6a"];
const STORY_COLOR_NAMES = {
  terracotta: "#c2683f",
  teal: "#3f8f8a",
  violet: "#7a5ba8",
  olive: "#7d8a3f",
  rose: "#b45573",
  steel: "#4a72a8",
  amber: "#c19a3e",
  green: "#4f8f6a"
};
function parseStoryColor(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (STORY_COLOR_NAMES[s]) return STORY_COLOR_NAMES[s];
  if (/^#?[0-9a-f]{6}$/.test(s)) return "#" + s.replace(/^#/, "");
  if (/^#?[0-9a-f]{3}$/.test(s)) {
    const h = s.replace(/^#/, "");
    return "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return null;
}
function autoStoryColor(index) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[((index || 0) % n + n) % n];
}
configLayer = createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs, path, readMeta, MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject });
function parseTicketData(slug, data) {
  try {
    const ticket = typeof data === "string" ? JSON.parse(data) : data;
    return ticket && ticket.id ? ticket : null;
  } catch (_) {
    return null;
  }
}
function queryTickets(slug, opts = {}) {
  const statuses = opts.status == null ? [] : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
  const unfiltered = opts.archived == null && statuses.length === 0 && opts.limit == null && !opts.offset;
  const cache = residentCache();
  const cacheKey = `tickets:${slug}`;
  if (unfiltered) {
    const cached = cache.snapshots.get(cacheKey);
    if (cached) return cloneCached(cached);
  }
  const clauses = ["project = ?"];
  const parameters = [slug];
  if (opts.archived != null) {
    clauses.push("archived = ?");
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    parameters.push(...statuses);
  }
  let sql = `SELECT data FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY ord DESC`;
  if (opts.limit != null) {
    sql += " LIMIT ? OFFSET ?";
    parameters.push(Math.max(0, Math.floor(Number(opts.limit)) || 0), Math.max(0, Math.floor(Number(opts.offset)) || 0));
  }
  const tickets = db.selectRows(database(), sql, parameters).map((row) => parseTicketData(slug, row.data)).filter(Boolean);
  if (unfiltered) cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}
function countTickets(slug, opts = {}) {
  const statuses = opts.status == null ? [] : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status) => String(status).toLowerCase());
  const clauses = ["project = ?"];
  const parameters = [slug];
  if (opts.archived != null) {
    clauses.push("archived = ?");
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    parameters.push(...statuses);
  }
  const row = db.selectRow(database(), `SELECT COUNT(*) AS count FROM tickets WHERE ${clauses.join(" AND ")}`, parameters);
  return Number(row && row.count) || 0;
}
function listTickets(slug) {
  return queryTickets(String(slug || ""));
}
function countOpenTickets(slug) {
  return countTickets(String(slug || ""), { status: ["todo", "doing"], archived: false });
}
function worktreeGcProjects(currentSlug, limit = 3) {
  const projects = listProjects({ all: true }).filter((project) => project && project.slug && project.path);
  if (!projects.length || limit < 1) return [];
  const current = String(currentSlug || "");
  const focused = projects.find((project) => project.slug === current);
  const cursor = String(readGlobal("worktree-gc-project-cursor", "") || "");
  const start = Math.max(0, projects.findIndex((project) => project.slug === cursor) + 1) % projects.length;
  const ordered = Array.from({ length: projects.length }, (_, index) => projects[(start + index) % projects.length]);
  const selected = focused ? [focused, ...ordered.filter((project) => project.slug !== focused.slug)] : ordered;
  const result = selected.slice(0, Math.min(limit, projects.length));
  writeGlobal("worktree-gc-project-cursor", result[result.length - 1].slug);
  return result;
}
function listAllProjectTickets(archivedOnly = false) {
  const cache = residentCache();
  const cacheKey = `all-project-tickets:${archivedOnly ? "archived" : "active"}`;
  const cached = cache.snapshots.get(cacheKey);
  if (cached) return cloneCached(cached);
  const rows = db.selectRows(database(), `
    WITH active_projects AS (
      SELECT
        p.slug,
        p.data,
        COALESCE(MAX(json_extract(all_t.data, '$.updatedAt')), json_extract(p.data, '$.createdAt'), '') AS last_activity
      FROM projects p
      LEFT JOIN tickets all_t ON all_t.project = p.slug
      WHERE json_extract(p.data, '$.archivedAt') IS NULL
      GROUP BY p.slug, p.data
    )
    SELECT
      tickets.data,
      active_projects.slug AS project,
      COALESCE(json_extract(active_projects.data, '$.name'), active_projects.slug) AS project_name
    FROM active_projects
    JOIN tickets ON tickets.project = active_projects.slug
    WHERE tickets.archived = ?
    ORDER BY active_projects.last_activity DESC, tickets.ord DESC
  `, [archivedOnly ? 1 : 0]);
  const tickets = rows.map((row) => {
    const ticket = parseTicketData(row.project, row.data);
    return ticket ? Object.assign({}, ticket, { project: row.project, projectName: row.project_name }) : null;
  }).filter(Boolean);
  cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}
function getTicket(slug, idOrRef) {
  const wanted = String(idOrRef);
  const row = db.selectRow(
    database(),
    "SELECT data FROM tickets WHERE project = ? AND (id = ? OR upper(ref) = upper(?)) LIMIT 1",
    [String(slug || ""), wanted, wanted]
  );
  return row ? parseTicketData(String(slug || ""), row.data) : null;
}
function coerceStatus(s, fallback) {
  s = String(s || "").toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}
function requireStatus(s) {
  const status = String(s).toLowerCase();
  if (!VALID_STATUS.includes(status)) {
    throw new Error(`Invalid status "${s}". Valid statuses: ${VALID_STATUS.join(", ")}. Deletion is not a status; use the MCP remove tool or CLI rm.`);
  }
  return status;
}
function coercePriority(p, fallback) {
  p = String(p || "").toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[String(p)] ?? 9 : 9;
}
const DIRECT_REASON_MIN_LENGTH = 20;
function isRoutedTicket(ticket) {
  return Boolean(ticket && ticket.model && ticket.effort && ticket.exec);
}
function directReason(reason) {
  const value = String(reason || "").trim();
  return value.length >= DIRECT_REASON_MIN_LENGTH ? value : null;
}
const INVALID_DIRECT_REASON_PATTERNS = [
  /context already loaded/i,
  /small change/i,
  /faster (?:myself|to do (?:it )?myself)/i,
  /(?:handoff|transfer) cost/i,
  /(?:needs?|requires?) (?:investigation|other[- ]file reading)/i,
  /(?:new behavior|new API(?: surface)?)/i,
  /failing test (?:does not|doesn't) pinpoint/i
];
function directReasonAllowed(reason) {
  return !INVALID_DIRECT_REASON_PATTERNS.some((pattern) => pattern.test(String(reason || "")));
}
function nullableText(value) {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}
function oracleMarker(dispatch2, opts, at) {
  const ask = nullableText(opts && opts.oracle);
  if (!ask) return null;
  const round = Number(dispatch2 && dispatch2.launchSeq);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error("oracle release requires an active dispatched round");
  }
  return {
    round,
    at,
    candidate: nullableText(opts && opts.candidate),
    deliverable: nullableText(opts && opts.deliverable),
    ask
  };
}
function clearOracleMarker(ticket) {
  if (!ticket || !ticket.oracle) return false;
  ticket.oracle = null;
  return true;
}
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: "comment", source: opts.source || "cli" });
    if (!completionComment.ok) throw new Error(`completion comment ${completionComment.reason}`);
  }
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    const at = (/* @__PURE__ */ new Date()).toISOString();
    let comment = null;
    if (completionComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(completionComment, at);
      t.comments.push(comment);
    }
    t.status = "done";
    t.completion = { by: String(by || "agent"), at, state: "done", commentId: comment ? comment.id : null };
    t.lastEventType = "done";
    t.lastEventSource = opts.source || "cli";
    t.updatedAt = at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, {});
    return { ok: true, ticket: t, comment };
  });
}
function recordedReviewPass(ticket) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || "")));
}
function linkedReviewPass(slug, ticket) {
  if (!ticket) return false;
  return listTickets(slug).some((candidate) => (candidate.category === "review-audit" || candidate.category?.id === "review-audit" || candidate.categoryId === "review-audit") && candidate.status === "done" && Array.isArray(candidate.links) && candidate.links.some((link) => String(link?.ref || "").toUpperCase() === String(ticket.ref || "").toUpperCase()));
}
const HIGH_STAKES_REVIEW_WARNING = "high-stakes ticket integrated without a recorded review pass. Close it by recording a comment beginning `reviewed-by: <ref>` or linking a completed review-audit ticket.";
function closeTicketForGrooming(slug, idOrRef, opts) {
  opts = opts || {};
  return completeTicket(slug, idOrRef, opts.by, Object.assign({}, opts, { body: opts.reason || opts.body }));
}
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}
function assignTicket(slug, idOrRef, assignee, opts) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    t.assignee = normalizeAssignee(assignee);
    t.lastEventType = "edit";
    t.lastEventSource = opts.source ? String(opts.source) : "cli";
    t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}
const { readServerInfo, writeServerInfo, clearServerInfo } = createServer({ database, deleteCachedRow, readGlobal, writeGlobal });
const stories = createStories({
  autoStoryColor,
  crypto,
  database,
  deleteCachedRow,
  db,
  getTicket,
  listTickets,
  nextStorySeq,
  parseStoryColor,
  putStory,
  putTicket,
  transaction,
  updateTicket
});
const {
  STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  appendStoryLogEntry,
  clearStoryLog,
  coerceStoryId,
  createStory,
  deleteStory,
  getStory,
  listStories,
  normalizeStoryLogEntry,
  storyDecisionLog,
  storyDecisionLogWarnings,
  storyExecutionContract,
  storyReadPayload,
  updateStory
} = stories;
projectsLayer = createProjects({
  acquireLock,
  assetsDir,
  cloneCached,
  database,
  db,
  defaultAlwaysInScope,
  defaultProjectName,
  deleteCachedRow,
  ensureDir,
  fs,
  invalidateStoreCaches,
  listStories,
  listTickets,
  normalizeForHash,
  path,
  projectDir,
  putProject,
  putStory,
  putTicket,
  releaseLock,
  residentCache,
  slugify,
  ticketsDir,
  transaction
});
const { boundedExcerpt, changesPayload, commentHistory, pulsePayload } = createPulse({
  boardConfig,
  dispatchState,
  execFileSync,
  getTicket,
  listTickets,
  readMeta,
  storyDecisionLogWarnings
});
module.exports = {
  countOpenTickets,
  VALID_STATUS,
  VALID_PRIORITY,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  DECLARED_FILES_MAX,
  CONTRACT_NAMES_MAX,
  LABELS_MAX,
  spawnDescription,
  SHARED_TREE_ARTIFACT_MARKER,
  homeRoot,
  projectsRoot,
  serverFile,
  slugify,
  nearestRepoRoot,
  mainWorktreeRoot,
  projectDir,
  ensureProject,
  readMeta,
  boardConfig,
  setBoardConfig,
  integrationTarget,
  normalizeDeliveryMode,
  effectiveScope,
  listProjects,
  findProject,
  archiveProject,
  unarchiveProject,
  deleteProjectExact,
  mergeProject,
  setProjectNotify,
  setProjectRouting,
  projectRoutingEnabled,
  copyAsset,
  saveAssetData,
  assetPath,
  listTickets,
  worktreeGcProjects,
  listAllProjectTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  completeTicket,
  closeTicketForGrooming,
  clearOracleMarker,
  assignTicket,
  scopesOverlap,
  normalizeFiles,
  scopeExpansionFiles,
  scopeExpansionCommand,
  pendingScopeApprovalWarning,
  requestScope,
  denyScopeRequest,
  normalizeContracts,
  contractCollisionReasons,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  storyExecutionContract,
  normalizeStoryLogEntry,
  storyDecisionLog,
  storyReadPayload,
  appendStoryLogEntry,
  clearStoryLog,
  storyDecisionLogWarnings,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  addComment,
  linkTickets,
  unlinkTickets,
  openBlockers,
  isBlocked,
  briefTicket,
  listPayload,
  readyPayload,
  pulsePayload,
  changesPayload,
  boundedExcerpt,
  commentHistory,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  normalizeLabels,
  NOTIFICATION_KINDS,
  listNotifications,
  addNotification,
  markRead,
  markAllRead,
  dismiss,
  pruneRead,
  getNotifyPrefs,
  setNotifyPrefs,
  pendingReminders,
  getPendingReminder,
  setReminder,
  cancelReminder,
  fireDueReminders,
  readServerInfo,
  writeServerInfo,
  clearServerInfo
};
