'use strict';

const { canonicalPreparedDispatchExecutor, normalizePreparedDispatch } = require('../prepared-dispatch.js');
const { classifyVerificationKind, verificationRequirement } = require('../kernel/verification.js');
const { resolveSuite } = require('../suite-resolver.js');
const { reviewCandidateFromSubmission, sameReviewCandidate, reviewRelationFor, reviewRelationOutcome } = require('../kernel/review-binding');
const { compareSemver } = require('../plugin-freshness.js');
const { WHOLE_TREE_SCOPE } = require('../commit-scope.js');
const { compositionCheckoutCommit, consumePreparedComposition, consumedAdmissionRefusal } = require('./composition-admission.js');
import type { CompositionDispatch, CompositionTicket } from './composition-admission';
import type { VerificationRequirement } from '../kernel/verification';

type NativeCheckoutCreation = CompositionDispatch & {
  sessionId?: string | null; worktreeBindingSource?: string;
  worktreeCommonGitDirectory?: string; worktreeObservedRevision?: string;
  worktreeCreationCompletedAt?: string; worktreeBoundAt?: string; agentId?: string;
};
type NativeCheckoutBindingRequest = { sessionId: string; worktree: string; repository: string; attempt: string; checkoutAgentId: string };
type NativeCheckoutBinding = {
  ok: true; ref: string; attempt: string; baseline: string; repository: string; worktree: string;
  creationCompleted?: boolean; expectedGitDirectory?: string | null; expectedCommonGitDirectory?: string | null;
  expectedCheckoutInstance?: string | null; expectedRevision?: string | null;
};
type NativeCheckoutBindingResult = NativeCheckoutBinding | { ok: false; reason: string };
type NativeCheckoutFacts = {
  gitDirectory: string; commonGitDirectory: string; checkoutInstance: string; revision: string;
};
type NativeCheckoutCompletion = { ok: true; alreadyCompleted: boolean } | { ok: false; reason: string };
// Git output read before the write transaction; checkoutStatus is null when git could not report it.
type ObservedNativeCheckout = { facts: NativeCheckoutFacts | null; checkoutStatus?: string | null };

function unscopedWriteCannotAutoApprove(ticket?: any, options?: any) {
  const { dispatchReadOnly, normalizeFiles, autoApproveScope } = options;
  return !dispatchReadOnly(ticket)
    && !normalizeFiles(ticket?.files).length
    && (!Array.isArray(autoApproveScope) || !autoApproveScope.length);
}

function undeclaredWriteScopeRefusal(ref: string) {
  return `prepare dispatch: ${ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to give the executor the whole tree as its write scope (isolated worktree only).`;
}

// GH-341: an unscoped dispatch used to bind only the board's alwaysInScope paths, so
// the executor silently got docs/ and nothing else. Board paths ride beside the whole
// tree; they never stand in for it.
function unscopedWriteScopeLine(alwaysInScope: unknown) {
  const boardPaths = Array.isArray(alwaysInScope) ? alwaysInScope : [];
  return `write scope: unscoped (whole tree)${boardPaths.length ? `, always-in-scope: ${boardPaths.join(', ')}` : ''}`;
}

// A whole-tree commit in the shared checkout would sweep every other dirty path into
// this ticket, so the refusal comes before the work instead of at submit.
function unscopedSharedTreeRefusal(ref: string, boardPaths: readonly string[]) {
  const boardOnly = boardPaths.length ? ` Board policy alone would give it only ${boardPaths.join(', ')}.` : '';
  return `prepare dispatch: ${ref} has no declared file scope and would run in the shared checkout, where an unscoped (whole tree) write scope would commit every dirty path in it.${boardOnly} Declare the paths it needs (\`sidequest update ${ref} --file <path>\`), or dispatch it into an isolated worktree.`;
}

function namedSuiteForTicket(ticket: any, projectPath: string) {
  const directories = new Set(
    (Array.isArray(ticket?.files) ? ticket.files : [])
      .map((file: unknown) => /^plugins\/([^/]+)(?:\/|$)/.exec(String(file || '').replace(/\\/g, '/'))?.[1])
      .filter(Boolean),
  );
  if (!projectPath || directories.size !== 1) return null;
  const name = [...directories][0];
  const resolved = resolveSuite(projectPath, { name, dir: `plugins/${name}` });
  return resolved
    ? { name: resolved.plugin, cwd: resolved.cwd, setup: resolved.setup, command: resolved.command }
    : null;
}

function preparedVerificationRequirement(ticket: any, projectPath: string) {
  const recorded = String(ticket?.executorVerify || '').trim();
  const declaredKind = String(ticket?.executorVerifyKind || 'command').trim().toLowerCase();
  const artifact = String(ticket?.executorAttestationArtifact || '').trim();
  const suite = !recorded || declaredKind === 'suite' ? namedSuiteForTicket(ticket, projectPath) : null;
  const attestation = declaredKind === 'attestation' && Boolean(artifact);
  const legacyWithoutVerifier = !recorded && !suite && !attestation;
  const kind = legacyWithoutVerifier ? 'custom' : classifyVerificationKind(recorded, declaredKind);
  return verificationRequirement({
    kind,
    evidence: legacyWithoutVerifier ? 'legacy project verifier was not recorded' : recorded || artifact || undefined,
    command: ['suite', 'command'].includes(kind) ? recorded || undefined : undefined,
    artifact: ticket?.executorAttestationArtifact,
    suite,
  });
}

function requirementsMatch(left: any, right: any) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function liveVerificationRequirement(state: any, ticket: any): VerificationRequirement | undefined {
  return state.verificationRequirement || state.lifecycleAttempt?.verificationRequirement || ticket.lifecycleAttempt?.verificationRequirement;
}

function applyLiveVerificationRequirement(state: any, ticket: any, requirement: VerificationRequirement) {
  state.verificationRequirement = requirement;
  const attempt = state.lifecycleAttempt || ticket.lifecycleAttempt;
  if (!attempt) return;
  const refreshedAttempt = Object.freeze({ ...attempt, verificationRequirement: requirement });
  state.lifecycleAttempt = refreshedAttempt;
  ticket.lifecycleAttempt = refreshedAttempt;
}

function trimmedOrNull(value: unknown) {
  return String(value || '').trim() || null;
}

function recordVerificationAmendment(ticket: any, amendment: any, previousRequirement: VerificationRequirement | undefined, nextRequirement: VerificationRequirement) {
  const record = Object.freeze({
    at: new Date().toISOString(),
    by: trimmedOrNull(amendment?.by),
    oldCommand: trimmedOrNull(previousRequirement?.command),
    newCommand: trimmedOrNull(nextRequirement.command),
  });
  ticket.verificationAmendments = [...(Array.isArray(ticket.verificationAmendments) ? ticket.verificationAmendments : []), record].slice(-20);
  return record;
}

// Only an isolated command|suite dispatch defers its verifier to the shared checkout; a
// board left at the default pins nothing, so its requirements stay byte-identical.
function pinnedVerificationRequirement(ticket: any, projectPath: string, verifyEnvironment: unknown, sharedTree: boolean) {
  const requirement = preparedVerificationRequirement(ticket, projectPath);
  const deferred = !sharedTree && verifyEnvironment === 'shared' && ['command', 'suite'].includes(requirement.kind);
  return deferred ? Object.freeze({ ...requirement, environment: 'shared' as const }) : requirement;
}

function createDispatch(dependencies: any) {
  const { ARTIFACT_BASELINE_MAX_PATHS, SHARED_TREE_ARTIFACT_MARKER, assertDispatchTransport, assertSidequestInstall, checkSidequestInstall, servingInstall, prepareAttempt, transitionAttempt, attemptDiagnostic, ensurePythonIoEncoding, localAheadOfUpstreamWarning, availableRoute, boardConfig, claimGraceMs, claimIdleMs, claimReclaimable, claimVerification, classifyDispatchFailure, terminalAgentFailure, commitScope, crypto, database, db, dispatchReadOnly, dispatchFilesystemSnapshotPreflight, dispatchBaselineForProject, dispatchVerifyCommandError, dispatchRouteRefusal, dispatchRouteState, effectiveScope, execFileSync, execProjection, fs, getCategory, getStory, homeRoot, integrationTarget, integrationTargetCommit, legacyCategoryForComplexity, listProjects, listTickets, nonRepoExternalOutput, normalizeArtifactRoots, normalizeFiles, normalizeRoute, normalizeWorktreeIsolation, path, hasOriginRemote, pendingSubmission, agentWorktreePath, agentWorktreeCandidates, agentIdFromWorktreePath, resolvedAgentWorktree, preparedDispatchTtlMs, putTicket, readMeta, releaseTerminalClaim, resolveCategoryFallback, resolveCategoryRoute, resolveTicketRoute, resolveExec, stableExecutorName, staleWorktreeCwdWarning, storyExecutionContract, takeSourceRevisionAdapterSwitch, ticketCategory, ticketStorageRow, withTicketLock, normalizeCategoryId, projectRoutingEnabled, routingDisabledMessage, getTicket, dispatchLaunchName, nextDispatchLaunchSeq, spawnDescription, claudeQuotaFailure, canonicalPath, checkoutInstanceIdentity, createWorktreeLease, worktreeResumeDecision, isCanonicalRegisteredWorktree, withTicketLocks, withTicketFileLocks, guardedTransaction, ticketGenerations, changedTicketSince, unclaimedDispatchWorktreeReclaim } = dependencies;

  function boardVerificationRequirement(slug: string, ticket: any, sharedTree: boolean) {
    return pinnedVerificationRequirement(ticket, String(readMeta(slug)?.path || ''), boardConfig(slug)?.verifyEnvironment, sharedTree);
  }

  function syncLiveDispatchVerification(slug?: any, ticket?: any, amendment?: any) {
    const state = dispatchState(ticket);
    if (!state || state.terminalAt) return null;
    const previousRequirement = liveVerificationRequirement(state, ticket);
    const nextRequirement = boardVerificationRequirement(slug, ticket, state.sharedTree === true);
    if (requirementsMatch(previousRequirement, nextRequirement)) return null;
    applyLiveVerificationRequirement(state, ticket, nextRequirement);
    return recordVerificationAmendment(ticket, amendment, previousRequirement, nextRequirement);
  }

const DISPATCH_TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const DISPATCH_TOKEN_CHARS = 32;
const DISPATCH_TOKEN_GROUP_SIZE = 4;

function normalizeDispatchToken(token?: any) {
  return String(token || '').replace(/[\s-]/g, '').toLowerCase();
}

function dispatchTokenMatches(expected?: any, received?: any) {
  const expectedToken = normalizeDispatchToken(expected);
  const receivedToken = normalizeDispatchToken(received);
  if (!expectedToken || expectedToken.length !== receivedToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(receivedToken));
}

function mintDispatchToken() {
  let token = '';
  while (token.length < DISPATCH_TOKEN_CHARS) {
    for (const byte of crypto.randomBytes(DISPATCH_TOKEN_CHARS)) {
      if (byte >= 248) continue;
      token += DISPATCH_TOKEN_ALPHABET[byte % DISPATCH_TOKEN_ALPHABET.length];
      if (token.length === DISPATCH_TOKEN_CHARS) break;
    }
  }
  return token.match(new RegExp(`.{1,${DISPATCH_TOKEN_GROUP_SIZE}}`, 'g'))?.join('-') || token;
}

function dispatchTokenPrefix(token?: any) {
  return token ? String(token).slice(0, 12) : null;
}

function dispatchTokenFile(ticket?: any) {
  return typeof ticket?.dispatch?.tokenFile === 'string' ? ticket.dispatch.tokenFile : null;
}

function newDispatchTokenFile() {
  return path.join(homeRoot(), 'dispatch-tokens', `${crypto.randomUUID()}.token`);
}

function ticketEvidenceDirectory(slug?: any, ref?: any, projectPath?: any) {
  const safeSlug = String(slug || 'project').replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeRef = String(ref || 'ticket').replace(/[^a-zA-Z0-9._-]/g, '_');
  const directory = path.resolve(homeRoot(), 'projects', safeSlug, 'verification', safeRef);
  const repository = String(projectPath || '').trim();
  if (!repository) return directory;
  const relative = path.relative(path.resolve(repository), directory);
  const insideRepository = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  return insideRepository
    ? path.join(path.dirname(path.resolve(repository)), '.sidequest-verification', safeSlug, safeRef)
    : directory;
}

// Board-owned verification evidence is not repository content: dispatch creates the directory above,
// the briefing sends executors there, and on a machine that keeps ~/.claude in a dotfiles repository
// the whole subtree sits inside a Git checkout no dispatch holds a lease for. A write lease answers
// for a repository, so letting the isolation guard resolve that enclosing checkout refused the board's
// own directory while the same write through Bash, which no hook gates, went through (GH-163).
//
// The exemption is keyed to the caller's own resolved dispatch rather than to a path shape. A shape
// match on `projects/<anything>/verification/**` cannot tell a registered ticket's directory from an
// invented slug, and it cannot recognize ticketEvidenceDirectory's relocated form at all, since that
// form lands beside the project repository rather than under the home. Comparing against the
// evidenceDirectory the store actually recorded for the matched dispatch answers both at once: only
// that one directory, wherever prepareDispatch resolved it to, is exempt.
//
// A dedicated lookup rather than a field folded into dispatchIsolationExpectation: that function
// already scans every project and ticket to answer a much bigger question (worktree and lease facts
// for every candidate dispatch), and this only ever needs one ticket's recorded directory once the
// guard already knows which dispatch it is asking about.
function dispatchEvidenceDirectory(project?: any, ref?: any) {
  const state = dispatchState(getTicket(project, ref));
  return state && state.evidenceDirectory ? String(state.evidenceDirectory) : null;
}

function segmentsUnder(root: string, target: string): string[] {
  const relative = path.relative(canonicalPath(root), canonicalPath(path.resolve(target))).replace(/\\/g, '/');
  // path.relative returns exactly '..' (no trailing slash) for root's immediate parent, so matching
  // only the '../' prefix let that one directory - here, the verification directory itself, one level
  // above any ticket's evidence directory - through as if it were nested inside root.
  const outside = !relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
  return outside ? [] : relative.split('/');
}

function trimmedString(value?: any): string {
  return String(value || '').trim();
}

// `canonicalPath` realpaths only the longest existing prefix, so a symlink at the final path
// component that does not resolve to anything yet stays unresolved and containment above would follow
// it out of the evidence directory once the write actually creates something there. Refusing whenever
// the requested path is itself a symlink, dangling or not, closes that; a live symlink pointing outside
// the directory was already refused by the containment check.
function boardVerificationEvidencePath(target?: any, evidenceDirectory?: any) {
  const requested = trimmedString(target);
  const root = trimmedString(evidenceDirectory);
  if (!requested || !root) return false;
  try {
    if (fs.lstatSync(requested).isSymbolicLink()) return false;
  } catch (_) {
    // Not there yet: the common case is exactly the write that will create it.
  }
  return segmentsUnder(root, requested).length > 0;
}

function writeDispatchTokenFile(ticket?: any) {
  const file = dispatchTokenFile(ticket);
  if (!file) throw new Error('dispatch token file is unavailable');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${ticket.dispatchNonce}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function removeDispatchTokenFile(ticket?: any) {
  const file = dispatchTokenFile(ticket);
  if (!file) return;
  try { fs.unlinkSync(file); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

function dispatchTokenFromFile(file?: any) {
  const tokenFile = String(file || '').trim();
  if (!tokenFile) return null;
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return token && !/[\r\n]/.test(token) ? token : null;
  } catch (_) {
    return null;
  }
}

function dispatchTokenForRequest(token?: any, tokenFile?: any) {
  return token == null || token === '' ? dispatchTokenFromFile(tokenFile) : token;
}

function dispatchState(ticket?: any) {
  return ticket && ticket.dispatch && typeof ticket.dispatch === 'object' ? ticket.dispatch : null;
}

// Revalidated at every dispatch, never trusted from the stored binding alone:
// the review only launches against the exact candidate that is still bound,
// still terminal, and still resolvable as one immutable commit.
function reviewDispatchTarget(slug?: any, ticket?: any) {
  const target = ticket?.reviewTarget;
  if (!target) return null;
  if (String(ticketCategory(ticket) || '').trim().toLowerCase() !== 'review-audit') {
    throw new Error(`prepare dispatch: ${ticket.ref} carries a reviewTarget outside category review-audit.`);
  }
  if (!target.ticketId || !target.ref || !target.candidate?.source || !target.candidate.value) {
    throw new Error(`prepare dispatch: ${ticket.ref} has an incomplete reviewTarget; rebind it through add or update.`);
  }
  const sourceTicket = getTicket(slug, target.ticketId);
  if (!sourceTicket || sourceTicket.ref !== target.ref) {
    throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${target.ref} no longer resolves to its source ticket.`);
  }
  if (sourceTicket.claim?.by) {
    throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${sourceTicket.ref} is live-claimed by ${sourceTicket.claim.by}.`);
  }
  const submission = sourceTicket.submission;
  const sourceDispatch = dispatchState(sourceTicket);
  const terminal = Boolean(
    (sourceDispatch?.terminalAt && sourceDispatch.outcome === 'submitted')
    || sourceTicket.lifecycleAttempt?.state === 'submitted',
  );
  if (!terminal || !submission || submission.integratedAt) {
    throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${sourceTicket.ref} is not a pending terminal submission.`);
  }
  const candidate = reviewCandidateFromSubmission(submission);
  if (!sameReviewCandidate(candidate, target.candidate)) {
    throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${sourceTicket.ref} no longer matches its exact submitted candidate.`);
  }
  const relation = reviewRelationFor(sourceTicket, listTickets(slug), (idOrRef: string) => getTicket(slug, idOrRef));
  if (!relation || relation.conflict || relation.reviewTicket?.id !== ticket.id) {
    throw new Error(`prepare dispatch: ${ticket.ref} is not the sole authoritative review bound to ${sourceTicket.ref}.`);
  }
  if (reviewRelationOutcome(relation) === 'rejected') {
    throw new Error(`prepare dispatch: ${ticket.ref} candidate was permanently rejected; repair needs fresh ticket, attempt, candidate, and review identities.`);
  }
  if (candidate.source === 'git') {
    let resolved = '';
    try {
      resolved = execFileSync('git', ['rev-parse', '--verify', `${candidate.value}^{commit}`], {
        cwd: String(readMeta(slug)?.path || '').trim(),
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().toLowerCase();
    } catch (_: any) {
      throw new Error(`prepare dispatch: ${ticket.ref} candidate commit ${candidate.value} is unavailable in this checkout.`);
    }
    if (resolved !== candidate.value) {
      throw new Error(`prepare dispatch: ${ticket.ref} candidate must be the full immutable commit ${resolved}.`);
    }
  }
  return { sourceTicket, submission, candidate };
}

function executorClaimDispatchRefusal(slug?: any, sessionId?: any) {
  const callerSessionId = String(sessionId || '').trim();
  if (!callerSessionId) return null;
  for (const ticket of listTickets(slug)) {
    const state = dispatchState(ticket);
    const dispatchingSessionId = String(state?.preparedBy?.sessionId || '').trim();
    if (!ticket?.claim?.by || !state || state.terminalAt || state.sessionId !== callerSessionId || dispatchingSessionId === callerSessionId || claimReclaimable(ticket)) continue;
    return `dispatch: refused while you hold ${ticket.ref}. Executors cannot dispatch child tickets. Record the follow-up on ${ticket.ref}; the orchestration session must dispatch it.`;
  }
  return null;
}

function sharedTreeRuntimeRefusal(ticket?: any, projectPath?: any, runtimeCwd?: any) {
  if (!runtimeCwd || !staleWorktreeCwdWarning(runtimeCwd, projectPath, true)) return null;
  return `prepare dispatch: refused ${ticket.ref}; sharedTree:true requires the spawning runtime to be rooted in the declared project checkout. This runtime is an isolated linked worktree. Record the follow-up on the owning ticket; the orchestration session must dispatch it.`;
}

function repositoryIdentity(cwd?: any) {
  try {
    const value = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: String(cwd), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return canonicalPath(path.isAbsolute(value) ? value : path.resolve(String(cwd), value));
  } catch (_) {
    return null;
  }
}

// An isolated dispatch is created by the spawning session's WorktreeCreate hook.
// That hook follows the session id to the board that reserved the creation, so a
// sibling project's ticket does get a worktree cut from its own repository. It
// cannot tell WHICH ticket it is creating for, though, so while this session owns
// launched isolated dispatches on more than one board it falls back to the
// spawning checkout, the lease never binds, and the executor dies before it
// starts (SQ-2570, SQ-2884). Refuse that case while the caller can still wait or
// choose sharedTree. Linked worktrees of the project share its common git dir, so
// they are NOT a mismatch; that case is the existing stale-cwd warning's. A runtime
// outside any repository is a mismatch too: the hook has no checkout to fall back
// to there, so it would crash after the launch was recorded (GH-269).
function runtimeOutsideProjectRepository(projectPath?: any, runtimeCwd?: any) {
  if (!runtimeCwd || !projectPath) return false;
  const project = repositoryIdentity(projectPath);
  return Boolean(project) && project !== repositoryIdentity(runtimeCwd);
}

function isolatedTreeRuntimeRefusal(ticket?: any, projectPath?: any, runtimeCwd?: any, slug?: any, sessionId?: any) {
  if (!runtimeOutsideProjectRepository(projectPath, runtimeCwd)) return null;
  const competing = launchedIsolatedSessionProjects(String(sessionId || '').trim(), slug);
  if (!competing.length) return null;
  return `prepare dispatch: refused ${ticket.ref}; its project ${projectPath} is a different repository from this session's checkout ${runtimeCwd}, and this session already owns launched isolated dispatches on another board (${competing.map((entry: any) => entry.path).join(', ')}). WorktreeCreate follows the session id to one board, so with several live it cannot tell which ticket it is creating for and would cut this worktree from the wrong repository. Dispatch ${ticket.ref} once those are terminal, leaving ${projectPath} as this session's only isolated board. sharedTree:true stays available but runs the executor and its commit in ${runtimeCwd}; only its verification is redirected to ${projectPath}.`;
}

function dispatchPreparationAttribution(opts?: any) {
  return {
    sessionId: opts?.sessionId ? String(opts.sessionId) : null,
    surface: String(opts?.source || opts?.transport || 'store'),
  };
}

function sharedTreeArtifactRequested(ticket?: any) {
  return String(ticket && ticket.description || '')
    .split(/\r?\n/)
    .some((line) => line.trim() === SHARED_TREE_ARTIFACT_MARKER);
}

function categoryArtifactRoot(category?: any, scope?: any) {
  const normalizedScope = commitScope.scopedPaths([scope]);
  if (normalizedScope.length !== 1 || !commitScope.validateRelativeScopes(normalizedScope).ok) return null;
  const roots = normalizeArtifactRoots(category && category.artifactRoots);
  return roots.find((root?: any) => commitScope.isInScope(normalizedScope[0], [root])) || null;
}

function sharedTreeArtifactMode(ticket?: any) {
  const state = dispatchState(ticket);
  return Boolean(state
    && state.sharedTree === true
    && state.artifactMode === true
    && typeof state.artifactRoot === 'string'
    && state.artifactRoot
    && typeof state.artifactScope === 'string'
    && state.artifactScope);
}

function dirtyPathKey(file?: any) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function artifactPathIdentity(root?: any, file?: any) {
  const absolute = path.resolve(root, file);
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error: any) {
    if (error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
  let kind = 'other';
  if (stat.isFile()) kind = 'file';
  else if (stat.isSymbolicLink()) kind = 'symlink';
  else if (stat.isDirectory()) kind = 'directory';
  let content = null;
  if (kind === 'file' || kind === 'symlink') {
    content = execFileSync('git', ['hash-object', '--no-filters', '--', file], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  }
  return [kind, stat.mode, stat.size, stat.dev, stat.ino, content].map((value) => String(value == null ? '' : value)).join(':');
}

class DirtyBaselinePathCapError extends Error {
  pathCount: number;

  constructor(pathCount: number) {
    super(`artifact dirty baseline has ${pathCount} paths, over the ${ARTIFACT_BASELINE_MAX_PATHS}-path cap`);
    this.name = 'DirtyBaselinePathCapError';
    this.pathCount = pathCount;
  }
}

function artifactIndexStates(root: string, files: string[]) {
  const indexStates = new Map<string, string>();
  const uniqueFiles = Array.from(new Set(files));
  const batchSize = 250;
  for (let offset = 0; offset < uniqueFiles.length; offset += batchSize) {
    const output = execFileSync('git', ['ls-files', '--stage', '-z', '--', ...uniqueFiles.slice(offset, offset + batchSize)], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const entry of output.split('\0')) {
      if (!entry) continue;
      const separator = entry.indexOf('\t');
      if (separator < 0) continue;
      const file = entry.slice(separator + 1).replace(/\\/g, '/');
      const key = dirtyPathKey(file);
      indexStates.set(key, `${indexStates.get(key) || ''}${entry}\0`);
    }
  }
  return indexStates;
}

function artifactWorkingState(slug?: any, options?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error('the board project path is unavailable');
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: meta.path,
    encoding: 'utf8',
    windowsHide: true,
  });
  const raw = output.split('\0');
  const states: any[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3).replace(/\\/g, '/');
    if (file) states.push({ file, status });
    if (status.includes('R') || status.includes('C')) {
      const previous = raw[++index];
      if (previous) states.push({ file: previous.replace(/\\/g, '/'), status: `${status}:source` });
    }
  }
  if (options?.allowLarge !== true && states.length > ARTIFACT_BASELINE_MAX_PATHS) {
    throw new DirtyBaselinePathCapError(states.length);
  }
  const indexStates = artifactIndexStates(meta.path, states.map((entry) => entry.file));
  return states
    .map((entry) => {
      const identity = crypto.createHash('sha256')
        .update(JSON.stringify({
          status: entry.status,
          index: indexStates.get(dirtyPathKey(entry.file)) || '',
          worktree: artifactPathIdentity(meta.path, entry.file),
        }))
        .digest('hex');
      return { path: entry.file, identity };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

// A shared tree is the user's own checkout, so it can already hold work that has
// nothing to do with this run: a stray screenshot, a half-finished edit. Recording
// what was dirty before launch lets the submit gate separate the paths an executor
// touched from the ones it inherited, instead of blocking on someone else's file
// (contractify SQ-95, 2026-08-05). Unrecordable means no exemption, never a refused
// dispatch.
function captureDirtyBaseline(slug?: any) {
  try {
    return { baseline: artifactWorkingState(slug), warning: null };
  } catch (error: any) {
    if (error instanceof DirtyBaselinePathCapError) {
      return {
        baseline: null,
        warning: `dirty baseline has ${error.pathCount} paths, over the ${ARTIFACT_BASELINE_MAX_PATHS}-path cap; no inherited-path exemption for this dispatch`,
      };
    }
    const detail = String(error?.stderr || error?.message || error).trim();
    return {
      baseline: null,
      warning: `dirty baseline could not be recorded: ${detail}; no inherited-path exemption for this dispatch`,
    };
  }
}

function postDispatchWorkingState(slug?: any, state?: any) {
  const baselineEntries = Array.isArray(state?.dirtyBaseline)
    ? state.dirtyBaseline
    : Array.isArray(state?.workingTreeDirtyBaseline)
      ? state.workingTreeDirtyBaseline
      : null;
  if (!baselineEntries) {
    return {
      working: commitScope.workingPaths(readMeta(slug)?.path || ''),
      preExisting: [],
      baselineRecorded: false,
    };
  }
  const baselineByPath = new Map(baselineEntries.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const currentEntries = artifactWorkingState(slug, { allowLarge: true });
  const currentByPath = new Map(currentEntries.map((entry: any) => [dirtyPathKey(entry.path), entry]));
  const working = new Set<string>();
  const preExisting = new Set<string>();
  for (const entry of baselineEntries) {
    const currentEntry: any = currentByPath.get(dirtyPathKey(entry.path));
    if (currentEntry?.identity === entry.identity) preExisting.add(entry.path);
    else working.add(entry.path);
  }
  for (const entry of currentEntries) {
    const baselineEntry: any = baselineByPath.get(dirtyPathKey(entry.path));
    if (!baselineEntry || baselineEntry.identity !== entry.identity) working.add(entry.path);
  }
  return {
    working: Array.from(working).sort(),
    preExisting: Array.from(preExisting).sort(),
    baselineRecorded: true,
  };
}

function captureArtifactBaseline(slug?: any, scope?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) throw new Error('prepare dispatch: shared-tree artifact mode requires a board project path.');
  const resolution = commitScope.validateScopeResolution(meta.path, [scope], { inspectDescendants: true });
  if (!resolution.ok) {
    const rejected = (resolution.indirect && resolution.indirect.length ? resolution.indirect : resolution.outside).join(', ');
    throw new Error(`prepare dispatch: artifact scope must be a direct path inside the board project: ${rejected}`);
  }
  try {
    return artifactWorkingState(slug);
  } catch (error: any) {
    const detail = error && error.message ? ` ${error.message}` : '';
    throw new Error(`prepare dispatch: shared-tree artifact mode requires a readable Git working tree.${detail}`);
  }
}

function artifactScopeCheck(slug?: any, ticket?: any, state?: any) {
  if (!Array.isArray(state.artifactDirtyBaseline)
    || state.artifactDirtyBaseline.some((entry?: any) => !entry || typeof entry.path !== 'string' || typeof entry.identity !== 'string')) {
    return {
      ok: false,
      reason: 'artifact_baseline_missing',
      message: `${ticket.ref} has no content-aware dispatch-time dirty baseline. Release it and dispatch again before closing the artifact.`,
    };
  }
  const approvedRoot = categoryArtifactRoot({ artifactRoots: [state.artifactRoot] }, state.artifactScope);
  if (!approvedRoot) {
    return {
      ok: false,
      reason: 'artifact_scope_violation',
      message: `${ticket.ref} artifact scope is outside its dispatch-time approved root. Release it and dispatch again.`,
    };
  }
  const meta = readMeta(slug);
  const resolution = meta && meta.path
    ? commitScope.validateScopeResolution(meta.path, [state.artifactScope], { inspectDescendants: true })
    : { ok: false, reason: 'scope_unavailable', indirect: [] };
  if (!resolution.ok) {
    const indirection = resolution.reason === 'filesystem_indirection';
    return {
      ok: false,
      reason: indirection ? 'artifact_scope_indirection' : 'artifact_scope_unavailable',
      message: indirection
        ? `${ticket.ref} artifact scope contains filesystem indirection: ${resolution.indirect.join(', ')}. Replace it with direct in-project paths or release the ticket.`
        : `${ticket.ref} cannot resolve the shared-tree artifact scope directly inside the project. Release it and dispatch again.`,
      ...(indirection ? { indirectPaths: resolution.indirect } : {}),
    };
  }
  let current: any[];
  try {
    current = artifactWorkingState(slug);
  } catch (_: any) {
    return {
      ok: false,
      reason: 'artifact_scope_unavailable',
      message: `${ticket.ref} cannot verify the shared-tree artifact scope. Release it and dispatch again from a readable Git working tree.`,
    };
  }
  const baseline = new Map(state.artifactDirtyBaseline.map((entry?: any) => [dirtyPathKey(entry.path), entry]));
  const currentByPath = new Map(current.map((entry?: any) => [dirtyPathKey(entry.path), entry]));
  const changed = new Set<string>();
  for (const entry of state.artifactDirtyBaseline) {
    if (commitScope.isInScope(entry.path, [state.artifactScope])) continue;
    const now: any = currentByPath.get(dirtyPathKey(entry.path));
    if (!now || now.identity !== entry.identity) changed.add(entry.path);
  }
  for (const entry of current) {
    if (!baseline.has(dirtyPathKey(entry.path)) && !commitScope.isInScope(entry.path, [state.artifactScope])) changed.add(entry.path);
  }
  const outside = Array.from(changed).sort();
  if (!outside.length) return { ok: true };
  return {
    ok: false,
    reason: 'artifact_scope_violation',
    message: `${ticket.ref} changed paths outside artifact scope ${state.artifactScope}: ${outside.join(', ')}. Revert those changes or release the ticket instead of closing it.`,
    unscopedPaths: outside,
  };
}

function activeDispatchRoute(ticket?: any) {
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket.dispatchNonce) return null;
  return normalizeRoute(state.route);
}

function rederiveUnlaunchedPreparedRoute(ticket?: any, project?: any) {
  const state = dispatchState(ticket);
  if (!state || state.recovery || state.terminalAt || state.outcome !== 'prepared' || state.launchedAt || state.boundAt || state.claimedAt || !ticket.dispatchNonce) return;
  let requestedCategory = ticketCategory(ticket);
  if (requestedCategory == null && ticket.complexity != null) requestedCategory = legacyCategoryForComplexity(ticket.complexity);
  let category = requestedCategory == null ? null : getCategory(requestedCategory, { project });
  if (!category || !category.enabled) category = getCategory('general', { project });
  if (!category) return;
  const resolved = resolveTicketRoute(ticket, category);
  ticket.model = resolved.model;
  ticket.effort = resolved.effort;
  ticket.exec = execProjection(resolved.exec);
}

function stampDispatchEvent(ticket?: any, source?: any, now?: any) {
  ticket.lastEventType = 'dispatch';
  ticket.lastEventSource = source || 'store';
  ticket.updatedAt = now || new Date().toISOString();
}

function pulseDispatchState(state?: any) {
  if (!state) return null;
  if (state.terminalAt) return state.outcome || 'terminal';
  if (state.claimedAt) return 'claimed';
  if (state.boundAt) return 'bound';
  if (state.launchedAt) return 'launched';
  return state.outcome || 'prepared';
}

// A spawn that never started leaves the same empty record as one that started and never claimed: a token,
// no runtime identity, no claim, no checkpoint. Both are retirable on evidence, so `prepared` belongs here
// next to `launched`. Before SQ-2136 only `launched` did, and a prepared-unbound attempt was refused with a
// message asserting it was bound, claimed, checkpointed, or terminal when it was none of those.
const PRE_RUNTIME_DISPATCH_OUTCOMES = new Set(['prepared', 'launched']);

// Every dispatch-state timestamp a RUNTIME can produce before its first claim, newest wins; the eighth
// signal is its own board writes, which live on the ticket rather than here. Measuring the
// grace from `boundAt` alone retired executors that were demonstrably alive: SubagentStart stamps it
// before the model's first turn, so a slow gateway turn, a briefing fetch, or a pre-claim skill load all
// happen inside a window that counted as silence (SQ-2932 finding 1). `preparedAt` is deliberately absent:
// it is the board stamping its own token, not a runtime saying anything, and an attempt that produced none
// of these has nothing alive to protect.
const PRE_CLAIM_RUNTIME_SIGNALS: ReadonlyArray<readonly [string, string]> = [
  ['launchedAt', 'launch recorded'],
  ['worktreeBoundAt', 'worktree creation started'],
  ['worktreeCreationCompletedAt', 'worktree checkout recorded'],
  ['worktreeProvisionedAt', 'worktree provisioning finished'],
  ['boundAt', 'runtime bound'],
  ['briefedAt', 'briefing fetched'],
  ['claimedAt', 'claim recorded'],
];

// The eighth signal, and the only one the runtime produces with its own hands instead of a hook: a board
// write. Two bound-unclaimed executors were posting comments while all seven stamps were two hours old, and
// retireOnly and groomClose retired both mid-write (SQ-2953 finding 2).
//
// The launcher session is the trust boundary, and on its own it is far too wide: fan-out siblings and the
// orchestrator all write on that one session, and the MCP transport carries no per-agent identity, so
// matching the session alone let the orchestrator's own progress comments hold a dead attempt open forever
// (SQ-2959 finding 1). So a comment speaks for the runtime only when it arrived on the launcher session the
// dispatch recorded, on this attempt's own ticket, after its launch, before any claim, and under the exact
// runtime name SubagentStart bound. A same-session caller that deliberately writes under that bound name is
// trusted as that runtime; any other `by` - the orchestrator's identity included - is somebody else. An
// attempt whose bind recorded only an agent id has no name to match, so no board write can speak for it.
// After a claim the claim liveness rules take over and this stops being consulted at all.
function lastAttributedBoardWriteAt(ticket?: any, state?: any) {
  const sessionId = String(state?.sessionId || '').trim();
  // Exact means byte-for-byte: a `by` that differs only by whitespace is somebody else (SQ-2964).
  const agentName = typeof state?.agentName === 'string' ? state.agentName : '';
  const launchedAt = Date.parse(state?.launchedAt);
  if (!sessionId || !agentName.trim() || !Number.isFinite(launchedAt)) return null;
  if (state.claimedAt || ticket?.claim?.by) return null;
  let latest: number | null = null;
  for (const comment of Array.isArray(ticket?.comments) ? ticket.comments : []) {
    if (String(comment?.sourceSession || '').trim() !== sessionId) continue;
    if (comment?.by !== agentName) continue;
    const at = Date.parse(comment?.at);
    if (!Number.isFinite(at) || at < launchedAt) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

function lastRuntimeSignalAt(ticket?: any, state?: any): { at: number; label: string } | null {
  let latest: { at: number; label: string } | null = null;
  for (const [field, label] of PRE_CLAIM_RUNTIME_SIGNALS) {
    const at = Date.parse(state?.[field]);
    // An unparsable stamp is one missing signal, never a NaN that poisons the whole comparison.
    if (!Number.isFinite(at)) continue;
    if (!latest || at >= latest.at) latest = { at, label };
  }
  const wroteAt = lastAttributedBoardWriteAt(ticket, state);
  if (wroteAt !== null && (!latest || wroteAt >= latest.at)) latest = { at: wroteAt, label: 'board write recorded' };
  return latest;
}

// WorktreeCreate records its completed checkout identity BEFORE it runs provisioning, and a cold `npm ci`
// runs for minutes after that with nothing else reaching the board, so neither the reservation nor the
// completion proves the hook is finished. Only the provisioning stamp does, or SubagentStart binding a
// runtime, which cannot happen until the hook returns (SQ-2932 finding 2).
function worktreeProvisioningInFlight(state?: any) {
  return Boolean(state?.worktreeBindingSource === 'worktree-create' && state.worktree
    && !state.worktreeProvisionedAt && !state.boundAt);
}

// THE retirement authority. Every evidence path - prepareDispatch, retireOnly, clearUnclaimedDispatch,
// pulse, the CLI and the refusal text - asks this and nothing else when an unclaimed attempt becomes
// retirable, so the printed deadline is always the one the gate uses. It never returns null: three
// reviews in a row found a caller that had invented its own answer for the missing case (SQ-2949).
function unclaimedRetirement(ticket?: any, state?: any, now = Date.now()) {
  const signal = lastRuntimeSignalAt(ticket, state);
  const provisioning = worktreeProvisioningInFlight(state);
  if (!signal) {
    // Nothing alive ever reported in. Falling back to the board's own prepare stamp keeps the instant
    // stable across repeated calls while leaving it in the past, which is the "retirable at once" the
    // refusal text and the MCP description have always promised.
    const preparedAt = Date.parse(state?.preparedAt);
    return {
      retirableAt: Number.isFinite(preparedAt) ? preparedAt : now,
      signal: null,
      provisioning,
      reason: 'no_readable_signal' as const,
    };
  }
  // A bound runtime's FIRST action is its tokened claim, so an attempt silent for a whole claim grace is
  // not winding down, it is gone. An in-flight WorktreeCreate is the exception: the board cannot tell a
  // cancelled hook from a running install, so it only ever reaches the idle backstop.
  return provisioning
    ? { retirableAt: signal.at + claimIdleMs(), signal, provisioning, reason: 'idle_backstop' as const }
    : { retirableAt: signal.at + claimGraceMs(), signal, provisioning, reason: 'grace' as const };
}

// The deadline protects a runtime still starting from anyone who cannot see it. The session that prepared the
// attempt spawned it, so it holds what the board never gets for a launch that dies before its first tool call:
// the host's failure report, or the Agent call returning with no claim. Its evidence retires at once; every
// other caller still waits for the deadline (SQ-3110, SQ-3071).
function preparingSessionAttests(state?: any, sessionId?: any) {
  const caller = String(sessionId || '').trim();
  return Boolean(caller) && caller === String(state?.preparedBy?.sessionId || '').trim();
}

// The shape half of the decision: an attempt nobody claimed, checkpointed or ended. Whether it is retirable
// YET is the authority's call, never this predicate's.
function unclaimedEvidenceAttempt(ticket?: any, state?: any) {
  return Boolean(
    state
    && ticket?.dispatchNonce
    && PRE_RUNTIME_DISPATCH_OUTCOMES.has(state.outcome)
    && !state.terminalAt
    && !state.claimedAt
    && !ticket.claim?.by
    && !ticket.checkpoint,
  );
}

// An attempt that never reached a runtime at all, which is a launch that never arrived rather than a
// stranded one. A WorktreeCreate holding the checkout counts as reached: the hook is the runtime.
function unboundEvidenceAttempt(state?: any) {
  return Boolean(state && !state.boundAt && !state.agentId && !worktreeProvisioningInFlight(state));
}

function evidenceRetirableAttempt(ticket?: any, state?: any, now = Date.now(), sessionId?: any) {
  if (!unclaimedEvidenceAttempt(ticket, state)) return false;
  return preparingSessionAttests(state, sessionId) || now >= unclaimedRetirement(ticket, state, now).retirableAt;
}

// A stop hook that beat the evidence to it already retired the attempt, so the same recovery call has nothing
// left to do rather than a reason to refuse (GH-69: the evidence call had no window in that shape).
function terminalUnclaimedAttempt(ticket?: any, state?: any) {
  return Boolean(state?.terminalAt && !ticket?.dispatchNonce && !ticket?.claim?.by && !pendingSubmission(ticket));
}

function preparingSessionClause(state?: any) {
  const preparingSession = String(state?.preparedBy?.sessionId || '').trim();
  return preparingSession
    ? `The session that prepared it (${preparingSession}) can retire it now with that evidence: it spawned the runtime, so the host's failure report or the Agent call returning without a claim is proof the board never gets.`
    : 'No preparing session was recorded, so evidence waits for the deadline.';
}

// Every refusal that meets an attempt nobody claimed names this one recovery, never a release (there is no
// claim holder) and never TaskStop (the host has already ended the runtime or will on its own).
function unclaimedAttemptRecoveryGuidance(ticket?: any, state?: any) {
  if (!unclaimedEvidenceAttempt(ticket, state)) return '';
  const ref = ticket.ref;
  return ` Nobody claimed this attempt, so there is no claim to release. The one recovery is recovery evidence: close it with \`groomClose ${ref} --recoveryEvidence "<the host's failure report>"\` (add \`--deliveryCommit <sha> --deliveryMethod manual\` for work landed by hand, reachable from the recorded integration branch), which retires the attempt in the same call, or retire it on its own with \`sidequest dispatch ${ref} --recovery-evidence "<that same evidence>" --retire-only\` (MCP \`recoveryEvidence\` with \`retireOnly: true\`). ${preparingSessionClause(state)} From any other session both refuse with the countdown to the retirement deadline.`;
}

function minuteCount(minutes: number) {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Elapsed rounds down and remaining rounds up, so the two halves of the refusal always sum to the grace
// rather than each claiming a minute the other already spent, and the countdown only reads "1 minute"
// inside the final minute. The old pair rounded and clamped both halves at one minute, which reported
// "60 minutes" the instant an attempt bound and "1 minute" for every minute after the deadline passed.
function describeElapsed(ms: number) {
  return minuteCount(Math.max(0, Math.floor(ms / 60000)));
}

function describeRemaining(ms: number) {
  return minuteCount(Math.ceil(ms / 60000));
}

function unclaimedRuntimeBlocker(ticket?: any, state?: any, now = Date.now()) {
  const boundMs = Date.parse(state?.boundAt);
  const waited = Number.isFinite(boundMs)
    ? `bound to a runtime ${describeElapsed(now - boundMs)} ago and still unclaimed, which`
    : worktreeProvisioningInFlight(state)
      ? 'still inside the WorktreeCreate that reserved its checkout, and unclaimed, which'
      : 'unbound and unclaimed, which';
  const retirement = unclaimedRetirement(ticket, state, now);
  // Naming the signal is what stops an operator reading the deadline as arbitrary: it is the difference
  // between "bound 20 minutes ago, still not retirable" and "its briefing fetch was 2 minutes ago".
  const measured = retirement.signal
    ? `last runtime signal: ${retirement.signal.label} at ${new Date(retirement.signal.at).toISOString()}`
    : 'no runtime ever recorded a signal on this attempt, so its own prepare stamp is the deadline';
  const window = retirement.provisioning
    ? 'its WorktreeCreate has not recorded finished provisioning, so only the idle backstop applies'
    : 'the claim grace runs from that signal';
  const remaining = retirement.retirableAt - now;
  if (remaining > 0) {
    return `${waited} becomes retirable on evidence at ${new Date(retirement.retirableAt).toISOString()}, in ${describeRemaining(remaining)}, unless its terminal hook fires first (${measured}; ${window}). ${preparingSessionClause(state)}`;
  }
  return `${waited} passed that deadline at ${new Date(retirement.retirableAt).toISOString()} but is not retirable in dispatch state ${pulseDispatchState(state)} (${measured})`;
}

// clearUnclaimedDispatch is a second door onto the same attempt, so it owes the caller the same countdown
// rather than its own verdict: groomClose retired a fresh unbound attempt inside grace because it never
// asked the authority at all (SQ-2949 finding 1).
function unclaimedRetirementRefusal(ticket?: any, state?: any, now = Date.now()) {
  return `${ticket?.ref || 'This attempt'} cannot be retired on recovery evidence yet because its dispatch is ${unclaimedRuntimeBlocker(ticket, state, now)}.`;
}

function evidenceSupersessionBlocker(ticket?: any, state?: any, now = Date.now()) {
  if (!state || !ticket?.dispatchNonce) return 'not an active attempt';
  if (state.terminalAt) return `already terminal (${state.outcome || 'terminal'})`;
  if (ticket.claim?.by) return `claimed by ${ticket.claim.by}`;
  if (state.claimedAt) return 'claimed';
  if (ticket.checkpoint) return 'checkpointed';
  if (!PRE_RUNTIME_DISPATCH_OUTCOMES.has(state.outcome)) return `in unrecognized state ${pulseDispatchState(state)}`;
  return unclaimedRuntimeBlocker(ticket, state, now);
}

function retirePreparedCompatibilityStaleAttempt(slug?: any, ticket?: any, source = 'tokened-claim-refusal') {
  const state = dispatchState(ticket);
  if (!state || state.terminalAt || !ticket?.dispatchNonce) return ticket;
  const previousStatus = ticket.status;
  setDispatchTerminal(ticket, 'failed', source, {
    slug,
    failureShape: 'prepared_compatibility_stale',
  });
  ticket.dispatchNonce = null;
  ticket.dispatchExecutor = null;
  if (!ticket.submission) ticket.status = 'todo';
  if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: new Date().toISOString() };
  stampDispatchEvent(ticket, source);
  putTicket(slug, ticket);
  return ticket;
}

type PreparedPluginInstall = {
  pluginInstall: unknown;
  identity: unknown;
  version?: unknown;
};

type PreparedCompatibilityState = {
  preparedCompatibility: PreparedPluginInstall;
};

type CurrentPluginInstall = {
  ok: boolean;
  installPath?: unknown;
  identity?: unknown;
};

type PreparedCompatibilityDecision = {
  refusal?: boolean;
  warning?: string;
};

function preparedCompatibilityDecision(state: PreparedCompatibilityState, currentInstall: CurrentPluginInstall): PreparedCompatibilityDecision | null {
  // Current-install reads retry transient replacement races; exhausting that retry
  // cannot prove the prepared snapshot still names the running install, so refuse.
  if (currentInstall.ok !== true) return { refusal: true };
  if (
    currentInstall.installPath !== state.preparedCompatibility.pluginInstall
    || currentInstall.identity !== state.preparedCompatibility.identity
  ) return { refusal: true };
  const preparedVersion = typeof state.preparedCompatibility.version === 'string' ? state.preparedCompatibility.version : '';
  const servingSnapshot = servingInstall();
  const servingVersion = typeof servingSnapshot?.version === 'string' ? servingSnapshot.version : '';
  if (!preparedVersion || !servingVersion) return null;
  const comparison = compareSemver(servingVersion, preparedVersion);
  // Equal precedence with distinct text may identify different builds, so refuse.
  if (comparison === 0 && servingVersion !== preparedVersion) return { refusal: true };
  // An older server can apply obsolete dispatch semantics; a newer one only needs a visible advisory.
  if (comparison === -1) return { refusal: true };
  if (comparison === 1) return { warning: `Sidequest serving ${servingVersion} is newer than prepared ${preparedVersion}; dispatch continues.` };
  return null;
}

function preparedCompatibilityHasProvenMismatch(state: PreparedCompatibilityState, currentInstall: CurrentPluginInstall) {
  return preparedCompatibilityDecision(state, currentInstall)?.refusal === true;
}

function preparedCompatibilityWarning(state: PreparedCompatibilityState, currentInstall: CurrentPluginInstall) {
  return preparedCompatibilityDecision(state, currentInstall)?.warning || null;
}

function supersedeUnboundAttempt(slug?: any, idOrRef?: any, opts?: any) {
  const evidence = String(opts?.evidence || '').trim();
  if (!evidence) return { ok: false, reason: 'recovery_evidence_required', message: 'Superseding an unbound dispatch attempt requires observed failure evidence.' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const state = dispatchState(ticket);
    const now = Date.now();
    if (terminalUnclaimedAttempt(ticket, state)) return { ok: true, ticket, alreadyTerminal: true };
    if (!evidenceRetirableAttempt(ticket, state, now, opts?.sessionId)) {
      return {
        ok: false,
        reason: 'unclaimed_launch_not_supersedable',
        ticket,
        message: `${ticket?.ref || idOrRef} cannot be superseded on recovery evidence because its dispatch is ${evidenceSupersessionBlocker(ticket, state, now)}. Evidence retires an unclaimed attempt at once from the session that prepared it, and from any other session once it has no readable runtime signal or its latest runtime signal is past its retirement deadline. A claimed attempt waits for its own terminal record.`,
      };
    }
    // What the runtime reached, not what the gate allowed: an attempt that bound or reserved a checkout
    // is stranded, and one that never left the token is a launch that never arrived.
    const strandedBound = !unboundEvidenceAttempt(state);
    setDispatchTerminal(ticket, 'failed', opts?.source || 'control-plane-unclaimed-launch-supersession', {
      slug,
      failureShape: strandedBound ? 'stranded_bound_launch_superseded' : 'unclaimed_launch_superseded',
    });
    const attempt = state.attempts?.at(-1);
    if (attempt) attempt.recoveryEvidence = evidence;
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    const previousStatus = ticket.status;
    if (!ticket.submission) ticket.status = 'todo';
    if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: new Date().toISOString() };
    stampDispatchEvent(ticket, opts?.source || 'control-plane-unclaimed-launch-supersession');
    putTicket(slug, ticket);
    return { ok: true, ticket };
  });
}

function isolatedDispatchWorktreeMissing(state?: any) {
  const worktree = String(state?.worktree || '').trim();
  return state?.sharedTree === false && Boolean(worktree) && !fs.existsSync(worktree);
}

function isolatedDispatchWithMissingWorktree(agentName?: any) {
  const target = String(agentName || '').trim();
  if (!target) return null;
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.agentName !== target || !isolatedDispatchWorktreeMissing(state)) continue;
      return { slug: project.slug, id: ticket.id, ref: ticket.ref, worktree: state.worktree };
    }
  }
  return null;
}

function terminalDispatchTarget(agentName?: any) {
  const target = String(agentName || '').trim();
  if (!target) return null;
  let terminal = null;
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.agentName !== target || !state.terminalAt || (state.outcome !== 'died' && ticket.claim?.by)) continue;
      terminal = { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt };
    }
  }
  return terminal;
}

