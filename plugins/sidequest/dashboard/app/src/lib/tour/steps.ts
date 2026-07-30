import type { BoardState } from '../state/board.svelte';

export interface TourStep {
  id: string;
  target: string | null;
  title: string;
  body: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  optional?: boolean;
  available?: (board: BoardState) => boolean;
  enter?: (board: BoardState) => void;
  exit?: (board: BoardState) => void;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Find your way around',
    body: 'This board is a window onto work, much of it filed and handled by agents. This one-minute tour shows you where to look, and you can skip it anytime.'
  },
  {
    id: 'project-rail',
    target: '[data-tour="project-rail"]',
    title: 'Your boards',
    body: 'Switch between boards here, or see everything together. Each bar shows that board’s todo, doing, and done split at a glance.'
  },
  {
    id: 'board-columns',
    target: '[data-tour="board-columns"]',
    title: 'Track the flow',
    body: 'Work moves through todo, doing, and done. Scan the columns to see what’s queued, active, and finished.',
    optional: true
  },
  {
    id: 'ticket-card',
    target: '[data-tour="ticket-card"]',
    title: 'Read a card',
    body: 'Cards are dense on purpose: the ref, priority, story, and model route tell you what the work is and how it will run. A claim chip means an agent currently holds it.',
    optional: true
  },
  {
    id: 'ticket-dialog',
    target: '[data-tour="ticket-dialog"]',
    title: 'Read the full ticket',
    body: 'Open a ticket for its full description, links, and claim details. The comment thread is where executors report back what they did, so it’s usually the main thing to check.',
    optional: true,
    available: (board) => board.visibleTickets.length > 0,
    enter: (board) => {
      const score = (ticket: typeof board.visibleTickets[number]) =>
        (Array.isArray(ticket.comments) && ticket.comments.length ? 8 : 0) +
        (typeof ticket.description === 'string' && ticket.description.trim() ? 4 : 0) +
        (ticket.claim?.by ? 2 : 0) +
        (ticket.storyId ? 1 : 0);
      const ticket = board.visibleTickets.reduce(
        (best, candidate) => score(candidate) > score(best) ? candidate : best,
        board.visibleTickets[0]
      );
      board.openDialog = ticket?.id ?? null;
    },
    exit: (board) => { board.openDialog = null; }
  },
  {
    id: 'notifications',
    target: '[data-tour="notifications"]',
    title: 'See what changed',
    body: 'Your inbox collects comments, new tickets, and status moves from while you were away.'
  },
  {
    id: 'search',
    target: '[data-tour="search"]',
    title: 'Find a ticket',
    body: 'Search refs, titles, and labels to find a specific ticket on a busy board.'
  },
  {
    id: 'priority-filter',
    target: '[data-tour="priority-filter"]',
    title: 'Focus by priority',
    body: 'Narrow the board to the priority that needs your attention.'
  },
  {
    id: 'sort-menu',
    target: '[data-tour="sort-menu"]',
    title: 'Choose the order',
    body: 'Keep the board’s drag order, or sort by priority, recent activity, or age.'
  },
  {
    id: 'story-filter',
    target: '[data-tour="story-filter"]',
    title: 'Follow a story',
    body: 'Narrow the board to one story and the related tickets that make it up.',
    optional: true
  },
  {
    id: 'archive-toggle',
    target: '[data-tour="archive-toggle"]',
    title: 'Look through history',
    body: 'Open the archive when you need finished tickets or archived boards.'
  },
  {
    id: 'settings-trigger',
    target: '[data-tour="settings-trigger"]',
    title: 'Steer model routing',
    body: 'Settings holds routing profiles and categories. This is where you choose which model handles each kind of work.'
  },
  {
    id: 'new-ticket',
    target: '[data-tour="new-ticket"]',
    title: 'File work yourself',
    body: 'You can file work yourself here, though most tickets arrive from agents. Press N as a shortcut.'
  },
  {
    id: 'finish',
    target: null,
    title: 'You’re set',
    body: 'Replay this tour from Settings or with the ? key whenever you need it.'
  }
];
