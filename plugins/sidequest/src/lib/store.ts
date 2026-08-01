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
const { dispatchLaunchName, stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require('./exec-names.js');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const db = require('./db.js');
const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, STARTER_ROUTING_PROFILES } = require('./category-defaults.js');
const commitScope = require('./commit-scope.js');
const { migrateIfNeeded } = require('./migrate.js');
const { discoverExternalModels, providerReadiness } = require('./discovery.js');
const telemetry = require('./telemetry.js');
const { routingDisabledMessage } = require('./refusal-guidance.js');
const { assertSidequestInstall, assertDispatchTransport } = require('./dispatch-preflight.js');
const { createAssets } = require('./store/assets.js');
const { createNotifications } = require('./store/notifications.js');
const { createWorkers } = require('./store/workers.js');
const { createStories } = require('./store/stories.js');
const { createComments } = require('./store/comments.js');
const { createPlans } = require('./store/plans.js');
const { createReads } = require('./store/reads.js');
const { createClaims } = require('./store/claims.js');
const { createLocks } = require('./store/locks.js');
const { createPulse } = require('./store/pulse.js');
const { createRouting } = require('./store/routing.js');
const { createTickets } = require('./store/tickets.js');
const { createSubmissions } = require('./store/submissions.js');
const { createDispatch } = require('./store/dispatch.js');

let dispatch: any;
function dispatchState(...args: any[]) { return dispatch.dispatchState(...args); }
function activeDispatchRoute(...args: any[]) { return dispatch.activeDispatchRoute(...args); }
function refreshPreparedDispatches(...args: any[]) { return dispatch.refreshPreparedDispatches(...args); }

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
  applyDerivedRouting,
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
  dispatchState,
});




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
  reconcileLaunchedDispatches,
} = (dispatch = createDispatch({
  ARTIFACT_BASELINE_MAX_PATHS,
  normalizeCategoryId: (...args: any[]) => normalizeCategoryId(...args),
  projectRoutingEnabled,
  routingDisabledMessage,
  getTicket,
  dispatchLaunchName,
  nextDispatchLaunchSeq,
  integrationTargetCommit,
  spawnDescription,
  claudeQuotaFailure: (...args: any[]) => claudeQuotaFailure(...args),
  SHARED_TREE_ARTIFACT_MARKER,
  assertDispatchTransport,
  assertSidequestInstall,
  availableRoute: (...args: any[]) => availableRoute(...args),
  captureScopePauseRecovery: (...args: any[]) => captureScopePauseRecovery(...args),
  claimReclaimable: (...args: any[]) => claimReclaimable(...args),
  claimVerification: (...args: any[]) => claimVerification(...args),
  commitScope,
  crypto,
  database,
  db,
  dispatchReadOnly: (...args: any[]) => dispatchReadOnly(...args),
  dispatchRouteRefusal: (...args: any[]) => dispatchRouteRefusal(...args),
  dispatchRouteState: (...args: any[]) => dispatchRouteState(...args),
  execFileSync,
  execProjection: (...args: any[]) => execProjection(...args),
  fs,
  getCategory: (...args: any[]) => getCategory(...args),
  getStory: (...args: any[]) => getStory(...args),
  integrationTarget,
  legacyCategoryForComplexity: (...args: any[]) => legacyCategoryForComplexity(...args),
  listProjects,
  listTickets,
  nonRepoExternalOutput,
  normalizeArtifactRoots: (...args: any[]) => normalizeArtifactRoots(...args),
  normalizeFiles: (...args: any[]) => normalizeFiles(...args),
  normalizeRoute: (...args: any[]) => normalizeRoute(...args),
  normalizeWorktreeIsolation,
  path,
  preparedDispatchTtlMs: (...args: any[]) => preparedDispatchTtlMs(...args),
  putTicket,
  readMeta,
  resolveCategoryFallback: (...args: any[]) => resolveCategoryFallback(...args),
  resolveCategoryRoute: (...args: any[]) => resolveCategoryRoute(...args),
  resolveExec: (...args: any[]) => resolveExec(...args),
  resumableScopePause: (...args: any[]) => resumableScopePause(...args),
  stableExecutorName,
  storyExecutionContract: (...args: any[]) => storyExecutionContract(...args),
  ticketCategory: (...args: any[]) => ticketCategory(...args),
  ticketStorageRow,
  withTicketLock: (...args: any[]) => withTicketLock(...args),
}));

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

function homeRoot() {
  const env = process.env.SIDEQUEST_HOME;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(os.homedir(), '.claude', 'sidequest');
}

function projectsRoot() {
  return path.join(homeRoot(), 'projects');
}

function serverFile() {
  return path.join(homeRoot(), 'server.json');
}