// A TeammateIdle payload only ever carries `teammate_name`, plus a session id and
// agent type belonging to the idle teammate rather than to the dispatching
// session, and a large share of dispatches never bind an agent id at all. So no
// field may veto a match: identity has to be proven positively by an exact agent
// id or an exact agent name, with session and executor breaking ties only.
// Anything other than one surviving candidate leaves the teammate alone.
function terminalDispatchForIdle(identity?: any) {
  const sessionId = String(identity?.sessionId || '').trim();
  const agentId = String(identity?.agentId || '').trim();
  const agentName = String(identity?.agentName || '').trim();
  const executor = String(identity?.executor || '').trim();
  if (!agentId && !agentName) return null;
  const candidates: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || !state.terminalAt || ticket.claim?.by) continue;
      const byId = Boolean(agentId && state.agentId && String(state.agentId) === agentId);
      const byName = Boolean(agentName && state.agentName && String(state.agentName) === agentName);
      if (!byId && !byName) continue;
      candidates.push({
        byId,
        corroboration: (sessionId && String(state.sessionId || '') === sessionId ? 1 : 0)
          + (executor && String(state.executor || '') === executor ? 1 : 0),
        match: { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt },
      });
    }
  }
  const sole = soleIdleCandidate(candidates);
  return sole ? sole.match : null;
}

function soleIdleCandidate(candidates: any[]) {
  if (candidates.length < 2) return candidates[0] || null;
  for (const pool of [candidates.filter((candidate?: any) => candidate.byId), candidates]) {
    if (!pool.length) continue;
    if (pool.length === 1) return pool[0];
    const best = pool.reduce((top: number, candidate?: any) => Math.max(top, candidate.corroboration), 0);
    const narrowed = pool.filter((candidate?: any) => candidate.corroboration === best);
    if (narrowed.length === 1) return narrowed[0];
  }
  return null;
}

function appendDispatchAttempt(state?: any, outcome?: any, source?: any, failureShape?: any, at?: any, commit?: any, release?: any) {
  const route = state && state.route && typeof state.route === 'object' ? state.route : {};
  const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
  const terminalSource = source || 'store';
  attempts.push({
    route: normalizeRoute(route),
    executor: state.executor || null,
    sessionId: state.sessionId || null,
    agentId: state.agentId || null,
    agentName: state.agentName || null,
    tokenPrefix: state.tokenPrefix || null,
    // Without this an attempt that bound through its dispatch token is
    // indistinguishable from one that never bound at all: both carry a null
    // agentId. Review provenance needs to tell those apart.
    bindSource: state.bindSource || null,
    preparedAt: state.preparedAt || null,
    launchedAt: state.launchedAt || null,
    boundAt: state.boundAt || null,
    claimedAt: state.claimedAt || null,
    sharedTree: state.sharedTree === true,
    outcome,
    failureShape,
    source: terminalSource,
    terminalAt: at,
    terminalSource,
    ...(commit ? { commit } : {}),
    ...(release?.kind ? { release } : {}),
  });
  state.attempts = attempts.slice(-8);
}

// What a run left behind, so a later guard can tell "died with nothing" from
// "made real progress and ran out of turns" — opposite situations that want
// opposite responses. A checkpoint or submission commit is the durable evidence;
// the outcome label alone cannot carry it.
function attemptCommit(ticket?: any, opts?: any) {
  return opts?.commit || ticket?.checkpoint?.commit || ticket?.submission?.commit || null;
}

type ObservedWorktree = { facts: ReturnType<typeof immutableWorktreeFacts>; registered: boolean };
type ObservedWorktreeFacts = ReadonlyMap<string, ObservedWorktree>;

// A release observes its checkouts under the ticket file lock before BEGIN, so the write transaction reads facts
// instead of running git while it holds every project's writers (SQ-3348).
function observeReleaseWorktreeFacts(slug: string, ticket: StoredRecord): ObservedWorktreeFacts {
  const state = dispatchState(ticket);
  if (state?.sharedTree !== false) return new Map();
  const worktrees = [state.worktree, state.releaseObservedCheckout?.worktree].filter(Boolean).map((worktree: string): string => canonicalPath(worktree));
  return new Map(worktrees.map((worktree: string) => [worktree, observeWorktree(slug, worktree)]));
}

function observeWorktree(slug: string, worktree: string): ObservedWorktree {
  const facts = immutableWorktreeFacts(slug, worktree);
  return { facts, registered: registeredProjectCheckout(facts) };
}

function worktreeFactsFor(slug: string, worktree: string, observed?: ObservedWorktreeFacts) {
  return observed ? observed.get(canonicalPath(worktree))?.facts ?? null : immutableWorktreeFacts(slug, worktree);
}

function observedCheckoutRegistered(worktree: string, facts: StoredRecord, observed?: ObservedWorktreeFacts): boolean {
  return observed ? observed.get(canonicalPath(worktree))?.registered === true : registeredProjectCheckout(facts);
}

function captureTerminalWorktreeRevision(slug?: any, state?: any, at?: any, observed?: ObservedWorktreeFacts) {
  if (!terminalRevisionBound(slug, state)) return;
  const facts = worktreeFactsFor(slug, state.worktree, observed);
  if (!factsDescribeBoundCheckout(facts, state)) return;
  state.terminalWorktreeRevision = facts.revision;
  state.terminalWorktreeObservedAt = at;
}

function terminalRevisionBound(slug: unknown, state: StoredRecord): boolean {
  return Boolean(slug) && state?.sharedTree === false && Boolean(state.worktree) && Boolean(state.worktreeGitDirectory) && Boolean(state.worktreeCommonGitDirectory);
}

type WorktreeFacts = NonNullable<ReturnType<typeof immutableWorktreeFacts>>;

function factsDescribeBoundCheckout(facts: WorktreeFacts | null, state: StoredRecord): facts is WorktreeFacts {
  if (!facts) return false;
  return sameCheckoutLocation(facts, state) && facts.checkoutInstance === String(state.worktreeCheckoutInstance || '');
}

function sameCheckoutLocation(facts: WorktreeFacts, state: StoredRecord): boolean {
  return facts.worktree === canonicalPath(state.worktree)
    && facts.gitDirectory === canonicalPath(state.worktreeGitDirectory)
    && facts.commonGitDirectory === canonicalPath(state.worktreeCommonGitDirectory);
}

function sameRevision(left?: any, right?: any) {
  const first = String(left || '').trim().toLowerCase();
  const second = String(right || '').trim().toLowerCase();
  if (first.length < 7 || second.length < 7) return false;
  return first.startsWith(second) || second.startsWith(first);
}

// A review that never reached its candidate is a verdict on the wrong tree, which is how SQ-2124 rejected a
// commit whose own suite passed 18/18. Asking the reviewer to STATE the revision it verified would prove
// nothing, because the candidate sha is in its briefing and a copied value is not evidence; the ending tree is
// already observable, so observe it. Only a `done` closure is checked: a review that finds a defect releases
// with kind oracle, and a hand-delivered control-plane closure is not an executor claim (SQ-2207).
function reviewCandidateTreeRefusal(slug?: any, ticket?: any) {
  const state = dispatchState(ticket);
  if (state?.reviewTarget?.candidate?.source !== 'git') return null;
  const candidate = String(state.baseCommit || '').trim();
  if (!candidate) return null;
  const worktree = String(state.worktree || '').trim();
  const observed = worktree ? immutableWorktreeFacts(slug, worktree)?.revision : null;
  if (!observed) {
    return {
      ok: false,
      reason: 'review_tree_unobservable',
      message: `${ticket.ref} reviews candidate ${candidate} and its checkout cannot be read, so nothing can show the verdict was formed on that commit. Do not close it: comment what you verified and release ${ticket.ref} with kind \`technical_blocker\` so the orchestrator dispatches the review again into a readable isolated checkout.`,
    };
  }
  if (sameRevision(observed, candidate)) return null;
  return {
    ok: false,
    reason: 'review_tree_mismatch',
    message: `${ticket.ref} cannot close: its checkout is on ${observed} rather than the candidate ${candidate}, so this verdict is about a different tree. A review ENDS on its candidate. Run \`git -C ${worktree} checkout --detach ${candidate}\`, re-run the declared verify there, then close. Comparing against the integration branch never needs HEAD to move: use \`git diff ${candidate}...main\` or \`git show\`.`,
  };
}

function setDispatchTerminal(ticket?: any, outcome?: any, source?: any, opts?: any) {
  const state = dispatchState(ticket);
  if (!state) return;
  const at = new Date().toISOString();
  captureTerminalWorktreeRevision(opts?.slug, state, at);
  const release = opts?.releaseKind ? {
    kind: opts.releaseKind,
    reason: opts.releaseReason || null,
    evidence: opts.releaseEvidence || null,
  } : null;
  const failureShape = opts?.failureShape || release?.kind || classifyDispatchFailure(opts?.error);
  state.outcome = outcome;
  state.failureShape = failureShape;
  state.terminalAt = at;
  state.terminalSource = source || 'store';
  appendDispatchAttempt(state, outcome, source, failureShape, at, attemptCommit(ticket, opts), release);
  delete state.supersededTokens;
}

function appendReworkEvent(ticket?: any, kind?: any, details?: any) {
  const dispatch = dispatchState(ticket);
  const route = dispatch && dispatch.route && typeof dispatch.route === 'object' ? dispatch.route : {};
  const at = details.at || new Date().toISOString();
  if (!Array.isArray(ticket.reworkEvents)) ticket.reworkEvents = [];
  ticket.reworkEvents.push({
    kind,
    at,
    source: details.source || 'store',
    by: details.by || null,
    fromStatus: details.fromStatus || null,
    toStatus: details.toStatus || null,
    attempt: dispatch ? {
      agentId: dispatch.agentId || null,
      agentName: dispatch.agentName || null,
      route: { model: route.model || null, effort: route.effort || null },
      preparedAt: dispatch.preparedAt || null,
      launchedAt: dispatch.launchedAt || null,
      boundAt: dispatch.boundAt || null,
      claimedAt: dispatch.claimedAt || null,
      terminalAt: dispatch.terminalAt || at,
      outcome: dispatch.outcome || null,
    } : null,
  });
}

function dispatchTokenDigest(token?: any) {
  return crypto.createHash('sha256').update(normalizeDispatchToken(token)).digest('hex');
}

function isSupersededDispatchToken(ticket?: any, token?: any) {
  const state = dispatchState(ticket);
  if (!state || !token || dispatchTokenMatches(ticket.dispatchNonce, token)) return false;
  return Array.isArray(state.supersededTokens) && state.supersededTokens.some((entry?: any) => entry.digest === dispatchTokenDigest(token));
}

function routingPolicyAffectsTicket(ticket?: any, categoryIds?: any) {
  if (ticket?.route != null) return false;
  if (!Array.isArray(categoryIds) || !categoryIds.length) return true;
  const affected = new Set(categoryIds.map(normalizeCategoryId));
  if (affected.has('general')) return true;
  let category = ticketCategory(ticket);
  if (category == null && ticket && ticket.complexity != null) category = legacyCategoryForComplexity(ticket.complexity);
  return category != null && affected.has(normalizeCategoryId(category));
}

function refreshPreparedDispatches(handle?: any, projects?: any, categoryIds?: any, options?: any) {
  const projectList = Array.from(new Set((projects || []).filter(Boolean)));
  const refreshed = { superseded: 0, stamped: 0 };
  if (!projectList.length) return refreshed;
  const now = new Date().toISOString();
  for (const project of projectList) {
    for (const row of handle.prepare('SELECT data FROM tickets WHERE project = ?').all(project)) {
      let ticket: any;
      try { ticket = JSON.parse(row.data); } catch (_: any) { continue; }
      if (!routingPolicyAffectsTicket(ticket, categoryIds)) continue;
      const state = dispatchState(ticket);
      if (!state || state.terminalAt || !ticket.dispatchNonce) continue;
      const active = Boolean(state.launchedAt || state.boundAt || state.claimedAt || (ticket.claim && ticket.claim.by) || options?.preservePrepared);
      if (active) {
        state.policyChangedAt = now;
        stampDispatchEvent(ticket, 'routing-policy', now);
        db.putRow(handle, 'tickets', ticketStorageRow(project, ticket));
        refreshed.stamped += 1;
        continue;
      }
      if (state.outcome !== 'prepared') continue;
      const supersededTokens = Array.isArray(state.supersededTokens) ? state.supersededTokens.slice() : [];
      supersededTokens.push({
        digest: dispatchTokenDigest(ticket.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(ticket.dispatchNonce),
        at: now,
      });
      state.supersededTokens = supersededTokens.slice(-8);
      const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
      attempts.push({
        route: normalizeRoute(state.route),
        executor: state.executor || canonicalPreparedDispatchExecutor(ticket),
        tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(ticket.dispatchNonce),
        preparedAt: state.preparedAt || null,
        launchedAt: null,
        outcome: 'policy-changed',
        terminalAt: now,
        terminalSource: 'routing-policy',
      });
      state.attempts = attempts.slice(-8);
      state.outcome = 'policy-changed';
      state.terminalAt = now;
      state.terminalSource = 'routing-policy';
      state.policyChangedAt = now;
      delete state.executor;
      delete ticket.dispatchNonce;
      delete ticket.dispatchExecutor;
      stampDispatchEvent(ticket, 'routing-policy', now);
      db.putRow(handle, 'tickets', ticketStorageRow(project, ticket));
      refreshed.superseded += 1;
    }
  }
  return refreshed;
}

function expiredPreparedDispatch(state?: any, now?: any) {
  if (!state || state.outcome !== 'prepared' || state.terminalAt || state.launchedAt || state.boundAt || state.claimedAt) return false;
  const preparedAt = Date.parse(state.preparedAt);
  return Number.isFinite(preparedAt) && now - preparedAt > preparedDispatchTtlMs();
}

function recentNoCommitAttemptSelection(state?: any) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const recent: any[] = [];
  const rounds = new Set<string>();
  let skippedUnbound = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt?.terminalAt || attempt.release?.kind === 'handback' || attempt.release?.kind === 'oracle') continue;
    const round = String(attempt.preparedAt || attempt.tokenPrefix || attempt.terminalAt);
    if (rounds.has(round)) continue;
    rounds.add(round);
    if (attempt.boundAt == null && attempt.claimedAt == null) {
      skippedUnbound += 1;
      continue;
    }
    recent.unshift(attempt);
    if (recent.length === 2) break;
  }
  return {
    attempts: recent.length === 2 && recent.every((attempt?: any) => attempt.outcome !== 'submitted' && !attempt.commit) ? recent : [],
    skippedUnbound,
  };
}

function recentNoCommitAttempts(state?: any) {
  return recentNoCommitAttemptSelection(state).attempts;
}

function skippedUnboundNoCommitAttempts(state?: any) {
  return recentNoCommitAttemptSelection(state).skippedUnbound >= 2;
}

function recordedAttemptSummary(attempt?: any) {
  const kind = attempt?.release?.kind || attempt?.outcome || 'unknown';
  const at = attempt?.terminalAt || 'unknown time';
  return `${kind} at ${at}`;
}

function repeatNoCommitDispatchError(ticket?: any, state?: any) {
  const attempts = recentNoCommitAttempts(state);
  if (attempts.length !== 2) return null;
  const recordedAttempts = attempts.map(recordedAttemptSummary).join('; ');
  const worktreeFailures = attempts.every((attempt?: any) => attempt.sharedTree === false && attempt.failureShape === 'worktree_environment');
  if (worktreeFailures) {
    return `prepare dispatch: ${ticket.ref} has two isolated no-commit dispatches (${recordedAttempts}) that failed to find the app or service. Check for repository bind mounts or unavailable paths, then choose a shared-tree fallback with \`dispatch ${ticket.ref} --shared-tree\` (or MCP \`sharedTree:true\`): its spawn omits \`isolation\`, so the harness validator does not run. Run one shared-tree executor at a time. Pass allowRepeatFailure:true to override this block; the override is recorded.`;
  }
  const repeatedContradictions = attempts.every((attempt?: any) => attempt.release?.kind === 'contradiction');
  if (repeatedContradictions) {
    return `prepare dispatch: ${ticket.ref} has two contradiction releases (${recordedAttempts}). The ticket premise is likely wrong, not the executor environment. Measure the claim, then rewrite the ticket before dispatching again; pass allowRepeatFailure:true only when a repeat is intentional.`;
  }
  return `prepare dispatch: ${ticket.ref} has two prior terminal no-commit dispatches (${recordedAttempts}). Review the recorded release reasons, correct the ticket when they show a contradiction, then dispatch with allowRepeatFailure:true when a repeat is intentional.`;
}

function sharedTreeExecutionGuidance(readonly: boolean): string {
  return readonly
    ? 'Read-only executor: keep project files unchanged and close with done; do not commit or submit.'
    : 'Executor must scoped-commit immediately.';
}

function worktreeIsolationWarning(slug?: string, readonly = false) {
  const guidance = sharedTreeExecutionGuidance(readonly);
  const meta = readMeta(slug);
  if (!meta || !meta.path) {
    return `Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. ${guidance}`;
  }
  if (!fs.existsSync(meta.path)) {
    return `Worktree isolation unavailable: project path does not exist; spawning in shared tree. ${guidance}`;
  }
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: meta.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') {
      return `Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. ${guidance}`;
    }
  } catch (error: any) {
    const reason = error && error.code === 'ENOENT' ? 'Git is not available' : 'project is not a Git work tree';
    return `Worktree isolation unavailable: ${reason}; spawning in shared tree. ${guidance}`;
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: meta.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return null;
  } catch (_: any) {
    return `Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. ${guidance}`;
  }
}

function nativeGitPath(value?: any) {
  const input = String(value || '').trim();
  const gitBashPath = process.platform === 'win32' ? /^\/([a-zA-Z])(?=\/|$)/.exec(input) : null;
  return gitBashPath ? `${gitBashPath[1]}:${input.slice(2)}` : input;
}

