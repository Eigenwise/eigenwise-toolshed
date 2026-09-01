"use strict";
const { execFileSync } = require("node:child_process");
const { canonicalPreparedDispatchExecutor } = require("../prepared-dispatch.js");
function createGitHubCiRunsProvider(projectPath, execute = execFileSync) {
  const command = (program, arguments_) => execute(program, arguments_, {
    cwd: projectPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  }).trim();
  try {
    const upstream = command("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const [remote, branch] = upstream.split("/", 2);
    const origin = command("git", ["remote", "get-url", remote]);
    if (!remote || !branch || !/github\.com(?::|\/)/i.test(origin)) return null;
    command("gh", ["auth", "status"]);
    return () => {
      try {
        const remoteHead = command("git", ["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/, 1)[0];
        if (!remoteHead) return null;
        const runs = JSON.parse(command("gh", ["run", "list", "--branch", branch, "--limit", "100", "--json", "databaseId,headSha,status,conclusion,name"]));
        const completedRuns = runs.filter((run) => run.status === "completed");
        const greenRuns = completedRuns.filter((run) => run.conclusion === "success");
        const lastGreenHeadSha = greenRuns[0]?.headSha || null;
        const hasCompletedGreenRun = greenRuns.some((run) => run.headSha === remoteHead);
        return {
          headSha: remoteHead,
          lastGreenHeadSha,
          hasCompletedGreenRun,
          runs: completedRuns.map((run) => ({
            id: run.databaseId,
            headSha: run.headSha,
            status: run.status,
            conclusion: run.conclusion,
            workflowName: run.name,
            failingJobCount: run.conclusion === "success" ? 0 : JSON.parse(command("gh", ["run", "view", String(run.databaseId), "--json", "jobs"])).jobs.filter((job) => job.conclusion === "failure").length
          }))
        };
      } catch (_error) {
        return null;
      }
    };
  } catch (_error) {
    return null;
  }
}
function createPulse(dependencies) {
  const {
    boardConfig,
    checkpointProjection,
    claimIdleMs,
    claimPulse,
    commitScope,
    dispatchState,
    effectiveScope,
    execFileSync: execFileSync2,
    getTicket,
    listTickets,
    normalizeRoute,
    oracleProjection,
    pulseDispatchState,
    readMeta,
    storyContractDriftWarnings,
    storyDecisionLogWarnings,
    submissionProjection
  } = dependencies;
  function boundedExcerpt(value, maxChars = 1200) {
    const text = String(value || "");
    if (text.length <= maxChars) return { text, length: text.length, truncated: false };
    const tailLength = Math.min(240, Math.floor(maxChars / 4));
    const marker = `
[… ${text.length - maxChars} more chars; use full:true …]
`;
    const headLength = maxChars - tailLength - marker.length;
    return {
      text: `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`,
      length: text.length,
      truncated: true
    };
  }
  const COMMENT_BODY_RETENTION = 10;
  function commentHistory(comments, full = false) {
    const history = Array.isArray(comments) ? comments : [];
    const omittedBodies = full ? 0 : Math.max(0, history.length - COMMENT_BODY_RETENTION);
    if (!omittedBodies) return { comments: history, omittedBodies: 0, notice: null };
    const notice = `${omittedBodies} earlier comment bodies omitted — pass --full to see them.`;
    return {
      comments: history.map((comment, index) => {
        if (index >= omittedBodies) return comment;
        const { body: _body, ...metadata } = comment;
        return Object.assign(metadata, { bodyOmitted: true });
      }),
      omittedBodies,
      notice
    };
  }
  function lastCommentPulse(ticket) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    return {
      at: comment.at,
      by: comment.by,
      kind: comment.kind,
      body: String(comment.body || "").slice(0, 100)
    };
  }
  function latestCommentExcerpt(ticket) {
    const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    const comment = comments[comments.length - 1];
    if (!comment) return null;
    const body = boundedExcerpt(comment.body, 200);
    return {
      id: comment.id,
      by: comment.by,
      kind: comment.kind,
      ...comment.sourceSession ? { sourceSession: comment.sourceSession } : {},
      ...comment.actor ? { actor: comment.actor } : {},
      ...comment.operation ? { operation: comment.operation } : {},
      body: body.text,
      bodyLength: body.length,
      bodyTruncated: body.truncated
    };
  }
  function gitPulse(projectPath, files) {
    if (!projectPath || !Array.isArray(files) || !files.length) return null;
    try {
      const git = (args) => execFileSync2("git", args, {
        cwd: projectPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }).trim();
      if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
      const commit = git(["log", "-1", "--format=%H%x1f%s%x1f%cI", "--", ...files]);
      const [hash, subject, at] = commit ? commit.split("") : [];
      const changed = git(["status", "--porcelain", "--", ...files]);
      return {
        commit: hash ? { hash, subject, at } : null,
        commitNote: "Last commit touching this ticket’s declared files; it may differ from repository HEAD.",
        dirty: Boolean(changed),
        dirtyNote: "Whether this ticket’s declared files have uncommitted changes; it is not repository-wide."
      };
    } catch (_) {
      return null;
    }
  }
  function projectedClaim(ticket, now = Date.now()) {
    const pulse = claimPulse(ticket, now);
    if (!pulse) return null;
    const boardQuietMs = Number.isFinite(pulse.idleMs) ? pulse.idleMs : null;
    const { idleMs: _idleMs, ...claim } = pulse;
    return {
      reclaimable: claim.reclaimable,
      ...claim,
      boardQuietMs,
      boardQuietNote: "Time since the claim holder last wrote to the board; this is not process liveness.",
      lastBoardActivityAt: boardQuietMs == null ? null : new Date(now - boardQuietMs).toISOString()
    };
  }
  function dispatchDeath(dispatch) {
    if (!dispatch) return null;
    if (dispatch.outcome === "died" && dispatch.terminalAt) {
      return { at: dispatch.terminalAt, source: dispatch.terminalSource || null };
    }
    const attempt = (Array.isArray(dispatch.attempts) ? dispatch.attempts : []).slice().reverse().find((entry) => entry?.outcome === "died" && entry.terminalAt);
    return attempt ? { at: attempt.terminalAt, source: attempt.terminalSource || null } : null;
  }
  function livenessPulse(ticket, dispatch, claim, death) {
    if (death) return { state: "dead", evidence: `died outcome recorded${death.source ? ` by ${death.source}` : ""}` };
    if (claim?.reclaimable) return { state: "dead", evidence: `claim is reclaimable: ${claim.reclaimable}` };
    if (claim?.verifying) return { state: "alive", evidence: "verification marker is active" };
    if (dispatch?.outcome === "launched" && !dispatch.boundAt && !dispatch.agentId && !claim && !ticket?.checkpoint) {
      return { state: "stalled", evidence: "dispatch launched without a bound runtime identity, claim, or checkpoint" };
    }
    if (dispatch?.outcome === "launched" && dispatch.boundAt && !dispatch.claimedAt && !claim && !ticket?.checkpoint && Date.now() - Date.parse(dispatch.boundAt) >= claimIdleMs()) {
      return { state: "stalled", evidence: "dispatch bound a runtime that never claimed, past the claim-idle backstop" };
    }
    if (claim && dispatch && !dispatch.terminalAt && (dispatch.agentId || dispatch.boundAt)) {
      return { state: "unknown", evidence: "a runtime identity was bound, but Sidequest has no process heartbeat" };
    }
    if (claim && dispatch && !dispatch.terminalAt) {
      return { state: "binding_fault", evidence: "dispatch.boundAt is null, so Sidequest cannot identify the executor process; the claim stays held because no death was observed" };
    }
    if (claim) return { state: "unknown", evidence: "claim held without live-process evidence" };
    return { state: "unknown", evidence: "no active claim or death record" };
  }
  function scopeDriftWarnings(slug, ticket) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.terminalAt || !Array.isArray(dispatch.declaredFiles)) return [];
    const scopePathKey = (file) => process.platform === "win32" ? file.toLowerCase() : file;
    const scopePaths = (files) => {
      const paths = /* @__PURE__ */ new Map();
      for (const file of Array.isArray(files) ? files : []) {
        const normalized = String(file || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
        const key = scopePathKey(normalized);
        if (normalized && !paths.has(key)) paths.set(key, normalized);
      }
      return [...paths.values()].sort((left, right) => scopePathKey(left).localeCompare(scopePathKey(right)));
    };
    const alwaysInScope = new Set(scopePaths(boardConfig(slug)?.alwaysInScope).map(scopePathKey));
    const declared = scopePaths(dispatch.declaredFiles).filter((file) => !alwaysInScope.has(scopePathKey(file)));
    const ticketFiles = scopePaths(commitScope.ticketCommitScope(effectiveScope(slug, ticket), ticket?.files, ticket?.ref)).filter((file) => !alwaysInScope.has(scopePathKey(file)));
    if (declared.length === ticketFiles.length && declared.every((file, index) => {
      const ticketFile = ticketFiles[index];
      return ticketFile != null && scopePathKey(file) === scopePathKey(ticketFile);
    })) return [];
    return [`Scope drift: this live dispatch enforces ${declared.join(", ") || "(none)"} but the ticket declares ${ticketFiles.join(", ") || "(none)"}. Commits are gated on the dispatch set; re-run update --files to resync.`];
  }
  function scopePulse(slug, ticket) {
    const dispatch = dispatchState(ticket);
    const resolution = ticket?.scopeResolution;
    return {
      declared: commitScope.ticketCommitScope(effectiveScope(slug, ticket), ticket?.files, ticket?.ref),
      enforced: dispatch && !dispatch.terminalAt && Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : null,
      lastRuling: resolution ? { state: resolution.state, at: resolution.at, granted: resolution.granted || [], refused: resolution.refused || [] } : null
    };
  }
  function pulsePayload(slug, idOrRef) {
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
      dispatchExecutor: canonicalPreparedDispatchExecutor(ticket),
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
        localAheadWarning: dispatch.localAheadWarning || null
      } : null,
      checkpoint: checkpointProjection(ticket),
      scope: scopePulse(slug, ticket),
      ...oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {},
      ...warnings.length ? { warnings } : {},
      submission: submissionProjection(ticket.submission),
      delivery: boardConfig(slug)?.delivery || "merge",
      git
    };
  }
  function changesPayload(slug, since, options) {
    const includeDispatchOwner = Boolean(options && options.includeDispatchOwner);
    const serverTime = (/* @__PURE__ */ new Date()).toISOString();
    const nowMs = Date.parse(serverTime);
    const defaultSince = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
    const after = since == null ? defaultSince : String(since);
    const afterMs = Date.parse(after);
    if (!Number.isFinite(afterMs)) throw new Error("changes: --since must be an ISO timestamp.");
    const changedAt = (ticket) => {
      const updatedMs = Date.parse(ticket.updatedAt);
      const expiresMs = Date.parse(ticket.checkpoint && ticket.checkpoint.expiresAt);
      return Number.isFinite(expiresMs) && expiresMs <= nowMs ? Math.max(updatedMs, expiresMs) : updatedMs;
    };
    const tickets = listTickets(slug).filter((ticket) => changedAt(ticket) > afterMs).sort((a, b) => changedAt(a) - changedAt(b)).map((ticket) => {
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
        ...includeDispatchOwner && dispatch ? {
          dispatch: {
            preparedBy: dispatch.preparedBy ? { sessionId: String(dispatch.preparedBy.sessionId || "").trim() || null } : null,
            terminalAt: dispatch.terminalAt || null
          }
        } : {},
        ...oracleProjection(ticket) ? { oracle: oracleProjection(ticket) } : {},
        ...warnings.length ? { warnings } : {},
        updatedAt: ticket.updatedAt
      };
    });
    return { since: after, serverTime, tickets };
  }
  return {
    boundedExcerpt,
    changesPayload,
    commentHistory,
    pulsePayload
  };
}
function createBoardWatch(dependencies) {
  const {
    board,
    changesPayload,
    ciRunsProvider,
    includeAllTickets = false,
    setTimer = setTimeout,
    writeError = (line) => process.stderr.write(`${line}
`),
    writeLine = (line) => process.stdout.write(`${line}
`),
    watchingAuthor = "",
    watchingSession = "",
    watchingOrigin = {}
  } = dependencies;
  const boardIdentity = String(board || "").trim();
  if (!boardIdentity) throw new Error("sidequest watch requires an explicit board identity.");
  const seen = /* @__PURE__ */ new Set();
  const seenCiRuns = /* @__PURE__ */ new Set();
  const seenUncheckedHeads = /* @__PURE__ */ new Set();
  let cursor = (/* @__PURE__ */ new Date()).toISOString();
  const commentPattern = /\b(?:out[- ]of[- ]scope|widen scope|scope request|technical_blocker|blocked|handback)\b/i;
  const markerPattern = /^\[sidequest:/i;
  function excerpt(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  function routineOwnMutation(comment) {
    const sessionId = String(watchingOrigin.sessionId || watchingSession || "");
    if (!comment || !sessionId) return false;
    return String(comment.sourceSession || "") === sessionId;
  }
  function ownedByAnotherSession(ticket) {
    if (includeAllTickets) return false;
    const watchingSessionId = String(watchingOrigin.sessionId || watchingSession || "").trim();
    const owningSessionId = String(ticket?.dispatch?.preparedBy?.sessionId || "").trim();
    if (!watchingSessionId || !owningSessionId || ticket?.dispatch?.terminalAt) return false;
    return owningSessionId !== watchingSessionId;
  }
  function actionableEvent(ticket) {
    if (ownedByAnotherSession(ticket)) return null;
    if (ticket.status === "awaiting-oracle") return { type: "awaiting-oracle", author: "", excerpt: "" };
    if (ticket.lastEventType === "release" || ticket.lastEventType === "scope-request") {
      return { type: ticket.lastEventType, author: "", excerpt: "" };
    }
    if (ticket.liveness === "dead") return { type: "dead", author: "", excerpt: String(ticket.livenessEvidence || "") };
    if (Array.isArray(ticket.warnings) && ticket.warnings.length) {
      const warningIdentity = String(ticket.warnings[0] || "");
      return { type: "warning", author: "", excerpt: excerpt(warningIdentity), warningIdentity };
    }
    const comment = ticket.lastComment;
    const body = String(comment?.body || "");
    if (!comment || markerPattern.test(body)) return null;
    if (routineOwnMutation(comment)) return null;
    if (commentPattern.test(body)) return { type: "comment", author: String(comment.by || ""), excerpt: excerpt(body) };
    return { type: "comment", author: String(comment.by || ""), excerpt: excerpt(body) };
  }
  function pollCi() {
    if (!ciRunsProvider) return;
    const ci = ciRunsProvider();
    if (!ci) return;
    for (const run of ci.runs || []) {
      if (run.headSha !== ci.headSha || run.status !== "completed" || run.conclusion === "success") continue;
      const key = `${run.headSha}|${run.id}`;
      if (seenCiRuns.has(key)) continue;
      seenCiRuns.add(key);
      writeLine(`CI ${run.headSha} failed ${run.workflowName} ${run.failingJobCount}`);
    }
    if (!ci.hasCompletedGreenRun && ci.headSha !== ci.lastGreenHeadSha && !seenUncheckedHeads.has(ci.headSha)) {
      seenUncheckedHeads.add(ci.headSha);
      writeLine(`CI ${ci.headSha} unchecked - -`);
    }
  }
  function poll() {
    try {
      const changes = changesPayload(boardIdentity, cursor);
      if (changes?.project !== boardIdentity) throw new Error("watch received changes for a different board identity.");
      if (changes?.serverTime) cursor = changes.serverTime;
      for (const ticket of Array.isArray(changes?.tickets) ? changes.tickets : []) {
        const event = actionableEvent(ticket);
        if (!event) continue;
        const commentId = ticket.lastComment?.id || "";
        const key = event.type === "warning" ? [ticket.ref, ticket.status, event.type, event.author, event.warningIdentity].join("|") : [ticket.ref, commentId, ticket.status].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        writeLine(`${ticket.ref} ${ticket.status} ${event.type} ${event.author || "-"} ${event.excerpt || "-"}`);
      }
      pollCi();
      return;
    } catch (error) {
      writeError(`sidequest watch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function start(intervalSeconds = 30) {
    const intervalMs = Math.max(1, Number(intervalSeconds) || 30) * 1e3;
    const next = () => {
      poll();
      setTimer(next, intervalMs);
    };
    next();
  }
  return { poll, start };
}
module.exports = { createPulse, createBoardWatch, createGitHubCiRunsProvider };
