'use strict';

export type ReviewCandidate = Readonly<{ source: string; value: string; observedAt?: string }>;
export type ReviewOutcome = 'planned' | 'accepted' | 'rejected' | 'inconclusive';
export type OracleVerdictOutcome = 'accepted' | 'rejected' | 'inconclusive';

export type ReviewMirror = Readonly<{
  ticketId?: string;
  ref?: string;
  candidate?: ReviewCandidate;
  createdAt?: string;
  outcome?: ReviewOutcome;
}>;

// Which half of the binding survived. A candidate written before this store
// enforced the pair, or one recovered from a half-applied legacy write, shows
// up as one side only; both directions still lock the source candidate.
export type ReviewBindingSide = 'both' | 'target-only' | 'mirror-only';

export type ReviewRelation = Readonly<{
  candidate: ReviewCandidate | null;
  reviewTicket: any;
  reviewTarget: any;
  mirror: ReviewMirror | null;
  conflict: boolean;
  side: ReviewBindingSide;
}>;

const REVIEW_COMMIT_RE = /^[0-9a-f]{7,64}$/i;

export function isReviewCommit(value?: unknown): boolean {
  return REVIEW_COMMIT_RE.test(String(value || '').trim());
}

export function reviewCandidateFromSubmission(submission?: any): ReviewCandidate | null {
  const revision = submission?.sourceRevision;
  if (revision?.source && revision.value) {
    return Object.freeze({
      source: String(revision.source),
      value: String(revision.value),
      observedAt: String(revision.observedAt || submission.at || ''),
    });
  }
  const commit = String(submission?.commit || '').trim().toLowerCase();
  if (!isReviewCommit(commit)) return null;
  return Object.freeze({ source: 'git', value: commit, observedAt: String(submission?.at || '') });
}

export function sameReviewCandidate(left?: any, right?: any): boolean {
  return Boolean(
    left?.source && right?.source
    && String(left.source) === String(right.source)
    && String(left.value) === String(right.value),
  );
}

function addressesSource(reviewTicket: any, sourceTicket: any): boolean {
  const target = reviewTicket?.reviewTarget;
  if (!target || reviewTicket.id === sourceTicket.id) return false;
  if (target.ticketId) return target.ticketId === sourceTicket.id;
  return String(target.ref || '').toUpperCase() === String(sourceTicket.ref || '').toUpperCase();
}

function namedMirror(mirror?: any): ReviewMirror | null {
  return mirror && (mirror.ticketId || mirror.ref) ? mirror as ReviewMirror : null;
}

// The one authoritative answer to "is this source candidate already bound to a
// review?". Deliberately presence-based, not match-based: a half-written or
// mismatched binding still counts, so every mutation guard fails closed instead
// of treating damaged state as unbound.
export function reviewRelationFor(
  sourceTicket: any,
  tickets: readonly any[],
  resolveTicket: (idOrRef: string) => any,
): ReviewRelation | null {
  if (!sourceTicket?.id) return null;
  const candidate = reviewCandidateFromSubmission(sourceTicket.submission);
  const mirror = namedMirror(sourceTicket.submission?.review);
  const addressed = (tickets || [])
    .filter((ticket: any) => addressesSource(ticket, sourceTicket))
    .sort((left: any, right: any) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.id || '').localeCompare(String(right.id || '')));
  if (addressed.length) {
    const reviewTicket = addressed[0];
    return Object.freeze({
      candidate: candidate || reviewTicket.reviewTarget?.candidate || null,
      reviewTicket,
      reviewTarget: reviewTicket.reviewTarget,
      mirror,
      conflict: addressed.length > 1,
      side: (mirror ? 'both' : 'target-only') as ReviewBindingSide,
    });
  }
  if (!mirror) return null;
  const reviewTicket = resolveTicket(String(mirror.ticketId || mirror.ref)) || null;
  return Object.freeze({
    candidate: candidate || mirror.candidate || null,
    reviewTicket,
    reviewTarget: reviewTicket?.reviewTarget || null,
    mirror,
    conflict: false,
    side: 'mirror-only' as ReviewBindingSide,
  });
}

export type ReviewProvenanceAttempt = Readonly<{ agentId: string; terminalAt: string; outcome: string }>;

