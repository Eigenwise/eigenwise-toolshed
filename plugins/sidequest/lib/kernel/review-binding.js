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
var review_binding_exports = {};
__export(review_binding_exports, {
  isReviewCommit: () => isReviewCommit,
  reviewCandidateFromSubmission: () => reviewCandidateFromSubmission,
  reviewLockMessage: () => reviewLockMessage,
  reviewRelationFor: () => reviewRelationFor,
  reviewRelationOutcome: () => reviewRelationOutcome,
  reviewRelationRef: () => reviewRelationRef,
  sameReviewCandidate: () => sameReviewCandidate
});
module.exports = __toCommonJS(review_binding_exports);
const REVIEW_COMMIT_RE = /^[0-9a-f]{7,64}$/i;
function isReviewCommit(value) {
  return REVIEW_COMMIT_RE.test(String(value || "").trim());
}
function reviewCandidateFromSubmission(submission) {
  const revision = submission?.sourceRevision;
  if (revision?.source && revision.value) {
    return Object.freeze({
      source: String(revision.source),
      value: String(revision.value),
      observedAt: String(revision.observedAt || submission.at || "")
    });
  }
  const commit = String(submission?.commit || "").trim().toLowerCase();
  if (!isReviewCommit(commit)) return null;
  return Object.freeze({ source: "git", value: commit, observedAt: String(submission?.at || "") });
}
function sameReviewCandidate(left, right) {
  return Boolean(
    left?.source && right?.source && String(left.source) === String(right.source) && String(left.value) === String(right.value)
  );
}
function addressesSource(reviewTicket, sourceTicket) {
  const target = reviewTicket?.reviewTarget;
  if (!target || reviewTicket.id === sourceTicket.id) return false;
  if (target.ticketId) return target.ticketId === sourceTicket.id;
  return String(target.ref || "").toUpperCase() === String(sourceTicket.ref || "").toUpperCase();
}
function namedMirror(mirror) {
  return mirror && (mirror.ticketId || mirror.ref) ? mirror : null;
}
function reviewRelationFor(sourceTicket, tickets, resolveTicket) {
  if (!sourceTicket?.id) return null;
  const candidate = reviewCandidateFromSubmission(sourceTicket.submission);
  const mirror = namedMirror(sourceTicket.submission?.review);
  const addressed = (tickets || []).filter((ticket) => addressesSource(ticket, sourceTicket)).sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || String(left.id || "").localeCompare(String(right.id || "")));
  if (addressed.length) {
    const reviewTicket2 = addressed[0];
    return Object.freeze({
      candidate: candidate || reviewTicket2.reviewTarget?.candidate || null,
      reviewTicket: reviewTicket2,
      reviewTarget: reviewTicket2.reviewTarget,
      mirror,
      conflict: addressed.length > 1,
      side: mirror ? "both" : "target-only"
    });
  }
  if (!mirror) return null;
  const reviewTicket = resolveTicket(String(mirror.ticketId || mirror.ref)) || null;
  return Object.freeze({
    candidate: candidate || mirror.candidate || null,
    reviewTicket,
    reviewTarget: reviewTicket?.reviewTarget || null,
    mirror,
    conflict: false,
    side: "mirror-only"
  });
}
function reviewRelationRef(relation) {
  return relation?.reviewTicket?.ref || relation?.mirror?.ref || "a candidate review";
}
function reviewRelationOutcome(relation) {
  return String(relation?.mirror?.outcome || relation?.reviewTarget?.outcome || "planned");
}
function reviewLockMessage(operation, ticket, relation) {
  const candidate = relation.candidate?.value || "its candidate";
  return `${operation}: refused ${ticket?.ref}; candidate ${candidate} is bound to ${reviewRelationRef(relation)} and cannot be changed. Repair requires a fresh ticket, attempt, candidate, and review identity.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isReviewCommit,
  reviewCandidateFromSubmission,
  reviewLockMessage,
  reviewRelationFor,
  reviewRelationOutcome,
  reviewRelationRef,
  sameReviewCandidate
});
