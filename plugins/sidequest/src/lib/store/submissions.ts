'use strict';

const { classifyVerificationKind, commandVerificationResult, verificationAccepted, verificationFailureDiagnostic, verificationOutcome, verificationRequirement, validateVerificationWaiver, verificationWaiverDiagnostic } = require('../kernel/verification.js');
const { runProcessVerification } = require('../ports/process.js');
const { decideSubmissionAdmission } = require('../kernel/submission');
const { isSourceRevisionAdapterFacts, sourceRevisionBaseline } = require('../source-revision-capability.js');
const { reviewCandidateFromSubmission, reviewRelationFor, reviewRelationRef, reviewRelationOutcome, reviewLockMessage, reviewProvenance } = require('../kernel/review-binding');
const { assembleWave, openWave, recordAssembledWaveGate, recordWaveDelivery } = require('../kernel/wave');
const { isInScope, scopedPaths } = require('../scope-match');
import type { VerificationResult } from '../kernel/verification.js';

function createSubmissions(dependencies: any) {
  const { EXECUTOR_VERIFY_MAX, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES, MANUAL_VERIFY_PREFIX, acquireLock, addComment, appendReworkEvent, artifactWorkingState, autoReleasedClaimMessage, attestationErrors, boardConfig, boundedExcerptForSubmission, commitScope, completionTreeCheck, coerceStatus, createComment, crypto, dirtyPathKey, dispatchState, executionScope, ensureDir, execFileSync, fs, getTicket, integrationTarget, integrationTargetCommit, listTickets, manualVerify, normalizeDeliveryMode, normalizeIntegrationBranch, normalizeIntegrationVerifyTimeoutMs, nullableText, path, prepareComment, projectDir, putTicket, queueEventNotification, readMeta, recordedReviewPass, recordLifecycleAttempt, releaseLock, setDispatchTerminal, spawnSync, stampDispatchEvent, ticketLockPath, transaction, unregisterClaim, verifyCommandErrors, verifyCommandError, withTicketLock, transitionAttempt, attemptDiagnostic } = dependencies;
  const boundedExcerpt = boundedExcerptForSubmission;

const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;
const DEFAULT_CHECKPOINT_TTL_MIN = 60;
const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
const CHECKPOINT_VERIFY_MAX = 4000;
const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;
const VERIFICATION_CAPTURE_MAX = 32;
const REJECTION_REVIEW_MAX = 1000;
const REJECTION_REASON_MAX = 4000;
const WORKING_TREE_DELIVERY_METHODS = new Set(['reset', 'working-tree', 'manual']);
const INTEGRATION_TARGET_DIRTY_PATH_LIMIT = 8;

type WaveGate = {
  state?: string;
};

type WaveState = {
  id: string;
  participants: string[];
  gate?: WaveGate;
};

type WaveSubmission = {
  wave?: WaveState;
  changedPaths?: string[];
  gitRef?: string;
  commit?: string;
  commits?: string[];
  noOp?: boolean;
};

type WaveTicket = {
  id: string;
  ref: string;
  submission: WaveSubmission;
};

type WaveDeliveryOptions = {
  target?: {
    branch?: string;
    upstream?: string;
  };
  mode?: string;
  deliveryRevision?: {
    source?: string;
    value?: string;
    observedAt?: string;
  };
  deliveryVerification?: VerificationResult;
};

type ExactWaveAdmission =
  | { ok: true; tickets: WaveTicket[]; wave: WaveState; participantRefs: string[] }
  | { ok: false; reason: string; message?: string; tickets?: WaveTicket[] };

function sourceRevisionMetadata(revision?: any) {
  if (!revision || typeof revision !== 'object') return null;
  const source = String(revision.source || '').trim();
  const value = String(revision.value || '').trim();
  const observedAt = String(revision.observedAt || '').trim();
  if (!source || !value || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error('invalid source revision metadata');
  }
  return Object.freeze({ source, value, observedAt: new Date(observedAt).toISOString() });
}

function changedSurfacesMetadata(surfaces?: any) {
  if (!Array.isArray(surfaces)) return [];
  return Array.from(new Set(surfaces.map((surface?: any) => String(surface).trim().replace(/\\/g, '/')).filter(Boolean)));
}

function projectCapabilityMetadata(capabilities?: any) {
  if (!capabilities || typeof capabilities !== 'object') return {};
  const metadata: Record<string, boolean> = {};
  for (const name of ['process', 'worktree', 'review']) {
    if (typeof capabilities[name] === 'boolean') metadata[name] = capabilities[name];
  }
  return metadata;
}

function projectUsesGit(slug: any) {
  const projectPath = String(readMeta(slug)?.path || '').trim();
  if (!projectPath) return true;
  let directory = path.resolve(projectPath);
  for (;;) {
    if (fs.existsSync(path.join(directory, '.git'))) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function isArtifactSubmission(submission?: any) {
  return Boolean(submission?.sourceRevision && !submission?.commit);
}

function rejectionHistory(ticket?: any) {
  return Array.isArray(ticket?.rejectedSubmissions)
    ? ticket.rejectedSubmissions.filter((entry: any) => entry)
    : [];
}

function sameSourceRevision(left?: any, right?: any) {
  return Boolean(
    left?.source
    && right?.source
    && left.source === right.source
    && left.value === right.value
  );
}

function replacesGitRetryCandidate(retryCheckpoint: any, checkpoint: any) {
  return retryCheckpoint?.candidate?.source === 'git'
    && checkpoint?.candidate?.source === 'git'
    && retryCheckpoint.candidate.value !== checkpoint.candidate.value;
}

function submissionRetryCheckpoint(ticket: any, checkpoint: any) {
  if (!ticket.submissionRetry || replacesGitRetryCandidate(ticket.submissionRetry, checkpoint)) {
    ticket.submissionRetry = checkpoint;
  }
  return ticket.submissionRetry;
}

function hasExplicitSubmissionCandidate(opts: any) {
  return Boolean(String(opts?.commit || '').trim());
}

function hydratedSubmissionOptions(opts: any, retryCheckpoint: any) {
  if (!retryCheckpoint || hasExplicitSubmissionCandidate(opts)) return opts;
  const candidate = retryCheckpoint.candidate;
  const sourceRevision = candidate?.source === 'git' ? null : candidate;
  return {
    ...opts,
    sourceRevision,
    commit: sourceRevision ? null : candidate?.value,
    gitRef: retryCheckpoint.gitRef,
    worktree: retryCheckpoint.worktree,
    changedSurfaces: retryCheckpoint.changedSurfaces,
    range: retryCheckpoint.range,
    unscopedPaths: retryCheckpoint.unscopedPaths,
    projectCapabilities: retryCheckpoint.projectCapabilities,
    verify: opts.verify != null ? opts.verify : retryCheckpoint.verify,
    admissionFacts: sourceRevision
      ? opts.admissionFacts
      : opts.admissionFacts || retryCheckpoint.admissionFacts,
  };
}

function rejectedSubmissionMatches(submission?: any, rejected?: any) {
  if (submission?.sourceRevision || rejected?.sourceRevision) {
    return sameSourceRevision(submission?.sourceRevision, rejected?.sourceRevision);
  }
  return Boolean(
    submission?.commit
    && rejected?.commit
    && String(submission.commit).toLowerCase() === String(rejected.commit).toLowerCase()
  );
}

function putTicketTransaction(slug: any, ticket: any) {
  return transaction(() => putTicket(slug, ticket));
}

function candidateReviewRelation(slug: any, ticket: any) {
  return reviewRelationFor(ticket, listTickets(slug), (idOrRef: string) => getTicket(slug, idOrRef));
}

// Every mutation that would move, replace, or erase a candidate under review
// stops here. Presence of either half of the binding is enough, so a legacy
// one-sided relation refuses exactly like a complete one.
function candidateReviewLocked(slug: any, ticket: any, operation: string) {
  const relation = candidateReviewRelation(slug, ticket);
  if (!relation) return null;
  return {
    ok: false,
    reason: 'candidate_review_locked',
    ticket,
    relation,
    message: reviewLockMessage(operation, ticket, relation),
  };
}

// Both identities come from the immutable terminal attempt snapshots rather than
// the live dispatch record, which a later prepared attempt rewrites in place.
function terminalReviewFailure(ticket: any, relation: any) {
  const reviewTicket = relation.reviewTicket;
  if (relation.conflict || !reviewTicket || reviewTicket.status !== 'done') {
    return `${reviewRelationRef(relation)} has not terminally completed its bound review of ${ticket.ref}`;
  }
  const target = reviewTicket.reviewTarget;
  const submitted = reviewCandidateFromSubmission(ticket.submission);
  if (target?.ticketId !== ticket.id || target?.candidate?.source !== submitted?.source || target?.candidate?.value !== submitted?.value) {
    return `${reviewRelationRef(relation)} is not the review of this exact candidate`;
  }
  const provenance = reviewProvenance(ticket, reviewTicket);
  if (provenance.reason === 'source_attempt_missing') {
    return `${ticket.ref} has no terminal dispatch attempt that submitted candidate ${submitted?.value || 'under review'}`;
  }
  if (provenance.reason === 'review_attempt_missing') {
    return `${reviewRelationRef(relation)} has no terminal done dispatch attempt for its bound review of ${ticket.ref}`;
  }
  if (provenance.reason === 'agent_identity_missing') {
    return `${reviewRelationRef(relation)} and ${ticket.ref} do not both carry a hook-bound runtime agent identity`;
  }
  if (provenance.reason === 'shared_agent_identity') {
    return `${reviewRelationRef(relation)} was completed by the same runtime identity that submitted ${ticket.ref}`;
  }
  return null;
}

function rejectionQuarantineRef(ticket: any, rejectionNumber: number) {
  return `refs/sidequest/${ticket.ref}-rejected${rejectionNumber === 1 ? '' : `-${rejectionNumber}`}`;
}

function finalizePendingRejection(ticket: any, rejected: any) {
  const source = rejected.source || 'mcp';
  rejected.preservationState = 'preserved';
  delete rejected.preservationError;
  if (rejected.rejectionKind === 'rework') {
    const previousStatus = rejected.previousStatus || ticket.status;
    if (ticket.submission && rejectedSubmissionMatches(ticket.submission, rejected)) {
      ticket.submission = null;
      ticket.status = 'todo';
      ticket.statusTransition = { from: previousStatus, to: ticket.status, at: rejected.rejectedAt };
    }
    appendReworkEvent(ticket, 'submission_rejected', {
      at: rejected.rejectedAt,
      by: rejected.rejectedBy,
      source,
      fromStatus: previousStatus,
      toStatus: ticket.status,
    });
  } else {
    appendReworkEvent(ticket, 'submission_validation_rejected', {
      at: rejected.rejectedAt,
      by: rejected.rejectedBy,
      source,
    });
  }
  ticket.lastEventType = 'status';
  ticket.lastEventSource = source;
  ticket.updatedAt = rejected.rejectedAt;
}

function preservePendingRejection(slug: any, ticket: any, rejected: any, root: string) {
  const history = rejectionHistory(ticket);
  const firstRejectionNumber = Math.max(1, history.indexOf(rejected) + 1);
  let preserved: any = { ok: false, reason: 'quarantine_ref_exhausted' };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    rejected.quarantineRef = rejectionQuarantineRef(ticket, firstRejectionNumber + attempt);
    putTicketTransaction(slug, ticket);
    preserved = commitScope.preserveCommitRef(root, rejected.commit, rejected.quarantineRef, { noOverwrite: true });
    if (preserved.ok || preserved.reason !== 'git_ref_collision') break;
  }
  if (!preserved.ok) {
    rejected.preservationError = {
      reason: preserved.reason,
      ...(preserved.message ? { message: preserved.message } : {}),
    };
    putTicketTransaction(slug, ticket);
    return {
      ok: false,
      reason: 'rejected_submission_preservation_failed',
      ticket,
      message: `Could not preserve ${rejected.commit} at ${rejected.quarantineRef}: ${preserved.reason}${preserved.message ? `: ${preserved.message}` : ''}`,
    };
  }
  rejected.commit = preserved.commit;
  finalizePendingRejection(ticket, rejected);
  putTicketTransaction(slug, ticket);
  return { ok: true, ticket, rejected };
}

function preserveRejectedSubmission(slug: any, ticket: any, rejected: any, root: string) {
  if (!rejected.sourceRevision) {
    if (!root) {
      return {
        ok: false,
        reason: 'rejected_submission_preservation_failed',
        ticket,
        message: `rework: refused ${ticket.ref}; missing project path`,
      };
    }
    return preservePendingRejection(slug, ticket, rejected, root);
  }
  rejected.preservationState = 'preserved';
  delete rejected.preservationError;
  delete rejected.quarantineRef;
  finalizePendingRejection(ticket, rejected);
  putTicketTransaction(slug, ticket);
  return { ok: true, ticket, rejected };
}

function reconcileSubmissionRejections(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    const pending = rejectionHistory(ticket).filter((entry: any) => entry.preservationState === 'pending');
    if (!pending.length) return { ok: true, ticket, recovered: [] };
    // Finishing a half-written rejection of the candidate currently under review
    // would reject it by the back door, so only a record of some OTHER candidate
    // may still be completed.
    if (pending.some((entry: any) => rejectedSubmissionMatches(ticket.submission, entry))) {
      const reviewLock = candidateReviewLocked(slug, ticket, 'reconcile rejected submission');
      if (reviewLock) return reviewLock;
    }
    const root = String(readMeta(slug)?.path || '').trim();
    const recovered: any[] = [];
    for (const rejected of pending) {
      const result = preserveRejectedSubmission(slug, ticket, rejected, root);
      if (!result.ok) return Object.assign(result, { recovered });
      recovered.push(result.rejected);
    }
    queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
    return { ok: true, ticket, recovered };
  });
}

function checkpointTtlMs(ttlMinutes?: any) {
  const minutes = ttlMinutes == null ? DEFAULT_CHECKPOINT_TTL_MIN : Number(ttlMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CHECKPOINT_TTL_MIN) {
    throw new Error(`checkpoint TTL must be an integer from 1 to ${MAX_CHECKPOINT_TTL_MIN} minutes`);
  }
  return minutes * 60 * 1000;
}

function checkpointProjection(ticket?: any, now?: any) {
  const checkpoint = ticket && ticket.checkpoint;
  if (!checkpoint) return null;
  const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const expiresMs = Date.parse(checkpoint.expiresAt);
  let state = 'expired';
  if (Number.isFinite(expiresMs) && expiresMs > atMs) {
    if (pendingSubmission(ticket)) state = 'submitted';
    else if (ticket.status === 'done') state = 'completed';
    else {
      const claim = ticket.claim;
      // A checkpoint is recoverable when nobody holds the ticket, never because
      // the holder has been at it a while.
      if (!claim || !claim.by) state = 'recoverable';
      else state = claim.by === checkpoint.by ? 'active' : 'resumed';
    }
  }
  const verify = boundedExcerpt(String(checkpoint.verify || ''), CHECKPOINT_VERIFY_EXCERPT_MAX);
  return {
    id: checkpoint.id,
    state,
    by: checkpoint.by,
    at: checkpoint.at,
    expiresAt: checkpoint.expiresAt,
    ttlMinutes: checkpoint.ttlMinutes,
    kind: checkpoint.kind || 'review',
    commit: checkpoint.commit || null,
    gitRef: checkpoint.gitRef || null,
    failure: checkpoint.failure || null,
    worktree: checkpoint.worktree || null,
    verify: verify.text,
    verifyLength: verify.length,
    verifyTruncated: verify.truncated,
  };
}

function oracleProjection(ticket?: any) {
  const oracle = ticket && ticket.oracle;
  if (ticket?.status !== 'awaiting-oracle' || !oracle) return null;
  const round = Number(oracle.round);
  const at = nullableText(oracle.at);
  const candidate = nullableText(oracle.candidate);
  const deliverable = nullableText(oracle.deliverable);
  const ask = nullableText(oracle.ask);
  if (!Number.isInteger(round) || round < 1 || !at || !ask) return null;
  const summary = [
    `awaiting oracle since ${at}`,
    `round ${round}`,
    candidate ? `candidate ${candidate}` : null,
    `ask: ${ask.replace(/\s+/g, ' ')}`,
  ].filter(Boolean).join(', ');
  return { round, at, candidate, deliverable, ask, summary };
}

function checkpointCommentBody(checkpoint?: any) {
  const candidate = [
    checkpoint.commit ? `commit ${checkpoint.commit}` : null,
    checkpoint.worktree ? `worktree ${checkpoint.worktree}` : null,
  ].filter(Boolean).join(', ');
  return `Live review checkpoint ${checkpoint.id}\nCandidate: ${candidate}\nVerification: ${checkpoint.verify}\nExpires: ${checkpoint.expiresAt}`;
}

function checkpointTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const commit = opts.commit == null || String(opts.commit).trim() === '' ? null : String(opts.commit).trim().toLowerCase();
  if (commit && !SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}": pass the verified commit's hex hash (7-64 chars)`);
  }
  const worktree = opts.worktree == null || String(opts.worktree).trim() === '' ? null : String(opts.worktree).trim();
  if (worktree && (!path.isAbsolute(worktree) || worktree.length > SUBMISSION_WORKTREE_MAX)) {
    throw new Error(`checkpoint worktree must be an absolute path no longer than ${SUBMISSION_WORKTREE_MAX} characters`);
  }
  if (!commit && !worktree) throw new Error('checkpoint requires a commit hash or absolute worktree path');
  const verify = String(opts.verify || '').trim();
  if (!verify) throw new Error('checkpoint verification evidence is required');
  if (verify.length > CHECKPOINT_VERIFY_MAX) throw new Error(`checkpoint verification evidence exceeds ${CHECKPOINT_VERIFY_MAX} characters`);
  const ttlMs = checkpointTtlMs(opts.ttlMinutes);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    if (pendingSubmission(t)) return { ok: false, reason: 'submitted', ticket: t, submission: t.submission };
    const held = t.claim;
    if (!held || !held.by) return { ok: false, reason: 'not_claimed', ticket: t };
    if (held.by !== by) return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const now = new Date(nowMs).toISOString();
    const checkpoint = {
      id: `cp_${crypto.randomBytes(8).toString('hex')}`,
      by,
      at: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      ttlMinutes: ttlMs / 60000,
      kind: opts.kind === 'submission_rejected' ? 'submission_rejected' : 'review',
      commit,
      gitRef: opts.gitRef == null ? null : String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX),
      failure: opts.failure && typeof opts.failure === 'object' ? {
        reason: String(opts.failure.reason || '').trim(),
        message: String(opts.failure.message || '').trim(),
      } : null,
      worktree,
      verify,
    };
    const body = opts.commentBody == null ? checkpointCommentBody(checkpoint) : String(opts.commentBody);
    const prepared = prepareComment({ by, body, source: opts.source || 'cli' });
    if (!prepared.ok) throw new Error(`checkpoint comment ${prepared.reason}`);
    const comment = createComment(prepared, now);
    if (!Array.isArray(t.comments)) t.comments = [];
    t.comments.push(comment);
    t.checkpoint = checkpoint;
    t.claim = Object.assign({}, held, { activeAt: now });
    t.lastEventType = 'comment';
    t.lastEventSource = comment.source;
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, checkpoint: checkpointProjection(t, nowMs), comment };
  });
}

function submissionUnscopedPaths(paths?: any) {
  return Array.from(new Set((Array.isArray(paths) ? paths : [])
    .map((value?: any) => String(value || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)));
}

// A shared tree can contain user dirt at launch and sibling dirt added later.
// Content identity proves the first case; the submitted range proves the second.
// Neither belongs in this ticket's commit, so closeout reports it without pushing
// the executor to sweep foreign work into scope (SQ-95, SQ-1328).
function inheritedDirtyPaths(slug?: any, ticket?: any) {
  const baseline = dispatchState(ticket)?.dirtyBaseline;
  const inherited = new Map<string, string>();
  if (!Array.isArray(baseline) || !baseline.length) return inherited;
  let current: any[];
  try {
    current = artifactWorkingState(slug);
  } catch (_: any) {
    return inherited;
  }
  const identities = new Map(current.map((entry: any) => [dirtyPathKey(entry.path), entry.identity]));
  for (const entry of baseline) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.identity !== 'string') continue;
    const key = dirtyPathKey(entry.path);
    if (identities.get(key) === entry.identity) inherited.set(key, entry.path);
  }
  return inherited;
}

function sharedTreeUnsubmittedWorkingPaths(ticket?: any, range?: any, reportedPaths?: any, inherited?: any) {
  if (dispatchState(ticket)?.sharedTree !== true || !range) return [];
  return reportedPaths.filter((file: string) => !inherited.has(dirtyPathKey(file)));
}

function sharedTreeWorkingPathAdvisory(inheritedPaths?: any, unsubmittedWorkingPaths?: any) {
  const attributedPaths = [
    ...inheritedPaths.map((file: string) => `${file} (present before dispatch)`),
    ...unsubmittedWorkingPaths.map((file: string) => `${file} (not in submitted range)`),
  ];
  if (!attributedPaths.length) return null;
  return `Shared-tree working paths excluded from this submission: ${attributedPaths.join(', ')}. Commit only your declared scope; never stash or revert foreign paths.`;
}

function submissionReadiness(submission?: any) {
  const unscopedPaths = submissionUnscopedPaths(submission?.unscopedPaths);
  if (!unscopedPaths.length) return { ok: true, state: 'ready', reason: null, unscopedPaths };
  return {
    ok: false,
    state: 'partial',
    reason: 'unscoped_paths',
    unscopedPaths,
    message: `PARTIAL: scope-gated paths remain outside this submission: ${unscopedPaths.join(', ')}.`,
  };
}

function submissionProjection(submission?: any) {
  if (!submission) return null;
  return Object.assign({}, submission, { readiness: submissionReadiness(submission) });
}

function submissionRangeMetadata(range?: any, commit?: any) {
  if (!range) return null;
  const base = String(range.base || '').trim().toLowerCase();
  const upstream = String(range.upstream || '').trim();
  const upstreamCommit = String(range.upstreamCommit || '').trim().toLowerCase();
  const commits = Array.isArray(range.commits) ? range.commits.map((value?: any) => String(value).trim().toLowerCase()) : [];
  const changedPaths = Array.isArray(range.changedPaths) ? range.changedPaths.map((value?: any) => String(value).trim().replace(/\\/g, '/')).filter(Boolean) : [];
  const integrationMode = range.integrationMode == null ? null : String(range.integrationMode).trim().toLowerCase();
  const integrationBranch = range.integrationBranch == null ? null : normalizeIntegrationBranch(range.integrationBranch);
  const noOp = range.noOp === true;
  if (!SUBMISSION_COMMIT_RE.test(base) || !upstream || !SUBMISSION_COMMIT_RE.test(upstreamCommit)
    || (!noOp && !commits.length) || (noOp && commits.length) || commits.some((value?: any) => !SUBMISSION_COMMIT_RE.test(value))
    || (!noOp && commits[commits.length - 1] !== commit)
    || (integrationMode != null && !['local', 'remote'].includes(integrationMode))) {
    throw new Error('invalid submission range metadata');
  }
  return Object.assign(
    { base, upstream, upstreamCommit, commits, changedPaths },
    noOp ? { noOp: true } : {},
    integrationMode ? { integrationMode } : {},
    integrationBranch ? { integrationBranch } : {},
  );
}

// A submission that has not been consumed by a done transition yet — the
// ticket is parked for the publish transaction, not for another executor.
function pendingSubmission(t?: any) {
  return !!(t && t.submission && (t.submission.commit || t.submission.sourceRevision) && !t.submission.integratedAt);
}

function submissionGitRef(ticket?: any) {
  return `refs/sidequest/${ticket.ref}`;
}

function integrationGit(repo: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.editor=true', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    timeout: 120_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function integrationGitError(error: any) {
  return String(error?.stderr || error?.stdout || error?.message || error || '').trim();
}

function unmergedIntegrationPaths(repo: string) {
  try {
    return integrationGit(repo, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function integrationConflictMessage(error: any, conflictedPaths: string[]) {
  const failure = integrationGitError(error);
  return conflictedPaths.length ? `${failure} Conflicted paths: ${conflictedPaths.join(', ')}.` : failure;
}

function integrationVerifyLogPath(slug: any, ticket: any) {
  const safeRef = String(ticket.ref || ticket.id || 'submission').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = String(dispatchState(ticket)?.evidenceDirectory || '').trim() || path.join(projectDir(slug), 'verification', safeRef);
  ensureDir(dir);
  return path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.log`);
}

function pinnedVerificationRequirement(ticket: any) {
  const pinned = ticket.dispatch?.verificationRequirement || ticket.dispatch?.lifecycleAttempt?.verificationRequirement || ticket.lifecycleAttempt?.verificationRequirement;
  if (pinned && typeof pinned === 'object') return pinned;
  const legacyCommand = String(ticket.executorVerify || ticket.submission?.verify || '').trim();
  if (!legacyCommand) {
    return verificationRequirement({ kind: 'custom', evidence: 'legacy project verifier was not recorded' });
  }
  return verificationRequirement({
    kind: classifyVerificationKind(legacyCommand, ticket.executorVerifyKind),
    command: legacyCommand,
    evidence: legacyCommand,
    artifact: ticket.executorAttestationArtifact,
  });
}

function recordedVerificationCaptures(ticket: any) {
  return Array.isArray(ticket?.verificationCaptures) ? ticket.verificationCaptures : [];
}

function captureCommandDetails(pinnedCommand: string, capturedCommand: string) {
  return `Pinned command: ${JSON.stringify(pinnedCommand)}\nCaptured command: ${JSON.stringify(capturedCommand)}`;
}

function amendedVerifierCaptureMessage(ticket: any, pinnedCommand: string, capturedCommand: string) {
  return `Verification capture for ${ticket.ref} used the live ticket verifier, but the verify was amended after dispatch. This dispatch still requires its pinned command.\n${captureCommandDetails(pinnedCommand, capturedCommand)}\nCheckpoint current work, release the claim, and re-dispatch; the recovery dispatch resumes the retained worktree and pins the amended verify. If the work is already verified by other evidence, release the claim and use orchestrator groomClose with deliveryCommit.`;
}

function recordVerificationCapture(slug: any, idOrRef: any, capture: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    const pinnedAtDispatch = ticket.dispatch?.verificationRequirement
      || ticket.dispatch?.lifecycleAttempt?.verificationRequirement
      || ticket.lifecycleAttempt?.verificationRequirement;
    const requirement = pinnedVerificationRequirement(ticket);
    const capturedCommand = String(capture?.command || '');
    const command = capturedCommand.trim();
    const pinnedCommand = String(requirement.command || '');
    const expectedCommand = pinnedCommand.trim();
    const status = String(capture?.status || '').trim();
    const candidateSource = String(capture?.candidate?.source || '').trim();
    const candidateValue = String(capture?.candidate?.value || '').trim().toLowerCase();
    if (!expectedCommand || command !== expectedCommand) {
      const liveCommand = String(ticket.executorVerify || '').trim();
      const message = pinnedAtDispatch && expectedCommand && liveCommand && command === liveCommand
        ? amendedVerifierCaptureMessage(ticket, pinnedCommand, capturedCommand)
        : `Verification capture for ${ticket.ref} must use its declared command pinned at dispatch.\n${captureCommandDetails(pinnedCommand, capturedCommand)}`;
      return { ok: false, reason: 'verification_capture_command_mismatch', ticket, message };
    }
    if (!['passed', 'failed_suite', 'toolchain_missing', 'could_not_run', 'timeout', 'manual', 'attestation', 'skipped', 'failed_check'].includes(status)) {
      return { ok: false, reason: 'invalid_verification_capture_status', ticket, message: `Verification capture for ${ticket.ref} has an invalid status.` };
    }
    if (!candidateSource || !candidateValue) {
      return { ok: false, reason: 'verification_capture_candidate_required', ticket, message: `Verification capture for ${ticket.ref} requires the candidate revision it checked.` };
    }
    const completedAt = String(capture?.completedAt || '').trim();
    if (!Number.isFinite(Date.parse(completedAt))) {
      return { ok: false, reason: 'verification_capture_completion_required', ticket, message: `Verification capture for ${ticket.ref} requires a completion timestamp.` };
    }
    const verified = {
      id: String(capture?.id || crypto.randomUUID()),
      ticket: ticket.ref,
      command,
      status,
      candidate: { source: candidateSource, value: candidateValue },
      dispatchNonce: String(ticket.dispatchNonce || ''),
      completedAt: new Date(completedAt).toISOString(),
      ...(capture?.worktree ? { worktree: String(capture.worktree) } : {}),
      ...(capture?.logPath ? { logPath: String(capture.logPath) } : {}),
      ...(Number.isInteger(capture?.exitCode) ? { exitCode: Number(capture.exitCode) } : {}),
      ...(capture?.shell ? { shell: String(capture.shell) } : {}),
      ...(Number.isFinite(capture?.waitedForSlotMs) ? { waitedForSlotMs: Number(capture.waitedForSlotMs) } : {}),
      ...(Number.isInteger(capture?.queuePosition) ? { queuePosition: Number(capture.queuePosition) } : {}),
    };
    ticket.verificationCaptures = [...recordedVerificationCaptures(ticket), verified].slice(-VERIFICATION_CAPTURE_MAX);
    ticket.updatedAt = new Date().toISOString();
    putTicket(slug, ticket);
    return { ok: true, ticket, capture: verified };
  });
}

function skippedVerification(requirement: any, waiver: any) {
  const validated = validateVerificationWaiver(waiver);
  if ('code' in validated) {
    return {
      kind: requirement.kind,
      status: 'skipped',
      evidence: validated.message,
      command: requirement.command || null,
      failureIdentities: [validated.code],
    };
  }
  return {
    kind: requirement.kind,
    status: 'skipped',
    evidence: validated.reason,
    command: requirement.command || null,
    waiver: validated,
    diagnostics: [verificationWaiverDiagnostic(validated)],
  };
}

function verifyDeliveredSubmission(slug: any, ticket: any, opts?: any) {
  const requirement = pinnedVerificationRequirement(ticket);
  const submitted = ticket.submission?.verificationResult;
  if (submitted && typeof submitted === 'object' && !requirement.command) return submitted;
  if (opts?.skipVerify === true) return skippedVerification(requirement, opts.verificationWaiver);
  if (requirement.kind === 'attestation' || isArtifactSubmission(ticket.submission)) {
    return {
      kind: 'attestation',
      status: 'attestation',
      artifact: ticket.submission?.sourceRevision?.value || requirement.artifact || null,
      evidence: String(ticket.submission?.verify || '').trim(),
    };
  }
  if (requirement.kind === 'manual') {
    return { kind: 'manual', status: 'manual', evidence: String(ticket.submission?.verify || requirement.evidenceContract), command: requirement.command || null };
  }
  if (!requirement.command) {
    return {
      kind: requirement.kind,
      status: 'could_not_run',
      evidence: 'The prepared verification requirement has no executable command.',
      command: null,
      failureIdentities: ['could_not_run:missing-command'],
    };
  }
  const validationError = verifyCommandError(requirement.command);
  if (validationError) {
    return {
      kind: requirement.kind,
      status: 'could_not_run',
      evidence: validationError,
      command: requirement.command,
      failureIdentities: ['could_not_run:invalid-command'],
    };
  }
  const timeoutMilliseconds = normalizeIntegrationVerifyTimeoutMs(boardConfig(slug)?.integrationVerifyTimeoutMs);
  return runProcessVerification(requirement, {
    cwd: readMeta(slug)?.path,
    timeoutMilliseconds,
    logPath: integrationVerifyLogPath(slug, ticket),
    outputTailBytes: INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES,
  });
}

function verificationFailureComment(verify: any) {
  return [
    `Integration verification returned ${verify.status}.`,
    verify.command ? `Command: ${verify.command}` : null,
    verify.logPath ? `Log: ${verify.logPath}` : null,
    Array.isArray(verify.failureIdentities) && verify.failureIdentities.length ? `Failures: ${verify.failureIdentities.join(', ')}` : null,
    verify.outputTail ? `Output tail:\n${verify.outputTail}` : null,
  ].filter(Boolean).join('\n');
}

function verifyIntegration(slug: any, idOrRef: any, opts?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket || !ticket.submission?.integration || ticket.submission.integration.outcome !== 'delivered') {
    return { ok: false, reason: 'delivery_required', ticket };
  }
  const verify = ticket.submission.integration?.verify || verifyDeliveredSubmission(slug, ticket, opts);
  const accepted = verificationAccepted(verify);
  const stored = updateSubmissionIntegration(slug, ticket.id, { verify, outcome: accepted ? 'verified' : verificationOutcome(verify) });
  if (!stored.ok) return stored;
  if (accepted) return { ok: true, ticket: stored.ticket, verify };
  const comment = addComment(slug, ticket.id, { by: String(opts?.by || 'orchestrator'), source: 'integration', body: verificationFailureComment(verify) });
  return { ok: false, reason: verificationOutcome(verify), ticket: comment.ticket || stored.ticket, verify };
}

function changedIntegrationPaths(repo: string, submission: any) {
  if (Array.isArray(submission.changedPaths) && submission.changedPaths.length) return submission.changedPaths.slice();
  return integrationGit(repo, ['diff', '--name-only', submission.base, submission.commit]).split(/\r?\n/).filter(Boolean);
}

function validateIntegrationSubmission(slug?: any, idOrRef?: any, opts?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  if (!pendingSubmission(ticket)) {
    return { ok: false, reason: 'submission_required', ticket, message: `${ticket.ref} has no submission to integrate.` };
  }
  const candidateReview = candidateReviewRelation(slug, ticket);
  if (candidateReview) {
    if (reviewRelationOutcome(candidateReview) === 'rejected') {
      return {
        ok: false,
        reason: 'candidate_rejected',
        ticket,
        message: `${ticket.ref} candidate was rejected by ${reviewRelationRef(candidateReview)}. Integration is permanently blocked; repair needs fresh ticket, attempt, candidate, and review identities.`,
      };
    }
    const reviewFailure = terminalReviewFailure(ticket, candidateReview);
    if (reviewFailure) {
      return { ok: false, reason: 'candidate_review_required', ticket, message: `${ticket.ref} integration refused; ${reviewFailure}.` };
    }
  }
  const requiredVerification = pinnedVerificationRequirement(ticket);
  if (requiredVerification.command && !isArtifactSubmission(ticket.submission)) {
    const recordedVerify = String(ticket.submission?.verify || '').trim();
    const verifyError = verifyCommandErrors(recordedVerify)[0];
    if (verifyError) {
      return {
        ok: false,
        reason: 'invalid_submission_verify',
        ticket,
        message: `${ticket.ref} integration refused; submission record verify ${JSON.stringify(boundedExcerpt(recordedVerify, 500).text)} is invalid: ${verifyError} The integrator reads submission.verify, not ticket.executorVerify. Re-submit with one runnable command or \`manual: <what you checked>\`.`,
      };
    }
  }
  const readiness = submissionReadiness(ticket.submission);
  if (!readiness.ok) {
    return {
      ok: false,
      reason: readiness.reason,
      ticket,
      submissionReadiness: readiness,
      message: `${ticket.ref} integration refused; ${readiness.message}`,
    };
  }
  const project = readMeta(slug);
  let integrationBranch: string | undefined;
  try {
    integrationBranch = String(integrationTarget(slug)?.branch || '').trim() || undefined;
  } catch {
    integrationBranch = undefined;
  }
  let scopeValidation = isArtifactSubmission(ticket.submission)
    ? { ok: true, changedPaths: ticket.submission.changedPaths || [] }
    : commitScope.validateStoredSubmissionRange(project?.path, ticket.submission, ticket.ref, integrationBranch);
  if (!scopeValidation.ok && opts?.deliveryInteractionCommit && scopeValidation.reason === 'reconciled_path_diverged') {
    scopeValidation = Object.assign({}, scopeValidation, { ok: true, reviewedMergedTreeInteraction: true });
  }
  if (!scopeValidation.ok) {
    const outside = Array.isArray(scopeValidation.outside) ? scopeValidation.outside : [];
    if (scopeValidation.reason === 'expected_upstream_diverged') {
      const targetBranch = integrationBranch || scopeValidation.upstream || 'the configured target';
      return {
        ok: false,
        reason: scopeValidation.reason,
        outside,
        ticket,
        scopeValidation,
        message: `${ticket.ref} integration refused; recorded expected upstream ${scopeValidation.upstreamCommit} is no longer reachable from target branch ${targetBranch}. Rework and submit a fresh candidate against current main, or when the work is verified, have the orchestrator record delivery through groomClose with deliveryCommit.`,
      };
    }
    const scopeFailure = scopeValidation.message || (scopeValidation.reason === 'missing_scope_snapshot'
      ? `${ticket.ref} submission has no admitted scope snapshot.`
      : outside.length
        ? `${ticket.ref} integration refused; submitted range changes paths outside its admitted scope: ${outside.join(', ')}.`
        : `${ticket.ref} integration refused; submitted range validation failed: ${scopeValidation.reason || 'unknown'}.`);
    return {
      ok: false,
      reason: scopeValidation.reason,
      outside,
      ticket,
      scopeValidation,
      message: `${scopeFailure} Preserve this candidate with rework and submit a fresh candidate against the admitted scope, or close it with supersede_submission after an integrated reviewed replacement.`,
    };
  }
  if (opts?.requireAssembledWave) {
    const waveGate = assembledWaveForDelivery(slug, ticket);
    if (!waveGate.ok) return Object.assign({ ticket }, waveGate);
  }
  if (opts?.requireDeliveredWave && ticket.submission?.wave?.delivery?.state !== 'delivered') {
    return {
      ok: false,
      reason: 'assembled_wave_delivery_required',
      ticket,
      message: `${ticket.ref} requires recorded delivery from its passing assembled wave before integration closure.`,
    };
  }
  return { ok: true, ticket, scopeValidation };
}

