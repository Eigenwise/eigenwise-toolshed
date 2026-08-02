'use strict';
/**
 * sidequest - storage layer
 *
 * One shared, dependency-free store used by the CLI, the capture hook, and the
 * dashboard server. Tickets live in a central home-directory store (not inside
 * each repo), keyed by the project's absolute path, so:
 *   - a repo never gets ticket JSON committed into it by accident, and
 *   - a single dashboard can show every project's board at once.
 *
 * Layout (root defaults to ~/.claude/sidequest, override with SIDEQUEST_HOME):
 *
 *   <root>/
 *     server.json                         # { port, pid, startedAt, url } of the live dashboard
 *     projects/
 *       <slug>/
 *         meta.json                       # { path, name, createdAt, seq }
 *         tickets/<id>.json               # one file per ticket
 *         assets/<id>/<file>              # images attached to a ticket
 *
 * <slug> is "<basename>-<8 hex of a hash of the absolute path>", so two
 * different folders that happen to share a basename never collide.
 *
 * Everything here is Node stdlib only and written to fail soft where a caller
 * (the hook) needs it to: a missing/corrupt file degrades to an empty result,
 * never a throw that could break a prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const db = require('./db.js');
const { migrateIfNeeded } = require('./migrate.js');
const telemetry = require('./telemetry.js');
const { createAssets } = require('./store/assets.js');
const { createNotifications } = require('./store/notifications.js');
const { createStories } = require('./store/stories.js');
const { createComments } = require('./store/comments.js');
const { createReads } = require('./store/reads.js');
const { createLocks } = require('./store/locks.js');
const { createPulse } = require('./store/pulse.js');
const { createTickets } = require('./store/tickets.js');
const { createPaths } = require('./store/paths.js');
const { createCache } = require('./store/cache.js');
const { createConfig } = require('./store/config.js');
const { createServer } = require('./store/server.js');
const { createProjects } = require('./store/projects.js');

let cacheLayer: any;
function sqliteDataVersion(...args: any[]) { return cacheLayer.sqliteDataVersion(...args); }
function newStoreCache(...args: any[]) { return cacheLayer.newStoreCache(...args); }
function residentCache(...args: any[]) { return cacheLayer.residentCache(...args); }
function invalidateStoreCaches(...args: any[]) { return cacheLayer.invalidateStoreCaches(...args); }
function putCachedRow(...args: any[]) { return cacheLayer.putCachedRow(...args); }
function deleteCachedRow(...args: any[]) { return cacheLayer.deleteCachedRow(...args); }
function cloneCached(...args: any[]) { return cacheLayer.cloneCached(...args); }
function ensureDir(...args: any[]) { return cacheLayer.ensureDir(...args); }

let configLayer: any;
function defaultProjectName(...args: any[]) { return configLayer.defaultProjectName(...args); }
function normalizeAlwaysInScope(...args: any[]) { return configLayer.normalizeAlwaysInScope(...args); }
function normalizeReadOnlyDeniedTools(...args: any[]) { return configLayer.normalizeReadOnlyDeniedTools(...args); }
function normalizeGeneratedPairPath(...args: any[]) { return configLayer.normalizeGeneratedPairPath(...args); }
function normalizeGeneratedPairs(...args: any[]) { return configLayer.normalizeGeneratedPairs(...args); }
function generatedPathFor(...args: any[]) { return configLayer.generatedPathFor(...args); }
function trackedGeneratedPaths(...args: any[]) { return configLayer.trackedGeneratedPaths(...args); }
function defaultAlwaysInScope(...args: any[]) { return configLayer.defaultAlwaysInScope(...args); }
function normalizeDeliveryMode(...args: any[]) { return configLayer.normalizeDeliveryMode(...args); }
function normalizeIntegrationMode(...args: any[]) { return configLayer.normalizeIntegrationMode(...args); }
function normalizeIntegrationBranch(...args: any[]) { return configLayer.normalizeIntegrationBranch(...args); }
function normalizeWorktreeIsolation(...args: any[]) { return configLayer.normalizeWorktreeIsolation(...args); }
function normalizeAutoApprovePluginTests(...args: any[]) { return configLayer.normalizeAutoApprovePluginTests(...args); }
function normalizeWorktreeSetup(...args: any[]) { return configLayer.normalizeWorktreeSetup(...args); }
function normalizeIntegrationVerifyTimeoutMs(...args: any[]) { return configLayer.normalizeIntegrationVerifyTimeoutMs(...args); }
function hasOriginRemote(...args: any[]) { return configLayer.hasOriginRemote(...args); }
function integrationBranchExists(...args: any[]) { return configLayer.integrationBranchExists(...args); }
function integrationTarget(...args: any[]) { return configLayer.integrationTarget(...args); }
function integrationTargetCommit(...args: any[]) { return configLayer.integrationTargetCommit(...args); }
function normalizeBoardName(...args: any[]) { return configLayer.normalizeBoardName(...args); }
function boardConfig(...args: any[]) { return configLayer.boardConfig(...args); }
function setBoardConfig(...args: any[]) { return configLayer.setBoardConfig(...args); }
function effectiveScope(...args: any[]) { return configLayer.effectiveScope(...args); }

let projectsLayer: any;
function ensureProject(...args: any[]) { return projectsLayer.ensureProject(...args); }
function readMeta(...args: any[]) { return projectsLayer.readMeta(...args); }
function metaLockPath(...args: any[]) { return projectsLayer.metaLockPath(...args); }
function withMetaLock(...args: any[]) { return projectsLayer.withMetaLock(...args); }
function nextSeq(...args: any[]) { return projectsLayer.nextSeq(...args); }
function nextStorySeq(...args: any[]) { return projectsLayer.nextStorySeq(...args); }
function setProjectNotify(...args: any[]) { return projectsLayer.setProjectNotify(...args); }
function setProjectRouting(...args: any[]) { return projectsLayer.setProjectRouting(...args); }
function projectRoutingEnabled(...args: any[]) { return projectsLayer.projectRoutingEnabled(...args); }
function archiveProject(...args: any[]) { return projectsLayer.archiveProject(...args); }
function unarchiveProject(...args: any[]) { return projectsLayer.unarchiveProject(...args); }
function deleteProjectExact(...args: any[]) { return projectsLayer.deleteProjectExact(...args); }
function listProjects(...args: any[]) { return projectsLayer.listProjects(...args); }
function findProject(...args: any[]) { return projectsLayer.findProject(...args); }
function mergeProject(...args: any[]) { return projectsLayer.mergeProject(...args); }


let dispatch: any;
function dispatchState(...args: any[]) { return dispatch.dispatchState(...args); }
function activeDispatchRoute(...args: any[]) { return dispatch.activeDispatchRoute(...args); }
function refreshPreparedDispatches(...args: any[]) { return dispatch.refreshPreparedDispatches(...args); }





const AGENT_DESCRIPTION_MAX_LENGTH = 120;
const ARTIFACT_BASELINE_MAX_PATHS = 500;
const WORKTREE_SETUP_MAX_LENGTH = 1000;
const SHARED_TREE_ARTIFACT_MARKER = 'Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.';
const CONTROL_PLANE_COMPLETION = Symbol('sidequest.control-plane-completion');
const DELIVERY_MODES = ['merge', 'replay', 'apply'];
const DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INTEGRATION_VERIFY_TIMEOUT_MS = 60 * 60 * 1000;
const INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES = 8 * 1024;
const EXECUTOR_ANCHORS_MAX = 4000;
const EXECUTOR_VERIFY_MAX = 1000;
const MANUAL_VERIFY_PREFIX = 'manual:';


function descriptionField(...candidates: any[]) {
  for (const candidate of candidates) {
    const value = String(candidate == null ? '' : candidate).replace(/[\s\[\]]+/g, ' ').trim();
    if (value) return value;
  }
  return '';
}

// The agent list shows this string next to the launch name, and it is the only
// place the route is visible while a run is in flight. The `[model=... effort=...]`
// prefix leads so it survives however far the list truncates the title.
function spawnDescription(ticket?: any, resolved?: any) {
  const title = String(ticket && ticket.title || 'Sidequest ticket').replace(/\s+/g, ' ').trim();
  const model = descriptionField(resolved && resolved.runsLabel, resolved && resolved.runsModel, ticket && ticket.model) || 'unrouted';
  const effort = descriptionField(ticket && ticket.effort, resolved && resolved.effort) || 'unset';
  const prefix = `[model=${model} effort=${effort}] `;
  const maxTitleLength = Math.max(1, AGENT_DESCRIPTION_MAX_LENGTH - prefix.length);
  return `${prefix}${title.slice(0, maxTitleLength).trimEnd()}`.slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
}

// The launch sequence is what keeps a redispatched name from shadowing a live
// sibling in the agent list, and it must move only when a real agent could
// already be wearing the current name. Re-preparing a dispatch that never
// launched keeps its name; a relaunch after a launched (resumed, reworked, or
// quota-recovered) attempt counts up.
function nextDispatchLaunchSeq(state?: any) {
  if (!state) return 1;
  const current = Number.isInteger(state.launchSeq) && state.launchSeq > 0 ? state.launchSeq : 1;
  return state.launchedAt ? current + 1 : current;
}

/* ------------------------------------------------------------------ *
 *  Roots and path helpers
 * ------------------------------------------------------------------ */

