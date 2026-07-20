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
		await state.askQuestion(ticket, 'Need an answer');
		await state.linkTicket(ticket, 'blocks', 'SQ-2');
		await state.unlinkTicket(ticket, 'SQ-2');

		const requests = fetcher.mock.calls.map(([input, init]) => ({ url: String(input), body: String(init?.body ?? '') }));
		expect(requests[0]).toMatchObject({ url: expect.stringContaining('/api/tickets/t-1?project=demo'), body: expect.stringContaining('Saved title') });
		expect(requests[1].body).toContain('"kind":"comment"');
		expect(requests[2].body).toContain('"kind":"question"');
		expect(requests[3].body).toContain('"verb":"blocks"');
		expect(requests[4].url).toContain('/link/SQ-2?project=demo');
	});

	it('escapes source HTML and rejects unsafe markdown links', () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [safe](https://example.test)');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain('href="https://example.test"');
	});
});
