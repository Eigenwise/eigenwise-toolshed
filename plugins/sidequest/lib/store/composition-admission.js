"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var composition_admission_exports = {};
__export(composition_admission_exports, {
  compositionCaptureRefusal: () => compositionCaptureRefusal,
  compositionCheckoutCommit: () => compositionCheckoutCommit,
  compositionIncludesSource: () => compositionIncludesSource,
  compositionSubmissionScope: () => compositionSubmissionScope,
  consumePreparedComposition: () => consumePreparedComposition,
  createCompositionAdmissions: () => createCompositionAdmissions,
  exactCompositionSubmissionRefusal: () => exactCompositionSubmissionRefusal
});
module.exports = __toCommonJS(composition_admission_exports);
var import_node_crypto = require("node:crypto");
var import_node_child_process = require("node:child_process");
var import_commit_scope = require("../commit-scope");
var import_review_binding = require("../kernel/review-binding");
var import_worktree = require("../kernel/worktree");
var import_composition_range = require("./composition-range");
const { contextRevision } = require("../context-packet");
function refuse(reason, message) {
  return { ok: false, reason, message };
}
function compositionAttestationRefusal(input) {
  const currentOnly = [input.authority === "main-attestation", input.historicalCheckout === false];
  if (currentOnly.includes(false)) return refuse("invalid_admission", "Only current main-attestation with historicalCheckout:false is supported.");
  if (![input.by.trim(), input.evidence.trim()].every(Boolean)) return refuse("invalid_admission", "Composition adoption requires nonempty by and evidence for its audit.");
}
function currentAuthorityRefusal(input, sessionId, granted) {
  if (!granted) return refuse("admission_unauthorized", "Composition adoption requires the main-thread MCP update grant. by and evidence are audit labels only.");
  if (!sessionId.trim()) return refuse("identity_unavailable", "Composition adoption requires the actual runtime session.");
  return compositionAttestationRefusal(input);
}
function releasedRootRangeRefusal(root, input) {
  if (!root.dispatch?.terminalAt || root.dispatch.outcome !== "released") return refuse("root_not_released", "The latest root dispatch must genuinely be released.");
  if (root.dispatch.baseCommit !== input.base) return refuse("composition_base_mismatch", "Composition must retain the original released dispatch BASE.");
}
function rootAdmissionRefusal(root, input) {
  if ([root.status === "done", root.claim?.by, root.dispatchNonce].some(Boolean)) return refuse("root_active", "Composition adoption requires a non-done, unclaimed, released root.");
  if (root.submission) return refuse("root_submitted", "Rework the root through the ordinary protocol before adopting a composition.");
  return releasedRootRangeRefusal(root, input);
}
function submittedTerminalGeneration(dispatch) {
  return Boolean(dispatch?.terminalAt) && dispatch?.outcome === "submitted";
}
function terminalSourceRefusal(source) {
  if ([source.claim?.by, source.dispatchNonce].some(Boolean)) return refuse("source_active", `${source.ref} is claimed or actively dispatched.`);
  if (!submittedTerminalGeneration(source.dispatch)) return refuse("source_unavailable", `${source.ref} needs its terminal submitted generation.`);
  if (source.status === "done") return refuse("source_delivered", `${source.ref} is already done.`);
}
function sourceCandidateRefusal(source, input, submission) {
  if (submission.commit !== input.commit || submission.at !== input.submittedAt) return refuse("stale_source", `${source.ref}'s submitted identity changed.`);
  if (!hasRecordedCompositionRange(submission)) return refuse("source_range_missing", `${source.ref} needs a complete recorded base, commit range and scope.`);
}
function sourceSubmissionRefusal(source, input) {
  const submission = source.submission;
  if (!submission) return refuse("source_unavailable", `${source.ref} has no pending immutable submission.`);
  if (submission.integratedAt || submission.supersededBy) return refuse("source_unavailable", `${source.ref} was delivered or superseded.`);
  return sourceCandidateRefusal(source, input, submission);
}
function sourceRelationRefusal(source, relation) {
  if (!relation) return;
  if (relation.conflict || relation.side !== "both") return refuse("stale_source", `${source.ref} has an incomplete or conflicting authoritative review binding.`);
  return sourceReviewIdentityRefusal(source, relation);
}
function reviewTargetBindsSource(target, source, candidate) {
  return [target?.ticketId === source.id, target?.ref === source.ref, (0, import_review_binding.sameReviewCandidate)(target?.candidate, candidate)].every(Boolean);
}
function sourceMirrorBindsReview(mirror, review, candidate) {
  return [mirror?.ticketId === review.id, mirror?.ref === review.ref, (0, import_review_binding.sameReviewCandidate)(mirror?.candidate, candidate)].every(Boolean);
}
function reviewBindsExactSource(source, review) {
  const candidate = { source: "git", value: source.submission?.commit };
  return reviewTargetBindsSource(review.reviewTarget, source, candidate) && sourceMirrorBindsReview(source.submission?.review, review, candidate);
}
function sourceReviewIdentityRefusal(source, relation) {
  const review = relation.reviewTicket;
  if (!review) return refuse("stale_source", `${source.ref}'s bound review is unavailable.`);
  if (!reviewBindsExactSource(source, review)) return refuse("stale_source", `${source.ref}'s review no longer binds its exact source and candidate.`);
  return sourceReviewOutcomeRefusal(source, review);
}
function latestCorrectionAt(review) {
  const corrections = review.oracle?.corrections ?? [];
  return corrections.at(-1)?.at;
}
function bindingOutcome(binding) {
  return binding?.outcome ?? "planned";
}
function sourceBindingGenerationRefusal(source, review, expectedOutcome) {
  const bindings = [source.submission?.review, review.reviewTarget];
  const correctedAt = latestCorrectionAt(review);
  if (!bindings.every((binding) => bindingOutcome(binding) === expectedOutcome)) return refuse("stale_source", `${source.ref}'s binding does not match the authoritative verdict.`);
  if (!bindings.every((binding) => binding?.correctedAt === correctedAt)) return refuse("stale_source", `${source.ref}'s binding does not match the authoritative correction generation.`);
}
function sourceReviewOutcomeRefusal(source, review) {
  const outcome = (0, import_review_binding.effectiveOracleVerdictOutcome)(review.oracle);
  if (outcome === "rejected") return refuse("source_rejected", `${source.ref}'s authoritative review rejected the candidate.`);
  return sourceBindingGenerationRefusal(source, review, outcome ?? "planned");
}
function hasRecordedCompositionRange(submission) {
  return [submission.base, submission.commit, submission.commits?.length, submission.admittedScope?.length].every(Boolean);
}
function sourceRange(source) {
  const submission = source.submission;
  if (!submission || !hasRecordedCompositionRange(submission)) throw new Error(`${source.ref} has no complete recorded composition range.`);
  return { ref: source.ref, base: submission.base, commit: submission.commit, commits: submission.commits, admittedScope: submission.admittedScope };
}
function sourceSnapshot(source, relation) {
  const review = relation?.reviewTicket;
  return contextRevision({
    id: source.id,
    submission: source.submission,
    dispatch: source.dispatch,
    review: review && {
      id: review.id,
      status: review.status,
      target: review.reviewTarget,
      oracle: review.oracle,
      dispatch: review.dispatch
    },
    binding: relation && { conflict: relation.conflict, side: relation.side }
  });
}
function mirroredReviewOutcome(source) {
  return source.submission?.review?.outcome ?? null;
}
function observedReviewGeneration(review) {
  return { reviewTicketId: review?.id ?? null, correctedAt: review ? latestCorrectionAt(review) ?? null : null };
}
function sourceObservation(source, input, relation) {
  const review = relation?.reviewTicket ?? null;
  return {
    ...input,
    range: sourceRange(source),
    ...observedReviewGeneration(review),
    reviewOutcome: mirroredReviewOutcome(source),
    snapshot: sourceSnapshot(source, relation)
  };
}
function rootGeneration(root) {
  const dispatch = root.dispatch ?? {};
  return {
    attemptCount: (dispatch.attempts ?? []).length,
    releasedAt: dispatch.terminalAt ?? "",
    preparedAt: dispatch.preparedAt ?? ""
  };
}
function expectedSource(observation) {
  return {
    ref: observation.ref,
    reviewTicketId: observation.reviewTicketId,
    reviewOutcome: observation.reviewOutcome,
    correctedAt: observation.correctedAt,
    snapshot: observation.snapshot
  };
}
function expectedRefusal(input, observed) {
  if (!input.expected) return {
    ok: false,
    reason: "expected_required",
    message: "Read this bounded observed snapshot, then retry update.admitComposition with expected. This probe grants nothing.",
    observed: { ...rootGenerationFromObserved(observed), sources: observed.sources.map(publicObservation) }
  };
  if (contextRevision(rootGenerationFromObserved(observed)) !== contextRevision(rootGenerationFromObserved(input.expected))) return refuse("stale_generation", "The root released generation changed. Probe again without expected.");
  if (contextRevision(input.expected.sources) !== contextRevision(observed.sources.map(expectedSource))) return refuse("stale_source", "A critical source submission or authoritative review/correction generation changed. Probe again without expected.");
}
function rootGenerationFromObserved(observed) {
  return { attemptCount: observed.attemptCount, releasedAt: observed.releasedAt, preparedAt: observed.preparedAt };
}
function publicObservation(observation) {
  return { ...expectedSource(observation), ref: observation.ref, commit: observation.commit, submittedAt: observation.submittedAt };
}
function existingAdmissionResult(root, input) {
  const previous = root.compositionAdmission;
  if (!previous) return;
  if (previous.consumedBy) return refuse("admission_consumed", "Composition adoption was already consumed. A new dispatch cannot replay it.");
  const previousInput = {
    authority: previous.authority,
    historicalCheckout: previous.historicalCheckout,
    by: previous.by,
    evidence: previous.evidence,
    candidate: previous.candidate,
    base: previous.base,
    ownCommits: previous.ownCommits,
    ownPaths: previous.ownPaths,
    sources: previous.sources,
    expected: previous.expected
  };
  if (contextRevision(previousInput) !== contextRevision(input)) return refuse("admission_exists", "A different immutable composition admission already exists.");
  return { ok: true, idempotent: true, admission: previous };
}
function distinctNonRootRefs(refs, rootRef) {
  return refs.length > 0 && new Set(refs).size === refs.length && !refs.includes(rootRef);
}
function uniqueSourcesRefusal(root, inputs) {
  const refs = inputs.map((input) => input.ref);
  if (!distinctNonRootRefs(refs, root.ref)) return refuse("invalid_sources", "Composition requires distinct related sources, excluding the root.");
  const related = new Set(root.links?.filter((link) => link.type === "related").map((link) => link.ref));
  if (refs.some((ref) => !related.has(ref))) return refuse("source_unrelated", "Every composition source must have an existing related root link.");
}
function sourceScopeRefusal(repository, source) {
  const range = sourceRange(source);
  if (!(0, import_commit_scope.validateRelativeScopes)(range.admittedScope).ok) return refuse("stale_source", `${source.ref}'s scope must be repository-relative.`);
  if (!(0, import_commit_scope.validateCommitRangeScope)(repository, range.commits, (0, import_commit_scope.ticketCommitScope)(range.admittedScope, range.admittedScope, source.ref)).ok) return refuse("source_scope_mismatch", `${source.ref}'s complete immutable submitted range exceeds its recorded scope.`);
}
function candidateFragmentRefusal(repository, root, candidate) {
  const fragment = (0, import_commit_scope.ticketReleaseFragment)(root.ref);
  if (!fragment) return refuse("missing_release_fragment", "Composition requires the original root release fragment.");
  const present = (0, import_node_child_process.execFileSync)("git", ["ls-tree", "-r", "--name-only", candidate, "--", fragment], {
    cwd: repository,
    encoding: "utf8",
    timeout: 3e4,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  if (present !== fragment) return refuse("missing_release_fragment", `Exact candidate must already contain ${fragment}.`);
}
function submittedOwnershipCommits(submission) {
  if (!submission) return [];
  return [submission.commit ?? "", ...submission.commits ?? []];
}
function attemptOwnershipCommits(attempt) {
  return [attempt.commit ?? "", ...attempt.sanctionedCommits ?? []];
}
function dispatchOwnershipCommits(dispatch) {
  if (!dispatch) return [];
  return [...dispatch.sanctionedCommits ?? [], ...(dispatch.attempts ?? []).flatMap(attemptOwnershipCommits)];
}
function recordedOwnershipCommits(ticket) {
  return [...submittedOwnershipCommits(ticket.submission), ticket.checkpoint?.commit ?? "", ...dispatchOwnershipCommits(ticket.dispatch)];
}
function foreignCommitRefusal(root, tickets, commits, sources) {
  const permitted = /* @__PURE__ */ new Set([root.ref, ...sources.map((source) => source.ref)]);
  const foreign = tickets.filter((ticket) => !permitted.has(ticket.ref)).find((ticket) => recordedOwnershipCommits(ticket).some((commit) => commits.includes(commit)));
  if (foreign) return refuse("foreign_commit", `Composition includes ${foreign.ref}'s independently recorded commit.`);
}
function originalRootScope(root) {
  return (0, import_commit_scope.ticketCommitScope)(root.dispatch?.declaredFiles ?? root.files ?? [], root.files, root.ref);
}
function admittedRootScope(root) {
  return root.compositionAdmission?.originalRootScope ?? originalRootScope(root);
}
function reviewEscapedLocks(relation, locked) {
  const review = relation?.reviewTicket;
  return review ? !locked.includes(review.id) : false;
}
function ownFragmentRefusal(root, paths) {
  const rootFragment = (0, import_commit_scope.ticketReleaseFragment)(root.ref);
  if (paths.some((file) => file.startsWith(".release/unreleased/") && file !== rootFragment)) {
    return refuse("foreign_release_fragment", "Root own changes cannot attribute another ticket's release fragment to the root.");
  }
}
function dispatchNamesConsumedGeneration(current, admission, consumedBy) {
  const fence = current.compositionAdmission;
  return [
    fence?.id === admission.id,
    current.preparedAt === consumedBy.preparedAt,
    current.baseCommit === admission.base,
    fence?.rangeBase === admission.base,
    compositionCheckoutCommit(current) === admission.candidate,
    current.sharedTree === false,
    consumedBy.attempt === admission.expected.attemptCount + 1,
    fence?.nonceDigest === consumedBy.nonceDigest
  ].every(Boolean);
}
function consumedGenerationRefusal(root) {
  const admission = root.compositionAdmission;
  if (!admission?.consumedBy) return refuse("admission_unconsumed", "Composition requires its genuinely consumed prepared generation.");
  if (!dispatchNamesConsumedGeneration(root.dispatch ?? {}, admission, admission.consumedBy)) return refuse("stale_generation", "Composition admission does not name this exact isolated dispatch generation.");
}
function terminalCompositionRefusal(root) {
  const generation = consumedGenerationRefusal(root);
  if (generation) return generation;
  const terminal = [!root.claim?.by, !root.dispatchNonce, submittedTerminalGeneration(root.dispatch)];
  if (terminal.includes(false)) return refuse("stale_generation", "Composition delivery requires its genuine claim-free submitted generation.");
  return exactCompositionSubmissionRefusal(root, root.submission);
}
function submitsExactComposition(admission, submission) {
  const expectedCommits = [...admission.ownCommits, ...admission.sourceRanges.flatMap((source) => source.commits)].sort();
  const recordedCommits = [...submission.commits ?? []].sort();
  return [
    submission.commit === admission.candidate,
    submission.base === admission.base,
    contextRevision(recordedCommits) === contextRevision(expectedCommits)
  ].every(Boolean);
}
function exactCompositionSubmissionRefusal(root, submission) {
  const admission = root.compositionAdmission;
  if (!admission) return;
  if (!submitsExactComposition(admission, submission ?? {})) return refuse("composition_submission_mismatch", "Composition must submit exact C and the complete original BASE..C range.");
}
function capturedInGeneration(root, capture) {
  return Date.parse(capture.completedAt ?? "") >= Date.parse(root.dispatch?.preparedAt ?? "");
}
function capturedCleanCandidate(capture, candidate) {
  return capture.cleanWorktree === true && capture.candidate?.source === "git" && capture.candidate?.value === candidate;
}
function compositionCaptureMetadataRefusal(root, capture) {
  const matches = [
    Boolean(root.claim?.by),
    capturedInGeneration(root, capture),
    capturedCleanCandidate(capture, root.compositionAdmission?.candidate)
  ];
  if (matches.includes(false)) return refuse("composition_capture_mismatch", "Composition capture must be fresh, clean, holder-owned, and bound to exact C in its new generation.");
}
function checkoutGitIdentity(worktree, argument) {
  return (0, import_node_child_process.execFileSync)("git", ["rev-parse", "--path-format=absolute", argument], {
    cwd: worktree,
    encoding: "utf8",
    timeout: 3e4,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function captureUsesDispatchCheckout(dispatch, worktree) {
  const actualWorktree = (0, import_worktree.canonicalPath)(checkoutGitIdentity(worktree, "--show-toplevel"));
  const gitDirectory = (0, import_worktree.canonicalPath)(checkoutGitIdentity(worktree, "--absolute-git-dir"));
  return [
    actualWorktree === (0, import_worktree.canonicalPath)(dispatch.worktree ?? ""),
    gitDirectory === (0, import_worktree.canonicalPath)(dispatch.worktreeGitDirectory ?? ""),
    (0, import_worktree.checkoutInstanceIdentity)(gitDirectory) === dispatch.worktreeCheckoutInstance
  ].every(Boolean);
}
function compositionCaptureCheckoutRefusal(root, worktree) {
  try {
    if (!captureUsesDispatchCheckout(root.dispatch ?? {}, worktree)) return refuse("composition_capture_checkout_mismatch", "Composition capture belongs to a different native checkout instance.");
  } catch {
    return refuse("composition_capture_checkout_unavailable", "Composition capture requires its observable genuine new native checkout.");
  }
}
function compositionCaptureRefusal(root, capture) {
  if (!root.compositionAdmission) return;
  const metadata = compositionCaptureMetadataRefusal(root, capture);
  if (metadata) return metadata;
  if (!capture.worktree) return refuse("composition_capture_checkout_unavailable", "Composition capture requires its genuine new native checkout.");
  return compositionCaptureCheckoutRefusal(root, capture.worktree);
}
function compositionSubmissionScope(root) {
  const admission = root.compositionAdmission;
  if (!admission || consumedGenerationRefusal(root)) return null;
  return [.../* @__PURE__ */ new Set([...admission.originalRootScope, ...admission.sourceRanges.flatMap((source) => source.admittedScope)])];
}
function compositionSourceStillMatches(source, expected, range) {
  const submission = source.submission;
  if (!submission || sourceCandidateRefusal(source, expected, submission)) return false;
  return contextRevision(sourceRange(source)) === contextRevision(range);
}
function compositionIncludesSource(root, source, commits) {
  const admission = root.compositionAdmission;
  if (!admission || consumedGenerationRefusal(root)) return false;
  const expected = admission.sources.find((input) => input.ref === source.ref);
  const range = admission.sourceRanges.find((input) => input.ref === source.ref);
  if (!expected || !range) return false;
  return [compositionSourceStillMatches(source, expected, range), range.commits.every((commit) => commits.includes(commit))].every(Boolean);
}
function compositionCheckoutCommit(state) {
  return state.compositionAdmission?.checkoutCommit ?? state.baseCommit ?? "";
}
function consumePreparedComposition(root, nonceDigest) {
  const admission = root.compositionAdmission;
  if (!admission) return;
  if (admission.consumedBy) throw new Error("Composition admission was already consumed. A new dispatch cannot replay it.");
  fencePreparedGeneration(root, admission, nonceDigest);
}
function fencePreparedGeneration(root, admission, nonceDigest) {
  const dispatch = root.dispatch;
  if (!dispatch?.preparedAt || !nonceDigest) throw new Error("Composition consumption requires the new prepared generation and nonce digest.");
  root.compositionAdmission = { ...admission, consumedBy: {
    attempt: (dispatch.attempts ?? []).length + 1,
    preparedAt: dispatch.preparedAt,
    nonceDigest
  } };
  dispatch.compositionAdmission = { id: admission.id, checkoutCommit: admission.candidate, rangeBase: admission.base, nonceDigest };
}
function createCompositionAdmissions(dependencies) {
  function observeSources(slug, root, input, locked) {
    const distinct = uniqueSourcesRefusal(root, input.sources);
    if (distinct) return distinct;
    const observations = [];
    for (const sourceInput of input.sources) {
      const observation = observeSource(slug, sourceInput, locked);
      if ("ok" in observation) return observation;
      observations.push(observation);
    }
    return observations;
  }
  function observeSource(slug, input, locked) {
    const source = dependencies.getTicket(slug, input.ref);
    if (!source) return refuse("source_unavailable", `${input.ref} is unavailable.`);
    const basic = terminalSourceRefusal(source) || sourceSubmissionRefusal(source, input);
    if (basic) return basic;
    return observeSourceReview(slug, source, input, locked);
  }
  function observeSourceReview(slug, source, input, locked) {
    const relation = dependencies.submissionReviewRelation(slug, source);
    if (reviewEscapedLocks(relation, locked)) return refuse("stale_source", "Source review identity changed while acquiring composition locks. Probe again.");
    const failure = sourceRelationRefusal(source, relation) || sourceScopeRefusal(dependencies.readMeta(slug).path, source);
    if (failure) return failure;
    return sourceObservation(source, input, relation);
  }
  function proveCandidate(slug, root, input, observed) {
    const repository = dependencies.readMeta(slug).path;
    const proof = (0, import_composition_range.proveCompositionRange)(repository, {
      ...input,
      rootScope: admittedRootScope(root),
      sources: observed.sources.map((source) => source.range)
    });
    if (!proof.ok) return proof;
    return ownFragmentRefusal(root, input.ownPaths) || foreignCommitRefusal(root, dependencies.listTickets(slug), proof.commits, input.sources) || candidateFragmentRefusal(repository, root, input.candidate);
  }
  function admitUnderLocks(slug, ref, input, sessionId, locked) {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse("not_found", "Composition root not found.");
    const rootFailure = rootAdmissionRefusal(root, input);
    if (rootFailure) return rootFailure;
    return admitObserved(slug, root, input, sessionId, locked);
  }
  function admitObserved(slug, root, input, sessionId, locked) {
    const sources = observeSources(slug, root, input, locked);
    if (!Array.isArray(sources)) return sources;
    const observed = { ...rootGeneration(root), sources };
    const failure = expectedRefusal(input, observed) || proveCandidate(slug, root, input, observed);
    if (failure) return failure;
    return existingAdmissionResult(root, input) ?? appendAdmission(slug, root, input, sessionId, observed);
  }
  function appendAdmission(slug, root, input, sessionId, observed) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const comment = dependencies.createComment({
      by: input.by,
      body: `Current main composition adoption: ${input.candidate} from original BASE ${input.base}. Historical checkout ownership is unverified. ${input.evidence}`,
      kind: "comment",
      source: "mcp"
    }, at);
    const admission = {
      ...input,
      id: (0, import_node_crypto.randomUUID)(),
      at,
      sessionId,
      commentId: comment.id,
      expected: { ...rootGeneration(root), sources: observed.sources.map(expectedSource) },
      sourceRanges: observed.sources.map((source) => source.range),
      originalRootScope: originalRootScope(root),
      releasedDispatch: structuredClone(root.dispatch ?? {}),
      consumedBy: null
    };
    root.compositionAdmission = admission;
    root.comments = [...root.comments ?? [], comment];
    root.updatedAt = at;
    dependencies.putTicket(slug, root);
    return { ok: true, admission };
  }
  function participantLockIdentities(slug, ref) {
    const participant = dependencies.getTicket(slug, ref);
    if (!participant) return [];
    const review = dependencies.submissionReviewRelation(slug, participant)?.reviewTicket;
    return review ? [participant.id, review.id] : [participant.id];
  }
  function lockIdentities(slug, root, input) {
    const identities = [
      root.id,
      ...participantLockIdentities(slug, root.ref),
      ...input.sources.flatMap((source) => participantLockIdentities(slug, source.ref))
    ];
    return [...new Set(identities)].sort();
  }
  function withCompositionLocks(slug, identities, callback) {
    const [identity, ...remaining] = identities;
    if (!identity) return callback();
    return dependencies.withTicketLock(slug, identity, () => withCompositionLocks(slug, remaining, callback));
  }
  function dispatchAdmissionRefusal(slug, root, locked) {
    const admission = root.compositionAdmission;
    if (!admission) return refuse("admission_unavailable", "Composition admission disappeared while acquiring its locks.");
    if (admission.consumedBy) return refuse("admission_consumed", "Composition admission was already consumed. A new dispatch cannot replay it.");
    return rootAdmissionRefusal(root, admission) || observedAdmissionRefusal(slug, root, admission, locked);
  }
  function observedAdmissionRefusal(slug, root, admission, locked) {
    const sources = observeSources(slug, root, admission, locked);
    if (!Array.isArray(sources)) return sources;
    const observed = { ...rootGeneration(root), sources };
    return expectedRefusal(admission, observed) || proveCandidate(slug, root, admission, observed);
  }
  function prepareUnderCompositionLocks(slug, ref, identities, callback) {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) throw new Error("Composition root disappeared while acquiring its locks.");
    const refusal = dispatchAdmissionRefusal(slug, root, identities);
    if (refusal) throw new Error(`prepare dispatch: ${refusal.reason}: ${refusal.message}`);
    return callback();
  }
  function withCompositionDispatchPreparation(slug, ref, callback) {
    const root = dependencies.getTicket(slug, ref);
    if (!root?.compositionAdmission) return dependencies.withTicketLock(slug, root?.id ?? ref, callback);
    const identities = lockIdentities(slug, root, root.compositionAdmission);
    try {
      return withCompositionLocks(slug, identities, () => prepareUnderCompositionLocks(slug, ref, identities, callback));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  function consumedSourceRefusal(slug, root, locked) {
    const admission = root.compositionAdmission;
    if (!admission) return refuse("admission_unavailable", "Composition admission disappeared while acquiring its locks.");
    const sources = observeSources(slug, root, admission, locked);
    if (!Array.isArray(sources)) return sources;
    if (contextRevision(admission.expected.sources) !== contextRevision(sources.map(expectedSource))) {
      return refuse("stale_source", "A critical source submission or authoritative review/correction generation changed after adoption.");
    }
    return proveCandidate(slug, root, admission, { ...admission.expected, sources });
  }
  function currentNonceRefusal(root) {
    if (!root.dispatchNonce) return refuse("stale_generation", "An active composition boundary requires its genuine new dispatch nonce.");
    if (dependencies.dispatchTokenDigest(root.dispatchNonce) !== root.compositionAdmission?.consumedBy?.nonceDigest) {
      return refuse("stale_generation", "Composition admission belongs to a different dispatch nonce.");
    }
  }
  function activeCompositionRefusal(slug, root, locked) {
    return consumedGenerationRefusal(root) || currentNonceRefusal(root) || consumedSourceRefusal(slug, root, locked);
  }
  function submittedCompositionRefusal(slug, root, identities) {
    const relation = dependencies.submissionReviewRelation(slug, root);
    if (!relation?.reviewTicket) return refuse("candidate_review_required", "Composition delivery requires an ordinary independent review bound to its submitted exact C.");
    if (!identities.includes(relation.reviewTicket.id)) return refuse("stale_review", "Composition root review changed while acquiring delivery locks.");
    return terminalCompositionRefusal(root) || consumedSourceRefusal(slug, root, identities);
  }
  function compositionBoundaryRefusal(slug, root, identities, boundary) {
    if (boundary === "active") return activeCompositionRefusal(slug, root, identities);
    return submittedCompositionRefusal(slug, root, identities);
  }
  function useUnderCompositionLocks(slug, ref, identities, use, callback) {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse("not_found", "Composition root disappeared while acquiring its locks.");
    const refusal = compositionBoundaryRefusal(slug, root, identities, use.boundary);
    if (refusal) return refusal;
    const consumerRefusal = use.refusal?.(root);
    if (consumerRefusal) return { ...consumerRefusal, ticket: root };
    return callback();
  }
  function withCompositionGenerationLock(slug, ref, callback, use = { boundary: "active" }) {
    const root = dependencies.getTicket(slug, ref);
    if (!root?.compositionAdmission) return dependencies.withTicketLock(slug, root?.id ?? ref, callback);
    const identities = lockIdentities(slug, root, root.compositionAdmission);
    try {
      return withCompositionLocks(slug, identities, () => useUnderCompositionLocks(slug, ref, identities, use, callback));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  function admitComposition(slug, ref, input, sessionId, grant = {}) {
    const failure = currentAuthorityRefusal(input, sessionId, grant.allowCompositionAdmission === true);
    if (failure) return failure;
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse("not_found", "Composition root not found.");
    const identities = lockIdentities(slug, root, input);
    try {
      return withCompositionLocks(slug, identities, () => admitUnderLocks(slug, root.id, input, sessionId, identities));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { admitComposition, withCompositionDispatchPreparation, withCompositionGenerationLock };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compositionCaptureRefusal,
  compositionCheckoutCommit,
  compositionIncludesSource,
  compositionSubmissionScope,
  consumePreparedComposition,
  createCompositionAdmissions,
  exactCompositionSubmissionRefusal
});
