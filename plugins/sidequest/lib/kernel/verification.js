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
  VERIFICATION_ENVIRONMENTS: () => VERIFICATION_ENVIRONMENTS,
  VERIFICATION_KINDS: () => VERIFICATION_KINDS,
  VERIFICATION_STATUSES: () => VERIFICATION_STATUSES,
  captureVerificationResult: () => captureVerificationResult,
  classifyVerificationKind: () => classifyVerificationKind,
  commandVerificationResult: () => commandVerificationResult,
  environmentPrefix: () => environmentPrefix,
  validateVerificationWaiver: () => validateVerificationWaiver,
  validationDiagnostic: () => validationDiagnostic,
  verificationAccepted: () => verificationAccepted,
  verificationFailureDiagnostic: () => verificationFailureDiagnostic,
  verificationOutcome: () => verificationOutcome,
  verificationRequirement: () => verificationRequirement,
  verificationWaiverDiagnostic: () => verificationWaiverDiagnostic,
  verifyCwdForRequirement: () => verifyCwdForRequirement
});
module.exports = __toCommonJS(verification_exports);
const VERIFICATION_KINDS = ["suite", "command", "typecheck", "document", "link", "schema", "manual", "attestation", "review", "custom"];
const VERIFICATION_STATUSES = ["passed", "failed_suite", "toolchain_missing", "could_not_run", "timeout", "manual", "attestation", "skipped", "failed_check", "deferred"];
const VERIFICATION_ENVIRONMENTS = ["isolated", "shared"];
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
const ENVIRONMENT_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)+/;
function environmentPrefix(command) {
  return ENVIRONMENT_ASSIGNMENTS.exec(nonEmpty(command))?.[0].trim() || "";
}
function suiteCommand(suite, environment) {
  const steps = [suite.setup, suite.command].filter(Boolean).map((step) => [environment, step].filter(Boolean).join(" "));
  return `cd ${suite.cwd} && ${steps.join(" && ")}`;
}
function verifyCwdForRequirement(requirement, verifyCwd) {
  return requirement?.suite ? "" : String(verifyCwd || "");
}
function validationDiagnostic(code, message) {
  return Object.freeze({ code, message, actionable: true });
}
function suiteVerificationRequirement(input, command, evidence) {
  const suite = suiteFrom(input);
  if (suite) return Object.freeze({ kind: "suite", suite, command: suiteCommand(suite, environmentPrefix(command)), evidenceContract: `suite ${suite.name} output` });
  return Object.freeze({ kind: "suite", ...command ? { command } : {}, evidenceContract: evidence || "named suite output" });
}
function executableVerificationRequirement(input, kind, evidence) {
  const command = nonEmpty([input.command, ["command", "typecheck"].includes(kind) ? evidence : ""].find(Boolean));
  if ([kind === "suite", [!command, Boolean(suiteFrom(input))].every(Boolean)].some(Boolean)) return suiteVerificationRequirement(input, command, evidence);
  return Object.freeze({ kind, command: command || void 0, evidenceContract: command || "command output" });
}
function evidenceVerificationRequirement(input, kind, evidence) {
  if (kind === "attestation") {
    const artifact = nonEmpty(input.artifact);
    return Object.freeze({ kind, artifact, evidenceContract: `attestation evidence for ${artifact}` });
  }
  const defaults = { review: "independent review findings", manual: "manual verification evidence" };
  return Object.freeze({ kind, evidenceContract: evidence || defaults[kind] || `${kind} verification evidence` });
}
function verificationRequirement(input) {
  const kind = classifyVerificationKind(input.evidence || input.command, input.kind);
  const evidence = nonEmpty(input.evidence);
  const evidenceOnly = ["attestation", "review", "manual"].includes(kind);
  const executable = [["command", "suite", "typecheck"].includes(kind), [!evidenceOnly, !nonEmpty(input.command), Boolean(suiteFrom(input))].every(Boolean)].some(Boolean);
  if (executable) return executableVerificationRequirement(input, kind, evidence);
  return evidenceVerificationRequirement(input, kind, evidence.replace(/^manual:\s*/i, kind === "manual" ? "" : "$&"));
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
function captureAttemptLabel(dispatchNonce) {
  return dispatchNonce ? `dispatch attempt ${dispatchNonce}` : "this direct claim";
}
function missingCaptureInstruction(command, directCaptureInvocation) {
  if (!directCaptureInvocation) return `Run ${JSON.stringify(command)} through the dispatched verify-capture wrapper again after finalizing that candidate, then resubmit.`;
  return `A direct claim has no dispatch briefing: from the checkout holding that candidate, run ${directCaptureInvocation} (it loads the pinned command from the ticket and records the capture), then resubmit.`;
}
function missingCaptureVerificationResult(requirement, command, dirtyCapture, ticket, candidate, dispatchNonce, directCaptureInvocation) {
  const message = dirtyCapture ? `Verification capture ${dirtyCapture.id} for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)} ran over a dirty worktree. Commit or discard the changes, then run the pinned verifier again before resubmitting.` : `No completed passed verification capture exists for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)}. ${missingCaptureInstruction(command, directCaptureInvocation)}`;
  return Object.freeze({
    result: Object.freeze({ kind: requirement.kind, status: "failed_check", evidence: message, command, failureIdentities: Object.freeze([dirtyCapture ? "verification:dirty-worktree-capture" : "verification:capture-required"]) }),
    expectedEvidence: null,
    diagnostic: Object.freeze({ code: dirtyCapture ? "verification_capture_dirty_worktree" : "verification_capture_required", message, retryable: true })
  });
}
function commandVerificationResult(requirement, evidence, captures, ticket, candidate, dispatchNonce, directCaptureInvocation = "") {
  const command = requirement.command;
  if (!command) {
    const message = "Command verification requires a dispatch-pinned verifier.";
    return Object.freeze({
      result: Object.freeze({ kind: requirement.kind, status: "failed_check", evidence: message, command, failureIdentities: Object.freeze(["verification:pinned-command-missing"]) }),
      expectedEvidence: null,
      diagnostic: Object.freeze({ code: "executor_verify_required", message, retryable: true })
    });
  }
  const matchingCapture = (capture) => capture.ticket === ticket && capture.command === command && capture.status === "passed" && capture.candidate.source === candidate.source && capture.candidate.value === candidate.value && capture.dispatchNonce === dispatchNonce;
  const provesCandidate = (capture) => capture.candidate.source === "working-tree" || capture.cleanWorktree === true;
  const completedCapture = captures.find((capture) => matchingCapture(capture) && provesCandidate(capture));
  if (!completedCapture) {
    const dirtyCapture = captures.find((capture) => matchingCapture(capture) && capture.cleanWorktree === false);
    return missingCaptureVerificationResult(requirement, command, dirtyCapture, ticket, candidate, dispatchNonce, directCaptureInvocation);
  }
  return Object.freeze({
    result: Object.freeze({
      kind: requirement.kind,
      status: "passed",
      verifierSource: "pinned",
      evidence: command,
      command,
      logPath: completedCapture.logPath || null,
      exitCode: completedCapture.exitCode ?? null
    }),
    expectedEvidence: command
  });
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
  VERIFICATION_ENVIRONMENTS,
  VERIFICATION_KINDS,
  VERIFICATION_STATUSES,
  captureVerificationResult,
  classifyVerificationKind,
  commandVerificationResult,
  environmentPrefix,
  validateVerificationWaiver,
  validationDiagnostic,
  verificationAccepted,
  verificationFailureDiagnostic,
  verificationOutcome,
  verificationRequirement,
  verificationWaiverDiagnostic,
  verifyCwdForRequirement
});
