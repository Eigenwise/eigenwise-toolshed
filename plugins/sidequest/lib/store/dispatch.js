"use strict";
const { canonicalPreparedDispatchExecutor, normalizePreparedDispatch } = require("../prepared-dispatch.js");
const { classifyVerificationKind, verificationRequirement } = require("../kernel/verification.js");
const { resolveSuite } = require("../suite-resolver.js");
const { reviewCandidateFromSubmission, sameReviewCandidate, reviewRelationFor, reviewRelationOutcome } = require("../kernel/review-binding");
const { compareSemver } = require("../plugin-freshness.js");
const { WHOLE_TREE_SCOPE } = require("../commit-scope.js");
const { compositionCheckoutCommit, consumePreparedComposition, consumedAdmissionRefusal } = require("./composition-admission.js");
function unscopedWriteCannotAutoApprove(ticket, options) {
  const { dispatchReadOnly, normalizeFiles, autoApproveScope } = options;
  return !dispatchReadOnly(ticket) && !normalizeFiles(ticket?.files).length && (!Array.isArray(autoApproveScope) || !autoApproveScope.length);
}
function undeclaredWriteScopeRefusal(ref) {
  return `prepare dispatch: ${ref} has no declared file scope for write work. Add files, or pass allowUnscoped:true to give the executor the whole tree as its write scope (isolated worktree only).`;
}
function unscopedWriteScopeLine(alwaysInScope) {
  const boardPaths = Array.isArray(alwaysInScope) ? alwaysInScope : [];
  return `write scope: unscoped (whole tree)${boardPaths.length ? `, always-in-scope: ${boardPaths.join(", ")}` : ""}`;
}
function unscopedSharedTreeRefusal(ref, boardPaths) {
  const boardOnly = boardPaths.length ? ` Board policy alone would give it only ${boardPaths.join(", ")}.` : "";
  return `prepare dispatch: ${ref} has no declared file scope and would run in the shared checkout, where an unscoped (whole tree) write scope would commit every dirty path in it.${boardOnly} Declare the paths it needs (\`sidequest update ${ref} --file <path>\`), or dispatch it into an isolated worktree.`;
}
function namedSuiteForTicket(ticket, projectPath) {
  const directories = new Set(
    (Array.isArray(ticket?.files) ? ticket.files : []).map((file) => /^plugins\/([^/]+)(?:\/|$)/.exec(String(file || "").replace(/\\/g, "/"))?.[1]).filter(Boolean)
  );
  if (!projectPath || directories.size !== 1) return null;
  const name = [...directories][0];
  const resolved = resolveSuite(projectPath, { name, dir: `plugins/${name}` });
  return resolved ? { name: resolved.plugin, cwd: resolved.cwd, setup: resolved.setup, command: resolved.command } : null;
}
function preparedVerificationRequirement(ticket, projectPath) {
  const recorded = String(ticket?.executorVerify || "").trim();
  const declaredKind = String(ticket?.executorVerifyKind || "command").trim().toLowerCase();
  const artifact = String(ticket?.executorAttestationArtifact || "").trim();
  const suite = !recorded || declaredKind === "suite" ? namedSuiteForTicket(ticket, projectPath) : null;
  const attestation = declaredKind === "attestation" && Boolean(artifact);
  const legacyWithoutVerifier = !recorded && !suite && !attestation;
  const kind = legacyWithoutVerifier ? "custom" : classifyVerificationKind(recorded, declaredKind);
  return verificationRequirement({
    kind,
    evidence: legacyWithoutVerifier ? "legacy project verifier was not recorded" : recorded || artifact || void 0,
    command: ["suite", "command"].includes(kind) ? recorded || void 0 : void 0,
    artifact: ticket?.executorAttestationArtifact,
    suite
  });
}
function requirementsMatch(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}
function liveVerificationRequirement(state, ticket) {
  return state.verificationRequirement || state.lifecycleAttempt?.verificationRequirement || ticket.lifecycleAttempt?.verificationRequirement;
}
function applyLiveVerificationRequirement(state, ticket, requirement) {
  state.verificationRequirement = requirement;
  const attempt = state.lifecycleAttempt || ticket.lifecycleAttempt;
  if (!attempt) return;
  const refreshedAttempt = Object.freeze({ ...attempt, verificationRequirement: requirement });
  state.lifecycleAttempt = refreshedAttempt;
  ticket.lifecycleAttempt = refreshedAttempt;
}
function trimmedOrNull(value) {
  return String(value || "").trim() || null;
}
function recordVerificationAmendment(ticket, amendment, previousRequirement, nextRequirement) {
  const record = Object.freeze({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    by: trimmedOrNull(amendment?.by),
    oldCommand: trimmedOrNull(previousRequirement?.command),
    newCommand: trimmedOrNull(nextRequirement.command)
  });
  ticket.verificationAmendments = [...Array.isArray(ticket.verificationAmendments) ? ticket.verificationAmendments : [], record].slice(-20);
  return record;
}
function pinnedVerificationRequirement(ticket, projectPath, verifyEnvironment, sharedTree) {
  const requirement = preparedVerificationRequirement(ticket, projectPath);
  const deferred = !sharedTree && verifyEnvironment === "shared" && ["command", "suite"].includes(requirement.kind);
  return deferred ? Object.freeze({ ...requirement, environment: "shared" }) : requirement;
}
function createDispatch(dependencies) {
  const { ARTIFACT_BASELINE_MAX_PATHS, SHARED_TREE_ARTIFACT_MARKER, assertDispatchTransport, assertSidequestInstall, checkSidequestInstall, servingInstall, prepareAttempt, transitionAttempt, attemptDiagnostic, ensurePythonIoEncoding, localAheadOfUpstreamWarning, availableRoute, boardConfig, claimGraceMs, claimIdleMs, claimReclaimable, claimVerification, classifyDispatchFailure, terminalAgentFailure, commitScope, crypto, database, db, dispatchReadOnly, dispatchFilesystemSnapshotPreflight, dispatchBaselineForProject, dispatchVerifyCommandError, dispatchRouteRefusal, dispatchRouteState, effectiveScope, execFileSync, execProjection, fs, getCategory, getStory, homeRoot, integrationTarget, integrationTargetCommit, legacyCategoryForComplexity, listProjects, listTickets, nonRepoExternalOutput, normalizeArtifactRoots, normalizeFiles, normalizeRoute, normalizeWorktreeIsolation, path, hasOriginRemote, pendingSubmission, agentWorktreePath, agentWorktreeCandidates, agentIdFromWorktreePath, resolvedAgentWorktree, preparedDispatchTtlMs, putTicket, readMeta, releaseTerminalClaim, resolveCategoryFallback, resolveCategoryRoute, resolveTicketRoute, resolveExec, stableExecutorName, staleWorktreeCwdWarning, storyExecutionContract, takeSourceRevisionAdapterSwitch, ticketCategory, ticketStorageRow, withTicketLock, normalizeCategoryId, projectRoutingEnabled, routingDisabledMessage, getTicket, dispatchLaunchName, nextDispatchLaunchSeq, spawnDescription, claudeQuotaFailure, canonicalPath, checkoutInstanceIdentity, createWorktreeLease, worktreeResumeDecision, isCanonicalRegisteredWorktree, withTicketLocks, withTicketFileLocks, guardedTransaction, ticketGenerations, changedTicketSince, unclaimedDispatchWorktreeReclaim } = dependencies;
  function boardVerificationRequirement(slug, ticket, sharedTree) {
    return pinnedVerificationRequirement(ticket, String(readMeta(slug)?.path || ""), boardConfig(slug)?.verifyEnvironment, sharedTree);
  }
  function syncLiveDispatchVerification(slug, ticket, amendment) {
    const state = dispatchState(ticket);
    if (!state || state.terminalAt) return null;
    const previousRequirement = liveVerificationRequirement(state, ticket);
    const nextRequirement = boardVerificationRequirement(slug, ticket, state.sharedTree === true);
    if (requirementsMatch(previousRequirement, nextRequirement)) return null;
    applyLiveVerificationRequirement(state, ticket, nextRequirement);
    return recordVerificationAmendment(ticket, amendment, previousRequirement, nextRequirement);
  }
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
  function ticketEvidenceDirectory(slug, ref, projectPath) {
    const safeSlug = String(slug || "project").replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeRef = String(ref || "ticket").replace(/[^a-zA-Z0-9._-]/g, "_");
    const directory = path.resolve(homeRoot(), "projects", safeSlug, "verification", safeRef);
    const repository = String(projectPath || "").trim();
    if (!repository) return directory;
    const relative = path.relative(path.resolve(repository), directory);
    const insideRepository = relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    return insideRepository ? path.join(path.dirname(path.resolve(repository)), ".sidequest-verification", safeSlug, safeRef) : directory;
  }
  function dispatchEvidenceDirectory(project, ref) {
    const state = dispatchState(getTicket(project, ref));
    return state && state.evidenceDirectory ? String(state.evidenceDirectory) : null;
  }
  function segmentsUnder(root, target) {
    const relative = path.relative(canonicalPath(root), canonicalPath(path.resolve(target))).replace(/\\/g, "/");
    const outside = !relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
    return outside ? [] : relative.split("/");
  }
  function trimmedString(value) {
    return String(value || "").trim();
  }
  function boardVerificationEvidencePath(target, evidenceDirectory) {
    const requested = trimmedString(target);
    const root = trimmedString(evidenceDirectory);
    if (!requested || !root) return false;
    try {
      if (fs.lstatSync(requested).isSymbolicLink()) return false;
    } catch (_) {
    }
    return segmentsUnder(root, requested).length > 0;
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
  function repositoryIdentity(cwd) {
    try {
      const value = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: String(cwd),
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      return canonicalPath(path.isAbsolute(value) ? value : path.resolve(String(cwd), value));
    } catch (_) {
      return null;
    }
  }
  function runtimeOutsideProjectRepository(projectPath, runtimeCwd) {
    if (!runtimeCwd || !projectPath) return false;
    const project = repositoryIdentity(projectPath);
    return Boolean(project) && project !== repositoryIdentity(runtimeCwd);
  }
  function isolatedTreeRuntimeRefusal(ticket, projectPath, runtimeCwd, slug, sessionId) {
    if (!runtimeOutsideProjectRepository(projectPath, runtimeCwd)) return null;
    const competing = launchedIsolatedSessionProjects(String(sessionId || "").trim(), slug);
    if (!competing.length) return null;
    return `prepare dispatch: refused ${ticket.ref}; its project ${projectPath} is a different repository from this session's checkout ${runtimeCwd}, and this session already owns launched isolated dispatches on another board (${competing.map((entry) => entry.path).join(", ")}). WorktreeCreate follows the session id to one board, so with several live it cannot tell which ticket it is creating for and would cut this worktree from the wrong repository. Dispatch ${ticket.ref} once those are terminal, leaving ${projectPath} as this session's only isolated board. sharedTree:true stays available but runs the executor and its commit in ${runtimeCwd}; only its verification is redirected to ${projectPath}.`;
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
  class DirtyBaselinePathCapError extends Error {
    pathCount;
    constructor(pathCount) {
      super(`artifact dirty baseline has ${pathCount} paths, over the ${ARTIFACT_BASELINE_MAX_PATHS}-path cap`);
      this.name = "DirtyBaselinePathCapError";
      this.pathCount = pathCount;
    }
  }
  function artifactIndexStates(root, files) {
    const indexStates = /* @__PURE__ */ new Map();
    const uniqueFiles = Array.from(new Set(files));
    const batchSize = 250;
    for (let offset = 0; offset < uniqueFiles.length; offset += batchSize) {
      const output = execFileSync("git", ["ls-files", "--stage", "-z", "--", ...uniqueFiles.slice(offset, offset + batchSize)], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true
      });
      for (const entry of output.split("\0")) {
        if (!entry) continue;
        const separator = entry.indexOf("	");
        if (separator < 0) continue;
        const file = entry.slice(separator + 1).replace(/\\/g, "/");
        const key = dirtyPathKey(file);
        indexStates.set(key, `${indexStates.get(key) || ""}${entry}\0`);
      }
    }
    return indexStates;
  }
  function artifactWorkingState(slug, options) {
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
    if (options?.allowLarge !== true && states.length > ARTIFACT_BASELINE_MAX_PATHS) {
      throw new DirtyBaselinePathCapError(states.length);
    }
    const indexStates = artifactIndexStates(meta.path, states.map((entry) => entry.file));
    return states.map((entry) => {
      const identity = crypto.createHash("sha256").update(JSON.stringify({
        status: entry.status,
        index: indexStates.get(dirtyPathKey(entry.file)) || "",
        worktree: artifactPathIdentity(meta.path, entry.file)
      })).digest("hex");
      return { path: entry.file, identity };
    }).sort((left, right) => left.path.localeCompare(right.path));
  }
  function captureDirtyBaseline(slug) {
    try {
      return { baseline: artifactWorkingState(slug), warning: null };
    } catch (error) {
      if (error instanceof DirtyBaselinePathCapError) {
        return {
          baseline: null,
          warning: `dirty baseline has ${error.pathCount} paths, over the ${ARTIFACT_BASELINE_MAX_PATHS}-path cap; no inherited-path exemption for this dispatch`
        };
      }
      const detail = String(error?.stderr || error?.message || error).trim();
      return {
        baseline: null,
        warning: `dirty baseline could not be recorded: ${detail}; no inherited-path exemption for this dispatch`
      };
    }
  }
  function postDispatchWorkingState(slug, state) {
    const baselineEntries = Array.isArray(state?.dirtyBaseline) ? state.dirtyBaseline : Array.isArray(state?.workingTreeDirtyBaseline) ? state.workingTreeDirtyBaseline : null;
    if (!baselineEntries) {
      return {
        working: commitScope.workingPaths(readMeta(slug)?.path || ""),
        preExisting: [],
        baselineRecorded: false
      };
    }
    const baselineByPath = new Map(baselineEntries.map((entry) => [dirtyPathKey(entry.path), entry]));
    const currentEntries = artifactWorkingState(slug, { allowLarge: true });
    const currentByPath = new Map(currentEntries.map((entry) => [dirtyPathKey(entry.path), entry]));
    const working = /* @__PURE__ */ new Set();
    const preExisting = /* @__PURE__ */ new Set();
    for (const entry of baselineEntries) {
      const currentEntry = currentByPath.get(dirtyPathKey(entry.path));
      if (currentEntry?.identity === entry.identity) preExisting.add(entry.path);
      else working.add(entry.path);
    }
    for (const entry of currentEntries) {
      const baselineEntry = baselineByPath.get(dirtyPathKey(entry.path));
      if (!baselineEntry || baselineEntry.identity !== entry.identity) working.add(entry.path);
    }
    return {
      working: Array.from(working).sort(),
      preExisting: Array.from(preExisting).sort(),
      baselineRecorded: true
    };
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
  const PRE_RUNTIME_DISPATCH_OUTCOMES = /* @__PURE__ */ new Set(["prepared", "launched"]);
  const PRE_CLAIM_RUNTIME_SIGNALS = [
    ["launchedAt", "launch recorded"],
    ["worktreeBoundAt", "worktree creation started"],
    ["worktreeCreationCompletedAt", "worktree checkout recorded"],
    ["worktreeProvisionedAt", "worktree provisioning finished"],
    ["boundAt", "runtime bound"],
    ["briefedAt", "briefing fetched"],
    ["claimedAt", "claim recorded"]
  ];
  function lastAttributedBoardWriteAt(ticket, state) {
    const sessionId = String(state?.sessionId || "").trim();
    const agentName = typeof state?.agentName === "string" ? state.agentName : "";
    const launchedAt = Date.parse(state?.launchedAt);
    if (!sessionId || !agentName.trim() || !Number.isFinite(launchedAt)) return null;
    if (state.claimedAt || ticket?.claim?.by) return null;
    let latest = null;
    for (const comment of Array.isArray(ticket?.comments) ? ticket.comments : []) {
      if (String(comment?.sourceSession || "").trim() !== sessionId) continue;
      if (comment?.by !== agentName) continue;
      const at = Date.parse(comment?.at);
      if (!Number.isFinite(at) || at < launchedAt) continue;
      if (latest === null || at > latest) latest = at;
    }
    return latest;
  }
  function lastRuntimeSignalAt(ticket, state) {
    let latest = null;
    for (const [field, label] of PRE_CLAIM_RUNTIME_SIGNALS) {
      const at = Date.parse(state?.[field]);
      if (!Number.isFinite(at)) continue;
      if (!latest || at >= latest.at) latest = { at, label };
    }
    const wroteAt = lastAttributedBoardWriteAt(ticket, state);
    if (wroteAt !== null && (!latest || wroteAt >= latest.at)) latest = { at: wroteAt, label: "board write recorded" };
    return latest;
  }
  function worktreeProvisioningInFlight(state) {
    return Boolean(state?.worktreeBindingSource === "worktree-create" && state.worktree && !state.worktreeProvisionedAt && !state.boundAt);
  }
  function unclaimedRetirement(ticket, state, now = Date.now()) {
    const signal = lastRuntimeSignalAt(ticket, state);
    const provisioning = worktreeProvisioningInFlight(state);
    if (!signal) {
      const preparedAt = Date.parse(state?.preparedAt);
      return {
        retirableAt: Number.isFinite(preparedAt) ? preparedAt : now,
        signal: null,
        provisioning,
        reason: "no_readable_signal"
      };
    }
    return provisioning ? { retirableAt: signal.at + claimIdleMs(), signal, provisioning, reason: "idle_backstop" } : { retirableAt: signal.at + claimGraceMs(), signal, provisioning, reason: "grace" };
  }
  function preparingSessionAttests(state, sessionId) {
    const caller = String(sessionId || "").trim();
    return Boolean(caller) && caller === String(state?.preparedBy?.sessionId || "").trim();
  }
  function unclaimedEvidenceAttempt(ticket, state) {
    return Boolean(
      state && ticket?.dispatchNonce && PRE_RUNTIME_DISPATCH_OUTCOMES.has(state.outcome) && !state.terminalAt && !state.claimedAt && !ticket.claim?.by && !ticket.checkpoint
    );
  }
  function unboundEvidenceAttempt(state) {
    return Boolean(state && !state.boundAt && !state.agentId && !worktreeProvisioningInFlight(state));
  }
  function evidenceRetirableAttempt(ticket, state, now = Date.now(), sessionId) {
    if (!unclaimedEvidenceAttempt(ticket, state)) return false;
    return preparingSessionAttests(state, sessionId) || now >= unclaimedRetirement(ticket, state, now).retirableAt;
  }
  function terminalUnclaimedAttempt(ticket, state) {
    return Boolean(state?.terminalAt && !ticket?.dispatchNonce && !ticket?.claim?.by && !pendingSubmission(ticket));
  }
  function preparingSessionClause(state) {
    const preparingSession = String(state?.preparedBy?.sessionId || "").trim();
    return preparingSession ? `The session that prepared it (${preparingSession}) can retire it now with that evidence: it spawned the runtime, so the host's failure report or the Agent call returning without a claim is proof the board never gets.` : "No preparing session was recorded, so evidence waits for the deadline.";
  }
  function unclaimedAttemptRecoveryGuidance(ticket, state) {
    if (!unclaimedEvidenceAttempt(ticket, state)) return "";
    const ref = ticket.ref;
    return ` Nobody claimed this attempt, so there is no claim to release. The one recovery is recovery evidence: close it with \`groomClose ${ref} --recoveryEvidence "<the host's failure report>"\` (add \`--deliveryCommit <sha> --deliveryMethod manual\` for work landed by hand, reachable from the recorded integration branch), which retires the attempt in the same call, or retire it on its own with \`sidequest dispatch ${ref} --recovery-evidence "<that same evidence>" --retire-only\` (MCP \`recoveryEvidence\` with \`retireOnly: true\`). ${preparingSessionClause(state)} From any other session both refuse with the countdown to the retirement deadline.`;
  }
  function minuteCount(minutes) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  function describeElapsed(ms) {
    return minuteCount(Math.max(0, Math.floor(ms / 6e4)));
  }
  function describeRemaining(ms) {
    return minuteCount(Math.ceil(ms / 6e4));
  }
  function unclaimedRuntimeBlocker(ticket, state, now = Date.now()) {
    const boundMs = Date.parse(state?.boundAt);
    const waited = Number.isFinite(boundMs) ? `bound to a runtime ${describeElapsed(now - boundMs)} ago and still unclaimed, which` : worktreeProvisioningInFlight(state) ? "still inside the WorktreeCreate that reserved its checkout, and unclaimed, which" : "unbound and unclaimed, which";
    const retirement = unclaimedRetirement(ticket, state, now);
    const measured = retirement.signal ? `last runtime signal: ${retirement.signal.label} at ${new Date(retirement.signal.at).toISOString()}` : "no runtime ever recorded a signal on this attempt, so its own prepare stamp is the deadline";
    const window = retirement.provisioning ? "its WorktreeCreate has not recorded finished provisioning, so only the idle backstop applies" : "the claim grace runs from that signal";
    const remaining = retirement.retirableAt - now;
    if (remaining > 0) {
      return `${waited} becomes retirable on evidence at ${new Date(retirement.retirableAt).toISOString()}, in ${describeRemaining(remaining)}, unless its terminal hook fires first (${measured}; ${window}). ${preparingSessionClause(state)}`;
    }
    return `${waited} passed that deadline at ${new Date(retirement.retirableAt).toISOString()} but is not retirable in dispatch state ${pulseDispatchState(state)} (${measured})`;
  }
  function unclaimedRetirementRefusal(ticket, state, now = Date.now()) {
    return `${ticket?.ref || "This attempt"} cannot be retired on recovery evidence yet because its dispatch is ${unclaimedRuntimeBlocker(ticket, state, now)}.`;
  }
  function evidenceSupersessionBlocker(ticket, state, now = Date.now()) {
    if (!state || !ticket?.dispatchNonce) return "not an active attempt";
    if (state.terminalAt) return `already terminal (${state.outcome || "terminal"})`;
    if (ticket.claim?.by) return `claimed by ${ticket.claim.by}`;
    if (state.claimedAt) return "claimed";
    if (ticket.checkpoint) return "checkpointed";
    if (!PRE_RUNTIME_DISPATCH_OUTCOMES.has(state.outcome)) return `in unrecognized state ${pulseDispatchState(state)}`;
    return unclaimedRuntimeBlocker(ticket, state, now);
  }
  function retirePreparedCompatibilityStaleAttempt(slug, ticket, source = "tokened-claim-refusal") {
    const state = dispatchState(ticket);
    if (!state || state.terminalAt || !ticket?.dispatchNonce) return ticket;
    const previousStatus = ticket.status;
    setDispatchTerminal(ticket, "failed", source, {
      slug,
      failureShape: "prepared_compatibility_stale"
    });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    if (!ticket.submission) ticket.status = "todo";
    if (ticket.status !== previousStatus) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: (/* @__PURE__ */ new Date()).toISOString() };
    stampDispatchEvent(ticket, source);
    putTicket(slug, ticket);
    return ticket;
  }
  function preparedCompatibilityDecision(state, currentInstall) {
    if (currentInstall.ok !== true) return { refusal: true };
    if (currentInstall.installPath !== state.preparedCompatibility.pluginInstall || currentInstall.identity !== state.preparedCompatibility.identity) return { refusal: true };
    const preparedVersion = typeof state.preparedCompatibility.version === "string" ? state.preparedCompatibility.version : "";
    const servingSnapshot = servingInstall();
    const servingVersion = typeof servingSnapshot?.version === "string" ? servingSnapshot.version : "";
    if (!preparedVersion || !servingVersion) return null;
    const comparison = compareSemver(servingVersion, preparedVersion);
    if (comparison === 0 && servingVersion !== preparedVersion) return { refusal: true };
    if (comparison === -1) return { refusal: true };
    if (comparison === 1) return { warning: `Sidequest serving ${servingVersion} is newer than prepared ${preparedVersion}; dispatch continues.` };
    return null;
  }
  function preparedCompatibilityHasProvenMismatch(state, currentInstall) {
    return preparedCompatibilityDecision(state, currentInstall)?.refusal === true;
  }
  function preparedCompatibilityWarning(state, currentInstall) {
    return preparedCompatibilityDecision(state, currentInstall)?.warning || null;
  }
  function supersedeUnboundAttempt(slug, idOrRef, opts) {
    const evidence = String(opts?.evidence || "").trim();
    if (!evidence) return { ok: false, reason: "recovery_evidence_required", message: "Superseding an unbound dispatch attempt requires observed failure evidence." };
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      const state = dispatchState(ticket);
      const now = Date.now();
      if (terminalUnclaimedAttempt(ticket, state)) return { ok: true, ticket, alreadyTerminal: true };
      if (!evidenceRetirableAttempt(ticket, state, now, opts?.sessionId)) {
        return {
          ok: false,
          reason: "unclaimed_launch_not_supersedable",
          ticket,
          message: `${ticket?.ref || idOrRef} cannot be superseded on recovery evidence because its dispatch is ${evidenceSupersessionBlocker(ticket, state, now)}. Evidence retires an unclaimed attempt at once from the session that prepared it, and from any other session once it has no readable runtime signal or its latest runtime signal is past its retirement deadline. A claimed attempt waits for its own terminal record.`
        };
      }
      const strandedBound = !unboundEvidenceAttempt(state);
      setDispatchTerminal(ticket, "failed", opts?.source || "control-plane-unclaimed-launch-supersession", {
        slug,
        failureShape: strandedBound ? "stranded_bound_launch_superseded" : "unclaimed_launch_superseded"
      });
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
      // Without this an attempt that bound through its dispatch token is
      // indistinguishable from one that never bound at all: both carry a null
      // agentId. Review provenance needs to tell those apart.
      bindSource: state.bindSource || null,
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
  function observeReleaseWorktreeFacts(slug, ticket) {
    const state = dispatchState(ticket);
    if (state?.sharedTree !== false) return /* @__PURE__ */ new Map();
    const worktrees = [state.worktree, state.releaseObservedCheckout?.worktree].filter(Boolean).map((worktree) => canonicalPath(worktree));
    return new Map(worktrees.map((worktree) => [worktree, observeWorktree(slug, worktree)]));
  }
  function observeWorktree(slug, worktree) {
    const facts = immutableWorktreeFacts(slug, worktree);
    return { facts, registered: registeredProjectCheckout(facts) };
  }
  function worktreeFactsFor(slug, worktree, observed) {
    return observed ? observed.get(canonicalPath(worktree))?.facts ?? null : immutableWorktreeFacts(slug, worktree);
  }
  function observedCheckoutRegistered(worktree, facts, observed) {
    return observed ? observed.get(canonicalPath(worktree))?.registered === true : registeredProjectCheckout(facts);
  }
  function captureTerminalWorktreeRevision(slug, state, at, observed) {
    if (!terminalRevisionBound(slug, state)) return;
    const facts = worktreeFactsFor(slug, state.worktree, observed);
    if (!factsDescribeBoundCheckout(facts, state)) return;
    state.terminalWorktreeRevision = facts.revision;
    state.terminalWorktreeObservedAt = at;
  }
  function terminalRevisionBound(slug, state) {
    return Boolean(slug) && state?.sharedTree === false && Boolean(state.worktree) && Boolean(state.worktreeGitDirectory) && Boolean(state.worktreeCommonGitDirectory);
  }
  function factsDescribeBoundCheckout(facts, state) {
    if (!facts) return false;
    return sameCheckoutLocation(facts, state) && facts.checkoutInstance === String(state.worktreeCheckoutInstance || "");
  }
  function sameCheckoutLocation(facts, state) {
    return facts.worktree === canonicalPath(state.worktree) && facts.gitDirectory === canonicalPath(state.worktreeGitDirectory) && facts.commonGitDirectory === canonicalPath(state.worktreeCommonGitDirectory);
  }
  function sameRevision(left, right) {
    const first = String(left || "").trim().toLowerCase();
    const second = String(right || "").trim().toLowerCase();
    if (first.length < 7 || second.length < 7) return false;
    return first.startsWith(second) || second.startsWith(first);
  }
  function reviewCandidateTreeRefusal(slug, ticket) {
    const state = dispatchState(ticket);
    if (state?.reviewTarget?.candidate?.source !== "git") return null;
    const candidate = String(state.baseCommit || "").trim();
    if (!candidate) return null;
    const worktree = String(state.worktree || "").trim();
    const observed = worktree ? immutableWorktreeFacts(slug, worktree)?.revision : null;
    if (!observed) {
      return {
        ok: false,
        reason: "review_tree_unobservable",
        message: `${ticket.ref} reviews candidate ${candidate} and its checkout cannot be read, so nothing can show the verdict was formed on that commit. Do not close it: comment what you verified and release ${ticket.ref} with kind \`technical_blocker\` so the orchestrator dispatches the review again into a readable isolated checkout.`
      };
    }
    if (sameRevision(observed, candidate)) return null;
    return {
      ok: false,
      reason: "review_tree_mismatch",
      message: `${ticket.ref} cannot close: its checkout is on ${observed} rather than the candidate ${candidate}, so this verdict is about a different tree. A review ENDS on its candidate. Run \`git -C ${worktree} checkout --detach ${candidate}\`, re-run the declared verify there, then close. Comparing against the integration branch never needs HEAD to move: use \`git diff ${candidate}...main\` or \`git show\`.`
    };
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
  function sharedTreeExecutionGuidance(readonly) {
    return readonly ? "Read-only executor: keep project files unchanged and close with done; do not commit or submit." : "Executor must scoped-commit immediately.";
  }
  function worktreeIsolationWarning(slug, readonly = false) {
    const guidance = sharedTreeExecutionGuidance(readonly);
    const meta = readMeta(slug);
    if (!meta || !meta.path) {
      return `Worktree isolation unavailable: board project path is unavailable; spawning in shared tree. ${guidance}`;
    }
    if (!fs.existsSync(meta.path)) {
      return `Worktree isolation unavailable: project path does not exist; spawning in shared tree. ${guidance}`;
    }
    try {
      const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: meta.path,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (inside !== "true") {
        return `Worktree isolation unavailable: project is not a Git work tree; spawning in shared tree. ${guidance}`;
      }
    } catch (error) {
      const reason = error && error.code === "ENOENT" ? "Git is not available" : "project is not a Git work tree";
      return `Worktree isolation unavailable: ${reason}; spawning in shared tree. ${guidance}`;
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
      return `Worktree isolation unavailable: repo has no commits or HEAD cannot be resolved; spawning in shared tree. ${guidance}`;
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
  function explicitBaseContinuation(released, explicit, target, baseCommit) {
    if (!explicit || !released?.continuation) return released;
    return retainedAgainstExplicitBase(released.continuation, `the dispatch explicitly names integration base ${target.branch} at ${baseCommit}`, baseCommit);
  }
  function retainedAgainstExplicitBase(continuation, named, baseCommit) {
    if (continuation.baseCommit === baseCommit) return { continuation: { ...continuation, retainReason: `${named}, which is the retained checkout's own base` } };
    const differs = `${named} while retained checkout ${continuation.sourceWorktree} is built on ${continuation.baseCommit}`;
    if (continuation.mode === "dirty_worktree_resume") {
      return { continuation: { ...continuation, retainReason: `${differs}; its uncommitted changes exist nowhere else, so it is still retained and they move onto ${baseCommit} before any work` } };
    }
    const { sourceBranch, commit, commits } = continuation;
    return {
      fallback: continuationFallback("released_worktree_base_differs_from_explicit_integration_base", continuation.sourceWorktree, {
        sourceBranch,
        commit,
        commits,
        cause: `${differs}, so its checkpoint commits replay onto the named base in a fresh checkout`
      })
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
  function boundIsolatedWorktree(state) {
    return Boolean(state?.worktree && ["worktree-create", "live-claim-recovery"].includes(state.worktreeBindingSource));
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
  function normalizedText(value) {
    return String(value || "").trim();
  }
  function pinnedCandidateLines(repository) {
    try {
      return gitOutput(repository, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/sidequest/"]).split("\n");
    } catch (_) {
      return [];
    }
  }
  function pinnedCandidateRevisions(repository) {
    const pinned = /* @__PURE__ */ new Map();
    for (const line of pinnedCandidateLines(repository)) {
      const [name, object] = line.trim().split(" ");
      if (name && object && name.startsWith("refs/sidequest/")) pinned.set(name.slice("refs/sidequest/".length), object.toLowerCase());
    }
    return pinned;
  }
  function ticketRecordedRevisions(ticket, state, pinned) {
    const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
    return [
      ...Array.isArray(state?.sanctionedCommits) ? state.sanctionedCommits : [],
      ticket?.checkpoint?.commit,
      ticket?.submission?.commit,
      attempts[attempts.length - 1]?.commit,
      pinned?.get(String(ticket?.ref || ""))
    ].map((commit) => normalizedText(commit).toLowerCase()).filter(Boolean);
  }
  function isOtherTicket(other, ticket) {
    return Boolean(other) && other.id !== ticket?.id;
  }
  function recordsRevision(recorded, commit) {
    return recorded.some((revision) => sameRevision(revision, commit));
  }
  function foreignCommit(commit, recorded, own) {
    return recordsRevision(recorded, commit) && !recordsRevision(own, commit);
  }
  function carriesForeignCommit(other, range, own, pinned) {
    const recorded = ticketRecordedRevisions(other, dispatchState(other), pinned);
    return recorded.length > 0 && range.some((commit) => foreignCommit(commit, recorded, own));
  }
  function checkoutRangeOwnership(slug, ticket, state, repository, commits) {
    const range = Array.isArray(commits) ? commits : [];
    const pinned = pinnedCandidateRevisions(repository);
    const own = ticketRecordedRevisions(ticket, state, pinned);
    const foreignTickets = listTickets(slug).filter((other) => isOtherTicket(other, ticket)).filter((other) => carriesForeignCommit(other, range, own, pinned)).map((other) => String(other.ref)).sort();
    const head = range[range.length - 1];
    return { ownHead: Boolean(head && recordsRevision(own, head)), foreignTickets };
  }
  function liveIsolatedLease(ticket) {
    const state = dispatchState(ticket);
    return ticket.status !== "done" && state?.sharedTree === false && !state.terminalAt && Boolean(state.worktree);
  }
  function leasesCheckout(other, ticket, target) {
    return isOtherTicket(other, ticket) && liveIsolatedLease(other) && canonicalPath(dispatchState(other).worktree) === target;
  }
  function liveCheckoutHolders(slug, ticket, worktree) {
    const target = canonicalPath(worktree);
    return listTickets(slug).filter((other) => leasesCheckout(other, ticket, target)).map((other) => String(other.ref)).sort();
  }
  function registeredProjectCheckout(facts) {
    try {
      return Boolean(facts && registeredWorktrees(facts.repository).includes(facts.worktree));
    } catch (_) {
      return false;
    }
  }
  function retainedBindingFallback(state, recordedWorktree) {
    if (state.retainedWorktreeDropped) {
      return continuationFallback("released_worktree_binding_dropped", recordedWorktree, { observedWorktree: state.retainedWorktreeDropped.observed || null });
    }
    if (!recordedWorktree || !fs.existsSync(recordedWorktree)) return continuationFallback("released_worktree_missing", recordedWorktree);
    return null;
  }
  function retainedOwnershipFallback(slug, ticket, state, repository, range) {
    const ownership = checkoutRangeOwnership(slug, ticket, state, repository, range.commits);
    if (ownership.foreignTickets.length) {
      return continuationFallback("retained_worktree_carries_another_tickets_commits", range.worktree, { commit: range.commit, commits: range.commits, foreignTickets: ownership.foreignTickets });
    }
    if (!ownership.ownHead) return continuationFallback("retained_worktree_head_is_not_this_tickets", range.worktree, { commit: range.commit, commits: range.commits });
    return null;
  }
  function retainedWorktreeContinuationState(slug, ticket, state) {
    const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
    const attempt = attempts[attempts.length - 1] || null;
    const checkpointCommit = String(attempt?.commit || "").trim();
    const checkpointedTerminalFailure = Boolean(state?.terminalAt && checkpointCommit && ["failed", "died"].includes(state.outcome));
    if (!state || !checkpointedTerminalFailure && state.outcome !== "released" || !state.terminalAt || state.sharedTree !== false) return null;
    const recordedWorktree = String(state.worktree || "").trim();
    const bindingFallback = retainedBindingFallback(state, recordedWorktree);
    if (bindingFallback) return { fallback: bindingFallback };
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
      const ownershipFallback = retainedOwnershipFallback(slug, ticket, state, worktreeFacts.repository, { worktree, commit: observedRevision, commits });
      if (ownershipFallback) return { fallback: ownershipFallback };
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
  function releaseFragmentOnlyCheckpoint(projectPath, ticket, checkpointCommit, baseCommit) {
    const repository = String(projectPath || "").trim();
    const commit = String(checkpointCommit || "").trim();
    const baseline = String(baseCommit || "").trim();
    const ticketRef = String(ticket?.ref || "").trim();
    if (!repository || !commit || !baseline || !ticketRef) return false;
    try {
      gitOutput(repository, ["merge-base", "--is-ancestor", baseline + "^{commit}", commit + "^{commit}"]);
      const changedPaths = gitOutput(repository, ["diff", "--name-only", baseline + "^{commit}", commit + "^{commit}", "--"]).split(/\r?\n/).map((changedPath) => changedPath.replace(/\\/g, "/").trim()).filter(Boolean);
      return changedPaths.length === 1 && changedPaths[0] === `.release/unreleased/${ticketRef}.md`;
    } catch (_) {
      return false;
    }
  }
  function checkoutBelongsToAnotherDispatchAgent(slug, projectPath, ticket, state) {
    const repository = String(projectPath || "").trim();
    const recorded = String(state?.worktree || "").trim();
    if (!repository || !recorded) return false;
    const target = canonicalPath(recorded);
    const namesCheckout = (agentId) => {
      const id = String(agentId || "").trim();
      return Boolean(id && agentWorktreeCandidates(repository, id).some((candidate) => canonicalPath(candidate) === target));
    };
    if (namesCheckout(state.agentId)) return false;
    return listTickets(slug).some((candidate) => {
      if (!candidate || candidate.id === ticket?.id) return false;
      const other = dispatchState(candidate);
      const attempts = Array.isArray(other?.attempts) ? other.attempts : [];
      return Boolean(other) && [other.agentId, ...attempts.map((attempt) => attempt?.agentId)].some(namesCheckout);
    });
  }
  function agentNamesCheckout(repository, agentId, target) {
    const id = String(agentId || "").trim();
    return Boolean(id) && agentWorktreeCandidates(repository, id).some((candidate) => canonicalPath(candidate) === target);
  }
  function liveCheckoutHolder(ticket) {
    const state = dispatchState(ticket);
    return Boolean(ticket?.claim?.by) || Boolean(state && !state.terminalAt);
  }
  function recordsCheckout(repository, ticket, target) {
    const state = dispatchState(ticket);
    if (state?.worktree && canonicalPath(state.worktree) === target) return true;
    return [state?.agentId, ticket.claim?.runtime?.agentId].some((agentId) => agentNamesCheckout(repository, agentId, target));
  }
  function siblingHoldsCheckout(repository, ticket, candidate, target) {
    return candidate.id !== ticket.id && liveCheckoutHolder(candidate) && recordsCheckout(repository, candidate, target);
  }
  function liveSiblingHoldingCheckout(slug, projectPath, ticket, state) {
    if (!projectPath || !state?.worktree) return null;
    const target = canonicalPath(state.worktree);
    return listTickets(slug).find((candidate) => siblingHoldsCheckout(projectPath, ticket, candidate, target)) || null;
  }
  function crossBoundCheckoutRefusal(ref, siblingRef, worktree) {
    return `${ref} did not remove ${worktree}: its retired attempt's binding was a cross-bind onto ${siblingRef}'s live checkout, not a tree ${ref} created. The checkout stays with ${siblingRef}, and only ${ref}'s binding was cleared.`;
  }
  function unsettledSiblingCheckoutRefusal(ref, siblingRef, worktree) {
    return `${ref} did not remove ${worktree}: ${siblingRef} from the same dispatch session has not claimed yet, and creation order can hand one sibling's checkout to the other's reservation, so this may be the tree ${siblingRef}'s executor runs in. The checkout stays, and only ${ref}'s binding was cleared.`;
  }
  function guessedSessionSibling(entry, slug, ticket, sessionId) {
    const state = dispatchState(entry.ticket);
    return entry.slug === slug && entry.ticket.id !== ticket.id && state?.sharedTree === false && guessedReservation(entry.ticket, state, sessionId);
  }
  function unsettledSessionSibling(slug, ticket, state) {
    const sessionId = normalizedText(state?.sessionId);
    const sibling = sessionId && ticketsMentioningSession(sessionId).find((entry) => guessedSessionSibling(entry, slug, ticket, sessionId));
    return sibling ? sibling.ticket : null;
  }
  function holdUncreatedFailureForSibling(slug, ticket, state, sessionId) {
    const sibling = guessedReservation(ticket, state, sessionId) ? unsettledSessionSibling(slug, ticket, state) : null;
    if (!sibling) return null;
    releaseCrossedCreationBinding(state, sibling.ref, (/* @__PURE__ */ new Date()).toISOString(), "worktree_create_failed");
    stampDispatchEvent(ticket, "worktree-create-failure-held");
    putTicket(slug, ticket);
    return { ok: true, ticket, heldFor: sibling.ref };
  }
  function siblingKeepingCheckout(slug, projectPath, ticket, state) {
    if (!state?.worktree) return null;
    const holder = liveSiblingHoldingCheckout(slug, projectPath, ticket, state);
    if (holder) return { sibling: holder, message: crossBoundCheckoutRefusal(ticket.ref, holder.ref, state.worktree) };
    const unsettled = unsettledSessionSibling(slug, ticket, state);
    if (!unsettled) return null;
    return { sibling: unsettled, message: unsettledSiblingCheckoutRefusal(ticket.ref, unsettled.ref, state.worktree), parkedCheckout: parkedCreationRecord(state) };
  }
  function parkedCreationRecord(state) {
    const record = { sessionId: state.sessionId, baseCommit: state.baseCommit };
    for (const field of CHECKOUT_BINDING_FIELDS) record[field] = state[field] === void 0 ? null : state[field];
    return record;
  }
  function reclaimRetiredAttemptCheckout(slug, projectPath, ticket, state, facts) {
    const decision = retiredAttemptCheckoutReclaim(slug, projectPath, ticket, state, facts);
    return decision?.reclaim ? decision.reclaim() : decision;
  }
  function retiredAttemptCheckoutReclaim(slug, projectPath, ticket, state, facts) {
    const kept = siblingKeepingCheckout(slug, projectPath, ticket, state);
    if (!kept) return unclaimedDispatchWorktreeReclaim(projectPath, state, facts);
    return {
      worktree: state.worktree,
      reclaimed: false,
      reason: "cross_bound_worktree",
      sibling: kept.sibling.ref,
      message: kept.message,
      parkedCheckout: kept.parkedCheckout
    };
  }
  function unclaimedWorktreeRecoveryFacts(projectPath, ticket, state) {
    const checkpointCommit = String(ticket?.checkpoint?.commit || ticket?.submission?.commit || "").trim();
    if (!checkpointCommit || !releaseFragmentOnlyCheckpoint(projectPath, ticket, checkpointCommit, state?.baseCommit)) {
      return { state, checkpointCommit: checkpointCommit || null };
    }
    const worktree = String(state?.worktree || "").trim();
    if (!worktree || !fs.existsSync(worktree)) return { state, checkpointCommit: null };
    try {
      const checkpointRevision = gitOutput(projectPath, ["rev-parse", "--verify", checkpointCommit + "^{commit}"]);
      const worktreeRevision = gitOutput(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (checkpointRevision === worktreeRevision) {
        return { state: Object.assign({}, state, { baseCommit: checkpointRevision }), checkpointCommit: null };
      }
    } catch (_) {
    }
    return { state, checkpointCommit: null };
  }
  function reusablePreparedRecovery(ticket, current) {
    return Boolean(current && current.recovery && current.outcome === "prepared" && ticket.dispatchNonce && canonicalPreparedDispatchExecutor(ticket));
  }
  function dispatchWorktreeOverrideRefusal(ticket, worktree, projectPath) {
    if (worktree == null || String(worktree).trim() === "") return null;
    const placement = ticket.workingTreeDelivery === true ? `${ticket.ref} declares workingTreeDelivery, so it runs and delivers in the board's registered checkout ${projectPath}; to deliver from a linked worktree instead, clear workingTreeDelivery so the ticket runs in an isolated worktree and submits a commit.` : "sharedTree:true runs in the board's registered checkout and sharedTree:false in a board-provisioned worktree.";
    return `prepare dispatch: worktree only names a resumed executor's checkout for live-claim recovery with claimHolder; it cannot choose where a new attempt runs. ${placement}`;
  }
  function dispatchSource(opts, fallback) {
    return opts.source || opts.transport || fallback;
  }
  function retireUnboundDispatchOnly(slug, idOrRef, opts) {
    const superseded = supersedeUnboundAttempt(slug, idOrRef, {
      evidence: opts.recoveryEvidence,
      source: dispatchSource(opts, "dispatch"),
      sessionId: opts.sessionId
    });
    if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${idOrRef} has no unbound dispatch attempt to retire (${superseded.reason}).`}`);
    return Object.assign(superseded, { retired: true });
  }
  function undeclaredScopeRefusal(slug, ticket, opts) {
    const noDeclaredFileScope = unscopedWriteCannotAutoApprove(ticket, {
      dispatchReadOnly,
      normalizeFiles,
      autoApproveScope: boardConfig(slug)?.autoApproveScope
    });
    return noDeclaredFileScope && opts.allowUnscoped !== true ? undeclaredWriteScopeRefusal(ticket.ref) : null;
  }
  function dispatchTicketRefusal(slug, found, opts, projectPath) {
    return dispatchWorktreeOverrideRefusal(found, opts.worktree, projectPath) || executorClaimDispatchRefusal(slug, opts.sessionId) || undeclaredScopeRefusal(slug, found, opts) || dispatchVerifyCommandError(found, projectPath);
  }
  function dispatchableTicket(slug, idOrRef, opts) {
    if (!projectRoutingEnabled(slug)) throw new Error(routingDisabledMessage(idOrRef));
    const projectPath = readMeta(slug)?.path;
    const found = getTicket(slug, idOrRef);
    if (!found) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    const refusal = dispatchTicketRefusal(slug, found, opts, projectPath);
    if (refusal) throw new Error(refusal);
    return { projectPath, found };
  }
  function installFacts(install) {
    const facts = install ?? {};
    return { installPath: facts.installPath || null, identity: facts.identity || null, version: facts.version || null };
  }
  function preparedCompatibilityRecord(plugin, serving) {
    if (!plugin.installPath || !plugin.identity) return null;
    return Object.freeze({
      pluginInstall: plugin.installPath,
      identity: plugin.identity,
      version: plugin.version,
      ...serving.installPath && serving.version ? { servingInstall: serving.installPath, servingVersion: serving.version } : {}
    });
  }
  function assertServingNotOlder(ref, preparedCompatibility, installCheck, plugin, serving) {
    if (!preparedCompatibility || !preparedCompatibilityHasProvenMismatch({ preparedCompatibility }, installCheck)) return;
    throw new Error(`prepare dispatch: ${ref} refused; serving Sidequest ${serving.version || "unknown"} is older than prepared ${plugin.version || "unknown"}. Restart Claude Code so the board serves the prepared build, then dispatch again.`);
  }
  function preparedInstallCompatibility(found, projectPath) {
    const installCheck = projectPath ? assertSidequestInstall(projectPath) : null;
    const plugin = installFacts(installCheck);
    const serving = installFacts(servingInstall());
    const preparedCompatibility = preparedCompatibilityRecord(plugin, serving);
    assertServingNotOlder(found.ref, preparedCompatibility, installCheck, plugin, serving);
    return {
      preparedCompatibility,
      servingCompatibilityWarning: preparedCompatibility ? preparedCompatibilityWarning({ preparedCompatibility }, installCheck) : null
    };
  }
  function supersedeEvidencedAttempt(slug, found, opts) {
    if (!opts.recoveryEvidence) return;
    const superseded = supersedeUnboundAttempt(slug, found.id, {
      evidence: opts.recoveryEvidence,
      source: dispatchSource(opts, "dispatch"),
      sessionId: opts.sessionId
    });
    if (!superseded.ok) throw new Error(`prepare dispatch: ${superseded.message || `${found.ref} has no unbound dispatch attempt to supersede (${superseded.reason}).`}`);
  }
  function preparedDispatchEnvironment(slug, found, idOrRef, projectPath) {
    const pythonIoEncoding = projectPath ? ensurePythonIoEncoding(projectPath) : { written: false };
    const sourceRevisionAdapterSwitch = takeSourceRevisionAdapterSwitch(slug);
    const captureFilesystemSnapshot = withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      if (!ticket) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
      return !reusablePreparedRecovery(ticket, dispatchState(ticket));
    });
    const snapshotPreflight = captureFilesystemSnapshot ? dispatchFilesystemSnapshotPreflight(slug, found, (/* @__PURE__ */ new Date()).toISOString()) : null;
    return { pythonIoEncoding, sourceRevisionAdapterSwitch, snapshotPreflight };
  }
  function pendingCandidateIdentity(submission) {
    return String(submission.commit || submission.sourceRevision?.value || "").trim();
  }
  function assertNoPendingSubmission(t) {
    if (!pendingSubmission(t)) return;
    const candidate = pendingCandidateIdentity(t.submission);
    throw new Error(`prepare dispatch: ${t.ref} has a pending submission${candidate ? ` (${candidate})` : ""} waiting on integration, so it is parked for the publish transaction rather than for another executor. Integrate it (\`sidequest integrate ${t.ref} --by <who>\`), send it back for repair and dispatch the replacement (\`sidequest rework ${t.ref} --by ${t.submission.by || "<candidate-owner>"} --review <review-ticket-or-evidence> --reason "what needs repair"\`), or close it as abandoned (\`sidequest groom-close ${t.ref} --abandon-submission --reason "<evidence it never landed>"\`).`);
  }
  function hasClaimHolder(t) {
    return Boolean(t.claim?.by);
  }
  function unclaimedRetiredIsolatedAttempt(t, current) {
    return Boolean(current?.terminalAt) && current.sharedTree === false && !current.claimedAt && !hasClaimHolder(t);
  }
  function reclaimsRetiredCheckout(slug, projectPath, t, current) {
    if (t.compositionAdmission) return false;
    return unclaimedRetiredIsolatedAttempt(t, current) && !checkoutBelongsToAnotherDispatchAgent(slug, projectPath, t, current);
  }
  function retainedRecoveryBlocked(recovery) {
    return Boolean(recovery) && recovery.reclaimed === false && recovery.discardable !== true && recovery.retainedCheckout !== true;
  }
  function checkpointRecoveryHint(t, current) {
    const checkpointCommit = String(t.checkpoint?.commit || "").trim();
    return checkpointCommit ? ` Restore ${current.worktree} to checkpoint ${checkpointCommit}, then dispatch again; the board will resume that retained checkout without creating another.` : "";
  }
  function unretryableRecoveryMessage(t, current, recovery) {
    const reason = recovery.message || `immutable recovery fact ${recovery.reason || "is unreadable"}`;
    return `prepare dispatch: ${t.ref} cannot retry because ${reason}${checkpointRecoveryHint(t, current)}`;
  }
  function assertRetainedRecoveryContinues(slug, t, current, recovery) {
    if (retainedRecoveryBlocked(recovery) && !retainedWorktreeContinuationState(slug, t, current)?.continuation) {
      throw new Error(unretryableRecoveryMessage(t, current, recovery));
    }
  }
  function queueCheckoutReclaim(effects, decision) {
    if (decision?.reclaim) effects.checkoutReclaims.push(decision.reclaim);
  }
  function reclaimRetiredCheckout(slug, projectPath, t, current, effects) {
    if (!reclaimsRetiredCheckout(slug, projectPath, t, current)) return null;
    const recoveryFacts = unclaimedWorktreeRecoveryFacts(projectPath, t, current);
    const recovery = retiredAttemptCheckoutReclaim(slug, projectPath, t, recoveryFacts.state, {
      checkpointCommit: recoveryFacts.checkpointCommit
    });
    queueCheckoutReclaim(effects, recovery);
    if (recovery?.reason === "cross_bound_worktree") {
      releaseCrossedCreationBinding(current, recovery.sibling, (/* @__PURE__ */ new Date()).toISOString(), "cross_bound_supersede");
      return { sibling: recovery.sibling, worktree: recovery.worktree, message: recovery.message, parkedCheckout: recovery.parkedCheckout };
    }
    assertRetainedRecoveryContinues(slug, t, current, recovery);
    return null;
  }
  function liveUnclaimedRuntimeAttempt(t, current) {
    return Boolean(current) && !current.terminalAt && !hasClaimHolder(t) && Boolean(current.launchedAt || current.boundAt);
  }
  function liveAttemptRecoveryHint(t, current, sessionId) {
    const evidenceCall = `so the orchestrator can supersede it in one call: \`sidequest dispatch ${t.ref} --recovery-evidence "<observed failed-claim evidence>"\`.`;
    if (!evidenceRetirableAttempt(t, current, Date.now(), sessionId)) {
      return ` Wait for that executor's terminal hook, then dispatch once from the returned todo state; do not mint a replacement token while it is still winding down. It is ${evidenceSupersessionBlocker(t, current)}.`;
    }
    return unboundEvidenceAttempt(current) ? ` It is unbound and unclaimed, ${evidenceCall}` : ` It never claimed, so if you observed the host report that runtime gone: ${evidenceCall}`;
  }
  function assertNoLiveRuntimeAttempt(t, current, opts) {
    if (!liveUnclaimedRuntimeAttempt(t, current)) return;
    throw new Error(`prepare dispatch: ${t.ref} already has a live dispatch attempt (${pulseDispatchState(current)}).${liveAttemptRecoveryHint(t, current, opts.sessionId)}`);
  }
  function retainedContinuationCandidate(slug, t, current) {
    return t.compositionAdmission ? null : retainedWorktreeContinuationState(slug, t, current);
  }
  function assertNoLiveClaim(t) {
    if (hasClaimHolder(t) && !claimReclaimable(t)) {
      throw new Error(`prepare dispatch: ${t.ref} has a live claim by ${t.claim.by}. Release it (\`sidequest release ${t.ref} --by ${t.claim.by}\`) before dispatching again.`);
    }
  }
  function applyFreshPolicyRoute(t, current, resolvedPolicy) {
    if (current?.recovery || !resolvedPolicy) return;
    t.model = resolvedPolicy.model;
    t.effort = resolvedPolicy.effort;
    t.exec = execProjection(resolvedPolicy.exec);
  }
  function resolveDispatchRoutePolicy(slug, t, current) {
    rederiveUnlaunchedPreparedRoute(t, slug);
    const resolvedPolicy = resolveTicketRoute(t, getCategory(ticketCategory(t), { project: slug }));
    applyFreshPolicyRoute(t, current, resolvedPolicy);
    if (resolvedPolicy?.refusal) throw new Error(resolvedPolicy.refusal);
    return resolvedPolicy;
  }
  function ensurePreparedLaunchName(t, current) {
    if (!current.launchSeq) current.launchSeq = 1;
    if (current.launchName) return;
    const route = current.route || { model: t.model, effort: t.effort };
    current.launchName = dispatchLaunchName(t.ref, t.title, resolveExec(route.model, route.effort), route.effort, current.launchSeq);
  }
  function reusePreparedRecovery(slug, t, current, opts) {
    if (opts.sessionId) current.sessionId = String(opts.sessionId);
    ensurePreparedLaunchName(t, current);
    return {
      ok: true,
      ticket: t,
      token: t.dispatchNonce,
      reused: true,
      recovery: current.recovery
    };
  }
  function pendingRecoveryFallback(current, currentRoute) {
    return Boolean(current?.recovery) && !current.terminalAt && !currentRoute;
  }
  function applyRecoveryFallback(t, current, currentRoute) {
    if (!pendingRecoveryFallback(current, currentRoute)) return;
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
  function guardLockedDispatch(slug, t, current, opts, projectPath, effects) {
    assertNoPendingSubmission(t);
    const crossBoundWorktree = reclaimRetiredCheckout(slug, projectPath, t, current, effects);
    assertNoLiveRuntimeAttempt(t, current, opts);
    const repeatFailure = repeatNoCommitDispatchError(t, current);
    const unboundAttemptsSkipped = skippedUnboundNoCommitAttempts(current);
    if (repeatFailure && opts.allowRepeatFailure !== true) throw new Error(repeatFailure);
    const retainedContinuation = retainedContinuationCandidate(slug, t, current);
    assertNoLiveClaim(t);
    return { crossBoundWorktree, repeatFailure, unboundAttemptsSkipped, retainedContinuation };
  }
  function prepareLockedDispatch(slug, idOrRef, found, opts, preflight, effects) {
    const t = getTicket(slug, found.id);
    if (!t) throw new Error(`prepare dispatch: no ticket "${idOrRef}".`);
    const current = dispatchState(t);
    const guarded = guardLockedDispatch(slug, t, current, opts, preflight.projectPath, effects);
    const resolvedPolicy = resolveDispatchRoutePolicy(slug, t, current);
    const currentRoute = activeDispatchRoute(t);
    if (reusablePreparedRecovery(t, current)) return reusePreparedRecovery(slug, t, current, opts);
    applyRecoveryFallback(t, current, currentRoute);
    return mintPreparedDispatch(slug, t, current, opts, preflight, effects, { ...guarded, resolvedPolicy });
  }
  function blankEffort(effort) {
    return effort == null || String(effort).trim() === "";
  }
  function defaultClaudeEffort(t) {
    const backend = availableRoute(t.model);
    if (backend?.backend !== "claude" || !blankEffort(t.effort)) return;
    t.effort = "low";
    t.exec = execProjection(resolveExec(t.model, t.effort));
  }
  function preparedExecutableRoute(slug, t, opts) {
    const refusal = dispatchRouteRefusal({ model: t.model, effort: t.effort });
    if (refusal) throw new Error(refusal);
    const preparedExec = resolveExec(t.model, t.effort);
    if (!preparedExec) throw new Error(`prepare dispatch: ${t.ref} has no executable route.`);
    const scopeRefusal = undeclaredScopeRefusal(slug, t, opts);
    if (scopeRefusal) throw new Error(scopeRefusal);
    return preparedExec;
  }
  function policyFallbackReason(current, resolvedPolicy) {
    return !current?.recovery && resolvedPolicy?.fallbackReason || null;
  }
  function routedRecovery(t, current) {
    return current?.recovery && activeDispatchRoute(t) ? current.recovery : null;
  }
  function priorAttemptHistory(current) {
    return {
      attempts: Array.isArray(current?.attempts) ? current.attempts.slice() : [],
      supersededTokens: Array.isArray(current?.supersededTokens) ? current.supersededTokens.slice() : []
    };
  }
  function liveDispatchToken(t, current) {
    return Boolean(current) && !current.terminalAt && Boolean(t.dispatchNonce);
  }
  function supersedeLiveToken(projectPath, t, current, supersededTokens, now, effects) {
    if (!liveDispatchToken(t, current)) return;
    if (current.outcome === "prepared" && current.sharedTree === false) {
      queueCheckoutReclaim(effects, unclaimedDispatchWorktreeReclaim(projectPath, current));
    }
    supersededTokens.push({
      digest: dispatchTokenDigest(t.dispatchNonce),
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      at: now
    });
  }
  function releasedDeclaredBinding(current) {
    return current?.outcome === "released" && Array.isArray(current.declaredFiles) && current.declaredFiles.length ? current.declaredFiles.filter((file) => file !== WHOLE_TREE_SCOPE) : null;
  }
  function dispatchEffectiveFiles(slug, t, current) {
    const releasedBinding = releasedDeclaredBinding(current);
    return releasedBinding ? Array.from(/* @__PURE__ */ new Set([...releasedBinding, ...effectiveScope(slug, t)])) : effectiveScope(slug, t);
  }
  function wholeTreeScopeOverride(t, opts, readonly) {
    return !readonly && opts.allowUnscoped === true && !normalizeFiles(t.files).length;
  }
  function requestedSharedTree(opts, current) {
    return opts.sharedTree === true || !Object.hasOwn(opts, "sharedTree") && Boolean(current?.sharedTree);
  }
  function requestedReducedAgentSchema(opts, current) {
    return opts.reducedAgentSchema === true || !Object.hasOwn(opts, "reducedAgentSchema") && current?.reducedAgentSchema === true;
  }
  function initialSharedTree(reviewTargetState, worktreeIsolation, requested) {
    if (reviewTargetState) return false;
    return worktreeIsolation ? requested : true;
  }
  function isolatedCheckoutWarning(slug, sharedTree, readonly, effectiveFiles) {
    return !sharedTree && (readonly || effectiveFiles.length) ? worktreeIsolationWarning(slug, readonly) : null;
  }
  function isolationWarning(slug, worktreeIsolation, explicitIsolation, sharedTree, readonly, effectiveFiles) {
    if (!worktreeIsolation && explicitIsolation) {
      return `Board worktree isolation is disabled; explicit sharedTree:false was overridden. Spawning in shared tree. ${sharedTreeExecutionGuidance(readonly)}`;
    }
    return isolatedCheckoutWarning(slug, sharedTree, readonly, effectiveFiles);
  }
  function assertReviewCheckoutIsolation(t, reviewTargetState, opts, worktreeWarning) {
    if (!reviewTargetState) return;
    if (opts.sharedTree === true) {
      throw new Error(`prepare dispatch: ${t.ref} reviews candidate ${reviewTargetState.candidate.value} and requires an isolated immutable checkout.`);
    }
    if (worktreeWarning) throw new Error(`prepare dispatch: ${t.ref} cannot pin the immutable candidate checkout. ${worktreeWarning}`);
  }
  function dispatchIsolation(slug, t, current, opts, effectiveFiles) {
    const readonly = dispatchReadOnly(t);
    const worktreeIsolation = normalizeWorktreeIsolation(readMeta(slug)?.worktreeIsolation);
    const reviewTargetState = reviewDispatchTarget(slug, t);
    const sharedTree = initialSharedTree(reviewTargetState, worktreeIsolation, requestedSharedTree(opts, current));
    const explicitIsolation = Object.hasOwn(opts, "sharedTree") && opts.sharedTree === false;
    const worktreeWarning = isolationWarning(slug, worktreeIsolation, explicitIsolation, sharedTree, readonly, effectiveFiles);
    assertReviewCheckoutIsolation(t, reviewTargetState, opts, worktreeWarning);
    return {
      readonly,
      wholeTreeScope: wholeTreeScopeOverride(t, opts, readonly),
      reducedAgentSchema: requestedReducedAgentSchema(opts, current),
      reviewTargetState,
      sharedTree: sharedTree || Boolean(worktreeWarning),
      nonRepoOutput: nonRepoExternalOutput(t, effectiveFiles),
      worktreeWarning
    };
  }
  function writableIsolatedRepositoryCheckout(isolation) {
    return !(isolation.sharedTree || isolation.readonly || isolation.nonRepoOutput || isolation.wholeTreeScope);
  }
  function assertCompositionCheckout(t, isolation) {
    if (t.compositionAdmission && !writableIsolatedRepositoryCheckout(isolation)) {
      throw new Error(`prepare dispatch: ${t.ref} composition admission requires a scoped writable native isolated repository checkout.`);
    }
  }
  function sharedTreeScopeRefusal(t, isolation, effectiveFiles) {
    if (isolation.wholeTreeScope && isolation.sharedTree) return unscopedSharedTreeRefusal(t.ref, effectiveFiles);
    if (t.workingTreeDelivery === true && !isolation.sharedTree) {
      return `prepare dispatch: ${t.ref} declares a working-tree deliverable and must run in the shared checkout. Re-dispatch with sharedTree:true.`;
    }
    return null;
  }
  function dispatchRuntimeRefusal(slug, t, sharedTree, projectPath, opts) {
    return sharedTree ? sharedTreeRuntimeRefusal(t, projectPath, opts.runtimeCwd) : isolatedTreeRuntimeRefusal(t, projectPath, opts.runtimeCwd, slug, opts.sessionId);
  }
  function assertDispatchCheckoutShape(slug, t, isolation, effectiveFiles, projectPath, opts) {
    assertCompositionCheckout(t, isolation);
    const refusal = sharedTreeScopeRefusal(t, isolation, effectiveFiles) || dispatchRuntimeRefusal(slug, t, isolation.sharedTree, projectPath, opts);
    if (refusal) throw new Error(refusal);
  }
  function workingTreeDeliveryRequested(t, sharedTree, effectiveFiles) {
    return sharedTree && t.workingTreeDelivery === true && effectiveFiles.length > 0;
  }
  function deliveryVerification(slug, t, sharedTree, effectiveFiles) {
    const workingTreeDelivery = workingTreeDeliveryRequested(t, sharedTree, effectiveFiles);
    const verificationRequirement2 = boardVerificationRequirement(slug, t, sharedTree);
    if (workingTreeDelivery && verificationRequirement2.kind === "review") {
      throw new Error(`prepare dispatch: ${t.ref} working-tree delivery cannot use review verification because executor evidence has no independent reviewer provenance.`);
    }
    return { workingTreeDelivery, verificationRequirement: verificationRequirement2 };
  }
  function dispatchArtifactRoot(slug, t, sharedTree, effectiveFiles) {
    return sharedTree && effectiveFiles.length === 1 && sharedTreeArtifactRequested(t) ? categoryArtifactRoot(getCategory(ticketCategory(t), { project: slug }), effectiveFiles[0]) : null;
  }
  function dispatchWriteScope(t, effectiveFiles, wholeTreeScope, artifactMode) {
    const writeScope = wholeTreeScope ? [WHOLE_TREE_SCOPE, ...effectiveFiles] : effectiveFiles;
    const declaredFiles = artifactMode ? effectiveFiles : commitScope.ticketCommitScope(writeScope, t.files, t.ref);
    const boardAddedFiles = declaredFiles.filter((file) => file !== WHOLE_TREE_SCOPE && !commitScope.isInScope(file, t.files));
    return { declaredFiles, boardAddedFiles };
  }
  function workingTreeDirtyBaseline(dirtyBaselineCapture, workingTreeDelivery) {
    return workingTreeDelivery ? dirtyBaselineCapture?.baseline || null : null;
  }
  function dispatchDirtyBaselines(slug, sharedTree, artifactMode, artifactScope, workingTreeDelivery) {
    const artifactDirtyBaseline = artifactMode ? captureArtifactBaseline(slug, artifactScope) : null;
    const dirtyBaselineCapture = sharedTree && !artifactMode ? captureDirtyBaseline(slug) : null;
    return { artifactDirtyBaseline, dirtyBaselineCapture, workingTreeDirtyBaseline: workingTreeDirtyBaseline(dirtyBaselineCapture, workingTreeDelivery) };
  }
  function dispatchArtifactScope(slug, t, isolation, effectiveFiles, workingTreeDelivery) {
    const artifactRoot = dispatchArtifactRoot(slug, t, isolation.sharedTree, effectiveFiles);
    const artifactMode = Boolean(artifactRoot);
    const artifactScope = artifactMode ? effectiveFiles[0] : null;
    return {
      artifactRoot,
      artifactMode,
      artifactScope,
      ...dispatchWriteScope(t, effectiveFiles, isolation.wholeTreeScope, artifactMode),
      ...dispatchDirtyBaselines(slug, isolation.sharedTree, artifactMode, artifactScope, workingTreeDelivery)
    };
  }
  function storyDispatchFacts(slug, t) {
    const story = t.storyId ? getStory(slug, t.storyId) : null;
    const storyLogRevision = Number(story?.logRevision) || 0;
    t.storyLogSeenSeq = storyLogRevision;
    return { contract: storyExecutionContract(story), storyLogRevision, contractDrift: t.storyContractDrift || null };
  }
  function configuredIntegration(slug) {
    return {
      integrationMode: String(readMeta(slug)?.integrationMode || "auto").trim().toLowerCase(),
      worktreeBase: boardConfig(slug)?.worktreeBase || "auto"
    };
  }
  function explicitIntegrationTargetRequested(opts) {
    return opts.integrationBranch != null || opts.integrationMode != null;
  }
  function isolatedRepositoryDispatch(isolation) {
    return !isolation.sharedTree && !isolation.readonly && !isolation.nonRepoOutput;
  }
  function automaticWorktreeBaseEligible(isolation, worktreeBase) {
    return isolatedRepositoryDispatch(isolation) || !isolation.sharedTree && isolation.readonly && !isolation.nonRepoOutput && worktreeBase !== "auto";
  }
  function remoteIntegrationTarget(slug, worktreeBase) {
    try {
      return integrationTarget(slug, { mode: "remote" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} The configured worktreeBase is "${worktreeBase}"; use --worktree-base local-main to dispatch from the local integration branch.`);
    }
  }
  function aheadLocalOrRemoteTarget(slug, projectPath, worktreeBase) {
    let localTarget;
    try {
      localTarget = integrationTarget(slug, { mode: "local" });
    } catch (_) {
      return remoteIntegrationTarget(slug, worktreeBase);
    }
    return localAheadOfUpstreamWarning(projectPath, localTarget.branch) ? localTarget : remoteIntegrationTarget(slug, worktreeBase);
  }
  function autoSelectedIntegrationTarget(slug, worktreeBase) {
    const projectPath = readMeta(slug)?.path || "";
    if (!hasOriginRemote(projectPath)) return null;
    return aheadLocalOrRemoteTarget(slug, projectPath, worktreeBase);
  }
  function originMainIntegrationTarget(slug, worktreeBase) {
    return hasOriginRemote(readMeta(slug)?.path || "") ? remoteIntegrationTarget(slug, worktreeBase) : null;
  }
  function configuredWorktreeBaseTarget(slug, worktreeBase) {
    if (worktreeBase === "local-main") return integrationTarget(slug, { mode: "local" });
    if (worktreeBase === "origin-main") return originMainIntegrationTarget(slug, worktreeBase);
    return autoSelectedIntegrationTarget(slug, worktreeBase);
  }
  function automaticWorktreeBase(slug, isolation, configured) {
    return automaticWorktreeBaseEligible(isolation, configured.worktreeBase) && configured.integrationMode === "auto" ? configuredWorktreeBaseTarget(slug, configured.worktreeBase) : null;
  }
  function explicitIntegrationTargetSelection(opts) {
    return {
      ...opts.integrationBranch != null ? { branch: opts.integrationBranch } : {},
      ...opts.integrationMode != null ? { mode: opts.integrationMode } : {}
    };
  }
  function dispatchIntegrationTarget(slug, opts, isolation) {
    if (explicitIntegrationTargetRequested(opts)) return integrationTarget(slug, explicitIntegrationTargetSelection(opts));
    const configured = configuredIntegration(slug);
    const automatic = automaticWorktreeBase(slug, isolation, configured);
    const configuredTarget = isolatedRepositoryDispatch(isolation) && configured.integrationMode !== "auto";
    return automatic || (configuredTarget ? integrationTarget(slug) : null);
  }
  function integrationTargetLabel(integrationTargetState) {
    return integrationTargetState.mode === "local" ? `local ${integrationTargetState.branch}` : integrationTargetState.upstream;
  }
  function localAheadIntegrationWarning(slug, sharedTree, integrationTargetState) {
    return !sharedTree && integrationTargetState ? localAheadOfUpstreamWarning(readMeta(slug)?.path || "", integrationTargetState.branch, integrationTargetLabel(integrationTargetState)) : null;
  }
  function integrationBaseCommit(slug, integrationTargetState) {
    const projectPath = readMeta(slug)?.path || "";
    return integrationTargetState ? integrationTargetCommit(projectPath, integrationTargetState) : commitScope.headCommit(projectPath);
  }
  function dispatchBaseCommit(slug, t, reviewTargetState, integrationTargetState) {
    if (t.compositionAdmission) return t.compositionAdmission.base;
    if (reviewTargetState?.candidate.source === "git") return reviewTargetState.candidate.value;
    return integrationBaseCommit(slug, integrationTargetState);
  }
  function publishBranchRef(slug, integrationTargetState) {
    return `refs/remotes/origin/${integrationTargetState?.branch || boardConfig(slug)?.integrationBranch || "main"}`;
  }
  function assertPublishedReleaseBaseline(slug, t, projectPath, baseCommit, integrationTargetState) {
    const releaseTip = projectPath ? commitScope.unpublishedReleaseTip(projectPath, baseCommit, publishBranchRef(slug, integrationTargetState)) : null;
    if (releaseTip) {
      throw new Error(`prepare dispatch: ${t.ref} refused; baseline ${releaseTip.commit} is an unpublished release commit, tagged ${releaseTip.tags.join(", ")} and not yet on the remote branch. A direct release cut tags its commit before running its suites, so this is either a direct cut still in flight or one that failed and left its commit live. The prepare/finalize flow never reaches this state: preparation creates no tag, and finalize only tags a commit the remote branch already has. Wait for the cut to finish and push, or tear it down (delete those tags and reset the branch), then dispatch again.`);
    }
  }
  function planPreparedDispatch(slug, t, current, opts, preflight, effects, guarded) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    defaultClaudeEffort(t);
    const preparedExec = preparedExecutableRoute(slug, t, opts);
    const fallbackReason = policyFallbackReason(current, guarded.resolvedPolicy);
    const recovery = routedRecovery(t, current);
    const history = priorAttemptHistory(current);
    supersedeLiveToken(preflight.projectPath, t, current, history.supersededTokens, now, effects);
    effects.prior = dispatchTokenFile(t);
    const effectiveFiles = dispatchEffectiveFiles(slug, t, current);
    const isolation = dispatchIsolation(slug, t, current, opts, effectiveFiles);
    assertDispatchCheckoutShape(slug, t, isolation, effectiveFiles, preflight.projectPath, opts);
    const delivery = deliveryVerification(slug, t, isolation.sharedTree, effectiveFiles);
    const artifact = dispatchArtifactScope(slug, t, isolation, effectiveFiles, delivery.workingTreeDelivery);
    t.dispatchExecutor = stableExecutorName(t, artifact.artifactMode || delivery.workingTreeDelivery);
    const launchSeq = nextDispatchLaunchSeq(current);
    const story = storyDispatchFacts(slug, t);
    const integrationTargetState = dispatchIntegrationTarget(slug, opts, isolation);
    const localAheadWarning = localAheadIntegrationWarning(slug, isolation.sharedTree, integrationTargetState);
    delete t.storyContractDrift;
    const evidenceDirectory = ticketEvidenceDirectory(slug, t.ref, preflight.projectPath);
    fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 448 });
    const baseCommit = dispatchBaseCommit(slug, t, isolation.reviewTargetState, integrationTargetState);
    const releasedContinuation = explicitBaseContinuation(guarded.retainedContinuation, explicitIntegrationTargetRequested(opts), integrationTargetState, baseCommit);
    assertPublishedReleaseBaseline(slug, t, preflight.projectPath, baseCommit, integrationTargetState);
    const dispatchBaseline = dispatchBaselineForProject(slug, t, now, baseCommit, isolation.nonRepoOutput, preflight.snapshotPreflight);
    return {
      now,
      preparedExec,
      fallbackReason,
      recovery,
      history,
      effectiveFiles,
      isolation,
      delivery,
      artifact,
      launchSeq,
      story,
      integrationTargetState,
      localAheadWarning,
      evidenceDirectory,
      baseCommit,
      releasedContinuation,
      dispatchBaseline,
      guarded
    };
  }
  function preparingSessionId(opts) {
    return opts.sessionId ? String(opts.sessionId) : null;
  }
  function preparationProvenanceFields(plan, opts, preparedCompatibility) {
    return {
      lifecycleAttempt: prepareAttempt(
        plan.dispatchBaseline,
        Object.freeze({ actor: dispatchPreparationAttribution(opts), operation: "prepare", sessionId: preparingSessionId(opts) }),
        preparedCompatibility ? Object.freeze({ pluginInstall: preparedCompatibility.pluginInstall, identity: preparedCompatibility.identity }) : void 0,
        plan.delivery.verificationRequirement
      ),
      verificationRequirement: plan.delivery.verificationRequirement,
      evidenceDirectory: plan.evidenceDirectory,
      sessionId: preparingSessionId(opts),
      preparedBy: dispatchPreparationAttribution(opts),
      ...preparedCompatibility ? { preparedCompatibility } : {}
    };
  }
  function runtimeEnvironmentFields(pythonIoEncoding, opts) {
    return {
      ...pythonIoEncoding.written ? { pythonIoEncoding } : {},
      ...opts.dispatchSkew ? { dispatchSkew: opts.dispatchSkew } : {}
    };
  }
  function checkoutPlacementFields(plan, preflight, opts) {
    return {
      sharedTree: plan.isolation.sharedTree,
      ...plan.isolation.reducedAgentSchema ? { reducedAgentSchema: true } : {},
      ...plan.isolation.worktreeWarning ? { worktreeWarning: plan.isolation.worktreeWarning } : {},
      ...plan.guarded.crossBoundWorktree ? { crossBoundWorktree: plan.guarded.crossBoundWorktree } : {},
      ...runtimeEnvironmentFields(preflight.pythonIoEncoding, opts)
    };
  }
  function isolatedContinuationFields(sharedTree, releasedContinuation) {
    const continuation = releasedContinuation?.continuation;
    if (sharedTree || !continuation) return {};
    return {
      continuation,
      worktree: continuation.sourceWorktree,
      worktreeGitDirectory: continuation.lease.boundGitDirectory,
      worktreeCommonGitDirectory: continuation.lease.boundCommonGitDirectory,
      worktreeCheckoutInstance: continuation.lease.boundCheckoutInstance,
      worktreeObservedRevision: continuation.lease.boundRevision,
      worktreeBindingSource: "continuation"
    };
  }
  function sharedTreeContinuationFallback(sharedTree, releasedContinuation) {
    return sharedTree && releasedContinuation?.continuation ? { continuationFallback: continuationFallback("continuation_checkpoint_requires_isolated_worktree", releasedContinuation.continuation.sourceWorktree) } : {};
  }
  function continuationFields(sharedTree, releasedContinuation) {
    return {
      ...isolatedContinuationFields(sharedTree, releasedContinuation),
      ...releasedContinuation?.fallback ? { continuationFallback: releasedContinuation.fallback } : {},
      ...sharedTreeContinuationFallback(sharedTree, releasedContinuation)
    };
  }
  function integrationFields(t, plan) {
    return {
      // Record the integration target commit so an isolated executor can bring
      // its harness-created worktree forward before changing it.
      baseCommit: plan.baseCommit,
      ...plan.isolation.reviewTargetState ? { reviewTarget: t.reviewTarget } : {},
      ...plan.integrationTargetState ? { integrationTarget: plan.integrationTargetState } : {},
      ...plan.localAheadWarning ? { localAheadWarning: plan.localAheadWarning } : {}
    };
  }
  function unscopedOverrideFields(slug, wholeTreeScope, opts, now) {
    if (!wholeTreeScope) return {};
    return {
      unscopedOverride: {
        at: now,
        source: dispatchSource(opts, "store"),
        writeScope: unscopedWriteScopeLine(boardConfig(slug)?.alwaysInScope)
      }
    };
  }
  function artifactFields(plan) {
    return {
      ...plan.isolation.nonRepoOutput ? { nonRepoOutput: true } : {},
      artifactMode: plan.artifact.artifactMode,
      artifactRoot: plan.artifact.artifactRoot,
      artifactScope: plan.artifact.artifactScope,
      ...plan.artifact.artifactMode ? { artifactDirtyBaseline: plan.artifact.artifactDirtyBaseline } : {}
    };
  }
  function sharedTreeDirtyBaseline(artifact) {
    return artifact.artifactDirtyBaseline || artifact.dirtyBaselineCapture?.baseline || null;
  }
  function dirtyBaselineFields(plan) {
    return {
      ...plan.artifact.dirtyBaselineCapture?.warning ? { dirtyBaselineWarning: plan.artifact.dirtyBaselineCapture.warning } : {},
      ...plan.delivery.workingTreeDelivery ? { workingTreeDelivery: true, workingTreeDirtyBaseline: plan.artifact.workingTreeDirtyBaseline } : {},
      ...plan.isolation.sharedTree ? { dirtyBaseline: sharedTreeDirtyBaseline(plan.artifact) } : {}
    };
  }
  function launchFields(t, plan) {
    return {
      tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
      tokenFile: newDispatchTokenFile(),
      executor: t.dispatchExecutor,
      description: spawnDescription(t, plan.preparedExec),
      launchSeq: plan.launchSeq,
      launchName: dispatchLaunchName(t.ref, t.title, plan.preparedExec, t.effort, plan.launchSeq),
      route: dispatchRouteState(t.model, t.effort, plan.preparedExec)
    };
  }
  function repeatFailureFields(plan, current, opts) {
    if (!plan.guarded.repeatFailure) return {};
    return {
      repeatFailureOverride: {
        at: plan.now,
        source: dispatchSource(opts, "store"),
        priorAttempts: recentNoCommitAttempts(current).length
      }
    };
  }
  function routeHistoryFields(plan, current, opts, preflight) {
    return {
      ...repeatFailureFields(plan, current, opts),
      ...plan.guarded.unboundAttemptsSkipped ? { unboundAttemptsSkipped: true } : {},
      ...plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : {},
      ...preflight.sourceRevisionAdapterSwitch ? { sourceRevisionAdapterSwitch: preflight.sourceRevisionAdapterSwitch } : {}
    };
  }
  function storyFields(plan) {
    return {
      storyContract: plan.story.contract,
      storyLogRevision: plan.story.storyLogRevision,
      ...plan.story.contractDrift ? { storyContractDrift: Object.assign({}, plan.story.contractDrift, { rebasedAt: plan.now }) } : {}
    };
  }
  function priorAttemptFields(plan) {
    return {
      ...plan.history.attempts.length ? { attempts: plan.history.attempts } : {},
      ...plan.history.supersededTokens.length ? { supersededTokens: plan.history.supersededTokens.slice(-8) } : {},
      ...plan.recovery ? { recovery: plan.recovery } : {}
    };
  }
  function preparedDispatchRecord(slug, t, current, plan, opts, preflight) {
    return {
      ...preparationProvenanceFields(plan, opts, preflight.preparedCompatibility),
      ...checkoutPlacementFields(plan, preflight, opts),
      declaredFiles: plan.artifact.declaredFiles,
      boardAddedFiles: plan.artifact.boardAddedFiles,
      ...continuationFields(plan.isolation.sharedTree, plan.releasedContinuation),
      ...integrationFields(t, plan),
      readonly: plan.isolation.readonly,
      ...unscopedOverrideFields(slug, plan.isolation.wholeTreeScope, opts, plan.now),
      ...artifactFields(plan),
      ...dirtyBaselineFields(plan),
      ...launchFields(t, plan),
      ...routeHistoryFields(plan, current, opts, preflight),
      ...storyFields(plan),
      preparedAt: plan.now,
      launchedAt: null,
      boundAt: null,
      claimedAt: null,
      terminalAt: null,
      outcome: "prepared",
      ...priorAttemptFields(plan)
    };
  }
  function preparedDispatchWarnings(plan, preflight) {
    return [plan.localAheadWarning?.message, plan.artifact.dirtyBaselineCapture?.warning, preflight.servingCompatibilityWarning, plan.guarded.crossBoundWorktree?.message].filter((warning) => Boolean(warning));
  }
  function mintPreparedDispatch(slug, t, current, opts, preflight, effects, guarded) {
    const plan = planPreparedDispatch(slug, t, current, opts, preflight, effects, guarded);
    t.dispatchNonce = mintDispatchToken();
    t.dispatch = preparedDispatchRecord(slug, t, current, plan, opts, preflight);
    consumePreparedComposition(t, dispatchTokenDigest(t.dispatchNonce));
    effects.staged = dispatchTokenFile(t);
    t.lifecycleAttempt = t.dispatch.lifecycleAttempt;
    stampDispatchEvent(t, "dispatch", plan.now);
    writeDispatchTokenFile(t);
    const warnings = preparedDispatchWarnings(plan, preflight);
    return { ok: true, ticket: t, token: t.dispatchNonce, recovery: plan.recovery, ...warnings.length ? { warnings } : {} };
  }
  function discardReplacedTokenFile(effects) {
    if (effects.prior && effects.staged && effects.prior !== effects.staged) {
      try {
        fs.unlinkSync(effects.prior);
      } catch (_) {
      }
    }
  }
  function discardUncommittedTokenFile(effects) {
    if (effects.staged && effects.staged !== effects.prior) {
      try {
        fs.unlinkSync(effects.staged);
      } catch (_) {
      }
    }
  }
  function changedDuringPreparationError(slug, changedId) {
    const changed = getTicket(slug, changedId);
    return new Error(`prepare dispatch: ${changed?.ref || changedId} changed while this dispatch was reading its checkouts, so nothing was written and no checkout was removed. Read the ticket again and dispatch once more if it still needs a runtime.`);
  }
  function checkoutReclaimWarning(reclaim) {
    try {
      return reclaimOutcomeWarning(reclaim());
    } catch (error) {
      return [`Dispatch committed; removing the retired checkout failed and it was left in place: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  function reclaimOutcomeWarning(result) {
    if (!result.reclaimed) return [`Dispatch committed; retired checkout ${result.worktree} was kept: ${result.message || result.reason}`];
    return result.branchKept ? [`Dispatch committed; retired checkout ${result.worktree} was removed, but deleting its branch ${result.branch} failed and the branch was kept: ${result.branchKept}`] : [];
  }
  function commitLockedPreparation(slug, lockedIds, assertAdmissionHolds, effects, prepare) {
    const generations = ticketGenerations(slug, lockedIds);
    assertAdmissionHolds();
    const prepared = prepare();
    guardedTransaction(() => {
      const changedId = changedTicketSince(slug, generations);
      if (changedId) throw changedDuringPreparationError(slug, changedId);
      putTicket(slug, prepared.ticket);
    });
    const warnings = [...prepared.warnings || [], ...effects.checkoutReclaims.flatMap(checkoutReclaimWarning)];
    return warnings.length ? { ...prepared, warnings } : prepared;
  }
  function prepareUnderDispatchLocks(slug, idOrRef, found, opts, preflight) {
    const effects = { prior: null, staged: null, checkoutReclaims: [] };
    try {
      const prepared = dependencies.withCompositionDispatchPreparation(
        slug,
        found.id,
        (lockedIds, assertAdmissionHolds) => commitLockedPreparation(
          slug,
          lockedIds,
          assertAdmissionHolds,
          effects,
          () => prepareLockedDispatch(slug, idOrRef, found, opts, preflight, effects)
        )
      );
      discardReplacedTokenFile(effects);
      return prepared;
    } catch (error) {
      discardUncommittedTokenFile(effects);
      throw error;
    }
  }
  function prepareDispatch(slug, idOrRef, opts) {
    opts = opts || {};
    if (opts.retireOnly === true) return retireUnboundDispatchOnly(slug, idOrRef, opts);
    const { projectPath, found } = dispatchableTicket(slug, idOrRef, opts);
    const install = preparedInstallCompatibility(found, projectPath);
    supersedeEvidencedAttempt(slug, found, opts);
    assertDispatchTransport(opts.transport, { allowUnverifiedTransport: !!opts.allowUnverifiedTransport });
    const preflight = { projectPath, ...install, ...preparedDispatchEnvironment(slug, found, idOrRef, projectPath) };
    return prepareUnderDispatchLocks(slug, idOrRef, found, opts, preflight);
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
    const briefed = withTicketLock(slug, ticket.id, () => {
      const current = getTicket(slug, ticket.id);
      const currentState = dispatchState(current);
      if (!currentState || currentState.terminalAt || !dispatchTokenMatches(current.dispatchNonce, receivedToken)) return null;
      currentState.briefedAt = (/* @__PURE__ */ new Date()).toISOString();
      stampDispatchEvent(current, "briefing-served", currentState.briefedAt);
      putTicket(slug, current);
      return current;
    });
    return { ok: true, ticket: briefed || ticket, token: receivedToken };
  }
  function trimmedRecoveryText(value) {
    return String(value || "").trim();
  }
  function liveClaimRecoveryRequest(opts = {}) {
    return {
      by: trimmedRecoveryText(opts.by),
      executor: trimmedRecoveryText(opts.executor),
      worktree: trimmedRecoveryText(opts.worktree),
      evidence: trimmedRecoveryText(opts.recoveryEvidence),
      sessionId: trimmedRecoveryText(opts.sessionId)
    };
  }
  function isLiveClaimedBy(ticket, by) {
    return ticket?.claim?.by === by;
  }
  function liveClaimHolderRefusal(ticket, idOrRef, by) {
    return { ok: false, reason: "not_claim_holder", ticket, message: `${ticket?.ref || idOrRef} is not live-claimed by ${by}.` };
  }
  function isLiveIsolatedClaim(state) {
    return state?.outcome === "claimed" && state.sharedTree === false && !state.terminalAt;
  }
  function claimRuntimeExecutor(ticket, executor) {
    return ticket.claim.runtime?.executor || executor;
  }
  function liveClaimExecutorRefusal(ticket, state, executor) {
    if (state.executor !== executor || claimRuntimeExecutor(ticket, executor) !== executor) {
      return { ok: false, reason: "executor_mismatch", ticket, message: `${ticket.ref} requires executor ${state.executor || "(unavailable)"}, not ${executor}.` };
    }
    return null;
  }
  function consumedCompositionRecoveryRefusal(ticket) {
    const consumed = consumedAdmissionRefusal(ticket);
    return consumed && {
      ok: false,
      reason: consumed.reason,
      ticket,
      message: `${ticket.ref}: ${consumed.message} Live-claim recovery would re-mint the dispatch nonce that consumed it, so it is refused and nothing was written. The live claim holder keeps its existing dispatch token and bound native checkout; this composition generation cannot be re-minted or redispatched.`
    };
  }
  function liveClaimRecoveryRefusal(ticket, state, request, idOrRef) {
    if (!isLiveClaimedBy(ticket, request.by)) return liveClaimHolderRefusal(ticket, idOrRef, request.by);
    if (!isLiveIsolatedClaim(state)) {
      return { ok: false, reason: "dispatch_unavailable", ticket, message: `${ticket.ref} does not have a live isolated claimed dispatch to recover.` };
    }
    return liveClaimExecutorRefusal(ticket, state, request.executor) || consumedCompositionRecoveryRefusal(ticket);
  }
  function resumeLiveClaim(ticket, state, facts, request, now) {
    state.sessionId = request.sessionId;
    state.agentId = null;
    state.continuation = {
      mode: "live_claim_resume",
      ticketRef: ticket.ref,
      sourceWorktree: facts.worktree,
      baseCommit: state.baseCommit,
      commit: facts.revision
    };
    bindCheckoutFacts(state, facts);
    state.worktreeBindingSource = "live-claim-recovery";
    state.worktreeBoundAt = now;
    state.resumedAt = now;
    state.liveClaimRecovery = { at: now, by: request.by, executor: request.executor, evidence: request.evidence };
    ticket.dispatchNonce = mintDispatchToken();
    state.tokenPrefix = dispatchTokenPrefix(ticket.dispatchNonce);
    writeDispatchTokenFile(ticket);
    syncClaimRuntimeIdentity(ticket, state);
    stampDispatchEvent(ticket, "live-claim-recovery", now);
  }
  function recoverLockedLiveClaim(slug, id, idOrRef, request, lockKeys) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    const refusal = liveClaimRecoveryRefusal(ticket, state, request, idOrRef);
    if (refusal) return refusal;
    const facts = immutableWorktreeFacts(slug, request.worktree);
    if (!facts) {
      return { ok: false, reason: "invalid_worktree", ticket, message: `${ticket.ref} recovery requires a linked worktree from this board project.` };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const rebind = liveClaimRebind(slug, ticket, state, facts, lockKeys, now);
    if (!rebind.ok) return { ok: false, reason: rebind.reason, ticket, message: rebind.message };
    resumeLiveClaim(ticket, state, facts, request, now);
    putTicket(slug, ticket);
    return {
      ok: true,
      ticket,
      token: ticket.dispatchNonce,
      recovery: Object.assign({ kind: "live_claim_resume", at: now, worktree: facts.worktree }, rebind.recovery)
    };
  }
  function recoverLiveClaimDispatch(slug, idOrRef, opts) {
    const request = liveClaimRecoveryRequest(opts);
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    if (Object.values(request).some((value) => !value)) {
      return { ok: false, reason: "missing_recovery_facts", message: "Live-claim recovery requires claimHolder, executor, worktree, recoveryEvidence, and a connected session." };
    }
    const lockKeys = recoveryLockKeys(slug, found, request.worktree);
    return withTicketLocks(lockKeys, () => recoverLockedLiveClaim(slug, found.id, idOrRef, request, lockKeys));
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
      let compatibilityWarning = null;
      if (state.preparedCompatibility?.pluginInstall) {
        const currentInstall = checkSidequestInstall(readMeta(slug)?.path || "");
        if (preparedCompatibilityHasProvenMismatch(state, currentInstall)) {
          const retired = retirePreparedCompatibilityStaleAttempt(slug, t, "tokened-launch-refusal");
          return {
            ok: false,
            reason: "prepared_compatibility_stale",
            ticket: retired,
            message: `${t.ref}'s prepared dispatch was retired because its Sidequest install snapshot is stale. Stop this launch; the orchestrator can dispatch a fresh token.`
          };
        }
        compatibilityWarning = preparedCompatibilityWarning(state, currentInstall);
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
      return { ok: true, ticket: t, ...compatibilityWarning ? { advisory: compatibilityWarning } : {} };
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
      removeDispatchTokenFile(t);
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
        ...state.reducedAgentSchema === true ? { reducedAgentSchema: true } : {},
        declaredFiles: Array.isArray(state.declaredFiles) ? state.declaredFiles.slice() : effectiveScope(slug, t),
        artifactMode: state.artifactMode === true,
        artifactRoot: state.artifactRoot || null,
        artifactScope: state.artifactScope || null,
        ...Array.isArray(state.artifactDirtyBaseline) ? { artifactDirtyBaseline: state.artifactDirtyBaseline.slice() } : {},
        tokenPrefix: dispatchTokenPrefix(t.dispatchNonce),
        tokenFile: newDispatchTokenFile(),
        executor: t.dispatchExecutor,
        description: spawnDescription(t, fallback.exec),
        launchSeq,
        launchName: dispatchLaunchName(t.ref, t.title, fallback.exec, fallback.effort, launchSeq),
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
      writeDispatchTokenFile(t);
      stampDispatchEvent(t, opts.source || "agent-launch-failure", now);
      putTicket(slug, t);
      return { ok: true, ticket: t, token: t.dispatchNonce, recovery };
    });
  }
  function dispatchCreationCandidate(state, sessionId) {
    return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && state.outcome === "launched" && !state.terminalAt && !state.worktree && !state.continuation?.sourceWorktree);
  }
  function unlaunchedSessionDispatch(slug, sessionId) {
    return listTickets(slug).some((candidate) => {
      const state = dispatchState(candidate);
      return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && state.outcome === "prepared" && !state.terminalAt && !state.worktree);
    });
  }
  function bindingFailurePredicate(state, sessionId, worktree) {
    if (state?.sessionId !== sessionId) return "session_id";
    if (state.sharedTree !== false) return "shared_tree";
    if (state.outcome !== "launched") return "outcome";
    if (state.terminalAt) return "terminal_at";
    if (state.worktreeBindingSource !== "worktree-create") return "worktree_binding_source";
    if (!state.worktree || canonicalPath(state.worktree) !== worktree) return "canonical_worktree";
    return "dispatch_binding_unavailable";
  }
  function launchedIsolatedSessionProjects(sessionId, skipSlug) {
    const owned = [];
    if (!sessionId) return owned;
    for (const project of listProjects({ all: true })) {
      if (!project?.slug || !project.path || project.slug === skipSlug) continue;
      for (const candidate of listTickets(project.slug)) {
        const state = dispatchState(candidate);
        if (state?.sessionId === sessionId && state.sharedTree === false && state.outcome === "launched" && !state.terminalAt) {
          owned.push({ slug: project.slug, path: String(project.path), state });
          break;
        }
      }
    }
    return owned;
  }
  function launchedIsolatedDispatchOnAnotherProject(slug, sessionId) {
    return launchedIsolatedSessionProjects(sessionId, slug)[0]?.state || null;
  }
  function isolatedDispatchRepositoryForSession(sessionId) {
    const boards = launchedIsolatedSessionProjects(String(sessionId || "").trim());
    return boards.length === 1 ? boards[0].path : null;
  }
  function unavailableWorktreeBinding(slug, candidates = [], sessionId, worktree) {
    const nearest = candidates.find(({ state: state2 }) => state2.sessionId === sessionId) || candidates.find(({ state: state2 }) => state2.worktree && canonicalPath(state2.worktree) === worktree);
    const crossProject = nearest ? null : launchedIsolatedDispatchOnAnotherProject(slug, sessionId);
    const state = nearest?.state || crossProject;
    return {
      ok: false,
      reason: "dispatch_binding_unavailable",
      binding: {
        candidatesConsidered: candidates.length,
        ...state ? {
          predicate: crossProject ? "different_project" : bindingFailurePredicate(state, sessionId, worktree),
          recordedSessionId: state.sessionId,
          recordedWorktree: state.worktree ? canonicalPath(state.worktree) : ""
        } : {},
        suppliedSessionId: sessionId,
        suppliedWorktree: worktree,
        crossProject: Boolean(crossProject)
      }
    };
  }
  function missingWorktreeCallbackAttempt(attempt) {
    return !String(attempt || "").trim();
  }
  function worktreeCallbackGenerationRefusal(state, attempt) {
    const claimed = String(attempt || "").trim();
    if (!claimed) return { ok: false, reason: "missing_attempt" };
    return claimed === String(state?.preparedAt || "").trim() ? null : { ok: false, reason: "stale_attempt" };
  }
  function liveIsolatedDispatch(state) {
    return Boolean(state && state.sharedTree === false && !state.terminalAt);
  }
  function liveSessionDispatch(state, sessionId) {
    return liveIsolatedDispatch(state) && state.sessionId === sessionId;
  }
  function recordedAtCheckout(state, checkout) {
    return Boolean(state?.worktree) && canonicalPath(state.worktree) === checkout;
  }
  function liveClaimOccupiesCheckout(candidate, state, checkout) {
    return Boolean(candidate?.claim?.by) && liveIsolatedDispatch(state) && recordedAtCheckout(state, checkout);
  }
  function reentrantCheckoutOwner(state, checkoutAgentId, sessionId) {
    if (state?.worktreeBindingSource !== "worktree-create") return state?.sessionId === sessionId;
    if (checkoutAgentId) return String(state.agentId || "") === checkoutAgentId;
    return Boolean(state.agentId) && state.sessionId === sessionId;
  }
  function occupiedCheckoutFailure(candidate, state, checkoutAgentId) {
    return {
      ownerRef: candidate.ref,
      ownerClaimHolder: String(candidate.claim.by),
      ownerAgentId: String(state.agentId || "").trim(),
      checkoutAgentId: String(checkoutAgentId || "")
    };
  }
  function occupiedCheckoutOwner(slug, boundWorktree, checkoutAgentId, sessionId) {
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (!liveClaimOccupiesCheckout(candidate, state, boundWorktree)) continue;
      if (reentrantCheckoutOwner(state, checkoutAgentId, sessionId)) continue;
      return occupiedCheckoutFailure(candidate, state, checkoutAgentId);
    }
    return null;
  }
  function holdsThisCheckout(state, sessionId, checkout) {
    return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && state.worktreeBindingSource === "worktree-create") && recordedAtCheckout(state, checkout);
  }
  function checkoutOwnerArrival(state, checkoutAgentId, sessionId) {
    if (state?.outcome === "launched") return true;
    return state?.outcome === "claimed" && reentrantCheckoutOwner(state, checkoutAgentId, sessionId);
  }
  function unbindableCheckoutHolder(slug, sessionId, boundWorktree, checkoutAgentId) {
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (holdsThisCheckout(state, sessionId, boundWorktree) && state.terminalAt) return { ok: false, reason: "stale_attempt" };
    }
    const occupied = occupiedCheckoutOwner(slug, boundWorktree, checkoutAgentId, sessionId);
    return occupied ? {
      ok: false,
      reason: "checkout_owned_by_live_claim",
      binding: { suppliedSessionId: sessionId, suppliedWorktree: boundWorktree, ...occupied }
    } : null;
  }
  function nativeCheckoutBindingRequest(slug, sessionId, worktree, attempt) {
    const identity = nativeCheckoutCallbackIdentity(sessionId, worktree);
    const meta = readMeta(slug);
    if (!identity || !meta?.path) return null;
    const repository = canonicalPath(meta.path);
    return {
      ...identity,
      repository,
      attempt: String(attempt || "").trim(),
      checkoutAgentId: agentIdFromWorktreePath(repository, identity.worktree)
    };
  }
  function existingNativeCheckoutOwner(ticket, request) {
    const state = dispatchState(ticket);
    if (!state || state.terminalAt) return false;
    return holdsThisCheckout(state, request.sessionId, request.worktree) && checkoutOwnerArrival(state, request.checkoutAgentId, request.sessionId);
  }
  function createdCheckoutExpectations(state) {
    return {
      expectedGitDirectory: state.worktreeGitDirectory ?? null,
      expectedCommonGitDirectory: state.worktreeCommonGitDirectory ?? null,
      expectedCheckoutInstance: state.worktreeCheckoutInstance ?? null,
      expectedRevision: state.worktreeObservedRevision ?? null
    };
  }
  function nativeCheckoutBindingResponse(ticket, state, request) {
    const baseline = String(compositionCheckoutCommit(state)).trim();
    if (!baseline) return { ok: false, reason: "baseline_unavailable" };
    return {
      ok: true,
      ref: ticket.ref,
      attempt: state.preparedAt ?? "",
      baseline,
      repository: request.repository,
      worktree: request.worktree,
      creationCompleted: Boolean(state.worktreeCreationCompletedAt),
      ...createdCheckoutExpectations(state)
    };
  }
  function nativeCallbackAttemptRefusal(attempt, state) {
    if (attempt && attempt !== state.preparedAt) return { ok: false, reason: "stale_attempt" };
    if (!attempt && !state.worktreeCreationCompletedAt) return { ok: false, reason: "missing_attempt" };
  }
  function existingNativeCheckoutBinding(slug, ticketId, request) {
    const ticket = getTicket(slug, ticketId);
    if (!ticket || !existingNativeCheckoutOwner(ticket, request)) return { ok: false, reason: "dispatch_binding_unavailable" };
    const state = dispatchState(ticket);
    return nativeCallbackAttemptRefusal(request.attempt, state) ?? nativeCheckoutBindingResponse(ticket, state, request);
  }
  function retainedCompositionCheckoutRefusal(ticket, worktree) {
    const admission = ticket.compositionAdmission;
    if (!admission) return;
    if (admission.releasedDispatch.worktree && canonicalPath(admission.releasedDispatch.worktree) === worktree) {
      return { ok: false, reason: "composition_checkout_reused" };
    }
    if (fs.existsSync(worktree)) return { ok: false, reason: "composition_checkout_occupied" };
  }
  function recordNativeCheckoutBinding(slug, ticket, state, request) {
    const response = nativeCheckoutBindingResponse(ticket, state, request);
    if (!response.ok) return response;
    state.worktree = request.worktree;
    state.worktreeBindingSource = "worktree-create";
    state.worktreeBoundAt = (/* @__PURE__ */ new Date()).toISOString();
    stampDispatchEvent(ticket, "worktree-create-binding", state.worktreeBoundAt);
    putTicket(slug, ticket);
    return {
      ok: true,
      ref: response.ref,
      attempt: response.attempt,
      baseline: response.baseline,
      repository: response.repository,
      worktree: response.worktree
    };
  }
  function freshNativeCheckoutBinding(slug, ticketId, request) {
    const ticket = getTicket(slug, ticketId);
    const state = dispatchState(ticket);
    if (!dispatchCreationCandidate(state, request.sessionId)) return { ok: false, reason: "already_bound" };
    if (request.attempt && request.attempt !== state.preparedAt) return { ok: false, reason: "stale_attempt" };
    return retainedCompositionCheckoutRefusal(ticket, request.worktree) ?? recordNativeCheckoutBinding(slug, ticket, state, request);
  }
  function bindAvailableNativeCheckout(slug, request, tickets) {
    const candidate = tickets.find((ticket) => dispatchCreationCandidate(dispatchState(ticket), request.sessionId));
    if (candidate) return dependencies.withCompositionGenerationLock(
      slug,
      candidate.id,
      () => freshNativeCheckoutBinding(slug, candidate.id, request)
    );
    if (unlaunchedSessionDispatch(slug, request.sessionId)) return { ok: false, reason: "dispatch_launch_unrecorded" };
    const candidates = tickets.map((candidate2) => ({ candidate: candidate2, state: dispatchState(candidate2) })).filter((candidate2) => Boolean(candidate2.state));
    return { ...unavailableWorktreeBinding(slug, candidates, request.sessionId, request.worktree), ok: false };
  }
  function bindDispatchWorktreeCreation(slug, sessionId, worktree, attempt) {
    const request = nativeCheckoutBindingRequest(slug, sessionId, worktree, attempt);
    if (!request) return { ok: false, reason: "missing_binding_facts" };
    const tickets = listTickets(slug);
    const existing = tickets.find((ticket) => existingNativeCheckoutOwner(ticket, request));
    if (existing) return dependencies.withCompositionGenerationLock(
      slug,
      existing.id,
      () => existingNativeCheckoutBinding(slug, existing.id, request)
    );
    const refusal = unbindableCheckoutHolder(slug, request.sessionId, request.worktree, request.checkoutAgentId);
    if (refusal) return { ...refusal, ok: false };
    return bindAvailableNativeCheckout(slug, request, tickets);
  }
  function nativeCheckoutCallbackIdentity(sessionId, worktree) {
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    if (!normalizedSessionId || !target) return null;
    return { sessionId: normalizedSessionId, worktree: canonicalPath(target) };
  }
  function launchedNativeCheckoutMatches(state, binding) {
    if (!state) return false;
    return [
      state.sessionId === binding.sessionId,
      state.sharedTree === false,
      state.outcome === "launched",
      !state.terminalAt,
      state.worktreeBindingSource === "worktree-create",
      Boolean(state.worktree),
      canonicalPath(state.worktree ?? "") === binding.worktree
    ].every(Boolean);
  }
  function createdCheckoutIdentityMatches(state, facts) {
    return [
      canonicalPath(state.worktreeGitDirectory ?? "") === facts.gitDirectory,
      canonicalPath(state.worktreeCommonGitDirectory ?? "") === facts.commonGitDirectory,
      state.worktreeCheckoutInstance === facts.checkoutInstance,
      state.worktreeObservedRevision === facts.revision
    ].every(Boolean);
  }
  function recordCreatedCheckoutIdentity(state, facts) {
    state.worktreeGitDirectory = facts.gitDirectory;
    state.worktreeCommonGitDirectory = facts.commonGitDirectory;
    state.worktreeCheckoutInstance = facts.checkoutInstance;
    state.worktreeObservedRevision = facts.revision;
    state.worktreeCreationCompletedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  function recordNativeCheckoutCompletion(slug, ticket, current, facts) {
    if (current.worktreeCreationCompletedAt) {
      return createdCheckoutIdentityMatches(current, facts) ? { ok: true, alreadyCompleted: true } : { ok: false, reason: "worktree_identity_mismatch" };
    }
    recordCreatedCheckoutIdentity(current, facts);
    stampDispatchEvent(ticket, "worktree-create-complete", current.worktreeCreationCompletedAt);
    putTicket(slug, ticket);
    return { ok: true, alreadyCompleted: false };
  }
  function compositionCheckoutWasReused(previous, worktree, facts) {
    return [
      previous.worktree && canonicalPath(previous.worktree) === worktree,
      previous.worktreeGitDirectory && canonicalPath(previous.worktreeGitDirectory) === facts.gitDirectory,
      previous.worktreeCheckoutInstance === facts.checkoutInstance
    ].some(Boolean);
  }
  function cleanCompositionCheckoutRefusal(worktree) {
    try {
      if (gitOutput(worktree, ["status", "--porcelain"])) return { ok: false, reason: "composition_checkout_dirty" };
    } catch {
      return { ok: false, reason: "composition_checkout_unobservable" };
    }
  }
  function compositionCheckoutIdentityRefusal(ticket, worktree, facts) {
    const admission = ticket.compositionAdmission;
    if (!admission) return;
    if (compositionCheckoutWasReused(admission.releasedDispatch, worktree, facts)) return { ok: false, reason: "composition_checkout_reused" };
    return cleanCompositionCheckoutRefusal(worktree);
  }
  function nativeCheckoutCompletionFacts(slug, worktree, state) {
    const facts = immutableWorktreeFacts(slug, worktree);
    if (!facts) return { ok: false, reason: "invalid_worktree_binding" };
    if (facts.revision !== String(compositionCheckoutCommit(state)).trim()) return { ok: false, reason: "worktree_revision_mismatch" };
    return facts;
  }
  function completeNativeCheckoutForTicket(slug, id, binding, attempt) {
    const ticket = getTicket(slug, id);
    const current = dispatchState(ticket);
    const generation = worktreeCallbackGenerationRefusal(current, attempt);
    if (generation) return { ...generation, ok: false };
    if (!launchedNativeCheckoutMatches(current, binding)) return { ok: false, reason: "dispatch_binding_unavailable" };
    const facts = nativeCheckoutCompletionFacts(slug, binding.worktree, current);
    if ("ok" in facts) return facts;
    return compositionCheckoutIdentityRefusal(ticket, binding.worktree, facts) ?? recordNativeCheckoutCompletion(slug, ticket, current, facts);
  }
  function completeDispatchWorktreeCreation(slug, sessionId, worktree, attempt) {
    if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: "missing_attempt" };
    const binding = nativeCheckoutCallbackIdentity(sessionId, worktree);
    if (!binding) return { ok: false, reason: "missing_binding_facts" };
    for (const candidate of listTickets(slug)) {
      if (!launchedNativeCheckoutMatches(dispatchState(candidate), binding)) continue;
      return dependencies.withCompositionGenerationLock(
        slug,
        candidate.id,
        () => completeNativeCheckoutForTicket(slug, candidate.id, binding, attempt)
      );
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function recordDispatchWorktreeProvisioned(slug, sessionId, worktree, attempt) {
    if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: "missing_attempt" };
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
        const generation = worktreeCallbackGenerationRefusal(current, attempt);
        if (generation) return generation;
        if (!current || current.sessionId !== normalizedSessionId || current.terminalAt || !current.worktree || canonicalPath(current.worktree) !== boundWorktree) {
          return { ok: false, reason: "dispatch_binding_unavailable" };
        }
        current.worktreeProvisionedAt = (/* @__PURE__ */ new Date()).toISOString();
        stampDispatchEvent(ticket, "worktree-provisioned", current.worktreeProvisionedAt);
        putTicket(slug, ticket);
        return { ok: true };
      });
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function recordDispatchWorktreeProvisioningFailure(slug, sessionId, worktree, failure, attempt) {
    if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: "missing_attempt" };
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    const command = String(failure?.command || "").trim();
    const reason = String(failure?.reason || "").trim();
    if (!normalizedSessionId || !target || !command || !reason) return { ok: false, reason: "missing_provisioning_failure_facts" };
    const boundWorktree = canonicalPath(target);
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false || state.outcome !== "launched" || state.terminalAt || state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
      return withTicketLock(slug, candidate.id, () => {
        const ticket = getTicket(slug, candidate.id);
        const current = dispatchState(ticket);
        const generation = worktreeCallbackGenerationRefusal(current, attempt);
        if (generation) return generation;
        if (!current || current.sessionId !== normalizedSessionId || current.sharedTree !== false || current.outcome !== "launched" || current.terminalAt || current.worktreeBindingSource !== "worktree-create" || !current.worktree || canonicalPath(current.worktree) !== boundWorktree || !current.worktreeCreationCompletedAt) {
          return { ok: false, reason: "dispatch_binding_unavailable" };
        }
        current.worktreeProvisioningFailure = {
          command,
          reason,
          stderrTail: String(failure?.stderrTail || "").trim().slice(-1e3),
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        stampDispatchEvent(ticket, "worktree-setup-incomplete", current.worktreeProvisioningFailure.at);
        putTicket(slug, ticket);
        return { ok: true };
      });
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function normalizedOwnedDependencyLink(worktree, dependency) {
    const relativePath = String(dependency?.relativePath || "").replace(/\\/g, "/");
    const target = String(dependency?.target || "").trim();
    if (!relativePath || path.isAbsolute(relativePath) || !path.isAbsolute(target)) return null;
    const linkPath = path.resolve(worktree, relativePath);
    const normalizedRelativePath = path.relative(worktree, linkPath).split(path.sep).join("/");
    if (normalizedRelativePath !== relativePath || normalizedRelativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
    const outsideWorktree = path.relative(worktree, linkPath);
    if (outsideWorktree === ".." || outsideWorktree.startsWith(`..${path.sep}`) || path.isAbsolute(outsideWorktree)) return null;
    return { relativePath, target: canonicalPath(target), mode: dependency?.mode === "copy" ? "copy" : "link" };
  }
  function recordDispatchWorktreeDependencyLink(slug, sessionId, worktree, dependency, attempt) {
    if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: "missing_attempt" };
    const normalizedSessionId = String(sessionId || "").trim();
    const target = String(worktree || "").trim();
    if (!normalizedSessionId || !target) return { ok: false, reason: "missing_dependency_link_facts" };
    const boundWorktree = canonicalPath(target);
    const link = normalizedOwnedDependencyLink(boundWorktree, dependency);
    if (!link) return { ok: false, reason: "invalid_dependency_link_facts" };
    for (const candidate of listTickets(slug)) {
      const state = dispatchState(candidate);
      if (!state || state.sessionId !== normalizedSessionId || state.sharedTree !== false || state.outcome !== "launched" || state.terminalAt || state.worktreeBindingSource !== "worktree-create" || !state.worktree || canonicalPath(state.worktree) !== boundWorktree) continue;
      return withTicketLock(slug, candidate.id, () => {
        const ticket = getTicket(slug, candidate.id);
        const current = dispatchState(ticket);
        const generation = worktreeCallbackGenerationRefusal(current, attempt);
        if (generation) return generation;
        if (!current || current.sessionId !== normalizedSessionId || current.sharedTree !== false || current.outcome !== "launched" || current.terminalAt || current.worktreeBindingSource !== "worktree-create" || !current.worktree || canonicalPath(current.worktree) !== boundWorktree || !current.worktreeCreationCompletedAt || !current.worktreeGitDirectory || !current.worktreeCommonGitDirectory || !current.worktreeCheckoutInstance || !current.worktreeObservedRevision) {
          return { ok: false, reason: "dispatch_binding_unavailable" };
        }
        const records = Array.isArray(current.ownedDependencyLinks) ? current.ownedDependencyLinks : [];
        const existing = records.find((record2) => String(record2?.relativePath || "") === link.relativePath);
        const record = {
          relativePath: link.relativePath,
          target: link.target,
          mode: link.mode,
          worktree: canonicalPath(current.worktree),
          gitDirectory: canonicalPath(current.worktreeGitDirectory),
          commonGitDirectory: canonicalPath(current.worktreeCommonGitDirectory),
          checkoutInstance: String(current.worktreeCheckoutInstance),
          revision: String(current.worktreeObservedRevision)
        };
        if (existing) {
          return JSON.stringify(existing) === JSON.stringify(record) ? { ok: true, alreadyRecorded: true } : { ok: false, reason: "dependency_link_record_mismatch" };
        }
        current.ownedDependencyLinks = [...records, record];
        stampDispatchEvent(ticket, "worktree-dependency-link-created");
        putTicket(slug, ticket);
        return { ok: true, alreadyRecorded: false };
      });
    }
    return { ok: false, reason: "dispatch_binding_unavailable" };
  }
  function recordRecoveredCheckoutIdentity(slug, state, worktree) {
    if (state.worktreeCreationCompletedAt) return;
    const facts = immutableWorktreeFacts(slug, worktree);
    const checkoutCommit = String(compositionCheckoutCommit(state)).trim();
    if (facts && checkoutCommit && facts.revision === checkoutCommit) recordCreatedCheckoutIdentity(state, facts);
  }
  function holdOrReleaseUncreatedCheckout(slug, ticket, state, sessionId, created) {
    if (created !== false) return;
    const held = holdUncreatedFailureForSibling(slug, ticket, state, sessionId);
    if (held) return held;
    releaseCrossedCreationBinding(state, null, (/* @__PURE__ */ new Date()).toISOString(), "worktree_create_failed");
  }
  function terminalizeFailedCheckoutCreation(slug, ticket, error) {
    setDispatchTerminal(ticket, "failed", "worktree-create-recovery", {
      slug,
      error,
      failureShape: "worktree_create_failed"
    });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    stampDispatchEvent(ticket, "worktree-create-recovery");
    putTicket(slug, ticket);
  }
  function recoverLaunchedCheckout(slug, id, binding, error, attempt, options) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    const generation = worktreeCallbackGenerationRefusal(state, attempt);
    if (generation) return generation;
    if (!launchedNativeCheckoutMatches(state, binding)) return { ok: false, reason: "dispatch_binding_unavailable" };
    recordRecoveredCheckoutIdentity(slug, state, binding.worktree);
    const held = holdOrReleaseUncreatedCheckout(slug, ticket, state, binding.sessionId, options?.created);
    if (held) return held;
    terminalizeFailedCheckoutCreation(slug, ticket, error);
    return { ok: true, ticket };
  }
  function recoverDispatchWorktreeCreation(slug, sessionId, worktree, error, attempt, options) {
    if (missingWorktreeCallbackAttempt(attempt)) return { ok: false, reason: "missing_attempt" };
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
    const terminal = withTicketLock(slug, matches[0].id, () => recoverLaunchedCheckout(slug, matches[0].id, { sessionId: normalizedSessionId, worktree: boundWorktree }, error, attempt, options));
    if (!terminal?.ok || terminal.heldFor) return terminal;
    const cleanup = reclaimRetiredAttemptCheckout(slug, meta.path, terminal.ticket, dispatchState(terminal.ticket));
    return { ok: true, ticket: terminal.ticket, cleanup };
  }
  function recordSanctionedCommit(slug, idOrRef, opts) {
    const by = String(opts?.by || "").trim();
    const commit = String(opts?.commit || "").trim().toLowerCase();
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    if (!by || !commit) return { ok: false, reason: "missing_sanctioned_commit_facts" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      const state = dispatchState(ticket);
      if (!state) return { ok: false, reason: "no_dispatch", ticket };
      if (ticket.claim?.by !== by) return { ok: false, reason: "not_owner", ticket };
      const recorded = Array.isArray(state.sanctionedCommits) ? state.sanctionedCommits.map(String) : [];
      if (!recorded.includes(commit)) recorded.push(commit);
      state.sanctionedCommits = recorded;
      putTicket(slug, ticket);
      return { ok: true, ticket, sanctionedCommits: recorded };
    });
  }
  function sanctionedRevisionsForLiveClaim(ticket, state) {
    if (!ticket?.claim?.by || !Array.isArray(state?.sanctionedCommits)) return [];
    return state.sanctionedCommits.map((commit) => String(commit).toLowerCase());
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
  function canonicalCheckout(value) {
    const trimmed = String(value || "").trim();
    return trimmed ? canonicalPath(trimmed) : "";
  }
  function mismatchedGateCheckouts(state, actualWorktree) {
    const actual = canonicalCheckout(actualWorktree);
    const bound = canonicalCheckout(state?.worktree);
    if (state?.sharedTree !== false || !actual || !bound || actual === bound) return null;
    return { boundWorktree: bound, actualWorktree: actual };
  }
  function otherLiveClaimOnCheckout(slug, ref, checkout) {
    for (const candidate of listTickets(slug)) {
      if (candidate?.ref === ref) continue;
      const state = dispatchState(candidate);
      if (!liveClaimOccupiesCheckout(candidate, state, checkout)) continue;
      return { ref: candidate.ref, claimHolder: String(candidate.claim.by), worktree: String(checkout) };
    }
    return null;
  }
  function crossedWorktreeBinding(slug, ticket, actualWorktree) {
    const checkouts = mismatchedGateCheckouts(dispatchState(ticket), actualWorktree);
    if (!checkouts) return null;
    const owner = otherLiveClaimOnCheckout(slug, ticket.ref, checkouts.actualWorktree) || otherLiveClaimOnCheckout(slug, ticket.ref, checkouts.boundWorktree);
    return owner ? { ref: ticket.ref, claimHolder: gatedClaimHolder(ticket), ...checkouts, owner } : null;
  }
  function gatedClaimHolder(ticket) {
    return ticket?.claim?.by ? String(ticket.claim.by) : "<your claim id>";
  }
  function dispatchCallerOwners(identity) {
    const agentId = String(identity?.agentId || "").trim();
    const ref = String(identity?.ref || "").trim().toUpperCase();
    if (!agentId) return [];
    return listProjects({ all: true }).flatMap((project) => listTickets(project.slug)).filter((ticket) => dispatchState(ticket)?.agentId === agentId && (!ref || String(ticket.ref).toUpperCase() === ref)).map((ticket) => ({ ref: ticket.ref, by: String(ticket.claim?.by || ticket.submission?.by || "").trim() })).filter((owner) => owner.by);
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
          sanctionedRevisions: sanctionedRevisionsForLiveClaim(ticket, state),
          claimHeld: Boolean(ticket.claim && ticket.claim.by),
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
      sanctionedRevisions: expectation.sanctionedRevisions,
      claimHeld: expectation.claimHeld,
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
  function dispatchUnboundClaim(identity) {
    const sessionId = String(identity?.sessionId || "").trim();
    const executor = String(identity?.executor || "").trim();
    const observedWorktree = String(identity?.observedWorktree || "").trim();
    const agentName = String(identity?.agentName || "").trim();
    if (!sessionId || !executor) return null;
    const matches = [];
    for (const project of listProjects({ all: true })) {
      const projectPath = readMeta(project.slug)?.path || null;
      if (observedWorktree && (!projectPath || worktreeIdentityKey(projectPath) !== worktreeIdentityKey(observedWorktree))) continue;
      for (const ticket of listTickets(project.slug)) {
        const state = dispatchState(ticket);
        if (!state || state.sharedTree !== true || state.sessionId !== sessionId || state.executor !== executor || state.agentId || !ticket.claim?.by || state.terminalAt || state.outcome !== "claimed") continue;
        if (agentName && state.agentName && state.agentName !== agentName) continue;
        matches.push({ ref: ticket.ref, project: project.slug });
      }
    }
    return matches.length === 1 ? matches[0] : null;
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
    const state = dispatchState(ticket);
    const projectPath = readMeta(slug)?.path || null;
    const sharedTreeWithoutCommit = state && state.sharedTree !== false && projectPath ? { root: projectPath, base: null } : null;
    const workspace = dispatchWorkspace(slug, ticket) || sharedTreeWithoutCommit;
    if (!workspace) return { ok: false, reason: "workspace_unavailable" };
    try {
      const workingState = state?.sharedTree !== false ? postDispatchWorkingState(slug, state) : { working: commitScope.workingPaths(workspace.root), preExisting: [], baselineRecorded: false };
      let head = null;
      try {
        head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
      } catch (error) {
        if (workspace.base) throw error;
      }
      let commits = [];
      if (head && workspace.base) {
        const base = execFileSync("git", ["rev-parse", "--verify", `${workspace.base}^{commit}`], {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true
        }).trim();
        commits = base === head ? [] : execFileSync("git", ["rev-list", `${base}..${head}`], {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true
        }).trim().split(/\r?\n/).filter(Boolean);
      } else if (head) {
        commits = execFileSync("git", ["rev-list", "--reverse", head], {
          cwd: workspace.root,
          encoding: "utf8",
          windowsHide: true
        }).trim().split(/\r?\n/).filter(Boolean);
      }
      const committed = commits.length ? commitScope.rangePaths(workspace.root, commits) : [];
      return { ok: true, workspace, ...workingState, committed };
    } catch (error) {
      return { ok: false, reason: "git_error", message: error?.message || String(error) };
    }
  }
  function ticketsMentioningSession(sessionId) {
    const pattern = `%${sessionId.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const candidates = [];
    for (const row of db.selectRows(database(), "SELECT project, data FROM tickets WHERE data LIKE ? ESCAPE '\\'", [pattern])) {
      try {
        const ticket = normalizePreparedDispatch(JSON.parse(row.data));
        if (ticket?.id) candidates.push({ slug: String(row.project), ticket });
      } catch (_) {
      }
    }
    return candidates;
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
    if (state.sharedTree === false && !state.continuation?.sourceWorktree && worktreeFacts && (!boundIsolatedWorktree(state) || canonicalPath(state.worktree) !== worktreeFacts.worktree)) return false;
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
  function attributableCreationReservation(ticket, state, sessionId) {
    return Boolean(state && state.sessionId === sessionId && state.sharedTree === false && !state.terminalAt && !state.continuation?.sourceWorktree && !state.agentId && !state.claimedAt && !ticket?.claim?.by);
  }
  function unclaimedCreationReservation(ticket, state, sessionId) {
    return Boolean(attributableCreationReservation(ticket, state, sessionId) && state.worktreeBindingSource === "worktree-create" && state.worktree);
  }
  function crossedCreationHolder(state, sessionId) {
    return liveSessionDispatch(state, sessionId) && !state.continuation?.sourceWorktree && !state.agentId && state.worktreeBindingSource === "worktree-create" && Boolean(state.worktree);
  }
  function movedCreationRecord(state) {
    return {
      worktreeBindingSource: "worktree-create",
      worktreeCreationCompletedAt: state?.worktreeCreationCompletedAt || null,
      ownedDependencyLinks: Array.isArray(state?.ownedDependencyLinks) ? state.ownedDependencyLinks : [],
      worktreeProvisioningFailure: state?.worktreeProvisioningFailure || null
    };
  }
  function releaseCrossedCreationBinding(state, otherRef, now, reason = "creation_order") {
    const from = canonicalPath(state.worktree);
    Object.assign(state, movedCreationRecord(null), {
      worktreeBindingSource: null,
      worktree: null,
      worktreeGitDirectory: null,
      worktreeCommonGitDirectory: null,
      worktreeCheckoutInstance: null,
      worktreeObservedRevision: null,
      worktreeBoundAt: null,
      worktreeBindingExchange: { at: now, from, with: otherRef, reason }
    });
  }
  function applyExchangedCreationBinding(state, facts, otherRef, now) {
    const from = state.worktree ? canonicalPath(state.worktree) : null;
    state.worktree = facts.worktree;
    state.worktreeGitDirectory = facts.gitDirectory;
    state.worktreeCommonGitDirectory = facts.commonGitDirectory;
    state.worktreeCheckoutInstance = facts.checkoutInstance;
    state.worktreeObservedRevision = facts.revision;
    state.worktreeBoundAt = now;
    state.worktreeBindingExchange = { at: now, from, with: otherRef, reason: "creation_order" };
  }
  function exchangeCrossedCreationBinding(slug, ticketId, sessionId, reportedWorktree) {
    const reported = canonicalPath(String(reportedWorktree || "").trim());
    if (!reported) return null;
    const parties = crossedCreationParties(slug, ticketId, sessionId, reported);
    if (!parties) return null;
    const lockedIds = [parties.target.id, parties.holder.id].sort();
    return withTicketFileLocks(lockedIds.map((id) => ({ slug, id })), () => {
      const generations = ticketGenerations(slug, lockedIds);
      const crossing = crossedCreationExchange(slug, ticketId, sessionId, reported);
      if (!crossing || crossing.holder.id !== parties.holder.id) return null;
      return guardedTransaction(() => writeCreationExchange(slug, sessionId, crossing, lockedIds, generations));
    });
  }
  function crossedCreationParties(slug, ticketId, sessionId, reported) {
    const target = getTicket(slug, ticketId);
    const targetState = dispatchState(target);
    if (!attributableCreationReservation(target, targetState, sessionId)) return null;
    const held = targetState.worktree ? canonicalPath(targetState.worktree) : "";
    if (held === reported) return null;
    const holder = crossedCreationHolderOf(slug, target, sessionId, reported);
    return holder ? { target, holder, held } : null;
  }
  function crossedCreationExchange(slug, ticketId, sessionId, reported) {
    const parties = crossedCreationParties(slug, ticketId, sessionId, reported);
    return parties ? crossingAtSharedBaseline(slug, parties.target, parties.holder, reported, parties.held) : null;
  }
  function crossedCreationHolderOf(slug, target, sessionId, reported) {
    return listTickets(slug).find((candidate) => candidate.id !== target.id && crossedCreationHolder(dispatchState(candidate), sessionId) && canonicalPath(dispatchState(candidate).worktree) === reported);
  }
  function crossingAtSharedBaseline(slug, target, holder, reported, held) {
    const baseline = sharedDispatchBaseline(dispatchState(target), dispatchState(holder));
    if (!baseline) return null;
    const facts = baselineCheckoutFacts(slug, baseline, reported, held);
    return facts ? { target, holder, ...facts } : null;
  }
  function sharedDispatchBaseline(targetState, holderState) {
    const baseline = String(targetState.baseCommit || "").trim();
    return baseline && baseline === String(holderState.baseCommit || "").trim() ? baseline : "";
  }
  function baselineCheckoutFacts(slug, baseline, reported, held) {
    const reportedFacts = checkoutAtBaseline(slug, reported, baseline);
    if (!reportedFacts) return null;
    if (!held) return { reportedFacts, heldFacts: null };
    const heldFacts = checkoutAtBaseline(slug, held, baseline);
    return heldFacts ? { reportedFacts, heldFacts } : null;
  }
  function checkoutAtBaseline(slug, worktree, baseline) {
    const facts = immutableWorktreeFacts(slug, worktree);
    return facts && facts.revision === baseline ? facts : null;
  }
  function writeCreationExchange(slug, sessionId, crossing, lockedIds, generations) {
    if (changedTicketSince(slug, generations)) return null;
    const sides = lockedIds.map((id) => creationExchangeSide(slug, sessionId, crossing, id));
    if (!sides.every((side) => side !== null)) return null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const movedRecord = holderCreationRecord(crossing, sides);
    for (const side of sides) {
      applyCreationExchange(side.state, side.facts, side.otherRef, movedRecord, now);
      stampDispatchEvent(side.ticket, "worktree-create-exchange", now);
      putTicket(slug, side.ticket);
    }
    return { ok: true, exchangedWith: crossing.holder.ref };
  }
  function holderCreationRecord(crossing, sides) {
    const holderSide = sides.find((side) => side.ticket.id === crossing.holder.id);
    return crossing.heldFacts || !holderSide ? null : movedCreationRecord(holderSide.state);
  }
  function creationExchangeSide(slug, sessionId, crossing, id) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    const isTarget = id === crossing.target.id;
    if (!creationExchangeEligible(isTarget, ticket, state, sessionId)) return null;
    const facts = isTarget ? crossing.reportedFacts : crossing.heldFacts;
    if (alreadyHoldsCheckout(state, facts)) return null;
    return { ticket, state, facts, otherRef: isTarget ? crossing.holder.ref : crossing.target.ref };
  }
  function creationExchangeEligible(isTarget, ticket, state, sessionId) {
    return isTarget ? attributableCreationReservation(ticket, state, sessionId) : crossedCreationHolder(state, sessionId);
  }
  function alreadyHoldsCheckout(state, facts) {
    if (!facts || !state.worktree) return false;
    return canonicalPath(state.worktree) === facts.worktree;
  }
  function applyCreationExchange(state, facts, otherRef, movedRecord, now) {
    if (facts) applyExchangedCreationBinding(state, facts, otherRef, now);
    else releaseCrossedCreationBinding(state, otherRef, now);
    if (facts && movedRecord) Object.assign(state, movedRecord);
  }
  function unclaimedLaunchedReservation(ticket, state, sessionId) {
    return state?.sessionId === sessionId && state.outcome === "launched" && !state.terminalAt && !ticket?.claim?.by;
  }
  function guessedRuntimeIdentity(ticket, state, sessionId, executor) {
    return unclaimedLaunchedReservation(ticket, state, sessionId) && state.executor === executor && state.bindSource !== "claim_runtime_identity";
  }
  function tokenAdmission(admission, slug, ticketId, opts) {
    return () => admittedByToken(admission(slug, ticketId, opts));
  }
  function admittedByToken(result) {
    return Boolean(result?.ok && result.token);
  }
  function claimIdentity(sessionId, executor, agentId) {
    const identity = { sessionId: normalizedText(sessionId), executor: normalizedText(executor), agentId: normalizedText(agentId) };
    return Object.values(identity).every(Boolean) ? identity : null;
  }
  function guessedClaimTarget(slug, ticketId, identity) {
    const target = identity ? getTicket(slug, ticketId) : null;
    return target && guessedRuntimeIdentity(target, dispatchState(target), identity.sessionId, identity.executor) ? target : null;
  }
  function holdsClaimingRuntime(entry, slug, target, identity) {
    const state = dispatchState(entry.ticket);
    return !(entry.slug === slug && entry.ticket.id === target.id) && !state?.terminalAt && normalizedText(state?.agentId) === identity.agentId;
  }
  function runtimeHolders(slug, target, identity) {
    return ticketsMentioningSession(identity.sessionId).filter((entry) => holdsClaimingRuntime(entry, slug, target, identity));
  }
  function exchangeCandidate(exchange) {
    if (!exchange.holder) return exchange.displaced ? exchange : null;
    const holderState = dispatchState(exchange.holder.ticket);
    return guessedRuntimeIdentity(exchange.holder.ticket, holderState, exchange.identity.sessionId, exchange.identity.executor) ? exchange : null;
  }
  function guessedIdentityExchange(slug, ticketId, identity) {
    const target = guessedClaimTarget(slug, ticketId, identity);
    if (!target) return null;
    const displaced = normalizedText(dispatchState(target).agentId);
    const holders = runtimeHolders(slug, target, identity);
    if (displaced === identity.agentId || holders.length > 1) return null;
    return exchangeCandidate({ slug, target, displaced, holder: holders[0] || null, identity });
  }
  function identityExchangeStillHolds(exchange, current, currentHolder) {
    const { identity } = exchange;
    const stillGuessed = (ticket, agentId) => guessedRuntimeIdentity(ticket, dispatchState(ticket), identity.sessionId, identity.executor) && normalizedText(dispatchState(ticket).agentId) === agentId;
    return stillGuessed(current, exchange.displaced) && (!exchange.holder || stillGuessed(currentHolder, identity.agentId));
  }
  function moveRuntimeIdentity(slug, ticket, agentId, deferredStop, exchange) {
    const state = dispatchState(ticket);
    state.agentId = agentId || null;
    state.deferredStop = deferredStop;
    state.runtimeIdentityExchange = exchange;
    stampDispatchEvent(ticket, "claim-identity-exchange", exchange.at);
    putTicket(slug, ticket);
  }
  function swapRuntimeIdentity(exchange, current, currentHolder) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const withRef = currentHolder ? currentHolder.ref : null;
    const displacedStop = dispatchState(current).deferredStop;
    moveRuntimeIdentity(exchange.slug, current, exchange.identity.agentId, void 0, { at, from: exchange.displaced || null, with: withRef, reason: "claim_token" });
    if (currentHolder) {
      moveRuntimeIdentity(exchange.holder.slug, currentHolder, exchange.displaced, displacedStop, { at, from: exchange.identity.agentId, with: current.ref, reason: "claim_token" });
    }
    return { ok: true, exchangedWith: withRef };
  }
  function applyGuessedIdentityExchange(exchange, admitted) {
    const current = getTicket(exchange.slug, exchange.target.id);
    const currentHolder = exchange.holder ? getTicket(exchange.holder.slug, exchange.holder.ticket.id) : null;
    if (!identityExchangeStillHolds(exchange, current, currentHolder) || !admitted?.()) return null;
    return swapRuntimeIdentity(exchange, current, currentHolder);
  }
  function exchangeGuessedClaimIdentity(slug, ticketId, sessionId, executor, agentId, admitted) {
    const exchange = guessedIdentityExchange(slug, ticketId, claimIdentity(sessionId, executor, agentId));
    if (!exchange) return null;
    const keys = [{ slug, id: exchange.target.id }, ...exchange.holder ? [{ slug: exchange.holder.slug, id: exchange.holder.ticket.id }] : []];
    return withTicketLocks(keys, () => applyGuessedIdentityExchange(exchange, admitted));
  }
  const CHECKOUT_BINDING_FIELDS = [
    "worktree",
    "worktreeGitDirectory",
    "worktreeCommonGitDirectory",
    "worktreeCheckoutInstance",
    "worktreeObservedRevision",
    "worktreeBoundAt",
    "worktreeCreationCompletedAt",
    "worktreeProvisionedAt",
    "ownedDependencyLinks",
    "worktreeProvisioningFailure",
    "worktreeBindingSource"
  ];
  const CHECKOUT_IDENTITY_FIELDS = ["worktree", "gitDirectory", "commonGitDirectory", "checkoutInstance"];
  const TOKEN_BIND_SOURCES = ["claim_token", "claim_runtime_identity"];
  function worktreeCreateLease(state) {
    return state?.sharedTree === false && state.worktreeBindingSource === "worktree-create" && !state.continuation?.sourceWorktree;
  }
  function crossedClaimCheckoutReservation(ticket, state, sessionId) {
    return unclaimedLaunchedReservation(ticket, state, sessionId) && !state.claimedAt && worktreeCreateLease(state) && Boolean(state.worktree);
  }
  function guessedSiblingCheckout(ticket, state, sessionId) {
    return crossedClaimCheckoutReservation(ticket, state, sessionId) && !TOKEN_BIND_SOURCES.includes(state.bindSource);
  }
  function observedCheckoutMatchesRecord(state, facts) {
    const recorded = completedWorktreeCreationFacts(state);
    return Boolean(recorded && facts) && CHECKOUT_IDENTITY_FIELDS.every((field) => recorded[field] === facts[field]);
  }
  function sameBaseline(state, other) {
    const baseline = normalizedText(state?.baseCommit);
    return Boolean(baseline) && baseline === normalizedText(other?.baseCommit);
  }
  function exchangeCheckoutRecords(left, right) {
    for (const field of CHECKOUT_BINDING_FIELDS) {
      const held = left[field];
      left[field] = right[field] === void 0 ? null : right[field];
      right[field] = held === void 0 ? null : held;
    }
  }
  function observedClaimCheckout(sessionId, observedWorktree) {
    const claim = { sessionId: normalizedText(sessionId), observed: normalizedText(observedWorktree) };
    return claim.sessionId && claim.observed ? { sessionId: claim.sessionId, observed: canonicalPath(claim.observed) } : null;
  }
  function checkoutlessReservation(ticket, state, sessionId) {
    return unclaimedLaunchedReservation(ticket, state, sessionId) && !state.claimedAt && state.sharedTree === false && !state.worktree && !state.continuation?.sourceWorktree;
  }
  function releasedCheckoutReservation(ticket, state, sessionId) {
    return checkoutlessReservation(ticket, state, sessionId) && state.worktreeBindingExchange?.reason === "worktree_create_failed";
  }
  function leasesAnotherCheckout(ticket, state, claim) {
    return crossedClaimCheckoutReservation(ticket, state, claim.sessionId) && canonicalPath(state.worktree) !== claim.observed;
  }
  function claimExchangesObservedCheckout(ticket, state, claim) {
    return leasesAnotherCheckout(ticket, state, claim) || releasedCheckoutReservation(ticket, state, claim.sessionId);
  }
  function claimAdoptsObservedCheckout(ticket, state, claim) {
    return leasesAnotherCheckout(ticket, state, claim) || checkoutlessReservation(ticket, state, claim.sessionId);
  }
  function crossedCheckoutTarget(slug, ticketId, claim, takesCheckout) {
    const target = getTicket(slug, ticketId);
    return takesCheckout(target, dispatchState(target), claim) ? target : null;
  }
  function recordedCheckout(state) {
    return state?.worktree ? canonicalPath(state.worktree) : null;
  }
  function recordsObservedCheckout(candidate, target, claim) {
    return candidate.id !== target.id && guessedSiblingCheckout(candidate, dispatchState(candidate), claim.sessionId) && canonicalPath(dispatchState(candidate).worktree) === claim.observed;
  }
  function crossedCheckoutHolder(slug, target, claim) {
    const holders = listTickets(slug).filter((candidate) => recordsObservedCheckout(candidate, target, claim));
    const holder = holders.length === 1 ? holders[0] : null;
    return holder && sameBaseline(dispatchState(target), dispatchState(holder)) ? holder : null;
  }
  function crossedCheckoutExchange(slug, ticketId, sessionId, observedWorktree) {
    const claim = observedClaimCheckout(sessionId, observedWorktree);
    const target = claim ? crossedCheckoutTarget(slug, ticketId, claim, claimExchangesObservedCheckout) : null;
    const holder = target ? crossedCheckoutHolder(slug, target, claim) : null;
    const facts = holder ? immutableWorktreeFacts(slug, claim.observed) : null;
    return observedCheckoutMatchesRecord(dispatchState(holder), facts) ? { slug, target, holder, facts, ...claim } : null;
  }
  function crossedCheckoutStillHolds(exchange, current, currentHolder) {
    return claimExchangesObservedCheckout(current, dispatchState(current), exchange) && recordedCheckout(dispatchState(current)) === recordedCheckout(dispatchState(exchange.target)) && guessedSiblingCheckout(currentHolder, dispatchState(currentHolder), exchange.sessionId) && observedCheckoutMatchesRecord(dispatchState(currentHolder), exchange.facts);
  }
  function applyCrossedCheckoutExchange(exchange, admitted) {
    const current = getTicket(exchange.slug, exchange.target.id);
    const currentHolder = getTicket(exchange.slug, exchange.holder.id);
    if (!crossedCheckoutStillHolds(exchange, current, currentHolder) || !admitted?.()) return null;
    const currentState = dispatchState(current);
    const holderState = dispatchState(currentHolder);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const from = recordedCheckout(currentState);
    exchangeCheckoutRecords(currentState, holderState);
    currentState.worktreeBindingExchange = { at: now, from, with: currentHolder.ref, reason: "claim_token" };
    holderState.worktreeBindingExchange = { at: now, from: exchange.observed, with: current.ref, reason: "claim_token" };
    stampDispatchEvent(current, "claim-worktree-exchange", now);
    stampDispatchEvent(currentHolder, "claim-worktree-exchange", now);
    putTicket(exchange.slug, current);
    putTicket(exchange.slug, currentHolder);
    return { ok: true, exchangedWith: currentHolder.ref, worktree: currentState.worktree, from };
  }
  function exchangeCrossedClaimCheckout(slug, ticketId, sessionId, observedWorktree, admitted) {
    const exchange = crossedCheckoutExchange(slug, ticketId, sessionId, observedWorktree);
    if (!exchange) return adoptParkedClaimCheckout(slug, ticketId, sessionId, observedWorktree, admitted);
    return withTicketLocks([{ slug, id: exchange.target.id }, { slug, id: exchange.holder.id }], () => applyCrossedCheckoutExchange(exchange, admitted));
  }
  function parkedCheckoutOf(ticket) {
    return dispatchState(ticket)?.crossBoundWorktree?.parkedCheckout || null;
  }
  function parksObservedCheckout(entry, slug, target, claim) {
    const parked = entry.slug === slug && entry.ticket.id !== target.id ? parkedCheckoutOf(entry.ticket) : null;
    return parked?.sessionId === claim.sessionId && recordedCheckout(parked) === claim.observed;
  }
  function parkedCheckoutHolder(slug, target, claim) {
    const parkers = ticketsMentioningSession(claim.sessionId).filter((entry) => parksObservedCheckout(entry, slug, target, claim));
    const parker = parkers.length === 1 ? parkers[0]?.ticket : null;
    return parker && sameBaseline(dispatchState(target), parkedCheckoutOf(parker)) ? parker : null;
  }
  function parkedCheckoutAdoption(slug, ticketId, sessionId, observedWorktree) {
    const claim = observedClaimCheckout(sessionId, observedWorktree);
    const target = claim ? crossedCheckoutTarget(slug, ticketId, claim, claimAdoptsObservedCheckout) : null;
    const parker = target ? parkedCheckoutHolder(slug, target, claim) : null;
    const facts = parker ? immutableWorktreeFacts(slug, claim.observed) : null;
    return observedCheckoutMatchesRecord(parkedCheckoutOf(parker), facts) ? { slug, target, parker, facts, ...claim } : null;
  }
  function parkedCheckoutStillHolds(adoption, current, parker) {
    return claimAdoptsObservedCheckout(current, dispatchState(current), adoption) && recordedCheckout(dispatchState(current)) === recordedCheckout(dispatchState(adoption.target)) && observedCheckoutMatchesRecord(parkedCheckoutOf(parker), adoption.facts);
  }
  function reparkDisplacedCheckout(slug, claimant, parker, displaced) {
    const crossBound = dispatchState(parker).crossBoundWorktree;
    if (displaced.worktree && unsettledSessionSibling(slug, claimant, dispatchState(claimant))) crossBound.parkedCheckout = displaced;
    else delete crossBound.parkedCheckout;
  }
  function applyParkedCheckoutAdoption(adoption, admitted) {
    const current = getTicket(adoption.slug, adoption.target.id);
    const parker = getTicket(adoption.slug, adoption.parker.id);
    if (!parkedCheckoutStillHolds(adoption, current, parker) || !admitted?.()) return null;
    const state = dispatchState(current);
    const parked = parkedCheckoutOf(parker);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const from = recordedCheckout(state);
    const displaced = parkedCreationRecord(state);
    for (const field of CHECKOUT_BINDING_FIELDS) state[field] = parked[field];
    state.worktreeBindingExchange = { at: now, from, with: parker.ref, reason: "claim_parked_checkout" };
    reparkDisplacedCheckout(adoption.slug, current, parker, displaced);
    stampDispatchEvent(current, "claim-worktree-adopted", now);
    stampDispatchEvent(parker, "claim-worktree-adopted", now);
    putTicket(adoption.slug, current);
    putTicket(adoption.slug, parker);
    return { ok: true, adoptedFrom: parker.ref, worktree: state.worktree, from };
  }
  function adoptParkedClaimCheckout(slug, ticketId, sessionId, observedWorktree, admitted) {
    const adoption = parkedCheckoutAdoption(slug, ticketId, sessionId, observedWorktree);
    if (!adoption) return null;
    return withTicketLocks([{ slug, id: adoption.target.id }, { slug, id: adoption.parker.id }], () => applyParkedCheckoutAdoption(adoption, admitted));
  }
  function guessedReservation(ticket, state, sessionId) {
    return unclaimedLaunchedReservation(ticket, state, sessionId) && !TOKEN_BIND_SOURCES.includes(state.bindSource);
  }
  function deferredStopApplies(state) {
    return Boolean(state?.deferredStop) && normalizedText(state.deferredStop.agentId) === normalizedText(state.agentId);
  }
  function tradableCheckouts(state, other) {
    return worktreeCreateLease(state) && worktreeCreateLease(other) && Boolean(completedWorktreeCreationFacts(state) && completedWorktreeCreationFacts(other)) && sameBaseline(state, other);
  }
  function bindingsCanCross(state, other) {
    return state.executor === other.executor && Boolean(other.agentId) || tradableCheckouts(state, other);
  }
  function unsettledSibling(entry, slug, ticket, sessionId) {
    const other = dispatchState(entry.ticket);
    return !(entry.slug === slug && entry.ticket.id === ticket.id) && guessedReservation(entry.ticket, other, sessionId) && !deferredStopApplies(other) && bindingsCanCross(dispatchState(ticket), other);
  }
  function awaitsSiblingClaim(slug, ticket, sessionId) {
    return guessedReservation(ticket, dispatchState(ticket), sessionId) && ticketsMentioningSession(sessionId).some((entry) => unsettledSibling(entry, slug, ticket, sessionId));
  }
  function holdStopOnRuntime(slug, id, stop, heldAgentId) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    if (normalizedText(state?.agentId) !== heldAgentId || !awaitsSiblingClaim(slug, ticket, stop.sessionId)) return null;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    state.agentId = heldAgentId || stop.agentId || null;
    state.deferredStop = { agentId: state.agentId, at };
    stampDispatchEvent(ticket, "subagent-stop-deferred", at);
    putTicket(slug, ticket);
    return { ok: true, stopped: true, deferred: true, tickets: [], deferredRefs: [ticket.ref] };
  }
  function runtimeHeldBy(state, stop) {
    return Boolean(stop.agentId) && state?.executor === stop.executor && state.agentId === stop.agentId;
  }
  function unboundLaunchNamed(state, stop) {
    return Boolean(stop.launchName) && state?.executor === stop.executor && state.agentName === stop.launchName && !state.agentId;
  }
  function stoppedReservation(candidates, stop) {
    const byRuntime = candidates.filter((entry) => runtimeHeldBy(dispatchState(entry.ticket), stop));
    const byLaunchName = candidates.filter((entry) => unboundLaunchNamed(dispatchState(entry.ticket), stop));
    const held = byRuntime.length ? byRuntime : byLaunchName;
    return held.length === 1 ? held[0] : null;
  }
  function deferGuessedStop(candidates, stop) {
    const held = stoppedReservation(candidates, stop);
    if (!held || !awaitsSiblingClaim(held.slug, held.ticket, stop.sessionId)) return null;
    const heldAgentId = normalizedText(dispatchState(held.ticket).agentId);
    return withTicketLock(held.slug, held.ticket.id, () => holdStopOnRuntime(held.slug, held.ticket.id, stop, heldAgentId));
  }
  function settleDeferredStop(slug, id, sessionId) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    if (!deferredStopApplies(state) || !guessedReservation(ticket, state, sessionId) || awaitsSiblingClaim(slug, ticket, sessionId)) return null;
    setDispatchTerminal(ticket, "failed", "subagent-stop", { slug, failureShape: "stopped_before_claim" });
    ticket.dispatchNonce = null;
    ticket.dispatchExecutor = null;
    stampDispatchEvent(ticket, "subagent-stop", (/* @__PURE__ */ new Date()).toISOString());
    putTicket(slug, ticket);
    return ticket;
  }
  function settleDeferredStops(sessionId) {
    const normalizedSessionId = normalizedText(sessionId);
    if (!normalizedSessionId) return;
    for (const { slug, ticket } of ticketsMentioningSession(normalizedSessionId)) {
      if (deferredStopApplies(dispatchState(ticket))) withTicketLock(slug, ticket.id, () => settleDeferredStop(slug, ticket.id, normalizedSessionId));
    }
  }
  function recoveryLockKeys(slug, ticket, worktree) {
    const facts = immutableWorktreeFacts(slug, worktree);
    const holders = facts ? liveCheckoutHolders(slug, ticket, facts.worktree) : [];
    const holder = holders.length === 1 ? getTicket(slug, holders[0]) : null;
    return [{ slug, id: ticket.id }, ...holder ? [{ slug, id: holder.id }] : []];
  }
  function movedCheckout(state, facts) {
    const recorded = state.worktree ? canonicalPath(state.worktree) : "";
    return recorded !== facts.worktree ? recorded : "";
  }
  function commitsSinceBaseline(worktree, baseCommit, revision) {
    try {
      return gitOutput(worktree, ["rev-list", "--reverse", normalizedText(baseCommit) + "^{commit}.." + revision, "--"]).split("\n").filter(Boolean);
    } catch (_) {
      return [];
    }
  }
  function checkoutOwnershipSinceBaseline(slug, ticket, state, facts) {
    const commits = commitsSinceBaseline(facts.worktree, state.baseCommit, facts.revision);
    return commits.length ? checkoutRangeOwnership(slug, ticket, state, facts.repository, commits) : { ownHead: false, foreignTickets: [] };
  }
  function handbackFallback(ticket) {
    return " Fallback: release " + ticket.ref + " with kind `handback` and status `todo` (MCP `release`), quoting this refusal; its redispatch resumes a checkout only when that checkout's HEAD is this ticket's own commit, and otherwise gets a fresh checkout of its own.";
  }
  function leasedCheckoutRefusal(ticket, facts, holders) {
    return `${ticket.ref} cannot be rebound to ${facts.worktree}: it is leased to ${holders.join(", ")}, a live ticket, and its HEAD is not a commit this claim made. Two claims crossed onto each other's checkouts are swapped instead, but only while both still hold the WorktreeCreate records of one session and baseline and neither checkout carries another ticket's commits.` + handbackFallback(ticket);
  }
  function claimedCreationLease(ticket, state) {
    return Boolean(ticket?.claim?.by) && !state?.terminalAt && worktreeCreateLease(state);
  }
  function sameCreationWave(ticket, state, holder, holderState) {
    return claimedCreationLease(ticket, state) && claimedCreationLease(holder, holderState) && holderState.sessionId === state.sessionId && sameBaseline(state, holderState);
  }
  function recordedCheckoutReturnable(slug, ticket, state, holder, holderState) {
    const recorded = immutableWorktreeFacts(slug, state.worktree);
    return observedCheckoutMatchesRecord(state, recorded) && !liveCheckoutHolders(slug, ticket, recorded.worktree).length && !checkoutOwnershipSinceBaseline(slug, holder, holderState, recorded).foreignTickets.length;
  }
  function crossedClaimPair(slug, ticket, state, holder, facts) {
    const holderState = dispatchState(holder);
    return sameCreationWave(ticket, state, holder, holderState) && observedCheckoutMatchesRecord(holderState, facts) && recordedCheckoutReturnable(slug, ticket, state, holder, holderState);
  }
  function mutualCheckoutSwap(slug, ticket, state, facts, lease) {
    if (lease.holders.length !== 1 || lease.ownership.foreignTickets.length) return null;
    const holder = getTicket(slug, lease.holders[0]);
    const locked = lease.lockKeys.some((key) => key.id === holder?.id);
    return locked && crossedClaimPair(slug, ticket, state, holder, facts) ? { holderId: holder.id, holderRef: holder.ref } : null;
  }
  function leasedCheckoutDecision(slug, ticket, state, facts, lease) {
    const swap = mutualCheckoutSwap(slug, ticket, state, facts, lease);
    if (swap) return { ok: true, basis: "mutual_swap", swap };
    return { ok: false, reason: "worktree_mismatch", message: leasedCheckoutRefusal(ticket, facts, lease.holders) };
  }
  function unleasedRebindDecision(ticket, facts, holders, ownership) {
    if (ownership.foreignTickets.length) {
      return { ok: false, reason: "worktree_mismatch", message: `${ticket.ref} cannot be rebound to ${facts.worktree}: it carries commits of ${ownership.foreignTickets.join(", ")}.` + handbackFallback(ticket) };
    }
    return { ok: true, basis: holders.length ? "own_commits" : "free_lease" };
  }
  function liveClaimRebindDecision(slug, ticket, state, facts, lockKeys) {
    if (!registeredProjectCheckout(facts)) {
      return { ok: false, reason: "invalid_worktree", message: `${ticket.ref} recovery requires a registered linked worktree from this board project.` };
    }
    const holders = liveCheckoutHolders(slug, ticket, facts.worktree);
    const ownership = checkoutOwnershipSinceBaseline(slug, ticket, state, facts);
    if (holders.length && !ownership.ownHead) return leasedCheckoutDecision(slug, ticket, state, facts, { holders, ownership, lockKeys });
    return unleasedRebindDecision(ticket, facts, holders, ownership);
  }
  function swapCheckoutRecords(slug, ticket, state, swap, now) {
    const holder = getTicket(slug, swap.holderId);
    const holderState = dispatchState(holder);
    const from = canonicalPath(holderState.worktree);
    exchangeCheckoutRecords(state, holderState);
    holderState.worktreeCorrection = { at: now, from, to: holderState.worktree, reason: "live_claim_mutual_swap", swappedWith: ticket.ref };
    stampDispatchEvent(holder, "live-claim-mutual-swap", now);
    putTicket(slug, holder);
  }
  function liveClaimRebind(slug, ticket, state, facts, lockKeys, now) {
    const from = movedCheckout(state, facts);
    if (!from) return { ok: true, recovery: {} };
    const decision = liveClaimRebindDecision(slug, ticket, state, facts, lockKeys);
    if (!decision.ok) return decision;
    if (decision.swap) swapCheckoutRecords(slug, ticket, state, decision.swap, now);
    state.worktreeCorrection = { at: now, from, to: facts.worktree, reason: "live_claim_recovery", basis: decision.basis, swappedWith: decision.swap?.holderRef };
    return { ok: true, recovery: { worktreeCorrection: state.worktreeCorrection } };
  }
  function bindCheckoutFacts(state, facts) {
    state.worktree = facts.worktree;
    state.worktreeGitDirectory = facts.gitDirectory;
    state.worktreeCommonGitDirectory = facts.commonGitDirectory;
    state.worktreeCheckoutInstance = facts.checkoutInstance;
    state.worktreeObservedRevision = facts.revision;
  }
  function releaseObservation(opts) {
    const observation = { by: normalizedText(opts?.by), agentId: normalizedText(opts?.agentId), worktree: normalizedText(opts?.observedWorktree) };
    return Object.values(observation).every(Boolean) ? { ...observation, worktree: canonicalPath(observation.worktree) } : null;
  }
  function releaseObservationApplies(ticket, state, observation) {
    return ticket?.claim?.by === observation.by && state?.agentId === observation.agentId && !state.terminalAt && worktreeCreateLease(state);
  }
  function recordObservedReleaseCheckout(slug, id, observation) {
    const ticket = getTicket(slug, id);
    const state = dispatchState(ticket);
    if (!releaseObservationApplies(ticket, state, observation)) return { ok: false, reason: "release_observation_unavailable", ticket };
    if (state.worktree && canonicalPath(state.worktree) === observation.worktree) return { ok: true, unchanged: true, ticket };
    state.releaseObservedCheckout = { worktree: observation.worktree, by: observation.by, agentId: observation.agentId, at: (/* @__PURE__ */ new Date()).toISOString() };
    putTicket(slug, ticket);
    return { ok: true, ticket };
  }
  function recordReleaseObservedCheckout(slug, idOrRef, opts) {
    const observation = releaseObservation(opts);
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    if (!observation) return { ok: false, reason: "missing_release_observation" };
    return withTicketLock(slug, found.id, () => recordObservedReleaseCheckout(slug, found.id, observation));
  }
  function releaseObservationStillHolds(state, observation, by) {
    return Boolean(by) && observation.by === by && observation.agentId === state.agentId && state.sharedTree === false && !state.terminalAt;
  }
  function applyReleaseObservedCheckout(slug, state, observed, observedFacts) {
    const recorded = state.worktree ? canonicalPath(state.worktree) : null;
    if (!observed || observed === recorded) return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const facts = worktreeFactsFor(slug, observed, observedFacts);
    if (!observedCheckoutRegistered(observed, facts, observedFacts)) {
      state.retainedWorktreeDropped = { at: now, reason: "release_observed_checkout_unverified", recorded, observed };
      return;
    }
    bindCheckoutFacts(state, facts);
    state.worktreeCorrection = { at: now, from: recorded, to: state.worktree, reason: "release_observed_checkout" };
  }
  function rekeyReleasedCheckout(slug, ticket, by, observedFacts) {
    const state = dispatchState(ticket);
    const observation = state?.releaseObservedCheckout;
    if (!observation) return;
    delete state.releaseObservedCheckout;
    if (!releaseObservationStillHolds(state, observation, by)) return;
    applyReleaseObservedCheckout(slug, state, canonicalPath(observation.worktree), observedFacts);
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
    const unclaimedCreationReservations = [];
    for (const { slug, ticket } of ticketsMentioningSession(normalizedSessionId)) {
      const state = dispatchState(ticket);
      if (state?.executor === normalizedExecutor && unclaimedCreationReservation(ticket, state, normalizedSessionId)) {
        unclaimedCreationReservations.push({ slug, id: ticket.id, sharedTree: state.sharedTree, state });
      }
      if (!dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      matches.push({ slug, id: ticket.id, sharedTree: state.sharedTree, state });
    }
    if (!matches.length && normalizedAgentId && normalizedWorktree && unclaimedCreationReservations.length === 1) {
      const reservation = unclaimedCreationReservations[0];
      const completed = completedWorktreeCreationFacts(reservation.state);
      if (completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree)) {
        matches = [Object.assign({}, reservation, { checkoutIdentityOverride: true })];
      }
    }
    if (normalizedWorktree) {
      const completedWorktreeMatches = matches.filter((match) => {
        const completed = completedWorktreeCreationFacts(match.state);
        return match.state.sharedTree === false && !match.state.continuation?.sourceWorktree && boundIsolatedWorktree(match.state) && completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree);
      });
      if (completedWorktreeMatches.length) matches = completedWorktreeMatches;
    }
    if (normalizedAgentId && !normalizedAgentName) {
      matches = matches.filter((match) => {
        if (String(match.state.agentId || "") === normalizedAgentId) return true;
        const completed = completedWorktreeCreationFacts(match.state);
        return match.sharedTree === false && Boolean(normalizedWorktree) && completed && canonicalPath(completed.worktree) === canonicalPath(normalizedWorktree);
      });
    }
    if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
      return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
    }
    const tickets = [];
    for (const match of matches) {
      const reportsParentCheckout = match.sharedTree === false && normalizedWorktree && reportsRegisteredProjectCheckout(match.slug, normalizedWorktree);
      if (match.sharedTree === false && normalizedWorktree && !reportsParentCheckout && !match.state.continuation?.sourceWorktree) {
        exchangeCrossedCreationBinding(match.slug, match.id, normalizedSessionId, normalizedWorktree);
      }
      const result = withTicketLock(match.slug, match.id, () => {
        const t = getTicket(match.slug, match.id);
        const state = dispatchState(t);
        const completedReservation = completedWorktreeCreationFacts(state);
        const checkoutIdentityOverride = Boolean(match.checkoutIdentityOverride && unclaimedCreationReservation(t, state, normalizedSessionId) && completedReservation && canonicalPath(completedReservation.worktree) === canonicalPath(normalizedWorktree));
        if (!checkoutIdentityOverride && !dispatchCanBindRuntimeIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) {
          return { ok: false };
        }
        if (state.sharedTree === false && normalizedWorktree && !state.continuation?.sourceWorktree && !boundIsolatedWorktree(state)) {
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
  function markDispatchStopped(sessionId, executor, agentId, agentName, launchName, terminalReason) {
    const stop = {
      sessionId: normalizedText(sessionId),
      executor: normalizedText(executor),
      agentId: normalizedText(agentId),
      agentName: normalizedText(agentName),
      launchName: normalizedText(launchName),
      terminalReason: normalizedText(terminalReason)
    };
    if (!stop.sessionId || !stop.executor) return { ok: false, reason: "missing_identity" };
    const candidates = ticketsMentioningSession(stop.sessionId);
    const deferred = deferGuessedStop(candidates, stop);
    if (deferred) return deferred;
    const stopped = stopByRuntimeOrLaunchName(candidates, stop);
    settleDeferredStops(stop.sessionId);
    return stopped;
  }
  function fallbackLaunchName(stop) {
    return stop.launchName === stop.agentName ? "" : stop.launchName;
  }
  function stopByRuntimeOrLaunchName(candidates, stop) {
    const byRuntimeIdentity = stopMatchingDispatches(candidates, stop.sessionId, stop.executor, stop.agentId, stop.agentName, stop.terminalReason);
    const launchName = fallbackLaunchName(stop);
    if (byRuntimeIdentity.ok || !launchName) return byRuntimeIdentity;
    const byLaunchName = stopMatchingDispatches(candidates, stop.sessionId, stop.executor, stop.agentId, launchName, stop.terminalReason);
    return byLaunchName.ok ? byLaunchName : byRuntimeIdentity;
  }
  function stopMatchingDispatches(candidates, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName, terminalReason) {
    const matches = [];
    const terminalAttempts = [];
    for (const { slug, ticket } of candidates) {
      const state = dispatchState(ticket);
      const terminalAttempt = ticket.claim?.by ? null : terminalAttemptMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName);
      if (terminalAttempt) terminalAttempts.push({ ref: ticket.ref, outcome: terminalAttempt.outcome, agentName: terminalAttempt.agentName });
      if (!dispatchMatchesStopIdentity(state, normalizedSessionId, normalizedExecutor, normalizedAgentId, normalizedAgentName)) continue;
      const active = state.outcome === "prepared" || state.outcome === "launched" || state.outcome === "claimed";
      if (active || state.terminalAt) matches.push({ slug, id: ticket.id, sharedTree: state.sharedTree });
    }
    if (!matches.length && terminalAttempts.length === 1) {
      return { ok: true, stopped: false, tickets: [], terminalAttempts };
    }
    if (!matches.length || dispatchIdentityAmbiguous(matches, normalizedAgentName)) {
      return { ok: false, reason: matches.length ? "ambiguous" : "not_found" };
    }
    const tickets = [];
    const terminalFailure = terminalAgentFailure(terminalReason);
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
        } else if (active && t.claim?.by && terminalFailure) {
          setDispatchTerminal(t, "failed", "subagent-stop", { slug: match.slug, error: terminalReason, failureShape: terminalFailure });
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
  function isolatedDispatchOfAgent(state, sessionId, agentId) {
    return state?.sessionId === sessionId && state.agentId === agentId && state.sharedTree === false && Boolean(state.worktree);
  }
  function agentDispatchWorktrees(sessionId, agentId) {
    if (!sessionId || !agentId) return [];
    const owned = [];
    for (const { ticket } of ticketsMentioningSession(sessionId)) {
      const state = dispatchState(ticket);
      if (isolatedDispatchOfAgent(state, sessionId, agentId)) owned.push(agentDispatchWorktree(ticket.ref, state));
    }
    return owned;
  }
  function agentDispatchWorktree(ref, state) {
    return { ref, worktree: String(state.worktree), outcome: state.outcome || null, terminalAt: state.terminalAt || null };
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
    isolatedDispatchRepositoryForSession,
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
    unclaimedEvidenceAttempt,
    unclaimedRetirementRefusal,
    preparingSessionAttests,
    unclaimedAttemptRecoveryGuidance,
    retirePreparedCompatibilityStaleAttempt,
    preparedCompatibilityHasProvenMismatch,
    preparedCompatibilityWarning,
    supersedeUnboundAttempt,
    isolatedDispatchWorktreeMissing,
    isolatedDispatchWithMissingWorktree,
    terminalDispatchTarget,
    terminalDispatchForIdle,
    soleIdleCandidate,
    reviewCandidateTreeRefusal,
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
    syncLiveDispatchVerification,
    readDispatchBriefing,
    recoverLiveClaimDispatch,
    recordReleaseObservedCheckout,
    rekeyReleasedCheckout,
    recordDispatchLaunch,
    recordDispatchAgentFailure,
    recoverDispatchQuotaFailure,
    bindDispatchWorktreeCreation,
    completeDispatchWorktreeCreation,
    recordDispatchWorktreeProvisioned,
    recordDispatchWorktreeProvisioningFailure,
    unclaimedRetirement,
    recordDispatchWorktreeDependencyLink,
    recoverDispatchWorktreeCreation,
    dispatchIdentityDiagnosis,
    crossedWorktreeBinding,
    dispatchIsolationExpectation,
    dispatchCallerOwners,
    dispatchUnboundClaim,
    boardVerificationEvidencePath,
    dispatchEvidenceDirectory,
    recordSanctionedCommit,
    dispatchWorkspace,
    dispatchDelta,
    activeSharedTreeClaim,
    dispatchIdentityAmbiguous,
    dispatchCanBindRuntimeIdentity,
    recordDispatchRuntimeIdentity,
    bindDispatchClaimToken,
    exchangeGuessedClaimIdentity,
    exchangeCrossedClaimCheckout,
    settleDeferredStops,
    tokenAdmission,
    bindDispatchAgent,
    dispatchMatchesStopIdentity,
    markDispatchStopped,
    agentDispatchWorktrees,
    reconcileLaunchedDispatches,
    observeReleaseWorktreeFacts,
    captureTerminalWorktreeRevision
  };
}
module.exports = { createDispatch, unscopedWriteCannotAutoApprove };