// Windows paths are case-insensitive; normalize case for a stable hash so the
// same folder always maps to the same slug regardless of how it was typed.
function normalizeForHash(absPath?: any) {
  const p = path.resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function slugify(absPath?: any) {
  const base = path
    .basename(path.resolve(absPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalizeForHash(absPath)).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

// A git worktree's `.git` is a FILE, not a directory:
//     gitdir: C:/dev/repo/.git/worktrees/<name>
// Given that file, resolve the MAIN worktree root that owns it (C:\dev\repo)
// so a worktree never mints its own board. Returns null when this isn't a
// linked worktree we can trust locally, and the caller keeps today's behavior:
//   - the entry is a `.git` DIRECTORY (a real clone root) — not our job
//   - the gitdir points at `.../modules/...` (a submodule — a separate repo)
//   - the gitdir is missing/malformed, or points off THIS machine (a remote
//     clone, a container mount, another OS) so the computed root isn't real here
// Fail-soft throughout: any error returns null.
function mainWorktreeRoot(gitEntry?: any) {
  let stat: any;
  try {
    stat = fs.statSync(gitEntry);
  } catch (_: any) {
    return null;
  }
  if (!stat.isFile()) return null; // a `.git` dir is a real repo root, leave it
  let content: any;
  try {
    content = fs.readFileSync(gitEntry, 'utf8');
  } catch (_: any) {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  // gitdir is normally absolute; resolve relative forms against the worktree dir.
  let gitdir = m[1]!.replace(/[/\\]+$/, '');
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(path.dirname(gitEntry), gitdir);
  // Only linked worktrees (.git/worktrees/<name>) fold home. Submodules
  // (.git/modules/<name>) and anything else stay their own board.
  const parts = gitdir.split(/[/\\]+/);
  const wtIdx = parts.lastIndexOf('worktrees');
  if (wtIdx < 1) return null;
  // parts[0..wtIdx) is `.../.git`; the main worktree root is one level above it.
  const gitDirPath = parts.slice(0, wtIdx).join(path.sep);
  const root = path.dirname(gitDirPath);
  // Trust it only if that root actually exists on THIS filesystem — otherwise
  // the worktree points at a repo that isn't here, and we must not anchor a
  // board onto a phantom path.
  try {
    if (fs.statSync(root).isDirectory()) return path.resolve(root);
  } catch (_: any) { /* off-machine / moved — fall through to null */ }
  return null;
}

// Resolve startDir to the root of the project the agent is actually working in,
// so a board is always anchored there — never on a worktree, and never on a bare
// subfolder. Precedence, safest-first:
//
//   1. A path inside `<root>\.claude\worktrees\<name>` (the EnterWorktree
//      convention) folds straight back to <root>. Pure string match, no fs
//      trust: the worktree checkout may carry its OWN committed `.claude`, which
//      must NOT win — keying on the outermost `.claude/worktrees` guarantees the
//      real project root regardless.
//   2. Walk up to the nearest `.git`. A `.git` FILE is a linked worktree — fold
//      it to its main worktree root (works wherever the worktree sits on disk,
//      even far from the repo, because the file points home). A `.git` DIRECTORY
//      is a real clone root and wins, so a genuine nested/vendored repo keeps its
//      own board just like before.
//   3. A worktree we can't resolve locally (gitdir missing, off-machine, a
//      submodule) or a plain non-repo folder is returned unchanged — a
//      self-contained board on the dir you're actually in. Today's behavior.
//
// Fail-soft: any fs error stops the walk and falls back to the resolved startDir.
function nearestRepoRoot(startDir?: any) {
  const start = path.resolve(startDir);

  // (1) EnterWorktree fast path — deterministic, no filesystem trust required.
  const wt = /^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/i.exec(start + path.sep);
  if (wt && wt[1]) {
    const owner = path.resolve(wt[1]);
    try {
      if (fs.statSync(owner).isDirectory()) return owner;
    } catch (_: any) { /* owner gone — fall through to the git walk */ }
  }

  // (2) + (3) Walk up to the enclosing `.git`.
  let dir = start;
  for (;;) {
    try {
      const entry = path.join(dir, '.git');
      if (fs.existsSync(entry)) {
        return mainWorktreeRoot(entry) || dir;
      }
    } catch (_: any) {
      return start;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // hit the filesystem root without a repo
    dir = parent;
  }
}

function projectDir(slug?: any) {
  return path.join(projectsRoot(), slug);
}
function ticketsDir(slug?: any) {
  return path.join(projectDir(slug), 'tickets');
}
function assetsDir(slug?: any, id?: any) {
  return path.join(projectDir(slug), 'assets', id);
}

/* ------------------------------------------------------------------ *
 *  SQLite persistence
 * ------------------------------------------------------------------ */

const dbByHome = new Map<string, any>();
const transactionDepth = new WeakMap<object, number>();

interface StoreCache {
  dataVersion: number;
  metadata: Map<string, any>;
  projectCategories: Map<string, any[]>;
  routingProfiles: Map<string, any>;
  routingProfileEntries: Map<string, any[]>;
  projectRoutingProfiles: Map<string, any>;
  routingProfileSettings: any | undefined;
  routingFallback: any | undefined;
  snapshots: Map<string, any>;
}

const storeCacheByDatabase = new WeakMap<object, StoreCache>();

function sqliteDataVersion(handle: any): number {
  const row = handle.prepare('PRAGMA data_version').get();
  return Number(row && row.data_version) || 0;
}

function newStoreCache(dataVersion: number): StoreCache {
  return {
    dataVersion,
    metadata: new Map<string, any>(),
    projectCategories: new Map<string, any[]>(),
    routingProfiles: new Map<string, any>(),
    routingProfileEntries: new Map<string, any[]>(),
    projectRoutingProfiles: new Map<string, any>(),
    routingProfileSettings: undefined,
    routingFallback: undefined,
    snapshots: new Map<string, any>(),
  };
}

function residentCache(): StoreCache {
  const handle = database();
  const dataVersion = sqliteDataVersion(handle);
  let cache = storeCacheByDatabase.get(handle);
  if (!cache || cache.dataVersion !== dataVersion) {
    cache = newStoreCache(dataVersion);
    storeCacheByDatabase.set(handle, cache);
  }
  return cache;
}

function invalidateStoreCaches(): void {
  const handle = database();
  storeCacheByDatabase.set(handle, newStoreCache(sqliteDataVersion(handle)));
}

function putCachedRow(handle: any, table: any, row: any): any {
  const result = db.putRow(handle, table, row);
  invalidateStoreCaches();
  return result;
}

function deleteCachedRow(handle: any, table: any, key: any): boolean {
  const deleted = db.deleteRow(handle, table, key);
  if (deleted) invalidateStoreCaches();
  return deleted;
}

function cloneCached<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function ensureDir(dir?: any) {
  fs.mkdirSync(dir, { recursive: true });
}

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
  touchClaimActivity,
} = createClaims({
  dispatchState,
  fs,
  getTicket,
  putTicket,
  withTicketLock,
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
  recordClaimVerification,
  touchClaimActivity,
  withTicketLock,
});

const {
  PLAN_ASSET_NAME,
  PLAN_BODY_MAX_BYTES,
  appendExperimentEntry,
  appendOverturnLine,
  applyExperimentVerdict,
  experimentPacket,
  ticketPlanInfo,
  writeTicketPlan,
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
  listActive,
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
  withTicketLock,
});

function pendingSubmissionForTickets(...args: any[]) {
  return pendingSubmission(...args);
}

function checkpointProjectionForRead(...args: any[]) {
  return checkpointProjection(...args);
}

function oracleProjectionForRead(...args: any[]) {
  return oracleProjection(...args);
}

function submissionReadinessForRead(...args: any[]) {
  return submissionReadiness(...args);
}

const {
  briefTicket,
  listPayload,
  readyPayload,
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
  submissionReadiness: submissionReadinessForRead,
});

const {
  markLongRunFlagged,
  reconcileSession,
  registerWorker,
  sessionClaims,
  unregisterClaim,
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
  writeGlobal,
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
  submissionsPayload,
} = createSubmissions({
  EXECUTOR_VERIFY_MAX,
  INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES,
  MANUAL_VERIFY_PREFIX,
  addComment,
  appendReworkEvent,
  autoReleasedClaimMessage,
  boardConfig,
  boundedExcerptForSubmission: (...args: any[]) => boundedExcerpt(...args),
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
  withTicketLock,
});

function refreshRoutingProfileSeeds(handle?: any) {
  const pending: any[] = [];
  for (const seed of STARTER_ROUTING_PROFILES) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null || Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION) continue;
    pending.push({ seed, profileId: profile.id });
  }
  if (!pending.length) return;
  db.txn(handle, () => {
    const now = new Date().toISOString();
    const affected = new Set<string>();
    for (const { seed, profileId } of pending) {
      handle.prepare('DELETE FROM routing_profile_entries WHERE profile_id = ?').run(profileId);
      seed.categories.forEach((category?: any, position?: any) => {
        handle.prepare(`
          INSERT INTO routing_profile_entries (profile_id, category_id, data, position, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(profileId, category.id, JSON.stringify(category), position, now);
      });
      handle.prepare(`
        UPDATE routing_profiles SET name = ?, description = ?, seed_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(seed.name, seed.description, ROUTING_PROFILE_SEED_REVISION, now, profileId);
      for (const row of handle.prepare('SELECT project FROM project_routing_profiles WHERE profile_id = ?').all(profileId)) {
        affected.add(String(row.project));
      }
    }
    refreshPreparedDispatches(handle, [...affected], null);
  });
}

function refreshReadonlyCategorySeeds(handle?: any) {
  const readonlyIds = new Set([
    ...DEFAULT_CATEGORIES.filter((category: any) => category.readonly === true).map((category: any) => category.id),
    'hand-analysis',
  ]);
  const affected = new Set<string>();
  let changed = false;
  db.txn(handle, () => {
    const updateProfileEntry = handle.prepare('UPDATE routing_profile_entries SET data = ?, updated_at = ? WHERE profile_id = ? AND category_id = ?');
    const updateProjectEntry = handle.prepare('UPDATE project_categories SET data = ? WHERE project = ? AND id = ?');
    const now = new Date().toISOString();
    for (const row of handle.prepare('SELECT profile_id, category_id, data FROM routing_profile_entries').all()) {
      let category: any;
      try { category = JSON.parse(row.data); } catch (_: any) { continue; }
      if (!readonlyIds.has(category?.id) || category.readonly !== undefined) continue;
      category.readonly = true;
      updateProfileEntry.run(JSON.stringify(category), now, row.profile_id, row.category_id);
      for (const project of handle.prepare('SELECT project FROM project_routing_profiles WHERE profile_id = ?').all(row.profile_id)) affected.add(String(project.project));
      changed = true;
    }
    for (const row of handle.prepare('SELECT project, id, data FROM project_categories').all()) {
      let category: any;
      try { category = JSON.parse(row.data); } catch (_: any) { continue; }
      if (!readonlyIds.has(row.id) || category.readonly !== undefined) continue;
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
  telemetry.emitTicket({ slug, path: project && project.path }, applyDerivedRouting(Object.assign({}, ticket), { project: slug }));
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

function defaultProjectName(absPath?: any) {
  return path.basename(path.resolve(absPath)) || 'project';
}

function normalizeAlwaysInScope(paths?: any) {
  if (!Array.isArray(paths)) throw new Error('alwaysInScope must be an array of repo-relative paths.');
  const seen = new Set();
  const normalized: any[] = [];
  for (const value of paths) {
    const item = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const relative = item.replace(/\/+$/, '');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error(`alwaysInScope path must stay inside the board repo: ${value}`);
    }
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(item);
    }
  }
  return normalized;
}

function normalizeReadOnlyDeniedTools(value?: any) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('readOnlyDeniedTools must be an array of tool patterns.');
  const seen = new Set();
  const normalized: any[] = [];
  for (const entry of value) {
    const pattern = String(entry || '').trim();
    if (!pattern) throw new Error('readOnlyDeniedTools entries must be non-empty tool patterns.');
    if (!pattern.startsWith('mcp__')) throw new Error(`readOnlyDeniedTools patterns must target MCP tools: ${entry}`);
    if (!seen.has(pattern)) {
      seen.add(pattern);
      normalized.push(pattern);
    }
  }
  return normalized;
}

function normalizeGeneratedPairPath(value?: any, name?: any) {
  const item = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!item || item === '..' || item.startsWith('../') || path.isAbsolute(item) || item.includes('/../')) {
    throw new Error(`generatedPairs ${name} pattern must stay inside the board repo: ${value}`);
  }
  return item;
}

function normalizeGeneratedPairs(pairs?: any) {
  if (pairs == null) return [];
  if (!Array.isArray(pairs)) throw new Error('generatedPairs must be an array of { from, to } patterns.');
  const seen = new Set();
  const normalized: any[] = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
      throw new Error('generatedPairs entries must be { from, to } patterns.');
    }
    const from = normalizeGeneratedPairPath(pair.from, 'from');
    const to = normalizeGeneratedPairPath(pair.to, 'to');
    if ((from.match(/\*/g) || []).length !== (to.match(/\*/g) || []).length) {
      throw new Error(`generatedPairs patterns must use the same number of * placeholders: ${from} -> ${to}`);
    }
    const key = `${from} ${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ from, to });
    }
  }
  return normalized;
}

function generatedPathFor(source?: any, pair?: any) {
  const sourcePath = String(source || '').replace(/\\/g, '/');
  if (!sourcePath || sourcePath.includes('*')) return null;
  const parts = String(pair.from).split('*');
  const expression = new RegExp(`^${parts.map((part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')}$`);
  const match = sourcePath.match(expression);
  if (!match) return null;
  return String(pair.to).split('*').map((part: string, index: number) => `${part}${index < match.length - 1 ? match[index + 1] : ''}`).join('');
}

function trackedGeneratedPaths(config?: any, files?: any) {
  if (!config || !config.path || !Array.isArray(config.generatedPairs) || !config.generatedPairs.length || !Array.isArray(files)) return [];
  const candidates = Array.from(new Set(files.flatMap((file: any) => config.generatedPairs.map((pair: any) => generatedPathFor(file, pair)).filter(Boolean))));
  if (!candidates.length) return [];
  try {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', ...candidates], {
      cwd: config.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    }).split(' ').filter(Boolean);
    const candidateKeys = new Set(candidates.map((candidate: any) => process.platform === 'win32' ? candidate.toLowerCase() : candidate));
    return tracked.filter((trackedPath: string) => candidateKeys.has(process.platform === 'win32' ? trackedPath.toLowerCase() : trackedPath));
  } catch (_: any) {
    return [];
  }
}

function defaultAlwaysInScope(absPath?: any) {
  try {
    return fs.statSync(path.join(absPath, 'docs')).isDirectory() ? ['docs/'] : [];
  } catch (_: any) {
    return [];
  }
}

function normalizeDeliveryMode(mode?: any) {
  const value = String(mode || 'merge').trim().toLowerCase();
  if (!DELIVERY_MODES.includes(value)) {
    throw new Error('delivery must be "merge", "replay", or "apply".');
  }
  return value;
}

function normalizeIntegrationMode(mode?: any) {
  const value = String(mode || 'auto').trim().toLowerCase();
  if (!['auto', 'local', 'remote'].includes(value)) {
    throw new Error('integrationMode must be "auto", "local", or "remote".');
  }
  return value;
}

function normalizeIntegrationBranch(value?: any) {
  const branch = String(value == null ? 'main' : value).trim();
  if (!branch || branch === '@' || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')
    || branch.includes('//') || branch.includes('/.') || branch.endsWith('.lock') || branch.includes('..') || branch.includes('@{') || /[\s~^:?*\[\\]/.test(branch)) {
    throw new Error('integrationBranch must be a valid Git branch name.');
  }
  return branch;
}

function normalizeWorktreeIsolation(value?: any) {
  if (value == null) return true;
  if (typeof value !== 'boolean') throw new Error('worktreeIsolation must be a boolean.');
  return value;
}

function normalizeAutoApprovePluginTests(value?: any) {
  if (value == null) return true;
  if (typeof value !== 'boolean') throw new Error('autoApprovePluginTests must be a boolean.');
  return value;
}

function normalizeWorktreeSetup(value?: any) {
  if (value == null || String(value).trim() === '') return null;
  const setup = String(value);
  if (/[\r\n]/.test(setup)) throw new Error('worktreeSetup must be a one-line command.');
  if (setup.length > WORKTREE_SETUP_MAX_LENGTH) {
    throw new Error(`worktreeSetup exceeds the ${WORKTREE_SETUP_MAX_LENGTH}-character board-config limit.`);
  }
  return setup;
}

function normalizeIntegrationVerifyTimeoutMs(value?: any) {
  if (value == null || value === '') return DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_INTEGRATION_VERIFY_TIMEOUT_MS) {
    throw new Error(`integrationVerifyTimeoutMs must be an integer from 1 to ${MAX_INTEGRATION_VERIFY_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function hasOriginRemote(absPath?: any) {
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: absPath, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_: any) {
    return false;
  }
}

function integrationBranchExists(absPath: any, ref: string) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: absPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    });
    return true;
  } catch (_: any) {
    return false;
  }
}

function integrationTarget(slug?: any, override?: any) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const requested = override && typeof override === 'object' ? override : {};
  const configured = normalizeIntegrationMode(requested.mode ?? meta.integrationMode);
  const mode = configured === 'auto' ? (hasOriginRemote(meta.path) ? 'remote' : 'local') : configured;
  const branch = normalizeIntegrationBranch(requested.branch ?? override ?? meta.integrationBranch);
  const upstream = mode === 'local' ? branch : `origin/${branch}`;
  const ref = mode === 'local' ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
  if (!integrationBranchExists(meta.path, ref)) {
    throw new Error(`Configured integration ref "${ref}" for branch "${branch}" does not exist. Create or fetch it, or set integrationBranch with board-config --integration-branch <branch>.`);
  }
  return { mode, upstream, branch };
}

function integrationTargetCommit(absPath: any, target: any) {
  return execFileSync('git', ['rev-parse', '--verify', `${target.upstream}^{commit}`], {
    cwd: absPath,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  }).trim();
}

function normalizeBoardName(value?: any) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('Board name cannot be empty.');
  return name;
}

function boardConfig(slug?: any) {
  const meta = readMeta(slug);
  if (!meta) return null;
  const selected = projectRoutingProfile(slug);
  if (!selected) throw new Error(`Project "${slug}" does not have a routing profile.`);
  const layer = getProjectCategories(slug);
  const byKind = Object.fromEntries(['ADD', 'OVERRIDE', 'DETACH', 'DISABLE'].map((kind?: any) => [kind, layer.rows.filter((row?: any) => row.kind === kind).length]));
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
      entryCount: routingProfileEntries(selected.profile.id).length,
    },
    overrides: {
      count: layer.rows.length,
      byKind,
      foreignBaseCount: layer.rows.filter((row?: any) => row.baseProfileId && row.baseProfileId !== selected.profile.id).length,
      items: layer.rows,
    },
    warnings: [...selected.warnings, ...layer.warnings],
  };
}

function setBoardConfig(slug?: any, patch?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (!patch || typeof patch !== 'object') return { ok: true, config: boardConfig(slug) };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      meta.name = normalizeBoardName(patch.name);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'alwaysInScope')) {
      meta.alwaysInScope = normalizeAlwaysInScope(patch.alwaysInScope);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'readOnlyDeniedTools')) {
      meta.readOnlyDeniedTools = normalizeReadOnlyDeniedTools(patch.readOnlyDeniedTools);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'generatedPairs')) {
      meta.generatedPairs = normalizeGeneratedPairs(patch.generatedPairs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'integrationMode')) {
      meta.integrationMode = normalizeIntegrationMode(patch.integrationMode);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'integrationBranch')) {
      meta.integrationBranch = normalizeIntegrationBranch(patch.integrationBranch);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'delivery')) {
      meta.delivery = normalizeDeliveryMode(patch.delivery);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'integrationVerifyTimeoutMs')) {
      meta.integrationVerifyTimeoutMs = normalizeIntegrationVerifyTimeoutMs(patch.integrationVerifyTimeoutMs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'worktreeIsolation')) {
      meta.worktreeIsolation = normalizeWorktreeIsolation(patch.worktreeIsolation);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'autoApprovePluginTests')) {
      meta.autoApprovePluginTests = normalizeAutoApprovePluginTests(patch.autoApprovePluginTests);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'worktreeSetup')) {
      meta.worktreeSetup = normalizeWorktreeSetup(patch.worktreeSetup);
    }
    putProject(slug, meta);
    return { ok: true, config: boardConfig(slug) };
  });
}

function effectiveScope(slug?: any, files?: any) {
  const config = boardConfig(slug);
  const paired = trackedGeneratedPaths(Object.assign({ path: readMeta(slug)?.path }, config), files);
  return Array.from(new Set([...(Array.isArray(files) ? files : []), ...((config && config.alwaysInScope) || []), ...paired]));
}

// Register (or refresh) a project and return { slug, dir, meta }. Creates the
// directory tree on first use. `name` overrides the display name (defaults to
// the folder basename).
function ensureProject(absPath?: any, name?: any) {
  const resolved = path.resolve(absPath);
  const slug = slugify(resolved);
  const dir = projectDir(slug);
  ensureDir(ticketsDir(slug));
  let meta: any;
  let changed = false;
  transaction(() => {
    const handle = database();
    meta = db.getRow(handle, 'projects', slug);
    if (!meta || typeof meta !== 'object') {
      meta = {
        path: resolved,
        name: name || defaultProjectName(resolved),
        createdAt: new Date().toISOString(),
        seq: 0,
        storySeq: 0,
        alwaysInScope: defaultAlwaysInScope(resolved),
        worktreeIsolation: true,
      };
      db.putRow(handle, 'projects', { slug, data: meta });
      changed = true;
    } else {
      if (meta.path !== resolved) { meta.path = resolved; changed = true; }
      if (name && meta.name !== name) { meta.name = name; changed = true; }
      if (!meta.name) { meta.name = defaultProjectName(resolved); changed = true; }
      if (typeof meta.seq !== 'number') { meta.seq = 0; changed = true; }
      if (typeof meta.storySeq !== 'number') { meta.storySeq = 0; changed = true; }
      if (changed) db.putRow(handle, 'projects', { slug, data: meta });
    }
    const pointer = handle.prepare('SELECT project FROM project_routing_profiles WHERE project = ?').get(slug);
    if (!pointer) {
      const settings = handle.prepare('SELECT new_project_profile_id FROM routing_profile_settings WHERE singleton = 1').get();
      if (!settings?.new_project_profile_id) throw new Error('The new-board routing profile is not configured.');
      db.putRow(handle, 'project_routing_profiles', {
        project: slug,
        profile_id: settings.new_project_profile_id,
        assigned_at: new Date().toISOString(),
        assigned_by: 'ensure-project',
      });
      changed = true;
    }
  });
  if (changed) invalidateStoreCaches();
  return { slug, dir, meta };
}

function readMeta(slug?: any) {
  const key = String(slug || '');
  const cache = residentCache();
  if (cache.metadata.has(key)) return cloneCached(cache.metadata.get(key));
  const meta = db.getRow(database(), 'projects', key);
  cache.metadata.set(key, meta);
  return cloneCached(meta);
}

function metaLockPath(slug?: any) {
  return path.join(projectDir(slug), '.meta.lock');
}

function withMetaLock(slug?: any, fn?: any) {
  const lock = metaLockPath(slug);
  const locked = acquireLock(lock);
  try {
    return transaction(fn);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked read-modify-write so two concurrent createTicket calls never mint the
// same human-facing SQ-N ref (a bare read+increment+write here would race).
// acquireLock already retries internally on contention; if it still can't get
// the lock (e.g. a wedged/unwritable dir), fall back to an unlocked bump rather
// than blocking ticket creation entirely.
function nextSeq(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { seq: 0 };
    meta.seq = (typeof meta.seq === 'number' ? meta.seq : 0) + 1;
    putProject(slug, meta);
    return meta.seq;
  });
}

// The story counter is a second monotonic sequence on the same project row,
// minting US-1, US-2, … independently of the SQ-N ticket refs.
function nextStorySeq(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug) || { storySeq: 0 };
    meta.storySeq = (typeof meta.storySeq === 'number' ? meta.storySeq : 0) + 1;
    putProject(slug, meta);
    return meta.storySeq;
  });
}

// Turn a board's per-project notifications on or off. When off, the board is
// muted: queueEventNotification below drops every background event for it, even
// with a dashboard tab open. Stored on the project row (absent == on).
function setProjectNotify(slug?: any, on?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.notify = on !== false;
    putProject(slug, meta);
    return { ok: true, notify: meta.notify };
  });
}

function setProjectRouting(slug?: any, routing?: any) {
  if (!['enabled', 'disabled'].includes(routing)) throw new Error('Routing must be enabled or disabled.');
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    meta.routing = routing;
    putProject(slug, meta);
    return { ok: true, routing: meta.routing };
  });
}

function projectRoutingEnabled(slug?: any) {
  const meta = readMeta(slug);
  return !meta || meta.routing !== 'disabled';
}

// Board-level archive is a reversible project-row stamp. Project data and tickets
// remain in place, and repeat calls keep the original archive timestamp.
function archiveProject(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (meta.archivedAt) return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: true };
    meta.archivedAt = new Date().toISOString();
    putProject(slug, meta);
    return { ok: true, slug, archivedAt: meta.archivedAt, alreadyArchived: false };
  });
}

function unarchiveProject(slug?: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta) return { ok: false, reason: 'not_found' };
    if (!meta.archivedAt) return { ok: true, slug, wasArchived: false };
    delete meta.archivedAt;
    putProject(slug, meta);
    return { ok: true, slug, wasArchived: true };
  });
}

// Permanent deletion is deliberately strict: callers must already have the exact
// stored slug. This avoids turning an untrusted display name or path into a new
// project lookup at a destructive boundary.
function deleteProjectExact(slug?: any) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return { ok: false, reason: 'not_found' };
  if (!readMeta(slug)) return { ok: false, reason: 'not_found' };
  transaction(() => {
    for (const ticket of db.listRows(database(), 'tickets', { project: slug })) deleteCachedRow(database(), 'tickets', ticket.id);
    for (const story of db.listRows(database(), 'stories', { project: slug })) deleteCachedRow(database(), 'stories', story.id);
    deleteCachedRow(database(), 'projects', slug);
  });
  fs.rmSync(projectDir(slug), { recursive: true, force: true });
  return { ok: true, slug };
}

// List every registered project with live ticket counts. Sorted by most recent
// activity so the busiest board floats to the top of the switcher. By default,
// archived boards are hidden. Pass { archived: true } to list only archived
// boards, or { all: true } for internal resolution.
function listProjects(opts?: any) {
  opts = opts || {};
  const cache = residentCache();
  const cacheKey = `projects:${opts.all ? 'all' : opts.archived ? 'archived' : 'active'}`;
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

  const out: any[] = [];
  for (const row of rows) {
    let meta: any;
    try { meta = JSON.parse(row.data); } catch (_: any) { continue; }
    if (!meta || !meta.path) continue;
    const archivedAt = meta.archivedAt || null;
    if (!opts.all && (opts.archived ? !archivedAt : !!archivedAt)) continue;
    const counts = { todo: Number(row.todo) || 0, doing: Number(row.doing) || 0, done: Number(row.done) || 0 };
    out.push({
      slug: slugify(meta.path),
      name: meta.name || row.slug,
      path: meta.path || '',
      counts,
      total: Number(row.active) || 0,
      archived: Number(row.archived) || 0,
      open: counts.todo + counts.doing,
      lastActivity: row.last_activity || meta.createdAt || null,
      notify: meta.notify !== false,
      routing: meta.routing === 'disabled' ? 'disabled' : 'enabled',
      stories: Number(row.stories) || 0,
      archivedAt,
    });
  }
  out.sort((a?: any, b?: any) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  cache.snapshots.set(cacheKey, out);
  return cloneCached(out);
}

// Resolve a caller-supplied --project reference to the ONE already-registered
// board it names — an exact slug, a case-insensitive display NAME, or a
// filesystem path. NEVER creates or matches anything outside the registered
// set (see SQ-86): a name is not a slug, so a bare display name used to miss
// the slug lookup, fall into ensureProject(), and get treated as a raw path
// resolved against cwd — silently minting a phantom empty board that happened
// to share the real project's display name (or a real one's if two directories
// share a basename, e.g. "BMR" run from both C:\dev\BMR and C:\dev\BMR\BMR).
// Returns { ok:true, slug, meta } on a clean match, or { ok:false, reason,
// ...} for the caller (the CLI) to turn into a hard error:
//   - reason 'ambiguous' + matches: 2+ registered boards share that NAME —
//     the caller must re-run with the disambiguating path.
//   - reason 'not_found' + known: nothing matched — known is the list of
//     registered display names to surface in the error.
function findProject(ref?: any) {
  const arg = String(ref == null ? '' : ref).trim();
  if (!arg) return { ok: false, reason: 'not_found', known: listProjects({ all: true }).map((project?: any) => project.name) };

  if (path.isAbsolute(arg)) {
    const resolvedPath = path.resolve(arg);
    const slug = slugify(resolvedPath);
    const meta = readMeta(slug);
    if (meta && normalizeForHash(meta.path) === normalizeForHash(resolvedPath)) return { ok: true, slug, meta };
  } else {
    const meta = readMeta(arg);
    if (meta) return { ok: true, slug: arg, meta };
  }

  const projects = db.selectRows(database(), 'SELECT slug, data FROM projects ORDER BY slug')
    .map((row?: any) => {
      try { return { slug: row.slug, meta: JSON.parse(row.data) }; } catch (_: any) { return null; }
    })
    .filter(Boolean);

  const wantedName = arg.toLowerCase();
  const byName = projects.filter((project?: any) => String(project.meta.name || project.slug).trim().toLowerCase() === wantedName);
  if (byName.length === 1) return { ok: true, slug: byName[0].slug, meta: byName[0].meta };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      matches: byName.map((project?: any) => ({ slug: project.slug, name: project.meta.name || project.slug, path: project.meta.path || '' })),
    };
  }

  if (!path.isAbsolute(arg)) {
    const wantedPath = normalizeForHash(path.resolve(arg));
    const byPath = projects.find((project?: any) => project.meta.path && normalizeForHash(path.resolve(project.meta.path)) === wantedPath);
    if (byPath) return { ok: true, slug: byPath.slug, meta: byPath.meta };
  }

  return { ok: false, reason: 'not_found', known: projects.map((project?: any) => project.meta.name || project.slug) };
}

// Fold one board (src) entirely into another (dest): move every ticket, story,
// and attached asset over, then delete the source board. Used to collapse the
// duplicate boards that older versions minted when the CLI ran from a subfolder
// (see nearestRepoRoot / SQ-94). The renumbering rules that make this safe:
//   - Ticket SQ-n / story US-n refs are re-minted ABOVE dest's live counters
//     (via nextSeq/nextStorySeq), so they never collide with dest's own refs.
//   - Stable ids (tk_… / st_…) are kept as-is. They're globally unique, so the
//     ticket/story JSON drops into dest without a filename clash, the assets
//     folder (keyed by ticket id) copies 1:1, and a ticket's storyId (which
//     points at a story's stable id, never its ref) still resolves after the
//     move — no membership is orphaned.
//   - Intra-board links (links[].ref, which point by SQ-ref) are rewritten
//     through the old->new ref map so dependencies survive the renumber.
// dryRun computes and returns the same mapping without touching disk. Returns
// { tickets, stories, mapping: [{ from, to, title }] }.
function mergeProject(srcSlug?: any, destSlug?: any, opts?: any) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (srcSlug === destSlug) throw new Error('source and destination are the same board');
  if (!readMeta(srcSlug)) throw new Error(`source board "${srcSlug}" does not exist`);
  if (!readMeta(destSlug)) throw new Error(`destination board "${destSlug}" does not exist`);

  // Oldest-first so re-minted refs preserve the source's creation order.
  const tickets = listTickets(srcSlug).slice().sort((a?: any, b?: any) => seqOfRef(a.ref) - seqOfRef(b.ref));
  const stories = listStories(srcSlug); // listStories already returns oldest-first

  // Plan the ref renumbering up front so link remapping can see every mapping.
  const refMap: Record<string, any> = {}; // OLD-TICKET-REF (upper) -> NEW-TICKET-REF
  const ticketPlan: any[] = [];
  for (const t of tickets) {
    const newRef = dryRun ? `SQ-?` : `SQ-${nextSeq(destSlug)}`;
    if (t.ref) refMap[String(t.ref).toUpperCase()] = newRef;
    ticketPlan.push({ ticket: t, newRef });
  }
  const storyPlan: any[] = [];
  for (const s of stories) {
    const newRef = dryRun ? `US-?` : `US-${nextStorySeq(destSlug)}`;
    storyPlan.push({ story: s, newRef });
  }

  const mapping = ticketPlan.map(({ ticket, newRef }: any) => ({ from: ticket.ref, to: newRef, title: ticket.title }));
  if (dryRun) return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };

  // Stories first, so a moved ticket's storyId still finds its story in dest.
  transaction(() => {
    for (const ticket of tickets) deleteCachedRow(database(), 'tickets', ticket.id);
    for (const story of stories) deleteCachedRow(database(), 'stories', story.id);
    for (const { story, newRef } of storyPlan) {
      const moved = Object.assign({}, story, { ref: newRef });
      putStory(destSlug, moved);
    }
    for (const { ticket, newRef } of ticketPlan) {
      const links = Array.isArray(ticket.links)
        ? ticket.links.map((l?: any) => Object.assign({}, l, { ref: refMap[String(l.ref).toUpperCase()] || l.ref }))
        : [];
      const moved = Object.assign({}, ticket, { ref: newRef, links });
      putTicket(destSlug, moved);
      const srcAssets = assetsDir(srcSlug, ticket.id);
      if (fs.existsSync(srcAssets)) {
        try {
          fs.cpSync(srcAssets, assetsDir(destSlug, ticket.id), { recursive: true });
        } catch (_: any) {
          /* an unreadable asset folder shouldn't abort the whole merge */
        }
      }
    }
    deleteCachedRow(database(), 'projects', srcSlug);
  });

  try {
    fs.rmSync(projectDir(srcSlug), { recursive: true, force: true });
  } catch (_: any) {
    /* best effort; the tickets already live in dest */
  }
  return { tickets: ticketPlan.length, stories: storyPlan.length, mapping };
}

// Pull the numeric sequence out of an "SQ-12" ref for ordering; junk sorts last.
function seqOfRef(ref?: any) {
  const m = /(\d+)\s*$/.exec(String(ref || ''));
  return m ? parseInt(m[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

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
    return ticket && ticket.id ? applyDerivedRouting(ticket, { project: slug }) : null;
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

// The sweep decides whether a worktree may be deleted, so every ticket it sees
// carries the claim-liveness answer with it. A done ticket whose executor is
// still holding the claim is still working in that tree.
function worktreeGcTickets(): any[] {
  return db.selectRows(database(), 'SELECT project, data FROM tickets')
    .map((row?: any) => {
      const ticket = parseTicketData(row.project, row.data);
      return ticket ? Object.assign({}, ticket, {
        project: row.project,
        claimLive: Boolean(ticket.claim && ticket.claim.by && !claimReleaseVerdict(ticket)),
      }) : null;
    })
    .filter(Boolean);
}

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

const DISPATCH_DESCRIPTION_MIN = 80;
const DISPATCH_DESCRIPTION_GUIDANCE = "the executor's entire brief is this ticket; add a description (Where / Contract / Verify) and a verify command, then dispatch";

// Per-ticket executor context stays deliberately small: this data may be passed
// through a Windows command surface with an 8191-character ceiling. Keep the
// anchors as written so the eventual executor prompt can carry them verbatim.
function executorText(value?: any, max?: any, label?: any) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > max) throw new Error(`${label} exceeds the ${max}-character executor-context limit.`);
  return text;
}

const VERIFY_BUILTINS = new Set([
  'bash', 'bun', 'cargo', 'cd', 'cmd', 'composer', 'dart', 'deno', 'dotnet',
  'elixir', 'eslint', 'flutter', 'git', 'go', 'gradle', 'java', 'jest', 'just',
  'make', 'mix', 'mvn', 'node', 'npm', 'npx', 'php', 'pnpm', 'poetry', 'powershell',
  'pwsh', 'py', 'pytest', 'python', 'python3', 'rake', 'ruby', 'sh', 'tox', 'tsc',
  'uv', 'vitest', 'yarn',
]);

function manualVerify(value?: any) {
  return /^manual:\s+\S/i.test(String(value || '').trim());
}

function verifyCommandError(value?: any) {
  const command = String(value || '').trim();
  if (!command || manualVerify(command)) return null;
  if (/^manual:/i.test(command)) {
    return 'Manual verification must say what was checked: `manual: <what you checked>`. Otherwise provide a runnable command such as `cd <repo-relative-dir> && <command>`.';
  }
  const first = command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[1]
    || command.match(/^\s*(?:["']([^"']+)["']|([^\s;&|]+))/)?.[2]
    || '';
  const likelyExecutable = VERIFY_BUILTINS.has(first.toLowerCase())
    || /[\\/]|\.(?:bat|cmd|com|exe|ps1|sh)$/i.test(first);
  const proseStarter = /^(?:check|confirm|ensure|inspect|look|open|read|review|verify)\s/i.test(command);
  if (command.endsWith('.') || proseStarter || !likelyExecutable && /[.!?]/.test(command)) {
    return 'Verify must be a runnable command such as `cd <repo-relative-dir> && <command>`. For manual verification, use `manual: <what you checked>` so it is recorded without shell execution.';
  }
  for (const match of command.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|(?::[^}]*)\})/g)) {
    const name = match[1] || match[2];
    if (name && process.env[name] == null && !match[0].includes(':-')) {
      return `Verify references unset environment variable ${name}. Set a portable default such as \`${'${'}${name}:-/tmp}\`, or use \`manual: <what you checked>\`.`;
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

function requireVerifyCommand(value?: any) {
  const error = verifyCommandError(value);
  if (error) throw new Error(error);
}

function ticketReferenceWarnings(slug?: any, title?: any, description?: any) {
  const refs = new Set((`${title || ''}\n${description || ''}`.match(/\bSQ-\d+\b/gi) || []).map((ref?: any) => ref.toUpperCase()));
  if (!refs.size) return [];
  const known = new Set(listTickets(slug).map((ticket?: any) => String(ticket.ref).toUpperCase()));
  const unknown = [...refs].filter((ref?: any) => !known.has(ref));
  return unknown.length ? [`Unknown ticket refs: ${unknown.join(', ')}.`] : [];
}

function ticketPrescribesFix(description?: any) {
  const body = String(description || '');
  if (/^\s*fix\s*:/im.test(body)) return true;
  if (/\b(?:replace|change)\s+\S[\s\S]{0,160}?\s+(?:with|to)\s+\S/i.test(body)) return true;
  if (/```(?:diff|patch)?\s*\r?\n[\s\S]*?^-\S[\s\S]*?^\+\S[\s\S]*?```/im.test(body)) return true;
  return (body.match(/^\s*\d+[.)]\s+(?:add|change|replace|remove|rename|move|update|set|delete|edit|wire)\b/gim) || []).length >= 2;
}

function ticketCategoryWarnings(ticket?: any) {
  if (ticketCategory(ticket) !== 'coding.hard' || !ticketPrescribesFix(ticket && ticket.description)) return [];
  return ['coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.'];
}

function readonlyCategoryWriteIntentWarning(ticket?: any) {
  if (!categoryReadOnly(ticket)) return null;
  const writesFiles = normalizeFiles(ticket.files).length > 0;
  const writesContracts = (normalizeContracts(ticket.contracts).changes || []).length > 0;
  if (!writesFiles && !writesContracts) return null;
  return 'Readonly category contradicts declared write intent (files or changes). Resolve the category or set an explicit readonly override before dispatch.';
}

// The complexity 4+ message below already names missing file scope, so skip this one there
// to avoid reporting the same gap twice.
function noDeclaredScopeWarning(ticket?: any) {
  if (dispatchReadOnly(ticket)) return null;
  if (Array.isArray(ticket.files) && ticket.files.length) return null;
  if (Number(ticket?.complexity) >= 4) return null;
  return 'Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.';
}

const BROWSER_REVIEW_SIGNAL = /\b(?:browser|visual|screenshot|playwright|ui review|e2e)\b/i;

function readonlyBrowserReviewWarning(ticket?: any) {
  if (!dispatchReadOnly(ticket)) return null;
  const signal = [ticket?.title, ticket?.description, ticketCategory(ticket)].join('\n');
  if (!BROWSER_REVIEW_SIGNAL.test(signal)) return null;
  return 'Planning-depth warning: this readonly browser/visual ticket may need a driver script. Read-only executors cannot write one; grant write scope with an explicit no-repo-writes mandate, or use a browser tool that needs no script.';
}

function relativePathWithin(root?: any, target?: any) {
  const relative = path.relative(String(root), String(target));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : relative === '' ? '.' : null;
}

function packageRootForScope(projectPath?: any, scope?: any) {
  const absolute = path.resolve(String(projectPath), String(scope));
  let directory = path.dirname(absolute);
  for (;;) {
    if (!relativePathWithin(projectPath, directory)) return null;
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function buildOutputDirectories(source?: any) {
  const outputs = new Map<string, any>();
  const add = (directory?: any, sourceDirectory?: any) => {
    const value = String(directory || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!value || value.includes('..') || path.isAbsolute(value)) return;
    const current = outputs.get(value);
    outputs.set(value, { directory: value, sourceDirectory: sourceDirectory || current?.sourceDirectory || null });
  };
  const text = String(source || '');
  for (const match of text.matchAll(/--(?:outdir|out-dir|output-dir)\s*(?:=|\s+)\s*["']?([^"'\s;&]+)/gi)) add(match[1]);
  for (const match of text.matchAll(/(?:outdir|outDir|outputDir)\s*:\s*["']([^"']+)["']/g)) add(match[1]);
  for (const helper of text.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{([\s\S]{0,2000}?)\n\}/g)) {
    const [helperName, parameter, body] = [helper[1], helper[2], helper[3]];
    if (!helperName || !parameter || !body || !new RegExp(`(?:outdir|outDir)\\s*:\\s*path\\.join\\([^)]*,\\s*${parameter}\\s*\\)`).test(body)) continue;
    const call = new RegExp(`\\b${helperName}\\s*\\(\\s*["']([^"']+)["']`, 'g');
    for (const match of text.matchAll(call)) add(match[1], match[1]);
  }
  return [...outputs.values()];
}

function packageBuildOutputs(packageRoot?: any) {
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(String(packageRoot), 'package.json'), 'utf8'));
  } catch (_: any) {
    return [];
  }
  const build = String(manifest?.scripts?.build || '');
  if (!build) return [];
  const outputs = buildOutputDirectories(build);
  for (const match of build.matchAll(/\bnode\s+(?:["']([^"']+)["']|([^\s;&]+))/g)) {
    const script = path.resolve(String(packageRoot), match[1] || match[2]);
    if (!relativePathWithin(packageRoot, script) || !fs.existsSync(script)) continue;
    try {
      outputs.push(...buildOutputDirectories(fs.readFileSync(script, 'utf8')));
    } catch (_: any) {
      /* A package build script that cannot be read cannot prove an output target. */
    }
  }
  return [...new Map(outputs.map((output?: any) => [output.directory, output])).values()];
}

function isTrackedBuildOutput(projectPath?: any, output?: any) {
  const relative = relativePathWithin(projectPath, output);
  if (!relative || relative === '.') return false;
  try {
    return Boolean(execFileSync('git', ['ls-files', '--', relative], {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch (_: any) {
    return false;
  }
}

function scopeIncludesPath(files?: any, projectPath?: any, target?: any) {
  return normalizeFiles(files).some((file?: any) => {
    const declared = path.resolve(String(projectPath), file);
    return declared === target || relativePathWithin(target, declared) !== null;
  });
}

function sourceBuildOutputWarnings(ticket?: any, projectPath?: any) {
  if (!projectPath || !Array.isArray(ticket?.files)) return [];
  const warnings = new Set<string>();
  for (const scope of normalizeFiles(ticket.files)) {
    const packageRoot = packageRootForScope(projectPath, scope);
    if (!packageRoot) continue;
    const sourceRelative = relativePathWithin(packageRoot, path.resolve(projectPath, scope))?.replace(/\\/g, '/');
    if (!sourceRelative || (sourceRelative !== 'src' && !sourceRelative.startsWith('src/'))) continue;
    const sourceDirectory = sourceRelative.split('/')[1] || null;
    for (const output of packageBuildOutputs(packageRoot)) {
      if (output.sourceDirectory && sourceDirectory && output.sourceDirectory !== sourceDirectory) continue;
      const target = path.resolve(packageRoot, output.directory);
      if (!isTrackedBuildOutput(projectPath, target) || scopeIncludesPath(ticket.files, projectPath, target)) continue;
      const packageRelative = relativePathWithin(projectPath, packageRoot)?.replace(/\\/g, '/') || '.';
      const display = packageRelative === '.' ? output.directory : `${packageRelative}/${output.directory}`;
      warnings.add(`Planning-depth warning: declared source scope under ${packageRelative}/src omits tracked build output ${display}. Include the generated output in this ticket; content-hashed output gets one rebuild ticket per wave.`);
    }
  }
  return [...warnings];
}

function verifyCommandWarning(ticket?: any, projectPath?: any) {
  const verify = String(ticket?.executorVerify || '').trim();
  if (!verify) return null;
  const match = /^cd\s+(?:["']([^"']+)["']|([^&;\s]+))\s*&&/.exec(verify);
  if (!match) return 'Planning-depth warning: record verify commands as `cd <repo-relative-dir> && ...`, then run that exact string before submitting.';
  const directory = path.resolve(String(projectPath || ''), match[1] || match[2]);
  if (!projectPath || !relativePathWithin(projectPath, directory) || !fs.existsSync(directory)) {
    return 'Planning-depth warning: the recorded verify command changes to a directory that does not exist in this repo. Run the exact string you record before submitting.';
  }
  return null;
}

function dispatchDescriptionError(ticket?: any) {
  if (!ticket || !ticket.model || !ticket.effort) return null;
  if (String(ticket.description || '').trim().length >= DISPATCH_DESCRIPTION_MIN) return null;
  return `dispatch: ${DISPATCH_DESCRIPTION_GUIDANCE}.`;
}

function storyContractDriftWarnings(ticket?: any) {
  const contractDrift = ticket && (ticket.storyContractDrift || dispatchState(ticket)?.storyContractDrift);
  if (!contractDrift) return [];
  return [`Dispatch warning: ${contractDrift.storyRef || 'story'} execution contract changed from revision ${contractDrift.fromRevision} to ${contractDrift.toRevision} while this ticket was claimed; the next briefing uses revision ${contractDrift.toRevision}.`];
}

function claudeWebSearchUnavailable(ticket?: any) {
  const model = normalizeRouteModel(ticket && ticket.model);
  const effort = coerceEffort(ticket && ticket.effort);
  return ['opus', 'sonnet', 'fable'].includes(String(model)) && ['xhigh', 'max'].includes(String(effort));
}

const DISPATCH_SYMBOL_CHECK_MAX = 12;
const DISPATCH_SYMBOL_CHECK_MAX_SCOPES = 64;
const DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES = 256 * 1024;

function ticketSymbolReferences(ticket?: any) {
  const candidates = `${ticket?.title || ''}\n${ticket?.description || ''}`.matchAll(/`([^`\r\n]+)`/g);
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const symbol = String(candidate[1] || '').trim();
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

function symbolSearchIsBounded(projectPath?: any, target?: any, scopes?: any) {
  if (!projectPath || !target || scopes.length > DISPATCH_SYMBOL_CHECK_MAX_SCOPES) return false;
  const args = ['ls-tree', '-r', '--name-only', String(target)];
  if (scopes.length) args.push('--', ...scopes);
  try {
    execFileSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
      maxBuffer: DISPATCH_SYMBOL_CHECK_MAX_TREE_BYTES,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function symbolExistsOnTarget(projectPath?: any, target?: any, symbol?: any, scopes?: any) {
  const args = ['grep', '-F', '-q', '--', String(symbol), String(target)];
  if (scopes.length) args.push('--', ...scopes);
  const result = spawnSync('git', args, {
    cwd: projectPath,
    windowsHide: true,
    stdio: 'ignore',
    timeout: 3000,
  });
  if (result.error || result.signal || result.status == null) return null;
  return result.status === 0;
}

function symbolExistenceWarnings(ticket?: any, slug?: any) {
  const projectPath = slug ? readMeta(slug)?.path : null;
  const symbols = ticketSymbolReferences(ticket);
  if (!projectPath || !symbols.length) return [];
  let target: any;
  try {
    target = integrationTarget(slug);
  } catch (_) {
    return [];
  }
  const scopes = dispatchDeclaredFiles(ticket);
  if (!symbolSearchIsBounded(projectPath, target.upstream, scopes)) return [];
  const warnings: string[] = [];
  for (const symbol of symbols) {
    const exists = symbolExistsOnTarget(projectPath, target.upstream, symbol, scopes);
    if (exists === false) warnings.push(`ticket names \`${symbol}\` but it does not appear on ${target.upstream}; verify this claim before acting.`);
  }
  return warnings;
}

function crossTicketStateWarnings(ticket?: any, slug?: any) {
  if (!ticket || !slug) return [];
  const writtenAt = Date.parse(ticket.referenceUpdatedAt || ticket.updatedAt);
  if (!Number.isFinite(writtenAt)) return [];
  const refs = new Set((String(ticket.description || '').match(/\bSQ-\d+\b/gi) || []).map((ref) => ref.toUpperCase()));
  refs.delete(String(ticket.ref || '').toUpperCase());
  const warnings: string[] = [];
  for (const ref of refs) {
    const referenced = getTicket(slug, ref);
    const transition = referenced?.statusTransition;
    const changedAt = Date.parse(transition?.at);
    if (!referenced || !Number.isFinite(changedAt) || changedAt <= writtenAt) continue;
    const from = transition.from || 'unknown';
    const to = transition.to || referenced.status || 'unknown';
    warnings.push(`${ref} changed state (${from} -> ${to}) after this ticket was written; its claims may be stale.`);
  }
  return warnings;
}

function dispatchUncertaintyWarnings(ticket?: any, slug?: any) {
  return [...symbolExistenceWarnings(ticket, slug), ...crossTicketStateWarnings(ticket, slug)]
    .map((warning) => `Dispatch warning: ${warning}`);
}

function dispatchWarnings(ticket?: any, slug?: any) {
  const warnings: any[] = dispatchUncertaintyWarnings(ticket, slug);
  const projectPath = slug ? readMeta(slug)?.path : null;
  if (projectPath) {
    const browserReview = readonlyBrowserReviewWarning(ticket);
    if (browserReview) warnings.push(`Dispatch warning: ${browserReview.replace('Planning-depth warning: ', '')}`);
    const verify = verifyCommandWarning(ticket, projectPath);
    if (verify) warnings.push(`Dispatch warning: ${verify.replace('Planning-depth warning: ', '')}`);
    for (const warning of sourceBuildOutputWarnings(ticket, projectPath)) {
      warnings.push(`Dispatch warning: ${warning.replace('Planning-depth warning: ', '')}`);
    }
  }
  if (claudeWebSearchUnavailable(ticket)) {
    warnings.push('Dispatch warning: WebSearch is unavailable on this Claude xhigh/max route. Put web research in a research-category ticket.');
  }
  if (readOnlyOverrideActive(ticket)) {
    warnings.push(ticket.readonlyOverride
      ? 'readonly override active: this ticket closes with done + comment despite its category default.'
      : 'readonly override active: this read-only category routes through the writing executor.');
  }
  const contradiction = readonlyCategoryWriteIntentWarning(ticket);
  if (contradiction) warnings.push(`Dispatch warning: ${contradiction}`);
  const worktreeWarning = dispatchState(ticket)?.worktreeWarning;
  if (worktreeWarning) warnings.push(worktreeWarning);
  const categoryId = ticket && (ticket.categoryId || (ticket.category && ticket.category.id));
  if (/^(?:coding(?:\.|$)|debugging$)/.test(String(categoryId || '')) && !String(ticket.executorVerify || '').trim()) {
    warnings.push('Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.');
  }
  warnings.push(...storyContractDriftWarnings(ticket));
  const declaredFiles = dispatchDeclaredFiles(ticket);
  const outside = externalDeclaredFiles(declaredFiles);
  if (outside.length) {
    warnings.push(`Dispatch warning: declared paths are outside the repo worktree: ${outside.join(', ')}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (!slug || !declaredFiles.length) return warnings;
  for (const sibling of listTickets(slug)) {
    if (sibling.id === ticket.id) continue;
    const dispatch = dispatchState(sibling);
    const liveClaim = sibling.claim && sibling.claim.by && !claimReclaimable(sibling);
    const liveDispatch = dispatch && !dispatch.terminalAt && ['prepared', 'launched', 'bound', 'claimed'].includes(pulseDispatchState(dispatch));
    if (!liveClaim && !liveDispatch) continue;
    const overlaps = overlappingScopePaths(declaredFiles, dispatchDeclaredFiles(sibling));
    const contractReasons = contractCollisionReasons(ticket, sibling);
    if (!overlaps.length && !contractReasons.length) continue;
    if (overlaps.length) {
      const lockfilesOnly = overlaps.every((file?: any) => /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml)$/i.test(file));
      const lockfileGuidance = lockfilesOnly
        ? ' Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration.'
        : '';
      warnings.push(`Dispatch warning: ${ticket.ref} overlaps in-flight ${sibling.ref} at ${overlaps.join(', ')} — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.${lockfileGuidance}`);
    }
    for (const collision of contractReasons) {
      warnings.push(`Dispatch warning: contract edge with in-flight ${sibling.ref}: ${collision.message} Serialize unless a reviewed contract waiver applies.`);
    }
  }
  return warnings;
}

function dispatchDeclaredFiles(ticket?: any) {
  const dispatch = dispatchState(ticket);
  return normalizeFiles(dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : ticket && ticket.files);
}

function externalDeclaredFiles(files?: any) {
  return commitScope.validateRelativeScopes(files).outside;
}

function nonRepoExternalOutput(ticket?: any, files?: any) {
  const declaredFiles = normalizeFiles(files);
  const outside = externalDeclaredFiles(declaredFiles);
  return declaredFiles.length > 0
    && outside.length === declaredFiles.length
    && dispatchReadOnly(ticket);
}

// Route by remaining uncertainty, not original difficulty: once an investigation has
// settled the exact edit, the implementation ticket belongs on a cheap tier. A false
// positive on an evidence block (log excerpt, test output, measured table) is worse
// than a miss, so a block must read as an edit AND not read as a transcript.
const JUDGMENT_TIER_CATEGORIES = ['coding.normal', 'coding.hard', 'debugging', 'plugin-dev', 'ui-frontend'];
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
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>\[\],\s]+\s+[\w$]+\s*\(/m,
];

function fencedBlocks(description?: any) {
  const blocks: any[] = [];
  const body = String(description || '');
  const fence = /^[ \t]*```+[ \t]*([^\n`]*)\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
  let match: any;
  while ((match = fence.exec(body))) blocks.push({ info: String(match[1]).trim().toLowerCase(), body: String(match[2]) });
  return blocks;
}

function diffShapedBlock(block?: any) {
  if (/^(?:diff|patch)\b/.test(block.info)) return true;
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(block.body)) return true;
  if (/^--- .+\r?\n\+\+\+ /m.test(block.body)) return true;
  const added = (block.body.match(/^\+(?!\+)\s*\S/gm) || []).length;
  const removed = (block.body.match(/^-(?!-)\s*\S/gm) || []).length;
  return added >= 2 && removed >= 2;
}

function evidenceShapedBlock(lines?: any) {
  const filled = lines.filter((line?: any) => line.trim());
  if (!filled.length) return true;
  const evidence = filled.filter((line?: any) => EVIDENCE_LINE.test(line) || EVIDENCE_TIMESTAMP.test(line)).length;
  return evidence / filled.length >= EVIDENCE_SHARE;
}

function embedsCompleteEdit(description?: any) {
  for (const block of fencedBlocks(description)) {
    const lines = block.body.split(/\r?\n/);
    if (lines.length < PRESOLVED_BLOCK_MIN_LINES && block.body.length < PRESOLVED_BLOCK_MIN_CHARS) continue;
    if (evidenceShapedBlock(lines)) continue;
    if (diffShapedBlock(block) || DEFINITION_SHAPES.some((shape?: any) => shape.test(block.body))) return true;
  }
  return false;
}

function presolvedRoutingWarnings(ticket?: any) {
  if (!JUDGMENT_TIER_CATEGORIES.includes(String(ticketCategory(ticket) || ''))) return [];
  if (!embedsCompleteEdit(ticket && ticket.description)) return [];
  return ['Planning-depth warning: this description embeds what looks like a complete edit; route by remaining uncertainty, so a fully resolved approach belongs on coding.easy or direct-ok, not a judgment tier.'];
}

function ticketPlanningWarnings(ticket?: any, projectPath?: any) {
  if (!ticket) return [];
  const warnings: any[] = [];
  const outside = externalDeclaredFiles(ticket.files);
  if (outside.length) {
    warnings.push(`Planning-depth warning: declared paths are outside the repo worktree: ${outside.join(', ')}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`);
  }
  if (Number(ticket.complexity) >= 4) {
    const missing: any[] = [];
    if (!String(ticket.executorAnchors || '').trim()) missing.push('executor anchors');
    if (!String(ticket.executorVerify || '').trim()) missing.push('verify command');
    if (!Array.isArray(ticket.files) || !ticket.files.length) missing.push('file scope');
    if (missing.length) {
      warnings.push(`Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: ${missing.join(', ')}.`);
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
  const absent = ticket.files.filter((file?: any) => !fs.existsSync(path.resolve(projectPath, file)));
  if (absent.length) warnings.push(`Planning-depth warning: declared file scope does not exist in the repo: ${absent.join(', ')}.`);
  return warnings;
}

function normalizeReadonlyOverride(value?: any) {
  return typeof value === 'boolean' ? value : null;
}

function requestedReadonlyOverride(fields?: any) {
  return normalizeReadonlyOverride(fields?.readonlyOverride === undefined ? fields?.readonly : fields.readonlyOverride);
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function priorityRank(p?: any) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, p) ? (PRIORITY_RANK[String(p)] ?? 9) : 9;
}

// The stable session-start executor receives the briefing and token in its prompt.
function stableExecutorName(ticket?: any, artifactMode = false) {
  if (!ticket || !ticket.model || !ticket.effort) throw new Error('dispatch executor requires a routable ticket.');
  const resolved = resolveExec(ticket.model, ticket.effort);
  if (!resolved || !resolved.agent) throw new Error(`no stable executor for ${ticket.model} at ${ticket.effort}.`);
  if (artifactMode || sharedTreeArtifactMode(ticket) || !dispatchReadOnly(ticket)) return resolved.agent;
  return resolved.backend === 'codex'
    ? stableReadOnlyDispatchName(ticket.effort)
    : stableReadOnlyClaudeName(ticket.effort);
}

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

function claimTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const result = withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id); // fresh read, under the lock
    if (!t) return { ok: false, reason: 'not_found' };
    const delay = testClaimLockDelayMs();
    if (delay) busyWait(delay);
    const directClaimReason = directReason(opts.reason);
    if (opts.direct && isRoutedTicket(t) && !directClaimReason) return { ok: false, reason: 'direct_reason_required', ticket: t };
    if (opts.direct && isRoutedTicket(t) && !directReasonAllowed(directClaimReason)) return { ok: false, reason: 'direct_not_allowed', ticket: t, expectedExecutor: t.dispatchExecutor || t.exec?.agent || null };
    if (opts.direct && t.dispatchNonce) return { ok: false, reason: 'direct_conflict', ticket: t };
    if (!opts.direct && t.dispatchNonce && opts.token !== t.dispatchNonce) return { ok: false, reason: 'token', ticket: t };
    if (!opts.direct && t.dispatchNonce && opts.executor !== t.dispatchExecutor) return { ok: false, reason: 'executor_mismatch', ticket: t, expectedExecutor: t.dispatchExecutor };
    if (!opts.direct && isRoutedTicket(t) && !t.dispatchNonce) return { ok: false, reason: 'dispatch_required', ticket: t };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const currentDispatch = dispatchState(t);
    if (currentDispatch?.resumedAt && isolatedDispatchWorktreeMissing(currentDispatch)) return { ok: false, reason: 'worktree_missing', ticket: t };
    // Submitted work awaits the orchestrator's publish transaction, not another
    // executor: re-claiming it would fork the already-verified commit. The
    // orchestrator clears the submission first when rework is genuinely wanted.
    if (pendingSubmission(t) && !opts.force) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    const now = new Date().toISOString();
    t.claim = { by, at: now };
    if (t.storyId) {
      const story = getStory(slug, t.storyId);
      if (story) t.storyLogSeenSeq = Number(story.logRevision) || 0;
    }
    t.claimRelease = null; // a fresh claim supersedes any auto-release provenance
    if (opts.direct && isRoutedTicket(t)) {
      t.directClaim = {
        by,
        at: now,
        model: t.model,
        effort: t.effort,
        executor: opts.executor ? String(opts.executor) : null,
        source: opts.source ? String(opts.source) : 'store',
        reason: directReason(opts.reason),
      };
    }
    const state = dispatchState(t);
    if (state) {
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = 'claimed';
    }
    const previousStatus = t.status;
    if (opts.status !== false) t.status = coerceStatus(opts.status || 'doing', t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    if (state) stampDispatchEvent(t, opts.source || 'cli', now);
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = now;
    }
    putTicket(slug, t);
    // Tie this claim to the worker's session so a SessionEnd/SubagentStop hook can
    // release it immediately instead of waiting out the TTL. No-op without a session id.
    if (opts.sessionId) registerWorker(opts.sessionId, slug, t.id, by);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t };
  });
  if (result.reason !== 'busy' || opts.force) return result;
  const t = getTicket(slug, found.id);
  const held = t && t.claim;
  if (held && held.by && held.by !== by && !claimReclaimable(t)) {
    return { ok: false, reason: 'claimed', ticket: t, claim: held };
  }
  return result;
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
function releaseTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const releaseComment = opts.releaseComment ? prepareComment(opts.releaseComment) : null;
  if (releaseComment && !releaseComment.ok) throw new Error(`release comment ${releaseComment.reason}`);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    // A ticket that finished is done — never yanked back to another status by a
    // release racing behind it. This closes a TOCTOU window: a caller (notably
    // reconcileSession, which pre-checks status on an unlocked read taken before
    // it could get this lock) can be scheduled between a completeTicket() clearing
    // the claim and this fresh read; without this guard, the empty claim would
    // vacuously pass the ownership check below and opts.status would stomp the
    // ticket straight back to "todo", silently un-completing finished work.
    // Mirrors claimTicket's own "done" refusal just above.
    if (t.status === 'done' && !opts.force) {
      const completion = t.completion;
      const key = completion && [t.id, completion.claimAt || completion.at, by, 'done'].join(':');
      if (opts.status === 'done' && completion && completion.key === key && completion.by === by && completion.state === 'done') {
        const comment = Array.isArray(t.comments) && completion.commentId
          ? t.comments.find((entry?: any) => entry.id === completion.commentId) || null
          : null;
        return { ok: true, idempotent: true, ticket: t, comment };
      }
      return { ok: false, reason: 'done', ticket: t };
    }
    // A pending submission is the ready-for-integration queue: release --status
    // todo used to apply the status flip and leave the submission sitting there,
    // so the next claim kept refusing it as already-submitted even though the
    // ticket looked reopened (SQ-1010). --force on a reopen means "reject the
    // submission", not "look past it" — clear it as part of the explicit
    // reopen instead of silently wedging the ticket again.
    let reopenedSubmission: any = null;
    if (opts.status && pendingSubmission(t)) {
      const reopenStatus = coerceStatus(opts.status, t.status);
      if (reopenStatus !== 'done') {
        if (!opts.force) {
          return {
            ok: false,
            reason: 'pending_submission',
            ticket: t,
            submission: t.submission,
            message: `${t.ref} has a pending submission (commit ${String(t.submission.commit).slice(0, 12)}) parked READY_FOR_INTEGRATION. release cannot move it to "${reopenStatus}" and leave the submission in place. CLI: pass --force to reject the submission and reopen in one step, or run \`sidequest submit ${t.ref} --clear --status ${reopenStatus}\` first. MCP: \`submit\` with \`clear:true, status:"${reopenStatus}"\` (release has no force param over MCP).`,
          };
        }
        reopenedSubmission = t.submission;
      }
    }
    const controlPlaneDone = opts.status === 'done' && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    const executorDone = opts.status === 'done' && !controlPlaneDone;
    const dispatch = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : normalizeFiles(t.files);
    const held = t.claim;
    // Held is held. Closeout never consults a clock: an executor that actually
    // did the work must always be able to hand it in, 5 minutes or 5 hours in.
    const liveClaim = Boolean(held && held.by);
    const activeDispatch = Boolean(t.dispatchNonce || (dispatch && !dispatch.terminalAt));
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch?.nonRepoOutput === true && liveClaim && activeDispatch;
    const activeReadOnlyDispatch = dispatch?.readonly === true && liveClaim && activeDispatch;
    let sharedTreeCommittedScope = false;
    if (executorDone && liveClaim && activeDispatch) {
      const delta = dispatchDelta(slug, t);
      if (!delta.ok && dispatch?.sharedTree === true && dispatch?.baseCommit) {
        return {
          ok: false,
          reason: 'dispatch_delta_unavailable',
          message: `${t.ref} cannot inspect the full dispatch delta before done closeout. Restore the dispatch worktree or release the ticket and dispatch again.`,
          ticket: t,
        };
      }
      if (delta.ok && !activeArtifactDispatch) {
        const scopedCommitted = delta.committed.filter((file: string) => commitScope.isInScope(file, declaredFiles));
        sharedTreeCommittedScope = dispatch?.sharedTree === true && scopedCommitted.length > 0;
        const scopedWorking = delta.working.filter((file: string) => commitScope.isInScope(file, declaredFiles));
        const scopedChanges = activeReadOnlyDispatch
          ? Array.from(new Set([...scopedWorking, ...scopedCommitted]))
          : [];
        if (scopedChanges.length) {
          const paths = scopedChanges.sort();
          const mode = activeReadOnlyDispatch ? 'read-only dispatch' : 'declared scope';
          return {
            ok: false,
            reason: 'done_scope_violation',
            message: `${t.ref} cannot close with done: ${mode} has dirty or committed paths inside its declared scope since dispatch base: ${paths.join(', ')}. Scoped-commit work that belongs to this ticket after a scope request, or restore the paths that do not.`,
            ticket: t,
            unscopedPaths: paths,
          };
        }
      }
    }
    if (executorDone && activeArtifactDispatch) {
      const scopeCheck = artifactScopeCheck(slug, t, dispatch);
      if (!scopeCheck.ok) return Object.assign({ ticket: t }, scopeCheck);
    }
    // Never let an executor discover at closeout that its work is unfilable with
    // no route forward: name the auto-release and the exact recovery.
    if (executorDone && !liveClaim && t.claimRelease) {
      return {
        ok: false,
        reason: 'claim_released',
        message: autoReleasedClaimMessage(t.ref, t.claimRelease),
        ticket: t,
        claimRelease: t.claimRelease,
      };
    }
    // Whether a run produces a commit is an OUTCOME, and no dispatch-time flag
    // predicts it: a read-only contract routed through a write-capable category
    // (testing, review-audit, an investigation that declares files it only reads)
    // records readonly:false correctly and then has nothing to hand in. The
    // caller may prove that by inspecting the worktree; a proven no-op closes,
    // anything uncommitted or committed in scope still owes a submission (SQ-923).
    const provenNoOp = opts.cleanDeclaredScope === true;
    if (executorDone && dispatch && declaredFiles.length && !provenNoOp && !sharedTreeCommittedScope && !activeReadOnlyDispatch && !activeArtifactDispatch && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: 'submission_required',
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. A read-only dispatch may close with done, but readonly:false selects this write path. A run that changed nothing closes here by itself once the board can see its worktree, so this refusal means the change is real or the worktree is unreadable. If the only declared output is outside the repo worktree, release it for reclassification as non-repo/artifact work; do not retry commit.`,
        ticket: t,
      };
    }
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    const oracleRequested = nullableText(opts.oracle);
    if (oracleRequested && coerceStatus(opts.status || t.status, t.status) !== 'doing') {
      throw new Error('oracle release must keep the ticket in doing');
    }
    if (oracleRequested && t.oracle) {
      throw new Error('ticket already awaits an oracle verdict');
    }
    if (oracleRequested) oracleMarker(dispatch, opts, null);
    // The sweep decides on an unlocked snapshot; re-check under the lock so a
    // claim that came back to life in between is never released out from under it.
    if (opts.requireReleaseVerdict && !claimReleaseVerdict(t)) {
      return {
        ok: false,
        reason: 'claim_live',
        message: `${t.ref} is still live-claimed by "${held && held.by}"; the sweep re-checked it under the lock and left it alone.`,
        ticket: t,
        claim: held,
      };
    }
    const now = new Date().toISOString();
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
    if (oracleRequested) t.oracle = oracleMarker(dispatch, opts, now);
    t.claim = null;
    // Provenance for a claim taken away from its holder rather than handed back,
    // so a later closeout attempt can be refused with an actionable recovery.
    if (opts.claimRelease) {
      t.claimRelease = Object.assign({ by, at: now, source: opts.source || 'store' }, opts.claimRelease);
    }
    setDispatchTerminal(t, opts.status === 'done' ? 'done' : 'released', opts.source || 'cli');
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (reopenedSubmission) t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    if (t.status === 'todo' && (previousStatus !== 'todo' || (held && held.by))) {
      appendReworkEvent(t, 'released_to_todo', {
        at: now,
        source: opts.source || 'cli',
        by,
        fromStatus: previousStatus,
        toStatus: t.status,
      });
    }
    if (reopenedSubmission) {
      appendReworkEvent(t, 'submission_cleared', {
        at: now,
        source: opts.source || 'cli',
        by,
        fromStatus: previousStatus,
        toStatus: t.status,
      });
    }
    if (opts.workedBy) t.workedBy = opts.workedBy; // self-reported provenance stamp (done transition only)
    if (t.status === 'done') {
      t.completion = {
        key: [t.id, held && held.at ? held.at : now, by, 'done'].join(':'),
        by,
        state: 'done',
        claimAt: held && held.at ? held.at : null,
        at: now,
        commentId: null,
        ...(opts.completionProvenance || {}),
      };
      if (opts.completionComment) {
        if (!Array.isArray(t.comments)) t.comments = [];
        comment = createComment(opts.completionComment, now);
        t.comments.push(comment);
        t.completion.commentId = comment.id;
      }
    }
    // Completing a submitted ticket is the publish transaction consuming the
    // submission — stamp it integrated (kept as provenance) so the ticket
    // leaves the ready-for-integration queue the moment it goes done.
    if (t.status === 'done' && pendingSubmission(t)) {
      t.submission = Object.assign({}, t.submission, { integratedAt: new Date().toISOString() });
    }
    if (dispatch) stampDispatchEvent(t, opts.source || 'cli', now);
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = now;
    }
    putTicket(slug, t);
    // Drop this claim from the session registry — it's no longer outstanding, so a
    // later reconcile of the same session won't try to touch it (keyed on the
    // ticket, so a blank `by` on the done doesn't matter). No-op without a session id.
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return {
      ok: true,
      ticket: t,
      comment,
      ...(reopenedSubmission ? { clearedSubmission: reopenedSubmission } : {}),
      ...(opts.completionComment && opts.completionComment.advisory ? { advisory: opts.completionComment.advisory } : {}),
    };
  });
}

// Build the provenance stamp recorded when a ticket is completed — which model
// tier (or the Codex model that actually backed it) and reasoning effort worked
// it, plus who and when. Returns null when no model is supplied. A supplied model
// must be a VALID_MODELS tier OR a discovered catalog slug (a Codex-backed tier
// records the real model that ran); effort, if present, a VALID_EFFORTS level
// (null/omitted allowed — haiku has no effort). Anything else throws.
function makeWorkedBy(input?: any) {
  if (!input) return null;
  const rawModel = input.model;
  if (rawModel == null || String(rawModel).trim() === '') return null;
  const model = normalizeReportedModel(rawModel) || (input.allowUnavailable ? String(rawModel).trim().toLowerCase() : null);
  if (!model || (!input.allowUnavailable && !availableRoute(model))) {
    throw new Error(`invalid model "${rawModel}" — expected an available Claude runtime or discovered Codex model`);
  }
  let effort = null;
  const rawEffort = input.effort;
  if (rawEffort != null && String(rawEffort).trim() !== '') {
    const e = String(rawEffort).trim().toLowerCase();
    if (VALID_EFFORTS.indexOf(e) === -1) {
      throw new Error(`invalid effort "${rawEffort}" — expected one of: ${VALID_EFFORTS.join(', ')} (or omit for none)`);
    }
    effort = e;
  }
  const by = input.by != null && String(input.by).trim() ? String(input.by).trim() : null;
  const at = input.at && Number.isFinite(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
  return { model, effort, by, at };
}

// Complete a ticket: mark it done and clear its claim. An optional { model,
// effort } (from `done --model … --effort …`) is recorded as a workedBy
// provenance stamp; invalid values throw before anything is written.
function completeTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  const dispatched = resolvedDispatchRoute(ticket);
  const omittedProvenance = (opts.model == null || String(opts.model).trim() === '')
    && (opts.effort == null || String(opts.effort).trim() === '');
  const workedBy = makeWorkedBy({
    model: omittedProvenance && dispatched ? dispatched.model : opts.model,
    effort: omittedProvenance && dispatched ? dispatched.effort : opts.effort,
    by,
    allowUnavailable: Boolean(ticket && opts.model != null && normalizeRouteModel(opts.model) === normalizeRouteModel(ticket.model)),
  });
  let completionComment = null;
  if (opts.body != null && String(opts.body).trim()) {
    completionComment = prepareComment({ by, body: opts.body, kind: 'comment', source: opts.source || 'cli' });
    if (!completionComment.ok) {
      throw new Error(`completion comment ${completionComment.reason}`);
    }
  }
  return releaseTicket(slug, idOrRef, by, Object.assign({}, opts, {
    status: 'done',
    workedBy,
    completionComment,
  }));
}

function recordedReviewPass(ticket?: any) {
  return Array.isArray(ticket?.comments) && ticket.comments.some((comment?: any) => /^\s*reviewed-by\s*:\s*\S/i.test(String(comment?.body || '')));
}

const HIGH_STAKES_REVIEW_WARNING = 'high-stakes ticket integrated without a recorded review pass';

function completeTicketAsControlPlane(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const purpose = String(opts.purpose || '').trim();
  if (!['grooming', 'integration'].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming" or "integration".');
  }
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  const state = dispatchState(ticket);
  if (purpose === 'grooming') {
    if ((ticket.claim && ticket.claim.by && !claimReclaimable(ticket)) || ticket.dispatchNonce || (state && !state.terminalAt)) {
      const holder = ticket.claim && ticket.claim.by ? String(ticket.claim.by) : '<claim holder>';
      return {
        ok: false,
        reason: 'active_dispatch',
        message: `${ticket.ref} still has a live claim or an open dispatch, so grooming cannot close it. Release it first: \`sidequest release ${ticket.ref} --by ${holder}\`, then re-run this closure with the same evidence. Releasing does not discard work already committed.`,
        ticket,
      };
    }
    if (pendingSubmission(ticket)) return { ok: false, reason: 'pending_submission', ticket };
  }
  if (purpose === 'integration' && !pendingSubmission(ticket)) {
    return {
      ok: false,
      reason: 'submission_required',
      message: `${ticket.ref} has no submission to consume, so an integration closure has nothing to integrate. A submission only exists after its executor ran commit and then submit. When the work shipped outside that flow — the usual case is the orchestrator committing an executor's changes out of the shared tree after it lost its worktree — release the claim (\`sidequest release ${ticket.ref} --by <claim holder>\`) and close it as plain grooming with the shipped commit as evidence, without --integration.`,
      ticket,
    };
  }
  const reason = String(opts.reason || '').trim();
  if (!reason) return { ok: false, reason: 'evidence_required', ticket };
  const by = String(opts.by || '').trim();
  if (!by) return { ok: false, reason: 'identity_required', ticket };
  let legacyScopeOverride = false;
  if (purpose === 'integration') {
    const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
    if (!admitted.ok) return admitted;
    legacyScopeOverride = !!admitted.legacyScopeOverride;
  }
  const advisory = purpose === 'integration' && ticket.highStakes && !recordedReviewPass(ticket)
    ? HIGH_STAKES_REVIEW_WARNING
    : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: Object.assign(
      { authority: 'control-plane', purpose, reason },
      legacyScopeOverride ? { legacyScopeOverride: { reason } } : {},
    ),
  }));
  return advisory ? Object.assign(result, { advisory }) : result;
}

function closeTicketForGrooming(slug?: any, idOrRef?: any, opts?: any) {
  return completeTicketAsControlPlane(slug, idOrRef, Object.assign({}, opts, { purpose: 'grooming' }));
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

// Expire only dispatches that remained prepared. Launched and bound dispatches are stateful work, not wall-clock leases.
function sweepStaleDispatches(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const expired: any[] = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done' || !expiredPreparedDispatch(dispatchState(ticket), now)) continue;
      try {
        const res = withTicketLock(project.slug, ticket.id, () => {
          const current = getTicket(project.slug, ticket.id);
          if (!current || !expiredPreparedDispatch(dispatchState(current), now)) return { ok: false };
          setDispatchTerminal(current, 'expired', source);
          current.dispatchNonce = null;
          current.dispatchExecutor = null;
          stampDispatchEvent(current, source);
          putTicket(project.slug, current);
          return { ok: true, ticket: current };
        });
        if (!res || !res.ok) continue;
        expired.push({ project: project.slug, ref: res.ticket.ref });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: `Auto-expired prepared dispatch: it never launched within the ${Math.round(preparedDispatchTtlMs() / 3600000)} hour TTL.`,
        });
      } catch (_: any) {
        // One inaccessible board must not prevent other stale dispatches from recovering.
      }
    }
  }
  return { ok: true, ttlMs: preparedDispatchTtlMs(), expired };
}

