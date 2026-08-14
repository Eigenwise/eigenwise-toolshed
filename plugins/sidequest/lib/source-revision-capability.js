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
var source_revision_capability_exports = {};
__export(source_revision_capability_exports, {
  isSourceRevisionAdapterFacts: () => isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability: () => registerSourceRevisionCapability,
  sourceRevisionAdapterFacts: () => sourceRevisionAdapterFacts,
  sourceRevisionBaseline: () => sourceRevisionBaseline
});
module.exports = __toCommonJS(source_revision_capability_exports);
const registrationsByProject = /* @__PURE__ */ new Map();
const resolvedAdapterFacts = /* @__PURE__ */ new WeakSet();
function projectKey(project) {
  return String(project || "").trim().toLowerCase();
}
function baselinePurpose(value) {
  if (value === "dispatch" || value === "wave" || value === "submission") return value;
  return null;
}
function immutableSourceRevision(value) {
  const source = String(value?.source || "").trim();
  const revisionValue = String(value?.value || "").trim();
  const observedAt = String(value?.observedAt || "").trim();
  if (!source || !revisionValue || !Number.isFinite(Date.parse(observedAt))) return null;
  return Object.freeze({ source, value: revisionValue, observedAt: new Date(observedAt).toISOString() });
}
function immutableBaseline(value) {
  const revision = immutableSourceRevision(value?.revision);
  const purpose = baselinePurpose(value?.purpose);
  if (!revision || !purpose) return null;
  return Object.freeze({ revision, purpose });
}
function sourceRevisionBaseline(ticket) {
  return immutableBaseline(
    ticket?.submissionRetry?.baseline || ticket?.lifecycleAttempt?.baseline || ticket?.dispatch?.lifecycleAttempt?.baseline
  );
}
function registerSourceRevisionCapability(project, capability) {
  const key = projectKey(project);
  if (!key) throw new Error("source revision capability requires a project");
  if (typeof capability !== "function") throw new Error("source revision capability must be a function");
  const token = Symbol(key);
  registrationsByProject.set(key, Object.freeze({ token, capability }));
  return () => {
    if (registrationsByProject.get(key)?.token === token) registrationsByProject.delete(key);
  };
}
function sourceRevisionAdapterFacts(project, candidate, baseline) {
  const pinnedCandidate = immutableSourceRevision(candidate || void 0);
  const pinnedBaseline = immutableBaseline(baseline || void 0);
  if (!pinnedCandidate || !pinnedBaseline) return null;
  const capability = registrationsByProject.get(projectKey(project))?.capability;
  let resolution = null;
  if (capability) {
    try {
      const reported = capability(pinnedCandidate, pinnedBaseline);
      if (reported && typeof reported.candidateExists === "boolean" && typeof reported.containsCandidate === "boolean") {
        resolution = Object.freeze({
          candidateExists: reported.candidateExists,
          containsCandidate: reported.containsCandidate
        });
      }
    } catch {
      resolution = null;
    }
  }
  const facts = Object.freeze({
    candidate: pinnedCandidate,
    dispatchBaseline: pinnedBaseline,
    baseline: resolution
  });
  resolvedAdapterFacts.add(facts);
  return facts;
}
function isSourceRevisionAdapterFacts(value) {
  return Boolean(value && typeof value === "object" && resolvedAdapterFacts.has(value));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isSourceRevisionAdapterFacts,
  registerSourceRevisionCapability,
  sourceRevisionAdapterFacts,
  sourceRevisionBaseline
});
