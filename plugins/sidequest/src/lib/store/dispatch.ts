'use strict';

function createDispatch(dependencies: any) {
  const { ARTIFACT_BASELINE_MAX_PATHS, SHARED_TREE_ARTIFACT_MARKER, assertDispatchTransport, assertSidequestInstall, availableRoute, claimReclaimable, claimVerification, classifyDispatchFailure, terminalAgentFailure, commitScope, crypto, database, db, dispatchReadOnly, dispatchVerifyCommandError, dispatchRouteRefusal, dispatchRouteState, effectiveScope, execFileSync, execProjection, fs, getCategory, getStory, homeRoot, integrationTarget, integrationTargetCommit, legacyCategoryForComplexity, listProjects, listTickets, nonRepoExternalOutput, normalizeArtifactRoots, normalizeFiles, normalizeRoute, normalizeWorktreeIsolation, path, preferredWorktreeIntegrationTarget, agentWorktreePath, agentWorktreeCandidates, resolvedAgentWorktree, preparedDispatchTtlMs, putTicket, readMeta, releaseTerminalClaim, resolveCategoryFallback, resolveCategoryRoute, resolveTicketRoute, resolveExec, stableExecutorName, storyExecutionContract, ticketCategory, ticketStorageRow, withTicketLock, normalizeCategoryId, projectRoutingEnabled, routingDisabledMessage, getTicket, dispatchLaunchName, nextDispatchLaunchSeq, spawnDescription, claudeQuotaFailure } = dependencies;

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

function executorClaimDispatchRefusal(slug?: any, sessionId?: any) {
  const callerSessionId = String(sessionId || '').trim();
  if (!callerSessionId) return null;
  for (const ticket of listTickets(slug)) {
    const state = dispatchState(ticket);
    const dispatchingSessionId = String(state?.preparedBy?.sessionId || '').trim();
    if (!ticket?.claim?.by || !state || state.terminalAt || state.sessionId !== callerSessionId || dispatchingSessionId === callerSessionId || claimReclaimable(ticket)) continue;
    return `dispatch: dispatch is orchestrator-owned while you hold ${ticket.ref}. File the follow-up with \`add\`, link it to ${ticket.ref}, report the new ref in your submission comment, and the orchestrator will dispatch it.`;
  }
  return null;
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

function artifactWorkingState(slug?: any) {
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
  if (states.length > ARTIFACT_BASELINE_MAX_PATHS) {
    throw new Error(`artifact dirty baseline exceeds ${ARTIFACT_BASELINE_MAX_PATHS} paths`);
  }
  return states
    .map((entry) => {
      const indexState = execFileSync('git', ['ls-files', '--stage', '-z', '--', entry.file], {
        cwd: meta.path,
        encoding: 'utf8',
        windowsHide: true,
      });
      const identity = crypto.createHash('sha256')
        .update(JSON.stringify({
          status: entry.status,
          index: indexState,
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
    return artifactWorkingState(slug);
  } catch (_) {
    return null;
  }
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

function supersedableUnclaimedLaunch(ticket?: any, state?: any) {
  return Boolean(
    state
    && state.outcome === 'launched'
    && state.launchedAt
    && !state.terminalAt
    && !state.boundAt
    && !state.agentId
    && !state.claimedAt
    && !(ticket?.claim && ticket.claim.by)
    && !ticket?.checkpoint
    && ticket?.dispatchNonce,
  );
}

function supersedeUnclaimedLaunch(slug?: any, idOrRef?: any, opts?: any) {
  const evidence = String(opts?.evidence || '').trim();
  if (!evidence) return { ok: false, reason: 'recovery_evidence_required', message: 'Superseding an unclaimed launch requires observed failure evidence.' };
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const ticket = getTicket(slug, found.id);
    const state = dispatchState(ticket);
    if (!supersedableUnclaimedLaunch(ticket, state)) return { ok: false, reason: 'unclaimed_launch_not_supersedable', ticket };
    setDispatchTerminal(ticket, 'failed', opts?.source || 'control-plane-unclaimed-launch-supersession', { failureShape: 'unclaimed_launch_superseded' });
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
    tokenPrefix: state.tokenPrefix || null,
    preparedAt: state.preparedAt || null,
    launchedAt: state.launchedAt || null,
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

function setDispatchTerminal(ticket?: any, outcome?: any, source?: any, opts?: any) {
  const state = dispatchState(ticket);
  if (!state) return;
  const at = new Date().toISOString();
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

function refreshPreparedDispatches(handle?: any, projects?: any, categoryIds?: any) {
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
      const active = Boolean(state.launchedAt || state.boundAt || state.claimedAt || (ticket.claim && ticket.claim.by));
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
        executor: state.executor || ticket.dispatchExecutor,
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

function recentNoCommitAttempts(state?: any) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const recent: any[] = [];
  const rounds = new Set<string>();
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt?.terminalAt || attempt.release?.kind === 'handback') continue;
    const round = String(attempt.preparedAt || attempt.tokenPrefix || attempt.terminalAt);
    if (rounds.has(round)) continue;
    rounds.add(round);
    recent.unshift(attempt);
    if (recent.length === 2) break;
  }
  return recent.length === 2 && recent.every((attempt?: any) => attempt.outcome !== 'submitted' && !attempt.commit) ? recent : [];
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
    return `prepare dispatch: ${ticket.ref} has two isolated no-commit dispatches (${recordedAttempts}) that failed to find the app or service. Check for repository bind mounts or unavailable paths, then set worktreeIsolation:false or dispatch with sharedTree:true. Pass allowRepeatFailure:true to override this block; the override is recorded.`;
  }
  const repeatedContradictions = attempts.every((attempt?: any) => attempt.release?.kind === 'contradiction');
  if (repeatedContradictions) {
    return `prepare dispatch: ${ticket.ref} has two contradiction releases (${recordedAttempts}). The ticket premise is likely wrong, not the executor environment. Measure the claim, then rewrite the ticket before dispatching again; pass allowRepeatFailure:true only when a repeat is intentional.`;
  }
  return `prepare dispatch: ${ticket.ref} has two prior terminal no-commit dispatches (${recordedAttempts}). Review the recorded release reasons, correct the ticket when they show a contradiction, then dispatch with allowRepeatFailure:true when a repeat is intentional.`;
}

function worktreeIsolationWarning(slug?: any) {
  const meta = readMeta(slug);
  if (!meta || !meta.path) {
    return 'Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. Executor must scoped-commit immediately.';
  }
  if (!fs.existsSync(meta.path)) {
    return 'Worktree isolation unavailable: project path does not exist; spawning in shared tree. Executor must scoped-commit immediately.';
  }
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: meta.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') {
      return 'Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. Executor must scoped-commit immediately.';
    }
  } catch (error: any) {
    const reason = error && error.code === 'ENOENT' ? 'Git is not available' : 'project is not a Git work tree';
    return `Worktree isolation unavailable: ${reason}; spawning in shared tree. Executor must scoped-commit immediately.`;
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
    return 'Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. Executor must scoped-commit immediately.';
  }
}

function nativeGitPath(value?: any) {
  const input = String(value || '').trim();
  const gitBashPath = process.platform === 'win32' ? /^\/([a-zA-Z])(?=\/|$)/.exec(input) : null;
  return gitBashPath ? `${gitBashPath[1]}:${input.slice(2)}` : input;
}

function canonicalFilesystemPath(value?: any) {
  const resolved = fs.realpathSync.native(path.resolve(nativeGitPath(value)));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalGitDirectory(repository?: any, directory?: any) {
  return canonicalFilesystemPath(path.resolve(String(repository || ''), nativeGitPath(directory)));
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
    .map((worktree: string) => canonicalFilesystemPath(worktree));
}

function registeredAgentWorktree(repository?: any, agentId?: any) {
  const expectedName = `agent-${String(agentId || '').trim()}`;
  if (expectedName === 'agent-') return null;
  try {
    return registeredWorktrees(repository).find((worktree: string) => path.basename(worktree).toLowerCase() === expectedName.toLowerCase()) || null;
  } catch (_: any) {
    return null;
  }
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

function releasedContinuationState(slug?: any, ticket?: any, state?: any) {
  if (!state || state.outcome !== 'released' || !state.terminalAt || state.sharedTree !== false) return null;
  const recordedWorktree = String(state.worktree || '').trim();
  if (!recordedWorktree || !fs.existsSync(recordedWorktree)) {
    return { fallback: continuationFallback('released_worktree_missing', recordedWorktree) };
  }
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const attempt = attempts[attempts.length - 1] || null;
  const checkpointCommit = String(attempt?.commit || '').trim();
  let worktree = recordedWorktree;
  try {
    const projectPath = String(readMeta(slug)?.path || '').trim();
    const projectRoot = canonicalFilesystemPath(gitOutput(projectPath, ['rev-parse', '--show-toplevel']));
    worktree = canonicalFilesystemPath(gitOutput(recordedWorktree, ['rev-parse', '--show-toplevel']));
    const projectGitDirectory = canonicalGitDirectory(projectRoot, gitOutput(projectRoot, ['rev-parse', '--git-common-dir']));
    const worktreeGitDirectory = canonicalGitDirectory(worktree, gitOutput(worktree, ['rev-parse', '--git-common-dir']));
    if (projectGitDirectory !== worktreeGitDirectory) {
      return { fallback: continuationFallback('released_worktree_belongs_to_another_repository', worktree) };
    }
    if (!registeredWorktrees(projectRoot).includes(worktree)) {
      return { fallback: continuationFallback('released_worktree_is_not_registered', worktree) };
    }
    const baseCommit = gitOutput(worktree, ['rev-parse', '--verify', `${state.baseCommit}^{commit}`]);
    const commit = gitOutput(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    gitOutput(worktree, ['merge-base', '--is-ancestor', baseCommit, commit]);
    const commits = gitOutput(worktree, ['rev-list', '--reverse', `${baseCommit}..${commit}`, '--']).split(/\r?\n/).filter(Boolean);
    let sourceBranch = null;
    try { sourceBranch = gitOutput(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch (_: any) {}
    if (gitOutput(worktree, ['status', '--porcelain'])) {
      if (!commits.length) {
        return {
          continuation: {
            mode: 'dirty_worktree_resume',
            ticketRef: ticket.ref,
            sourceWorktree: worktree,
            sourceBranch,
            baseCommit,
            commit,
            clean: false,
            releasedAt: state.terminalAt,
            releaseKind: attempt?.release?.kind || 'release',
          },
        };
      }
      return {
        fallback: continuationFallback('released_worktree_is_dirty', worktree, {
          sourceBranch,
          commit,
          commits,
        }),
      };
    }
    if (!checkpointCommit && attempt?.release?.kind !== 'handback') {
      return { fallback: continuationFallback('release_has_no_checkpoint_or_handback', worktree) };
    }
    if (checkpointCommit && gitOutput(worktree, ['rev-parse', '--verify', `${checkpointCommit}^{commit}`]) !== commit) {
      return { fallback: continuationFallback('checkpoint_is_not_worktree_head', worktree) };
    }
    if (!commits.length) return { fallback: continuationFallback('released_worktree_has_no_committed_progress', worktree) };
    if (commits.length > 128) return { fallback: continuationFallback('released_worktree_commit_range_is_too_large', worktree) };
    return {
      continuation: {
        mode: 'retained_worktree_resume',
        ticketRef: ticket.ref,
        sourceWorktree: worktree,
        sourceBranch,
        baseCommit,
        commit,
        commits,
        clean: true,
        releasedAt: state.terminalAt,
        releaseKind: attempt?.release?.kind || (checkpointCommit ? 'checkpoint' : 'handback'),
      },
    };
  } catch (error: any) {
    return {
      fallback: continuationFallback('released_worktree_git_state_is_unreadable', worktree, {
        cause: gitFailureEvidence(error),
      }),
    };
  }
}

function prepareDispatch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
  // A fresh native Agent session resolves plugins from Claude Code's registry
  // independently of whatever MCP roster this conversation happens to have
  // loaded, so a claim-first spawn spec is worthless unless the target
  // project actually has a runnable, board-MCP-capable install (SQ-1017).
  const projectPath = readMeta(slug)?.path;
  const found = getTicket(slug, idOrRef);
  if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
  const executorClaimRefusal = executorClaimDispatchRefusal(slug, opts.sessionId);
  if (executorClaimRefusal) throw new Error(executorClaimRefusal);
  const initialNoDeclaredFileScope = !dispatchReadOnly(found)
    && Array.isArray(found.contracts?.changes) && found.contracts.changes.length > 0
    && !normalizeFiles(found.files).length;
  if (initialNoDeclaredFileScope && opts.allowUnscoped !== true) {
    throw new Error(`prepare dispatch: ${found.ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to explicitly accept that the executor can block on its first write and end without a submission.`);
  }
  const verifyError = dispatchVerifyCommandError(found, projectPath);
  if (verifyError) throw new Error(verifyError);
  if (projectPath) assertSidequestInstall(projectPath);
  if (opts.recoveryEvidence) {
    const superseded = supersedeUnclaimedLaunch(slug, found.id, {
      evidence: opts.recoveryEvidence,
      source: opts.source || opts.transport || 'dispatch',
    });
    if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${found.ref} has a bound, claimed, checkpointed, or terminal dispatch that cannot be superseded.`}`);
  }
  // Registry install proves a future session; it does not prove THIS
  // invocation's session has the board MCP connected (SQ-1017 correction).
  // Only CLI transport needs to prove anything here — omitted/'mcp' callers
  // are trusted, matching every direct `prepareDispatch` caller that predates
  // this transport concept.
  assertDispatchTransport(opts.transport, { allowUnverifiedTransport: !!opts.allowUnverifiedTransport });
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    const current = dispatchState(t);
    const activeRuntimeAttempt = current && !current.terminalAt && !(t.claim && t.claim.by)
      && Boolean(current.launchedAt || current.boundAt);
    if (activeRuntimeAttempt) {
      const recovery = supersedableUnclaimedLaunch(t, current)
        ? ` It is unbound and unclaimed, so the orchestrator can supersede it in one call: \`sidequest dispatch ${t.ref} --recovery-evidence "<observed failed-claim evidence>"\`.`
        : ' Wait for that executor\'s terminal hook, then dispatch once from the returned todo state; do not mint a replacement token while it is still winding down.';
      throw new Error(`prepare dispatch: ${t.ref} already has a live dispatch attempt (${pulseDispatchState(current)}).${recovery}`);
    }
    const repeatFailure = repeatNoCommitDispatchError(t, current);
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
    const currentExec = currentRoute && resolveExec(currentRoute.model, currentRoute.effort);
    if (current && current.recovery && current.outcome === 'prepared' && t.dispatchNonce && t.dispatchExecutor
      && currentExec && stableExecutorName(t) === t.dispatchExecutor) {
      if (opts.sessionId) current.sessionId = String(opts.sessionId);
      // A record prepared before launch naming existed still has to hand back a
      // usable name, and reusing it must not renumber the sequence.
      if (!current.launchSeq) current.launchSeq = 1;
      if (!current.launchName) current.launchName = dispatchLaunchName(t.ref, t.title, current.launchSeq);
      putTicket(slug, t);
      return {
        ok: true,
        ticket: t,
        token: t.dispatchNonce,
        reused: true,
        recovery: current.recovery,
      };
    }
    if (current && current.recovery && !current.terminalAt && !currentExec) {
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
    const now = new Date().toISOString();
    const backend = availableRoute(t.model);
    if (backend && backend.backend === 'claude' && (t.effort == null || String(t.effort).trim() === '')) {
      t.effort = 'low';
      t.exec = execProjection(resolveExec(t.model, t.effort));
    }
    const refusal = dispatchRouteRefusal({ model: t.model, effort: t.effort });
    if (refusal) throw new Error(refusal);
    const preparedExec = resolveExec(t.model, t.effort);
    if (!preparedExec) throw new Error(`prepare dispatch: ${t.ref} has no executable route.`);
    const noDeclaredFileScope = !dispatchReadOnly(t)
      && Array.isArray(t.contracts?.changes) && t.contracts.changes.length > 0
      && !normalizeFiles(t.files).length;
    if (noDeclaredFileScope && opts.allowUnscoped !== true) {
      throw new Error(`prepare dispatch: ${t.ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to explicitly accept that the executor can block on its first write and end without a submission.`);
    }
    const fallbackReason = !current?.recovery && resolvedPolicy?.fallbackReason || null;
    const recovery = current && current.recovery && activeDispatchRoute(t) ? current.recovery : null;
    const attempts = current && Array.isArray(current.attempts) ? current.attempts.slice() : [];
    const supersededTokens = current && Array.isArray(current.supersededTokens) ? current.supersededTokens.slice() : [];
    if (current && !current.terminalAt && t.dispatchNonce) {
      supersededTokens.push({
        digest: dispatchTokenDigest(t.dispatchNonce),
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        at: now,
      });
    }
    const priorTokenFile = dispatchTokenFile(t);
    t.dispatchNonce = mintDispatchToken();
    if (priorTokenFile) {
      try { fs.unlinkSync(priorTokenFile); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
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
    const releasedBinding = current?.outcome === 'released' && Array.isArray(current.declaredFiles) && current.declaredFiles.length
      ? current.declaredFiles.slice()
      : null;
    const declaredFiles = releasedBinding
      ? Array.from(new Set([...releasedBinding, ...effectiveScope(slug, t.files)]))
      : effectiveScope(slug, t.files);
    const readonly = dispatchReadOnly(t);
    const requestedSharedTree = opts.sharedTree === true || (!Object.hasOwn(opts, 'sharedTree') && Boolean(current?.sharedTree));
    const explicitIsolation = Object.hasOwn(opts, 'sharedTree') && opts.sharedTree === false;
    const readOnlySharedCheckout = readonly
      && declaredFiles.length === 0
      && !sharedTreeArtifactRequested(t)
      && !explicitIsolation;
    const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
    let sharedTree = worktreeIsolation ? requestedSharedTree || readOnlySharedCheckout : true;
    const nonRepoOutput = nonRepoExternalOutput(t, declaredFiles);
    const worktreeWarning = !worktreeIsolation && explicitIsolation
      ? 'Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. Executor must scoped-commit immediately.'
      : (!sharedTree && declaredFiles.length ? worktreeIsolationWarning(slug) : null);
    if (worktreeWarning) sharedTree = true;
    const category = getCategory(ticketCategory(t), { project: slug });
    const artifactRoot = sharedTree && declaredFiles.length === 1 && sharedTreeArtifactRequested(t)
      ? categoryArtifactRoot(category, declaredFiles[0])
      : null;
    const artifactMode = Boolean(artifactRoot);
    const artifactScope = artifactMode ? declaredFiles[0] : null;
    const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
    t.dispatchExecutor = stableExecutorName(t, artifactMode);
    const launchSeq = nextDispatchLaunchSeq(current);
    const story = t.storyId ? getStory(slug, t.storyId) : null;
    const contract = storyExecutionContract(story);
    const contractDrift = t.storyContractDrift || null;
    const configuredIntegrationMode = String(readMeta(slug)?.integrationMode || 'auto').trim().toLowerCase();
    const explicitIntegrationTarget = opts.integrationBranch != null || opts.integrationMode != null;
    const isolatedRepositoryDispatch = !sharedTree && !readonly && !nonRepoOutput;
    const automaticWorktreeBase = isolatedRepositoryDispatch && !explicitIntegrationTarget && configuredIntegrationMode === 'auto'
      ? preferredWorktreeIntegrationTarget(readMeta(slug)?.path || '', String(readMeta(slug)?.integrationBranch || 'main'))
      : null;
    const useIntegrationTarget = explicitIntegrationTarget
      || (isolatedRepositoryDispatch && configuredIntegrationMode !== 'auto')
      || Boolean(automaticWorktreeBase);
    const integrationTargetState = explicitIntegrationTarget
      ? integrationTarget(slug, {
        ...(opts.integrationBranch != null ? { branch: opts.integrationBranch } : {}),
        ...(opts.integrationMode != null ? { mode: opts.integrationMode } : {}),
      })
      : automaticWorktreeBase || (useIntegrationTarget ? integrationTarget(slug) : null);
    delete t.storyContractDrift;
    t.dispatch = {
      sessionId: opts.sessionId ? String(opts.sessionId) : null,
      preparedBy: dispatchPreparationAttribution(opts),
      sharedTree,
      ...(worktreeWarning ? { worktreeWarning } : {}),
      declaredFiles,
      ...(!sharedTree && releasedContinuation?.continuation ? {
        continuation: releasedContinuation.continuation,
        worktree: releasedContinuation.continuation.sourceWorktree,
      } : {}),
      ...(releasedContinuation?.fallback ? { continuationFallback: releasedContinuation.fallback } : {}),
      ...(sharedTree && releasedContinuation?.continuation
        ? { continuationFallback: continuationFallback('continuation_checkpoint_requires_isolated_worktree', releasedContinuation.continuation.sourceWorktree) }
        : {}),
      // Record the integration target commit so an isolated executor can bring
      // its harness-created worktree forward before changing it.
      baseCommit: integrationTargetState
        ? integrationTargetCommit(readMeta(slug)?.path || '', integrationTargetState)
        : commitScope.headCommit(readMeta(slug)?.path || ''),
      ...(integrationTargetState ? { integrationTarget: integrationTargetState } : {}),
      readonly,
      ...(noDeclaredFileScope ? {
        unscopedOverride: {
          at: now,
          source: opts.source || opts.transport || 'store',
        },
      } : {}),
      ...(nonRepoOutput ? { nonRepoOutput: true } : {}),
      artifactMode,
      artifactRoot,
      artifactScope,
      ...(artifactMode ? { artifactDirtyBaseline } : {}),
      ...(sharedTree ? { dirtyBaseline: artifactDirtyBaseline || captureDirtyBaseline(slug) } : {}),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      tokenFile: newDispatchTokenFile(),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, preparedExec),
      launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
      route: dispatchRouteState(t.model, t.effort, preparedExec),
      ...(repeatFailure ? {
        repeatFailureOverride: {
          at: now,
          source: opts.source || opts.transport || 'store',
          priorAttempts: recentNoCommitAttempts(current).length,
        },
      } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
      storyContract: contract,
      ...(contractDrift ? { storyContractDrift: Object.assign({}, contractDrift, { rebasedAt: now }) } : {}),
      preparedAt: now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: 'prepared',
      ...(attempts.length ? { attempts } : {}),
      ...(supersededTokens.length ? { supersededTokens: supersededTokens.slice(-8) } : {}),
      ...(recovery ? { recovery } : {}),
    };
    writeDispatchTokenFile(t);
    stampDispatchEvent(t, 'dispatch', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
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
  return { ok: true, ticket };
}

function recordDispatchLaunch(slug?: any, idOrRef?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== t.dispatchExecutor) {
      return { ok: false, reason: 'not_prepared' };
    }
    const state = dispatchState(t);
    if (!state) return { ok: false, reason: 'missing_state' };
    const now = new Date().toISOString();
    state.sessionId = opts.sessionId ? String(opts.sessionId) : state.sessionId || null;
    state.agentName = opts.agentName ? String(opts.agentName) : state.agentName || null;
    state.launchedAt = state.launchedAt || now;
    state.outcome = 'launched';
    stampDispatchEvent(t, opts.source || 'dispatch', now);
    putTicket(slug, t);
    return { ok: true, ticket: t };
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
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== t.dispatchExecutor) {
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
    if (!t || !t.dispatchNonce || !dispatchTokenMatches(t.dispatchNonce, dispatchTokenForRequest(opts.token, opts.tokenFile)) || opts.executor !== t.dispatchExecutor) {
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
      executor: state.executor || t.dispatchExecutor,
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
      declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : effectiveScope(slug, t.files),
      artifactMode: state.artifactMode === true,
      artifactRoot: state.artifactRoot || null,
      artifactScope: state.artifactScope || null,
      ...(Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {}),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, fallback.exec),
      launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, launchSeq),
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
    stampDispatchEvent(t, opts.source || 'agent-launch-failure', now);
    putTicket(slug, t);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
  });
}

// Answers "was this running agent promised a linked worktree?" for the write
// guard. The harness deletes an isolated worktree when an agent stops with it
// unchanged, so a resumed executor is silently handed the shared checkout.
// Terminal dispatches stay here for their original agent id: that executor no
// longer has a legal write target, and the guard must keep refusing its writes.
// Session fallback deliberately excludes terminal no-claim dispatches so an
// old executor cannot taint a different agent in the same session.
function dispatchIsolationExpectation(identity?: any) {
  const sessionId = String(identity?.sessionId || '').trim();
  const executor = String(identity?.executor || '').trim();
  const agentId = String(identity?.agentId || '').trim();
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
      };
      if (agentId && candidate.agentId === agentId) byAgent.push(candidate);
      else if (!terminalWithoutClaim && sessionId && executor && state.sessionId === sessionId && state.executor === executor) {
        bySession.push(candidate);
      }
    }
  }
  const matched = byAgent.length ? byAgent : bySession;
  if (!matched.length) return null;
  const expectation = matched[0];
  return {
    ref: expectation.ref,
    project: expectation.project,
    projectPath: expectation.projectPath,
    sharedTree: matched.some((candidate) => candidate.sharedTree),
    terminal: matched.some((candidate) => candidate.terminal),
    matchedBy: byAgent.length ? 'agent' : 'session',
    expectedWorktree: agentId && expectation.projectPath
      ? resolvedAgentWorktree(expectation.projectPath, agentId)
      : null,
    expectedWorktrees: agentId && expectation.projectPath
      ? agentWorktreeCandidates(expectation.projectPath, agentId)
      : [],
  };
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
  const root = String(state.worktree || '').trim() || agentWorktreePath(projectPath, agentId);
  if (!fs.existsSync(root)) return null;
  let base = baseCommit;
  if (!base) {
    try { base = integrationTarget(slug)?.upstream || null; } catch (_: any) { base = null; }
  }
  return base ? { root, base } : null;
}

function dispatchDelta(slug?: any, ticket?: any) {
  const workspace = dispatchWorkspace(slug, ticket);
  if (!workspace) return { ok: false, reason: 'workspace_unavailable' };
  try {
    const working = commitScope.workingPaths(workspace.root);
    const base = execFileSync('git', ['rev-parse', '--verify', `${workspace.base}^{commit}`], {
      cwd: workspace.root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: workspace.root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const commits = base === head ? [] : execFileSync('git', ['rev-list', `${base}..${head}`], {
      cwd: workspace.root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim().split(/\r?\n/).filter(Boolean);
    const committed = commits.length ? commitScope.rangePaths(workspace.root, commits) : [];
    return { ok: true, workspace, working, committed };
  } catch (error: any) {
    return { ok: false, reason: 'git_error', message: error?.message || String(error) };
  }
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

function recordDispatchRuntimeIdentity(slug?: any, state?: any, agentId?: any, agentName?: any, now?: any) {
  if (agentId) state.agentId = agentId;
  if (agentName) state.agentName = agentName;
  if (state.sharedTree === false && agentId && !state.continuation?.sourceWorktree) {
    const projectPath = readMeta(slug)?.path;
    if (projectPath) state.worktree = registeredAgentWorktree(projectPath, agentId) || agentWorktreePath(projectPath, agentId);
  }
  state.boundAt = state.boundAt || now || new Date().toISOString();
}

function bindDispatchClaimToken(state?: any, sessionId?: any, executor?: any, now?: any) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedExecutor = String(executor || '').trim();
  if (!state || state.sharedTree !== false || state.agentId || !normalizedSessionId || !normalizedExecutor) return false;
  state.sessionId = normalizedSessionId;
  state.executor = normalizedExecutor;
  state.boundAt = state.boundAt || now || new Date().toISOString();
  state.bindSource = 'claim_token';
  return true;
}

function bindDispatchAgent(sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedExecutor = String(executor || '').trim();
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedAgentName = String(agentName || '').trim();
  if (!normalizedSessionId || !normalizedExecutor || (!normalizedAgentId && !normalizedAgentName)) {
    return { ok: false, reason: 'missing_identity' };
  }
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      matches.push({ slug: project.slug, id: ticket.id, sharedTree: state.sharedTree });
    }
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
  for (const match of matches) {
    const result = withTicketLock(match.slug, match.id, () => {
      const t = getTicket(match.slug, match.id);
      const state = dispatchState(t);
      if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
        return { ok: false };
      }
      const now = new Date().toISOString();
      recordDispatchRuntimeIdentity(match.slug, state, normalizedAgentId, normalizedAgentName, now);
      syncClaimRuntimeIdentity(t, state);
      stampDispatchEvent(t, 'subagent-start', now);
      putTicket(match.slug, t);
      return { ok: true, ticket: t };
    });
    if (!result || !result.ok) return { ok: false, reason: 'not_found' };
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
function markDispatchStopped(sessionId?: any, executor?: any, agentId?: any, agentName?: any) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedExecutor = String(executor || '').trim();
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedAgentName = String(agentName || '').trim();
  if (!normalizedSessionId || !normalizedExecutor) return { ok: false, reason: 'missing_identity' };
  const matches: any[] = [];
  for (const project of listProjects({ all: true })) {
    for (const ticket of listTickets(project.slug)) {
      const state = dispatchState(ticket);
      if (!dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      const active = state.outcome === 'prepared' || state.outcome === 'launched' || state.outcome === 'claimed';
      if (active || state.terminalAt) matches.push({ slug: project.slug, id: ticket.id, sharedTree: state.sharedTree });
    }
  }
  if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
    return { ok: false, reason: matches.length ? 'ambiguous' : 'not_found' };
  }
  const tickets: any[] = [];
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
        setDispatchTerminal(t, 'failed', 'subagent-stop', { failureShape: 'stopped_before_claim' });
        t.dispatchNonce = null;
        t.dispatchExecutor = null;
        stopped = true;
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
        setDispatchTerminal(t, 'failed', source);
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
    reconcileLaunchedDispatches,
  };
}

module.exports = { createDispatch };
