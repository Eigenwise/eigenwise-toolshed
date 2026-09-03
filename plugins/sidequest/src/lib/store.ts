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
const sourceRevisionCapability = require('./source-revision-capability.js');
const {
  filesystemSnapshotCapability,
  filesystemSnapshotRevision,
  registerSourceRevisionCapability,
  sourceRevision,
  sourceRevisionAdapterFacts: resolveSourceRevisionAdapterFacts,
} = sourceRevisionCapability;
const { DEFAULT_CATEGORIES, ROUTING_PROFILE_SEED_REVISION, starterRoutingProfilesFor } = require('./category-defaults.js');
const commitScope = require('./commit-scope.js');
const { commitPaths } = commitScope;
const { preferredWorktreeIntegrationTarget, agentWorktreePath, agentWorktreeCandidates, resolvedAgentWorktree, reclaimUnclaimedDispatchWorktree } = require('./worktrees.js');
const { canonicalPath, checkoutInstanceIdentity, createWorktreeLease, worktreeResumeDecision, isCanonicalRegisteredWorktree } = require('./kernel/worktree.js');
const { reviewLockMessage } = require('./kernel/review-binding.js');
const { migrateIfNeeded } = require('./migrate.js');
const { catalogStateFingerprint, configuredExternalModelProvider, discoverExternalModels, providerReadiness } = require('./discovery.js');
const telemetry = require('./telemetry.js');
const { negativeControlRecoveryGuidance, routingDisabledMessage } = require('./refusal-guidance.js');
const { canonicalPreparedDispatchExecutor, normalizePreparedDispatch } = require('./prepared-dispatch.js');
const { assertSidequestInstall, checkSidequestInstall, assertDispatchTransport, ensurePythonIoEncoding, localAheadOfUpstreamWarning } = require('./dispatch-preflight.js');
const { prepareAttempt, prepareDirectAttempt, transitionAttempt, attemptDiagnostic, VERIFICATION_KINDS } = require('./kernel/index.js');
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
const { createPaths } = require('./store/paths.js');
const { createCache } = require('./store/cache.js');
const { createConfig } = require('./store/config.js');
const { createSweeps } = require('./store/sweeps.js');
const { createServer } = require('./store/server.js');
const { createProjects } = require('./store/projects.js');
const { createWarnings } = require('./store/warnings.js');

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
function normalizeAutoApproveTestScope(...args: any[]) { return configLayer.normalizeAutoApproveTestScope(...args); }
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
// An empty binding means "nothing was bound", never "bind nothing". Accepting
// `[]` as an authoritative scope let a dispatch that captured no files override
// the ticket's real declared paths: the commit gate then saw an empty effective
// scope with a non-empty ticket.files, appended the release fragment, and
// demanded `.release/unreleased/<REF>.md` as the only path in scope. Three
// executors lost their runs to that in one hour, each editing a list the gate
// was not reading.
// A TERMINAL dispatch's binding is history, not authority. After a release the
// orchestrator can expand ticket.files or grant scope and finish the work under
// a direct claim, and syncLiveDispatchScope rightly never rewrites a dead
// dispatch — so an orchestrator submit was gated on the dead binding while
// pulse reported enforced: null for it, and a granted path had to land as an
// out-of-band commit (the-bot-resurrection SQ-825, three refused submits).
function executionScope(slug?: any, ticket?: any) {
  const dispatch = ticket?.dispatch;
  const bound = dispatch && !dispatch.terminalAt ? dispatch.declaredFiles : null;
  if (Array.isArray(bound) && bound.length) {
    const granted = Array.isArray(ticket?.scopeResolution?.granted) ? ticket.scopeResolution.granted : [];
    return Array.from(new Set([...bound, ...effectiveScope(slug, { files: granted })]));
  }
  return effectiveScope(slug, ticket);
}

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

const FILESYSTEM_SNAPSHOT_ADAPTER = 'filesystem-snapshot';
const GIT_SOURCE_REVISION_ADAPTER = 'git';
const SOURCE_REVISION_SNAPSHOTS_MAX = 256;

function sourceRevisionAdapterForPath(projectPath: any) {
  let directory = path.resolve(projectPath);
  for (;;) {
    if (fs.existsSync(path.join(directory, '.git'))) return GIT_SOURCE_REVISION_ADAPTER;
    const parent = path.dirname(directory);
    if (parent === directory) return FILESYSTEM_SNAPSHOT_ADAPTER;
    directory = parent;
  }
}

function sourceRevisionSnapshots(meta: any) {
  return Array.isArray(meta?.sourceRevisionSnapshots)
    ? meta.sourceRevisionSnapshots.filter((snapshot: any) => snapshot?.source === FILESYSTEM_SNAPSHOT_ADAPTER && typeof snapshot.value === 'string')
    : [];
}

function persistFilesystemSnapshot(slug: any, revision: any) {
  return withMetaLock(slug, () => {
    const meta = readMeta(slug);
    if (!meta || meta.sourceRevisionAdapter !== FILESYSTEM_SNAPSHOT_ADAPTER) {
      throw new Error(`source revision adapter "${FILESYSTEM_SNAPSHOT_ADAPTER}" is not configured for project ${slug}.`);
    }
    const snapshots = sourceRevisionSnapshots(meta);
    if (!snapshots.some((snapshot: any) => snapshot.value === revision.value)) {
      snapshots.push(revision);
      meta.sourceRevisionSnapshots = snapshots.slice(-SOURCE_REVISION_SNAPSHOTS_MAX);
      putProject(slug, meta);
    }
    return revision;
  });
}

function filesystemSnapshotBaseline(slug: any, observedAt: string) {
  const meta = readMeta(slug);
  const revision = filesystemSnapshotRevision(String(meta?.path || ''), observedAt);
  if (!revision) {
    throw new Error(`project registration refused: the configured ${FILESYSTEM_SNAPSHOT_ADAPTER} adapter cannot snapshot ${String(meta?.path || slug)}.`);
  }
  return persistFilesystemSnapshot(slug, revision);
}

function dispatchBaselineForProject(slug: any, ticket: any, observedAt: string, baseCommit: any, nonRepoOutput: boolean) {
  const project = readMeta(slug);
  const revision = project?.sourceRevisionAdapter === FILESYSTEM_SNAPSHOT_ADAPTER
    ? filesystemSnapshotBaseline(slug, observedAt)
    : Object.freeze({
      source: nonRepoOutput ? 'project-snapshot' : 'git',
      value: String(baseCommit || ticket.id || ticket.ref),
      observedAt,
    });
  return Object.freeze({ revision, purpose: 'dispatch' as const });
}

function sourceRevisionAdapterFacts(slug: any, candidate: any, baseline: any) {
  const meta = readMeta(slug);
  if (meta?.sourceRevisionAdapter !== FILESYSTEM_SNAPSHOT_ADAPTER) {
    return resolveSourceRevisionAdapterFacts(slug, candidate, baseline);
  }
  const persistedCapability = filesystemSnapshotCapability(String(meta.path), (pinnedBaseline: any) => (
    sourceRevisionSnapshots(readMeta(slug)).some((snapshot: any) => (
      snapshot.source === pinnedBaseline.revision.source && snapshot.value === pinnedBaseline.revision.value
    ))
  ));
  const facts = resolveSourceRevisionAdapterFacts(slug, candidate, baseline, persistedCapability);
  if (facts?.baseline?.candidateExists) persistFilesystemSnapshot(slug, facts.candidate);
  return facts;
}