const { homeRoot, projectsRoot, serverFile, normalizeForHash, slugify, mainWorktreeRoot, nearestRepoRoot, projectDir, ticketsDir, assetsDir } = createPaths({ fs, os, path, crypto });

/* ------------------------------------------------------------------ *
 *  SQLite persistence
 * ------------------------------------------------------------------ */

const dbByHome = new Map<string, any>();
const transactionDepth = new WeakMap<object, number>();

cacheLayer = createCache({ database, db, fs });

const {
  acquireLock,
  busyWait,
  releaseLock,
  testClaimLockDelayMs,
  ticketLockPath,
  withTicketLock,
} = createLocks({
  fs,
  path,
  ticketsDir,
  transaction,
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
  setReminder,
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
  writeGlobal,
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
  upperRef,
} = createComments({
  crypto,
  getTicket,
  putTicket,
  queueEventNotification,
  withTicketLock,
});


function ticketStoryId(...args: any[]) {
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
  listActive,
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
  withTicketLock,
});





const {
  briefTicket,
  listPayload,
  readyPayload,
} = createReads({
  contractMetadata,
  countTickets,
  database,
  db,
  openBlockers,
  openBlockersFromIndex,
  queryTickets,
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

function transaction(fn?: any) {
  const handle = database();
  if (transactionDepth.get(handle)) return fn();
  transactionDepth.set(handle, 1);
  try {
    return db.txn(handle, fn);
  } finally {
    transactionDepth.delete(handle);
  }
}

function putProject(slug?: any, meta?: any) {
  putCachedRow(database(), 'projects', { slug, data: meta });
}

function ticketStorageRow(slug?: any, ticket?: any) {
  const stored = Object.assign({}, ticket);
  if (stored.category && typeof stored.category === 'object') stored.category = stored.categoryId || stored.category.id;
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
    data: stored,
  };
}

function putTicket(slug?: any, ticket?: any) {
  putCachedRow(database(), 'tickets', ticketStorageRow(slug, ticket));
  const project = readMeta(slug);
  telemetry.emitTicket({ slug, path: project && project.path }, Object.assign({}, ticket));
}

function putStory(slug?: any, story?: any) {
  putCachedRow(database(), 'stories', { id: story.id, project: slug, data: story });
}

function readGlobal(key?: any, fallback?: any) {
  const value = db.getRow(database(), 'globals', key);
  return value == null ? fallback : value;
}

function writeGlobal(key?: any, value?: any) {
  putCachedRow(database(), 'globals', { key, data: value });
}

/* ------------------------------------------------------------------ *
 *  Ids
 * ------------------------------------------------------------------ */

function newTicketId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `tk_${t}_${r}`;
}