function gitOutput(root?: any, args?: any[]) {
  return execFileSync('git', args || [], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function registeredWorktrees(repository?: any): string[] {
  return gitOutput(repository, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n\r?\n/)
    .map((entry: string) => /^worktree\s+(.+)$/m.exec(entry)?.[1])
    .filter((worktree: string | undefined): worktree is string => Boolean(worktree))
    .map((worktree: string) => canonicalPath(worktree));
}

function gitFailureEvidence(error?: any) {
  return String(error?.stderr || error?.message || error || 'unknown Git error')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function continuationFallback(reason?: any, worktree?: any, details?: any) {
  return {
    reason: String(reason || 'unavailable'),
    ...(worktree ? { sourceWorktree: String(worktree) } : {}),
    ...(details && typeof details === 'object' ? details : {}),
  };
}

// Selection runs before the dispatch base is known, and an explicitly named older base passes the
// ancestry check against a checkout built on a newer one, so the override never reached the executor (GH-125).
function explicitBaseContinuation(released: any, explicit: boolean, target: any, baseCommit: string) {
  if (!explicit || !released?.continuation) return released;
  return retainedAgainstExplicitBase(released.continuation, `the dispatch explicitly names integration base ${target.branch} at ${baseCommit}`, baseCommit);
}

// Committed checkpoints replay onto the named base in a fresh checkout. Uncommitted work exists only in
// its checkout, so that one stays retained and is told to move.
function retainedAgainstExplicitBase(continuation: any, named: string, baseCommit: string) {
  if (continuation.baseCommit === baseCommit) return { continuation: { ...continuation, retainReason: `${named}, which is the retained checkout's own base` } };
  const differs = `${named} while retained checkout ${continuation.sourceWorktree} is built on ${continuation.baseCommit}`;
  if (continuation.mode === 'dirty_worktree_resume') {
    return { continuation: { ...continuation, retainReason: `${differs}; its uncommitted changes exist nowhere else, so it is still retained and they move onto ${baseCommit} before any work` } };
  }
  const { sourceBranch, commit, commits } = continuation;
  return {
    fallback: continuationFallback('released_worktree_base_differs_from_explicit_integration_base', continuation.sourceWorktree, {
      sourceBranch, commit, commits, cause: `${differs}, so its checkpoint commits replay onto the named base in a fresh checkout`,
    }),
  };
}

function gitDirectory(repository?: any, directory?: any) {
  const value = nativeGitPath(directory);
  return canonicalPath(path.isAbsolute(value) ? value : path.resolve(String(repository || ''), value));
}

function immutableWorktreeFacts(slug?: any, candidate?: any) {
  const projectPath = String(readMeta(slug)?.path || '').trim();
  const supplied = String(candidate || '').trim();
  if (!projectPath || !supplied) return null;
  try {
    const repository = canonicalPath(gitOutput(projectPath, ['rev-parse', '--show-toplevel']));
    const worktree = canonicalPath(gitOutput(supplied, ['rev-parse', '--show-toplevel']));
    const gitDirectoryPath = gitDirectory(worktree, gitOutput(worktree, ['rev-parse', '--git-dir']));
    const commonGitDirectory = gitDirectory(worktree, gitOutput(worktree, ['rev-parse', '--git-common-dir']));
    const repositoryGitDirectory = gitDirectory(repository, gitOutput(repository, ['rev-parse', '--git-common-dir']));
    const checkoutInstance = checkoutInstanceIdentity(gitDirectoryPath);
    if (commonGitDirectory !== repositoryGitDirectory || gitDirectoryPath === commonGitDirectory || !checkoutInstance) return null;
    const revision = gitOutput(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return { repository, worktree, gitDirectory: gitDirectoryPath, commonGitDirectory, checkoutInstance, revision };
  } catch (_: any) {
    return null;
  }
}

function boundIsolatedWorktree(state?: any) {
  return Boolean(state?.worktree && ['worktree-create', 'live-claim-recovery'].includes(state.worktreeBindingSource));
}

function completedWorktreeCreationFacts(state?: any) {
  if (!state?.worktreeCreationCompletedAt || !state.worktree || !state.worktreeGitDirectory
    || !state.worktreeCommonGitDirectory || !state.worktreeCheckoutInstance || !state.worktreeObservedRevision) return null;
  return {
    worktree: canonicalPath(state.worktree),
    gitDirectory: canonicalPath(state.worktreeGitDirectory),
    commonGitDirectory: canonicalPath(state.worktreeCommonGitDirectory),
    checkoutInstance: String(state.worktreeCheckoutInstance),
    revision: String(state.worktreeObservedRevision),
  };
}

function reportsRegisteredProjectCheckout(slug?: any, worktree?: any) {
  const projectPath = String(readMeta(slug)?.path || '').trim();
  const reportedWorktree = String(worktree || '').trim();
  return Boolean(projectPath && reportedWorktree && canonicalPath(projectPath) === canonicalPath(reportedWorktree));
}

function normalizedText(value?: any) {
  return String(value || '').trim();
}

function pinnedCandidateLines(repository?: any): string[] {
  try {
    return gitOutput(repository, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/sidequest/']).split('\n');
  } catch (_: any) {
    return [];
  }
}

function pinnedCandidateRevisions(repository?: any) {
  const pinned = new Map<string, string>();
  for (const line of pinnedCandidateLines(repository)) {
    const [name, object] = line.trim().split(' ');
    if (name && object && name.startsWith('refs/sidequest/')) pinned.set(name.slice('refs/sidequest/'.length), object.toLowerCase());
  }
  return pinned;
}

function ticketRecordedRevisions(ticket?: any, state?: any, pinned?: Map<string, string>): string[] {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  return [
    ...(Array.isArray(state?.sanctionedCommits) ? state.sanctionedCommits : []),
    ticket?.checkpoint?.commit,
    ticket?.submission?.commit,
    attempts[attempts.length - 1]?.commit,
    pinned?.get(String(ticket?.ref || '')),
  ].map((commit?: any) => normalizedText(commit).toLowerCase()).filter(Boolean);
}

function isOtherTicket(other?: any, ticket?: any) {
  return Boolean(other) && other.id !== ticket?.id;
}

function recordsRevision(recorded: string[], commit: string) {
  return recorded.some((revision: string) => sameRevision(revision, commit));
}

function foreignCommit(commit: string, recorded: string[], own: string[]) {
  return recordsRevision(recorded, commit) && !recordsRevision(own, commit);
}

function carriesForeignCommit(other?: any, range?: string[], own?: string[], pinned?: Map<string, string>) {
  const recorded = ticketRecordedRevisions(other, dispatchState(other), pinned);
  return recorded.length > 0 && range!.some((commit: string) => foreignCommit(commit, recorded, own!));
}

// A crossed checkout carries its sibling's commits (GitHub #298), and nothing about the tree itself says whose they
// are. The board does: a claim's board commits, its checkpoint and submission, and its pinned candidate. A checkout
// counts as this ticket's only when its HEAD is one of those and no commit in its range is another ticket's (SQ-75).
function checkoutRangeOwnership(slug?: any, ticket?: any, state?: any, repository?: any, commits?: string[]) {
  const range = Array.isArray(commits) ? commits : [];
  const pinned = pinnedCandidateRevisions(repository);
  const own = ticketRecordedRevisions(ticket, state, pinned);
  const foreignTickets = listTickets(slug)
    .filter((other?: any) => isOtherTicket(other, ticket))
    .filter((other?: any) => carriesForeignCommit(other, range, own, pinned))
    .map((other?: any) => String(other.ref))
    .sort();
  const head = range[range.length - 1];
  return { ownHead: Boolean(head && recordsRevision(own, head)), foreignTickets };
}

function liveIsolatedLease(ticket?: any) {
  const state = dispatchState(ticket);
  return ticket.status !== 'done' && state?.sharedTree === false && !state.terminalAt && Boolean(state.worktree);
}

function leasesCheckout(other?: any, ticket?: any, target?: any) {
  return isOtherTicket(other, ticket) && liveIsolatedLease(other) && canonicalPath(dispatchState(other).worktree) === target;
}

function liveCheckoutHolders(slug?: any, ticket?: any, worktree?: any): string[] {
  const target = canonicalPath(worktree);
  return listTickets(slug)
    .filter((other?: any) => leasesCheckout(other, ticket, target))
    .map((other?: any) => String(other.ref))
    .sort();
}

function registeredProjectCheckout(facts?: any) {
  try {
    return Boolean(facts && registeredWorktrees(facts.repository).includes(facts.worktree));
  } catch (_: any) {
    return false;
  }
}

// A binding the release dropped (SQ-75), or a checkout that is gone, leaves nothing to resume.
function retainedBindingFallback(state?: any, recordedWorktree?: any) {
  if (state.retainedWorktreeDropped) {
    return continuationFallback('released_worktree_binding_dropped', recordedWorktree, { observedWorktree: state.retainedWorktreeDropped.observed || null });
  }
  if (!recordedWorktree || !fs.existsSync(recordedWorktree)) return continuationFallback('released_worktree_missing', recordedWorktree);
  return null;
}

// Only a checkout whose HEAD this ticket committed, carrying no other ticket's commits, resumes (SQ-75).
function retainedOwnershipFallback(slug?: any, ticket?: any, state?: any, repository?: any, range?: any) {
  const ownership = checkoutRangeOwnership(slug, ticket, state, repository, range.commits);
  if (ownership.foreignTickets.length) {
    return continuationFallback('retained_worktree_carries_another_tickets_commits', range.worktree, { commit: range.commit, commits: range.commits, foreignTickets: ownership.foreignTickets });
  }
  if (!ownership.ownHead) return continuationFallback('retained_worktree_head_is_not_this_tickets', range.worktree, { commit: range.commit, commits: range.commits });
  return null;
}

function retainedWorktreeContinuationState(slug?: any, ticket?: any, state?: any) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const attempt = attempts[attempts.length - 1] || null;
  const checkpointCommit = String(attempt?.commit || '').trim();
  const checkpointedTerminalFailure = Boolean(state?.terminalAt && checkpointCommit && ['failed', 'died'].includes(state.outcome));
  if (!state || (!checkpointedTerminalFailure && state.outcome !== 'released') || !state.terminalAt || state.sharedTree !== false) return null;
  const recordedWorktree = String(state.worktree || '').trim();
  const bindingFallback = retainedBindingFallback(state, recordedWorktree);
  if (bindingFallback) return { fallback: bindingFallback };
  let worktree = recordedWorktree;
  try {
    const recordedGitDirectory = String(state.worktreeGitDirectory || '').trim();
    const recordedCommonGitDirectory = String(state.worktreeCommonGitDirectory || '').trim();
    const recordedCheckoutInstance = String(state.worktreeCheckoutInstance || '').trim();
    const recordedRevision = String(state.terminalWorktreeRevision || '').trim();
    const worktreeFacts = immutableWorktreeFacts(slug, recordedWorktree);
    if (!worktreeFacts || !recordedGitDirectory || !recordedCommonGitDirectory || !recordedCheckoutInstance || !recordedRevision) {
      return { fallback: continuationFallback('released_worktree_identity_unavailable', recordedWorktree) };
    }
    worktree = worktreeFacts.worktree;
    const observedRevision = worktreeFacts.revision;
    const leaseFacts = {
      repository: worktreeFacts.repository,
      gitDirectory: worktreeFacts.gitDirectory,
      commonGitDirectory: worktreeFacts.commonGitDirectory,
      dispatchRef: String(ticket?.ref || '') || null,
      dispatchBaseline: String(state.baseCommit || '').trim() || null,
      observedRevision,
      observedWorktree: worktree,
      boundRevision: recordedRevision,
      boundWorktree: recordedWorktree,
      boundGitDirectory: recordedGitDirectory,
      boundCommonGitDirectory: recordedCommonGitDirectory,
      boundCheckoutInstance: recordedCheckoutInstance,
      identity: state.agentId ? { status: 'bound' as const, agentId: String(state.agentId) } : { status: 'unknown' as const },
      phase: 'terminal' as const,
      locked: false,
      liveness: { status: 'terminal' as const, evidence: 'released at ' + state.terminalAt },
      provisioning: 'host' as const,
    };
    const lease = createWorktreeLease(leaseFacts);
    if (!isCanonicalRegisteredWorktree(lease, registeredWorktrees(worktreeFacts.repository))) {
      return { fallback: continuationFallback('released_worktree_is_not_registered', worktree) };
    }
    const resume = worktreeResumeDecision(lease);
    if (!resume.allowed) {
      return { fallback: continuationFallback('released_worktree_lease_refused', worktree, { cause: resume.reason }) };
    }
    const baseCommit = gitOutput(worktree, ['rev-parse', '--verify', String(state.baseCommit) + '^{commit}']);
    const commits = gitOutput(worktree, ['rev-list', '--reverse', baseCommit + '..' + observedRevision, '--']).split(/\r?\n/).filter(Boolean);
    let sourceBranch = null;
    try { sourceBranch = gitOutput(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch (_: any) {}
    if (gitOutput(worktree, ['status', '--porcelain'])) {
      if (!commits.length) {
        return {
          continuation: {
            mode: 'dirty_worktree_resume', ticketRef: ticket.ref, sourceWorktree: worktree, sourceBranch, baseCommit, commit: observedRevision,
            clean: false, releasedAt: state.terminalAt, releaseKind: attempt?.release?.kind || 'release', lease: leaseFacts,
          },
        };
      }
      return { fallback: continuationFallback('released_worktree_is_dirty', worktree, { sourceBranch, commit: observedRevision, commits }) };
    }
    if (!checkpointCommit && !['handback', 'oracle'].includes(attempt?.release?.kind)) {
      return { fallback: continuationFallback('release_has_no_checkpoint_or_handback', worktree) };
    }
    if (checkpointCommit && checkpointCommit !== observedRevision) {
      return { fallback: continuationFallback('checkpoint_is_not_worktree_head', worktree) };
    }
    if (!commits.length) return { fallback: continuationFallback('released_worktree_has_no_committed_progress', worktree) };
    if (commits.length > 128) return { fallback: continuationFallback('released_worktree_commit_range_is_too_large', worktree) };
    const ownershipFallback = retainedOwnershipFallback(slug, ticket, state, worktreeFacts.repository, { worktree, commit: observedRevision, commits });
    if (ownershipFallback) return { fallback: ownershipFallback };
    return {
      continuation: {
        mode: 'retained_worktree_resume', ticketRef: ticket.ref, sourceWorktree: worktree, sourceBranch, baseCommit, commit: observedRevision, commits,
        clean: true, releasedAt: state.terminalAt, releaseKind: attempt?.release?.kind || (checkpointCommit ? 'checkpoint' : 'handback'), lease: leaseFacts,
      },
    };
  } catch (error: any) {
    return { fallback: continuationFallback('released_worktree_git_state_is_unreadable', worktree, { cause: gitFailureEvidence(error) }) };
  }
}

function releaseFragmentOnlyCheckpoint(projectPath?: any, ticket?: any, checkpointCommit?: any, baseCommit?: any) {
  const repository = String(projectPath || '').trim();
  const commit = String(checkpointCommit || '').trim();
  const baseline = String(baseCommit || '').trim();
  const ticketRef = String(ticket?.ref || '').trim();
  if (!repository || !commit || !baseline || !ticketRef) return false;
  try {
    gitOutput(repository, ['merge-base', '--is-ancestor', baseline + '^{commit}', commit + '^{commit}']);
    const changedPaths = gitOutput(repository, ['diff', '--name-only', baseline + '^{commit}', commit + '^{commit}', '--'])
      .split(/\r?\n/)
      .map((changedPath: string) => changedPath.replace(/\\/g, '/').trim())
      .filter(Boolean);
    return changedPaths.length === 1 && changedPaths[0] === `.release/unreleased/${ticketRef}.md`;
  } catch (_: any) {
    return false;
  }
}

// Creation attributes a checkout in creation order, so a board can still carry a record naming a checkout a
// sibling's agent actually ran in. Everything the recovery fact then reports about that checkout is the
// sibling's work, and the fact is immutable, so it refused every retry of a ticket whose own spawn never
// created anything (SQ-2926). A linked checkout is named agent-<agentId>, so an agent id another dispatch
// bound is proof this attempt never created this one.
function checkoutBelongsToAnotherDispatchAgent(slug?: any, projectPath?: any, ticket?: any, state?: any) {
  const repository = String(projectPath || '').trim();
  const recorded = String(state?.worktree || '').trim();
  if (!repository || !recorded) return false;
  const target = canonicalPath(recorded);
  const namesCheckout = (agentId?: any) => {
    const id = String(agentId || '').trim();
    return Boolean(id && agentWorktreeCandidates(repository, id).some((candidate: string) => canonicalPath(candidate) === target));
  };
  if (namesCheckout(state.agentId)) return false;
  return listTickets(slug).some((candidate?: any) => {
    if (!candidate || candidate.id === ticket?.id) return false;
    const other = dispatchState(candidate);
    const attempts = Array.isArray(other?.attempts) ? other.attempts : [];
    return Boolean(other) && [other.agentId, ...attempts.map((attempt: any) => attempt?.agentId)].some(namesCheckout);
  });
}

function agentNamesCheckout(repository: string, agentId: unknown, target: string) {
  const id = String(agentId || '').trim();
  return Boolean(id) && agentWorktreeCandidates(repository, id).some((candidate: string) => canonicalPath(candidate) === target);
}

function liveCheckoutHolder(ticket?: any) {
  const state = dispatchState(ticket);
  return Boolean(ticket?.claim?.by) || Boolean(state && !state.terminalAt);
}

function recordsCheckout(repository: string, ticket: any, target: string) {
  const state = dispatchState(ticket);
  if (state?.worktree && canonicalPath(state.worktree) === target) return true;
  return [state?.agentId, ticket.claim?.runtime?.agentId].some((agentId) => agentNamesCheckout(repository, agentId, target));
}

function siblingHoldsCheckout(repository: string, ticket: any, candidate: any, target: string) {
  return candidate.id !== ticket.id && liveCheckoutHolder(candidate) && recordsCheckout(repository, candidate, target);
}

// A retired attempt's own record can name a sibling's checkout down to the sibling's agent id, because both
// creation order and runtime binding can cross (SQ-3132: SQ-3104's recovery removed SQ-3101's live tree).
// A live claim or dispatch that records the path, or whose agent the path is named after, outranks it.
function liveSiblingHoldingCheckout(slug: string, projectPath: string, ticket: any, state: any) {
  if (!projectPath || !state?.worktree) return null;
  const target = canonicalPath(state.worktree);
  return listTickets(slug).find((candidate: any) => siblingHoldsCheckout(projectPath, ticket, candidate, target)) || null;
}

function crossBoundCheckoutRefusal(ref: string, siblingRef: string, worktree: string) {
  return `${ref} did not remove ${worktree}: its retired attempt's binding was a cross-bind onto ${siblingRef}'s live checkout, not a tree ${ref} created. The checkout stays with ${siblingRef}, and only ${ref}'s binding was cleared.`;
}

function unsettledSiblingCheckoutRefusal(ref: string, siblingRef: string, worktree: string) {
  return `${ref} did not remove ${worktree}: ${siblingRef} from the same dispatch session has not claimed yet, and creation order can hand one sibling's checkout to the other's reservation, so this may be the tree ${siblingRef}'s executor runs in. The checkout stays, and only ${ref}'s binding was cleared.`;
}

// Creation only ever attributes a checkout to an isolated reservation on its own board, so a shared-tree or
// other-board sibling can never be the crossed one (SQ-3147).
function guessedSessionSibling(entry: { slug: string; ticket: any }, slug: string, ticket: any, sessionId: string) {
  const state = dispatchState(entry.ticket);
  return entry.slug === slug && entry.ticket.id !== ticket.id && state?.sharedTree === false && guessedReservation(entry.ticket, state, sessionId);
}

// Creation order and SubagentStart both bind by guess, so until every sibling of this session has claimed, the
// retired record can name a live executor's checkout with nothing on the sibling's own record to say so (SQ-3139).
function unsettledSessionSibling(slug: string, ticket: any, state: any) {
  const sessionId = normalizedText(state?.sessionId);
  const sibling = sessionId && ticketsMentioningSession(sessionId).find((entry) => guessedSessionSibling(entry, slug, ticket, sessionId));
  return sibling ? sibling.ticket : null;
}

// Creation order may have bound this reservation for a sibling's executor, and the failing executor's ticket is
// unknowable from the hook, so failing it cleared the token a live executor still needed to claim (SQ-3139). While a
// sibling of this session is unsettled, the reservation only loses the binding; whichever attempt never claims retires.
function holdUncreatedFailureForSibling(slug: string, ticket: any, state: any, sessionId: string) {
  const sibling = guessedReservation(ticket, state, sessionId) ? unsettledSessionSibling(slug, ticket, state) : null;
  if (!sibling) return null;
  releaseCrossedCreationBinding(state, sibling.ref, new Date().toISOString(), 'worktree_create_failed');
  stampDispatchEvent(ticket, 'worktree-create-failure-held');
  putTicket(slug, ticket);
  return { ok: true, ticket, heldFor: sibling.ref };
}

function siblingKeepingCheckout(slug: string, projectPath: string, ticket: any, state: any) {
  if (!state?.worktree) return null;
  const holder = liveSiblingHoldingCheckout(slug, projectPath, ticket, state);
  if (holder) return { sibling: holder, message: crossBoundCheckoutRefusal(ticket.ref, holder.ref, state.worktree) };
  const unsettled = unsettledSessionSibling(slug, ticket, state);
  if (!unsettled) return null;
  return { sibling: unsettled, message: unsettledSiblingCheckoutRefusal(ticket.ref, unsettled.ref, state.worktree), parkedCheckout: parkedCreationRecord(state) };
}

// The binding is cleared, but the executor running in the kept checkout may be the unsettled sibling's, and only its
// claim can say so. The retired creation record stays on the ticket so that claim can take the checkout on an exact
// checkout-instance match (SQ-3139).
function parkedCreationRecord(state: any) {
  const record: any = { sessionId: state.sessionId, baseCommit: state.baseCommit };
  for (const field of CHECKOUT_BINDING_FIELDS) record[field] = state[field] === undefined ? null : state[field];
  return record;
}

function reclaimRetiredAttemptCheckout(slug: string, projectPath: string, ticket: any, state: any, facts?: any) {
  const decision = retiredAttemptCheckoutReclaim(slug, projectPath, ticket, state, facts);
  return decision?.reclaim ? decision.reclaim() : decision;
}

function retiredAttemptCheckoutReclaim(slug: string, projectPath: string, ticket: any, state: any, facts?: any) {
  const kept = siblingKeepingCheckout(slug, projectPath, ticket, state);
  if (!kept) return unclaimedDispatchWorktreeReclaim(projectPath, state, facts);
  return {
    worktree: state.worktree,
    reclaimed: false,
    reason: 'cross_bound_worktree',
    sibling: kept.sibling.ref,
    message: kept.message,
    parkedCheckout: kept.parkedCheckout,
  };
}

function unclaimedWorktreeRecoveryFacts(projectPath?: any, ticket?: any, state?: any) {
  const checkpointCommit = String(ticket?.checkpoint?.commit || ticket?.submission?.commit || '').trim();
  if (!checkpointCommit || !releaseFragmentOnlyCheckpoint(projectPath, ticket, checkpointCommit, state?.baseCommit)) {
    return { state, checkpointCommit: checkpointCommit || null };
  }
  const worktree = String(state?.worktree || '').trim();
  if (!worktree || !fs.existsSync(worktree)) return { state, checkpointCommit: null };
  try {
    const checkpointRevision = gitOutput(projectPath, ['rev-parse', '--verify', checkpointCommit + '^{commit}']);
    const worktreeRevision = gitOutput(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (checkpointRevision === worktreeRevision) {
      return { state: Object.assign({}, state, { baseCommit: checkpointRevision }), checkpointCommit: null };
    }
  } catch (_: any) {
  }
  return { state, checkpointCommit: null };
}

function reusablePreparedRecovery(ticket: any, current: any) {
  return Boolean(current && current.recovery && current.outcome === 'prepared' && ticket.dispatchNonce && canonicalPreparedDispatchExecutor(ticket));
}

// Only live-claim recovery reads `worktree`. A fresh attempt used to drop it silently, so a workingTreeDelivery
// ticket got a lease on the registered checkout and its executor then refused to write anywhere else (GH-162).
function dispatchWorktreeOverrideRefusal(ticket: any, worktree: unknown, projectPath: string): string | null {
  if (worktree == null || String(worktree).trim() === '') return null;
  const placement = ticket.workingTreeDelivery === true
    ? `${ticket.ref} declares workingTreeDelivery, so it runs and delivers in the board's registered checkout ${projectPath}; to deliver from a linked worktree instead, clear workingTreeDelivery so the ticket runs in an isolated worktree and submits a commit.`
    : 'sharedTree:true runs in the board\'s registered checkout and sharedTree:false in a board-provisioned worktree.';
  return `prepare dispatch: worktree only names a resumed executor's checkout for live-claim recovery with claimHolder; it cannot choose where a new attempt runs. ${placement}`;
}

// Ticket and dispatch rows are untyped persisted JSON throughout this store (getTicket and dispatchState return any).
// Typing them only inside these phases would be a partial schema the rest of the store never honours.
type StoredRecord = any;
type DispatchOptions = StoredRecord;
type CheckoutReclaimResult = { worktree: string; reclaimed: boolean; reason?: string; message?: string; branch?: string | null; branchKept?: string };
// Filesystem work a preparation stages: token files it writes before commit and retired checkouts it removes
// only after its write transaction commits.
type DispatchPreparationEffects = { prior: string | null; staged: string | null; checkoutReclaims: Array<() => CheckoutReclaimResult> };
type InstallFacts = { installPath: string | null; identity: string | null; version: string | null };
type DispatchPreflight = {
  projectPath: string; preparedCompatibility: StoredRecord | null; servingCompatibilityWarning: string | null;
  pythonIoEncoding: { written: boolean }; sourceRevisionAdapterSwitch: StoredRecord; snapshotPreflight: StoredRecord | null;
};
type GuardedDispatch = {
  crossBoundWorktree: CrossBoundWorktree | null; repeatFailure: string | null; unboundAttemptsSkipped: boolean;
  retainedContinuation: StoredRecord | null; resolvedPolicy: StoredRecord | null;
};
type CrossBoundWorktree = { sibling: string; worktree: string; message: string; parkedCheckout?: Record<string, unknown> };
type DispatchIsolation = {
  readonly: boolean; wholeTreeScope: boolean; reducedAgentSchema: boolean; reviewTargetState: StoredRecord | null;
  sharedTree: boolean; nonRepoOutput: boolean; worktreeWarning: string | null;
};
type ConfiguredIntegration = { integrationMode: string; worktreeBase: string };
type DirtyBaselines = { artifactDirtyBaseline: StoredRecord | null; dirtyBaselineCapture: StoredRecord | null; workingTreeDirtyBaseline: StoredRecord | null };

function dispatchSource(opts: DispatchOptions, fallback: string): string {
  return opts.source || opts.transport || fallback;
}

function retireUnboundDispatchOnly(slug: string, idOrRef: string, opts: DispatchOptions) {
  const superseded = supersedeUnboundAttempt(slug, idOrRef, {
    evidence: opts.recoveryEvidence,
    source: dispatchSource(opts, 'dispatch'),
    sessionId: opts.sessionId,
  });
  if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${idOrRef} has no unbound dispatch attempt to retire (${superseded.reason}).`}`);
  return Object.assign(superseded, { retired: true });
}

function undeclaredScopeRefusal(slug: string, ticket: StoredRecord, opts: DispatchOptions): string | null {
  const noDeclaredFileScope = unscopedWriteCannotAutoApprove(ticket, {
    dispatchReadOnly,
    normalizeFiles,
    autoApproveScope: boardConfig(slug)?.autoApproveScope,
  });
  return noDeclaredFileScope && opts.allowUnscoped !== true ? undeclaredWriteScopeRefusal(ticket.ref) : null;
}

function dispatchTicketRefusal(slug: string, found: StoredRecord, opts: DispatchOptions, projectPath: string): string | null {
  return dispatchWorktreeOverrideRefusal(found, opts.worktree, projectPath)
    || executorClaimDispatchRefusal(slug, opts.sessionId)
    || undeclaredScopeRefusal(slug, found, opts)
    || dispatchVerifyCommandError(found, projectPath);
}

function dispatchableTicket(slug: string, idOrRef: string, opts: DispatchOptions) {
  if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
  // A fresh native Agent session resolves plugins from Claude Code's registry
  // independently of whatever MCP roster this conversation happens to have
  // loaded, so a claim-first spawn spec is worthless unless the target
  // project actually has a runnable, board-MCP-capable install (SQ-1017).
  const projectPath: string = readMeta(slug)?.path;
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  const refusal = dispatchTicketRefusal(slug, found, opts, projectPath);
  if (refusal) throw new Error(refusal);
  return { projectPath, found };
}

function installFacts(install: Partial<InstallFacts> | null | undefined): InstallFacts {
  const facts = install ?? {};
  return { installPath: facts.installPath || null, identity: facts.identity || null, version: facts.version || null };
}

function preparedCompatibilityRecord(plugin: InstallFacts, serving: InstallFacts) {
  if (!plugin.installPath || !plugin.identity) return null;
  return Object.freeze({
    pluginInstall: plugin.installPath,
    identity: plugin.identity,
    version: plugin.version,
    ...(serving.installPath && serving.version ? { servingInstall: serving.installPath, servingVersion: serving.version } : {}),
  });
}

function assertServingNotOlder(ref: string, preparedCompatibility: StoredRecord | null, installCheck: StoredRecord | null, plugin: InstallFacts, serving: InstallFacts): void {
  if (!preparedCompatibility || !preparedCompatibilityHasProvenMismatch({ preparedCompatibility }, installCheck)) return;
  throw new Error(`prepare dispatch: ${ref} refused; serving Sidequest ${serving.version || 'unknown'} is older than prepared ${plugin.version || 'unknown'}. Restart Claude Code so the board serves the prepared build, then dispatch again.`);
}

function preparedInstallCompatibility(found: StoredRecord, projectPath: string) {
  const installCheck = projectPath ? assertSidequestInstall(projectPath) : null;
  const plugin = installFacts(installCheck);
  const serving = installFacts(servingInstall());
  const preparedCompatibility = preparedCompatibilityRecord(plugin, serving);
  assertServingNotOlder(found.ref, preparedCompatibility, installCheck, plugin, serving);
  return {
    preparedCompatibility,
    servingCompatibilityWarning: preparedCompatibility ? preparedCompatibilityWarning({ preparedCompatibility }, installCheck) : null,
  };
}

function supersedeEvidencedAttempt(slug: string, found: StoredRecord, opts: DispatchOptions): void {
  if (!opts.recoveryEvidence) return;
  const superseded = supersedeUnboundAttempt(slug, found.id, {
    evidence: opts.recoveryEvidence,
    source: dispatchSource(opts, 'dispatch'),
    sessionId: opts.sessionId,
  });
  if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${found.ref} has no unbound dispatch attempt to supersede (${superseded.reason}).`}`);
}

function preparedDispatchEnvironment(slug: string, found: StoredRecord, idOrRef: string, projectPath: string) {
  const pythonIoEncoding = projectPath ? ensurePythonIoEncoding(projectPath) : { written: false };
  const sourceRevisionAdapterSwitch = takeSourceRevisionAdapterSwitch(slug);
  const captureFilesystemSnapshot = withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    return !reusablePreparedRecovery(ticket, dispatchState(ticket));
  });
  const snapshotPreflight = captureFilesystemSnapshot
    ? dispatchFilesystemSnapshotPreflight(slug, found, new Date().toISOString())
    : null;
  return { pythonIoEncoding, sourceRevisionAdapterSwitch, snapshotPreflight };
}

function pendingCandidateIdentity(submission: StoredRecord): string {
  return String(submission.commit || submission.sourceRevision?.value || '').trim();
}

// A pending submission is a terminal outcome parked for the publish transaction, so preparing over it
// minted a second attempt that outranked the submitted one in pulse while the submission stayed valid
// (SQ-2117). Anything reading current dispatch.agentId then reads an executor that never touched the
// candidate. Rework is the path that dispatches again: it clears the submission first.
function assertNoPendingSubmission(t: StoredRecord): void {
  if (!pendingSubmission(t)) return;
  const candidate = pendingCandidateIdentity(t.submission);
  throw new Error(`prepare dispatch: ${t.ref} has a pending submission${candidate ? ` (${candidate})` : ''} waiting on integration, so it is parked for the publish transaction rather than for another executor. Integrate it (\`sidequest integrate ${t.ref} --by <who>\`), send it back for repair and dispatch the replacement (\`sidequest rework ${t.ref} --by ${t.submission.by || '<candidate-owner>'} --review <review-ticket-or-evidence> --reason "what needs repair"\`), or close it as abandoned (\`sidequest groom-close ${t.ref} --abandon-submission --reason "<evidence it never landed>"\`).`);
}

function hasClaimHolder(t: StoredRecord): boolean {
  return Boolean(t.claim?.by);
}

function unclaimedRetiredIsolatedAttempt(t: StoredRecord, current: StoredRecord): boolean {
  return Boolean(current?.terminalAt) && current.sharedTree === false && !current.claimedAt && !hasClaimHolder(t);
}

// A composition admission adopts exact C into a genuinely new checkout, so it never reclaims or resumes the
// released attempt's retained checkout: that checkout and its proofs stay untouched.
function reclaimsRetiredCheckout(slug: string, projectPath: string, t: StoredRecord, current: StoredRecord): boolean {
  if (t.compositionAdmission) return false;
  return unclaimedRetiredIsolatedAttempt(t, current) && !checkoutBelongsToAnotherDispatchAgent(slug, projectPath, t, current);
}

function retainedRecoveryBlocked(recovery: StoredRecord): boolean {
  return Boolean(recovery) && recovery.reclaimed === false && recovery.discardable !== true && recovery.retainedCheckout !== true;
}

function checkpointRecoveryHint(t: StoredRecord, current: StoredRecord): string {
  const checkpointCommit = String(t.checkpoint?.commit || '').trim();
  return checkpointCommit
    ? ` Restore ${current.worktree} to checkpoint ${checkpointCommit}, then dispatch again; the board will resume that retained checkout without creating another.`
    : '';
}

function unretryableRecoveryMessage(t: StoredRecord, current: StoredRecord, recovery: StoredRecord): string {
  const reason = recovery.message || `immutable recovery fact ${recovery.reason || 'is unreadable'}`;
  return `prepare dispatch: ${t.ref} cannot retry because ${reason}${checkpointRecoveryHint(t, current)}`;
}

function assertRetainedRecoveryContinues(slug: string, t: StoredRecord, current: StoredRecord, recovery: StoredRecord): void {
  if (retainedRecoveryBlocked(recovery) && !retainedWorktreeContinuationState(slug, t, current)?.continuation) {
    throw new Error(unretryableRecoveryMessage(t, current, recovery));
  }
}

function queueCheckoutReclaim(effects: DispatchPreparationEffects, decision: { reclaim?: () => CheckoutReclaimResult } | null): void {
  if (decision?.reclaim) effects.checkoutReclaims.push(decision.reclaim);
}

function reclaimRetiredCheckout(slug: string, projectPath: string, t: StoredRecord, current: StoredRecord, effects: DispatchPreparationEffects): CrossBoundWorktree | null {
  if (!reclaimsRetiredCheckout(slug, projectPath, t, current)) return null;
  const recoveryFacts = unclaimedWorktreeRecoveryFacts(projectPath, t, current);
  const recovery = retiredAttemptCheckoutReclaim(slug, projectPath, t, recoveryFacts.state, {
    checkpointCommit: recoveryFacts.checkpointCommit,
  });
  queueCheckoutReclaim(effects, recovery);
  if (recovery?.reason === 'cross_bound_worktree') {
    releaseCrossedCreationBinding(current, recovery.sibling, new Date().toISOString(), 'cross_bound_supersede');
    return { sibling: recovery.sibling, worktree: recovery.worktree, message: recovery.message, parkedCheckout: recovery.parkedCheckout };
  }
  assertRetainedRecoveryContinues(slug, t, current, recovery);
  return null;
}

function liveUnclaimedRuntimeAttempt(t: StoredRecord, current: StoredRecord): boolean {
  return Boolean(current) && !current.terminalAt && !hasClaimHolder(t) && Boolean(current.launchedAt || current.boundAt);
}

function liveAttemptRecoveryHint(t: StoredRecord, current: StoredRecord, sessionId: string | undefined): string {
  const evidenceCall = `so the orchestrator can supersede it in one call: \`sidequest dispatch ${t.ref} --recovery-evidence "<observed failed-claim evidence>"\`.`;
  if (!evidenceRetirableAttempt(t, current, Date.now(), sessionId)) {
    return ` Wait for that executor's terminal hook, then dispatch once from the returned todo state; do not mint a replacement token while it is still winding down. It is ${evidenceSupersessionBlocker(t, current)}.`;
  }
  return unboundEvidenceAttempt(current)
    ? ` It is unbound and unclaimed, ${evidenceCall}`
    : ` It never claimed, so if you observed the host report that runtime gone: ${evidenceCall}`;
}

function assertNoLiveRuntimeAttempt(t: StoredRecord, current: StoredRecord, opts: DispatchOptions): void {
  if (!liveUnclaimedRuntimeAttempt(t, current)) return;
  throw new Error(`prepare dispatch: ${t.ref} already has a live dispatch attempt (${pulseDispatchState(current)}).${liveAttemptRecoveryHint(t, current, opts.sessionId)}`);
}

// A composition needs a genuine new checkout instance at C, so it never continues a retained one.
function retainedContinuationCandidate(slug: string, t: StoredRecord, current: StoredRecord): StoredRecord | null {
  return t.compositionAdmission ? null : retainedWorktreeContinuationState(slug, t, current);
}

function assertNoLiveClaim(t: StoredRecord): void {
  if (hasClaimHolder(t) && !claimReclaimable(t)) {
    throw new Error(`prepare dispatch: ${t.ref} has a live claim by ${t.claim.by}. Release it (\`sidequest release ${t.ref} --by ${t.claim.by}\`) before dispatching again.`);
  }
}

function applyFreshPolicyRoute(t: StoredRecord, current: StoredRecord, resolvedPolicy: StoredRecord | null): void {
  if (current?.recovery || !resolvedPolicy) return;
  t.model = resolvedPolicy.model;
  t.effort = resolvedPolicy.effort;
  t.exec = execProjection(resolvedPolicy.exec);
}

function resolveDispatchRoutePolicy(slug: string, t: StoredRecord, current: StoredRecord): StoredRecord | null {
  rederiveUnlaunchedPreparedRoute(t, slug);
  const resolvedPolicy = resolveTicketRoute(t, getCategory(ticketCategory(t), { project: slug }));
  applyFreshPolicyRoute(t, current, resolvedPolicy);
  if (resolvedPolicy?.refusal) throw new Error(resolvedPolicy.refusal);
  return resolvedPolicy;
}

// A record prepared before launch naming existed still has to hand back a
// usable name, and reusing it must not renumber the sequence.
function ensurePreparedLaunchName(t: StoredRecord, current: StoredRecord): void {
  if (!current.launchSeq) current.launchSeq = 1;
  if (current.launchName) return;
  const route = current.route || { model: t.model, effort: t.effort };
  current.launchName = dispatchLaunchName(t.ref, t.title, resolveExec(route.model, route.effort), route.effort, current.launchSeq);
}

function reusePreparedRecovery(slug: string, t: StoredRecord, current: StoredRecord, opts: DispatchOptions) {
  if (opts.sessionId) current.sessionId = String(opts.sessionId);
  ensurePreparedLaunchName(t, current);
  return {
    ok: true,
    ticket: t,
    token: t.dispatchNonce,
    reused: true,
    recovery: current.recovery,
  };
}

function pendingRecoveryFallback(current: StoredRecord, currentRoute: StoredRecord | null): boolean {
  return Boolean(current?.recovery) && !current.terminalAt && !currentRoute;
}

function applyRecoveryFallback(t: StoredRecord, current: StoredRecord, currentRoute: StoredRecord | null): void {
  if (!pendingRecoveryFallback(current, currentRoute)) return;
  const replacement = resolveCategoryFallback(t.category, current.recovery.failedModel);
  if (!replacement) throw new Error(`prepare dispatch: no fallback remains available for ${current.recovery.failedModel}.`);
  t.model = replacement.model;
  t.effort = replacement.effort;
  t.exec = execProjection(replacement.exec);
  current.recovery = Object.assign({}, current.recovery, {
    fallbackSource: replacement.source,
    model: replacement.model,
    effort: replacement.effort,
  });
}

function guardLockedDispatch(slug: string, t: StoredRecord, current: StoredRecord, opts: DispatchOptions, projectPath: string, effects: DispatchPreparationEffects) {
  assertNoPendingSubmission(t);
  const crossBoundWorktree = reclaimRetiredCheckout(slug, projectPath, t, current, effects);
  assertNoLiveRuntimeAttempt(t, current, opts);
  const repeatFailure = repeatNoCommitDispatchError(t, current);
  const unboundAttemptsSkipped = skippedUnboundNoCommitAttempts(current);
  if (repeatFailure && opts.allowRepeatFailure !== true) throw new Error(repeatFailure);
  const retainedContinuation = retainedContinuationCandidate(slug, t, current);
  assertNoLiveClaim(t);
  return { crossBoundWorktree, repeatFailure, unboundAttemptsSkipped, retainedContinuation };
}

function prepareLockedDispatch(slug: string, idOrRef: string, found: StoredRecord, opts: DispatchOptions, preflight: DispatchPreflight, effects: DispatchPreparationEffects) {
  const t = getTicket(slug, found.id);
  if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  const current = dispatchState(t);
  const guarded = guardLockedDispatch(slug, t, current, opts, preflight.projectPath, effects);
  const resolvedPolicy = resolveDispatchRoutePolicy(slug, t, current);
  const currentRoute = activeDispatchRoute(t);
  if (reusablePreparedRecovery(t, current)) return reusePreparedRecovery(slug, t, current, opts);
  applyRecoveryFallback(t, current, currentRoute);
  return mintPreparedDispatch(slug, t, current, opts, preflight, effects, { ...guarded, resolvedPolicy });
}

function blankEffort(effort: unknown): boolean {
  return effort == null || String(effort).trim() === '';
}

function defaultClaudeEffort(t: StoredRecord): void {
  const backend = availableRoute(t.model);
  if (backend?.backend !== 'claude' || !blankEffort(t.effort)) return;
  t.effort = 'low';
  t.exec = execProjection(resolveExec(t.model, t.effort));
}

function preparedExecutableRoute(slug: string, t: StoredRecord, opts: DispatchOptions) {
  const refusal = dispatchRouteRefusal({ model: t.model, effort: t.effort });
  if (refusal) throw new Error(refusal);
  const preparedExec = resolveExec(t.model, t.effort);
  if (!preparedExec) throw new Error(`prepare dispatch: ${t.ref} has no executable route.`);
  const scopeRefusal = undeclaredScopeRefusal(slug, t, opts);
  if (scopeRefusal) throw new Error(scopeRefusal);
  return preparedExec;
}

function policyFallbackReason(current: StoredRecord, resolvedPolicy: StoredRecord | null): string | null {
  return !current?.recovery && resolvedPolicy?.fallbackReason || null;
}

function routedRecovery(t: StoredRecord, current: StoredRecord): StoredRecord | null {
  return current?.recovery && activeDispatchRoute(t) ? current.recovery : null;
}

function priorAttemptHistory(current: StoredRecord) {
  return {
    attempts: Array.isArray(current?.attempts) ? current.attempts.slice() : [],
    supersededTokens: Array.isArray(current?.supersededTokens) ? current.supersededTokens.slice() : [],
  };
}

function liveDispatchToken(t: StoredRecord, current: StoredRecord): boolean {
  return Boolean(current) && !current.terminalAt && Boolean(t.dispatchNonce);
}

function supersedeLiveToken(projectPath: string, t: StoredRecord, current: StoredRecord, supersededTokens: StoredRecord[], now: string, effects: DispatchPreparationEffects): void {
  if (!liveDispatchToken(t, current)) return;
  if (current.outcome === 'prepared' && current.sharedTree === false) {
    queueCheckoutReclaim(effects, unclaimedDispatchWorktreeReclaim(projectPath, current));
  }
  supersededTokens.push({
    digest: dispatchTokenDigest(t.dispatchNonce),
    tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
    at: now,
  });
}

// A released dispatch hands its binding to the next attempt so a
// continuation keeps the same worktree scope. An EMPTY released binding
// must not be inherited: it pinned the first attempt's missing scope onto
// every re-dispatch, so the ticket's files were never re-read and editing
// them changed nothing. A STALE one has the same disease: files expanded
// between a handback and the re-dispatch must reach the new binding, so the
// carryover unions with the current effective scope instead of replacing it
// (the-bot-resurrection SQ-825: a path granted after a handback never
// entered the redispatch binding and had to ship as an out-of-band commit).
function releasedDeclaredBinding(current: StoredRecord): string[] | null {
  return current?.outcome === 'released' && Array.isArray(current.declaredFiles) && current.declaredFiles.length
    ? current.declaredFiles.filter((file: string) => file !== WHOLE_TREE_SCOPE)
    : null;
}

function dispatchEffectiveFiles(slug: string, t: StoredRecord, current: StoredRecord): string[] {
  const releasedBinding = releasedDeclaredBinding(current);
  return releasedBinding
    ? Array.from(new Set([...releasedBinding, ...effectiveScope(slug, t)]))
    : effectiveScope(slug, t);
}

function wholeTreeScopeOverride(t: StoredRecord, opts: DispatchOptions, readonly: boolean): boolean {
  return !readonly && opts.allowUnscoped === true && !normalizeFiles(t.files).length;
}

function requestedSharedTree(opts: DispatchOptions, current: StoredRecord): boolean {
  return opts.sharedTree === true || (!Object.hasOwn(opts, 'sharedTree') && Boolean(current?.sharedTree));
}

function requestedReducedAgentSchema(opts: DispatchOptions, current: StoredRecord): boolean {
  return opts.reducedAgentSchema === true || (!Object.hasOwn(opts, 'reducedAgentSchema') && current?.reducedAgentSchema === true);
}

function initialSharedTree(reviewTargetState: StoredRecord | null, worktreeIsolation: boolean, requested: boolean): boolean {
  if (reviewTargetState) return false;
  return worktreeIsolation ? requested : true;
}

function isolatedCheckoutWarning(slug: string, sharedTree: boolean, readonly: boolean, effectiveFiles: readonly string[]): string | null {
  return !sharedTree && (readonly || effectiveFiles.length) ? worktreeIsolationWarning(slug, readonly) : null;
}

function isolationWarning(slug: string, worktreeIsolation: boolean, explicitIsolation: boolean, sharedTree: boolean, readonly: boolean, effectiveFiles: readonly string[]): string | null {
  if (!worktreeIsolation && explicitIsolation) {
    return `Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. ${sharedTreeExecutionGuidance(readonly)}`;
  }
  return isolatedCheckoutWarning(slug, sharedTree, readonly, effectiveFiles);
}

function assertReviewCheckoutIsolation(t: StoredRecord, reviewTargetState: StoredRecord | null, opts: DispatchOptions, worktreeWarning: string | null): void {
  if (!reviewTargetState) return;
  if (opts.sharedTree === true) {
    throw new Error(`prepare dispatch: ${t.ref} reviews candidate ${reviewTargetState.candidate.value} and requires an isolated immutable checkout.`);
  }
  if (worktreeWarning) throw new Error(`prepare dispatch: ${t.ref} cannot pin the immutable candidate checkout. ${worktreeWarning}`);
}

function dispatchIsolation(slug: string, t: StoredRecord, current: StoredRecord, opts: DispatchOptions, effectiveFiles: readonly string[]): DispatchIsolation {
  const readonly = dispatchReadOnly(t);
  const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
  const reviewTargetState = reviewDispatchTarget(slug, t);
  const sharedTree = initialSharedTree(reviewTargetState, worktreeIsolation, requestedSharedTree(opts, current));
  const explicitIsolation = Object.hasOwn(opts, 'sharedTree') && opts.sharedTree === false;
  const worktreeWarning = isolationWarning(slug, worktreeIsolation, explicitIsolation, sharedTree, readonly, effectiveFiles);
  assertReviewCheckoutIsolation(t, reviewTargetState, opts, worktreeWarning);
  return {
    readonly,
    wholeTreeScope: wholeTreeScopeOverride(t, opts, readonly),
    reducedAgentSchema: requestedReducedAgentSchema(opts, current),
    reviewTargetState,
    sharedTree: sharedTree || Boolean(worktreeWarning),
    nonRepoOutput: nonRepoExternalOutput(t, effectiveFiles),
    worktreeWarning,
  };
}

function writableIsolatedRepositoryCheckout(isolation: DispatchIsolation): boolean {
  return !(isolation.sharedTree || isolation.readonly || isolation.nonRepoOutput || isolation.wholeTreeScope);
}

function assertCompositionCheckout(t: StoredRecord, isolation: DispatchIsolation): void {
  if (t.compositionAdmission && !writableIsolatedRepositoryCheckout(isolation)) {
    throw new Error(`prepare dispatch: ${t.ref} composition admission requires a scoped writable native isolated repository checkout.`);
  }
}

function sharedTreeScopeRefusal(t: StoredRecord, isolation: DispatchIsolation, effectiveFiles: readonly string[]): string | null {
  if (isolation.wholeTreeScope && isolation.sharedTree) return unscopedSharedTreeRefusal(t.ref, effectiveFiles);
  if (t.workingTreeDelivery === true && !isolation.sharedTree) {
    return `prepare dispatch: ${t.ref} declares a working-tree deliverable and must run in the shared checkout. Re-dispatch with sharedTree:true.`;
  }
  return null;
}

function dispatchRuntimeRefusal(slug: string, t: StoredRecord, sharedTree: boolean, projectPath: string, opts: DispatchOptions): string | null {
  return sharedTree
    ? sharedTreeRuntimeRefusal(t, projectPath, opts.runtimeCwd)
    : isolatedTreeRuntimeRefusal(t, projectPath, opts.runtimeCwd, slug, opts.sessionId);
}

function assertDispatchCheckoutShape(slug: string, t: StoredRecord, isolation: DispatchIsolation, effectiveFiles: readonly string[], projectPath: string, opts: DispatchOptions): void {
  assertCompositionCheckout(t, isolation);
  const refusal = sharedTreeScopeRefusal(t, isolation, effectiveFiles) || dispatchRuntimeRefusal(slug, t, isolation.sharedTree, projectPath, opts);
  if (refusal) throw new Error(refusal);
}

function workingTreeDeliveryRequested(t: StoredRecord, sharedTree: boolean, effectiveFiles: readonly string[]): boolean {
  return sharedTree && t.workingTreeDelivery === true && effectiveFiles.length > 0;
}

function deliveryVerification(slug: string, t: StoredRecord, sharedTree: boolean, effectiveFiles: readonly string[]) {
  const workingTreeDelivery = workingTreeDeliveryRequested(t, sharedTree, effectiveFiles);
  const verificationRequirement = boardVerificationRequirement(slug, t, sharedTree);
  if (workingTreeDelivery && verificationRequirement.kind === 'review') {
    throw new Error(`prepare dispatch: ${t.ref} working-tree delivery cannot use review verification because executor evidence has no independent reviewer provenance.`);
  }
  return { workingTreeDelivery, verificationRequirement };
}

function dispatchArtifactRoot(slug: string, t: StoredRecord, sharedTree: boolean, effectiveFiles: readonly string[]): string | null {
  return sharedTree && effectiveFiles.length === 1 && sharedTreeArtifactRequested(t)
    ? categoryArtifactRoot(getCategory(ticketCategory(t), { project: slug }), effectiveFiles[0])
    : null;
}

function dispatchWriteScope(t: StoredRecord, effectiveFiles: string[], wholeTreeScope: boolean, artifactMode: boolean) {
  const writeScope = wholeTreeScope ? [WHOLE_TREE_SCOPE, ...effectiveFiles] : effectiveFiles;
  const declaredFiles: string[] = artifactMode ? effectiveFiles : commitScope.ticketCommitScope(writeScope, t.files, t.ref);
  const boardAddedFiles = declaredFiles.filter((file: string) => file !== WHOLE_TREE_SCOPE && !commitScope.isInScope(file, t.files));
  return { declaredFiles, boardAddedFiles };
}

function workingTreeDirtyBaseline(dirtyBaselineCapture: StoredRecord | null, workingTreeDelivery: boolean): StoredRecord | null {
  return workingTreeDelivery ? dirtyBaselineCapture?.baseline || null : null;
}

function dispatchDirtyBaselines(slug: string, sharedTree: boolean, artifactMode: boolean, artifactScope: string | null | undefined, workingTreeDelivery: boolean): DirtyBaselines {
  const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
  const dirtyBaselineCapture = sharedTree && !artifactMode ? captureDirtyBaseline(slug) : null;
  return { artifactDirtyBaseline, dirtyBaselineCapture, workingTreeDirtyBaseline: workingTreeDirtyBaseline(dirtyBaselineCapture, workingTreeDelivery) };
}

function dispatchArtifactScope(slug: string, t: StoredRecord, isolation: DispatchIsolation, effectiveFiles: string[], workingTreeDelivery: boolean) {
  const artifactRoot = dispatchArtifactRoot(slug, t, isolation.sharedTree, effectiveFiles);
  const artifactMode = Boolean(artifactRoot);
  const artifactScope = artifactMode ? effectiveFiles[0] : null;
  return {
    artifactRoot, artifactMode, artifactScope,
    ...dispatchWriteScope(t, effectiveFiles, isolation.wholeTreeScope, artifactMode),
    ...dispatchDirtyBaselines(slug, isolation.sharedTree, artifactMode, artifactScope, workingTreeDelivery),
  };
}

function storyDispatchFacts(slug: string, t: StoredRecord) {
  const story = t.storyId ? getStory(slug, t.storyId) : null;
  const storyLogRevision = Number(story?.logRevision) || 0;
  t.storyLogSeenSeq = storyLogRevision;
  return { contract: storyExecutionContract(story), storyLogRevision, contractDrift: t.storyContractDrift || null };
}

function configuredIntegration(slug: string): ConfiguredIntegration {
  return {
    integrationMode: String(readMeta(slug)?.integrationMode || 'auto').trim().toLowerCase(),
    worktreeBase: boardConfig(slug)?.worktreeBase || 'auto',
  };
}

function explicitIntegrationTargetRequested(opts: DispatchOptions): boolean {
  return opts.integrationBranch != null || opts.integrationMode != null;
}

function isolatedRepositoryDispatch(isolation: DispatchIsolation): boolean {
  return !isolation.sharedTree && !isolation.readonly && !isolation.nonRepoOutput;
}

function automaticWorktreeBaseEligible(isolation: DispatchIsolation, worktreeBase: string): boolean {
  return isolatedRepositoryDispatch(isolation)
    || (!isolation.sharedTree && isolation.readonly && !isolation.nonRepoOutput && worktreeBase !== 'auto');
}

function remoteIntegrationTarget(slug: string, worktreeBase: string) {
  try {
    return integrationTarget(slug, { mode: 'remote' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} The configured worktreeBase is "${worktreeBase}"; use --worktree-base local-main to dispatch from the local integration branch.`);
  }
}

function aheadLocalOrRemoteTarget(slug: string, projectPath: string, worktreeBase: string) {
  let localTarget;
  try {
    localTarget = integrationTarget(slug, { mode: 'local' });
  } catch (_: unknown) {
    return remoteIntegrationTarget(slug, worktreeBase);
  }
  return localAheadOfUpstreamWarning(projectPath, localTarget.branch)
    ? localTarget
    : remoteIntegrationTarget(slug, worktreeBase);
}

function autoSelectedIntegrationTarget(slug: string, worktreeBase: string) {
  const projectPath = readMeta(slug)?.path || '';
  if (!hasOriginRemote(projectPath)) return null;
  return aheadLocalOrRemoteTarget(slug, projectPath, worktreeBase);
}

function originMainIntegrationTarget(slug: string, worktreeBase: string) {
  return hasOriginRemote(readMeta(slug)?.path || '') ? remoteIntegrationTarget(slug, worktreeBase) : null;
}

function configuredWorktreeBaseTarget(slug: string, worktreeBase: string) {
  if (worktreeBase === 'local-main') return integrationTarget(slug, { mode: 'local' });
  if (worktreeBase === 'origin-main') return originMainIntegrationTarget(slug, worktreeBase);
  return autoSelectedIntegrationTarget(slug, worktreeBase);
}

function automaticWorktreeBase(slug: string, isolation: DispatchIsolation, configured: ConfiguredIntegration) {
  return automaticWorktreeBaseEligible(isolation, configured.worktreeBase) && configured.integrationMode === 'auto'
    ? configuredWorktreeBaseTarget(slug, configured.worktreeBase)
    : null;
}

function explicitIntegrationTargetSelection(opts: DispatchOptions) {
  return {
    ...(opts.integrationBranch != null ? { branch: opts.integrationBranch } : {}),
    ...(opts.integrationMode != null ? { mode: opts.integrationMode } : {}),
  };
}

function dispatchIntegrationTarget(slug: string, opts: DispatchOptions, isolation: DispatchIsolation) {
  if (explicitIntegrationTargetRequested(opts)) return integrationTarget(slug, explicitIntegrationTargetSelection(opts));
  const configured = configuredIntegration(slug);
  const automatic = automaticWorktreeBase(slug, isolation, configured);
  const configuredTarget = isolatedRepositoryDispatch(isolation) && configured.integrationMode !== 'auto';
  return automatic || (configuredTarget ? integrationTarget(slug) : null);
}

function integrationTargetLabel(integrationTargetState: StoredRecord): string {
  return integrationTargetState.mode === 'local' ? `local ${integrationTargetState.branch}` : integrationTargetState.upstream;
}

function localAheadIntegrationWarning(slug: string, sharedTree: boolean, integrationTargetState: StoredRecord | null): StoredRecord | null {
  return !sharedTree && integrationTargetState
    ? localAheadOfUpstreamWarning(readMeta(slug)?.path || '', integrationTargetState.branch, integrationTargetLabel(integrationTargetState))
    : null;
}

function integrationBaseCommit(slug: string, integrationTargetState: StoredRecord | null): string {
  const projectPath = readMeta(slug)?.path || '';
  return integrationTargetState ? integrationTargetCommit(projectPath, integrationTargetState) : commitScope.headCommit(projectPath);
}

// A composition keeps its ORIGINAL BASE as the range floor for every control, capture, submit and integrate
// consumer. Only native checkout creation reads C, from the separate dispatch.compositionAdmission fence.
function dispatchBaseCommit(slug: string, t: StoredRecord, reviewTargetState: StoredRecord | null, integrationTargetState: StoredRecord | null): string {
  if (t.compositionAdmission) return t.compositionAdmission.base;
  if (reviewTargetState?.candidate.source === 'git') return reviewTargetState.candidate.value;
  return integrationBaseCommit(slug, integrationTargetState);
}

function publishBranchRef(slug: string, integrationTargetState: StoredRecord | null): string {
  return `refs/remotes/origin/${integrationTargetState?.branch || boardConfig(slug)?.integrationBranch || 'main'}`;
}

// A direct cut (cut.mjs --push without --prepare) tags its release commit
// before it runs the release suites and only pushes once they pass, so between
// those two moments local main sits on a tip that may still be rewound.
// Baselining a dispatch there hands the executor a checkout forked from a
// commit the branch rewinds past, and the candidate's submission range then
// comes back as [release commit, candidate] and fails outside_scope (SQ-2776
// reproduced it). Refusing is the conservative half of the fix: silently
// baselining somewhere other than the branch the board recorded is its own
// class of confusion, and the window is minutes. The prepare/finalize flow
// cannot produce this state: preparation creates no tag at all, and finalize
// only tags a commit the remote publish branch already carries.
function assertPublishedReleaseBaseline(slug: string, t: StoredRecord, projectPath: string, baseCommit: string, integrationTargetState: StoredRecord | null): void {
  const releaseTip = projectPath ? commitScope.unpublishedReleaseTip(projectPath, baseCommit, publishBranchRef(slug, integrationTargetState)) : null;
  if (releaseTip) {
    throw new Error(`prepare dispatch: ${t.ref} refused; baseline ${releaseTip.commit} is an unpublished release commit, tagged ${releaseTip.tags.join(', ')} and not yet on the remote branch. A direct release cut tags its commit before running its suites, so this is either a direct cut still in flight or one that failed and left its commit live. The prepare/finalize flow never reaches this state: preparation creates no tag, and finalize only tags a commit the remote branch already has. Wait for the cut to finish and push, or tear it down (delete those tags and reset the branch), then dispatch again.`);
  }
}

function planPreparedDispatch(slug: string, t: StoredRecord, current: StoredRecord, opts: DispatchOptions, preflight: DispatchPreflight, effects: DispatchPreparationEffects, guarded: GuardedDispatch) {
  const now = new Date().toISOString();
  defaultClaudeEffort(t);
  const preparedExec = preparedExecutableRoute(slug, t, opts);
  const fallbackReason = policyFallbackReason(current, guarded.resolvedPolicy);
  const recovery = routedRecovery(t, current);
  const history = priorAttemptHistory(current);
  supersedeLiveToken(preflight.projectPath, t, current, history.supersededTokens, now, effects);
  effects.prior = dispatchTokenFile(t);
  const effectiveFiles = dispatchEffectiveFiles(slug, t, current);
  const isolation = dispatchIsolation(slug, t, current, opts, effectiveFiles);
  assertDispatchCheckoutShape(slug, t, isolation, effectiveFiles, preflight.projectPath, opts);
  const delivery = deliveryVerification(slug, t, isolation.sharedTree, effectiveFiles);
  const artifact = dispatchArtifactScope(slug, t, isolation, effectiveFiles, delivery.workingTreeDelivery);
  t.dispatchExecutor = stableExecutorName(t, artifact.artifactMode || delivery.workingTreeDelivery);
  const launchSeq = nextDispatchLaunchSeq(current);
  const story = storyDispatchFacts(slug, t);
  const integrationTargetState = dispatchIntegrationTarget(slug, opts, isolation);
  const localAheadWarning = localAheadIntegrationWarning(slug, isolation.sharedTree, integrationTargetState);
  delete t.storyContractDrift;
  const evidenceDirectory = ticketEvidenceDirectory(slug, t.ref, preflight.projectPath);
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const baseCommit = dispatchBaseCommit(slug, t, isolation.reviewTargetState, integrationTargetState);
  const releasedContinuation = explicitBaseContinuation(guarded.retainedContinuation, explicitIntegrationTargetRequested(opts), integrationTargetState, baseCommit);
  assertPublishedReleaseBaseline(slug, t, preflight.projectPath, baseCommit, integrationTargetState);
  const dispatchBaseline = dispatchBaselineForProject(slug, t, now, baseCommit, isolation.nonRepoOutput, preflight.snapshotPreflight);
  return {
    now, preparedExec, fallbackReason, recovery, history, effectiveFiles, isolation, delivery, artifact, launchSeq, story,
    integrationTargetState, localAheadWarning, evidenceDirectory, baseCommit, releasedContinuation, dispatchBaseline, guarded,
  };
}

type PreparedDispatchPlan = ReturnType<typeof planPreparedDispatch>;

function preparingSessionId(opts: DispatchOptions): string | null {
  return opts.sessionId ? String(opts.sessionId) : null;
}

function preparationProvenanceFields(plan: PreparedDispatchPlan, opts: DispatchOptions, preparedCompatibility: StoredRecord | null) {
  return {
    lifecycleAttempt: prepareAttempt(
      plan.dispatchBaseline,
      Object.freeze({ actor: dispatchPreparationAttribution(opts), operation: 'prepare', sessionId: preparingSessionId(opts) }),
      preparedCompatibility
        ? Object.freeze({ pluginInstall: preparedCompatibility.pluginInstall, identity: preparedCompatibility.identity })
        : undefined,
      plan.delivery.verificationRequirement,
    ),
    verificationRequirement: plan.delivery.verificationRequirement,
    evidenceDirectory: plan.evidenceDirectory,
    sessionId: preparingSessionId(opts),
    preparedBy: dispatchPreparationAttribution(opts),
    ...(preparedCompatibility ? { preparedCompatibility } : {}),
  };
}

function runtimeEnvironmentFields(pythonIoEncoding: { written: boolean }, opts: DispatchOptions) {
  return {
    ...(pythonIoEncoding.written ? { pythonIoEncoding } : {}),
    ...(opts.dispatchSkew ? { dispatchSkew: opts.dispatchSkew } : {}),
  };
}

function checkoutPlacementFields(plan: PreparedDispatchPlan, preflight: DispatchPreflight, opts: DispatchOptions) {
  return {
    sharedTree: plan.isolation.sharedTree,
    ...(plan.isolation.reducedAgentSchema ? { reducedAgentSchema: true } : {}),
    ...(plan.isolation.worktreeWarning ? { worktreeWarning: plan.isolation.worktreeWarning } : {}),
    ...(plan.guarded.crossBoundWorktree ? { crossBoundWorktree: plan.guarded.crossBoundWorktree } : {}),
    ...runtimeEnvironmentFields(preflight.pythonIoEncoding, opts),
  };
}

function isolatedContinuationFields(sharedTree: boolean, releasedContinuation: StoredRecord | null) {
  const continuation = releasedContinuation?.continuation;
  if (sharedTree || !continuation) return {};
  return {
    continuation,
    worktree: continuation.sourceWorktree,
    worktreeGitDirectory: continuation.lease.boundGitDirectory,
    worktreeCommonGitDirectory: continuation.lease.boundCommonGitDirectory,
    worktreeCheckoutInstance: continuation.lease.boundCheckoutInstance,
    worktreeObservedRevision: continuation.lease.boundRevision,
    worktreeBindingSource: 'continuation',
  };
}

function sharedTreeContinuationFallback(sharedTree: boolean, releasedContinuation: StoredRecord | null) {
  return sharedTree && releasedContinuation?.continuation
    ? { continuationFallback: continuationFallback('continuation_checkpoint_requires_isolated_worktree', releasedContinuation.continuation.sourceWorktree) }
    : {};
}

function continuationFields(sharedTree: boolean, releasedContinuation: StoredRecord | null) {
  return {
    ...isolatedContinuationFields(sharedTree, releasedContinuation),
    ...(releasedContinuation?.fallback ? { continuationFallback: releasedContinuation.fallback } : {}),
    ...sharedTreeContinuationFallback(sharedTree, releasedContinuation),
  };
}

function integrationFields(t: StoredRecord, plan: PreparedDispatchPlan) {
  return {
    // Record the integration target commit so an isolated executor can bring
    // its harness-created worktree forward before changing it.
    baseCommit: plan.baseCommit,
    ...(plan.isolation.reviewTargetState ? { reviewTarget: t.reviewTarget } : {}),
    ...(plan.integrationTargetState ? { integrationTarget: plan.integrationTargetState } : {}),
    ...(plan.localAheadWarning ? { localAheadWarning: plan.localAheadWarning } : {}),
  };
}

function unscopedOverrideFields(slug: string, wholeTreeScope: boolean, opts: DispatchOptions, now: string) {
  if (!wholeTreeScope) return {};
  return {
    unscopedOverride: {
      at: now,
      source: dispatchSource(opts, 'store'),
      writeScope: unscopedWriteScopeLine(boardConfig(slug)?.alwaysInScope),
    },
  };
}

function artifactFields(plan: PreparedDispatchPlan) {
  return {
    ...(plan.isolation.nonRepoOutput ? { nonRepoOutput: true } : {}),
    artifactMode: plan.artifact.artifactMode,
    artifactRoot: plan.artifact.artifactRoot,
    artifactScope: plan.artifact.artifactScope,
    ...(plan.artifact.artifactMode ? { artifactDirtyBaseline: plan.artifact.artifactDirtyBaseline } : {}),
  };
}

function sharedTreeDirtyBaseline(artifact: DirtyBaselines): StoredRecord | null {
  return artifact.artifactDirtyBaseline || artifact.dirtyBaselineCapture?.baseline || null;
}

function dirtyBaselineFields(plan: PreparedDispatchPlan) {
  return {
    ...(plan.artifact.dirtyBaselineCapture?.warning ? { dirtyBaselineWarning: plan.artifact.dirtyBaselineCapture.warning } : {}),
    ...(plan.delivery.workingTreeDelivery ? { workingTreeDelivery: true, workingTreeDirtyBaseline: plan.artifact.workingTreeDirtyBaseline } : {}),
    ...(plan.isolation.sharedTree ? { dirtyBaseline: sharedTreeDirtyBaseline(plan.artifact) } : {}),
  };
}

function launchFields(t: StoredRecord, plan: PreparedDispatchPlan) {
  return {
    tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
    tokenFile: newDispatchTokenFile(),
    executor: t.dispatchExecutor,
    description: spawnDescription(t, plan.preparedExec),
    launchSeq: plan.launchSeq,
    launchName: dispatchLaunchName(t.ref, t.title, plan.preparedExec, t.effort, plan.launchSeq),
    route: dispatchRouteState(t.model, t.effort, plan.preparedExec),
  };
}

function repeatFailureFields(plan: PreparedDispatchPlan, current: StoredRecord, opts: DispatchOptions) {
  if (!plan.guarded.repeatFailure) return {};
  return {
    repeatFailureOverride: {
      at: plan.now,
      source: dispatchSource(opts, 'store'),
      priorAttempts: recentNoCommitAttempts(current).length,
    },
  };
}

function routeHistoryFields(plan: PreparedDispatchPlan, current: StoredRecord, opts: DispatchOptions, preflight: DispatchPreflight) {
  return {
    ...repeatFailureFields(plan, current, opts),
    ...(plan.guarded.unboundAttemptsSkipped ? { unboundAttemptsSkipped: true } : {}),
    ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {}),
    ...(preflight.sourceRevisionAdapterSwitch ? { sourceRevisionAdapterSwitch: preflight.sourceRevisionAdapterSwitch } : {}),
  };
}

function storyFields(plan: PreparedDispatchPlan) {
  return {
    storyContract: plan.story.contract,
    storyLogRevision: plan.story.storyLogRevision,
    ...(plan.story.contractDrift ? { storyContractDrift: Object.assign({}, plan.story.contractDrift, { rebasedAt: plan.now }) } : {}),
  };
}

function priorAttemptFields(plan: PreparedDispatchPlan) {
  return {
    ...(plan.history.attempts.length ? { attempts: plan.history.attempts } : {}),
    ...(plan.history.supersededTokens.length ? { supersededTokens: plan.history.supersededTokens.slice(-8) } : {}),
    ...(plan.recovery ? { recovery: plan.recovery } : {}),
  };
}

function preparedDispatchRecord(slug: string, t: StoredRecord, current: StoredRecord, plan: PreparedDispatchPlan, opts: DispatchOptions, preflight: DispatchPreflight) {
  return {
    ...preparationProvenanceFields(plan, opts, preflight.preparedCompatibility),
    ...checkoutPlacementFields(plan, preflight, opts),
    declaredFiles: plan.artifact.declaredFiles,
    boardAddedFiles: plan.artifact.boardAddedFiles,
    ...continuationFields(plan.isolation.sharedTree, plan.releasedContinuation),
    ...integrationFields(t, plan),
    readonly: plan.isolation.readonly,
    ...unscopedOverrideFields(slug, plan.isolation.wholeTreeScope, opts, plan.now),
    ...artifactFields(plan),
    ...dirtyBaselineFields(plan),
    ...launchFields(t, plan),
    ...routeHistoryFields(plan, current, opts, preflight),
    ...storyFields(plan),
    preparedAt: plan.now,
    launchedAt: null,
    boundAt: null,
    claimedAt: null,
    terminalAt: null,
    outcome: 'prepared',
    ...priorAttemptFields(plan),
  };
}

function preparedDispatchWarnings(plan: PreparedDispatchPlan, preflight: DispatchPreflight): string[] {
  return [plan.localAheadWarning?.message, plan.artifact.dirtyBaselineCapture?.warning, preflight.servingCompatibilityWarning, plan.guarded.crossBoundWorktree?.message]
    .filter((warning): warning is string => Boolean(warning));
}

function mintPreparedDispatch(slug: string, t: StoredRecord, current: StoredRecord, opts: DispatchOptions, preflight: DispatchPreflight, effects: DispatchPreparationEffects, guarded: GuardedDispatch) {
  const plan = planPreparedDispatch(slug, t, current, opts, preflight, effects, guarded);
  // Everything above this line only validates. Minting the replacement token
  // any earlier meant a later refusal — a changed project registration, an
  // unresolvable integration target, an unreadable evidence directory — left
  // SQLite pointing at a token file that had already been deleted, so the
  // still-authoritative dispatch could no longer authenticate (SQ-2691).
  t.dispatchNonce = mintDispatchToken();
  t.dispatch = preparedDispatchRecord(slug, t, current, plan, opts, preflight);
  consumePreparedComposition(t, dispatchTokenDigest(t.dispatchNonce));
  effects.staged = dispatchTokenFile(t);
  t.lifecycleAttempt = t.dispatch.lifecycleAttempt;
  stampDispatchEvent(t, 'dispatch', plan.now);
  writeDispatchTokenFile(t);
  const warnings = preparedDispatchWarnings(plan, preflight);
  return { ok: true, ticket: t, token: t.dispatchNonce, recovery: plan.recovery, ...(warnings.length ? { warnings } : {}) };
}

function discardReplacedTokenFile(effects: DispatchPreparationEffects): void {
  if (effects.prior && effects.staged && effects.prior !== effects.staged) {
    try { fs.unlinkSync(effects.prior); } catch (_: unknown) {}
  }
}

function discardUncommittedTokenFile(effects: DispatchPreparationEffects): void {
  if (effects.staged && effects.staged !== effects.prior) {
    try { fs.unlinkSync(effects.staged); } catch (_: unknown) {}
  }
}

function changedDuringPreparationError(slug: string, changedId: string): Error {
  const changed = getTicket(slug, changedId);
  return new Error(`prepare dispatch: ${changed?.ref || changedId} changed while this dispatch was reading its checkouts, so nothing was written and no checkout was removed. Read the ticket again and dispatch once more if it still needs a runtime.`);
}

function checkoutReclaimWarning(reclaim: () => CheckoutReclaimResult): string[] {
  try {
    return reclaimOutcomeWarning(reclaim());
  } catch (error) {
    return [`Dispatch committed; removing the retired checkout failed and it was left in place: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function reclaimOutcomeWarning(result: CheckoutReclaimResult): string[] {
  if (!result.reclaimed) return [`Dispatch committed; retired checkout ${result.worktree} was kept: ${result.message || result.reason}`];
  return result.branchKept ? [`Dispatch committed; retired checkout ${result.worktree} was removed, but deleting its branch ${result.branch} failed and the branch was kept: ${result.branchKept}`] : [];
}

// Git observation and token staging ran under the ticket file locks alone. The write transaction only rechecks that
// no locked ticket moved, then writes; retired checkouts are removed after the commit, still under the file locks,
// and a removal failure is reported against the committed dispatch rather than thrown as if nothing was written.
// The generations are read first so every observation that follows, the composition admission included, is covered.
function commitLockedPreparation(slug: string, lockedIds: readonly string[], assertAdmissionHolds: () => void, effects: DispatchPreparationEffects, prepare: () => StoredRecord) {
  const generations = ticketGenerations(slug, lockedIds);
  assertAdmissionHolds();
  const prepared = prepare();
  guardedTransaction(() => {
    const changedId = changedTicketSince(slug, generations);
    if (changedId) throw changedDuringPreparationError(slug, changedId);
    putTicket(slug, prepared.ticket);
  });
  const warnings = [...(prepared.warnings || []), ...effects.checkoutReclaims.flatMap(checkoutReclaimWarning)];
  return warnings.length ? { ...prepared, warnings } : prepared;
}

function prepareUnderDispatchLocks(slug: string, idOrRef: string, found: StoredRecord, opts: DispatchOptions, preflight: DispatchPreflight) {
  const effects: DispatchPreparationEffects = { prior: null, staged: null, checkoutReclaims: [] };
  try {
    const prepared = dependencies.withCompositionDispatchPreparation(slug, found.id,
      (lockedIds: readonly string[], assertAdmissionHolds: () => void) => commitLockedPreparation(slug, lockedIds, assertAdmissionHolds, effects,
        () => prepareLockedDispatch(slug, idOrRef, found, opts, preflight, effects)));
    discardReplacedTokenFile(effects);
    return prepared;
  } catch (error) {
    discardUncommittedTokenFile(effects);
    throw error;
  }
}

function prepareDispatch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  if (opts.retireOnly === true) return retireUnboundDispatchOnly(slug, idOrRef, opts);
  const { projectPath, found } = dispatchableTicket(slug, idOrRef, opts);
  const install = preparedInstallCompatibility(found, projectPath);
  supersedeEvidencedAttempt(slug, found, opts);
  // Registry install proves a future session; it does not prove THIS
  // invocation's session has the board MCP connected (SQ-1017 correction).
  // Only CLI transport needs to prove anything here — omitted/'mcp' callers
  // are trusted, matching every direct `prepareDispatch` caller that predates
  // this transport concept.
  assertDispatchTransport(opts.transport, { allowUnverifiedTransport: !!opts.allowUnverifiedTransport });
  const preflight: DispatchPreflight = { projectPath, ...install, ...preparedDispatchEnvironment(slug, found, idOrRef, projectPath) };
  return prepareUnderDispatchLocks(slug, idOrRef, found, opts, preflight);
}

function readDispatchBriefing(slug?: any, idOrRef?: any, token?: any, tokenFile?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  const state = dispatchState(ticket);
  const receivedToken = dispatchTokenForRequest(token, tokenFile);
  if (!state || !ticket.dispatchNonce) return { ok: false, reason: 'token' };
  if (state.terminalAt) return { ok: false, reason: 'stale' };
  if (!dispatchTokenMatches(ticket.dispatchNonce, receivedToken)) {
    return { ok: false, reason: 'token' };
  }
  // A briefing fetch is the running executor saying it got this far, and for a slow first turn it is the
  // only thing it says before claiming, so record it as runtime liveness (SQ-2934).
  const briefed = withTicketLock(slug, ticket.id, () => {
    const current = getTicket(slug, ticket.id);
    const currentState = dispatchState(current);
    if (!currentState || currentState.terminalAt || !dispatchTokenMatches(current.dispatchNonce, receivedToken)) return null;
    currentState.briefedAt = new Date().toISOString();
    stampDispatchEvent(current, 'briefing-served', currentState.briefedAt);
    putTicket(slug, current);
    return current;
  });
  // The renderer still validates the resolved credential. Returning only the
  // ticket made every token-file briefing fail after authentication (SQ-1866).
  return { ok: true, ticket: briefed || ticket, token: receivedToken };
}

type LiveClaimRecoveryRequest = { by: string; executor: string; worktree: string; evidence: string; sessionId: string };
type LiveClaimRecoveryOptions = Partial<Record<'by' | 'executor' | 'worktree' | 'recoveryEvidence' | 'sessionId', unknown>>;
type RecoverableClaim = { by?: string; runtime?: { executor?: string } };
type RecoverableClaimTicket = CompositionTicket & { claim?: RecoverableClaim | null };
type LiveClaimedTicket = RecoverableClaimTicket & { claim: RecoverableClaim };
type RecoverableClaimDispatch = { terminalAt?: string | null; sharedTree?: boolean; outcome?: string; executor?: string };
type LiveClaimRecoveryRefusal = { ok: false; reason: string; ticket: RecoverableClaimTicket | null; message: string };

function trimmedRecoveryText(value: unknown): string {
  return String(value || '').trim();
}

function liveClaimRecoveryRequest(opts: LiveClaimRecoveryOptions = {}): LiveClaimRecoveryRequest {
  return { by: trimmedRecoveryText(opts.by), executor: trimmedRecoveryText(opts.executor), worktree: trimmedRecoveryText(opts.worktree),
    evidence: trimmedRecoveryText(opts.recoveryEvidence), sessionId: trimmedRecoveryText(opts.sessionId) };
}

function isLiveClaimedBy(ticket: RecoverableClaimTicket | null, by: string): ticket is LiveClaimedTicket {
  return ticket?.claim?.by === by;
}

function liveClaimHolderRefusal(ticket: RecoverableClaimTicket | null, idOrRef: string, by: string): LiveClaimRecoveryRefusal {
  return { ok: false, reason: 'not_claim_holder', ticket, message: `${ticket?.ref || idOrRef} is not live-claimed by ${by}.` };
}

function isLiveIsolatedClaim(state: RecoverableClaimDispatch | null): state is RecoverableClaimDispatch {
  return state?.outcome === 'claimed' && state.sharedTree === false && !state.terminalAt;
}

// A claim without a recorded runtime executor matches whatever executor the dispatch stored.
function claimRuntimeExecutor(ticket: LiveClaimedTicket, executor: string): string {
  return ticket.claim.runtime?.executor || executor;
}

function liveClaimExecutorRefusal(ticket: LiveClaimedTicket, state: RecoverableClaimDispatch, executor: string): LiveClaimRecoveryRefusal | null {
  if (state.executor !== executor || claimRuntimeExecutor(ticket, executor) !== executor) {
    return { ok: false, reason: 'executor_mismatch', ticket, message: `${ticket.ref} requires executor ${state.executor || '(unavailable)'}, not ${executor}.` };
  }
  return null;
}

// The consumed composition grant names this claim's dispatch nonce. Re-minting it would leave every later claim,
// capture and submit refused as stale_generation, and the consumed grant also refuses a redispatch.
function consumedCompositionRecoveryRefusal(ticket: RecoverableClaimTicket): LiveClaimRecoveryRefusal | undefined {
  const consumed = consumedAdmissionRefusal(ticket);
  return consumed && { ok: false, reason: consumed.reason, ticket,
    message: `${ticket.ref}: ${consumed.message} Live-claim recovery would re-mint the dispatch nonce that consumed it, so it is refused and nothing was written. The live claim holder keeps its existing dispatch token and bound native checkout; this composition generation cannot be re-minted or redispatched.` };
}

function liveClaimRecoveryRefusal(ticket: RecoverableClaimTicket | null, state: RecoverableClaimDispatch | null, request: LiveClaimRecoveryRequest, idOrRef: string) {
  if (!isLiveClaimedBy(ticket, request.by)) return liveClaimHolderRefusal(ticket, idOrRef, request.by);
  if (!isLiveIsolatedClaim(state)) {
    return { ok: false, reason: 'dispatch_unavailable', ticket, message: `${ticket.ref} does not have a live isolated claimed dispatch to recover.` };
  }
  return liveClaimExecutorRefusal(ticket, state, request.executor) || consumedCompositionRecoveryRefusal(ticket);
}

function resumeLiveClaim(ticket: StoredRecord, state: StoredRecord, facts: StoredRecord, request: LiveClaimRecoveryRequest, now: string) {
  state.sessionId = request.sessionId;
  state.agentId = null;
  state.continuation = {
    mode: 'live_claim_resume',
    ticketRef: ticket.ref,
    sourceWorktree: facts.worktree,
    baseCommit: state.baseCommit,
    commit: facts.revision,
  };
  bindCheckoutFacts(state, facts);
  state.worktreeBindingSource = 'live-claim-recovery';
  state.worktreeBoundAt = now;
  state.resumedAt = now;
  state.liveClaimRecovery = { at: now, by: request.by, executor: request.executor, evidence: request.evidence };
  ticket.dispatchNonce = mintDispatchToken();
  state.tokenPrefix = dispatchTokenPrefix(ticket.dispatchNonce);
  writeDispatchTokenFile(ticket);
  syncClaimRuntimeIdentity(ticket, state);
  stampDispatchEvent(ticket, 'live-claim-recovery', now);
}

function recoverLockedLiveClaim(slug: string, id: string, idOrRef: string, request: LiveClaimRecoveryRequest, lockKeys: TicketKey[]) {
  const ticket = getTicket(slug, id);
  const state = dispatchState(ticket);
  const refusal = liveClaimRecoveryRefusal(ticket, state, request, idOrRef);
  if (refusal) return refusal;
  const facts = immutableWorktreeFacts(slug, request.worktree);
  if (!facts) {
    return { ok: false, reason: 'invalid_worktree', ticket, message: `${ticket.ref} recovery requires a linked worktree from this board project.` };
  }
  const now = new Date().toISOString();
  const rebind = liveClaimRebind(slug, ticket, state, facts, lockKeys, now);
  if (!rebind.ok) return { ok: false, reason: rebind.reason, ticket, message: rebind.message };
  resumeLiveClaim(ticket, state, facts, request, now);
  putTicket(slug, ticket);
  return {
    ok: true,
    ticket,
    token: ticket.dispatchNonce,
    recovery: Object.assign({ kind: 'live_claim_resume', at: now, worktree: facts.worktree }, rebind.recovery),
  };
}

function recoverLiveClaimDispatch(slug?: any, idOrRef?: any, opts?: LiveClaimRecoveryOptions) {
  const request = liveClaimRecoveryRequest(opts);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  if (Object.values(request).some((value) => !value)) {
    return { ok: false, reason: 'missing_recovery_facts', message: 'Live-claim recovery requires claimHolder, executor, worktree, recoveryEvidence, and a connected session.' };
  }
  const lockKeys = recoveryLockKeys(slug, found, request.worktree);
  return withTicketLocks(lockKeys, () => recoverLockedLiveClaim(slug, found.id, idOrRef, request, lockKeys));
}

function recordDispatchLaunch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
      return { ok: false, reason: 'not_prepared' };
    }
    const state = dispatchState(t);
    if (!state) return { ok: false, reason: 'missing_state' };
    let compatibilityWarning = null;
    if (state.preparedCompatibility?.pluginInstall) {
      const currentInstall = checkSidequestInstall(readMeta(slug)?.path || '');
      if (preparedCompatibilityHasProvenMismatch(state, currentInstall)) {
        const retired = retirePreparedCompatibilityStaleAttempt(slug, t, 'tokened-launch-refusal');
        return {
          ok: false,
          reason: 'prepared_compatibility_stale',
          ticket: retired,
          message: `${t.ref}'s prepared dispatch was retired because its Sidequest install snapshot is stale. Stop this launch; the orchestrator can dispatch a fresh token.`,
        };
      }
      compatibilityWarning = preparedCompatibilityWarning(state, currentInstall);
    }
    const now = new Date().toISOString();
    state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
    state.agentName = opts.agentName ? String(opts.agentName) : state.agentName || null;
    state.launchedAt = state.launchedAt || now;
    state.outcome = 'launched';
    const lifecycle = t.lifecycleAttempt || state.lifecycleAttempt;
    const launchedAttempt = lifecycle?.state === 'prepared' ? transitionAttempt(lifecycle, 'launch') : lifecycle;
    if (launchedAttempt) {
      if (attemptDiagnostic(launchedAttempt)) return { ok: false, reason: 'invalid_lifecycle' };
      t.lifecycleAttempt = launchedAttempt;
      state.lifecycleAttempt = launchedAttempt;
    }
    stampDispatchEvent(t, opts.source || 'dispatch', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, ...(compatibilityWarning ? { advisory: compatibilityWarning } : {}) };
  });
}

function terminalRuntimeMatches(state?: any, claim?: any, opts?: any) {
  const sessionId = String(opts?.sessionId || '').trim();
  const executor = String(opts?.executor || '').trim();
  const taskName = String(opts?.taskName || '').trim();
  if (!sessionId || !executor || !taskName) return false;
  if (state?.sessionId !== sessionId || state?.executor !== executor || state?.agentName !== taskName) return false;
  const runtime = claim?.runtime;
  if (runtime && (runtime.sessionId !== sessionId || runtime.executor !== executor || runtime.agentName !== taskName)) return false;
  const agentId = String(opts?.agentId || '').trim();
  const agentName = String(opts?.agentName || '').trim();
  if (agentId && state.agentId && state.agentId !== agentId) return false;
  if (agentName && state.agentName && state.agentName !== agentName) return false;
  return true;
}

function claimSnapshot(claim?: any) {
  if (!claim?.by || !claim?.at) return null;
  return { by: claim.by, at: claim.at };
}

function recordDispatchAgentFailure(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const failureShape = terminalAgentFailure(opts.error);
  if (!failureShape) return { ok: false, reason: 'unrecognized_failure' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const recorded = withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
      return { ok: false, reason: 'not_prepared' };
    }
    const state = dispatchState(t);
    if (!state || !['launched', 'claimed'].includes(state.outcome) || state.terminalAt) {
      return { ok: false, reason: 'not_launched' };
    }
    if (!terminalRuntimeMatches(state, t.claim, opts)) return { ok: false, reason: 'runtime_mismatch', ticket: t };
    const now = new Date().toISOString();
    const claim = claimSnapshot(t.claim);
    setDispatchTerminal(t, claim ? 'died' : 'failed', opts.source || 'agent-terminal-failure', {
      slug,
      error: opts.error,
      failureShape,
    });
    if (!claim) {
      t.dispatchNonce = null;
      t.dispatchExecutor = null;
    }
    stampDispatchEvent(t, opts.source || 'agent-terminal-failure', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, claim, dispatchBindingCleared: !claim };
  });
  if (!recorded?.ok || !recorded.claim || typeof releaseTerminalClaim !== 'function') return recorded;
  const released = releaseTerminalClaim(slug, found.id, recorded.claim, opts.source || 'agent-terminal-failure');
  return Object.assign({}, recorded, { claimReleased: Boolean(released?.ok), ticket: released?.ticket || recorded.ticket });
}

