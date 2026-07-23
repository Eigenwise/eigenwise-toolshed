import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../app/src/lib/api';
import { BoardState } from '../app/src/lib/state/board.svelte';
import { PollingController } from '../app/src/lib/state/polling';

function response(payload: unknown) { return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })); }

const fetcher = vi.fn((input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/projects')) return response({ projects: [] });
  if (url.includes('/tickets')) return response({ tickets: [] });
  if (url.includes('/stories')) return response({ stories: [] });
  if (url.includes('/categories')) return response({ categories: [], warnings: [] });
  if (url.includes('/notifications')) return response({ notifications: [], unread: 0, unreadNeeds: 0 });
  if (url.includes('/routing-models')) return response({ models: ['sonnet', 'codex-fixture'], discovered: [{ slug: 'codex-fixture' }], efforts: ['medium'], globalFallback: { model: 'sonnet', effort: 'medium' } });
  return response({ ok: true, name: 'sidequest', pid: 1, startedAt: '2026-01-01', version: '1.0.0' });
});

describe('PollingController', () => {
  it('applies one coherent snapshot from mocked fetch responses', async () => {
    const state = new BoardState(new ApiClient(fetcher));
    const controller = new PollingController(state);
    controller.refresh();

    await vi.waitFor(() => expect(state.raw?.health.version).toBe('1.0.0'));
    expect(state.routingCatalog.models).toContain('codex-fixture');
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('keeps the current board and marks the state offline after a mandatory fetch fails', async () => {
    const state = new BoardState(new ApiClient(fetcher));
    const controller = new PollingController(state);
    controller.refresh();
    await vi.waitFor(() => expect(state.raw).not.toBeNull());

    state.api = new ApiClient(vi.fn().mockRejectedValue(new Error('network down')));
    controller.refresh();
    await vi.waitFor(() => expect(state.offline).toBe(true));
    expect(state.raw?.health.version).toBe('1.0.0');
  });
});
