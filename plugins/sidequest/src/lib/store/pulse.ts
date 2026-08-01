'use strict';

function createPulse(dependencies: any) {
  const {
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
      return { commit: hash ? { hash, subject, at } : null, dirty: Boolean(changed) };
    } catch (_: any) {
      return null;
    }
  }

  function claimActivityPulse(ticket?: any, git?: any) {
    const claim = ticket && ticket.claim;
    if (!claim || !claim.by || claimReleaseVerdict(ticket)) return { working: false, lastActivityAt: null };
    const activity = [claim.at];
    for (const comment of Array.isArray(ticket.comments) ? ticket.comments : []) {
      if (comment && comment.by === claim.by) activity.push(comment.at);
    }
    if (git && git.commit && git.commit.at) activity.push(git.commit.at);
    const timestamps = activity
      .filter((at?: any) => Number.isFinite(Date.parse(at)))
      .sort((a?: any, b?: any) => Date.parse(b) - Date.parse(a));
    return { working: true, lastActivityAt: timestamps[0] || null };
  }

  function pulsePayload(slug?: any, idOrRef?: any) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return null;
    const meta = readMeta(slug);
    const git = gitPulse(meta && meta.path, ticket.files);
    const activity = claimActivityPulse(ticket, git);
    const dispatch = dispatchState(ticket);
    const warnings = [...storyContractDriftWarnings(ticket), ...storyDecisionLogWarnings(ticket, slug)];
    return {
      ref: ticket.ref,
      title: ticket.title,
      status: ticket.status,
      direct: ticket.directClaim || null,
      claim: claimPulse(ticket, Date.now()),
      working: activity.working,
      lastActivityAt: activity.lastActivityAt,
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
        return {
          ref: ticket.ref,
          title: ticket.title,
          status: ticket.status,
          lastEventType: ticket.lastEventType || null,
          lastEventSource: ticket.lastEventSource || null,
          lastComment: latestCommentExcerpt(ticket),
          claim: claimPulse(ticket, nowMs),
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