function reconciledDeliveryWave(slug: any, ticket: any, revision: any, verification: any) {
  const baseline = ticket.submission?.baseline || sourceRevisionBaseline(ticket);
  return {
    id: `reconciled-${ticket.ref}-${crypto.randomBytes(6).toString('hex')}`,
    baseline,
    participants: [ticket.ref],
    dependencies: {},
    declaredSurfaces: executionScope(slug, ticket),
    state: 'gate_passed',
    gate: { verification, state: 'gate_passed' },
    delivery: { state: 'delivered', revision, verification },
  };
}

function updateSubmissionIntegration(slug: any, id: any, patch: any, submissionPatch?: any) {
  return withTicketLock(slug, id, () => {
    const ticket = getTicket(slug, id);
    if (!ticket || !ticket.submission) return { ok: false, reason: 'submission_required', ticket };
    ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, patch);
    if (submissionPatch) Object.assign(ticket.submission, submissionPatch);
    ticket.updatedAt = new Date().toISOString();
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, 'status', 'integration');
    return { ok: true, ticket };
  });
}

function integrationFailure(slug: any, ticket: any, patch: any) {
  updateSubmissionIntegration(slug, ticket.id, Object.assign({ outcome: 'failed', completedAt: new Date().toISOString() }, patch));
  return Object.assign({ ok: false, ticket: getTicket(slug, ticket.id) }, patch);
}

function deliveryRecordFailure(ticket: any, delivery: any, error: any) {
  const detail = error?.message || String(error || 'unknown board write error');
  return {
    ok: false,
    reason: 'delivery_record_failed',
    ticket,
    delivery,
    message: `Delivered ${delivery.commit} to ${delivery.targetBranch} at ${delivery.resultingHead}; board record failed: ${detail}`,
  };
}

function integrationTargetCheckoutState(repo: string) {
  return integrationGit(repo, ['status', '--porcelain=v2', '--untracked-files=all']).split(/\r?\n/).filter(Boolean);
}

function integrationTargetCheckoutPath(entry: string) {
  if (/^[?!] /.test(entry)) return entry.slice(2);
  const fieldsBeforePath = entry.startsWith('1 ') ? 8 : entry.startsWith('2 ') ? 9 : entry.startsWith('u ') ? 10 : 0;
  return fieldsBeforePath ? entry.split(' ', fieldsBeforePath + 1)[fieldsBeforePath]?.split('\t')[0] || entry : entry;
}

function integrationTargetDirtyMessage(mode: string, checkoutState: string[]) {
  const paths = checkoutState.slice(0, INTEGRATION_TARGET_DIRTY_PATH_LIMIT).map(integrationTargetCheckoutPath);
  const remaining = checkoutState.length - paths.length;
  return `${mode} refused; integration target has pending checkout state: ${paths.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.`;
}

function integrationOperationResidue(repo: string) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].filter((reference) => {
    const operationPath = integrationGit(repo, ['rev-parse', '--git-path', reference]);
    return fs.existsSync(operationPath);
  });
}

function restoreCleanIntegrationCheckout(repo: string, before: string) {
  integrationGit(repo, ['reset', '--merge', before]);
  const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
  const checkoutState = integrationTargetCheckoutState(repo);
  const operationResidue = integrationOperationResidue(repo);
  if (resultingHead !== before || checkoutState.length || operationResidue.length) {
    throw new Error(`Expected clean checkout at ${before}; HEAD is ${resultingHead}, status has ${checkoutState.length} entries, operation residue: ${operationResidue.join(', ') || 'none'}.`);
  }
}

function deliveryResultIsReachable(repo: string, deliveryHead: string, currentHead: string) {
  try {
    integrationGit(repo, ['merge-base', '--is-ancestor', deliveryHead, currentHead]);
    return true;
  } catch (error: any) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function rejectedPostMergeRollbackMessage(repo: string, before: string, deliveryHead: string, targetBranch: string, currentHead: string) {
  if (deliveryResultIsReachable(repo, deliveryHead, currentHead)) {
    return `Automatic rollback refused: ${targetBranch} STILL CONTAINS the delivered merge ${deliveryHead} at ${currentHead}, so Sidequest will not discard commits after it. Manual recovery: inspect ${targetBranch}, then reset it to the recorded pre-merge head ${before} only when that is safe.`;
  }
  return `Automatic rollback refused: ${targetBranch} no longer contains the delivered merge ${deliveryHead}; it now points at ${currentHead}. Manual recovery: inspect ${targetBranch} and recover it from the recorded pre-merge head ${before}.`;
}

function restorePostMergeVerificationCheckout(repo: string, before: string, deliveryHead: string, targetBranch: string, mode: string) {
  const currentBranch = integrationGit(repo, ['branch', '--show-current']);
  const currentHead = integrationGit(repo, ['rev-parse', 'HEAD']);
  const branchHead = integrationGit(repo, ['rev-parse', '--verify', `refs/heads/${targetBranch}^{commit}`]);
  const mergeBase = mode === 'merge' ? integrationGit(repo, ['rev-parse', `${deliveryHead}^1`]) : before;
  if (currentBranch !== targetBranch || currentHead !== deliveryHead || branchHead !== deliveryHead || mergeBase !== before) {
    throw new Error(rejectedPostMergeRollbackMessage(repo, before, deliveryHead, targetBranch, currentHead));
  }
  integrationGit(repo, ['reset', '--hard', before]);
  const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
  const checkoutState = integrationTargetCheckoutState(repo);
  const operationResidue = integrationOperationResidue(repo);
  if (resultingHead !== before || checkoutState.length || operationResidue.length) {
    throw new Error(`Expected clean hard-reset checkout at ${before}; HEAD is ${resultingHead}, status has ${checkoutState.length} entries, operation residue: ${operationResidue.join(', ') || 'none'}.`);
  }
  return { strategy: 'hard-reset-delivery-head', before, deliveryHead, targetBranch };
}

function deliveryLockPath(repo: string) {
  return path.resolve(repo, integrationGit(repo, ['rev-parse', '--git-common-dir']), 'sidequest-delivery.lock');
}

function deliveryInProgress(ticket: any) {
  return {
    ok: false,
    reason: 'delivery_in_progress',
    ticket,
    message: `Integration is already delivering another submission into this checkout. Retry ${ticket.ref} after that delivery finishes.`,
  };
}

function postMergeVerificationFailure(slug: any, ticket: any, verify: any, repo: string, mode: string, before: string, deliveryHead: string, targetBranch: string) {
  const verificationMessage = `${ticket.ref} verification returned ${verify.status} after ${mode} delivery: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`;
  try {
    const rollback = restorePostMergeVerificationCheckout(repo, before, deliveryHead, targetBranch, mode);
    return integrationFailure(slug, ticket, {
      reason: `${verificationOutcome(verify)}_post_merge`,
      before,
      deliveryHead,
      rollback,
      verify,
      message: `${verificationMessage} Sidequest rolled back delivery ${deliveryHead} to the recorded pre-merge head ${before} after verification changed tracked files.`,
    });
  } catch (error: any) {
    return integrationFailure(slug, ticket, {
      reason: `${verificationOutcome(verify)}_post_merge_rollback_failed`,
      before,
      deliveryHead,
      rollback: { strategy: 'refused', before, deliveryHead, targetBranch },
      verify,
      message: `${verificationMessage} Rollback failed: ${integrationGitError(error)}`,
    });
  }
}

function submissionUsesGit(ticket?: any) {
  return !isArtifactSubmission(ticket?.submission) || ticket.submission.projectCapabilities?.git !== false;
}

function integrateArtifactSubmission(slug: any, ticket: any, opts?: any) {
  const submission = ticket.submission;
  const capabilities = submission.projectCapabilities || {};
  const changedPaths = changedIntegrationPaths('', submission);
  const verify = verifyDeliveredSubmission(slug, ticket, opts);
  if (capabilities.process === false && verify.status !== 'attestation') {
    return integrationFailure(slug, ticket, {
      reason: 'artifact_attestation_required',
      verify,
      message: `${ticket.ref} requires attestation or review evidence for integration without process capability.`,
    });
  }
  if (!verificationAccepted(verify)) {
    return integrationFailure(slug, ticket, {
      reason: `${verificationOutcome(verify)}_delivery`,
      verify,
      message: `${ticket.ref} delivery verification returned ${verify.status}.`,
    });
  }
  const delivery = recordTicketWaveDelivery(slug, ticket, submission.sourceRevision, verify);
  if (!delivery.ok) return integrationFailure(slug, ticket, { reason: delivery.reason, verify, message: delivery.message });
  const integratedAt = new Date().toISOString();
  const integration = {
    mode: 'source-revision',
    sourceRevision: submission.sourceRevision,
    changedPaths,
    deliveredFiles: changedPaths,
    verify,
    outcome: 'delivered',
    recordedAt: integratedAt,
    deliveredAt: integratedAt,
    verifiedAt: integratedAt,
  };
  const recorded = updateSubmissionIntegration(slug, ticket.id, integration);
  return recorded.ok ? { ok: true, ticket: recorded.ticket, integration: recorded.ticket.submission.integration } : recorded;
}

function patchIdForCommit(repo: string, commit: string) {
  const parent = integrationGit(repo, ['rev-parse', `${commit}^`]);
  const patch = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', parent, commit], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd: repo,
    encoding: 'utf8',
    input: patch,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result?.status !== 0) throw new Error(String(result?.stderr || result?.error?.message || 'could not calculate patch identity'));
  const patchId = String(result.stdout || '').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/i.test(patchId)) throw new Error(`could not calculate a content identity for ${commit}`);
  return patchId.toLowerCase();
}

function deliveryContainsSubmittedContent(repo: string, submission: any, deliveryCommit: string) {
  const candidate = String(submission.commit || '').toLowerCase();
  try {
    integrationGit(repo, ['merge-base', '--is-ancestor', candidate, deliveryCommit]);
    return { ok: true, evidence: 'candidate_ancestor' };
  } catch (error: any) {
    if (error?.status !== 1) throw error;
  }
  const commonBase = integrationGit(repo, ['merge-base', candidate, deliveryCommit]);
  const deliveredCommits = integrationGit(repo, ['rev-list', '--reverse', `${commonBase}..${deliveryCommit}`]).split(/\r?\n/).filter(Boolean);
  const deliveredPatchIds = new Set(deliveredCommits.map((commit: string) => patchIdForCommit(repo, commit)));
  const candidateCommits = Array.isArray(submission.commits) && submission.commits.length ? submission.commits : [candidate];
  const missing = candidateCommits.filter((commit: any) => !deliveredPatchIds.has(patchIdForCommit(repo, String(commit))));
  return missing.length
    ? { ok: false, missing }
    : { ok: true, evidence: 'equivalent_patches' };
}

function reviewedMergedTreeInteraction(repo: string, ticket: any, sourceCommit: string, resultingHead: string, requestedInteraction: any) {
  const interaction = String(requestedInteraction || '').trim();
  if (!interaction) return { ok: true, interaction: null };
  if (!SUBMISSION_COMMIT_RE.test(interaction)) {
    return {
      ok: false,
      reason: 'delivery_interaction_required',
      message: `${ticket.ref} reviewed interaction delivery requires a commit hash for deliveryInteractionCommit.`,
    };
  }
  const interactionCommit = integrationGit(repo, ['rev-parse', '--verify', `${interaction}^{commit}`]).toLowerCase();
  if (interactionCommit === sourceCommit) {
    return {
      ok: false,
      reason: 'delivery_interaction_required',
      message: `${ticket.ref} reviewed interaction delivery requires a commit after source ${sourceCommit}.`,
    };
  }
  for (const [commit, label] of [[sourceCommit, 'source'], [interactionCommit, 'interaction']]) {
    try {
      integrationGit(repo, ['merge-base', '--is-ancestor', commit, resultingHead]);
    } catch (error: any) {
      if (error?.status === 1) {
        return {
          ok: false,
          reason: 'delivery_interaction_not_reachable',
          message: `${ticket.ref} reviewed interaction delivery requires its ${label} commit ${commit} to be reachable from ${resultingHead}.`,
        };
      }
      throw error;
    }
  }
  try {
    integrationGit(repo, ['merge-base', '--is-ancestor', sourceCommit, interactionCommit]);
  } catch (error: any) {
    if (error?.status === 1) {
      return {
        ok: false,
        reason: 'delivery_interaction_not_descendant',
        message: `${ticket.ref} reviewed interaction ${interactionCommit} must descend from delivered source ${sourceCommit}.`,
      };
    }
    throw error;
  }
  const interactionPaths = integrationGit(repo, ['diff', '--name-only', sourceCommit, interactionCommit]).split(/\r?\n/).filter(Boolean);
  if (!interactionPaths.length) {
    return {
      ok: false,
      reason: 'delivery_interaction_required',
      message: `${ticket.ref} reviewed interaction ${interactionCommit} did not change the delivered source tree.`,
    };
  }
  const submittedPaths = changedIntegrationPaths(repo, ticket.submission);
  const unrelatedPaths = interactionPaths.filter((file: string) => !isInScope(file, submittedPaths));
  if (unrelatedPaths.length) {
    return {
      ok: false,
      reason: 'delivery_interaction_outside_candidate',
      unrelatedPaths,
      message: `${ticket.ref} reviewed interaction ${interactionCommit} changes paths outside the submitted candidate: ${unrelatedPaths.join(', ')}. Record that work through its own reviewed delivery.`,
    };
  }
  return { ok: true, interaction: { commit: interactionCommit, paths: interactionPaths } };
}

function pinnedCandidateMatches(repo: string, ticket: any, candidate: string) {
  try {
    const pinnedCommit = integrationGit(repo, ['rev-parse', '--verify', `${submissionGitRef(ticket)}^{commit}`]).toLowerCase();
    return pinnedCommit === candidate;
  } catch (_) {
    return false;
  }
}

