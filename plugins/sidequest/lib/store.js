"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dispatchLaunchName, stableClaudeName, stableDispatchName, stableReadOnlyClaudeName, stableReadOnlyDispatchName } = require("./exec-names.js");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const db = require("./db.js");
const { registerSourceRevisionCapability } = require("./source-revision-capability.js");
const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, starterRoutingProfilesFor } = require("./category-defaults.js");
const commitScope = require("./commit-scope.js");
const { commitPaths } = commitScope;
const { preferredWorktreeIntegrationTarget, agentWorktreePath, agentWorktreeCandidates, resolvedAgentWorktree, reclaimUnclaimedDispatchWorktree } = require("./worktrees.js");
const { canonicalPath, checkoutInstanceIdentity, createWorktreeLease, worktreeResumeDecision, isCanonicalRegisteredWorktree } = require("./kernel/worktree.js");
const { migrateIfNeeded } = require("./migrate.js");
const { discoverExternalModels, providerReadiness } = require("./discovery.js");
const telemetry = require("./telemetry.js");
const { negativeControlRecoveryGuidance, routingDisabledMessage } = require("./refusal-guidance.js");
const { canonicalPreparedDispatchExecutor, normalizePreparedDispatch } = require("./prepared-dispatch.js");
const { assertSidequestInstall, checkSidequestInstall, assertDispatchTransport, ensurePythonIoEncoding, localAheadOfUpstreamWarning } = require("./dispatch-preflight.js");
const { prepareAttempt, prepareDirectAttempt, transitionAttempt, attemptDiagnostic } = require("./kernel/index.js");
const { sourceRevision } = require("./source-revision-capability.js");
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
const { createPaths } = require("./store/paths.js");
const { createCache } = require("./store/cache.js");
const { createConfig } = require("./store/config.js");
const { createSweeps } = require("./store/sweeps.js");
const { createServer } = require("./store/server.js");
const { createProjects } = require("./store/projects.js");
const { createWarnings } = require("./store/warnings.js");
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
function normalizeAutoApproveTestScope(...args) {
  return configLayer.normalizeAutoApproveTestScope(...args);
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
function executionScope(slug, ticket) {
  const dispatch2 = ticket?.dispatch;
  const bound = dispatch2 && !dispatch2.terminalAt ? dispatch2.declaredFiles : null;
  return Array.isArray(bound) && bound.length ? bound : effectiveScope(slug, ticket?.files);
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
let warningsLayer;
let DISPATCH_DESCRIPTION_MIN;
function executorText(...args) {
  return warningsLayer.executorText(...args);
}
function manualVerify(...args) {
  return warningsLayer.manualVerify(...args);
}
const VERIFY_ORACLE_KINDS = ["command", "attestation"];
function normalizeVerifyOracleKind(...args) {
  return warningsLayer.normalizeVerifyOracleKind(...args);
}
function attestationErrors(...args) {
  return warningsLayer.attestationErrors(...args);
}
function verifyOracleErrors(...args) {
  return warningsLayer.verifyOracleErrors(...args);
}
function requireVerifyOracle(...args) {
  return warningsLayer.requireVerifyOracle(...args);
}
function verifyCommandErrors(...args) {
  return warningsLayer.verifyCommandErrors(...args);
}
function verifyCommandError(...args) {
  return warningsLayer.verifyCommandError(...args);
}
function requireVerifyCommand(...args) {
  warningsLayer.requireVerifyCommand(...args);
  const command = String(args[0] || "").trim();
  const pluginDirectoryChanges = command.match(/(?:^|[;&]{1,2})\s*cd\s+plugins\/[^\s;&]+/g) || [];
  if (pluginDirectoryChanges.length > 1) {
    throw new Error("multi-plugin verify commands must use one subshell per plugin joined with &&, for example: (cd plugins/a && npm test) && (cd plugins/b && npm test)");
  }
}
function ticketReferenceWarnings(...args) {
  return warningsLayer.ticketReferenceWarnings(...args);
}
function ticketPrescribesFix(...args) {
  return warningsLayer.ticketPrescribesFix(...args);
}
function ticketCategoryWarnings(...args) {
  return warningsLayer.ticketCategoryWarnings(...args);
}
function readonlyCategoryWriteIntentWarning(...args) {
  return warningsLayer.readonlyCategoryWriteIntentWarning(...args);
}
function noDeclaredScopeWarning(...args) {
  return warningsLayer.noDeclaredScopeWarning(...args);
}
function readonlyBrowserReviewWarning(...args) {
  return warningsLayer.readonlyBrowserReviewWarning(...args);
}
function relativePathWithin(...args) {
  return warningsLayer.relativePathWithin(...args);
}
function packageRootForScope(...args) {
  return warningsLayer.packageRootForScope(...args);
}
function buildOutputDirectories(...args) {
  return warningsLayer.buildOutputDirectories(...args);
}
function packageBuildOutputs(...args) {
  return warningsLayer.packageBuildOutputs(...args);
}
function isTrackedBuildOutput(...args) {
  return warningsLayer.isTrackedBuildOutput(...args);
}
function scopeIncludesPath(...args) {
  return warningsLayer.scopeIncludesPath(...args);
}
function sourceBuildOutputWarnings(...args) {
  return warningsLayer.sourceBuildOutputWarnings(...args);
}
function verifyCommandWarning(...args) {
  return warningsLayer.verifyCommandWarning(...args);
}
function dispatchVerifyCommandError(...args) {
  return warningsLayer.dispatchVerifyCommandError(...args);
}
function dispatchDescriptionError(...args) {
  return warningsLayer.dispatchDescriptionError(...args);
}
function storyContractDriftWarnings(...args) {
  return warningsLayer.storyContractDriftWarnings(...args);
}
function crossTicketStateWarnings(...args) {
  return warningsLayer.crossTicketStateWarnings(...args);
}
function staleWorktreeCwdWarning(...args) {
  return warningsLayer.staleWorktreeCwdWarning(...args);
}
function dispatchUncertaintyWarnings(...args) {
  return warningsLayer.dispatchUncertaintyWarnings(...args);
}
function dispatchWarnings(ticket, slug) {
  const project = !slug && process.env.CLAUDE_PROJECT_DIR ? findProject(process.env.CLAUDE_PROJECT_DIR) : null;
  return warningsLayer.dispatchWarnings(ticket, slug || (project?.ok ? project.slug : null));
}
function dispatchDeclaredFiles(...args) {
  return warningsLayer.dispatchDeclaredFiles(...args);
}
function externalDeclaredFiles(...args) {
  return warningsLayer.externalDeclaredFiles(...args);
}
function nonRepoExternalOutput(...args) {
  return warningsLayer.nonRepoExternalOutput(...args);
}
function fencedBlocks(...args) {
  return warningsLayer.fencedBlocks(...args);
}
function diffShapedBlock(...args) {
  return warningsLayer.diffShapedBlock(...args);
}
function evidenceShapedBlock(...args) {
  return warningsLayer.evidenceShapedBlock(...args);
}
function embedsCompleteEdit(...args) {
  return warningsLayer.embedsCompleteEdit(...args);
}
function presolvedRoutingWarnings(...args) {
  return warningsLayer.presolvedRoutingWarnings(...args);
}
function scopeConsumerWarningDetails(...args) {
  return warningsLayer.scopeConsumerWarningDetails(...args);
}
function ticketPlanningWarnings(ticket, projectPath) {
  const project = projectPath ? findProject(projectPath) : null;
  return warningsLayer.ticketPlanningWarnings(ticket, projectPath, project?.ok ? project.slug : null);
}
function presentWarnings(...args) {
  return warningsLayer.presentWarnings(...args);
}
function normalizeReadonlyOverride(...args) {
  return warningsLayer.normalizeReadonlyOverride(...args);
}
function requestedReadonlyOverride(...args) {
  return warningsLayer.requestedReadonlyOverride(...args);
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
  classifyDispatchFailure,
  terminalAgentFailure,
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
  resolveTicketRoute,
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
  executorClaimDispatchRefusal,
  sharedTreeRuntimeRefusal,
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
  appendReworkEvent,
  dispatchTokenDigest,
  dispatchTokenMatches,
  dispatchTokenForRequest,
  isSupersededDispatchToken,
  routingPolicyAffectsTicket,
  expiredPreparedDispatch,
  worktreeIsolationWarning,
  prepareDispatch,
  supersedeUnclaimedLaunch,
  readDispatchBriefing,
  recordDispatchLaunch,
  recordDispatchAgentFailure,
  recoverDispatchQuotaFailure,
  bindDispatchWorktreeCreation,
  completeDispatchWorktreeCreation,
  recoverDispatchWorktreeCreation,
  dispatchIsolationExpectation,
  dispatchWorkspace,
  dispatchDelta,
  activeSharedTreeClaim,
  dispatchIdentityAmbiguous,
  dispatchCanBindRuntimeIdentity,
  recordDispatchRuntimeIdentity,
  bindDispatchClaimToken,
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
  canonicalPath,
  checkoutInstanceIdentity,
  createWorktreeLease,
  worktreeResumeDecision,
  isCanonicalRegisteredWorktree,
  classifyDispatchFailure: (...args) => classifyDispatchFailure(...args),
  terminalAgentFailure: (...args) => terminalAgentFailure(...args),
  SHARED_TREE_ARTIFACT_MARKER,
  assertDispatchTransport,
  assertSidequestInstall,
  checkSidequestInstall,
  prepareAttempt,
  transitionAttempt,
  attemptDiagnostic,
  ensurePythonIoEncoding,
  localAheadOfUpstreamWarning,
  availableRoute: (...args) => availableRoute(...args),
  boardConfig,
  claimReclaimable: (...args) => claimReclaimable(...args),
  claimVerification: (...args) => claimVerification(...args),
  commitScope,
  crypto,
  database,
  db,
  dispatchReadOnly: (...args) => dispatchReadOnly(...args),
  dispatchVerifyCommandError: (...args) => dispatchVerifyCommandError(...args),
  dispatchRouteRefusal: (...args) => dispatchRouteRefusal(...args),
  dispatchRouteState: (...args) => dispatchRouteState(...args),
  effectiveScope: (...args) => effectiveScope(...args),
  execFileSync,
  execProjection: (...args) => execProjection(...args),
  fs,
  getCategory: (...args) => getCategory(...args),
  getStory: (...args) => getStory(...args),
  homeRoot: () => process.env.SIDEQUEST_HOME || path.join(os.homedir(), ".claude", "sidequest"),
  integrationTarget,
  preferredWorktreeIntegrationTarget,
  agentWorktreePath,
  agentWorktreeCandidates,
  resolvedAgentWorktree,
  reclaimUnclaimedDispatchWorktree,
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
  releaseTerminalClaim,
  resolveCategoryFallback: (...args) => resolveCategoryFallback(...args),
  resolveTicketRoute: (...args) => resolveTicketRoute(...args),
  resolveCategoryRoute: (...args) => resolveCategoryRoute(...args),
  resolveExec: (...args) => resolveExec(...args),
  stableExecutorName,
  staleWorktreeCwdWarning: (...args) => staleWorktreeCwdWarning(...args),
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
  const title = String(ticket && ticket.title || "Sidequest ticket").replace(/\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(?:low|medium|high|xhigh|max)\]/gi, " ").replace(/\s+/g, " ").trim() || "Sidequest ticket";
  const model = descriptionField(resolved && resolved.runsLabel, resolved && resolved.runsModel, ticket && ticket.model) || "unrouted";
  const effort = descriptionField(ticket && ticket.effort, resolved && resolved.effort) || "unset";
  const prefix = `${model}, ${effort} · `;
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
function isTestSidePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized) || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(normalized);
}
function negativeControlFailureKind(body) {
  const text = String(body || "");
  if (/\bimport\s*error\b/i.test(text)) return "import_error";
  if (/\bcollection\s+(?:error|failed|failure)\b/i.test(text)) return "collection_error";
  return "";
}
function changedTestNames(delta, changedPaths) {
  if (!delta?.workspace) return [];
  const names = /* @__PURE__ */ new Set();
  for (const file of changedPaths || []) {
    if (!isTestSidePath(file)) continue;
    let source = "";
    let diff = "";
    try {
      source = fs.readFileSync(path.join(delta.workspace.root, file), "utf8");
    } catch (_) {
      continue;
    }
    try {
      diff = execFileSync("git", ["diff", "--no-ext-diff", "--unified=0", delta.workspace.base, "--", file], {
        cwd: delta.workspace.root,
        encoding: "utf8",
        windowsHide: true
      });
    } catch (_) {
      continue;
    }
    const definitions = source.split(/\r?\n/).map((line, index) => {
      const match = line.match(/\b(?:test|it|specify)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/) || line.match(/\bdef\s+(test_[A-Za-z0-9_]+)/);
      return match ? { line: index + 1, name: match[2] || match[1] } : null;
    }).filter(Boolean);
    try {
      execFileSync("git", ["cat-file", "-e", `${delta.workspace.base}:${file}`], {
        cwd: delta.workspace.root,
        stdio: "ignore",
        windowsHide: true
      });
    } catch (_) {
      for (const definition of definitions) names.add(definition.name);
      continue;
    }
    let newLine = 0;
    let changedInHunk = false;
    const addNearestDefinition = (line) => {
      const definition = definitions.filter((entry) => entry.line <= line).at(-1);
      if (definition) names.add(definition.name);
    };
    for (const line of diff.split(/\r?\n/)) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        if (changedInHunk) addNearestDefinition(newLine);
        newLine = Number(hunk[1]);
        changedInHunk = false;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        changedInHunk = true;
        const addedDefinition = line.match(/\b(?:test|it|specify)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/) || line.match(/\bdef\s+(test_[A-Za-z0-9_]+)/);
        const addedName = addedDefinition?.[2] || addedDefinition?.[1];
        if (addedName) names.add(addedName);
        addNearestDefinition(newLine);
        newLine += 1;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        changedInHunk = true;
        continue;
      }
      if (line.startsWith(" ")) newLine += 1;
    }
    if (changedInHunk) addNearestDefinition(newLine);
  }
  return Array.from(names);
}
function negativeControlTestReport(body, expectedTestNames = []) {
  const details = String(body || "").split(/\r?\n/).map((line) => line.trim().match(/^\[sidequest:negative-control-test\]\s+(.*)$/i)?.[1] || "").filter(Boolean);
  const unreported = expectedTestNames.filter((name) => !details.some((detail) => {
    const reportedName = detail.match(/^(failed|unaffected)\s+(.+)$/i)?.[2];
    return reportedName?.includes(name) === true;
  }));
  return unreported;
}
function negativeControlResult(ticket, expectedTestNames = []) {
  const claimHolder = String(ticket?.claim?.by || "").trim();
  if (!claimHolder) return { kind: "missing" };
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  let otherControlAuthor = "";
  let malformedMarkerLine = "";
  for (const comment of comments.slice().reverse()) {
    const body = String(comment.body || "").trim();
    const markerLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("[sidequest:negative-control]"));
    if (comment?.by !== claimHolder) {
      if (!otherControlAuthor && markerLine) otherControlAuthor = String(comment?.by || "unknown");
      continue;
    }
    if (!markerLine) continue;
    const waived = markerLine.match(/^\[sidequest:negative-control\]\s+waived\s+(.+)/);
    const waiverReason = waived?.[1]?.trim();
    if (waiverReason) return waiverReason.length >= 20 ? { kind: "waived" } : { kind: "short_waiver" };
    const failed = markerLine.match(/^\[sidequest:negative-control\]\s+target=([^;]+);\s*assertion=([^;]+);\s*(.+?)\s+failed=(\d+)/);
    if (failed) {
      if (!failed[1]?.trim() || !failed[2]?.trim()) return { kind: "missing_target_or_assertion" };
      if (Number(failed[4]) === 0) return { kind: "zero_failures" };
      const failureKind = negativeControlFailureKind(body);
      if (failureKind) return { kind: failureKind };
      const unreportedTests = negativeControlTestReport(body, expectedTestNames);
      return unreportedTests.length ? { kind: "unreported_tests", tests: unreportedTests } : { kind: "failed" };
    }
    if (/^\[sidequest:negative-control\]\s+.+?\s+failed=\d+/.test(markerLine)) return { kind: "missing_target_or_assertion" };
    if (!malformedMarkerLine) malformedMarkerLine = markerLine;
  }
  if (malformedMarkerLine) return { kind: "malformed_marker", markerLine: malformedMarkerLine };
  return otherControlAuthor ? { kind: "wrong_author", by: otherControlAuthor } : { kind: "missing" };
}
function negativeControlRefusal(ticket, result) {
  const recipe = negativeControlRecoveryGuidance();
  if (result.kind === "import_error" || result.kind === "collection_error") {
    const failure = result.kind === "import_error" ? "an ImportError" : "a collection error";
    return {
      ok: false,
      reason: `negative_control_${result.kind}`,
      message: `${ticket.ref} completion refused: the recorded negative control failed with ${failure}. ${recipe}`
    };
  }
  if (result.kind === "missing_target_or_assertion") {
    return {
      ok: false,
      reason: "negative_control_evidence_required",
      message: `${ticket.ref} completion refused: the negative control must name the broken target and the assertion that failed. ${recipe}`
    };
  }
  if (result.kind === "zero_failures") {
    return {
      ok: false,
      reason: "negative_control_zero_failures",
      message: `${ticket.ref} completion refused: failed=0 means tests passed against the pre-change code and do not test the change. ${recipe}`
    };
  }
  if (result.kind === "unreported_tests") {
    return {
      ok: false,
      reason: "negative_control_test_required",
      message: `${ticket.ref} completion refused: the negative control did not report these added or modified tests: ${result.tests.join(", ")}. ${recipe}`
    };
  }
  if (result.kind === "short_waiver") {
    return {
      ok: false,
      reason: "negative_control_waiver_too_short",
      message: `${ticket.ref} completion refused: a negative-control waiver needs a reason of at least 20 characters. ${recipe}`
    };
  }
  if (result.kind === "malformed_marker") {
    return {
      ok: false,
      reason: "negative_control_required",
      message: `${ticket.ref} completion refused: found negative-control marker line "${result.markerLine}", but the number was not where it was expected. ${recipe}`
    };
  }
  if (result.kind === "wrong_author") {
    return {
      ok: false,
      reason: "negative_control_required",
      message: `${ticket.ref} completion refused: a negative control was recorded by "${result.by}", but the current claim holder is "${ticket.claim.by}". ${recipe}`
    };
  }
  return {
    ok: false,
    reason: "negative_control_required",
    message: `${ticket.ref} completion refused: changed scoped paths include both test-side and non-test-side files, but the claim holder has not recorded a negative control. ${recipe}`
  };
}
function completionTreeCheck(slug, ticket, opts) {
  const state = dispatchState(ticket);
  if (!state || state.readonly === true || state.nonRepoOutput === true) return { ok: true, applicable: false };
  const declaredFiles = executionScope(slug, ticket);
  if (!declaredFiles.length) return { ok: true, applicable: false };
  const delta = dispatchDelta(slug, ticket);
  if (!delta.ok) return { ok: true, applicable: false, unavailable: true };
  const changedPaths = Array.from(/* @__PURE__ */ new Set([...delta.working, ...delta.committed])).filter((file) => commitScope.isInScope(file, declaredFiles)).sort();
  if (!changedPaths.length && opts?.explicitNoOp !== true) {
    return {
      ok: false,
      reason: "empty_declared_scope",
      declaredFiles,
      message: `${ticket.ref} completion refused: its declared write scope has an empty diff since dispatch base. Declared files: ${declaredFiles.join(", ")}. If this run intentionally made no repository change, report [sidequest:verify-complete] no-op: <evidence>; verification outcomes use [sidequest:verify-complete] <passed|failed-suite|failed|could-not-run>: <evidence>.`
    };
  }
  if (changedPaths.some(isTestSidePath) && changedPaths.some((file) => !isTestSidePath(file))) {
    const negativeControl = negativeControlResult(ticket, changedTestNames(delta, changedPaths));
    if (negativeControl.kind !== "failed" && negativeControl.kind !== "waived") return negativeControlRefusal(ticket, negativeControl);
  }
  return { ok: true, applicable: true, changedPaths, noOp: !changedPaths.length };
}
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
  claimReleaseBlocker,
  claimReleaseNote,
  claimReleaseVerdict,
  claimVerification,
  hasNoOpReleaseProof,
  preparedDispatchTtlMs,
  recordClaimVerification,
  releaseCommentBody,
  technicalBlockerRelease,
  verificationCompletionCheck,
  touchClaim,
  touchClaimActivity
} = createClaims({
  completionTreeCheck,
  dispatchDelta,
  dispatchState,
  isolatedDispatchWorktreeMissing,
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
  verificationCompletionCheck,
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
  writeOracleExperimentRound,
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
  requestScope,
  migrateLegacyScopeRequest,
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
  dispatchVerifyCommandError,
  effectiveScope,
  execFileSync,
  executorText,
  fs,
  getCategory,
  getStory: (...args) => getStory(...args),
  getTicket,
  listTickets,
  makeWorkedBy,
  newTicketId,
  nextSeq,
  normalizeRoute,
  path,
  pendingSubmission: pendingSubmissionForTickets,
  putTicket,
  queryTickets,
  queueEventNotification,
  readMeta,
  readyTickets,
  releaseLock,
  requestedReadonlyOverride,
  requireStatus,
  requireVerifyOracle,
  normalizeVerifyOracleKind,
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
  submissionUsesGit,
  verifyIntegration,
  validateIntegrationSubmission,
  integrateSubmission,
  closeSubmissionAsSuperseded,
  submissionOwnershipFailure,
  submitTicket,
  recordSubmissionRejection,
  reconcileSubmissionRejections,
  reworkSubmission,
  clearSubmission,
  submissionBaseCandidates,
  submissionsPayload
} = createSubmissions({
  EXECUTOR_VERIFY_MAX,
  INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES,
  MANUAL_VERIFY_PREFIX,
  acquireLock,
  addComment,
  appendReworkEvent,
  artifactWorkingState,
  autoReleasedClaimMessage,
  boardConfig,
  boundedExcerptForSubmission: (...args) => boundedExcerpt(...args),
  claimReclaimable,
  commitScope,
  completionTreeCheck,
  coerceStatus,
  createComment,
  crypto,
  dirtyPathKey,
  dispatchState,
  executionScope,
  ensureDir,
  execFileSync,
  fs,
  getTicket,
  listTickets,
  manualVerify,
  VERIFY_ORACLE_KINDS,
  normalizeVerifyOracleKind,
  attestationErrors,
  verifyOracleErrors,
  requireVerifyOracle,
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
  recordLifecycleAttempt,
  releaseLock,
  setDispatchTerminal,
  spawnSync,
  stampDispatchEvent,
  ticketLockPath,
  transaction,
  transitionAttempt,
  attemptDiagnostic,
  unregisterClaim,
  verifyCommandErrors,
  verifyCommandError,
  withTicketLock
});
let refreshingRoutingProfileSeeds = false;
function installedProviderSeedProfiles() {
  return starterRoutingProfilesFor(discoverExternalModels().filter((model) => providerReadiness(model.provider)?.ready === true));
}
function refreshRoutingProfileSeeds(handle) {
  const pending = [];
  for (const seed of installedProviderSeedProfiles()) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null) continue;
    const existing = handle.prepare(`
      SELECT category_id, data, position FROM routing_profile_entries
      WHERE profile_id = ? ORDER BY position, category_id
    `).all(profile.id);
    const matchesSeed = existing.length === seed.categories.length && existing.every((entry, position) => entry.category_id === seed.categories[position].id && entry.data === JSON.stringify(seed.categories[position]) && Number(entry.position) === position);
    if (Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION && matchesSeed) continue;
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
    refreshPreparedDispatches(handle, [...affected], null, { preservePrepared: true });
  });
  invalidateStoreCaches();
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
    dbByHome.set(root, handle);
    refreshReadonlyCategorySeeds(handle);
  }
  if (!refreshingRoutingProfileSeeds) {
    refreshingRoutingProfileSeeds = true;
    try {
      refreshRoutingProfileSeeds(handle);
    } finally {
      refreshingRoutingProfileSeeds = false;
    }
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
const VALID_STATUS = ["todo", "doing", "awaiting-oracle", "done"];
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
configLayer = createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs, getProjectCategories, isTrackedBuildOutput: (...args) => warningsLayer?.isTrackedBuildOutput(...args), packageBuildOutputs: (...args) => warningsLayer?.packageBuildOutputs(...args) || [], packageRootForScope: (...args) => warningsLayer?.packageRootForScope(...args), path, projectRoutingProfile, readMeta, routingProfileEntries, MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject });
function parseTicketData(slug, data) {
  try {
    const ticket = typeof data === "string" ? JSON.parse(data) : data;
    return ticket && ticket.id ? applyDerivedRouting(normalizePreparedDispatch(ticket), { project: slug }) : null;
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
function lifecycleBaseline(ticket, purpose) {
  const preparedAt = String(ticket.dispatch?.preparedAt || ticket.updatedAt || (/* @__PURE__ */ new Date()).toISOString());
  return Object.freeze({ revision: Object.freeze({ source: "board", value: String(ticket.id || ticket.ref), observedAt: preparedAt }), purpose });
}
function recordLifecycleAttempt(ticket, attempt) {
  ticket.lifecycleAttempt = attempt;
  if (ticket.dispatch) ticket.dispatch.lifecycleAttempt = attempt;
}
function lifecycleAttemptFromFacts(ticket, authority, purpose, direct) {
  const persistedAttempt = ticket.lifecycleAttempt || ticket.dispatch?.lifecycleAttempt;
  const baseline = persistedAttempt?.baseline || lifecycleBaseline(ticket, purpose);
  const preparedCompatibility = persistedAttempt?.preparedCompatibility || ticket.dispatch?.preparedCompatibility;
  let current = direct ? prepareDirectAttempt(baseline, persistedAttempt?.authority || authority) : prepareAttempt(baseline, persistedAttempt?.authority || authority, preparedCompatibility);
  const dispatch2 = ticket.dispatch;
  if (direct) {
    if (ticket.claim || ticket.submission) current = transitionAttempt(current, "claim_direct");
  } else if (dispatch2) {
    if (dispatch2.launchedAt) current = transitionAttempt(current, "launch");
    if (dispatch2.boundAt || ticket.claim || ticket.submission) {
      current = transitionAttempt(current, current.state === "launched" ? "bind" : "bind_claim_token");
    }
    if (ticket.claim || ticket.submission) current = transitionAttempt(current, "claim");
  }
  if (ticket.submission) {
    for (const event of ["start_work", "verify", "submit"]) current = transitionAttempt(current, event);
  }
  const diagnostic = attemptDiagnostic(current);
  if (diagnostic) throw new Error(`lifecycle refused ${ticket.ref}: ${diagnostic.message}`);
  return current;
}
function liveRuntimeClaim(slug, ticket, by) {
  const claimant = String(by || "").trim();
  if (!claimant) return null;
  for (const project of listProjects({ all: true })) {
    for (const candidate of listTickets(project.slug)) {
      const dispatch2 = dispatchState(candidate);
      if (project.slug === slug && candidate.id === ticket?.id) continue;
      if (!candidate.claim?.by || candidate.claim.by !== claimant || candidate.status === "done" || !dispatch2 || dispatch2.terminalAt || claimReclaimable(candidate)) continue;
      return candidate;
    }
  }
  return null;
}
function claimAdmission(slug, idOrRef, opts) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: "not_found" };
  if (opts.direct) return { ok: true, ticket, token: null };
  if (opts.effort != null) {
    const derivedEffort = ticket.effort || (CLAUDE_RUNTIMES.includes(ticket.model) ? "low" : null);
    const claimedEffort = String(opts.effort).toLowerCase();
    if (derivedEffort && claimedEffort !== derivedEffort) {
      const resolved = resolveExec(ticket.model, derivedEffort);
      const expectedExecutor = ticket.exec && ticket.exec.agent || resolved && resolved.agent || `sidequest-exec-${derivedEffort}`;
      return {
        ok: false,
        reason: "effort_mismatch",
        ticket,
        derivedModel: ticket.model,
        derivedEffort,
        claimedEffort,
        expectedExecutor,
        message: `${ticket.ref} resolves to ${ticket.model}·${derivedEffort}, but ${claimedEffort} was requested. Run sidequest dispatch ${ticket.ref}, then spawn ${expectedExecutor}.`
      };
    }
  }
  const token = dispatchTokenForRequest(opts.token, opts.tokenFile);
  if (!ticket.dispatchNonce) {
    if (!opts.executor || !ticket.exec || ticket.exec.backend !== "codex" || opts.executor === ticket.exec.agent) {
      return { ok: true, ticket, token };
    }
    return {
      ok: false,
      reason: "executor_mismatch",
      ticket,
      derivedModel: ticket.model,
      derivedEffort: ticket.effort,
      executor: opts.executor,
      expectedExecutor: ticket.exec.agent,
      message: `${ticket.ref} resolves to ${ticket.exec.runsLabel} · ${ticket.effort} (${ticket.exec.backend}), but ${opts.executor} is not its generated executor. Run sidequest dispatch ${ticket.ref}, then spawn ${ticket.exec.agent}.`
    };
  }
  if (!dispatchTokenMatches(ticket.dispatchNonce, token)) {
    if (isSupersededDispatchToken(ticket, token)) {
      return {
        ok: false,
        reason: "token",
        ticket,
        message: `${ticket.ref}'s dispatch was superseded by a newer preparation. Re-read this dispatch's token from its own briefing before claiming.`
      };
    }
    return { ok: false, reason: "token", ticket };
  }
  const preparedExecutor = canonicalPreparedDispatchExecutor(ticket);
  if (opts.executor !== preparedExecutor) {
    return {
      ok: false,
      reason: "executor_mismatch",
      ticket,
      derivedModel: ticket.model,
      derivedEffort: ticket.effort,
      executor: opts.executor || null,
      expectedExecutor: preparedExecutor,
      message: `${ticket.ref} has a prepared dispatch for ${preparedExecutor}, not ${opts.executor || "this executor"}. Re-run sidequest dispatch ${ticket.ref} and claim with its returned executor and token.`
    };
  }
  return { ok: true, ticket, token };
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
    if (opts.direct && isRoutedTicket(t2) && !directReasonAllowed(directClaimReason)) return { ok: false, reason: "direct_not_allowed", ticket: t2, expectedExecutor: canonicalPreparedDispatchExecutor(t2) };
    const admission = claimAdmission(slug, found.id, opts);
    if (!admission.ok) return admission;
    const currentDispatch = dispatchState(t2);
    const terminalDispatch = Boolean(currentDispatch?.terminalAt && currentDispatch?.outcome);
    if (opts.direct && t2.dispatchNonce && !terminalDispatch) return { ok: false, reason: "direct_conflict", ticket: t2 };
    if (opts.direct && t2.dispatchNonce && terminalDispatch && !opts.force) return { ok: false, reason: "terminal_claim_takeover_required", ticket: t2 };
    if (!opts.direct && isRoutedTicket(t2) && !t2.dispatchNonce) return { ok: false, reason: "dispatch_required", ticket: t2 };
    if (currentDispatch?.preparedCompatibility?.pluginInstall) {
      const currentInstall = checkSidequestInstall(readMeta(slug)?.path || "");
      if (!currentInstall.ok || currentInstall.installPath !== currentDispatch.preparedCompatibility.pluginInstall || currentInstall.identity !== currentDispatch.preparedCompatibility.identity) {
        return {
          ok: false,
          reason: "prepared_compatibility_stale",
          ticket: t2,
          message: `claim: refused ${t2.ref}; the prepared Sidequest install snapshot no longer matches the current project install. Prepare a fresh dispatch before claiming.`
        };
      }
    }
    if (t2.status === "done") return { ok: false, reason: "done", ticket: t2 };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const lifecycleAuthority = { actor: by, operation: "claim", sessionId: opts.sessionId || null };
    const directExecution = opts.direct || !currentDispatch;
    let activeAttempt = directExecution ? lifecycleAttemptFromFacts(t2, lifecycleAuthority, "dispatch", true) : lifecycleAttemptFromFacts(t2, lifecycleAuthority, "dispatch", false);
    if (!directExecution && opts.requireBoundAgent && currentDispatch && activeAttempt.state === "prepared") {
      const boundAttempt = bindDispatchClaimToken(currentDispatch, activeAttempt, opts.sessionId, opts.executor, now);
      if (boundAttempt) activeAttempt = boundAttempt;
    }
    if (!directExecution && opts.requireBoundAgent && currentDispatch && activeAttempt.state === "launched" && !currentDispatch.boundAt) {
      const boundAttempt = bindDispatchClaimToken(currentDispatch, activeAttempt, opts.sessionId, opts.executor, now);
      if (boundAttempt) activeAttempt = boundAttempt;
    }
    if (!directExecution && !opts.requireBoundAgent && ["prepared", "launched"].includes(activeAttempt.state)) {
      activeAttempt = transitionAttempt(activeAttempt, "bind_claim_token");
    }
    if (!directExecution && opts.requireBoundAgent && activeAttempt.state !== "bound" && activeAttempt.state !== "claimed") {
      return { ok: false, reason: "unbound_dispatch", ticket: t2 };
    }
    if (currentDispatch?.resumedAt && isolatedDispatchWorktreeMissing(currentDispatch)) return { ok: false, reason: "worktree_missing", ticket: t2 };
    if (pendingSubmission(t2) && !opts.force) return { ok: false, reason: "submitted", ticket: t2, submission: t2.submission };
    const held2 = t2.claim;
    if (held2 && held2.by && held2.by !== by && !claimReclaimable(t2) && !opts.force) {
      return { ok: false, reason: "claimed", ticket: t2, claim: held2 };
    }
    const runtimeClaim = !opts.direct && !opts.force ? liveRuntimeClaim(slug, t2, by) : null;
    if (runtimeClaim) {
      return {
        ok: false,
        reason: "runtime_claimed",
        ticket: t2,
        claim: runtimeClaim.claim,
        message: `claim: refused ${t2.ref}; this runtime already holds ${runtimeClaim.ref}. One runtime may hold one live ticket claim. The orchestration session must dispatch any review or follow-up.`
      };
    }
    const claimRuntime = currentDispatch ? {
      sessionId: currentDispatch.sessionId || opts.sessionId || null,
      executor: currentDispatch.executor || null,
      agentId: currentDispatch.agentId || null,
      agentName: currentDispatch.agentName || null
    } : opts.sessionId ? {
      sessionId: String(opts.sessionId),
      executor: null,
      agentId: null,
      agentName: null
    } : null;
    t2.claim = {
      by,
      at: now,
      generation: crypto.randomUUID(),
      ...claimRuntime ? { runtime: claimRuntime } : {}
    };
    if (opts.direct && opts.force && terminalDispatch && held2?.by && held2.by !== by) {
      t2.claimTakeover = {
        by,
        at: now,
        previousBy: held2.by,
        evidence: {
          outcome: currentDispatch.outcome,
          terminalAt: currentDispatch.terminalAt,
          terminalSource: currentDispatch.terminalSource || null
        }
      };
    }
    if (t2.storyId && !Number.isInteger(t2.dispatch?.storyLogRevision)) {
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
    const preClaimAttempt = activeAttempt;
    if (directExecution && preClaimAttempt.state !== "prepared" && preClaimAttempt.state !== "claimed") {
      return { ok: false, reason: "invalid_transition", ticket: t2, message: "Cannot directly claim an attempt after execution started." };
    }
    if (!directExecution && preClaimAttempt.state !== "bound" && preClaimAttempt.state !== "claimed") {
      return { ok: false, reason: "invalid_transition", ticket: t2, message: "Cannot claim a dispatched attempt before it is bound." };
    }
    const claimedAttempt = preClaimAttempt.state === "claimed" ? preClaimAttempt : transitionAttempt(preClaimAttempt, directExecution ? "claim_direct" : "claim");
    const claimDiagnostic = attemptDiagnostic(claimedAttempt);
    if (claimDiagnostic) return { ok: false, reason: claimDiagnostic.code, ticket: t2, message: claimDiagnostic.message };
    recordLifecycleAttempt(t2, claimedAttempt);
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
    const held = t.claim;
    const heldOwner = String(held?.by || "").trim();
    const submissionOwner = String(t.submission?.by || "").trim();
    const controlPlaneDone = opts.status === "done" && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
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
            message: `${t.ref} has a pending submission (commit ${String(t.submission.commit).slice(0, 12)}) parked READY_FOR_INTEGRATION. release cannot move it to "${reopenStatus}" and leave the submission in place. For a review rejection, use \`sidequest rework ${t.ref} --by <reviewer> --review <evidence> --reason "what needs repair"\`, then dispatch the ticket for repair. If this work already landed on the integration branch by hand, close it with \`sidequest groomClose ${t.ref} --by <integrator> --deliveryCommit <sha> --reason "why"\` instead of reopening it. Candidate-owner \`--force\` and \`submit --clear\` intentionally drop the candidate and are only for an integration bounce.`
          };
        }
        reopenedSubmission = t.submission;
      }
    }
    const executorDone = opts.status === "done" && !controlPlaneDone;
    const dispatch2 = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch2 && Array.isArray(dispatch2.declaredFiles) ? dispatch2.declaredFiles : normalizeFiles(t.files);
    const liveClaim = Boolean(held && held.by);
    const activeDispatch = Boolean(t.dispatchNonce || dispatch2 && !dispatch2.terminalAt);
    if (!liveClaim && activeDispatch && !opts.force) {
      return {
        ok: false,
        reason: "unclaimed_active_dispatch",
        message: `${t.ref} has a newer active dispatch but no claim owned by ${by}. Do not release it from this executor. Wait for the current attempt to finish, then have the orchestrator dispatch once from todo. When the dispatch is provably dead and verified work already landed, the orchestrator delivers it itself with \`sidequest groomClose ${t.ref} --by <integrator> --recoveryEvidence "<observed terminal evidence>" --deliveryCommit <sha>\`. Do not hand that command to a user.`,
        ticket: t
      };
    }
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch2?.nonRepoOutput === true && liveClaim && activeDispatch;
    const activeReadOnlyDispatch = dispatch2?.readonly === true && liveClaim && activeDispatch;
    let sharedTreeCommittedScope = false;
    let completionDelta = null;
    if (executorDone && liveClaim && activeDispatch) {
      completionDelta = dispatchDelta(slug, t);
      if (completionDelta.ok && !activeArtifactDispatch) {
        const scopedCommitted = completionDelta.committed.filter((file) => commitScope.isInScope(file, declaredFiles));
        sharedTreeCommittedScope = dispatch2?.sharedTree === true && scopedCommitted.length > 0;
        const scopedWorking = completionDelta.working.filter((file) => commitScope.isInScope(file, declaredFiles));
        const sharedTreeReadOnly = activeReadOnlyDispatch && dispatch2?.sharedTree === true;
        const scopedChanges = activeReadOnlyDispatch && !sharedTreeReadOnly ? Array.from(/* @__PURE__ */ new Set([...scopedWorking, ...scopedCommitted])) : [];
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
    const provenNoOp = opts.cleanDeclaredScope === true || Boolean(dispatch2?.noOpRelease);
    if (executorDone && dispatch2 && declaredFiles.length && !provenNoOp && !sharedTreeCommittedScope && !activeReadOnlyDispatch && !activeArtifactDispatch && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: "submission_required",
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. A read-only dispatch may close with done, but readonly:false selects this write path. A run that changed nothing closes here by itself once the board can see its worktree, so this refusal means the change is real or the worktree is unreadable. If the only declared output is outside the repo worktree, release it for reclassification as non-repo/artifact work; do not retry commit.`,
        ticket: t
      };
    }
    if (executorDone && liveClaim && activeDispatch) {
      const completion = completionTreeCheck(slug, t, { explicitNoOp: opts.cleanDeclaredScope === true });
      if (!completion.ok) return Object.assign({ ticket: t }, completion);
      if (!completionDelta?.ok && dispatch2?.sharedTree === true && dispatch2?.baseCommit) {
        return {
          ok: false,
          reason: "dispatch_delta_unavailable",
          message: `${t.ref} cannot inspect the full dispatch delta before done closeout. Restore the dispatch worktree or release the ticket and dispatch again.`,
          ticket: t
        };
      }
    }
    const expectedClaim = opts.expectedClaim;
    if (expectedClaim && (!held?.by || held.by !== expectedClaim.by || held.at !== expectedClaim.at)) {
      return { ok: false, reason: "claim_changed", ticket: t, claim: held || null };
    }
    const bypassOwnership = controlPlaneDone && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    if (!bypassOwnership && submissionOwner && submissionOwner !== by) {
      return { ok: false, reason: "not_owner", ticket: t, submission: t.submission, ...held ? { claim: held } : {} };
    }
    if (!bypassOwnership && heldOwner && heldOwner !== by && !claimReclaimable(t)) {
      return { ok: false, reason: "not_owner", ticket: t, claim: held };
    }
    const oracleRequested = nullableText(opts.oracle);
    const oracleRelease = opts.releaseKind === "oracle";
    if (oracleRelease && !oracleRequested) throw new Error("oracle release requires a non-empty oracle ask");
    if (oracleRequested && !oracleRelease) throw new Error("oracle ask requires release kind oracle");
    if (oracleRelease && coerceStatus(opts.status || "awaiting-oracle", t.status) !== "awaiting-oracle") {
      throw new Error("oracle release must set the ticket to awaiting-oracle");
    }
    if (oracleRelease && t.oracle && !t.oracle.verdict) {
      throw new Error("ticket already awaits an oracle verdict");
    }
    if (oracleRequested) oracleMarker(dispatch2, opts, null);
    if (opts.requireReleaseVerdict) {
      if (!claimReleaseVerdict(t)) {
        return {
          ok: false,
          reason: "claim_live",
          message: `${t.ref} is still live-claimed by "${held && held.by}"; the sweep re-checked it under the lock and left it alone.`,
          ticket: t,
          claim: held
        };
      }
      const releaseBlocker = claimReleaseBlocker(slug, t);
      if (releaseBlocker) {
        const changed = releaseBlocker.paths?.length ? ` Changed paths: ${releaseBlocker.paths.join(", ")}.` : "";
        return {
          ok: false,
          reason: releaseBlocker.kind,
          message: `${t.ref} claim release refused: ${releaseBlocker.reason}.${changed}`,
          paths: releaseBlocker.paths || [],
          ticket: t,
          claim: held
        };
      }
    }
    const noOpRelease = liveClaim && hasNoOpReleaseProof(slug, t, by);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previousStatus = t.status;
    let comment = null;
    if (releaseComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(releaseComment, now);
      t.comments.push(comment);
    }
    if (oracleRelease) {
      t.oracle = oracleMarker(dispatch2, opts, now);
      writeOracleExperimentRound(slug, t);
    }
    const closesPendingSubmission = opts.status === "done" && pendingSubmission(t);
    const lifecycleAlreadyTerminal = ["closed", "released"].includes(t.lifecycleAttempt?.state);
    const releasedAttempt = !closesPendingSubmission && t.lifecycleAttempt && !lifecycleAlreadyTerminal ? transitionAttempt(t.lifecycleAttempt, "release") : t.lifecycleAttempt;
    const releaseDiagnostic = releasedAttempt ? attemptDiagnostic(releasedAttempt) : null;
    if (releaseDiagnostic) {
      return {
        ok: false,
        reason: releaseDiagnostic.code,
        ticket: t,
        message: releaseDiagnostic.message
      };
    }
    if (releasedAttempt) recordLifecycleAttempt(t, releasedAttempt);
    t.claim = null;
    if (noOpRelease && dispatch2) dispatch2.noOpRelease = { by, at: now, claimAt: held?.at || null };
    if (opts.claimRelease) {
      t.claimRelease = Object.assign({ by, at: now, source: opts.source || "store" }, opts.claimRelease);
    }
    const terminalOutcome = opts.status === "done" ? "done" : dispatch2?.outcome === "died" || opts.claimRelease?.kind === "session_ended" ? "died" : "released";
    const release = opts.releaseKind ? {
      kind: String(opts.releaseKind),
      reason: String(opts.releaseReason || "").trim() || null,
      evidence: opts.releaseEvidence || null,
      source: opts.source || "cli",
      at: now
    } : null;
    if (release) t.release = release;
    if (!dispatch2?.terminalAt || dispatch2.outcome !== terminalOutcome) {
      setDispatchTerminal(t, terminalOutcome, opts.source || "cli", {
        slug,
        failureShape: opts.failureShape || release?.kind || "unknown",
        releaseKind: release?.kind,
        releaseReason: release?.reason,
        releaseEvidence: release?.evidence
      });
    }
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (reopenedSubmission) t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    else if (oracleRelease) t.status = "awaiting-oracle";
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
        ...dispatch2?.noOpRelease ? { purpose: "no-op", noOp: dispatch2.noOpRelease } : {},
        ...opts.completionProvenance || {}
      };
      if (opts.completionComment) {
        if (!Array.isArray(t.comments)) t.comments = [];
        comment = createComment(opts.completionComment, now);
        t.comments.push(comment);
        t.completion.commentId = comment.id;
      }
    }
    if (closesPendingSubmission) {
      const assembledAttempt = t.lifecycleAttempt?.state === "submitted" ? transitionAttempt(t.lifecycleAttempt, "assemble") : t.lifecycleAttempt;
      const integratedAttempt = assembledAttempt?.state === "assembled" ? transitionAttempt(assembledAttempt, "integrate") : assembledAttempt;
      const closedAttempt = integratedAttempt?.state === "integrated" ? transitionAttempt(integratedAttempt, "close") : integratedAttempt;
      const lifecycleDiagnostic = closedAttempt ? attemptDiagnostic(closedAttempt) : null;
      if (lifecycleDiagnostic) return { ok: false, reason: lifecycleDiagnostic.code, ticket: t, message: lifecycleDiagnostic.message };
      if (closedAttempt) recordLifecycleAttempt(t, closedAttempt);
      const integratedAt = (/* @__PURE__ */ new Date()).toISOString();
      const recordedDelivery2 = opts.recordedDelivery;
      t.submission = Object.assign({}, t.submission, {
        integratedAt,
        ...recordedDelivery2 ? {
          integration: {
            outcome: "verified",
            mode: "recorded",
            pinnedCommit: t.submission.commit,
            resultingHead: recordedDelivery2.commit,
            targetBranch: recordedDelivery2.target.branch,
            targetRef: recordedDelivery2.target.upstream,
            deliveredAt: integratedAt,
            verifiedAt: integratedAt,
            evidence: recordedDelivery2.evidence
          }
        } : {}
      });
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
function releaseTerminalClaim(slug, idOrRef, expectedClaim, source) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket?.claim?.by || ticket.claim.by !== expectedClaim?.by || ticket.claim.at !== expectedClaim?.at) {
    return { ok: false, reason: "claim_changed", ticket: ticket || null };
  }
  const verdict = claimReleaseVerdict(ticket);
  if (!verdict || verdict.kind !== "observed_stop") return { ok: false, reason: "claim_live", ticket };
  const released = releaseTicket(slug, ticket.id, expectedClaim.by, {
    status: "todo",
    source,
    expectedClaim,
    requireReleaseVerdict: true,
    claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null }
  });
  if (released.ok) {
    addComment(slug, ticket.id, {
      by: "sidequest",
      kind: "comment",
      source,
      body: claimReleaseNote(ticket, verdict)
    });
  }
  return released;
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
function linkedReviewPass(slug, ticket) {
  if (!ticket) return false;
  return listTickets(slug).some((candidate) => (candidate.category === "review-audit" || candidate.category?.id === "review-audit" || candidate.categoryId === "review-audit") && candidate.status === "done" && Array.isArray(candidate.links) && candidate.links.some((link) => String(link?.ref || "").toUpperCase() === String(ticket.ref || "").toUpperCase()));
}
const HIGH_STAKES_REVIEW_WARNING = "high-stakes ticket integrated without a recorded review pass. Record one with a comment starting reviewed-by: <ref>, or link a completed review-audit ticket.";
const DELIVERY_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
function missingReleaseFragment(repoPath, ref, changedPaths) {
  const repo = String(repoPath || "").trim();
  if (!repo) return null;
  const marketplacePath = path.join(repo, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(marketplacePath)) return null;
  const manifest = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
  const changed = Array.isArray(changedPaths) ? changedPaths : [];
  const shipped = plugins.flatMap((plugin) => {
    const name = String(plugin?.name || "").trim();
    const source = String(plugin?.source || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return name && source && !source.startsWith("../") && changed.some((changedPath) => changedPath === source || changedPath.startsWith(`${source}/`)) ? [{ name, source }] : [];
  });
  if (!shipped.length) return null;
  const fragmentPath = `.release/unreleased/${ref}.md`;
  return changed.includes(fragmentPath) && fs.existsSync(path.join(repo, fragmentPath)) ? null : { fragmentPath, plugins: shipped };
}
function missingReleaseFragmentMessage(ref, fragmentPath, plugins) {
  return `submit: refused ${ref}; submitted range changes shipped plugin paths (${plugins.map((plugin) => plugin.source).join(", ")}) but does not include ${fragmentPath}. Create it with:
---
ref: ${ref}
title: <short user-facing title>
bump: patch
plugins:
${plugins.map((plugin) => `  - ${plugin.name}`).join("\n")}
---

Describe the user-facing change.`;
}
function recordedDelivery(slug, commit, evidence) {
  const requestedCommit = String(commit || "").trim();
  const recordedEvidence = String(evidence || "").trim();
  if (!DELIVERY_COMMIT_RE.test(requestedCommit)) {
    return { ok: false, reason: "delivery_commit_required", message: "A hand-delivered closure requires the full or abbreviated Git commit that reached the integration branch." };
  }
  if (!recordedEvidence) return { ok: false, reason: "evidence_required" };
  const repo = readMeta(slug)?.path;
  if (!repo) return { ok: false, reason: "project_unavailable" };
  let target;
  try {
    target = integrationTarget(slug);
    const deliveredCommit = execFileSync("git", ["rev-parse", "--verify", `${requestedCommit}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe"
    }).trim();
    const targetCommit = integrationTargetCommit(repo, target);
    const integrationRevision = sourceRevision({
      source: `git:${target.upstream}`,
      value: targetCommit,
      observedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    if (!integrationRevision) throw new Error("could not record the current integration revision");
    execFileSync("git", ["merge-base", "--is-ancestor", deliveredCommit, integrationRevision.value], {
      cwd: repo,
      windowsHide: true,
      stdio: "pipe"
    });
    return { ok: true, commit: deliveredCommit, target, integrationRevision, evidence: recordedEvidence };
  } catch (error) {
    return {
      ok: false,
      reason: "delivery_not_reachable",
      message: `The recorded delivery commit is not reachable from the configured integration branch: ${String(error?.message || error).trim()}`
    };
  }
}
function clearUnclaimedDispatch(slug, idOrRef, opts) {
  const by = String(opts?.by || "").trim();
  const agentId = String(opts?.agentId || "").trim();
  const agentName = String(opts?.agentName || "").trim();
  const evidence = String(opts?.evidence || "").trim();
  if (!by) return { ok: false, reason: "identity_required" };
  if (!evidence) return { ok: false, reason: "death_evidence_required", message: "Clearing an unclaimed dispatch requires recorded terminal-agent evidence." };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: "not_found" };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const state = dispatchState(ticket);
    if (!ticket || !state || !ticket.dispatchNonce || state.terminalAt) return { ok: false, reason: "no_unclaimed_dispatch", ticket };
    if (ticket.claim?.by) return { ok: false, reason: "claimed", ticket, claim: ticket.claim };
    if (agentId && String(state.agentId || "") !== agentId) return { ok: false, reason: "dispatch_identity_mismatch", ticket };
    if (agentName && String(state.agentName || "") !== agentName) return { ok: false, reason: "dispatch_identity_mismatch", ticket };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    setDispatchTerminal(ticket, "failed", "control-plane-death-recovery", {
      failureShape: "observed_terminal_agent",
      deathEvidence: { by, agentId: agentId || state.agentId || null, agentName: agentName || state.agentName || null, evidence }
    });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    const previousStatus = ticket.status;
    if (!pendingSubmission(ticket)) ticket.status = "todo";
    if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: now };
    stampDispatchEvent(ticket, "control-plane-death-recovery", now);
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
    return { ok: true, ticket };
  });
}
function completeTicketAsControlPlane(slug, idOrRef, opts) {
  opts = opts || {};
  const purpose = String(opts.purpose || "").trim();
  if (!["grooming", "integration", "delivery"].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming", "integration", or "delivery".');
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
  if (purpose === "delivery") {
    if (ticket.claim?.by || ticket.dispatchNonce || state && !state.terminalAt) {
      return {
        ok: false,
        reason: "active_dispatch",
        message: `${ticket.ref} still has a live claim or an open dispatch, so hand delivery cannot close it. Release it first: \`sidequest release ${ticket.ref} --by ${ticket.claim?.by ? String(ticket.claim.by) : "<claim holder>"}\`, then re-run this closure with the same evidence. Releasing does not discard work already committed.`,
        ticket
      };
    }
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
  const delivery = purpose === "delivery" ? recordedDelivery(slug, opts.deliveryCommit, reason) : null;
  if (delivery && !delivery.ok) return Object.assign({ ticket }, delivery);
  const missingFragment = delivery ? missingReleaseFragment(readMeta(slug)?.path, ticket.ref, commitPaths(readMeta(slug)?.path || "", delivery.commit)) : null;
  if (missingFragment) return {
    ok: false,
    reason: "missing_release_fragment",
    message: missingReleaseFragmentMessage(ticket.ref, missingFragment.fragmentPath, missingFragment.plugins),
    ticket
  };
  let legacyScopeOverride = false;
  if (purpose === "integration") {
    const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
    if (!admitted.ok) return admitted;
    legacyScopeOverride = !!admitted.legacyScopeOverride;
  }
  const advisory = purpose === "integration" && ticket.highStakes && !recordedReviewPass(ticket) && !linkedReviewPass(slug, ticket) ? HIGH_STAKES_REVIEW_WARNING : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: Object.assign(
      { authority: "control-plane", purpose, reason },
      delivery?.ok ? {
        delivery: {
          commit: delivery.commit,
          targetBranch: delivery.target.branch,
          targetRef: delivery.target.upstream,
          integrationRevision: delivery.integrationRevision,
          evidence: delivery.evidence
        }
      } : {},
      legacyScopeOverride ? { legacyScopeOverride: { reason } } : {}
    ),
    ...delivery?.ok ? { recordedDelivery: delivery } : {}
  }));
  return advisory ? Object.assign(result, { advisory }) : result;
}
function closeTicketForGrooming(slug, idOrRef, opts) {
  return completeTicketAsControlPlane(slug, idOrRef, Object.assign({}, opts, { purpose: "grooming" }));
}
const { sweepStaleDispatches, sweepStaleClaims } = createSweeps({
  addComment,
  claimAbandonMs,
  claimIdleMs,
  claimReleaseNote,
  claimReleaseVerdict,
  dispatchState,
  expiredPreparedDispatch,
  getTicket,
  listProjects,
  listTickets,
  migrateLegacyScopeRequest,
  preparedDispatchTtlMs,
  putTicket,
  releaseTicket,
  setDispatchTerminal,
  stampDispatchEvent,
  withTicketLock
});
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
const { readServerInfo, writeServerInfo, clearServerInfo } = createServer({ database, deleteCachedRow, readGlobal, writeGlobal });
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
  STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES,
  STORY_LOG_ENTRY_ADVISORY_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  appendStoryLogEntry,
  coerceStoryId,
  createStory,
  deleteStory,
  getStory,
  listStories,
  normalizeStoryLogEntry,
  rotateStoryLog,
  storyLogEntryAdvisory,
  storyDecisionLog,
  storyDecisionLogWarnings,
  storyExecutionContract,
  storyExecutionContractPage,
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
warningsLayer = createWarnings({
  boardConfig,
  categoryReadOnly,
  claimReclaimable,
  coerceEffort,
  commitScope,
  contractCollisionReasons,
  dispatchReadOnly,
  dispatchState,
  execFileSync,
  fs,
  getTicket,
  integrationTarget,
  listTickets,
  normalizeContracts,
  normalizeFiles,
  normalizeRouteModel,
  overlappingScopePaths,
  path,
  pulseDispatchState,
  readMeta,
  readOnlyOverrideActive,
  spawnSync,
  ticketCategory
});
DISPATCH_DESCRIPTION_MIN = warningsLayer.DISPATCH_DESCRIPTION_MIN;
const { boundedExcerpt, changesPayload, commentHistory, pulsePayload } = createPulse({
  boardConfig,
  checkpointProjection,
  claimPulse,
  claimReleaseVerdict,
  claimVerification,
  commitScope,
  dispatchState,
  effectiveScope,
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
  dispatchVerifyCommandError,
  dispatchDeclaredFiles,
  dispatchWorkspace,
  dispatchWarnings,
  staleWorktreeCwdWarning,
  dispatchUncertaintyWarnings,
  ticketReferenceWarnings,
  ticketCategoryWarnings,
  scopeConsumerWarningDetails,
  ticketPlanningWarnings,
  presentWarnings,
  coerceComplexity,
  legacyCategoryForComplexity,
  applyDerivedRouting,
  getModelVocab,
  modelsPayload,
  routingModels,
  normalizeRoute,
  availableRoute,
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
  resolveTicketRoute,
  resolveCategoryRoute,
  claudeQuotaFailure,
  classifyDispatchFailure,
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
  registerSourceRevisionCapability,
  readMeta,
  boardConfig,
  setBoardConfig,
  integrationTarget,
  normalizeDeliveryMode,
  validateIntegrationSubmission,
  integrateSubmission,
  submissionUsesGit,
  closeSubmissionAsSuperseded,
  verifyIntegration,
  effectiveScope,
  executionScope,
  VERIFY_ORACLE_KINDS,
  normalizeVerifyOracleKind,
  attestationErrors,
  verifyOracleErrors,
  verifyCommandErrors,
  verifyCommandError,
  completionTreeCheck,
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
  dispatchReadOnly,
  stableExecutorName,
  canonicalPreparedDispatchExecutor,
  executorClaimDispatchRefusal,
  sharedTreeRuntimeRefusal,
  prepareDispatch,
  readDispatchBriefing,
  dispatchTokenForRequest,
  isSupersededDispatchToken,
  recordDispatchLaunch,
  recordDispatchAgentFailure,
  recoverDispatchQuotaFailure,
  bindDispatchWorktreeCreation,
  completeDispatchWorktreeCreation,
  recoverDispatchWorktreeCreation,
  bindDispatchAgent,
  dispatchIsolationExpectation,
  activeSharedTreeClaim,
  isolatedDispatchWithMissingWorktree,
  terminalDispatchTarget,
  terminalDispatchForIdle,
  markDispatchStopped,
  reconcileLaunchedDispatches,
  claimAdmission,
  claimTicket,
  releaseTicket,
  completeTicket,
  completeTicketAsControlPlane,
  missingReleaseFragment,
  missingReleaseFragmentMessage,
  clearUnclaimedDispatch,
  closeTicketForGrooming,
  makeWorkedBy,
  checkpointTicket,
  checkpointProjection,
  oracleProjection,
  clearOracleMarker,
  checkpointTtlMs,
  DEFAULT_CHECKPOINT_TTL_MIN,
  MAX_CHECKPOINT_TTL_MIN,
  submissionOwnershipFailure,
  submitTicket,
  recordSubmissionRejection,
  reconcileSubmissionRejections,
  reworkSubmission,
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
  requestScope,
  migrateLegacyScopeRequest,
  normalizeContracts,
  contractCollisionReasons,
  STORY_PALETTE,
  STORY_COLOR_NAMES,
  STORY_EXECUTION_CONTRACT_MAX_BYTES,
  STORY_EXECUTION_CONTRACT_PAGE_MAX_BYTES,
  STORY_DECISION_LOG_BRIEFING_MAX_BYTES,
  STORY_LOG_ENTRY_ADVISORY_BYTES,
  STORY_LOG_ENTRY_TEXT_MAX_BYTES,
  storyExecutionContract,
  storyExecutionContractPage,
  normalizeStoryLogEntry,
  rotateStoryLog,
  storyLogEntryAdvisory,
  storyDecisionLog,
  storyReadPayload,
  appendStoryLogEntry,
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
  releaseCommentBody,
  technicalBlockerRelease,
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
