import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ticketCommitScope, ticketReleaseFragment, validateCommitRangeScope, validateRelativeScopes } from '../commit-scope';
import { stillSpawnsInsideItsWrite } from '../db';
import { effectiveOracleVerdictOutcome, sameReviewCandidate } from '../kernel/review-binding';
import { canonicalPath, checkoutInstanceIdentity } from '../kernel/worktree';
import type { ReviewBindingSide, ReviewMirror, ReviewOutcome, OracleVerdictOutcome } from '../kernel/review-binding';
import type { ReviewVerdictCorrection } from './review-corrections';
import { proveCompositionRange } from './composition-range';
import type { CompositionSourceRange, CompositionRefusal } from './composition-range';
const { contextRevision } = require('../context-packet');

export type CompositionSourceInput = Readonly<{ ref: string; commit: string; submittedAt: string }>;
export type CompositionSourceExpected = Readonly<{
  ref: string; reviewTicketId: string | null; reviewOutcome: ReviewOutcome | null;
  correctedAt: string | null; snapshot: string;
}>;
export type CompositionExpected = Readonly<{
  attemptCount: number; releasedAt: string; preparedAt: string;
  sources: readonly CompositionSourceExpected[];
}>;
export type CompositionAdmissionInput = Readonly<{
  authority: 'main-attestation'; historicalCheckout: false; by: string; evidence: string;
  candidate: string; base: string; ownCommits: readonly string[]; ownPaths: readonly string[];
  sources: readonly CompositionSourceInput[]; expected?: CompositionExpected;
}>;
export type CompositionConsumption = Readonly<{ attempt: number; preparedAt: string; nonceDigest: string }>;
export type CompositionAdmission = CompositionAdmissionInput & Readonly<{
  id: string; at: string; sessionId: string; commentId: string; expected: CompositionExpected;
  sourceRanges: readonly CompositionSourceRange[]; originalRootScope: readonly string[];
  releasedDispatch: CompositionDispatch; consumedBy: CompositionConsumption | null;
}>;
export type CompositionDispatch = {
  preparedAt?: string; terminalAt?: string | null; outcome?: string; baseCommit?: string;
  sharedTree?: boolean; attempts?: readonly CompositionDispatch[];
  declaredFiles?: readonly string[]; sanctionedCommits?: readonly string[]; commit?: string;
  worktree?: string; worktreeGitDirectory?: string; worktreeCheckoutInstance?: string;
  compositionAdmission?: { id: string; checkoutCommit: string; rangeBase: string; nonceDigest: string };
};
export type CompositionSubmission = {
  commit?: string; at?: string; base?: string; commits?: readonly string[]; admittedScope?: readonly string[];
  integratedAt?: string; supersededBy?: string; review?: ReviewMirror;
  [field: string]: unknown;
};
export type CompositionTicket = {
  id: string; ref: string; status: string; files?: readonly string[];
  claim?: { by?: string } | null; dispatchNonce?: string | null; dispatch?: CompositionDispatch;
  submission?: CompositionSubmission | null; links?: readonly { type: string; ref: string }[];
  checkpoint?: { commit?: string };
  reviewTarget?: ReviewMirror;
  oracle?: { verdict?: { outcome: OracleVerdictOutcome; at: string }; corrections?: readonly ReviewVerdictCorrection[] };
  compositionAdmission?: CompositionAdmission;
  comments?: AdmissionComment[]; updatedAt?: string;
};
type AdmissionComment = { id: string; by: string; body: string; kind: string; source: string; at: string };
type SourceRelation = {
  conflict: boolean; side: ReviewBindingSide; reviewTicket: CompositionTicket | null;
  reviewTarget: ReviewMirror | null; mirror: ReviewMirror | null;
};
type SourceObservation = CompositionSourceExpected & CompositionSourceInput & { range: CompositionSourceRange };
type Observed = Omit<CompositionExpected, 'sources'> & { sources: readonly SourceObservation[] };
export type CompositionAdmissionResult = CompositionRefusal
  | { ok: false; reason: 'expected_required'; message: string; observed: Omit<Observed, 'sources'> & { sources: readonly (CompositionSourceExpected & CompositionSourceInput)[] } }
  | { ok: true; admission: CompositionAdmission; idempotent?: true };
type LockedResult = CompositionAdmissionResult | { ok: false; reason: 'busy' };
type CompositionBoundary = 'active' | 'submitted';
// A consumer refusal runs on the fresh locked root, so a capture or submit can refuse before its legacy body runs.
export type CompositionLockUse = Readonly<{
  boundary: CompositionBoundary;
  refusal?: (root: CompositionTicket) => CompositionRefusal | undefined;
}>;
type CompositionLockRefusal = CompositionRefusal & { ticket?: CompositionTicket };
type TicketLockKey = { slug: string; id: string };
type Dependencies = {
  getTicket: (slug: string, ref: string) => CompositionTicket | null;
  listTickets: (slug: string) => readonly CompositionTicket[];
  submissionReviewRelation: (slug: string, ticket: CompositionTicket) => SourceRelation | null;
  readMeta: (slug: string) => { path: string };
  withTicketFileLocks: <Result>(keys: readonly TicketLockKey[], callback: () => Result) => Result | { ok: false; reason: 'busy' };
  withTicketLocks: <Result>(keys: readonly TicketLockKey[], callback: () => Result) => Result | { ok: false; reason: 'busy' };
  putTicket: (slug: string, ticket: CompositionTicket) => void;
  createComment: (input: { by: string; body: string; kind: string; source: string }, at: string) => AdmissionComment;
  invalidateStoreCaches: () => void;
  dispatchTokenDigest: (nonce: string) => string;
};

