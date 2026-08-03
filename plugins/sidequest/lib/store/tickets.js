"use strict";
function createTickets(dependencies) {
  const {
    EXECUTOR_ANCHORS_MAX,
    EXECUTOR_VERIFY_MAX,
    acquireLock,
    assetPath,
    assetsDir,
    boardConfig,
    claimReclaimable,
    coerceComplexity,
    coercePriority,
    commitScope,
    copyAsset,
    createComment,
    database,
    deleteCachedRow,
    dispatchState,
    effectiveScope,
    execFileSync,
    executorText,
    fs,
    getTicket,
    listTickets,
    makeWorkedBy,
    newTicketId,
    nextSeq,
    path,
    pendingSubmission,
    putTicket,
    queryTickets,
    queueEventNotification,
    readyTickets,
    releaseLock,
    reopenScopePausedDispatch,
    requestedReadonlyOverride,
    requireStatus,
    requireVerifyCommand,
    saveAssetData,
    stripLinksTo,
    ticketLockPath,
    ticketStoryId,
    touchClaimActivity,
    upperRef,
    withTicketLock
  } = dependencies;
  const coerceStoryId = ticketStoryId;
  function categoryReadOnly(ticket) {
    return ticket?.category?.readonly === true;
  }
  function readOnlyOverrideActive(ticket) {
    return typeof ticket?.readonlyOverride === "boolean";
  }
  function dispatchReadOnly(ticket) {
    return typeof ticket?.readonlyOverride === "boolean" ? ticket.readonlyOverride : categoryReadOnly(ticket);
  }
  function createTicket(slug, fields) {
    fields = fields || {};
    const status = fields.status === void 0 ? "todo" : requireStatus(fields.status);
    const id = newTicketId();
    const seq = nextSeq(slug);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const assets = [];
    const imgs = Array.isArray(fields.images) ? fields.images : [];
    for (const src of imgs) {
      try {
        assets.push(copyAsset(slug, id, src));
      } catch (e) {
        if (fields.onAssetError) fields.onAssetError(src, e);
      }
    }
    for (const d of asDataImages(fields.imagesData)) {
      try {
        assets.push(saveAssetData(slug, id, d.name, d.buffer));
      } catch (_) {
      }
    }
    requireVerifyCommand(fields.executorVerify);
    const ticket = {
      id,
      ref: `SQ-${seq}`,
      title: String(fields.title || "Untitled").trim().slice(0, 300) || "Untitled",
      description: String(fields.description || "").trim(),
      status,
      priority: coercePriority(fields.priority, "normal"),
      labels: boundedLabels(fields.labels),
      highStakes: !!fields.highStakes,
      storyId: coerceStoryId(slug, fields.storyId),
      // the user story this ticket belongs to (null = none)
      category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
      complexity: coerceComplexity(fields.complexity),
      // 1..10 score the routing is derived from (entry points require it)
      complexityWhy: String(fields.complexityWhy || "").trim().slice(0, 1e3),
      // the mandatory motivation for the score
      files: boundedFiles(fields.files),
      // declared file scope, for parallel-wave planning
      contracts: boundedContracts(fields.contracts),
      // declared contract edges, for parallel-wave planning
      contractWaiver: !!fields.contractWaiver,
      readonlyOverride: requestedReadonlyOverride(fields),
      executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors"),
      executorVerify: executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command"),
      assets,
      comments: [],
      // [{ id, by, body, kind: 'comment', at }]
      links: [],
      // [{ type: 'blocks'|'blocked-by'|'related', ref }]
      claim: null,
      // { by, at } when an agent has claimed it to work on
      checkpoint: null,
      dispatchNonce: null,
      dispatchExecutor: null,
      directClaim: null,
      assignee: normalizeAssignee(fields.assignee),
      // who it's assigned to (usually the human "you"); distinct from an agent claim
      archived: false,
      // hidden from the board (kept, restorable) once true
      archivedAt: null,
      source: String(fields.source || "manual"),
      // Who/what last touched this ticket, and how. The dashboard uses these to
      // decide whether a change was made by the user (source "dashboard") or by
      // Claude/the CLI in the background, and whether it was a status change.
      lastEventType: "created",
      lastEventSource: String(fields.source || "manual"),
      createdAt: now,
      updatedAt: now,
      referenceUpdatedAt: now,
      order: Date.now()
    };
    putTicket(slug, ticket);
    queueEventNotification(slug, ticket, "created", ticket.lastEventSource);
    return ticket;
  }
  function asDataImages(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const d of list) {
      if (!d || typeof d.base64 !== "string") continue;
      const b64 = d.base64.replace(/^data:[^;]+;base64,/, "");
      try {
        const buffer = Buffer.from(b64, "base64");
        if (buffer.length) out.push({ name: d.name, buffer });
      } catch (_) {
      }
    }
    return out;
  }
  function normalizeLabels(labels) {
    if (!labels) return [];
    const arr = Array.isArray(labels) ? labels : String(labels).split(",");
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const l of arr) {
      const v = String(l).trim().slice(0, 40);
      if (v && !seen.has(v.toLowerCase())) {
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  }
  function normalizeFiles(files) {
    if (!files) return [];
    const arr = Array.isArray(files) ? files : String(files).split(",");
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const f of arr) {
      const v = String(f).trim().replace(/\\/g, "/").replace(/\/+$/, "").slice(0, 200);
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
  function boundedList(values, max, label, guidance) {
    if (values.length > max) {
      throw new Error(`${label} accepts at most ${max} entries; this write declared ${values.length} (${values.length - max} over). ${guidance}`);
    }
    return values;
  }
  function boundedFiles(files) {
    return boundedList(
      normalizeFiles(files),
      DECLARED_FILES_MAX,
      "declared file scope",
      "Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file)."
    );
  }
  function boundedLabels(labels) {
    return boundedList(normalizeLabels(labels), LABELS_MAX, "labels", "Labels route and filter work; drop the ones that do neither.");
  }
  function scopeExpansionFiles(ticket, additions) {
    return normalizeFiles([...Array.isArray(ticket?.files) ? ticket.files : [], ...normalizeFiles(additions)]);
  }
  function approvedScopeRequestFiles(ticket, files) {
    const request = ticket?.scopeRequest;
    const pending = normalizeFiles(request?.files);
    if (!pending.length) return null;
    const next = boundedFiles(files);
    const pendingScope = scopeExpansionFiles(ticket, pending);
    const requestedScope = scopeExpansionFiles(ticket, request?.requested || pending);
    if (!sameFiles(next, pendingScope) && !sameFiles(next, requestedScope)) return null;
    return requestedScope;
  }
  function clearCoveredScopeRequest(slug, ticket, now) {
    const request = ticket?.scopeRequest;
    if (!request || !normalizeFiles(request.files).every((file) => commitScope.isInScope(file, effectiveScope(slug, ticket.files)))) return false;
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
  function syncLiveDispatchScope(ticket) {
    const dispatch = dispatchState(ticket);
    if (dispatch && dispatch.sharedTree === false && !dispatch.terminalAt) dispatch.declaredFiles = normalizeFiles(ticket?.files);
  }
  function resolveScopeRequestAgainstUpdate(slug, ticket, patch, now) {
    const request = ticket?.scopeRequest;
    if (!request) return;
    const caller = String(patch?.by || "").trim();
    if (!caller || caller === ticket?.claim?.by) return;
    const scope = effectiveScope(slug, ticket.files);
    const requested = normalizeFiles(request.files);
    const granted = requested.filter((file) => commitScope.isInScope(file, scope));
    const refused = requested.filter((file) => !commitScope.isInScope(file, scope));
    clearScopeRequestMarker(slug, ticket);
    const resumed = reopenScopePausedDispatch(ticket, now);
    ticket.scopeRequest = null;
    const dispatch = dispatchState(ticket);
    if (dispatch && (!dispatch.terminalAt || resumed)) delete dispatch.scopeRequest;
    if (!Array.isArray(ticket.comments)) ticket.comments = [];
    const grantedText = granted.length ? `granted ${granted.join(", ")}` : "granted none of the requested paths";
    const refusedText = refused.length ? `; not granted: ${refused.join(", ")} (outside the updated scope)` : "";
    const comment = createComment({
      by: caller,
      body: `Scope request resolved by scope update: ${grantedText}${refusedText}. Declared scope is now: ${normalizeFiles(ticket.files).join(", ") || "(none)"}.`,
      kind: "comment",
      source: patch?.source || "cli"
    }, now);
    ticket.comments.push(comment);
    queueEventNotification(slug, ticket, "comment", comment.source, { commentBody: comment.body });
  }
  function scopeExpansionCommand(ticket, additions) {
    const ref = String(ticket?.ref || "").trim();
    if (!ref) return null;
    return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(","))}`;
  }
  function pendingScopeApprovalWarning(ticket) {
    const requested = normalizeFiles(ticket?.scopeRequest?.files);
    if (!requested.length) return null;
    const command = scopeExpansionCommand(ticket, requested);
    return `Scope request remains pending for ${requested.join(", ")}. This update did not cover every requested path; approve the full request with \`${command}\`.`;
  }
  function scopeRequestMarkerFile(ticket) {
    return `scope-request-${String(ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.json`;
  }
  function pluginRoot(file) {
    const match = /^plugins\/([^/]+)(?:\/|$)/i.exec(String(file || "").replace(/\\/g, "/"));
    return match ? `plugins/${match[1]}` : null;
  }
  function pluginTestDirectory(file) {
    const match = /^(plugins\/[^/]+)\/test(?:\/|$)/i.exec(String(file || "").replace(/\\/g, "/"));
    return match ? `${match[1]}/test` : null;
  }
  function autoApprovedPluginTestScope(ticket, requested, additions, slug) {
    if (!boardConfig(slug)?.autoApprovePluginTests) return null;
    const declaredRoots = new Set((ticket?.files || []).map(pluginRoot).filter(Boolean).map((root) => root.toLowerCase()));
    const requestedTestDirectories = normalizeFiles(requested).map(pluginTestDirectory);
    if (!requestedTestDirectories.length || requestedTestDirectories.some((directory) => !directory || !declaredRoots.has(pluginRoot(directory).toLowerCase()))) return null;
    return normalizeFiles(normalizeFiles(additions).map(pluginTestDirectory).filter(Boolean));
  }
  function createScopeRequestMarker(slug, ticket, request) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.sharedTree !== false) return;
    const worktree = String(dispatch.worktree || "").trim();
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
        at: request.at
      }) + "\n");
    } catch (_) {
    }
  }
  function clearScopeRequestMarker(slug, ticket) {
    try {
      fs.unlinkSync(assetPath(slug, ticket.id, scopeRequestMarkerFile(ticket)));
    } catch (_) {
    }
    const worktree = String(ticket?.scopeRequest?.markerWorktree || "").trim();
    if (!worktree) return;
    const marker = path.join(worktree, ".sidequest", scopeRequestMarkerFile(ticket));
    const relativeMarker = path.relative(worktree, marker).replace(/\\/g, "/");
    try {
      execFileSync("git", ["reset", "--quiet", "--", relativeMarker], { cwd: worktree, windowsHide: true, stdio: "ignore" });
    } catch (_) {
    }
    try {
      fs.unlinkSync(marker);
    } catch (_) {
    }
    try {
      fs.rmdirSync(path.dirname(marker));
    } catch (_) {
    }
  }
  function scopePauseRecoveryAsset(ticket) {
    return `scope-pause-${String(ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.patch`;
  }
  function noIndexDiff(worktree, relativePath) {
    try {
      return execFileSync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", relativePath], {
        cwd: worktree,
        encoding: "utf8",
        windowsHide: true
      });
    } catch (error) {
      return String(error?.stdout || "");
    }
  }
  function captureScopePauseRecovery(slug, ticket) {
    const dispatch = dispatchState(ticket);
    const worktree = String(dispatch?.worktree || ticket?.scopeRequest?.markerWorktree || "").trim();
    if (!worktree || !fs.existsSync(worktree)) return null;
    let patch = "";
    try {
      patch = execFileSync("git", ["diff", "--binary", "HEAD", "--", ".", ":(exclude).sidequest/**"], {
        cwd: worktree,
        encoding: "utf8",
        windowsHide: true
      });
    } catch (_) {
      return null;
    }
    try {
      const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: worktree,
        encoding: "utf8",
        windowsHide: true
      }).split("\0");
      for (const file of untracked) {
        const relative = file.replace(/\\/g, "/");
        if (!relative || relative === ".sidequest" || relative.startsWith(".sidequest/")) continue;
        patch += noIndexDiff(worktree, relative);
      }
    } catch (_) {
    }
    if (!patch.trim()) return null;
    const asset = scopePauseRecoveryAsset(ticket);
    try {
      fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
      fs.writeFileSync(assetPath(slug, ticket.id, asset), patch);
      if (!Array.isArray(ticket.assets)) ticket.assets = [];
      if (!ticket.assets.includes(asset)) ticket.assets.push(asset);
      ticket.scopePauseRecovery = { asset, at: (/* @__PURE__ */ new Date()).toISOString(), worktree };
      return ticket.scopePauseRecovery;
    } catch (_) {
      return null;
    }
  }
  function requestScope(slug, idOrRef, by, files, opts) {
    opts = opts || {};
    by = String(by || "agent");
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      const held = t.claim;
      if (!held || !held.by) return { ok: false, reason: "not_claimed", ticket: t };
      if (held.by !== by && !opts.force) return { ok: false, reason: "not_owner", ticket: t, claim: held };
      const requested = normalizeFiles(files);
      if (!requested.length) return { ok: false, reason: "files_required", ticket: t };
      const validation = commitScope.validateRelativeScopes(requested);
      if (!validation.ok) return { ok: false, reason: "invalid_scope", ticket: t, paths: validation.outside };
      const scope = effectiveScope(slug, t.files);
      const additions = requested.filter((file) => !commitScope.isInScope(file, scope));
      const covered = requested.filter((file) => commitScope.isInScope(file, scope));
      const now = (/* @__PURE__ */ new Date()).toISOString();
      touchClaimActivity(t, by, now);
      if (!additions.length) {
        clearCoveredScopeRequest(slug, t, now);
        t.updatedAt = now;
        putTicket(slug, t);
        return { ok: true, ticket: t, covered, scopeRequest: null, command: null };
      }
      const testDirectories = autoApprovedPluginTestScope(t, requested, additions, slug);
      if (testDirectories) {
        t.files = boundedFiles(scopeExpansionFiles(t, testDirectories));
        const dispatch2 = dispatchState(t);
        if (dispatch2 && !dispatch2.terminalAt) dispatch2.declaredFiles = t.files.slice();
        if (!Array.isArray(t.comments)) t.comments = [];
        const comment2 = createComment({
          by: "board",
          body: `Auto-approved test scope under board policy: ${testDirectories.join(", ")}.`,
          kind: "comment",
          source: "policy"
        }, now);
        t.comments.push(comment2);
        t.lastEventType = "scope_auto_approved";
        t.lastEventSource = "policy";
        t.updatedAt = now;
        putTicket(slug, t);
        queueEventNotification(slug, t, "comment", comment2.source, { commentBody: comment2.body });
        return { ok: true, ticket: t, covered, approved: testDirectories, autoApproved: true, scopeRequest: null, command: null, comment: comment2 };
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
        body: `Scope expansion requested: ${additions.join(", ")}.${covered.length ? ` Already in scope: ${covered.join(", ")}.` : ""} Approve with \`${command}\`; claim remains held.`,
        kind: "comment",
        source: opts.source || "cli"
      }, now);
      t.comments.push(comment);
      t.lastEventType = "scope_request";
      t.lastEventSource = opts.source || "cli";
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
      return { ok: true, ticket: t, scopeRequest: t.scopeRequest, command, comment };
    });
  }
  function denyScopeRequest(slug, idOrRef, by, reason, opts) {
    opts = opts || {};
    by = String(by || "orchestrator").trim() || "orchestrator";
    reason = String(reason || "").trim();
    if (!reason) throw new Error("scope-deny reason is required");
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      const request = t.scopeRequest;
      if (!request) return { ok: false, reason: "no_scope_request", ticket: t };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const denied = {
        by,
        reason,
        files: normalizeFiles(request.files),
        requested: normalizeFiles(request.requested || request.files),
        covered: normalizeFiles(request.covered),
        at: now
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
        body: `Scope expansion denied: ${reason}. Declared scope is now: ${normalizeFiles(t.files).join(", ") || "(none)"}; commit within it or release the ticket if it cannot complete the work.`,
        kind: "comment",
        source: opts.source || "cli"
      }, now);
      t.comments.push(comment);
      t.lastEventType = "scope_denied";
      t.lastEventSource = opts.source || "cli";
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
      return { ok: true, ticket: t, denied, comment };
    });
  }
  function overlappingScopePaths(filesA, filesB) {
    const a = normalizeFiles(filesA);
    const b = normalizeFiles(filesB);
    const overlaps = /* @__PURE__ */ new Map();
    for (const x of a) {
      for (const y of b) {
        const left = x.toLowerCase();
        const right = y.toLowerCase();
        const overlap = left === right ? x : left.startsWith(right + "/") ? x : right.startsWith(left + "/") ? y : null;
        if (overlap) overlaps.set(overlap.toLowerCase(), overlap);
      }
    }
    return Array.from(overlaps.values()).sort((left, right) => left.localeCompare(right));
  }
  function scopesOverlap(filesA, filesB) {
    return overlappingScopePaths(filesA, filesB).length > 0;
  }
  const CONTRACT_EDGE_KINDS = ["produces", "changes", "consumes"];
  function normalizeContractNames(values) {
    if (!values) return [];
    const entries = Array.isArray(values) ? values : String(values).split(",");
    const seen = /* @__PURE__ */ new Set();
    const normalized = [];
    for (const value of entries) {
      const name = String(value).trim().slice(0, 200);
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        normalized.push(name);
      }
    }
    return normalized;
  }
  function normalizeContracts(contracts) {
    const source = contracts && typeof contracts === "object" ? contracts : {};
    return Object.fromEntries(CONTRACT_EDGE_KINDS.map((kind) => [kind, normalizeContractNames(source[kind])]));
  }
  function boundedContracts(contracts) {
    const normalized = normalizeContracts(contracts);
    for (const kind of CONTRACT_EDGE_KINDS) {
      boundedList(normalized[kind], CONTRACT_NAMES_MAX, `contract ${kind}`, "Name the shared interfaces the wave planner sequences on, not every symbol they touch.");
    }
    return normalized;
  }
  function contractNamesByLowerCase(values) {
    return new Map(normalizeContractNames(values).map((value) => [value.toLowerCase(), value]));
  }
  function contractCollisionReasons(left, right) {
    if (!left || !right || left.contractWaiver || right.contractWaiver) return [];
    const leftContracts = normalizeContracts(left.contracts);
    const rightContracts = normalizeContracts(right.contracts);
    const reasons = [];
    const matchingNames = (a, b) => {
      const matches = [];
      for (const [key, name] of contractNamesByLowerCase(a)) {
        if (contractNamesByLowerCase(b).has(key)) matches.push(name);
      }
      return matches.sort((a2, b2) => a2.localeCompare(b2));
    };
    for (const contract of matchingNames(leftContracts.produces, rightContracts.consumes)) {
      reasons.push({ contract, type: "produces-consumes", message: `${left.ref} produces ${contract}, which ${right.ref} consumes.` });
    }
    for (const contract of matchingNames(rightContracts.produces, leftContracts.consumes)) {
      reasons.push({ contract, type: "produces-consumes", message: `${right.ref} produces ${contract}, which ${left.ref} consumes.` });
    }
    for (const contract of matchingNames(leftContracts.changes, rightContracts.changes)) {
      reasons.push({ contract, type: "changes-changes", message: `${left.ref} and ${right.ref} both change ${contract}.` });
    }
    return reasons;
  }
  function ticketsConflict(left, right) {
    return scopesOverlap(left.files, right.files) || contractCollisionReasons(left, right).length > 0;
  }
  function orderReadyTicketsByContractDependencies(tickets) {
    const ordered = Array.isArray(tickets) ? tickets : [];
    const edges = new Map(ordered.map((ticket) => [ticket.id, /* @__PURE__ */ new Set()]));
    for (const producer of ordered) {
      if (producer.contractWaiver) continue;
      const produced = contractNamesByLowerCase(normalizeContracts(producer.contracts).produces);
      for (const consumer of ordered) {
        if (producer.id === consumer.id || consumer.contractWaiver) continue;
        const consumed = contractNamesByLowerCase(normalizeContracts(consumer.contracts).consumes);
        const dependencies2 = edges.get(producer.id);
        if (dependencies2 && [...produced.keys()].some((name) => consumed.has(name))) dependencies2.add(consumer.id);
      }
    }
    const pending = new Set(ordered.map((ticket) => ticket.id));
    const result = [];
    while (pending.size) {
      const next = ordered.find((ticket) => {
        if (!pending.has(ticket.id)) return false;
        for (const [from, targets] of edges) {
          if (pending.has(from) && targets.has(ticket.id)) return false;
        }
        return true;
      }) || ordered.find((ticket) => pending.has(ticket.id));
      result.push(next);
      pending.delete(next.id);
    }
    return result;
  }
  function contractMetadata(ticket) {
    const contracts = normalizeContracts(ticket && ticket.contracts);
    return {
      produces: contracts.produces,
      changes: contracts.changes,
      consumes: contracts.consumes,
      waiver: !!(ticket && ticket.contractWaiver)
    };
  }
  function readyWaves(slug, opts) {
    const ready = orderReadyTicketsByContractDependencies(readyTickets(slug, opts));
    const waves = [];
    for (const t of ready) {
      let placed = false;
      for (const wave of waves) {
        if (!wave.some((w) => ticketsConflict(w, t))) {
          wave.push(t);
          placed = true;
          break;
        }
      }
      if (!placed) waves.push([t]);
    }
    return waves;
  }
  function readyWaveDependencies(slug, opts) {
    const waves = readyWaves(slug, opts);
    const dependencies2 = [];
    for (let waveIndex = 1; waveIndex < waves.length; waveIndex++) {
      for (const ticket of waves[waveIndex]) {
        for (let priorWave = 0; priorWave < waveIndex; priorWave++) {
          for (const earlier of waves[priorWave]) {
            for (const reason of contractCollisionReasons(earlier, ticket)) {
              dependencies2.push({ before: earlier.ref, after: ticket.ref, contract: reason.contract, type: reason.type, reason: reason.message });
            }
          }
        }
      }
    }
    return dependencies2;
  }
  function normalizeAssignee(v) {
    if (v == null) return null;
    const s = String(v).trim().slice(0, 60);
    return s || null;
  }
  function updateDoneRefusal(ticket) {
    if (ticket.claim && ticket.claim.by && !claimReclaimable(ticket)) {
      return `${ticket.ref} is claimed. Use done/completeTicket for eligible non-repo or artifact work; scoped repository work must commit and submit.`;
    }
    if (pendingSubmission(ticket)) {
      return `${ticket.ref} has a pending submission. Complete it through the integration lifecycle; update --status done cannot consume submitted work.`;
    }
    const state = dispatchState(ticket);
    if (ticket.dispatchNonce || state && !state.terminalAt) {
      return `${ticket.ref} has an active dispatch. Its executor must use done/completeTicket or commit and submit; update --status done cannot bypass that lifecycle.`;
    }
    if (state) {
      return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work; use the control-plane grooming closure with evidence.`;
    }
    return null;
  }
  function updateReopenRefusal(ticket, nextStatus) {
    if (!pendingSubmission(ticket)) return null;
    const commit = String(ticket.submission.commit || "").slice(0, 12);
    return `${ticket.ref} has a pending submission (commit ${commit}) parked READY_FOR_INTEGRATION. update cannot move it to "${nextStatus}" and leave the submission in place — the next claim would still refuse it as already-submitted. Reject it first: \`sidequest submit ${ticket.ref} --clear --status ${nextStatus}\` (MCP \`submit\` with \`clear:true, status:"${nextStatus}"\`), or integrate it through the publish flow.`;
  }
  function sameFiles(left, right) {
    const normalizedLeft = normalizeFiles(left);
    const normalizedRight = normalizeFiles(right);
    const rightFiles = new Set(normalizedRight.map((file) => file.toLowerCase()));
    return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((file) => rightFiles.has(file.toLowerCase()));
  }
  function activeClaimScopeRefusal(ticket, files, patch) {
    if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
    const current = normalizeFiles(ticket.files);
    const next = boundedFiles(files);
    if (sameFiles(current, next)) return null;
    const request = ticket.scopeRequest;
    if (request && approvedScopeRequestFiles(ticket, next)) return null;
    const caller = String(patch?.by || "").trim();
    if (caller && caller !== ticket.claim.by) return null;
    const claimedSession = String(dispatchState(ticket)?.sessionId || "").trim();
    const callerSession = String(patch?.sessionId || "").trim();
    if (callerSession && claimedSession && callerSession !== claimedSession) return null;
    const currentFiles = new Set(current.map((file) => file.toLowerCase()));
    const nextFiles = new Set(next.map((file) => file.toLowerCase()));
    const refused = [
      ...next.filter((file) => !currentFiles.has(file.toLowerCase())),
      ...current.filter((file) => !nextFiles.has(file.toLowerCase()))
    ];
    const refusal = `${ticket.ref}: refusing active-claim scope change for ${refused.join(", ")}.`;
    if (!caller) {
      return `${refusal} Re-run \`sidequest update ${ticket.ref} --files <paths> --by <your-id>\` using your own control-plane identity (MCP \`update\` with \`by:"<your-id>"\`).`;
    }
    return `${refusal} Use \`sidequest scope-request ${ticket.ref} --file <path> --by ${ticket.claim.by}\` to request approval.`;
  }
  function updateTicket(slug, idOrRef, patch) {
    const found = getTicket(slug, idOrRef);
    if (!found) return null;
    patch = patch || {};
    const apply = (t) => {
      const nextStatus = patch.status == null ? null : requireStatus(patch.status);
      const doneRefusal = nextStatus === "done" ? updateDoneRefusal(t) : null;
      if (doneRefusal) throw new Error(doneRefusal);
      const reopenRefusal = nextStatus != null && nextStatus !== "done" ? updateReopenRefusal(t, nextStatus) : null;
      if (reopenRefusal) throw new Error(reopenRefusal);
      const prevStatus = t.status;
      if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
      if (patch.description != null) t.description = String(patch.description).trim();
      if (patch.status != null) t.status = nextStatus;
      if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
      if (patch.labels != null) t.labels = boundedLabels(patch.labels);
      if (patch.highStakes !== void 0) t.highStakes = !!patch.highStakes;
      if (patch.storyId !== void 0) t.storyId = coerceStoryId(slug, patch.storyId);
      if (patch.category !== void 0) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
      if (patch.complexity !== void 0) {
        const c = coerceComplexity(patch.complexity);
        if (c) t.complexity = c;
      }
      if (patch.complexityWhy !== void 0 && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1e3);
      if (patch.files !== void 0) {
        const scopeRefusal = activeClaimScopeRefusal(t, patch.files, patch);
        if (scopeRefusal) throw new Error(scopeRefusal);
        const approvedFiles = approvedScopeRequestFiles(t, patch.files);
        t.files = approvedFiles || boundedFiles(patch.files);
        const scopeEditAt = (/* @__PURE__ */ new Date()).toISOString();
        if (!clearCoveredScopeRequest(slug, t, scopeEditAt)) resolveScopeRequestAgainstUpdate(slug, t, patch, scopeEditAt);
        syncLiveDispatchScope(t);
      }
      if (patch.contracts !== void 0) t.contracts = boundedContracts(patch.contracts);
      if (patch.contractWaiver !== void 0) t.contractWaiver = !!patch.contractWaiver;
      if (patch.readonly !== void 0 || patch.readonlyOverride !== void 0) t.readonlyOverride = requestedReadonlyOverride(patch);
      if (patch.executorAnchors !== void 0) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors");
      if (patch.executorVerify !== void 0) {
        requireVerifyCommand(patch.executorVerify);
        t.executorVerify = executorText(patch.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command");
      }
      if (patch.workedBy !== void 0) {
        try {
          const w = makeWorkedBy(patch.workedBy);
          if (w) t.workedBy = w;
        } catch (_) {
        }
      }
      if (patch.assignee !== void 0) t.assignee = normalizeAssignee(patch.assignee);
      if (patch.order != null && Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
      const imgs = Array.isArray(patch.images) ? patch.images : [];
      for (const src of imgs) {
        try {
          t.assets.push(copyAsset(slug, t.id, src));
        } catch (e) {
          if (patch.onAssetError) patch.onAssetError(src, e);
        }
      }
      for (const d of asDataImages(patch.imagesData)) {
        try {
          t.assets.push(saveAssetData(slug, t.id, d.name, d.buffer));
        } catch (_) {
        }
      }
      if (Array.isArray(patch.removeAssets) && patch.removeAssets.length) {
        const drop = new Set(patch.removeAssets.map((f) => path.basename(String(f))));
        t.assets = t.assets.filter((a) => {
          if (!drop.has(a)) return true;
          try {
            fs.unlinkSync(assetPath(slug, t.id, a));
          } catch (_) {
          }
          return false;
        });
      }
      t.lastEventType = t.status !== prevStatus ? "status" : "edit";
      t.lastEventSource = patch.source ? String(patch.source) : "cli";
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (t.status !== prevStatus) t.statusTransition = { from: prevStatus, to: t.status, at: now };
      t.updatedAt = now;
      t.referenceUpdatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      return t;
    };
    const lock = ticketLockPath(slug, found.id);
    const locked = acquireLock(lock);
    try {
      const t = getTicket(slug, found.id);
      if (!t) return null;
      return apply(t);
    } finally {
      if (locked) releaseLock(lock);
    }
  }
  function deleteTicket(slug, idOrRef) {
    const found = getTicket(slug, idOrRef);
    if (!found) return false;
    const deletedRef = found.ref;
    const lock = ticketLockPath(slug, found.id);
    const locked = acquireLock(lock);
    let ok = false;
    try {
      ok = deleteCachedRow(database(), "tickets", found.id);
      if (ok) {
        try {
          fs.rmSync(assetsDir(slug, found.id), { recursive: true, force: true });
        } catch (_) {
        }
      }
    } finally {
      if (locked) releaseLock(lock);
    }
    if (!ok) return false;
    try {
      for (const other of listTickets(slug)) {
        if (Array.isArray(other.links) && other.links.some((l) => upperRef(l.ref) === upperRef(deletedRef))) {
          stripLinksTo(slug, other.id, deletedRef);
        }
      }
    } catch (_) {
    }
    return true;
  }
  function setArchived(slug, idOrRef, archived, opts) {
    opts = opts || {};
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const t = getTicket(slug, found.id);
      if (!t) return { ok: false, reason: "not_found" };
      t.archived = !!archived;
      t.archivedAt = archived ? (/* @__PURE__ */ new Date()).toISOString() : null;
      t.lastEventType = archived ? "archived" : "restored";
      t.lastEventSource = opts.source ? String(opts.source) : "cli";
      t.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      putTicket(slug, t);
      return { ok: true, ticket: t };
    });
  }
  function archiveTicket(slug, idOrRef, opts) {
    return setArchived(slug, idOrRef, true, opts);
  }
  function unarchiveTicket(slug, idOrRef, opts) {
    return setArchived(slug, idOrRef, false, opts);
  }
  function archiveAllDone(slug, opts) {
    const refs = [];
    for (const ticket of queryTickets(String(slug || ""), { status: "done", archived: false })) {
      const result = setArchived(slug, ticket.id, true, opts);
      if (result.ok) refs.push(result.ticket.ref);
    }
    return { ok: true, archived: refs };
  }
  function listArchived(slug) {
    return queryTickets(String(slug || ""), { archived: true });
  }
  function listActive(slug) {
    return queryTickets(String(slug || ""), { archived: false });
  }
  return { DECLARED_FILES_MAX, CONTRACT_NAMES_MAX, LABELS_MAX, categoryReadOnly, readOnlyOverrideActive, dispatchReadOnly, createTicket, normalizeLabels, normalizeFiles, scopeExpansionFiles, scopeExpansionCommand, pendingScopeApprovalWarning, clearScopeRequestMarker, captureScopePauseRecovery, requestScope, denyScopeRequest, overlappingScopePaths, scopesOverlap, normalizeContracts, contractCollisionReasons, contractMetadata, readyWaves, readyWaveDependencies, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}
module.exports = { createTickets };