function workingTreeContainsSubmittedContent(repo: string, submission: any, candidate: string) {
  const missing: string[] = [];
  for (const file of changedIntegrationPaths(repo, submission)) {
    let candidateContents: Buffer | null;
    try {
      candidateContents = execFileSync('git', ['show', `${candidate}:${file}`], {
        cwd: repo,
        encoding: 'buffer',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      if (error?.status !== 128) throw error;
      candidateContents = null;
    }
    const workingPath = path.join(repo, file);
    const workingContents = fs.existsSync(workingPath) ? fs.readFileSync(workingPath) : null;
    if (candidateContents === null ? workingContents !== null : workingContents === null || !candidateContents.equals(workingContents)) {
      missing.push(file);
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true, evidence: 'working_tree_matches_candidate' };
}

function workingTreeDeliveryPaths(repo: string) {
  const tracked = integrationGit(repo, ['diff', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean);
  const untracked = integrationGit(repo, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked]));
}

function workingTreeDeliveryMethod(value: any) {
  const method = String(value || '').trim();
  return WORKING_TREE_DELIVERY_METHODS.has(method) ? method : null;
}

function recordDeliveredSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const preflight = validateIntegrationSubmission(slug, idOrRef, { deliveryInteractionCommit: opts.deliveryInteractionCommit });
  if (!preflight.ok) return preflight;
  const preflightTicket = preflight.ticket;
  if (opts.skipVerify === true) return { ok: false, reason: 'delivery_verify_required', ticket: preflightTicket, message: `${preflightTicket.ref} reconciliation requires a passing merged-tree verification; skipVerify is not allowed.` };
  const ticket = preflightTicket;
  if (!submissionUsesGit(ticket)) return { ok: false, reason: 'git_delivery_required', ticket, message: `${ticket.ref} has no Git candidate to reconcile.` };
  const reason = String(opts.reason || '').trim();
  const requestedCommit = String(opts.deliveryCommit || '').trim();
  if (!reason) return { ok: false, reason: 'evidence_required', ticket, message: `${ticket.ref} reconciliation requires delivery evidence.` };
  if (!SUBMISSION_COMMIT_RE.test(requestedCommit)) return { ok: false, reason: 'delivery_commit_required', ticket, message: `${ticket.ref} reconciliation requires the delivery commit hash.` };
  const repo = String(readMeta(slug)?.path || '').trim();
  const target = opts.target;
  if (!repo || !target?.branch) return { ok: false, reason: 'integration_target_unavailable', ticket };
  try {
    const currentBranch = integrationGit(repo, ['branch', '--show-current']);
    if (currentBranch !== target.branch) {
      return { ok: false, reason: 'branch_not_checked_out', ticket, message: `${target.branch} must be checked out before recording an external delivery; currently on ${currentBranch || 'detached HEAD'}.` };
    }
    const deliveryCommit = integrationGit(repo, ['rev-parse', '--verify', `${requestedCommit}^{commit}`]).toLowerCase();
    const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']).toLowerCase();
    const deliveryRevision = {
      source: `git:${target.upstream}`,
      value: resultingHead,
      observedAt: new Date().toISOString(),
    };
    let reachable = true;
    try {
      integrationGit(repo, ['merge-base', '--is-ancestor', deliveryCommit, resultingHead]);
    } catch (error: any) {
      if (error?.status === 1) reachable = false;
      else throw error;
    }
    const deliveryMethod = workingTreeDeliveryMethod(opts.deliveryMethod);
    const requestedDeliveryMethod = String(opts.deliveryMethod || '').trim();
    if (requestedDeliveryMethod && !deliveryMethod) {
      return {
        ok: false,
        reason: 'invalid_delivery_method',
        ticket,
        message: `${ticket.ref} reconciliation refused: deliveryMethod must be reset, working-tree, or manual.`,
      };
    }
    const workingTreeDelivery = deliveryMethod !== null && !reachable;
    if (!reachable && !workingTreeDelivery) {
      return {
        ok: false,
        reason: 'delivery_not_reachable',
        ticket,
        message: `${ticket.ref} reconciliation refused: delivery commit ${deliveryCommit} is not reachable from ${target.branch}. Record a reset, working-tree, or manual delivery with this pinned candidate, deliveryMethod, and the candidate content present in the integration working tree.`,
      };
    }
    if (workingTreeDelivery && !pinnedCandidateMatches(repo, ticket, deliveryCommit)) {
      return {
        ok: false,
        reason: 'delivery_not_pinned',
        ticket,
        message: `${ticket.ref} reconciliation refused: non-reachable delivery must name its immutable ${submissionGitRef(ticket)} candidate, not ${deliveryCommit}.`,
      };
    }
    const content = workingTreeDelivery && !reachable
      ? workingTreeContainsSubmittedContent(repo, ticket.submission, deliveryCommit)
      : deliveryContainsSubmittedContent(repo, ticket.submission, deliveryCommit);
    if (!content.ok) {
      return {
        ok: false,
        reason: 'delivery_content_missing',
        ticket,
        missingCommits: content.missing,
        message: `${ticket.ref} reconciliation refused: ${deliveryCommit} does not preserve the submitted candidate content for ${content.missing.join(', ')}.`,
      };
    }
    const interaction = workingTreeDelivery
      ? { ok: true, interaction: null }
      : reviewedMergedTreeInteraction(repo, ticket, deliveryCommit, resultingHead, opts.deliveryInteractionCommit);
    if (!interaction.ok) return Object.assign({ ticket }, interaction);
    const verify = verifyDeliveredSubmission(slug, ticket);
    if (!verificationAccepted(verify)) {
      return integrationFailure(slug, ticket, {
        reason: `${verificationOutcome(verify)}_recorded_delivery`,
        verify,
        message: `${ticket.ref} merged-tree verification returned ${verify.status} for recorded delivery ${deliveryCommit}: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`,
      });
    }
    const deliveredFiles = workingTreeDelivery
      ? workingTreeDeliveryPaths(repo)
      : interaction.interaction
        ? Array.from(new Set([...deliveredCommitPaths(repo, deliveryCommit), ...interaction.interaction.paths]))
        : deliveredCommitPaths(repo, deliveryCommit);
    const deliveryIdentity = {
      kind: interaction.interaction ? 'reviewed-merged-tree-interaction' : workingTreeDelivery ? 'pinned-working-tree' : 'reachable-commit',
      pinnedRef: submissionGitRef(ticket),
      candidate: ticket.submission.commit,
      sourceRevision: deliveryRevision,
      ...(interaction.interaction ? { sourceCommit: deliveryCommit, interaction: interaction.interaction } : {}),
      ...(workingTreeDelivery ? { method: deliveryMethod } : {}),
    };
    const recorded = updateSubmissionIntegration(slug, ticket.id, {
      mode: interaction.interaction ? 'recorded-reviewed-interaction' : workingTreeDelivery ? 'recorded-working-tree' : 'recorded',
      pinnedRef: submissionGitRef(ticket),
      pinnedCommit: ticket.submission.commit,
      deliveryCommit,
      resultingHead,
      contentCommit: workingTreeDelivery ? deliveryCommit : resultingHead,
      deliveryRevision,
      deliveryIdentity,
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      changedPaths: changedIntegrationPaths(repo, ticket.submission),
      deliveredFiles,
      verify,
      evidence: reason,
      contentEvidence: interaction.interaction ? `${content.evidence}:reviewed_merged_tree_interaction` : content.evidence,
      outcome: 'verified',
      recordedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    }, { wave: reconciledDeliveryWave(slug, ticket, deliveryRevision, verify) });
    return recorded.ok ? { ok: true, ticket: recorded.ticket, integration: recorded.ticket.submission.integration } : recorded;
  } catch (error: any) {
    return { ok: false, reason: 'delivery_evidence_unavailable', ticket, message: `${ticket.ref} reconciliation refused because delivery evidence could not be inspected: ${integrationGitError(error)}` };
  }
}

function recordAlreadyLandedSubmission(slug: any, found: any, target: any, candidate: string, reason: string, repo: string) {
  const resultingHead = integrationGit(repo, ['rev-parse', `refs/heads/${target.branch}`]).toLowerCase();
  const now = new Date().toISOString();
  const deliveryRevision = {
    source: `git:${target.upstream || target.branch}`,
    value: resultingHead,
    observedAt: now,
  };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket?.submission || !pendingSubmission(ticket)) return { ok: false, reason: 'submission_required', ticket };
    if (String(ticket.submission.commit || '').trim().toLowerCase() !== candidate) {
      return { ok: false, reason: 'submission_changed', ticket, message: `${ticket.ref} changed candidates while landed delivery evidence was being recorded.` };
    }
    const changedPaths = changedIntegrationPaths(repo, ticket.submission);
    ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, {
      mode: 'already-landed',
      outcome: 'delivered',
      pinnedRef: submissionGitRef(ticket),
      pinnedCommit: candidate,
      deliveryCommit: candidate,
      resultingHead,
      contentCommit: candidate,
      deliveryRevision,
      deliveryIdentity: {
        kind: 'already-landed-candidate',
        pinnedRef: submissionGitRef(ticket),
        candidate,
        sourceRevision: deliveryRevision,
      },
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      changedPaths,
      deliveredFiles: changedPaths,
      evidence: reason,
      contentEvidence: 'candidate_ancestor',
      recordedAt: now,
      deliveredAt: now,
    });
    ticket.submission.integratedAt = now;
    ticket.updatedAt = now;
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, 'status', 'integration');
    return { ok: true, ticket, integration: ticket.submission.integration };
  });
}

// Abandonment is legal only while the candidate is absent from the integration branch. A reachable
// candidate is already delivered, so the same closure call records that landed fact instead of
// redirecting into the assembled-wave gate used to decide whether an unlanded candidate may ship.
// This keeps abandonment from writing off shipped work without making historical delivery depend on
// a gate that can no longer change what reached the branch.
function recordAbandonedSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const reason = String(opts.reason || '').trim();
  if (!reason) return { ok: false, reason: 'evidence_required', ticket: found, message: `${found.ref} abandonment requires evidence that the candidate never landed.` };
  if (!pendingSubmission(found)) return { ok: false, reason: 'submission_required', ticket: found, message: `${found.ref} has no pending submission to abandon.` };
  const target = opts.target;
  const repo = String(readMeta(slug)?.path || '').trim();
  if (!repo || !target?.branch) return { ok: false, reason: 'integration_target_unavailable', ticket: found };
  const candidate = String(found.submission?.commit || '').trim();
  let candidateState = 'unresolvable';
  let landedCandidate: string | null = null;
  if (submissionUsesGit(found) && candidate) {
    try {
      const resolved = integrationGit(repo, ['rev-parse', '--verify', `${candidate}^{commit}`]).toLowerCase();
      try {
        integrationGit(repo, ['merge-base', '--is-ancestor', resolved, `refs/heads/${target.branch}`]);
        landedCandidate = resolved;
      } catch (error: any) {
        if (error?.status !== 1) throw error;
        candidateState = 'unreachable';
      }
    } catch (error: any) {
      // A stored candidate whose object no longer resolves is dead by definition, and refusing
      // here would deadlock the exact case this path exists for. Record which of the two it was.
      candidateState = 'unresolvable';
    }
  }
  if (landedCandidate) {
    try {
      return recordAlreadyLandedSubmission(slug, found, target, landedCandidate, reason, repo);
    } catch (error: any) {
      return { ok: false, reason: 'delivery_evidence_unavailable', ticket: found, message: `${found.ref} landed delivery evidence could not be recorded: ${integrationGitError(error)}` };
    }
  }
  const now = new Date().toISOString();
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket?.submission) return { ok: false, reason: 'submission_required', ticket };
    ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, {
      mode: 'abandoned',
      outcome: 'abandoned',
      pinnedRef: submissionGitRef(ticket),
      pinnedCommit: candidate || null,
      candidateState,
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      evidence: reason,
      abandonedAt: now,
      completedAt: now,
    });
    // Stamping integratedAt is what actually retires the submission: pendingSubmission keys on it,
    // so without it the ticket closes while the board still counts it as awaiting integration.
    // Supersession closes the same way, and the truthful record of what happened is the abandoned
    // outcome above, not this timestamp.
    ticket.submission.integratedAt = now;
    ticket.updatedAt = now;
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, 'status', 'integration');
    return { ok: true, ticket, integration: ticket.submission.integration };
  });
}

function integrateSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const preflight = validateIntegrationSubmission(slug, idOrRef);
  if (!preflight.ok) return preflight;
  const ticket = preflight.ticket;
  if (!submissionUsesGit(ticket)) {
    const assembled = ensureSingletonAssembledWave(slug, idOrRef, opts);
    if (!assembled.ok) return assembled;
    const admitted = validateIntegrationSubmission(slug, idOrRef, { requireAssembledWave: true });
    return admitted.ok ? integrateArtifactSubmission(slug, admitted.ticket, opts) : admitted;
  }
  const project = readMeta(slug);
  const repo = project?.path;
  const target = opts.target;
  if (!repo || !target || !target.branch) return { ok: false, reason: 'integration_target_unavailable', ticket };
  let lock: string;
  try {
    lock = deliveryLockPath(repo);
  } catch (error: any) {
    return { ok: false, reason: 'integration_target_unavailable', ticket, message: integrationGitError(error) };
  }
  const lockLease = acquireLock(lock, { wait: false });
  if (!lockLease) return deliveryInProgress(ticket);
  try {
    lockLease.refresh();
    return integrateSubmissionUnlocked(slug, idOrRef, opts);
  } finally {
    lockLease.refresh();
    releaseLock(lock, lockLease);
  }
}

function exactAssembledWave(slug: string | undefined, refs: string | readonly string[] | undefined): ExactWaveAdmission {
  const participantRefs = Array.from(new Set((Array.isArray(refs) ? refs : [refs]).map((ref) => String(ref || '').trim()).filter(Boolean)));
  if (!participantRefs.length) return { ok: false, reason: 'wave_participants_required', message: 'Delivery requires one or more assembled participant refs.' };
  for (const ref of participantRefs) {
    const admission = validateIntegrationSubmission(slug, ref);
    if (!admission.ok) {
      return {
        ok: false,
        reason: String(admission.reason || 'submission_required'),
        ...(admission.message ? { message: admission.message } : {}),
      };
    }
  }
  const tickets: WaveTicket[] = participantRefs.map((ref): WaveTicket => getTicket(slug, ref));
  const wave = tickets[0]?.submission.wave;
  const expectedParticipants = Array.isArray(wave?.participants) ? wave.participants.slice().sort() : [];
  const requestedParticipants = participantRefs.slice().sort();
  if (!wave
    || wave.gate?.state !== 'gate_passed'
    || expectedParticipants.length !== requestedParticipants.length
    || expectedParticipants.some((ref: string, index: number) => ref !== requestedParticipants[index])
    || tickets.some((ticket) => ticket.submission.wave?.id !== wave.id || ticket.submission.wave?.gate?.state !== 'gate_passed')) {
    return {
      ok: false,
      reason: 'assembled_wave_gate_required',
      tickets,
      message: 'Delivery requires the exact participant set from one passing assembled wave.',
    };
  }
  return { ok: true, tickets, wave, participantRefs };
}

function integrateSubmissionWave(slug?: string, refs?: string | readonly string[], opts?: WaveDeliveryOptions) {
  opts = opts || {};
  const assembled = exactAssembledWave(slug, refs);
  if (!assembled.ok) return assembled;
  const firstTicket = assembled.tickets[0];
  if (!firstTicket) return { ok: false, reason: 'wave_participants_required', message: 'Delivery requires one or more assembled participant refs.' };
  if (assembled.tickets.length === 1) return integrateSubmission(slug, firstTicket.ref, opts);
  if (assembled.tickets.some((ticket) => !submissionUsesGit(ticket))) {
    if (assembled.tickets.some(submissionUsesGit)) {
      return { ok: false, reason: 'wave_project_kind_mismatch', tickets: assembled.tickets, message: 'A wave cannot deliver Git and non-Git candidates through one adapter.' };
    }
    const revision = sourceRevisionMetadata(opts.deliveryRevision);
    if (!revision) {
      return { ok: false, reason: 'wave_delivery_revision_required', tickets: assembled.tickets, message: `Wave ${assembled.wave.id} delivery requires the immutable resulting source revision.` };
    }
    const verification = opts.deliveryVerification;
    if (!verificationAccepted(verification)) {
      return { ok: false, reason: 'wave_delivery_verification_required', tickets: assembled.tickets, message: `Wave ${assembled.wave.id} delivery requires accepted immutable verification evidence for ${revision.source}:${revision.value}.` };
    }
    const delivered = recordSubmissionWaveDelivery(slug, assembled.participantRefs, revision, verification);
    if (!delivered.ok) return delivered;
    const deliveredAt = new Date().toISOString();
    const integrations = assembled.tickets.map((ticket) => updateSubmissionIntegration(slug, ticket.id, {
      mode: 'source-revision',
      outcome: 'verified',
      sourceRevision: revision,
      deliveredAt,
      verifiedAt: deliveredAt,
      deliveredFiles: ticket.submission.changedPaths || [],
      verify: verification,
    }));
    const failedIntegration = integrations.find((integration) => !integration.ok);
    if (failedIntegration) return failedIntegration;
    return {
      ok: true,
      tickets: integrations.map((integration) => integration.ticket),
      wave: delivered.delivery,
      integration: { mode: 'source-revision', sourceRevision: revision, verify: verification, participants: assembled.participantRefs },
    };
  }
  const project = readMeta(slug);
  const repo = project?.path;
  const target = opts.target;
  if (!repo || !target?.branch) return { ok: false, reason: 'integration_target_unavailable', tickets: assembled.tickets };
  let lock: string;
  try {
    lock = deliveryLockPath(repo);
  } catch (error: any) {
    return { ok: false, reason: 'integration_target_unavailable', tickets: assembled.tickets, message: integrationGitError(error) };
  }
  const lockLease = acquireLock(lock, { wait: false });
  if (!lockLease) return deliveryInProgress(assembled.tickets[0]);
  try {
    lockLease.refresh();
    const checkoutState = integrationTargetCheckoutState(repo);
    if (checkoutState.length) {
      return {
        ok: false,
        reason: 'integration_target_dirty',
        tickets: assembled.tickets,
        checkoutState,
        message: integrationTargetDirtyMessage(normalizeDeliveryMode(opts.mode), checkoutState),
      };
    }
    const mode = normalizeDeliveryMode(opts.mode);
    const currentBranch = integrationGit(repo, ['branch', '--show-current']);
    if (currentBranch !== target.branch) {
      return { ok: false, reason: 'branch_not_checked_out', tickets: assembled.tickets, message: `${target.branch} must be checked out before wave delivery; currently on ${currentBranch || 'detached HEAD'}.` };
    }
    const candidates: any[] = [];
    for (const ticket of assembled.tickets) {
      const submission = ticket.submission;
      const gitRef = String(submission.gitRef || submissionGitRef(ticket));
      const pinnedCommit = integrationGit(repo, ['rev-parse', '--verify', `${gitRef}^{commit}`]).toLowerCase();
      if (pinnedCommit !== String(submission.commit).toLowerCase()) {
        return { ok: false, reason: 'pinned_ref_mismatch', ticket, tickets: assembled.tickets, message: `${gitRef} points to ${pinnedCommit}, not submitted ${submission.commit}.` };
      }
      candidates.push({ ticket, submission, gitRef, pinnedCommit, changedPaths: changedIntegrationPaths(repo, submission) });
    }
    const before = integrationGit(repo, ['rev-parse', 'HEAD']);
    try {
      for (const candidate of candidates) {
        if (candidate.submission.noOp) continue;
        if (mode === 'merge') {
          integrationGit(repo, ['merge', '--no-ff', '--no-edit', candidate.pinnedCommit]);
          continue;
        }
        const commits = Array.isArray(candidate.submission.commits) && candidate.submission.commits.length ? candidate.submission.commits : [candidate.submission.commit];
        for (const commit of commits) integrationGit(repo, ['cherry-pick', ...(mode === 'apply' ? ['--no-commit'] : []), commit]);
      }
    } catch (error: any) {
      const conflictedPaths = unmergedIntegrationPaths(repo);
      const message = integrationConflictMessage(error, conflictedPaths);
      try {
        restoreCleanIntegrationCheckout(repo, before);
      } catch (rollbackError: any) {
        return { ok: false, reason: 'wave_delivery_rollback_failed', tickets: assembled.tickets, before, conflictedPaths, message: `${message} Rollback failed: ${integrationGitError(rollbackError)}` };
      }
      return { ok: false, reason: 'wave_delivery_failed', tickets: assembled.tickets, before, conflictedPaths, message };
    }
    const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
    const verification = verifyDeliveredSubmission(slug, assembled.tickets[0], opts);
    if (!verificationAccepted(verification)) {
      try {
        restoreCleanIntegrationCheckout(repo, before);
      } catch (rollbackError: any) {
        return { ok: false, reason: `${verificationOutcome(verification)}_wave_delivery_rollback_failed`, tickets: assembled.tickets, before, verify: verification, message: `Wave ${assembled.wave.id} verification failed and rollback failed: ${integrationGitError(rollbackError)}` };
      }
      return { ok: false, reason: `${verificationOutcome(verification)}_wave_delivery`, tickets: assembled.tickets, before, verify: verification, message: `Wave ${assembled.wave.id} delivery verification returned ${verification.status}.` };
    }
    const delivered = recordSubmissionWaveDelivery(slug, assembled.participantRefs, { source: 'git', value: resultingHead, observedAt: new Date().toISOString() }, verification);
    if (!delivered.ok) return delivered;
    const deliveredAt = new Date().toISOString();
    const integrations = candidates.map((candidate) => updateSubmissionIntegration(slug, candidate.ticket.id, {
      mode,
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      pinnedRef: candidate.gitRef,
      pinnedCommit: candidate.pinnedCommit,
      changedPaths: candidate.changedPaths,
      outcome: 'verified',
      deliveredAt,
      verifiedAt: deliveredAt,
      resultingHead,
      deliveredFiles: candidate.changedPaths,
      dirtyFiles: mode === 'apply' ? candidate.changedPaths : [],
      verify: verification,
    }));
    const failedIntegration = integrations.find((integration) => !integration.ok);
    if (failedIntegration) return failedIntegration;
    return {
      ok: true,
      tickets: integrations.map((integration) => integration.ticket),
      wave: delivered.delivery,
      integration: {
        mode,
        targetBranch: target.branch,
        targetUpstream: target.upstream,
        resultingHead,
        pinnedCommits: candidates.map((candidate) => candidate.pinnedCommit),
        participants: assembled.participantRefs,
        verify: verification,
      },
    };
  } catch (error: any) {
    return { ok: false, reason: 'wave_delivery_error', tickets: assembled.tickets, message: integrationGitError(error) };
  } finally {
    lockLease.refresh();
    releaseLock(lock, lockLease);
  }
}