function refuse(reason: string, message: string): CompositionRefusal {
  return { ok: false, reason, message };
}

function compositionAttestationRefusal(input: CompositionAdmissionInput): CompositionRefusal | undefined {
  const currentOnly = [input.authority === 'main-attestation', input.historicalCheckout === false];
  if (currentOnly.includes(false)) return refuse('invalid_admission', 'Only current main-attestation with historicalCheckout:false is supported.');
  if (![input.by.trim(), input.evidence.trim()].every(Boolean)) return refuse('invalid_admission', 'Composition adoption requires nonempty by and evidence for its audit.');
}

function currentAuthorityRefusal(input: CompositionAdmissionInput, sessionId: string, granted: boolean): CompositionRefusal | undefined {
  if (!granted) return refuse('admission_unauthorized', 'Composition adoption requires the main-thread MCP update grant. by and evidence are audit labels only.');
  if (!sessionId.trim()) return refuse('identity_unavailable', 'Composition adoption requires the actual runtime session.');
  return compositionAttestationRefusal(input);
}

function releasedRootRangeRefusal(root: CompositionTicket, input: CompositionAdmissionInput): CompositionRefusal | undefined {
  if (!root.dispatch?.terminalAt || root.dispatch.outcome !== 'released') return refuse('root_not_released', 'The latest root dispatch must genuinely be released.');
  if (root.dispatch.baseCommit !== input.base) return refuse('composition_base_mismatch', 'Composition must retain the original released dispatch BASE.');
}

function rootAdmissionRefusal(root: CompositionTicket, input: CompositionAdmissionInput): CompositionRefusal | undefined {
  if ([root.status === 'done', root.claim?.by, root.dispatchNonce].some(Boolean)) return refuse('root_active', 'Composition adoption requires a non-done, unclaimed, released root.');
  if (root.submission) return refuse('root_submitted', 'Rework the root through the ordinary protocol before adopting a composition.');
  return releasedRootRangeRefusal(root, input);
}

function submittedTerminalGeneration(dispatch: CompositionDispatch | undefined): boolean {
  return Boolean(dispatch?.terminalAt) && dispatch?.outcome === 'submitted';
}

function terminalSourceRefusal(source: CompositionTicket): CompositionRefusal | undefined {
  if ([source.claim?.by, source.dispatchNonce].some(Boolean)) return refuse('source_active', `${source.ref} is claimed or actively dispatched.`);
  if (!submittedTerminalGeneration(source.dispatch)) return refuse('source_unavailable', `${source.ref} needs its terminal submitted generation.`);
  if (source.status === 'done') return refuse('source_delivered', `${source.ref} is already done.`);
}

function sourceCandidateRefusal(source: CompositionTicket, input: CompositionSourceInput, submission: CompositionSubmission): CompositionRefusal | undefined {
  if (submission.commit !== input.commit || submission.at !== input.submittedAt) return refuse('stale_source', `${source.ref}'s submitted identity changed.`);
  if (!hasRecordedCompositionRange(submission)) return refuse('source_range_missing', `${source.ref} needs a complete recorded base, commit range and scope.`);
}

function sourceSubmissionRefusal(source: CompositionTicket, input: CompositionSourceInput): CompositionRefusal | undefined {
  const submission = source.submission;
  if (!submission) return refuse('source_unavailable', `${source.ref} has no pending immutable submission.`);
  if (submission.integratedAt || submission.supersededBy) return refuse('source_unavailable', `${source.ref} was delivered or superseded.`);
  return sourceCandidateRefusal(source, input, submission);
}

function sourceRelationRefusal(source: CompositionTicket, relation: SourceRelation | null): CompositionRefusal | undefined {
  if (!relation) return;
  if (relation.conflict || relation.side !== 'both') return refuse('stale_source', `${source.ref} has an incomplete or conflicting authoritative review binding.`);
  return sourceReviewIdentityRefusal(source, relation);
}

type SourceCandidate = { source: string; value: string | undefined };

function reviewTargetBindsSource(target: ReviewMirror | undefined, source: CompositionTicket, candidate: SourceCandidate): boolean {
  return [target?.ticketId === source.id, target?.ref === source.ref, sameReviewCandidate(target?.candidate, candidate)].every(Boolean);
}

function sourceMirrorBindsReview(mirror: ReviewMirror | undefined, review: CompositionTicket, candidate: SourceCandidate): boolean {
  return [mirror?.ticketId === review.id, mirror?.ref === review.ref, sameReviewCandidate(mirror?.candidate, candidate)].every(Boolean);
}

function reviewBindsExactSource(source: CompositionTicket, review: CompositionTicket): boolean {
  const candidate: SourceCandidate = { source: 'git', value: source.submission?.commit };
  return reviewTargetBindsSource(review.reviewTarget, source, candidate) && sourceMirrorBindsReview(source.submission?.review, review, candidate);
}

