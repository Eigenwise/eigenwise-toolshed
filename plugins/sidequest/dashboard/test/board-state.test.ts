import { describe, expect, it } from 'vitest';
import { BoardState } from '../app/src/lib/state/board.svelte';
import { ApiClient } from '../app/src/lib/api';
import type { Snapshot } from '../app/src/lib/types';

const snapshot = (): Snapshot => ({
  projects: [{ slug: 'alpha', name: 'Alpha' }],
  tickets: [
    { id: '1', ref: 'SQ-1', title: 'First', status: 'todo', priority: 'normal', order: 1, projectSlug: 'alpha' },
    { id: '2', ref: 'SQ-2', title: 'Urgent item', status: 'doing', priority: 'urgent', order: 2, projectSlug: 'alpha' },
    { id: '3', ref: 'SQ-3', title: 'Done', status: 'done', priority: 'low', order: 3, projectSlug: 'alpha' }
  ],
  stories: [],
  categories: [{ id: 'general', name: 'General' }],
  notifications: { notifications: [{ id: 'n1', kind: 'question' }, { id: 'n2', kind: 'comment' }], unread: 2, unreadQuestions: 1, unreadNeeds: 1 },
  health: { ok: true, name: 'sidequest', pid: 1, startedAt: '2026-01-01', version: '1.0.0' }
});

describe('BoardState', () => {
  it('derives scope, filters, columns, and inbox buckets from one snapshot', () => {
    const state = new BoardState();
    state.applySnapshot(snapshot());
    state.selectProject('alpha');
    state.search = 'urgent';

    expect(state.visibleTickets.map((ticket) => ticket.id)).toEqual(['2']);
    expect(state.columns.todo).toEqual([]);
    expect(state.columns.doing.map((ticket) => ticket.id)).toEqual(['2']);
    expect(state.counts).toEqual({ todo: 0, doing: 1, done: 0 });
    expect(state.unreadBuckets.needs.map((notification) => notification.id)).toEqual(['n1']);
    expect(state.categoryGroups.enabled.map((category) => category.id)).toEqual(['general']);
  });

  it('filters tickets by assignee alongside the other board filters', () => {
    const state = new BoardState();
    const data = snapshot();
    data.tickets[0].assignee = 'you';
    data.tickets[1].claim = { by: 'agent', at: new Date().toISOString() };
    state.applySnapshot(data);

    state.assignee = 'you';
    expect(state.visibleTickets.map((ticket) => ticket.id)).toEqual(['1']);
    state.assignee = 'agent';
    expect(state.visibleTickets.map((ticket) => ticket.id)).toEqual(['2']);
    state.assignee = 'unassigned';
    expect(state.visibleTickets.map((ticket) => ticket.id)).toEqual(['3']);
  });

  it('holds a pending poll snapshot until a ticket mutation completes', async () => {
    let finish: () => void = () => {};
    const api = {
      updateTicket: () => new Promise((resolve) => { finish = () => resolve({ ticket: snapshot().tickets[0] }); })
    } as unknown as ApiClient;
    const state = new BoardState(api);
    state.applySnapshot(snapshot());
    const ticket = state.raw!.tickets[0];
    const save = state.patchTicket(ticket, { title: 'Saved' });
    const next = snapshot();
    next.tickets[0].title = 'From poll';
    state.applySnapshot(next);

    expect(state.mutations).toBe(1);
    expect(state.raw?.tickets[0].title).toBe('First');
    finish();
    await save;
    expect(state.mutations).toBe(0);
    expect(state.raw?.tickets[0].title).toBe('From poll');
  });

  it('keeps the newest snapshot until an interaction lock clears', () => {
    const state = new BoardState();
    state.applySnapshot(snapshot());
    state.setDragging(true);
    const next = snapshot();
    next.tickets[0].title = 'Updated while dragging';
    state.applySnapshot(next);

    expect(state.raw?.tickets[0].title).toBe('First');
    state.setDragging(false);
    expect(state.raw?.tickets[0].title).toBe('Updated while dragging');
  });
});