// Garbage-collect claims whose holder is gone: an observed stop first, then the
// idle/abandoned backstops for deaths nothing reported. Each release re-checks
// the verdict under the ticket lock, so a claim that is merely quiet — or one
// replaced since the snapshot — is never swept.
function sweepStaleClaims(opts?: any) {
  opts = opts || {};
  const source = opts.source ? String(opts.source) : 'sweep';
  const released: any[] = [];
  for (const project of listProjects({ all: true })) {
    if (opts.project && project.slug !== opts.project) continue;
    for (const ticket of listTickets(project.slug)) {
      if (ticket.archived || ticket.status === 'done') continue;
      const verdict = claimReleaseVerdict(ticket);
      if (!verdict) continue;
      try {
        const res = releaseTicket(project.slug, ticket.id, ticket.claim.by, {
          status: 'todo',
          source,
          requireReleaseVerdict: true,
          claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null },
        });
        if (!res.ok) continue;
        released.push({ project: project.slug, ref: ticket.ref, kind: verdict.kind });
        addComment(project.slug, ticket.id, {
          by: 'sidequest', kind: 'comment', source,
          body: claimReleaseNote(ticket, verdict),
        });
      } catch (_: any) {
        // One inaccessible board must not prevent other dead claims from recovering.
      }
    }
  }
  const dispatches = sweepStaleDispatches(opts);
  return { ok: true, idleMs: claimIdleMs(), abandonMs: claimAbandonMs(), released, expiredDispatches: dispatches.expired };
}

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
function readyTickets(slug?: any, opts?: any) {
  opts = opts || {};
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  return listTickets(slug)
    .filter((t?: any) => !t.archived)
    .filter((t?: any) => t.status !== 'done')
    .filter((t?: any) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t?: any) => !t.claim || claimReclaimable(t))
    .filter((t?: any) => !isBlocked(slug, t))
    .filter((t?: any) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t?: any) => !category || t.categoryId === category)
    .sort((a: any, b: any) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

// Atomically claim the best available ticket in a project: highest priority
// first, oldest-first within a priority. Skips done tickets and ones actively
// claimed by another worker. Returns { ok:true, ticket } or { reason:'empty' }.
function claimNext(slug?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const want = opts.model ? classifyModelFilter(opts.model) : 'any';
  if (want === 'unknown') throw new Error(`Unknown model: ${opts.model}`);
  const category = opts.category == null ? null : String(opts.category).trim().toLowerCase();
  const candidates = listTickets(slug)
    .filter((t?: any) => !t.archived)
    .filter((t?: any) => t.status !== 'done')
    .filter((t?: any) => !pendingSubmission(t)) // parked for integration, not for another executor
    .filter((t?: any) => !t.claim || claimReclaimable(t) || t.claim.by === by)
    .filter((t?: any) => !opts.priority || t.priority === String(opts.priority).toLowerCase())
    .filter((t?: any) => modelMatches(t.model, want === 'any' ? null : want))
    .filter((t?: any) => !category || t.categoryId === category) // a tier-X worker only claims X-tagged work
    .filter((t?: any) => opts.includeBlocked || !isBlocked(slug, t)) // never auto-hand-out blocked work
    .sort((a: any, b: any) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  for (const cand of candidates) {
    const res = claimTicket(slug, cand.id, by, { direct: !!opts.direct, reason: opts.reason, source: opts.source, sessionId: opts.sessionId });
    if (res.ok || res.reason === 'direct_not_allowed' || res.reason === 'direct_reason_required') return res;
    // Lost the race or it changed under us — try the next candidate.
  }
  return { ok: false, reason: 'empty' };
}

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
function claimPulse(ticket?: any, now?: any) {
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
    verifying: Boolean(claimVerification(ticket)),
  };
}

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

function readServerInfo() {
  return readGlobal('server-info', null);
}
function writeServerInfo(info?: any) {
  writeGlobal('server-info', info);
}
function clearServerInfo() {
  deleteCachedRow(database(), 'globals', 'server-info');
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
  updateTicket,
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
  updateStory,
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
  submissionProjection,
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
  sessionClaims,
};