/* ------------------------------------------------------------------ *
 *  Projects
 * ------------------------------------------------------------------ */

const VALID_STATUS = ['todo', 'doing', 'done'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'urgent'];

const STORY_PALETTE = ['#c2683f', '#3f8f8a', '#7a5ba8', '#7d8a3f', '#b45573', '#4a72a8', '#c19a3e', '#4f8f6a'];
const STORY_COLOR_NAMES: Record<string, string> = {
  terracotta: '#c2683f', teal: '#3f8f8a', violet: '#7a5ba8', olive: '#7d8a3f',
  rose: '#b45573', steel: '#4a72a8', amber: '#c19a3e', green: '#4f8f6a',
};

// Normalize a requested story colour to a #rrggbb string, or null if it isn't a
// hex (#rgb / #rrggbb) or a known name — callers fall back to autoStoryColor().
function parseStoryColor(input?: any) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (STORY_COLOR_NAMES[s]) return STORY_COLOR_NAMES[s];
  if (/^#?[0-9a-f]{6}$/.test(s)) return '#' + s.replace(/^#/, '');
  if (/^#?[0-9a-f]{3}$/.test(s)) {
    const h = s.replace(/^#/, '');
    return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return null;
}
function autoStoryColor(index?: any) {
  const n = STORY_PALETTE.length;
  return STORY_PALETTE[(((index || 0) % n) + n) % n];
}

configLayer = createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs,  path,  readMeta,  MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject });


/* ------------------------------------------------------------------ *
 *  Plan document (SQ-1015)
 *
 *  A ticket asset with a reserved filename, so it inherits the existing
 *  asset machinery for free: project-move copy, delete cleanup, briefing
 *  attachment listing. Replace-whole-document, one current revision, no
 *  history — supersession is what a plan needs and what a comment thread
 *  cannot do without a second full copy declaring itself the replacement.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  Tickets
 * ------------------------------------------------------------------ */

function parseTicketData(slug: string, data: unknown): any | null {
  try {
    const ticket = typeof data === 'string' ? JSON.parse(data) : data;
    return ticket && ticket.id ? ticket : null;
  } catch (_: any) {
    return null;
  }
}

function queryTickets(slug: string, opts: any = {}): any[] {
  const statuses = opts.status == null
    ? []
    : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status?: any) => String(status).toLowerCase());
  const unfiltered = opts.archived == null && statuses.length === 0 && opts.limit == null && !opts.offset;
  const cache = residentCache();
  const cacheKey = `tickets:${slug}`;
  if (unfiltered) {
    const cached = cache.snapshots.get(cacheKey);
    if (cached) return cloneCached(cached);
  }

  const clauses = ['project = ?'];
  const parameters: any[] = [slug];
  if (opts.archived != null) {
    clauses.push('archived = ?');
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    parameters.push(...statuses);
  }
  let sql = `SELECT data FROM tickets WHERE ${clauses.join(' AND ')} ORDER BY ord DESC`;
  if (opts.limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    parameters.push(Math.max(0, Math.floor(Number(opts.limit)) || 0), Math.max(0, Math.floor(Number(opts.offset)) || 0));
  }
  const tickets = db.selectRows(database(), sql, parameters)
    .map((row?: any) => parseTicketData(slug, row.data))
    .filter(Boolean);
  if (unfiltered) cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}

function countTickets(slug: string, opts: any = {}): number {
  const statuses = opts.status == null
    ? []
    : (Array.isArray(opts.status) ? opts.status : [opts.status]).map((status?: any) => String(status).toLowerCase());
  const clauses = ['project = ?'];
  const parameters: any[] = [slug];
  if (opts.archived != null) {
    clauses.push('archived = ?');
    parameters.push(opts.archived ? 1 : 0);
  }
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    parameters.push(...statuses);
  }
  const row = db.selectRow(database(), `SELECT COUNT(*) AS count FROM tickets WHERE ${clauses.join(' AND ')}`, parameters);
  return Number(row && row.count) || 0;
}

function listTickets(slug?: any) {
  return queryTickets(String(slug || ''));
}

function countOpenTickets(slug?: any): number {
  return countTickets(String(slug || ''), { status: ['todo', 'doing'], archived: false });
}

// The sweep decides whether a worktree may be deleted, so every ticket it sees
// carries the claim-liveness answer with it. A done ticket whose executor is
// still holding the claim is still working in that tree.

