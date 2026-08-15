'use strict';

export type ReviewCandidate = Readonly<{ source: string; value: string; observedAt?: string }>;

export type ReviewMirror = Readonly<{
  ticketId?: string;
  ref?: string;
  candidate?: ReviewCandidate;
  createdAt?: string;
  outcome?: string;
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

export function reviewRelationRef(relation?: ReviewRelation | null): string {
  return relation?.reviewTicket?.ref || relation?.mirror?.ref || 'a candidate review';
}

export function reviewRelationOutcome(relation?: ReviewRelation | null): string {
  return String(relation?.mirror?.outcome || relation?.reviewTarget?.outcome || 'planned');
}

export function reviewLockMessage(operation: string, ticket: any, relation: ReviewRelation): string {
  const candidate = relation.candidate?.value || 'its candidate';
  return `${operation}: refused ${ticket?.ref}; candidate ${candidate} is bound to ${reviewRelationRef(relation)}`
    + ' and cannot be changed. Repair requires a fresh ticket, attempt, candidate, and review identity.';
}