function recoverDispatchQuotaFailure(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const failure = claudeQuotaFailure(opts.error);
  if (!failure) return { ok: false, reason: 'unrecognized_failure' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
      return { ok: false, reason: 'not_prepared' };
    }
    if (t.claim && t.claim.by) return { ok: false, reason: 'claimed' };
    const state = dispatchState(t);
    if (!state || state.outcome !== 'launched' || state.terminalAt) return { ok: false, reason: 'not_launched' };
    const failedRoute = normalizeRoute(state.route) || normalizeRoute({ model: t.model, effort: t.effort });
    const failedExec = failedRoute && resolveExec(failedRoute.model, failedRoute.effort);
    if (!failedExec || failedExec.backend !== 'claude' || failedExec.runsModel !== failure.model) {
      return { ok: false, reason: 'signature_route_mismatch' };
    }
    const fallback = resolveCategoryFallback(t.category, failedExec.runsModel);
    if (!fallback) return { ok: false, reason: 'no_fallback' };

    const now = new Date().toISOString();
    const failedAttempt = {
      route: { model: failedExec.runsModel, effort: failedRoute.effort },
      executor: state.executor || canonicalPreparedDispatchExecutor(t),
      tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(t.dispatchNonce),
      preparedAt: state.preparedAt || null,
      launchedAt: state.launchedAt || null,
      outcome: 'quota_exhausted',
      failureShape: classifyDispatchFailure(opts.error),
      terminalAt: now,
      terminalSource: opts.source || 'agent-launch-failure',
      failure: { kind: 'claude_quota_exhausted', signature: failure.signature },
    };
    const attempts = (Array.isArray(state.attempts) ? state.attempts : []).concat(failedAttempt).slice(-8);
    const supersededTokens = (Array.isArray(state.supersededTokens) ? state.supersededTokens : []).concat({
      digest: dispatchTokenDigest(t.dispatchNonce),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      at: now,
    }).slice(-8);
    const recovery = {
      kind: 'claude_quota_exhausted',
      failedModel: failedExec.runsModel,
      failedEffort: failedRoute.effort,
      fallbackSource: fallback.source,
      model: fallback.model,
      effort: fallback.effort,
      signature: failure.signature,
      at: now,
    };

    removeDispatchTokenFile(t);
    t.dispatchNonce = mintDispatchToken();
    t.dispatchExecutor = fallback.exec.agent;
    // The recovery route replaces the failed one before the card labels are
    // rendered, so the description advertises the model that will actually run.
    t.model = fallback.model;
    t.effort = fallback.effort;
    t.exec = execProjection(fallback.exec);
    const launchSeq = nextDispatchLaunchSeq(state);
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : state.sessionId || null,
      preparedBy: dispatchPreparationAttribution(opts),
      sharedTree: state.sharedTree === true,
      ...(state.reducedAgentSchema === true ? { reducedAgentSchema: true } : {}),
      declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : effectiveScope(slug, t),
      artifactMode: state.artifactMode === true,
      artifactRoot: state.artifactRoot || null,
      artifactScope: state.artifactScope || null,
      ...(Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {}),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      tokenFile: newDispatchTokenFile(),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, fallback.exec),
      launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, fallback.exec, fallback.effort, launchSeq),
      route: dispatchRouteState(fallback.model, fallback.effort, fallback.exec),
      storyContract: state.storyContract || storyExecutionContract(t.storyId ? getStory(slug, t.storyId) : null),
      ...(state.storyContractDrift ? { storyContractDrift: state.storyContractDrift } : {}),
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: 'prepared',
      attempts,
      supersededTokens,
      recovery,
    };
    writeDispatchTokenFile(t);
    stampDispatchEvent(t, opts.source || 'agent-launch-failure', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}

