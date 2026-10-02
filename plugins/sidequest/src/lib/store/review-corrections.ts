import type { ReviewCandidate, OracleVerdictOutcome, ReviewMirror } from '../kernel/review-binding';
import { sameReviewCandidate, reviewCandidateFromSubmission } from '../kernel/review-binding';

export type ReviewVerdictCorrection = Readonly<{
  from: 'accepted'; to: 'rejected'; verdictAt: string; sourceTicketId: string; sourceRef: string;
  candidate: ReviewCandidate; text: string; why: string; evidence: string; by: string;
  sessionId: string; at: string; commentId: string;
}>;
export type CorrectionInput = {
  by: string; sessionId: string; text: string; why?: string; evidence: string;
  expected: { outcome: 'accepted'; verdictAt: string; sourceRef: string; candidate: ReviewCandidate };
};
export type CorrectionComment = { id: string; by: string; body: string; kind: string; source: string; at: string };
export type CorrectionTicket = {
  id: string; ref: string; status: string; updatedAt?: string; category?: string | { id: string };
  claim?: { by?: string }; dispatchNonce?: string;
  dispatch?: { readonly?: boolean; executor?: string; terminalAt?: string; outcome?: string };
  completion?: { purpose?: string };
  reviewTarget?: ReviewMirror;
  oracle?: { verdict?: { outcome: OracleVerdictOutcome; at: string }; corrections?: ReviewVerdictCorrection[] };
  submission?: { commit?: string; sourceRevision?: ReviewCandidate; at?: string; integratedAt?: string; supersededBy?: string; review?: ReviewMirror };
  comments?: CorrectionComment[];
};
type Refusal = { ok: false; reason: string; message: string };
type CorrectionResult = Refusal | { ok: true; idempotent?: true; correction: ReviewVerdictCorrection; reviewOutcome: { sourceRef: string; outcome: 'rejected' } };
type Grant = { allowAcceptedReviewCorrection?: boolean };
type Relation = { conflict: boolean; side: string; reviewTicket: CorrectionTicket | null };
type Dependencies = {
  getTicket: (slug: string, ref: string) => CorrectionTicket | null;
  pendingSubmission: (ticket: CorrectionTicket) => boolean;
  isReadOnlyExecutor: (executor?: string) => boolean;
  submissionReviewRelation: (slug: string, ticket: CorrectionTicket) => Relation | null;
  withSourceTicketLock: (slug: string, id: string, callback: () => CorrectionResult, requireLock: boolean) => CorrectionResult;
  withTicketLock: (slug: string, id: string, callback: () => CorrectionResult) => CorrectionResult;
  createComment: (input: { by: string; body: string; kind: string; source: string }, at: string) => CorrectionComment;
  recordBoundReviewOutcome: (slug: string, ticket: CorrectionTicket, outcome: 'rejected', fields: { correctedAt: string }) => unknown;
  putTicket: (slug: string, ticket: CorrectionTicket) => void;
  invalidateStoreCaches: () => void;
};

function refuse(reason: string, message: string): Refusal {
  return { ok: false, reason, message };
}

function requiredCorrectionText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function correctionRequestRefusal(input: CorrectionInput, grant: Grant): Refusal | undefined {
  if (grant.allowAcceptedReviewCorrection !== true) return refuse('correction_unauthorized', 'Finalized review correction requires the main-thread MCP verdict grant.');
  if (!requiredCorrectionText(input.by)) return refuse('identity_required', 'Correction by is required for the audit.');
  if (!requiredCorrectionText(input.sessionId)) return refuse('identity_unavailable', 'Correction requires the actual runtime session.');
  return correctionEvidenceRefusal(input) || correctionExpectedOutcomeRefusal(input.expected);
}

function correctionEvidenceRefusal(input: CorrectionInput): Refusal | undefined {
  if (!requiredCorrectionText(input.text)) return refuse('invalid_correction', 'Correction text must be nonempty.');
  if (!requiredCorrectionText(input.evidence)) return refuse('evidence_required', 'Correction evidence must be nonempty.');
  if (input.why !== undefined && typeof input.why !== 'string') return refuse('invalid_correction', 'Correction why must be text.');
}

function correctionExpectedOutcomeRefusal(expected: CorrectionInput['expected']): Refusal | undefined {
  if (expected?.outcome !== 'accepted') return refuse('invalid_correction', 'Correction expects the original accepted verdict.');
}

function activeCorrectionDispatch(ticket: CorrectionTicket): boolean {
  if (ticket.dispatchNonce) return true;
  if (!ticket.dispatch) return false;
  return !ticket.dispatch.terminalAt;
}

function correctionReviewCategory(category: CorrectionTicket['category']): string | undefined {
  if (typeof category === 'string') return category;
  return category?.id;
}

function activeCorrectionTicket(ticket: CorrectionTicket): boolean {
  return Boolean(ticket.claim?.by) || activeCorrectionDispatch(ticket);
}

