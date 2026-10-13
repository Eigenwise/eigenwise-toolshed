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
var mcp_composition_admission_exports = {};
__export(mcp_composition_admission_exports, {
  COMPOSITION_ADMISSION_SCHEMA: () => COMPOSITION_ADMISSION_SCHEMA,
  installCompositionUpdate: () => installCompositionUpdate
});
module.exports = __toCommonJS(mcp_composition_admission_exports);
const { store, resolveProject, runtimeSessionId } = require("./mcp-shared");
const REVIEW_OUTCOMES = { planned: true, accepted: true, rejected: true, inconclusive: true };
const IMMUTABLE_COMMIT = { type: "string", pattern: "^[a-f0-9]{40}$" };
const SOURCE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "commit", "submittedAt"],
  properties: { ref: { type: "string", minLength: 1 }, commit: IMMUTABLE_COMMIT, submittedAt: { type: "string", minLength: 1 } }
};
const SOURCE_EXPECTED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "reviewTicketId", "reviewOutcome", "correctedAt", "snapshot"],
  properties: {
    ref: { type: "string", minLength: 1 },
    reviewTicketId: { type: ["string", "null"] },
    reviewOutcome: { enum: [...Object.keys(REVIEW_OUTCOMES), null] },
    correctedAt: { type: ["string", "null"] },
    snapshot: { type: "string", minLength: 1 }
  }
};
const COMPOSITION_ADMISSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "Main-thread current adoption of exact immutable candidate C for a genuinely released root. Historical checkout ownership stays unverified. Sources stay pending and unaccepted. Omit expected for a bounded write-free expected_required CAS snapshot, then retry with it. Original BASE remains the full range floor; only a new native isolated checkout starts at C. by/evidence are audit only. Run ordinary update.verify/verifyCwd separately for new holder-owned output; fresh controls, nonce/capture and post-submit independent exact-C review remain required.",
  required: ["authority", "historicalCheckout", "by", "evidence", "candidate", "base", "ownCommits", "ownPaths", "sources"],
  properties: {
    authority: { const: "main-attestation" },
    historicalCheckout: { const: false },
    by: { type: "string", minLength: 1 },
    evidence: { type: "string", minLength: 1 },
    candidate: IMMUTABLE_COMMIT,
    base: IMMUTABLE_COMMIT,
    ownCommits: { type: "array", items: IMMUTABLE_COMMIT, uniqueItems: true },
    ownPaths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    sources: { type: "array", items: SOURCE_INPUT_SCHEMA, minItems: 1, maxItems: 20 },
    expected: {
      type: "object",
      additionalProperties: false,
      required: ["attemptCount", "releasedAt", "preparedAt", "sources"],
      properties: {
        attemptCount: { type: "integer", minimum: 0 },
        releasedAt: { type: "string", minLength: 1 },
        preparedAt: { type: "string", minLength: 1 },
        sources: { type: "array", items: SOURCE_EXPECTED_SCHEMA, minItems: 1, maxItems: 20 }
      }
    }
  }
};
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonemptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function commit(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}
function textArray(value) {
  return Array.isArray(value) && value.every(nonemptyText);
}
function commitArray(value) {
  return Array.isArray(value) && value.every(commit);
}
function nullableText(value) {
  return value === null || nonemptyText(value);
}
function reviewOutcome(value) {
  return value === null || typeof value === "string" && Object.hasOwn(REVIEW_OUTCOMES, value);
}
function onlyFields(value, fields) {
  return Object.keys(value).every((field) => fields.includes(field));
}
function sourceInput(value) {
  if (!record(value)) return false;
  return [onlyFields(value, ["ref", "commit", "submittedAt"]), nonemptyText(value.ref), commit(value.commit), nonemptyText(value.submittedAt)].every(Boolean);
}
function sourceExpected(value) {
  if (!record(value)) return false;
  return [
    onlyFields(value, ["ref", "reviewTicketId", "reviewOutcome", "correctedAt", "snapshot"]),
    nonemptyText(value.ref),
    nullableText(value.reviewTicketId),
    reviewOutcome(value.reviewOutcome),
    nullableText(value.correctedAt),
    nonemptyText(value.snapshot)
  ].every(Boolean);
}
function boundedSources(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(sourceInput);
}
function boundedExpectedSources(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(sourceExpected);
}
function expected(value) {
  if (value === void 0) return true;
  if (!record(value)) return false;
  return [
    onlyFields(value, ["attemptCount", "releasedAt", "preparedAt", "sources"]),
    Number.isInteger(value.attemptCount),
    typeof value.attemptCount === "number" && value.attemptCount >= 0,
    nonemptyText(value.releasedAt),
    nonemptyText(value.preparedAt),
    boundedExpectedSources(value.sources)
  ].every(Boolean);
}
function admissionInput(value) {
  if (!record(value)) return false;
  return [
    onlyFields(value, ["authority", "historicalCheckout", "by", "evidence", "candidate", "base", "ownCommits", "ownPaths", "sources", "expected"]),
    value.authority === "main-attestation",
    value.historicalCheckout === false,
    nonemptyText(value.by),
    nonemptyText(value.evidence),
    commit(value.candidate),
    commit(value.base),
    commitArray(value.ownCommits),
    textArray(value.ownPaths),
    boundedSources(value.sources),
    expected(value.expected)
  ].every(Boolean);
}
function admitFromUpdate(input) {
  if (!admissionInput(input.admitComposition)) return { ok: false, reason: "invalid_admission", message: "Use the update.admitComposition schema with exact immutable commits and bounded expected source identities." };
  if (!nonemptyText(input.ref)) return { ok: false, reason: "not_found", message: "Composition root ref is required." };
  if (Object.keys(input).some((field) => !["ref", "project", "admitComposition"].includes(field))) return { ok: false, reason: "invalid_admission", message: "Run composition admission separately from ordinary field updates; refusal must leave all fields unchanged." };
  const { slug } = resolveProject(input.project);
  return store.admitComposition(slug, input.ref, input.admitComposition, runtimeSessionId() ?? "", { allowCompositionAdmission: true });
}
function installCompositionUpdate(tool) {
  if (!tool) throw new Error("Composition admission requires the existing update tool.");
  const ordinaryUpdate = tool.handler;
  tool.inputSchema.properties.admitComposition = COMPOSITION_ADMISSION_SCHEMA;
  tool.description += " Main-only admitComposition adopts exact current C without claiming historical ownership. Omit expected for a bounded write-free CAS probe. It preserves original BASE, sources and old proofs, and requires a fresh native isolated checkout, nonce/capture and independent post-submit exact-C review. Use it separately from ordinary field updates.";
  tool.handler = (input) => Object.hasOwn(input, "admitComposition") ? admitFromUpdate(input) : ordinaryUpdate(input);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMPOSITION_ADMISSION_SCHEMA,
  installCompositionUpdate
});
