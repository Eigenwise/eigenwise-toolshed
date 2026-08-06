"use strict";
const { resolveSuite } = require("../suite-resolver.js");
function createSubmissions(dependencies) {
  const { EXECUTOR_VERIFY_MAX, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES, MANUAL_VERIFY_PREFIX, addComment, appendReworkEvent, artifactWorkingState, autoReleasedClaimMessage, boardConfig, boundedExcerptForSubmission, claimReclaimable, commitScope, completionTreeCheck, coerceStatus, createComment, crypto, dirtyPathKey, dispatchState, effectiveScope, ensureDir, execFileSync, fs, getTicket, listTickets, manualVerify, normalizeDeliveryMode, normalizeIntegrationBranch, normalizeIntegrationVerifyTimeoutMs, nullableText, path, prepareComment, projectDir, putTicket, queueEventNotification, readMeta, setDispatchTerminal, spawnSync, stampDispatchEvent, ticketLockPath, unregisterClaim, verifyCommandError, withTicketLock } = dependencies;
  const boundedExcerpt = boundedExcerptForSubmission;
  const SUBMISSION_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
  const SUBMISSION_GITREF_MAX = 200;
  const SUBMISSION_WORKTREE_MAX = 500;
  const DEFAULT_CHECKPOINT_TTL_MIN = 60;
  const MAX_CHECKPOINT_TTL_MIN = 24 * 60;
  const CHECKPOINT_VERIFY_MAX = 4e3;
  const CHECKPOINT_VERIFY_EXCERPT_MAX = 500;
  function checkpointTtlMs(ttlMinutes) {
    const minutes = ttlMinutes == null ? DEFAULT_CHECKPOINT_TTL_MIN : Number(ttlMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CHECKPOINT_TTL_MIN) {
      throw new Error(`checkpoint TTL must be an integer from 1 to ${MAX_CHECKPOINT_TTL_MIN} minutes`);
    }
    return minutes * 60 * 1e3;
  }
  function checkpointProjection(ticket, now) {
    const checkpoint = ticket && ticket.checkpoint;
    if (!checkpoint) return null;
    const atMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const expiresMs = Date.parse(checkpoint.expiresAt);
    let state = "expired";
    if (Number.isFinite(expiresMs) && expiresMs > atMs) {
      if (pendingSubmission(ticket)) state = "submitted";
      else if (ticket.status === "done") state = "completed";
      else {
        const claim = ticket.claim;
        if (!claim || !claim.by) state = "recoverable";
        else state = claim.by === checkpoint.by ? "active" : "resumed";
      }
    }
    const verify = boundedExcerpt(String(checkpoint.verify || ""), CHECKPOINT_VERIFY_EXCERPT_MAX);
    return {
      id: checkpoint.id,
      state,
      by: checkpoint.by,
      at: checkpoint.at,
      expiresAt: checkpoint.expiresAt,
      ttlMinutes: checkpoint.ttlMinutes,
      kind: checkpoint.kind || "review",
      commit: checkpoint.commit || null,
      gitRef: checkpoint.gitRef || null,
      failure: checkpoint.failure || null,
      worktree: checkpoint.worktree || null,
      verify: verify.text,
      verifyLength: verify.length,
      verifyTruncated: verify.truncated
    };
  }
  function oracleProjection(ticket) {
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
      `ask: ${ask.replace(/\s+/g, " ")}`
    ].filter(Boolean).join(", ");
    return { round, at, candidate, deliverable, ask, summary };
  }
  function checkpointCommentBody(checkpoint) {
    const candidate = [
      checkpoint.commit ? `commit ${checkpoint.commit}` : null,
      checkpoint.worktree ? `worktree ${checkpoint.worktree}` : null
    ].filter(Boolean).join(", ");
    return `Live review checkpoint ${checkpoint.id}
Candidate: ${candidate}
Verification: ${checkpoint.verify}
Expires: ${checkpoint.expiresAt}`;
  }
  function checkpointTicket(slug, idOrRef, by, opts) {
    opts = opts || {};
    by = String(by || "agent");
    const commit = opts.commit == null || String(opts.commit).trim() === "" ? null : String(opts.commit).trim().toLowerCase();
    if (commit && !SUBMISSION_COMMIT_RE.test(commit)) {
      throw new Error(`invalid commit "${opts.commit}": pass the verified commit's hex hash (7-64 chars)`);
    }
    const worktree = opts.worktree == null || String(opts.worktree).trim() === "" ? null : String(opts.worktree).trim();
    if (worktree && (!path.isAbsolute(worktree) || worktree.length > SUBMISSION_WORKTREE_MAX)) {
      throw new Error(`checkpoint worktree must be an absolute path no longer than ${SUBMISSION_WORKTREE_MAX} characters`);
    }
    if (!commit && !worktree) throw new Error("checkpoint requires a commit hash or absolute worktree path");
    const verify = String(opts.verify || "").trim();
    if (!verify) throw new Error("checkpoint verification evidence is required");
    if (verify.length > CHECKPOINT_VERIFY_MAX) throw new Error(`checkpoint verification evidence exceeds ${CHECKPOINT_VERIFY_MAX} characters`);
    const ttlMs = checkpointTtlMs(opts.ttlMinutes);
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      if (t.status === "done") return { ok: false, reason: "done", ticket: t };
      if (pendingSubmission(t)) return { ok: false, reason: "submitted", ticket: t, submission: t.submission };
      const held = t.claim;
      if (!held || !held.by) return { ok: false, reason: "not_claimed", ticket: t };
      if (held.by !== by) return { ok: false, reason: "not_owner", ticket: t, claim: held };
      const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
      const now = new Date(nowMs).toISOString();
      const checkpoint = {
        id: `cp_${crypto.randomBytes(8).toString("hex")}`,
        by,
        at: now,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        ttlMinutes: ttlMs / 6e4,
        kind: opts.kind === "submission_rejected" ? "submission_rejected" : "review",
        commit,
        gitRef: opts.gitRef == null ? null : String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX),
        failure: opts.failure && typeof opts.failure === "object" ? {
          reason: String(opts.failure.reason || "").trim(),
          message: String(opts.failure.message || "").trim()
        } : null,
        worktree,
        verify
      };
      const body = opts.commentBody == null ? checkpointCommentBody(checkpoint) : String(opts.commentBody);
      const prepared = prepareComment({ by, body, source: opts.source || "cli" });
      if (!prepared.ok) throw new Error(`checkpoint comment ${prepared.reason}`);
      const comment = createComment(prepared, now);
      if (!Array.isArray(t.comments)) t.comments = [];
      t.comments.push(comment);
      t.checkpoint = checkpoint;
      t.claim = Object.assign({}, held, { activeAt: now });
      t.lastEventType = "comment";
      t.lastEventSource = comment.source;
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
      return { ok: true, ticket: t, checkpoint: checkpointProjection(t, nowMs), comment };
    });
  }
  function submissionUnscopedPaths(paths) {
    return Array.from(new Set((Array.isArray(paths) ? paths : []).map((value) => String(value || "").trim().replace(/\\/g, "/")).filter(Boolean)));
  }
  function inheritedDirtyPaths(slug, ticket) {
    const baseline = dispatchState(ticket)?.dirtyBaseline;
    const inherited = /* @__PURE__ */ new Map();
    if (!Array.isArray(baseline) || !baseline.length) return inherited;
    let current;
    try {
      current = artifactWorkingState(slug);
    } catch (_) {
      return inherited;
    }
    const identities = new Map(current.map((entry) => [dirtyPathKey(entry.path), entry.identity]));
    for (const entry of baseline) {
      if (!entry || typeof entry.path !== "string" || typeof entry.identity !== "string") continue;
      const key = dirtyPathKey(entry.path);
      if (identities.get(key) === entry.identity) inherited.set(key, entry.path);
    }
    return inherited;
  }
  function sharedTreeUnsubmittedWorkingPaths(ticket, range, reportedPaths, inherited) {
    if (dispatchState(ticket)?.sharedTree !== true || !range) return [];
    return reportedPaths.filter((file) => !inherited.has(dirtyPathKey(file)));
  }
  function sharedTreeWorkingPathAdvisory(inheritedPaths, unsubmittedWorkingPaths) {
    const attributedPaths = [
      ...inheritedPaths.map((file) => `${file} (present before dispatch)`),
      ...unsubmittedWorkingPaths.map((file) => `${file} (not in submitted range)`)
    ];
    if (!attributedPaths.length) return null;
    return `Shared-tree working paths excluded from this submission: ${attributedPaths.join(", ")}. Commit only your declared scope; never stash or revert foreign paths.`;
  }
  function submissionReadiness(submission) {
    const unscopedPaths = submissionUnscopedPaths(submission?.unscopedPaths);
    if (!unscopedPaths.length) return { ok: true, state: "ready", reason: null, unscopedPaths };
    return {
      ok: false,
      state: "partial",
      reason: "unscoped_paths",
      unscopedPaths,
      message: `PARTIAL: scope-gated paths remain outside this submission: ${unscopedPaths.join(", ")}.`
    };
  }
  function submissionProjection(submission) {
    if (!submission) return null;
    return Object.assign({}, submission, { readiness: submissionReadiness(submission) });
  }
  function submissionRangeMetadata(range, commit) {
    if (!range) return null;
    const base = String(range.base || "").trim().toLowerCase();
    const upstream = String(range.upstream || "").trim();
    const upstreamCommit = String(range.upstreamCommit || "").trim().toLowerCase();
    const commits = Array.isArray(range.commits) ? range.commits.map((value) => String(value).trim().toLowerCase()) : [];
    const changedPaths = Array.isArray(range.changedPaths) ? range.changedPaths.map((value) => String(value).trim().replace(/\\/g, "/")).filter(Boolean) : [];
    const integrationMode = range.integrationMode == null ? null : String(range.integrationMode).trim().toLowerCase();
    const integrationBranch = range.integrationBranch == null ? null : normalizeIntegrationBranch(range.integrationBranch);
    const noOp = range.noOp === true;
    if (!SUBMISSION_COMMIT_RE.test(base) || !upstream || !SUBMISSION_COMMIT_RE.test(upstreamCommit) || !noOp && !commits.length || noOp && commits.length || commits.some((value) => !SUBMISSION_COMMIT_RE.test(value)) || !noOp && commits[commits.length - 1] !== commit || integrationMode != null && !["local", "remote"].includes(integrationMode)) {
      throw new Error("invalid submission range metadata");
    }
    return Object.assign(
      { base, upstream, upstreamCommit, commits, changedPaths },
      noOp ? { noOp: true } : {},
      integrationMode ? { integrationMode } : {},
      integrationBranch ? { integrationBranch } : {}
    );
  }
  function pendingSubmission(t) {
    return !!(t && t.submission && t.submission.commit && !t.submission.integratedAt);
  }
  function submissionGitRef(ticket) {
    return `refs/sidequest/${ticket.ref}`;
  }
  function integrationGit(repo, args) {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  function integrationGitError(error) {
    return String(error?.stderr || error?.message || error || "").trim();
  }
  function integrationVerifyLogPath(slug, ticket) {
    const safeRef = String(ticket.ref || ticket.id || "submission").replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = path.join(projectDir(slug), "verification", safeRef);
    ensureDir(dir);
    return path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`);
  }
  function integrationVerifyOutputTail(logPath) {
    const size = fs.statSync(logPath).size;
    const length = Math.min(size, INTEGRATION_VERIFY_OUTPUT_TAIL_BYTES);
    if (!length) return "";
    const fd = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return `${size > length ? "[output truncated]\n" : ""}${buffer.toString("utf8")}`.trim();
    } finally {
      fs.closeSync(fd);
    }
  }
  function integrationVerifyCommand(slug, ticket) {
    const recorded = String(ticket.submission?.verify || "").trim();
    const projectPath = String(readMeta(slug)?.path || "").trim();
    const pluginDirectories = new Set(
      (Array.isArray(ticket.files) ? ticket.files : []).map((file) => /^plugins\/([^/]+)(?:\/|$)/.exec(String(file || "").replace(/\\/g, "/"))?.[1]).filter(Boolean)
    );
    if (!projectPath || pluginDirectories.size !== 1) return recorded;
    const directoryName = [...pluginDirectories][0];
    const suite = resolveSuite(projectPath, { name: directoryName, dir: `plugins/${directoryName}` });
    return suite ? `cd ${suite.cwd} && ${suite.command}` : recorded;
  }
  function verifyDeliveredSubmission(slug, ticket, opts) {
    const command = integrationVerifyCommand(slug, ticket);
    if (opts?.skipVerify === true) return { status: "skipped", skippedByChoice: true, command: command || null };
    if (!command) return { status: "none", command: null };
    const validationError = verifyCommandError(command);
    if (validationError) return { status: "invalid", command, error: validationError };
    if (manualVerify(command)) return { status: "manual", command, manual: command.slice(MANUAL_VERIFY_PREFIX.length).trim() };
    const timeoutMs = normalizeIntegrationVerifyTimeoutMs(boardConfig(slug)?.integrationVerifyTimeoutMs);
    const logPath = integrationVerifyLogPath(slug, ticket);
    const fd = fs.openSync(logPath, "w");
    let result;
    try {
      result = spawnSync(command, {
        cwd: readMeta(slug)?.path,
        shell: true,
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ["ignore", fd, fd]
      });
    } finally {
      fs.closeSync(fd);
    }
    const outputTail = integrationVerifyOutputTail(logPath);
    const timedOut = result?.error?.code === "ETIMEDOUT";
    if (timedOut) return { status: "timeout", command, timeoutMs, logPath, outputTail };
    if (result?.status === 0) return { status: "passed", command, timeoutMs, logPath, outputTail };
    return {
      status: "failed",
      command,
      exitCode: typeof result?.status === "number" ? result.status : null,
      logPath,
      outputTail,
      error: result?.error ? String(result.error.message || result.error) : null
    };
  }
  function verificationFailureComment(verify) {
    const outcome = verify.status === "timeout" ? `timed out after ${verify.timeoutMs}ms` : `exited ${verify.exitCode ?? "without an exit code"}`;
    return [
      `Integration verification ${outcome}.`,
      `Command: ${verify.command}`,
      `Log: ${verify.logPath}`,
      verify.outputTail ? `Output tail:
${verify.outputTail}` : null
    ].filter(Boolean).join("\n");
  }
  function verifyIntegration(slug, idOrRef, opts) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket || !ticket.submission?.integration || ticket.submission.integration.outcome !== "delivered") {
      return { ok: false, reason: "delivery_required", ticket };
    }
    const verify = ticket.submission.integration?.verify || verifyDeliveredSubmission(slug, ticket, opts);
    const accepted = ["passed", "none", "skipped", "manual"].includes(verify.status);
    const stored = updateSubmissionIntegration(slug, ticket.id, { verify, outcome: accepted ? "verified" : "verify_failed" });
    if (!stored.ok) return stored;
    if (accepted) return { ok: true, ticket: stored.ticket, verify };
    const comment = addComment(slug, ticket.id, { by: String(opts?.by || "orchestrator"), source: "integration", body: verificationFailureComment(verify) });
    return { ok: false, reason: "verify_failed", ticket: comment.ticket || stored.ticket, verify };
  }
  function changedIntegrationPaths(repo, submission) {
    if (Array.isArray(submission.changedPaths) && submission.changedPaths.length) return submission.changedPaths.slice();
    return integrationGit(repo, ["diff", "--name-only", submission.base, submission.commit]).split(/\r?\n/).filter(Boolean);
  }
  function validateIntegrationSubmission(slug, idOrRef, opts) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: "not_found" };
    if (!pendingSubmission(ticket)) {
      return { ok: false, reason: "submission_required", ticket, message: `${ticket.ref} has no submission to integrate.` };
    }
    const readiness = submissionReadiness(ticket.submission);
    if (!readiness.ok) {
      return {
        ok: false,
        reason: readiness.reason,
        ticket,
        submissionReadiness: readiness,
        message: `${ticket.ref} integration refused; ${readiness.message}`
      };
    }
    const project = readMeta(slug);
    const scopeValidation = commitScope.validateStoredSubmissionRange(project?.path, ticket.submission);
    const legacyScopeOverride = opts?.overrideLegacyScope === true && scopeValidation.reason === "missing_scope_snapshot";
    if (!scopeValidation.ok && !legacyScopeOverride) {
      const outside = Array.isArray(scopeValidation.outside) ? scopeValidation.outside : [];
      return {
        ok: false,
        reason: scopeValidation.reason,
        outside,
        ticket,
        scopeValidation,
        message: scopeValidation.reason === "missing_scope_snapshot" ? `${ticket.ref} submission has no admitted scope snapshot. Re-submit it, or pass the explicit legacy scope override with a recorded reason.` : `${ticket.ref} integration refused; submitted range changes paths outside its admitted scope: ${outside.join(", ")}.`
      };
    }
    return { ok: true, ticket, scopeValidation, legacyScopeOverride };
  }
  function updateSubmissionIntegration(slug, id, patch) {
    return withTicketLock(slug, id, () => {
      const ticket = getTicket(slug, id);
      if (!ticket || !ticket.submission) return { ok: false, reason: "submission_required", ticket };
      ticket.submission.integration = Object.assign({}, ticket.submission.integration || {}, patch);
      ticket.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putTicket(slug, ticket);
      queueEventNotification(slug, ticket, "status", "integration");
      return { ok: true, ticket };
    });
  }
  function integrationFailure(slug, ticket, patch) {
    updateSubmissionIntegration(slug, ticket.id, Object.assign({ outcome: "failed", completedAt: (/* @__PURE__ */ new Date()).toISOString() }, patch));
    return Object.assign({ ok: false, ticket: getTicket(slug, ticket.id) }, patch);
  }
  function rollbackPostMergeVerification(repo, mode, before) {
    integrationGit(repo, mode === "apply" ? ["reset", "--merge", before] : ["reset", "--hard", before]);
  }
  function postMergeVerificationFailure(slug, ticket, verify, repo, mode, before) {
    const verificationMessage = `${ticket.ref} verification failed after ${mode} delivery: ${verify.command || `verification ${verify.status}`}. Log: ${verify.logPath || "not created"}.`;
    try {
      rollbackPostMergeVerification(repo, mode, before);
    } catch (error) {
      return integrationFailure(slug, ticket, {
        reason: "verify_failed_post_merge_rollback_failed",
        before,
        verify,
        message: `${verificationMessage} Rollback failed: ${integrationGitError(error)}`
      });
    }
    return integrationFailure(slug, ticket, {
      reason: "verify_failed_post_merge",
      before,
      verify,
      message: verificationMessage
    });
  }
  function integrateSubmission(slug, idOrRef, opts) {
    opts = opts || {};
    const admitted = validateIntegrationSubmission(slug, idOrRef, opts);
    if (!admitted.ok) return admitted;
    const ticket = admitted.ticket;
    const project = readMeta(slug);
    const repo = project?.path;
    const mode = normalizeDeliveryMode(opts.mode);
    const target = opts.target;
    if (!repo || !target || !target.branch) return { ok: false, reason: "integration_target_unavailable", ticket };
    const submission = ticket.submission;
    const gitRef = String(submission.gitRef || submissionGitRef(ticket));
    let pinnedCommit;
    let changedPaths;
    try {
      pinnedCommit = integrationGit(repo, ["rev-parse", "--verify", `${gitRef}^{commit}`]).toLowerCase();
      if (pinnedCommit !== String(submission.commit).toLowerCase()) {
        return { ok: false, reason: "pinned_ref_mismatch", ticket, message: `${gitRef} points to ${pinnedCommit}, not submitted ${submission.commit}.` };
      }
      changedPaths = changedIntegrationPaths(repo, submission);
    } catch (error) {
      return { ok: false, reason: "pinned_ref_missing", ticket, message: `${gitRef} is unavailable: ${integrationGitError(error)}` };
    }
    const recorded = updateSubmissionIntegration(slug, ticket.id, {
      mode,
      targetBranch: target.branch,
      targetUpstream: target.upstream,
      pinnedRef: gitRef,
      pinnedCommit,
      changedPaths,
      recordedAt: (/* @__PURE__ */ new Date()).toISOString(),
      outcome: "pending"
    });
    if (!recorded.ok) return recorded;
    try {
      const currentBranch = integrationGit(repo, ["branch", "--show-current"]);
      if (currentBranch !== target.branch) {
        return integrationFailure(slug, ticket, { reason: "branch_not_checked_out", message: `${target.branch} must be checked out before integration; currently on ${currentBranch || "detached HEAD"}.` });
      }
      const dirty = integrationGit(repo, ["diff", "--name-only"]).split(/\r?\n/).filter(Boolean);
      const staged = integrationGit(repo, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);
      const untracked = integrationGit(repo, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
      const dirtyPaths = Array.from(/* @__PURE__ */ new Set([...dirty, ...staged]));
      if (mode === "apply") {
        const overlap = Array.from(/* @__PURE__ */ new Set([...dirtyPaths, ...untracked])).filter((entry) => changedPaths.includes(entry));
        if (overlap.length) {
          return integrationFailure(slug, ticket, { reason: "dirty_overlap", dirtyPaths: overlap, message: `apply refused; uncommitted changes overlap submitted paths: ${overlap.join(", ")}.` });
        }
      } else if (dirtyPaths.length) {
        return integrationFailure(slug, ticket, { reason: "checkout_dirty", dirtyPaths, message: `${mode} refused; the integration checkout has uncommitted changes: ${dirtyPaths.join(", ")}.` });
      }
      const before = integrationGit(repo, ["rev-parse", "HEAD"]);
      const commits = Array.isArray(submission.commits) && submission.commits.length ? submission.commits : [submission.commit];
      if (!submission.noOp && mode === "merge") {
        try {
          integrationGit(repo, ["merge", "--no-ff", "--no-edit", pinnedCommit]);
        } catch (error) {
          try {
            integrationGit(repo, ["merge", "--abort"]);
          } catch (_) {
          }
          return integrationFailure(slug, ticket, { reason: "merge_failed", message: integrationGitError(error), before });
        }
      } else if (!submission.noOp) {
        for (const commit of commits) {
          try {
            integrationGit(repo, ["cherry-pick", ...mode === "apply" ? ["--no-commit"] : [], commit]);
          } catch (error) {
            try {
              integrationGit(repo, ["cherry-pick", "--abort"]);
            } catch (_) {
            }
            if (mode === "replay") {
              try {
                integrationGit(repo, ["reset", "--hard", before]);
              } catch (_) {
              }
            }
            return integrationFailure(slug, ticket, {
              reason: `${mode}_failed`,
              failedCommit: commit,
              before,
              message: integrationGitError(error)
            });
          }
        }
      }
      const resultingHead = integrationGit(repo, ["rev-parse", "HEAD"]);
      const deliveredFiles = mode === "apply" ? Array.from(/* @__PURE__ */ new Set([
        ...integrationGit(repo, ["diff", "--name-only"]).split(/\r?\n/).filter(Boolean),
        ...integrationGit(repo, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean)
      ])) : changedPaths;
      const verify = verifyDeliveredSubmission(slug, ticket, opts);
      const acceptedVerify = ["passed", "none", "skipped", "manual"].includes(verify.status);
      if (!acceptedVerify) return postMergeVerificationFailure(slug, ticket, verify, repo, mode, before);
      const result = updateSubmissionIntegration(slug, ticket.id, {
        outcome: "delivered",
        deliveredAt: (/* @__PURE__ */ new Date()).toISOString(),
        resultingHead,
        verify,
        dirtyFiles: mode === "apply" ? deliveredFiles : [],
        deliveredFiles
      });
      return result.ok ? { ok: true, ticket: result.ticket, integration: result.ticket.submission.integration } : result;
    } catch (error) {
      return integrationFailure(slug, ticket, { reason: "integration_error", message: integrationGitError(error) });
    }
  }
  function submitTicket(slug, idOrRef, by, opts) {
    opts = opts || {};
    by = String(by || "agent");
    const submissionComment = opts.submissionComment ? prepareComment(opts.submissionComment) : null;
    if (submissionComment && !submissionComment.ok) throw new Error(`submission comment ${submissionComment.reason}`);
    const commit = String(opts.commit || "").trim().toLowerCase();
    if (!SUBMISSION_COMMIT_RE.test(commit)) {
      throw new Error(`invalid commit "${opts.commit}" — pass the verified commit's hex hash (7-64 chars)`);
    }
    const gitRef = opts.gitRef != null && String(opts.gitRef).trim() ? String(opts.gitRef).trim().slice(0, SUBMISSION_GITREF_MAX) : null;
    const verify = opts.verify != null && String(opts.verify).trim() ? String(opts.verify).trim().slice(0, EXECUTOR_VERIFY_MAX) : null;
    const worktree = opts.worktree != null && String(opts.worktree).trim() ? String(opts.worktree).trim().slice(0, SUBMISSION_WORKTREE_MAX) : null;
    const range = submissionRangeMetadata(opts.range, commit);
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      if (t.status === "done") return { ok: false, reason: "done", ticket: t };
      const held = t.claim;
      if (held && held.by && held.by !== by && !claimReclaimable(t) && !opts.force) {
        return { ok: false, reason: "not_owner", ticket: t, claim: held };
      }
      if ((!held || !held.by) && !opts.force) {
        return {
          ok: false,
          reason: "not_claimed",
          ticket: t,
          ...t.claimRelease ? { claimRelease: t.claimRelease, message: autoReleasedClaimMessage(t.ref, t.claimRelease) } : {}
        };
      }
      if (t.scopeRequest) {
        return {
          ok: false,
          reason: "scope_request_pending",
          ticket: t,
          message: `submit: refused ${t.ref}; scope approval remains pending. Approve or deny the request before submitting.`
        };
      }
      const completion = completionTreeCheck(slug, t, { explicitNoOp: range?.noOp === true });
      if (!completion.ok) return Object.assign({ ticket: t }, completion);
      const validationError = verifyCommandError(verify);
      if (validationError) {
        return { ok: false, reason: "invalid_verify", ticket: t, message: validationError };
      }
      const declaredExecutorVerify = String(t.executorVerify || "").trim();
      if (declaredExecutorVerify && verify !== declaredExecutorVerify) {
        return {
          ok: false,
          reason: "executor_verify_mismatch",
          ticket: t,
          message: `submit: refused ${t.ref}; verification must match the declared executor verify command.`
        };
      }
      const admittedScope = effectiveScope(slug, t.files);
      const outsideSubmittedRange = range ? range.changedPaths.filter((file) => !commitScope.isInScope(file, admittedScope)) : [];
      if (outsideSubmittedRange.length) {
        return {
          ok: false,
          reason: "outside_scope",
          outside: outsideSubmittedRange,
          ticket: t,
          message: `submit: refused ${t.ref}; submitted range changes paths outside its declared scope: ${outsideSubmittedRange.join(", ")}. Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`
        };
      }
      const inherited = inheritedDirtyPaths(slug, t);
      const reportedPaths = submissionUnscopedPaths(opts.unscopedPaths);
      const inheritedPaths = reportedPaths.filter((file) => inherited.has(dirtyPathKey(file)));
      const unsubmittedWorkingPaths = sharedTreeUnsubmittedWorkingPaths(t, range, reportedPaths, inherited);
      const excludedWorkingPaths = new Set([...inheritedPaths, ...unsubmittedWorkingPaths].map(dirtyPathKey));
      const gatedPaths = reportedPaths.filter((file) => !excludedWorkingPaths.has(dirtyPathKey(file)));
      const readiness = submissionReadiness({ unscopedPaths: gatedPaths });
      if (!readiness.ok) {
        return {
          ok: false,
          reason: readiness.reason,
          ticket: t,
          submissionReadiness: readiness,
          message: `submit: refused ${t.ref}; ${readiness.message} Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`
        };
      }
      const workingPathAdvisory = sharedTreeWorkingPathAdvisory(inheritedPaths, unsubmittedWorkingPaths);
      const submittedAt = (/* @__PURE__ */ new Date()).toISOString();
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
        ...inheritedPaths.length ? { inheritedPaths } : {},
        ...unsubmittedWorkingPaths.length ? { unsubmittedWorkingPaths } : {},
        integratedAt: null
      }, range || {});
      const dispatch = dispatchState(t);
      const previousStatus = t.status;
      delete t.scopePauseRecovery;
      t.claim = null;
      setDispatchTerminal(t, "submitted", opts.source || "cli", { failureShape: "unknown" });
      t.dispatchNonce = null;
      t.dispatchExecutor = null;
      t.status = "doing";
      if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: submittedAt };
      if (dispatch) stampDispatchEvent(t, opts.source || "cli", submittedAt);
      else {
        t.lastEventType = "status";
        t.lastEventSource = opts.source ? String(opts.source) : "cli";
        t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
      putTicket(slug, t);
      if (opts.sessionId) unregisterClaim(opts.sessionId, slug, t.id);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      if (comment) queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
      const advisories = [submissionComment?.advisory, workingPathAdvisory].filter(Boolean);
      return { ok: true, ticket: t, comment, ...advisories.length ? { advisory: advisories.join(" ") } : {} };
    });
  }
  function clearSubmission(slug, idOrRef, opts) {
    opts = opts || {};
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      if (!t.submission) return { ok: false, reason: "no_submission", ticket: t };
      const cleared = t.submission;
      const previousStatus = t.status;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      t.submission = null;
      if (opts.status) t.status = coerceStatus(opts.status, t.status);
      if (t.status !== previousStatus) t.statusTransition = { from: previousStatus, to: t.status, at: now };
      appendReworkEvent(t, "submission_cleared", {
        at: now,
        source: opts.source || "cli",
        fromStatus: previousStatus,
        toStatus: t.status
      });
      t.lastEventType = "status";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      return { ok: true, ticket: t, cleared };
    });
  }
  function submissionBaseCandidates(slug, idOrRef, opts) {
    const excluded = idOrRef == null ? null : getTicket(slug, idOrRef);
    const integratedOnly = !!(opts && opts.integratedOnly);
    const commits = /* @__PURE__ */ new Set();
    for (const ticket of listTickets(slug)) {
      if (excluded && ticket.id === excluded.id) continue;
      const submission = ticket.submission;
      const commit = String(submission && submission.commit || "").trim().toLowerCase();
      const rangeCommits = submission && Array.isArray(submission.commits) ? submission.commits : [];
      if (!submission || !SUBMISSION_COMMIT_RE.test(commit) || !SUBMISSION_COMMIT_RE.test(String(submission.base || "")) || !rangeCommits.length || String(rangeCommits[rangeCommits.length - 1]).trim().toLowerCase() !== commit) continue;
      if (integratedOnly && !submission.integratedAt) continue;
      commits.add(commit);
    }
    return Array.from(commits);
  }
  function submissionsPayload(slug) {
    const tickets = listTickets(slug).filter((t) => !t.archived && t.status !== "done" && pendingSubmission(t)).sort((a, b) => String(a.submission.at).localeCompare(String(b.submission.at))).map((t) => ({
      ref: t.ref,
      title: t.title,
      status: t.status,
      files: Array.isArray(t.files) ? t.files : [],
      executorVerify: t.executorVerify || null,
      submission: submissionProjection(t.submission)
    }));
    return { tickets, count: tickets.length, delivery: boardConfig(slug)?.delivery || "merge" };
  }
  return { DEFAULT_CHECKPOINT_TTL_MIN, MAX_CHECKPOINT_TTL_MIN, checkpointTtlMs, checkpointProjection, oracleProjection, checkpointTicket, submissionReadiness, submissionProjection, pendingSubmission, verifyIntegration, validateIntegrationSubmission, integrateSubmission, submitTicket, clearSubmission, submissionBaseCandidates, submissionsPayload };
}
module.exports = { createSubmissions };
