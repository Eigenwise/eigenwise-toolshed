'use strict';

const { resolveSuite } = require('../suite-resolver.js');

function createSubmissions(dependencies: any) {
  const { EXECUTOR_VERIFY_MAX, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES, MANUAL_VERIFY_PREFIX, addComment, appendReworkEvent, artifactWorkingState, autoReleasedClaimMessage, attestationErrors, boardConfig, boundedExcerptForSubmission, claimReclaimable, commitScope, completionTreeCheck, coerceStatus, createComment, crypto, dirtyPathKey, dispatchState, executionScope, ensureDir, execFileSync, fs, getTicket, listTickets, manualVerify, normalizeDeliveryMode, normalizeIntegrationBranch, normalizeIntegrationVerifyTimeoutMs, nullableText, path, prepareComment, projectDir, putTicket, queueEventNotification, readMeta, setDispatchTerminal, spawnSync, stampDispatchEvent, ticketLockPath, unregisterClaim, verifyCommandErrors, verifyCommandError, withTicketLock } = dependencies;
  const boundedExcerpt = boundedExcerptForSubmission;

const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
const SUBMISSION_GITREF_MAX = 200;
const SUBMISSION_WORKTREE_MAX = 500;
const DEFAULT_CHECKPOINT_TTL_MIN = 60;
const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
const CHECKPOINT_VERIFY_MAX = 4000;
const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;

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
  return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
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
  return suite ? `cd ${suite.cwd} && ${suite.command}` : recorded;
}