function integrateSubmissionUnlocked(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const preflight = validateIntegrationSubmission(slug, idOrRef);
  if (!preflight.ok) return preflight;
  let ticket = preflight.ticket;
  const project = readMeta(slug);
  const repo = project?.path;
  const mode = normalizeDeliveryMode(opts.mode);
  const target = opts.target;
  if (!repo || !target || !target.branch) return { ok: false, reason: 'integration_target_unavailable', ticket };
  let checkoutState: string[];
  try {
    checkoutState = integrationTargetCheckoutState(repo);
  } catch (error: any) {
    return { ok: false, reason: 'integration_target_unavailable', ticket, message: integrationGitError(error) };
  }
  if (checkoutState.length) {
    return {
      ok: false,
      reason: 'integration_target_dirty',
      ticket,
      checkoutState,
      message: integrationTargetDirtyMessage(mode, checkoutState),
    };
  }
  const assembled = ensureSingletonAssembledWave(slug, idOrRef, opts);
  if (!assembled.ok) return assembled;
  const admitted = validateIntegrationSubmission(slug, idOrRef, { requireAssembledWave: true });
  if (!admitted.ok) return admitted;
  ticket = admitted.ticket;
  const submission = ticket.submission;
  const gitRef = String(submission.gitRef || submissionGitRef(ticket));
  let pinnedCommit: string;
  let changedPaths: string[];
  let delivered: { commit: string; targetBranch: string; resultingHead: string } | null = null;
  try {
    pinnedCommit = integrationGit(repo, ['rev-parse', '--verify', `${gitRef}^{commit}`]).toLowerCase();
    if (pinnedCommit !== String(submission.commit).toLowerCase()) {
      return { ok: false, reason: 'pinned_ref_mismatch', ticket, message: `${gitRef} points to ${pinnedCommit}, not submitted ${submission.commit}.` };
    }
    changedPaths = changedIntegrationPaths(repo, submission);
  } catch (error: any) {
    return { ok: false, reason: 'pinned_ref_missing', ticket, message: `${gitRef} is unavailable: ${integrationGitError(error)}` };
  }
  const recorded = updateSubmissionIntegration(slug, ticket.id, {
    mode,
    targetBranch: target.branch,
    targetUpstream: target.upstream,
    pinnedRef: gitRef,
    pinnedCommit,
    changedPaths,
    recordedAt: new Date().toISOString(),
    outcome: 'pending',
  });
  if (!recorded.ok) return recorded;
  try {
    const currentBranch = integrationGit(repo, ['branch', '--show-current']);
    if (currentBranch !== target.branch) {
      return integrationFailure(slug, ticket, { reason: 'branch_not_checked_out', message: `${target.branch} must be checked out before integration; currently on ${currentBranch || 'detached HEAD'}.` });
    }
    if ('scopeValidation' in admitted && admitted.scopeValidation?.reconciled) {
      const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
      const verify = verifyDeliveredSubmission(slug, ticket, opts);
      const acceptedVerify = verificationAccepted(verify);
      if (!acceptedVerify) {
        return integrationFailure(slug, ticket, {
          reason: `${verificationOutcome(verify)}_existing_delivery`,
          verify,
          message: `${ticket.ref} is already on ${target.branch}, but verification returned ${verify.status}: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`,
        });
      }
      delivered = { commit: pinnedCommit, targetBranch: target.branch, resultingHead };
      const waveDelivery = recordTicketWaveDelivery(slug, ticket, { source: 'git', value: resultingHead, observedAt: new Date().toISOString() }, verify);
      if (!waveDelivery.ok) return integrationFailure(slug, ticket, { reason: waveDelivery.reason, verify, message: waveDelivery.message });
      const result = updateSubmissionIntegration(slug, ticket.id, {
        outcome: 'delivered',
        deliveredAt: new Date().toISOString(),
        resultingHead,
        verify,
        reconciled: true,
        deliveredFiles: changedPaths,
        ignoredDirtyPaths: [],
      });
      return result.ok ? { ok: true, ticket: result.ticket, integration: result.ticket.submission.integration } : deliveryRecordFailure(ticket, delivered, result);
    }
    const before = integrationGit(repo, ['rev-parse', 'HEAD']);
    const commits = Array.isArray(submission.commits) && submission.commits.length ? submission.commits : [submission.commit];
    if (!submission.noOp && mode === 'merge') {
      try {
        integrationGit(repo, ['merge', '--no-ff', '--no-edit', pinnedCommit]);
      } catch (error: any) {
        const conflictedPaths = unmergedIntegrationPaths(repo);
        const message = integrationConflictMessage(error, conflictedPaths);
        try {
          restoreCleanIntegrationCheckout(repo, before);
        } catch (rollbackError: any) {
          return integrationFailure(slug, ticket, {
            reason: 'merge_failed_rollback_failed',
            conflictedPaths,
            before,
            message: `${message} Rollback failed: ${integrationGitError(rollbackError)}`,
          });
        }
        return integrationFailure(slug, ticket, { reason: 'merge_failed', conflictedPaths, message: `${message} If the conflict is resolved and delivered outside this integration attempt, record that exact delivery with integrate deliveryCommit and reason; it still requires the bound review and a passing merged-tree gate.`, before });
      }
    } else if (!submission.noOp) {
      for (const commit of commits) {
        try {
          integrationGit(repo, ['cherry-pick', ...(mode === 'apply' ? ['--no-commit'] : []), commit]);
        } catch (error: any) {
          const conflictedPaths = unmergedIntegrationPaths(repo);
          const message = integrationConflictMessage(error, conflictedPaths);
          try {
            restoreCleanIntegrationCheckout(repo, before);
          } catch (rollbackError: any) {
            return integrationFailure(slug, ticket, {
              reason: `${mode}_failed_rollback_failed`,
              failedCommit: commit,
              before,
              conflictedPaths,
              message: `${message} Rollback failed: ${integrationGitError(rollbackError)}`,
            });
          }
          return integrationFailure(slug, ticket, {
            reason: `${mode}_failed`,
            failedCommit: commit,
            before,
            conflictedPaths,
            message: `${message} If the conflict is resolved and delivered outside this integration attempt, record that exact delivery with integrate deliveryCommit and reason; it still requires the bound review and a passing merged-tree gate.`,
          });
        }
      }
    }
    const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
    const deliveredFiles = mode === 'apply'
      ? Array.from(new Set([
        ...integrationGit(repo, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean),
        ...integrationGit(repo, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean),
      ]))
      : changedPaths;
    const verify = verifyDeliveredSubmission(slug, ticket, opts);
    const acceptedVerify = verificationAccepted(verify);
    if (!acceptedVerify) return postMergeVerificationFailure(slug, ticket, verify, repo, mode, before, resultingHead, target.branch);
    delivered = { commit: pinnedCommit, targetBranch: target.branch, resultingHead };
    const waveDelivery = recordTicketWaveDelivery(slug, ticket, { source: 'git', value: resultingHead, observedAt: new Date().toISOString() }, verify);
    if (!waveDelivery.ok) return postMergeVerificationFailure(slug, ticket, verify, repo, mode, before, resultingHead, target.branch);
    const result = updateSubmissionIntegration(slug, ticket.id, {
      outcome: 'delivered',
      deliveredAt: new Date().toISOString(),
      resultingHead,
      verify,
      dirtyFiles: mode === 'apply' ? deliveredFiles : [],
      deliveredFiles,
      ignoredDirtyPaths: [],
    });
    return result.ok ? { ok: true, ticket: result.ticket, integration: result.ticket.submission.integration } : deliveryRecordFailure(ticket, delivered, result);
  } catch (error: any) {
    if (delivered) return deliveryRecordFailure(ticket, delivered, error);
    return integrationFailure(slug, ticket, { reason: 'integration_error', message: integrationGitError(error) });
  }
}

function sharedTreeDescendantPaths(slug: any, ticket: any, range: any, admittedScope: string[]) {
  const candidate = Array.isArray(range?.commits) ? range.commits[range.commits.length - 1] : null;
  if (dispatchState(ticket)?.sharedTree !== true || !candidate || !range?.upstreamCommit || !admittedScope.length) {
    return { ok: true, paths: [] };
  }
  let root: string;
  try {
    root = commitScope.repoRoot(String(readMeta(slug)?.path || ''));
  } catch (error: any) {
    return { ok: false, message: error?.message || String(error) };
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidate, range.upstreamCommit], { cwd: root, encoding: 'utf8', windowsHide: true });
  } catch (error: any) {
    if (error?.status === 1) return { ok: true, paths: [] };
    return { ok: false, message: error?.message || String(error) };
  }
  try {
    const paths: string[] = String(execFileSync('git', ['diff', '--name-only', `${candidate}..${range.upstreamCommit}`, '--', ...admittedScope], { cwd: root, encoding: 'utf8', windowsHide: true }))
      .split(/\r?\n/)
      .map((file: string) => file.trim())
      .filter(Boolean);
    return { ok: true, paths: Array.from(new Set(paths)) };
  } catch (error: any) {
    return { ok: false, message: error?.message || String(error) };
  }
}

function submissionVerificationResult(ticket: any, sourceRevision: any, verify: any, candidateCommit?: any) {
  const requirement = pinnedVerificationRequirement(ticket);
  const evidence = String(verify || '').trim();
  if (requirement.kind === 'attestation' || sourceRevision != null) {
    const artifact = sourceRevision ? sourceRevision.value : requirement.artifact;
    const error = attestationErrors(evidence, artifact)[0];
    const result = error
      ? { kind: 'attestation', status: 'failed_check', evidence: error, failureIdentities: ['attestation:evidence-contract'] }
      : { kind: 'attestation', status: 'attestation', evidence };
    return { result, expectedEvidence: null, ...(error ? { diagnostic: { code: 'invalid_verify', message: error, retryable: true } } : {}) };
  }
  if (requirement.kind === 'manual') {
    const error = evidence ? null : 'manual verification requires evidence from the prepared verifier contract';
    const result = error
      ? { kind: 'manual', status: 'failed_check', evidence: error, failureIdentities: ['manual:evidence-required'] }
      : { kind: 'manual', status: 'manual', evidence, command: requirement.command || null };
    return { result, expectedEvidence: null, ...(error ? { diagnostic: { code: 'invalid_verify', message: error, retryable: true } } : {}) };
  }
  if (requirement.kind === 'custom' && requirement.evidenceContract === 'legacy project verifier was not recorded' && evidence) {
    const error = verifyCommandError(evidence);
    if (error) {
      return {
        result: { kind: 'custom', status: 'failed_check', evidence: error, failureIdentities: ['custom:invalid-fallback'] },
        expectedEvidence: null,
        diagnostic: { code: 'invalid_verify', message: error, retryable: true },
      };
    }
    if (manualVerify(evidence)) return { result: { kind: 'custom', status: 'manual', evidence }, expectedEvidence: null };
  }
  if (requirement.command && evidence !== requirement.command) {
    return commandVerificationResult(requirement, evidence, recordedVerificationCaptures(ticket), ticket.ref, {
      source: 'git',
      value: String(candidateCommit || '').trim().toLowerCase(),
    }, String(ticket.dispatchNonce || ''));
  }
  if (requirement.command) {
    const error = verifyCommandError(requirement.command);
    if (error) {
      return {
        result: { kind: requirement.kind, status: 'could_not_run', evidence: error, command: requirement.command, failureIdentities: ['could_not_run:invalid-command'] },
        expectedEvidence: requirement.command,
        diagnostic: { code: 'invalid_verify', message: error, retryable: true },
      };
    }
    return commandVerificationResult(requirement, evidence, recordedVerificationCaptures(ticket), ticket.ref, {
      source: 'git',
      value: String(candidateCommit || '').trim().toLowerCase(),
    }, String(ticket.dispatchNonce || ''));
  }
  if (requirement.kind === 'custom' && requirement.evidenceContract === 'legacy project verifier was not recorded' && !evidence) {
    return { result: { kind: 'custom', status: 'passed', evidence: requirement.evidenceContract }, expectedEvidence: null };
  }
  const error = evidence ? null : `required ${requirement.kind} verification evidence is missing`;
  const result = error
    ? { kind: requirement.kind, status: 'failed_check', evidence: error, failureIdentities: [`${requirement.kind}:evidence-required`] }
    : { kind: requirement.kind, status: 'passed', evidence };
  return { result, expectedEvidence: null, ...(error ? { diagnostic: { code: 'invalid_verify', message: error, retryable: true } } : {}) };
}