function finalizedReviewRefusal(ticket: CorrectionTicket, readonlyExecutor: boolean): Refusal | undefined {
  if (ticket.status === 'awaiting-oracle') return refuse('use_verdict', 'Use ordinary verdict for an awaiting-oracle review.');
  if (activeCorrectionTicket(ticket)) return refuse('review_active', 'A claimed or actively dispatched review cannot be corrected.');
  if (correctionReviewCategory(ticket.category) !== 'review-audit') return refuse('review_unbound', 'Correction requires a bound review-audit ticket.');
  return reviewFinalizationRefusal(ticket, readonlyExecutor);
}

function finalizedReviewBindingRefusal(ticket: CorrectionTicket): Refusal | undefined {
  const target = ticket.reviewTarget;
  if (!target || !target.ticketId) return refuse('review_unbound', 'Correction requires the original source binding.');
  if (!ticket.oracle?.verdict) return refuse('no_verdict', 'The original verdict is unavailable.');
}

function reviewFinalizationRefusal(ticket: CorrectionTicket, readonlyExecutor: boolean): Refusal | undefined {
  const bindingRefusal = finalizedReviewBindingRefusal(ticket);
  if (bindingRefusal) return bindingRefusal;
  if (ticket.status !== 'done') return refuse('review_nonfinalized', 'Correction requires a finalized review.');
  if (!readonlyExecutor) return refuse('review_nonreadonly', 'Correction requires a readonly review.');
}

function expectedVerdictRefusal(ticket: CorrectionTicket, expected: CorrectionInput['expected']): Refusal | undefined {
  const { oracle = {}, reviewTarget = {} } = ticket;
  const verdict = oracle.verdict;
  if (!verdict) return refuse('no_verdict', 'The original verdict is unavailable.');
  if (verdict.outcome !== 'accepted') return refuse('not_accepted', 'Only an original accepted verdict can be corrected.');
  const matches = [
    requiredCorrectionText(verdict.at), verdict.at === expected.verdictAt,
    reviewTarget.ref === expected.sourceRef,
    sameReviewCandidate(reviewTarget.candidate, expected.candidate),
  ];
  if (matches.includes(false)) return refuse('stale_expected', 'Read list({ref: reviewRef}).ticket.oracle.verdict.at and the exact original source/candidate before correcting.');
}

function sourceCorrectionRefusal(source: CorrectionTicket, pending: boolean): Refusal | undefined {
  if (activeCorrectionTicket(source)) return refuse('source_active', 'The original source is claimed or actively dispatched.');
  return sourceSubmissionRefusal(source.submission, pending);
}

function sourceSubmissionRefusal(submission: CorrectionTicket['submission'], pending: boolean): Refusal | undefined {
  if (!submission) return refuse('submission_required', 'Correction requires the original pending submission.');
  if (submission.integratedAt) return refuse('source_delivered', 'A delivered source cannot be corrected.');
  if (submission.supersededBy) return refuse('source_superseded', 'A superseded source cannot be corrected.');
  if (!pending) return refuse('submission_required', 'Correction requires the original pending submission.');
}

function correctionRelationRefusal(ticket: CorrectionTicket, relation: Relation | null): Refusal | undefined {
  if (!relation) return refuse('binding_mismatch', 'Correction requires a nonconflicting exact two-sided original review binding.');
  const identities = [relation.conflict === false, relation.side === 'both', relation.reviewTicket?.id === ticket.id];
  if (identities.includes(false)) return refuse('binding_mismatch', 'Correction requires a nonconflicting exact two-sided original review binding.');
}

function correctionBindingRefusal(ticket: CorrectionTicket, source: CorrectionTicket, relation: Relation | null): Refusal | undefined {
  const { reviewTarget = {} } = ticket;
  const { submission = {} } = source;
  const mirror = submission.review;
  if (!mirror) return refuse('binding_mismatch', 'Correction requires a nonconflicting exact two-sided original review binding.');
  const identities = [
    source.id === reviewTarget.ticketId, source.ref === reviewTarget.ref,
    mirror.ticketId === ticket.id, mirror.ref === ticket.ref,
    JSON.stringify(reviewCandidateFromSubmission(source.submission)) === JSON.stringify(reviewTarget.candidate),
    JSON.stringify(mirror.candidate) === JSON.stringify(reviewTarget.candidate),
    requiredCorrectionText(mirror.createdAt),
  ];
  if (identities.includes(false)) return refuse('binding_mismatch', 'Correction requires a nonconflicting exact two-sided original review binding.');
  return correctionRelationRefusal(ticket, relation);
}

function correctionRetryRefusal(previous: ReviewVerdictCorrection, count: number, source: CorrectionTicket, input: CorrectionInput): Refusal | undefined {
  if (!requiredCorrectionText(previous.at) || count !== 1) return refuse('binding_mismatch', 'The stored correction history is inconsistent.');
  const matching = [previous.verdictAt === input.expected.verdictAt, previous.sourceRef === input.expected.sourceRef,
    sameReviewCandidate(previous.candidate, input.expected.candidate), previous.text === input.text,
    previous.why === (input.why ?? ''), previous.evidence === input.evidence,
    previous.from === 'accepted', previous.to === 'rejected', previous.sourceTicketId === source.id];
  if (matching.includes(false)) return refuse('already_corrected', 'A different correction already exists for this verdict.');
}

