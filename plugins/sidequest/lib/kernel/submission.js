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
var submission_exports = {};
__export(submission_exports, {
  decideSubmissionAdmission: () => decideSubmissionAdmission
});
module.exports = __toCommonJS(submission_exports);
var import_scope_match = require("../scope-match.js");
var import_verification = require("./verification.js");
function diagnostic(failure) {
  return Object.freeze({ code: failure.code, message: failure.message, actionable: failure.actionable !== false });
}
function supplied(failure, fallback) {
  return failure || fallback;
}
function outsideAdmittedSurfaces(surfaces) {
  return surfaces.changed.filter((surface) => !(0, import_scope_match.isInScope)(surface, surfaces.admitted));
}
function sameSourceRevision(left, right) {
  return Boolean(
    left && right && left.source === right.source && left.value === right.value && left.observedAt === right.observedAt
  );
}
function sameBaseline(left, right) {
  return Boolean(
    left && right && left.purpose === right.purpose && sameSourceRevision(left.revision, right.revision)
  );
}
function baselineBoundToCandidate(facts) {
  if (!facts.sourceBaseline) return true;
  return sameSourceRevision(facts.baseline.candidate, facts.candidate) && sameBaseline(facts.baseline.dispatchBaseline, facts.sourceBaseline);
}
function verificationAdmitted(result) {
  return (0, import_verification.verificationAccepted)(result) || result.status === "deferred";
}
function candidateOwner(authority) {
  return authority.claimOwner || (authority.allowSubmittedOwner ? authority.submittedOwner : null);
}
function authorityFailure(ticket, authority) {
  if (authority.terminal) return { code: "done", message: `submit: refused ${ticket.ref}; the ticket is already done.`, actionable: false, retryable: false };
  const owner = candidateOwner(authority);
  if (!owner) return supplied(authority.claimReleaseDiagnostic, { code: "not_claimed", message: `submit: refused ${ticket.ref}; a held claim is required.`, retryable: true });
  if (owner !== authority.authority.actor) {
    return { code: "not_owner", message: `submit: refused ${ticket.ref}; not_owner: ${authority.authority.actor} does not own the candidate.`, retryable: false };
  }
  return null;
}
function baselineFactsUnavailable(facts) {
  return !baselineBoundToCandidate(facts) || facts.baseline.candidateExists == null || facts.baseline.containsCandidate == null;
}
function baselineFailure(facts) {
  const { ticket, candidate, baseline } = facts;
  if (baselineFactsUnavailable(facts)) {
    return supplied(baseline.diagnostic, { code: "baseline_membership_unavailable", message: `submit: refused ${ticket.ref}; the project adapter did not return immutable existence and baseline-membership facts for ${candidate.source}:${candidate.value}. Refresh the adapter facts and resubmit the preserved candidate.`, retryable: true });
  }
  if (!baseline.candidateExists) {
    return supplied(baseline.diagnostic, { code: "source_revision_missing", message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} does not exist in the project adapter.`, retryable: true });
  }
  if (!baseline.containsCandidate) {
    return supplied(baseline.diagnostic, { code: "baseline_membership_mismatch", message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} is outside the immutable project baseline.`, retryable: true });
  }
  return null;
}
function verificationFailure(ticket, verification) {
  if (!verificationAdmitted(verification.result)) {
    return supplied(verification.diagnostic, { code: "invalid_verify", message: `submit: refused ${ticket.ref}; verification evidence is unavailable.`, retryable: true });
  }
  if (verification.expectedEvidence && verification.result.evidence !== verification.expectedEvidence) {
    return { code: "executor_verify_mismatch", message: `submit: refused ${ticket.ref}; verification must match the declared executor verify command.`, retryable: true };
  }
  return null;
}
function surfaceFailures(ticket, surfaces) {
  const failures = [];
  const outside = outsideAdmittedSurfaces(surfaces);
  if (outside.length) {
    failures.push(supplied(surfaces.diagnostic, { code: "outside_scope", message: `submit: refused ${ticket.ref}; submitted surfaces are outside its declared scope: ${outside.join(", ")}. Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`, retryable: true }));
  }
  if (surfaces.pending.length) {
    failures.push({ code: "dirty_scope", message: `submit: refused ${ticket.ref}; uncommitted changes fall inside this ticket's declared scope: ${surfaces.pending.join(", ")}. Commit these paths, or explain why they are deliberately excluded before resubmitting.`, retryable: true });
  }
  return failures;
}
function decideSubmissionAdmission(facts) {
  const { ticket, authority, completion, verification, surfaces, duplicate } = facts;
  const failures = [
    authorityFailure(ticket, authority),
    duplicate.identity ? supplied(duplicate.diagnostic, { code: "duplicate_submission", message: `submit: refused ${ticket.ref}; candidate ${duplicate.identity} is already submitted.`, retryable: false }) : null,
    completion.complete ? null : supplied(completion.diagnostic, { code: "incomplete", message: `submit: refused ${ticket.ref}; completion is not recorded.`, retryable: true }),
    baselineFailure(facts),
    verificationFailure(ticket, verification),
    ...surfaceFailures(ticket, surfaces),
    ...facts.requirements || []
  ].filter((failure) => failure !== null);
  if (!failures.length) return Object.freeze({ ok: true, diagnostics: Object.freeze([]) });
  const diagnostics = Object.freeze(failures.map(diagnostic));
  return Object.freeze({ ok: false, diagnostics, retryable: failures.every((failure) => failure.retryable !== false), outsideAdmittedSurfaces: Object.freeze(outsideAdmittedSurfaces(surfaces)) });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decideSubmissionAdmission
});
