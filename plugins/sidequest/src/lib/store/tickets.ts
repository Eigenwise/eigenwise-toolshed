'use strict';

function createTickets(dependencies: any) {
  const {
    EXECUTOR_ANCHORS_MAX, EXECUTOR_VERIFY_MAX, acquireLock, assetPath, assetsDir, boardConfig,
    claimReclaimable, coerceComplexity, coercePriority, commitScope, copyAsset, createComment,
    database, deleteCachedRow, dispatchState, effectiveScope, execFileSync, executorText, fs,
    getTicket, listTickets, makeWorkedBy, newTicketId, nextSeq, path, pendingSubmission, putTicket,
    queryTickets, queueEventNotification, readyTickets, releaseLock, reopenScopePausedDispatch,
    requestedReadonlyOverride, requireStatus, requireVerifyCommand, saveAssetData, stripLinksTo,
    ticketLockPath, ticketStoryId, touchClaimActivity, upperRef, withTicketLock,
  } = dependencies;
  const coerceStoryId = ticketStoryId;

function categoryReadOnly(ticket?: any) {
  return ticket?.category?.readonly === true;
}

function readOnlyOverrideActive(ticket?: any) {
  return typeof ticket?.readonlyOverride === 'boolean';
}

function dispatchReadOnly(ticket?: any) {
  return typeof ticket?.readonlyOverride === 'boolean' ? ticket.readonlyOverride : categoryReadOnly(ticket);
}

function createTicket(slug?: any, fields?: any) {
  fields = fields || {};
  const status = fields.status === undefined ? 'todo' : requireStatus(fields.status);
  const id = newTicketId();
  const seq = nextSeq(slug);
  const now = new Date().toISOString();

  const assets: any[] = [];
  const imgs = Array.isArray(fields.images) ? fields.images : [];
  for (const src of imgs) {
    try {
      assets.push(copyAsset(slug, id, src));
    } catch (e: any) {
      // Record which image could not be attached; the CLI surfaces this.
      if (fields.onAssetError) fields.onAssetError(src, e);
    }
  }
  for (const d of asDataImages(fields.imagesData)) {
    try {
      assets.push(saveAssetData(slug, id, d.name, d.buffer));
    } catch (_: any) {
      /* skip a bad upload */
    }
  }

  requireVerifyCommand(fields.executorVerify);
  const ticket = {
    id,
    ref: `SQ-${seq}`,
    title: String(fields.title || 'Untitled').trim().slice(0, 300) || 'Untitled',
    description: String(fields.description || '').trim(),
    status,
    priority: coercePriority(fields.priority, 'normal'),
    labels: boundedLabels(fields.labels),
    highStakes: !!fields.highStakes,
    storyId: coerceStoryId(slug, fields.storyId), // the user story this ticket belongs to (null = none)
    category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
    complexity: coerceComplexity(fields.complexity), // 1..10 score the routing is derived from (entry points require it)
    complexityWhy: String(fields.complexityWhy || '').trim().slice(0, 1000), // the mandatory motivation for the score
    files: boundedFiles(fields.files),          // declared file scope, for parallel-wave planning
    contracts: boundedContracts(fields.contracts), // declared contract edges, for parallel-wave planning
    contractWaiver: !!fields.contractWaiver,
    readonlyOverride: requestedReadonlyOverride(fields),
    executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors'),
    executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command'),
    assets,
    comments: [],              // [{ id, by, body, kind: 'comment', at }]
    links: [],                 // [{ type: 'blocks'|'blocked-by'|'related', ref }]
    claim: null,               // { by, at } when an agent has claimed it to work on
    checkpoint: null,
    dispatchNonce: null,
    dispatchExecutor: null,
    directClaim: null,
    assignee: normalizeAssignee(fields.assignee), // who it's assigned to (usually the human "you"); distinct from an agent claim
    archived: false,           // hidden from the board (kept, restorable) once true
    archivedAt: null,
    source: String(fields.source || 'manual'),
    // Who/what last touched this ticket, and how. The dashboard uses these to
    // decide whether a change was made by the user (source "dashboard") or by
    // Claude/the CLI in the background, and whether it was a status change.
    lastEventType: 'created',
    lastEventSource: String(fields.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    referenceUpdatedAt: now,
    order: Date.now(),
  };
  putTicket(slug, ticket);
  queueEventNotification(slug, ticket, 'created', ticket.lastEventSource);
  return ticket;
}

// Decode an optional [{ name, base64 }] list (dashboard image paste/drop) into
// [{ name, buffer }]. Data-URL prefixes are stripped. Bad entries are dropped.
function asDataImages(list?: any) {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const d of list) {
    if (!d || typeof d.base64 !== 'string') continue;
    const b64 = d.base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length) out.push({ name: d.name, buffer });
    } catch (_: any) {
      /* skip */
    }
  }
  return out;
}

