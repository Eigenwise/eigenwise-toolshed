import { describe, expect, it } from 'vitest';
import { isStaleClaim, movePayload, plainText, projectFor } from '../app/src/lib/components/board/surface';

describe('board surface interactions', () => {
  it('does not create a move for a card dropped in its current column', () => {
    expect(movePayload({ id: '1', ref: 'SQ-1', title: 'Ticket', status: 'todo' }, 'todo')).toBeNull();
  });

  it('creates a timestamped move for a different column', () => {
    expect(movePayload({ id: '1', ref: 'SQ-1', title: 'Ticket', status: 'todo' }, 'doing', 42)).toEqual({ status: 'doing', order: 42 });
  });

  it('uses the ticket project slug and strips markdown previews', () => {
    expect(projectFor({ id: '1', ref: 'SQ-1', title: 'Ticket', status: 'todo', projectSlug: 'toolshed' })).toBe('toolshed');
    expect(plainText('## **Ship** [it](https://example.com)')).toBe('Ship it');
  });

  it('identifies stale and fresh agent claims', () => {
    expect(isStaleClaim({ at: new Date(Date.now() - 61 * 60 * 1_000).toISOString() })).toBe(true);
    expect(isStaleClaim({ at: new Date().toISOString() })).toBe(false);
  });
});
