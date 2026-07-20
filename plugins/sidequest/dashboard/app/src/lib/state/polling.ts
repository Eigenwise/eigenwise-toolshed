import type { BoardState } from './board.svelte';
import type { Snapshot } from '../types';

const POLL_MS = 2_500;

export class PollingController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private queued = false;

  constructor(private readonly state: BoardState) {}

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    return () => this.stop();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh() {
    if (this.inFlight) { this.queued = true; return; }
    void this.run();
  }

  private async run() {
    this.inFlight = true;
    try {
      const [projects, tickets, stories, categories, notifications, health] = await Promise.all([
        this.state.api.projects(),
        this.state.api.tickets('all'),
        this.state.api.stories('all').catch(() => ({ project: 'all', stories: this.state.raw?.stories ?? [] })),
        this.state.api.categories(this.state.selectedProject).catch(() => ({ project: this.state.selectedProject, categories: this.state.raw?.categories ?? [], warnings: [] })),
        this.state.api.notifications({ limit: 50 }).catch(() => this.state.raw?.notifications ?? { notifications: [], unread: 0, unreadNeeds: 0 }),
        this.state.api.health().catch(() => this.state.raw?.health ?? null)
      ]);
      if (!health) return;
      const snapshot: Snapshot = { projects: projects.projects, tickets: tickets.tickets, stories: stories.stories, categories: categories.categories, notifications, health };
      this.state.applySnapshot(snapshot);
      if (this.state.view === 'archive') this.state.archivedTickets = (await this.state.api.tickets(this.state.selectedProject, true)).tickets;
    } catch (error) {
      this.state.offline = true;
      this.state.toast(error instanceof Error ? error.message : 'Unable to refresh Sidequest.');
    } finally {
      this.inFlight = false;
      if (this.queued) { this.queued = false; this.refresh(); }
    }
  }
}
