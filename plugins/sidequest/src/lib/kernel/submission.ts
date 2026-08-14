'use strict';

import type { Authority, Baseline, Diagnostic, SourceRevision, VerificationResult } from './index';

export type SubmissionTicket = Readonly<{ ref: string }>;
export type SubmissionFailure = Readonly<{ code: string; message: string; actionable?: boolean; retryable?: boolean }>;
export type SubmissionAuthority = Readonly<{
  authority: Authority;
  claimOwner: string | null;
  submittedOwner: string | null;
  claimReleaseDiagnostic?: SubmissionFailure;
  terminal: boolean;
  allowSubmittedOwner: boolean;
}>;
export type SubmissionCompletion = Readonly<{ complete: boolean; diagnostic?: SubmissionFailure }>;
export type SubmissionBaseline = Readonly<{
  candidateExists: boolean | null;
  containsCandidate: boolean | null;
  candidate?: SourceRevision;
  dispatchBaseline?: Baseline;
  diagnostic?: SubmissionFailure;
}>;
export type SubmissionSurfaces = Readonly<{
  declared: readonly string[];
  admitted: readonly string[];
  changed: readonly string[];
  pending: readonly string[];
  diagnostic?: SubmissionFailure;
}>;
export type SubmissionDuplicate = Readonly<{ identity: string | null; diagnostic?: SubmissionFailure }>;
export type SubmissionVerification = Readonly<{
  result: VerificationResult;
  expectedEvidence: string | null;
  diagnostic?: SubmissionFailure;
}>;
export type SubmissionAdmissionFacts = Readonly<{
  ticket: SubmissionTicket;
  authority: SubmissionAuthority;
  completion: SubmissionCompletion;
  verification: SubmissionVerification;
  candidate: SourceRevision;
  baseline: SubmissionBaseline;
  sourceBaseline?: Baseline | null;
  surfaces: SubmissionSurfaces;
  duplicate: SubmissionDuplicate;
  requirements?: readonly SubmissionFailure[];
}>;
export type SubmissionDecision = Readonly<{ ok: true; diagnostics: readonly [] } | { ok: false; diagnostics: readonly Diagnostic[]; retryable: boolean; outsideAdmittedSurfaces: readonly string[] }>;

function diagnostic(failure: SubmissionFailure): Diagnostic {
  return Object.freeze({ code: failure.code, message: failure.message, actionable: failure.actionable !== false });
}

function supplied(failure: SubmissionFailure | undefined, fallback: SubmissionFailure): SubmissionFailure {
  return failure || fallback;
}

function outsideAdmittedSurfaces(surfaces: SubmissionSurfaces): string[] {
  return surfaces.changed.filter((surface) => !surfaces.admitted.some((admitted) => {
    const normalized = admitted.replace(/\\/g, '/').replace(/\/+$/, '');
    return surface === normalized || surface.startsWith(`${normalized}/`);
  }));
}

function sameSourceRevision(left: SourceRevision | undefined, right: SourceRevision | undefined): boolean {
  return Boolean(
    left
    && right
    && left.source === right.source
    && left.value === right.value
    && left.observedAt === right.observedAt
  );
}

function sameBaseline(left: Baseline | undefined, right: Baseline | null | undefined): boolean {
  return Boolean(
    left
    && right
    && left.purpose === right.purpose
    && sameSourceRevision(left.revision, right.revision)
  );
}

function baselineBoundToCandidate(facts: SubmissionAdmissionFacts): boolean {
  if (!facts.sourceBaseline) return true;
  return sameSourceRevision(facts.baseline.candidate, facts.candidate)
    && sameBaseline(facts.baseline.dispatchBaseline, facts.sourceBaseline);
}

export function decideSubmissionAdmission(facts: SubmissionAdmissionFacts): SubmissionDecision {
  const failures: SubmissionFailure[] = [];
  const { ticket, authority, completion, verification, candidate, baseline, surfaces, duplicate } = facts;
  const owner = authority.claimOwner || authority.submittedOwner;
  if (authority.terminal) {
    failures.push({ code: 'done', message: `submit: refused ${ticket.ref}; the ticket is already done.`, actionable: false, retryable: false });
  } else if (!owner || (!authority.claimOwner && !authority.allowSubmittedOwner)) {
    failures.push(supplied(authority.claimReleaseDiagnostic, { code: 'not_claimed', message: `submit: refused ${ticket.ref}; a held claim is required.`, retryable: true }));
  } else if (owner !== authority.authority.actor) {
    failures.push({ code: 'not_owner', message: `submit: refused ${ticket.ref}; not_owner: ${authority.authority.actor} does not own the candidate.`, retryable: false });
  }
  if (duplicate.identity) {
    failures.push(supplied(duplicate.diagnostic, { code: 'duplicate_submission', message: `submit: refused ${ticket.ref}; candidate ${duplicate.identity} is already submitted.`, retryable: false }));
  }
  if (!completion.complete) failures.push(supplied(completion.diagnostic, { code: 'incomplete', message: `submit: refused ${ticket.ref}; completion is not recorded.`, retryable: true }));
  if (!baselineBoundToCandidate(facts) || baseline.candidateExists == null || baseline.containsCandidate == null) {
    failures.push(supplied(baseline.diagnostic, { code: 'baseline_membership_unavailable', message: `submit: refused ${ticket.ref}; the project adapter did not return immutable existence and baseline-membership facts for ${candidate.source}:${candidate.value}. Refresh the adapter facts and resubmit the preserved candidate.`, retryable: true }));
  } else if (!baseline.candidateExists) {
    failures.push(supplied(baseline.diagnostic, { code: 'source_revision_missing', message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} does not exist in the project adapter.`, retryable: true }));
  } else if (!baseline.containsCandidate) {
    failures.push(supplied(baseline.diagnostic, { code: 'baseline_membership_mismatch', message: `submit: refused ${ticket.ref}; ${candidate.source}:${candidate.value} is outside the immutable project baseline.`, retryable: true }));
  }
  if (verification.result.status !== 'passed') {
    failures.push(supplied(verification.diagnostic, { code: 'invalid_verify', message: `submit: refused ${ticket.ref}; verification evidence is unavailable.`, retryable: true }));
  } else if (verification.expectedEvidence && verification.result.evidence !== verification.expectedEvidence) {
    failures.push({ code: 'executor_verify_mismatch', message: `submit: refused ${ticket.ref}; verification must match the declared executor verify command.`, retryable: true });
  }
  const outside = outsideAdmittedSurfaces(surfaces);
  if (outside.length) {
    failures.push(supplied(surfaces.diagnostic, { code: 'outside_scope', message: `submit: refused ${ticket.ref}; submitted surfaces are outside its declared scope: ${outside.join(', ')}. Request scope only for work this ticket owns. Commit only approved scope; never stash, revert, or include foreign paths.`, retryable: true }));
  }
  if (surfaces.pending.length) {
    failures.push({ code: 'dirty_scope', message: `submit: refused ${ticket.ref}; uncommitted changes fall inside this ticket's declared scope: ${surfaces.pending.join(', ')}. Commit these paths, or explain why they are deliberately excluded before resubmitting.`, retryable: true });
  }
  failures.push(...(facts.requirements || []));
  if (!failures.length) return Object.freeze({ ok: true, diagnostics: Object.freeze([]) as readonly [] });
  const diagnostics = Object.freeze(failures.map(diagnostic));
  return Object.freeze({ ok: false, diagnostics, retryable: failures.every((failure) => failure.retryable !== false), outsideAdmittedSurfaces: Object.freeze(outside) });
}