function dispatchCreationCandidate(state?: any, sessionId?: any) {
  return Boolean(state
    && state.sessionId === sessionId
    && state.sharedTree === false
    && state.outcome === 'launched'
    && !state.terminalAt
    && !state.worktree
    && !state.continuation?.sourceWorktree);
}

// A WorktreeCreate that finds only a PREPARED dispatch for its session means the
// Agent launch marker never reached the board, so there is no launched attempt to
// reserve the checkout. A prepared attempt still supplies no creation authority;
// naming the case separately only tells the orchestrator which failure it hit,
// because "dispatch_binding_unavailable" alone reads as a missing dispatch and
// sends it hunting for the wrong cause (SQ-2570).
function unlaunchedSessionDispatch(slug?: any, sessionId?: string) {
  return listTickets(slug).some((candidate?: any) => {
    const state = dispatchState(candidate);
    return Boolean(state && state.sessionId === sessionId && state.sharedTree === false
      && state.outcome === 'prepared' && !state.terminalAt && !state.worktree);
  });
}

function bindingFailurePredicate(state?: any, sessionId?: string, worktree?: string) {
  if (state?.sessionId !== sessionId) return 'session_id';
  if (state.sharedTree !== false) return 'shared_tree';
  if (state.outcome !== 'launched') return 'outcome';
  if (state.terminalAt) return 'terminal_at';
  if (state.worktreeBindingSource !== 'worktree-create') return 'worktree_binding_source';
  if (!state.worktree || canonicalPath(state.worktree) !== worktree) return 'canonical_worktree';
  return 'dispatch_binding_unavailable';
}

// One entry per board this session still owns a launched isolated dispatch on.
// WorktreeCreate learns only the spawning checkout's cwd, so the session id is the
// only thing that can point it at a sibling project's board (SQ-2884).
function launchedIsolatedSessionProjects(sessionId?: string, skipSlug?: any) {
  const owned: { slug: string; path: string; state: any }[] = [];
  if (!sessionId) return owned;
  for (const project of listProjects({ all: true })) {
    if (!project?.slug || !project.path || project.slug === skipSlug) continue;
    for (const candidate of listTickets(project.slug)) {
      const state = dispatchState(candidate);
      if (state?.sessionId === sessionId && state.sharedTree === false && state.outcome === 'launched' && !state.terminalAt) {
        owned.push({ slug: project.slug, path: String(project.path), state });
        break;
      }
    }
  }
  return owned;
}

function launchedIsolatedDispatchOnAnotherProject(slug?: any, sessionId?: string) {
  return launchedIsolatedSessionProjects(sessionId, slug)[0]?.state || null;
}

// The repository WorktreeCreate should cut this session's next isolated worktree
// from. Guessing between boards would check out the wrong repository, so an
// ambiguous session resolves to nothing and the hook keeps its spawning-checkout
// fallback; prepareDispatch refuses that combination up front.
function isolatedDispatchRepositoryForSession(sessionId?: any) {
  const boards = launchedIsolatedSessionProjects(String(sessionId || '').trim());
  return boards.length === 1 ? boards[0]!.path : null;
}

function unavailableWorktreeBinding(slug?: any, candidates: any[] = [], sessionId?: string, worktree?: string) {
  const nearest = candidates.find(({ state }) => state.sessionId === sessionId)
    || candidates.find(({ state }) => state.worktree && canonicalPath(state.worktree) === worktree);
  const crossProject = nearest ? null : launchedIsolatedDispatchOnAnotherProject(slug, sessionId);
  const state = nearest?.state || crossProject;
  return {
    ok: false,
    reason: 'dispatch_binding_unavailable',
    binding: {
      candidatesConsidered: candidates.length,
      ...(state ? {
        predicate: crossProject ? 'different_project' : bindingFailurePredicate(state, sessionId, worktree),
        recordedSessionId: state.sessionId,
        recordedWorktree: state.worktree ? canonicalPath(state.worktree) : '',
      } : {}),
      suppliedSessionId: sessionId,
      suppliedWorktree: worktree,
      crossProject: Boolean(crossProject),
    },
  };
}

// A WorktreeCreate callback carries only the session and the checkout path, and a replacement dispatch
// reuses both, so a prior generation's late hook landed its stamp on the live attempt and shortened the
// replacement's protection (SQ-2949 finding 3). `preparedAt` is the attempt's own generation stamp: the
// binding hands it out and every later callback hands it back, so a stale one stamps nothing.
//
// The token is mandatory. Treating a missing one as current was the same corruption with an easier
// trigger: every recorder stamped the replacement whenever a caller simply omitted it (SQ-2953 finding 1).
// So the generation is the FIRST thing each recorder checks, before any state predicate, which is what
// makes `dispatch_binding_unavailable` reachable only once the generation is known to be current.
function missingWorktreeCallbackAttempt(attempt?: any) {
  return !String(attempt || '').trim();
}

function worktreeCallbackGenerationRefusal(state?: any, attempt?: any) {
  const claimed = String(attempt || '').trim();
  if (!claimed) return { ok: false, reason: 'missing_attempt' };
  return claimed === String(state?.preparedAt || '').trim() ? null : { ok: false, reason: 'stale_attempt' };
}

function liveIsolatedDispatch(state?: any) {
  return Boolean(state && state.sharedTree === false && !state.terminalAt);
}

function liveSessionDispatch(state?: any, sessionId?: any) {
  return liveIsolatedDispatch(state) && state.sessionId === sessionId;
}

function recordedAtCheckout(state?: any, checkout?: string) {
  return Boolean(state?.worktree) && canonicalPath(state.worktree) === checkout;
}

// The occupancy fact both sides of this change read: a live isolated dispatch whose ticket is claimed and whose
// record names this exact checkout. Creation asks it of the checkout a WorktreeCreate is arriving at; the
// completion gates ask it of the two checkouts they can see.
function liveClaimOccupiesCheckout(candidate?: any, state?: any, checkout?: string) {
  return Boolean(candidate?.claim?.by) && liveIsolatedDispatch(state) && recordedAtCheckout(state, checkout);
}

// Whether an arrival at an occupied checkout is that owner's own dispatch coming back rather than a second
// executor. The binding the board already holds is read first, because it is the stronger fact: a binding that
// did not come from creation-order attribution was proven against the checkout itself - live-claim recovery
// clears the agent id, keeps the checkout, and moves the record to the recovering session, so its replacement
// runtime would otherwise be accused of intruding on its own tree. Only then does the checkout name decide, and
// when the name carries no agent id at all - WorktreeCreate accepts any single path segment - the record's own
// bound identity is the last thing left to read.
function reentrantCheckoutOwner(state?: any, checkoutAgentId?: string, sessionId?: string) {
  if (state?.worktreeBindingSource !== 'worktree-create') return state?.sessionId === sessionId;
  if (checkoutAgentId) return String(state.agentId || '') === checkoutAgentId;
  return Boolean(state.agentId) && state.sessionId === sessionId;
}

function occupiedCheckoutFailure(candidate?: any, state?: any, checkoutAgentId?: string) {
  return {
    ownerRef: candidate.ref,
    ownerClaimHolder: String(candidate.claim.by),
    ownerAgentId: String(state.agentId || '').trim(),
    checkoutAgentId: String(checkoutAgentId || ''),
  };
}

// A checkout an active claim occupies is never re-attributed to another reservation. The live-owner scan in
// `bindDispatchWorktreeCreation` only covers a holder whose outcome is still `launched`, so a holder that had
// already CLAIMED its ticket fell through to creation-order attribution and the occupied checkout was handed to
// a sibling reservation; every completion gate then read a tree that belongs to somebody else's live executor
// (GH-235). The checkout name is the one per-agent discriminator a WorktreeCreate payload carries: a linked
// checkout is named agent-<agentId>, so the owner's own bound agent id is the one arrival the name can confirm,
// and any other arrival is a second agent landing in an occupied tree.
function occupiedCheckoutOwner(slug?: any, boundWorktree?: string, checkoutAgentId?: string, sessionId?: string) {
  for (const candidate of listTickets(slug)) {
    const state = dispatchState(candidate);
    if (!liveClaimOccupiesCheckout(candidate, state, boundWorktree)) continue;
    if (reentrantCheckoutOwner(state, checkoutAgentId, sessionId)) continue;
    return occupiedCheckoutFailure(candidate, state, checkoutAgentId);
  }
  return null;
}

// The start binding is scoped to the session and the checkout, not to a generation, because the hook learns its
// generation from this very call.
function holdsThisCheckout(state?: any, sessionId?: string, checkout?: string) {
  return Boolean(state && state.sessionId === sessionId
    && state.sharedTree === false && state.worktreeBindingSource === 'worktree-create')
    && recordedAtCheckout(state, checkout);
}

// A live owner of this checkout that a start callback can still bind to: one still launched, or one whose ticket
// is already claimed and whose own dispatch is re-entering. Admitting the re-entry here rather than only
// excusing it from the refusal matters: an unadmitted callback falls through to creation-order attribution,
// which is exactly how an occupied checkout reaches a sibling reservation.
function checkoutOwnerArrival(state?: any, checkoutAgentId?: string, sessionId?: string) {
  if (state?.outcome === 'launched') return true;
  return state?.outcome === 'claimed' && reentrantCheckoutOwner(state, checkoutAgentId, sessionId);
}

// Nothing a start callback may bind to still holds this checkout: either a retired attempt does, or a live claim
// occupies it and the arrival is not that owner's own dispatch coming back.
function unbindableCheckoutHolder(slug?: any, sessionId?: string, boundWorktree?: string, checkoutAgentId?: string) {
  for (const candidate of listTickets(slug)) {
    const state = dispatchState(candidate);
    if (holdsThisCheckout(state, sessionId, boundWorktree) && state.terminalAt) return { ok: false, reason: 'stale_attempt' };
  }
  const occupied = occupiedCheckoutOwner(slug, boundWorktree, checkoutAgentId, sessionId);
  return occupied ? {
    ok: false,
    reason: 'checkout_owned_by_live_claim',
    binding: { suppliedSessionId: sessionId, suppliedWorktree: boundWorktree, ...occupied },
  } : null;
}

// The start recorder is the one callback that CANNOT present a generation: the hook learns its generation
// from this very call, and nothing in a WorktreeCreate payload (a session id, a cwd, and a worktree name that
// is just the checkout path again) tells two generations of the same session and checkout apart. So this
// binding is session-and-checkout scoped, not generation-scoped, and the docs say so - but a caller that DOES
// know its generation is held to it, and the two shapes a generation-blind caller could have hijacked are
// closed (SQ-2959 finding 2):
//   - A checkout whose attempt is already bound and still creating has a hook inside its creation window, and
//     that hook already holds the generation. A second caller arriving there with none is a racing hook, not
//     the owner, so it never acquires the live generation. Once creation is COMPLETE the same call is a
//     re-entry that stamps nothing - `createWorktree` no-ops on an intact checkout - so it stays allowed.
//   - A retired attempt still holding this checkout answers `stale_attempt`, rather than falling through and
//     handing its late hook some other live attempt in the same session.
//   - A holder whose ticket is already CLAIMED answers `checkout_owned_by_live_claim` unless the binding the
//     board already holds, or the checkout name, says the owner's own dispatch is re-entering, rather than
//     letting attribution hand an occupied tree to a sibling reservation (GH-235).
//
// Attribution itself still has no per-dispatch discriminator when every sibling reservation is unbound: the
// payload's only per-agent fact is the checkout name, and at that moment no dispatch has bound an agent id to
// compare it against. So creation order remains the guess, and `exchangeCrossedCreationBinding` at SubagentStart
// remains the fact that settles it.
function nativeCheckoutBindingRequest(slug: string, sessionId?: string, worktree?: string, attempt?: string): NativeCheckoutBindingRequest | null {
  const identity = nativeCheckoutCallbackIdentity(sessionId, worktree);
  const meta = readMeta(slug);
  if (!identity || !meta?.path) return null;
  const repository = canonicalPath(meta.path);
  return { ...identity, repository, attempt: String(attempt || '').trim(),
    checkoutAgentId: agentIdFromWorktreePath(repository, identity.worktree) };
}

