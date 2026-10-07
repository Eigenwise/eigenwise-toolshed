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
function correctionObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonemptyCorrectionText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function correctionRevision(value) {
  if (!correctionObject(value)) return null;
  if (!nonemptyCorrectionText(value.source) || !nonemptyCorrectionText(value.value)) return null;
  return { source: value.source, value: value.value };
}
function correctionMetadata(correct) {
  return typeof correct.expectedVerdictAt === "string" && typeof correct.sourceRef === "string" && typeof correct.evidence === "string";
}
function correctionCandidate(correct) {
  if (Object.hasOwn(correct, "commit") === Object.hasOwn(correct, "sourceRevision")) return null;
  if (!Object.hasOwn(correct, "commit")) return correctionRevision(correct.sourceRevision);
  if (typeof correct.commit !== "string" || !(0, import_review_binding.isReviewCommit)(correct.commit)) return null;
  return { source: "git", value: correct.commit.trim().toLowerCase() };
}
function correctReviewVerdict(slug, args, sessionId) {
  if (args.outcome !== "rejected" || args.constraint !== void 0) return { ok: false, reason: "invalid_correction", message: "Correction requires outcome rejected and accepts why, not constraint." };
  const correct = args.correct;
  if (!correctionObject(correct)) return { ok: false, reason: "invalid_correction", message: "Correction requires its exact original verdict/source/candidate and evidence." };
  return correctValidatedRequest(slug, args, correct, sessionId);
}
function correctValidatedRequest(slug, args, correct, sessionId) {
  if (correct.expectedOutcome !== "accepted") return { ok: false, reason: "invalid_correction", message: "Correction expects the original accepted verdict." };
  if (!correctionMetadata(correct)) return { ok: false, reason: "invalid_correction", message: "Correction expectedVerdictAt, sourceRef and evidence must be text." };
  const candidate = correctionCandidate(correct);
  if (!candidate) return { ok: false, reason: "invalid_correction", message: "Correction requires exactly one valid commit or sourceRevision." };
  const input = {
    by: args.by,
    sessionId: sessionId ?? "",
    text: args.text,
    why: args.why,
    evidence: correct.evidence,
    expected: { outcome: correct.expectedOutcome, verdictAt: correct.expectedVerdictAt, sourceRef: correct.sourceRef, candidate }
  };
  return store.correctAcceptedReviewVerdict(slug, args.ref, input, { allowAcceptedReviewCorrection: true });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  correctReviewVerdict
});