export type ReviewProvenanceReason =
  | 'ok'
  | 'source_attempt_missing'
  | 'review_attempt_missing'
  | 'agent_identity_missing'
  | 'shared_agent_identity';

export type ReviewProvenance = Readonly<{
  source: ReviewProvenanceAttempt | null;
  reviewer: ReviewProvenanceAttempt | null;
  reason: ReviewProvenanceReason;
}>;

function terminalAttempts(ticket?: any): readonly any[] {
  const attempts = ticket?.dispatch?.attempts;
  return Array.isArray(attempts) ? attempts.filter((attempt: any) => attempt && attempt.terminalAt) : [];
}

function latestAttempt(attempts: readonly any[]): any {
  return attempts
    .slice()
    .sort((left: any, right: any) => String(left.terminalAt).localeCompare(String(right.terminalAt)))
    .pop() || null;
}

function identifiedAttempt(attempt?: any): ReviewProvenanceAttempt | null {
  const agentId = String(attempt?.agentId || '').trim();
  if (!agentId) return null;
  return Object.freeze({ agentId, terminalAt: String(attempt.terminalAt), outcome: String(attempt.outcome || '') });
}

// The live dispatch record is mutable: preparing a later attempt overwrites its
// agent id, outcome, and terminalAt in place, so anything read from it can be
// replaced after the fact. Only the appended terminal attempt snapshots are
// immutable, so provenance is selected from those and nothing else.
export function submittedCandidateAttempt(sourceTicket?: any): any {
  const commit = String(sourceTicket?.submission?.commit || '').trim().toLowerCase();
  if (!commit) return null;
  return latestAttempt(terminalAttempts(sourceTicket).filter((attempt: any) => String(attempt.outcome) === 'submitted'
    && String(attempt.commit || '').trim().toLowerCase() === commit));
}

export function completedReviewAttempt(reviewTicket?: any): any {
  const acceptedOracleCompletion = reviewTicket?.completion?.purpose === 'oracle-review-verdict';
  return latestAttempt(terminalAttempts(reviewTicket).filter((attempt: any) => String(attempt.outcome) === 'done'
    || (acceptedOracleCompletion && String(attempt.outcome) === 'released')));
}

export function reviewProvenance(sourceTicket?: any, reviewTicket?: any): ReviewProvenance {
  const sourceAttempt = submittedCandidateAttempt(sourceTicket);
  if (!sourceAttempt) return Object.freeze({ source: null, reviewer: null, reason: 'source_attempt_missing' as ReviewProvenanceReason });
  const reviewerAttempt = completedReviewAttempt(reviewTicket);
  if (!reviewerAttempt) return Object.freeze({ source: null, reviewer: null, reason: 'review_attempt_missing' as ReviewProvenanceReason });
  const source = identifiedAttempt(sourceAttempt);
  const reviewer = identifiedAttempt(reviewerAttempt);
  if (!source || !reviewer) return Object.freeze({ source, reviewer, reason: 'agent_identity_missing' as ReviewProvenanceReason });
  if (source.agentId === reviewer.agentId) return Object.freeze({ source, reviewer, reason: 'shared_agent_identity' as ReviewProvenanceReason });
  return Object.freeze({ source, reviewer, reason: 'ok' as ReviewProvenanceReason });
}

export function reviewRelationRef(relation?: ReviewRelation | null): string {
  return relation?.reviewTicket?.ref || relation?.mirror?.ref || 'a candidate review';
}

export function reviewOutcomeFromOracleVerdict(outcome: OracleVerdictOutcome): ReviewOutcome {
  return outcome;
}

export function reviewRelationOutcome(relation?: ReviewRelation | null): string {
  return String(relation?.mirror?.outcome || relation?.reviewTarget?.outcome || 'planned');
}

export function reviewLockMessage(operation: string, ticket: any, relation: ReviewRelation): string {
  const candidate = relation.candidate?.value || 'its candidate';
  return `${operation}: refused ${ticket?.ref}; candidate ${candidate} is bound to ${reviewRelationRef(relation)}`
    + ' and cannot be changed. Repair requires a fresh ticket, attempt, candidate, and review identity.'
    + ' A failed review records its evidence on the review ticket and releases it for an external oracle;'
    + ' an oracle-confirmed defect records the candidate rejection, and only an integrated repair may supersede it.';
}