function normalizeLabels(labels?: any) {
  if (!labels) return [];
  const arr = Array.isArray(labels) ? labels : String(labels).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const l of arr) {
    const v = String(l).trim().slice(0, 40);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

// A ticket's declared file scope drives wave planning and gates repository commits
// submitted through the Sidequest executor path. Normalizing never drops entries:
// a truncated scope silently un-approves paths the caller declared, and the commit
// gate then refuses them as out of scope (SQ-900). List bounds belong on the write
// path, where the caller can be told to re-scope.
function normalizeFiles(files?: any) {
  if (!files) return [];
  const arr = Array.isArray(files) ? files : String(files).split(',');
  const seen = new Set();
  const out: any[] = [];
  for (const f of arr) {
    const v = String(f).trim().replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

const DECLARED_FILES_MAX = 100;
const CONTRACT_NAMES_MAX = 40;
const LABELS_MAX = 24;

function boundedList(values?: any, max?: any, label?: any, guidance?: any) {
  if (values.length > max) {
    throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
  }
  return values;
}

function boundedFiles(files?: any) {
  return boundedList(
    normalizeFiles(files),
    DECLARED_FILES_MAX,
    'declared file scope',
    'Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file).',
  );
}

function boundedLabels(labels?: any) {
  return boundedList(normalizeLabels(labels), LABELS_MAX, 'labels', 'Labels route and filter work; drop the ones that do neither.');
}

function scopeExpansionFiles(ticket?: any, additions?: any) {
  return normalizeFiles([...(Array.isArray(ticket?.files) ? ticket.files : []), ...normalizeFiles(additions)]);
}

function approvedScopeRequestFiles(ticket?: any, files?: any) {
  const request = ticket?.scopeRequest;
  const pending = normalizeFiles(request?.files);
  if (!pending.length) return null;
  const next = boundedFiles(files);
  const pendingScope = scopeExpansionFiles(ticket, pending);
  const requestedScope = scopeExpansionFiles(ticket, request?.requested || pending);
  if (!sameFiles(next, pendingScope) && !sameFiles(next, requestedScope)) return null;
  return requestedScope;
}

function clearCoveredScopeRequest(slug?: any, ticket?: any, now?: any) {
  const request = ticket?.scopeRequest;
  if (!request || !normalizeFiles(request.files).every((file?: any) => commitScope.isInScope(file, effectiveScope(slug, ticket.files)))) return false;
  clearScopeRequestMarker(slug, ticket);
  const dispatch = dispatchState(ticket);
  const resumed = reopenScopePausedDispatch(ticket, now);
  ticket.scopeRequest = null;
  if (dispatch && (!dispatch.terminalAt || resumed)) {
    dispatch.declaredFiles = ticket.files.slice();
    delete dispatch.scopeRequest;
  }
  return true;
}

// For an isolated run, declared scope IS ticket.files; the dispatch snapshot
// exists for terminal forensics. Commit enforcement reads the snapshot, so
// letting the two diverge gates the executor against a set nobody can see or
// repair. Shared-tree dispatches are excluded on purpose: their authority
// (artifact mode, artifact root, and the scope encoding it) is pinned at
// dispatch time precisely so a mid-run ticket edit cannot flip it.
function syncLiveDispatchScope(ticket?: any) {
  const dispatch = dispatchState(ticket);
  if (dispatch && dispatch.sharedTree === false && !dispatch.terminalAt) dispatch.declaredFiles = normalizeFiles(ticket?.files);
}

// A control-plane scope edit is itself the ruling on any pending request: the
// requested paths now inside the updated scope are granted, the rest refused.
// Leaving the request pending after such an edit created an unrecoverable run —
// it could never be re-filed (already covered) and never approved (nothing
// pending covers it), while the dispatch snapshot stayed stale.
function resolveScopeRequestAgainstUpdate(slug?: any, ticket?: any, patch?: any, now?: any) {
  const request = ticket?.scopeRequest;
  if (!request) return;
  const caller = String(patch?.by || '').trim();
  if (!caller || caller === ticket?.claim?.by) return;
  const scope = effectiveScope(slug, ticket.files);
  const requested = normalizeFiles(request.files);
  const granted = requested.filter((file?: any) => commitScope.isInScope(file, scope));
  const refused = requested.filter((file?: any) => !commitScope.isInScope(file, scope));
  clearScopeRequestMarker(slug, ticket);
  const resumed = reopenScopePausedDispatch(ticket, now);
  ticket.scopeRequest = null;
  const dispatch = dispatchState(ticket);
  if (dispatch && (!dispatch.terminalAt || resumed)) delete dispatch.scopeRequest;
  if (!Array.isArray(ticket.comments)) ticket.comments = [];
  const grantedText = granted.length ? `granted ${granted.join(', ')}` : 'granted none of the requested paths';
  const refusedText = refused.length ? `; not granted: ${refused.join(', ')} (outside the updated scope)` : '';
  const comment = createComment({
    by: caller,
    body: `Scope request resolved by scope update: ${grantedText}${refusedText}. Declared scope is now: ${normalizeFiles(ticket.files).join(', ') || '(none)'}.`,
    kind: 'comment',
    source: patch?.source || 'cli',
  }, now);
  ticket.comments.push(comment);
  queueEventNotification(slug, ticket, 'comment', comment.source, { commentBody: comment.body });
}

function scopeExpansionCommand(ticket?: any, additions?: any) {
  const ref = String(ticket?.ref || '').trim();
  if (!ref) return null;
  return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(','))}`;
}

function pendingScopeApprovalWarning(ticket?: any) {
  const requested = normalizeFiles(ticket?.scopeRequest?.files);
  if (!requested.length) return null;
  const command = scopeExpansionCommand(ticket, requested);
  return `Scope request remains pending for ${requested.join(', ')}. This update did not cover every requested path; approve the full request with \`${command}\`.`;
}

function scopeRequestMarkerFile(ticket?: any) {
  return `scope-request-${String(ticket?.id || 'ticket').replace(/[^a-z0-9_-]/gi, '_')}.json`;
}

function pluginRoot(file?: any) {
  const match = /^plugins\/([^/]+)(?:\/|$)/i.exec(String(file || '').replace(/\\/g, '/'));
  return match ? `plugins/${match[1]}` : null;
}

function pluginTestDirectory(file?: any) {
  const match = /^(plugins\/[^/]+)\/test(?:\/|$)/i.exec(String(file || '').replace(/\\/g, '/'));
  return match ? `${match[1]}/test` : null;
}

function autoApprovedPluginTestScope(ticket?: any, requested?: any, additions?: any, slug?: any) {
  if (!boardConfig(slug)?.autoApprovePluginTests) return null;
  const declaredRoots = new Set((ticket?.files || []).map(pluginRoot).filter(Boolean).map((root: any) => root.toLowerCase()));
  const requestedTestDirectories = normalizeFiles(requested).map(pluginTestDirectory);
  if (!requestedTestDirectories.length || requestedTestDirectories.some((directory?: any) => !directory || !declaredRoots.has(pluginRoot(directory)!.toLowerCase()))) return null;
  return normalizeFiles(normalizeFiles(additions).map(pluginTestDirectory).filter(Boolean));
}

// The marker is a recovery breadcrumb, never a gate. A scope request is pure
// board state; an unbound dispatch (agentId/boundAt null) or unreachable
// worktree must not make filing it impossible for executor and orchestrator
// alike, which is exactly what a fail-closed marker did.
function createScopeRequestMarker(slug?: any, ticket?: any, request?: any) {
  const dispatch = dispatchState(ticket);
  if (!dispatch || dispatch.sharedTree !== false) return;
  const worktree = String(dispatch.worktree || '').trim();
  if (!worktree) return;
  try {
    const root = commitScope.repoRoot(worktree);
    const linked = commitScope.linkedWorktree(root);
    if (!linked.ok || !linked.linked) return;
    fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
    fs.writeFileSync(assetPath(slug, ticket.id, scopeRequestMarkerFile(ticket)), JSON.stringify({
      ref: ticket.ref,
      by: request.by,
      files: request.files,
      requested: request.requested,
      covered: request.covered,
      at: request.at,
    }) + '\n');
  } catch (_) {}
}

function clearScopeRequestMarker(slug?: any, ticket?: any) {
  try { fs.unlinkSync(assetPath(slug, ticket.id, scopeRequestMarkerFile(ticket))); } catch (_) {}
  const worktree = String(ticket?.scopeRequest?.markerWorktree || '').trim();
  if (!worktree) return;
  const marker = path.join(worktree, '.sidequest', scopeRequestMarkerFile(ticket));
  const relativeMarker = path.relative(worktree, marker).replace(/\\/g, '/');
  try { execFileSync('git', ['reset', '--quiet', '--', relativeMarker], { cwd: worktree, windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  try { fs.unlinkSync(marker); } catch (_) {}
  try { fs.rmdirSync(path.dirname(marker)); } catch (_) {}
}

function scopePauseRecoveryAsset(ticket?: any) {
  return `scope-pause-${String(ticket?.id || 'ticket').replace(/[^a-z0-9_-]/gi, '_')}.patch`;
}

function noIndexDiff(worktree?: any, relativePath?: any) {
  try {
    return execFileSync('git', ['diff', '--binary', '--no-index', '--', '/dev/null', relativePath], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error: any) {
    return String(error?.stdout || '');
  }
}

function captureScopePauseRecovery(slug?: any, ticket?: any) {
  const dispatch = dispatchState(ticket);
  const worktree = String(dispatch?.worktree || ticket?.scopeRequest?.markerWorktree || '').trim();
  if (!worktree || !fs.existsSync(worktree)) return null;
  let patch = '';
  try {
    patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).sidequest/**'], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (_) {
    return null;
  }
  try {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true,
    }).split('\0');
    for (const file of untracked) {
      const relative = file.replace(/\\/g, '/');
      if (!relative || relative === '.sidequest' || relative.startsWith('.sidequest/')) continue;
      patch += noIndexDiff(worktree, relative);
    }
  } catch (_) {}
  if (!patch.trim()) return null;
  const asset = scopePauseRecoveryAsset(ticket);
  try {
    fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
    fs.writeFileSync(assetPath(slug, ticket.id, asset), patch);
    if (!Array.isArray(ticket.assets)) ticket.assets = [];
    if (!ticket.assets.includes(asset)) ticket.assets.push(asset);
    ticket.scopePauseRecovery = { asset, at: new Date().toISOString(), worktree };
    return ticket.scopePauseRecovery;
  } catch (_) {
    return null;
  }
}

function requestScope(slug?: any, idOrRef?: any, by?: any, files?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'agent');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const held = t.claim;
    // Closeout-adjacent: the holder asking for scope is proof of life, never
    // something a clock may refuse.
    if (!held || !held.by) return { ok: false, reason: 'not_claimed', ticket: t };
    if (held.by !== by && !opts.force) return { ok: false, reason: 'not_owner', ticket: t, claim: held };
    const requested = normalizeFiles(files);
    if (!requested.length) return { ok: false, reason: 'files_required', ticket: t };
    const validation = commitScope.validateRelativeScopes(requested);
    if (!validation.ok) return { ok: false, reason: 'invalid_scope', ticket: t, paths: validation.outside };
    const scope = effectiveScope(slug, t.files);
    const additions = requested.filter((file?: any) => !commitScope.isInScope(file, scope));
    const covered = requested.filter((file?: any) => commitScope.isInScope(file, scope));
    const now = new Date().toISOString();
    touchClaimActivity(t, by, now);
    if (!additions.length) {
      clearCoveredScopeRequest(slug, t, now);
      t.updatedAt = now;
      putTicket(slug, t);
      return { ok: true, ticket: t, covered, scopeRequest: null, command: null };
    }
    const testDirectories = autoApprovedPluginTestScope(t, requested, additions, slug);
    if (testDirectories) {
      // Test-only widening is audited here; publish reverify runs it before the integrated-diff review.
      t.files = boundedFiles(scopeExpansionFiles(t, testDirectories));
      const dispatch = dispatchState(t);
      if (dispatch && !dispatch.terminalAt) dispatch.declaredFiles = t.files.slice();
      if (!Array.isArray(t.comments)) t.comments = [];
      const comment = createComment({
        by: 'board',
        body: `Auto-approved test scope under board policy: ${testDirectories.join(', ')}.`,
        kind: 'comment',
        source: 'policy',
      }, now);
      t.comments.push(comment);
      t.lastEventType = 'scope_auto_approved';
      t.lastEventSource = 'policy';
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
      return { ok: true, ticket: t, covered, approved: testDirectories, autoApproved: true, scopeRequest: null, command: null, comment };
    }
    const command = scopeExpansionCommand(t, requested);
    const request = { by, files: additions, requested, covered, at: now };
    createScopeRequestMarker(slug, t, request);
    t.scopeRequest = request;
    const dispatch = dispatchState(t);
    if (dispatch && !dispatch.terminalAt) dispatch.scopeRequest = t.scopeRequest;
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment({
      by,
      body: `Scope expansion requested: ${additions.join(', ')}.${covered.length ? ` Already in scope: ${covered.join(', ')}.` : ''} Approve with \`${command}\`; claim remains held.`,
      kind: 'comment',
      source: opts.source || 'cli',
    }, now);
    t.comments.push(comment);
    t.lastEventType = 'scope_request';
    t.lastEventSource = opts.source || 'cli';
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, scopeRequest: t.scopeRequest, command, comment };
  });
}

function denyScopeRequest(slug?: any, idOrRef?: any, by?: any, reason?: any, opts?: any) {
  opts = opts || {};
  by = String(by || 'orchestrator').trim() || 'orchestrator';
  reason = String(reason || '').trim();
  if (!reason) throw new Error('scope-deny reason is required');
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    const request = t.scopeRequest;
    if (!request) return { ok: false, reason: 'no_scope_request', ticket: t };
    const now = new Date().toISOString();
    const denied = {
      by,
      reason,
      files: normalizeFiles(request.files),
      requested: normalizeFiles(request.requested || request.files),
      covered: normalizeFiles(request.covered),
      at: now,
    };
    clearScopeRequestMarker(slug, t);
    const dispatch = dispatchState(t);
    const resumed = reopenScopePausedDispatch(t, now);
    t.scopeRequest = null;
    if (dispatch && (!dispatch.terminalAt || resumed)) delete dispatch.scopeRequest;
    syncLiveDispatchScope(t);
    if (!Array.isArray(t.comments)) t.comments = [];
    const comment = createComment({
      by,
      // State the scope that is actually in force: a deny can follow a partial
      // files edit, and "unchanged" then contradicts the ruling above it.
      body: `Scope expansion denied: ${reason}. Declared scope is now: ${normalizeFiles(t.files).join(', ') || '(none)'}; commit within it or release the ticket if it cannot complete the work.`,
      kind: 'comment',
      source: opts.source || 'cli',
    }, now);
    t.comments.push(comment);
    t.lastEventType = 'scope_denied';
    t.lastEventSource = opts.source || 'cli';
    t.updatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, 'comment', comment.source, { commentBody: comment.body });
    return { ok: true, ticket: t, denied, comment };
  });
}

// Do two declared scopes collide? A path conflicts with an equal path or with
// one that is a directory-prefix of it (case-insensitive, "/"-normalized).
// Empty scopes never conflict mechanically — "no declaration" means "no
// information", and the skill tells the orchestrator how to treat that.
function overlappingScopePaths(filesA?: any, filesB?: any) {
  const a = normalizeFiles(filesA);
  const b = normalizeFiles(filesB);
  const overlaps = new Map();
  for (const x of a) {
    for (const y of b) {
      const left = x.toLowerCase();
      const right = y.toLowerCase();
      const overlap = left === right ? x : (left.startsWith(right + '/') ? x : (right.startsWith(left + '/') ? y : null));
      if (overlap) overlaps.set(overlap.toLowerCase(), overlap);
    }
  }
  return Array.from(overlaps.values()).sort((left?: any, right?: any) => left.localeCompare(right));
}

function scopesOverlap(filesA?: any, filesB?: any) {
  return overlappingScopePaths(filesA, filesB).length > 0;
}

const CONTRACT_EDGE_KINDS = ['produces', 'changes', 'consumes'];

function normalizeContractNames(values?: any) {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : String(values).split(',');
  const seen = new Set();
  const normalized: any[] = [];
  for (const value of entries) {
    const name = String(value).trim().slice(0, 200);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      normalized.push(name);
    }
  }
  return normalized;
}

function normalizeContracts(contracts?: any) {
  const source = contracts && typeof contracts === 'object' ? contracts : {};
  return Object.fromEntries(CONTRACT_EDGE_KINDS.map((kind) => [kind, normalizeContractNames(source[kind])]));
}

function boundedContracts(contracts?: any) {
  const normalized = normalizeContracts(contracts);
  for (const kind of CONTRACT_EDGE_KINDS) {
    boundedList(normalized[kind], CONTRACT_NAMES_MAX, `contract ${kind}`, 'Name the shared interfaces the wave planner sequences on, not every symbol they touch.');
  }
  return normalized;
}

function contractNamesByLowerCase(values?: any) {
  return new Map(normalizeContractNames(values).map((value?: any) => [value.toLowerCase(), value]));
}

function contractCollisionReasons(left?: any, right?: any) {
  if (!left || !right || left.contractWaiver || right.contractWaiver) return [];
  const leftContracts = normalizeContracts(left.contracts);
  const rightContracts = normalizeContracts(right.contracts);
  const reasons: any[] = [];
  const matchingNames = (a?: any, b?: any) => {
    const matches: any[] = [];
    for (const [key, name] of contractNamesByLowerCase(a)) {
      if (contractNamesByLowerCase(b).has(key)) matches.push(name);
    }
    return matches.sort((a?: any, b?: any) => a.localeCompare(b));
  };
  for (const contract of matchingNames(leftContracts.produces, rightContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${left.ref} produces ${contract}, which ${right.ref} consumes.` });
  }
  for (const contract of matchingNames(rightContracts.produces, leftContracts.consumes)) {
    reasons.push({ contract, type: 'produces-consumes', message: `${right.ref} produces ${contract}, which ${left.ref} consumes.` });
  }
  for (const contract of matchingNames(leftContracts.changes, rightContracts.changes)) {
    reasons.push({ contract, type: 'changes-changes', message: `${left.ref} and ${right.ref} both change ${contract}.` });
  }
  return reasons;
}

function ticketsConflict(left?: any, right?: any) {
  return scopesOverlap(left.files, right.files) || contractCollisionReasons(left, right).length > 0;
}

function orderReadyTicketsByContractDependencies(tickets?: any) {
  const ordered = Array.isArray(tickets) ? tickets : [];
  const edges = new Map(ordered.map((ticket?: any) => [ticket.id, new Set()]));
  for (const producer of ordered) {
    if (producer.contractWaiver) continue;
    const produced = contractNamesByLowerCase(normalizeContracts(producer.contracts).produces);
    for (const consumer of ordered) {
      if (producer.id === consumer.id || consumer.contractWaiver) continue;
      const consumed = contractNamesByLowerCase(normalizeContracts(consumer.contracts).consumes);
      const dependencies = edges.get(producer.id);
      if (dependencies && [...produced.keys()].some((name?: any) => consumed.has(name))) dependencies.add(consumer.id);
    }
  }
  const pending = new Set(ordered.map((ticket?: any) => ticket.id));
  const result: any[] = [];
  while (pending.size) {
    const next = ordered.find((ticket?: any) => {
      if (!pending.has(ticket.id)) return false;
      for (const [from, targets] of edges) {
        if (pending.has(from) && targets.has(ticket.id)) return false;
      }
      return true;
    }) || ordered.find((ticket?: any) => pending.has(ticket.id));
    result.push(next);
    pending.delete(next.id);
  }
  return result;
}

function contractMetadata(ticket?: any) {
  const contracts = normalizeContracts(ticket && ticket.contracts);
  return {
    produces: contracts.produces,
    changes: contracts.changes,
    consumes: contracts.consumes,
    waiver: !!(ticket && ticket.contractWaiver),
  };
}

// Partition the ready set into waves an orchestrator can fan out one wave at a
// time: within a wave no two tickets' declared scopes or named contracts
// conflict. Greedy first-fit in priority order, so wave 1 is "start these now",
// wave 2 "after wave 1", etc. Tickets with no declarations never mechanically
// conflict.
function readyWaves(slug?: any, opts?: any) {
  const ready = orderReadyTicketsByContractDependencies(readyTickets(slug, opts));
  const waves: any[] = [];
  for (const t of ready) {
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((w?: any) => ticketsConflict(w, t))) {
        wave.push(t);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([t]);
  }
  return waves;
}

function readyWaveDependencies(slug?: any, opts?: any) {
  const waves = readyWaves(slug, opts);
  const dependencies: any[] = [];
  for (let waveIndex = 1; waveIndex < waves.length; waveIndex++) {
    for (const ticket of waves[waveIndex]) {
      for (let priorWave = 0; priorWave < waveIndex; priorWave++) {
        for (const earlier of waves[priorWave]) {
          for (const reason of contractCollisionReasons(earlier, ticket)) {
            dependencies.push({ before: earlier.ref, after: ticket.ref, contract: reason.contract, type: reason.type, reason: reason.message });
          }
        }
      }
    }
  }
  return dependencies;
}

// An assignee is a free-form name (the human "you", or an agent). Empty/blank
// clears it back to null (unassigned).
function normalizeAssignee(v?: any) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  return s || null;
}

function updateDoneRefusal(ticket?: any) {
  if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket)) {
    return `${ticket.ref} is claimed. Use done/completeTicket for eligible non-repo or artifact work; scoped repository work must commit and submit.`;
  }
  if (pendingSubmission(ticket)) {
    return `${ticket.ref} has a pending submission. Complete it through the integration lifecycle; update --status done cannot consume submitted work.`;
  }
  const state = dispatchState(ticket);
  if (ticket.dispatchNonce || (state && !state.terminalAt)) {
    return `${ticket.ref} has an active dispatch. Its executor must use done/completeTicket or commit and submit; update --status done cannot bypass that lifecycle.`;
  }
  if (state) {
    return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work; use the control-plane grooming closure with evidence.`;
  }
  return null;
}

// update --status <anything but done> on a ticket with a pending submission
// used to apply silently, leaving the submission in place: the ticket looked
// reopened but the next claim still refused it as already-submitted (SQ-1010).
// Reopening past a pending submission needs the explicit reject, not a status
// patch that quietly strands it.
function updateReopenRefusal(ticket?: any, nextStatus?: any) {
  if (!pendingSubmission(ticket)) return null;
  const commit = String(ticket.submission.commit || '').slice(0, 12);
  return `${ticket.ref} has a pending submission (commit ${commit}) parked READY_FOR_INTEGRATION. update cannot move it to "${nextStatus}" and leave the submission in place — the next claim would still refuse it as already-submitted. Reject it first: \`sidequest submit ${ticket.ref} --clear --status ${nextStatus}\` (MCP \`submit\` with \`clear:true, status:"${nextStatus}"\`), or integrate it through the publish flow.`;
}

function sameFiles(left?: any, right?: any) {
  const normalizedLeft = normalizeFiles(left);
  const normalizedRight = normalizeFiles(right);
  const rightFiles = new Set(normalizedRight.map((file: any) => file.toLowerCase()));
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((file: any) => rightFiles.has(file.toLowerCase()));
}

function activeClaimScopeRefusal(ticket?: any, files?: any, patch?: any) {
  if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
  const current = normalizeFiles(ticket.files);
  const next = boundedFiles(files);
  if (sameFiles(current, next)) return null;
  const request = ticket.scopeRequest;
  if (request && approvedScopeRequestFiles(ticket, next)) return null;
  const caller = String(patch?.by || '').trim();
  if (caller && caller !== ticket.claim.by) return null;
  const claimedSession = String(dispatchState(ticket)?.sessionId || '').trim();
  const callerSession = String(patch?.sessionId || '').trim();
  if (callerSession && claimedSession && callerSession !== claimedSession) return null;
  const currentFiles = new Set(current.map((file: any) => file.toLowerCase()));
  const nextFiles = new Set(next.map((file: any) => file.toLowerCase()));
  const refused = [
    ...next.filter((file: any) => !currentFiles.has(file.toLowerCase())),
    ...current.filter((file: any) => !nextFiles.has(file.toLowerCase())),
  ];
  const refusal = `${ticket.ref}: refusing active-claim scope change for ${refused.join(', ')}.`;
  if (!caller) {
    return `${refusal} Re-run \`sidequest update ${ticket.ref} --files <paths> --by <your-id>\` using your own control-plane identity (MCP \`update\` with \`by:"<your-id>"\`).`;
  }
  return `${refusal} Use \`sidequest scope-request ${ticket.ref} --file <path> --by ${ticket.claim.by}\` to request approval.`;
}

// Apply a partial update. Only known fields are written; unknown keys ignored.
// Locked (like every other mutator) so a concurrent comment/claim/link append
// can never be silently overwritten by an update whose read predates it.
function updateTicket(slug?: any, idOrRef?: any, patch?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return null;
  patch = patch || {};
  const apply = (t?: any) => {
    const nextStatus = patch.status == null ? null : requireStatus(patch.status);
    const doneRefusal = nextStatus === 'done' ? updateDoneRefusal(t) : null;
    if (doneRefusal) throw new Error(doneRefusal);
    const reopenRefusal = nextStatus != null && nextStatus !== 'done' ? updateReopenRefusal(t, nextStatus) : null;
    if (reopenRefusal) throw new Error(reopenRefusal);
    const prevStatus = t.status;
    if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
    if (patch.description != null) t.description = String(patch.description).trim();
    if (patch.status != null) t.status = nextStatus;
    if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
    if (patch.labels != null) t.labels = boundedLabels(patch.labels);
    if (patch.highStakes !== undefined) t.highStakes = !!patch.highStakes;
    if (patch.storyId !== undefined) t.storyId = coerceStoryId(slug, patch.storyId);
    if (patch.category !== undefined) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
    // Complexity can move to another valid score, never clear; a fresh motivation
    // rides along whenever one is provided (the CLI demands one on change).
    if (patch.complexity !== undefined) { const c = coerceComplexity(patch.complexity); if (c) t.complexity = c; }
    if (patch.complexityWhy !== undefined && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1000);
    if (patch.files !== undefined) {
      const scopeRefusal = activeClaimScopeRefusal(t, patch.files, patch);
      if (scopeRefusal) throw new Error(scopeRefusal);
      const approvedFiles = approvedScopeRequestFiles(t, patch.files);
      t.files = approvedFiles || boundedFiles(patch.files);
      const scopeEditAt = new Date().toISOString();
      if (!clearCoveredScopeRequest(slug, t, scopeEditAt)) resolveScopeRequestAgainstUpdate(slug, t, patch, scopeEditAt);
      syncLiveDispatchScope(t);
    }
    if (patch.contracts !== undefined) t.contracts = boundedContracts(patch.contracts);
    if (patch.contractWaiver !== undefined) t.contractWaiver = !!patch.contractWaiver;
    if (patch.readonly !== undefined || patch.readonlyOverride !== undefined) t.readonlyOverride = requestedReadonlyOverride(patch);
    if (patch.executorAnchors !== undefined) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, 'executor anchors');
    if (patch.executorVerify !== undefined) {
      requireVerifyCommand(patch.executorVerify);
      t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, 'executor verify command');
    }
    // A provenance stamp may ride along a patch (e.g. the dashboard completing a
    // ticket). Permissive like the routing fields above: a valid stamp is set, a
    // bad one is ignored rather than thrown (the data layer never crashes a write).
    if (patch.workedBy !== undefined) {
      try { const w = makeWorkedBy(patch.workedBy); if (w) t.workedBy = w; } catch (_: any) { /* ignore an invalid stamp on a patch */ }
    }
    if (patch.assignee !== undefined) t.assignee = normalizeAssignee(patch.assignee);
    if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    // Attach any newly supplied images (by path from the CLI, or base64 from the
    // dashboard). Also allow removing an attached asset by filename.
    const imgs = Array.isArray(patch.images) ? patch.images : [];
    for (const src of imgs) {
      try {
        t.assets.push(copyAsset(slug, t.id, src));
      } catch (e: any) {
        if (patch.onAssetError) patch.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(patch.imagesData)) {
      try {
        t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
      } catch (_: any) {
        /* skip */
      }
    }
    if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
      const drop = new Set(patch.removeAssets.map((f?: any) => path.basename(String(f))));
      t.assets = t.assets.filter((a?: any) => {
        if (!drop.has(a)) return true;
        try {
          fs.unlinkSync(assetPath(slug, t.id, a));
        } catch (_: any) {
          /* ignore */
        }
        return false;
      });
    }
    // Record the event: a status move vs. a plain edit, and who made it. Source
    // defaults to "cli" (the CLI / a subagent), so only the dashboard tags itself.
    t.lastEventType = t.status !== prevStatus ? 'status' : 'edit';
    t.lastEventSource = patch.source ? String(patch.source) : 'cli';
    const now = new Date().toISOString();
    if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
    t.updatedAt = now;
    t.referenceUpdatedAt = now;
    putTicket(slug, t);
    queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
    return t;
  };
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock); // best-effort: still applies the update if contention outlasts the retries
  try {
    const t = getTicket(slug, found.id); // fresh read, under the lock when we have it
    if (!t) return null;
    return apply(t);
  } finally {
    if (locked) releaseLock(lock);
  }
}

// Locked so a delete can never yank the ticket/lock file out from under a
// concurrent addComment/claimTicket that still believes it holds the lock.
function deleteTicket(slug?: any, idOrRef?: any) {
  const found = getTicket(slug, idOrRef);
  if (!found) return false;
  const deletedRef = found.ref;
  const lock = ticketLockPath(slug, found.id);
  const locked = acquireLock(lock);
  let ok = false;
  try {
    ok = deleteCachedRow(database(), 'tickets', found.id);
    if (ok) {
      try {
        fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
      } catch (_: any) {
        /* best effort */
      }
    }
  } finally {
    if (locked) releaseLock(lock); // also removes the lock file itself
  }
  if (!ok) return false;
  // Drop any links other tickets had pointing at the one we just removed, so no
  // dangling "blocked-by SQ-deleted" leaves a ticket falsely blocked forever.
  try {
    for (const other of listTickets(slug)) {
      if (Array.isArray(other.links) && other.links.some((l?: any) => upperRef(l.ref) === upperRef(deletedRef))) {
        stripLinksTo(slug, other.id, deletedRef);
      }
    }
  } catch (_: any) {
    /* best effort */
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Archiving: put finished work out of the way without deleting it
 *
 *  An archived ticket is kept (and fully restorable) but hidden from the board,
 *  the counts, and `next`. This is how "clear out the Done column" works without
 *  losing the record.
 * ------------------------------------------------------------------ */

function setArchived(slug?: any, idOrRef?: any, archived?: any, opts?: any) {
  opts = opts || {};
  const found = getTicket(slug, idOrRef);
  if (!found) return { ok: false, reason: 'not_found' };
  return withTicketLock(slug, found.id, () => {
    const t = getTicket(slug, found.id);
    if (!t) return { ok: false, reason: 'not_found' };
    t.archived = !!archived;
    t.archivedAt = archived ? new Date().toISOString() : null;
    t.lastEventType = archived ? 'archived' : 'restored';
    t.lastEventSource = opts.source ? String(opts.source) : 'cli';
    t.updatedAt = new Date().toISOString();
    putTicket(slug, t);
    return { ok: true, ticket: t };
  });
}

function archiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, true, opts);
}
function unarchiveTicket(slug?: any, idOrRef?: any, opts?: any) {
  return setArchived(slug, idOrRef, false, opts);
}

// Archive every done, not-yet-archived ticket in a project. Returns the refs.
function archiveAllDone(slug?: any, opts?: any) {
  const refs: any[] = [];
  for (const ticket of queryTickets(String(slug || ''), { status: 'done', archived: false })) {
    const result = setArchived(slug, ticket.id, true, opts);
    if (result.ok) refs.push(result.ticket.ref);
  }
  return { ok: true, archived: refs };
}

function listArchived(slug?: any) {
  return queryTickets(String(slug || ''), { archived: true });
}
function listActive(slug?: any) {
  return queryTickets(String(slug || ''), { archived: false });
}

  return { DECLARED_FILES_MAX, CONTRACT_NAMES_MAX, LABELS_MAX, categoryReadOnly, readOnlyOverrideActive, dispatchReadOnly, createTicket, normalizeLabels, normalizeFiles, scopeExpansionFiles, scopeExpansionCommand, pendingScopeApprovalWarning, clearScopeRequestMarker, captureScopePauseRecovery, requestScope, denyScopeRequest, overlappingScopePaths, scopesOverlap, normalizeContracts, contractCollisionReasons, contractMetadata, readyWaves, readyWaveDependencies, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}

module.exports = { createTickets };
