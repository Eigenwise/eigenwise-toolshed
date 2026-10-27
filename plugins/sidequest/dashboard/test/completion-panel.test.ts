import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import CompletionPanel from '../app/src/lib/components/ticket/CompletionPanel.svelte';
import StoryCompletionPanel from '../app/src/lib/components/story/StoryCompletionPanel.svelte';
import { ApiClient } from '../app/src/lib/api';
import { BoardState } from '../app/src/lib/state/board.svelte';
import type { CompletionFacts, CompletionSummary, CompletionView, StoryCompletionView, Ticket } from '../app/src/lib/types';

const measuredFacts: CompletionFacts = {
	submission: { commit: 'abc1234567890', at: '2026-10-27T10:00:00Z', by: 'sq-exec' },
	delivery: null,
	verify: { status: 'passed', command: 'npm test', logPath: null, kinds: ['captured-command'] },
	quality: { status: 'measured-pass', detail: null },
	negativeControl: { kind: 'captured', evidence: 'captured' },
	review: null,
	release: { version: null, evidence: 'none' },
	candidateChanged: false
};

const summary: CompletionSummary = { version: 1, result: 'Panel ships.', checked: 'Ran the panel test.', uncertain: 'Dark theme unchecked.', action: 'None.', by: 'sq-exec', at: '2026-10-27T10:00:00Z', candidate: 'abc1234567890', stale: false };

function view(overrides: Partial<CompletionView> = {}, facts: Partial<CompletionFacts> = {}): CompletionView {
	return { ref: 'SQ-1', title: 'Panel', stage: 'submitted', blocker: { reason: 'Candidate abc123456 awaits integration.', actor: 'orchestrator', nextAction: 'Integrate the submitted candidate.' }, facts: { ...measuredFacts, ...facts }, summary: null, evidence: [], text: '', ...overrides };
}

function html(props: { view: CompletionView | null; anchors?: string[] }) {
	return render(CompletionPanel, { props }).body;
}

function stageBadge(body: string) {
	return /data-stage="([^"]+)"[^>]*>([^<]+)</.exec(body)?.slice(1);
}

