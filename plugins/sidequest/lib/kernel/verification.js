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
var verification_exports = {};
__export(verification_exports, {
  VERIFICATION_KINDS: () => VERIFICATION_KINDS,
  VERIFICATION_STATUSES: () => VERIFICATION_STATUSES,
  captureVerificationResult: () => captureVerificationResult,
  classifyVerificationKind: () => classifyVerificationKind,
  validateVerificationWaiver: () => validateVerificationWaiver,
  validationDiagnostic: () => validationDiagnostic,
  verificationAccepted: () => verificationAccepted,
  verificationFailureDiagnostic: () => verificationFailureDiagnostic,
  verificationOutcome: () => verificationOutcome,
  verificationRequirement: () => verificationRequirement,
  verificationWaiverDiagnostic: () => verificationWaiverDiagnostic
});
module.exports = __toCommonJS(verification_exports);
const VERIFICATION_KINDS = ["suite", "command", "document", "link", "schema", "manual", "attestation", "review", "custom"];
const VERIFICATION_STATUSES = ["passed", "failed_suite", "toolchain_missing", "could_not_run", "timeout", "manual", "attestation", "skipped", "failed_check"];
function nonEmpty(value) {
  return String(value || "").trim();
}
function requiredKind(value) {
  return VERIFICATION_KINDS.includes(value) ? value : "custom";
}
function classifyVerificationKind(verify, declaredKind) {
  if (/^manual:\s+/i.test(nonEmpty(verify))) return "manual";
  return requiredKind(nonEmpty(declaredKind || "command").toLowerCase());
}
function suiteFrom(input) {
  if (!input.suite) return void 0;
  const name = nonEmpty(input.suite.name);
  const cwd = nonEmpty(input.suite.cwd);
  const command = nonEmpty(input.suite.command);
  return name && cwd && command ? Object.freeze({ name, cwd, setup: input.suite.setup || null, command }) : void 0;
}
function suiteCommand(suite) {
  return `cd ${suite.cwd} && ${[suite.setup, suite.command].filter(Boolean).join(" && ")}`;
}
function validationDiagnostic(code, message) {
  return Object.freeze({ code, message, actionable: true });
}
function verificationRequirement(input) {
  const kind = classifyVerificationKind(input.evidence || input.command, input.kind);
  const evidence = nonEmpty(input.evidence);
  const command = nonEmpty(input.command || (kind === "command" ? evidence : ""));
  const suite = suiteFrom(input);
  if (kind === "attestation") {
    const artifact = nonEmpty(input.artifact);
    return Object.freeze({ kind, artifact, evidenceContract: `attestation evidence for ${artifact}` });
  }
  if (kind === "review") return Object.freeze({ kind, evidenceContract: evidence || "independent review findings" });
  if (kind === "manual") return Object.freeze({ kind, evidenceContract: evidence.replace(/^manual:\s*/i, "") || "manual verification evidence" });
  if (kind === "suite" || !command && suite) {
    if (!suite) return Object.freeze({ kind: "suite", ...command ? { command } : {}, evidenceContract: evidence || "named suite output" });
    return Object.freeze({ kind: "suite", suite, command: suiteCommand(suite), evidenceContract: `suite ${suite.name} output` });
  }
  if (["document", "link", "schema", "custom"].includes(kind)) {
    return Object.freeze({ kind, evidenceContract: evidence || `${kind} verification evidence` });
  }
  return Object.freeze({ kind: "command", command: command || void 0, evidenceContract: command || "command output" });
}
function verificationWaiverDiagnostic(waiver) {
  return validationDiagnostic("verification_waived", `Verification gate ${waiver.affectedGate} waived by ${waiver.authority}: ${waiver.reason}`);
}
function validateVerificationWaiver(value, now = /* @__PURE__ */ new Date()) {
  if (!value || typeof value !== "object") return validationDiagnostic("verification_waiver_required", "Skipping required verification requires a human waiver with authority, reason, affectedGate, and bounded scope or expiry.");
  const waiver = value;
  const authority = nonEmpty(waiver.authority);
  const reason = nonEmpty(waiver.reason);
  const affectedGate = nonEmpty(waiver.affectedGate);
  const scope = nonEmpty(waiver.scope);
  const expiresAt = nonEmpty(waiver.expiresAt);
  if (!authority || !reason || !affectedGate || !scope && !expiresAt) {
    return validationDiagnostic("verification_waiver_incomplete", "A verification waiver requires authority, reason, affectedGate, and either scope or expiresAt.");
  }
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) {
    return validationDiagnostic("verification_waiver_expired", "A verification waiver expiry must be a future ISO timestamp.");
  }
  return Object.freeze({ authority, reason, affectedGate, ...scope ? { scope } : {}, ...expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {} });
}
function verificationAccepted(result) {
  if (result.status === "passed" || result.status === "manual" || result.status === "attestation") return true;
  if (result.status !== "skipped") return false;
  return !("code" in validateVerificationWaiver(result.waiver));
}
function verificationOutcome(result) {
  return verificationAccepted(result) ? "verified" : `verification_${String(result.status).replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
}
function verificationFailureDiagnostic(result) {
  if (verificationAccepted(result)) return null;
  const identities = result.failureIdentities?.length ? ` Failures: ${result.failureIdentities.join(", ")}.` : "";
  return validationDiagnostic(`verification_${String(result.status).replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`, `Required ${result.kind} verification returned ${result.status}.${identities}`);
}
function captureVerificationResult(requirement, capture) {
  if (capture.status === "passed") {
    return Object.freeze({ kind: requirement.kind, status: "passed", evidence: requirement.evidenceContract, command: capture.command || requirement.command || null, logPath: capture.logPath || null });
  }
  const status = capture.status === "failed_suite" ? "failed_suite" : capture.status === "timeout" ? "timeout" : capture.status === "toolchain_missing" ? "toolchain_missing" : "could_not_run";
  const identity = capture.exitCode == null ? status : `${status}:exit-${capture.exitCode}`;
  return Object.freeze({ kind: requirement.kind, status, evidence: String(capture.reason || ""), command: capture.command || requirement.command || null, logPath: capture.logPath || null, failureIdentities: Object.freeze([identity]) });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VERIFICATION_KINDS,
  VERIFICATION_STATUSES,
  captureVerificationResult,
  classifyVerificationKind,
  validateVerificationWaiver,
  validationDiagnostic,
  verificationAccepted,
  verificationFailureDiagnostic,
  verificationOutcome,
  verificationRequirement,
  verificationWaiverDiagnostic
});