function worktreeGcProjects(currentSlug?: any, limit: number = 3): any[] {
  const projects = listProjects({ all: true }).filter((project?: any) => project && project.slug && project.path);
  if (!projects.length || limit < 1) return [];
  const current = String(currentSlug || '');
  const focused = projects.find((project?: any) => project.slug === current);
  const cursor = String(readGlobal('worktree-gc-project-cursor', '') || '');
  const start = Math.max(0, projects.findIndex((project?: any) => project.slug === cursor) + 1) % projects.length;
  const ordered = Array.from({ length: projects.length }, (_, index) => projects[(start + index) % projects.length]);
  const selected = focused ? [focused, ...ordered.filter((project?: any) => project.slug !== focused.slug)] : ordered;
  const result = selected.slice(0, Math.min(limit, projects.length));
  writeGlobal('worktree-gc-project-cursor', result[result.length - 1].slug);
  return result;
}

function listAllProjectTickets(archivedOnly: boolean = false): any[] {
  const cache = residentCache();
  const cacheKey = `all-project-tickets:${archivedOnly ? 'archived' : 'active'}`;
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
  const tickets = rows
    .map((row?: any) => {
      const ticket = parseTicketData(row.project, row.data);
      return ticket ? Object.assign({}, ticket, { project: row.project, projectName: row.project_name }) : null;
    })
    .filter(Boolean);
  cache.snapshots.set(cacheKey, tickets);
  return cloneCached(tickets);
}

function getTicket(slug?: any, idOrRef?: any) {
  const wanted = String(idOrRef);
  const row = db.selectRow(
    database(),
    'SELECT data FROM tickets WHERE project = ? AND (id = ? OR upper(ref) = upper(?)) LIMIT 1',
    [String(slug || ''), wanted, wanted],
  );
  return row ? parseTicketData(String(slug || ''), row.data) : null;
}

function coerceStatus(s?: any, fallback?: any) {
  s = String(s || '').toLowerCase();
  return VALID_STATUS.includes(s) ? s : fallback;
}

function requireStatus(s?: any) {
  const status = String(s).toLowerCase();
  if (!VALID_STATUS.includes(status)) {
    throw new Error(`Invalid status "${s}". Valid statuses: ${VALID_STATUS.join(', ')}. Deletion is not a status; use the MCP remove tool or CLI rm.`);
  }
  return status;
}
function coercePriority(p?: any, fallback?: any) {
  p = String(p || '').toLowerCase();
  return VALID_PRIORITY.includes(p) ? p : fallback;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function priorityRank(p?: any) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? (PRIORITY_RANK[String(p)] ?? 9) : 9;
}

// The stable session-start executor receives the briefing and token in its prompt.

// Prepare a ticket for dispatch: persist a fresh claim nonce and the stable
// executor name the claim guard requires. The briefing and token ride the spawn
// prompt, so no executor definition is written.
// Atomically claim a ticket for worker `by`. Refuses (ok:false) if the ticket is
// gone, already done, or actively claimed by someone else, unless that claim is
// stale or opts.force; on success it moves the ticket to "doing" unless opts.status is false.
const DIRECT_REASON_MIN_LENGTH = 20;

function isRoutedTicket(ticket?: any) {
  return Boolean(ticket && ticket.model && ticket.effort && ticket.exec);
}

function directReason(reason?: any) {
  const value = String(reason || '').trim();
  return value.length >= DIRECT_REASON_MIN_LENGTH ? value : null;
}

const INVALID_DIRECT_REASON_PATTERNS = [
  /context already loaded/i,
  /small change/i,
  /faster (?:myself|to do (?:it )?myself)/i,
  /(?:handoff|transfer) cost/i,
  /(?:needs?|requires?) (?:investigation|other[- ]file reading)/i,
  /(?:new behavior|new API(?: surface)?)/i,
  /failing test (?:does not|doesn't) pinpoint/i,
];

function directReasonAllowed(reason?: any) {
  return !INVALID_DIRECT_REASON_PATTERNS.some((pattern) => pattern.test(String(reason || '')));
}


function nullableText(value?: any) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function oracleMarker(dispatch?: any, opts?: any, at?: any) {
  const ask = nullableText(opts && opts.oracle);
  if (!ask) return null;
  const round = Number(dispatch && dispatch.launchSeq);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('oracle release requires an active dispatched round');
  }
  return {
    round,
    at,
    candidate: nullableText(opts && opts.candidate),
    deliverable: nullableText(opts && opts.deliverable),
    ask,
  };
}

