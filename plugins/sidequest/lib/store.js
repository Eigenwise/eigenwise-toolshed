"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dispatchLaunchName, stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const db = require("./db.js");
const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, STARTER_ROUTING_PROFILES } = require("./category-defaults.js");
const commitScope = require("./commit-scope.js");
const { migrateIfNeeded } = require("./migrate.js");
const { discoverExternalModels, providerReadiness } = require("./discovery.js");
const telemetry = require("./telemetry.js");
const { routingDisabledMessage } = require("./refusal-guidance.js");
const { assertSidequestInstall, assertDispatchTransport } = require("./dispatch-preflight.js");
const { createAssets } = require("./store/assets.js");
const { createNotifications } = require("./store/notifications.js");
const { createWorkers } = require("./store/workers.js");
const { createStories } = require("./store/stories.js");
const { createComments } = require("./store/comments.js");
const { createPlans } = require("./store/plans.js");
const { createReads } = require("./store/reads.js");
const { createClaims } = require("./store/claims.js");
const { createLocks } = require("./store/locks.js");
const { createPulse } = require("./store/pulse.js");
const { createRouting } = require("./store/routing.js");
const { createTickets } = require("./store/tickets.js");
const { createSubmissions } = require("./store/submissions.js");
const { createDispatch } = require("./store/dispatch.js");
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
const {
  CLAUDE_RUNTIMES,
  CLAUDE_RUNTIME_LABELS,
  VALID_EFFORTS,
  BACKEND_SLUG_RE,
  BACKEND_KEY_RE,
  HAIKU_BACKEND_EFFORT,
  ROUTING_FALLBACK_DEFAULT,
  CLAUDE_QUOTA_FAILURES,
  coerceEffort,
  coerceComplexity,
  backendKey,
  discoveredByKey,
  discoveredBySlug,
  resolvedBackend,
  normalizeRouteModel,
  availableRoute,
  reportingModelForms,
  claudeRuntimeAlias,
  normalizeReportedModel,
  resolvedDispatchRoute,
  dispatchModelFor,
  dispatchRouteState,
  execFromBackend,
  resolveExec,
  resolveReportedExec,
  resolveModelId,
  routingModels,
  getModelVocab,
  routeDescriptor,
  modelsPayload,
  classifyModelFilter,
  legacyCategoryForComplexity,
  normalizeRoute,
  claudeQuotaFailure,
  getRoutingFallback,
  setRoutingFallback,
  routingProfileSettings,
  getRoutingProfile,
  routingProfileEntries,
  defaultRoutingProfileId,
  projectRoutingProfile,
  policyMutationProjects,
  mutateRoutingPolicy,
  projectCategoryRows,
  routingContext,
  resolvedProfileCategories,
  projectCategoryWarnings,
  getCategoryRoutePairs,
  getProjectCategories,
  getCategories,
  normalizeCategoryId,
  getCategory,
  normalizeArtifactRoots,
  requireArtifactRoots,
  normalizeCategory,
  routingProfileCategory,
  setRoutingProfileCategory,
  setCategory,
  removeRoutingProfileCategory,
  removeCategory,
  normalizeFullProjectCategory,
  setProjectCategory,
  detachCategory,
  setProjectRoutingProfile,
  setNewProjectRoutingProfile,
  listRoutingProfiles,
  normalizeRoutingProfileId,
  routingProfileDetails,
  createRoutingProfile,
  editRoutingProfile,
  retireRoutingProfile,
  canonicalRoutingValue,
  routingFingerprint,
  normalizedTaxonomy,
  canonicalLocalRows,
  localRowsFingerprint,
  routingProfileHygiene,
  hypotheticalTaxonomy,
  taxonomyDrift,
  repointRoutingProfiles,
  promoteRoutingProfile,
  removeProjectCategory,
  classifierCategories,
  routeProvider,
  routeReadyForAutomaticFallback,
  resolveCategoryRoute,
  resolveCategoryFallback,
  providerDispatchRefusal,
  dispatchRouteRefusal,
  ticketCategory,
  execProjection,
  applyDerivedRouting
} = createRouting({
  activeDispatchRoute,
  commitScope,
  crypto,
  database,
  db,
  discoverExternalModels,
  invalidateStoreCaches,
  listProjects,
  providerReadiness,
  readGlobal,
  readMeta,
  refreshPreparedDispatches,
  residentCache,
  stableClaudeName,
  stableDispatchName,
  transaction,
  cloneCached,
  dispatchState
});
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
const {
  dispatchTokenPrefix,
  sharedTreeArtifactRequested,
  categoryArtifactRoot,
  sharedTreeArtifactMode,
  dirtyPathKey,
  artifactPathIdentity,
  artifactWorkingState,
  captureArtifactBaseline,
  artifactScopeCheck,
  rederiveUnlaunchedPreparedRoute,
  stampDispatchEvent,
  pulseDispatchState,
  isolatedDispatchWorktreeMissing,
  isolatedDispatchWithMissingWorktree,
  terminalDispatchTarget,
  terminalDispatchForIdle,
  soleIdleCandidate,
  setDispatchTerminal,
  reopenScopePausedDispatch,
  appendReworkEvent,
  dispatchTokenDigest,
  isSupersededDispatchToken,
  routingPolicyAffectsTicket,
  expiredPreparedDispatch,
  worktreeIsolationWarning,
  prepareDispatch,
  readDispatchBriefing,
  recordDispatchLaunch,
  recoverDispatchQuotaFailure,
  dispatchIsolationExpectation,
  dispatchWorkspace,
  dispatchDelta,
  activeSharedTreeClaim,
  dispatchIdentityAmbiguous,
  dispatchCanBindRuntimeIdentity,
  recordDispatchRuntimeIdentity,
  bindDispatchAgent,
  dispatchMatchesStopIdentity,
  markDispatchStopped,
  reconcileLaunchedDispatches
} = dispatch = createDispatch({
  ARTIFACT_BASELINE_MAX_PATHS,
  normalizeCategoryId: (...args) => normalizeCategoryId(...args),
  projectRoutingEnabled,
  routingDisabledMessage,
  getTicket,
  dispatchLaunchName,
  nextDispatchLaunchSeq,
  integrationTargetCommit,
  spawnDescription,
  claudeQuotaFailure: (...args) => claudeQuotaFailure(...args),
  SHARED_TREE_ARTIFACT_MARKER,
  assertDispatchTransport,
  assertSidequestInstall,
  availableRoute: (...args) => availableRoute(...args),
  captureScopePauseRecovery: (...args) => captureScopePauseRecovery(...args),
  claimReclaimable: (...args) => claimReclaimable(...args),
  claimVerification: (...args) => claimVerification(...args),
  commitScope,
  crypto,
  database,
  db,
  dispatchReadOnly: (...args) => dispatchReadOnly(...args),
  dispatchRouteRefusal: (...args) => dispatchRouteRefusal(...args),
  dispatchRouteState: (...args) => dispatchRouteState(...args),
  execFileSync,
  execProjection: (...args) => execProjection(...args),
  fs,
  getCategory: (...args) => getCategory(...args),
  getStory: (...args) => getStory(...args),
  integrationTarget,
  legacyCategoryForComplexity: (...args) => legacyCategoryForComplexity(...args),
  listProjects,
  listTickets,
  nonRepoExternalOutput,
  normalizeArtifactRoots: (...args) => normalizeArtifactRoots(...args),
  normalizeFiles: (...args) => normalizeFiles(...args),
  normalizeRoute: (...args) => normalizeRoute(...args),
  normalizeWorktreeIsolation,
  path,
  preparedDispatchTtlMs: (...args) => preparedDispatchTtlMs(...args),
  putTicket,
  readMeta,
  resolveCategoryFallback: (...args) => resolveCategoryFallback(...args),
  resolveCategoryRoute: (...args) => resolveCategoryRoute(...args),
  resolveExec: (...args) => resolveExec(...args),
  resumableScopePause: (...args) => resumableScopePause(...args),
  stableExecutorName,
  storyExecutionContract: (...args) => storyExecutionContract(...args),
  ticketCategory: (...args) => ticketCategory(...args),
  ticketStorageRow,
  withTicketLock: (...args) => withTicketLock(...args)
});
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
function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), ".claude", "sidequest");
}
function projectsRoot() {
  return path.join(homeRoot(), "projects");
}
function serverFile() {
  return path.join(homeRoot(), "server.json");
}
function normalizeForHash(absPath) {
  const p = path.resolve(absPath);
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function slugify(absPath) {
  const base = path.basename(path.resolve(absPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = crypto.createHash("sha1").update(normalizeForHash(absPath)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}
function mainWorktreeRoot(gitEntry) {
  let stat;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_) {
    return null;
  }
  if (!stat.isFile()) return null;
  let content;
  try {
    content = fs.readFileSync(gitEntry, "utf8");
  } catch (_) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  let gitdir = m[1].replace(/[/\\]+$/, "");
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf("worktrees");
  if (wtIdx < 1) return null;
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_) {
  }
  return null;
}
function nearestRepoRoot(startDir) {
  const start = path.resolve(startDir);
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_) {
    }
  }
  let dir = start;
  for (; ; ) {
    try {
      const entry = path.join(dir, ".git");
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
function projectDir(slug) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug) {
  return path.join(projectDir(slug), "tickets");
}
function assetsDir(slug, id) {
  return path.join(projectDir(slug), "assets", id);
}
const dbByHome = /* @__PURE__ */ new Map();
const transactionDepth = /* @__PURE__ */ new WeakMap();
const storeCacheByDatabase = /* @__PURE__ */ new WeakMap();
function sqliteDataVersion(handle) {
  const row = handle.prepare("PRAGMA data_version").get();
  return Number(row && row.data_version) || 0;
}
function newStoreCache(dataVersion) {
  return {
    dataVersion,
    metadata: /* @__PURE__ */ new Map(),
    projectCategories: /* @__PURE__ */ new Map(),
    routingProfiles: /* @__PURE__ */ new Map(),
    routingProfileEntries: /* @__PURE__ */ new Map(),
    projectRoutingProfiles: /* @__PURE__ */ new Map(),
    routingProfileSettings: void 0,
    routingFallback: void 0,
    snapshots: /* @__PURE__ */ new Map()
  };
}
function residentCache() {
  const handle = database();
  const dataVersion = sqliteDataVersion(handle);
  let cache = storeCacheByDatabase.get(handle);
  if (!cache || cache.dataVersion !== dataVersion) {
    cache = newStoreCache(dataVersion);
    storeCacheByDatabase.set(handle, cache);
  }
  return cache;
}
function invalidateStoreCaches() {
  const handle = database();
  storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
}
function putCachedRow(handle, table, row) {
  const result = db.putRow(handle, table, row);
  invalidateStoreCaches();
  return result;
}
function deleteCachedRow(handle, table, key) {
  const deleted = db.deleteRow(handle, table, key);
  if (deleted) invalidateStoreCaches();
  return deleted;
}
function cloneCached(value) {
  return value == null ? value : structuredClone(value);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
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
  DEFAULT_CLAIM_ABANDON_MIN,
  DEFAULT_CLAIM_IDLE_MIN,
  DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
  autoReleasedClaimMessage,
  claimAbandonMs,
  claimActivityMs,
  claimIdleAge,
  claimIdleMs,
  claimReclaimable,
  claimReleaseNote,
  claimReleaseVerdict,
  claimVerification,
  preparedDispatchTtlMs,
  recordClaimVerification,
  resumableScopePause,
  touchClaim,
  touchClaimActivity
} = createClaims({
  dispatchState,
  fs,
  getTicket,
  putTicket,
  withTicketLock
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
  recordClaimVerification,
  touchClaimActivity,
  withTicketLock
});
const {
  PLAN_ASSET_NAME,
  PLAN_BODY_MAX_BYTES,
  appendExperimentEntry,
  appendOverturnLine,
  applyExperimentVerdict,
  experimentPacket,
  ticketPlanInfo,
  writeTicketPlan
} = createPlans({
  assetPath,
  assetsDir,
  clearOracleMarker,
  fs,
  getTicket,
  nullableText,
  path,
  putTicket,
  stripControlChars,
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
  overlappingScopePaths,
  scopesOverlap,
  normalizeContracts,
  contractCollisionReasons,
  contractMetadata,
  readyWaves,
  readyWaveDependencies,
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
  claimReclaimable,
  coerceComplexity,
  coercePriority,
  commitScope,
  copyAsset,
  createComment,
  database,
  deleteCachedRow,
  dispatchState,
  effectiveScope,
  execFileSync,
  executorText,
  fs,
  getTicket,
  listTickets,
  makeWorkedBy,
  newTicketId,
  nextSeq,
  path,
  pendingSubmission: pendingSubmissionForTickets,
  putTicket,
  queryTickets,
  queueEventNotification,
  readyTickets,
  releaseLock,
  reopenScopePausedDispatch,
  requestedReadonlyOverride,
  requireStatus,
  requireVerifyCommand,
  saveAssetData,
  ticketLockPath,
  ticketStoryId,
  touchClaimActivity,
  upperRef,
  stripLinksTo,
  withTicketLock
});
function pendingSubmissionForTickets(...args) {
  return pendingSubmission(...args);
}
function checkpointProjectionForRead(...args) {
  return checkpointProjection(...args);
}
function oracleProjectionForRead(...args) {
  return oracleProjection(...args);
}
function submissionReadinessForRead(...args) {
  return submissionReadiness(...args);
}
const {
  briefTicket,
  listPayload,
  readyPayload
} = createReads({
  checkpointProjection: checkpointProjectionForRead,
  claimIdleMs,
  claimReclaimable,
  classifierCategories,
  contractMetadata,
  countTickets,
  database,
  db,
  openBlockers,
  openBlockersFromIndex,
  oracleProjection: oracleProjectionForRead,
  pendingSubmission: pendingSubmissionForTickets,
  queryTickets,
  readyTickets,
  readyWaveDependencies,
  readyWaves,
  routeDescriptor,
  submissionReadiness: submissionReadinessForRead
});
const {
  markLongRunFlagged,
  reconcileSession,
  registerWorker,
  sessionClaims,
  unregisterClaim
} = createWorkers({
  acquireLock,
  addComment,
  dispatchState,
  getTicket,
  path,
  projectsRoot,
  readGlobal,
  releaseLock,
  releaseTicket,
  transaction,
  writeGlobal
});
const {
  DEFAULT_CHECKPOINT_TTL_MIN,
  MAX_CHECKPOINT_TTL_MIN,
  checkpointTtlMs,
  checkpointProjection,
  oracleProjection,
  checkpointTicket,
  submissionReadiness,
  submissionProjection,
  pendingSubmission,
  verifyIntegration,
  validateIntegrationSubmission,
  integrateSubmission,
  submitTicket,
  clearSubmission,
  submissionBaseCandidates,
  submissionsPayload
} = createSubmissions({
  EXECUTOR_VERIFY_MAX,
  INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES,
  MANUAL_VERIFY_PREFIX,
  addComment,
  appendReworkEvent,
  autoReleasedClaimMessage,
  boardConfig,
  boundedExcerptForSubmission: (...args) => boundedExcerpt(...args),
  claimReclaimable,
  clearScopeRequestMarker,
  commitScope,
  coerceStatus,
  createComment,
  crypto,
  dispatchState,
  effectiveScope,
  ensureDir,
  execFileSync,
  fs,
  getTicket,
  listTickets,
  manualVerify,
  normalizeDeliveryMode,
  normalizeIntegrationBranch,
  normalizeIntegrationVerifyTimeoutMs,
  nullableText,
  path,
  prepareComment,
  projectDir,
  putTicket,
  queueEventNotification,
  readMeta,
  setDispatchTerminal,
  spawnSync,
  stampDispatchEvent,
  ticketLockPath,
  unregisterClaim,
  verifyCommandError,
  withTicketLock
});
function refreshRoutingProfileSeeds(handle) {
  const pending = [];
  for (const seed of STARTER_ROUTING_PROFILES) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null || Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION) continue;
    pending.push({ seed, profileId: profile.id });
  }
  if (!pending.length) return;
  db.txn(handle, () => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const affected = /* @__PURE__ */ new Set();
    for (const { seed, profileId } of pending) {
      handle.prepare("DELETE FROM routing_profile_entries WHERE profile_id = ?").run(profileId);
      seed.categories.forEach((category, position) => {
        handle.prepare(`
          INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(profileId, category.id, JSON.stringify(category), position, now);
      });
      handle.prepare(`
        UPDATE routing_profiles SET name = ?, description = ?, seed_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(seed.name, seed.description, ROUTING_PROFILE_SEED_REVISION, now, profileId);
      for (const row of handle.prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ?").all(profileId)) {
        affected.add(String(row.project));
      }
    }
    refreshPreparedDispatches(handle, [...affected], null);
  });
}
function refreshReadonlyCategorySeeds(handle) {
  const readonlyIds = /* @__PURE__ */ new Set([
    ...DEFAULT_CATEGORIES.filter((category) => category.readonly === true).map((category) => category.id),
    "hand-analysis"
  ]);
  const affected = /* @__PURE__ */ new Set();
  let changed = false;
  db.txn(handle, () => {
    const updateProfileEntry = handle.prepare("UPDATE routing_profile_entries SET data = ?, updated_at = ? WHERE profile_id = ? AND category_id = ?");
    const updateProjectEntry = handle.prepare("UPDATE project_categories SET data = ? WHERE project = ? AND id = ?");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const row of handle.prepare("SELECT profile_id, category_id, data FROM routing_profile_entries").all()) {
      let category;
      try {
        category = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!readonlyIds.has(category?.id) || category.readonly !== void 0) continue;
      category.readonly = true;
      updateProfileEntry.run(JSON.stringify(category), now, row.profile_id, row.category_id);
      for (const project of handle.prepare("SELECT project FROM project_routing_profiles WHERE profile_id = ?").all(row.profile_id)) affected.add(String(project.project));
      changed = true;
    }
    for (const row of handle.prepare("SELECT project, id, data FROM project_categories").all()) {
      let category;
      try {
        category = JSON.parse(row.data);
      } catch (_) {
        continue;
      }
      if (!readonlyIds.has(row.id) || category.readonly !== void 0) continue;
      category.readonly = true;
      updateProjectEntry.run(JSON.stringify(category), row.project, row.id);
      affected.add(String(row.project));
      changed = true;
    }
    if (changed) refreshPreparedDispatches(handle, [...affected], [...readonlyIds]);
  });
}
function database() {
  const root = homeRoot();
  let handle = dbByHome.get(root);
  if (!handle) {
    handle = db.openDb(root);
    migrateIfNeeded(handle, root);
    refreshRoutingProfileSeeds(handle);
    refreshReadonlyCategorySeeds(handle);
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
  telemetry.emitTicket({ slug, path: project && project.path }, applyDerivedRouting(Object.assign({}, ticket), { project: slug }));
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
function defaultProjectName(absPath) {
  return path.basename(path.resolve(absPath)) || "project";
}
function normalizeAlwaysInScope(paths) {
  if (!Array.isArray(paths)) throw new Error("alwaysInScope must be an array of repo-relative paths.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const value of paths) {
    const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const relative = item.replace(/\/+$/, "");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`alwaysInScope path must stay inside the board repo: ${value}`);
    }
    const key = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(item);
    }
  }
  return normalized;
}
function normalizeReadOnlyDeniedTools(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("readOnlyDeniedTools must be an array of tool patterns.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const entry of value) {
    const pattern = String(entry || "").trim();
    if (!pattern) throw new Error("readOnlyDeniedTools entries must be non-empty tool patterns.");
    if (!pattern.startsWith("mcp__")) throw new Error(`readOnlyDeniedTools patterns must target MCP tools: ${entry}`);
    if (!seen.has(pattern)) {
      seen.add(pattern);
      normalized.push(pattern);
    }
  }
  return normalized;
}
function normalizeGeneratedPairPath(value, name) {
  const item = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!item || item === ".." || item.startsWith("../") || path.isAbsolute(item) || item.includes("/../")) {
    throw new Error(`generatedPairs ${name} pattern must stay inside the board repo: ${value}`);
  }
  return item;
}
function normalizeGeneratedPairs(pairs) {
  if (pairs == null) return [];
  if (!Array.isArray(pairs)) throw new Error("generatedPairs must be an array of { from, to } patterns.");
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      throw new Error("generatedPairs entries must be { from, to } patterns.");
    }
    const from = normalizeGeneratedPairPath(pair.from, "from");
    const to = normalizeGeneratedPairPath(pair.to, "to");
    if ((from.match(/\*/g) || []).length !== (to.match(/\*/g) || []).length) {
      throw new Error(`generatedPairs patterns must use the same number of * placeholders: ${from} -> ${to}`);
    }
    const key = `${from}\0${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ from, to });
    }
  }
  return normalized;
}
function generatedPathFor(source, pair) {
  const sourcePath = String(source || "").replace(/\\/g, "/");
  if (!sourcePath || sourcePath.includes("*")) return null;
  const parts = String(pair.from).split("*");
  const expression = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+)")}$`);
  const match = sourcePath.match(expression);
  if (!match) return null;
  return String(pair.to).split("*").map((part, index) => `${part}${index < match.length - 1 ? match[index + 1] : ""}`).join("");
}
function trackedGeneratedPaths(config, files) {
  if (!config || !config.path || !Array.isArray(config.generatedPairs) || !config.generatedPairs.length || !Array.isArray(files)) return [];
  const candidates = Array.from(new Set(files.flatMap((file) => config.generatedPairs.map((pair) => generatedPathFor(file, pair)).filter(Boolean))));
  if (!candidates.length) return [];
  try {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...candidates], {
      cwd: config.path,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    }).split("\0").filter(Boolean);
    const candidateKeys = new Set(candidates.map((candidate) => process.platform === "win32" ? candidate.toLowerCase() : candidate));
    return tracked.filter((trackedPath) => candidateKeys.has(process.platform === "win32" ? trackedPath.toLowerCase() : trackedPath));
  } catch (_) {
    return [];
  }
}
function defaultAlwaysInScope(absPath) {
  try {
    return fs.statSync(path.join(absPath, "docs")).isDirectory() ? ["docs/"] : [];
  } catch (_) {
    return [];
  }
}
function normalizeDeliveryMode(mode) {
  const value = String(mode || "merge").trim().toLowerCase();
  if (!DELIVERY_MODES.includes(value)) {
    throw new Error('delivery must be "merge", "replay", or "apply".');
  }
  return value;
}
function normalizeIntegrationMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  if (!["auto", "local", "remote"].includes(value)) {
    throw new Error('integrationMode must be "auto", "local", or "remote".');
  }
  return value;
}
function normalizeIntegrationBranch(value) {
  const branch = String(value == null ? "main" : value).trim();
  if (!branch || branch === "@" || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//") || branch.includes("/.") || branch.endsWith(".lock") || branch.includes("..") || branch.includes("@{") || /[\s~^:?*\[\\]/.test(branch)) {
    throw new Error("integrationBranch must be a valid Git branch name.");
  }
  return branch;
}
function normalizeWorktreeIsolation(value) {
  if (value == null) return true;
  if (typeof value !== "boolean") throw new Error("worktreeIsolation must be a boolean.");
  return value;
}
function normalizeAutoApprovePluginTests(value) {
  if (value == null) return true;
  if (typeof value !== "boolean") throw new Error("autoApprovePluginTests must be a boolean.");
  return value;
}
function normalizeWorktreeSetup(value) {
  if (value == null || String(value).trim() === "") return null;
  const setup = String(value);
  if (/[\r\n]/.test(setup)) throw new Error("worktreeSetup must be a one-line command.");
  if (setup.length > WORKTREE_SETUP_MAX_LENGTH) {
    throw new Error(`worktreeSetup exceeds the ${WORKTREE_SETUP_MAX_LENGTH}-character board-config limit.`);
  }
  return setup;
}
function normalizeIntegrationVerifyTimeoutMs(value) {
  if (value == null || value === "") return DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_INTEGRATION_VERIFY_TIMEOUT_MS) {
    throw new Error(`integrationVerifyTimeoutMs must be an integer from 1 to ${MAX_INTEGRATION_VERIFY_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}
function hasOriginRemote(absPath) {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: absPath, encoding: "utf8", windowsHide: true, stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}
function integrationBranchExists(absPath, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: absPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    });
    return true;
  } catch (_) {
    return false;
  }
}
function integrationTarget(slug, override) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const requested = override && typeof override === "object" ? override : {};
  const configured = normalizeIntegrationMode(requested.mode ?? meta.integrationMode);
  const mode = configured === "auto" ? hasOriginRemote(meta.path) ? "remote" : "local" : configured;
  const branch = normalizeIntegrationBranch(requested.branch ?? override ?? meta.integrationBranch);
  const upstream = mode === "local" ? branch : `origin/${branch}`;
  const ref = mode === "local" ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
  if (!integrationBranchExists(meta.path, ref)) {
    throw new Error(`Configured integration ref "${ref}" for branch "${branch}" does not exist. Create or fetch it, or set integrationBranch with board-config --integration-branch <branch>.`);
  }
  return { mode, upstream, branch };
}
function integrationTargetCommit(absPath, target) {
  return execFileSync("git", ["rev-parse", "--verify", `${target.upstream}^{commit}`], {
    cwd: absPath,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe"
  }).trim();
}
function normalizeBoardName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("Board name cannot be empty.");
  return name;
}
function boardConfig(slug) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const selected = projectRoutingProfile(slug);
  if (!selected) throw new Error(`Project "${slug}" does not have a routing profile.`);
  const layer = getProjectCategories(slug);
  const byKind = Object.fromEntries(["ADD", "OVERRIDE", "DETACH", "DISABLE"].map((kind) => [kind, layer.rows.filter((row) => row.kind === kind).length]));
  return {
    name: meta.name,
    alwaysInScope: Array.isArray(meta.alwaysInScope) ? normalizeAlwaysInScope(meta.alwaysInScope) : defaultAlwaysInScope(meta.path),
    readOnlyDeniedTools: normalizeReadOnlyDeniedTools(meta.readOnlyDeniedTools),
    generatedPairs: normalizeGeneratedPairs(meta.generatedPairs),
    integrationMode: normalizeIntegrationMode(meta.integrationMode),
    integrationBranch: normalizeIntegrationBranch(meta.integrationBranch),
    delivery: normalizeDeliveryMode(meta.delivery),
    integrationVerifyTimeoutMs: normalizeIntegrationVerifyTimeoutMs(meta.integrationVerifyTimeoutMs),
    worktreeIsolation: normalizeWorktreeIsolation(meta.worktreeIsolation),
    autoApprovePluginTests: normalizeAutoApprovePluginTests(meta.autoApprovePluginTests),
    worktreeSetup: normalizeWorktreeSetup(meta.worktreeSetup),
    profile: {
      id: selected.profile.id,
      name: selected.profile.name,
      revision: selected.profile.revision,
      entryCount: routingProfileEntries(selected.profile.id).length
    },
    overrides: {
      count: layer.rows.length,
      byKind,
      foreignBaseCount: layer.rows.filter((row) => row.baseProfileId && row.baseProfileId !== selected.profile.id).length,
      items: layer.rows
    },
    warnings: [...selected.warnings, ...layer.warnings]
  };
}
function setBoardConfig(slug, patch) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (!patch || typeof patch !== "object") return { ok: true, config: boardConfig(slug) };
    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      meta.name = normalizeBoardName(patch.name);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "alwaysInScope")) {
      meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "readOnlyDeniedTools")) {
      meta.readOnlyDeniedTools = normalizeReadOnlyDeniedTools(patch.readOnlyDeniedTools);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "generatedPairs")) {
      meta.generatedPairs = normalizeGeneratedPairs(patch.generatedPairs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationMode")) {
      meta.integrationMode = normalizeIntegrationMode(patch.integrationMode);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationBranch")) {
      meta.integrationBranch = normalizeIntegrationBranch(patch.integrationBranch);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "delivery")) {
      meta.delivery = normalizeDeliveryMode(patch.delivery);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "integrationVerifyTimeoutMs")) {
      meta.integrationVerifyTimeoutMs = normalizeIntegrationVerifyTimeoutMs(patch.integrationVerifyTimeoutMs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "worktreeIsolation")) {
      meta.worktreeIsolation = normalizeWorktreeIsolation(patch.worktreeIsolation);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoApprovePluginTests")) {
      meta.autoApprovePluginTests = normalizeAutoApprovePluginTests(patch.autoApprovePluginTests);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "worktreeSetup")) {
      meta.worktreeSetup = normalizeWorktreeSetup(patch.worktreeSetup);
    }
    putProject(slug, meta);
    return { ok: true, config: boardConfig(slug) };
  });
}
function effectiveScope(slug, files) {
  const config = boardConfig(slug);
  const paired = trackedGeneratedPaths(Object.assign({ path: readMeta(slug)?.path }, config), files);
  return Array.from(/* @__PURE__ */ new Set([...Array.isArray(files) ? files : [], ...config && config.alwaysInScope || [], ...paired]));
}
function ensureProject(absPath, name) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  let meta;
  let changed = false;
  transaction(() => {
    const handle = database();
    meta = db.getRow(handle, "projects", slug);
    if (!meta || typeof meta !== "object") {
      meta = {
        path: resolved,
        name: name || defaultProjectName(resolved),
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        seq: 0,
        storySeq: 0,
        alwaysInScope: defaultAlwaysInScope(resolved),
        worktreeIsolation: true
      };
      db.putRow(handle, "projects", { slug, data: meta });
      changed = true;
    } else {
      if (meta.path !== resolved) {
        meta.path = resolved;
        changed = true;
      }
      if (name && meta.name !== name) {
        meta.name = name;
        changed = true;
      }
      if (!meta.name) {
        meta.name = defaultProjectName(resolved);
        changed = true;
      }
      if (typeof meta.seq !== "number") {
        meta.seq = 0;
        changed = true;
      }
      if (typeof meta.storySeq !== "number") {
        meta.storySeq = 0;
        changed = true;
      }
      if (changed) db.putRow(handle, "projects", { slug, data: meta });
    }
    const pointer = handle.prepare("SELECT project FROM project_routing_profiles WHERE project = ?").get(slug);
    if (!pointer) {
      const settings = handle.prepare("SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1").get();
      if (!settings?.new_project_profile_id) throw new Error("The new-board routing profile is not configured.");
      db.putRow(handle, "project_routing_profiles", {
        project: slug,
        profile_id: settings.new_project_profile_id,
        assigned_at: (/* @__PURE__ */ new Date()).toISOString(),
        assigned_by: "ensure-project"
      });
      changed = true;
    }
  });
  if (changed) invalidateStoreCaches();
  return { slug, dir, meta };
}
function readMeta(slug) {
  const key = String(slug || "");
  const cache = residentCache();
  if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
  const meta = db.getRow(database(), "projects", key);
  cache.metadata.set(key, meta);
  return cloneCached(meta);
}
function metaLockPath(slug) {
  return path.join(projectDir(slug), ".meta.lock");
}
function withMetaLock(slug, fn) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
  }
}
function nextSeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { seq: 0 };
    meta.seq = (typeof meta.seq === "number" ? meta.seq : 0) + 1;
    putProject(slug, meta);
    return meta.seq;
  });
}
function nextStorySeq(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === "number" ? meta.storySeq : 0) + 1;
    putProject(slug, meta);
    return meta.storySeq;
  });
}
function setProjectNotify(slug, on) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    meta.notify = on !== false;
    putProject(slug, meta);
    return { ok: true, notify: meta.notify };
  });
}
function setProjectRouting(slug, routing) {
  if (!["enabled", "disabled"].includes(routing)) throw new Error("Routing must be enabled or disabled.");
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    meta.routing = routing;
    putProject(slug, meta);
    return { ok: true, routing: meta.routing };
  });
}
function projectRoutingEnabled(slug) {
  const meta = readMeta(slug);
  return !meta || meta.routing !== "disabled";
}
function archiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = (/* @__PURE__ */ new Date()).toISOString();
    putProject(slug, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  });
}
function unarchiveProject(slug) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: "not_found" };
    if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
    delete meta.archivedAt;
    putProject(slug, meta);
    return { ok: true, slug, wasArchived: true };
  });
}
function deleteProjectExact(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: "not_found" };
  if (!readMeta(slug)) return { ok: false, reason: "not_found" };
  transaction(() => {
    for (const ticket of db.listRows(database(), "tickets", { project: slug })) deleteCachedRow(database(), "tickets", ticket.id);
    for (const story of db.listRows(database(), "stories", { project: slug })) deleteCachedRow(database(), "stories", story.id);
    deleteCachedRow(database(), "projects", slug);
  });
  fs.rmSync(projectDir(slug), { recursive: true, force: true });
  return { ok: true, slug };
}
function listProjects(opts) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `projects:${opts.all ? "all" : opts.archived ? "archived" : "active"}`;
  const cached = cache.snapshots.get(cacheKey);
  if (cached) return cloneCached(cached);
  const rows = db.selectRows(database(), `
    SELECT
      p.slug,
      p.data,
      COALESCE(t.todo, 0) AS todo,
      COALESCE(t.doing, 0) AS doing,
      COALESCE(t.done, 0) AS done,
      COALESCE(t.active, 0) AS active,
      COALESCE(t.archived, 0) AS archived,
      t.last_activity,
      COALESCE(s.stories, 0) AS stories
    FROM projects p
    LEFT JOIN (
      SELECT
        project,
        SUM(CASE WHEN archived = 0 AND status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN archived = 0 AND status = 'doing' THEN 1 ELSE 0 END) AS doing,
        SUM(CASE WHEN archived = 0 AND status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived != 0 THEN 1 ELSE 0 END) AS archived,
        MAX(json_extract(data, '$.updatedAt')) AS last_activity
      FROM tickets
      GROUP BY project
    ) t ON t.project = p.slug
    LEFT JOIN (
      SELECT project, COUNT(*) AS stories
      FROM stories
      GROUP BY project
    ) s ON s.project = p.slug
  `);
  const out = [];
  for (const row of rows) {
    let meta;
    try {
      meta = JSON.parse(row.data);
    } catch (_) {
      continue;
    }
    if (!meta || !meta.path) continue;
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
    const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
    out.push({
      slug: slugify(meta.path),
      name: meta.name || row.slug,
      path: meta.path || "",
      counts,
      total: Number(row.active) || 0,
      archived: Number(row.archived) || 0,
      open: counts.todo + counts.doing,
      lastActivity: row.last_activity || meta.createdAt || null,
      notify: meta.notify !== false,
      routing: meta.routing === "disabled" ? "disabled" : "enabled",
      stories: Number(row.stories) || 0,
      archivedAt
    });
  }
  out.sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
  cache.snapshots.set(cacheKey, out);
  return cloneCached(out);
}
function findProject(ref) {
  const arg = String(ref == null ? "" : ref).trim();
  if (!arg) return { ok: false, reason: "not_found", known: listProjects({ all: true }).map((project) => project.name) };
  if (path.isAbsolute(arg)) {
    const resolvedPath = path.resolve(arg);
    const slug = slugify(resolvedPath);
    const meta = readMeta(slug);
    if (meta && normalizeForHash(meta.path) === normalizeForHash(resolvedPath)) return { ok: true, slug, meta };
  } else {
    const meta = readMeta(arg);
    if (meta) return { ok: true, slug: arg, meta };
  }
  const projects = db.selectRows(database(), "SELECT slug, data FROM projects ORDER BY slug").map((row) => {
    try {
      return { slug: row.slug, meta: JSON.parse(row.data) };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
  const wantedName = arg.toLowerCase();
  const byName = projects.filter((project) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
  if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      matches: byName.map((project) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || "" }))
    };
  }
  if (!path.isAbsolute(arg)) {
    const wantedPath = normalizeForHash(path.resolve(arg));
    const byPath = projects.find((project) => project.meta.path && normalizeForHash(path.resolve(project.meta.path)) === wantedPath);
    if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
  }
  return { ok: false, reason: "not_found", known: projects.map((project) => project.meta.name || project.slug) };
}
function mergeProject(srcSlug, destSlug, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error("source and destination are the same board");
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);
  const tickets = listTickets(srcSlug).slice().sort((a, b) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories2 = listStories(srcSlug);
  const refMap = {};
  const ticketPlan = [];
  for (const t of tickets) {
    const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
    if (t.ref) refMap[String(t.ref).toUpperCase()] = newRef;
    ticketPlan.push({ ticket: t, newRef });
  }
  const storyPlan = [];
  for (const s of stories2) {
    const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
    storyPlan.push({ story: s, newRef });
  }
  const mapping = ticketPlan.map(({ ticket, newRef }) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
  if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
  transaction(() => {
    for (const ticket of tickets) deleteCachedRow(database(), "tickets", ticket.id);
    for (const story of stories2) deleteCachedRow(database(), "stories", story.id);
    for (const { story, newRef } of storyPlan) {
      const moved = Object.assign({}, story, { ref: newRef });
      putStory(destSlug, moved);
    }
    for (const { ticket, newRef } of ticketPlan) {
      const links = Array.isArray(ticket.links) ? ticket.links.map((l) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref })) : [];
      const moved = Object.assign({}, ticket, { ref: newRef, links });
      putTicket(destSlug, moved);
      const srcAssets = assetsDir(srcSlug, ticket.id);
      if (fs.existsSync(srcAssets)) {
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_) {
        }
      }
    }
    deleteCachedRow(database(), "projects", srcSlug);
  });
  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_) {
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}
function seqOfRef(ref) {
  const m = /(\d+)\s*$/.exec(String(ref || ""));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}
function parseTicketData(slug, data) {
  try {
    const ticket = typeof data === "string" ? JSON.parse(data) : data;
    return ticket && ticket.id ? applyDerivedRouting(ticket, { project: slug }) : null;
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
function worktreeGcTickets() {
  return db.selectRows(database(), "SELECT project, data FROM tickets").map((row) => {
    const ticket = parseTicketData(row.project, row.data);
    return ticket ? Object.assign({}, ticket, {
      project: row.project,
      claimLive: Boolean(ticket.claim && ticket.claim.by && !claimReleaseVerdict(ticket))
    }) : null;
  }).filter(Boolean);
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
const DISPATCH_DESCRIPTION_MIN = 80;
const DISPATCH_DESCRIPTION_GUIDANCE = "the executor's entire brief is this ticket; add a description (Where / Contract / Verify) and a verify command, then dispatch";
function executorText(value, max, label) {
  if (value == null) return "";
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}
const VERIFY_BUILTINS = /* @__PURE__ */ new Set([
  "bash",
  "bun",
  "cargo",
  "cd",
  "cmd",
  "composer",
  "dart",
  "deno",
  "dotnet",
  "elixir",
  "eslint",
  "flutter",
  "git",
  "go",
  "gradle",
  "java",
  "jest",
  "just",
  "make",
  "mix",
  "mvn",
  "node",
  "npm",
  "npx",
  "php",
  "pnpm",
  "poetry",
  "powershell",
  "pwsh",
  "py",
  "pytest",
  "python",
  "python3",
  "rake",
  "ruby",
  "sh",
  "tox",
  "tsc",
  "uv",
  "vitest",
  "yarn"
]);
function manualVerify(value) {
  return /^manual:\s+\S/i.test(String(value || "").trim());
}
function verifyCommandError(value) {
  const command = String(value || "").trim();
  if (!command || manualVerify(command)) return null;
  if (/^manual:/i.test(command)) {
    return "Manual verification must say what was checked: `manual: <what you checked>`. Otherwise provide a runnable command such as `cd <repo-relative-dir> && <command>`.";
  }
  const first = command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[1] || command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[2] || "";
  const likelyExecutable = VERIFY_BUILTINS.has(first.toLowerCase()) || /[\\/]|\.(?:bat|cmd|com|exe|ps1|sh)$/i.test(first);
  const proseStarter = /^(?:check|confirm|ensure|inspect|look|open|read|review|verify)\s/i.test(command);
  if (command.endsWith(".") || proseStarter || !likelyExecutable && /[.!?]/.test(command)) {
    return "Verify must be a runnable command such as `cd <repo-relative-dir> && <command>`. For manual verification, use `manual: <what you checked>` so it is recorded without shell execution.";
  }
  for (const match of command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|(?::[^}]*)\})/g)) {
    const name = match[1] || match[2];
    if (name && process.env[name] == null && !match[0].includes(":-")) {
      return `Verify references unset environment variable ${name}. Set a portable default such as \`${"${"}${name}:-/tmp}\`, or use \`manual: <what you checked>\`.`;
    }
  }
  for (const match of command.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    const name = match[1];
    if (name != null && process.env[name] == null) {
      return `Verify references unset environment variable ${name}. Set a portable default or use \`manual: <what you checked>\`.`;
    }
  }
  return null;
}
function requireVerifyCommand(value) {
  const error = verifyCommandError(value);
  if (error) throw new Error(error);
}
function ticketReferenceWarnings(slug, title, description) {
  const refs = new Set((`${title || ""}
${description || ""}`.match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(", ")}.`] : [];
}
function ticketPrescribesFix(description) {
  const body = String(description || "");
  if (/^\s*fix\s*:/im.test(body)) return true;
  if (/\b(?:replace|change)\s+\S[\s\S]{0,160}?\s+(?:with|to)\s+\S/i.test(body)) return true;
  if (/```(?:diff|patch)?\s*\r?\n[\s\S]*?^-\S[\s\S]*?^\+\S[\s\S]*?```/im.test(body)) return true;
  return (body.match(/^\s*\d+[.)]\s+(?:add|change|replace|remove|rename|move|update|set|delete|edit|wire)\b/gim) || []).length >= 2;
}
function ticketCategoryWarnings(ticket) {
  if (ticketCategory(ticket) !== "coding.hard" || !ticketPrescribesFix(ticket && ticket.description)) return [];
  return ["coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category."];
}
function readonlyCategoryWriteIntentWarning(ticket) {
  if (!categoryReadOnly(ticket)) return null;
  const writesFiles = normalizeFiles(ticket.files).length > 0;
  const writesContracts = (normalizeContracts(ticket.contracts).changes || []).length > 0;
  if (!writesFiles && !writesContracts) return null;
  return "Readonly category contradicts declared write intent (files or changes). Resolve the category or set an explicit readonly override before dispatch.";
}
function noDeclaredScopeWarning(ticket) {
  if (dispatchReadOnly(ticket)) return null;
  if (Array.isArray(ticket.files) && ticket.files.length) return null;
  if (Number(ticket?.complexity) >= 4) return null;
  return "Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.";
}
const BROWSER_REVIEW_SIGNAL = /\b(?:browser|visual|screenshot|playwright|ui review|e2e)\b/i;
function readonlyBrowserReviewWarning(ticket) {
  if (!dispatchReadOnly(ticket)) return null;
  const signal = [ticket?.title, ticket?.description, ticketCategory(ticket)].join("\n");
  if (!BROWSER_REVIEW_SIGNAL.test(signal)) return null;
  return "Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.";
}
function relativePathWithin(root, target) {
  const relative = path.relative(String(root), String(target));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : relative === "" ? "." : null;
}
function packageRootForScope(projectPath, scope) {
  const absolute = path.resolve(String(projectPath), String(scope));
  let directory = path.dirname(absolute);
  for (; ; ) {
    if (!relativePathWithin(projectPath, directory)) return null;
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function buildOutputDirectories(source) {
  const outputs = /* @__PURE__ */ new Map();
  const add = (directory, sourceDirectory) => {
    const value = String(directory || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!value || value.includes("..") || path.isAbsolute(value)) return;
    const current = outputs.get(value);
    outputs.set(value, { directory: value, sourceDirectory: sourceDirectory || current?.sourceDirectory || null });
  };
  const text = String(source || "");
  for (const match of text.matchAll(/--(?:outdir|out-dir|output-dir)\s*(?:=|\s+)\s*["']?([^"'\s;&]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/(?:outdir|outDir|outputDir)\s*:\s*["']([^"']+)["']/g)) add(match[1]);
  for (const helper of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{([\s\S]{0,2000}?)\n\}/g)) {
    const [helperName, parameter, body] = [helper[1], helper[2], helper[3]];
    if (!helperName || !parameter || !body || !new RegExp(`(?:outdir|outDir)\\s*:\\s*path\\.join\\([^)]*,\\s*${parameter}\\s*\\)`).test(body)) continue;
    const call = new RegExp(`\\b${helperName}\\s*\\(\\s*["']([^"']+)["']`, "g");
    for (const match of text.matchAll(call)) add(match[1], match[1]);
  }
  return [...outputs.values()];
}
function packageBuildOutputs(packageRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(String(packageRoot), "package.json"), "utf8"));
  } catch (_) {
    return [];
  }
  const build = String(manifest?.scripts?.build || "");
  if (!build) return [];
  const outputs = buildOutputDirectories(build);
  for (const match of build.matchAll(/\bnode\s+(?:["']([^"']+)["']|([^\s;&]+))/g)) {
    const script = path.resolve(String(packageRoot), match[1] || match[2]);
    if (!relativePathWithin(packageRoot, script) || !fs.existsSync(script)) continue;
    try {
      outputs.push(...buildOutputDirectories(fs.readFileSync(script, "utf8")));
    } catch (_) {
    }
  }
  return [...new Map(outputs.map((output) => [output.directory, output])).values()];
}
function isTrackedBuildOutput(projectPath, output) {
  const relative = relativePathWithin(projectPath, output);
  if (!relative || relative === ".") return false;
  try {
    return Boolean(execFileSync("git", ["ls-files", "--", relative], {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch (_) {
    return false;
  }
}
function scopeIncludesPath(files, projectPath, target) {
  return normalizeFiles(files).some((file) => {
    const declared = path.resolve(String(projectPath), file);
    return declared === target || relativePathWithin(target, declared) !== null;
  });
}
function sourceBuildOutputWarnings(ticket, projectPath) {
  if (!projectPath || !Array.isArray(ticket?.files)) return [];
  const warnings = /* @__PURE__ */ new Set();
  for (const scope of normalizeFiles(ticket.files)) {
    const packageRoot = packageRootForScope(projectPath, scope);
    if (!packageRoot) continue;
    const sourceRelative = relativePathWithin(packageRoot, path.resolve(projectPath, scope))?.replace(/\\/g, "/");
    if (!sourceRelative || sourceRelative !== "src" && !sourceRelative.startsWith("src/")) continue;
    const sourceDirectory = sourceRelative.split("/")[1] || null;
    for (const output of packageBuildOutputs(packageRoot)) {
      if (output.sourceDirectory && sourceDirectory && output.sourceDirectory !== sourceDirectory) continue;
      const target = path.resolve(packageRoot, output.directory);
      if (!isTrackedBuildOutput(projectPath, target) || scopeIncludesPath(ticket.files, projectPath, target)) continue;
      const packageRelative = relativePathWithin(projectPath, packageRoot)?.replace(/\\/g, "/") || ".";
      const display = packageRelative === "." ? output.directory : `${packageRelative}/${output.directory}`;
      warnings.add(`Planning-depth warning: declared source scope under ${packageRelative}/src omits tracked build output ${display}. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.`);
    }
  }
  return [...warnings];
}
function verifyCommandWarning(ticket, projectPath) {
  const verify = String(ticket?.executorVerify || "").trim();
  if (!verify) return null;
  const match = /^cd\s+(?:["']([^"']+)["']|([^&;\s]+))\s*&&/.exec(verify);
  if (!match) return "Planning-depth warning: record verify commands as `cd <repo-relative-dir> && ...`, then run that exact string before submitting.";
  const directory = path.resolve(String(projectPath || ""), match[1] || match[2]);
  if (!projectPath || !relativePathWithin(projectPath, directory) || !fs.existsSync(directory)) {
    return "Planning-depth warning: the recorded verify command changes to a directory that does not exist in this repo. Run the exact string you record before submitting.";
  }
  return null;
}
function dispatchDescriptionError(ticket) {
  if (!ticket || !ticket.model || !ticket.effort) return null;
  if (String(ticket.description || "").trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
  return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
}
function storyContractDriftWarnings(ticket) {
  const contractDrift = ticket && (ticket.storyContractDrift || dispatchState(ticket)?.storyContractDrift);
  if (!contractDrift) return [];
  return [`Dispatch warning: ${contractDrift.storyRef || "story"} execution contract changed from revision ${contractDrift.fromRevision} to ${contractDrift.toRevision} while this ticket was claimed; the next briefing uses revision ${contractDrift.toRevision}.`];
}
function claudeWebSearchUnavailable(ticket) {
  const model = normalizeRouteModel(ticket && ticket.model);
  const effort = coerceEffort(ticket && ticket.effort);
  return ["opus", "sonnet", "fable"].includes(String(model)) && ["xhigh", "max"].includes(String(effort));
}
const DISPATCH_SYMBOL_CHECK_MAX = 12;
const DISPATCH_SYMBOL_CHECK_MAX_SCOPES = 64;
const DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES = 256 * 1024;
function ticketSymbolReferences(ticket) {
  const candidates = `${ticket?.title || ""}
${ticket?.description || ""}`.matchAll(/`([^`\r\n]+)`/g);
  const symbols = [];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const symbol = String(candidate[1] || "").trim();
    if (symbol.length < 3 || !/[_.]|\(\)/.test(symbol)) continue;
    if (!/^[A-Za-z_$][\w$]*(?:[._][A-Za-z_$][\w$]*)*(?:\(\))?$/.test(symbol)) continue;
    const key = symbol.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push(symbol);
    if (symbols.length >= DISPATCH_SYMBOL_CHECK_MAX) break;
  }
  return symbols;
}
function symbolSearchIsBounded(projectPath, target, scopes) {
  if (!projectPath || !target || scopes.length > DISPATCH_SYMBOL_CHECK_MAX_SCOPES) return false;
  const args = ["ls-tree", "-r", "--name-only", String(target)];
  if (scopes.length) args.push("--", ...scopes);
  try {
    execFileSync("git", args, {
      cwd: projectPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
      maxBuffer: DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES
    });
    return true;
  } catch (_) {
    return false;
  }
}
function symbolExistsOnTarget(projectPath, target, symbol, scopes) {
  const args = ["grep", "-F", "-q", "--", String(symbol), String(target)];
  if (scopes.length) args.push("--", ...scopes);
  const result = spawnSync("git", args, {
    cwd: projectPath,
    windowsHide: true,
    stdio: "ignore",
    timeout: 3e3
  });
  if (result.error || result.signal || result.status == null) return null;
  return result.status === 0;
}
function symbolExistenceWarnings(ticket, slug) {
  const projectPath = slug ? readMeta(slug)?.path : null;
  const symbols = ticketSymbolReferences(ticket);
  if (!projectPath || !symbols.length) return [];
  let target;
  try {
    target = integrationTarget(slug);
  } catch (_) {
    return [];
  }
  const scopes = dispatchDeclaredFiles(ticket);
  if (!symbolSearchIsBounded(projectPath, target.upstream, scopes)) return [];
  const warnings = [];
  for (const symbol of symbols) {
    const exists = symbolExistsOnTarget(projectPath, target.upstream, symbol, scopes);
    if (exists === false) warnings.push(`ticket names \`${symbol}\` but it does not appear on ${target.upstream}; verify this claim before acting.`);
  }
  return warnings;
}
function crossTicketStateWarnings(ticket, slug) {
  if (!ticket || !slug) return [];
  const writtenAt = Date.parse(ticket.referenceUpdatedAt || ticket.updatedAt);
  if (!Number.isFinite(writtenAt)) return [];
  const refs = new Set((String(ticket.description || "").match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  refs.delete(String(ticket.ref || "").toUpperCase());
  const warnings = [];
  for (const ref of refs) {
    const referenced = getTicket(slug, ref);
    const transition = referenced?.statusTransition;
    const changedAt = Date.parse(transition?.at);
    if (!referenced || !Number.isFinite(changedAt) || changedAt <= writtenAt) continue;
    const from = transition.from || "unknown";
    const to = transition.to || referenced.status || "unknown";
    warnings.push(`${ref} changed state (${from} -> ${to}) after this ticket was written; its claims may be stale.`);
  }
  return warnings;
}
function dispatchUncertaintyWarnings(ticket, slug) {
  return [...symbolExistenceWarnings(ticket, slug), ...crossTicketStateWarnings(ticket, slug)].map((warning) => `Dispatch warning: ${warning}`);
}
function dispatchWarnings(ticket, slug) {
  const warnings = dispatchUncertaintyWarnings(ticket, slug);
  const projectPath = slug ? readMeta(slug)?.path : null;
  if (projectPath) {
    const browserReview = readonlyBrowserReviewWarning(ticket);
    if (browserReview) warnings.push(`Dispatch warning: ${browserReview.replace("Planning-depth warning: ", "")}`);
    const verify = verifyCommandWarning(ticket, projectPath);
    if (verify) warnings.push(`Dispatch warning: ${verify.replace("Planning-depth warning: ", "")}`);
    for (const warning of sourceBuildOutputWarnings(ticket, projectPath)) {
      warnings.push(`Dispatch warning: ${warning.replace("Planning-depth warning: ", "")}`);
    }
  }
  if (claudeWebSearchUnavailable(ticket)) {
    warnings.push("Dispatch warning: WebSearch is unavailable on this Claude xhigh/max route. Put web research in a research-category ticket.");
  }
  if (readOnlyOverrideActive(ticket)) {
    warnings.push(ticket.readonlyOverride ? "readonly override active: this ticket closes with done + comment despite its category default." : "readonly override active: this read-only category routes through the writing executor.");
  }
  const contradiction = readonlyCategoryWriteIntentWarning(ticket);
  if (contradiction) warnings.push(`Dispatch warning: ${contradiction}`);
  const worktreeWarning = dispatchState(ticket)?.worktreeWarning;
  if (worktreeWarning) warnings.push(worktreeWarning);
  const categoryId = ticket && (ticket.categoryId || ticket.category && ticket.category.id);
  if (/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || "")) && !String(ticket.executorVerify || "").trim()) {
    warnings.push("Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.");
  }
  warnings.push(...storyContractDriftWarnings(ticket));
  const declaredFiles = dispatchDeclaredFiles(ticket);
  const outside = externalDeclaredFiles(declaredFiles);
  if (outside.length) {
    warnings.push(`Dispatch warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (!slug || !declaredFiles.length) return warnings;
  for (const sibling of listTickets(slug)) {
    if (sibling.id === ticket.id) continue;
    const dispatch2 = dispatchState(sibling);
    const liveClaim = sibling.claim && sibling.claim.by && !claimReclaimable(sibling);
    const liveDispatch = dispatch2 && !dispatch2.terminalAt && ["prepared", "launched", "bound", "claimed"].includes(pulseDispatchState(dispatch2));
    if (!liveClaim && !liveDispatch) continue;
    const overlaps = overlappingScopePaths(declaredFiles, dispatchDeclaredFiles(sibling));
    const contractReasons = contractCollisionReasons(ticket, sibling);
    if (!overlaps.length && !contractReasons.length) continue;
    if (overlaps.length) {
      const lockfilesOnly = overlaps.every((file) => /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(file));
      const lockfileGuidance = lockfilesOnly ? " Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration." : "";
      warnings.push(`Dispatch warning: ${ticket.ref} overlaps in-flight ${sibling.ref} at ${overlaps.join(", ")} — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.${lockfileGuidance}`);
    }
    for (const collision of contractReasons) {
      warnings.push(`Dispatch warning: contract edge with in-flight ${sibling.ref}: ${collision.message} Serialize unless a reviewed contract waiver applies.`);
    }
  }
  return warnings;
}
function dispatchDeclaredFiles(ticket) {
  const dispatch2 = dispatchState(ticket);
  return normalizeFiles(dispatch2 && Array.isArray(dispatch2.declaredFiles) ? dispatch2.declaredFiles : ticket && ticket.files);
}
function externalDeclaredFiles(files) {
  return commitScope.validateRelativeScopes(files).outside;
}
function nonRepoExternalOutput(ticket, files) {
  const declaredFiles = normalizeFiles(files);
  const outside = externalDeclaredFiles(declaredFiles);
  return declaredFiles.length > 0 && outside.length === declaredFiles.length && dispatchReadOnly(ticket);
}
const JUDGMENT_TIER_CATEGORIES = ["coding.normal", "coding.hard", "debugging", "plugin-dev", "ui-frontend"];
const PRESOLVED_BLOCK_MIN_LINES = 20;
const PRESOLVED_BLOCK_MIN_CHARS = 1200;
const EVIDENCE_SHARE = 0.25;
const EVIDENCE_LINE = /^\s*(?:\||at\s+\S.*:\d+:\d+|(?:not )?ok\s|[#$>]\s|(?:npm|node|git|pwsh|PS|yarn|pnpm|cargo|python)\s|(?:\[[^\]]*\]\s*)?(?:ERROR|WARN|INFO|DEBUG|TRACE)\b|(?:pass|fail|tests|suites|skipped|todo|cancelled|duration_ms)\s+\d|[\w.]*(?:Error|Exception):)/;
const EVIDENCE_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DEFINITION_SHAPES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(/m,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+/m,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+[^=\n]*=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*=>|[\w$]+\s*=>)/m,
  /^\s*def\s+[\w$]+\s*\(/m,
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>\[\],\s]+\s+[\w$]+\s*\(/m
];
function fencedBlocks(description) {
  const blocks = [];
  const body = String(description || "");
  const fence = /^[ \t]*```+[ \t]*([^\n`]*)\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
  let match;
  while (match = fence.exec(body)) blocks.push({ info: String(match[1]).trim().toLowerCase(), body: String(match[2]) });
  return blocks;
}
function diffShapedBlock(block) {
  if (/^(?:diff|patch)\b/.test(block.info)) return true;
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block.body)) return true;
  if (/^--- .+\r?\n\+\+\+ /m.test(block.body)) return true;
  const added = (block.body.match(/^\+(?!\+)\s*\S/gm) || []).length;
  const removed = (block.body.match(/^-(?!-)\s*\S/gm) || []).length;
  return added >= 2 && removed >= 2;
}
function evidenceShapedBlock(lines) {
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return true;
  const evidence = filled.filter((line) => EVIDENCE_LINE.test(line) || EVIDENCE_TIMESTAMP.test(line)).length;
  return evidence / filled.length >= EVIDENCE_SHARE;
}
function embedsCompleteEdit(description) {
  for (const block of fencedBlocks(description)) {
    const lines = block.body.split(/\r?\n/);
    if (lines.length < PRESOLVED_BLOCK_MIN_LINES && block.body.length < PRESOLVED_BLOCK_MIN_CHARS) continue;
    if (evidenceShapedBlock(lines)) continue;
    if (diffShapedBlock(block) || DEFINITION_SHAPES.some((shape) => shape.test(block.body))) return true;
  }
  return false;
}
function presolvedRoutingWarnings(ticket) {
  if (!JUDGMENT_TIER_CATEGORIES.includes(String(ticketCategory(ticket) || ""))) return [];
  if (!embedsCompleteEdit(ticket && ticket.description)) return [];
  return ["Planning-depth warning: this description embeds what looks like a complete edit; route by remaining uncertainty, so a fully resolved approach belongs on coding.easy or direct-ok, not a judgment tier."];
}
function ticketPlanningWarnings(ticket, projectPath) {
  if (!ticket) return [];
  const warnings = [];
  const outside = externalDeclaredFiles(ticket.files);
  if (outside.length) {
    warnings.push(`Planning-depth warning: declared paths are outside the repo worktree: ${outside.join(", ")}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (Number(ticket.complexity) >= 4) {
    const missing = [];
    if (!String(ticket.executorAnchors || "").trim()) missing.push("executor anchors");
    if (!String(ticket.executorVerify || "").trim()) missing.push("verify command");
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push("file scope");
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(", ")}.`);
    }
  }
  warnings.push(...presolvedRoutingWarnings(ticket));
  const contradiction = readonlyCategoryWriteIntentWarning(ticket);
  if (contradiction) warnings.push(contradiction);
  const noScope = noDeclaredScopeWarning(ticket);
  if (noScope) warnings.push(noScope);
  const browserReview = readonlyBrowserReviewWarning(ticket);
  if (browserReview) warnings.push(browserReview);
  const verify = verifyCommandWarning(ticket, projectPath);
  if (verify) warnings.push(verify);
  if (!projectPath || !Array.isArray(ticket.files)) return warnings;
  warnings.push(...sourceBuildOutputWarnings(ticket, projectPath));
  const absent = ticket.files.filter((file) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(", ")}.`);
  return warnings;
}
function normalizeReadonlyOverride(value) {
  return typeof value === "boolean" ? value : null;
}
function requestedReadonlyOverride(fields) {
  return normalizeReadonlyOverride(fields?.readonlyOverride === void 0 ? fields?.readonly : fields.readonlyOverride);
}
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function priorityRank(p) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? PRIORITY_RANK[String(p)] ?? 9 : 9;
}
function stableExecutorName(ticket, artifactMode = false) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error("dispatch executor requires a routable ticket.");
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort}.`);
  if (artifactMode || sharedTreeArtifactMode(ticket) || !dispatchReadOnly(ticket)) return resolved.agent;
  return resolved.backend === "codex" ? stableReadOnlyDispatchName(ticket.effort) : stableReadOnlyClaudeName(ticket.effort);
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
function claimTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  const result = withTicketLock(slug, found.id, () => {
    const t2 = getTicket(slug, found.id);
    if (!t2) return { ok: false, reason: "not_found" };
    const delay = testClaimLockDelayMs();
    if (delay) busyWait(delay);
    const directClaimReason = directReason(opts.reason);
    if (opts.direct && isRoutedTicket(t2) && !directClaimReason) return { ok: false, reason: "direct_reason_required", ticket: t2 };
    if (opts.direct && isRoutedTicket(t2) && !directReasonAllowed(directClaimReason)) return { ok: false, reason: "direct_not_allowed", ticket: t2, expectedExecutor: t2.dispatchExecutor || t2.exec?.agent || null };
    if (opts.direct && t2.dispatchNonce) return { ok: false, reason: "direct_conflict", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.token !== t2.dispatchNonce) return { ok: false, reason: "token", ticket: t2 };
    if (!opts.direct && t2.dispatchNonce && opts.executor !== t2.dispatchExecutor) return { ok: false, reason: "executor_mismatch", ticket: t2, expectedExecutor: t2.dispatchExecutor };
    if (!opts.direct && isRoutedTicket(t2) && !t2.dispatchNonce) return { ok: false, reason: "dispatch_required", ticket: t2 };
    if (t2.status === "done") return { ok: false, reason: "done", ticket: t2 };
    const currentDispatch = dispatchState(t2);
    if (currentDispatch?.resumedAt && isolatedDispatchWorktreeMissing(currentDispatch)) return { ok: false, reason: "worktree_missing", ticket: t2 };
    if (pendingSubmission(t2) && !opts.force) return { ok: false, reason: "submitted", ticket: t2, submission: t2.submission };
    const held2 = t2.claim;
    if (held2 && held2.by && held2.by !== by && !claimReclaimable(t2) && !opts.force) {
      return { ok: false, reason: "claimed", ticket: t2, claim: held2 };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    t2.claim = { by, at: now };
    if (t2.storyId) {
      const story = getStory(slug, t2.storyId);
      if (story) t2.storyLogSeenSeq = Number(story.logRevision) || 0;
    }
    t2.claimRelease = null;
    if (opts.direct && isRoutedTicket(t2)) {
      t2.directClaim = {
        by,
        at: now,
        model: t2.model,
        effort: t2.effort,
        executor: opts.executor ? String(opts.executor) : null,
        source: opts.source ? String(opts.source) : "store",
        reason: directReason(opts.reason)
      };
    }
    const state = dispatchState(t2);
    if (state) {
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = "claimed";
    }
    const previousStatus = t2.status;
    if (opts.status !== false) t2.status = coerceStatus(opts.status || "doing", t2.status);
    if (t2.status !== previousStatus) t2.statusTransition = { from: previousStatus, to: t2.status, at: now };
    if (state) stampDispatchEvent(t2, opts.source || "cli", now);
    else {
      t2.lastEventType = "status";
      t2.lastEventSource = opts.source ? String(opts.source) : "cli";
      t2.updatedAt = now;
    }
    putTicket(slug, t2);
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t2.id, by);
    queueEventNotification(slug, t2, t2.lastEventType, t2.lastEventSource);
    return { ok: true, ticket: t2 };
  });
  if (result.reason !== "busy" || opts.force) return result;
  const t = getTicket(slug, found.id);
  const held = t && t.claim;
  if (held && held.by && held.by !== by && !claimReclaimable(t)) {
    return { ok: false, reason: "claimed", ticket: t, claim: held };
  }
  return result;
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
function releaseTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const releaseComment = opts.releaseComment ? prepareComment(opts.releaseComment) : null;
  if (releaseComment && !releaseComment.ok) throw new Error(`release comment ${releaseComment.reason}`);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: "not_found" };
    if (t.status === "done" && !opts.force) {
      const completion = t.completion;
      const key = completion && [t.id, completion.claimAt || completion.at, by, "done"].join(":");
      if (opts.status === "done" && completion && completion.key === key && completion.by === by && completion.state === "done") {
        const comment2 = Array.isArray(t.comments) && completion.commentId ? t.comments.find((entry) => entry.id === completion.commentId) || null : null;
        return { ok: true, idempotent: true, ticket: t, comment: comment2 };
      }
      return { ok: false, reason: "done", ticket: t };
    }
    let reopenedSubmission = null;
    if (opts.status && pendingSubmission(t)) {
      const reopenStatus = coerceStatus(opts.status, t.status);
      if (reopenStatus !== "done") {
        if (!opts.force) {
          return {
            ok: false,
            reason: "pending_submission",
            ticket: t,
            submission: t.submission,
            message: `${t.ref} has a pending submission (commit ${String(t.submission.commit).slice(0, 12)}) parked READY_FOR_INTEGRATION. release cannot move it to "${reopenStatus}" and leave the submission in place. CLI: pass --force to reject the submission and reopen in one step, or run \`sidequest submit ${t.ref} --clear --status ${reopenStatus}\` first. MCP: \`submit\` with \`clear:true, status:"${reopenStatus}"\` (release has no force param over MCP).`
          };
        }
        reopenedSubmission = t.submission;
      }
    }
    const controlPlaneDone = opts.status === "done" && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    const executorDone = opts.status === "done" && !controlPlaneDone;
    const dispatch2 = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch2 && Array.isArray(dispatch2.declaredFiles) ? dispatch2.declaredFiles : normalizeFiles(t.files);
    const held = t.claim;
    const liveClaim = Boolean(held && held.by);
    const activeDispatch = Boolean(t.dispatchNonce || dispatch2 && !dispatch2.terminalAt);
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch2?.nonRepoOutput === true && liveClaim && activeDispatch;
    const activeReadOnlyDispatch = dispatch2?.readonly === true && liveClaim && activeDispatch;
    let sharedTreeCommittedScope = false;
    if (executorDone && liveClaim && activeDispatch) {
      const delta = dispatchDelta(slug, t);
      if (!delta.ok && dispatch2?.sharedTree === true && dispatch2?.baseCommit) {
        return {
          ok: false,
          reason: "dispatch_delta_unavailable",
          message: `${t.ref} cannot inspect the full dispatch delta before done closeout. Restore the dispatch worktree or release the ticket and dispatch again.`,
          ticket: t
        };
      }
      if (delta.ok && !activeArtifactDispatch) {
        const scopedCommitted = delta.committed.filter((file) => commitScope.isInScope(file, declaredFiles));
        sharedTreeCommittedScope = dispatch2?.sharedTree === true && scopedCommitted.length > 0;
        const scopedWorking = delta.working.filter((file) => commitScope.isInScope(file, declaredFiles));
        const scopedChanges = activeReadOnlyDispatch ? Array.from(/* @__PURE__ */ new Set([...scopedWorking, ...scopedCommitted])) : [];
        if (scopedChanges.length) {
          const paths = scopedChanges.sort();
          const mode = activeReadOnlyDispatch ? "read-only dispatch" : "declared scope";
          return {
            ok: false,
            reason: "done_scope_violation",
            message: `${t.ref} cannot close with done: ${mode} has dirty or committed paths inside its declared scope since dispatch base: ${paths.join(", ")}. Scoped-commit work that belongs to this ticket after a scope request, or restore the paths that do not.`,
            ticket: t,
            unscopedPaths: paths
          };
        }
      }
    }
    if (executorDone && activeArtifactDispatch) {
      const scopeCheck = artifactScopeCheck(slug, t, dispatch2);
      if (!scopeCheck.ok) return Object.assign({ ticket: t }, scopeCheck);
    }
    if (executorDone && !liveClaim && t.claimRelease) {
      return {
        ok: false,
        reason: "claim_released",
        message: autoReleasedClaimMessage(t.ref, t.claimRelease),
        ticket: t,
        claimRelease: t.claimRelease
      };
    }
    const provenNoOp = opts.cleanDeclaredScope === true;
    if (executorDone && dispatch2 && declaredFiles.length && !provenNoOp && !sharedTreeCommittedScope && !activeReadOnlyDispatch && !activeArtifactDispatch && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: "submission_required",
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. A read-only dispatch may close with done, but readonly:false selects this write path. A run that changed nothing closes here by itself once the board can see its worktree, so this refusal means the change is real or the worktree is unreadable. If the only declared output is outside the repo worktree, release it for reclassification as non-repo/artifact work; do not retry commit.`,
        ticket: t
      };
    }
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    const oracleRequested = nullableText(opts.oracle);
    if (oracleRequested && coerceStatus(opts.status || t.status, t.status) !== "doing") {
      throw new Error("oracle release must keep the ticket in doing");
    }
    if (oracleRequested && t.oracle) {
      throw new Error("ticket already awaits an oracle verdict");
    }
    if (oracleRequested) oracleMarker(dispatch2, opts, null);
    if (opts.requireReleaseVerdict && !claimReleaseVerdict(t)) {
      return {
        ok: false,
        reason: "claim_live",
        message: `${t.ref} is still live-claimed by "${held && held.by}"; the sweep re-checked it under the lock and left it alone.`,
        ticket: t,
        claim: held
      };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previousStatus = t.status;
    if (resumableScopePause(t)) captureScopePauseRecovery(slug, t);
    let comment = null;
    if (releaseComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(releaseComment, now);
      t.comments.push(comment);
    }
    clearScopeRequestMarker(t);
    t.scopeRequest = null;
    if (oracleRequested) t.oracle = oracleMarker(dispatch2, opts, now);
    t.claim = null;
    if (opts.claimRelease) {
      t.claimRelease = Object.assign({ by, at: now, source: opts.source || "store" }, opts.claimRelease);
    }
    setDispatchTerminal(t, opts.status === "done" ? "done" : "released", opts.source || "cli");
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (reopenedSubmission) t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    if (t.status === "todo" && (previousStatus !== "todo" || held && held.by)) {
      appendReworkEvent(t, "released_to_todo", {
        at: now,
        source: opts.source || "cli",
        by,
        fromStatus: previousStatus,
        toStatus: t.status
      });
    }
    if (reopenedSubmission) {
      appendReworkEvent(t, "submission_cleared", {
        at: now,
        source: opts.source || "cli",
        by,
        fromStatus: previousStatus,
        toStatus: t.status
      });
    }
    if (opts.workedBy) t.workedBy = opts.workedBy;
    if (t.status === "done") {
      t.completion = {
        key: [t.id, held && held.at ? held.at : now, by, "done"].join(":"),
        by,
        state: "done",
        claimAt: held && held.at ? held.at : null,
        at: now,
        commentId: null,
        ...opts.completionProvenance || {}
      };
      if (opts.completionComment) {
        if (!Array.isArray(t.comments)) t.comments = [];
        comment = createComment(opts.completionComment, now);
        t.comments.push(comment);
        t.completion.commentId = comment.id;
      }
    }
    if (t.status === "done" && pendingSubmission(t)) {
      t.submission = Object.assign({}, t.submission, { integratedAt: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (dispatch2) stampDispatchEvent(t, opts.source || "cli", now);
    else {
      t.lastEventType = "status";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = now;
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
    return {
      ok: true,
      ticket: t,
      comment,
      ...reopenedSubmission ? { clearedSubmission: reopenedSubmission } : {},
      ...opts.completionComment && opts.completionComment.advisory ? { advisory: opts.completionComment.advisory } : {}
    };
  });
}
function makeWorkedBy(input) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === "") return null;
  const model = normalizeReportedModel(rawModel) || (input.allowUnavailable ? String(rawModel).trim().toLowerCase() : null);
  if (!model || !input.allowUnavailable && !availableRoute(model)) {
    throw new Error(`invalid model "${rawModel}" — expected an available Claude runtime or discovered Codex model`);
  }
  let effort = null;
  const rawEffort = input.effort;
  if (rawEffort != null && String(rawEffort).trim() !== "") {
    const e = String(rawEffort).trim().toLowerCase();
    if (VALID_EFFORTS.indexOf(e) === -1) {
      throw new Error(`invalid effort "${rawEffort}" — expected one of: ${VALID_EFFORTS.join(", ")} (or omit for none)`);
    }
    effort = e;
  }
  const by = input.by != null && String(input.by).trim() ? String(input.by).trim() : null;
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
  return { model, effort, by, at };
}
function completeTicket(slug, idOrRef, by, opts) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  const dispatched = resolvedDispatchRoute(ticket);
  const omittedProvenance = (opts.model == null || String(opts.model).trim() === "") && (opts.effort == null || String(opts.effort).trim() === "");
  const workedBy = makeWorkedBy({
    model: omittedProvenance && dispatched ? dispatched.model : opts.model,
    effort: omittedProvenance && dispatched ? dispatched.effort : opts.effort,
    by,
    allowUnavailable: Boolean(ticket && opts.model != null && normalizeRouteModel(opts.model) === normalizeRouteModel(ticket.model))
  });
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: "comment", source: opts.source || "cli" });
    if (!completionComment.ok) {
      throw new Error(`completion comment ${completionComment.reason}`);
    }
  }
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, {
    status: "done",
    workedBy,
    completionComment
  }));
}
function recordedReviewPass(ticket) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || "")));
}
const HIGH_STAKES_REVIEW_WARNING = "high-stakes ticket integrated without a recorded review pass";
function completeTicketAsControlPlane(slug, idOrRef, opts) {
  opts = opts || {};
  const purpose = String(opts.purpose || "").trim();
  if (!["grooming", "integration"].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming" or "integration".');
  }
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "not_found" };
  const state = dispatchState(ticket);
  if (purpose === "grooming") {
    if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket) || ticket.dispatchNonce || state && !state.terminalAt) {
      const holder = ticket.claim && ticket.claim.by ? String(ticket.claim.by) : "<claim holder>";
      return {
        ok: false,
        reason: "active_dispatch",
        message: `${ticket.ref} still has a live claim or an open dispatch, so grooming cannot close it. Release it first: \`sidequest release ${ticket.ref} --by ${holder}\`, then re-run this closure with the same evidence. Releasing does not discard work already committed.`,
        ticket
      };
    }
    if (pendingSubmission(ticket)) return { ok: false, reason: "pending_submission", ticket };
  }
  if (purpose === "integration" && !pendingSubmission(ticket)) {
    return {
      ok: false,
      reason: "submission_required",
      message: `${ticket.ref} has no submission to consume, so an integration closure has nothing to integrate. A submission only exists after its executor ran commit and then submit. When the work shipped outside that flow — the usual case is the orchestrator committing an executor's changes out of the shared tree after it lost its worktree — release the claim (\`sidequest release ${ticket.ref} --by <claim holder>\`) and close it as plain grooming with the shipped commit as evidence, without --integration.`,
      ticket
    };
  }
  const reason = String(opts.reason || "").trim();
  if (!reason) return { ok: false, reason: "evidence_required", ticket };
  const by = String(opts.by || "").trim();
  if (!by) return { ok: false, reason: "identity_required", ticket };
  let legacyScopeOverride = false;
  if (purpose === "integration") {
    const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
    if (!admitted.ok) return admitted;
    legacyScopeOverride = !!admitted.legacyScopeOverride;
  }
  const advisory = purpose === "integration" && ticket.highStakes && !recordedReviewPass(ticket) ? HIGH_STAKES_REVIEW_WARNING : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: Object.assign(
      { authority: "control-plane", purpose, reason },
      legacyScopeOverride ? { legacyScopeOverride: { reason } } : {}
    )
  }));
  return advisory ? Object.assign(result, { advisory }) : result;
}
function closeTicketForGrooming(slug, idOrRef, opts) {
  return completeTicketAsControlPlane(slug, idOrRef, Object.assign({}, opts, { purpose: "grooming" }));
}
function sweepStaleDispatches(opts) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : "sweep";
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const expired = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === "done" || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
      try {
        const res = withTicketLock(project.slug, ticket.id, () => {
          const current = getTicket(project.slug, ticket.id);
          if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
          setDispatchTerminal(current, "expired", source);
          current.dispatchNonce = null;
          current.dispatchExecutor = null;
          stampDispatchEvent(current, source);
          putTicket(project.slug, current);
          return { ok: true, ticket: current };
        });
        if (!res || !res.ok) continue;
        expired.push({ project: project.slug, ref: res.ticket.ref });
        addComment(project.slug, ticket.id, {
          by: "sidequest",
          kind: "comment",
          source,
          body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 36e5)} hour TTL.`
        });
      } catch (_) {
      }
    }
  }
  return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
}
function sweepStaleClaims(opts) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : "sweep";
  const released = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === "done") continue;
      const verdict = claimReleaseVerdict(ticket);
      if (!verdict) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, {
          status: "todo",
          source,
          requireReleaseVerdict: true,
          claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null }
        });
        if (!res.ok) continue;
        released.push({ project: project.slug, ref: ticket.ref, kind: verdict.kind });
        addComment(project.slug, ticket.id, {
          by: "sidequest",
          kind: "comment",
          source,
          body: claimReleaseNote(ticket, verdict)
        });
      } catch (_) {
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, idleMs: claimIdleMs(), abandonMs: claimAbandonMs(), released, expiredDispatches: dispatches.expired };
}
function modelMatches(ticketModel, want) {
  return !want || ticketModel === want;
}
function readyTickets(slug, opts) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : "any";
  if (want === "unknown") throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || claimReclaimable(t)).filter((t) => !isBlocked(slug, t)).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}
function claimNext(slug, by, opts) {
  opts = opts || {};
  by = String(by || "agent");
  const want = opts.model ? classifyModelFilter(opts.model) : "any";
  if (want === "unknown") throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  const candidates = listTickets(slug).filter((t) => !t.archived).filter((t) => t.status !== "done").filter((t) => !pendingSubmission(t)).filter((t) => !t.claim || claimReclaimable(t) || t.claim.by === by).filter((t) => !opts.priority || t.priority === String(opts.priority).toLowerCase()).filter((t) => modelMatches(t.model, want === "any" ? null : want)).filter((t) => !category || t.categoryId === category).filter((t) => opts.includeBlocked || !isBlocked(slug, t)).sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { direct: !!opts.direct, reason: opts.reason, source: opts.source, sessionId: opts.sessionId });
    if (res.ok || res.reason === "direct_not_allowed" || res.reason === "direct_reason_required") return res;
  }
  return { ok: false, reason: "empty" };
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
function claimPulse(ticket, now) {
  const claim = ticket && ticket.claim;
  if (!claim || !claim.by) return null;
  const atMs = Date.parse(claim.at);
  const idleMs = claimIdleAge(ticket, now);
  const verdict = claimReleaseVerdict(ticket, now);
  return {
    by: claim.by,
    at: claim.at,
    ageMs: Number.isFinite(atMs) ? Math.max(0, now - atMs) : null,
    idleMs: Number.isFinite(idleMs) ? idleMs : null,
    reclaimable: verdict ? verdict.kind : null,
    verifying: Boolean(claimVerification(ticket))
  };
}
function readServerInfo() {
  return readGlobal("server-info", null);
}
function writeServerInfo(info) {
  writeGlobal("server-info", info);
}
function clearServerInfo() {
  deleteCachedRow(database(), "globals", "server-info");
}
const stories = createStories({
  autoStoryColor,
  claimReclaimable,
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
  STORY_DECISION_LOG_MAX_BYTES,
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
  updateStory
} = stories;
const { boundedExcerpt, changesPayload, commentHistory, pulsePayload } = createPulse({
  boardConfig,
  checkpointProjection,
  claimPulse,
  claimReleaseVerdict,
  claimVerification,
  dispatchState,
  execFileSync,
  getTicket,
  listTickets,
  normalizeRoute,
  oracleProjection,
  pulseDispatchState,
  readMeta,
  storyContractDriftWarnings,
  storyDecisionLogWarnings,
  submissionProjection
});
module.exports = {
  VALID_STATUS,
  VALID_PRIORITY,
  VALID_EFFORTS,
  CLAUDE_RUNTIMES,
  ROUTING_FALLBACK_DEFAULT,
  EXECUTOR_ANCHORS_MAX,
  EXECUTOR_VERIFY_MAX,
  DECLARED_FILES_MAX,
  CONTRACT_NAMES_MAX,
  LABELS_MAX,
  DISPATCH_DESCRIPTION_MIN,
  dispatchDescriptionError,
  dispatchDeclaredFiles,
  dispatchWorkspace,
  dispatchWarnings,
  dispatchUncertaintyWarnings,
  ticketReferenceWarnings,
  ticketCategoryWarnings,
  ticketPlanningWarnings,
  coerceComplexity,
  legacyCategoryForComplexity,
  applyDerivedRouting,
  getModelVocab,
  modelsPayload,
  routingModels,
  resolveModelId,
  resolveExec,
  resolveReportedExec,
  normalizeReportedModel,
  resolvedDispatchRoute,
  spawnDescription,
  SHARED_TREE_ARTIFACT_MARKER,
  sharedTreeArtifactRequested,
  categoryArtifactRoot,
  sharedTreeArtifactMode,
  resolveCategoryRoute,
  claudeQuotaFailure,
  classifyModelFilter,
  getRoutingFallback,
  setRoutingFallback,
  mutateRoutingPolicy,
  routingProfileSettings,
  listRoutingProfiles,
  routingProfileDetails,
  createRoutingProfile,
  editRoutingProfile,
  retireRoutingProfile,
  routingProfileHygiene,
  repointRoutingProfiles,
  promoteRoutingProfile,
  getRoutingProfile,
  projectRoutingProfile,
  setProjectRoutingProfile,
  setNewProjectRoutingProfile,
  routingProfileEntries,
  routingProfileCategory,
  setRoutingProfileCategory,
  removeRoutingProfileCategory,
  getCategories,
  getCategoryRoutePairs,
  getCategory,
  getProjectCategories,
  setProjectCategory,
  detachCategory,
  removeProjectCategory,
  setCategory,
  removeCategory,
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
  validateIntegrationSubmission,
  integrateSubmission,
  verifyIntegration,
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
  PLAN_ASSET_NAME,
  PLAN_BODY_MAX_BYTES,
  writeTicketPlan,
  ticketPlanInfo,
  appendExperimentEntry,
  applyExperimentVerdict,
  appendOverturnLine,
  experimentPacket,
  listTickets,
  worktreeGcTickets,
  worktreeGcProjects,
  listAllProjectTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  stableExecutorName,
  prepareDispatch,
  readDispatchBriefing,
  isSupersededDispatchToken,
  recordDispatchLaunch,
  recoverDispatchQuotaFailure,
  bindDispatchAgent,
  dispatchIsolationExpectation,
  activeSharedTreeClaim,
  isolatedDispatchWithMissingWorktree,
  terminalDispatchTarget,
  terminalDispatchForIdle,
  markDispatchStopped,
  reconcileLaunchedDispatches,
  claimTicket,
  releaseTicket,
  completeTicket,
  completeTicketAsControlPlane,
  closeTicketForGrooming,
  makeWorkedBy,
  checkpointTicket,
  checkpointProjection,
  oracleProjection,
  clearOracleMarker,
  checkpointTtlMs,
  DEFAULT_CHECKPOINT_TTL_MIN,
  MAX_CHECKPOINT_TTL_MIN,
  submitTicket,
  clearSubmission,
  pendingSubmission,
  submissionReadiness,
  submissionBaseCandidates,
  submissionsPayload,
  claimNext,
  assignTicket,
  readyTickets,
  readyWaves,
  readyWaveDependencies,
  scopesOverlap,
  normalizeFiles,
  scopeExpansionFiles,
  scopeExpansionCommand,
  pendingScopeApprovalWarning,
  requestScope,
  normalizeContracts,
  contractCollisionReasons,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_DECISION_LOG_MAX_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  storyExecutionContract,
  normalizeStoryLogEntry,
  storyDecisionLog,
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
  claimPulse,
  changesPayload,
  boundedExcerpt,
  commentHistory,
  archiveTicket,
  unarchiveTicket,
  archiveAllDone,
  listArchived,
  listActive,
  autoReleasedClaimMessage,
  claimReclaimable,
  claimReleaseVerdict,
  claimActivityMs,
  touchClaim,
  claimIdleMs,
  claimAbandonMs,
  preparedDispatchTtlMs,
  DEFAULT_CLAIM_IDLE_MIN,
  DEFAULT_CLAIM_ABANDON_MIN,
  DEFAULT_PREPARED_DISPATCH_TTL_HOURS,
  sweepStaleClaims,
  sweepStaleDispatches,
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
  registerWorker,
  unregisterClaim,
  markLongRunFlagged,
  reconcileSession,
  sessionClaims
};