function existingNativeCheckoutOwner(ticket: CompositionTicket, request: NativeCheckoutBindingRequest): boolean {
  const state: NativeCheckoutCreation | undefined = dispatchState(ticket);
  if (!state || state.terminalAt) return false;
  return holdsThisCheckout(state, request.sessionId, request.worktree)
    && checkoutOwnerArrival(state, request.checkoutAgentId, request.sessionId);
}

function createdCheckoutExpectations(state: NativeCheckoutCreation): Pick<NativeCheckoutBinding, 'expectedGitDirectory' | 'expectedCommonGitDirectory' | 'expectedCheckoutInstance' | 'expectedRevision'> {
  return { expectedGitDirectory: state.worktreeGitDirectory ?? null, expectedCommonGitDirectory: state.worktreeCommonGitDirectory ?? null,
    expectedCheckoutInstance: state.worktreeCheckoutInstance ?? null, expectedRevision: state.worktreeObservedRevision ?? null };
}

function nativeCheckoutBindingResponse(ticket: CompositionTicket, state: NativeCheckoutCreation, request: NativeCheckoutBindingRequest): NativeCheckoutBindingResult {
  const baseline = String(compositionCheckoutCommit(state)).trim();
  if (!baseline) return { ok: false, reason: 'baseline_unavailable' };
  return { ok: true, ref: ticket.ref, attempt: state.preparedAt ?? '', baseline,
    repository: request.repository, worktree: request.worktree, creationCompleted: Boolean(state.worktreeCreationCompletedAt),
    ...createdCheckoutExpectations(state) };
}

// An already-bound checkout replays only its own prepared attempt, or completes without one after creation finished.
function nativeCallbackAttemptRefusal(attempt: string, state: NativeCheckoutCreation): NativeCheckoutBindingResult | undefined {
  if (attempt && attempt !== state.preparedAt) return { ok: false, reason: 'stale_attempt' };
  if (!attempt && !state.worktreeCreationCompletedAt) return { ok: false, reason: 'missing_attempt' };
}

function existingNativeCheckoutBinding(slug: string, ticketId: string, request: NativeCheckoutBindingRequest): NativeCheckoutBindingResult {
  const ticket: CompositionTicket = getTicket(slug, ticketId);
  if (!ticket || !existingNativeCheckoutOwner(ticket, request)) return { ok: false, reason: 'dispatch_binding_unavailable' };
  const state: NativeCheckoutCreation = dispatchState(ticket);
  return nativeCallbackAttemptRefusal(request.attempt, state) ?? nativeCheckoutBindingResponse(ticket, state, request);
}

function retainedCompositionCheckoutRefusal(ticket: CompositionTicket, worktree: string): NativeCheckoutBindingResult | undefined {
  const admission = ticket.compositionAdmission;
  if (!admission) return;
  if (admission.releasedDispatch.worktree && canonicalPath(admission.releasedDispatch.worktree) === worktree) {
    return { ok: false, reason: 'composition_checkout_reused' };
  }
  if (fs.existsSync(worktree)) return { ok: false, reason: 'composition_checkout_occupied' };
}

function recordNativeCheckoutBinding(slug: string, ticket: CompositionTicket, state: NativeCheckoutCreation, request: NativeCheckoutBindingRequest): NativeCheckoutBindingResult {
  const response = nativeCheckoutBindingResponse(ticket, state, request);
  if (!response.ok) return response;
  state.worktree = request.worktree;
  state.worktreeBindingSource = 'worktree-create';
  state.worktreeBoundAt = new Date().toISOString();
  stampDispatchEvent(ticket, 'worktree-create-binding', state.worktreeBoundAt);
  putTicket(slug, ticket);
  return { ok: true, ref: response.ref, attempt: response.attempt, baseline: response.baseline,
    repository: response.repository, worktree: response.worktree };
}

function freshNativeCheckoutBinding(slug: string, ticketId: string, request: NativeCheckoutBindingRequest): NativeCheckoutBindingResult {
  const ticket: CompositionTicket = getTicket(slug, ticketId);
  const state: NativeCheckoutCreation = dispatchState(ticket);
  if (!dispatchCreationCandidate(state, request.sessionId)) return { ok: false, reason: 'already_bound' };
  if (request.attempt && request.attempt !== state.preparedAt) return { ok: false, reason: 'stale_attempt' };
  return retainedCompositionCheckoutRefusal(ticket, request.worktree)
    ?? recordNativeCheckoutBinding(slug, ticket, state, request);
}

function bindAvailableNativeCheckout(slug: string, request: NativeCheckoutBindingRequest, tickets: readonly CompositionTicket[]): NativeCheckoutBindingResult {
  const candidate = tickets.find(ticket => dispatchCreationCandidate(dispatchState(ticket), request.sessionId));
  if (candidate) return dependencies.withCompositionGenerationLock(slug, candidate.id,
    () => freshNativeCheckoutBinding(slug, candidate.id, request));
  if (unlaunchedSessionDispatch(slug, request.sessionId)) return { ok: false, reason: 'dispatch_launch_unrecorded' };
  const candidates = tickets.map(candidate => ({ candidate, state: dispatchState(candidate) })).filter(candidate => Boolean(candidate.state));
  return { ...unavailableWorktreeBinding(slug, candidates, request.sessionId, request.worktree), ok: false };
}

function bindDispatchWorktreeCreation(slug: string, sessionId?: string, worktree?: string, attempt?: string): NativeCheckoutBindingResult {
  const request = nativeCheckoutBindingRequest(slug, sessionId, worktree, attempt);
  if (!request) return { ok: false, reason: 'missing_binding_facts' };
  const tickets: readonly CompositionTicket[] = listTickets(slug);
  const existing = tickets.find(ticket => existingNativeCheckoutOwner(ticket, request));
  if (existing) return dependencies.withCompositionGenerationLock(slug, existing.id,
    () => existingNativeCheckoutBinding(slug, existing.id, request));
  const refusal = unbindableCheckoutHolder(slug, request.sessionId, request.worktree, request.checkoutAgentId);
  if (refusal) return { ...refusal, ok: false };
  return bindAvailableNativeCheckout(slug, request, tickets);
}

function nativeCheckoutCallbackIdentity(sessionId?: string, worktree?: string): { sessionId: string; worktree: string } | null {
  const normalizedSessionId = String(sessionId || '').trim();
  const target = String(worktree || '').trim();
  if (!normalizedSessionId || !target) return null;
  return { sessionId: normalizedSessionId, worktree: canonicalPath(target) };
}

function launchedNativeCheckoutMatches(state: NativeCheckoutCreation | null | undefined, binding: { sessionId: string; worktree: string }): state is NativeCheckoutCreation {
  if (!state) return false;
  return [state.sessionId === binding.sessionId, state.sharedTree === false, state.outcome === 'launched', !state.terminalAt,
    state.worktreeBindingSource === 'worktree-create', Boolean(state.worktree), canonicalPath(state.worktree ?? '') === binding.worktree].every(Boolean);
}

function createdCheckoutIdentityMatches(state: NativeCheckoutCreation, facts: NativeCheckoutFacts): boolean {
  return [canonicalPath(state.worktreeGitDirectory ?? '') === facts.gitDirectory,
    canonicalPath(state.worktreeCommonGitDirectory ?? '') === facts.commonGitDirectory,
    state.worktreeCheckoutInstance === facts.checkoutInstance, state.worktreeObservedRevision === facts.revision].every(Boolean);
}

function recordCreatedCheckoutIdentity(state: NativeCheckoutCreation, facts: NativeCheckoutFacts): void {
  state.worktreeGitDirectory = facts.gitDirectory;
  state.worktreeCommonGitDirectory = facts.commonGitDirectory;
  state.worktreeCheckoutInstance = facts.checkoutInstance;
  state.worktreeObservedRevision = facts.revision;
  state.worktreeCreationCompletedAt = new Date().toISOString();
}

function recordNativeCheckoutCompletion(slug: string, ticket: CompositionTicket, current: NativeCheckoutCreation, facts: NativeCheckoutFacts): NativeCheckoutCompletion {
  if (current.worktreeCreationCompletedAt) {
    return createdCheckoutIdentityMatches(current, facts)
      ? { ok: true, alreadyCompleted: true } : { ok: false, reason: 'worktree_identity_mismatch' };
  }
  recordCreatedCheckoutIdentity(current, facts);
  stampDispatchEvent(ticket, 'worktree-create-complete', current.worktreeCreationCompletedAt);
  putTicket(slug, ticket);
  return { ok: true, alreadyCompleted: false };
}

function compositionCheckoutWasReused(previous: CompositionDispatch, worktree: string, facts: NativeCheckoutFacts): boolean {
  return [previous.worktree && canonicalPath(previous.worktree) === worktree,
    previous.worktreeGitDirectory && canonicalPath(previous.worktreeGitDirectory) === facts.gitDirectory,
    previous.worktreeCheckoutInstance === facts.checkoutInstance].some(Boolean);
}

function checkoutStatus(worktree: string): string | null {
  try {
    return gitOutput(worktree, ['status', '--porcelain']);
  } catch {
    return null;
  }
}

function observeNativeCheckout(slug: string, worktree: string, ticket: CompositionTicket): ObservedNativeCheckout {
  return { facts: immutableWorktreeFacts(slug, worktree), checkoutStatus: ticket.compositionAdmission ? checkoutStatus(worktree) : undefined };
}

function cleanCompositionCheckoutRefusal(status: string | null | undefined): NativeCheckoutCompletion | undefined {
  if (status == null) return { ok: false, reason: 'composition_checkout_unobservable' };
  if (status) return { ok: false, reason: 'composition_checkout_dirty' };
}

function compositionCheckoutIdentityRefusal(ticket: CompositionTicket, worktree: string, facts: NativeCheckoutFacts, observed: ObservedNativeCheckout): NativeCheckoutCompletion | undefined {
  const admission = ticket.compositionAdmission;
  if (!admission) return;
  if (compositionCheckoutWasReused(admission.releasedDispatch, worktree, facts)) return { ok: false, reason: 'composition_checkout_reused' };
  return cleanCompositionCheckoutRefusal(observed.checkoutStatus);
}

function nativeCheckoutCompletionFacts(observed: ObservedNativeCheckout, state: NativeCheckoutCreation): NativeCheckoutFacts | { ok: false; reason: string } {
  const facts = observed.facts;
  if (!facts) return { ok: false, reason: 'invalid_worktree_binding' };
  if (facts.revision !== String(compositionCheckoutCommit(state)).trim()) return { ok: false, reason: 'worktree_revision_mismatch' };
  return facts;
}

function completeNativeCheckoutForTicket(slug: string, id: string, binding: { sessionId: string; worktree: string }, attempt: string | undefined, observed: ObservedNativeCheckout): NativeCheckoutCompletion {
  const ticket = getTicket(slug, id);
  const current: NativeCheckoutCreation | undefined = dispatchState(ticket);
  const generation = worktreeCallbackGenerationRefusal(current, attempt);
  if (generation) return { ...generation, ok: false };
  if (!launchedNativeCheckoutMatches(current, binding)) return { ok: false, reason: 'dispatch_binding_unavailable' };
  const facts = nativeCheckoutCompletionFacts(observed, current);
  if ('ok' in facts) return facts;
  return compositionCheckoutIdentityRefusal(ticket, binding.worktree, facts, observed)
    ?? recordNativeCheckoutCompletion(slug, ticket, current, facts);
}

function completeDispatchWorktreeCreation(slug: string, sessionId?: string, worktree?: string, attempt?: string) {
  if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: 'missing_attempt' };
  const binding = nativeCheckoutCallbackIdentity(sessionId, worktree);
  if (!binding) return { ok: false, reason: 'missing_binding_facts' };
  for (const candidate of listTickets(slug)) {
    if (!launchedNativeCheckoutMatches(dispatchState(candidate), binding)) continue;
    const observed = observeNativeCheckout(slug, binding.worktree, candidate);
    return dependencies.withCompositionGenerationLock(slug, candidate.id,
      () => completeNativeCheckoutForTicket(slug, candidate.id, binding, attempt, observed));
  }
  return { ok: false, reason: 'dispatch_binding_unavailable' };
}

// Creation completion is recorded before provisioning starts, so without this the board had no way to tell
// a cold `npm ci` still running from a WorktreeCreate that died, and retired live ones (SQ-2932 finding 2).
function recordDispatchWorktreeProvisioned(slug?: any, sessionId?: any, worktree?: any, attempt?: any) {
  if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: 'missing_attempt' };
  const normalizedSessionId = String(sessionId || '').trim();
  const target = String(worktree || '').trim();
  if (!normalizedSessionId || !target) return { ok: false, reason: 'missing_binding_facts' };
  const boundWorktree = canonicalPath(target);
  for (const candidate of listTickets(slug)) {
    const state = dispatchState(candidate);
    if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false
      || state.outcome !== 'launched' || state.terminalAt || state.worktreeBindingSource !== 'worktree-create'
      || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
    return withTicketLock(slug, candidate.id, () => {
      const ticket = getTicket(slug, candidate.id);
      const current = dispatchState(ticket);
      const generation = worktreeCallbackGenerationRefusal(current, attempt);
      if (generation) return generation;
      if (!current || current.sessionId !== normalizedSessionId || current.terminalAt
        || !current.worktree || canonicalPath(current.worktree) !== boundWorktree) {
        return { ok: false, reason: 'dispatch_binding_unavailable' };
      }
      current.worktreeProvisionedAt = new Date().toISOString();
      stampDispatchEvent(ticket, 'worktree-provisioned', current.worktreeProvisionedAt);
      putTicket(slug, ticket);
      return { ok: true };
    });
  }
  return { ok: false, reason: 'dispatch_binding_unavailable' };
}

function recordDispatchWorktreeProvisioningFailure(slug?: any, sessionId?: any, worktree?: any, failure?: any, attempt?: any) {
  if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: 'missing_attempt' };
  const normalizedSessionId = String(sessionId || '').trim();
  const target = String(worktree || '').trim();
  const command = String(failure?.command || '').trim();
  const reason = String(failure?.reason || '').trim();
  if (!normalizedSessionId || !target || !command || !reason) return { ok: false, reason: 'missing_provisioning_failure_facts' };
  const boundWorktree = canonicalPath(target);
  for (const candidate of listTickets(slug)) {
    const state = dispatchState(candidate);
    if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false
      || state.outcome !== 'launched' || state.terminalAt || state.worktreeBindingSource !== 'worktree-create'
      || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
    return withTicketLock(slug, candidate.id, () => {
      const ticket = getTicket(slug, candidate.id);
      const current = dispatchState(ticket);
      const generation = worktreeCallbackGenerationRefusal(current, attempt);
      if (generation) return generation;
      if (!current || current.sessionId !== normalizedSessionId || current.sharedTree !== false
        || current.outcome !== 'launched' || current.terminalAt || current.worktreeBindingSource !== 'worktree-create'
        || !current.worktree || canonicalPath(current.worktree) !== boundWorktree || !current.worktreeCreationCompletedAt) {
        return { ok: false, reason: 'dispatch_binding_unavailable' };
      }
      current.worktreeProvisioningFailure = {
        command,
        reason,
        stderrTail: String(failure?.stderrTail || '').trim().slice(-1_000),
        at: new Date().toISOString(),
      };
      stampDispatchEvent(ticket, 'worktree-setup-incomplete', current.worktreeProvisioningFailure.at);
      putTicket(slug, ticket);
      return { ok: true };
    });
  }
  return { ok: false, reason: 'dispatch_binding_unavailable' };
}

function normalizedOwnedDependencyLink(worktree: string, dependency?: any) {
  const relativePath = String(dependency?.relativePath || '').replace(/\\/g, '/');
  const target = String(dependency?.target || '').trim();
  if (!relativePath || path.isAbsolute(relativePath) || !path.isAbsolute(target)) return null;
  const linkPath = path.resolve(worktree, relativePath);
  const normalizedRelativePath = path.relative(worktree, linkPath).split(path.sep).join('/');
  if (normalizedRelativePath !== relativePath || normalizedRelativePath.split('/').some((segment: string) => !segment || segment === '.' || segment === '..')) return null;
  const outsideWorktree = path.relative(worktree, linkPath);
  if (outsideWorktree === '..' || outsideWorktree.startsWith(`..${path.sep}`) || path.isAbsolute(outsideWorktree)) return null;
  return { relativePath, target: canonicalPath(target), mode: dependency?.mode === 'copy' ? 'copy' : 'link' };
}

function recordDispatchWorktreeDependencyLink(slug?: any, sessionId?: any, worktree?: any, dependency?: any, attempt?: any) {
  if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: 'missing_attempt' };
  const normalizedSessionId = String(sessionId || '').trim();
  const target = String(worktree || '').trim();
  if (!normalizedSessionId || !target) return { ok: false, reason: 'missing_dependency_link_facts' };
  const boundWorktree = canonicalPath(target);
  const link = normalizedOwnedDependencyLink(boundWorktree, dependency);
  if (!link) return { ok: false, reason: 'invalid_dependency_link_facts' };
  for (const candidate of listTickets(slug)) {
    const state = dispatchState(candidate);
    if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false
      || state.outcome !== 'launched' || state.terminalAt || state.worktreeBindingSource !== 'worktree-create'
      || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
    return withTicketLock(slug, candidate.id, () => {
      const ticket = getTicket(slug, candidate.id);
      const current = dispatchState(ticket);
      const generation = worktreeCallbackGenerationRefusal(current, attempt);
      if (generation) return generation;
      if (!current || current.sessionId !== normalizedSessionId || current.sharedTree !== false
        || current.outcome !== 'launched' || current.terminalAt || current.worktreeBindingSource !== 'worktree-create'
        || !current.worktree || canonicalPath(current.worktree) !== boundWorktree || !current.worktreeCreationCompletedAt
        || !current.worktreeGitDirectory || !current.worktreeCommonGitDirectory || !current.worktreeCheckoutInstance || !current.worktreeObservedRevision) {
        return { ok: false, reason: 'dispatch_binding_unavailable' };
      }
      const records = Array.isArray(current.ownedDependencyLinks) ? current.ownedDependencyLinks : [];
      const existing = records.find((record: any) => String(record?.relativePath || '') === link.relativePath);
      const record = {
        relativePath: link.relativePath,
        target: link.target,
        mode: link.mode,
        worktree: canonicalPath(current.worktree),
        gitDirectory: canonicalPath(current.worktreeGitDirectory),
        commonGitDirectory: canonicalPath(current.worktreeCommonGitDirectory),
        checkoutInstance: String(current.worktreeCheckoutInstance),
        revision: String(current.worktreeObservedRevision),
      };
      if (existing) {
        return JSON.stringify(existing) === JSON.stringify(record)
          ? { ok: true, alreadyRecorded: true }
          : { ok: false, reason: 'dependency_link_record_mismatch' };
      }
      current.ownedDependencyLinks = [...records, record];
      stampDispatchEvent(ticket, 'worktree-dependency-link-created');
      putTicket(slug, ticket);
      return { ok: true, alreadyRecorded: false };
    });
  }
  return { ok: false, reason: 'dispatch_binding_unavailable' };
}

function recordRecoveredCheckoutIdentity(state: NativeCheckoutCreation, facts: NativeCheckoutFacts | null): void {
  if (state.worktreeCreationCompletedAt) return;
  const checkoutCommit = String(compositionCheckoutCommit(state)).trim();
  if (facts && checkoutCommit && facts.revision === checkoutCommit) recordCreatedCheckoutIdentity(state, facts);
}

// A hook that failed before its checkout existed must not leave the attempt naming a path it never
// created: whatever sits there later is someone else's, and retry cleanup would reclaim it (SQ-3132).
function holdOrReleaseUncreatedCheckout(slug: string, ticket: CompositionTicket, state: NativeCheckoutCreation, sessionId: string, created?: boolean) {
  if (created !== false) return;
  const held = holdUncreatedFailureForSibling(slug, ticket, state, sessionId);
  if (held) return held;
  releaseCrossedCreationBinding(state, null, new Date().toISOString(), 'worktree_create_failed');
}

type ExecutorDispatchedTicket = CompositionTicket & { dispatchExecutor?: string | null };

function terminalizeFailedCheckoutCreation(slug: string, ticket: ExecutorDispatchedTicket, error: unknown): void {
  setDispatchTerminal(ticket, 'failed', 'worktree-create-recovery', {
    slug,
    error,
    failureShape: 'worktree_create_failed',
  });
  ticket.dispatchNonce = null;
  ticket.dispatchExecutor = null;
  stampDispatchEvent(ticket, 'worktree-create-recovery');
  putTicket(slug, ticket);
}

function recoverLaunchedCheckout(slug: string, id: string, binding: { sessionId: string; worktree: string }, error: unknown, attempt: string | undefined, options: { created?: boolean } | undefined, facts: NativeCheckoutFacts | null) {
  const ticket: ExecutorDispatchedTicket = getTicket(slug, id);
  const state: NativeCheckoutCreation | undefined = dispatchState(ticket);
  const generation = worktreeCallbackGenerationRefusal(state, attempt);
  if (generation) return generation;
  if (!launchedNativeCheckoutMatches(state, binding)) return { ok: false, reason: 'dispatch_binding_unavailable' };
  recordRecoveredCheckoutIdentity(state, facts);
  const held = holdOrReleaseUncreatedCheckout(slug, ticket, state, binding.sessionId, options?.created);
  if (held) return held;
  terminalizeFailedCheckoutCreation(slug, ticket, error);
  return { ok: true, ticket };
}

// Recovery is the hook's failure path, and it is generation-scoped for the same reason the recorders are:
// a retired hook that caught its own correct `stale_attempt` used to land here and terminalize the live
// replacement, clearing its nonce and marking it failed while the hook's own stderr said the live attempt
// was untouched (SQ-2953 finding 1, hook-race-probe.json).
function recoverDispatchWorktreeCreation(slug?: any, sessionId?: any, worktree?: any, error?: any, attempt?: any, options?: { created?: boolean }) {
  if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: 'missing_attempt' };
  const normalizedSessionId = String(sessionId || '').trim();
  const target = String(worktree || '').trim();
  const meta = readMeta(slug);
  if (!normalizedSessionId || !target || !meta?.path) return { ok: false, reason: 'missing_binding_facts' };
  const boundWorktree = canonicalPath(target);
  const matches = listTickets(slug).filter((candidate?: any) => {
    const state = dispatchState(candidate);
    return Boolean(state && state.sessionId === normalizedSessionId && state.sharedTree === false
      && state.outcome === 'launched' && !state.terminalAt && state.worktreeBindingSource === 'worktree-create'
      && state.worktree && canonicalPath(state.worktree) === boundWorktree);
  });
  if (matches.length !== 1) return { ok: false, reason: matches.length ? 'ambiguous_binding' : 'dispatch_binding_unavailable' };
  const facts: NativeCheckoutFacts | null = dispatchState(matches[0]).worktreeCreationCompletedAt ? null : immutableWorktreeFacts(slug, boundWorktree);
  const terminal = withTicketLock(slug, matches[0].id, () => recoverLaunchedCheckout(slug, matches[0].id, { sessionId: normalizedSessionId, worktree: boundWorktree }, error, attempt, options, facts));
  if (!terminal?.ok || terminal.heldFor) return terminal;
  const cleanup = reclaimRetiredAttemptCheckout(slug, meta.path, terminal.ticket, dispatchState(terminal.ticket));
  return { ok: true, ticket: terminal.ticket, cleanup };
}

// Answers "was this running agent promised a linked worktree?" for the write
// guard. The harness deletes an isolated worktree when an agent stops with it
// unchanged, so a resumed executor is silently handed the shared checkout.
// Terminal dispatches stay here for their original agent id: that executor no
// longer has a legal write target, and the guard must keep refusing its writes.
// Session fallback deliberately excludes terminal no-claim dispatches so an
// old executor cannot taint a different agent in the same session.
// A commit the board authored for a held claim, so the write lease can tell the executor's own
// sanctioned work from drift. Recorded rather than derived because the observed HEAD alone cannot say who
// moved it, and the lease must keep refusing a revision this dispatch did not create (SQ-2182).
function recordSanctionedCommit(slug?: any, idOrRef?: any, opts?: any) {
  const by = String(opts?.by || '').trim();
  const commit = String(opts?.commit || '').trim().toLowerCase();
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  if (!by || !commit) return { ok: false, reason: 'missing_sanctioned_commit_facts' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const state = dispatchState(ticket);
    if (!state) return { ok: false, reason: 'no_dispatch', ticket };
    if (ticket.claim?.by !== by) return { ok: false, reason: 'not_owner', ticket };
    const recorded: string[] = Array.isArray(state.sanctionedCommits) ? state.sanctionedCommits.map(String) : [];
    if (!recorded.includes(commit)) recorded.push(commit);
    state.sanctionedCommits = recorded;
    putTicket(slug, ticket);
    return { ok: true, ticket, sanctionedCommits: recorded };
  });
}

// Only while the claim is still held. A released claim leaves the recorded commits in place as history,
// and reading them through this gate is what keeps the rebind following the claim instead of widening the
// write window for anyone who later lands in the same worktree.
function sanctionedRevisionsForLiveClaim(ticket?: any, state?: any): string[] {
  if (!ticket?.claim?.by || !Array.isArray(state?.sanctionedCommits)) return [];
  return state.sanctionedCommits.map((commit: any) => String(commit).toLowerCase());
}

function worktreeIdentityKey(worktree?: any) {
  const normalized = canonicalPath(String(worktree || '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Two dispatches in one session share a session id and an executor name, so session matching alone
// reports both and the caller cannot tell them apart. Their worktrees are distinct, and the guard
// already knows which checkout the write landed in, so the observed worktree names exactly one of
// them. This can only ever narrow an already-matched set, never widen it (SQ-2189).
function dispatchesForObservedWorktree(candidates: any[], observedWorktree: string) {
  if (candidates.length <= 1 || !observedWorktree) return candidates;
  const observed = worktreeIdentityKey(observedWorktree);
  return candidates.filter((candidate) => {
    if (!candidate.worktree) return false;
    const expected = worktreeIdentityKey(candidate.worktree);
    // Callers observe a checkout root, but some only know a working directory somewhere inside it, so a
    // path under the worktree still names that dispatch and nothing else.
    return observed === expected || observed.startsWith(`${expected}/`);
  });
}

function canonicalCheckout(value?: any) {
  const trimmed = String(value || '').trim();
  return trimmed ? canonicalPath(trimmed) : '';
}

// The two checkouts a completion gate can compare, once both are known and they disagree. Nothing here is a
// crossing yet: an isolated dispatch running somewhere other than its bound tree is the ordinary shape of a
// relocation too.
function mismatchedGateCheckouts(state?: any, actualWorktree?: any) {
  const actual = canonicalCheckout(actualWorktree);
  const bound = canonicalCheckout(state?.worktree);
  if (state?.sharedTree !== false || !actual || !bound || actual === bound) return null;
  return { boundWorktree: bound, actualWorktree: actual };
}

// The other side of a crossing, asked of one checkout: the same occupancy fact creation reads, minus the ticket
// being gated. A holder that has not claimed is deliberately not one - see `crossedWorktreeBinding`.
function otherLiveClaimOnCheckout(slug?: any, ref?: string, checkout?: string) {
  for (const candidate of listTickets(slug)) {
    if (candidate?.ref === ref) continue;
    const state = dispatchState(candidate);
    if (!liveClaimOccupiesCheckout(candidate, state, checkout)) continue;
    return { ref: candidate.ref, claimHolder: String(candidate.claim.by), worktree: String(checkout) };
  }
  return null;
}

// The completion gates are the first authority that learns where an executor ACTUALLY is: commit, submit and
// verify-capture are all handed the caller's own worktree root, while everything downstream of the dispatch
// record reads the bound one. When those disagree and one of the two checkouts belongs to a different live
// claim, the disagreement is a crossing, not a caller mistake, and the gates have to say so: reading the bound
// tree instead answers with another ticket's working state - the shape that listed a sibling's 27 test names
// back at an executor as if they were its own (GH-235).
//
// Narrowed to a proven crossing on purpose. A mismatch with no other live claim behind it can be an ordinary
// relocation, a continuation resuming its source checkout among them, and refusing those would strand work the
// board has no reason to doubt. The cost of that narrowing is real and accepted: between a sibling's creation
// binding and its claim there is a window in which the other side holds no claim, so a gate running in that
// window still reads the foreign tree and is not refused. A claim is the only per-record fact that marks a
// checkout as somebody's live working tree, and refusing every unclaimed mismatch would cost far more.
function crossedWorktreeBinding(slug?: any, ticket?: any, actualWorktree?: any) {
  const checkouts = mismatchedGateCheckouts(dispatchState(ticket), actualWorktree);
  if (!checkouts) return null;
  const owner = otherLiveClaimOnCheckout(slug, ticket.ref, checkouts.actualWorktree)
    || otherLiveClaimOnCheckout(slug, ticket.ref, checkouts.boundWorktree);
  return owner ? { ref: ticket.ref, claimHolder: gatedClaimHolder(ticket), ...checkouts, owner } : null;
}

// The printed remedy names the claim it acts on: the CLI's own identity falls back to the environment or the host
// name, so a release without `--by` is answered as somebody else's claim and the crossed claim stays live.
function gatedClaimHolder(ticket?: any) {
  return ticket?.claim?.by ? String(ticket.claim.by) : '<your claim id>';
}

function dispatchIsolationExpectation(identity?: any) {
  const sessionId = String(identity?.sessionId || '').trim();
  const executor = String(identity?.executor || '').trim();
  const agentId = String(identity?.agentId || '').trim();
  const observedWorktree = String(identity?.observedWorktree || '').trim();
  if (!agentId && !(sessionId && executor)) return null;
  const byAgent: any[] = [];
  const bySession: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state) continue;
      const terminalWithoutClaim = Boolean(state.terminalAt && !(ticket.claim && ticket.claim.by));
      const candidate = {
        ref: ticket.ref,
        project: project.slug,
        projectPath: readMeta(project.slug)?.path || null,
        sharedTree: state.sharedTree !== false,
        terminal: terminalWithoutClaim,
        agentId: state.agentId ? String(state.agentId) : null,
        worktree: state.worktree ? String(state.worktree) : null,
        worktreeGitDirectory: state.worktreeGitDirectory ? String(state.worktreeGitDirectory) : null,
        worktreeCommonGitDirectory: state.worktreeCommonGitDirectory ? String(state.worktreeCommonGitDirectory) : null,
        worktreeCheckoutInstance: state.worktreeCheckoutInstance ? String(state.worktreeCheckoutInstance) : null,
        worktreeObservedRevision: state.worktreeObservedRevision ? String(state.worktreeObservedRevision) : null,
        worktreeBindingSource: state.worktreeBindingSource ? String(state.worktreeBindingSource) : null,
        baseCommit: state.baseCommit ? String(state.baseCommit) : null,
        sanctionedRevisions: sanctionedRevisionsForLiveClaim(ticket, state),
        claimHeld: Boolean(ticket.claim && ticket.claim.by),
        phase: state.terminalAt ? 'terminal' : state.outcome === 'claimed' ? 'claimed' : 'bound',
      };
      if (agentId && candidate.agentId === agentId) byAgent.push(candidate);
      else if (!terminalWithoutClaim && sessionId && executor && state.sessionId === sessionId && state.executor === executor
        && ['launched', 'claimed'].includes(state.outcome)) {
        bySession.push(candidate);
      }
    }
  }
  const agentMatches = dispatchesForObservedWorktree(byAgent, observedWorktree);
  const sessionMatches = dispatchesForObservedWorktree(bySession, observedWorktree);
  const matchedByAgentIdentity = agentMatches.length === 1;
  const matched = matchedByAgentIdentity ? agentMatches : sessionMatches.length === 1 ? sessionMatches : [];
  if (!matched.length) return null;
  const expectation = matched[0];
  return {
    ref: expectation.ref,
    project: expectation.project,
    projectPath: expectation.projectPath,
    sharedTree: matched.some((candidate) => candidate.sharedTree),
    terminal: matched.some((candidate) => candidate.terminal),
    matchedBy: matchedByAgentIdentity ? 'agent' : 'session',
    identityBound: Boolean(agentId && expectation.agentId === agentId),
    dispatchBaseline: expectation.baseCommit,
    sanctionedRevisions: expectation.sanctionedRevisions,
    claimHeld: expectation.claimHeld,
    phase: expectation.phase,
    expectedWorktree: expectation.worktree,
    expectedGitDirectory: expectation.worktreeGitDirectory,
    expectedCommonGitDirectory: expectation.worktreeCommonGitDirectory,
    expectedCheckoutInstance: expectation.worktreeCheckoutInstance,
    expectedRevision: expectation.worktreeObservedRevision,
    worktreeBindingSource: expectation.worktreeBindingSource,
  };
}

// Every cause of an unresolved identity produces the same refusal sentence, and the hook payload that
// would tell them apart is gone by the time anyone reads it. SQ-2189 cost a full investigation to
// establish which one it was, so the counts travel with the refusal: a zero session count means the id
// the caller reported is not the one the dispatch recorded, a count above one on session+executor means
// concurrent dispatches share an identity, and a zero agent-id count means runtime binding never landed.
function dispatchIdentityDiagnosis(identity?: any) {
  const sessionId = String(identity?.sessionId || '').trim();
  const executor = String(identity?.executor || '').trim();
  const agentId = String(identity?.agentId || '').trim();
  const observedWorktree = String(identity?.observedWorktree || '').trim();
  const observed = observedWorktree ? worktreeIdentityKey(observedWorktree) : '';
  const counts = { live: 0, session: 0, sessionExecutor: 0, agent: 0, worktree: 0 };
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || (state.terminalAt && !ticket.claim?.by) || !['launched', 'claimed'].includes(state.outcome)) continue;
      counts.live += 1;
      if (sessionId && state.sessionId === sessionId) {
        counts.session += 1;
        if (executor && state.executor === executor) counts.sessionExecutor += 1;
      }
      if (agentId && state.agentId && String(state.agentId) === agentId) counts.agent += 1;
      if (observed && state.worktree && worktreeIdentityKey(state.worktree) === observed) counts.worktree += 1;
    }
  }
  return counts;
}

function dispatchUnboundClaim(identity?: any) {
  const sessionId = String(identity?.sessionId || '').trim();
  const executor = String(identity?.executor || '').trim();
  const observedWorktree = String(identity?.observedWorktree || '').trim();
  const agentName = String(identity?.agentName || '').trim();
  if (!sessionId || !executor) return null;
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    const projectPath = readMeta(project.slug)?.path || null;
    if (observedWorktree && (!projectPath || worktreeIdentityKey(projectPath) !== worktreeIdentityKey(observedWorktree))) continue;
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sharedTree !== true || state.sessionId !== sessionId || state.executor !== executor
        || state.agentId || !ticket.claim?.by || state.terminalAt || state.outcome !== 'claimed') continue;
      if (agentName && state.agentName && state.agentName !== agentName) continue;
      matches.push({ ref: ticket.ref, project: project.slug });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Where this dispatch's executor is working and what its work is measured
