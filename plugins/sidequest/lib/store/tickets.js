"use strict";
const { reviewCandidateFromSubmission, sameReviewCandidate, reviewRelationFor, reviewRelationRef } = require("../kernel/review-binding");
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
    dispatchVerifyCommandError,
    effectiveScope,
    execFileSync,
    executorText,
    fs,
    getCategory,
    getStory,
    getTicket,
    listTickets,
    makeWorkedBy,
    newTicketId,
    nextSeq,
    normalizeRoute,
    path,
    pendingSubmission,
    putTicket,
    queryTickets,
    queueEventNotification,
    readMeta,
    readyTickets,
    releaseLock,
    requestedReadonlyOverride,
    requireStatus,
    requireVerifyOracle,
    normalizeVerifyOracleKind,
    saveAssetData,
    stripLinksTo,
    ticketLockPath,
    ticketStoryId,
    touchClaimActivity,
    transaction,
    upperRef,
    withTicketLock
  } = dependencies;
  const coerceStoryId = ticketStoryId;
  function submissionReviewRelation(slug, sourceTicket) {
    return reviewRelationFor(sourceTicket, listTickets(slug), (idOrRef) => getTicket(slug, idOrRef));
  }
  function terminallySubmitted(ticket) {
    const state = dispatchState(ticket);
    return Boolean(
      state?.terminalAt && state.outcome === "submitted" || ticket?.lifecycleAttempt?.state === "submitted"
    );
  }
  function injectedReviewBindingFault(stage) {
    if (String(process.env.SIDEQUEST_TEST_REVIEW_BINDING_FAULT || "").trim() !== stage) return;
    throw new Error(`injected review binding fault after the ${stage} write`);
  }
  function categoryReadOnly(ticket) {
    return ticket?.category?.readonly === true;
  }
  function readOnlyOverrideActive(ticket) {
    return typeof ticket?.readonlyOverride === "boolean";
  }
  function dispatchReadOnly(ticket) {
    return typeof ticket?.readonlyOverride === "boolean" ? ticket.readonlyOverride : categoryReadOnly(ticket);
  }
  function normalizedTicketRoute(route) {
    if (route == null) return null;
    const normalized = normalizeRoute(route);
    if (!normalized) throw new Error("Ticket route override requires a valid model and effort.");
    return normalized;
  }
  function authoringVerifyError(ticket, projectPath) {
    const error = dispatchVerifyCommandError(ticket, projectPath);
    return error && /(?:requires .*package\.json|requires a `[^`]+` script)/.test(error) ? error : null;
  }
  function storyLogRevision(slug, storyId) {
    const story = storyId ? getStory(slug, storyId) : null;
    return Number(story?.logRevision) || 0;
  }
  function normalizedReviewTarget(slug, reviewTicket, requested) {
    if (!requested || typeof requested !== "object") {
      throw new Error("reviewTarget requires ref plus the exact submitted candidate");
    }
    const targetRef = String(requested.ref || "").trim().toUpperCase();
    if (!targetRef) throw new Error("reviewTarget.ref is required");
    const sourceTicket = getTicket(slug, targetRef);
    if (!sourceTicket) throw new Error(`reviewTarget.ref ${targetRef} does not exist`);
    if (sourceTicket.id === reviewTicket?.id) throw new Error(`${reviewTicket.ref} cannot review its own submission`);
    if (sourceTicket.claim?.by) {
      throw new Error(`reviewTarget ${sourceTicket.ref} is still live-claimed by ${sourceTicket.claim.by}; it must submit and release before review binds`);
    }
    if (!pendingSubmission(sourceTicket) || !terminallySubmitted(sourceTicket)) {
      throw new Error(`reviewTarget ${sourceTicket.ref} has no claim-free terminal submission to review`);
    }
    const candidate = reviewCandidateFromSubmission(sourceTicket.submission);
    if (!candidate) throw new Error(`reviewTarget ${sourceTicket.ref} has no immutable candidate identity`);
    const requestedCommit = String(requested.commit || "").trim().toLowerCase();
    const requestedRevision = requested.sourceRevision && typeof requested.sourceRevision === "object" ? { source: String(requested.sourceRevision.source || "").trim(), value: String(requested.sourceRevision.value || "").trim() } : null;
    const hasCommit = Boolean(requestedCommit);
    const hasRevision = Boolean(requestedRevision?.source && requestedRevision.value);
    if (hasCommit === hasRevision) throw new Error("reviewTarget requires exactly one of commit or sourceRevision");
    if (!sameReviewCandidate(candidate, hasCommit ? { source: "git", value: requestedCommit } : requestedRevision)) {
      throw new Error(`reviewTarget ${sourceTicket.ref} candidate does not match its submitted ${candidate.source}:${candidate.value}`);
    }
    const relation = submissionReviewRelation(slug, sourceTicket);
    if (relation && (relation.conflict || !reviewTicket?.id || relation.reviewTicket?.id !== reviewTicket.id)) {
      throw new Error(`reviewTarget ${sourceTicket.ref} candidate is already bound to ${reviewRelationRef(relation)}`);
    }
    return {
      sourceTicket,
      target: {
        ticketId: sourceTicket.id,
        ref: sourceTicket.ref,
        candidate,
        submittedAt: sourceTicket.submission.at,
        submittedBy: sourceTicket.submission.by,
        ...sourceTicket.submission.gitRef ? { gitRef: sourceTicket.submission.gitRef } : {}
      }
    };
  }
  function bindReviewTarget(slug, reviewTicket, requested, persistReview) {
    const category = String(reviewTicket?.category?.id || reviewTicket?.category || "").trim().toLowerCase();
    if (requested === void 0) {
      persistReview(reviewTicket);
      return reviewTicket;
    }
    if (category !== "review-audit") throw new Error("reviewTarget is only valid for category review-audit");
    const bound = normalizedReviewTarget(slug, reviewTicket, requested);
    const previousTarget = reviewTicket.reviewTarget || null;
    if (previousTarget && (previousTarget.ticketId !== bound.target.ticketId || !sameReviewCandidate(previousTarget.candidate, bound.target.candidate))) {
      throw new Error(`${reviewTicket.ref} reviewTarget is immutable; retarget needs a fresh review ticket`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    try {
      transaction(() => {
        reviewTicket.reviewTarget = bound.target;
        persistReview(reviewTicket);
        injectedReviewBindingFault("review");
        const sourceTicket = getTicket(slug, bound.sourceTicket.id);
        if (!sourceTicket?.submission) throw new Error(`reviewTarget ${bound.target.ref} lost its submission mid-binding`);
        const mirror = sourceTicket.submission.review;
        sourceTicket.submission.review = {
          ticketId: reviewTicket.id,
          ref: reviewTicket.ref,
          candidate: bound.target.candidate,
          createdAt: mirror?.createdAt || now,
          outcome: mirror?.outcome || "planned"
        };
        sourceTicket.updatedAt = now;
        putTicket(slug, sourceTicket);
      });
    } catch (error) {
      if (previousTarget) reviewTicket.reviewTarget = previousTarget;
      else delete reviewTicket.reviewTarget;
      throw error;
    }
    return reviewTicket;
  }
  function withSourceTicketLock(slug, sourceId, fn) {
    const lock = ticketLockPath(slug, sourceId);
    const locked = acquireLock(lock);
    try {
      return fn();
    } finally {
      if (locked) releaseLock(lock, locked);
    }
  }
  function persistWithReviewBinding(slug, ticket, requested) {
    const persistReview = (review) => putTicket(slug, review);
    const targetRef = requested === void 0 ? "" : String(requested?.ref || "").trim().toUpperCase();
    const sourceTicket = targetRef ? getTicket(slug, targetRef) : null;
    if (!sourceTicket) return bindReviewTarget(slug, ticket, requested, persistReview);
    const bound = withSourceTicketLock(slug, sourceTicket.id, () => bindReviewTarget(slug, ticket, requested, persistReview));
    queueEventNotification(slug, getTicket(slug, sourceTicket.id), "status", ticket.lastEventSource || "cli");
    return bound;
  }
  function createTicket(slug, fields, reviewTarget) {
    fields = fields || {};
    if (Object.hasOwn(fields, "reviewTarget")) {
      throw new Error("generic ticket fields cannot set reviewTarget; pass the review target transition separately");
    }
    const status = fields.status === void 0 ? "todo" : requireStatus(fields.status);
    const id = newTicketId();
    const seq = nextSeq(slug);
    const ref = `SQ-${seq}`;
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
    requireVerifyOracle(fields.executorVerifyKind, fields.executorVerify, fields.executorAttestationArtifact);
    const executorVerify = executorText(fields.executorVerify, EXECUTOR_VERIFY_MAX, "executor verify command");
    const executorVerifyKind = normalizeVerifyOracleKind(fields.executorVerifyKind, executorVerify);
    const storyId = coerceStoryId(slug, fields.storyId);
    const ticket = {
      id,
      ref,
      title: String(fields.title || "Untitled").trim().slice(0, 300) || "Untitled",
      description: String(fields.description || "").trim(),
      status,
      priority: coercePriority(fields.priority, "normal"),
      labels: boundedLabels(fields.labels),
      highStakes: !!fields.highStakes,
      storyId,
      // the user story this ticket belongs to (null = none)
      storyLogSeenSeq: storyLogRevision(slug, storyId),
      category: fields.category == null ? null : String(fields.category).trim().toLowerCase() || null,
      route: normalizedTicketRoute(fields.route),
      complexity: coerceComplexity(fields.complexity),
      // 1..10 score the routing is derived from (entry points require it)
      complexityWhy: String(fields.complexityWhy || "").trim().slice(0, 1e3),
      // the mandatory motivation for the score
      files: boundedFiles(fields.files, {
        category: fields.category,
        readonlyOverride: requestedReadonlyOverride(fields),
        slug,
        ticketRef: ref,
        operation: "add"
      }),
      // declared file scope, for parallel-wave planning
      contracts: boundedContracts(fields.contracts),
      // declared contract edges, for parallel-wave planning
      contractWaiver: !!fields.contractWaiver,
      readonlyOverride: requestedReadonlyOverride(fields),
      workingTreeDelivery: fields.workingTreeDelivery === true,
      executorAnchors: executorText(fields.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors"),
      executorVerifyKind,
      executorAttestationArtifact: executorText(fields.executorAttestationArtifact, EXECUTOR_VERIFY_MAX, "executor attestation artifact"),
      executorVerify,
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
    const verifyError = authoringVerifyError(ticket, readMeta(slug)?.path);
    if (verifyError) throw new Error(`${verifyError} Keep acceptance criteria in a comment, not the verify field.`);
    persistWithReviewBinding(slug, ticket, reviewTarget);
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
  function isVerificationEvidencePath(file, evidenceDirectory, ticketRef) {
    const directory = String(evidenceDirectory || "").trim();
    const requestedPath = String(file || "").trim();
    if (!requestedPath) return false;
    if (directory) {
      const relative = path.relative(path.resolve(directory), path.resolve(requestedPath));
      if (relative === "" || !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
    }
    const normalizedPath = requestedPath.replace(/\\/g, "/").toLowerCase();
    const normalizedRef = String(ticketRef || "").trim().toLowerCase();
    return Boolean(
      normalizedRef && normalizedPath.includes(normalizedRef) && normalizedPath.split("/").some((segment) => ["artifacts", "evidence", "verification"].includes(segment))
    );
  }
  function verificationEvidenceGuidance(evidenceDirectory, evidencePaths) {
    if (!evidencePaths.length) return "";
    const subject = evidencePaths.length === 1 ? "The refused path is" : "The refused paths are";
    return ` ${subject} board-owned verification evidence: ${evidencePaths.join(", ")}. Verification evidence belongs in ${evidenceDirectory}; do not request or commit it inside the repository.`;
  }
  function declaredScopeGuidance(ticket, refusedPaths) {
    if (!refusedPaths.length || !normalizeFiles(ticket.files).length) return "";
    const subject = refusedPaths.length === 1 ? "The refused path is" : "The refused paths are";
    return ` ${subject} outside this ticket's declared files: ${refusedPaths.join(", ")}. The orchestrator has to declare them (\`sidequest update ${ticket.ref} --file <path>\`) and redispatch.`;
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
  function externalOutputAllowed(context) {
    if (typeof context?.readonlyOverride === "boolean") return context.readonlyOverride;
    return getCategory(context?.category, { project: context?.slug })?.readonly === true;
  }
  function boundedFiles(files, context) {
    const declaredFiles = boundedList(
      normalizeFiles(files),
      DECLARED_FILES_MAX,
      "declared file scope",
      "Re-scope with directory entries: a declared directory covers every path under it (e.g. plugins/sidequest/test instead of each test file)."
    );
    const outside = commitScope.validateRelativeScopes(declaredFiles).outside;
    if (outside.length && !externalOutputAllowed(context)) {
      throw new Error(`declared file scope contains paths outside the repo worktree: ${outside.join(", ")}. For genuine non-repo output, classify as non-repo/artifact work; otherwise declare in-repo paths.`);
    }
    const foreignReleaseFragments = commitScope.foreignReleaseFragmentScopePaths(declaredFiles, context?.ticketRef);
    if (foreignReleaseFragments.length) {
      throw new Error(commitScope.foreignReleaseFragmentRefusalMessage(context?.operation || "declared file scope", context?.ticketRef, foreignReleaseFragments));
    }
    return declaredFiles;
  }
  function boundedLabels(labels) {
    return boundedList(normalizeLabels(labels), LABELS_MAX, "labels", "Labels route and filter work; drop the ones that do neither.");
  }
  function scopeExpansionFiles(ticket, additions) {
    return normalizeFiles([...Array.isArray(ticket?.files) ? ticket.files : [], ...normalizeFiles(additions)]);
  }
  function scopeResolution(slug, ticket, request, state, now, granted, refused) {
    const resolution = {
      state,
      by: request?.by || null,
      requestAt: request?.at || null,
      requested: normalizeFiles(request?.requested || request?.files),
      granted: normalizeFiles(granted),
      refused: normalizeFiles(refused),
      effectiveScope: [],
      at: now || (/* @__PURE__ */ new Date()).toISOString()
    };
    ticket.scopeResolution = resolution;
    resolution.effectiveScope = effectiveScope(slug, ticket);
  }
  function syncLiveDispatchScope(slug, ticket) {
    const dispatch = dispatchState(ticket);
    if (!dispatch || dispatch.terminalAt) return;
    const scope = effectiveScope(slug, ticket);
    const refreshed = dispatch.artifactMode ? scope : commitScope.ticketCommitScope(scope, ticket?.files, ticket?.ref);
    dispatch.declaredFiles = dispatch.sharedTree === false ? refreshed : normalizeFiles([...Array.isArray(dispatch.declaredFiles) ? dispatch.declaredFiles : [], ...refreshed]);
  }
  function scopeExpansionCommand(ticket, additions) {
    const ref = String(ticket?.ref || "").trim();
    if (!ref) return null;
    return `sidequest update ${ref} --files ${JSON.stringify(scopeExpansionFiles(ticket, additions).join(","))}`;
  }
  const TEST_DIRECTORY_NAMES = ["test", "tests", "spec", "specs", "__tests__"];
  function repoRelative(file) {
    return String(file || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  }
  function reachableTestRoots(ticket, slug) {
    const repo = readMeta(slug)?.path;
    if (!repo) return [];
    const roots = /* @__PURE__ */ new Map();
    for (const declared of normalizeFiles(ticket?.files)) {
      const segments = repoRelative(declared).split("/").filter(Boolean);
      segments.pop();
      for (let depth = segments.length; depth >= 0; depth--) {
        const parent = segments.slice(0, depth);
        for (const name of TEST_DIRECTORY_NAMES) {
          const candidate = [...parent, name].join("/");
          if (roots.has(candidate.toLowerCase())) continue;
          try {
            if (fs.statSync(path.join(repo, ...parent, name)).isDirectory()) roots.set(candidate.toLowerCase(), candidate);
          } catch (_) {
          }
        }
      }
    }
    return [...roots.values()];
  }
  function enclosingTestRoot(file, roots) {
    const target = repoRelative(file).toLowerCase();
    return (roots || []).find((root) => {
      const prefix = root.toLowerCase();
      return target === prefix || target.startsWith(`${prefix}/`);
    }) || null;
  }
  function autoApprovedTestScope(ticket, requested, additions, slug) {
    if (!boardConfig(slug)?.autoApproveTestScope) return null;
    const roots = reachableTestRoots(ticket, slug);
    if (!roots.length) return null;
    const requestedRoots = normalizeFiles(requested).map((file) => enclosingTestRoot(file, roots));
    if (!requestedRoots.length || requestedRoots.some((root) => !root)) return null;
    return normalizeFiles(normalizeFiles(additions).map((file) => enclosingTestRoot(file, roots)).filter(Boolean));
  }
  const SOURCE_FILE_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cc", ".cpp", ".cxx", ".cs", ".go", ".js", ".jsx", ".py", ".rs", ".ts", ".tsx"]);
  function isSourceFile(file) {
    return SOURCE_FILE_EXTENSIONS.has(path.extname(repoRelative(file)).toLowerCase());
  }
  function buildRegistrationCandidates(source) {
    const extension = path.extname(repoRelative(source)).toLowerCase();
    if (extension === ".cs") return ["*.csproj", "*.vcxproj"];
    if (extension === ".go") return ["go.mod"];
    if (extension === ".py") return ["pyproject.toml", "setup.py", "__init__.py"];
    if (extension === ".rs") return ["Cargo.toml", "mod.rs"];
    if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") return ["package.json", "index.ts", "index.js"];
    return ["CMakeLists.txt"];
  }
  function registrationFileAt(repo, parent, candidate) {
    if (candidate === "*.csproj" || candidate === "*.vcxproj") {
      try {
        const suffix = candidate.slice(1).toLowerCase();
        return fs.readdirSync(path.join(repo, ...parent)).find((name) => name.toLowerCase().endsWith(suffix)) || null;
      } catch (_) {
        return null;
      }
    }
    try {
      return fs.statSync(path.join(repo, ...parent, candidate)).isFile() ? candidate : null;
    } catch (_) {
      return null;
    }
  }
  function governingBuildRegistrationFile(source, slug) {
    const repo = readMeta(slug)?.path;
    if (!repo || !isSourceFile(source)) return null;
    const segments = repoRelative(source).split("/").filter(Boolean);
    segments.pop();
    for (let depth = segments.length; depth >= 0; depth--) {
      const parent = segments.slice(0, depth);
      for (const candidate of buildRegistrationCandidates(source)) {
        const name = registrationFileAt(repo, parent, candidate);
        if (name) return [...parent, name].join("/");
      }
    }
    return null;
  }
  function autoApprovedBuildRegistrationScope(ticket, additions, slug) {
    const requested = normalizeFiles(additions);
    if (!requested.length) return null;
    const registrations = /* @__PURE__ */ new Map();
    for (const source of normalizeFiles(ticket?.files)) {
      const registration = governingBuildRegistrationFile(source, slug);
      if (registration) registrations.set(registration.toLowerCase(), registration);
    }
    if (!registrations.size || requested.some((file) => !registrations.has(repoRelative(file).toLowerCase()))) return null;
    return requested.map((file) => registrations.get(repoRelative(file).toLowerCase()));
  }
  function globExpression(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`, process.platform === "win32" ? "i" : "");
  }
  function autoApprovedScopePaths(ticket, additions, slug) {
    const patterns = boardConfig(slug)?.autoApproveScope || [];
    if (!patterns.length) return [];
    const expressions = patterns.map((pattern) => globExpression(pattern));
    return normalizeFiles(additions).filter((file) => expressions.some((expression) => expression.test(repoRelative(file))));
  }
  const PACKAGE_SURFACE_CONTAINERS = /* @__PURE__ */ new Set(["apps", "crates", "packages", "plugins", "services"]);
  const PACKAGE_SURFACE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "CMakeLists.txt"];
  const PACKAGE_MANIFESTS = /* @__PURE__ */ new Set([...PACKAGE_SURFACE_MARKERS.map((name) => name.toLowerCase()), "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  const CONTROL_PATH_SEGMENTS = /* @__PURE__ */ new Set([".claude", ".claude-plugin", ".circleci", ".github", ".gitlab", ".buildkite", ".changeset"]);
  const ROOT_RELEASE_DIRECTORIES = /* @__PURE__ */ new Set(["release", "releases"]);
  const CONTINUOUS_INTEGRATION_FILENAMES = /* @__PURE__ */ new Set(["appveyor.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile"]);
  const CREDENTIAL_FILENAMES = /* @__PURE__ */ new Set([".npmrc", ".pypirc", "credentials.json", "credentials.toml", "credentials.yaml", "credentials.yml", "id_ed25519", "id_rsa", "secrets.json", "secrets.toml", "secrets.yaml", "secrets.yml"]);
  function containsScopePattern(file) {
    return /[*?\[\]{}!]/.test(repoRelative(file));
  }
  function protectedAutoApprovalPath(file) {
    const normalized = repoRelative(file).toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    const basename = segments.at(-1) || "";
    const firstSegment = segments[0] || "";
    if (!segments.length || segments.some((segment) => CONTROL_PATH_SEGMENTS.has(segment))) return true;
    if (ROOT_RELEASE_DIRECTORIES.has(firstSegment)) return true;
    if (PACKAGE_MANIFESTS.has(basename) || CONTINUOUS_INTEGRATION_FILENAMES.has(basename) || CREDENTIAL_FILENAMES.has(basename)) return true;
    if (basename === ".env" || basename.startsWith(".env.") || /\.(key|p12|pem|pfx)$/.test(basename)) return true;
    return firstSegment === "scripts" && /^(cut|publish|release)([.-]|$)/.test(basename);
  }
  function workspacePackageRoot(file) {
    const segments = repoRelative(file).split("/").filter(Boolean);
    const firstSegment = segments[0] || "";
    return segments.length > 1 && PACKAGE_SURFACE_CONTAINERS.has(firstSegment.toLowerCase()) ? segments.slice(0, 2).join("/") : null;
  }
  function directoryHasPackageMarker(repository, segments) {
    const directory = path.join(repository, ...segments);
    for (const marker of PACKAGE_SURFACE_MARKERS) {
      try {
        if (fs.statSync(path.join(directory, marker)).isFile()) return true;
      } catch (_) {
      }
    }
    try {
      return fs.readdirSync(directory).some((name) => /\.(csproj|vcxproj)$/i.test(name));
    } catch (_) {
      return false;
    }
  }
  function packageSurfaceRoot(file, slug) {
    const workspaceRoot = workspacePackageRoot(file);
    if (workspaceRoot) return workspaceRoot;
    const repository = readMeta(slug)?.path;
    if (!repository) return null;
    const segments = repoRelative(file).split("/").filter(Boolean);
    try {
      if (!fs.statSync(path.join(repository, ...segments)).isDirectory()) segments.pop();
    } catch (_) {
      segments.pop();
    }
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      const parent = segments.slice(0, depth);
      if (directoryHasPackageMarker(repository, parent)) return parent.join("/") || ".";
    }
    return null;
  }
  function packageRelativeSegments(file, packageRoot) {
    const segments = repoRelative(file).split("/").filter(Boolean);
    if (packageRoot === ".") return segments;
    const rootSegments = repoRelative(packageRoot).split("/").filter(Boolean);
    return segments.slice(rootSegments.length);
  }
  function packageSurfaceName(file, packageRoot) {
    return packageRelativeSegments(file, packageRoot)[0]?.toLowerCase() || null;
  }
  function declaredPackageSurfaces(ticket, slug) {
    const surfaces = /* @__PURE__ */ new Map();
    for (const file of normalizeFiles(ticket?.files)) {
      if (containsScopePattern(file) || protectedAutoApprovalPath(file)) continue;
      const root = packageSurfaceRoot(file, slug);
      const surface = root == null ? null : packageSurfaceName(file, root);
      if (!root || !surface) continue;
      const rootKey = root.toLowerCase();
      const rootSurfaces = surfaces.get(rootKey) || /* @__PURE__ */ new Set();
      rootSurfaces.add(surface);
      surfaces.set(rootKey, rootSurfaces);
    }
    return surfaces;
  }
  function autoApprovedPackageScope(ticket, additions, slug) {
    if (dispatchReadOnly(ticket) || dispatchState(ticket)?.readonly === true) return [];
    const testScopeDisabled = boardConfig(slug)?.autoApproveTestScope === false;
    const testRoots = testScopeDisabled ? reachableTestRoots(ticket, slug) : [];
    const declaredSurfaces = declaredPackageSurfaces(ticket, slug);
    if (!declaredSurfaces.size) return [];
    return normalizeFiles(additions).filter((file) => {
      if (containsScopePattern(file) || protectedAutoApprovalPath(file) || enclosingTestRoot(file, testRoots)) return false;
      const root = packageSurfaceRoot(file, slug);
      const surface = root == null ? null : packageSurfaceName(file, root);
      return root != null && surface != null && declaredSurfaces.get(root.toLowerCase())?.has(surface) === true;
    });
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
      const evidenceDirectory = String(t.dispatch?.evidenceDirectory || "").trim();
      const requestedEvidencePaths = requested.filter((file) => isVerificationEvidencePath(file, evidenceDirectory, t.ref));
      const validation = commitScope.validateRelativeScopes(requested);
      if (!validation.ok) {
        const refusalMessage2 = `Scope expansion refused: ${validation.outside.join(", ")}.`;
        return {
          ok: false,
          reason: "invalid_scope",
          ticket: t,
          paths: validation.outside,
          ...requestedEvidencePaths.length ? {
            message: `${refusalMessage2}${verificationEvidenceGuidance(evidenceDirectory, requestedEvidencePaths)}`
          } : {}
        };
      }
      const foreignReleaseFragments = commitScope.foreignReleaseFragmentScopePaths(requested, t.ref);
      const isForeignReleaseFragmentScope = (file) => foreignReleaseFragments.some((fragment) => commitScope.isInScope(file, [fragment]) && commitScope.isInScope(fragment, [file]));
      const scope = commitScope.ticketCommitScope(effectiveScope(slug, t), t.files, t.ref);
      const additions = requested.filter((file) => !isForeignReleaseFragmentScope(file) && !commitScope.isInScope(file, scope));
      const covered = requested.filter((file) => !isForeignReleaseFragmentScope(file) && commitScope.isInScope(file, scope));
      const now = (/* @__PURE__ */ new Date()).toISOString();
      touchClaimActivity(t, by, now);
      const request = { by, files: additions, requested, covered, at: now };
      if (!additions.length && !foreignReleaseFragments.length) {
        scopeResolution(slug, t, request, "granted", now, [], []);
        t.updatedAt = now;
        putTicket(slug, t);
        return { ok: true, ticket: t, covered, approved: [], autoApproved: false, state: "granted", resolution: t.scopeResolution };
      }
      const testDirectories = autoApprovedTestScope(t, requested, additions, slug) || [];
      const testScopeApproved = testDirectories.length > 0;
      const buildRegistrations = testScopeApproved ? [] : autoApprovedBuildRegistrationScope(t, additions, slug) || [];
      const buildRegistrationApproved = buildRegistrations.length > 0;
      const configuredScope = testScopeApproved || buildRegistrationApproved ? [] : autoApprovedScopePaths(t, additions, slug);
      const derivedScope = testScopeApproved ? testDirectories : buildRegistrationApproved ? buildRegistrations : configuredScope;
      const remainingAfterDerivedScope = additions.filter((file) => !commitScope.isInScope(file, derivedScope));
      const packageScope = autoApprovedPackageScope(t, remainingAfterDerivedScope, slug);
      const approved = normalizeFiles([...derivedScope, ...packageScope]);
      if (approved.length) {
        t.files = boundedFiles(scopeExpansionFiles(t, approved));
        syncLiveDispatchScope(slug, t);
      }
      const refused = normalizeFiles([
        ...foreignReleaseFragments,
        ...additions.filter((file) => !commitScope.isInScope(file, approved))
      ]);
      const state = refused.length ? "refused" : "granted";
      scopeResolution(slug, t, request, state, now, approved, refused);
      if (!Array.isArray(t.comments)) t.comments = [];
      const policy = testScopeApproved && !packageScope.length ? "test scope under board policy" : buildRegistrationApproved && !packageScope.length ? "build-registration scope derived from the in-scope source layout" : configuredScope.length && !packageScope.length ? "scope under board policy" : "matching package surface derived from the ticket’s declared files";
      const undeclared = !normalizeFiles(t.files).length ? ` This ticket declares no files, so nothing outside board policy can be in scope. The orchestrator has to declare them (\`sidequest update ${t.ref} --file <path>\`) and redispatch.` : "";
      const refusedEvidencePaths = refused.filter((file) => isVerificationEvidencePath(file, evidenceDirectory, t.ref));
      const refusedOutsideDeclaredFiles = refused.filter((file) => !isForeignReleaseFragmentScope(file) && !isVerificationEvidencePath(file, evidenceDirectory, t.ref));
      const foreignReleaseFragmentMessage = foreignReleaseFragments.length ? commitScope.foreignReleaseFragmentRefusalMessage("scopeRequest", t.ref, foreignReleaseFragments) : "";
      const scopeExpansionRefusalMessage = additions.length ? `Scope expansion refused: ${refused.join(", ")}.` : "";
      const refusalMessage = [foreignReleaseFragmentMessage, scopeExpansionRefusalMessage].filter(Boolean).join(" ");
      const body = refused.length ? `${refusalMessage}${approved.length ? ` Auto-approved ${policy}: ${approved.join(", ")}.` : ""}${undeclared}${declaredScopeGuidance(t, refusedOutsideDeclaredFiles)}${verificationEvidenceGuidance(evidenceDirectory, refusedEvidencePaths)} Commit in-scope work, then release with kind "handback" and name the refused paths.` : `Auto-approved ${policy}: ${approved.join(", ")}.`;
      const comment = createComment({ by: refused.length ? "board" : "board", body, kind: "comment", source: refused.length ? opts.source || "cli" : "policy" }, now);
      t.comments.push(comment);
      t.lastEventType = refused.length ? "scope_refused" : "scope_auto_approved";
      t.lastEventSource = comment.source;
      t.updatedAt = now;
      putTicket(slug, t);
      queueEventNotification(slug, t, "comment", comment.source, { commentBody: comment.body });
      return {
        ok: true,
        ticket: t,
        covered,
        approved,
        autoApproved: !refused.length,
        refused,
        state,
        resolution: t.scopeResolution,
        comment,
        ...refusalMessage ? { message: refusalMessage } : {}
      };
    });
  }
  function migrateLegacyScopeRequest(slug, idOrRef) {
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      const request = ticket?.scopeRequest;
      if (!ticket || !request) return { ok: true, migrated: false, ticket };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const requested = normalizeFiles(request.requested || request.files);
      scopeResolution(slug, ticket, request, "refused", now, [], requested);
      ticket.scopeRequest = null;
      if (ticket.dispatch) delete ticket.dispatch.scopeRequest;
      if (!Array.isArray(ticket.comments)) ticket.comments = [];
      const comment = createComment({
        by: "board",
        body: `Cleared legacy pending scope request from ${request.by || "unknown requester"}: ${requested.join(", ") || "(no paths recorded)"}. Scope requests now rule immediately; commit in-scope work and release with kind "handback" if these paths are still needed.`,
        kind: "comment",
        source: "migration"
      }, now);
      ticket.comments.push(comment);
      ticket.lastEventType = "scope_request_migrated";
      ticket.lastEventSource = "migration";
      ticket.updatedAt = now;
      putTicket(slug, ticket);
      queueEventNotification(slug, ticket, "comment", comment.source, { commentBody: comment.body });
      return { ok: true, migrated: true, ticket, comment };
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
      return `${ticket.ref} has routed dispatch history. Executors cannot close released repository work unless their verified no-op release recorded clean scope. Otherwise commit and submit verified scoped changes, or release to todo with findings; the orchestrator can re-dispatch it or use the control-plane grooming closure with evidence.`;
    }
    return null;
  }
  function updateReopenRefusal(ticket, nextStatus) {
    if (!pendingSubmission(ticket)) return null;
    const commit = String(ticket.submission.commit || "").slice(0, 12);
    return `${ticket.ref} has a pending submission (commit ${commit}) parked READY_FOR_INTEGRATION. update cannot move it to "${nextStatus}" and leave the submission in place. For a review rejection, record it with MCP \`rework\` (review and reason required), then dispatch the same ticket for repair; the old candidate stays recorded until replacement submission. Use \`sidequest submit ${ticket.ref} --clear --status ${nextStatus}\` only for an integration bounce that intentionally drops the candidate, or integrate it through the publish flow.`;
  }
  function sameFiles(left, right) {
    const normalizedLeft = normalizeFiles(left);
    const normalizedRight = normalizeFiles(right);
    const rightFiles = new Set(normalizedRight.map((file) => file.toLowerCase()));
    return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((file) => rightFiles.has(file.toLowerCase()));
  }
  function activeClaimScopeRefusal(slug, ticket, files, patch) {
    if (!ticket.claim?.by || claimReclaimable(ticket)) return null;
    const current = normalizeFiles(ticket.files);
    const next = boundedFiles(files, {
      category: ticket.category,
      readonlyOverride: ticket.readonlyOverride,
      slug,
      ticketRef: ticket.ref,
      operation: "update"
    });
    if (sameFiles(current, next)) return null;
    const caller = String(patch?.by || "").trim();
    if (caller && caller !== ticket.claim.by) return null;
    const claimedSession = String(dispatchState(ticket)?.sessionId || "").trim();
    const callerSession = String(patch?.sessionId || "").trim();
    if (callerSession && claimedSession && callerSession !== claimedSession) return null;
    const currentFiles = new Set(current.map((file) => file.toLowerCase()));
    const nextFiles = new Set(next.map((file) => file.toLowerCase()));
    if (caller && next.every((file) => currentFiles.has(file.toLowerCase()))) return null;
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
  function updateTicket(slug, idOrRef, patch, reviewTarget) {
    const found = getTicket(slug, idOrRef);
    if (!found) return null;
    patch = patch || {};
    if (Object.hasOwn(patch, "reviewTarget")) {
      throw new Error("generic ticket patch cannot set, change, or clear reviewTarget; pass the review target transition separately");
    }
    const apply = (t) => {
      const nextStatus = patch.status == null ? null : requireStatus(patch.status);
      const doneRefusal = nextStatus === "done" ? updateDoneRefusal(t) : null;
      if (doneRefusal) throw new Error(doneRefusal);
      const reopenRefusal = nextStatus != null && nextStatus !== "done" ? updateReopenRefusal(t, nextStatus) : null;
      if (reopenRefusal) throw new Error(reopenRefusal);
      if (t.reviewTarget && patch.category !== void 0 && String(patch.category == null ? "" : patch.category).trim().toLowerCase() !== "review-audit") {
        throw new Error(`${t.ref} reviewTarget is immutable and cannot be cleared by changing category; file a fresh ticket`);
      }
      const prevStatus = t.status;
      if (patch.title != null) t.title = String(patch.title).trim().slice(0, 300) || t.title;
      if (patch.description != null) t.description = String(patch.description).trim();
      if (patch.status != null) t.status = nextStatus;
      if (patch.priority != null) t.priority = coercePriority(patch.priority, t.priority);
      if (patch.labels != null) t.labels = boundedLabels(patch.labels);
      if (patch.highStakes !== void 0) t.highStakes = !!patch.highStakes;
      if (patch.storyId !== void 0) {
        const storyId = coerceStoryId(slug, patch.storyId);
        if (storyId !== t.storyId) {
          t.storyId = storyId;
          t.storyLogSeenSeq = storyLogRevision(slug, storyId);
        }
      }
      if (patch.category !== void 0) t.category = patch.category == null ? null : String(patch.category).trim().toLowerCase() || null;
      if (patch.route !== void 0) t.route = normalizedTicketRoute(patch.route);
      if (patch.complexity !== void 0) {
        const c = coerceComplexity(patch.complexity);
        if (c) t.complexity = c;
      }
      if (patch.complexityWhy !== void 0 && String(patch.complexityWhy).trim()) t.complexityWhy = String(patch.complexityWhy).trim().slice(0, 1e3);
      if (patch.files !== void 0) {
        const scopeRefusal = activeClaimScopeRefusal(slug, t, patch.files, patch);
        if (scopeRefusal) throw new Error(scopeRefusal);
        t.files = boundedFiles(patch.files, {
          category: patch.category === void 0 ? t.category : patch.category,
          readonlyOverride: patch.readonly === void 0 && patch.readonlyOverride === void 0 ? t.readonlyOverride : requestedReadonlyOverride(patch),
          slug,
          ticketRef: t.ref,
          operation: "update"
        });
        syncLiveDispatchScope(slug, t);
      }
      if (patch.contracts !== void 0) t.contracts = boundedContracts(patch.contracts);
      if (patch.contractWaiver !== void 0) t.contractWaiver = !!patch.contractWaiver;
      if (patch.readonly !== void 0 || patch.readonlyOverride !== void 0) t.readonlyOverride = requestedReadonlyOverride(patch);
      if (patch.workingTreeDelivery !== void 0) t.workingTreeDelivery = patch.workingTreeDelivery === true;
      if (patch.category !== void 0 || patch.readonly !== void 0 || patch.readonlyOverride !== void 0) {
        t.files = boundedFiles(t.files, {
          category: t.category,
          readonlyOverride: t.readonlyOverride,
          slug,
          ticketRef: t.ref,
          operation: "update"
        });
      }
      if (patch.executorAnchors !== void 0) t.executorAnchors = executorText(patch.executorAnchors, EXECUTOR_ANCHORS_MAX, "executor anchors");
      const nextVerifyKind = patch.executorVerifyKind === void 0 ? t.executorVerifyKind : patch.executorVerifyKind;
      const nextAttestationArtifact = patch.executorAttestationArtifact === void 0 ? t.executorAttestationArtifact : patch.executorAttestationArtifact;
      const nextVerify = patch.executorVerify === void 0 ? t.executorVerify : patch.executorVerify;
      if (patch.executorVerify !== void 0 || patch.executorVerifyKind !== void 0 || patch.executorAttestationArtifact !== void 0) {
        requireVerifyOracle(nextVerifyKind, nextVerify, nextAttestationArtifact);
        const executorVerify = executorText(nextVerify, EXECUTOR_VERIFY_MAX, "executor verify command");
        const executorVerifyKind = normalizeVerifyOracleKind(nextVerifyKind, executorVerify);
        const executorAttestationArtifact = executorText(nextAttestationArtifact, EXECUTOR_VERIFY_MAX, "executor attestation artifact");
        const verifyTicket = Object.assign({}, t, { executorVerifyKind, executorAttestationArtifact, executorVerify });
        const verifyError = authoringVerifyError(verifyTicket, readMeta(slug)?.path);
        if (verifyError) throw new Error(`${verifyError} Keep acceptance criteria in a comment, not the verify field.`);
        if (t.claim || dispatchState(t)) {
          const verifyError2 = dispatchVerifyCommandError(verifyTicket, readMeta(slug)?.path);
          if (verifyError2) throw new Error(verifyError2);
        }
        t.executorVerifyKind = executorVerifyKind;
        t.executorAttestationArtifact = executorAttestationArtifact;
        t.executorVerify = executorVerify;
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
      bindReviewTarget(slug, t, reviewTarget, (review) => putTicket(slug, review));
      queueEventNotification(slug, t, t.lastEventType, t.lastEventSource);
      return t;
    };
    const applyUnderTicketLock = () => {
      const lock = ticketLockPath(slug, found.id);
      const locked = acquireLock(lock);
      try {
        const t = getTicket(slug, found.id);
        if (!t) return null;
        return apply(t);
      } finally {
        if (locked) releaseLock(lock, locked);
      }
    };
    const targetRef = reviewTarget === void 0 ? "" : String(reviewTarget?.ref || "").trim().toUpperCase();
    const sourceTicket = targetRef ? getTicket(slug, targetRef) : null;
    if (!sourceTicket) return applyUnderTicketLock();
    const updated = withSourceTicketLock(slug, sourceTicket.id, applyUnderTicketLock);
    queueEventNotification(slug, getTicket(slug, sourceTicket.id), "status", patch.source ? String(patch.source) : "cli");
    return updated;
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
      if (locked) releaseLock(lock, locked);
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
  return { DECLARED_FILES_MAX, CONTRACT_NAMES_MAX, LABELS_MAX, categoryReadOnly, readOnlyOverrideActive, dispatchReadOnly, submissionReviewRelation, createTicket, normalizeLabels, normalizeFiles, scopeExpansionFiles, scopeExpansionCommand, requestScope, migrateLegacyScopeRequest, overlappingScopePaths, scopesOverlap, normalizeContracts, contractCollisionReasons, contractMetadata, readyWaves, readyWaveDependencies, normalizeAssignee, updateTicket, deleteTicket, archiveTicket, unarchiveTicket, archiveAllDone, listArchived, listActive };
}
module.exports = { createTickets };