function sourceReviewIdentityRefusal(source: CompositionTicket, relation: SourceRelation): CompositionRefusal | undefined {
  const review = relation.reviewTicket;
  if (!review) return refuse('stale_source', `${source.ref}'s bound review is unavailable.`);
  if (!reviewBindsExactSource(source, review)) return refuse('stale_source', `${source.ref}'s review no longer binds its exact source and candidate.`);
  return sourceReviewOutcomeRefusal(source, review);
}

function latestCorrectionAt(review: CompositionTicket): string | undefined {
  const corrections = review.oracle?.corrections ?? [];
  return corrections.at(-1)?.at;
}

// An open review records no outcome yet; the board reads that as planned (reviewRelationOutcome).
function bindingOutcome(binding: ReviewMirror | undefined): ReviewOutcome {
  return binding?.outcome ?? 'planned';
}

function sourceBindingGenerationRefusal(source: CompositionTicket, review: CompositionTicket, expectedOutcome: ReviewOutcome): CompositionRefusal | undefined {
  const bindings = [source.submission?.review, review.reviewTarget];
  const correctedAt = latestCorrectionAt(review);
  if (!bindings.every(binding => bindingOutcome(binding) === expectedOutcome)) return refuse('stale_source', `${source.ref}'s binding does not match the authoritative verdict.`);
  if (!bindings.every(binding => binding?.correctedAt === correctedAt)) return refuse('stale_source', `${source.ref}'s binding does not match the authoritative correction generation.`);
}

function sourceReviewOutcomeRefusal(source: CompositionTicket, review: CompositionTicket): CompositionRefusal | undefined {
  const outcome = effectiveOracleVerdictOutcome(review.oracle);
  if (outcome === 'rejected') return refuse('source_rejected', `${source.ref}'s authoritative review rejected the candidate.`);
  return sourceBindingGenerationRefusal(source, review, outcome ?? 'planned');
}

type RecordedCompositionSubmission = CompositionSubmission & {
  base: string; commit: string; commits: readonly string[]; admittedScope: readonly string[];
};

function hasRecordedCompositionRange(submission: CompositionSubmission): submission is RecordedCompositionSubmission {
  return [submission.base, submission.commit, submission.commits?.length, submission.admittedScope?.length].every(Boolean);
}

function sourceRange(source: CompositionTicket): CompositionSourceRange {
  const submission = source.submission;
  if (!submission || !hasRecordedCompositionRange(submission)) throw new Error(`${source.ref} has no complete recorded composition range.`);
  return { ref: source.ref, base: submission.base, commit: submission.commit, commits: submission.commits, admittedScope: submission.admittedScope };
}

// The snapshot hashes the authoritative review ticket itself, not only the source's mirror of it.
function sourceSnapshot(source: CompositionTicket, relation: SourceRelation | null): string {
  const review = relation?.reviewTicket;
  return contextRevision({ id: source.id, submission: source.submission, dispatch: source.dispatch,
    review: review && { id: review.id, status: review.status, target: review.reviewTarget,
      oracle: review.oracle, dispatch: review.dispatch },
    binding: relation && { conflict: relation.conflict, side: relation.side } });
}

function mirroredReviewOutcome(source: CompositionTicket): ReviewOutcome | null {
  return source.submission?.review?.outcome ?? null;
}

function observedReviewGeneration(review: CompositionTicket | null): Pick<CompositionSourceExpected, 'reviewTicketId' | 'correctedAt'> {
  return { reviewTicketId: review?.id ?? null, correctedAt: review ? latestCorrectionAt(review) ?? null : null };
}

function sourceObservation(source: CompositionTicket, input: CompositionSourceInput, relation: SourceRelation | null): SourceObservation {
  const review = relation?.reviewTicket ?? null;
  return { ...input, range: sourceRange(source), ...observedReviewGeneration(review),
    reviewOutcome: mirroredReviewOutcome(source), snapshot: sourceSnapshot(source, relation) };
}

function rootGeneration(root: CompositionTicket): Omit<CompositionExpected, 'sources'> {
  const dispatch = root.dispatch ?? {};
  return { attemptCount: (dispatch.attempts ?? []).length,
    releasedAt: dispatch.terminalAt ?? '', preparedAt: dispatch.preparedAt ?? '' };
}

function expectedSource(observation: SourceObservation): CompositionSourceExpected {
  return { ref: observation.ref, reviewTicketId: observation.reviewTicketId,
    reviewOutcome: observation.reviewOutcome, correctedAt: observation.correctedAt, snapshot: observation.snapshot };
}

function expectedRefusal(input: CompositionAdmissionInput, observed: Observed): Extract<CompositionAdmissionResult, { ok: false }> | undefined {
  if (!input.expected) return { ok: false, reason: 'expected_required', message: 'Read this bounded observed snapshot, then retry update.admitComposition with expected. This probe grants nothing.',
    observed: { ...rootGenerationFromObserved(observed), sources: observed.sources.map(publicObservation) } };
  if (contextRevision(rootGenerationFromObserved(observed)) !== contextRevision(rootGenerationFromObserved(input.expected))) return refuse('stale_generation', 'The root released generation changed. Probe again without expected.');
  if (contextRevision(input.expected.sources) !== contextRevision(observed.sources.map(expectedSource))) return refuse('stale_source', 'A critical source submission or authoritative review/correction generation changed. Probe again without expected.');
}

