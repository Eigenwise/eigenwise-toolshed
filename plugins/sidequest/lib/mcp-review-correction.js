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
var mcp_review_correction_exports = {};
__export(mcp_review_correction_exports, {
  correctReviewVerdict: () => correctReviewVerdict
});
module.exports = __toCommonJS(mcp_review_correction_exports);
var import_review_binding = require("./kernel/review-binding");
const store = require("./store");
function correctionCandidate(correct) {
  if (Boolean(correct.commit) === Boolean(correct.sourceRevision)) return null;
  if (correct.commit) return (0, import_review_binding.isReviewCommit)(correct.commit) ? { source: "git", value: correct.commit.toLowerCase() } : null;
  const revision = correct.sourceRevision;
  if (typeof revision?.source !== "string" || typeof revision.value !== "string") return null;
  return revision.source.trim() && revision.value.trim() ? { source: revision.source, value: revision.value } : null;
}
function correctReviewVerdict(slug, args, sessionId) {
  if (args.outcome !== "rejected") return { ok: false, reason: "invalid_correction", message: "Correction requires outcome rejected." };
  if (!args.correct || typeof args.correct !== "object") return { ok: false, reason: "invalid_correction", message: "Correction requires its exact original verdict/source/candidate and evidence." };
  const candidate = correctionCandidate(args.correct);
  if (!candidate) return { ok: false, reason: "invalid_correction", message: "Correction requires exactly one valid commit or sourceRevision." };
  const input = {
    by: args.by,
    sessionId: sessionId ?? "",
    text: args.text,
    why: args.why,
    evidence: args.correct.evidence,
    expected: { outcome: args.correct.expectedOutcome, verdictAt: args.correct.expectedVerdictAt, sourceRef: args.correct.sourceRef, candidate }
  };
  return store.correctAcceptedReviewVerdict(slug, args.ref, input, { allowAcceptedReviewCorrection: true });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  correctReviewVerdict
});
