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
var kernel_exports = {};
__export(kernel_exports, {
  ATTEMPT_TRANSITIONS: () => ATTEMPT_TRANSITIONS,
  VERIFICATION_KINDS: () => import_verification.VERIFICATION_KINDS,
  assembleWave: () => import_wave.assembleWave,
  attemptDiagnostic: () => attemptDiagnostic,
  canonicalPath: () => import_worktree.canonicalPath,
  captureVerificationResult: () => import_verification.captureVerificationResult,
  classifyVerificationKind: () => import_verification.classifyVerificationKind,
  commandVerificationResult: () => import_verification.commandVerificationResult,
  createWorktreeLease: () => import_worktree.createWorktreeLease,
  dependentReleaseDecision: () => import_wave.dependentReleaseDecision,
  isCanonicalRegisteredWorktree: () => import_worktree.isCanonicalRegisteredWorktree,
  openWave: () => import_wave.openWave,
  prepareAttempt: () => prepareAttempt,
  prepareDirectAttempt: () => prepareDirectAttempt,
  recordAssembledWaveGate: () => import_wave.recordAssembledWaveGate,
  recordWaveDelivery: () => import_wave.recordWaveDelivery,
  reduceAttempt: () => reduceAttempt,
  sameCanonicalPath: () => import_worktree.sameCanonicalPath,
  transitionAttempt: () => transitionAttempt,
  validateVerificationWaiver: () => import_verification.validateVerificationWaiver,
  verificationAccepted: () => import_verification.verificationAccepted,
  verificationFailureDiagnostic: () => import_verification.verificationFailureDiagnostic,
  verificationOutcome: () => import_verification.verificationOutcome,
  verificationRequirement: () => import_verification.verificationRequirement,
  verificationWaiverDiagnostic: () => import_verification.verificationWaiverDiagnostic,
  worktreeCleanupDecision: () => import_worktree.worktreeCleanupDecision,
  worktreeCreateDecision: () => import_worktree.worktreeCreateDecision,
  worktreeResumeDecision: () => import_worktree.worktreeResumeDecision,
  worktreeWriteDecision: () => import_worktree.worktreeWriteDecision
});
module.exports = __toCommonJS(kernel_exports);
var import_worktree = require("./worktree.js");
var import_verification = require("./verification.js");
var import_wave = require("./wave.js");
const ATTEMPT_TRANSITIONS = {
  prepared: { launch: "launched", bind_claim_token: "bound", claim_direct: "claimed", release: "released" },
  launched: { bind: "bound", bind_claim_token: "bound", release: "released" },
  bound: { claim: "claimed", release: "released" },
  claimed: { start_work: "working", release: "released" },
  working: { verify: "verified", release: "released" },
  verified: { submit: "submitted", release: "released" },
  submitted: { assemble: "assembled", invalidate: "invalidated", release: "released" },
  assembled: { integrate: "integrated", invalidate: "invalidated", release: "released" },
  integrated: { close: "closed", release: "released" },
  closed: {},
  released: {},
  invalidated: { refresh: "working", release: "released" }
};
function prepareAttempt(baseline, authority, preparedCompatibility, verificationRequirement2) {
  return Object.freeze({
    state: "prepared",
    execution: "dispatched",
    baseline,
    authority,
    ...preparedCompatibility ? { preparedCompatibility: Object.freeze({ ...preparedCompatibility }) } : {},
    ...verificationRequirement2 ? { verificationRequirement: Object.freeze({ ...verificationRequirement2 }) } : {}
  });
}
function prepareDirectAttempt(baseline, authority) {
  return Object.freeze({ state: "prepared", execution: "direct", baseline, authority });
}
function transitionAttempt(attempt, event) {
  const directDispatchEvent = attempt.execution === "direct" && ["launch", "bind", "bind_claim_token", "claim"].includes(event);
  const dispatchedDirectEvent = attempt.execution === "dispatched" && event === "claim_direct";
  if (directDispatchEvent || dispatchedDirectEvent) return Object.freeze({ code: "invalid_transition", message: `Cannot ${event} a ${attempt.execution} attempt.`, actionable: false });
  const next = ATTEMPT_TRANSITIONS[attempt.state][event];
  return next ? Object.freeze({ ...attempt, state: next }) : Object.freeze({ code: "invalid_transition", message: `Cannot ${event} an attempt in ${attempt.state}.`, actionable: false });
}
function reduceAttempt(attempt, events) {
  let current = attempt;
  for (const event of events) {
    if ("code" in current) return current;
    current = transitionAttempt(current, event);
  }
  return current;
}
function attemptDiagnostic(result) {
  return "code" in result ? result : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ATTEMPT_TRANSITIONS,
  VERIFICATION_KINDS,
  assembleWave,
  attemptDiagnostic,
  canonicalPath,
  captureVerificationResult,
  classifyVerificationKind,
  commandVerificationResult,
  createWorktreeLease,
  dependentReleaseDecision,
  isCanonicalRegisteredWorktree,
  openWave,
  prepareAttempt,
  prepareDirectAttempt,
  recordAssembledWaveGate,
  recordWaveDelivery,
  reduceAttempt,
  sameCanonicalPath,
  transitionAttempt,
  validateVerificationWaiver,
  verificationAccepted,
  verificationFailureDiagnostic,
  verificationOutcome,
  verificationRequirement,
  verificationWaiverDiagnostic,
  worktreeCleanupDecision,
  worktreeCreateDecision,
  worktreeResumeDecision,
  worktreeWriteDecision
});
