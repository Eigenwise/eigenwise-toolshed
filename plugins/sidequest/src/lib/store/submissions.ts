'use strict';

const { resolveSuite } = require('../suite-resolver.js');
const { decideSubmissionAdmission } = require('../kernel/submission');
const { isSourceRevisionAdapterFacts, sourceRevisionBaseline } = require('../source-revision-capability.js');
const { reviewCandidateFromSubmission, reviewRelationFor, reviewRelationRef, reviewRelationOutcome, reviewLockMessage, reviewProvenance } = require('../kernel/review-binding');

function createSubmissions(dependencies: any) {
  const { EXECUTOR_VERIFY_MAX, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES, MANUAL_VERIFY_PREFIX, acquireLock, addComment, appendReworkEvent, artifactWorkingState, autoReleasedClaimMessage, attestationErrors, boardConfig, boundedExcerptForSubmission, claimReclaimable, commitScope, completionTreeCheck, coerceStatus, createComment, crypto, dirtyPathKey, dispatchState, executionScope, ensureDir, execFileSync, fs, getTicket, integrationTarget, listTickets, manualVerify, normalizeDeliveryMode, normalizeIntegrationBranch, normalizeIntegrationVerifyTimeoutMs, nullableText, path, prepareComment, projectDir, putTicket, queueEventNotification, readMeta, recordedReviewPass, recordLifecycleAttempt, releaseLock, setDispatchTerminal, spawnSync, stampDispatchEvent, ticketLockPath, transaction, unregisterClaim, verifyCommandErrors, verifyCommandError, withTicketLock, transitionAttempt, attemptDiagnostic } = dependencies;
  const boundedExcerpt = boundedExcerptForSubmission;

const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;
const DEFAULT_CHECKPOINT_TTL_MIN = 60;
const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
const CHECKPOINT_VERIFY_MAX = 4000;
const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;
const REJECTION_REVIEW_MAX = 1000;
const REJECTION_REASON_MAX = 4000;

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
  if (!oracle) return null;
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
  const dir = path.join(projectDir(slug), 'verification', safeRef);
  ensureDir(dir);
  return path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.log`);
}

function integrationVerifyOutputTail(logPath: string) {
  const size = fs.statSync(logPath).size;
  const length = Math.min(size, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES);
  if (!length) return '';
  const fd = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return `${size > length ? '[output truncated]\n' : ''}${buffer.toString('utf8')}`.trim();
  } finally {
    fs.closeSync(fd);
  }
}

function integrationVerifySummary(logPath: string) {
  const output = fs.readFileSync(logPath, 'utf8');
  const count = (label: string) => {
    const match = new RegExp(`^# ${label}[\\t ]+(\\d+)[\\t ]*\\r?$`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  const duration = /^# duration_ms[\t ]+(\d+(?:\.\d+)?)[\t ]*\r?$/m.exec(output);
  return {
    total: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    skipped: count('skipped'),
    durationMs: duration ? Number(duration[1]) : null,
  };
}

function integrationVerifyCommand(slug: any, ticket: any) {
  const recorded = String(ticket.submission?.verify || '').trim();
  const projectPath = String(readMeta(slug)?.path || '').trim();
  const pluginDirectories = new Set(
    (Array.isArray(ticket.files) ? ticket.files : [])
      .map((file: any) => /^plugins\/([^/]+)(?:\/|$)/.exec(String(file || '').replace(/\\/g, '/'))?.[1])
      .filter(Boolean),
  );
  if (!projectPath || pluginDirectories.size !== 1) return recorded;
  const directoryName = [...pluginDirectories][0];
  const suite = resolveSuite(projectPath, { name: directoryName, dir: `plugins/${directoryName}` });
  return suite ? `cd ${suite.cwd} && ${[suite.setup, suite.command].filter(Boolean).join(' && ')}` : recorded;
}