// against, by the same convention the isolation guard enforces: the board
// checkout for a shared-tree dispatch, the agent's own linked worktree for an
// isolated one. Null whenever either is unknowable — no bound runtime identity,
// a worktree that is already gone, no recorded baseline — which is exactly when
// a caller must not conclude that a run wrote nothing (SQ-923).
function dispatchWorkspace(slug?: any, ticket?: any) {
  const state = dispatchState(ticket);
  const projectPath = readMeta(slug)?.path || null;
  if (!state || !projectPath) return null;
  const baseCommit = String(state.baseCommit || '').trim() || null;
  if (state.sharedTree !== false) return baseCommit ? { root: projectPath, base: baseCommit } : null;
  const agentId = String(state.agentId || '').trim();
  if (!agentId) return null;
  const root = String(state.worktree || '').trim();
  if (!root || !fs.existsSync(root)) return null;
  let base = baseCommit;
  if (!base) {
    try { base = integrationTarget(slug)?.upstream || null; } catch (_: any) { base = null; }
  }
  return base ? { root, base } : null;
}

function dispatchDelta(slug?: any, ticket?: any) {
  const state = dispatchState(ticket);
  const projectPath = readMeta(slug)?.path || null;
  const sharedTreeWithoutCommit = state && state.sharedTree !== false && projectPath
    ? { root: projectPath, base: null }
    : null;
  const workspace = dispatchWorkspace(slug, ticket) || sharedTreeWithoutCommit;
  if (!workspace) return { ok: false, reason: 'workspace_unavailable' };
  try {
    const workingState = state?.sharedTree !== false
      ? postDispatchWorkingState(slug, state)
      : { working: commitScope.workingPaths(workspace.root), preExisting: [], baselineRecorded: false };
    let head: string | null = null;
    try {
      head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: workspace.root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (error: any) {
      if (workspace.base) throw error;
    }
    let commits: string[] = [];
    if (head && workspace.base) {
      const base = execFileSync('git', ['rev-parse', '--verify', `${workspace.base}^{commit}`], {
        cwd: workspace.root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      commits = base === head ? [] : execFileSync('git', ['rev-list', `${base}..${head}`], {
        cwd: workspace.root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim().split(/\r?\n/).filter(Boolean);
    } else if (head) {
      commits = execFileSync('git', ['rev-list', '--reverse', head], {
        cwd: workspace.root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim().split(/\r?\n/).filter(Boolean);
    }
    const committed = commits.length ? commitScope.rangePaths(workspace.root, commits) : [];
    return { ok: true, workspace, ...workingState, committed };
  } catch (error: any) {
    return { ok: false, reason: 'git_error', message: error?.message || String(error) };
  }
}

// The runtime hooks all match on a session id that is stored verbatim inside the ticket record, so
// SQLite can discard every other ticket without JS parsing it. Walking listTickets() over every
// project instead cost 2.0s of the 5000ms the host hardcodes for SubagentStop on its interrupted
// -query path, over 5190 tickets, and grew with the board forever (SQ-2864). The narrowed rows are
// read-only match candidates: every mutation still re-reads its ticket with getTicket under the
// ticket lock, which is where the normalization this skips (derived routing) actually matters.
function ticketsMentioningSession(sessionId: string) {
  const pattern = `%${sessionId.replace(/[\\%_]/g, (character: string) => `\\${character}`)}%`;
  const candidates: { slug: string; ticket: any }[] = [];
  for (const row of db.selectRows(database(), "SELECT project, data FROM tickets WHERE data LIKE ? ESCAPE '\\'", [pattern])) {
    try {
      const ticket = normalizePreparedDispatch(JSON.parse(row.data));
      if (ticket?.id) candidates.push({ slug: String(row.project), ticket });
    } catch (_) { /* an unreadable row cannot carry a matchable identity */ }
  }
  return candidates;
}

function activeSharedTreeClaim(identity?: any) {
  const agentId = String(identity?.agentId || '').trim();
  const executor = String(identity?.executor || '').trim();
  if (!agentId || !executor) return null;
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    const projectPath = readMeta(project.slug)?.path || null;
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!state || state.sharedTree !== true || state.terminalAt || !ticket.claim?.by) continue;
      if (String(state.agentId || '') !== agentId || String(state.executor || '') !== executor) continue;
      matches.push({ ref: ticket.ref, project: project.slug, projectPath });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function dispatchIdentityAmbiguous(matches: any[], agentName?: any) {
  return matches.length > 1 && (!agentName || matches.some((match?: any) => match.sharedTree === false) || new Set(matches.map((match?: any) => match.slug)).size > 1);
}

function dispatchCanBindRuntimeIdentity(state?: any, sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  if (!state || state.sessionId !== sessionId || state.executor !== executor || !['launched', 'claimed'].includes(state.outcome)) return false;
  if (agentName && state.agentName && state.agentName !== agentName) return false;
  if (agentId) return !state.agentId || state.agentId === agentId;
  return Boolean(agentName && state.agentName === agentName);
}

function syncClaimRuntimeIdentity(ticket?: any, state?: any) {
  const runtime = ticket?.claim?.runtime;
  if (!runtime || runtime.sessionId !== state?.sessionId || runtime.executor !== state?.executor) return;
  ticket.claim.runtime = {
    sessionId: state.sessionId || null,
    executor: state.executor || null,
    agentId: state.agentId || null,
    agentName: state.agentName || null,
  };
}

function recordDispatchRuntimeIdentity(slug?: any, state?: any, agentId?: any, agentName?: any, now?: any, worktreeFacts?: any) {
  if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts
    && (!boundIsolatedWorktree(state)
      || canonicalPath(state.worktree) !== worktreeFacts.worktree)) return false;
  if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts
    && state.worktreeCreationCompletedAt
    && (canonicalPath(String(state.worktreeGitDirectory || '')) !== worktreeFacts.gitDirectory
      || canonicalPath(String(state.worktreeCommonGitDirectory || '')) !== worktreeFacts.commonGitDirectory
      || String(state.worktreeCheckoutInstance || '') !== worktreeFacts.checkoutInstance
      || String(state.worktreeObservedRevision || '') !== worktreeFacts.revision)) return false;
  if (agentId) state.agentId = agentId;
  if (agentName) state.agentName = agentName;
  if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts) {
    state.worktree = worktreeFacts.worktree;
    state.worktreeGitDirectory = worktreeFacts.gitDirectory;
    state.worktreeCommonGitDirectory = worktreeFacts.commonGitDirectory;
    state.worktreeCheckoutInstance = worktreeFacts.checkoutInstance;
    state.worktreeObservedRevision = worktreeFacts.revision;
    state.worktreeBoundAt = state.worktreeBoundAt || now || new Date().toISOString();
  }
  state.boundAt = state.boundAt || now || new Date().toISOString();
  return true;
}

function bindDispatchClaimToken(state?: any, attempt?: any, sessionId?: any, executor?: any, now?: any) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedExecutor = String(executor || '').trim();
  if (!state || !normalizedSessionId || !normalizedExecutor || !['prepared', 'launched'].includes(attempt?.state)) return null;
  const boundAttempt = transitionAttempt(attempt, attempt.state === 'prepared' ? 'bind_claim_token' : 'bind');
  if (attemptDiagnostic(boundAttempt)) return null;
  state.sessionId = normalizedSessionId;
  state.executor = normalizedExecutor;
  state.boundAt = state.boundAt || now || new Date().toISOString();
  state.bindSource = 'claim_token';
  return boundAttempt;
}

// The shape a reported checkout can still be attributed to: this session's isolated reservation, with no
// agent, claim or terminal outcome of its own. Whether it already holds a creation-order binding is what
// separates an exchange from a one-sided move.
function attributableCreationReservation(ticket?: any, state?: any, sessionId?: any) {
  return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && !state.terminalAt
    && !state.continuation?.sourceWorktree && !state.agentId && !state.claimedAt && !ticket?.claim?.by);
}

function unclaimedCreationReservation(ticket?: any, state?: any, sessionId?: any) {
  return Boolean(attributableCreationReservation(ticket, state, sessionId)
    && state.worktreeBindingSource === 'worktree-create' && state.worktree);
}

// Who a crossed creation order can still take a checkout back FROM. A claim is not proof of which checkout a
// record holds - the claim carries no path, and a runtime identity is the only fact that binds one - so a sibling
// that claimed before anybody's SubagentStart corrected the crossing used to freeze it permanently: the reporting
// agent found no eligible holder, its own bind was refused `worktree_binding_mismatch`, and both records kept a
// checkout the other executor was running in, which is what every completion gate then read (GH-235). Identity is
// the line that matters, so a holder that has never bound an agent id is still exchangeable, claimed or not,
// while a holder whose agent proved its checkout keeps it.
function crossedCreationHolder(state?: any, sessionId?: any) {
  return liveSessionDispatch(state, sessionId)
    && !state.continuation?.sourceWorktree && !state.agentId
    && state.worktreeBindingSource === 'worktree-create' && Boolean(state.worktree);
}

// What the checkout carries rather than the record: the completion stamp downstream binds require, and the
// links provisioning made inside it, which cleanup reads from whichever dispatch owns the checkout.
function movedCreationRecord(state?: any) {
  return {
    worktreeBindingSource: 'worktree-create',
    worktreeCreationCompletedAt: state?.worktreeCreationCompletedAt || null,
    ownedDependencyLinks: Array.isArray(state?.ownedDependencyLinks) ? state.ownedDependencyLinks : [],
    worktreeProvisioningFailure: state?.worktreeProvisioningFailure || null,
  };
}

function releaseCrossedCreationBinding(state?: any, otherRef?: any, now?: any, reason = 'creation_order') {
  const from = canonicalPath(state.worktree);
  Object.assign(state, movedCreationRecord(null), {
    worktreeBindingSource: null,
    worktree: null,
    worktreeGitDirectory: null,
    worktreeCommonGitDirectory: null,
    worktreeCheckoutInstance: null,
    worktreeObservedRevision: null,
    worktreeBoundAt: null,
    worktreeBindingExchange: { at: now, from, with: otherRef, reason },
  });
}

function applyExchangedCreationBinding(state?: any, facts?: any, otherRef?: any, now?: any) {
  const from = state.worktree ? canonicalPath(state.worktree) : null;
  state.worktree = facts.worktree;
  state.worktreeGitDirectory = facts.gitDirectory;
  state.worktreeCommonGitDirectory = facts.commonGitDirectory;
  state.worktreeCheckoutInstance = facts.checkoutInstance;
  state.worktreeObservedRevision = facts.revision;
  state.worktreeBoundAt = now;
  state.worktreeBindingExchange = { at: now, from, with: otherRef, reason: 'creation_order' };
}

// Worktree creation cannot know which reservation a new checkout belongs to: its hook carries the session and the
// path, and the harness agent id that names the path first reaches the board HERE. Under a fan-out every sibling
// reservation is eligible, so creation attributes them in creation order, and any other creation order leaves each
// reservation holding a sibling's checkout (SQ-2190). This bind is the first fact that can settle it, because the
// agent reports the checkout it is actually running in, and an observation outranks a guess.
//
// Confined to two reservations of the same session that are both still identity-unbound - the reporting side also
// still unclaimed, the holder claimed or not - so a checkout is never taken from an executor that has proven it
// owns one, and a path no reservation in this session created still matches nothing and is still refused. A
// holder's claim cannot stand in for that proof: it names no checkout, so waiting for it only freezes the
// crossing (GH-235). Both records are rewritten under one transaction, with the
// locks taken in id order so two siblings exchanging at once cannot deadlock and the loser finds nothing to do.
//
// The crossing is not always a pair. When a sibling's WorktreeCreate died before it reserved anything, creation
// attributed the surviving checkout to a reservation that never created one, and the reporting agent holds
// nothing to give back, so the move is one-sided. Refusing that left a sibling's checkout recorded as the
// stalled attempt's own, and that fact is immutable: it then refused every retry of the stalled ticket (SQ-2926).
function exchangeCrossedCreationBinding(slug?: any, ticketId?: any, sessionId?: any, reportedWorktree?: any) {
  const reported = canonicalPath(String(reportedWorktree || '').trim());
  if (!reported) return null;
  const parties = crossedCreationParties(slug, ticketId, sessionId, reported);
  if (!parties) return null;
  const lockedIds = [parties.target.id, parties.holder.id].sort();
  return withTicketFileLocks(lockedIds.map((id: string) => ({ slug, id })), () => {
    const generations = ticketGenerations(slug, lockedIds);
    const crossing = crossedCreationExchange(slug, ticketId, sessionId, reported);
    if (!crossing || crossing.holder.id !== parties.holder.id) return null;
    return guardedTransaction(() => writeCreationExchange(slug, sessionId, crossing, lockedIds, generations));
  });
}

type CreationParties = { target: StoredRecord; holder: StoredRecord; held: string };

function crossedCreationParties(slug: string, ticketId: string, sessionId: string, reported: string): CreationParties | null {
  const target = getTicket(slug, ticketId);
  const targetState = dispatchState(target);
  if (!attributableCreationReservation(target, targetState, sessionId)) return null;
  const held = targetState.worktree ? canonicalPath(targetState.worktree) : '';
  if (held === reported) return null;
  const holder = crossedCreationHolderOf(slug, target, sessionId, reported);
  return holder ? { target, holder, held } : null;
}

type CreationCrossing = { target: StoredRecord; holder: StoredRecord; reportedFacts: WorktreeFacts; heldFacts: WorktreeFacts | null };

// Read again under both file locks, after their generations: the Git facts then describe these exact records.
function crossedCreationExchange(slug: string, ticketId: string, sessionId: string, reported: string): CreationCrossing | null {
  const parties = crossedCreationParties(slug, ticketId, sessionId, reported);
  return parties ? crossingAtSharedBaseline(slug, parties.target, parties.holder, reported, parties.held) : null;
}

function crossedCreationHolderOf(slug: string, target: StoredRecord, sessionId: string, reported: string): StoredRecord | undefined {
  return listTickets(slug).find((candidate?: any) => candidate.id !== target.id
    && crossedCreationHolder(dispatchState(candidate), sessionId)
    && canonicalPath(dispatchState(candidate).worktree) === reported);
}

function crossingAtSharedBaseline(slug: string, target: StoredRecord, holder: StoredRecord, reported: string, held: string): CreationCrossing | null {
  const baseline = sharedDispatchBaseline(dispatchState(target), dispatchState(holder));
  if (!baseline) return null;
  const facts = baselineCheckoutFacts(slug, baseline, reported, held);
  return facts ? { target, holder, ...facts } : null;
}

function sharedDispatchBaseline(targetState: StoredRecord, holderState: StoredRecord): string {
  const baseline = String(targetState.baseCommit || '').trim();
  return baseline && baseline === String(holderState.baseCommit || '').trim() ? baseline : '';
}

// Both checkouts must still sit at the shared dispatch base, or the exchange could hand an executor's commits away.
function baselineCheckoutFacts(slug: string, baseline: string, reported: string, held: string) {
  const reportedFacts = checkoutAtBaseline(slug, reported, baseline);
  if (!reportedFacts) return null;
  if (!held) return { reportedFacts, heldFacts: null };
  const heldFacts = checkoutAtBaseline(slug, held, baseline);
  return heldFacts ? { reportedFacts, heldFacts } : null;
}

function checkoutAtBaseline(slug: string, worktree: string, baseline: string): WorktreeFacts | null {
  const facts = immutableWorktreeFacts(slug, worktree);
  return facts && facts.revision === baseline ? facts : null;
}

// Both records are checked before either is written: a refusal on the second side must leave the first unwritten,
// because the transaction commits whatever was put before a null return.
function writeCreationExchange(slug: string, sessionId: string, crossing: CreationCrossing, lockedIds: readonly string[], generations: ReadonlyMap<string, string>) {
  if (changedTicketSince(slug, generations)) return null;
  const sides = lockedIds.map((id) => creationExchangeSide(slug, sessionId, crossing, id));
  if (!sides.every((side): side is CreationExchangeSide => side !== null)) return null;
  const now = new Date().toISOString();
  const movedRecord = holderCreationRecord(crossing, sides);
  for (const side of sides) {
    applyCreationExchange(side.state, side.facts, side.otherRef, movedRecord, now);
    stampDispatchEvent(side.ticket, 'worktree-create-exchange', now);
    putTicket(slug, side.ticket);
  }
  return { ok: true, exchangedWith: crossing.holder.ref };
}

type CreationExchangeSide = { ticket: StoredRecord; state: StoredRecord; facts: WorktreeFacts | null; otherRef: string };

function holderCreationRecord(crossing: CreationCrossing, sides: readonly CreationExchangeSide[]) {
  const holderSide = sides.find((side) => side.ticket.id === crossing.holder.id);
  return crossing.heldFacts || !holderSide ? null : movedCreationRecord(holderSide.state);
}

function creationExchangeSide(slug: string, sessionId: string, crossing: CreationCrossing, id: string): CreationExchangeSide | null {
  const ticket = getTicket(slug, id);
  const state = dispatchState(ticket);
  const isTarget = id === crossing.target.id;
  if (!creationExchangeEligible(isTarget, ticket, state, sessionId)) return null;
  const facts = isTarget ? crossing.reportedFacts : crossing.heldFacts;
  if (alreadyHoldsCheckout(state, facts)) return null;
  return { ticket, state, facts, otherRef: isTarget ? crossing.holder.ref : crossing.target.ref };
}

function creationExchangeEligible(isTarget: boolean, ticket: StoredRecord, state: StoredRecord, sessionId: string): boolean {
  return isTarget ? attributableCreationReservation(ticket, state, sessionId) : crossedCreationHolder(state, sessionId);
}

function alreadyHoldsCheckout(state: StoredRecord, facts: WorktreeFacts | null): boolean {
  if (!facts || !state.worktree) return false;
  return canonicalPath(state.worktree) === facts.worktree;
}

function applyCreationExchange(state: StoredRecord, facts: WorktreeFacts | null, otherRef: string, movedRecord: StoredRecord | null, now: string): void {
  if (facts) applyExchangedCreationBinding(state, facts, otherRef, now);
  else releaseCrossedCreationBinding(state, otherRef, now);
  if (facts && movedRecord) Object.assign(state, movedRecord);
}

// Everything a sibling launch leaves before any claim: launched, still live, and nobody holding its claim.
function unclaimedLaunchedReservation(ticket?: any, state?: any, sessionId?: any) {
  return state?.sessionId === sessionId && state.outcome === 'launched' && !state.terminalAt && !ticket?.claim?.by;
}

// A runtime identity no token has vouched for yet: SubagentStart attached it by session, executor, name or
// reported checkout, all of which siblings launched together share or can cross.
function guessedRuntimeIdentity(ticket?: any, state?: any, sessionId?: any, executor?: any) {
  return unclaimedLaunchedReservation(ticket, state, sessionId) && state.executor === executor
    && state.bindSource !== 'claim_runtime_identity';
}

type ClaimAdmission = () => boolean;
type ClaimAdmissionCheck = (slug: any, ticketId: any, opts: any) => any;
type TicketKey = { slug: string; id: string };

// Only a token admits an exchange: a direct claim proves nothing about which reservation this runtime is.
function tokenAdmission(admission: ClaimAdmissionCheck, slug?: any, ticketId?: any, opts?: any): ClaimAdmission {
  return () => admittedByToken(admission(slug, ticketId, opts));
}

function admittedByToken(result?: any) {
  return Boolean(result?.ok && result.token);
}

function claimIdentity(sessionId?: any, executor?: any, agentId?: any) {
  const identity = { sessionId: normalizedText(sessionId), executor: normalizedText(executor), agentId: normalizedText(agentId) };
  return Object.values(identity).every(Boolean) ? identity : null;
}

function guessedClaimTarget(slug?: any, ticketId?: any, identity?: any) {
  const target = identity ? getTicket(slug, ticketId) : null;
  return target && guessedRuntimeIdentity(target, dispatchState(target), identity.sessionId, identity.executor) ? target : null;
}

function holdsClaimingRuntime(entry?: any, slug?: any, target?: any, identity?: any) {
  const state = dispatchState(entry.ticket);
  return !(entry.slug === slug && entry.ticket.id === target.id) && !state?.terminalAt && normalizedText(state?.agentId) === identity.agentId;
}

// Live reservations of this session, other than the claimed one, that hold the claiming runtime's id.
function runtimeHolders(slug?: any, target?: any, identity?: any) {
  return ticketsMentioningSession(identity.sessionId).filter((entry: any) => holdsClaimingRuntime(entry, slug, target, identity));
}

// The reservation holding the claiming runtime must itself still be a guess; with no holder, only a displaced id moves.
function exchangeCandidate(exchange: any) {
  if (!exchange.holder) return exchange.displaced ? exchange : null;
  const holderState = dispatchState(exchange.holder.ticket);
  return guessedRuntimeIdentity(exchange.holder.ticket, holderState, exchange.identity.sessionId, exchange.identity.executor) ? exchange : null;
}

function guessedIdentityExchange(slug?: any, ticketId?: any, identity?: any) {
  const target = guessedClaimTarget(slug, ticketId, identity);
  if (!target) return null;
  const displaced = normalizedText(dispatchState(target).agentId);
  const holders = runtimeHolders(slug, target, identity);
  if (displaced === identity.agentId || holders.length > 1) return null;
  return exchangeCandidate({ slug, target, displaced, holder: holders[0] || null, identity });
}

function identityExchangeStillHolds(exchange: any, current?: any, currentHolder?: any) {
  const { identity } = exchange;
  const stillGuessed = (ticket?: any, agentId?: any) => guessedRuntimeIdentity(ticket, dispatchState(ticket), identity.sessionId, identity.executor)
    && normalizedText(dispatchState(ticket).agentId) === agentId;
  return stillGuessed(current, exchange.displaced) && (!exchange.holder || stillGuessed(currentHolder, identity.agentId));
}

// A stop held while the runtime's reservation was still a guess belongs to the runtime, not to the record, so it
// moves with the agent id.
function moveRuntimeIdentity(slug?: any, ticket?: any, agentId?: any, deferredStop?: any, exchange?: any) {
  const state = dispatchState(ticket);
  state.agentId = agentId || null;
  state.deferredStop = deferredStop;
  state.runtimeIdentityExchange = exchange;
  stampDispatchEvent(ticket, 'claim-identity-exchange', exchange.at);
  putTicket(slug, ticket);
}

function swapRuntimeIdentity(exchange: any, current?: any, currentHolder?: any) {
  const at = new Date().toISOString();
  const withRef = currentHolder ? currentHolder.ref : null;
  const displacedStop = dispatchState(current).deferredStop;
  moveRuntimeIdentity(exchange.slug, current, exchange.identity.agentId, undefined, { at, from: exchange.displaced || null, with: withRef, reason: 'claim_token' });
  if (currentHolder) {
    moveRuntimeIdentity(exchange.holder.slug, currentHolder, exchange.displaced, displacedStop, { at, from: exchange.identity.agentId, with: current.ref, reason: 'claim_token' });
  }
  return { ok: true, exchangedWith: withRef };
}

function applyGuessedIdentityExchange(exchange: any, admitted?: ClaimAdmission) {
  const current = getTicket(exchange.slug, exchange.target.id);
  const currentHolder = exchange.holder ? getTicket(exchange.holder.slug, exchange.holder.ticket.id) : null;
  if (!identityExchangeStillHolds(exchange, current, currentHolder) || !admitted?.()) return null;
  return swapRuntimeIdentity(exchange, current, currentHolder);
}

// SubagentStart cannot tell same-executor siblings of one session apart (hook stdin carries agent_id, never the
// agent name), so it can attach a runtime to its sibling's reservation. Every hook then resolves that runtime to the
// sibling: its writes are judged against the sibling's lease, and it is told to stop when the sibling closes
// (SQ-53, GitHub #298). The dispatch token presented at claim is the first fact that names the runtime's own ticket,
// so it settles the guess. Only guessed identities move: a reservation some token already bound, a claimed one, or a
// terminal one is never rewritten, and the admission is re-checked under both locks, taken in a fixed order so two
// siblings claiming at once cannot deadlock and the loser finds nothing left to exchange.
function exchangeGuessedClaimIdentity(slug?: any, ticketId?: any, sessionId?: any, executor?: any, agentId?: any, admitted?: ClaimAdmission) {
  const exchange = guessedIdentityExchange(slug, ticketId, claimIdentity(sessionId, executor, agentId));
  if (!exchange) return null;
  const keys = [{ slug, id: exchange.target.id }, ...(exchange.holder ? [{ slug: exchange.holder.slug, id: exchange.holder.ticket.id }] : [])];
  return withTicketLocks(keys, () => applyGuessedIdentityExchange(exchange, admitted));
}

// Everything a reservation records about the checkout it holds. These describe the checkout, not the ticket, so when
// a binding moves they move as one unit and the checkout-instance identity is never re-derived.
const CHECKOUT_BINDING_FIELDS = [
  'worktree', 'worktreeGitDirectory', 'worktreeCommonGitDirectory', 'worktreeCheckoutInstance', 'worktreeObservedRevision',
  'worktreeBoundAt', 'worktreeCreationCompletedAt', 'worktreeProvisionedAt', 'ownedDependencyLinks', 'worktreeProvisioningFailure',
  'worktreeBindingSource',
];

const CHECKOUT_IDENTITY_FIELDS = ['worktree', 'gitDirectory', 'commonGitDirectory', 'checkoutInstance'];

const TOKEN_BIND_SOURCES = ['claim_token', 'claim_runtime_identity'];

// A checkout lease WorktreeCreate recorded for an isolated reservation, not one a continuation spawn inherited.
function worktreeCreateLease(state?: any) {
  return state?.sharedTree === false && state.worktreeBindingSource === 'worktree-create' && !state.continuation?.sourceWorktree;
}

function crossedClaimCheckoutReservation(ticket?: any, state?: any, sessionId?: any) {
  return unclaimedLaunchedReservation(ticket, state, sessionId) && !state.claimedAt && worktreeCreateLease(state) && Boolean(state.worktree);
}

// A sibling's checkout binding is still WorktreeCreate's guess only while no token has vouched for its runtime.
function guessedSiblingCheckout(ticket?: any, state?: any, sessionId?: any) {
  return crossedClaimCheckoutReservation(ticket, state, sessionId) && !TOKEN_BIND_SOURCES.includes(state.bindSource);
}

function observedCheckoutMatchesRecord(state?: any, facts?: any) {
  const recorded: any = completedWorktreeCreationFacts(state);
  return Boolean(recorded && facts) && CHECKOUT_IDENTITY_FIELDS.every((field) => recorded[field] === facts[field]);
}

// A checkout is cut at its reservation's baseline and submission ranges are computed against it, so only reservations
// sharing one baseline can trade checkouts.
function sameBaseline(state?: any, other?: any) {
  const baseline = normalizedText(state?.baseCommit);
  return Boolean(baseline) && baseline === normalizedText(other?.baseCommit);
}

function exchangeCheckoutRecords(left?: any, right?: any) {
  for (const field of CHECKOUT_BINDING_FIELDS) {
    const held = left[field];
    left[field] = right[field] === undefined ? null : right[field];
    right[field] = held === undefined ? null : held;
  }
}

function observedClaimCheckout(sessionId?: any, observedWorktree?: any) {
  const claim = { sessionId: normalizedText(sessionId), observed: normalizedText(observedWorktree) };
  return claim.sessionId && claim.observed ? { sessionId: claim.sessionId, observed: canonicalPath(claim.observed) } : null;
}

// An isolated reservation holding no checkout: the checkout its executor runs in is named by some other record, or
// was parked by a supersede (SQ-3139), so it can only arrive one way.
function checkoutlessReservation(ticket?: any, state?: any, sessionId?: any) {
  return unclaimedLaunchedReservation(ticket, state, sessionId) && !state.claimedAt && state.sharedTree === false
    && !state.worktree && !state.continuation?.sourceWorktree;
}

// Only a binding a pre-creation failure released is traded with a live holder at claim time. A reservation that never
// held one is the one-sided crossing its holder's agent report settles (GH-235), and trading it at claim time emptied
// the holder's record that the SQ-3132 retry route reads to keep the claimed sibling's tree (GH-305, SQ-3147).
function releasedCheckoutReservation(ticket?: any, state?: any, sessionId?: any) {
  return checkoutlessReservation(ticket, state, sessionId) && state.worktreeBindingExchange?.reason === 'worktree_create_failed';
}

function leasesAnotherCheckout(ticket?: any, state?: any, claim?: any) {
  return crossedClaimCheckoutReservation(ticket, state, claim.sessionId) && canonicalPath(state.worktree) !== claim.observed;
}

function claimExchangesObservedCheckout(ticket?: any, state?: any, claim?: any) {
  return leasesAnotherCheckout(ticket, state, claim) || releasedCheckoutReservation(ticket, state, claim.sessionId);
}

function claimAdoptsObservedCheckout(ticket?: any, state?: any, claim?: any) {
  return leasesAnotherCheckout(ticket, state, claim) || checkoutlessReservation(ticket, state, claim.sessionId);
}

function crossedCheckoutTarget(slug: any, ticketId: any, claim: any, takesCheckout: typeof claimAdoptsObservedCheckout) {
  const target = getTicket(slug, ticketId);
  return takesCheckout(target, dispatchState(target), claim) ? target : null;
}

function recordedCheckout(state?: any) {
  return state?.worktree ? canonicalPath(state.worktree) : null;
}

function recordsObservedCheckout(candidate?: any, target?: any, claim?: any) {
  return candidate.id !== target.id && guessedSiblingCheckout(candidate, dispatchState(candidate), claim.sessionId)
    && canonicalPath(dispatchState(candidate).worktree) === claim.observed;
}

// Exactly one unvouched sibling records the checkout this executor runs in, on this claim's baseline.
function crossedCheckoutHolder(slug?: any, target?: any, claim?: any) {
  const holders = listTickets(slug).filter((candidate?: any) => recordsObservedCheckout(candidate, target, claim));
  const holder = holders.length === 1 ? holders[0] : null;
  return holder && sameBaseline(dispatchState(target), dispatchState(holder)) ? holder : null;
}

function crossedCheckoutExchange(slug?: any, ticketId?: any, sessionId?: any, observedWorktree?: any) {
  const claim = observedClaimCheckout(sessionId, observedWorktree);
  const target = claim ? crossedCheckoutTarget(slug, ticketId, claim, claimExchangesObservedCheckout) : null;
  const holder = target ? crossedCheckoutHolder(slug, target, claim) : null;
  const facts = holder ? immutableWorktreeFacts(slug, claim!.observed) : null;
  return observedCheckoutMatchesRecord(dispatchState(holder), facts) ? { slug, target, holder, facts, ...claim! } : null;
}

function crossedCheckoutStillHolds(exchange: any, current?: any, currentHolder?: any) {
  return claimExchangesObservedCheckout(current, dispatchState(current), exchange)
    && recordedCheckout(dispatchState(current)) === recordedCheckout(dispatchState(exchange.target))
    && guessedSiblingCheckout(currentHolder, dispatchState(currentHolder), exchange.sessionId)
    && observedCheckoutMatchesRecord(dispatchState(currentHolder), exchange.facts);
}

function applyCrossedCheckoutExchange(exchange: any, admitted?: ClaimAdmission) {
  const current = getTicket(exchange.slug, exchange.target.id);
  const currentHolder = getTicket(exchange.slug, exchange.holder.id);
  if (!crossedCheckoutStillHolds(exchange, current, currentHolder) || !admitted?.()) return null;
  const currentState = dispatchState(current);
  const holderState = dispatchState(currentHolder);
  const now = new Date().toISOString();
  const from = recordedCheckout(currentState);
  exchangeCheckoutRecords(currentState, holderState);
  currentState.worktreeBindingExchange = { at: now, from, with: currentHolder.ref, reason: 'claim_token' };
  holderState.worktreeBindingExchange = { at: now, from: exchange.observed, with: current.ref, reason: 'claim_token' };
  stampDispatchEvent(current, 'claim-worktree-exchange', now);
  stampDispatchEvent(currentHolder, 'claim-worktree-exchange', now);
  putTicket(exchange.slug, current);
  putTicket(exchange.slug, currentHolder);
  return { ok: true, exchangedWith: currentHolder.ref, worktree: currentState.worktree, from };
}

// WorktreeCreate attributes each new checkout to a reservation in creation order, and nothing in its payload names the
// executor type, so siblings spawned in one Agent message can each be leased to the other's checkout (SQ-55, GitHub
// #298). The harness confines each executor to the checkout it created for it, so a crossed lease refuses every write
// the executor can make. exchangeGuessedClaimIdentity cannot settle this: siblings of different executor types never
// cross agent ids, only checkouts. The claim is the first call that pairs the token naming the executor's own ticket
// with the checkout the executor is actually running in, so it settles the checkout guess the same way the token
// settles the agent id. The observed checkout must be the exact instance the sibling's creation recorded (Git
// directories and checkout-instance marker), the sibling must still be an unclaimed, non-terminal reservation that no
// token has vouched for, and both must share one baseline. The whole checkout record swaps under both locks.
function exchangeCrossedClaimCheckout(slug?: any, ticketId?: any, sessionId?: any, observedWorktree?: any, admitted?: ClaimAdmission) {
  const exchange = crossedCheckoutExchange(slug, ticketId, sessionId, observedWorktree);
  if (!exchange) return adoptParkedClaimCheckout(slug, ticketId, sessionId, observedWorktree, admitted);
  return withTicketLocks([{ slug, id: exchange.target.id }, { slug, id: exchange.holder.id }], () => applyCrossedCheckoutExchange(exchange, admitted));
}

function parkedCheckoutOf(ticket?: any) {
  return dispatchState(ticket)?.crossBoundWorktree?.parkedCheckout || null;
}

function parksObservedCheckout(entry: { slug: string; ticket: any }, slug: string, target: any, claim: any) {
  const parked = entry.slug === slug && entry.ticket.id !== target.id ? parkedCheckoutOf(entry.ticket) : null;
  return parked?.sessionId === claim.sessionId && recordedCheckout(parked) === claim.observed;
}

// Exactly one superseded attempt of this session parked the checkout this executor runs in, on this claim's baseline.
function parkedCheckoutHolder(slug: string, target: any, claim: any) {
  const parkers = ticketsMentioningSession(claim.sessionId).filter((entry) => parksObservedCheckout(entry, slug, target, claim));
  const parker = parkers.length === 1 ? parkers[0]?.ticket : null;
  return parker && sameBaseline(dispatchState(target), parkedCheckoutOf(parker)) ? parker : null;
}

function parkedCheckoutAdoption(slug: string, ticketId: string, sessionId: string, observedWorktree: string) {
  const claim = observedClaimCheckout(sessionId, observedWorktree);
  const target = claim ? crossedCheckoutTarget(slug, ticketId, claim, claimAdoptsObservedCheckout) : null;
  const parker = target ? parkedCheckoutHolder(slug, target, claim) : null;
  const facts = parker ? immutableWorktreeFacts(slug, claim!.observed) : null;
  return observedCheckoutMatchesRecord(parkedCheckoutOf(parker), facts) ? { slug, target, parker, facts, ...claim! } : null;
}

function parkedCheckoutStillHolds(adoption: any, current: any, parker: any) {
  return claimAdoptsObservedCheckout(current, dispatchState(current), adoption)
    && recordedCheckout(dispatchState(current)) === recordedCheckout(dispatchState(adoption.target))
    && observedCheckoutMatchesRecord(parkedCheckoutOf(parker), adoption.facts);
}

// In a rotation of three or more, the record the claim gives up can be the checkout a still-unsettled sibling runs
// in, and dropping it left that sibling leased to a dead tree with nothing naming its own (SQ-3147).
function reparkDisplacedCheckout(slug: string, claimant: any, parker: any, displaced: any) {
  const crossBound = dispatchState(parker).crossBoundWorktree;
  if (displaced.worktree && unsettledSessionSibling(slug, claimant, dispatchState(claimant))) crossBound.parkedCheckout = displaced;
  else delete crossBound.parkedCheckout;
}

function applyParkedCheckoutAdoption(adoption: any, admitted?: ClaimAdmission) {
  const current = getTicket(adoption.slug, adoption.target.id);
  const parker = getTicket(adoption.slug, adoption.parker.id);
  if (!parkedCheckoutStillHolds(adoption, current, parker) || !admitted?.()) return null;
  const state = dispatchState(current);
  const parked = parkedCheckoutOf(parker);
  const now = new Date().toISOString();
  const from = recordedCheckout(state);
  const displaced = parkedCreationRecord(state);
  for (const field of CHECKOUT_BINDING_FIELDS) state[field] = parked[field];
  state.worktreeBindingExchange = { at: now, from, with: parker.ref, reason: 'claim_parked_checkout' };
  reparkDisplacedCheckout(adoption.slug, current, parker, displaced);
  stampDispatchEvent(current, 'claim-worktree-adopted', now);
  stampDispatchEvent(parker, 'claim-worktree-adopted', now);
  putTicket(adoption.slug, current);
  putTicket(adoption.slug, parker);
  return { ok: true, adoptedFrom: parker.ref, worktree: state.worktree, from };
}

// A supersede that kept a checkout for an unsettled sibling cleared the only live record naming it, so no sibling is
// left to exchange with (SQ-3139). The claim then takes the retired attempt's parked creation record instead, under
// the same proof the exchange demands: the token's own ticket, the exact checkout instance the creation recorded, and
// one baseline. The dead sibling's checkout the claim leaves behind is nobody's lease, which is what sweep reclaims.
function adoptParkedClaimCheckout(slug: string, ticketId: string, sessionId: string, observedWorktree: string, admitted?: ClaimAdmission) {
  const adoption = parkedCheckoutAdoption(slug, ticketId, sessionId, observedWorktree);
  if (!adoption) return null;
  return withTicketLocks([{ slug, id: adoption.target.id }, { slug, id: adoption.parker.id }], () => applyParkedCheckoutAdoption(adoption, admitted));
}

// No token has vouched for this reservation's runtime yet, so the agent id and the checkout it holds may be a
// sibling's (GitHub #298).
function guessedReservation(ticket?: any, state?: any, sessionId?: any) {
  return unclaimedLaunchedReservation(ticket, state, sessionId) && !TOKEN_BIND_SOURCES.includes(state.bindSource);
}

// A held stop still names the runtime its reservation holds, or, for a stop matched by launch name, still no runtime.
function deferredStopApplies(state?: any) {
  return Boolean(state?.deferredStop) && normalizedText(state.deferredStop.agentId) === normalizedText(state.agentId);
}

// Only completed WorktreeCreate records cut at one baseline can be traded by a claim-time checkout exchange.
function tradableCheckouts(state?: any, other?: any) {
  return worktreeCreateLease(state) && worktreeCreateLease(other)
    && Boolean(completedWorktreeCreationFacts(state) && completedWorktreeCreationFacts(other)) && sameBaseline(state, other);
}

// A runtime id crosses only onto a sibling of one executor type that holds a live runtime of its own, and a checkout
// only onto a tradable one. A launch that never bound anything cannot settle a guess, so it never holds a stop.
function bindingsCanCross(state?: any, other?: any) {
  return (state.executor === other.executor && Boolean(other.agentId)) || tradableCheckouts(state, other);
}

// A sibling whose own claim can still settle which runtime, or which checkout, a guessed record really holds.
function unsettledSibling(entry?: any, slug?: any, ticket?: any, sessionId?: any) {
  const other = dispatchState(entry.ticket);
  return !(entry.slug === slug && entry.ticket.id === ticket.id) && guessedReservation(entry.ticket, other, sessionId)
    && !deferredStopApplies(other) && bindingsCanCross(dispatchState(ticket), other);
}

function awaitsSiblingClaim(slug?: any, ticket?: any, sessionId?: any) {
  return guessedReservation(ticket, dispatchState(ticket), sessionId)
    && ticketsMentioningSession(sessionId).some((entry) => unsettledSibling(entry, slug, ticket, sessionId));
}

function holdStopOnRuntime(slug?: any, id?: any, stop?: any, heldAgentId?: any) {
  const ticket = getTicket(slug, id);
  const state = dispatchState(ticket);
  if (normalizedText(state?.agentId) !== heldAgentId || !awaitsSiblingClaim(slug, ticket, stop.sessionId)) return null;
  const at = new Date().toISOString();
  // A stop matched by launch name is the reservation's own runtime, so it records that runtime as an ended stop would.
  state.agentId = heldAgentId || stop.agentId || null;
  state.deferredStop = { agentId: state.agentId, at };
  stampDispatchEvent(ticket, 'subagent-stop-deferred', at);
  putTicket(slug, ticket);
  return { ok: true, stopped: true, deferred: true, tickets: [], deferredRefs: [ticket.ref] };
}

function runtimeHeldBy(state?: any, stop?: any) {
  return Boolean(stop.agentId) && state?.executor === stop.executor && state.agentId === stop.agentId;
}

// A reservation SubagentStart never bound is reachable only by the launch name the host recorded beside the transcript.
function unboundLaunchNamed(state?: any, stop?: any) {
  return Boolean(stop.launchName) && state?.executor === stop.executor && state.agentName === stop.launchName && !state.agentId;
}

// The one reservation this stop lands on: the one holding its runtime id, or else the unbound one its launch name names.
function stoppedReservation(candidates: any[], stop: any) {
  const byRuntime = candidates.filter((entry: any) => runtimeHeldBy(dispatchState(entry.ticket), stop));
  const byLaunchName = candidates.filter((entry: any) => unboundLaunchNamed(dispatchState(entry.ticket), stop));
  const held = byRuntime.length ? byRuntime : byLaunchName;
  return held.length === 1 ? held[0] : null;
}

// A runtime that stops before claiming may stop on a sibling's record, because SubagentStart binds by guess (GitHub
// #298). Ending that record failed the live sibling's dispatch and cleared its token, so the live executor could no
// longer claim its own ticket. Even a record that is the stopped runtime's own can hold the live sibling's checkout by
// creation order, and ending it left that crossing for nobody to settle. While a sibling whose claim can still settle
// the guess is unclaimed, the stop is held on the runtime id instead: it follows that id through the claim-time
// exchange, and settleDeferredStops ends whichever reservation holds it once no unsettled sibling is left.
function deferGuessedStop(candidates: any[], stop: any) {
  const held = stoppedReservation(candidates, stop);
  if (!held || !awaitsSiblingClaim(held.slug, held.ticket, stop.sessionId)) return null;
  const heldAgentId = normalizedText(dispatchState(held.ticket).agentId);
  return withTicketLock(held.slug, held.ticket.id, () => holdStopOnRuntime(held.slug, held.ticket.id, stop, heldAgentId));
}

function settleDeferredStop(slug?: any, id?: any, sessionId?: any) {
  const ticket = getTicket(slug, id);
  const state = dispatchState(ticket);
  if (!deferredStopApplies(state) || !guessedReservation(ticket, state, sessionId) || awaitsSiblingClaim(slug, ticket, sessionId)) return null;
  setDispatchTerminal(ticket, 'failed', 'subagent-stop', { slug, failureShape: 'stopped_before_claim' });
  ticket.dispatchNonce = null;
  ticket.dispatchExecutor = null;
  stampDispatchEvent(ticket, 'subagent-stop', new Date().toISOString());
  putTicket(slug, ticket);
  return ticket;
}

// Once a claim has vouched for a runtime, or a stop has ended a sibling, a held stop with no unsettled sibling left
// belongs to whichever reservation holds its runtime id, and that reservation ends as a stop before claim.
function settleDeferredStops(sessionId?: any) {
  const normalizedSessionId = normalizedText(sessionId);
  if (!normalizedSessionId) return;
  for (const { slug, ticket } of ticketsMentioningSession(normalizedSessionId)) {
    if (deferredStopApplies(dispatchState(ticket))) withTicketLock(slug, ticket.id, () => settleDeferredStop(slug, ticket.id, normalizedSessionId));
  }
}

// A mutual swap rewrites the holder's record as well, so a recovery that names a checkout exactly one other live
// ticket leases takes that ticket's lock too, in the order every multi-record exchange takes them.
function recoveryLockKeys(slug?: any, ticket?: any, worktree?: any): TicketKey[] {
  const facts = immutableWorktreeFacts(slug, worktree);
  const holders = facts ? liveCheckoutHolders(slug, ticket, facts.worktree) : [];
  const holder = holders.length === 1 ? getTicket(slug, holders[0]) : null;
  return [{ slug, id: ticket.id }, ...(holder ? [{ slug, id: holder.id }] : [])];
}

function movedCheckout(state?: any, facts?: any) {
  const recorded = state.worktree ? canonicalPath(state.worktree) : '';
  return recorded !== facts.worktree ? recorded : '';
}

function commitsSinceBaseline(worktree?: any, baseCommit?: any, revision?: any): string[] {
  try {
    return gitOutput(worktree, ['rev-list', '--reverse', normalizedText(baseCommit) + '^{commit}..' + revision, '--']).split('\n').filter(Boolean);
  } catch (_: any) {
    return [];
  }
}

function checkoutOwnershipSinceBaseline(slug?: any, ticket?: any, state?: any, facts?: any) {
  const commits = commitsSinceBaseline(facts.worktree, state.baseCommit, facts.revision);
  return commits.length ? checkoutRangeOwnership(slug, ticket, state, facts.repository, commits) : { ownHead: false, foreignTickets: [] as string[] };
}

// The way out that always exists: a released ticket's redispatch resumes only a checkout its own commit heads.
function handbackFallback(ticket?: any) {
  return ' Fallback: release ' + ticket.ref + ' with kind `handback` and status `todo` (MCP `release`), quoting this refusal;'
    + " its redispatch resumes a checkout only when that checkout's HEAD is this ticket's own commit, and otherwise gets a fresh checkout of its own.";
}

function leasedCheckoutRefusal(ticket?: any, facts?: any, holders?: string[]) {
  return `${ticket.ref} cannot be rebound to ${facts.worktree}: it is leased to ${holders!.join(', ')}, a live ticket, and its HEAD is not a commit this claim made.`
    + " Two claims crossed onto each other's checkouts are swapped instead, but only while both still hold the WorktreeCreate records of one session and baseline and neither checkout carries another ticket's commits."
    + handbackFallback(ticket);
}

function claimedCreationLease(ticket?: any, state?: any) {
  return Boolean(ticket?.claim?.by) && !state?.terminalAt && worktreeCreateLease(state);
}

function sameCreationWave(ticket?: any, state?: any, holder?: any, holderState?: any) {
  return claimedCreationLease(ticket, state) && claimedCreationLease(holder, holderState)
    && holderState.sessionId === state.sessionId && sameBaseline(state, holderState);
}

// The checkout this claim records must be free for the holder to take: the instance creation recorded, leased by no
// other live ticket, and carrying no commits but the holder's own.
function recordedCheckoutReturnable(slug?: any, ticket?: any, state?: any, holder?: any, holderState?: any) {
  const recorded = immutableWorktreeFacts(slug, state.worktree);
  return observedCheckoutMatchesRecord(state, recorded) && !liveCheckoutHolders(slug, ticket, recorded!.worktree).length
    && !checkoutOwnershipSinceBaseline(slug, holder, holderState, recorded).foreignTickets.length;
}

function crossedClaimPair(slug?: any, ticket?: any, state?: any, holder?: any, facts?: any) {
  const holderState = dispatchState(holder);
  return sameCreationWave(ticket, state, holder, holderState) && observedCheckoutMatchesRecord(holderState, facts)
    && recordedCheckoutReturnable(slug, ticket, state, holder, holderState);
}

// Siblings that both claimed before anything settled a crossing each hold the other's checkout (GitHub #298). Neither
// can commit where it runs, because that checkout is leased to the other, so neither can ever earn the own-commit
// rebind. When the pair is exactly crossed, trading the two records is the only move that gives both claims their own.
function mutualCheckoutSwap(slug?: any, ticket?: any, state?: any, facts?: any, lease?: any) {
  if (lease.holders.length !== 1 || lease.ownership.foreignTickets.length) return null;
  const holder = getTicket(slug, lease.holders[0]);
  const locked = lease.lockKeys.some((key: TicketKey) => key.id === holder?.id);
  return locked && crossedClaimPair(slug, ticket, state, holder, facts) ? { holderId: holder.id, holderRef: holder.ref } : null;
}

function leasedCheckoutDecision(slug?: any, ticket?: any, state?: any, facts?: any, lease?: any) {
  const swap = mutualCheckoutSwap(slug, ticket, state, facts, lease);
  if (swap) return { ok: true, basis: 'mutual_swap', swap };
  return { ok: false, reason: 'worktree_mismatch', message: leasedCheckoutRefusal(ticket, facts, lease.holders) };
}

function unleasedRebindDecision(ticket?: any, facts?: any, holders?: string[], ownership?: any) {
  if (ownership.foreignTickets.length) {
    return { ok: false, reason: 'worktree_mismatch', message: `${ticket.ref} cannot be rebound to ${facts.worktree}: it carries commits of ${ownership.foreignTickets.join(', ')}.` + handbackFallback(ticket) };
  }
  return { ok: true, basis: holders!.length ? 'own_commits' : 'free_lease' };
}

// A recorded binding can be the creation-order guess of a crossed sibling (GitHub #298), so the claim holder may
// move it to the checkout it names. The move is refused only where it would take a checkout from another live
// ticket: one leased to a live dispatch whose HEAD is not this claim's own commit, or one carrying another ticket's
// commits (SQ-75). An exactly crossed claimed pair trades records instead.
function liveClaimRebindDecision(slug?: any, ticket?: any, state?: any, facts?: any, lockKeys?: TicketKey[]) {
  if (!registeredProjectCheckout(facts)) {
    return { ok: false, reason: 'invalid_worktree', message: `${ticket.ref} recovery requires a registered linked worktree from this board project.` };
  }
  const holders = liveCheckoutHolders(slug, ticket, facts.worktree);
  const ownership = checkoutOwnershipSinceBaseline(slug, ticket, state, facts);
  if (holders.length && !ownership.ownHead) return leasedCheckoutDecision(slug, ticket, state, facts, { holders, ownership, lockKeys });
  return unleasedRebindDecision(ticket, facts, holders, ownership);
}

function swapCheckoutRecords(slug?: any, ticket?: any, state?: any, swap?: any, now?: any) {
  const holder = getTicket(slug, swap.holderId);
  const holderState = dispatchState(holder);
  const from = canonicalPath(holderState.worktree);
  exchangeCheckoutRecords(state, holderState);
  holderState.worktreeCorrection = { at: now, from, to: holderState.worktree, reason: 'live_claim_mutual_swap', swappedWith: ticket.ref };
  stampDispatchEvent(holder, 'live-claim-mutual-swap', now);
  putTicket(slug, holder);
}

// Runs under the recovery's locks, before the recovered binding is written. The move is recorded on the claim as
// worktreeCorrection and returned with the recovery.
function liveClaimRebind(slug?: any, ticket?: any, state?: any, facts?: any, lockKeys?: TicketKey[], now?: any) {
  const from = movedCheckout(state, facts);
  if (!from) return { ok: true, recovery: {} };
  const decision: any = liveClaimRebindDecision(slug, ticket, state, facts, lockKeys);
  if (!decision.ok) return decision;
  if (decision.swap) swapCheckoutRecords(slug, ticket, state, decision.swap, now);
  state.worktreeCorrection = { at: now, from, to: facts.worktree, reason: 'live_claim_recovery', basis: decision.basis, swappedWith: decision.swap?.holderRef };
  return { ok: true, recovery: { worktreeCorrection: state.worktreeCorrection } };
}

function bindCheckoutFacts(state?: any, facts?: any) {
  state.worktree = facts.worktree;
  state.worktreeGitDirectory = facts.gitDirectory;
  state.worktreeCommonGitDirectory = facts.commonGitDirectory;
  state.worktreeCheckoutInstance = facts.checkoutInstance;
  state.worktreeObservedRevision = facts.revision;
}

function releaseObservation(opts?: any) {
  const observation = { by: normalizedText(opts?.by), agentId: normalizedText(opts?.agentId), worktree: normalizedText(opts?.observedWorktree) };
  return Object.values(observation).every(Boolean) ? { ...observation, worktree: canonicalPath(observation.worktree) } : null;
}

// Only the harness confines an executor to a checkout, so only a WorktreeCreate binding's own bound runtime can
// report where it really ran. A continuation spawn has no isolation and its cwd proves nothing (SQ-75).
function releaseObservationApplies(ticket?: any, state?: any, observation?: any) {
  return ticket?.claim?.by === observation.by && state?.agentId === observation.agentId && !state.terminalAt && worktreeCreateLease(state);
}

function recordObservedReleaseCheckout(slug?: any, id?: any, observation?: any) {
  const ticket = getTicket(slug, id);
  const state = dispatchState(ticket);
  if (!releaseObservationApplies(ticket, state, observation)) return { ok: false, reason: 'release_observation_unavailable', ticket };
  if (state.worktree && canonicalPath(state.worktree) === observation.worktree) return { ok: true, unchanged: true, ticket };
  state.releaseObservedCheckout = { worktree: observation.worktree, by: observation.by, agentId: observation.agentId, at: new Date().toISOString() };
  putTicket(slug, ticket);
  return { ok: true, ticket };
}

function recordReleaseObservedCheckout(slug?: any, idOrRef?: any, opts?: any) {
  const observation = releaseObservation(opts);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  if (!observation) return { ok: false, reason: 'missing_release_observation' };
  return withTicketLock(slug, found.id, () => recordObservedReleaseCheckout(slug, found.id, observation));
}

function releaseObservationStillHolds(state?: any, observation?: any, by?: any) {
  return Boolean(by) && observation.by === by && observation.agentId === state.agentId && state.sharedTree === false && !state.terminalAt;
}

// An observation that is not a registered linked checkout of this project cannot establish where the work is, so the
// retained binding is dropped and the next dispatch gets a fresh checkout.
function applyReleaseObservedCheckout(slug?: any, state?: any, observed?: any, observedFacts?: ObservedWorktreeFacts) {
  const recorded = state.worktree ? canonicalPath(state.worktree) : null;
  if (!observed || observed === recorded) return;
  const now = new Date().toISOString();
  const facts = worktreeFactsFor(slug, observed, observedFacts);
  if (!observedCheckoutRegistered(observed, facts, observedFacts)) {
    state.retainedWorktreeDropped = { at: now, reason: 'release_observed_checkout_unverified', recorded, observed };
    return;
  }
  bindCheckoutFacts(state, facts);
  state.worktreeCorrection = { at: now, from: recorded, to: state.worktree, reason: 'release_observed_checkout' };
}

// Runs inside the release lock, before the terminal revision is captured, so the retained continuation is keyed to
// the checkout the releasing executor ran in.
function rekeyReleasedCheckout(slug?: any, ticket?: any, by?: any, observedFacts?: ObservedWorktreeFacts) {
  const state = dispatchState(ticket);
  const observation = state?.releaseObservedCheckout;
  if (!observation) return;
  delete state.releaseObservedCheckout;
  if (!releaseObservationStillHolds(state, observation, by)) return;
  applyReleaseObservedCheckout(slug, state, canonicalPath(observation.worktree), observedFacts);
}

function bindDispatchAgent(sessionId?: any, executor?: any, agentId?: any, agentName?: any, worktree?: any) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedExecutor = String(executor || '').trim();
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedAgentName = String(agentName || '').trim();
  const normalizedWorktree = String(worktree || '').trim();
  if (!normalizedSessionId || !normalizedExecutor || (!normalizedAgentId && !normalizedAgentName)) {
    return { ok: false, reason: 'missing_identity' };
  }
  let matches: any[] = [];
  const unclaimedCreationReservations: any[] = [];
  for (const { slug, ticket } of ticketsMentioningSession(normalizedSessionId)) {
    const state = dispatchState(ticket);
    if (state?.executor === normalizedExecutor && unclaimedCreationReservation(ticket, state, normalizedSessionId)) {
      unclaimedCreationReservations.push({ slug, id: ticket.id, sharedTree: state.sharedTree, state });
    }
    if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
    matches.push({ slug, id: ticket.id, sharedTree: state.sharedTree, state });
  }
  if (!matches.length && normalizedAgentId && normalizedWorktree && unclaimedCreationReservations.length === 1) {
    const reservation = unclaimedCreationReservations[0];
    const completed = completedWorktreeCreationFacts(reservation.state);
    if (completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree)) {
      matches = [Object.assign({}, reservation, { checkoutIdentityOverride: true })];
    }
  }
  // A completed creation target is stronger evidence than a name: it is a reserved path, unique to one
  // dispatch, and the caller had to already be inside it to report it. Gating this on a missing name left
  // a named bind ambiguous whenever a sibling dispatch had no recorded name to filter on (SQ-2189).
  if (normalizedWorktree) {
    const completedWorktreeMatches = matches.filter((match) => {
      const completed = completedWorktreeCreationFacts(match.state);
      return match.state.sharedTree === false && !match.state.continuation?.sourceWorktree
        && boundIsolatedWorktree(match.state)
        && completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree);
    });
    if (completedWorktreeMatches.length) matches = completedWorktreeMatches;
  }
  if (normalizedAgentId && !normalizedAgentName) {
    matches = matches.filter((match) => {
      if (String(match.state.agentId || '') === normalizedAgentId) return true;
      const completed = completedWorktreeCreationFacts(match.state);
      return match.sharedTree === false && Boolean(normalizedWorktree) && completed
        && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree);
    });
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
  for (const match of matches) {
    const reportsParentCheckout = match.sharedTree === false && normalizedWorktree
      && reportsRegisteredProjectCheckout(match.slug, normalizedWorktree);
    // A parent-checkout report is not the agent's own checkout, so it proves nothing about which reservation owns
    // which created target and must never move a binding.
    if (match.sharedTree === false && normalizedWorktree && !reportsParentCheckout && !match.state.continuation?.sourceWorktree) {
      exchangeCrossedCreationBinding(match.slug, match.id, normalizedSessionId, normalizedWorktree);
    }
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      const completedReservation = completedWorktreeCreationFacts(state);
      const checkoutIdentityOverride = Boolean(match.checkoutIdentityOverride
        && unclaimedCreationReservation(t, state, normalizedSessionId)
        && completedReservation
        && canonicalPath(completedReservation.worktree) === canonicalPath(normalizedWorktree));
      if (!checkoutIdentityOverride
        && !dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
        return { ok: false };
      }
      if (state.sharedTree === false && normalizedWorktree && !state.continuation?.sourceWorktree
        && !boundIsolatedWorktree(state)) {
        return { ok: false, reason: 'worktree_binding_unavailable' };
      }
      const completedTargetFacts = reportsParentCheckout ? completedWorktreeCreationFacts(state) : null;
      const worktreeFacts = reportsParentCheckout
        ? completedTargetFacts ? immutableWorktreeFacts(match.slug, completedTargetFacts.worktree) : null
        : state.sharedTree === false && normalizedWorktree
          ? immutableWorktreeFacts(match.slug, normalizedWorktree)
          : null;
      if (reportsParentCheckout && !completedTargetFacts) {
        return { ok: false, reason: 'worktree_binding_unavailable' };
      }
      if (state.sharedTree === false && normalizedWorktree && !state.continuation?.sourceWorktree && !worktreeFacts) {
        return { ok: false, reason: 'invalid_worktree_binding' };
      }
      const now = new Date().toISOString();
      if (!recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now, worktreeFacts)) {
        return { ok: false, reason: 'worktree_binding_mismatch' };
      }
      const lifecycle = t.lifecycleAttempt || state.lifecycleAttempt;
      const launchedAttempt = lifecycle?.state === 'prepared' ? transitionAttempt(lifecycle, 'launch') : lifecycle;
      const boundAttempt = launchedAttempt?.state === 'launched' ? transitionAttempt(launchedAttempt, 'bind') : launchedAttempt;
      if (boundAttempt) {
        if (attemptDiagnostic(boundAttempt)) return { ok: false };
        t.lifecycleAttempt = boundAttempt;
        state.lifecycleAttempt = boundAttempt;
      }
      syncClaimRuntimeIdentity(t, state);
      stampDispatchEvent(t, 'subagent-start', now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: result?.reason || 'not_found' };
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets };
}