function submissionAdmissionDecision(slug: any, ticket: any, by: string, opts: any, sourceRevision: any, pinnedBaseline: any, range: any, verify: any, changedSurfaces: string[]) {
  const adapterFacts = opts.admissionFacts || {};
  const sourceRevisionFacts = sourceRevision && isSourceRevisionAdapterFacts(opts.admissionFacts)
    ? opts.admissionFacts
    : null;
  const sourceRevisionResolution = sourceRevisionFacts?.baseline || null;
  const verification = submissionVerificationResult(ticket, sourceRevision, verify, opts.commit);
  const completion = sourceRevision
    ? { ok: true }
    : completionTreeCheck(slug, ticket, { explicitNoOp: range?.noOp === true });
  const admitted = adapterFacts.admittedScope || executionScope(slug, ticket);
  const scope = adapterFacts.scope || commitScope.ticketCommitScope(admitted, ticket.files, ticket.ref);
  const descendantPaths = sourceRevision ? { ok: true, paths: [] } : sharedTreeDescendantPaths(slug, ticket, range, scope);
  const staleDescendantPaths: string[] = descendantPaths.ok && Array.isArray(descendantPaths.paths) ? descendantPaths.paths : [];
  const submittedSurfaces = sourceRevision ? changedSurfaces : range?.changedPaths || [];
  const inherited = inheritedDirtyPaths(slug, ticket);
  const reportedPaths = submissionUnscopedPaths(opts.unscopedPaths);
  const inheritedPaths = reportedPaths.filter((file: string) => inherited.has(dirtyPathKey(file)));
  const unsubmittedWorkingPaths = sharedTreeUnsubmittedWorkingPaths(ticket, range, reportedPaths, inherited);
  const excludedWorkingPaths = new Set([...inheritedPaths, ...unsubmittedWorkingPaths].map(dirtyPathKey));
  const gatedPaths = reportedPaths.filter((file: string) => !excludedWorkingPaths.has(dirtyPathKey(file)));
  const readiness = submissionReadiness({ unscopedPaths: gatedPaths });
  const rejected = rejectionHistory(ticket);
  const rejectedSource = sourceRevision && rejected.find((entry: any) => sameSourceRevision(entry.sourceRevision, sourceRevision));
  const submittedCommits = range?.commits?.length ? range.commits : [String(opts.commit || '').trim().toLowerCase()];
  const rejectedCommit = !sourceRevision && rejected
    .map((entry: any) => String(entry?.commit || '').trim().toLowerCase())
    .find((candidate: string) => candidate && submittedCommits.some((submittedCommit: string) => candidate === submittedCommit || candidate.startsWith(submittedCommit) || submittedCommit.startsWith(candidate)));
  const duplicate = adapterFacts.duplicate || (rejectedSource
    ? { identity: `${sourceRevision.source}:${sourceRevision.value}`, diagnostic: { code: 'rejected_submission_reused', message: `submit: refused ${ticket.ref}; source revision ${sourceRevision.source}:${sourceRevision.value} was previously rejected. Submit a different immutable revision.`, retryable: false } }
    : rejectedCommit
      ? { identity: rejectedCommit, diagnostic: { code: 'rejected_submission_reused', message: `submit: refused ${ticket.ref}; admitted range contains previously rejected commit ${rejectedCommit}. Create and verify a range without any rejected commit before submitting.`, retryable: false } }
      : { identity: null });
  const decision = decideSubmissionAdmission({
    ticket,
    authority: {
      authority: { actor: by, operation: 'submit' },
      claimOwner: String(ticket.claim?.by || '').trim() || null,
      submittedOwner: String(ticket.submission?.by || '').trim() || null,
      ...(ticket.claim || !ticket.claimRelease ? {} : {
        claimReleaseDiagnostic: {
          code: 'not_claimed',
          message: autoReleasedClaimMessage(ticket.ref, ticket.claimRelease),
          retryable: true,
        },
      }),
      terminal: ticket.status === 'done',
      allowSubmittedOwner: opts.force === true,
    },
    completion: { complete: completion.ok, ...(completion.ok ? {} : { diagnostic: { code: completion.reason, message: completion.message, retryable: true } }) },
    verification,
    candidate: sourceRevision || { source: 'git', value: String(opts.commit || '').trim().toLowerCase(), observedAt: new Date().toISOString() },
    baseline: sourceRevision
      ? {
        candidateExists: sourceRevisionResolution?.candidateExists ?? null,
        containsCandidate: sourceRevisionResolution?.containsCandidate ?? null,
        ...(sourceRevisionFacts ? {
          candidate: sourceRevisionFacts.candidate,
          dispatchBaseline: sourceRevisionFacts.dispatchBaseline,
        } : {}),
      }
      : adapterFacts.baseline || { candidateExists: true, containsCandidate: true },
    sourceBaseline: sourceRevision ? pinnedBaseline : null,
    surfaces: { declared: scope, admitted: scope, changed: submittedSurfaces, pending: adapterFacts.surfaces?.pending || [], ...(adapterFacts.surfaces || {}) },
    duplicate,
    requirements: [
      ...(adapterFacts.requirements || []),
      ...(descendantPaths.ok
        ? staleDescendantPaths.length
          ? [{
            code: 'stale_shared_tree_candidate',
            message: `submit: refused ${ticket.ref}; newer shared-tree commits changed this candidate's admitted paths: ${staleDescendantPaths.join(', ')}. Commit and verify a replacement candidate against the current integration tip before submitting.`,
            retryable: true,
          }]
          : []
        : [{
          code: 'shared_tree_candidate_history_unavailable',
          message: `submit: could not inspect newer shared-tree commits for ${ticket.ref}: ${descendantPaths.message}. Preserve the candidate and retry after Git history is available.`,
          retryable: true,
        }]),
      ...(readiness.ok ? [] : [{ code: readiness.reason, message: `submit: refused ${ticket.ref}; ${readiness.message} Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`, retryable: true }]),
    ],
  });
  return { decision, verification, admittedScope: admitted, inheritedPaths, unsubmittedWorkingPaths, gatedPaths };
}

// Record verified, committed work as ready for integration and release the
// claim in the same locked step. A held claim establishes ownership. force can
// only let the same submitted candidate owner replace their pending candidate.
function submitTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const submissionComment = opts.submissionComment ? prepareComment(opts.submissionComment) : null;
  if (submissionComment && !submissionComment.ok) throw new Error(`submission comment ${submissionComment.reason}`);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    // Review start freezes the candidate: no amendment, no replacement submit.
    const reviewLock = candidateReviewLocked(slug, t, 'submit');
    if (reviewLock) return reviewLock;
    const retryCheckpoint = t.submissionRetry || null;
    const submissionOptions = hydratedSubmissionOptions(opts, retryCheckpoint);
    const commit = String(submissionOptions.commit || '').trim().toLowerCase();
    const sourceRevision = sourceRevisionMetadata(submissionOptions.sourceRevision);
    if (sourceRevision && commit) {
      throw new Error('submit exactly one of commit or source revision');
    }
    const changedSurfaces = changedSurfacesMetadata(submissionOptions.changedSurfaces);
    const reportedProjectCapabilities = projectCapabilityMetadata(submissionOptions.projectCapabilities);
    const projectCapabilities = sourceRevision
      ? Object.freeze({ ...reportedProjectCapabilities, git: projectUsesGit(slug) })
      : Object.freeze({ ...reportedProjectCapabilities });
    if (!sourceRevision && !SUBMISSION_COMMIT_RE.test(commit)) {
      throw new Error(`invalid commit "${submissionOptions.commit}" — pass the verified commit's hex hash (7-64 chars) or a source revision`);
    }
    if (sourceRevision && !changedSurfaces.length) {
      throw new Error('source revision submissions require changed surfaces');
    }
    if (sourceRevision && projectCapabilities.git) {
      throw new Error('source revision submissions require a project outside Git');
    }
    const gitRef = submissionOptions.gitRef != null && String(submissionOptions.gitRef).trim()
      ? String(submissionOptions.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX)
      : null;
    const verify = submissionOptions.verify != null && String(submissionOptions.verify).trim()
      ? String(submissionOptions.verify).trim().slice(0, EXECUTOR_VERIFY_MAX)
      : null;
    const worktree = submissionOptions.worktree != null && String(submissionOptions.worktree).trim()
      ? String(submissionOptions.worktree).trim().slice(0, SUBMISSION_WORKTREE_MAX)
      : null;
    const range = sourceRevision ? null : submissionRangeMetadata(submissionOptions.range, commit);
    const pinnedBaseline = sourceRevisionBaseline(t);
    const resolvedSourceRevisionFacts = sourceRevision
      ? (isSourceRevisionAdapterFacts(submissionOptions.admissionFacts)
        ? submissionOptions.admissionFacts
        : null)
      : submissionOptions.admissionFacts;
    const admissionOptions = sourceRevision
      ? { ...submissionOptions, admissionFacts: resolvedSourceRevisionFacts }
      : submissionOptions;
    const admission = submissionAdmissionDecision(slug, t, by, admissionOptions, sourceRevision, pinnedBaseline, range, verify, changedSurfaces);
    if (!admission.decision.ok) {
      const [primary] = admission.decision.diagnostics;
      const decisionForeignWorkingPaths = admission.decision.outsideAdmittedSurfaces;
      const retry = admission.decision.retryable
        ? submissionRetryCheckpoint(t, {
          at: new Date().toISOString(),
          by,
          candidate: sourceRevision || { source: 'git', value: commit, observedAt: new Date().toISOString() },
          gitRef,
          worktree,
          verify,
          changedSurfaces: sourceRevision ? changedSurfaces : range?.changedPaths || [],
          range,
          unscopedPaths: submissionOptions.unscopedPaths || [],
          projectCapabilities,
          ...(pinnedBaseline ? { baseline: pinnedBaseline } : {}),
          admissionFacts: sourceRevision ? null : admissionOptions.admissionFacts || null,
          diagnostics: admission.decision.diagnostics,
          foreignWorkingPaths: decisionForeignWorkingPaths,
        })
        : null;
      if (retry) putTicket(slug, t);
      const foreignWorkingPaths = retry?.foreignWorkingPaths || decisionForeignWorkingPaths;
      return {
        ok: false,
        reason: primary.code,
        ticket: t,
        message: primary.message,
        failures: admission.decision.diagnostics,
        retryable: admission.decision.retryable,
        ...(retry ? { retry } : {}),
        ...(foreignWorkingPaths.length ? { outside: foreignWorkingPaths, foreignWorkingPaths } : {}),
      };
    }
    const pendingRejections = rejectionHistory(t).filter((entry: any) => entry.preservationState === 'pending');
    if (pendingRejections.length) {
      const rejectionRoot = String(readMeta(slug)?.path || '').trim();
      for (const pendingRejection of pendingRejections) {
        const recovered = preserveRejectedSubmission(slug, t, pendingRejection, rejectionRoot);
        if (!recovered.ok) return recovered;
      }
    }
    const rejectedSubmission = rejectionHistory(t).find((entry: any) => entry && !entry.supersededAt) || null;
    const { admittedScope, verification: submissionVerification, inheritedPaths, unsubmittedWorkingPaths, gatedPaths } = admission;
    const workingPathAdvisory = sharedTreeWorkingPathAdvisory(inheritedPaths, unsubmittedWorkingPaths);
    const submittedAt = new Date().toISOString();
    let comment = null;
    delete t.submissionRetry;
    if (submissionComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(submissionComment, submittedAt);
      t.comments.push(comment);
    }
    t.submission = Object.assign({
      by,
      at: submittedAt,
      ...(sourceRevision ? { sourceRevision, changedPaths: changedSurfaces, projectCapabilities } : { commit, gitRef: gitRef || submissionGitRef(t) }),
      commentId: comment ? comment.id : null,
      verify,
      verificationResult: submissionVerification.result,
      worktree,
      admittedScope,
      ...(pinnedBaseline ? { baseline: pinnedBaseline } : {}),
      unscopedPaths: gatedPaths,
      ...(rejectedSubmission ? { supersedesRejectedSubmission: rejectedSubmission.commit } : {}),
      ...(inheritedPaths.length ? { inheritedPaths } : {}),
      ...(unsubmittedWorkingPaths.length ? { unsubmittedWorkingPaths } : {}),
      integratedAt: null,
    }, range || {});
    if (rejectedSubmission) {
      rejectedSubmission.supersededAt = submittedAt;
      rejectedSubmission.supersededBy = sourceRevision
        ? { sourceRevision }
        : { commit, gitRef: t.submission.gitRef };
    }
    const dispatch = dispatchState(t);
    const lifecycle = t.lifecycleAttempt;
    const workingAttempt = lifecycle?.state === 'claimed' ? transitionAttempt(lifecycle, 'start_work') : lifecycle;
    const verifiedAttempt = workingAttempt?.state === 'working' ? transitionAttempt(workingAttempt, 'verify') : workingAttempt;
    const submittedAttempt = verifiedAttempt?.state === 'verified' ? transitionAttempt(verifiedAttempt, 'submit') : verifiedAttempt;
    const lifecycleDiagnostic = submittedAttempt ? attemptDiagnostic(submittedAttempt) : null;
    if (lifecycleDiagnostic) return { ok: false, reason: lifecycleDiagnostic.code, ticket: t, message: lifecycleDiagnostic.message };
    if (submittedAttempt) recordLifecycleAttempt(t, submittedAttempt);
    const previousStatus = t.status;
    t.claim = null;
    setDispatchTerminal(t, 'submitted', opts.source || 'cli', { failureShape: 'unknown' });
    t.dispatchNonce = null;
    t.dispatchExecutor = null;
    t.status = 'doing'; // ready-for-integration parks in doing, never done
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: submittedAt };
    if (dispatch) stampDispatchEvent(t, opts.source || 'cli', submittedAt);
    else {
      t.lastEventType = 'status';
      t.lastEventSource = opts.source ? String(opts.source) : 'cli';
      t.updatedAt = new Date().toISOString();
    }
    putTicket(slug, t);
    if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    if (comment) queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    const advisories = [(submissionComment as any)?.advisory, workingPathAdvisory].filter(Boolean);
    return { ok: true, ticket: t, comment, ...(advisories.length ? { advisory: advisories.join(' ') } : {}) };
  });
}

function workingTreeVerification(ticket: any, candidate: any) {
  const requirement = pinnedVerificationRequirement(ticket);
  if (!requirement.command) {
    return {
      ok: false,
      reason: 'working_tree_verification_capture_required',
      message: `${ticket.ref} working-tree delivery requires a command verifier and a completed verify-capture against the final working-tree state.`,
    };
  }
  const verification = commandVerificationResult(requirement, requirement.command, recordedVerificationCaptures(ticket), ticket.ref, candidate, String(ticket.dispatchNonce || ''));
  if (!verification.diagnostic) return { ok: true, verification: verification.result };
  return { ok: false, reason: verification.diagnostic.code, message: verification.diagnostic.message, verification: verification.result };
}

function normalizedReplacementEvidence(replacements?: any) {
  const entries = Array.isArray(replacements) ? replacements : [];
  const evidence = new Map<string, { path: string; reviewedBy: string; reason: string }>();
  for (const entry of entries) {
    const path = String(entry?.path || '').trim().replace(/\\/g, '/');
    const reviewedBy = String(entry?.reviewedBy || '').trim();
    const reason = String(entry?.reason || '').trim();
    if (!path || !reviewedBy || !reason) {
      throw new Error('each reviewed replacement requires path, reviewedBy, and reason');
    }
    if (evidence.has(path)) throw new Error(`duplicate reviewed replacement for ${path}`);
    evidence.set(path, { path, reviewedBy, reason });
  }
  return evidence;
}

function submissionChangedPaths(repo: string, submission: any) {
  if (Array.isArray(submission?.changedPaths) && submission.changedPaths.length) {
    return submission.changedPaths.map((entry: any) => String(entry).trim().replace(/\\/g, '/')).filter(Boolean);
  }
  return integrationGit(repo, ['diff', '--name-only', submission.base, submission.commit]).split(/\r?\n/).filter(Boolean);
}

function pathsWithDifferentContent(repo: string, sourceCommit: string, deliveredHead: string, paths: string[]) {
  const divergent: string[] = [];
  for (const file of paths) {
    try {
      integrationGit(repo, ['diff', '--quiet', sourceCommit, deliveredHead, '--', file]);
    } catch (error: any) {
      if (error?.status === 1) divergent.push(file);
      else throw error;
    }
  }
  return divergent;
}

function deliveredCommitPaths(repo: string, deliveredCommit: string) {
  const facts = integrationGit(repo, ['rev-list', '--parents', '-n', '1', deliveredCommit]).split(/\s+/).filter(Boolean);
  if (!facts.length || facts[0].toLowerCase() !== deliveredCommit) throw new Error('delivery commit facts are unavailable');
  const firstParent = facts[1];
  const args = firstParent
    ? ['diff', '--name-only', firstParent, deliveredCommit]
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', deliveredCommit];
  return integrationGit(repo, args).split(/\r?\n/).filter(Boolean);
}

function completedRepairDelivery(repo: string, repair: any) {
  const delivery = repair.completion?.delivery;
  const commit = String(delivery?.commit || '').trim();
  const resultingHead = String(delivery?.integrationRevision?.value || '').trim();
  if (!SUBMISSION_COMMIT_RE.test(commit) || !SUBMISSION_COMMIT_RE.test(resultingHead) || !recordedReviewPass(repair)) return null;
  try {
    const deliveredCommit = integrationGit(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).toLowerCase();
    const deliveredHead = integrationGit(repo, ['rev-parse', '--verify', `${resultingHead}^{commit}`]).toLowerCase();
    integrationGit(repo, ['merge-base', '--is-ancestor', deliveredCommit, deliveredHead]);
    return {
      commit: deliveredCommit,
      resultingHead: deliveredHead,
      deliveredAt: repair.completion.at || null,
      deliveredFiles: deliveredCommitPaths(repo, deliveredCommit),
    };
  } catch (_) {
    return null;
  }
}

function integratedRepairTicket(slug: any, source: any, repairRef: any) {
  const repair = getTicket(slug, repairRef);
  if (!repair) return { ok: false, reason: 'repair_not_found', message: `No repair ticket ${repairRef}.` };
  if (repair.id === source.id) return { ok: false, reason: 'repair_self_reference', message: `${source.ref} cannot supersede its own submission.` };
  const integration = repair.submission?.integration;
  if (repair.status === 'done' && repair.submission?.integratedAt && integration?.resultingHead && ['delivered', 'verified'].includes(integration.outcome)) {
    return { ok: true, repair, integration };
  }
  const repo = readMeta(slug)?.path;
  const delivery = repo && repair.status === 'done' ? completedRepairDelivery(repo, repair) : null;
  if (delivery) return { ok: true, repair, integration: Object.assign({ outcome: 'delivered' }, delivery) };
  return {
    ok: false,
    reason: 'repair_not_integrated',
    message: `${repair.ref} must be done with a reviewed recorded delivery before it can supersede ${source.ref}. Integrate and close ${repair.ref} first.`,
  };
}