function rootGenerationFromObserved(observed: Omit<CompositionExpected, 'sources'>): Omit<CompositionExpected, 'sources'> {
  return { attemptCount: observed.attemptCount, releasedAt: observed.releasedAt, preparedAt: observed.preparedAt };
}

function publicObservation(observation: SourceObservation): CompositionSourceExpected & CompositionSourceInput {
  return { ...expectedSource(observation), ref: observation.ref, commit: observation.commit, submittedAt: observation.submittedAt };
}

function existingAdmissionResult(root: CompositionTicket, input: CompositionAdmissionInput): CompositionAdmissionResult | undefined {
  const previous = root.compositionAdmission;
  if (!previous) return;
  if (previous.consumedBy) return refuse('admission_consumed', 'Composition adoption was already consumed. A new dispatch cannot replay it.');
  const previousInput: CompositionAdmissionInput = { authority: previous.authority, historicalCheckout: previous.historicalCheckout,
    by: previous.by, evidence: previous.evidence, candidate: previous.candidate, base: previous.base,
    ownCommits: previous.ownCommits, ownPaths: previous.ownPaths, sources: previous.sources, expected: previous.expected };
  if (contextRevision(previousInput) !== contextRevision(input)) return refuse('admission_exists', 'A different immutable composition admission already exists.');
  return { ok: true, idempotent: true, admission: previous };
}

function distinctNonRootRefs(refs: readonly string[], rootRef: string): boolean {
  return refs.length > 0 && new Set(refs).size === refs.length && !refs.includes(rootRef);
}

function uniqueSourcesRefusal(root: CompositionTicket, inputs: readonly CompositionSourceInput[]): CompositionRefusal | undefined {
  const refs = inputs.map(input => input.ref);
  if (!distinctNonRootRefs(refs, root.ref)) return refuse('invalid_sources', 'Composition requires distinct related sources, excluding the root.');
  const related = new Set(root.links?.filter(link => link.type === 'related').map(link => link.ref));
  if (refs.some(ref => !related.has(ref))) return refuse('source_unrelated', 'Every composition source must have an existing related root link.');
}

function sourceScopeRefusal(repository: string, source: CompositionTicket): CompositionRefusal | undefined {
  const range = sourceRange(source);
  if (!validateRelativeScopes(range.admittedScope).ok) return refuse('stale_source', `${source.ref}'s scope must be repository-relative.`);
  if (!validateCommitRangeScope(repository, range.commits, ticketCommitScope(range.admittedScope, range.admittedScope, source.ref)).ok) return refuse('source_scope_mismatch', `${source.ref}'s complete immutable submitted range exceeds its recorded scope.`);
}