function clearOracleMarker(ticket?: any) {
  if (!ticket || !ticket.oracle) return false;
  ticket.oracle = null;
  return true;
}

// Release a claim. Only the owner (or a stale claim) may release unless
// opts.force; opts.status optionally moves the ticket at the same time.

// Build the provenance stamp recorded when a ticket is completed — which model
// tier (or the Codex model that actually backed it) and reasoning effort worked
// it, plus who and when. Returns null when no model is supplied. A supplied model
// must be a VALID_MODELS tier OR a discovered catalog slug (a Codex-backed tier
// records the real model that ran); effort, if present, a VALID_EFFORTS level
// (null/omitted allowed — haiku has no effort). Anything else throws.

// Complete a ticket: mark it done and clear its claim. An optional { model,
// effort } (from `done --model … --effort …`) is recorded as a workedBy
// provenance stamp; invalid values throw before anything is written.
function completeTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: 'comment', source: opts.source || 'cli' });
    if (!completionComment.ok) throw new Error(`completion comment ${completionComment.reason}`);
  }
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const at = new Date().toISOString();
    let comment = null;
    if (completionComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(completionComment, at);
      t.comments.push(comment);
    }
    t.status = 'done';
    t.completion = { by: String(by || 'agent'), at, state: 'done', commentId: comment ? comment.id : null };
    t.lastEventType = 'done';
    t.lastEventSource = opts.source || 'cli';
    t.updatedAt = at;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource, {});
    return { ok: true, ticket: t, comment };
  });
}

function recordedReviewPass(ticket?: any) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment?: any) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || '')));
}

function linkedReviewPass(slug?: any, ticket?: any) {
  if (!ticket) return false;
  return listTickets(slug).some((candidate?: any) => (candidate.category === 'review-audit' || candidate.category?.id === 'review-audit' || candidate.categoryId === 'review-audit')
    && candidate.status === 'done'
    && Array.isArray(candidate.links)
    && candidate.links.some((link?: any) => String(link?.ref || '').toUpperCase() === String(ticket.ref || '').toUpperCase()));
}

const HIGH_STAKES_REVIEW_WARNING = 'high-stakes ticket integrated without a recorded review pass. Close it by recording a comment beginning `reviewed-by: <ref>` or linking a completed review-audit ticket.';


function closeTicketForGrooming(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  return completeTicket(slug, idOrRef, opts.by, Object.assign({}, opts, { body: opts.reason || opts.body }));
}

/* ------------------------------------------------------------------ *
 *  Ready-for-integration submissions (SQ-398)
 *
 *  Executors never publish. A repo-changing executor finishes at a verified
 *  LOCAL commit in its isolated worktree and submits it — commit hash, durable
 *  git ref, the verify command it ran — as a submission riding the ticket. The
 *  ticket stays "doing" with the claim released: ready-for-integration is a
 *  lifecycle of its own, distinct from done. The orchestrator's publish
 *  transaction (see skills/sidequest/references/publishing.md) integrates the
 *  submitted commits under the repo publish lock (lib/publish.js), assigns
 *  versions centrally, reverifies, pushes the configured integration branch, and only then completes the
 *  ticket — which stamps the submission integrated.
 * ------------------------------------------------------------------ */


// True when a ticket may be handed to a worker running as tier `want`: either the
// worker didn't specify a tier, or the tags match. Every ticket now carries a
// tier, so a filtered tier-X worker only gets exact-tier matches (no untagged
// pass-through).
function modelMatches(ticketModel?: any, want?: any) {
  return !want || ticketModel === want;
}

// The tickets that are ready to be worked right now: not done, not archived, not
// actively claimed, and not blocked by an unfinished ticket. This is the set to
// fan subagents out over (each still claims before working). Priority-ordered.
// opts.model restricts to that tier's work (exact-tier matches only).