function closeSubmissionAsSuperseded(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  const by = String(opts.by || '').trim();
  const repairRef = String(opts.supersededBy || '').trim();
  const reason = String(opts.reason || '').trim();
  if (!by) return { ok: false, reason: 'identity_required', message: 'Submission supersession requires a control-plane identity.' };
  if (!repairRef) return { ok: false, reason: 'repair_required', message: `${found.ref} needs supersededBy: the later integrated repair ticket ref.` };
  if (!reason) return { ok: false, reason: 'evidence_required', message: `${found.ref} needs a concise evidence record explaining why the repair range replaces this submission.` };
  let replacements: Map<string, { path: string; reviewedBy: string; reason: string }>;
  try {
    replacements = normalizedReplacementEvidence(opts.reviewedReplacements);
  } catch (error: any) {
    return { ok: false, reason: 'invalid_replacements', message: String(error?.message || error) };
  }
  return withTicketLock(slug, found.id, () => {
    const source = getTicket(slug, found.id);
    if (!source) return { ok: false, reason: 'not_found' };
    const existing = source.submission?.supersededBy;
    if (existing && source.status === 'done') {
      if (String(existing.ref || '').toUpperCase() === repairRef.toUpperCase()) return { ok: true, idempotent: true, ticket: source, supersededBy: existing };
      return { ok: false, reason: 'already_superseded', ticket: source, message: `${source.ref} was already superseded by ${existing.ref}.` };
    }
    if (!pendingSubmission(source)) {
      return { ok: false, reason: 'submission_required', ticket: source, message: `${source.ref} has no pending submission to supersede.` };
    }
    // A rejected candidate is the one binding a repair may replace; any other
    // bound candidate is still under review and cannot be superseded away.
    const candidateReview = candidateReviewRelation(slug, source);
    if (candidateReview && reviewRelationOutcome(candidateReview) !== 'rejected') {
      return candidateReviewLocked(slug, source, 'supersede');
    }
    const repaired = integratedRepairTicket(slug, source, repairRef);
    if (!repaired.ok) return Object.assign({ ticket: source }, repaired);
    const repo = readMeta(slug)?.path;
    if (!repo) return { ok: false, reason: 'project_unavailable', ticket: source };
    let changedPaths: string[];
    const contentCommit = String(repaired.integration.contentCommit || repaired.integration.resultingHead || '').trim();
    try {
      integrationGit(repo, ['rev-parse', '--verify', `${source.submission.commit}^{commit}`]);
      integrationGit(repo, ['rev-parse', '--verify', `${contentCommit}^{commit}`]);
      changedPaths = submissionChangedPaths(repo, source.submission);
    } catch (error: any) {
      return {
        ok: false,
        reason: 'lineage_unavailable',
        ticket: source,
        message: `${source.ref} supersession refused because its submitted range or ${repaired.repair.ref}'s delivered head cannot be inspected: ${integrationGitError(error)}`,
      };
    }
    const deliveredFiles = Array.isArray(repaired.integration.deliveredFiles)
      ? repaired.integration.deliveredFiles.map((entry: any) => String(entry).trim().replace(/\\/g, '/')).filter(Boolean)
      : [];
    const delivered = new Set(deliveredFiles);
    const missingPaths = changedPaths.filter((file) => !delivered.has(file));
    const unreviewedMissingPaths = missingPaths.filter((file) => !replacements.has(file));
    if (unreviewedMissingPaths.length) {
      return {
        ok: false,
        reason: 'lineage_paths_missing',
        ticket: source,
        missingPaths: unreviewedMissingPaths,
        message: `${source.ref} supersession refused: ${repaired.repair.ref}'s recorded delivery omits submitted paths without reviewed retirement evidence: ${unreviewedMissingPaths.join(', ')}. Supply reviewedReplacements entries with path, reviewedBy, and reason for every intentionally retired path, or integrate a repair that delivers the full path lineage.`,
      };
    }
    let divergentPaths: string[];
    try {
      divergentPaths = pathsWithDifferentContent(repo, source.submission.commit, contentCommit, changedPaths);
    } catch (error: any) {
      return {
        ok: false,
        reason: 'lineage_unavailable',
        ticket: source,
        message: `${source.ref} supersession refused while comparing delivered content: ${integrationGitError(error)}`,
      };
    }
    const unreviewed = divergentPaths.filter((file) => !replacements.has(file));
    if (unreviewed.length) {
      return {
        ok: false,
        reason: 'lineage_content_diverged',
        ticket: source,
        divergentPaths: unreviewed,
        message: `${source.ref} supersession refused: delivered content differs for ${unreviewed.join(', ')}. Supply reviewedReplacements entries with path, reviewedBy, and reason for every intentional replacement.`,
      };
    }
    const now = new Date().toISOString();
    const reviewedReplacementPaths = new Set(missingPaths.concat(divergentPaths));
    const reviewedReplacements = changedPaths
      .filter((file) => reviewedReplacementPaths.has(file))
      .map((file) => replacements.get(file)!);
    const supersededBy = {
      ref: repaired.repair.ref,
      commit: repaired.repair.submission?.commit || repaired.integration.commit,
      resultingHead: repaired.integration.resultingHead,
      deliveredAt: repaired.integration.deliveredAt || repaired.repair.submission?.integratedAt,
      closedAt: now,
      changedPaths,
      reviewedReplacements,
      reason,
    };
    const commentPreparation = prepareComment({ by, body: reason, kind: 'comment', source: opts.source || 'control-plane-supersession' });
    if (!commentPreparation.ok) throw new Error(`supersession comment ${commentPreparation.reason}`);
    const comment = createComment(commentPreparation, now);
    if (!Array.isArray(source.comments)) source.comments = [];
    source.comments.push(comment);
    source.claim = null;
    source.submission = Object.assign({}, source.submission, {
      integratedAt: now,
      supersededBy,
      integration: Object.assign({}, source.submission.integration || {}, { outcome: 'superseded', supersededAt: now, supersededBy }),
    });
    const previousStatus = source.status;
    source.status = 'done';
    source.statusTransition = { from: previousStatus, to: 'done', at: now };
    source.completion = {
      key: [source.id, now, by, 'done'].join(':'),
      by,
      state: 'done',
      claimAt: null,
      at: now,
      commentId: comment.id,
      authority: 'control-plane',
      purpose: 'submission-supersession',
      supersededBy,
    };
    setDispatchTerminal(source, 'done', opts.source || 'control-plane-supersession', { failureShape: 'superseded_submission' });
    source.dispatchNonce = null;
    source.dispatchExecutor = null;
    stampDispatchEvent(source, opts.source || 'control-plane-supersession', now);
    putTicket(slug, source);
    queueEventNotification(slug, source, source.lastEventType, source.lastEventSource);
    queueEventNotification(slug, source, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: source, supersededBy, comment };
  });
}

function submissionOwnershipFailure(ticket: any, by: string, opts?: any) {
  opts = opts || {};
  if (ticket.status === 'done') return { ok: false, reason: 'done', ticket };
  const held = ticket.claim;
  const claimOwner = String(held?.by || '').trim();
  const submissionOwner = String(ticket.submission?.by || '').trim();
  const owner = claimOwner || submissionOwner;
  if (!owner) {
    return {
      ok: false,
      reason: 'not_claimed',
      ticket,
      ...(ticket.claimRelease ? { claimRelease: ticket.claimRelease, message: autoReleasedClaimMessage(ticket.ref, ticket.claimRelease) } : { message: `${ticket.ref} has no claim to release.` }),
    };
  }
  if (owner !== by) {
    return {
      ok: false,
      reason: 'not_owner',
      ticket,
      ...(held ? { claim: held } : {}),
      ...(!claimOwner ? { message: `${ticket.ref} has no claim to release. Its pending submission belongs to "${submissionOwner}".` } : {}),
    };
  }
  if (!claimOwner && opts.allowSubmittedOwner !== true) {
    return {
      ok: false,
      reason: 'not_claimed',
      ticket,
      ...(ticket.claimRelease ? { claimRelease: ticket.claimRelease, message: autoReleasedClaimMessage(ticket.ref, ticket.claimRelease) } : { message: `${ticket.ref} has no claim to release.` }),
    };
  }
  return null;
}

function recordSubmissionRejection(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const by = String(opts.by || '').trim();
  const review = String(opts.review || '').trim();
  const reason = String(opts.reason || '').trim();
  const commit = String(opts.commit || '').trim().toLowerCase();
  const root = String(opts.root || '').trim();
  if (!by || !review || !reason || !SUBMISSION_COMMIT_RE.test(commit) || !root) {
    throw new Error('rejected submission requires by, review, reason, commit, and worktree root');
  }
  if (review.length > REJECTION_REVIEW_MAX || reason.length > REJECTION_REASON_MAX) {
    throw new Error('rejected submission review evidence or reason exceeds its maximum length');
  }
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    // Ahead of the ownership check on purpose: every caller label — the
    // submitter, a reviewer, a fresh repair identity — gets the same refusal, so
    // no label reads as authority to reject a candidate that is under review.
    const reviewLock = candidateReviewLocked(slug, ticket, 'reject submission');
    if (reviewLock) return reviewLock;
    if (ticket.status === 'done') return { ok: false, reason: 'done', ticket };
    const ownershipFailure = submissionOwnershipFailure(ticket, by, { allowSubmittedOwner: true });
    if (ownershipFailure) return ownershipFailure;
    const history = rejectionHistory(ticket);
    const existing = history.find((entry: any) => entry.validation === true && entry.commit === commit && entry.reason === reason && entry.review === review);
    if (existing) {
      if (existing.preservationState !== 'pending') return { ok: true, ticket, rejected: existing };
      return preservePendingRejection(slug, ticket, existing, root);
    }
    const rejected = {
      commit,
      rejectedAt: new Date().toISOString(),
      rejectedBy: by,
      review,
      reason,
      quarantineRef: rejectionQuarantineRef(ticket, history.length + 1),
      validation: true,
      rejectionKind: 'validation',
      preservationState: 'pending',
      source: opts.source || 'mcp',
    };
    if (!Array.isArray(ticket.rejectedSubmissions)) ticket.rejectedSubmissions = [];
    ticket.rejectedSubmissions.push(rejected);
    ticket.updatedAt = rejected.rejectedAt;
    putTicketTransaction(slug, ticket);
    const preserved = preservePendingRejection(slug, ticket, rejected, root);
    if (!preserved.ok) {
      ticket.rejectedSubmissions = ticket.rejectedSubmissions.filter((entry: any) => entry !== rejected);
      if (!ticket.rejectedSubmissions.length) delete ticket.rejectedSubmissions;
      try { putTicketTransaction(slug, ticket); } catch (_: any) { return preserved; }
      return Object.assign({}, preserved, { ticket });
    }
    queueEventNotification(slug, ticket, 'status', rejected.source);
    return preserved;
  });
}

// reviewRef is accepted for compatibility with callers written against the
// removed privileged route and is deliberately never read: MCP and CLI hand the
// store nothing but caller-supplied JSON, so no argument here can prove an
// external release principal.
function reworkSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const by = String(opts.by || '').trim();
  const review = String(opts.review || '').trim();
  const reason = String(opts.reason || '').trim();
  if (!by) throw new Error('rework requires the reviewer or orchestrator identity in by');
  if (!review) throw new Error('rework: "review" is required.');
  if (!reason) throw new Error('rework requires the review rejection reason');
  if (review.length > REJECTION_REVIEW_MAX || reason.length > REJECTION_REASON_MAX) throw new Error('rework review evidence or reason exceeds its maximum length');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    // Before the retry checkpoint, the rejection history, and preservation, so a
    // bound candidate leaves this call with nothing written on either half.
    const reviewLock = candidateReviewLocked(slug, ticket, 'rework');
    if (reviewLock) return reviewLock;
    const retryCheckpoint = ticket.submissionRetry || null;
    if (!pendingSubmission(ticket) && !retryCheckpoint) {
      return { ok: false, reason: 'submission_required', ticket, message: `${ticket.ref} has no pending submission or retry candidate to reject for rework.` };
    }
    const ownershipFailure = submissionOwnershipFailure(ticket, by, { allowSubmittedOwner: true });
    if (ownershipFailure) return ownershipFailure;
    const history = rejectionHistory(ticket);
    const source = opts.source || 'cli';
    const root = String(readMeta(slug)?.path || '').trim();
    if (retryCheckpoint && !pendingSubmission(ticket)) {
      const candidate = retryCheckpoint.candidate;
      const rejectedCandidate = candidate.source === 'git'
        ? {
          commit: candidate.value,
          gitRef: retryCheckpoint.gitRef,
          worktree: retryCheckpoint.worktree,
          verify: retryCheckpoint.verify,
          changedPaths: retryCheckpoint.changedSurfaces,
          ...(retryCheckpoint.range || {}),
        }
        : {
          sourceRevision: candidate,
          changedPaths: retryCheckpoint.changedSurfaces,
          projectCapabilities: retryCheckpoint.projectCapabilities,
          verify: retryCheckpoint.verify,
        };
      const rejected = Object.assign({}, rejectedCandidate, {
        rejectedAt: new Date().toISOString(),
        rejectedBy: by,
        review,
        reason,
        ...(candidate.source === 'git'
          ? { quarantineRef: rejectionQuarantineRef(ticket, history.length + 1) }
          : {}),
        rejectionKind: 'rework',
        preservationState: 'pending',
        previousStatus: ticket.status,
        source,
      });
      if (!Array.isArray(ticket.rejectedSubmissions)) ticket.rejectedSubmissions = [];
      ticket.rejectedSubmissions.push(rejected);
      ticket.updatedAt = rejected.rejectedAt;
      putTicketTransaction(slug, ticket);
      const preserved = preserveRejectedSubmission(slug, ticket, rejected, root);
      if (!preserved.ok) return preserved;
      delete ticket.submissionRetry;
      putTicketTransaction(slug, ticket);
      queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
      return { ok: true, ticket, rejected };
    }
    const pendingRejection = history.find((entry: any) => entry.rejectionKind === 'rework'
      && entry.preservationState === 'pending'
      && rejectedSubmissionMatches(ticket.submission, entry));
    if (pendingRejection) {
      const recovered = preserveRejectedSubmission(slug, ticket, pendingRejection, root);
      if (recovered.ok) queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
      return recovered;
    }
    const rejected = Object.assign({}, ticket.submission, {
      rejectedAt: new Date().toISOString(),
      rejectedBy: by,
      review,
      reason,
      ...(ticket.submission.sourceRevision
        ? {}
        : { quarantineRef: rejectionQuarantineRef(ticket, history.length + 1) }),
      rejectionKind: 'rework',
      preservationState: 'pending',
      previousStatus: ticket.status,
      source,
    });
    if (!Array.isArray(ticket.rejectedSubmissions)) ticket.rejectedSubmissions = [];
    ticket.rejectedSubmissions.push(rejected);
    ticket.updatedAt = rejected.rejectedAt;
    putTicketTransaction(slug, ticket);
    const preserved = preserveRejectedSubmission(slug, ticket, rejected, root);
    if (!preserved.ok) {
      ticket.rejectedSubmissions = ticket.rejectedSubmissions.filter((entry: any) => entry !== rejected);
      if (!ticket.rejectedSubmissions.length) delete ticket.rejectedSubmissions;
      try { putTicketTransaction(slug, ticket); } catch (_: any) { return preserved; }
      return Object.assign({}, preserved, {
        ticket,
        message: `rework: refused ${ticket.ref}; ${preserved.message || preserved.reason}`,
      });
    }
    queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
    return preserved;
  });
}

function clearSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const by = String(opts.by || '').trim();
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    if (!ticket) return { ok: false, reason: 'not_found' };
    if (!ticket.submission) return { ok: false, reason: 'no_submission', ticket };
    const reviewLock = candidateReviewLocked(slug, ticket, 'clear submission');
    if (reviewLock) return reviewLock;
    const ownershipFailure = submissionOwnershipFailure(ticket, by, { allowSubmittedOwner: true });
    if (ownershipFailure) return ownershipFailure;
    const cleared = ticket.submission;
    const previousStatus = ticket.status;
    const now = new Date().toISOString();
    ticket.submission = null;
    if (opts.status) ticket.status = coerceStatus(opts.status, ticket.status);
    if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: now };
    appendReworkEvent(ticket, 'submission_cleared', {
      at: now,
      source: opts.source || 'cli',
      fromStatus: previousStatus,
      toStatus: ticket.status,
    });
    ticket.lastEventType = 'status';
    ticket.lastEventSource = opts.source ? String(opts.source) : 'cli';
    ticket.updatedAt = now;
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, ticket.lastEventType, ticket.lastEventSource);
    return { ok: true, ticket, cleared };
  });
}

function submissionIncludesCandidate(submission: any, candidate: any) {
  const commit = String(candidate?.commit || '').trim().toLowerCase();
  if (!commit) return false;
  return [submission?.commit, ...(Array.isArray(submission?.commits) ? submission.commits : [])]
    .map((entry) => String(entry || '').trim().toLowerCase())
    .includes(commit);
}

function submissionWasRecordedAfter(sibling: any, participant: any) {
  const siblingAt = String(sibling?.submission?.at || '').trim();
  const participantAt = String(participant?.submission?.at || '').trim();
  return Boolean(siblingAt && participantAt) && siblingAt >= participantAt;
}

function waveScopeConflicts(slug: any, tickets: any[]) {
  const participantRefs = new Set(tickets.map((ticket) => ticket.ref));
  const conflicts: any[] = [];
  for (const participant of tickets) {
    const participantChanges = scopedPaths(participant.submission?.changedPaths);
    for (const sibling of listTickets(slug)) {
      if (sibling.archived || sibling.status === 'done' || participantRefs.has(sibling.ref) || !pendingSubmission(sibling)) continue;
      if (!submissionWasRecordedAfter(sibling, participant)) continue;
      if (submissionIncludesCandidate(participant.submission, sibling.submission) || submissionIncludesCandidate(sibling.submission, participant.submission)) continue;
      const siblingDeclaredScope = scopedPaths(sibling.files);
      const surfaces = participantChanges.filter((surface: string) => isInScope(surface, siblingDeclaredScope)
        || siblingDeclaredScope.some((siblingSurface: string) => isInScope(siblingSurface, [surface])));
      if (surfaces.length) conflicts.push({ participant: participant.ref, sibling: sibling.ref, surfaces });
    }
  }
  return conflicts;
}

