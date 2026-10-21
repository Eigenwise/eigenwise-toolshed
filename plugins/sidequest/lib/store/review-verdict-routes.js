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
var review_verdict_routes_exports = {};
__export(review_verdict_routes_exports, {
  finalizeShape: () => finalizeShape,
  oracleRoundRefusal: () => oracleRoundRefusal,
  pendingOracleVerdictRefusal: () => pendingOracleVerdictRefusal,
  reviewedSourceRefusal: () => reviewedSourceRefusal
});
module.exports = __toCommonJS(review_verdict_routes_exports);
function refuse(reason, message) {
  return { ok: false, reason, message };
}
function candidateField(candidate) {
  if (!candidate) return 'commit: "<reviewTarget candidate>" (or sourceRevision: {source, value})';
  if (candidate.source === "git") return `commit: "${candidate.value}"`;
  return `sourceRevision: {source: "${candidate.source}", value: "${candidate.value}"}`;
}
function finalizeShape(reviewRef = "<review ref>", sourceRef = "<reviewed source ref>", candidate) {
  return `verdict {ref: "${reviewRef}", outcome: "accepted"|"rejected", by, text, finalize: {sourceRef: "${sourceRef}", ${candidateField(candidate)}, evidence}}`;
}
function plainVerdictShape(ref) {
  return `verdict {ref: "${ref}", outcome, by, text} without finalize`;
}
function reviewedSourceMirror(ticket) {
  if (ticket.reviewTarget) return null;
  const { review: mirror = {} } = ticket.submission ?? {};
  return [mirror.ticketId, mirror.ref].every(Boolean) ? mirror : null;
}
function openOracleRoundRefusal(ref, status, round) {
  if (status === "awaiting-oracle") return refuse("use_verdict", `${ref} is awaiting its oracle verdict: record it with ${plainVerdictShape(ref)}.`);
  if (status === "done") {
    return refuse("oracle_round_closed", `${ref} was closed while oracle round ${round} still awaited its verdict, so neither plain verdict nor finalize can record it as is. Reopen it with update {ref: "${ref}", status: "awaiting-oracle"}, then record the outcome with ${plainVerdictShape(ref)}.`);
  }
  return refuse("use_verdict", `${ref} has oracle round ${round} in progress; its outcome comes from ${plainVerdictShape(ref)} once it is released with kind oracle, never from finalize.`);
}
function oracleRoundRefusal(review) {
  const { oracle } = review;
  if (!oracle) return;
  if (oracle.verdict) {
    return refuse("use_verdict", `${review.ref} already carries oracle verdict ${oracle.verdict.outcome}, so finalize does not apply. A mistaken accepted takes verdict with correct; a rejected candidate needs a fresh repair ticket.`);
  }
  return openOracleRoundRefusal(review.ref, review.status, oracle.round ?? 1);
}
function reviewVerdictRoute(review) {
  const oracleRefusal = oracleRoundRefusal(review);
  if (oracleRefusal) return oracleRefusal.message;
  const { reviewTarget: target = {} } = review;
  return `Once that review is done, finalize it with ${finalizeShape(review.ref, target.ref, target.candidate)}.`;
}
function reviewedSourceRefusal(source, review) {
  const mirror = reviewedSourceMirror(source);
  if (!mirror) return;
  const route = review ? ` ${reviewVerdictRoute(review)}` : "";
  return refuse("review_ref_required", `${source.ref} is the reviewed source, not the review: verdict takes its bound review ${mirror.ref} as ref, and ${source.ref} only appears as finalize.sourceRef.${route}`);
}
function pendingOracleVerdictRefusal(ticket) {
  if (!ticket) return;
  const pending = [ticket.status === "awaiting-oracle", Boolean(ticket.oracle), !ticket.oracle?.verdict, Boolean(ticket.reviewTarget?.ticketId)];
  if (pending.includes(false)) return;
  return refuse("oracle_verdict_pending", `${ticket.ref} is a bound review still awaiting its oracle verdict; closing it now leaves the review outcome unrecorded and the verdict unreachable. Record it first with verdict {ref: "${ticket.ref}", outcome: "accepted"|"rejected"|"inconclusive", by, text}: an accepted readonly review closes itself, any other outcome returns it to todo for groomClose.`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  finalizeShape,
  oracleRoundRefusal,
  pendingOracleVerdictRefusal,
  reviewedSourceRefusal
});