let warningsLayer: any;
let DISPATCH_DESCRIPTION_MIN: any;
function executorText(...args: any[]) { return warningsLayer.executorText(...args); }
function manualVerify(...args: any[]) { return warningsLayer.manualVerify(...args); }
const VERIFY_ORACLE_KINDS = VERIFICATION_KINDS;
function normalizeVerifyOracleKind(...args: any[]) { return warningsLayer.normalizeVerifyOracleKind(...args); }
function attestationErrors(...args: any[]) { return warningsLayer.attestationErrors(...args); }
function verifyOracleErrors(...args: any[]) { return warningsLayer.verifyOracleErrors(...args); }
function requireVerifyOracle(...args: any[]) { return warningsLayer.requireVerifyOracle(...args); }
function verifyCommandErrors(...args: any[]) { return warningsLayer.verifyCommandErrors(...args); }
function verifyCommandError(...args: any[]) { return warningsLayer.verifyCommandError(...args); }
function requireVerifyCommand(...args: any[]) {
  warningsLayer.requireVerifyCommand(...args);
  const command = String(args[0] || '').trim();
  const pluginDirectoryChanges = command.match(/(?:^|[;&]{1,2})\s*cd\s+plugins\/[^\s;&]+/g) || [];
  if (pluginDirectoryChanges.length > 1) {
    throw new Error('multi-plugin verify commands must use one subshell per plugin joined with &&, for example: (cd plugins/a && npm test) && (cd plugins/b && npm test)');
  }
}
function ticketReferenceWarnings(...args: any[]) { return warningsLayer.ticketReferenceWarnings(...args); }
function ticketPrescribesFix(...args: any[]) { return warningsLayer.ticketPrescribesFix(...args); }
function ticketCategoryWarnings(...args: any[]) { return warningsLayer.ticketCategoryWarnings(...args); }
function readonlyCategoryWriteIntentWarning(...args: any[]) { return warningsLayer.readonlyCategoryWriteIntentWarning(...args); }
function noDeclaredScopeWarning(...args: any[]) { return warningsLayer.noDeclaredScopeWarning(...args); }
function readonlyBrowserReviewWarning(...args: any[]) { return warningsLayer.readonlyBrowserReviewWarning(...args); }
function relativePathWithin(...args: any[]) { return warningsLayer.relativePathWithin(...args); }
function packageRootForScope(...args: any[]) { return warningsLayer.packageRootForScope(...args); }
function buildOutputDirectories(...args: any[]) { return warningsLayer.buildOutputDirectories(...args); }
function packageBuildOutputs(...args: any[]) { return warningsLayer.packageBuildOutputs(...args); }
function isTrackedBuildOutput(...args: any[]) { return warningsLayer.isTrackedBuildOutput(...args); }
function scopeIncludesPath(...args: any[]) { return warningsLayer.scopeIncludesPath(...args); }
function sourceBuildOutputWarnings(...args: any[]) { return warningsLayer.sourceBuildOutputWarnings(...args); }
function verifyCommandWarning(...args: any[]) { return warningsLayer.verifyCommandWarning(...args); }
function dispatchVerifyCommandError(...args: any[]) { return warningsLayer.dispatchVerifyCommandError(...args); }
function dispatchDescriptionError(...args: any[]) { return warningsLayer.dispatchDescriptionError(...args); }
function storyContractDriftWarnings(...args: any[]) { return warningsLayer.storyContractDriftWarnings(...args); }
function crossTicketStateWarnings(...args: any[]) { return warningsLayer.crossTicketStateWarnings(...args); }
function staleWorktreeCwdWarning(...args: any[]) { return warningsLayer.staleWorktreeCwdWarning(...args); }
function dispatchUncertaintyWarnings(...args: any[]) { return warningsLayer.dispatchUncertaintyWarnings(...args); }
function dispatchWarnings(ticket?: any, slug?: any) {
  const project = !slug && process.env.CLAUDE_PROJECT_DIR ? findProject(process.env.CLAUDE_PROJECT_DIR) : null;
  return warningsLayer.dispatchWarnings(ticket, slug || (project?.ok ? project.slug : null));
}
function dispatchDeclaredFiles(...args: any[]) { return warningsLayer.dispatchDeclaredFiles(...args); }
function externalDeclaredFiles(...args: any[]) { return warningsLayer.externalDeclaredFiles(...args); }
function nonRepoExternalOutput(...args: any[]) { return warningsLayer.nonRepoExternalOutput(...args); }
function fencedBlocks(...args: any[]) { return warningsLayer.fencedBlocks(...args); }
function diffShapedBlock(...args: any[]) { return warningsLayer.diffShapedBlock(...args); }
function evidenceShapedBlock(...args: any[]) { return warningsLayer.evidenceShapedBlock(...args); }
function embedsCompleteEdit(...args: any[]) { return warningsLayer.embedsCompleteEdit(...args); }
function presolvedRoutingWarnings(...args: any[]) { return warningsLayer.presolvedRoutingWarnings(...args); }
function scopeConsumerWarningDetails(...args: any[]) { return warningsLayer.scopeConsumerWarningDetails(...args); }
function ticketPlanningWarnings(ticket?: any, projectPath?: any) {
  const project = projectPath ? findProject(projectPath) : null;
  return warningsLayer.ticketPlanningWarnings(ticket, projectPath, project?.ok ? project.slug : null);
}
function presentWarnings(...args: any[]) { return warningsLayer.presentWarnings(...args); }
function normalizeReadonlyOverride(...args: any[]) { return warningsLayer.normalizeReadonlyOverride(...args); }
function requestedReadonlyOverride(...args: any[]) { return warningsLayer.requestedReadonlyOverride(...args); }

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
  projectDispatchAdmission,
  resolveTicketRoute,
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
  configuredExternalModelProvider,
  crypto,
  database,
  db,
  discoverExternalModels,
  invalidateStoreCaches,
  listProjects,
  projectRoutingEnabled,
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
  reviewCandidateTreeRefusal,
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
  retirePreparedCompatibilityStaleAttempt,
  preparedCompatibilityHasProvenMismatch,
  supersedeUnboundAttempt,
  readDispatchBriefing,
  recordDispatchLaunch,
  recordDispatchAgentFailure,
  recoverDispatchQuotaFailure,
  bindDispatchWorktreeCreation,
  completeDispatchWorktreeCreation,
  recordDispatchWorktreeProvisioningFailure,
  recoverDispatchWorktreeCreation,
  dispatchIdentityDiagnosis,
  dispatchIsolationExpectation,
  dispatchUnboundClaim,
  recordSanctionedCommit,
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
  canonicalPath,
  checkoutInstanceIdentity,
  createWorktreeLease,
  worktreeResumeDecision,
  isCanonicalRegisteredWorktree,
  classifyDispatchFailure: (...args: any[]) => classifyDispatchFailure(...args),
  terminalAgentFailure: (...args: any[]) => terminalAgentFailure(...args),
  SHARED_TREE_ARTIFACT_MARKER,
  assertDispatchTransport,
  assertSidequestInstall,
  checkSidequestInstall,
  prepareAttempt,
  transitionAttempt,
  attemptDiagnostic,
  ensurePythonIoEncoding,
  localAheadOfUpstreamWarning,
  availableRoute: (...args: any[]) => availableRoute(...args),
  boardConfig,
  claimIdleMs: () => claimIdleMs(),
  claimReclaimable: (...args: any[]) => claimReclaimable(...args),
  claimVerification: (...args: any[]) => claimVerification(...args),
  commitScope,
  crypto,
  database,
  db,
  dispatchReadOnly: (...args: any[]) => dispatchReadOnly(...args),
  dispatchBaselineForProject,
  dispatchVerifyCommandError: (...args: any[]) => dispatchVerifyCommandError(...args),
  dispatchRouteRefusal: (...args: any[]) => dispatchRouteRefusal(...args),
  dispatchRouteState: (...args: any[]) => dispatchRouteState(...args),
  effectiveScope: (...args: any[]) => effectiveScope(...args),
  execFileSync,
  execProjection: (...args: any[]) => execProjection(...args),
  fs,
  getCategory: (...args: any[]) => getCategory(...args),
  getStory: (...args: any[]) => getStory(...args),
  homeRoot: () => process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest'),
  integrationTarget,
  hasOriginRemote,
  pendingSubmission: pendingSubmissionForTickets,
  agentWorktreePath,
  agentWorktreeCandidates,
  resolvedAgentWorktree,
  reclaimUnclaimedDispatchWorktree,
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
  releaseTerminalClaim,
  resolveCategoryFallback: (...args: any[]) => resolveCategoryFallback(...args),
  resolveTicketRoute: (...args: any[]) => resolveTicketRoute(...args),
  resolveCategoryRoute: (...args: any[]) => resolveCategoryRoute(...args),
  resolveExec: (...args: any[]) => resolveExec(...args),
  stableExecutorName,
  staleWorktreeCwdWarning: (...args: any[]) => staleWorktreeCwdWarning(...args),
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

