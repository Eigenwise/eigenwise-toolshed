import { reviewProvenance, reviewVerdictHistory, sameReviewCandidate } from '../kernel/review-binding';
import type { ReviewCandidate } from '../kernel/review-binding';
import { activeCorrectionTicket, correctionReviewCategory, sourceCorrectionRefusal, correctionBindingRefusal } from './review-corrections';
import type { CorrectionTicket, CorrectionComment, Refusal, Relation } from './review-corrections';

export type ReviewDecision = Readonly<{
  outcome: 'accepted' | 'rejected'; text: string; evidence: string; by: string; sessionId: string;
  sourceRef: string; candidate: ReviewCandidate; at: string; commentId: string;
}>;
export type FinalizationInput = {
  by: string; sessionId: string; text: string; evidence: string; outcome: 'accepted' | 'rejected';
  expected: { sourceRef: string; candidate: ReviewCandidate };
};
type FinalizationTicket = CorrectionTicket & {
  completion?: { purpose?: string; state?: string; key?: string; at?: string };
  reviewDecision?: { verdict: ReviewDecision };
};
type Result = Refusal | { ok: true; idempotent?: true; decision: ReviewDecision; reviewOutcome: { sourceRef: string; outcome: 'accepted' | 'rejected' } };
type LockedResult = Result | { ok: false; reason: 'busy' };
type Dependencies = {
  getTicket: (slug: string, ref: string) => FinalizationTicket | null;
  pendingSubmission: (ticket: CorrectionTicket) => boolean;
  submissionReviewRelation: (slug: string, ticket: CorrectionTicket) => Relation | null;
  withSourceTicketLock: (slug: string, id: string, callback: () => LockedResult, requireLock: boolean) => LockedResult;
  withTicketLock: (slug: string, id: string, callback: () => Result) => LockedResult;
  createComment: (input: { by: string; body: string; kind: string; source: string }, at: string) => CorrectionComment;
  recordBoundReviewOutcome: (slug: string, ticket: CorrectionTicket, outcome: 'accepted' | 'rejected') => unknown;
  putTicket: (slug: string, ticket: CorrectionTicket) => void;
  invalidateStoreCaches: () => void;
};

function refuse(reason: string, message: string): Refusal {
  return { ok: false, reason, message };
}

function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function requestRefusal(input: FinalizationInput, granted: boolean): Refusal | undefined {
  if (!granted) return refuse('finalization_unauthorized', 'Completed review finalization requires the main-thread MCP verdict grant. by is an audit label only.');
  if (!nonemptyText(input.sessionId)) return refuse('identity_unavailable', 'Finalization requires the actual runtime session.');
  return decisionEvidenceRefusal(input) || expectedSourceRefusal(input.expected);
}

function decisionEvidenceRefusal(input: FinalizationInput): Refusal | undefined {
  if (!['accepted', 'rejected'].includes(input.outcome)) return refuse('invalid_finalization', 'Completed review finalization requires explicit accepted or rejected.');
  if (![input.by, input.text, input.evidence].every(nonemptyText)) return refuse('evidence_required', 'Finalization requires nonempty by, text and evidence.');
}

function expectedSourceRefusal(expected: FinalizationInput['expected']): Refusal | undefined {
  if (!expected) return refuse('invalid_finalization', 'Finalization requires the exact source and candidate.');
  if (![expected.sourceRef, expected.candidate?.source, expected.candidate?.value].every(nonemptyText)) return refuse('invalid_finalization', 'Finalization requires the exact source and candidate.');
}

function completedNormalReviewRefusal(review: FinalizationTicket): Refusal | undefined {
  if (review.oracle) return refuse('use_verdict', 'Use the separate oracle verdict lifecycle for an experimental review.');
  if (activeCorrectionTicket(review)) return refuse('review_active', 'A claimed or actively dispatched review cannot be finalized.');
  if (correctionReviewCategory(review.category) !== 'review-audit') return refuse('review_unbound', 'Finalization requires a bound review-audit ticket.');
  return completionRefusal(review);
}

function completionRefusal(review: FinalizationTicket): Refusal | undefined {
  const completion = review.completion ?? {};
  const completed = [review.status === 'done', review.dispatch?.outcome === 'done', nonemptyText(review.dispatch?.terminalAt),
    completion.state === 'done', nonemptyText(completion.key), nonemptyText(completion.at)];
  if (completed.includes(false)) return refuse('review_nonfinalized', 'Finalization requires the original terminal done review completion.');
  if (!review.reviewTarget?.ticketId) return refuse('review_unbound', 'Finalization requires the original source binding.');
}

function expectedBindingRefusal(review: FinalizationTicket, input: FinalizationInput): Refusal | undefined {
  const target = review.reviewTarget ?? {};
  const matching = [target.ref === input.expected.sourceRef, sameReviewCandidate(target.candidate, input.expected.candidate)];
  if (matching.includes(false)) return refuse('stale_expected', 'Read the exact original reviewTarget source/candidate before finalizing.');
}

