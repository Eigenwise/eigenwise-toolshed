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
function decideSubmissionAdmission(facts) {
  const failures = [];
  const { ticket, authority, completion, verification, candidate, baseline, surfaces, duplicate } = facts;
  const owner = authority.claimOwner || authority.submittedOwner;
  if (authority.terminal) {
    failures.push({ code: "done", message: `submit: refused ${ticket.ref}; the ticket is already done.`, actionable: false, retryable: false });
  } else if (!owner || !authority.claimOwner && !authority.allowSubmittedOwner) {
    failures.push(supplied(authority.claimReleaseDiagnostic, { code: "not_claimed", message: `submit: refused ${ticket.ref}; a held claim is required.`, retryable: true }));
  } else if (owner !== authority.authority.actor) {
    failures.push({ code: "not_owner", message: `submit: refused ${ticket.ref}; not_owner: ${authority.authority.actor} does not own the candidate.`, retryable: false });
  }
  if (duplicate.identity) {
    failures.push(supplied(duplicate.diagnostic, { code: "duplicate_submission", message: `submit: refused ${ticket.ref}; candidate ${duplicate.identity} is already submitted.`, retryable: false }));
  }
  if (!completion.complete) failures.push(supplied(completion.diagnostic, { code: "incomplete", message: `submit: refused ${ticket.ref}; completion is not recorded.`, retryable: true }));
  if (!baselineBoundToCandidate(facts) || baseline.candidateExists == null || baseline.containsCandidate == null) {
    failures.push(supplied(baseline.diagnostic, { code: "baseline_membership_unavailable", message: `submit: refused ${ticket.ref}; the project adapter did not return immutable existence and baseline-membership facts for ${candidate.source}:${candidate.value}. Refresh the adapter facts and resubmit the preserved candidate.`, retryable: true }));
  } else if (!baseline.candidateExists) {
    failures.push(supplied(baseline.diagnostic, { code: "source_revision_missing", message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} does not exist in the project adapter.`, retryable: true }));
  } else if (!baseline.containsCandidate) {
    failures.push(supplied(baseline.diagnostic, { code: "baseline_membership_mismatch", message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} is outside the immutable project baseline.`, retryable: true }));
  }
  if (!(0, import_verification.verificationAccepted)(verification.result)) {
    failures.push(supplied(verification.diagnostic, { code: "invalid_verify", message: `submit: refused ${ticket.ref}; verification evidence is unavailable.`, retryable: true }));
  } else if (verification.expectedEvidence && verification.result.evidence !== verification.expectedEvidence) {
    failures.push({ code: "executor_verify_mismatch", message: `submit: refused ${ticket.ref}; verification must match the declared executor verify command.`, retryable: true });
  }
  const outside = outsideAdmittedSurfaces(surfaces);
  if (outside.length) {
    failures.push(supplied(surfaces.diagnostic, { code: "outside_scope", message: `submit: refused ${ticket.ref}; submitted surfaces are outside its declared scope: ${outside.join(", ")}. Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`, retryable: true }));
  }
  if (surfaces.pending.length) {
    failures.push({ code: "dirty_scope", message: `submit: refused ${ticket.ref}; uncommitted changes fall inside this ticket's declared scope: ${surfaces.pending.join(", ")}. Commit these paths, or explain why they are deliberately excluded before resubmitting.`, retryable: true });
  }
  failures.push(...facts.requirements || []);
  if (!failures.length) return Object.freeze({ ok: true, diagnostics: Object.freeze([]) });
  const diagnostics = Object.freeze(failures.map(diagnostic));
  return Object.freeze({ ok: false, diagnostics, retryable: failures.every((failure) => failure.retryable !== false), outsideAdmittedSurfaces: Object.freeze(outside) });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decideSubmissionAdmission
});