function duplicateCorrectionRefusal(ticket: CorrectionTicket, source: CorrectionTicket, input: CorrectionInput): Refusal | undefined {
  const { oracle = {}, reviewTarget = {} } = ticket;
  const { corrections = [] } = oracle;
  const { submission = {} } = source;
  const { review: mirror = {} } = submission;
  const previous = corrections.at(-1);
  const outcome = previous ? 'rejected' : 'accepted';
  const correctedAt = previous?.at;
  const matching = [reviewTarget.outcome === outcome, mirror.outcome === outcome,
    reviewTarget.correctedAt === correctedAt, mirror.correctedAt === correctedAt];
  if (matching.includes(false)) return refuse('binding_mismatch', 'Both binding halves must match the effective verdict and stored correction timestamp.');
  if (previous) return correctionRetryRefusal(previous, corrections.length, source, input);
}

export function createReviewCorrections(dependencies: Dependencies) {
  function correctUnderLocks(slug: string, reviewId: string, input: CorrectionInput): CorrectionResult {
    dependencies.invalidateStoreCaches();
    const ticket = dependencies.getTicket(slug, reviewId);
    if (!ticket) return refuse('not_found', 'Review ticket not found.');
    const dispatch = ticket.dispatch ?? {};
    const readonlyExecutor = [dispatch.readonly === true, dependencies.isReadOnlyExecutor(dispatch.executor)].includes(true);
    const reviewRefusal = finalizedReviewRefusal(ticket, readonlyExecutor) || expectedVerdictRefusal(ticket, input.expected);
    if (reviewRefusal) return reviewRefusal;
    return correctSource(slug, ticket, input);
  }

  function sourceBindingRefusal(slug: string, ticket: CorrectionTicket, source: CorrectionTicket): Refusal | undefined {
    return sourceCorrectionRefusal(source, dependencies.pendingSubmission(source))
      || correctionBindingRefusal(ticket, source, dependencies.submissionReviewRelation(slug, source));
  }

  function correctSource(slug: string, ticket: CorrectionTicket, input: CorrectionInput): CorrectionResult {
    const source = dependencies.getTicket(slug, input.expected.sourceRef);
    if (!source) return refuse('source_unavailable', 'The original source ticket is unavailable.');
    const sourceRefusal = sourceBindingRefusal(slug, ticket, source) || duplicateCorrectionRefusal(ticket, source, input);
    if (sourceRefusal) return sourceRefusal;
    const { oracle = {} } = ticket;
    const { corrections = [] } = oracle;
    const previous = corrections.at(-1);
    if (previous) return { ok: true, idempotent: true, correction: previous, reviewOutcome: { sourceRef: source.ref, outcome: 'rejected' } };
    return appendCorrection(slug, ticket, source, input);
  }

  function appendCorrection(slug: string, ticket: CorrectionTicket, source: CorrectionTicket, input: CorrectionInput): CorrectionResult {
    const { reviewTarget = {}, oracle = {}, comments = [] } = ticket;
    const { corrections = [] } = oracle;
    const at = new Date().toISOString();
    const comment = dependencies.createComment({ by: input.by, body: `Oracle verdict correction (accepted -> rejected): ${input.text}`, kind: 'comment', source: 'mcp' }, at);
    const correction: ReviewVerdictCorrection = {
      from: 'accepted', to: 'rejected', verdictAt: input.expected.verdictAt, sourceTicketId: source.id,
      sourceRef: source.ref, candidate: reviewTarget.candidate ?? input.expected.candidate, text: input.text, why: input.why ?? '',
      evidence: input.evidence, by: input.by, sessionId: input.sessionId, at, commentId: comment.id,
    };
    ticket.oracle = { ...oracle, corrections: [...corrections, correction] };
    ticket.comments = [...comments, comment];
    dependencies.recordBoundReviewOutcome(slug, ticket, 'rejected', { correctedAt: at });
    ticket.updatedAt = at;
    dependencies.putTicket(slug, ticket);
    return { ok: true, correction, reviewOutcome: { sourceRef: source.ref, outcome: 'rejected' } };
  }

  function correctAcceptedReviewVerdict(slug: string, idOrRef: string, input: CorrectionInput, grant: Grant = {}): CorrectionResult {
    const requestRefusal = correctionRequestRefusal(input, grant);
    if (requestRefusal) return requestRefusal;
    const found = dependencies.getTicket(slug, idOrRef);
    if (!found) return refuse('not_found', 'Review ticket not found.');
    if (!found.reviewTarget?.ticketId) return refuse('review_unbound', 'Correction requires the original source binding.');
    try {
      return dependencies.withSourceTicketLock(slug, found.reviewTarget.ticketId,
        () => dependencies.withTicketLock(slug, found.id, () => correctUnderLocks(slug, found.id, input)), true);
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { correctAcceptedReviewVerdict };
}