describe('completion panel', () => {
	it('renders the four sections for an integrated ticket and labels the summary agent-reported', () => {
		const body = html({ view: view({ stage: 'integrated', blocker: null, summary }, { delivery: { commit: 'def9876543210', branch: 'develop', head: 'fff000', at: '2026-10-27T11:00:00Z', method: 'merge' } }) });
		expect(stageBadge(body)).toEqual(['integrated', 'integrated']);
		const order = ['Result', 'Checked', 'Still uncertain', 'Your action'].map((label) => body.search(new RegExp(`<dt[^>]*>${label}</dt>`)));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(body).toContain('Delivered def987654 to develop by merge.');
		expect(body).toMatch(/<span class="tag[^"]*">agent-reported<\/span> Panel ships\./);
		expect(body).toContain('no release record');
		expect(body).toContain('No action needed.');
	});

	it('badges a submitted ticket as submitted, never done or integrated', () => {
		const body = html({ view: view() });
		expect(stageBadge(body)).toEqual(['submitted', 'submitted']);
		expect(body).not.toMatch(/data-stage="(?:integrated|done)"/);
		expect(body).toContain('not integrated yet');
		expect(body).toContain('Next (orchestrator): Integrate the submitted candidate.');
	});

	it('shows the facts block for a legacy ticket without inventing a result', () => {
		const body = html({ view: view({ stage: 'closed', blocker: null }, { submission: null, verify: null, quality: { status: 'not-measured', detail: null }, negativeControl: { kind: 'missing', evidence: 'missing' } }) });
		expect(body).toContain('No summary recorded.');
		expect(body).toContain('Closed without a delivery record.');
		expect(body).toContain('Verify: not recorded.');
		expect(body).not.toContain('agent-reported</span>');
	});

	it('keeps unverified quality, waived and agent-reported controls and a stale summary as visible chips', () => {
		const stale = html({ view: view({ summary: { ...summary, stale: true } }, { quality: { status: 'unverified', detail: null }, negativeControl: { kind: 'new-behavior', evidence: 'agent-reported' } }) });
		const visible = stale.slice(0, stale.indexOf('<details'));
		for (const chip of ['summary stale', 'quality UNVERIFIED', 'negative control agent-reported']) expect(visible).toContain(`>${chip}</li>`);
		const waived = html({ view: view({}, { quality: { status: 'none', detail: null }, negativeControl: { kind: 'waived', evidence: 'waived' } }) });
		expect(waived.slice(0, waived.indexOf('<details'))).toContain('>negative control waived</li>');
		expect(waived).toContain('>quality: none</li>');
	});

	it('puts a user-action blocker before the four sections', () => {
		const body = html({ view: view({ stage: 'blocked', blocker: { reason: 'Waiting on a human verdict.', actor: 'user', nextAction: 'Answer: ship it?' } }, { submission: null }) });
		const blocker = body.indexOf('role="alert"');
		expect(blocker).toBeGreaterThan(-1);
		expect(blocker).toBeLessThan(body.search(/<dt[^>]*>Result<\/dt>/));
		expect(body).toContain('Answer: ship it?');
	});

	it('renders a script tag in agent text as text', () => {
		const body = html({ view: view({ summary: { ...summary, result: '<script>alert(1)</script>' } }) });
		expect(body).not.toContain('<script>alert(1)');
		expect(body).toContain('&lt;script>alert(1)&lt;/script>');
	});

	it('links evidence only for an absolute path under an approved root', () => {
		const body = html({ view: view({ evidence: [
			{ kind: 'captured-command', path: 'C:\\Users\\me\\.claude\\sidequest\\verification\\SQ-1\\verify.log', label: 'verify capture passed' },
			{ kind: 'mocked-test', path: '', label: 'outside root' },
			{ kind: 'visual', path: 'javascript:alert(1)', label: 'scripted' }
		] }) });
		const links = [...body.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
		expect(links).toEqual([['file:///C:/Users/me/.claude/sidequest/verification/SQ-1/verify.log', 'verify capture passed']]);
		expect(body).toMatch(/<span[^>]*>outside root<\/span>/);
		expect(body).not.toContain('href="javascript:');
	});
});

describe('story completion panel', () => {
	const child = view({ stage: 'integrated', blocker: null }, { quality: { status: 'unverified', detail: null }, delivery: { commit: 'def9876543210', branch: 'develop', head: 'fff000', at: '2026-10-27T11:00:00Z', method: 'merge' } });
	const story: StoryCompletionView = { ref: 'US-1', title: 'Story', stage: 'partial', blocker: null, children: [child, view({ ref: 'SQ-2' })], integrated: ['SQ-1'], notYet: [{ ref: 'SQ-2', stage: 'submitted' }], uncertainties: ['SQ-1 quality UNVERIFIED.'], decisions: { count: 2, latest: 'Keep released honest.' }, text: '' };

	it('says the story view is not available when the server has no story read', () => {
		expect(render(StoryCompletionPanel, { props: { read: { available: false, completion: null } } }).body).toContain('Story view not available.');
	});

	it('renders the story sections with member stages and uncertainty outside the expand area', () => {
		const body = render(StoryCompletionPanel, { props: { read: { available: true, completion: story } } }).body;
		expect(stageBadge(body)).toEqual(['partial', 'partial']);
		expect(body).toContain('1 of 2 tickets integrated (SQ-1).');
		expect(body).toContain('Not yet: SQ-2 (submitted).');
		const visible = body.slice(0, body.indexOf('<details'));
		expect(visible).toContain('SQ-1 quality UNVERIFIED.');
		expect(visible).toContain('>quality UNVERIFIED</span>');
		expect(body).toContain('Keep released honest.');
	});
});

describe('completion reads', () => {
	const ticket: Ticket = { id: 't-1', ref: 'SQ-1', project: 'demo', title: 'Panel', status: 'doing' };

	function response(status: number, payload: unknown) {
		return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }));
	}

	it('loads the completion view beside the ticket detail and drops it when the dialog moves on', async () => {
		const completion = view();
		const fetcher = vi.fn((input: RequestInfo | URL) => String(input).includes('/completion') ? response(200, { completion }) : response(200, { ticket }));
		const state = new BoardState(new ApiClient(fetcher));
		state.applySnapshot({ projects: [{ slug: 'demo', name: 'Demo' }], tickets: [ticket], stories: [], categories: [], notifications: { notifications: [], unread: 0, unreadNeeds: 0 }, health: { ok: true, name: 'sidequest', pid: 1, startedAt: '2026-01-01', version: '1.0.0' } });

		await state.openTicket(ticket);
		expect(fetcher).toHaveBeenCalledWith('/api/tickets/t-1/completion?project=demo', expect.objectContaining({ method: 'GET' }));
		expect(state.ticketCompletion?.stage).toBe('submitted');

		state.openDialog = null;
		await state.loadTicketCompletion();
		expect(state.ticketCompletion?.stage).toBe('submitted');
		await state.openTicket({ ...ticket, id: 't-2' });
		expect(state.ticketCompletion).toBeNull();
	});

	it('reads a failed story completion request as not available', async () => {
		const fetcher = vi.fn(() => response(404, { error: 'not found' }));
		const state = new BoardState(new ApiClient(fetcher));
		await state.openStoryCompletion({ id: 's-1', projectSlug: 'demo', title: 'Story' });
		expect(fetcher).toHaveBeenCalledWith('/api/stories/s-1/completion?project=demo', expect.objectContaining({ method: 'GET' }));
		expect(state.storyCompletion).toEqual({ available: false, completion: null });
		state.closeStoryCompletion();
		expect(state.storyCompletionId).toBeNull();
	});
});