function dispatchMatchesStopIdentity(state?: any, sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  if (!state || state.sessionId !== sessionId || state.executor !== executor) return false;
  if (state.bindSource === 'claim_token' && !state.agentId) return true;
  if (agentName && state.agentName !== agentName) return false;
  if (!agentId) return agentName ? state.agentName === agentName : true;
  if (state.agentId) return state.agentId === agentId;
  return Boolean(agentName && state.agentName === agentName);
}
function terminalAttemptMatchesStopIdentity(state?: any, sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  return attempts.find((attempt?: any) => {
    if (!attempt?.terminalAt || attempt.sessionId !== sessionId || attempt.executor !== executor) return false;
    if (agentName && attempt.agentName !== agentName) return false;
    if (!agentId) return Boolean(agentName && attempt.agentName === agentName);
    if (attempt.agentId) return attempt.agentId === agentId;
    return Boolean(agentName && attempt.agentName === agentName);
  }) || null;
}

function markDispatchStopped(sessionId?: any, executor?: any, agentId?: any, agentName?: any, launchName?: any, terminalReason?: any) {
  const stop = {
    sessionId: normalizedText(sessionId),
    executor: normalizedText(executor),
    agentId: normalizedText(agentId),
    agentName: normalizedText(agentName),
    launchName: normalizedText(launchName),
    terminalReason: normalizedText(terminalReason),
  };
  if (!stop.sessionId || !stop.executor) return { ok: false, reason: 'missing_identity' };
  const candidates = ticketsMentioningSession(stop.sessionId);
  const deferred = deferGuessedStop(candidates, stop);
  if (deferred) return deferred;
  const stopped = stopByRuntimeOrLaunchName(candidates, stop);
  settleDeferredStops(stop.sessionId);
  return stopped;
}

function fallbackLaunchName(stop: any) {
  return stop.launchName === stop.agentName ? '' : stop.launchName;
}

// SubagentStop carries agent_id and never agent_name, so an attempt whose cancellable SubagentStart
// never recorded an agentId is unreachable by its own terminal hook: 36 attempts on this board were
// stranded that way, median 129s and worst 3.2 hours before an orchestrator retired them by hand.
// The host writes the launch name into agent-<id>.meta.json beside the transcript, so the hook can
// recover it. It is applied strictly second, and only when the id-keyed pass found nothing to touch,
// so every stop that matches on agent_id today takes the identical path it takes now.
function stopByRuntimeOrLaunchName(candidates: any[], stop: any) {
  const byRuntimeIdentity = stopMatchingDispatches(candidates, stop.sessionId, stop.executor, stop.agentId, stop.agentName, stop.terminalReason);
  const launchName = fallbackLaunchName(stop);
  if (byRuntimeIdentity.ok || !launchName) return byRuntimeIdentity;
  const byLaunchName = stopMatchingDispatches(candidates, stop.sessionId, stop.executor, stop.agentId, launchName, stop.terminalReason);
  return byLaunchName.ok ? byLaunchName : byRuntimeIdentity;
}

function stopMatchingDispatches(candidates: any[], normalizedSessionId: string, normalizedExecutor: string, normalizedAgentId: string, normalizedAgentName: string, terminalReason: string) {
  const matches: any[] = [];
  const terminalAttempts: any[] = [];
  for (const { slug, ticket } of candidates) {
    const state = dispatchState(ticket);
    const terminalAttempt = ticket.claim?.by
      ? null
      : terminalAttemptMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName);
    if (terminalAttempt) terminalAttempts.push({ ref: ticket.ref, outcome: terminalAttempt.outcome, agentName: terminalAttempt.agentName });
    if (!dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
    const active = state.outcome === 'prepared' || state.outcome === 'launched' || state.outcome === 'claimed';
    if (active || state.terminalAt) matches.push({ slug, id: ticket.id, sharedTree: state.sharedTree });
  }
  if (!matches.length && terminalAttempts.length === 1) {
    return { ok: true, stopped: false, tickets: [], terminalAttempts };
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
  const terminalFailure = terminalAgentFailure(terminalReason);
  let stopped = false;
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      const active = Boolean(state && ['prepared', 'launched', 'claimed'].includes(state.outcome));
      if (!state || (!active && !state.terminalAt) ||
        !dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
        return { ok: false, reason: 'not_found' };
      }
      const now = new Date().toISOString();
      if (normalizedAgentId || normalizedAgentName) {
        recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now);
      }
      if (active && state.outcome === 'launched' && !(t.claim && t.claim.by)) {
        setDispatchTerminal(t, 'failed', 'subagent-stop', { slug: match.slug, failureShape: 'stopped_before_claim' });
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
        stopped = true;
      } else if (active && t.claim?.by && terminalFailure) {
        setDispatchTerminal(t, 'failed', 'subagent-stop', { slug: match.slug, error: terminalReason, failureShape: terminalFailure });
      } else if (active) {
        state.turnEndedAt = now;
      }
      stampDispatchEvent(t, 'subagent-stop', now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t, stopped, turnEnded: active };
    });
    if (!result || !result.ok) return { ok: false, reason: 'not_found' };
    stopped = stopped || result.stopped;
    tickets.push(result.ticket);
  }
  return { ok: true, ticket: tickets[0], tickets, stopped };
}

function isolatedDispatchOfAgent(state: any, sessionId: string, agentId: string): boolean {
  return state?.sessionId === sessionId && state.agentId === agentId && state.sharedTree === false && Boolean(state.worktree);
}

// Native subagents share their parent's session id, so anything keyed on the session alone answers the same for
// the orchestrator and every sibling executor. The agent id SubagentStart bound to a dispatch tells them apart
// (GH-155, GH-150).
function agentDispatchWorktrees(sessionId: string, agentId: string) {
  if (!sessionId || !agentId) return [];
  const owned: { ref: string; worktree: string; outcome: string | null; terminalAt: string | null }[] = [];
  for (const { ticket } of ticketsMentioningSession(sessionId)) {
    const state = dispatchState(ticket);
    if (isolatedDispatchOfAgent(state, sessionId, agentId)) owned.push(agentDispatchWorktree(ticket.ref, state));
  }
  return owned;
}

function agentDispatchWorktree(ref: string, state: any) {
  return { ref, worktree: String(state.worktree), outcome: state.outcome || null, terminalAt: state.terminalAt || null };
}

function reconcileLaunchedDispatches(sessionId?: any, opts?: any) {
  const reconciled: any[] = [];
  if (!sessionId) return { ok: true, reconciled };
  const source = opts && opts.source ? String(opts.source) : 'session-start';
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      // A bound agent has a durable runtime identity; only its terminal hook or claim lifecycle may retire it.
      if (!state || state.sessionId !== String(sessionId) || state.outcome !== 'launched' || state.boundAt || (ticket.claim && ticket.claim.by)) continue;
      const res = withTicketLock(project.slug, ticket.id, () => {
        const t = getTicket(project.slug, ticket.id);
        const current = dispatchState(t);
        if (!current || current.sessionId !== String(sessionId) || current.outcome !== 'launched' || current.boundAt || (t.claim && t.claim.by)) {
          return { ok: false };
        }
        setDispatchTerminal(t, 'failed', source, { slug: project.slug });
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
        stampDispatchEvent(t, source);
        putTicket(project.slug, t);
        return { ok: true, ticket: t };
      });
      if (res && res.ok) reconciled.push(res.ticket.ref);
    }
  }
  return { ok: true, reconciled };
}

  return {
    dispatchTokenPrefix,
    dispatchState,
    executorClaimDispatchRefusal,
    sharedTreeRuntimeRefusal,
    isolatedDispatchRepositoryForSession,
    sharedTreeArtifactRequested,
    categoryArtifactRoot,
    sharedTreeArtifactMode,
    dirtyPathKey,
    artifactPathIdentity,
    artifactWorkingState,
    captureArtifactBaseline,
    artifactScopeCheck,
    activeDispatchRoute,
    rederiveUnlaunchedPreparedRoute,
    stampDispatchEvent,
    pulseDispatchState,
    unclaimedEvidenceAttempt,
    unclaimedRetirementRefusal,
    preparingSessionAttests,
    unclaimedAttemptRecoveryGuidance,
    retirePreparedCompatibilityStaleAttempt,
    preparedCompatibilityHasProvenMismatch,
    preparedCompatibilityWarning,
    supersedeUnboundAttempt,
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
    refreshPreparedDispatches,
    expiredPreparedDispatch,
    worktreeIsolationWarning,
    prepareDispatch,
    syncLiveDispatchVerification,
    readDispatchBriefing,
    recoverLiveClaimDispatch,
    recordReleaseObservedCheckout,
    rekeyReleasedCheckout,
    recordDispatchLaunch,
    recordDispatchAgentFailure,
    recoverDispatchQuotaFailure,
    bindDispatchWorktreeCreation,
    completeDispatchWorktreeCreation,
    recordDispatchWorktreeProvisioned,
    recordDispatchWorktreeProvisioningFailure,
    unclaimedRetirement,
    recordDispatchWorktreeDependencyLink,
    recoverDispatchWorktreeCreation,
    dispatchIdentityDiagnosis,
    crossedWorktreeBinding,
    dispatchIsolationExpectation,
    dispatchUnboundClaim,
    boardVerificationEvidencePath,
    dispatchEvidenceDirectory,
    recordSanctionedCommit,
    dispatchWorkspace,
    dispatchDelta,
    activeSharedTreeClaim,
    dispatchIdentityAmbiguous,
    dispatchCanBindRuntimeIdentity,
    recordDispatchRuntimeIdentity,
    bindDispatchClaimToken,
    exchangeGuessedClaimIdentity,
    exchangeCrossedClaimCheckout,
    settleDeferredStops,
    tokenAdmission,
    bindDispatchAgent,
    dispatchMatchesStopIdentity,
    markDispatchStopped,
    agentDispatchWorktrees,
    reconcileLaunchedDispatches,
    observeReleaseWorktreeFacts,
    captureTerminalWorktreeRevision,
  };
}

module.exports = { createDispatch, unscopedWriteCannotAutoApprove };
