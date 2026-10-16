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
var review_finalization_exports = {};
__export(review_finalization_exports, {
  createReviewFinalization: () => createReviewFinalization
});
module.exports = __toCommonJS(review_finalization_exports);
var import_review_binding = require("../kernel/review-binding");
var import_review_corrections = require("./review-corrections");
function refuse(reason, message) {
  return { ok: false, reason, message };
}
function nonemptyText(value) {
  return typeof value === "string" && Boolean(value.trim());
}
function requestRefusal(input, granted) {
  if (!granted) return refuse("finalization_unauthorized", "Completed review finalization requires the main-thread MCP verdict grant. by is an audit label only.");
  if (!nonemptyText(input.sessionId)) return refuse("identity_unavailable", "Finalization requires the actual runtime session.");
  return decisionEvidenceRefusal(input) || expectedSourceRefusal(input.expected);
}
function decisionEvidenceRefusal(input) {
  if (input.authority !== void 0 && input.authority !== "main-attestation") return refuse("invalid_finalization", "External authority must explicitly be main-attestation.");
  if (!["accepted", "rejected"].includes(input.outcome)) return refuse("invalid_finalization", "Completed review finalization requires explicit accepted or rejected.");
  if (![input.by, input.text, input.evidence].every(nonemptyText)) return refuse("evidence_required", "Finalization requires nonempty by, text and evidence.");
}
function expectedSourceRefusal(expected) {
  if (!expected) return refuse("invalid_finalization", "Finalization requires the exact source and candidate.");
  if (![expected.sourceRef, expected.candidate?.source, expected.candidate?.value].every(nonemptyText)) return refuse("invalid_finalization", "Finalization requires the exact source and candidate.");
}
function expectedBindingRefusal(review, input) {
  const target = review.reviewTarget ?? {};
  const matching = [target.ref === input.expected.sourceRef, (0, import_review_binding.sameReviewCandidate)(target.candidate, input.expected.candidate)];
  if (matching.includes(false)) return refuse("stale_expected", "Read the exact original reviewTarget source/candidate before finalizing.");
}
function decisionRetryRefusal(review, source, input) {
  const history = (0, import_review_binding.reviewVerdictHistory)(review);
  const previous = history?.verdict;
  const effective = (0, import_review_binding.effectiveOracleVerdictOutcome)(history) ?? "planned";
  const { reviewTarget = {} } = review;
  const { submission = {} } = source;
  const { review: mirror = {} } = submission;
  const { outcome: targetOutcome = "planned" } = reviewTarget;
  const { outcome: mirrorOutcome = "planned" } = mirror;
  const matching = [targetOutcome === effective, mirrorOutcome === effective];
  if (matching.includes(false)) return refuse("binding_mismatch", "Both binding halves must match the recorded decision.");
  if (!previous) return;
  return differentDecisionRefusal(history, input);
}
function differentDecisionRefusal(history, input) {
  const { verdict: previous, corrections = [] } = history;
  const matches = [
    corrections.length === 0,
    JSON.stringify(previous) === JSON.stringify({ ...previous, outcome: input.outcome, text: input.text, evidence: input.evidence, authority: input.authority })
  ];
  if (matches.includes(false)) {
    return refuse("already_finalized", "A different decision already exists. Use the native accepted-to-rejected correction path for a mistaken approval; repair requires a fresh candidate.");
  }
}
function reviewFinalizationRefusal(review, input) {
  if (input.authority !== "main-attestation") return (0, import_review_corrections.completedNormalReviewRefusal)(review);
  if ((0, import_review_corrections.activeCorrectionTicket)(review)) return refuse("review_active", "A claimed or actively dispatched review cannot be finalized.");
  if ((0, import_review_corrections.correctionReviewCategory)(review.category) !== "review-audit") return refuse("review_unbound", "External finalization requires a bound review-audit ticket.");
  return (0, import_review_corrections.undispatchedReviewRefusal)(review);
}
function createReviewFinalization(dependencies) {
  function finalizeUnderLocks(slug, reviewId, input) {
    dependencies.invalidateStoreCaches();
    const review = dependencies.getTicket(slug, reviewId);
    if (!review) return refuse("not_found", "Review ticket not found.");
    const reviewRefusal = reviewFinalizationRefusal(review, input) || expectedBindingRefusal(review, input);
    if (reviewRefusal) return reviewRefusal;
    return finalizeSource(slug, review, input);
  }
  function sourceRefusal(slug, review, source, input) {
    return (0, import_review_corrections.sourceCorrectionRefusal)(source, dependencies.pendingSubmission(source)) || (0, import_review_corrections.correctionBindingRefusal)(review, source, dependencies.submissionReviewRelation(slug, source)) || (input.authority === "main-attestation" ? void 0 : (0, import_review_corrections.independentReviewRefusal)(source, review));
  }
  function finalizeSource(slug, review, input) {
    const source = dependencies.getTicket(slug, input.expected.sourceRef);
    if (!source) return refuse("source_unavailable", "The original source ticket is unavailable.");
    const invalid = sourceRefusal(slug, review, source, input) || decisionRetryRefusal(review, source, input);
    if (invalid) return invalid;
    const previous = review.reviewDecision?.verdict;
    if (previous) return { ok: true, idempotent: true, decision: previous, reviewOutcome: { sourceRef: source.ref, outcome: previous.outcome } };
    return recordDecision(slug, review, source, input);
  }
  function recordDecision(slug, review, source, input) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const comment = dependencies.createComment({ by: input.by, body: `${input.authority === "main-attestation" ? "Externally attested" : "Completed"} review decision (${input.outcome}): ${input.text}`, kind: "comment", source: "mcp" }, at);
    const decision = {
      outcome: input.outcome,
      text: input.text,
      evidence: input.evidence,
      by: input.by,
      sessionId: input.sessionId,
      sourceRef: source.ref,
      candidate: { ...review.reviewTarget.candidate },
      at,
      commentId: comment.id,
      ...input.authority === "main-attestation" ? { authority: input.authority, reviewerRuntimeProvenance: false } : {}
    };
    review.reviewDecision = { verdict: decision };
    review.comments = [...review.comments ?? [], comment];
    dependencies.recordBoundReviewOutcome(slug, review, input.outcome);
    review.updatedAt = at;
    dependencies.putTicket(slug, review);
    return { ok: true, decision, reviewOutcome: { sourceRef: source.ref, outcome: input.outcome } };
  }
  function finalizeCompletedReview(slug, idOrRef, input, grant = {}) {
    const invalid = requestRefusal(input, grant.allowCompletedReviewFinalization === true);
    if (invalid) return invalid;
    const review = dependencies.getTicket(slug, idOrRef);
    if (!review) return refuse("not_found", "Review ticket not found.");
    if (!review.reviewTarget?.ticketId) return refuse("review_unbound", "Finalization requires the original source binding.");
    try {
      return dependencies.withSourceTicketLock(
        slug,
        review.reviewTarget.ticketId,
        () => dependencies.withTicketLock(slug, review.id, () => finalizeUnderLocks(slug, review.id, input)),
        true
      );
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { finalizeCompletedReview };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createReviewFinalization
});