function candidateFragmentRefusal(repository: string, root: CompositionTicket, candidate: string): CompositionRefusal | undefined {
  const fragment = ticketReleaseFragment(root.ref);
  if (!fragment) return refuse('missing_release_fragment', 'Composition requires the original root release fragment.');
  const present = execFileSync('git', ['ls-tree', '-r', '--name-only', candidate, '--', fragment], {
    cwd: repository, encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (present !== fragment) return refuse('missing_release_fragment', `Exact candidate must already contain ${fragment}.`);
}

function submittedOwnershipCommits(submission: CompositionSubmission | null | undefined): readonly string[] {
  if (!submission) return [];
  return [submission.commit ?? '', ...(submission.commits ?? [])];
}

function attemptOwnershipCommits(attempt: CompositionDispatch): readonly string[] {
  return [attempt.commit ?? '', ...(attempt.sanctionedCommits ?? [])];
}

function dispatchOwnershipCommits(dispatch: CompositionDispatch | undefined): readonly string[] {
  if (!dispatch) return [];
  return [...(dispatch.sanctionedCommits ?? []), ...(dispatch.attempts ?? []).flatMap(attemptOwnershipCommits)];
}

function recordedOwnershipCommits(ticket: CompositionTicket): readonly string[] {
  return [...submittedOwnershipCommits(ticket.submission), ticket.checkpoint?.commit ?? '', ...dispatchOwnershipCommits(ticket.dispatch)];
}

function foreignCommitRefusal(root: CompositionTicket, tickets: readonly CompositionTicket[], commits: readonly string[], sources: readonly CompositionSourceInput[]): CompositionRefusal | undefined {
  const permitted = new Set([root.ref, ...sources.map(source => source.ref)]);
  const foreign = tickets.filter(ticket => !permitted.has(ticket.ref))
    .find(ticket => recordedOwnershipCommits(ticket).some(commit => commits.includes(commit)));
  if (foreign) return refuse('foreign_commit', `Composition includes ${foreign.ref}'s independently recorded commit.`);
}

function originalRootScope(root: CompositionTicket): readonly string[] {
  return ticketCommitScope(root.dispatch?.declaredFiles ?? root.files ?? [], root.files, root.ref);
}

function admittedRootScope(root: CompositionTicket): readonly string[] {
  return root.compositionAdmission?.originalRootScope ?? originalRootScope(root);
}

// The lock set was computed from a pre-lock read, so a review bound afterwards is not protected by it.
function reviewEscapedLocks(relation: SourceRelation | null, locked: readonly string[]): boolean {
  const review = relation?.reviewTicket;
  return review ? !locked.includes(review.id) : false;
}

function ownFragmentRefusal(root: CompositionTicket, paths: readonly string[]): CompositionRefusal | undefined {
  const rootFragment = ticketReleaseFragment(root.ref);
  if (paths.some(file => file.startsWith('.release/unreleased/') && file !== rootFragment)) {
    return refuse('foreign_release_fragment', 'Root own changes cannot attribute another ticket\'s release fragment to the root.');
  }
}

// The dispatch fence must name the consumed admission, its new nonce, original BASE as range floor and C as checkout.
function dispatchNamesConsumedGeneration(current: CompositionDispatch, admission: CompositionAdmission, consumedBy: CompositionConsumption): boolean {
  const fence = current.compositionAdmission;
  return [fence?.id === admission.id, current.preparedAt === consumedBy.preparedAt,
    current.baseCommit === admission.base, fence?.rangeBase === admission.base,
    compositionCheckoutCommit(current) === admission.candidate, current.sharedTree === false,
    consumedBy.attempt === admission.expected.attemptCount + 1,
    fence?.nonceDigest === consumedBy.nonceDigest].every(Boolean);
}

function consumedGenerationRefusal(root: CompositionTicket): CompositionRefusal | undefined {
  const admission = root.compositionAdmission;
  if (!admission?.consumedBy) return refuse('admission_unconsumed', 'Composition requires its genuinely consumed prepared generation.');
  if (!dispatchNamesConsumedGeneration(root.dispatch ?? {}, admission, admission.consumedBy)) return refuse('stale_generation', 'Composition admission does not name this exact isolated dispatch generation.');
}

// The consumed grant is bound to one dispatch nonce, so neither a redispatch nor a live-claim recovery may mint another.
export function consumedAdmissionRefusal(root: CompositionTicket): CompositionRefusal | undefined {
  if (root.compositionAdmission?.consumedBy) return refuse('admission_consumed', 'Composition admission was already consumed. A new dispatch cannot replay it.');
}

function terminalCompositionRefusal(root: CompositionTicket): CompositionRefusal | undefined {
  const generation = consumedGenerationRefusal(root);
  if (generation) return generation;
  const terminal = [!root.claim?.by, !root.dispatchNonce, submittedTerminalGeneration(root.dispatch)];
  if (terminal.includes(false)) return refuse('stale_generation', 'Composition delivery requires its genuine claim-free submitted generation.');
  return exactCompositionSubmissionRefusal(root, root.submission);
}

function submitsExactComposition(admission: CompositionAdmission, submission: CompositionSubmission): boolean {
  const expectedCommits = [...admission.ownCommits, ...admission.sourceRanges.flatMap(source => source.commits)].sort();
  const recordedCommits = [...(submission.commits ?? [])].sort();
  return [submission.commit === admission.candidate, submission.base === admission.base,
    contextRevision(recordedCommits) === contextRevision(expectedCommits)].every(Boolean);
}

export function exactCompositionSubmissionRefusal(root: CompositionTicket, submission: CompositionSubmission | null | undefined): CompositionRefusal | undefined {
  const admission = root.compositionAdmission;
  if (!admission) return;
  if (!submitsExactComposition(admission, submission ?? {})) return refuse('composition_submission_mismatch', 'Composition must submit exact C and the complete original BASE..C range.');
}

type CompositionCapture = Readonly<{
  candidate?: { source?: string; value?: string }; completedAt?: string; worktree?: string; cleanWorktree?: boolean;
}>;

function capturedInGeneration(root: CompositionTicket, capture: CompositionCapture): boolean {
  return Date.parse(capture.completedAt ?? '') >= Date.parse(root.dispatch?.preparedAt ?? '');
}

function capturedCleanCandidate(capture: CompositionCapture, candidate: string | undefined): boolean {
  return capture.cleanWorktree === true && capture.candidate?.source === 'git' && capture.candidate?.value === candidate;
}

function compositionCaptureMetadataRefusal(root: CompositionTicket, capture: CompositionCapture): CompositionRefusal | undefined {
  const matches = [Boolean(root.claim?.by), capturedInGeneration(root, capture),
    capturedCleanCandidate(capture, root.compositionAdmission?.candidate)];
  if (matches.includes(false)) return refuse('composition_capture_mismatch', 'Composition capture must be fresh, clean, holder-owned, and bound to exact C in its new generation.');
}

function checkoutGitIdentity(worktree: string, argument: string): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', argument], {
    cwd: worktree, encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function captureUsesDispatchCheckout(dispatch: CompositionDispatch, worktree: string): boolean {
  const actualWorktree = canonicalPath(checkoutGitIdentity(worktree, '--show-toplevel'));
  const gitDirectory = canonicalPath(checkoutGitIdentity(worktree, '--absolute-git-dir'));
  return [actualWorktree === canonicalPath(dispatch.worktree ?? ''),
    gitDirectory === canonicalPath(dispatch.worktreeGitDirectory ?? ''),
    checkoutInstanceIdentity(gitDirectory) === dispatch.worktreeCheckoutInstance].every(Boolean);
}

function compositionCaptureCheckoutRefusal(root: CompositionTicket, worktree: string): CompositionRefusal | undefined {
  try {
    if (!captureUsesDispatchCheckout(root.dispatch ?? {}, worktree)) return refuse('composition_capture_checkout_mismatch', 'Composition capture belongs to a different native checkout instance.');
  } catch {
    return refuse('composition_capture_checkout_unavailable', 'Composition capture requires its observable genuine new native checkout.');
  }
}

export function compositionCaptureRefusal(root: CompositionTicket, capture: CompositionCapture): CompositionRefusal | undefined {
  if (!root.compositionAdmission) return;
  const metadata = compositionCaptureMetadataRefusal(root, capture);
  if (metadata) return metadata;
  if (!capture.worktree) return refuse('composition_capture_checkout_unavailable', 'Composition capture requires its genuine new native checkout.');
  return compositionCaptureCheckoutRefusal(root, capture.worktree);
}

export function compositionSubmissionScope(root: CompositionTicket): readonly string[] | null {
  const admission = root.compositionAdmission;
  if (!admission || consumedGenerationRefusal(root)) return null;
  return [...new Set([...admission.originalRootScope, ...admission.sourceRanges.flatMap(source => source.admittedScope)])];
}

function compositionSourceStillMatches(source: CompositionTicket, expected: CompositionSourceInput, range: CompositionSourceRange): boolean {
  const submission = source.submission;
  if (!submission || sourceCandidateRefusal(source, expected, submission)) return false;
  return contextRevision(sourceRange(source)) === contextRevision(range);
}

export function compositionIncludesSource(root: CompositionTicket, source: CompositionTicket, commits: readonly string[]): boolean {
  const admission = root.compositionAdmission;
  if (!admission || consumedGenerationRefusal(root)) return false;
  const expected = admission.sources.find(input => input.ref === source.ref);
  const range = admission.sourceRanges.find(input => input.ref === source.ref);
  if (!expected || !range) return false;
  return [compositionSourceStillMatches(source, expected, range), range.commits.every(commit => commits.includes(commit))].every(Boolean);
}

export function compositionCheckoutCommit(state: CompositionDispatch): string {
  return state.compositionAdmission?.checkoutCommit ?? state.baseCommit ?? '';
}

export function consumePreparedComposition(root: CompositionTicket, nonceDigest: string): void {
  const admission = root.compositionAdmission;
  if (!admission) return;
  if (admission.consumedBy) throw new Error('Composition admission was already consumed. A new dispatch cannot replay it.');
  fencePreparedGeneration(root, admission, nonceDigest);
}

function fencePreparedGeneration(root: CompositionTicket, admission: CompositionAdmission, nonceDigest: string): void {
  const dispatch = root.dispatch;
  if (!dispatch?.preparedAt || !nonceDigest) throw new Error('Composition consumption requires the new prepared generation and nonce digest.');
  root.compositionAdmission = { ...admission, consumedBy: {
    attempt: (dispatch.attempts ?? []).length + 1, preparedAt: dispatch.preparedAt, nonceDigest,
  } };
  dispatch.compositionAdmission = { id: admission.id, checkoutCommit: admission.candidate, rangeBase: admission.base, nonceDigest };
}

export function createCompositionAdmissions(dependencies: Dependencies) {
  function observeSources(slug: string, root: CompositionTicket, input: CompositionAdmissionInput, locked: readonly string[]): SourceObservation[] | CompositionRefusal {
    const distinct = uniqueSourcesRefusal(root, input.sources);
    if (distinct) return distinct;
    const observations: SourceObservation[] = [];
    for (const sourceInput of input.sources) {
      const observation = observeSource(slug, sourceInput, locked);
      if ('ok' in observation) return observation;
      observations.push(observation);
    }
    return observations;
  }

  function observeSource(slug: string, input: CompositionSourceInput, locked: readonly string[]): SourceObservation | CompositionRefusal {
    const source = dependencies.getTicket(slug, input.ref);
    if (!source) return refuse('source_unavailable', `${input.ref} is unavailable.`);
    const basic = terminalSourceRefusal(source) || sourceSubmissionRefusal(source, input);
    if (basic) return basic;
    return observeSourceReview(slug, source, input, locked);
  }

  function observeSourceReview(slug: string, source: CompositionTicket, input: CompositionSourceInput, locked: readonly string[]): SourceObservation | CompositionRefusal {
    const relation = dependencies.submissionReviewRelation(slug, source);
    if (reviewEscapedLocks(relation, locked)) return refuse('stale_source', 'Source review identity changed while acquiring composition locks. Probe again.');
    const failure = sourceRelationRefusal(source, relation) || sourceScopeRefusal(dependencies.readMeta(slug).path, source);
    if (failure) return failure;
    return sourceObservation(source, input, relation);
  }

  function proveCandidate(slug: string, root: CompositionTicket, input: CompositionAdmissionInput, observed: Observed): CompositionRefusal | undefined {
    const repository = dependencies.readMeta(slug).path;
    const proof = proveCompositionRange(repository, { ...input, rootScope: admittedRootScope(root),
      sources: observed.sources.map(source => source.range) });
    if (!proof.ok) return proof;
    return ownFragmentRefusal(root, input.ownPaths)
      || foreignCommitRefusal(root, dependencies.listTickets(slug), proof.commits, input.sources)
      || candidateFragmentRefusal(repository, root, input.candidate);
  }

  function admitUnderLocks(slug: string, ref: string, input: CompositionAdmissionInput, sessionId: string, locked: readonly string[]): CompositionAdmissionResult {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse('not_found', 'Composition root not found.');
    const rootFailure = rootAdmissionRefusal(root, input);
    if (rootFailure) return rootFailure;
    return admitObserved(slug, root, input, sessionId, locked);
  }

  function admitObserved(slug: string, root: CompositionTicket, input: CompositionAdmissionInput, sessionId: string, locked: readonly string[]): CompositionAdmissionResult {
    const sources = observeSources(slug, root, input, locked);
    if (!Array.isArray(sources)) return sources;
    const observed: Observed = { ...rootGeneration(root), sources };
    const failure = expectedRefusal(input, observed) || proveCandidate(slug, root, input, observed);
    if (failure) return failure;
    return existingAdmissionResult(root, input) ?? appendAdmission(slug, root, input, sessionId, observed);
  }

  function appendAdmission(slug: string, root: CompositionTicket, input: CompositionAdmissionInput, sessionId: string, observed: Observed): CompositionAdmissionResult {
    const at = new Date().toISOString();
    const comment = dependencies.createComment({ by: input.by,
      body: `Current main composition adoption: ${input.candidate} from original BASE ${input.base}. Historical checkout ownership is unverified. ${input.evidence}`,
      kind: 'comment', source: 'mcp' }, at);
    const admission: CompositionAdmission = { ...input, id: randomUUID(), at, sessionId, commentId: comment.id,
      expected: { ...rootGeneration(root), sources: observed.sources.map(expectedSource) },
      sourceRanges: observed.sources.map(source => source.range), originalRootScope: originalRootScope(root),
      releasedDispatch: structuredClone(root.dispatch ?? {}), consumedBy: null };
    root.compositionAdmission = admission;
    root.comments = [...(root.comments ?? []), comment];
    root.updatedAt = at;
    dependencies.putTicket(slug, root);
    return { ok: true, admission };
  }

  function participantLockIdentities(slug: string, ref: string): readonly string[] {
    const participant = dependencies.getTicket(slug, ref);
    if (!participant) return [];
    const review = dependencies.submissionReviewRelation(slug, participant)?.reviewTicket;
    return review ? [participant.id, review.id] : [participant.id];
  }

  function lockIdentities(slug: string, root: CompositionTicket, input: CompositionAdmissionInput): string[] {
    const identities = [root.id, ...participantLockIdentities(slug, root.ref),
      ...input.sources.flatMap(source => participantLockIdentities(slug, source.ref))];
    return [...new Set(identities)].sort();
  }

  function lockKeys(slug: string, identities: readonly string[]): TicketLockKey[] {
    return identities.map(id => ({ slug, id }));
  }

  function withCompositionLocks<Result>(slug: string, identities: readonly string[], callback: () => Result): Result | { ok: false; reason: 'busy' } {
    return stillSpawnsInsideItsWrite('withCompositionLocks', () => dependencies.withTicketLocks(lockKeys(slug, identities), callback));
  }

  function dispatchAdmissionRefusal(slug: string, root: CompositionTicket, locked: readonly string[]): Extract<CompositionAdmissionResult, { ok: false }> | undefined {
    const admission = root.compositionAdmission;
    if (!admission) return refuse('admission_unavailable', 'Composition admission disappeared while acquiring its locks.');
    return consumedAdmissionRefusal(root) || rootAdmissionRefusal(root, admission) || observedAdmissionRefusal(slug, root, admission, locked);
  }

  function observedAdmissionRefusal(slug: string, root: CompositionTicket, admission: CompositionAdmission, locked: readonly string[]): Extract<CompositionAdmissionResult, { ok: false }> | undefined {
    const sources = observeSources(slug, root, admission, locked);
    if (!Array.isArray(sources)) return sources;
    const observed: Observed = { ...rootGeneration(root), sources };
    return expectedRefusal(admission, observed) || proveCandidate(slug, root, admission, observed);
  }

  function dispatchLockIdentities(slug: string, ref: string, root: CompositionTicket | null | undefined): readonly string[] {
    return root?.compositionAdmission ? lockIdentities(slug, root, root.compositionAdmission) : [root?.id ?? ref];
  }

  // Re-read under the locks after the caller's generation snapshot: an admission adopted (or changed) while this
  // dispatch waited for its locks names sources it does not hold, so the old lock set proves nothing about it.
  function assertDispatchAdmissionHolds(slug: string, ref: string, identities: readonly string[]): void {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) throw new Error('Composition root disappeared while acquiring its locks.');
    if (dispatchLockIdentities(slug, ref, root).join('\n') !== identities.join('\n')) {
      throw new Error('prepare dispatch: admission_changed: Composition admission changed while this dispatch waited for its locks, so nothing was written. Dispatch again to take the current admission\'s source locks.');
    }
    const refusal = root.compositionAdmission ? dispatchAdmissionRefusal(slug, root, identities) : undefined;
    if (refusal) throw new Error(`prepare dispatch: ${refusal.reason}: ${refusal.message}`);
  }

  // Dispatch preparation runs git, so it holds only the file locks. The callback snapshots every locked ticket's
  // generation before it calls assertAdmissionHolds, whose source observations and range proof come next, and its
  // short write transaction rechecks that snapshot. A snapshot taken after the proof could not see a writer that
  // landed between the observation and the snapshot.
  function withCompositionDispatchPreparation<Result>(slug: string, ref: string, callback: (lockedIds: readonly string[], assertAdmissionHolds: () => void) => Result): Result | { ok: false; reason: 'busy' } {
    const identities = dispatchLockIdentities(slug, ref, dependencies.getTicket(slug, ref));
    try {
      return dependencies.withTicketFileLocks(lockKeys(slug, identities), () => callback(identities, () => assertDispatchAdmissionHolds(slug, ref, identities)));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }

  function consumedSourceRefusal(slug: string, root: CompositionTicket, locked: readonly string[]): CompositionRefusal | undefined {
    const admission = root.compositionAdmission;
    if (!admission) return refuse('admission_unavailable', 'Composition admission disappeared while acquiring its locks.');
    const sources = observeSources(slug, root, admission, locked);
    if (!Array.isArray(sources)) return sources;
    if (contextRevision(admission.expected.sources) !== contextRevision(sources.map(expectedSource))) {
      return refuse('stale_source', 'A critical source submission or authoritative review/correction generation changed after adoption.');
    }
    return proveCandidate(slug, root, admission, { ...admission.expected, sources });
  }

  function currentNonceRefusal(root: CompositionTicket): CompositionRefusal | undefined {
    if (!root.dispatchNonce) return refuse('stale_generation', 'An active composition boundary requires its genuine new dispatch nonce.');
    if (dependencies.dispatchTokenDigest(root.dispatchNonce) !== root.compositionAdmission?.consumedBy?.nonceDigest) {
      return refuse('stale_generation', 'Composition admission belongs to a different dispatch nonce.');
    }
  }

  function activeCompositionRefusal(slug: string, root: CompositionTicket, locked: readonly string[]): CompositionRefusal | undefined {
    return consumedGenerationRefusal(root) || currentNonceRefusal(root) || consumedSourceRefusal(slug, root, locked);
  }

  function submittedCompositionRefusal(slug: string, root: CompositionTicket, identities: readonly string[]): CompositionRefusal | undefined {
    const relation = dependencies.submissionReviewRelation(slug, root);
    if (!relation?.reviewTicket) return refuse('candidate_review_required', 'Composition delivery requires an ordinary independent review bound to its submitted exact C.');
    if (!identities.includes(relation.reviewTicket.id)) return refuse('stale_review', 'Composition root review changed while acquiring delivery locks.');
    return terminalCompositionRefusal(root) || consumedSourceRefusal(slug, root, identities);
  }

  function compositionBoundaryRefusal(slug: string, root: CompositionTicket, identities: readonly string[], boundary: CompositionBoundary): CompositionRefusal | undefined {
    if (boundary === 'active') return activeCompositionRefusal(slug, root, identities);
    return submittedCompositionRefusal(slug, root, identities);
  }

  function useUnderCompositionLocks<Result>(slug: string, ref: string, identities: readonly string[], use: CompositionLockUse, callback: () => Result): Result | CompositionLockRefusal {
    dependencies.invalidateStoreCaches();
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse('not_found', 'Composition root disappeared while acquiring its locks.');
    const refusal = compositionBoundaryRefusal(slug, root, identities, use.boundary);
    if (refusal) return refusal;
    const consumerRefusal = use.refusal?.(root);
    if (consumerRefusal) return { ...consumerRefusal, ticket: root };
    return callback();
  }

  function withCompositionGenerationLock<Result>(slug: string, ref: string, callback: () => Result, use: CompositionLockUse = { boundary: 'active' }): Result | CompositionLockRefusal | { ok: false; reason: 'busy' } {
    const root = dependencies.getTicket(slug, ref);
    if (!root?.compositionAdmission) return dependencies.withTicketLocks(lockKeys(slug, [root?.id ?? ref]), callback);
    const identities = lockIdentities(slug, root, root.compositionAdmission);
    try {
      return withCompositionLocks(slug, identities, () => useUnderCompositionLocks(slug, ref, identities, use, callback));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }

  function admitComposition(slug: string, ref: string, input: CompositionAdmissionInput, sessionId: string, grant: { allowCompositionAdmission?: boolean } = {}): LockedResult {
    const failure = currentAuthorityRefusal(input, sessionId, grant.allowCompositionAdmission === true);
    if (failure) return failure;
    const root = dependencies.getTicket(slug, ref);
    if (!root) return refuse('not_found', 'Composition root not found.');
    const identities = lockIdentities(slug, root, input);
    try {
      return withCompositionLocks(slug, identities, () => admitUnderLocks(slug, root.id, input, sessionId, identities));
    } finally {
      dependencies.invalidateStoreCaches();
    }
  }
  return { admitComposition, withCompositionDispatchPreparation, withCompositionGenerationLock };
}
