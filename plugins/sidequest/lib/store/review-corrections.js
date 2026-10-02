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
var review_corrections_exports = {};
__export(review_corrections_exports, {
  createReviewCorrections: () => createReviewCorrections
});
module.exports = __toCommonJS(review_corrections_exports);
var import_review_binding = require("../kernel/review-binding");
function refuse(reason, message) {
  return { ok: false, reason, message };
}
function requiredCorrectionText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function correctionRequestRefusal(input, grant) {
  if (grant.allowAcceptedReviewCorrection !== true) return refuse("correction_unauthorized", "Finalized review correction requires the main-thread MCP verdict grant.");
  if (!requiredCorrectionText(input.by)) return refuse("identity_required", "Correction by is required for the audit.");
  if (!requiredCorrectionText(input.sessionId)) return refuse("identity_unavailable", "Correction requires the actual runtime session.");
  return correctionEvidenceRefusal(input);
}
function correctionEvidenceRefusal(input) {
  if (!requiredCorrectionText(input.text)) return refuse("invalid_correction", "Correction text must be nonempty.");
  if (!requiredCorrectionText(input.evidence)) return refuse("evidence_required", "Correction evidence must be nonempty.");
  if (input.why !== void 0 && typeof input.why !== "string") return refuse("invalid_correction", "Correction why must be text.");
  if (input.expected?.outcome !== "accepted") return refuse("invalid_correction", "Correction expects the original accepted verdict.");
}
function finalizedReviewRefusal(ticket, readonlyExecutor) {
  if (ticket.status === "awaiting-oracle") return refuse("use_verdict", "Use ordinary verdict for an awaiting-oracle review.");
  if (ticket.claim?.by) return refuse("review_active", "A claimed review cannot be corrected.");
  const category = typeof ticket.category === "string" ? ticket.category : ticket.category?.id;
  if (category !== "review-audit") return refuse("review_unbound", "Correction requires a bound review-audit ticket.");
  return reviewFinalizationRefusal(ticket, readonlyExecutor);
}
function reviewFinalizationRefusal(ticket, readonlyExecutor) {
  if (!ticket.reviewTarget?.ticketId) return refuse("review_unbound", "Correction requires the original source binding.");
  if (ticket.status !== "done") return refuse("review_nonfinalized", "Correction requires a finalized review.");
  if (!readonlyExecutor) return refuse("review_nonreadonly", "Correction requires a readonly review.");
  if (ticket.dispatchNonce) return refuse("review_active", "Correction cannot replace an active review dispatch.");
  if (!ticket.oracle?.verdict) return refuse("no_verdict", "The original verdict is unavailable.");
}
function expectedVerdictRefusal(ticket, expected) {
  const verdict = ticket.oracle?.verdict;
  if (verdict?.outcome !== "accepted") return refuse("not_accepted", "Only an original accepted verdict can be corrected.");
  const matches = [
    requiredCorrectionText(verdict.at),
    verdict.at === expected.verdictAt,
    ticket.reviewTarget?.ref === expected.sourceRef,
    (0, import_review_binding.sameReviewCandidate)(ticket.reviewTarget?.candidate, expected.candidate)
  ];
  if (matches.includes(false)) return refuse("stale_expected", "Read list({ref: reviewRef}).ticket.oracle.verdict.at and the exact original source/candidate before correcting.");
}
function sourceCorrectionRefusal(source, pending) {
  if (source.claim?.by) return refuse("source_active", "The original source is claimed.");
  if (source.submission?.integratedAt) return refuse("source_delivered", "A delivered source cannot be corrected.");
  if (source.submission?.supersededBy) return refuse("source_superseded", "A superseded source cannot be corrected.");
  if (!pending) return refuse("submission_required", "Correction requires the original pending submission.");
}
function correctionBindingRefusal(ticket, source, relation) {
  const identities = [
    relation?.conflict === false,
    relation?.side === "both",
    relation?.reviewTicket?.id === ticket.id,
    source.id === ticket.reviewTarget?.ticketId,
    source.ref === ticket.reviewTarget?.ref,
    source.submission?.review?.ticketId === ticket.id,
    source.submission?.review?.ref === ticket.ref,
    (0, import_review_binding.sameReviewCandidate)((0, import_review_binding.reviewCandidateFromSubmission)(source.submission), ticket.reviewTarget?.candidate),
    JSON.stringify(source.submission?.review?.candidate) === JSON.stringify(ticket.reviewTarget?.candidate)
  ];
  if (identities.includes(false)) return refuse("binding_mismatch", "Correction requires a nonconflicting exact two-sided original review binding.");
}
function duplicateCorrectionRefusal(ticket, source, input) {
  const previous = ticket.oracle?.corrections?.at(-1);
  const outcome = previous ? "rejected" : "accepted";
  if (ticket.reviewTarget?.outcome !== outcome || source.submission?.review?.outcome !== outcome) return refuse("binding_mismatch", "Both binding halves must match the effective verdict.");
  if (!previous) return;
  const matching = [
    previous.verdictAt === input.expected.verdictAt,
    previous.sourceRef === input.expected.sourceRef,
    (0, import_review_binding.sameReviewCandidate)(previous.candidate, input.expected.candidate),
    previous.text === input.text,
    previous.why === (input.why ?? ""),
    previous.evidence === input.evidence,
    previous.from === "accepted",
    previous.to === "rejected",
    previous.sourceTicketId === source.id
  ];
  if (matching.includes(false)) return refuse("already_corrected", "A different correction already exists for this verdict.");
}
function createReviewCorrections(dependencies) {
  function correctUnderLocks(slug, reviewId, input) {
    const ticket = dependencies.getTicket(slug, reviewId);
    if (!ticket) return refuse("not_found", "Review ticket not found.");
    const readonlyExecutor = ticket.dispatch?.readonly === true || dependencies.isReadOnlyExecutor(ticket.dispatch?.executor);
    const reviewRefusal = finalizedReviewRefusal(ticket, readonlyExecutor) || expectedVerdictRefusal(ticket, input.expected);
    if (reviewRefusal) return reviewRefusal;
    return correctSource(slug, ticket, input);
  }
  function correctSource(slug, ticket, input) {
    const source = dependencies.getTicket(slug, input.expected.sourceRef);
    if (!source) return refuse("source_unavailable", "The original source ticket is unavailable.");
    const sourceRefusal = sourceCorrectionRefusal(source, dependencies.pendingSubmission(source)) || correctionBindingRefusal(ticket, source, dependencies.submissionReviewRelation(slug, source)) || duplicateCorrectionRefusal(ticket, source, input);
    if (sourceRefusal) return sourceRefusal;
    const previous = ticket.oracle?.corrections?.at(-1);
    if (previous) return { ok: true, idempotent: true, correction: previous, reviewOutcome: { sourceRef: source.ref, outcome: "rejected" } };
    return appendCorrection(slug, ticket, source, input);
  }
  function appendCorrection(slug, ticket, source, input) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const comment = dependencies.createComment({ by: input.by, body: `Oracle verdict correction (accepted -> rejected): ${input.text}`, kind: "comment", source: "mcp" }, at);
    const correction = {
      from: "accepted",
      to: "rejected",
      verdictAt: input.expected.verdictAt,
      sourceTicketId: source.id,
      sourceRef: source.ref,
      candidate: ticket.reviewTarget?.candidate ?? input.expected.candidate,
      text: input.text,
      why: input.why ?? "",
      evidence: input.evidence,
      by: input.by,
      sessionId: input.sessionId,
      at,
      commentId: comment.id
    };
    ticket.oracle = { ...ticket.oracle, corrections: [...ticket.oracle?.corrections ?? [], correction] };
    ticket.comments = [...ticket.comments ?? [], comment];
    dependencies.recordBoundReviewOutcome(slug, ticket, "rejected", { correctedAt: at });
    ticket.updatedAt = at;
    dependencies.putTicket(slug, ticket);
    return { ok: true, correction, reviewOutcome: { sourceRef: source.ref, outcome: "rejected" } };
  }
  function correctAcceptedReviewVerdict(slug, idOrRef, input, grant = {}) {
    const requestRefusal = correctionRequestRefusal(input, grant);
    if (requestRefusal) return requestRefusal;
    const found = dependencies.getTicket(slug, idOrRef);
    if (!found) return refuse("not_found", "Review ticket not found.");
    if (!found.reviewTarget?.ticketId) return refuse("review_unbound", "Correction requires the original source binding.");
    try {
      return dependencies.withSourceTicketLock(
        slug,
        found.reviewTarget.ticketId,
        () => dependencies.withTicketLock(slug, found.id, () => correctUnderLocks(slug, found.id, input)),
        true
      );
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { correctAcceptedReviewVerdict };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createReviewCorrections
});
