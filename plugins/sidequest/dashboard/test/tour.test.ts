import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardState } from '../app/src/lib/state/board.svelte';
import { TourState } from '../app/src/lib/state/tour.svelte';
import {
  clearTourProgress,
  defaultTourProgress,
  readTourProgress,
  TOUR_STORAGE_KEY,
  TOUR_VERSION,
  writeTourProgress
} from '../app/src/lib/state/tour-storage';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); })
  };
}

function persisted() {
  return JSON.parse(localStorage.getItem(TOUR_STORAGE_KEY) ?? 'null');
}

function tour() {
  return new TourState(new BoardState());
}

describe('tour storage', () => {
  let store: ReturnType<typeof storage>;

  beforeEach(() => {
    store = storage();
    vi.stubGlobal('localStorage', store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the default progress when storage is empty', () => {
    expect(readTourProgress()).toEqual(defaultTourProgress());
  });

  it('round trips progress through localStorage', () => {
    const progress = { version: TOUR_VERSION, completed: false, step: 4 };
    writeTourProgress(progress);
    expect(readTourProgress()).toEqual(progress);
  });

  it.each([
    ['corrupt JSON', '{bad json'],
    ['a different version', JSON.stringify({ version: 2, completed: false, step: 1 })],
    ['a non-object payload', JSON.stringify(['not', 'an', 'object'])],
    ['a non-numeric step', JSON.stringify({ version: TOUR_VERSION, completed: false, step: '1' })]
  ])('returns the default for %s', (_reason, value) => {
    store.setItem(TOUR_STORAGE_KEY, value);
    expect(readTourProgress()).toEqual(defaultTourProgress());
  });

  it('clears progress and returns the default afterward', () => {
    writeTourProgress({ version: TOUR_VERSION, completed: true, step: 0 });
    clearTourProgress();
    expect(readTourProgress()).toEqual(defaultTourProgress());
    expect(store.removeItem).toHaveBeenCalledWith(TOUR_STORAGE_KEY);
  });

  it('survives a browser with throwing localStorage', () => {
    const disabled = {
      getItem: vi.fn(() => { throw new Error('storage disabled'); }),
      setItem: vi.fn(() => { throw new Error('storage disabled'); }),
      removeItem: vi.fn(() => { throw new Error('storage disabled'); })
    };
    vi.stubGlobal('localStorage', disabled);

    expect(readTourProgress()).toEqual(defaultTourProgress());
    expect(() => writeTourProgress(defaultTourProgress())).not.toThrow();
    expect(() => clearTourProgress()).not.toThrow();
  });
});

describe('TourState', () => {
  let store: ReturnType<typeof storage>;

  beforeEach(() => {
    store = storage();
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('document', { querySelector: vi.fn(() => ({ })) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at index zero and persists every move', () => {
    const state = tour();
    state.start(0);
    expect(state.active).toBe(true);
    expect(state.index).toBe(0);

    state.next();
    expect(state.index).toBe(1);
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: false, step: 1 });
    state.next();
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: false, step: 2 });
  });

  it('moves backward and keeps index zero as a no-op', () => {
    const state = tour();
    state.start(2);
    state.prev();
    expect(state.index).toBe(1);
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: false, step: 1 });
    state.prev();
    expect(state.index).toBe(0);
    state.prev();
    expect(state.index).toBe(0);
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: false, step: 0 });
  });

  it('enters and exits the ticket dialog in both directions', () => {
    const board = new BoardState();
    const state = new TourState(board);
    state.start(8);
    state.next();
    expect(state.index).toBe(9);
    expect(board.openDialog).toBe('create');
    state.next();
    expect(state.index).toBe(10);
    expect(board.openDialog).toBeNull();

    state.prev();
    expect(state.index).toBe(9);
    expect(board.openDialog).toBe('create');
    state.prev();
    expect(state.index).toBe(8);
    expect(board.openDialog).toBeNull();
  });

  it('skip exits the current step and persists completion', () => {
    const board = new BoardState();
    const state = new TourState(board);
    state.start(9);
    expect(board.openDialog).toBe('create');
    state.skip();
    expect(state.active).toBe(false);
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: true, step: 9 });
    expect(board.openDialog).toBeNull();
  });

  it('finishes, including when next is called on the last step', () => {
    const state = tour();
    state.start(13);
    state.next();
    expect(state.active).toBe(false);
    expect(persisted()).toEqual({ version: TOUR_VERSION, completed: true, step: 0 });
  });

  it('resets completed progress and starts from zero', () => {
    const state = tour();
    state.start(4);
    state.finish();
    state.reset();
    expect(state.active).toBe(true);
    expect(state.index).toBe(0);
    expect(persisted()).toBeNull();
  });

  it('does not auto-start completed progress and resumes incomplete progress', () => {
    writeTourProgress({ version: TOUR_VERSION, completed: true, step: 4 });
    const completed = tour();
    completed.maybeAutoStart();
    expect(completed.active).toBe(false);

    writeTourProgress({ version: TOUR_VERSION, completed: false, step: 4 });
    const resumed = tour();
    resumed.maybeAutoStart();
    expect(resumed.active).toBe(true);
    expect(resumed.index).toBe(4);
  });

  it('skips missing optional targets but keeps missing required targets', () => {
    const querySelector = vi.fn((target: string) => {
      if (target.includes('story-filter') || target.includes('board-columns') || target.includes('ticket-card')) return null;
      return {};
    });
    vi.stubGlobal('document', { querySelector });

    const state = tour();
    state.start(4);
    state.next();
    expect(state.index).toBe(8);

    querySelector.mockImplementation(() => null);
    state.start(1);
    expect(state.index).toBe(1);
    expect(state.step?.id).toBe('project-rail');
  });
});
