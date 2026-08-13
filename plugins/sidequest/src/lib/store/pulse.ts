'use strict';

function createPulse(dependencies: any) {
  const {
    boardConfig,
    checkpointProjection,
    claimPulse,
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
  } = dependencies;

  function boundedExcerpt(value?: any, maxChars = 1200) {
    const text = String(value || '');
    if (text.length <= maxChars) return { text, length: text.length, truncated: false };
    const tailLength = Math.min(240, Math.floor(maxChars / 4));
    const marker = `\n[… ${text.length - maxChars} more chars; use full:true …]\n`;
    const headLength = maxChars - tailLength - marker.length;
    return {
      text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
      length: text.length,
      truncated: true,
    };
  }

  const COMMENT_BODY_RETENTION = 10;

  function commentHistory(comments?: any, full = false) {
    const history = Array.isArray(comments) ? comments : [];
    const omittedBodies = full ? 0 : Math.max(0, history.length - COMMENT_BODY_RETENTION);
    if (!omittedBodies) return { comments: history, omittedBodies: 0, notice: null };
    const notice = `${omittedBodies} earlier comment bodies omitted — pass --full to see them.`;
    return {
      comments: history.map((comment: any, index: number) => {
        if (index >= omittedBodies) return comment;
        const { body: _body, ...metadata } = comment;
        return Object.assign(metadata, { bodyOmitted: true });
      }),
      omittedBodies,
      notice,
    };
  }

  function lastCommentPulse(ticket?: any) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    return {
      at: comment.at,
      by: comment.by,
      kind: comment.kind,
      body: String(comment.body || '').slice(0, 100),
    };
  }

  function latestCommentExcerpt(ticket?: any) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    const body = boundedExcerpt(comment.body, 200);
    return {
      by: comment.by,
      kind: comment.kind,
      body: body.text,
      bodyLength: body.length,
      bodyTruncated: body.truncated,
    };
  }

  function gitPulse(projectPath?: any, files?: any) {
    if (!projectPath || !Array.isArray(files) || !files.length) return null;
    try {
      const git = (args?: any) => execFileSync('git', args, {
        cwd: projectPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
      const commit = git(['log', '-1', '--format=%H%x1f%s%x1f%cI', '--', ...files]);
      const [hash, subject, at] = commit ? commit.split('\x1f') : [];
      const changed = git(['status', '--porcelain', '--', ...files]);
      return {
        commit: hash ? { hash, subject, at } : null,
        commitNote: 'Last commit touching this ticket’s declared files; it may differ from repository HEAD.',
        dirty: Boolean(changed),
        dirtyNote: 'Whether this ticket’s declared files have uncommitted changes; it is not repository-wide.',
      };
    } catch (_: any) {
      return null;
    }
  }

  function projectedClaim(ticket?: any, now = Date.now()) {
    const pulse = claimPulse(ticket, now);
    if (!pulse) return null;
    const boardQuietMs = Number.isFinite(pulse.idleMs) ? pulse.idleMs : null;
    const { idleMs: _idleMs, ...claim } = pulse;
    return {
      reclaimable: claim.reclaimable,
      ...claim,
      boardQuietMs,
      boardQuietNote: 'Time since the claim holder last wrote to the board; this is not process liveness.',
      lastBoardActivityAt: boardQuietMs == null ? null : new Date(now - boardQuietMs).toISOString(),
    };
  }

  function dispatchDeath(dispatch?: any) {
    if (!dispatch) return null;
    if (dispatch.outcome === 'died' && dispatch.terminalAt) {
      return { at: dispatch.terminalAt, source: dispatch.terminalSource || null };
    }
    const attempt = (Array.isArray(dispatch.attempts) ? dispatch.attempts : [])
      .slice().reverse().find((entry: any) => entry?.outcome === 'died' && entry.terminalAt);
    return attempt ? { at: attempt.terminalAt, source: attempt.terminalSource || null } : null;
  }

  function livenessPulse(ticket?: any, dispatch?: any, claim?: any, death?: any) {
    if (death) return { state: 'dead', evidence: `died outcome recorded${death.source ? ` by ${death.source}` : ''}` };
    if (claim?.reclaimable) return { state: 'dead', evidence: `claim is reclaimable: ${claim.reclaimable}` };
    if (claim?.verifying) return { state: 'alive', evidence: 'verification marker is active' };
    if (dispatch?.outcome === 'launched' && !dispatch.boundAt && !dispatch.agentId && !claim && !ticket?.checkpoint) {
      return { state: 'stalled', evidence: 'dispatch launched without a bound runtime identity, claim, or checkpoint' };
    }
    if (claim && dispatch && !dispatch.terminalAt && (dispatch.agentId || dispatch.boundAt)) {
      return { state: 'unknown', evidence: 'a runtime identity was bound, but Sidequest has no process heartbeat' };
    }
    if (claim && dispatch && !dispatch.terminalAt) {
      return { state: 'binding_fault', evidence: 'dispatch.boundAt is null, so Sidequest cannot identify the executor process; the claim stays held because no death was observed' };
    }
    if (claim) return { state: 'unknown', evidence: 'claim held without live-process evidence' };
    return { state: 'unknown', evidence: 'no active claim or death record' };
  }

  // Commit enforcement reads the dispatch snapshot, not ticket.files. When the
  // two differ on a live run the executor is gated against a set the ticket
  // does not show, so the drift has to be visible in the pulse where the
  // orchestrator actually looks.
  function scopeDriftWarnings(slug?: any, ticket?: any) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.terminalAt || !Array.isArray(dispatch.declaredFiles)) return [];
    const scopePathKey = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
    const scopePaths = (files?: any) => {
      const paths = new Map<string, string>();
      for (const file of Array.isArray(files) ? files : []) {
        const normalized = String(file || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
        const key = scopePathKey(normalized);
        if (normalized && !paths.has(key)) paths.set(key, normalized);
      }
      return [...paths.values()].sort((left, right) => scopePathKey(left).localeCompare(scopePathKey(right)));
    };
    const alwaysInScope = new Set(scopePaths(boardConfig(slug)?.alwaysInScope).map(scopePathKey));
    const declared = scopePaths(dispatch.declaredFiles).filter((file) => !alwaysInScope.has(scopePathKey(file)));
    const ticketFiles = scopePaths(commitScope.ticketCommitScope(effectiveScope(slug, ticket?.files), ticket?.files, ticket?.ref)).filter((file) => !alwaysInScope.has(scopePathKey(file)));
    if (declared.length === ticketFiles.length && declared.every((file, index) => {
      const ticketFile = ticketFiles[index];
      return ticketFile != null && scopePathKey(file) === scopePathKey(ticketFile);
    })) return [];
    return [`Scope drift: this live dispatch enforces ${declared.join(', ') || '(none)'} but the ticket declares ${ticketFiles.join(', ') || '(none)'}. Commits are gated on the dispatch set; re-run update --files to resync.`];
  }

  // Whether a scope approval actually landed is the question pulse gets asked after
  // every ruling, and without this an orchestrator has to shell out to the CLI and
  // filter JSON to answer it (Terge_VST, 2026-08-05). `enforced` is what commits are
  // gated on; it differs from `declared` exactly when scopeDriftWarnings fires.
  function scopePulse(slug?: any, ticket?: any) {
    const dispatch = dispatchState(ticket);
    const resolution = ticket?.scopeResolution;
    return {
      declared: commitScope.ticketCommitScope(effectiveScope(slug, ticket?.files), ticket?.files, ticket?.ref),
      enforced: dispatch && !dispatch.terminalAt && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : null,
      lastRuling: resolution ? { state: resolution.state, at: resolution.at, granted: resolution.granted || [], refused: resolution.refused || [] } : null,
    };
  }

  function pulsePayload(slug?: any, idOrRef?: any) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return null;
    const meta = readMeta(slug);
    const git = gitPulse(meta && meta.path, ticket.files);
    const dispatch = dispatchState(ticket);
    const now = Date.now();
    const claim = projectedClaim(ticket, now);
    const died = dispatchDeath(dispatch);
    const liveness = livenessPulse(ticket, dispatch, claim, died);
    const warnings = [...storyContractDriftWarnings(ticket), ...storyDecisionLogWarnings(ticket, slug), ...scopeDriftWarnings(slug, ticket)];
    return {
      ref: ticket.ref,
      title: ticket.title,
      liveness: liveness.state,
      livenessEvidence: liveness.evidence,
      reclaimable: claim?.reclaimable || null,
      died,
      status: ticket.status,
      direct: ticket.directClaim || null,
      claim,
      claimHeld: Boolean(ticket.claim?.by),
      comments: Array.isArray(ticket.comments) ? ticket.comments.length : 0,
      lastComment: lastCommentPulse(ticket),
      dispatchExecutor: ticket.dispatchExecutor || null,
      dispatch: dispatch ? {
        state: pulseDispatchState(dispatch),
        sessionId: dispatch.sessionId || null,
        tokenPrefix: dispatch.tokenPrefix || null,
        executor: dispatch.executor || null,
        route: normalizeRoute(dispatch.route),
        recovery: dispatch.recovery || null,
        attempts: Array.isArray(dispatch.attempts) ? dispatch.attempts : [],
        agentId: dispatch.agentId || null,
        agentName: dispatch.agentName || null,
        preparedAt: dispatch.preparedAt || null,
        launchedAt: dispatch.launchedAt || null,
        boundAt: dispatch.boundAt || null,
        claimedAt: dispatch.claimedAt || null,
        terminalAt: dispatch.terminalAt || null,
        terminalSource: dispatch.terminalSource || null,
        outcome: dispatch.outcome || null,
        failureShape: dispatch.failureShape || null,
      } : null,
      checkpoint: checkpointProjection(ticket),
      scope: scopePulse(slug, ticket),
      ...(oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {}),
      ...(warnings.length ? { warnings } : {}),
      submission: submissionProjection(ticket.submission),
      delivery: boardConfig(slug)?.delivery || 'merge',
      git,
    };
  }

  function changesPayload(slug?: any, since?: any) {
    const serverTime = new Date().toISOString();
    const nowMs = Date.parse(serverTime);
    const defaultSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const after = since == null ? defaultSince : String(since);
    const afterMs = Date.parse(after);
    if (!Number.isFinite(afterMs)) throw new Error('changes: --since must be an ISO timestamp.');
    const changedAt = (ticket?: any) => {
      const updatedMs = Date.parse(ticket.updatedAt);
      const expiresMs = Date.parse(ticket.checkpoint && ticket.checkpoint.expiresAt);
      return Number.isFinite(expiresMs) && expiresMs <= nowMs ? Math.max(updatedMs, expiresMs) : updatedMs;
    };
    const tickets = listTickets(slug)
      .filter((ticket?: any) => changedAt(ticket) > afterMs)
      .sort((a?: any, b?: any) => changedAt(a) - changedAt(b))
      .map((ticket?: any) => {
        const warnings = [...storyContractDriftWarnings(ticket), ...storyDecisionLogWarnings(ticket, slug)];
        const dispatch = dispatchState(ticket);
        const claim = claimPulse(ticket, nowMs);
        const liveness = livenessPulse(ticket, dispatch, claim, dispatchDeath(dispatch));
        return {
          ref: ticket.ref,
          title: ticket.title,
          status: ticket.status,
          liveness: liveness.state,
          livenessEvidence: liveness.evidence,
          lastEventType: ticket.lastEventType || null,
          lastEventSource: ticket.lastEventSource || null,
          lastComment: latestCommentExcerpt(ticket),
          claim,
          checkpoint: checkpointProjection(ticket, nowMs),
          ...(oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {}),
          ...(warnings.length ? { warnings } : {}),
          updatedAt: ticket.updatedAt,
        };
      });
    return { since: after, serverTime, tickets };
  }

  return {
    boundedExcerpt,
    changesPayload,
    commentHistory,
    pulsePayload,
  };
}

module.exports = { createPulse };
