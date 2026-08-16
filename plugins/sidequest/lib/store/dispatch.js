"use strict";
const { canonicalPreparedDispatchExecutor } = require("../prepared-dispatch.js");
const { reviewCandidateFromSubmission, sameReviewCandidate, reviewRelationFor, reviewRelationOutcome } = require("../kernel/review-binding");
function unscopedWriteCannotAutoApprove(ticket, options) {
  const { dispatchReadOnly, normalizeFiles, autoApproveScope } = options;
  return !dispatchReadOnly(ticket) && !normalizeFiles(ticket?.files).length && (!Array.isArray(autoApproveScope) || !autoApproveScope.length);
}
function createDispatch(dependencies) {
  const { ARTIFACT_BASELINE_MAX_PATHS, SHARED_TREE_ARTIFACT_MARKER, assertDispatchTransport, assertSidequestInstall, checkSidequestInstall, prepareAttempt, transitionAttempt, attemptDiagnostic, ensurePythonIoEncoding, localAheadOfUpstreamWarning, availableRoute, boardConfig, claimReclaimable, claimVerification, classifyDispatchFailure, terminalAgentFailure, commitScope, crypto, database, db, dispatchReadOnly, dispatchVerifyCommandError, dispatchRouteRefusal, dispatchRouteState, effectiveScope, execFileSync, execProjection, fs, getCategory, getStory, homeRoot, integrationTarget, integrationTargetCommit, legacyCategoryForComplexity, listProjects, listTickets, nonRepoExternalOutput, normalizeArtifactRoots, normalizeFiles, normalizeRoute, normalizeWorktreeIsolation, path, preferredWorktreeIntegrationTarget, agentWorktreePath, agentWorktreeCandidates, resolvedAgentWorktree, reclaimUnclaimedDispatchWorktree, preparedDispatchTtlMs, putTicket, readMeta, releaseTerminalClaim, resolveCategoryFallback, resolveCategoryRoute, resolveTicketRoute, resolveExec, stableExecutorName, staleWorktreeCwdWarning, storyExecutionContract, ticketCategory, ticketStorageRow, withTicketLock, normalizeCategoryId, projectRoutingEnabled, routingDisabledMessage, getTicket, dispatchLaunchName, nextDispatchLaunchSeq, spawnDescription, claudeQuotaFailure, canonicalPath, checkoutInstanceIdentity, createWorktreeLease, worktreeResumeDecision, isCanonicalRegisteredWorktree } = dependencies;
  const DISPATCH_TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
  const DISPATCH_TOKEN_CHARS = 32;
  const DISPATCH_TOKEN_GROUP_SIZE = 4;
  function normalizeDispatchToken(token) {
    return String(token || "").replace(/[\s-]/g, "").toLowerCase();
  }
  function dispatchTokenMatches(expected, received) {
    const expectedToken = normalizeDispatchToken(expected);
    const receivedToken = normalizeDispatchToken(received);
    if (!expectedToken || expectedToken.length !== receivedToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(receivedToken));
  }
  function mintDispatchToken() {
    let token = "";
    while (token.length < DISPATCH_TOKEN_CHARS) {
      for (const byte of crypto.randomBytes(DISPATCH_TOKEN_CHARS)) {
        if (byte >= 248) continue;
        token += DISPATCH_TOKEN_ALPHABET[byte % DISPATCH_TOKEN_ALPHABET.length];
        if (token.length === DISPATCH_TOKEN_CHARS) break;
      }
    }
    return token.match(new RegExp(`.{1,${DISPATCH_TOKEN_GROUP_SIZE}}`, "g"))?.join("-") || token;
  }
  function dispatchTokenPrefix(token) {
    return token ? String(token).slice(0, 12) : null;
  }
  function dispatchTokenFile(ticket) {
    return typeof ticket?.dispatch?.tokenFile === "string" ? ticket.dispatch.tokenFile : null;
  }
  function newDispatchTokenFile() {
    return path.join(homeRoot(), "dispatch-tokens", `${crypto.randomUUID()}.token`);
  }
  function writeDispatchTokenFile(ticket) {
    const file = dispatchTokenFile(ticket);
    if (!file) throw new Error("dispatch token file is unavailable");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
    fs.writeFileSync(file, `${ticket.dispatchNonce}
`, { encoding: "utf8", mode: 384 });
    return file;
  }
  function removeDispatchTokenFile(ticket) {
    const file = dispatchTokenFile(ticket);
    if (!file) return;
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  function dispatchTokenFromFile(file) {
    const tokenFile = String(file || "").trim();
    if (!tokenFile) return null;
    try {
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      return token && !/[\r\n]/.test(token) ? token : null;
    } catch (_) {
      return null;
    }
  }
  function dispatchTokenForRequest(token, tokenFile) {
    return token == null || token === "" ? dispatchTokenFromFile(tokenFile) : token;
  }
  function dispatchState(ticket) {
    return ticket && ticket.dispatch && typeof ticket.dispatch === "object" ? ticket.dispatch : null;
  }
  function reviewDispatchTarget(slug, ticket) {
    const target = ticket?.reviewTarget;
    if (!target) return null;
    if (String(ticketCategory(ticket) || "").trim().toLowerCase() !== "review-audit") {
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
      sourceDispatch?.terminalAt && sourceDispatch.outcome === "submitted" || sourceTicket.lifecycleAttempt?.state === "submitted"
    );
    if (!terminal || !submission || submission.integratedAt) {
      throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${sourceTicket.ref} is not a pending terminal submission.`);
    }
    const candidate = reviewCandidateFromSubmission(submission);
    if (!sameReviewCandidate(candidate, target.candidate)) {
      throw new Error(`prepare dispatch: ${ticket.ref} reviewTarget ${sourceTicket.ref} no longer matches its exact submitted candidate.`);
    }
    const relation = reviewRelationFor(sourceTicket, listTickets(slug), (idOrRef) => getTicket(slug, idOrRef));
    if (!relation || relation.conflict || relation.reviewTicket?.id !== ticket.id) {
      throw new Error(`prepare dispatch: ${ticket.ref} is not the sole authoritative review bound to ${sourceTicket.ref}.`);
    }
    if (reviewRelationOutcome(relation) === "rejected") {
      throw new Error(`prepare dispatch: ${ticket.ref} candidate was permanently rejected; repair needs fresh ticket, attempt, candidate, and review identities.`);
    }
    if (candidate.source === "git") {
      let resolved = "";
      try {
        resolved = execFileSync("git", ["rev-parse", "--verify", `${candidate.value}^{commit}`], {
          cwd: String(readMeta(slug)?.path || "").trim(),
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"]
        }).trim().toLowerCase();
      } catch (_) {
        throw new Error(`prepare dispatch: ${ticket.ref} candidate commit ${candidate.value} is unavailable in this checkout.`);
      }
      if (resolved !== candidate.value) {
        throw new Error(`prepare dispatch: ${ticket.ref} candidate must be the full immutable commit ${resolved}.`);
      }
    }
    return { sourceTicket, submission, candidate };
  }
  function executorClaimDispatchRefusal(slug, sessionId) {
    const callerSessionId = String(sessionId || "").trim();
    if (!callerSessionId) return null;
    for (const ticket of listTickets(slug)) {
      const state = dispatchState(ticket);
      const dispatchingSessionId = String(state?.preparedBy?.sessionId || "").trim();
      if (!ticket?.claim?.by || !state || state.terminalAt || state.sessionId !== callerSessionId || dispatchingSessionId === callerSessionId || claimReclaimable(ticket)) continue;
      return `dispatch: refused while you hold ${ticket.ref}. Executors cannot dispatch child tickets. Record the follow-up on ${ticket.ref}; the orchestration session must dispatch it.`;
    }
    return null;
  }
  function sharedTreeRuntimeRefusal(ticket, projectPath, runtimeCwd) {
    if (!runtimeCwd || !staleWorktreeCwdWarning(runtimeCwd, projectPath, true)) return null;
    return `prepare dispatch: refused ${ticket.ref}; sharedTree:true requires the spawning runtime to be rooted in the declared project checkout. This runtime is an isolated linked worktree. Record the follow-up on the owning ticket; the orchestration session must dispatch it.`;
  }
  function dispatchPreparationAttribution(opts) {
    return {
      sessionId: opts?.sessionId ? String(opts.sessionId) : null,
      surface: String(opts?.source || opts?.transport || "store")
    };
  }
  function sharedTreeArtifactRequested(ticket) {
    return String(ticket && ticket.description || "").split(/\r?\n/).some((line) => line.trim() === SHARED_TREE_ARTIFACT_MARKER);
  }
  function categoryArtifactRoot(category, scope) {
    const normalizedScope = commitScope.scopedPaths([scope]);
    if (normalizedScope.length !== 1 || !commitScope.validateRelativeScopes(normalizedScope).ok) return null;
    const roots = normalizeArtifactRoots(category && category.artifactRoots);
    return roots.find((root) => commitScope.isInScope(normalizedScope[0], [root])) || null;
  }
  function sharedTreeArtifactMode(ticket) {
    const state = dispatchState(ticket);
    return Boolean(state && state.sharedTree === true && state.artifactMode === true && typeof state.artifactRoot === "string" && state.artifactRoot && typeof state.artifactScope === "string" && state.artifactScope);
  }
  function dirtyPathKey(file) {
    const normalized = String(file || "").replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
  function artifactPathIdentity(root, file) {
    const absolute = path.resolve(root, file);
    let stat;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return "missing";
      throw error;
    }
    let kind = "other";
    if (stat.isFile()) kind = "file";
    else if (stat.isSymbolicLink()) kind = "symlink";
    else if (stat.isDirectory()) kind = "directory";
    let content = null;
    if (kind === "file" || kind === "symlink") {
      content = execFileSync("git", ["hash-object", "--no-filters", "--", file], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true
      }).trim();
    }
    return [kind, stat.mode, stat.size, stat.dev, stat.ino, content].map((value) => String(value == null ? "" : value)).join(":");
  }
  function artifactWorkingState(slug) {
    const meta = readMeta(slug);
    if (!meta || !meta.path) throw new Error("the board project path is unavailable");
    const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: meta.path,
      encoding: "utf8",
      windowsHide: true
    });
    const raw = output.split("\0");
    const states = [];
    for (let index = 0; index < raw.length; index++) {
      const entry = raw[index];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const file = entry.slice(3).replace(/\\/g, "/");
      if (file) states.push({ file, status });
      if (status.includes("R") || status.includes("C")) {
        const previous = raw[++index];
        if (previous) states.push({ file: previous.replace(/\\/g, "/"), status: `${status}:source` });
      }
    }
    if (states.length > ARTIFACT_BASELINE_MAX_PATHS) {
      throw new Error(`artifact dirty baseline exceeds ${ARTIFACT_BASELINE_MAX_PATHS} paths`);
    }
    return states.map((entry) => {
      const indexState = execFileSync("git", ["ls-files", "--stage", "-z", "--", entry.file], {
        cwd: meta.path,
        encoding: "utf8",
        windowsHide: true
      });
      const identity = crypto.createHash("sha256").update(JSON.stringify({
        status: entry.status,
        index: indexState,
        worktree: artifactPathIdentity(meta.path, entry.file)
      })).digest("hex");
      return { path: entry.file, identity };
    }).sort((left, right) => left.path.localeCompare(right.path));
  }
  function captureDirtyBaseline(slug) {
    try {
      return artifactWorkingState(slug);
    } catch (_) {
      return null;
    }
  }
  function captureArtifactBaseline(slug, scope) {
    const meta = readMeta(slug);
    if (!meta || !meta.path) throw new Error("prepare dispatch: shared-tree artifact mode requires a board project path.");
    const resolution = commitScope.validateScopeResolution(meta.path, [scope], { inspectDescendants: true });
    if (!resolution.ok) {
      const rejected = (resolution.indirect && resolution.indirect.length ? resolution.indirect : resolution.outside).join(", ");
      throw new Error(`prepare dispatch: artifact scope must be a direct path inside the board project: ${rejected}`);
    }
    try {
      return artifactWorkingState(slug);
    } catch (error) {
      const detail = error && error.message ? ` ${error.message}` : "";
      throw new Error(`prepare dispatch: shared-tree artifact mode requires a readable Git working tree.${detail}`);
    }
  }
  function artifactScopeCheck(slug, ticket, state) {
    if (!Array.isArray(state.artifactDirtyBaseline) || state.artifactDirtyBaseline.some((entry) => !entry || typeof entry.path !== "string" || typeof entry.identity !== "string")) {
      return {
        ok: false,
        reason: "artifact_baseline_missing",
        message: `${ticket.ref} has no content-aware dispatch-time dirty baseline. Release it and dispatch again before closing the artifact.`
      };
    }
    const approvedRoot = categoryArtifactRoot({ artifactRoots: [state.artifactRoot] }, state.artifactScope);
    if (!approvedRoot) {
      return {
        ok: false,
        reason: "artifact_scope_violation",
        message: `${ticket.ref} artifact scope is outside its dispatch-time approved root. Release it and dispatch again.`
      };
    }
    const meta = readMeta(slug);
    const resolution = meta && meta.path ? commitScope.validateScopeResolution(meta.path, [state.artifactScope], { inspectDescendants: true }) : { ok: false, reason: "scope_unavailable", indirect: [] };
    if (!resolution.ok) {
      const indirection = resolution.reason === "filesystem_indirection";
      return {
        ok: false,
        reason: indirection ? "artifact_scope_indirection" : "artifact_scope_unavailable",
        message: indirection ? `${ticket.ref} artifact scope contains filesystem indirection: ${resolution.indirect.join(", ")}. Replace it with direct in-project paths or release the ticket.` : `${ticket.ref} cannot resolve the shared-tree artifact scope directly inside the project. Release it and dispatch again.`,
        ...indirection ? { indirectPaths: resolution.indirect } : {}
      };
    }
    let current;
    try {
      current = artifactWorkingState(slug);
    } catch (_) {
      return {
        ok: false,
        reason: "artifact_scope_unavailable",
        message: `${ticket.ref} cannot verify the shared-tree artifact scope. Release it and dispatch again from a readable Git working tree.`
      };
    }
    const baseline = new Map(state.artifactDirtyBaseline.map((entry) => [dirtyPathKey(entry.path), entry]));
    const currentByPath = new Map(current.map((entry) => [dirtyPathKey(entry.path), entry]));
    const changed = /* @__PURE__ */ new Set();
    for (const entry of state.artifactDirtyBaseline) {
      if (commitScope.isInScope(entry.path, [state.artifactScope])) continue;
      const now = currentByPath.get(dirtyPathKey(entry.path));
      if (!now || now.identity !== entry.identity) changed.add(entry.path);
    }
    for (const entry of current) {
      if (!baseline.has(dirtyPathKey(entry.path)) && !commitScope.isInScope(entry.path, [state.artifactScope])) changed.add(entry.path);
    }
    const outside = Array.from(changed).sort();
    if (!outside.length) return { ok: true };
    return {
      ok: false,
      reason: "artifact_scope_violation",
      message: `${ticket.ref} changed paths outside artifact scope ${state.artifactScope}: ${outside.join(", ")}. Revert those changes or release the ticket instead of closing it.`,
      unscopedPaths: outside
    };
  }
  function activeDispatchRoute(ticket) {
    const state = dispatchState(ticket);
    if (!state || state.terminalAt || !ticket.dispatchNonce) return null;
    return normalizeRoute(state.route);
  }
  function rederiveUnlaunchedPreparedRoute(ticket, project) {
    const state = dispatchState(ticket);
    if (!state || state.recovery || state.terminalAt || state.outcome !== "prepared" || state.launchedAt || state.boundAt || state.claimedAt || !ticket.dispatchNonce) return;
    let requestedCategory = ticketCategory(ticket);
    if (requestedCategory == null && ticket.complexity != null) requestedCategory = legacyCategoryForComplexity(ticket.complexity);
    let category = requestedCategory == null ? null : getCategory(requestedCategory, { project });
    if (!category || !category.enabled) category = getCategory("general", { project });
    if (!category) return;
    const resolved = resolveTicketRoute(ticket, category);
    ticket.model = resolved.model;
    ticket.effort = resolved.effort;
    ticket.exec = execProjection(resolved.exec);
  }
  function stampDispatchEvent(ticket, source, now) {
    ticket.lastEventType = "dispatch";
    ticket.lastEventSource = source || "store";
    ticket.updatedAt = now || (/* @__PURE__ */ new Date()).toISOString();
  }
  function pulseDispatchState(state) {
    if (!state) return null;
    if (state.terminalAt) return state.outcome || "terminal";
    if (state.claimedAt) return "claimed";
    if (state.boundAt) return "bound";
    if (state.launchedAt) return "launched";
    return state.outcome || "prepared";
  }
  function supersedableUnclaimedLaunch(ticket, state) {
    return Boolean(
      state && state.outcome === "launched" && state.launchedAt && !state.terminalAt && !state.boundAt && !state.agentId && !state.claimedAt && !(ticket?.claim && ticket.claim.by) && !ticket?.checkpoint && ticket?.dispatchNonce
    );
  }
  function supersedeUnclaimedLaunch(slug, idOrRef, opts) {
    const evidence = String(opts?.evidence || "").trim();
    if (!evidence) return { ok: false, reason: "recovery_evidence_required", message: "Superseding an unclaimed launch requires observed failure evidence." };
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      const state = dispatchState(ticket);
      if (!supersedableUnclaimedLaunch(ticket, state)) return { ok: false, reason: "unclaimed_launch_not_supersedable", ticket };
      setDispatchTerminal(ticket, "failed", opts?.source || "control-plane-unclaimed-launch-supersession", { slug, failureShape: "unclaimed_launch_superseded" });
      const attempt = state.attempts?.at(-1);
      if (attempt) attempt.recoveryEvidence = evidence;
      ticket.dispatchNonce = null;
      ticket.dispatchExecutor = null;
      const previousStatus = ticket.status;
      if (!ticket.submission) ticket.status = "todo";
      if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: (/* @__PURE__ */ new Date()).toISOString() };
      stampDispatchEvent(ticket, opts?.source || "control-plane-unclaimed-launch-supersession");
      putTicket(slug, ticket);
      return { ok: true, ticket };
    });
  }
  function isolatedDispatchWorktreeMissing(state) {
    const worktree = String(state?.worktree || "").trim();
    return state?.sharedTree === false && Boolean(worktree) && !fs.existsSync(worktree);
  }
  function isolatedDispatchWithMissingWorktree(agentName) {
    const target = String(agentName || "").trim();
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
  function terminalDispatchTarget(agentName) {
    const target = String(agentName || "").trim();
    if (!target) return null;
    let terminal = null;
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || state.agentName !== target || !state.terminalAt || state.outcome !== "died" && ticket.claim?.by) continue;
        terminal = { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt };
      }
    }
    return terminal;
  }
  function terminalDispatchForIdle(identity) {
    const sessionId = String(identity?.sessionId || "").trim();
    const agentId = String(identity?.agentId || "").trim();
    const agentName = String(identity?.agentName || "").trim();
    const executor = String(identity?.executor || "").trim();
    if (!agentId && !agentName) return null;
    const candidates = [];
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || !state.terminalAt || ticket.claim?.by) continue;
        const byId = Boolean(agentId && state.agentId && String(state.agentId) === agentId);
        const byName = Boolean(agentName && state.agentName && String(state.agentName) === agentName);
        if (!byId && !byName) continue;
        candidates.push({
          byId,
          corroboration: (sessionId && String(state.sessionId || "") === sessionId ? 1 : 0) + (executor && String(state.executor || "") === executor ? 1 : 0),
          match: { slug: project.slug, id: ticket.id, ref: ticket.ref, outcome: state.outcome, terminalAt: state.terminalAt }
        });
      }
    }
    const sole = soleIdleCandidate(candidates);
    return sole ? sole.match : null;
  }
  function soleIdleCandidate(candidates) {
    if (candidates.length < 2) return candidates[0] || null;
    for (const pool of [candidates.filter((candidate) => candidate.byId), candidates]) {
      if (!pool.length) continue;
      if (pool.length === 1) return pool[0];
      const best = pool.reduce((top, candidate) => Math.max(top, candidate.corroboration), 0);
      const narrowed = pool.filter((candidate) => candidate.corroboration === best);
      if (narrowed.length === 1) return narrowed[0];
    }
    return null;
  }
  function appendDispatchAttempt(state, outcome, source, failureShape, at, commit, release) {
    const route = state && state.route && typeof state.route === "object" ? state.route : {};
    const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
    const terminalSource = source || "store";
    attempts.push({
      route: normalizeRoute(route),
      executor: state.executor || null,
      sessionId: state.sessionId || null,
      agentId: state.agentId || null,
      agentName: state.agentName || null,
      tokenPrefix: state.tokenPrefix || null,
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
      ...commit ? { commit } : {},
      ...release?.kind ? { release } : {}
    });
    state.attempts = attempts.slice(-8);
  }
  function attemptCommit(ticket, opts) {
    return opts?.commit || ticket?.checkpoint?.commit || ticket?.submission?.commit || null;
  }
  function captureTerminalWorktreeRevision(slug, state, at) {
    if (!slug || state?.sharedTree !== false || !state.worktree || !state.worktreeGitDirectory || !state.worktreeCommonGitDirectory) return;
    const facts = immutableWorktreeFacts(slug, state.worktree);
    if (!facts || facts.worktree !== canonicalPath(state.worktree) || facts.gitDirectory !== canonicalPath(state.worktreeGitDirectory) || facts.commonGitDirectory !== canonicalPath(state.worktreeCommonGitDirectory) || facts.checkoutInstance !== String(state.worktreeCheckoutInstance || "")) return;
    state.terminalWorktreeRevision = facts.revision;
    state.terminalWorktreeObservedAt = at;
  }
  function setDispatchTerminal(ticket, outcome, source, opts) {
    const state = dispatchState(ticket);
    if (!state) return;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    captureTerminalWorktreeRevision(opts?.slug, state, at);
    const release = opts?.releaseKind ? {
      kind: opts.releaseKind,
      reason: opts.releaseReason || null,
      evidence: opts.releaseEvidence || null
    } : null;
    const failureShape = opts?.failureShape || release?.kind || classifyDispatchFailure(opts?.error);
    state.outcome = outcome;
    state.failureShape = failureShape;
    state.terminalAt = at;
    state.terminalSource = source || "store";
    appendDispatchAttempt(state, outcome, source, failureShape, at, attemptCommit(ticket, opts), release);
    delete state.supersededTokens;
  }
  function appendReworkEvent(ticket, kind, details) {
    const dispatch = dispatchState(ticket);
    const route = dispatch && dispatch.route && typeof dispatch.route === "object" ? dispatch.route : {};
    const at = details.at || (/* @__PURE__ */ new Date()).toISOString();
    if (!Array.isArray(ticket.reworkEvents)) ticket.reworkEvents = [];
    ticket.reworkEvents.push({
      kind,
      at,
      source: details.source || "store",
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
        outcome: dispatch.outcome || null
      } : null
    });
  }
  function dispatchTokenDigest(token) {
    return crypto.createHash("sha256").update(normalizeDispatchToken(token)).digest("hex");
  }
  function isSupersededDispatchToken(ticket, token) {
    const state = dispatchState(ticket);
    if (!state || !token || dispatchTokenMatches(ticket.dispatchNonce, token)) return false;
    return Array.isArray(state.supersededTokens) && state.supersededTokens.some((entry) => entry.digest === dispatchTokenDigest(token));
  }
  function routingPolicyAffectsTicket(ticket, categoryIds) {
    if (ticket?.route != null) return false;
    if (!Array.isArray(categoryIds) || !categoryIds.length) return true;
    const affected = new Set(categoryIds.map(normalizeCategoryId));
    if (affected.has("general")) return true;
    let category = ticketCategory(ticket);
    if (category == null && ticket && ticket.complexity != null) category = legacyCategoryForComplexity(ticket.complexity);
    return category != null && affected.has(normalizeCategoryId(category));
  }
  function refreshPreparedDispatches(handle, projects, categoryIds, options) {
    const projectList = Array.from(new Set((projects || []).filter(Boolean)));
    const refreshed = { superseded: 0, stamped: 0 };
    if (!projectList.length) return refreshed;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const project of projectList) {
      for (const row of handle.prepare("SELECT data FROM tickets WHERE project = ?").all(project)) {
        let ticket;
        try {
          ticket = JSON.parse(row.data);
        } catch (_) {
          continue;
        }
        if (!routingPolicyAffectsTicket(ticket, categoryIds)) continue;
        const state = dispatchState(ticket);
        if (!state || state.terminalAt || !ticket.dispatchNonce) continue;
        const active = Boolean(state.launchedAt || state.boundAt || state.claimedAt || ticket.claim && ticket.claim.by || options?.preservePrepared);
        if (active) {
          state.policyChangedAt = now;
          stampDispatchEvent(ticket, "routing-policy", now);
          db.putRow(handle, "tickets", ticketStorageRow(project, ticket));
          refreshed.stamped += 1;
          continue;
        }
        if (state.outcome !== "prepared") continue;
        const supersededTokens = Array.isArray(state.supersededTokens) ? state.supersededTokens.slice() : [];
        supersededTokens.push({
          digest: dispatchTokenDigest(ticket.dispatchNonce),
          tokenPrefix: dispatchTokenPrefix(ticket.dispatchNonce),
          at: now
        });
        state.supersededTokens = supersededTokens.slice(-8);
        const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
        attempts.push({
          route: normalizeRoute(state.route),
          executor: state.executor || canonicalPreparedDispatchExecutor(ticket),
          tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(ticket.dispatchNonce),
          preparedAt: state.preparedAt || null,
          launchedAt: null,
          outcome: "policy-changed",
          terminalAt: now,
          terminalSource: "routing-policy"
        });
        state.attempts = attempts.slice(-8);
        state.outcome = "policy-changed";
        state.terminalAt = now;
        state.terminalSource = "routing-policy";
        state.policyChangedAt = now;
        delete state.executor;
        delete ticket.dispatchNonce;
        delete ticket.dispatchExecutor;
        stampDispatchEvent(ticket, "routing-policy", now);
        db.putRow(handle, "tickets", ticketStorageRow(project, ticket));
        refreshed.superseded += 1;
      }
    }
    return refreshed;
  }
  function expiredPreparedDispatch(state, now) {
    if (!state || state.outcome !== "prepared" || state.terminalAt || state.launchedAt || state.boundAt || state.claimedAt) return false;
    const preparedAt = Date.parse(state.preparedAt);
    return Number.isFinite(preparedAt) && now - preparedAt > preparedDispatchTtlMs();
  }
  function recentNoCommitAttemptSelection(state) {
    const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
    const recent = [];
    const rounds = /* @__PURE__ */ new Set();
    let skippedUnbound = 0;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (!attempt?.terminalAt || attempt.release?.kind === "handback" || attempt.release?.kind === "oracle") continue;
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
      attempts: recent.length === 2 && recent.every((attempt) => attempt.outcome !== "submitted" && !attempt.commit) ? recent : [],
      skippedUnbound
    };
  }
  function recentNoCommitAttempts(state) {
    return recentNoCommitAttemptSelection(state).attempts;
  }
  function skippedUnboundNoCommitAttempts(state) {
    return recentNoCommitAttemptSelection(state).skippedUnbound >= 2;
  }
  function recordedAttemptSummary(attempt) {
    const kind = attempt?.release?.kind || attempt?.outcome || "unknown";
    const at = attempt?.terminalAt || "unknown time";
    return `${kind} at ${at}`;
  }
  function repeatNoCommitDispatchError(ticket, state) {
    const attempts = recentNoCommitAttempts(state);
    if (attempts.length !== 2) return null;
    const recordedAttempts = attempts.map(recordedAttemptSummary).join("; ");
    const worktreeFailures = attempts.every((attempt) => attempt.sharedTree === false && attempt.failureShape === "worktree_environment");
    if (worktreeFailures) {
      return `prepare dispatch: ${ticket.ref} has two isolated no-commit dispatches (${recordedAttempts}) that failed to find the app or service. Check for repository bind mounts or unavailable paths, then choose a shared-tree fallback with \`dispatch ${ticket.ref} --shared-tree\` (or MCP \`sharedTree:true\`): its spawn omits \`isolation\`, so the harness validator does not run. Run one shared-tree executor at a time. Pass allowRepeatFailure:true to override this block; the override is recorded.`;
    }
    const repeatedContradictions = attempts.every((attempt) => attempt.release?.kind === "contradiction");
    if (repeatedContradictions) {
      return `prepare dispatch: ${ticket.ref} has two contradiction releases (${recordedAttempts}). The ticket premise is likely wrong, not the executor environment. Measure the claim, then rewrite the ticket before dispatching again; pass allowRepeatFailure:true only when a repeat is intentional.`;
    }
    return `prepare dispatch: ${ticket.ref} has two prior terminal no-commit dispatches (${recordedAttempts}). Review the recorded release reasons, correct the ticket when they show a contradiction, then dispatch with allowRepeatFailure:true when a repeat is intentional.`;
  }
  function worktreeIsolationWarning(slug) {
    const meta = readMeta(slug);
    if (!meta || !meta.path) {
      return "Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. Executor must scoped-commit immediately.";
    }
    if (!fs.existsSync(meta.path)) {
      return "Worktree isolation unavailable: project path does not exist; spawning in shared tree. Executor must scoped-commit immediately.";
    }
    try {
      const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: meta.path,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (inside !== "true") {
        return "Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. Executor must scoped-commit immediately.";
      }
    } catch (error) {
      const reason = error && error.code === "ENOENT" ? "Git is not available" : "project is not a Git work tree";
      return `Worktree isolation unavailable: ${reason}; spawning in shared tree. Executor must scoped-commit immediately.`;
    }
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: meta.path,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"]
      });
      return null;
    } catch (_) {
      return "Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. Executor must scoped-commit immediately.";
    }
  }
  function nativeGitPath(value) {
    const input = String(value || "").trim();
    const gitBashPath = process.platform === "win32" ? /^\/([a-zA-Z])(?=\/|$)/.exec(input) : null;
    return gitBashPath ? `${gitBashPath[1]}:${input.slice(2)}` : input;
  }
  function gitOutput(root, args) {
    return execFileSync("git", args || [], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  }
  function registeredWorktrees(repository) {
    return gitOutput(repository, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/).map((entry) => /^worktree\s+(.+)$/m.exec(entry)?.[1]).filter((worktree) => Boolean(worktree)).map((worktree) => canonicalPath(worktree));
  }
  function gitFailureEvidence(error) {
    return String(error?.stderr || error?.message || error || "unknown Git error").replace(/\s+/g, " ").trim().slice(0, 1e3);
  }
  function continuationFallback(reason, worktree, details) {
    return {
      reason: String(reason || "unavailable"),
      ...worktree ? { sourceWorktree: String(worktree) } : {},
      ...details && typeof details === "object" ? details : {}
    };
  }
  function gitDirectory(repository, directory) {
    const value = nativeGitPath(directory);
    return canonicalPath(path.isAbsolute(value) ? value : path.resolve(String(repository || ""), value));
  }
  function immutableWorktreeFacts(slug, candidate) {
    const projectPath = String(readMeta(slug)?.path || "").trim();
    const supplied = String(candidate || "").trim();
    if (!projectPath || !supplied) return null;
    try {
      const repository = canonicalPath(gitOutput(projectPath, ["rev-parse", "--show-toplevel"]));
      const worktree = canonicalPath(gitOutput(supplied, ["rev-parse", "--show-toplevel"]));
      const gitDirectoryPath = gitDirectory(worktree, gitOutput(worktree, ["rev-parse", "--git-dir"]));
      const commonGitDirectory = gitDirectory(worktree, gitOutput(worktree, ["rev-parse", "--git-common-dir"]));
      const repositoryGitDirectory = gitDirectory(repository, gitOutput(repository, ["rev-parse", "--git-common-dir"]));
      const checkoutInstance = checkoutInstanceIdentity(gitDirectoryPath);
      if (commonGitDirectory !== repositoryGitDirectory || gitDirectoryPath === commonGitDirectory || !checkoutInstance) return null;
      const revision = gitOutput(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
      return { repository, worktree, gitDirectory: gitDirectoryPath, commonGitDirectory, checkoutInstance, revision };
    } catch (_) {
      return null;
    }
  }
  function completedWorktreeCreationFacts(state) {
    if (!state?.worktreeCreationCompletedAt || !state.worktree || !state.worktreeGitDirectory || !state.worktreeCommonGitDirectory || !state.worktreeCheckoutInstance || !state.worktreeObservedRevision) return null;
    return {
      worktree: canonicalPath(state.worktree),
      gitDirectory: canonicalPath(state.worktreeGitDirectory),
      commonGitDirectory: canonicalPath(state.worktreeCommonGitDirectory),
      checkoutInstance: String(state.worktreeCheckoutInstance),
      revision: String(state.worktreeObservedRevision)
    };
  }
  function reportsRegisteredProjectCheckout(slug, worktree) {
    const projectPath = String(readMeta(slug)?.path || "").trim();
    const reportedWorktree = String(worktree || "").trim();
    return Boolean(projectPath && reportedWorktree && canonicalPath(projectPath) === canonicalPath(reportedWorktree));
  }
  function releasedContinuationState(slug, ticket, state) {
    if (!state || state.outcome !== "released" || !state.terminalAt || state.sharedTree !== false) return null;
    const recordedWorktree = String(state.worktree || "").trim();
    if (!recordedWorktree || !fs.existsSync(recordedWorktree)) {
      return { fallback: continuationFallback("released_worktree_missing", recordedWorktree) };
    }
    const attempts = Array.isArray(state.attempts) ? state.attempts : [];
    const attempt = attempts[attempts.length - 1] || null;
    const checkpointCommit = String(attempt?.commit || "").trim();
    let worktree = recordedWorktree;
    try {
      const recordedGitDirectory = String(state.worktreeGitDirectory || "").trim();
      const recordedCommonGitDirectory = String(state.worktreeCommonGitDirectory || "").trim();
      const recordedCheckoutInstance = String(state.worktreeCheckoutInstance || "").trim();
      const recordedRevision = String(state.terminalWorktreeRevision || "").trim();
      const worktreeFacts = immutableWorktreeFacts(slug, recordedWorktree);
      if (!worktreeFacts || !recordedGitDirectory || !recordedCommonGitDirectory || !recordedCheckoutInstance || !recordedRevision) {
        return { fallback: continuationFallback("released_worktree_identity_unavailable", recordedWorktree) };
      }
      worktree = worktreeFacts.worktree;
      const observedRevision = worktreeFacts.revision;
      const leaseFacts = {
        repository: worktreeFacts.repository,
        gitDirectory: worktreeFacts.gitDirectory,
        commonGitDirectory: worktreeFacts.commonGitDirectory,
        dispatchRef: String(ticket?.ref || "") || null,
        dispatchBaseline: String(state.baseCommit || "").trim() || null,
        observedRevision,
        observedWorktree: worktree,
        boundRevision: recordedRevision,
        boundWorktree: recordedWorktree,
        boundGitDirectory: recordedGitDirectory,
        boundCommonGitDirectory: recordedCommonGitDirectory,
        boundCheckoutInstance: recordedCheckoutInstance,
        identity: state.agentId ? { status: "bound", agentId: String(state.agentId) } : { status: "unknown" },
        phase: "terminal",
        locked: false,
        liveness: { status: "terminal", evidence: "released at " + state.terminalAt },
        provisioning: "host"
      };
      const lease = createWorktreeLease(leaseFacts);
      if (!isCanonicalRegisteredWorktree(lease, registeredWorktrees(worktreeFacts.repository))) {
        return { fallback: continuationFallback("released_worktree_is_not_registered", worktree) };
      }
      const resume = worktreeResumeDecision(lease);
      if (!resume.allowed) {
        return { fallback: continuationFallback("released_worktree_lease_refused", worktree, { cause: resume.reason }) };
      }
      const baseCommit = gitOutput(worktree, ["rev-parse", "--verify", String(state.baseCommit) + "^{commit}"]);
      const commits = gitOutput(worktree, ["rev-list", "--reverse", baseCommit + ".." + observedRevision, "--"]).split(/\r?\n/).filter(Boolean);
      let sourceBranch = null;
      try {
        sourceBranch = gitOutput(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
      } catch (_) {
      }
      if (gitOutput(worktree, ["status", "--porcelain"])) {
        if (!commits.length) {
          return {
            continuation: {
              mode: "dirty_worktree_resume",
              ticketRef: ticket.ref,
              sourceWorktree: worktree,
              sourceBranch,
              baseCommit,
              commit: observedRevision,
              clean: false,
              releasedAt: state.terminalAt,
              releaseKind: attempt?.release?.kind || "release",
              lease: leaseFacts
            }
          };
        }
        return { fallback: continuationFallback("released_worktree_is_dirty", worktree, { sourceBranch, commit: observedRevision, commits }) };
      }
      if (!checkpointCommit && !["handback", "oracle"].includes(attempt?.release?.kind)) {
        return { fallback: continuationFallback("release_has_no_checkpoint_or_handback", worktree) };
      }
      if (checkpointCommit && checkpointCommit !== observedRevision) {
        return { fallback: continuationFallback("checkpoint_is_not_worktree_head", worktree) };
      }
      if (!commits.length) return { fallback: continuationFallback("released_worktree_has_no_committed_progress", worktree) };
      if (commits.length > 128) return { fallback: continuationFallback("released_worktree_commit_range_is_too_large", worktree) };
      return {
        continuation: {
          mode: "retained_worktree_resume",
          ticketRef: ticket.ref,
          sourceWorktree: worktree,
          sourceBranch,
          baseCommit,
          commit: observedRevision,
          commits,
          clean: true,
          releasedAt: state.terminalAt,
          releaseKind: attempt?.release?.kind || (checkpointCommit ? "checkpoint" : "handback"),
          lease: leaseFacts
        }
      };
    } catch (error) {
      return { fallback: continuationFallback("released_worktree_git_state_is_unreadable", worktree, { cause: gitFailureEvidence(error) }) };
    }
  }
  function worktreeBaseIntegrationTarget(slug, worktreeBase, repository, branch) {
    if (worktreeBase === "local-main") return integrationTarget(slug, { mode: "local" });
    try {
      return integrationTarget(slug, { mode: "remote" });
    } catch (_) {
      return preferredWorktreeIntegrationTarget(repository, branch);
    }
  }
  function prepareDispatch(slug, idOrRef, opts) {
    opts = opts || {};
    if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
    const projectPath = readMeta(slug)?.path;
    const found = getTicket(slug, idOrRef);
    if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    const executorClaimRefusal = executorClaimDispatchRefusal(slug, opts.sessionId);
    if (executorClaimRefusal) throw new Error(executorClaimRefusal);
    const initialNoDeclaredFileScope = unscopedWriteCannotAutoApprove(found, {
      dispatchReadOnly,
      normalizeFiles,
      autoApproveScope: boardConfig(slug)?.autoApproveScope
    });
    if (initialNoDeclaredFileScope && opts.allowUnscoped !== true) {
      throw new Error(`prepare dispatch: ${found.ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to explicitly accept that the executor can block on its first write and end without a submission.`);
    }
    const verifyError = dispatchVerifyCommandError(found, projectPath);
    if (verifyError) throw new Error(verifyError);
    const installCheck = projectPath ? assertSidequestInstall(projectPath) : null;
    const preparedPluginInstall = installCheck?.installPath || null;
    const preparedPluginIdentity = installCheck?.identity || null;
    if (opts.recoveryEvidence) {
      const superseded = supersedeUnclaimedLaunch(slug, found.id, {
        evidence: opts.recoveryEvidence,
        source: opts.source || opts.transport || "dispatch"
      });
      if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${found.ref} has a bound, claimed, checkpointed, or terminal dispatch that cannot be superseded.`}`);
    }
    assertDispatchTransport(opts.transport, { allowUnverifiedTransport: !!opts.allowUnverifiedTransport });
    const pythonIoEncoding = projectPath ? ensurePythonIoEncoding(projectPath) : { written: false };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
      const current = dispatchState(t);
      if (current?.terminalAt && current.sharedTree === false && !current.claimedAt && !(t.claim && t.claim.by)) {
        const recovery2 = reclaimUnclaimedDispatchWorktree(projectPath, current, {
          checkpointCommit: t.checkpoint?.commit || t.submission?.commit || null
        });
        if (recovery2 && recovery2.reclaimed === false && recovery2.discardable !== true) {
          throw new Error(`prepare dispatch: ${t.ref} cannot retry because ${recovery2.message || `immutable recovery fact ${recovery2.reason || "is unreadable"}`}`);
        }
      }
      const activeRuntimeAttempt = current && !current.terminalAt && !(t.claim && t.claim.by) && Boolean(current.launchedAt || current.boundAt);
      if (activeRuntimeAttempt) {
        const recovery2 = supersedableUnclaimedLaunch(t, current) ? ` It is unbound and unclaimed, so the orchestrator can supersede it in one call: \`sidequest dispatch ${t.ref} --recovery-evidence "<observed failed-claim evidence>"\`.` : " Wait for that executor's terminal hook, then dispatch once from the returned todo state; do not mint a replacement token while it is still winding down.";
        throw new Error(`prepare dispatch: ${t.ref} already has a live dispatch attempt (${pulseDispatchState(current)}).${recovery2}`);
      }
      const repeatFailure = repeatNoCommitDispatchError(t, current);
      const unboundAttemptsSkipped = skippedUnboundNoCommitAttempts(current);
      if (repeatFailure && opts.allowRepeatFailure !== true) throw new Error(repeatFailure);
      const releasedContinuation = releasedContinuationState(slug, t, current);
      if (t.claim && t.claim.by && !claimReclaimable(t)) {
        throw new Error(`prepare dispatch: ${t.ref} has a live claim by ${t.claim.by}. Release it (\`sidequest release ${t.ref} --by ${t.claim.by}\`) before dispatching again.`);
      }
      rederiveUnlaunchedPreparedRoute(t, slug);
      const policyCategory = getCategory(ticketCategory(t), { project: slug });
      const resolvedPolicy = resolveTicketRoute(t, policyCategory);
      if (!current?.recovery && resolvedPolicy) {
        t.model = resolvedPolicy.model;
        t.effort = resolvedPolicy.effort;
        t.exec = execProjection(resolvedPolicy.exec);
      }
      if (resolvedPolicy?.refusal) throw new Error(resolvedPolicy.refusal);
      const currentRoute = activeDispatchRoute(t);
      if (current && current.recovery && current.outcome === "prepared" && t.dispatchNonce && canonicalPreparedDispatchExecutor(t)) {
        if (opts.sessionId) current.sessionId = String(opts.sessionId);
        if (!current.launchSeq) current.launchSeq = 1;
        if (!current.launchName) current.launchName = dispatchLaunchName(t.ref, t.title, current.launchSeq);
        putTicket(slug, t);
        return {
          ok: true,
          ticket: t,
          token: t.dispatchNonce,
          reused: true,
          recovery: current.recovery
        };
      }
      if (current && current.recovery && !current.terminalAt && !currentRoute) {
        const replacement = resolveCategoryFallback(t.category, current.recovery.failedModel);
        if (!replacement) throw new Error(`prepare dispatch: no fallback remains available for ${current.recovery.failedModel}.`);
        t.model = replacement.model;
        t.effort = replacement.effort;
        t.exec = execProjection(replacement.exec);
        current.recovery = Object.assign({}, current.recovery, {
          fallbackSource: replacement.source,
          model: replacement.model,
          effort: replacement.effort
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const backend = availableRoute(t.model);
      if (backend && backend.backend === "claude" && (t.effort == null || String(t.effort).trim() === "")) {
        t.effort = "low";
        t.exec = execProjection(resolveExec(t.model, t.effort));
      }
      const refusal = dispatchRouteRefusal({ model: t.model, effort: t.effort });
      if (refusal) throw new Error(refusal);
      const preparedExec = resolveExec(t.model, t.effort);
      if (!preparedExec) throw new Error(`prepare dispatch: ${t.ref} has no executable route.`);
      const noDeclaredFileScope = unscopedWriteCannotAutoApprove(t, {
        dispatchReadOnly,
        normalizeFiles,
        autoApproveScope: boardConfig(slug)?.autoApproveScope
      });
      if (noDeclaredFileScope && opts.allowUnscoped !== true) {
        throw new Error(`prepare dispatch: ${t.ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to explicitly accept that the executor can block on its first write and end without a submission.`);
      }
      const fallbackReason = !current?.recovery && resolvedPolicy?.fallbackReason || null;
      const recovery = current && current.recovery && activeDispatchRoute(t) ? current.recovery : null;
      const attempts = current && Array.isArray(current.attempts) ? current.attempts.slice() : [];
      const supersededTokens = current && Array.isArray(current.supersededTokens) ? current.supersededTokens.slice() : [];
      if (current && !current.terminalAt && t.dispatchNonce) {
        if (current.outcome === "prepared" && current.sharedTree === false) {
          reclaimUnclaimedDispatchWorktree(projectPath, current);
        }
        supersededTokens.push({
          digest: dispatchTokenDigest(t.dispatchNonce),
          tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
          at: now
        });
      }
      const priorTokenFile = dispatchTokenFile(t);
      const releasedBinding = current?.outcome === "released" && Array.isArray(current.declaredFiles) && current.declaredFiles.length ? current.declaredFiles.slice() : null;
      const effectiveFiles = releasedBinding ? Array.from(/* @__PURE__ */ new Set([...releasedBinding, ...effectiveScope(slug, t.files)])) : effectiveScope(slug, t.files);
      const readonly = dispatchReadOnly(t);
      const requestedSharedTree = opts.sharedTree === true || !Object.hasOwn(opts, "sharedTree") && Boolean(current?.sharedTree);
      const explicitIsolation = Object.hasOwn(opts, "sharedTree") && opts.sharedTree === false;
      const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
      const reviewTargetState = reviewDispatchTarget(slug, t);
      if (reviewTargetState && opts.sharedTree === true) {
        throw new Error(`prepare dispatch: ${t.ref} reviews candidate ${reviewTargetState.candidate.value} and requires an isolated immutable checkout.`);
      }
      let sharedTree = reviewTargetState ? false : worktreeIsolation ? requestedSharedTree : true;
      const nonRepoOutput = nonRepoExternalOutput(t, effectiveFiles);
      const worktreeWarning = !worktreeIsolation && explicitIsolation ? "Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. Executor must scoped-commit immediately." : !sharedTree && effectiveFiles.length ? worktreeIsolationWarning(slug) : null;
      if (reviewTargetState && worktreeWarning) {
        throw new Error(`prepare dispatch: ${t.ref} cannot pin the immutable candidate checkout. ${worktreeWarning}`);
      }
      if (worktreeWarning) sharedTree = true;
      const runtimeRefusal = sharedTree ? sharedTreeRuntimeRefusal(t, projectPath, opts.runtimeCwd) : null;
      if (runtimeRefusal) throw new Error(runtimeRefusal);
      t.dispatchNonce = mintDispatchToken();
      if (priorTokenFile) {
        try {
          fs.unlinkSync(priorTokenFile);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const category = getCategory(ticketCategory(t), { project: slug });
      const artifactRoot = sharedTree && effectiveFiles.length === 1 && sharedTreeArtifactRequested(t) ? categoryArtifactRoot(category, effectiveFiles[0]) : null;
      const artifactMode = Boolean(artifactRoot);
      const declaredFiles = artifactMode ? effectiveFiles : commitScope.ticketCommitScope(effectiveFiles, t.files, t.ref);
      const artifactScope = artifactMode ? effectiveFiles[0] : null;
      const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
      t.dispatchExecutor = stableExecutorName(t, artifactMode);
      const launchSeq = nextDispatchLaunchSeq(current);
      const story = t.storyId ? getStory(slug, t.storyId) : null;
      const contract = storyExecutionContract(story);
      const storyLogRevision = Number(story?.logRevision) || 0;
      t.storyLogSeenSeq = storyLogRevision;
      const contractDrift = t.storyContractDrift || null;
      const configuredIntegrationMode = String(readMeta(slug)?.integrationMode || "auto").trim().toLowerCase();
      const configuredWorktreeBase = boardConfig(slug)?.worktreeBase || "origin-main";
      const configuredIntegrationBranch = String(readMeta(slug)?.integrationBranch || "main");
      const explicitIntegrationTarget = opts.integrationBranch != null || opts.integrationMode != null;
      const isolatedRepositoryDispatch = !sharedTree && !readonly && !nonRepoOutput;
      const automaticWorktreeBase = isolatedRepositoryDispatch && !explicitIntegrationTarget && configuredIntegrationMode === "auto" ? worktreeBaseIntegrationTarget(slug, configuredWorktreeBase, readMeta(slug)?.path || "", configuredIntegrationBranch) : null;
      const useIntegrationTarget = explicitIntegrationTarget || isolatedRepositoryDispatch && configuredIntegrationMode !== "auto" || Boolean(automaticWorktreeBase);
      const integrationTargetState = explicitIntegrationTarget ? integrationTarget(slug, {
        ...opts.integrationBranch != null ? { branch: opts.integrationBranch } : {},
        ...opts.integrationMode != null ? { mode: opts.integrationMode } : {}
      }) : automaticWorktreeBase || (useIntegrationTarget ? integrationTarget(slug) : null);
      const localAheadWarning = !sharedTree && integrationTargetState ? localAheadOfUpstreamWarning(readMeta(slug)?.path || "", integrationTargetState.branch) : null;
      delete t.storyContractDrift;
      t.dispatch = {
        lifecycleAttempt: prepareAttempt(
          Object.freeze({ revision: Object.freeze({ source: "board", value: String(t.id || t.ref), observedAt: now }), purpose: "dispatch" }),
          Object.freeze({ actor: dispatchPreparationAttribution(opts), operation: "prepare", sessionId: opts.sessionId ? String(opts.sessionId) : null }),
          preparedPluginInstall && preparedPluginIdentity ? Object.freeze({ pluginInstall: preparedPluginInstall, identity: preparedPluginIdentity }) : void 0
        ),
        sessionId: opts.sessionId ? String(opts.sessionId) : null,
        preparedBy: dispatchPreparationAttribution(opts),
        ...preparedPluginInstall && preparedPluginIdentity ? { preparedCompatibility: { pluginInstall: preparedPluginInstall, identity: preparedPluginIdentity } } : {},
        sharedTree,
        ...worktreeWarning ? { worktreeWarning } : {},
        ...pythonIoEncoding.written ? { pythonIoEncoding } : {},
        ...opts.dispatchSkew ? { dispatchSkew: opts.dispatchSkew } : {},
        declaredFiles,
        ...!sharedTree && releasedContinuation?.continuation ? {
          continuation: releasedContinuation.continuation,
          worktree: releasedContinuation.continuation.sourceWorktree,
          worktreeGitDirectory: releasedContinuation.continuation.lease.boundGitDirectory,
          worktreeCommonGitDirectory: releasedContinuation.continuation.lease.boundCommonGitDirectory,
          worktreeCheckoutInstance: releasedContinuation.continuation.lease.boundCheckoutInstance,
          worktreeObservedRevision: releasedContinuation.continuation.lease.boundRevision,
          worktreeBindingSource: "continuation"
        } : {},
        ...releasedContinuation?.fallback ? { continuationFallback: releasedContinuation.fallback } : {},
        ...sharedTree && releasedContinuation?.continuation ? { continuationFallback: continuationFallback("continuation_checkpoint_requires_isolated_worktree", releasedContinuation.continuation.sourceWorktree) } : {},
        // Record the integration target commit so an isolated executor can bring
        // its harness-created worktree forward before changing it.
        baseCommit: reviewTargetState?.candidate.source === "git" ? reviewTargetState.candidate.value : integrationTargetState ? integrationTargetCommit(readMeta(slug)?.path || "", integrationTargetState) : commitScope.headCommit(readMeta(slug)?.path || ""),
        ...reviewTargetState ? { reviewTarget: t.reviewTarget } : {},
        ...integrationTargetState ? { integrationTarget: integrationTargetState } : {},
        ...localAheadWarning ? { localAheadWarning } : {},
        readonly,
        ...noDeclaredFileScope ? {
          unscopedOverride: {
            at: now,
            source: opts.source || opts.transport || "store"
          }
        } : {},
        ...nonRepoOutput ? { nonRepoOutput: true } : {},
        artifactMode,
        artifactRoot,
        artifactScope,
        ...artifactMode ? { artifactDirtyBaseline } : {},
        ...sharedTree ? { dirtyBaseline: artifactDirtyBaseline || captureDirtyBaseline(slug) } : {},
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        tokenFile: newDispatchTokenFile(),
        executor: t.dispatchExecutor,
        description: spawnDescription(t, preparedExec),
        launchSeq,
        launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
        route: dispatchRouteState(t.model, t.effort, preparedExec),
        ...repeatFailure ? {
          repeatFailureOverride: {
            at: now,
            source: opts.source || opts.transport || "store",
            priorAttempts: recentNoCommitAttempts(current).length
          }
        } : {},
        ...unboundAttemptsSkipped ? { unboundAttemptsSkipped: true } : {},
        ...fallbackReason ? { fallbackReason } : {},
        storyContract: contract,
        storyLogRevision,
        ...contractDrift ? { storyContractDrift: Object.assign({}, contractDrift, { rebasedAt: now }) } : {},
        preparedAt: now,
        launchedAt: null,
        boundAt: null,
        claimedAt: null,
        terminalAt: null,
        outcome: "prepared",
        ...attempts.length ? { attempts } : {},
        ...supersededTokens.length ? { supersededTokens: supersededTokens.slice(-8) } : {},
        ...recovery ? { recovery } : {}
      };
      t.lifecycleAttempt = t.dispatch.lifecycleAttempt;
      writeDispatchTokenFile(t);
      stampDispatchEvent(t, "dispatch", now);
      putTicket(slug, t);
      return { ok: true, ticket: t, token: t.dispatchNonce, recovery, ...localAheadWarning ? { warnings: [localAheadWarning.message] } : {} };
    });
  }
  function readDispatchBriefing(slug, idOrRef, token, tokenFile) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return { ok: false, reason: "not_found" };
    const state = dispatchState(ticket);
    const receivedToken = dispatchTokenForRequest(token, tokenFile);
    if (!state || !ticket.dispatchNonce) return { ok: false, reason: "token" };
    if (state.terminalAt) return { ok: false, reason: "stale" };
    if (!dispatchTokenMatches(ticket.dispatchNonce, receivedToken)) {
      return { ok: false, reason: "token" };
    }
    return { ok: true, ticket, token: receivedToken };
  }
  function recordDispatchLaunch(slug, idOrRef, opts) {
    opts = opts || {};
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
        return { ok: false, reason: "not_prepared" };
      }
      const state = dispatchState(t);
      if (!state) return { ok: false, reason: "missing_state" };
      if (state.preparedCompatibility?.pluginInstall) {
        const currentInstall = checkSidequestInstall(readMeta(slug)?.path || "");
        if (!currentInstall.ok || currentInstall.installPath !== state.preparedCompatibility.pluginInstall || currentInstall.identity !== state.preparedCompatibility.identity) {
          return { ok: false, reason: "prepared_compatibility_stale" };
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
      state.agentName = opts.agentName ? String(opts.agentName) : state.agentName || null;
      state.launchedAt = state.launchedAt || now;
      state.outcome = "launched";
      const lifecycle = t.lifecycleAttempt || state.lifecycleAttempt;
      const launchedAttempt = lifecycle?.state === "prepared" ? transitionAttempt(lifecycle, "launch") : lifecycle;
      if (launchedAttempt) {
        if (attemptDiagnostic(launchedAttempt)) return { ok: false, reason: "invalid_lifecycle" };
        t.lifecycleAttempt = launchedAttempt;
        state.lifecycleAttempt = launchedAttempt;
      }
      stampDispatchEvent(t, opts.source || "dispatch", now);
      putTicket(slug, t);
      return { ok: true, ticket: t };
    });
  }
  function terminalRuntimeMatches(state, claim, opts) {
    const sessionId = String(opts?.sessionId || "").trim();
    const executor = String(opts?.executor || "").trim();
    const taskName = String(opts?.taskName || "").trim();
    if (!sessionId || !executor || !taskName) return false;
    if (state?.sessionId !== sessionId || state?.executor !== executor || state?.agentName !== taskName) return false;
    const runtime = claim?.runtime;
    if (runtime && (runtime.sessionId !== sessionId || runtime.executor !== executor || runtime.agentName !== taskName)) return false;
    const agentId = String(opts?.agentId || "").trim();
    const agentName = String(opts?.agentName || "").trim();
    if (agentId && state.agentId && state.agentId !== agentId) return false;
    if (agentName && state.agentName && state.agentName !== agentName) return false;
    return true;
  }
  function claimSnapshot(claim) {
    if (!claim?.by || !claim?.at) return null;
    return { by: claim.by, at: claim.at };
  }
  function recordDispatchAgentFailure(slug, idOrRef, opts) {
    opts = opts || {};
    const failureShape = terminalAgentFailure(opts.error);
    if (!failureShape) return { ok: false, reason: "unrecognized_failure" };
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    const recorded = withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
        return { ok: false, reason: "not_prepared" };
      }
      const state = dispatchState(t);
      if (!state || !["launched", "claimed"].includes(state.outcome) || state.terminalAt) {
        return { ok: false, reason: "not_launched" };
      }
      if (!terminalRuntimeMatches(state, t.claim, opts)) return { ok: false, reason: "runtime_mismatch", ticket: t };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const claim = claimSnapshot(t.claim);
      setDispatchTerminal(t, claim ? "died" : "failed", opts.source || "agent-terminal-failure", {
        slug,
        error: opts.error,
        failureShape
      });
      if (!claim) {
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
      }
      stampDispatchEvent(t, opts.source || "agent-terminal-failure", now);
      putTicket(slug, t);
      return { ok: true, ticket: t, claim, dispatchBindingCleared: !claim };
    });
    if (!recorded?.ok || !recorded.claim || typeof releaseTerminalClaim !== "function") return recorded;
    const released = releaseTerminalClaim(slug, found.id, recorded.claim, opts.source || "agent-terminal-failure");
    return Object.assign({}, recorded, { claimReleased: Boolean(released?.ok), ticket: released?.ticket || recorded.ticket });
  }
  function recoverDispatchQuotaFailure(slug, idOrRef, opts) {
    opts = opts || {};
    const failure = claudeQuotaFailure(opts.error);
    if (!failure) return { ok: false, reason: "unrecognized_failure" };
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== canonicalPreparedDispatchExecutor(t)) {
        return { ok: false, reason: "not_prepared" };
      }
      if (t.claim && t.claim.by) return { ok: false, reason: "claimed" };
      const state = dispatchState(t);
      if (!state || state.outcome !== "launched" || state.terminalAt) return { ok: false, reason: "not_launched" };
      const failedRoute = normalizeRoute(state.route) || normalizeRoute({ model: t.model, effort: t.effort });
      const failedExec = failedRoute && resolveExec(failedRoute.model, failedRoute.effort);
      if (!failedExec || failedExec.backend !== "claude" || failedExec.runsModel !== failure.model) {
        return { ok: false, reason: "signature_route_mismatch" };
      }
      const fallback = resolveCategoryFallback(t.category, failedExec.runsModel);
      if (!fallback) return { ok: false, reason: "no_fallback" };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const failedAttempt = {
        route: { model: failedExec.runsModel, effort: failedRoute.effort },
        executor: state.executor || canonicalPreparedDispatchExecutor(t),
        tokenPrefix: state.tokenPrefix || dispatchTokenPrefix(t.dispatchNonce),
        preparedAt: state.preparedAt || null,
        launchedAt: state.launchedAt || null,
        outcome: "quota_exhausted",
        failureShape: classifyDispatchFailure(opts.error),
        terminalAt: now,
        terminalSource: opts.source || "agent-launch-failure",
        failure: { kind: "claude_quota_exhausted", signature: failure.signature }
      };
      const attempts = (Array.isArray(state.attempts) ? state.attempts : []).concat(failedAttempt).slice(-8);
      const supersededTokens = (Array.isArray(state.supersededTokens) ? state.supersededTokens : []).concat({
        digest: dispatchTokenDigest(t.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        at: now
      }).slice(-8);
      const recovery = {
        kind: "claude_quota_exhausted",
        failedModel: failedExec.runsModel,
        failedEffort: failedRoute.effort,
        fallbackSource: fallback.source,
        model: fallback.model,
        effort: fallback.effort,
        signature: failure.signature,
        at: now
      };
      t.dispatchNonce = mintDispatchToken();
      t.dispatchExecutor = fallback.exec.agent;
      t.model = fallback.model;
      t.effort = fallback.effort;
      t.exec = execProjection(fallback.exec);
      const launchSeq = nextDispatchLaunchSeq(state);
      t.dispatch = {
        sessionId: opts.sessionId ? String(opts.sessionId) : state.sessionId || null,
        preparedBy: dispatchPreparationAttribution(opts),
        sharedTree: state.sharedTree === true,
        declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : effectiveScope(slug, t.files),
        artifactMode: state.artifactMode === true,
        artifactRoot: state.artifactRoot || null,
        artifactScope: state.artifactScope || null,
        ...Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {},
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        executor: t.dispatchExecutor,
        description: spawnDescription(t, fallback.exec),
        launchSeq,
        launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
        route: dispatchRouteState(fallback.model, fallback.effort, fallback.exec),
        storyContract: state.storyContract || storyExecutionContract(t.storyId ? getStory(slug, t.storyId) : null),
        ...state.storyContractDrift ? { storyContractDrift: state.storyContractDrift } : {},
        preparedAt: now,
        launchedAt: null,
        boundAt: null,
        claimedAt: null,
        terminalAt: null,
        outcome: "prepared",
        attempts,
        supersededTokens,
        recovery
      };
      stampDispatchEvent(t, opts.source || "agent-launch-failure", now);
      putTicket(slug, t);
      return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
    });
  }
  function dispatchCreationCandidate(state, sessionId) {
    return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && state.outcome === "launched" && !state.terminalAt && !state.worktree && !state.continuation?.sourceWorktree);
  }
  function bindDispatchWorktreeCreation(slug, sessionId, worktree) {
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    const meta = readMeta(slug);
    if (!normalizedSessionId || !target || !meta?.path) return { ok: false, reason: "missing_binding_facts" };
    const repository = canonicalPath(meta.path);
    const boundWorktree = canonicalPath(target);
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false || state.outcome !== "launched" || state.terminalAt || state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
      const baseline = String(state.baseCommit || "").trim();
      if (baseline) return {
        ok: true,
        ref: candidate.ref,
        baseline,
        repository,
        worktree: boundWorktree,
        creationCompleted: Boolean(state.worktreeCreationCompletedAt),
        expectedGitDirectory: state.worktreeGitDirectory || null,
        expectedCommonGitDirectory: state.worktreeCommonGitDirectory || null,
        expectedCheckoutInstance: state.worktreeCheckoutInstance || null,
        expectedRevision: state.worktreeObservedRevision || null
      };
    }
    for (const candidate of listTickets(slug)) {
      if (!dispatchCreationCandidate(dispatchState(candidate), normalizedSessionId)) continue;
      const result = withTicketLock(slug, candidate.id, () => {
        const ticket = getTicket(slug, candidate.id);
        const state = dispatchState(ticket);
        if (!dispatchCreationCandidate(state, normalizedSessionId)) return { ok: false, reason: "already_bound" };
        const baseline = String(state.baseCommit || "").trim();
        if (!baseline) return { ok: false, reason: "baseline_unavailable" };
        state.worktree = boundWorktree;
        state.worktreeBindingSource = "worktree-create";
        state.worktreeBoundAt = (/* @__PURE__ */ new Date()).toISOString();
        stampDispatchEvent(ticket, "worktree-create-binding", state.worktreeBoundAt);
        putTicket(slug, ticket);
        return { ok: true, ref: ticket.ref, baseline, repository, worktree: boundWorktree };
      });
      if (result?.ok) return result;
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function completeDispatchWorktreeCreation(slug, sessionId, worktree) {
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    if (!normalizedSessionId || !target) return { ok: false, reason: "missing_binding_facts" };
    const boundWorktree = canonicalPath(target);
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false || state.outcome !== "launched" || state.terminalAt || state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
      return withTicketLock(slug, candidate.id, () => {
        const ticket = getTicket(slug, candidate.id);
        const current = dispatchState(ticket);
        if (!current || current.sessionId !== normalizedSessionId || current.sharedTree !== false || current.outcome !== "launched" || current.terminalAt || current.worktreeBindingSource !== "worktree-create" || !current.worktree || canonicalPath(current.worktree) !== boundWorktree) {
          return { ok: false, reason: "dispatch_binding_unavailable" };
        }
        const facts = immutableWorktreeFacts(slug, boundWorktree);
        if (!facts) return { ok: false, reason: "invalid_worktree_binding" };
        const baseline = String(current.baseCommit || "").trim();
        if (!baseline || facts.revision !== baseline) return { ok: false, reason: "worktree_revision_mismatch" };
        if (current.worktreeCreationCompletedAt) {
          const unchanged = canonicalPath(String(current.worktreeGitDirectory || "")) === facts.gitDirectory && canonicalPath(String(current.worktreeCommonGitDirectory || "")) === facts.commonGitDirectory && String(current.worktreeCheckoutInstance || "") === facts.checkoutInstance && String(current.worktreeObservedRevision || "") === facts.revision;
          return unchanged ? { ok: true, alreadyCompleted: true } : { ok: false, reason: "worktree_identity_mismatch" };
        }
        current.worktreeGitDirectory = facts.gitDirectory;
        current.worktreeCommonGitDirectory = facts.commonGitDirectory;
        current.worktreeCheckoutInstance = facts.checkoutInstance;
        current.worktreeObservedRevision = facts.revision;
        current.worktreeCreationCompletedAt = (/* @__PURE__ */ new Date()).toISOString();
        stampDispatchEvent(ticket, "worktree-create-complete", current.worktreeCreationCompletedAt);
        putTicket(slug, ticket);
        return { ok: true, alreadyCompleted: false };
      });
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function recoverDispatchWorktreeCreation(slug, sessionId, worktree, error) {
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    const meta = readMeta(slug);
    if (!normalizedSessionId || !target || !meta?.path) return { ok: false, reason: "missing_binding_facts" };
    const boundWorktree = canonicalPath(target);
    const matches = listTickets(slug).filter((candidate) => {
      const state = dispatchState(candidate);
      return Boolean(state && state.sessionId === normalizedSessionId && state.sharedTree === false && state.outcome === "launched" && !state.terminalAt && state.worktreeBindingSource === "worktree-create" && state.worktree && canonicalPath(state.worktree) === boundWorktree);
    });
    if (matches.length !== 1) return { ok: false, reason: matches.length ? "ambiguous_binding" : "dispatch_binding_unavailable" };
    const terminal = withTicketLock(slug, matches[0].id, () => {
      const ticket = getTicket(slug, matches[0].id);
      const state = dispatchState(ticket);
      if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false || state.outcome !== "launched" || state.terminalAt || state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) {
        return { ok: false, reason: "dispatch_binding_unavailable" };
      }
      const facts = immutableWorktreeFacts(slug, boundWorktree);
      const baseline = String(state.baseCommit || "").trim();
      if (!state.worktreeCreationCompletedAt && facts && baseline && facts.revision === baseline) {
        state.worktreeGitDirectory = facts.gitDirectory;
        state.worktreeCommonGitDirectory = facts.commonGitDirectory;
        state.worktreeCheckoutInstance = facts.checkoutInstance;
        state.worktreeObservedRevision = facts.revision;
        state.worktreeCreationCompletedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
      setDispatchTerminal(ticket, "failed", "worktree-create-recovery", {
        slug,
        error,
        failureShape: "worktree_create_failed"
      });
      ticket.dispatchNonce = null;
      ticket.dispatchExecutor = null;
      stampDispatchEvent(ticket, "worktree-create-recovery");
      putTicket(slug, ticket);
      return { ok: true, ticket };
    });
    if (!terminal?.ok) return terminal;
    const cleanup = reclaimUnclaimedDispatchWorktree(meta.path, dispatchState(terminal.ticket));
    return { ok: true, ticket: terminal.ticket, cleanup };
  }
  function worktreeIdentityKey(worktree) {
    const normalized = canonicalPath(String(worktree || "")).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
  function dispatchesForObservedWorktree(candidates, observedWorktree) {
    if (candidates.length <= 1 || !observedWorktree) return candidates;
    const observed = worktreeIdentityKey(observedWorktree);
    return candidates.filter((candidate) => {
      if (!candidate.worktree) return false;
      const expected = worktreeIdentityKey(candidate.worktree);
      return observed === expected || observed.startsWith(`${expected}/`);
    });
  }
  function dispatchIsolationExpectation(identity) {
    const sessionId = String(identity?.sessionId || "").trim();
    const executor = String(identity?.executor || "").trim();
    const agentId = String(identity?.agentId || "").trim();
    const observedWorktree = String(identity?.observedWorktree || "").trim();
    if (!agentId && !(sessionId && executor)) return null;
    const byAgent = [];
    const bySession = [];
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
          phase: state.terminalAt ? "terminal" : state.outcome === "claimed" ? "claimed" : "bound"
        };
        if (agentId && candidate.agentId === agentId) byAgent.push(candidate);
        else if (!terminalWithoutClaim && sessionId && executor && state.sessionId === sessionId && state.executor === executor && ["launched", "claimed"].includes(state.outcome)) {
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
      matchedBy: matchedByAgentIdentity ? "agent" : "session",
      identityBound: Boolean(agentId && expectation.agentId === agentId),
      dispatchBaseline: expectation.baseCommit,
      phase: expectation.phase,
      expectedWorktree: expectation.worktree,
      expectedGitDirectory: expectation.worktreeGitDirectory,
      expectedCommonGitDirectory: expectation.worktreeCommonGitDirectory,
      expectedCheckoutInstance: expectation.worktreeCheckoutInstance,
      expectedRevision: expectation.worktreeObservedRevision,
      worktreeBindingSource: expectation.worktreeBindingSource
    };
  }
  function dispatchIdentityDiagnosis(identity) {
    const sessionId = String(identity?.sessionId || "").trim();
    const executor = String(identity?.executor || "").trim();
    const agentId = String(identity?.agentId || "").trim();
    const observedWorktree = String(identity?.observedWorktree || "").trim();
    const observed = observedWorktree ? worktreeIdentityKey(observedWorktree) : "";
    const counts = { live: 0, session: 0, sessionExecutor: 0, agent: 0, worktree: 0 };
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || state.terminalAt && !ticket.claim?.by || !["launched", "claimed"].includes(state.outcome)) continue;
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
  function dispatchWorkspace(slug, ticket) {
    const state = dispatchState(ticket);
    const projectPath = readMeta(slug)?.path || null;
    if (!state || !projectPath) return null;
    const baseCommit = String(state.baseCommit || "").trim() || null;
    if (state.sharedTree !== false) return baseCommit ? { root: projectPath, base: baseCommit } : null;
    const agentId = String(state.agentId || "").trim();
    if (!agentId) return null;
    const root = String(state.worktree || "").trim();
    if (!root || !fs.existsSync(root)) return null;
    let base = baseCommit;
    if (!base) {
      try {
        base = integrationTarget(slug)?.upstream || null;
      } catch (_) {
        base = null;
      }
    }
    return base ? { root, base } : null;
  }
  function dispatchDelta(slug, ticket) {
    const workspace = dispatchWorkspace(slug, ticket);
    if (!workspace) return { ok: false, reason: "workspace_unavailable" };
    try {
      const working = commitScope.workingPaths(workspace.root);
      const base = execFileSync("git", ["rev-parse", "--verify", `${workspace.base}^{commit}`], {
        cwd: workspace.root,
        encoding: "utf8",
        windowsHide: true
      }).trim();
      const head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: workspace.root,
        encoding: "utf8",
        windowsHide: true
      }).trim();
      const commits = base === head ? [] : execFileSync("git", ["rev-list", `${base}..${head}`], {
        cwd: workspace.root,
        encoding: "utf8",
        windowsHide: true
      }).trim().split(/\r?\n/).filter(Boolean);
      const committed = commits.length ? commitScope.rangePaths(workspace.root, commits) : [];
      return { ok: true, workspace, working, committed };
    } catch (error) {
      return { ok: false, reason: "git_error", message: error?.message || String(error) };
    }
  }
  function activeSharedTreeClaim(identity) {
    const agentId = String(identity?.agentId || "").trim();
    const executor = String(identity?.executor || "").trim();
    if (!agentId || !executor) return null;
    const matches = [];
    for (const project of listProjects({ all: true })) {
      const projectPath = readMeta(project.slug)?.path || null;
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || state.sharedTree !== true || state.terminalAt || !ticket.claim?.by) continue;
        if (String(state.agentId || "") !== agentId || String(state.executor || "") !== executor) continue;
        matches.push({ ref: ticket.ref, project: project.slug, projectPath });
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function dispatchIdentityAmbiguous(matches, agentName) {
    return matches.length > 1 && (!agentName || matches.some((match) => match.sharedTree === false) || new Set(matches.map((match) => match.slug)).size > 1);
  }
  function dispatchCanBindRuntimeIdentity(state, sessionId, executor, agentId, agentName) {
    if (!state || state.sessionId !== sessionId || state.executor !== executor || !["launched", "claimed"].includes(state.outcome)) return false;
    if (agentName && state.agentName && state.agentName !== agentName) return false;
    if (agentId) return !state.agentId || state.agentId === agentId;
    return Boolean(agentName && state.agentName === agentName);
  }
  function syncClaimRuntimeIdentity(ticket, state) {
    const runtime = ticket?.claim?.runtime;
    if (!runtime || runtime.sessionId !== state?.sessionId || runtime.executor !== state?.executor) return;
    ticket.claim.runtime = {
      sessionId: state.sessionId || null,
      executor: state.executor || null,
      agentId: state.agentId || null,
      agentName: state.agentName || null
    };
  }
  function recordDispatchRuntimeIdentity(slug, state, agentId, agentName, now, worktreeFacts) {
    if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts && (state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== worktreeFacts.worktree)) return false;
    if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts && state.worktreeCreationCompletedAt && (canonicalPath(String(state.worktreeGitDirectory || "")) !== worktreeFacts.gitDirectory || canonicalPath(String(state.worktreeCommonGitDirectory || "")) !== worktreeFacts.commonGitDirectory || String(state.worktreeCheckoutInstance || "") !== worktreeFacts.checkoutInstance || String(state.worktreeObservedRevision || "") !== worktreeFacts.revision)) return false;
    if (agentId) state.agentId = agentId;
    if (agentName) state.agentName = agentName;
    if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts) {
      state.worktree = worktreeFacts.worktree;
      state.worktreeGitDirectory = worktreeFacts.gitDirectory;
      state.worktreeCommonGitDirectory = worktreeFacts.commonGitDirectory;
      state.worktreeCheckoutInstance = worktreeFacts.checkoutInstance;
      state.worktreeObservedRevision = worktreeFacts.revision;
      state.worktreeBoundAt = state.worktreeBoundAt || now || (/* @__PURE__ */ new Date()).toISOString();
    }
    state.boundAt = state.boundAt || now || (/* @__PURE__ */ new Date()).toISOString();
    return true;
  }
  function bindDispatchClaimToken(state, attempt, sessionId, executor, now) {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedExecutor = String(executor || "").trim();
    if (!state || !normalizedSessionId || !normalizedExecutor || !["prepared", "launched"].includes(attempt?.state)) return null;
    const boundAttempt = transitionAttempt(attempt, attempt.state === "prepared" ? "bind_claim_token" : "bind");
    if (attemptDiagnostic(boundAttempt)) return null;
    state.sessionId = normalizedSessionId;
    state.executor = normalizedExecutor;
    state.boundAt = state.boundAt || now || (/* @__PURE__ */ new Date()).toISOString();
    state.bindSource = "claim_token";
    return boundAttempt;
  }
  function bindDispatchAgent(sessionId, executor, agentId, agentName, worktree) {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedExecutor = String(executor || "").trim();
    const normalizedAgentId = String(agentId || "").trim();
    const normalizedAgentName = String(agentName || "").trim();
    const normalizedWorktree = String(worktree || "").trim();
    if (!normalizedSessionId || !normalizedExecutor || !normalizedAgentId && !normalizedAgentName) {
      return { ok: false, reason: "missing_identity" };
    }
    let matches = [];
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
        matches.push({ slug: project.slug, id: ticket.id, sharedTree: state.sharedTree, state });
      }
    }
    if (normalizedWorktree) {
      const completedWorktreeMatches = matches.filter((match) => {
        const completed = completedWorktreeCreationFacts(match.state);
        return match.state.sharedTree === false && !match.state.continuation?.sourceWorktree && match.state.worktreeBindingSource === "worktree-create" && completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree);
      });
      if (completedWorktreeMatches.length) matches = completedWorktreeMatches;
    }
    if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
      return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
    }
    const tickets = [];
    for (const match of matches) {
      const reportsParentCheckout = match.sharedTree === false && normalizedWorktree && reportsRegisteredProjectCheckout(match.slug, normalizedWorktree);
      const result = withTicketLock(match.slug, match.id, () => {
        const t = getTicket(match.slug, match.id);
        const state = dispatchState(t);
        if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
          return { ok: false };
        }
        if (state.sharedTree === false && normalizedWorktree && !state.continuation?.sourceWorktree && (state.worktreeBindingSource !== "worktree-create" || !state.worktree)) {
          return { ok: false, reason: "worktree_binding_unavailable" };
        }
        const completedTargetFacts = reportsParentCheckout ? completedWorktreeCreationFacts(state) : null;
        const worktreeFacts = reportsParentCheckout ? completedTargetFacts ? immutableWorktreeFacts(match.slug, completedTargetFacts.worktree) : null : state.sharedTree === false && normalizedWorktree ? immutableWorktreeFacts(match.slug, normalizedWorktree) : null;
        if (reportsParentCheckout && !completedTargetFacts) {
          return { ok: false, reason: "worktree_binding_unavailable" };
        }
        if (state.sharedTree === false && normalizedWorktree && !state.continuation?.sourceWorktree && !worktreeFacts) {
          return { ok: false, reason: "invalid_worktree_binding" };
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (!recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now, worktreeFacts)) {
          return { ok: false, reason: "worktree_binding_mismatch" };
        }
        const lifecycle = t.lifecycleAttempt || state.lifecycleAttempt;
        const launchedAttempt = lifecycle?.state === "prepared" ? transitionAttempt(lifecycle, "launch") : lifecycle;
        const boundAttempt = launchedAttempt?.state === "launched" ? transitionAttempt(launchedAttempt, "bind") : launchedAttempt;
        if (boundAttempt) {
          if (attemptDiagnostic(boundAttempt)) return { ok: false };
          t.lifecycleAttempt = boundAttempt;
          state.lifecycleAttempt = boundAttempt;
        }
        syncClaimRuntimeIdentity(t, state);
        stampDispatchEvent(t, "subagent-start", now);
        putTicket(match.slug, t);
        return { ok: true, ticket: t };
      });
      if (!result || !result.ok) return { ok: false, reason: result?.reason || "not_found" };
      tickets.push(result.ticket);
    }
    return { ok: true, ticket: tickets[0], tickets };
  }
  function dispatchMatchesStopIdentity(state, sessionId, executor, agentId, agentName) {
    if (!state || state.sessionId !== sessionId || state.executor !== executor) return false;
    if (state.bindSource === "claim_token" && !state.agentId) return true;
    if (agentName && state.agentName !== agentName) return false;
    if (!agentId) return agentName ? state.agentName === agentName : true;
    if (state.agentId) return state.agentId === agentId;
    return Boolean(agentName && state.agentName === agentName);
  }
  function terminalAttemptMatchesStopIdentity(state, sessionId, executor, agentId, agentName) {
    const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
    return attempts.find((attempt) => {
      if (!attempt?.terminalAt || attempt.sessionId !== sessionId || attempt.executor !== executor) return false;
      if (agentName && attempt.agentName !== agentName) return false;
      if (!agentId) return Boolean(agentName && attempt.agentName === agentName);
      if (attempt.agentId) return attempt.agentId === agentId;
      return Boolean(agentName && attempt.agentName === agentName);
    }) || null;
  }
  function markDispatchStopped(sessionId, executor, agentId, agentName) {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedExecutor = String(executor || "").trim();
    const normalizedAgentId = String(agentId || "").trim();
    const normalizedAgentName = String(agentName || "").trim();
    if (!normalizedSessionId || !normalizedExecutor) return { ok: false, reason: "missing_identity" };
    const matches = [];
    const terminalAttempts = [];
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        const terminalAttempt = ticket.claim?.by ? null : terminalAttemptMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName);
        if (terminalAttempt) terminalAttempts.push({ ref: ticket.ref, outcome: terminalAttempt.outcome, agentName: terminalAttempt.agentName });
        if (!dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
        const active = state.outcome === "prepared" || state.outcome === "launched" || state.outcome === "claimed";
        if (active || state.terminalAt) matches.push({ slug: project.slug, id: ticket.id, sharedTree: state.sharedTree });
      }
    }
    if (!matches.length && terminalAttempts.length === 1) {
      return { ok: true, stopped: false, tickets: [], terminalAttempts };
    }
    if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
      return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
    }
    const tickets = [];
    let stopped = false;
    for (const match of matches) {
      const result = withTicketLock(match.slug, match.id, () => {
        const t = getTicket(match.slug, match.id);
        const state = dispatchState(t);
        const active = Boolean(state && ["prepared", "launched", "claimed"].includes(state.outcome));
        if (!state || !active && !state.terminalAt || !dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
          return { ok: false, reason: "not_found" };
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (normalizedAgentId || normalizedAgentName) {
          recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now);
        }
        if (active && state.outcome === "launched" && !(t.claim && t.claim.by)) {
          setDispatchTerminal(t, "failed", "subagent-stop", { slug: match.slug, failureShape: "stopped_before_claim" });
          t.dispatchNonce = null;
          t.dispatchExecutor = null;
          stopped = true;
        } else if (active) {
          state.turnEndedAt = now;
        }
        stampDispatchEvent(t, "subagent-stop", now);
        putTicket(match.slug, t);
        return { ok: true, ticket: t, stopped, turnEnded: active };
      });
      if (!result || !result.ok) return { ok: false, reason: "not_found" };
      stopped = stopped || result.stopped;
      tickets.push(result.ticket);
    }
    return { ok: true, ticket: tickets[0], tickets, stopped };
  }
  function reconcileLaunchedDispatches(sessionId, opts) {
    const reconciled = [];
    if (!sessionId) return { ok: true, reconciled };
    const source = opts && opts.source ? String(opts.source) : "session-start";
    for (const project of listProjects({ all: true })) {
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || state.sessionId !== String(sessionId) || state.outcome !== "launched" || state.boundAt || ticket.claim && ticket.claim.by) continue;
        const res = withTicketLock(project.slug, ticket.id, () => {
          const t = getTicket(project.slug, ticket.id);
          const current = dispatchState(t);
          if (!current || current.sessionId !== String(sessionId) || current.outcome !== "launched" || current.boundAt || t.claim && t.claim.by) {
            return { ok: false };
          }
          setDispatchTerminal(t, "failed", source, { slug: project.slug });
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
    supersedableUnclaimedLaunch,
    supersedeUnclaimedLaunch,
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
    refreshPreparedDispatches,
    expiredPreparedDispatch,
    worktreeIsolationWarning,
    prepareDispatch,
    readDispatchBriefing,
    recordDispatchLaunch,
    recordDispatchAgentFailure,
    recoverDispatchQuotaFailure,
    bindDispatchWorktreeCreation,
    completeDispatchWorktreeCreation,
    recoverDispatchWorktreeCreation,
    dispatchIdentityDiagnosis,
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
  };
}
module.exports = { createDispatch, unscopedWriteCannotAutoApprove };
