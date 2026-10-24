import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../app/src/lib/api';
import { BoardState } from '../app/src/lib/state/board.svelte';
import { renderMarkdown } from '../app/src/lib/components/ticket/markdown';
import type { Ticket } from '../app/src/lib/types';

const ticket: Ticket = { id: 't-1', ref: 'SQ-1', project: 'demo', title: 'Dialog ticket', status: 'todo' };

function response(payload: unknown) {
	return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('ticket dialog actions', () => {
	it('keeps edits, comments, and links behind BoardState mutation methods', async () => {
		const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => response({ ticket, from: ticket, init, input: String(input) }));
		const state = new BoardState(new ApiClient(fetcher));

		await state.autosaveTicket(ticket, { title: 'Saved title' });
		await state.addComment(ticket, 'A note');
		await state.linkTicket(ticket, 'blocks', 'SQ-2');
		await state.unlinkTicket(ticket, 'SQ-2');

		const requests = fetcher.mock.calls.map(([input, init]) => ({ url: String(input), body: String(init?.body ?? '') }));
		expect(requests[0]).toMatchObject({ url: expect.stringContaining('/api/tickets/t-1?project=demo'), body: expect.stringContaining('Saved title') });
		expect(requests[1].body).toContain('"kind":"comment"');
		expect(requests[2].body).toContain('"verb":"blocks"');
		expect(requests[3].url).toContain('/link/SQ-2?project=demo');
	});

	it('reads the full ticket when its dialog opens, since list rows carry only a summary', async () => {
		const row: Ticket = { ...ticket, summary: 'Short', commentCount: 1 };
		const full: Ticket = { ...ticket, description: 'Short and then the whole story', comments: [{ id: 'c-1', body: 'Report' }] };
		const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => response(String(input).startsWith('/api/tickets/t-1') ? { ticket: full } : { method: init?.method }));
		const state = new BoardState(new ApiClient(fetcher));
		state.applySnapshot({ projects: [{ slug: 'demo', name: 'Demo' }], tickets: [row], stories: [], categories: [], notifications: { notifications: [], unread: 0, unreadNeeds: 0 }, health: { ok: true, name: 'sidequest', pid: 1, startedAt: '2026-01-01', version: '1.0.0' } });

		await state.openTicket(row);

		expect(fetcher).toHaveBeenCalledWith('/api/tickets/t-1?project=demo', expect.objectContaining({ method: 'GET' }));
		expect(state.openDialog).toBe('t-1');
		expect(state.ticketDetail?.description).toBe('Short and then the whole story');
		expect(state.ticketDetail?.comments).toHaveLength(1);

		state.openDialog = null;
		await state.openTicket({ ...row, id: 't-2', ref: 'SQ-2' });
		expect(state.ticketDetail).toBeNull();
	});

	it('requests list rows for the selected board only', async () => {
		const fetcher = vi.fn((input: RequestInfo | URL) => response(String(input).startsWith('/api/health') ? { ok: true, name: 'sidequest', pid: 1, startedAt: '2026-01-01', version: '1.0.0' } : {}));
		const state = new BoardState(new ApiClient(fetcher));
		state.selectedProject = 'demo';
		const { PollingController } = await import('../app/src/lib/state/polling');
		new PollingController(state).refresh();

		await vi.waitFor(() => expect(fetcher.mock.calls.map(([input]) => String(input))).toContain('/api/tickets?project=demo'));
	});

	it('escapes source HTML and rejects unsafe markdown links', () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [safe](https://example.test)');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain('href="https://example.test"');
	});
});