// Claude Code replaces this description with live activity in the agent list, so
// dispatchLaunchName carries the durable route identity. Keep the route prefix here
// for launch notifications and stop lines, where this original description survives.
function spawnDescription(ticket?: any, resolved?: any) {
  const title = String(ticket && ticket.title || 'Sidequest ticket')
    .replace(/\[sidequest-route model=[a-z0-9][a-z0-9.-]{0,63} effort=(?:low|medium|high|xhigh|max)\]/gi, ' ')
    .replace(/\s+/g, ' ').trim() || 'Sidequest ticket';
  const model = descriptionField(resolved && resolved.runsLabel, resolved && resolved.runsModel, ticket && ticket.model) || 'unrouted';
  const effort = descriptionField(ticket && ticket.effort, resolved && resolved.effort) || 'unset';
  const prefix = `${model}, ${effort} · `;
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

// The one answer to "which board does this session mean when a call names no
// project". The MCP server and the PreToolUse hooks both resolve through it, so
// a claim that omits `project` binds to the same board the claim handler uses.
function sessionProjectRoot() {
  return nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

/* ------------------------------------------------------------------ *
 *  SQLite persistence
 * ------------------------------------------------------------------ */

const dbByHome = new Map<string, any>();
const transactionDepth = new WeakMap<object, number>();

// SQLite has no nested transactions, so anything that begins one has to know whether one is already open on
// that handle. Every writer must come through here rather than calling db.txn itself: the seed refreshers
// did, and since they run from database(), which code inside an open transaction is free to call, a stale
// seed turned into `cannot start a transaction within a transaction` from whichever unrelated test happened
// to leave a routing profile entry mismatched (SQ-2196).
function withinTransaction(handle: object, fn: () => any) {
  if (transactionDepth.get(handle)) return fn();
  transactionDepth.set(handle, 1);
  try {
    return db.txn(handle, fn);
  } finally {
    transactionDepth.delete(handle);
  }
}

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

function isTestSidePath(file?: any) {
  const normalized = String(file || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized)
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(normalized);
}

function negativeControlFailureKind(body?: unknown) {
  const text = String(body || '');
  if (/\bimport\s*error\b/i.test(text)) return 'import_error';
  if (/\bcollection\s+(?:error|failed|failure)\b/i.test(text)) return 'collection_error';
  return '';
}

function changedTestNames(delta?: any, changedPaths?: any[]) {
  if (!delta?.workspace) return [];
  const names = new Set<string>();
  for (const file of changedPaths || []) {
    if (!isTestSidePath(file)) continue;
    let source = '';
    let diff = '';
    try {
      source = fs.readFileSync(path.join(delta.workspace.root, file), 'utf8');
    } catch (_: any) {
      continue;
    }
    try {
      diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', delta.workspace.base, '--', file], {
        cwd: delta.workspace.root,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (_: any) {
      continue;
    }
    const definitions = source.split(/\r?\n/).map((line: string, index: number) => {
      const match = line.match(/\b(?:test|it|specify)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/) || line.match(/\bdef\s+(test_[A-Za-z0-9_]+)/);
      return match ? { line: index + 1, name: match[2] || match[1] } : null;
    }).filter(Boolean) as Array<{ line: number; name: string }>;
    try {
      execFileSync('git', ['cat-file', '-e', `${delta.workspace.base}:${file}`], {
        cwd: delta.workspace.root,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_: any) {
      for (const definition of definitions) names.add(definition.name);
      continue;
    }
    let newLine = 0;
    let changedInHunk = false;
    const addNearestDefinition = (line: number) => {
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
      if (line.startsWith('+') && !line.startsWith('+++')) {
        changedInHunk = true;
        const addedDefinition = line.match(/\b(?:test|it|specify)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/) || line.match(/\bdef\s+(test_[A-Za-z0-9_]+)/);
        const addedName = addedDefinition?.[2] || addedDefinition?.[1];
        if (addedName) names.add(addedName);
        addNearestDefinition(newLine);
        newLine += 1;
        continue;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        changedInHunk = true;
        continue;
      }
      if (line.startsWith(' ')) newLine += 1;
    }
    if (changedInHunk) addNearestDefinition(newLine);
  }
  return Array.from(names);
}

function negativeControlTestReport(body?: any, expectedTestNames: string[] = []) {
  const details = String(body || '').split(/\r?\n/)
    .map((line) => line.trim().match(/^\[sidequest:negative-control-test\]\s+(.*)$/i)?.[1] || '')
    .filter(Boolean);
  const unreported = expectedTestNames.filter((name) => !details.some((detail) => {
    const reportedName = detail.match(/^(failed|unaffected)\s+(.+)$/i)?.[2];
    return reportedName?.includes(name) === true;
  }));
  return unreported;
}

function negativeControlResult(ticket?: any, expectedTestNames: string[] = []) {
  const claimHolder = String(ticket?.claim?.by || '').trim();
  if (!claimHolder) return { kind: 'missing' };
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  let otherControlAuthor = '';
  let malformedMarkerLine = '';
  for (const comment of comments.slice().reverse()) {
    const body = String(comment.body || '').trim();
    const markerLine = body.split(/\r?\n/).map((line: string) => line.trim()).find((line: string) => line.startsWith('[sidequest:negative-control]'));
    if (comment?.by !== claimHolder) {
      if (!otherControlAuthor && markerLine) otherControlAuthor = String(comment?.by || 'unknown');
      continue;
    }
    if (!markerLine) continue;
    const waived = markerLine.match(/^\[sidequest:negative-control\]\s+waived\s+(.+)/);
    const waiverReason = waived?.[1]?.trim();
    if (waiverReason) return waiverReason.length >= 20 ? { kind: 'waived' } : { kind: 'short_waiver' };
    const failed = markerLine.match(/^\[sidequest:negative-control\]\s+target=([^;]+);\s*assertion=([^;]+);\s*(.+?)\s+failed=(\d+)/);
    if (failed) {
      if (!failed[1]?.trim() || !failed[2]?.trim()) return { kind: 'missing_target_or_assertion' };
      if (Number(failed[4]) === 0) return { kind: 'zero_failures' };
      const failureKind = negativeControlFailureKind(body);
      if (failureKind) return { kind: failureKind };
      const unreportedTests = negativeControlTestReport(body, expectedTestNames);
      return unreportedTests.length ? { kind: 'unreported_tests', tests: unreportedTests } : { kind: 'failed' };
    }
    if (/^\[sidequest:negative-control\]\s+.+?\s+failed=\d+/.test(markerLine)) return { kind: 'missing_target_or_assertion' };
    if (!malformedMarkerLine) malformedMarkerLine = markerLine;
  }
  if (malformedMarkerLine) return { kind: 'malformed_marker', markerLine: malformedMarkerLine };
  return otherControlAuthor ? { kind: 'wrong_author', by: otherControlAuthor } : { kind: 'missing' };
}

function negativeControlRefusal(ticket?: any, result?: any) {
  const recipe = negativeControlRecoveryGuidance();
  if (result.kind === 'import_error' || result.kind === 'collection_error') {
    const failure = result.kind === 'import_error' ? 'an ImportError' : 'a collection error';
    return {
      ok: false,
      reason: `negative_control_${result.kind}`,
      message: `${ticket.ref} completion refused: the recorded negative control failed with ${failure}. ${recipe}`,
    };
  }
  if (result.kind === 'missing_target_or_assertion') {
    return {
      ok: false,
      reason: 'negative_control_evidence_required',
      message: `${ticket.ref} completion refused: the negative control must name the broken target and the assertion that failed. ${recipe}`,
    };
  }
  if (result.kind === 'zero_failures') {
    return {
      ok: false,
      reason: 'negative_control_zero_failures',
      message: `${ticket.ref} completion refused: failed=0 means tests passed against the pre-change code and do not test the change. ${recipe}`,
    };
  }
  if (result.kind === 'unreported_tests') {
    return {
      ok: false,
      reason: 'negative_control_test_required',
      message: `${ticket.ref} completion refused: the negative control did not report these added or modified tests: ${result.tests.join(', ')}. ${recipe}`,
    };
  }
  if (result.kind === 'short_waiver') {
    return {
      ok: false,
      reason: 'negative_control_waiver_too_short',
      message: `${ticket.ref} completion refused: a negative-control waiver needs a reason of at least 20 characters. ${recipe}`,
    };
  }
  if (result.kind === 'malformed_marker') {
    return {
      ok: false,
      reason: 'negative_control_required',
      message: `${ticket.ref} completion refused: found negative-control marker line "${result.markerLine}", but the number was not where it was expected. ${recipe}`,
    };
  }
  if (result.kind === 'wrong_author') {
    return {
      ok: false,
      reason: 'negative_control_required',
      message: `${ticket.ref} completion refused: a negative control was recorded by "${result.by}", but the current claim holder is "${ticket.claim.by}". ${recipe}`,
    };
  }
  return {
    ok: false,
    reason: 'negative_control_required',
    message: `${ticket.ref} completion refused: changed scoped paths include both test-side and non-test-side files, but the claim holder has not recorded a negative control. ${recipe}`,
  };
}

function completionScope(slug?: any, ticket?: any) {
  const relatedFragments = Array.isArray(ticket?.links)
    ? ticket.links.flatMap((link: any) => {
      if (link?.type !== 'related') return [];
      const source = getTicket(slug, link.ref);
      if (source?.submission?.review?.outcome !== 'rejected') return [];
      const fragment = commitScope.ticketReleaseFragment(source.ref);
      return fragment ? [fragment] : [];
    })
    : [];
  return [...new Set([...executionScope(slug, ticket), ...relatedFragments])];
}

function completionTreeCheck(slug?: any, ticket?: any, opts?: any) {
  const state = dispatchState(ticket);
  if (!state || state.readonly === true || state.nonRepoOutput === true) return { ok: true, applicable: false };
  const declaredFiles = completionScope(slug, ticket);
  if (!declaredFiles.length) return { ok: true, applicable: false };
  const delta = dispatchDelta(slug, ticket);
  if (!delta.ok) return { ok: true, applicable: false, unavailable: true };
  const changedPaths = Array.from(new Set([...delta.working, ...delta.committed]))
    .filter((file: string) => commitScope.isInScope(file, declaredFiles))
    .sort();
  if (!changedPaths.length && opts?.explicitNoOp !== true) {
    return {
      ok: false,
      reason: 'empty_declared_scope',
      declaredFiles,
      message: `${ticket.ref} completion refused: its declared write scope has an empty diff since dispatch base. Declared files: ${declaredFiles.join(', ')}. If this run intentionally made no repository change, report [sidequest:verify-complete] no-op: <evidence>; verification outcomes use [sidequest:verify-complete] <passed|failed_suite|toolchain_missing|could_not_run|timeout|manual|attestation|skipped|failed_check>: <evidence>.`,
    };
  }
  if (changedPaths.some(isTestSidePath) && changedPaths.some((file: string) => !isTestSidePath(file))) {
    const negativeControl = negativeControlResult(ticket, changedTestNames(delta, changedPaths));
    if (negativeControl.kind !== 'failed' && negativeControl.kind !== 'waived') return negativeControlRefusal(ticket, negativeControl);
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
  claimMaySubmit,
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
  touchClaimActivity,
} = createClaims({
  completionTreeCheck,
  dispatchDelta,
  dispatchState,
  isolatedDispatchWorktreeMissing,
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
  verificationCompletionCheck,
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
  writeOracleExperimentRound,
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
  submissionReviewRelation,
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
  dispatchVerifyCommandError,
  effectiveScope,
  execFileSync,
  executorText,
  fs,
  getCategory,
  getStory: (...args: any[]) => getStory(...args),
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
  transaction: (...args: any[]) => transaction(...args),
  normalizeVerifyOracleKind,
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
  submissionUsesGit,
  workingTreeVerification,
  verifyIntegration,
  validateIntegrationSubmission,
  recordDeliveredSubmission,
  recordAbandonedSubmission,
  integrateSubmission,
  integrateSubmissionWave,
  closeSubmissionAsSuperseded,
  submissionOwnershipFailure,
  submitTicket,
  recordVerificationCapture,
  recordSubmissionRejection,
  reconcileSubmissionRejections,
  reworkSubmission,
  clearSubmission,
  assembleSubmissionWave,
  recordSubmissionWaveDelivery,
  submissionsPayload,
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
  boundedExcerptForSubmission: (...args: any[]) => boundedExcerpt(...args),
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
  integrationTarget,
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
  recordedReviewPass,
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
  withTicketLock,
});

let refreshingRoutingProfileSeeds = false;
const routingProfileSeedStates = new Map<string, string>();

function installedProviderSeedProfiles() {
  return starterRoutingProfilesFor(discoverExternalModels()
    .filter((model: any) => providerReadiness(model.provider)?.ready === true));
}

function refreshRoutingProfileSeeds(handle?: any) {
  const pending: any[] = [];
  for (const seed of installedProviderSeedProfiles()) {
    const profile = handle.prepare(`
      SELECT id, seed_revision FROM routing_profiles WHERE source = 'seed' AND seed_key = ?
    `).get(seed.id);
    if (!profile || profile.seed_revision == null) continue;
    const existing = handle.prepare(`
      SELECT category_id, data, position FROM routing_profile_entries
      WHERE profile_id = ? ORDER BY position, category_id
    `).all(profile.id);
    const matchesSeed = existing.length === seed.categories.length
      && existing.every((entry: any, position: number) => entry.category_id === seed.categories[position].id
        && entry.data === JSON.stringify(seed.categories[position])
        && Number(entry.position) === position);
    if (Number(profile.seed_revision) >= ROUTING_PROFILE_SEED_REVISION && matchesSeed) continue;
    pending.push({ seed, profileId: profile.id });
  }
  if (!pending.length) return;
  withinTransaction(handle, () => {
    const now = new Date().toISOString();
    const affected = new Set<string>();
    for (const { seed, profileId } of pending) {
      handle.prepare('DELETE FROM routing_profile_entries WHERE profile_id = ?').run(profileId);
      seed.categories.forEach((category: any, position: number) => {
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
    refreshPreparedDispatches(handle, [...affected], null, { preservePrepared: true });
  });
  invalidateStoreCaches();
}

function refreshReadonlyCategorySeeds(handle?: any) {
  const readonlyIds = new Set([
    ...DEFAULT_CATEGORIES.filter((category: any) => category.readonly === true).map((category: any) => category.id),
    'hand-analysis',
  ]);
  const affected = new Set<string>();
  let changed = false;
  withinTransaction(handle, () => {
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

function refreshRoutingProfileSeedsForCatalogState(handle: unknown, root: string) {
  const currentState = catalogStateFingerprint();
  if (routingProfileSeedStates.get(root) === currentState) return;
  refreshRoutingProfileSeeds(handle);
  routingProfileSeedStates.set(root, catalogStateFingerprint());
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
      refreshRoutingProfileSeedsForCatalogState(handle, root);
    } finally {
      refreshingRoutingProfileSeeds = false;
    }
  }
  return handle;
}

function transaction(fn?: any) {
  return withinTransaction(database(), fn);
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

const VALID_STATUS = ['todo', 'doing', 'awaiting-oracle', 'done'];
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

configLayer = createConfig({ DEFAULT_INTEGRATION_VERIFY_TIMEOUT_MS, DELIVERY_MODES, execFileSync, fs, getProjectCategories, isTrackedBuildOutput: (...args: any[]) => warningsLayer?.isTrackedBuildOutput(...args), packageBuildOutputs: (...args: any[]) => warningsLayer?.packageBuildOutputs(...args) || [], packageRootForScope: (...args: any[]) => warningsLayer?.packageRootForScope(...args), path, projectRoutingProfile, readMeta, routingProfileEntries, MAX_INTEGRATION_VERIFY_TIMEOUT_MS, WORKTREE_SETUP_MAX_LENGTH, withMetaLock, putProject });


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
    return ticket && ticket.id ? applyDerivedRouting(normalizePreparedDispatch(ticket), { project: slug }) : null;
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

// The executor name a claim refusal should name. A recorded dispatch is authoritative; without one, the name
// prepare WOULD record is, because `exec.agent` is the read-write dispatch name for every Codex route whether
// the ticket is readonly or not, and naming it sent readonly executors to spawn their read-write twin
// (SQ-2110, SQ-2205).
function expectedClaimExecutor(ticket?: any) {
  const prepared = canonicalPreparedDispatchExecutor(ticket);
  if (ticket?.dispatch?.executor || ticket?.dispatchExecutor) return prepared;
  return isRoutedTicket(ticket) ? stableExecutorName(ticket) : prepared;
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

function lifecycleBaseline(slug: any, ticket: any, purpose: 'dispatch' | 'wave' | 'submission') {
  const preparedAt = String(ticket.dispatch?.preparedAt || ticket.updatedAt || new Date().toISOString());
  const project = readMeta(slug);
  const projectPath = String(project?.path || '').trim();
  const revision = project?.sourceRevisionAdapter === FILESYSTEM_SNAPSHOT_ADAPTER
    ? filesystemSnapshotBaseline(slug, preparedAt)
    : Object.freeze({
      source: 'git',
      value: String(commitScope.headCommit(projectPath) || ticket.id || ticket.ref),
      observedAt: preparedAt,
    });
  return Object.freeze({ revision, purpose });
}

function recordLifecycleAttempt(ticket: any, attempt: any) {
  ticket.lifecycleAttempt = attempt;
  if (ticket.dispatch) ticket.dispatch.lifecycleAttempt = attempt;
}

function lifecycleAttemptFromFacts(slug: any, ticket: any, authority: any, purpose: 'dispatch' | 'wave' | 'submission', direct: boolean) {
  const persistedAttempt = ticket.lifecycleAttempt || ticket.dispatch?.lifecycleAttempt;
  const baseline = persistedAttempt?.baseline || lifecycleBaseline(slug, ticket, purpose);
  const preparedCompatibility = persistedAttempt?.preparedCompatibility || ticket.dispatch?.preparedCompatibility;
  let current: any = direct
    ? prepareDirectAttempt(baseline, persistedAttempt?.authority || authority)
    : prepareAttempt(baseline, persistedAttempt?.authority || authority, preparedCompatibility);
  const dispatch = ticket.dispatch;
  if (direct) {
    if (ticket.claim || ticket.submission) current = transitionAttempt(current, 'claim_direct');
  } else if (dispatch) {
    if (dispatch.launchedAt) current = transitionAttempt(current, 'launch');
    if (dispatch.boundAt || ticket.claim || ticket.submission) {
      current = transitionAttempt(current, current.state === 'launched' ? 'bind' : 'bind_claim_token');
    }
    if (ticket.claim || ticket.submission) current = transitionAttempt(current, 'claim');
  }
  if (ticket.submission) {
    for (const event of ['start_work', 'verify', 'submit'] as const) current = transitionAttempt(current, event);
  }
  const diagnostic = attemptDiagnostic(current);
  if (diagnostic) throw new Error(`lifecycle refused ${ticket.ref}: ${diagnostic.message}`);
  return current;
}

function liveRuntimeClaim(slug?: any, ticket?: any, by?: any) {
  const claimant = String(by || '').trim();
  if (!claimant) return null;
  for (const project of listProjects({ all: true })) {
    for (const candidate of listTickets(project.slug)) {
      const dispatch = dispatchState(candidate);
      if (project.slug === slug && candidate.id === ticket?.id) continue;
      if (!candidate.claim?.by || candidate.claim.by !== claimant || candidate.status === 'done' || !dispatch || dispatch.terminalAt || claimReclaimable(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function claimAdmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  if (opts.direct) return { ok: true, ticket, token: null };
  if (opts.effort != null) {
    const derivedEffort = ticket.effort || (CLAUDE_RUNTIMES.includes(ticket.model) ? 'low' : null);
    const claimedEffort = String(opts.effort).toLowerCase();
    if (derivedEffort && claimedEffort !== derivedEffort) {
      const resolved = resolveExec(ticket.model, derivedEffort);
      const expectedExecutor = expectedClaimExecutor(ticket) || (resolved && resolved.agent) || `sidequest-exec-${derivedEffort}`;
      return {
        ok: false,
        reason: 'effort_mismatch',
        ticket,
        derivedModel: ticket.model,
        derivedEffort,
        claimedEffort,
        expectedExecutor,
        message: `${ticket.ref} resolves to ${ticket.model}·${derivedEffort}, but ${claimedEffort} was requested. Run sidequest dispatch ${ticket.ref}, then spawn ${expectedExecutor}.`,
      };
    }
  }
  const token = dispatchTokenForRequest(opts.token, opts.tokenFile);
  if (!ticket.dispatchNonce) {
    if (!opts.executor || !ticket.exec || ticket.exec.backend !== 'codex') return { ok: true, ticket, token };
    const expectedExecutor = expectedClaimExecutor(ticket);
    if (opts.executor === expectedExecutor) return { ok: true, ticket, token };
    return {
      ok: false,
      reason: 'executor_mismatch',
      ticket,
      derivedModel: ticket.model,
      derivedEffort: ticket.effort,
      executor: opts.executor,
      expectedExecutor,
      message: `${ticket.ref} resolves to ${ticket.exec.runsLabel} · ${ticket.effort} (${ticket.exec.backend}), but ${opts.executor} is not its generated executor. Run sidequest dispatch ${ticket.ref}, then spawn ${expectedExecutor}.`,
    };
  }
  if (!dispatchTokenMatches(ticket.dispatchNonce, token)) {
    if (isSupersededDispatchToken(ticket, token)) {
      return {
        ok: false,
        reason: 'token',
        ticket,
        message: `${ticket.ref}'s dispatch was superseded by a newer preparation. Re-read this dispatch's token from its own briefing before claiming.`,
      };
    }
    return { ok: false, reason: 'token', ticket };
  }
  const preparedExecutor = canonicalPreparedDispatchExecutor(ticket);
  if (opts.executor !== preparedExecutor) {
    return {
      ok: false,
      reason: 'executor_mismatch',
      ticket,
      derivedModel: ticket.model,
      derivedEffort: ticket.effort,
      executor: opts.executor || null,
      expectedExecutor: preparedExecutor,
      message: `${ticket.ref} has a prepared dispatch for ${preparedExecutor}, not ${opts.executor || 'this executor'}. Re-run sidequest dispatch ${ticket.ref} and claim with its returned executor and token.`,
    };
  }
  return { ok: true, ticket, token };
}

function bindClaimRuntimeIdentity(slug?: any, idOrRef?: any, opts?: any) {
  const agentId = String(opts?.agentId || '').trim();
  const found = getTicket(slug, idOrRef);
  if (!agentId || !found) return { ok: false, reason: !found ? 'not_found' : 'missing_identity' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    const admission = claimAdmission(slug, ticket.id, opts);
    if (!admission.ok) return admission;
    const state = dispatchState(ticket);
    if (!state || state.terminalAt || !['prepared', 'launched', 'claimed'].includes(state.outcome)) {
      return { ok: false, reason: 'dispatch_unavailable', ticket };
    }
    // What binds here is the runtime the harness reported (agent_id from hook
    // stdin) to the claim the dispatch token authorizes. The token is the
    // per-dispatch credential: each executor is handed only its own, so a
    // sibling can present another dispatch's token only by reading a file it
    // was never given, which is the same class as importing the store and sits
    // outside this boundary. What the store CAN check is that the runtime
    // belongs to the session that prepared the reservation (hook stdin cannot
    // name an agent_name; Claude Code's hook schema carries agent_id and
    // agent_type only), the same match dispatchCanBindRuntimeIdentity requires.
    const sessionId = String(opts?.sessionId || '').trim();
    if (!sessionId || String(state.sessionId || '').trim() !== sessionId) {
      return { ok: false, reason: 'session_mismatch', ticket };
    }
    const boundAgentId = String(state.agentId || '').trim();
    if (boundAgentId && boundAgentId !== agentId) {
      return { ok: false, reason: 'runtime_identity_mismatch', ticket };
    }
    const now = new Date().toISOString();
    if (!recordDispatchRuntimeIdentity(slug, state, agentId, null, now)) {
      return { ok: false, reason: 'runtime_identity_mismatch', ticket };
    }
    state.bindSource = 'claim_runtime_identity';
    stampDispatchEvent(ticket, 'claim-runtime-identity', now);
    putTicket(slug, ticket);
    return { ok: true, ticket };
  });
}

function claimTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const result = withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id); // fresh read, under the lock
    if (!t) return { ok: false, reason: 'not_found' };
    // A bound candidate is frozen for its review: reclaiming it would let the
    // implementer resume or amend the exact revision under audit.
    const candidateReview = submissionReviewRelation(slug, t);
    if (candidateReview) {
      return {
        ok: false,
        reason: 'candidate_review_locked',
        ticket: t,
        message: reviewLockMessage('claim', t, candidateReview),
      };
    }
    const delay = testClaimLockDelayMs();
    if (delay) busyWait(delay);
    const directClaimReason = directReason(opts.reason);
    if (opts.direct && isRoutedTicket(t) && !directClaimReason) return { ok: false, reason: 'direct_reason_required', ticket: t };
    if (opts.direct && isRoutedTicket(t) && !directReasonAllowed(directClaimReason)) return { ok: false, reason: 'direct_not_allowed', ticket: t, expectedExecutor: expectedClaimExecutor(t) };
    const admission = claimAdmission(slug, found.id, opts);
    if (!admission.ok) return admission;
    const currentDispatch = dispatchState(t);
    const terminalDispatch = Boolean(currentDispatch?.terminalAt && currentDispatch?.outcome);
    if (opts.direct && t.dispatchNonce && !terminalDispatch) return { ok: false, reason: 'direct_conflict', ticket: t };
    if (opts.direct && t.dispatchNonce && terminalDispatch && !opts.force) return { ok: false, reason: 'terminal_claim_takeover_required', ticket: t };
    if (!opts.direct && isRoutedTicket(t) && !t.dispatchNonce) return { ok: false, reason: 'dispatch_required', ticket: t };
    if (currentDispatch?.preparedCompatibility?.pluginInstall && t.dispatchNonce) {
      const currentInstall = checkSidequestInstall(readMeta(slug)?.path || '');
      if (preparedCompatibilityHasProvenMismatch(currentDispatch, currentInstall)) {
        const retired = retirePreparedCompatibilityStaleAttempt(slug, t);
        return {
          ok: false,
          reason: 'prepared_compatibility_stale',
          ticket: retired,
          message: `claim: refused ${t.ref}; its prepared Sidequest install snapshot is stale, so this dispatch attempt was retired. Stop without claiming; the orchestrator can dispatch a fresh token.`,
        };
      }
    }
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const now = new Date().toISOString();
    const lifecycleAuthority = { actor: by, operation: 'claim', sessionId: opts.sessionId || null };
    const directExecution = opts.direct || !currentDispatch;
    let activeAttempt = directExecution
      ? lifecycleAttemptFromFacts(slug, t, lifecycleAuthority, 'dispatch', true)
      : lifecycleAttemptFromFacts(slug, t, lifecycleAuthority, 'dispatch', false);
    if (!directExecution && opts.requireBoundAgent && currentDispatch && activeAttempt.state === 'prepared') {
      const boundAttempt = bindDispatchClaimToken(currentDispatch, activeAttempt, opts.sessionId, opts.executor, now);
      if (boundAttempt) activeAttempt = boundAttempt;
    }
    if (!directExecution && opts.requireBoundAgent && currentDispatch && activeAttempt.state === 'launched' && !currentDispatch.boundAt) {
      const boundAttempt = bindDispatchClaimToken(currentDispatch, activeAttempt, opts.sessionId, opts.executor, now);
      if (boundAttempt) activeAttempt = boundAttempt;
    }
    if (!directExecution && !opts.requireBoundAgent && ['prepared', 'launched'].includes(activeAttempt.state)) {
      activeAttempt = transitionAttempt(activeAttempt, 'bind_claim_token');
    }
    if (!directExecution && opts.requireBoundAgent && activeAttempt.state !== 'bound' && activeAttempt.state !== 'claimed') {
      currentDispatch.failedClaimSurrender = {
        by,
        executor: String(opts.executor || ''),
        sessionId: opts.sessionId ? String(opts.sessionId) : null,
        tokenDigest: dispatchTokenDigest(admission.token),
        tokenPrefix: dispatchTokenPrefix(admission.token),
        at: now,
      };
      stampDispatchEvent(t, opts.source || 'claim', now);
      putTicket(slug, t);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      return {
        ok: false,
        reason: 'unbound_dispatch',
        ticket: t,
        message: `claim: refused ${t.ref}; this runtime presented the current token and executor but did not bind to the prepared dispatch. ${by} may immediately release this attempt with kind technical_blocker, using this refusal as the command/output evidence and the same session identity when one was supplied, then stop.`,
      };
    }
    if (currentDispatch?.resumedAt && isolatedDispatchWorktreeMissing(currentDispatch)) return { ok: false, reason: 'worktree_missing', ticket: t };
    // Submitted work awaits the orchestrator's publish transaction, not another
    // executor: re-claiming it would fork the already-verified commit. The
    // orchestrator clears the submission first when rework is genuinely wanted.
    if (pendingSubmission(t) && !opts.force) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: 'claimed', ticket: t, claim: held };
    }
    const runtimeClaim = !opts.direct && !opts.force
      ? liveRuntimeClaim(slug, t, by)
      : null;
    if (runtimeClaim) {
      return {
        ok: false,
        reason: 'runtime_claimed',
        ticket: t,
        claim: runtimeClaim.claim,
        message: `claim: refused ${t.ref}; this runtime already holds ${runtimeClaim.ref}. One runtime may hold one live ticket claim. The orchestration session must dispatch any review or follow-up.`,
      };
    }
    const claimRuntime = currentDispatch ? {
      sessionId: currentDispatch.sessionId || opts.sessionId || null,
      executor: currentDispatch.executor || null,
      agentId: currentDispatch.agentId || null,
      agentName: currentDispatch.agentName || null,
    } : opts.sessionId ? {
      sessionId: String(opts.sessionId),
      executor: null,
      agentId: null,
      agentName: null,
    } : null;
    t.claim = {
      by,
      at: now,
      generation: crypto.randomUUID(),
      ...(claimRuntime ? { runtime: claimRuntime } : {}),
    };
    if (opts.direct && opts.force && terminalDispatch && held?.by && held.by !== by) {
      t.claimTakeover = {
        by,
        at: now,
        previousBy: held.by,
        evidence: {
          outcome: currentDispatch.outcome,
          terminalAt: currentDispatch.terminalAt,
          terminalSource: currentDispatch.terminalSource || null,
        },
      };
    }
    if (t.storyId && !Number.isInteger(t.dispatch?.storyLogRevision)) {
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
      delete state.failedClaimSurrender;
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.claimedAt = now;
      state.outcome = 'claimed';
    }
    const previousStatus = t.status;
    const preClaimAttempt = activeAttempt;
    if (directExecution && preClaimAttempt.state !== 'prepared' && preClaimAttempt.state !== 'claimed') {
      return { ok: false, reason: 'invalid_transition', ticket: t, message: 'Cannot directly claim an attempt after execution started.' };
    }
    if (!directExecution && preClaimAttempt.state !== 'bound' && preClaimAttempt.state !== 'claimed') {
      return { ok: false, reason: 'invalid_transition', ticket: t, message: 'Cannot claim a dispatched attempt before it is bound.' };
    }
    const claimedAttempt = preClaimAttempt.state === 'claimed'
      ? preClaimAttempt
      : transitionAttempt(preClaimAttempt, directExecution ? 'claim_direct' : 'claim');
    const claimDiagnostic = attemptDiagnostic(claimedAttempt);
    if (claimDiagnostic) return { ok: false, reason: claimDiagnostic.code, ticket: t, message: claimDiagnostic.message };
    recordLifecycleAttempt(t, claimedAttempt);
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

function failedClaimCanSurrender(ticket?: any, dispatch?: any, by?: any, opts?: any) {
  const authorization = dispatch?.failedClaimSurrender;
  const nonce = String(ticket?.dispatchNonce || '').trim();
  if (!authorization || !nonce || opts?.releaseKind !== 'technical_blocker') return false;
  if (String(authorization.by || '') !== String(by || '')) return false;
  if (String(authorization.executor || '') !== String(dispatch?.executor || '')) return false;
  if (String(authorization.tokenDigest || '') !== dispatchTokenDigest(nonce)) return false;
  const authorizedSessionId = String(authorization.sessionId || '').trim();
  return !authorizedSessionId || authorizedSessionId === String(opts?.sessionId || '').trim();
}

// Release a claim. Only the owner or a reclaimable claim may release it.
// force can reopen the owner's pending submission, never bypass ownership.
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
    const held = t.claim;
    const heldOwner = String(held?.by || '').trim();
    const submissionOwner = String(t.submission?.by || '').trim();
    const controlPlaneDone = opts.status === 'done' && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
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
            message: `${heldOwner ? '' : `${t.ref} has no claim to release. `}${t.ref} has a pending submission (commit ${String(t.submission.commit).slice(0, 12)}) parked READY_FOR_INTEGRATION. release cannot move it to "${reopenStatus}" and leave the submission in place. For a review rejection, use \`sidequest rework ${t.ref} --by <reviewer> --review <evidence> --reason "what needs repair"\`, then dispatch the ticket for repair. When a reviewed candidate already landed through an external conflict resolution, use the integrate route with deliveryCommit and reason. It verifies the named reachable delivery against the submitted content and merged tree before closing. Candidate-owner \`--force\` and \`submit --clear\` intentionally drop the candidate and are only for an integration bounce.`,
          };
        }
        reopenedSubmission = t.submission;
      }
    }
    const executorDone = opts.status === 'done' && !controlPlaneDone;
    const dispatch = dispatchState(t);
    const artifactDispatch = sharedTreeArtifactMode(t);
    const declaredFiles = dispatch && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : normalizeFiles(t.files);
    // Held is held. Closeout never consults a clock: an executor that actually
    // did the work must always be able to hand it in, 5 minutes or 5 hours in.
    const liveClaim = Boolean(held && held.by);
    const activeDispatch = Boolean(t.dispatchNonce || (dispatch && !dispatch.terminalAt));
    const surrenderingFailedClaim = !liveClaim && activeDispatch && failedClaimCanSurrender(t, dispatch, by, opts);
    if (!liveClaim && activeDispatch && !surrenderingFailedClaim && !opts.force) {
      const foundState = dispatch?.outcome || (t.dispatchNonce ? 'prepared' : 'unknown');
      return {
        ok: false,
        reason: 'unclaimed_active_dispatch',
        message: `${t.ref} has an active ${foundState} dispatch but no claim owned by ${by}. Do not release another runtime's attempt. A claimant whose current token and executor were accepted but whose runtime could not bind receives an unbound_dispatch refusal that authorizes the same claimant to release with kind technical_blocker. Otherwise wait for the current attempt's terminal hook, then have the orchestrator dispatch once from todo. recoveryEvidence applies only when a prepared, launched, or bound dispatch never claimed and terminal-agent evidence confirms that runtime ended. After a terminal dispatch, deliver verified landed work through \`sidequest groomClose ${t.ref} --by <integrator> --deliveryCommit <sha>\`.`,
        ticket: t,
      };
    }
    const activeArtifactDispatch = artifactDispatch && liveClaim && activeDispatch;
    const activeWorkingTreeDelivery = dispatch?.workingTreeDelivery === true && liveClaim && activeDispatch;
    const activeNonRepoOutput = dispatch?.nonRepoOutput === true && liveClaim && activeDispatch;
    const activeReadOnlyDispatch = dispatch?.readonly === true && liveClaim && activeDispatch;
    let sharedTreeCommittedScope = false;
    let completionDelta: any = null;
    // Ahead of the scope check on purpose: a review sitting on another commit reports that tree's files as dirty
    // or committed scope, and telling a readonly reviewer to commit or restore them is advice it cannot take
    // (SQ-2207). It also only reports them when the drift happens to touch a declared file, so the wrong tree has
    // to be named on its own.
    if (executorDone && liveClaim && activeDispatch) {
      const reviewTree = reviewCandidateTreeRefusal(slug, t);
      if (reviewTree) return Object.assign({ ticket: t }, reviewTree);
    }
    if (executorDone && liveClaim && activeDispatch) {
      completionDelta = dispatchDelta(slug, t);
      if (completionDelta.ok && !activeArtifactDispatch) {
        const scopedCommitted = completionDelta.committed.filter((file: string) => commitScope.isInScope(file, declaredFiles));
        sharedTreeCommittedScope = dispatch?.sharedTree === true && scopedCommitted.length > 0;
        const scopedWorking = completionDelta.working.filter((file: string) => commitScope.isInScope(file, declaredFiles));
        // A restricted read-only executor cannot own shared-checkout changes; siblings must remain free to commit during its run.
        const sharedTreeReadOnly = activeReadOnlyDispatch && dispatch?.sharedTree === true;
        const scopedChanges = activeReadOnlyDispatch && !sharedTreeReadOnly
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
    if (executorDone && activeWorkingTreeDelivery) {
      let delivery;
      try {
        delivery = workingTreeDeliveryCloseout(slug, t, completionDelta);
      } catch (error: any) {
        return { ok: false, reason: 'working_tree_delivery_unavailable', ticket: t, message: `${t.ref} cannot inspect its working-tree deliverable: ${error?.message || error}` };
      }
      if (!delivery.ok) return Object.assign({ ticket: t }, delivery);
      const verification = workingTreeVerification(t, delivery.candidate);
      if (!verification.ok) return Object.assign({ ticket: t }, verification);
      opts.completionProvenance = {
        purpose: 'working-tree',
        workingTree: {
          candidate: delivery.candidate,
          changedPaths: delivery.changedPaths,
          verification: verification.verification,
        },
      };
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
    const provenNoOp = opts.cleanDeclaredScope === true || Boolean(dispatch?.noOpRelease);
    if (executorDone && dispatch && declaredFiles.length && !provenNoOp && !sharedTreeCommittedScope && !activeReadOnlyDispatch && !activeArtifactDispatch && !activeWorkingTreeDelivery && !activeNonRepoOutput) {
      return {
        ok: false,
        reason: 'submission_required',
        message: `${t.ref} has routed repository write scope. Its executor must commit and submit verified changes. A read-only dispatch may close with done, but readonly:false selects this write path. If the ticket contract forbids commits, set workingTreeDelivery:true before dispatch and run it in the shared checkout; done then records its declared working-tree paths and matching pinned verify-capture. A clean declared scope may close as an external-deliverable completion only when the ticket explicitly sets externalDeliverable:true. The orchestrator can set that flag through update during this claim; then run the pinned command through the dispatched verify-capture wrapper for the current dispatch attempt and revision, and repeat done. Dirty or committed declared paths still require commit and submit.`,
        ticket: t,
      };
    }
    if (executorDone && liveClaim && activeDispatch) {
      const completion = completionTreeCheck(slug, t, { explicitNoOp: opts.cleanDeclaredScope === true });
      if (!completion.ok) return Object.assign({ ticket: t }, completion);
      if (!completionDelta?.ok && dispatch?.sharedTree === true && dispatch?.baseCommit) {
        return {
          ok: false,
          reason: 'dispatch_delta_unavailable',
          message: `${t.ref} cannot inspect the full dispatch delta before done closeout. Restore the dispatch worktree or release the ticket and dispatch again.`,
          ticket: t,
        };
      }
    }
    const expectedClaim = opts.expectedClaim;
    if (expectedClaim && (!held?.by || held.by !== expectedClaim.by || held.at !== expectedClaim.at)) {
      return { ok: false, reason: 'claim_changed', ticket: t, claim: held || null };
    }
    const bypassOwnership = controlPlaneDone && opts.completionAuthority === CONTROL_PLANE_COMPLETION;
    if (!bypassOwnership && submissionOwner && submissionOwner !== by) {
      return { ok: false, reason: 'not_owner', ticket: t, submission: t.submission, ...(held ? { claim: held } : {}) };
    }
    if (!bypassOwnership && heldOwner && heldOwner !== by && !claimReclaimable(t)) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    const oracleRequested = nullableText(opts.oracle);
    const oracleRelease = opts.releaseKind === 'oracle';
    if (oracleRelease && !oracleRequested) throw new Error('oracle release requires a non-empty oracle ask');
    if (oracleRequested && !oracleRelease) throw new Error('oracle ask requires release kind oracle');
    if (oracleRelease && coerceStatus(opts.status || 'awaiting-oracle', t.status) !== 'awaiting-oracle') {
      throw new Error('oracle release must set the ticket to awaiting-oracle');
    }
    if (oracleRelease && t.oracle && !t.oracle.verdict) {
      throw new Error('ticket already awaits an oracle verdict');
    }
    if (oracleRequested) oracleMarker(dispatch, opts, null);
    // The sweep decides on an unlocked snapshot; re-check under the lock so a
    // claim that came back to life in between is never released out from under it.
    if (opts.requireReleaseVerdict) {
      if (!claimReleaseVerdict(t)) {
        return {
          ok: false,
          reason: 'claim_live',
          message: `${t.ref} is still live-claimed by "${held && held.by}"; the sweep re-checked it under the lock and left it alone.`,
          ticket: t,
          claim: held,
        };
      }
      const releaseBlocker = claimReleaseBlocker(slug, t);
      if (releaseBlocker) {
        const changed = releaseBlocker.paths?.length ? ` Changed paths: ${releaseBlocker.paths.join(', ')}.` : '';
        return {
          ok: false,
          reason: releaseBlocker.kind,
          message: `${t.ref} claim release refused: ${releaseBlocker.reason}.${changed}`,
          paths: releaseBlocker.paths || [],
          ticket: t,
          claim: held,
        };
      }
    }
    const noOpRelease = liveClaim && hasNoOpReleaseProof(slug, t, by);
    const now = new Date().toISOString();
    const previousStatus = t.status;
    let comment = null;
    if (releaseComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(releaseComment, now);
      t.comments.push(comment);
    }
    if (oracleRelease) {
      t.oracle = oracleMarker(dispatch, opts, now);
      writeOracleExperimentRound(slug, t);
    }
    const closesPendingSubmission = opts.status === 'done' && pendingSubmission(t);
    const lifecycleAlreadyTerminal = ['closed', 'released'].includes(t.lifecycleAttempt?.state);
    const releasedAttempt = !closesPendingSubmission && t.lifecycleAttempt && !lifecycleAlreadyTerminal
      ? transitionAttempt(t.lifecycleAttempt, 'release')
      : t.lifecycleAttempt;
    const releaseDiagnostic = releasedAttempt ? attemptDiagnostic(releasedAttempt) : null;
    if (releaseDiagnostic) {
      return {
        ok: false,
        reason: releaseDiagnostic.code,
        ticket: t,
        message: releaseDiagnostic.message,
      };
    }
    if (releasedAttempt) recordLifecycleAttempt(t, releasedAttempt);
    t.claim = null;
    if (noOpRelease && dispatch) dispatch.noOpRelease = { by, at: now, claimAt: held?.at || null };
    // Provenance for a claim taken away from its holder rather than handed back,
    // so a later closeout attempt can be refused with an actionable recovery.
    if (opts.claimRelease) {
      t.claimRelease = Object.assign({ by, at: now, source: opts.source || 'store' }, opts.claimRelease);
    }
    const terminalOutcome = opts.status === 'done'
      ? 'done'
      : dispatch?.outcome === 'died' || opts.claimRelease?.kind === 'session_ended'
        ? 'died'
        : 'released';
    const release = opts.releaseKind ? {
      kind: String(opts.releaseKind),
      reason: String(opts.releaseReason || '').trim() || null,
      evidence: opts.releaseEvidence || null,
      source: opts.source || 'cli',
      at: now,
    } : null;
    if (release) t.release = release;
    if (dispatch) delete dispatch.failedClaimSurrender;
    if (!dispatch?.terminalAt || dispatch.outcome !== terminalOutcome) {
      setDispatchTerminal(t, terminalOutcome, opts.source || 'cli', {
        slug,
        failureShape: opts.failureShape || release?.kind || 'unknown',
        releaseKind: release?.kind,
        releaseReason: release?.reason,
        releaseEvidence: release?.evidence,
      });
    }
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    if (reopenedSubmission) t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    else if (oracleRelease) t.status = 'awaiting-oracle';
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
        ...(dispatch?.noOpRelease ? { purpose: 'no-op', noOp: dispatch.noOpRelease } : {}),
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
    if (closesPendingSubmission) {
      const assembledAttempt = t.lifecycleAttempt?.state === 'submitted' ? transitionAttempt(t.lifecycleAttempt, 'assemble') : t.lifecycleAttempt;
      const integratedAttempt = assembledAttempt?.state === 'assembled' ? transitionAttempt(assembledAttempt, 'integrate') : assembledAttempt;
      const closedAttempt = integratedAttempt?.state === 'integrated' ? transitionAttempt(integratedAttempt, 'close') : integratedAttempt;
      const lifecycleDiagnostic = closedAttempt ? attemptDiagnostic(closedAttempt) : null;
      if (lifecycleDiagnostic) return { ok: false, reason: lifecycleDiagnostic.code, ticket: t, message: lifecycleDiagnostic.message };
      if (closedAttempt) recordLifecycleAttempt(t, closedAttempt);
      const integratedAt = new Date().toISOString();
      const recordedDelivery = opts.recordedDelivery;
      t.submission = Object.assign({}, t.submission, {
        integratedAt,
        ...(recordedDelivery ? {
          integration: Object.assign({
            outcome: 'verified',
            mode: 'recorded',
            pinnedCommit: t.submission.commit,
            resultingHead: recordedDelivery.commit,
            targetBranch: recordedDelivery.target.branch,
            targetRef: recordedDelivery.target.upstream,
            deliveredAt: integratedAt,
            verifiedAt: integratedAt,
            evidence: recordedDelivery.evidence,
          }, recordedDelivery.integration || {}),
        } : {}),
      });
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

function releaseTerminalClaim(slug?: any, idOrRef?: any, expectedClaim?: any, source?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket?.claim?.by || ticket.claim.by !== expectedClaim?.by || ticket.claim.at !== expectedClaim?.at) {
    return { ok: false, reason: 'claim_changed', ticket: ticket || null };
  }
  const verdict = claimReleaseVerdict(ticket);
  if (!verdict || verdict.kind !== 'observed_stop') return { ok: false, reason: 'claim_live', ticket };
  const released = releaseTicket(slug, ticket.id, expectedClaim.by, {
    status: 'todo',
    source,
    expectedClaim,
    requireReleaseVerdict: true,
    claimRelease: { kind: verdict.kind, reason: verdict.reason, idleMs: Number.isFinite(verdict.idleMs) ? verdict.idleMs : null },
  });
  if (released.ok) {
    addComment(slug, ticket.id, {
      by: 'sidequest',
      kind: 'comment',
      source,
      body: claimReleaseNote(ticket, verdict),
    });
  }
  return released;
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

type WorkingTreeDeliveryCandidate = Readonly<{
  candidate: Readonly<{ source: 'working-tree'; value: string }>;
  changedPaths: readonly string[];
}>;
type WorkingTreeDeliveryCloseout =
  | Readonly<{ ok: true; candidate: WorkingTreeDeliveryCandidate['candidate']; changedPaths: WorkingTreeDeliveryCandidate['changedPaths'] }>
  | Readonly<{ ok: false; reason: string; message: string; unscopedPaths?: readonly string[] }>;

function workingTreeDeliveryCandidate(slug?: any, ticket?: any): WorkingTreeDeliveryCandidate | null {
  const dispatch = dispatchState(ticket);
  const declaredFiles = Array.isArray(dispatch?.declaredFiles) ? dispatch.declaredFiles : [];
  if (dispatch?.workingTreeDelivery !== true || !Array.isArray(dispatch.workingTreeDirtyBaseline) || !declaredFiles.length) return null;
  const baseline = new Map(dispatch.workingTreeDirtyBaseline.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const current = artifactWorkingState(slug);
  const currentByPath = new Map(current.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const changed = new Map<string, string>();
  for (const entry of dispatch.workingTreeDirtyBaseline) {
    if (!commitScope.isInScope(entry.path, declaredFiles)) continue;
    const currentEntry: any = currentByPath.get(dirtyPathKey(entry.path));
    if (!currentEntry || currentEntry.identity !== entry.identity) changed.set(entry.path, currentEntry?.identity || 'missing');
  }
  for (const entry of current) {
    if (commitScope.isInScope(entry.path, declaredFiles) && !baseline.has(dirtyPathKey(entry.path))) changed.set(entry.path, entry.identity);
  }
  const paths = Array.from(changed.keys()).sort();
  return {
    candidate: {
      source: 'working-tree',
      value: crypto.createHash('sha256').update(JSON.stringify(paths.map((path) => [path, changed.get(path)]))).digest('hex'),
    },
    changedPaths: paths,
  };
}

function workingTreeDeliveryCloseout(slug?: any, ticket?: any, completionDelta?: any): WorkingTreeDeliveryCloseout {
  const dispatch = dispatchState(ticket);
  const candidate = workingTreeDeliveryCandidate(slug, ticket);
  if (!candidate) return { ok: false, reason: 'working_tree_delivery_unavailable', message: `${ticket.ref} cannot inspect its pinned working-tree deliverable. Release it and dispatch again.` };
  const declaredFiles = dispatch.declaredFiles;
  const baseline = new Map(dispatch.workingTreeDirtyBaseline.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const current = artifactWorkingState(slug);
  const currentByPath = new Map(current.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const outside = new Set<string>();
  for (const entry of dispatch.workingTreeDirtyBaseline) {
    if (commitScope.isInScope(entry.path, declaredFiles)) continue;
    const currentEntry: any = currentByPath.get(dirtyPathKey(entry.path));
    if (!currentEntry || currentEntry.identity !== entry.identity) outside.add(entry.path);
  }
  for (const entry of current) {
    if (!baseline.has(dirtyPathKey(entry.path)) && !commitScope.isInScope(entry.path, declaredFiles)) outside.add(entry.path);
  }
  if (outside.size) return { ok: false, reason: 'working_tree_scope_violation', message: `${ticket.ref} changed paths outside its working-tree deliverable: ${Array.from(outside).sort().join(', ')}. Revert them or release the ticket.`, unscopedPaths: Array.from(outside).sort() };
  const committed = Array.isArray(completionDelta?.committed)
    ? completionDelta.committed.filter((file: string) => commitScope.isInScope(file, declaredFiles))
    : [];
  if (committed.length) return { ok: false, reason: 'working_tree_commit_forbidden', message: `${ticket.ref} declares a working-tree deliverable, but committed declared paths: ${committed.join(', ')}. Restore the shared checkout to the uncommitted deliverable before closing.` };
  if (!candidate.changedPaths.length) return { ok: false, reason: 'working_tree_delivery_empty', message: `${ticket.ref} has no changed declared paths to record as a working-tree deliverable.` };
  return { ok: true, ...candidate };
}

function externalDeliverableCloseout(slug?: any, ticket?: any) {
  if (ticket?.externalDeliverable !== true) {
    return {
      ok: false,
      reason: 'external_deliverable_not_declared',
      message: `${ticket.ref} has routed repository write scope. A clean scope can close with done only when the ticket explicitly sets externalDeliverable:true. The orchestrator can set externalDeliverable:true through update during this claim, then this executor can rerun the pinned verify-capture wrapper and done.`,
    };
  }
  const workspace = dispatchWorkspace(slug, ticket);
  if (!workspace) return { ok: false, reason: 'external_deliverable_worktree_unavailable', message: `${ticket.ref} cannot inspect this dispatch worktree, so it cannot record an external-deliverable completion.` };
  const scope = completionScope(slug, ticket);
  const pending = commitScope.scopedWorkPending(workspace.root, scope, { base: workspace.base });
  if (!pending.ok) return { ok: false, reason: 'external_deliverable_scope_unavailable', message: `Could not inspect the declared scope in ${workspace.root}: ${pending.message || pending.reason}.` };
  if (pending.pending) {
    const changes = [
      pending.working.length ? `uncommitted ${pending.working.join(', ')}` : null,
      pending.committed.length ? `committed but not submitted ${pending.committed.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    return { ok: false, reason: 'external_deliverable_scope_dirty', message: `${ticket.ref} has declared repository changes (${changes}); commit and submit them instead of closing as an external-deliverable completion.` };
  }
  let revision: string;
  try {
    revision = String(execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: workspace.root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    })).trim().toLowerCase();
  } catch (error: any) {
    return { ok: false, reason: 'external_deliverable_revision_unavailable', message: `${ticket.ref} cannot read the current revision for its external-deliverable verification capture: ${String(error?.message || error).trim()}` };
  }
  if (!revision) return { ok: false, reason: 'external_deliverable_revision_unavailable', message: `${ticket.ref} cannot read the current revision for its external-deliverable verification capture.` };
  const candidate = { source: 'git', value: revision };
  const verification = workingTreeVerification(ticket, candidate);
  if (!verification.ok) return verification;
  const capture = Array.isArray(ticket.verificationCaptures)
    ? ticket.verificationCaptures.find((entry: any) => entry?.status === 'passed'
      && entry?.candidate?.source === candidate.source
      && entry?.candidate?.value === candidate.value
      && entry?.command === verification.verification.command
      && entry?.dispatchNonce === ticket.dispatchNonce)
    : null;
  return { ok: true, worktree: workspace.root, candidate, verification: verification.verification, capture: capture || null };
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

function linkedReviewPass(slug?: any, ticket?: any) {
  if (!ticket) return false;
  return listTickets(slug).some((candidate?: any) => (candidate.category === 'review-audit' || candidate.category?.id === 'review-audit' || candidate.categoryId === 'review-audit')
    && candidate.status === 'done'
    && Array.isArray(candidate.links)
    && candidate.links.some((link?: any) => String(link?.ref || '').toUpperCase() === String(ticket.ref || '').toUpperCase()));
}

const HIGH_STAKES_REVIEW_WARNING = 'high-stakes ticket integrated without a recorded review pass. Record one with a comment starting reviewed-by: <ref>, or link a completed review-audit ticket.';
const DELIVERY_COMMIT_RE = /^[0-9a-f]{7,64}$/i;

function shippedPluginsWithoutReleaseFragment(repoPath?: any, ref?: any, changedPaths?: any, fragmentExists?: any) {
  const repo = String(repoPath || '').trim();
  if (!repo) return null;
  const marketplacePath = path.join(repo, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(marketplacePath)) return null;
  const manifest = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
  const changed = Array.isArray(changedPaths) ? changedPaths : [];
  const shipped = plugins.flatMap((plugin: any) => {
    const name = String(plugin?.name || '').trim();
    const source = String(plugin?.source || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return name && source && !source.startsWith('../') && changed.some((changedPath: any) => changedPath === source || changedPath.startsWith(`${source}/`))
      ? [{ name, source }]
      : [];
  });
  if (!shipped.length) return null;
  const fragmentPath = `.release/unreleased/${ref}.md`;
  return changed.includes(fragmentPath) && fragmentExists(fragmentPath)
    ? null
    : { fragmentPath, plugins: shipped };
}

function missingReleaseFragment(repoPath?: any, ref?: any, changedPaths?: any) {
  const repo = String(repoPath || '').trim();
  return shippedPluginsWithoutReleaseFragment(repo, ref, changedPaths, (fragmentPath: string) => fs.existsSync(path.join(repo, fragmentPath)));
}

function missingDeliveredReleaseFragment(repoPath?: any, ref?: any, changedPaths?: any) {
  return shippedPluginsWithoutReleaseFragment(repoPath, ref, changedPaths, () => true);
}

function missingReleaseFragmentMessage(ref?: any, fragmentPath?: any, plugins?: any) {
  return `submit: refused ${ref}; submitted range changes shipped plugin paths (${plugins.map((plugin: any) => plugin.source).join(', ')}) but does not include ${fragmentPath}. Write the fragment, then commit it, then submit again. Next time write it BEFORE your first commit so it rides along:\n---\nref: ${ref}\ntitle: <short user-facing title>\nbump: patch\nplugins:\n${plugins.map((plugin: any) => `  - ${plugin.name}`).join('\n')}\n---\n\nDescribe the user-facing change.`;
}

// Only reachable when a dispatch exists and recording still failed. A directly-claimed ticket has no
// dispatch and therefore no baseline for the commit to drift from, so warning there would predict a
// refusal that cannot happen (SQ-2182).
function unrecordedSanctionedCommitWarning(reason?: any) {
  return `this commit was not recorded as sanctioned (${reason}), so further writes in this worktree may be refused until redispatch`;
}

function recordedDelivery(slug?: any, commit?: any, evidence?: any) {
  const requestedCommit = String(commit || '').trim();
  const recordedEvidence = String(evidence || '').trim();
  if (!DELIVERY_COMMIT_RE.test(requestedCommit)) {
    return { ok: false, reason: 'delivery_commit_required', message: 'A hand-delivered closure requires the full or abbreviated Git commit that reached the integration branch.' };
  }
  if (!recordedEvidence) return { ok: false, reason: 'evidence_required' };
  const repo = readMeta(slug)?.path;
  if (!repo) return { ok: false, reason: 'project_unavailable' };
  let target: any;
  try {
    target = integrationTarget(slug);
    const deliveredCommit = execFileSync('git', ['rev-parse', '--verify', `${requestedCommit}^{commit}`], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    }).trim();
    const targetCommit = integrationTargetCommit(repo, target);
    const integrationRevision = sourceRevision({
      source: `git:${target.upstream}`,
      value: targetCommit,
      observedAt: new Date().toISOString(),
    });
    if (!integrationRevision) throw new Error('could not record the current integration revision');
    execFileSync('git', ['merge-base', '--is-ancestor', deliveredCommit, integrationRevision.value], {
      cwd: repo,
      windowsHide: true,
      stdio: 'pipe',
    });
    return { ok: true, commit: deliveredCommit, target, integrationRevision, evidence: recordedEvidence };
  } catch (error: any) {
    return {
      ok: false,
      reason: 'delivery_not_reachable',
      message: `The recorded delivery commit is not reachable from the configured integration branch: ${String(error?.message || error).trim()}. For a submitted reset or working-tree delivery, record the pinned candidate with deliveryMethod reset, working-tree, or manual after its content is present in the integration working tree.`,
    };
  }
}

function pendingSubmissionDeliveryRefusal(ticket?: any, result?: any) {
  return Object.assign({}, result, {
    message: `${String(result?.message || `${ticket.ref} submission could not be recorded as delivered.`)} To discard this pending candidate instead, use groomClose with \`abandonSubmission: true\`; the board records it as abandoned.`,
  });
}

function clearUnclaimedDispatch(slug?: any, idOrRef?: any, opts?: any) {
  const by = String(opts?.by || '').trim();
  const agentId = String(opts?.agentId || '').trim();
  const agentName = String(opts?.agentName || '').trim();
  const evidence = String(opts?.evidence || '').trim();
  if (!by) return { ok: false, reason: 'identity_required' };
  if (!evidence) return { ok: false, reason: 'death_evidence_required', message: 'Clearing an unclaimed dispatch requires recorded terminal-agent evidence.' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const state = dispatchState(ticket);
    if (!ticket || !state || !ticket.dispatchNonce || state.terminalAt) {
      const outcome = String(state?.outcome || 'unknown').trim() || 'unknown';
      const pendingSubmissionGuidance = pendingSubmission(ticket)
        ? ` This ticket has a pending submission: use groomClose with deliveryCommit when the delivered commit preserves the candidate, or groomClose with abandonSubmission: true when it does not.`
        : '';
      return {
        ok: false,
        reason: 'no_unclaimed_dispatch',
        ticket,
        message: `${ticket?.ref || String(idOrRef)} has a terminal dispatch with observed outcome "${outcome}". recoveryEvidence does not apply to a terminal dispatch.${pendingSubmissionGuidance}`,
      };
    }
    if (ticket.claim?.by) return { ok: false, reason: 'claimed', ticket, claim: ticket.claim };
    if (agentId && String(state.agentId || '') !== agentId) return { ok: false, reason: 'dispatch_identity_mismatch', ticket };
    if (agentName && String(state.agentName || '') !== agentName) return { ok: false, reason: 'dispatch_identity_mismatch', ticket };
    const now = new Date().toISOString();
    setDispatchTerminal(ticket, 'failed', 'control-plane-death-recovery', {
      failureShape: 'observed_terminal_agent',
      deathEvidence: { by, agentId: agentId || state.agentId || null, agentName: agentName || state.agentName || null, evidence },
    });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    const previousStatus = ticket.status;
    if (!pendingSubmission(ticket)) ticket.status = 'todo';
    if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: now };
    stampDispatchEvent(ticket, 'control-plane-death-recovery', now);
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
    return { ok: true, ticket };
  });
}

function unconsumedPreparedDispatch(ticket?: any, state?: any) {
  return Boolean(
    ticket
    && state
    && state.outcome === 'prepared'
    && !state.terminalAt
    && !state.launchedAt
    && !state.boundAt
    && !state.claimedAt
    && !state.agentId
    && !(ticket.claim && ticket.claim.by)
    && !ticket.checkpoint
    && !pendingSubmission(ticket)
    && ticket.dispatchNonce,
  );
}

function abandonUnconsumedPreparedDispatchForGrooming(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    const state = dispatchState(ticket);
    if (!unconsumedPreparedDispatch(ticket, state)) return { ok: true, ticket, abandoned: false };
    setDispatchTerminal(ticket, 'abandoned', 'control-plane-grooming-prepared-abandonment', {
      slug,
      failureShape: 'unconsumed_prepared_dispatch_abandoned',
    });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    stampDispatchEvent(ticket, 'control-plane-grooming-prepared-abandonment');
    putTicket(slug, ticket);
    return { ok: true, ticket, abandoned: true };
  });
}

function completeTicketAsControlPlane(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const purpose = String(opts.purpose || '').trim();
  if (!['grooming', 'integration', 'delivery'].includes(purpose)) {
    throw new Error('control-plane completion requires purpose "grooming", "integration", or "delivery".');
  }
  let ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  if (purpose === 'grooming') {
    const abandoned = abandonUnconsumedPreparedDispatchForGrooming(slug, ticket.id);
    if (!abandoned.ok) return abandoned;
    ticket = abandoned.ticket;
  }
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
  }
  if (purpose === 'delivery') {
    if (ticket.claim?.by || ticket.dispatchNonce || (state && !state.terminalAt)) {
      return {
        ok: false,
        reason: 'active_dispatch',
        message: `${ticket.ref} still has a live claim or an open dispatch, so hand delivery cannot close it. Release it first: \`sidequest release ${ticket.ref} --by ${ticket.claim?.by ? String(ticket.claim.by) : '<claim holder>'}\`, then re-run this closure with the same evidence. Releasing does not discard work already committed.`,
        ticket,
      };
    }
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
  if (purpose === 'grooming' && pendingSubmission(ticket)) {
    let target: any;
    try {
      target = integrationTarget(slug);
    } catch (error: any) {
      return { ok: false, reason: 'integration_target_unavailable', ticket, message: String(error?.message || error) };
    }
    if (opts.abandonSubmission === true) {
      const abandoned = recordAbandonedSubmission(slug, idOrRef, { target, reason });
      if (!abandoned.ok) return abandoned;
    } else {
      const deliveredSubmission = recordDeliveredSubmission(slug, idOrRef, {
        target,
        deliveryCommit: ticket.submission?.commit,
        reason,
      });
      // Refusing without naming the abandonment path leaves grooming with no legal move for a
      // candidate that never landed, which is how these tickets pile up unclosable (SQ-2188). The
      // hint has to key on reachability rather than the refusal code: a stranded candidate is
      // refused for divergence long before the reachability check runs, and a candidate that did
      // land can be refused for reasons abandonment would not fix, like a pending candidate review.
      if (!deliveredSubmission.ok) {
        const landed = commitScope.submissionCommitReachedIntegrationBranch(readMeta(slug)?.path || '', ticket.submission || {}, target?.branch);
        return landed ? deliveredSubmission : Object.assign({}, deliveredSubmission, {
          message: `${String(deliveredSubmission.message || `${ticket.ref} submission could not be recorded as delivered.`)} Its candidate is not reachable from ${target?.branch || 'the integration branch'}, so if it never landed and no longer merges, close it as an abandoned submission instead: \`sidequest groom-close ${ticket.ref} --abandon-submission --reason "<evidence it never landed>"\` (MCP \`abandonSubmission: true\`).`,
        });
      }
    }
  }
  let reconciledDelivery: any = null;
  if (purpose === 'delivery' && pendingSubmission(ticket)) {
    let target: any;
    try {
      target = integrationTarget(slug);
    } catch (error: any) {
      return { ok: false, reason: 'integration_target_unavailable', ticket, message: String(error?.message || error) };
    }
    const recordedSubmission = recordDeliveredSubmission(slug, idOrRef, {
      target,
      deliveryCommit: opts.deliveryCommit,
      deliveryInteractionCommit: opts.deliveryInteractionCommit,
      deliveryMethod: opts.deliveryMethod,
      reason,
    });
    if (!recordedSubmission.ok) return pendingSubmissionDeliveryRefusal(ticket, recordedSubmission);
    const integration = recordedSubmission.integration;
    reconciledDelivery = {
      ok: true,
      commit: integration.deliveryCommit,
      target,
      integrationRevision: integration.deliveryRevision,
      integration,
      evidence: reason,
      identity: integration.deliveryIdentity,
    };
  }
  const delivery = purpose === 'delivery' ? reconciledDelivery || recordedDelivery(slug, opts.deliveryCommit, reason) : null;
  if (delivery && !delivery.ok) return Object.assign({ ticket }, delivery);
  const missingFragment = delivery ? missingDeliveredReleaseFragment(readMeta(slug)?.path, ticket.ref, commitPaths(readMeta(slug)?.path || '', delivery.commit)) : null;
  if (missingFragment) return {
    ok: false,
    reason: 'missing_release_fragment',
    message: missingReleaseFragmentMessage(ticket.ref, missingFragment.fragmentPath, missingFragment.plugins),
    ticket,
  };
  if (purpose === 'integration') {
    const admitted = validateIntegrationSubmission(slug, idOrRef, { requireDeliveredWave: true });
    if (!admitted.ok) return admitted;
  }
  const recorded = delivery;
  const advisory = purpose === 'integration' && ticket.highStakes && !recordedReviewPass(ticket) && !linkedReviewPass(slug, ticket)
    ? HIGH_STAKES_REVIEW_WARNING
    : null;
  const result = completeTicket(slug, idOrRef, by, Object.assign({}, opts, {
    body: reason,
    source: `control-plane-${purpose}`,
    completionAuthority: CONTROL_PLANE_COMPLETION,
    completionProvenance: Object.assign(
      { authority: 'control-plane', purpose, reason },
      recorded?.ok ? {
        delivery: {
          commit: recorded.commit,
          targetBranch: recorded.target.branch,
          targetRef: recorded.target.upstream,
          integrationRevision: recorded.integrationRevision,
          evidence: recorded.evidence,
          ...(recorded.identity ? { identity: recorded.identity } : {}),
        },
      } : {},
    ),
    ...(recorded?.ok ? { recordedDelivery: recorded } : {}),
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

const { sweepStaleDispatches, sweepStaleClaims } = createSweeps({
  addComment, claimAbandonMs, claimIdleMs, claimReleaseNote, claimReleaseVerdict, dispatchState, expiredPreparedDispatch, getTicket, listProjects, listTickets, migrateLegacyScopeRequest, preparedDispatchTtlMs, putTicket, releaseTicket, setDispatchTerminal, stampDispatchEvent, withTicketLock,
});

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
  updateTicket,
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
  updateStory,
} = stories;

projectsLayer = createProjects({
  acquireLock, assetsDir, claimReclaimable, cloneCached, database, db, defaultAlwaysInScope, defaultProjectName,
  deleteCachedRow, ensureDir, fs, invalidateStoreCaches, listStories, listTickets, normalizeForHash,
  path, projectDir, putProject, putStory, putTicket, releaseLock, residentCache, slugify, sourceRevisionAdapterForPath, ticketsDir, transaction,
});

warningsLayer = createWarnings({
  boardConfig, categoryReadOnly, claimReclaimable, coerceEffort, commitScope, contractCollisionReasons, dispatchReadOnly,
  dispatchState, execFileSync, fs, getTicket, integrationTarget, listTickets, normalizeContracts, normalizeFiles,
  normalizeRouteModel, overlappingScopePaths, path, pulseDispatchState, readMeta, readOnlyOverrideActive, spawnSync, ticketCategory,
});
DISPATCH_DESCRIPTION_MIN = warningsLayer.DISPATCH_DESCRIPTION_MIN;

const { boundedExcerpt, changesPayload, commentHistory, pulsePayload } = createPulse({
  boardConfig,
  checkpointProjection,
  claimPulse,
  claimIdleMs,
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
  projectDispatchAdmission,
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
  sessionProjectRoot,
  mainWorktreeRoot,
  projectDir,
  ensureProject,
  registerSourceRevisionCapability,
  sourceRevisionAdapterFacts,
  readMeta,
  boardConfig,
  setBoardConfig,
  integrationTarget,
  normalizeDeliveryMode,
  validateIntegrationSubmission,
  recordDeliveredSubmission,
  recordAbandonedSubmission,
  integrateSubmission,
  integrateSubmissionWave,
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
  submissionReviewRelation,
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
  recordDispatchWorktreeProvisioningFailure,
  recoverDispatchWorktreeCreation,
  bindDispatchAgent,
  dispatchIdentityDiagnosis,
  dispatchIsolationExpectation,
  dispatchUnboundClaim,
  recordSanctionedCommit,
  activeSharedTreeClaim,
  isolatedDispatchWithMissingWorktree,
  terminalDispatchTarget,
  terminalDispatchForIdle,
  markDispatchStopped,
  reconcileLaunchedDispatches,
  claimAdmission,
  bindClaimRuntimeIdentity,
  claimTicket,
  releaseTicket,
  completeTicket,
  workingTreeDeliveryCandidate,
  externalDeliverableCloseout,
  completeTicketAsControlPlane,
  missingReleaseFragment,
  missingDeliveredReleaseFragment,
  missingReleaseFragmentMessage,
  unrecordedSanctionedCommitWarning,
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
  recordVerificationCapture,
  recordSubmissionRejection,
  reconcileSubmissionRejections,
  reworkSubmission,
  clearSubmission,
  assembleSubmissionWave,
  recordSubmissionWaveDelivery,
  pendingSubmission,
  submissionReadiness,
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
  claimMaySubmit,
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
  sessionClaims,
};
