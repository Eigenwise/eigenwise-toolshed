import type { CorrectionInput } from './store/review-corrections';
import type { ReviewCandidate } from './kernel/review-binding';
import { isReviewCommit } from './kernel/review-binding';

const store = require('./store');
type Request = {
  ref: string; outcome: string; by: string; text: string; why?: string; constraint?: unknown;
  correct: unknown;
};

function correctionObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyCorrectionText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function correctionRevision(value: unknown): ReviewCandidate | null {
  if (!correctionObject(value)) return null;
  if (!nonemptyCorrectionText(value.source) || !nonemptyCorrectionText(value.value)) return null;
  return { source: value.source, value: value.value };
}

function correctionMetadata(correct: Record<string, unknown>): correct is Record<string, unknown> & {
  expectedVerdictAt: string; sourceRef: string; evidence: string;
} {
  return typeof correct.expectedVerdictAt === 'string'
    && typeof correct.sourceRef === 'string' && typeof correct.evidence === 'string';
}

function correctionCandidate(correct: Record<string, unknown>): ReviewCandidate | null {
  if (Object.hasOwn(correct, 'commit') === Object.hasOwn(correct, 'sourceRevision')) return null;
  if (!Object.hasOwn(correct, 'commit')) return correctionRevision(correct.sourceRevision);
  if (typeof correct.commit !== 'string' || !isReviewCommit(correct.commit)) return null;
  return { source: 'git', value: correct.commit.trim().toLowerCase() };
}

export function correctReviewVerdict(slug: string, args: Request, sessionId: string | null) {
  if (args.outcome !== 'rejected' || args.constraint !== undefined) return { ok: false, reason: 'invalid_correction', message: 'Correction requires outcome rejected and accepts why, not constraint.' };
  const correct = args.correct;
  if (!correctionObject(correct)) return { ok: false, reason: 'invalid_correction', message: 'Correction requires its exact original verdict/source/candidate and evidence.' };
  return correctValidatedRequest(slug, args, correct, sessionId);
}

function correctValidatedRequest(slug: string, args: Request, correct: Record<string, unknown>, sessionId: string | null) {
  if (correct.expectedOutcome !== 'accepted') return { ok: false, reason: 'invalid_correction', message: 'Correction expects the original accepted verdict.' };
  if (!correctionMetadata(correct)) return { ok: false, reason: 'invalid_correction', message: 'Correction expectedVerdictAt, sourceRef and evidence must be text.' };
  const candidate = correctionCandidate(correct);
  if (!candidate) return { ok: false, reason: 'invalid_correction', message: 'Correction requires exactly one valid commit or sourceRevision.' };
  const input: CorrectionInput = {
    by: args.by, sessionId: sessionId ?? '', text: args.text, why: args.why, evidence: correct.evidence,
    expected: { outcome: correct.expectedOutcome, verdictAt: correct.expectedVerdictAt, sourceRef: correct.sourceRef, candidate },
  };
  return store.correctAcceptedReviewVerdict(slug, args.ref, input, { allowAcceptedReviewCorrection: true });
}
