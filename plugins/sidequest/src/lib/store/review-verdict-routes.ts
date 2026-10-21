import type { ReviewCandidate, ReviewMirror, OracleVerdictOutcome } from '../kernel/review-binding';

// Every refusal on the verdict surface names the one shape that records this ticket's outcome.
// The refusals used to point at each other: plain verdict sent a done review to finalize, and
// finalize sent an oracle review back to plain verdict (SQ-3840).
export type RoutedTicket = {
  ref: string; status: string;
  oracle?: { round?: number; verdict?: { outcome: OracleVerdictOutcome } };
  reviewTarget?: ReviewMirror;
  submission?: { review?: ReviewMirror };
};
export type RouteRefusal = { ok: false; reason: string; message: string };

function refuse(reason: string, message: string): RouteRefusal {
  return { ok: false, reason, message };
}

function candidateField(candidate?: ReviewCandidate): string {
  if (!candidate) return 'commit: "<reviewTarget candidate>" (or sourceRevision: {source, value})';
  if (candidate.source === 'git') return `commit: "${candidate.value}"`;
  return `sourceRevision: {source: "${candidate.source}", value: "${candidate.value}"}`;
}

export function finalizeShape(reviewRef = '<review ref>', sourceRef = '<reviewed source ref>', candidate?: ReviewCandidate): string {
  return `verdict {ref: "${reviewRef}", outcome: "accepted"|"rejected", by, text, finalize: {sourceRef: "${sourceRef}", ${candidateField(candidate)}, evidence}}`;
}

function plainVerdictShape(ref: string): string {
  return `verdict {ref: "${ref}", outcome, by, text} without finalize`;
}

function reviewedSourceMirror(ticket: RoutedTicket): ReviewMirror | null {
  if (ticket.reviewTarget) return null;
  const { review: mirror = {} } = ticket.submission ?? {};
  return [mirror.ticketId, mirror.ref].every(Boolean) ? mirror : null;
}

function openOracleRoundRefusal(ref: string, status: string, round: number): RouteRefusal {
  if (status === 'awaiting-oracle') return refuse('use_verdict', `${ref} is awaiting its oracle verdict: record it with ${plainVerdictShape(ref)}.`);
  if (status === 'done') {
    return refuse('oracle_round_closed', `${ref} was closed while oracle round ${round} still awaited its verdict, so neither plain verdict nor finalize can record it as is. Reopen it with update {ref: "${ref}", status: "awaiting-oracle"}, then record the outcome with ${plainVerdictShape(ref)}.`);
  }
  return refuse('use_verdict', `${ref} has oracle round ${round} in progress; its outcome comes from ${plainVerdictShape(ref)} once it is released with kind oracle, never from finalize.`);
}

export function oracleRoundRefusal(review: RoutedTicket): RouteRefusal | undefined {
  const { oracle } = review;
  if (!oracle) return;
  if (oracle.verdict) {
    return refuse('use_verdict', `${review.ref} already carries oracle verdict ${oracle.verdict.outcome}, so finalize does not apply. A mistaken accepted takes verdict with correct; a rejected candidate needs a fresh repair ticket.`);
  }
  return openOracleRoundRefusal(review.ref, review.status, oracle.round ?? 1);
}

// The next shape for a review, as the first refusal should name it.
function reviewVerdictRoute(review: RoutedTicket): string {
  const oracleRefusal = oracleRoundRefusal(review);
  if (oracleRefusal) return oracleRefusal.message;
  const { reviewTarget: target = {} } = review;
  return `Once that review is done, finalize it with ${finalizeShape(review.ref, target.ref, target.candidate)}.`;
}

export function reviewedSourceRefusal(source: RoutedTicket, review: RoutedTicket | null): RouteRefusal | undefined {
  const mirror = reviewedSourceMirror(source);
  if (!mirror) return;
  const route = review ? ` ${reviewVerdictRoute(review)}` : '';
  return refuse('review_ref_required', `${source.ref} is the reviewed source, not the review: verdict takes its bound review ${mirror.ref} as ref, and ${source.ref} only appears as finalize.sourceRef.${route}`);
}

export function pendingOracleVerdictRefusal(ticket: RoutedTicket | null): RouteRefusal | undefined {
  if (!ticket) return;
  const pending = [ticket.status === 'awaiting-oracle', Boolean(ticket.oracle), !ticket.oracle?.verdict, Boolean(ticket.reviewTarget?.ticketId)];
  if (pending.includes(false)) return;
  return refuse('oracle_verdict_pending', `${ticket.ref} is a bound review still awaiting its oracle verdict; closing it now leaves the review outcome unrecorded and the verdict unreachable. Record it first with verdict {ref: "${ticket.ref}", outcome: "accepted"|"rejected"|"inconclusive", by, text}: an accepted readonly review closes itself, any other outcome returns it to todo for groomClose.`);
}