function omittedPendingSubmissionOverlaps(slug: any, tickets: any[]) {
  if (tickets.length !== 1) return [];
  const [participant] = tickets;
  const participantScope = scopedPaths(participant.files);
  return listTickets(slug)
    .filter((sibling: any) => sibling.ref !== participant.ref && !sibling.archived && sibling.status !== 'done' && pendingSubmission(sibling))
    .map((sibling: any): { ref: string; surfaces: string[] } | null => {
      const surfaces = scopedPaths(sibling.submission?.changedPaths).filter((surface: string) => isInScope(surface, participantScope)
        || participantScope.some((participantSurface: string) => isInScope(participantSurface, [surface])));
      return surfaces.length ? { ref: sibling.ref, surfaces } : null;
    })
    .filter((overlap: { ref: string; surfaces: string[] } | null): overlap is { ref: string; surfaces: string[] } => overlap !== null);
}

function waveVerificationRequirement(tickets: any[]) {
  const requirements = tickets.map(pinnedVerificationRequirement);
  const first = requirements[0];
  if (!first) return { ok: false, reason: 'wave_verification_required', message: 'Wave assembly requires a pinned project verification requirement.' };
  const identity = JSON.stringify({ kind: first.kind, command: first.command || null, evidenceContract: first.evidenceContract, artifact: first.artifact || null });
  if (requirements.some((requirement) => JSON.stringify({ kind: requirement.kind, command: requirement.command || null, evidenceContract: requirement.evidenceContract, artifact: requirement.artifact || null }) !== identity)) {
    return {
      ok: false,
      reason: 'wave_verifier_mismatch',
      message: 'Wave assembly requires one project-defined verification gate. Its participants pin different verifier requirements, so split the wave or refresh and reverify them against the same gate.',
    };
  }
  return { ok: true, requirement: first };
}

function authoritativeWaveVerification(slug: any, tickets: any[], waveId: string, supplied: any, opts?: any) {
  const requirement = waveVerificationRequirement(tickets);
  if (!requirement.ok) return requirement;
  if (opts?.skipVerify === true) return { ok: true, verification: skippedVerification(requirement.requirement, opts.verificationWaiver) };
  if (requirement.requirement.command) {
    const timeoutMilliseconds = normalizeIntegrationVerifyTimeoutMs(boardConfig(slug)?.integrationVerifyTimeoutMs);
    const candidateWorktree = tickets.length === 1 ? String(tickets[0]?.submission?.worktree || '').trim() : '';
    return {
      ok: true,
      verification: runProcessVerification(requirement.requirement, {
        cwd: candidateWorktree || readMeta(slug)?.path,
        timeoutMilliseconds,
        logPath: integrationVerifyLogPath(slug, { ref: waveId }),
        outputTailBytes: INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES,
      }),
    };
  }
  if (!supplied || typeof supplied !== 'object' || String(supplied.kind || '') !== requirement.requirement.kind) {
    return {
      ok: false,
      reason: 'wave_verification_required',
      message: `Wave ${waveId} requires recorded ${requirement.requirement.kind} gate evidence from the project-defined verifier before delivery.`,
    };
  }
  return { ok: true, verification: supplied };
}

function assembledWaveForDelivery(slug: any, ticket: any) {
  const wave = ticket?.submission?.wave;
  if (!wave?.gate || wave.gate.state !== 'gate_passed') {
    return {
      ok: false,
      reason: 'assembled_wave_gate_required',
      message: `${ticket?.ref || 'Submission'} requires a passing assembled-wave gate before delivery. Assemble its submitted candidate and run the project-defined gate first.`,
    };
  }
  const participants = Array.isArray(wave.participants) ? wave.participants : [];
  if (participants.length !== 1 || participants[0] !== ticket.ref) {
    return {
      ok: false,
      reason: 'assembled_wave_delivery_required',
      message: `${ticket.ref} belongs to wave ${wave.id}; delivery must consume that exact assembled participant set rather than integrate one candidate separately.`,
    };
  }
  return { ok: true, wave };
}

function ensureSingletonAssembledWave(slug: any, idOrRef: any, opts?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  if (opts?.skipVerify === true) {
    const waiver = validateVerificationWaiver(opts.verificationWaiver);
    if ('code' in waiver) return { ok: false, reason: waiver.code, message: waiver.message, ticket };
  }
  const existing = ticket.submission?.wave;
  const retryWithWaiver = existing?.gate?.state === 'gate_failed' && opts?.skipVerify === true;
  if (retryWithWaiver) {
    const assembled = assembleSubmissionWave(slug, [ticket.ref], {
      waveId: `delivery-${ticket.ref}-${crypto.randomBytes(6).toString('hex')}`,
      verification: ticket.submission?.verificationResult,
      skipVerify: true,
      verificationWaiver: opts.verificationWaiver,
    });
    if (!assembled.ok) return assembled;
    return assembledWaveForDelivery(slug, getTicket(slug, ticket.id));
  }
  const admitted = assembledWaveForDelivery(slug, ticket);
  if (admitted.ok) return admitted;
  if (existing && existing.state !== 'invalidated') return admitted;
  const assembled = assembleSubmissionWave(slug, [ticket.ref], {
    waveId: `delivery-${ticket.ref}-${crypto.randomBytes(6).toString('hex')}`,
    verification: ticket.submission?.verificationResult,
    skipVerify: opts?.skipVerify === true,
    verificationWaiver: opts?.verificationWaiver,
  });
  if (!assembled.ok) return assembled;
  return assembledWaveForDelivery(slug, getTicket(slug, ticket.id));
}

function recordTicketWaveDelivery(slug: any, ticket: any, revision: any, verification: any) {
  const delivery = recordSubmissionWaveDelivery(slug, [ticket.ref], revision, verification);
  if (!delivery.ok) return delivery;
  return { ok: true, delivery: delivery.delivery };
}

function submissionWaveCandidate(ticket: any) {
  const submission = ticket?.submission;
  if (!submission) return null;
  const revision = submission.sourceRevision || (submission.commit
    ? { source: 'git', value: String(submission.commit).trim().toLowerCase(), observedAt: String(submission.at || new Date().toISOString()) }
    : null);
  const baseline = submission.baseline || sourceRevisionBaseline(ticket);
  if (!revision || !baseline || !submission.verificationResult) return null;
  return {
    ref: ticket.ref,
    baseline,
    surfaces: Array.isArray(submission.changedPaths) ? submission.changedPaths : [],
    verification: submission.verificationResult,
  };
}

function currentIntegrationWaveBaseline(slug: any, fallback: any) {
  if (fallback?.revision?.source !== 'git') return fallback;
  const projectPath = String(readMeta(slug)?.path || '').trim();
  const target = integrationTarget(slug);
  const commit = integrationTargetCommit(projectPath, target);
  return Object.freeze({
    revision: Object.freeze({ source: 'git', value: commit, observedAt: new Date().toISOString() }),
    purpose: 'wave' as const,
  });
}

function candidateBaselineIsCurrentOrAncestor(slug: any, candidate: any, waveBaseline: any) {
  const candidateRevision = candidate?.baseline?.revision;
  const waveRevision = waveBaseline?.revision;
  if (!candidateRevision || !waveRevision || candidateRevision.source !== waveRevision.source) return false;
  if (candidateRevision.value === waveRevision.value) return true;
  if (candidateRevision.source !== 'git') return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidateRevision.value, waveRevision.value], {
      cwd: String(readMeta(slug)?.path || '').trim(),
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    });
    return true;
  } catch (_: any) {
    return false;
  }
}

function waveCandidatesForBaseline(slug: any, candidates: any[], waveBaseline: any) {
  return candidates.map((candidate) => Object.freeze({
    ...candidate,
    baselineCompatible: candidateBaselineIsCurrentOrAncestor(slug, candidate, waveBaseline),
  }));
}

function assembleSubmissionWave(slug?: any, refs?: any, opts?: any) {
  const participantRefs = Array.from(new Set((Array.isArray(refs) ? refs : [refs]).map((ref) => String(ref || '').trim()).filter(Boolean)));
  if (!participantRefs.length) return { ok: false, reason: 'wave_participants_required', message: 'Wave assembly requires one or more submitted participant refs.' };
  const tickets = participantRefs.map((ref) => getTicket(slug, ref));
  if (tickets.some((ticket) => !ticket)) return { ok: false, reason: 'not_found' };
  if (tickets.some((ticket) => !pendingSubmission(ticket))) {
    return { ok: false, reason: 'submitted_candidates_required', message: 'Wave assembly requires every participant to have a submitted candidate.' };
  }
  const waveId = String(opts?.waveId || `wave-${crypto.randomBytes(8).toString('hex')}`);
  const dependencies = opts?.dependencies && typeof opts.dependencies === 'object' ? opts.dependencies : {};
  const candidates = tickets.map(submissionWaveCandidate);
  if (candidates.some((candidate) => !candidate)) {
    return { ok: false, reason: 'wave_baseline_required', message: 'Every submitted candidate must retain its dispatch baseline, changed surfaces, and verifier evidence before wave assembly.' };
  }
  const waveCandidates = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const scopeConflicts = waveScopeConflicts(slug, tickets);
  if (scopeConflicts.length) {
    return {
      ok: false,
      reason: 'candidate_overlap',
      conflicts: scopeConflicts,
      message: `Wave assembly paused because submitted candidates overlap: ${scopeConflicts.map((conflict) => `${conflict.participant} and ${conflict.sibling} (${conflict.surfaces.join(', ')})`).join('; ')}. These refs each hold a pending candidate, not merely a live declared scope. Assemble the named candidates in one wave so the delivery merge can check their actual content, or resolve one candidate before assembling a singleton.`,
    };
  }
  const firstCandidate = waveCandidates[0];
  if (!firstCandidate) return { ok: false, reason: 'wave_baseline_required', message: 'Wave assembly requires a candidate baseline.' };
  const omittedPendingOverlaps = omittedPendingSubmissionOverlaps(slug, tickets);
  const opened = openWave({
    baseline: currentIntegrationWaveBaseline(slug, firstCandidate.baseline),
    participants: tickets.map((ticket) => ({
      ref: ticket.ref,
      dependencies: Array.isArray(dependencies[ticket.ref]) ? dependencies[ticket.ref] : [],
      declaredSurfaces: executionScope(slug, ticket),
    })),
  });
  if ('code' in opened) return { ok: false, reason: opened.code, message: opened.message };
  const decision = assembleWave(opened, waveCandidatesForBaseline(slug, waveCandidates, opened.baseline));
  if (!decision.ok) {
    return {
      ok: false,
      reason: 'wave_invalidated',
      message: `Wave ${waveId} could not assemble at the current integration target. Submitted candidates remain parked with their existing verification evidence.`,
      invalidated: decision.invalidated,
      wave: { id: waveId, baseline: opened.baseline },
    };
  }
  const verification = authoritativeWaveVerification(slug, tickets, waveId, opts?.verification, opts);
  if (!verification.ok || !('verification' in verification)) return verification;
  const gate = recordAssembledWaveGate(decision.assembly, verification.verification);
  transaction(() => {
    for (const ticket of tickets) {
      const current = getTicket(slug, ticket.id);
      if (!current?.submission) continue;
      current.submission.wave = {
        id: waveId,
        baseline: opened.baseline,
        participants: participantRefs,
        dependencies,
        declaredSurfaces: opened.declaredSurfaces,
        state: gate?.state || 'assembled',
        ...(gate ? { gate: { verification: gate.verification, state: gate.state } } : {}),
      };
      const assembledAttempt = transitionAttempt(current.lifecycleAttempt, 'assemble');
      if (!attemptDiagnostic(assembledAttempt)) recordLifecycleAttempt(current, assembledAttempt);
      current.updatedAt = new Date().toISOString();
      putTicket(slug, current);
      queueEventNotification(slug, current, 'status', 'wave');
    }
  });
  if (gate.state === 'gate_failed') {
    const wave = { id: waveId, baseline: opened.baseline, participants: participantRefs };
    if (gate.verification.status === 'toolchain_missing') {
      const worktreeSetup = String(boardConfig(slug)?.worktreeSetup || '').trim();
      const setupEvidence = worktreeSetup
        ? `Configured worktree setup ${JSON.stringify(worktreeSetup)} should provide that command before the gate runs.`
        : 'No worktree setup is configured to provide the missing command.';
      return {
        ok: false,
        reason: 'assembled_wave_environment_problem',
        message: `Wave ${waveId} gate could not run because its verification environment is incomplete. ${gate.verification.evidence} ${setupEvidence} Provision the gate environment and retry; no candidate was rejected.`,
        wave,
        assembly: decision.assembly,
        gate,
      };
    }
    return {
      ok: false,
      reason: 'assembled_wave_gate_failed',
      message: `Wave ${waveId} gate returned ${gate.verification.status}. Refresh and reverify its candidates before delivery.`,
      wave,
      assembly: decision.assembly,
      gate,
    };
  }
  return {
    ok: true,
    wave: { id: waveId, baseline: opened.baseline, participants: participantRefs },
    assembly: decision.assembly,
    gate,
    ...(omittedPendingOverlaps.length ? { omittedPendingOverlaps } : {}),
  };
}

function recordSubmissionWaveDelivery(slug?: any, refs?: any, revision?: any, verification?: any) {
  const participantRefs = Array.from(new Set((Array.isArray(refs) ? refs : [refs]).map((ref) => String(ref || '').trim()).filter(Boolean)));
  if (!participantRefs.length) return { ok: false, reason: 'wave_participants_required', message: 'Delivery requires the exact assembled participant refs.' };
  const tickets = participantRefs.map((ref) => getTicket(slug, ref));
  if (tickets.some((ticket) => !ticket?.submission?.wave)) {
    return { ok: false, reason: 'assembled_wave_gate_required', message: 'Delivery requires every exact participant to retain a passing assembled-wave gate.' };
  }
  const waveState = tickets[0].submission.wave;
  const expectedParticipants = Array.isArray(waveState.participants) ? waveState.participants.slice().sort() : [];
  if (expectedParticipants.length !== participantRefs.length
    || expectedParticipants.some((ref: string, index: number) => ref !== participantRefs.slice().sort()[index])
    || tickets.some((ticket) => ticket.submission.wave.id !== waveState.id || ticket.submission.wave.gate?.state !== 'gate_passed')) {
    return { ok: false, reason: 'assembled_wave_gate_required', message: 'Delivery requires the exact participant set from one passing assembled wave.' };
  }
  const opened = openWave({
    baseline: waveState.baseline,
    participants: tickets.map((ticket) => ({
      ref: ticket.ref,
      dependencies: Array.isArray(waveState.dependencies?.[ticket.ref]) ? waveState.dependencies[ticket.ref] : [],
      declaredSurfaces: executionScope(slug, ticket),
    })),
  });
  if ('code' in opened) return { ok: false, reason: opened.code, message: opened.message };
  const candidates = tickets.map(submissionWaveCandidate);
  if (candidates.some((candidate) => !candidate)) return { ok: false, reason: 'wave_candidate_required', message: 'Delivery requires the immutable candidates that passed assembly.' };
  const assembly = { wave: opened, candidates, state: 'assembled' as const };
  const delivery = recordWaveDelivery({ assembly, verification: waveState.gate.verification, state: 'gate_passed' }, revision, verification);
  if ('code' in delivery) return { ok: false, reason: delivery.code, message: delivery.message };
  transaction(() => {
    for (const ticket of tickets) {
      const current = getTicket(slug, ticket.id);
      if (!current?.submission?.wave) continue;
      current.submission.wave.delivery = delivery;
      current.submission.wave.state = delivery.state;
      current.updatedAt = new Date().toISOString();
      putTicket(slug, current);
      queueEventNotification(slug, current, 'status', 'wave');
    }
  });
  return { ok: delivery.state === 'delivered', delivery };
}

// The integration queue: every ticket parked ready-for-integration, oldest
// submission first — the order the publish transaction integrates them in.
function submissionsPayload(slug?: any) {
  const tickets = listTickets(slug)
    .filter((t?: any) => !t.archived && t.status !== 'done' && pendingSubmission(t))
    .sort((a?: any, b?: any) => String(a.submission.at).localeCompare(String(b.submission.at)))
    .map((t?: any) => ({
      ref: t.ref,
      title: t.title,
      status: t.status,
      files: Array.isArray(t.files) ? t.files : [],
      executorVerify: t.executorVerify || null,
      submission: submissionProjection(t.submission),
    }));
  return { tickets, count: tickets.length, delivery: boardConfig(slug)?.delivery || 'merge' };
}


  return { DEFAULT_CHECKPOINT_TTL_MIN, MAX_CHECKPOINT_TTL_MIN, checkpointTtlMs, checkpointProjection, oracleProjection, checkpointTicket, submissionReadiness, submissionProjection, pendingSubmission, submissionUsesGit, workingTreeVerification, verifyIntegration, validateIntegrationSubmission, recordDeliveredSubmission, recordAbandonedSubmission, integrateSubmission, integrateSubmissionWave, closeSubmissionAsSuperseded, submissionOwnershipFailure, submitTicket, recordVerificationCapture, recordSubmissionRejection, reconcileSubmissionRejections, reworkSubmission, clearSubmission, assembleSubmissionWave, recordSubmissionWaveDelivery, submissionsPayload };
}

module.exports = { createSubmissions };
