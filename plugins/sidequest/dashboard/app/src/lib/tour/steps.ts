import type { BoardState } from '../state/board.svelte';

export interface TourStep {
  id: string;
  target: string | null;
  title: string;
  body: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  optional?: boolean;
  enter?: (board: BoardState) => void;
  exit?: (board: BoardState) => void;
}

export const TOUR_STEPS: TourStep[] = [
  { id: 'welcome', target: null, title: 'Welcome to Sidequest', body: 'This quick tour takes about a minute. Skip it whenever you want.' },
  { id: 'project-rail', target: '[data-tour="project-rail"]', title: 'Pick a board', body: 'Switch between boards here, or see every ticket at once. The bars show each board’s progress.' },
  { id: 'search', target: '[data-tour="search"]', title: 'Find a ticket', body: 'Search refs, titles, and labels when you know what you need.' },
  { id: 'priority-filter', target: '[data-tour="priority-filter"]', title: 'Focus by priority', body: 'Use this to narrow the board to work that needs attention first.' },
  { id: 'sort-menu', target: '[data-tour="sort-menu"]', title: 'Choose the order', body: 'Keep your drag order, or sort by priority and recent activity.' },
  { id: 'story-filter', target: '[data-tour="story-filter"]', title: 'Follow a story', body: 'Stories group related tickets so you can focus on one piece of work.', optional: true },
  { id: 'board-columns', target: '[data-tour="board-columns"]', title: 'Move work forward', body: 'Drag tickets between todo, doing, and done as the work changes.', optional: true },
  { id: 'ticket-card', target: '[data-tour="ticket-card"]', title: 'Read the work', body: 'Each ticket keeps its priority, story, route, and claim state in one place.', optional: true },
  { id: 'new-ticket', target: '[data-tour="new-ticket"]', title: 'File a ticket', body: 'Add work here whenever it comes up. You can also press N.' },
  {
    id: 'ticket-dialog',
    target: '[data-tour="ticket-dialog"]',
    title: 'Shape the work',
    body: 'Give the ticket enough detail for someone to pick it up and finish it.',
    enter: (board) => { board.openDialog = 'create'; },
    exit: (board) => { board.openDialog = null; }
  },
  { id: 'notifications', target: '[data-tour="notifications"]', title: 'Catch up', body: 'Your inbox keeps comments, new tickets, and status changes together.' },
  { id: 'archive-toggle', target: '[data-tour="archive-toggle"]', title: 'See archived work', body: 'Open the archive when you need past tickets or boards without crowding the active view.' },
  { id: 'settings-trigger', target: '[data-tour="settings-trigger"]', title: 'Make it yours', body: 'Settings holds routing, categories, theme, and notification preferences.' },
  { id: 'finish', target: null, title: 'You’re set', body: 'Replay this tour from Settings or with the ? key whenever you need it.' }
];