function verifyDeliveredSubmission(slug: any, ticket: any, opts?: any) {
  const command = integrationVerifyCommand(slug, ticket);
  if (ticket.executorVerifyKind === 'attestation') return { status: 'attestation', artifact: ticket.executorAttestationArtifact || null, evidence: String(ticket.submission?.verify || '').trim() };
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

function validateIntegrationSubmission(slug?: any, idOrRef?: any, opts?: any) {
  const ticket = getTicket(slug, idOrRef);
  if (!ticket) return { ok: false, reason: 'not_found' };
  if (!pendingSubmission(ticket)) {
    return { ok: false, reason: 'submission_required', ticket, message: `${ticket.ref} has no submission to integrate.` };
  }
  if (ticket.executorVerifyKind !== 'attestation') {
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
  const scopeValidation = commitScope.validateStoredSubmissionRange(project?.path, ticket.submission, ticket.ref);
  const legacyScopeOverride = opts?.overrideLegacyScope === true && scopeValidation.reason === 'missing_scope_snapshot';
  if (!scopeValidation.ok && !legacyScopeOverride) {
    const outside = Array.isArray(scopeValidation.outside) ? scopeValidation.outside : [];
    return {
      ok: false,
      reason: scopeValidation.reason,
      outside,
      ticket,
      scopeValidation,
      message: scopeValidation.reason === 'missing_scope_snapshot'
        ? `${ticket.ref} submission has no admitted scope snapshot. Re-submit it, or pass the explicit legacy scope override with a recorded reason.`
        : `${ticket.ref} integration refused; submitted range changes paths outside its admitted scope: ${outside.join(', ')}.`,
    };
  }
  return { ok: true, ticket, scopeValidation, legacyScopeOverride };
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

function rollbackPostMergeVerification(repo: string, before: string) {
  integrationGit(repo, ['reset', '--merge', before]);
}

function postMergeVerificationFailure(slug: any, ticket: any, verify: any, repo: string, mode: string, before: string) {
  const verificationMessage = `${ticket.ref} verification failed after ${mode} delivery: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || 'not created'}.`;
  try {
    rollbackPostMergeVerification(repo, before);
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

function integrateSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
  if (!admitted.ok) return admitted;
  const ticket = admitted.ticket;
  const project = readMeta(slug);
  const repo = project?.path;
  const mode = normalizeDeliveryMode(opts.mode);
  const target = opts.target;
  if (!repo || !target || !target.branch) return { ok: false, reason: 'integration_target_unavailable', ticket };
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
    const dirty = integrationGit(repo, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean);
    const staged = integrationGit(repo, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
    const untracked = integrationGit(repo, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
    const dirtyPaths = Array.from(new Set([...dirty, ...staged]));
    const declaredScope = Array.isArray(admitted.scopeValidation.admittedScope)
      ? admitted.scopeValidation.admittedScope
      : Array.isArray(ticket.files) ? ticket.files : [];
    const integrationScope = Array.from(new Set([
      ...declaredScope,
      ...changedPaths,
    ]));
    const workingPaths = Array.from(new Set([...dirtyPaths, ...untracked]));
    const scopedDirtyPaths = workingPaths.filter((entry) => commitScope.isInScope(entry, integrationScope));
    const ignoredDirtyPaths = dirtyPaths.filter((entry) => !commitScope.isInScope(entry, integrationScope));
    if (scopedDirtyPaths.length) {
      return integrationFailure(slug, ticket, {
        reason: 'dirty_scope',
        dirtyPaths: scopedDirtyPaths,
        message: `${mode} refused; uncommitted changes fall inside this ticket's declared scope: ${scopedDirtyPaths.join(', ')}.`,
      });
    }
    const before = integrationGit(repo, ['rev-parse', 'HEAD']);
    const commits = Array.isArray(submission.commits) && submission.commits.length ? submission.commits : [submission.commit];
    if (!submission.noOp && mode === 'merge') {
      try {
        integrationGit(repo, ['merge', '--no-ff', '--no-edit', pinnedCommit]);
      } catch (error: any) {
        const conflictedPaths = unmergedIntegrationPaths(repo);
        const message = integrationConflictMessage(error, conflictedPaths);
        try { integrationGit(repo, ['merge', '--abort']); } catch (_) { /* best effort */ }
        return integrationFailure(slug, ticket, { reason: 'merge_failed', conflictedPaths, message, before });
      }
    } else if (!submission.noOp) {
      for (const commit of commits) {
        try {
          integrationGit(repo, ['cherry-pick', ...(mode === 'apply' ? ['--no-commit'] : []), commit]);
        } catch (error: any) {
          const conflictedPaths = unmergedIntegrationPaths(repo);
          const message = integrationConflictMessage(error, conflictedPaths);
          try { integrationGit(repo, ['cherry-pick', '--abort']); } catch (_) { /* best effort */ }
          let rollbackNote = '';
          if (mode === 'replay') {
            // --merge, never --hard: integration deliberately admits dirty files
            // outside the ticket's scope, so a hard reset here would delete work
            // this ticket was never allowed to touch. --merge refuses instead,
            // and a refusal the caller never hears about is the same bug again.
            try {
              integrationGit(repo, ['reset', '--merge', before]);
            } catch (rollbackError: any) {
              rollbackNote = ` Rollback to ${before} refused: ${integrationGitError(rollbackError)}.`;
            }
          }
          return integrationFailure(slug, ticket, {
            reason: `${mode}_failed`, failedCommit: commit, before, conflictedPaths, message: `${message}${rollbackNote}`,
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
      ignoredDirtyPaths,
    });
    return result.ok ? { ok: true, ticket: result.ticket, integration: result.ticket.submission.integration } : deliveryRecordFailure(ticket, delivered, result);
  } catch (error: any) {
    if (delivered) return deliveryRecordFailure(ticket, delivered, error);
    return integrationFailure(slug, ticket, { reason: 'integration_error', message: integrationGitError(error) });
  }
}

// Record verified, committed work as ready for integration and release the
// claim in the same locked step. Requires the caller to HOLD the claim (the
// submit is the terminal act of a claimed run) unless opts.force — mirroring
// releaseTicket's ownership rules. Status deliberately stays "doing".
function submitTicket(slug?: any, idOrRef?: any, by?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const submissionComment = opts.submissionComment ? prepareComment(opts.submissionComment) : null;
  if (submissionComment && !submissionComment.ok) throw new Error(`submission comment ${submissionComment.reason}`);
  const commit = String(opts.commit || '').trim().toLowerCase();
  if (!SUBMISSION_COMMIT_RE.test(commit)) {
    throw new Error(`invalid commit "${opts.commit}" — pass the verified commit's hex hash (7-64 chars)`);
  }
  const gitRef = opts.gitRef != null && String(opts.gitRef).trim()
    ? String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX)
    : null;
  const verify = opts.verify != null && String(opts.verify).trim()
    ? String(opts.verify).trim().slice(0, EXECUTOR_VERIFY_MAX)
    : null;
  const worktree = opts.worktree != null && String(opts.worktree).trim()
    ? String(opts.worktree).trim().slice(0, SUBMISSION_WORKTREE_MAX)
    : null;
  const range = submissionRangeMetadata(opts.range, commit);
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.status === 'done') return { ok: false, reason: 'done', ticket: t };
    const held = t.claim;
    if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
      return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    }
    if ((!held || !held.by) && !opts.force) {
      return {
        ok: false,
        reason: 'not_claimed',
        ticket: t,
        ...(t.claimRelease ? { claimRelease: t.claimRelease, message: autoReleasedClaimMessage(t.ref, t.claimRelease) } : {}),
      };
    }
    const completion = completionTreeCheck(slug, t, { explicitNoOp: range?.noOp === true });
    if (!completion.ok) return Object.assign({ ticket: t }, completion);
    const attestation = t.executorVerifyKind === 'attestation';
    const validationError = attestation ? attestationErrors(verify, t.executorAttestationArtifact)[0] : verifyCommandError(verify);
    if (validationError) {
      return { ok: false, reason: 'invalid_verify', ticket: t, message: validationError };
    }
    const declaredExecutorVerify = String(t.executorVerify || '').trim();
    if (!attestation && declaredExecutorVerify && verify !== declaredExecutorVerify) {
      return {
        ok: false,
        reason: 'executor_verify_mismatch',
        ticket: t,
        message: `submit: refused ${t.ref}; verification must match the declared executor verify command.`,
      };
    }
    const admittedScope = executionScope(slug, t);
    const submissionScope = commitScope.ticketCommitScope(admittedScope, t.files, t.ref);
    const outsideSubmittedRange = range
      ? range.changedPaths.filter((file: string) => !commitScope.isInScope(file, submissionScope))
      : [];
    if (outsideSubmittedRange.length) {
      return {
        ok: false,
        reason: 'outside_scope',
        outside: outsideSubmittedRange,
        ticket: t,
        message: `submit: refused ${t.ref}; submitted range changes paths outside its declared scope: ${outsideSubmittedRange.join(', ')}. Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`,
      };
    }
    const inherited = inheritedDirtyPaths(slug, t);
    const reportedPaths = submissionUnscopedPaths(opts.unscopedPaths);
    const inheritedPaths = reportedPaths.filter((file: string) => inherited.has(dirtyPathKey(file)));
    const unsubmittedWorkingPaths = sharedTreeUnsubmittedWorkingPaths(t, range, reportedPaths, inherited);
    const excludedWorkingPaths = new Set([...inheritedPaths, ...unsubmittedWorkingPaths].map(dirtyPathKey));
    const gatedPaths = reportedPaths.filter((file: string) => !excludedWorkingPaths.has(dirtyPathKey(file)));
    const readiness = submissionReadiness({ unscopedPaths: gatedPaths });
    if (!readiness.ok) {
      return {
        ok: false,
        reason: readiness.reason,
        ticket: t,
        submissionReadiness: readiness,
        message: `submit: refused ${t.ref}; ${readiness.message} Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`,
      };
    }
    const workingPathAdvisory = sharedTreeWorkingPathAdvisory(inheritedPaths, unsubmittedWorkingPaths);
    const submittedAt = new Date().toISOString();
    let comment = null;
    if (submissionComment) {
      if (!Array.isArray(t.comments)) t.comments = [];
      comment = createComment(submissionComment, submittedAt);
      t.comments.push(comment);
    }
    t.submission = Object.assign({
      by,
      at: submittedAt,
      commit,
      commentId: comment ? comment.id : null,
      gitRef: gitRef || submissionGitRef(t),
      verify,
      worktree,
      admittedScope,
      unscopedPaths: gatedPaths,
      ...(inheritedPaths.length ? { inheritedPaths } : {}),
      ...(unsubmittedWorkingPaths.length ? { unsubmittedWorkingPaths } : {}),
      integratedAt: null,
    }, range || {});
    const dispatch = dispatchState(t);
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

function integratedRepairTicket(slug: any, source: any, repairRef: any) {
  const repair = getTicket(slug, repairRef);
  if (!repair) return { ok: false, reason: 'repair_not_found', message: `No repair ticket ${repairRef}.` };
  if (repair.id === source.id) return { ok: false, reason: 'repair_self_reference', message: `${source.ref} cannot supersede its own submission.` };
  const integration = repair.submission?.integration;
  if (repair.status !== 'done' || !repair.submission?.integratedAt || !integration?.resultingHead || !['delivered', 'verified'].includes(integration.outcome)) {
    return {
      ok: false,
      reason: 'repair_not_integrated',
      message: `${repair.ref} must be done with a recorded integrated delivery before it can supersede ${source.ref}. Integrate and close ${repair.ref} first.`,
    };
  }
  return { ok: true, repair, integration };
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
    if (missingPaths.length) {
      return {
        ok: false,
        reason: 'lineage_paths_missing',
        ticket: source,
        missingPaths,
        message: `${source.ref} supersession refused: ${repaired.repair.ref}'s recorded delivery does not include every submitted path: ${missingPaths.join(', ')}. Keep the submission parked or integrate a repair that delivers the full path lineage.`,
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
    const reviewedReplacements = divergentPaths.map((file) => replacements.get(file)!);
    const supersededBy = {
      ref: repaired.repair.ref,
      commit: repaired.repair.submission.commit,
      resultingHead: repaired.integration.resultingHead,
      deliveredAt: repaired.integration.deliveredAt || repaired.repair.submission.integratedAt,
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

// Orchestrator reset: drop a pending submission so the ticket is claimable
// again (integration bounced and the work must be redone rather than merged).
// opts.status optionally moves it (usually back to todo) at the same time.
function clearSubmission(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!t.submission) return { ok: false, reason: 'no_submission', ticket: t };
    const cleared = t.submission;
    const previousStatus = t.status;
    const now = new Date().toISOString();
    t.submission = null;
    if (opts.status) t.status = coerceStatus(opts.status, t.status);
    if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
    appendReworkEvent(t, 'submission_cleared', {
      at: now,
      source: opts.source || 'cli',
      fromStatus: previousStatus,
      toStatus: t.status,
    });
    t.lastEventType = 'status';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return { ok: true, ticket: t, cleared };
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


  return { DEFAULT_CHECKPOINT_TTL_MIN, MAX_CHECKPOINT_TTL_MIN, checkpointTtlMs, checkpointProjection, oracleProjection, checkpointTicket, submissionReadiness, submissionProjection, pendingSubmission, verifyIntegration, validateIntegrationSubmission, integrateSubmission, closeSubmissionAsSuperseded, submitTicket, clearSubmission, submissionBaseCandidates, submissionsPayload };
}

module.exports = { createSubmissions };
