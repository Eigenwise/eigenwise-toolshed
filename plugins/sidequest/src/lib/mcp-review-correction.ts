import type { CorrectionInput } from './store/review-corrections';
import type { ReviewCandidate } from './kernel/review-binding';
import { isReviewCommit } from './kernel/review-binding';

const store = require('./store');
type Request = {
  ref: string; outcome: string; by: string; text: string; why?: string;
  correct: { expectedOutcome: 'accepted'; expectedVerdictAt: string; sourceRef: string;
    commit?: string; sourceRevision?: ReviewCandidate; evidence: string };
};

function correctionCandidate(correct: Request['correct']): ReviewCandidate | null {
  if (Boolean(correct.commit) === Boolean(correct.sourceRevision)) return null;
  if (correct.commit) return isReviewCommit(correct.commit) ? { source: 'git', value: correct.commit.toLowerCase() } : null;
  const revision = correct.sourceRevision;
  if (typeof revision?.source !== 'string' || typeof revision.value !== 'string') return null;
  return revision.source.trim() && revision.value.trim() ? { source: revision.source, value: revision.value } : null;
}

export function correctReviewVerdict(slug: string, args: Request, sessionId: string | null) {
  if (args.outcome !== 'rejected') return { ok: false, reason: 'invalid_correction', message: 'Correction requires outcome rejected.' };
  if (!args.correct || typeof args.correct !== 'object') return { ok: false, reason: 'invalid_correction', message: 'Correction requires its exact original verdict/source/candidate and evidence.' };
  const candidate = correctionCandidate(args.correct);
  if (!candidate) return { ok: false, reason: 'invalid_correction', message: 'Correction requires exactly one valid commit or sourceRevision.' };
  const input: CorrectionInput = {
    by: args.by, sessionId: sessionId ?? '', text: args.text, why: args.why, evidence: args.correct.evidence,
    expected: { outcome: args.correct.expectedOutcome, verdictAt: args.correct.expectedVerdictAt, sourceRef: args.correct.sourceRef, candidate },
  };
  return store.correctAcceptedReviewVerdict(slug, args.ref, input, { allowAcceptedReviewCorrection: true });
}