// Atomically claim the best available ticket in a project: highest priority
// first, oldest-first within a priority. Skips done tickets and ones actively
// claimed by another worker. Returns { ok:true, ticket } or { reason:'empty' }.

// Assign (or, with a null/blank assignee, unassign) a ticket. Assignment is a
// persistent "who owns this" marker — unlike claimTicket it has no TTL, does not
// move the ticket to "doing", and does not gate ready/next. It's how a human
// takes a ticket for themselves (assignee "you") or an agent hands one back.
function assignTicket(slug?: any, idOrRef?: any, assignee?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.assignee = normalizeAssignee(assignee);
    t.lastEventType = 'edit';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}

/* ------------------------------------------------------------------ *
 *  Stories (a user story groups tickets and tints their cards)
 *
 *  Stored one JSON file per story under projects/<slug>/stories/, minted US-1,
 *  US-2, … from meta.storySeq — deliberately parallel to how tickets live under
 *  tickets/ with SQ-N refs. A ticket points at its story by the story's stable
 *  id (ticket.storyId), never its ref, so renumbering or ref lookups can't orphan
 *  the link. Lower-contention than tickets (created/edited rarely, one human),
 *  so these use a plain read-modify-write rather than the per-item lock tickets need.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  Comments
 *
 *  Appends happen under the ticket lock so two simultaneous comments never
 *  clobber each other.
 * ------------------------------------------------------------------ */

// Age is reported, never acted on. `reclaimable` is the verdict that actually
// governs a sweep, so a reader can tell "long-running" from "gone".

/* ------------------------------------------------------------------ *
 *  Notifications
 *
 *  A single, persistent, per-user queue (one notifications.json under
 *  projectsRoot(), a sibling to the project dirs). Unlike the old client-side
 *  toasts/badges — which were derived on the fly from ticket diffs and lost on
 *  reload — these survive a server restart, because reminders must be able to
 *  fire even when no dashboard tab is open. Appends/mutations go through a single
 *  queue lock so two writers can never clobber each other, mirroring the
 *  read-modify-write-under-lock pattern used for tickets.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  Worker registry (session -> the claims it holds)
 *
 *  The claim TTL (default 60 min) is the backstop that frees a crashed worker's
 *  ticket. But when a *session* ends cleanly, we know its claims are dead right
 *  then — no reason to make a dependent wait out the TTL. The SessionEnd hook
 *  fires on that boundary; it has the session id but a claim is tagged
 *  only with an opaque `--by`. This tiny registry is the missing link: it maps a
 *  session id to the claims taken under it, so reconcileSession() can release
 *  exactly those (and only those — never another live session's) on the spot.
 *
 *  One file, projects/workers.json, a sibling to notifications.json:
 *    { sessions: { <sessionId>: { updatedAt, claims: [{ slug, ticketId, by, at }] } } }
 *
 *  Fail-soft throughout: a missing/garbage file degrades to an empty registry,
 *  and any hiccup here must never break a claim (the TTL still covers us). The
 *  registry is an OPTIMIZATION over the TTL, not a new source of truth — nothing
 *  reads it to decide whether a claim is valid, only to speed up releasing it.
 * ------------------------------------------------------------------ */

// Sessions untouched for this long with no live claims are pruned on write, so
// the file can't grow forever from sessions that ended without a reconcile hook.
/* ------------------------------------------------------------------ *
 *  Server lockfile (used by CLI + server to find/reuse a running dashboard)
 * ------------------------------------------------------------------ */

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
  updateTicket,
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
  updateStory,
} = stories;

projectsLayer = createProjects({
  acquireLock, assetsDir, cloneCached, database, db, defaultAlwaysInScope, defaultProjectName,
  deleteCachedRow, ensureDir, fs, invalidateStoreCaches, listStories, listTickets, normalizeForHash,
  path, projectDir, putProject, putStory, putTicket, releaseLock, residentCache, slugify, ticketsDir, transaction,
});


const { boundedExcerpt, changesPayload, commentHistory, pulsePayload } = createPulse({
  boardConfig,
  dispatchState,
  execFileSync,
  getTicket,
  listTickets,
  readMeta,
  storyDecisionLogWarnings,
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
  clearServerInfo,
};