function independentReviewRefusal(source: CorrectionTicket, review: FinalizationTicket): Refusal | undefined {
  const provenance = reviewProvenance(source, review);
  if (provenance.reason !== 'ok') return refuse(provenance.reason, 'Finalization requires distinct immutable submitted-source and completed-review runtime provenance.');
  const current = [source.dispatch?.outcome === 'submitted', source.dispatch?.terminalAt === provenance.source?.terminalAt,
    review.dispatch?.terminalAt === provenance.reviewer?.terminalAt];
  if (current.includes(false)) return refuse('stale_provenance', 'Finalization requires the current original submitted-source and completed-review generations.');
}

function decisionRetryRefusal(review: FinalizationTicket, source: CorrectionTicket, input: FinalizationInput): Refusal | undefined {
  const history = reviewVerdictHistory(review);
  const previous = history?.verdict;
  const effective = history?.corrections?.at(-1)?.to ?? previous?.outcome ?? 'planned';
  const matching = [review.reviewTarget?.outcome === effective, source.submission?.review?.outcome === effective];
  if (matching.includes(false)) return refuse('binding_mismatch', 'Both binding halves must match the recorded decision.');
  if (previous && [!history?.corrections?.length,
    JSON.stringify(previous) === JSON.stringify({ ...previous, outcome: input.outcome, text: input.text, evidence: input.evidence })].includes(false)) {
    return refuse('already_finalized', 'A different decision already exists. Use the native accepted-to-rejected correction path for a mistaken approval; repair requires a fresh candidate.');
  }
}

export function createReviewFinalization(dependencies: Dependencies) {
  function finalizeUnderLocks(slug: string, reviewId: string, input: FinalizationInput): Result {
    dependencies.invalidateStoreCaches();
    const review = dependencies.getTicket(slug, reviewId);
    if (!review) return refuse('not_found', 'Review ticket not found.');
    const reviewRefusal = completedNormalReviewRefusal(review) || expectedBindingRefusal(review, input);
    if (reviewRefusal) return reviewRefusal;
    return finalizeSource(slug, review, input);
  }

  function sourceRefusal(slug: string, review: FinalizationTicket, source: FinalizationTicket): Refusal | undefined {
    return sourceCorrectionRefusal(source, dependencies.pendingSubmission(source))
      || correctionBindingRefusal(review, source, dependencies.submissionReviewRelation(slug, source))
      || independentReviewRefusal(source, review);
  }

  function finalizeSource(slug: string, review: FinalizationTicket, input: FinalizationInput): Result {
    const source = dependencies.getTicket(slug, input.expected.sourceRef);
    if (!source) return refuse('source_unavailable', 'The original source ticket is unavailable.');
    const invalid = sourceRefusal(slug, review, source) || decisionRetryRefusal(review, source, input);
    if (invalid) return invalid;
    const previous = review.reviewDecision?.verdict;
    if (previous) return { ok: true, idempotent: true, decision: previous, reviewOutcome: { sourceRef: source.ref, outcome: previous.outcome } };
    return recordDecision(slug, review, source, input);
  }

  function recordDecision(slug: string, review: FinalizationTicket, source: FinalizationTicket, input: FinalizationInput): Result {
    const at = new Date().toISOString();
    const comment = dependencies.createComment({ by: input.by, body: `Completed review decision (${input.outcome}): ${input.text}`, kind: 'comment', source: 'mcp' }, at);
    const decision: ReviewDecision = { outcome: input.outcome, text: input.text, evidence: input.evidence, by: input.by,
      sessionId: input.sessionId, sourceRef: source.ref, candidate: { ...review.reviewTarget!.candidate! }, at, commentId: comment.id };
    review.reviewDecision = { verdict: decision };
    review.comments = [...(review.comments ?? []), comment];
    dependencies.recordBoundReviewOutcome(slug, review, input.outcome);
    review.updatedAt = at;
    dependencies.putTicket(slug, review);
    return { ok: true, decision, reviewOutcome: { sourceRef: source.ref, outcome: input.outcome } };
  }

  function finalizeCompletedReview(slug: string, idOrRef: string, input: FinalizationInput, grant: { allowCompletedReviewFinalization?: boolean } = {}): LockedResult {
    const invalid = requestRefusal(input, grant.allowCompletedReviewFinalization === true);
    if (invalid) return invalid;
    const review = dependencies.getTicket(slug, idOrRef);
    if (!review) return refuse('not_found', 'Review ticket not found.');
    if (!review.reviewTarget?.ticketId) return refuse('review_unbound', 'Finalization requires the original source binding.');
    try {
      return dependencies.withSourceTicketLock(slug, review.reviewTarget.ticketId,
        () => dependencies.withTicketLock(slug, review.id, () => finalizeUnderLocks(slug, review.id, input)), true);
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { finalizeCompletedReview };
}
