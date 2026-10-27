import type { CompletionFacts, CompletionStage, CompletionView, QualityStatus, StoryCompletionView } from '../../types';

export type Tone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
export interface UncertaintyChip { label: string; tone: Tone; }

const STAGE_TONES: Record<CompletionStage | 'partial', Tone> = {
	proposed: 'neutral', ready: 'neutral', blocked: 'danger', running: 'accent', submitted: 'warning', integrating: 'warning',
	partial: 'warning', rejected: 'danger', abandoned: 'danger', integrated: 'success', released: 'success', closed: 'success'
};
const TERMINAL_STAGES = new Set<string>(['integrated', 'released', 'closed']);
const QUALITY_WORDING: Record<QualityStatus, string> = {
	'measured-pass': 'measured, passed',
	'measured-fail': 'measured, FAILED',
	unverified: 'UNVERIFIED',
	'not-measured': 'not measured (no quality record)',
	none: 'not measured (no quality gate configured)'
};
const QUALITY_CHIPS: Record<QualityStatus, UncertaintyChip | null> = {
	'measured-pass': null,
	'measured-fail': { label: 'quality FAILED', tone: 'danger' },
	unverified: { label: 'quality UNVERIFIED', tone: 'warning' },
	'not-measured': { label: 'quality not measured', tone: 'warning' },
	none: { label: 'quality: none', tone: 'warning' }
};
const CONTROL_CHIPS: Record<CompletionFacts['negativeControl']['evidence'], UncertaintyChip | null> = {
	captured: null,
	'agent-reported': { label: 'negative control agent-reported', tone: 'warning' },
	waived: { label: 'negative control waived', tone: 'warning' },
	missing: { label: 'no negative control', tone: 'warning' }
};

export function stageTone(stage: string): Tone {
	return STAGE_TONES[stage as CompletionStage] ?? 'neutral';
}

export function shortCommit(commit: string | null | undefined): string {
	return (commit ?? '').slice(0, 9) || 'unknown';
}

function hasCandidate(view: CompletionView): boolean {
	return Boolean(view.facts.submission || view.facts.delivery);
}

function verifyChip(view: CompletionView): UncertaintyChip | null {
	const status = view.facts.verify?.status;
	if (status === 'passed') return null;
	return { label: status ? `verify ${status}` : 'verify not recorded', tone: status === 'failed' ? 'danger' : 'warning' };
}

const CANDIDATE_CHIPS: ((view: CompletionView) => UncertaintyChip | null)[] = [
	verifyChip,
	(view) => QUALITY_CHIPS[view.facts.quality.status],
	(view) => CONTROL_CHIPS[view.facts.negativeControl.evidence]
];

const VIEW_CHIPS: ((view: CompletionView) => UncertaintyChip | null)[] = [
	(view) => (view.summary?.stale ? { label: 'summary stale', tone: 'warning' } : null),
	(view) => (view.facts.candidateChanged && !view.summary?.stale ? { label: 'candidate changed', tone: 'warning' } : null),
	(view) => (view.stage === 'integrated' ? { label: 'no release record', tone: 'neutral' } : null)
];

/** Every doubt the records carry, as a flat list the panel shows in full: nothing here is ever collapsed. */
export function uncertaintyChips(view: CompletionView): UncertaintyChip[] {
	const rules = hasCandidate(view) ? [...VIEW_CHIPS, ...CANDIDATE_CHIPS] : VIEW_CHIPS;
	return rules.map((rule) => rule(view)).filter((chip): chip is UncertaintyChip => chip !== null);
}

function deliveryLine(delivery: NonNullable<CompletionFacts['delivery']>): string {
	const branch = delivery.branch ? ` to ${delivery.branch}` : '';
	return `Delivered ${shortCommit(delivery.commit)}${branch} by ${delivery.method}.`;
}

const RESULT_LINES: Partial<Record<CompletionStage, (view: CompletionView) => string>> = {
	integrated: (view) => deliveryLine(view.facts.delivery!),
	released: (view) => `${deliveryLine(view.facts.delivery!)} Released in ${view.facts.release.version}.`,
	submitted: (view) => `Submitted ${shortCommit(view.facts.submission?.commit)} by ${view.facts.submission?.by || 'an unrecorded actor'}; not integrated yet.`,
	integrating: (view) => `Submitted ${shortCommit(view.facts.submission?.commit)}; integration is running.`,
	closed: () => 'Closed without a delivery record.',
	abandoned: () => 'The submission was abandoned without landing.'
};

export function resultFact(view: CompletionView): string {
	return RESULT_LINES[view.stage]?.(view) ?? view.blocker?.reason ?? 'No candidate yet.';
}

function verifyFact(verify: CompletionFacts['verify']): string {
	if (!verify) return 'Verify: not recorded.';
	const kinds = verify.kinds.length ? verify.kinds.join(', ') : 'none recorded';
	return `Verify ${verify.status}${verify.command ? ` (${verify.command})` : ''}; evidence: ${kinds}.`;
}

function controlFact(control: CompletionFacts['negativeControl']): string {
	return control.kind === control.evidence ? `Negative control: ${control.kind}.` : `Negative control: ${control.kind} (${control.evidence}).`;
}

function reviewFact(review: CompletionFacts['review']): string {
	return review ? `Review ${review.by ?? 'unbound'}: ${review.verdict || 'no verdict yet'}.` : 'Review: none bound.';
}

export function checkedFacts(facts: CompletionFacts): string[] {
	return [verifyFact(facts.verify), `Quality: ${QUALITY_WORDING[facts.quality.status]}.`, controlFact(facts.negativeControl), reviewFact(facts.review)];
}

/** "No action needed." only when a terminal stage or a non-user blocker says someone else holds the next step. */
export function actionFact(view: Pick<CompletionView | StoryCompletionView, 'stage' | 'blocker'>): string {
	const blocker = view.blocker;
	if (blocker?.actor === 'user') return blocker.nextAction;
	if (blocker) return `No action needed. Next (${blocker.actor}): ${blocker.nextAction}`;
	return TERMINAL_STAGES.has(view.stage) ? 'No action needed.' : 'Check the ticket; the records name no next step.';
}

/** A local path becomes a file link only when it is absolute; the server already dropped paths outside approved roots. */
export function evidenceHref(path: string): string | null {
	const normalized = path.replace(/\\/g, '/');
	if (!/^(?:[A-Za-z]:)?\/[^/]/.test(normalized)) return null;
	return encodeURI(`file:///${normalized.replace(/^\//, '')}`);
}

export function storyResultFact(view: StoryCompletionView): string {
	const total = view.children.length;
	const landed = view.integrated.length ? ` (${view.integrated.join(', ')})` : '';
	return `${view.integrated.length} of ${total} tickets integrated${landed}.`;
}