function verifyDeliveredSubmission(slug: any, ticket: any, opts?: any) {
  const command = integrationVerifyCommand(slug, ticket);
  if (ticket.executorVerifyKind === 'attestation' || isArtifactSubmission(ticket.submission)) {
    return {
      status: 'attestation',
      artifact: ticket.submission?.sourceRevision?.value || ticket.executorAttestationArtifact || null,
      evidence: String(ticket.submission?.verify || '').trim(),
    };
  }
  if (opts?.skipVerify === true) return { status: 'skipped', skippedByChoice: true, command: command || null };
  if (!command) return { status: 'none', command: null };
  const validationError = verifyCommandError(command);
  if (validationError) return { status: 'invalid', command, error: validationError };
  if (manualVerify(command)) return { status: 'manual', command, manual: command.slice(MANUAL_VERIFY_PREFIX.length).trim() };
  const timeoutMs = normalizeIntegrationVerifyTimeoutMs(boardConfig(slug)?.integrationVerifyTimeoutMs);
  const logPath = integrationVerifyLogPath(slug, ticket);
  const fd = fs.openSync(logPath, 'w');
  let result: any;
  try {
    result = spawnSync(command, {
      cwd: readMeta(slug)?.path,
      shell: true,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const outputTail = integrationVerifyOutputTail(logPath);
  const timedOut = result?.error?.code === 'ETIMEDOUT';
  if (timedOut) return { status: 'timeout', command, timeoutMs, logPath, outputTail };
  if (result?.status === 0) return { status: 'passed', command, timeoutMs, logPath, summary: integrationVerifySummary(logPath) };
  return {
    status: 'failed',
    command,
    exitCode: typeof result?.status === 'number' ? result.status : null,
    logPath,
    outputTail,
    error: result?.error ? String(result.error.message || result.error) : null,
  };
}

function verificationFailureComment(verify: any) {
  const outcome = verify.status === 'timeout' ? `timed out after ${verify.timeoutMs}ms` : `exited ${verify.exitCode ?? 'without an exit code'}`;
  return [
    `Integration verification ${outcome}.`,
    `Command: ${verify.command}`,
    `Log: ${verify.logPath}`,
    verify.outputTail ? `Output tail:\n${verify.outputTail}` : null,
  ].filter(Boolean).join('\n');
}

function verifyIntegration(slug: any, idOrRef: any, opts?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket || !ticket.submission?.integration || ticket.submission.integration.outcome !== 'delivered') {
    return { ok: false, reason: 'delivery_required', ticket };
  }
  const verify = ticket.submission.integration?.verify || verifyDeliveredSubmission(slug, ticket, opts);
  const accepted = ['passed', 'none', 'skipped', 'manual', 'attestation'].includes(verify.status);
  const stored = updateSubmissionIntegration(slug, ticket.id, { verify, outcome: accepted ? 'verified' : 'verify_failed' });
  if (!stored.ok) return stored;
  if (accepted) return { ok: true, ticket: stored.ticket, verify };
  const comment = addComment(slug, ticket.id, { by: String(opts?.by || 'orchestrator'), source: 'integration', body: verificationFailureComment(verify) });
  return { ok: false, reason: 'verify_failed', ticket: comment.ticket || stored.ticket, verify };
}

function changedIntegrationPaths(repo: string, submission: any) {
  if (Array.isArray(submission.changedPaths) && submission.changedPaths.length) return submission.changedPaths.slice();
  return integrationGit(repo, ['diff', '--name-only', submission.base, submission.commit]).split(/\r?\n/).filter(Boolean);
}

function validateIntegrationSubmission(slug?: any, idOrRef?: any) {
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
  if (ticket.executorVerifyKind !== 'attestation' && !isArtifactSubmission(ticket.submission)) {
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
  const scopeValidation = isArtifactSubmission(ticket.submission)
    ? { ok: true, changedPaths: ticket.submission.changedPaths || [] }
    : commitScope.validateStoredSubmissionRange(project?.path, ticket.submission, ticket.ref, integrationBranch);
  if (!scopeValidation.ok) {
    const outside = Array.isArray(scopeValidation.outside) ? scopeValidation.outside : [];
    const scopeFailure = scopeValidation.message || (scopeValidation.reason === 'missing_scope_snapshot'
      ? `${ticket.ref} submission has no admitted scope snapshot.`
      : `${ticket.ref} integration refused; submitted range changes paths outside its admitted scope: ${outside.join(', ')}.`);
    return {
      ok: false,
      reason: scopeValidation.reason,
      outside,
      ticket,
      scopeValidation,
      message: `${scopeFailure} Preserve this candidate with rework and submit a fresh candidate against the admitted scope, or close it with supersede_submission after an integrated reviewed replacement.`,
    };
  }
  return { ok: true, ticket, scopeValidation };
}

function updateSubmissionIntegration(slug: any, id: any, patch: any) {
  return withTicketLock(slug, id, () => {
    const ticket = getTicket(slug, id);
    if (!ticket || !ticket.submission) return { ok: false, reason: 'submission_required', ticket };
    ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, patch);
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

function postMergeVerificationFailure(slug: any, ticket: any, verify: any, repo: string, mode: string, before: string) {
  const verificationMessage = `${ticket.ref} verification failed after ${mode} delivery: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`;
  try {
    restoreCleanIntegrationCheckout(repo, before);
  } catch (error: any) {
    return integrationFailure(slug, ticket, {
      reason: 'verify_failed_post_merge_rollback_failed',
      before,
      verify,
      message: `${verificationMessage} Rollback failed: ${integrationGitError(error)}`,
    });
  }
  return integrationFailure(slug, ticket, {
    reason: 'verify_failed_post_merge',
    before,
    verify,
    message: verificationMessage,
  });
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

function recordDeliveredSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const admitted = validateIntegrationSubmission(slug, idOrRef);
  if (!admitted.ok) return admitted;
  const ticket = admitted.ticket;
  if (!submissionUsesGit(ticket)) return { ok: false, reason: 'git_delivery_required', ticket, message: `${ticket.ref} has no Git candidate to reconcile.` };
  const reason = String(opts.reason || '').trim();
  const requestedCommit = String(opts.deliveryCommit || '').trim();
  if (!reason) return { ok: false, reason: 'evidence_required', ticket, message: `${ticket.ref} reconciliation requires delivery evidence.` };
  if (!SUBMISSION_COMMIT_RE.test(requestedCommit)) return { ok: false, reason: 'delivery_commit_required', ticket, message: `${ticket.ref} reconciliation requires the delivery commit hash.` };
  if (opts.skipVerify === true) return { ok: false, reason: 'delivery_verify_required', ticket, message: `${ticket.ref} reconciliation requires a passing merged-tree verification; skipVerify is not allowed.` };
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
    try {
      integrationGit(repo, ['merge-base', '--is-ancestor', deliveryCommit, resultingHead]);
    } catch (error: any) {
      if (error?.status === 1) {
        return { ok: false, reason: 'delivery_not_reachable', ticket, message: `${ticket.ref} reconciliation refused: delivery commit ${deliveryCommit} is not reachable from ${target.branch}.` };
      }
      throw error;
    }
    const content = deliveryContainsSubmittedContent(repo, ticket.submission, deliveryCommit);
    if (!content.ok) {
      return { ok: false, reason: 'delivery_content_missing', ticket, missingCommits: content.missing, message: `${ticket.ref} reconciliation refused: ${deliveryCommit} does not preserve the submitted candidate content for ${content.missing.join(', ')}.` };
    }
    const verify = verifyDeliveredSubmission(slug, ticket);
    if (verify.status !== 'passed') {
      return integrationFailure(slug, ticket, {
        reason: 'verify_failed_recorded_delivery',
        verify,
        message: `${ticket.ref} merged-tree verification failed for recorded delivery ${deliveryCommit}: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`,
      });
    }
    const recorded = updateSubmissionIntegration(slug, ticket.id, {
      mode: 'recorded',
      pinnedRef: submissionGitRef(ticket),
      pinnedCommit: ticket.submission.commit,
      deliveryCommit,
      resultingHead,
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      changedPaths: changedIntegrationPaths(repo, ticket.submission),
      deliveredFiles: changedIntegrationPaths(repo, ticket.submission),
      verify,
      evidence: reason,
      contentEvidence: content.evidence,
      outcome: 'verified',
      recordedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });
    return recorded.ok ? { ok: true, ticket: recorded.ticket, integration: recorded.ticket.submission.integration } : recorded;
  } catch (error: any) {
    return { ok: false, reason: 'delivery_evidence_unavailable', ticket, message: `${ticket.ref} reconciliation refused because delivery evidence could not be inspected: ${integrationGitError(error)}` };
  }
}

// A candidate that never reached the integration branch, and no longer merges into it, cannot be
// delivered or integrated: the branch has moved past the tree it was cut from. Grooming still has
// to be able to close the ticket, so the candidate is recorded as abandoned rather than dressed up
// as a delivery. The reachability test is the mirror of recordDeliveredSubmission's, which is what
// makes this safe: abandonment is legal ONLY while the candidate is absent from the integration
// branch, so it can never be used to write off work that actually shipped (SQ-2188).
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
  if (submissionUsesGit(found) && candidate) {
    try {
      const resolved = integrationGit(repo, ['rev-parse', '--verify', `${candidate}^{commit}`]).toLowerCase();
      try {
        integrationGit(repo, ['merge-base', '--is-ancestor', resolved, `refs/heads/${target.branch}`]);
        return {
          ok: false,
          reason: 'candidate_already_landed',
          ticket: found,
          message: `${found.ref} cannot be abandoned: its candidate ${resolved} is reachable from ${target.branch}, so it shipped. Close it as a delivery with that commit as the delivery evidence instead.`,
        };
      } catch (error: any) {
        if (error?.status !== 1) throw error;
      }
      candidateState = 'unreachable';
    } catch (error: any) {
      // A stored candidate whose object no longer resolves is dead by definition, and refusing
      // here would deadlock the exact case this path exists for. Record which of the two it was.
      candidateState = 'unresolvable';
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
  const admitted = validateIntegrationSubmission(slug, idOrRef);
  if (!admitted.ok) return admitted;
  const ticket = admitted.ticket;
  if (!submissionUsesGit(ticket)) return integrateArtifactSubmission(slug, ticket, opts);
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

function integrateSubmissionUnlocked(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const admitted = validateIntegrationSubmission(slug, idOrRef);
  if (!admitted.ok) return admitted;
  const ticket = admitted.ticket;
  const project = readMeta(slug);
  const repo = project?.path;
  const mode = normalizeDeliveryMode(opts.mode);
  const target = opts.target;
  if (!repo || !target || !target.branch) return { ok: false, reason: 'integration_target_unavailable', ticket };
  const submission = ticket.submission;
  const gitRef = String(submission.gitRef || submissionGitRef(ticket));
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
      message: `${mode} refused; integration target has pending checkout state.`,
    };
  }
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
    if (admitted.scopeValidation.reconciled) {
      const resultingHead = integrationGit(repo, ['rev-parse', 'HEAD']);
      const verify = verifyDeliveredSubmission(slug, ticket, opts);
      const acceptedVerify = ['passed', 'none', 'skipped', 'manual'].includes(verify.status);
      if (!acceptedVerify) {
        return integrationFailure(slug, ticket, {
          reason: 'verify_failed_existing_delivery',
          verify,
          message: `${ticket.ref} is already on ${target.branch}, but verification failed: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`,
        });
      }
      delivered = { commit: pinnedCommit, targetBranch: target.branch, resultingHead };
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
    const acceptedVerify = ['passed', 'none', 'skipped', 'manual'].includes(verify.status);
    if (!acceptedVerify) return postMergeVerificationFailure(slug, ticket, verify, repo, mode, before);
    delivered = { commit: pinnedCommit, targetBranch: target.branch, resultingHead };
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

function submissionAdmissionDecision(slug: any, ticket: any, by: string, opts: any, sourceRevision: any, pinnedBaseline: any, range: any, verify: any, changedSurfaces: string[]) {
  const adapterFacts = opts.admissionFacts || {};
  const sourceRevisionFacts = sourceRevision && isSourceRevisionAdapterFacts(opts.admissionFacts)
    ? opts.admissionFacts
    : null;
  const sourceRevisionResolution = sourceRevisionFacts?.baseline || null;
  const attestation = ticket.executorVerifyKind === 'attestation' || sourceRevision != null;
  const verificationError = attestation ? attestationErrors(verify, sourceRevision ? sourceRevision.value : ticket.executorAttestationArtifact)[0] : verifyCommandError(verify);
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
    verification: { result: { kind: attestation ? 'attestation' : 'suite', status: verificationError ? 'unavailable' : 'passed', evidence: String(verify || '') }, expectedEvidence: attestation ? null : String(ticket.executorVerify || '').trim() || null, ...(verificationError ? { diagnostic: { code: 'invalid_verify', message: verificationError, retryable: true } } : {}) },
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
  return { decision, admittedScope: admitted, inheritedPaths, unsubmittedWorkingPaths, gatedPaths };
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
    const pinnedBaseline = sourceRevision ? sourceRevisionBaseline(t) : null;
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
          ...(sourceRevision && pinnedBaseline ? { baseline: pinnedBaseline } : {}),
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
    const { admittedScope, inheritedPaths, unsubmittedWorkingPaths, gatedPaths } = admission;
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
      worktree,
      admittedScope,
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
    try {
      integrationGit(repo, ['rev-parse', '--verify', `${source.submission.commit}^{commit}`]);
      integrationGit(repo, ['rev-parse', '--verify', `${repaired.integration.resultingHead}^{commit}`]);
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
      divergentPaths = pathsWithDifferentContent(repo, source.submission.commit, repaired.integration.resultingHead, changedPaths);
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
      ...(ticket.claimRelease ? { claimRelease: ticket.claimRelease, message: autoReleasedClaimMessage(ticket.ref, ticket.claimRelease) } : {}),
    };
  }
  if (owner !== by) return { ok: false, reason: 'not_owner', ticket, ...(held ? { claim: held } : {}) };
  if (!claimOwner && opts.allowSubmittedOwner !== true) {
    return {
      ok: false,
      reason: 'not_claimed',
      ticket,
      ...(ticket.claimRelease ? { claimRelease: ticket.claimRelease, message: autoReleasedClaimMessage(ticket.ref, ticket.claimRelease) } : {}),
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
  if (!review) throw new Error('rework requires review evidence');
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

function submissionBaseCandidates(slug?: any, idOrRef?: any, opts?: any) {
  const excluded = idOrRef == null ? null : getTicket(slug, idOrRef);
  const integratedOnly = !!(opts && opts.integratedOnly);
  const commits = new Set<string>();
  for (const ticket of listTickets(slug)) {
    if (excluded && ticket.id === excluded.id) continue;
    const submission = ticket.submission;
    const commit = String(submission && submission.commit || '').trim().toLowerCase();
    const rangeCommits = submission && Array.isArray(submission.commits) ? submission.commits : [];
    if (!submission || !SUBMISSION_COMMIT_RE.test(commit) || !SUBMISSION_COMMIT_RE.test(String(submission.base || ''))
      || !rangeCommits.length || String(rangeCommits[rangeCommits.length - 1]).trim().toLowerCase() !== commit) continue;
    if (integratedOnly && !submission.integratedAt) continue;
    commits.add(commit);
  }
  return Array.from(commits);
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


  return { DEFAULT_CHECKPOINT_TTL_MIN, MAX_CHECKPOINT_TTL_MIN, checkpointTtlMs, checkpointProjection, oracleProjection, checkpointTicket, submissionReadiness, submissionProjection, pendingSubmission, submissionUsesGit, verifyIntegration, validateIntegrationSubmission, recordDeliveredSubmission, recordAbandonedSubmission, integrateSubmission, closeSubmissionAsSuperseded, submissionOwnershipFailure, submitTicket, recordSubmissionRejection, reconcileSubmissionRejections, reworkSubmission, clearSubmission, submissionBaseCandidates, submissionsPayload };
}

module.exports = { createSubmissions };
