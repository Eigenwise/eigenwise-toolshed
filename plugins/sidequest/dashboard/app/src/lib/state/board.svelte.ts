import type { Snapshot, Ticket, Project, Story, Category, Notification, Scope, Status } from '../types';
import { ApiClient } from '../api';
import type { PollingController } from './polling';

const statusOrder: Status[] = ['todo', 'doing', 'done'];

export class BoardState {
  raw = $state.raw<Snapshot | null>(null);
  archivedProjects = $state.raw<Project[]>([]);
  archivedTickets = $state.raw<Ticket[]>([]);
  routingCatalog = $state.raw<Record<string, unknown>>({});
  notifyPreferences = $state.raw<Record<string, unknown>>({});

  selectedProject = $state<Scope>('all');
  view = $state<'board' | 'archive'>('board');
  priority = $state<'all' | 'urgent' | 'high' | 'normal' | 'low'>('all');
  assignee = $state<'all' | 'you' | 'agent' | 'unassigned'>('all');
  story = $state<string>('all');
  search = $state('');
  sort = $state<'manual' | 'priority' | 'latest' | 'newest'>('manual');
  inboxTab = $state<'all' | 'needs' | 'activity'>('all');
  openDialog = $state<string | null>(null);
  popover = $state<string | null>(null);
  dragging = $state(false);
  mutations = $state(0);
  offline = $state(false);
  reloadGuard = $state(false);
  healthIdentity = $state<string | null>(null);
  toasts = $state<string[]>([]);
  pendingSnapshot: Snapshot | null = null;
  controller: PollingController | null = null;

  currentProject = $derived(this.selectedProject === 'all' ? null : this.raw?.projects.find((project) => project.slug === this.selectedProject) ?? null);
  scopedTickets = $derived(this.raw?.tickets.filter((ticket) => this.selectedProject === 'all' || this.ticketProject(ticket) === this.selectedProject) ?? []);
  scopedStories = $derived(this.raw?.stories.filter((story) => this.selectedProject === 'all' || story.project === this.selectedProject) ?? []);
  visibleTickets = $derived.by(() => this.scopedTickets.filter((ticket) => this.matches(ticket)));
  columns = $derived.by(() => Object.fromEntries(statusOrder.map((status) => [status, this.sortTickets(this.visibleTickets.filter((ticket) => ticket.status === status))])) as Record<Status, Ticket[]>);
  counts = $derived.by(() => ({ todo: this.columns.todo.length, doing: this.columns.doing.length, done: this.columns.done.length }));
  unreadBuckets = $derived.by(() => {
    const notifications = this.raw?.notifications.notifications ?? [];
    return {
      all: notifications,
      needs: notifications.filter((notification) => notification.kind === 'question' || notification.kind === 'reminder'),
      activity: notifications.filter((notification) => notification.kind !== 'question' && notification.kind !== 'reminder')
    };
  });
  categoryGroups = $derived.by(() => (this.raw?.categories ?? []).reduce<Record<string, Category[]>>((groups, category) => {
    const key = category.enabled === false ? 'disabled' : 'enabled';
    (groups[key] ??= []).push(category);
    return groups;
  }, {}));

  constructor(api: ApiClient = new ApiClient()) { this.api = api; }

  api: ApiClient;

  applySnapshot(snapshot: Snapshot) {
    if (this.dragging || this.mutations > 0) {
      this.pendingSnapshot = snapshot;
      return;
    }
    this.raw = snapshot;
    this.offline = false;
    const identity = `${snapshot.health.version}|${snapshot.health.pid}|${snapshot.health.startedAt}`;
    if (this.healthIdentity && this.healthIdentity !== identity && !this.reloadGuard) {
      this.reloadGuard = true;
      this.toast('Sidequest updated. Reloading…');
      globalThis.location?.reload();
      return;
    }
    this.healthIdentity ??= identity;
  }

  flushPendingSnapshot() {
    if (this.pendingSnapshot && !this.dragging && this.mutations === 0) {
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.applySnapshot(snapshot);
    }
  }

  selectProject(project: Scope) { this.selectedProject = project; this.view = 'board'; }
  openArchive() { this.view = 'archive'; this.requestRefresh(); }
  closeArchive() { this.view = 'board'; }
  setDragging(value: boolean) { this.dragging = value; if (!value) this.flushPendingSnapshot(); }
  toast(message: string) { this.toasts = [...this.toasts, message]; }
  dismissToast(message: string) { this.toasts = this.toasts.filter((toast) => toast !== message); }
  async moveTicket(ticket: Ticket, status: Status) { await this.mutate(() => this.api.updateTicket(ticket.id, this.ticketProject(ticket), { status, order: Date.now(), source: 'dashboard' })); }
  async markNotificationsRead(body: { id: string } | { all: true }) { await this.mutate(() => this.api.markNotificationsRead(body)); }
  async scheduleReminder(ticket: Ticket, fireAt: string) { await this.mutate(() => this.api.setReminder(ticket.id, this.ticketProject(ticket), fireAt)); }
  async createTicket(body: Record<string, unknown>) { await this.mutate(() => this.api.createTicket({ ...body, source: 'dashboard' })); }
  async patchTicket(ticket: Ticket, body: Record<string, unknown>) { await this.mutate(() => this.api.updateTicket(ticket.id, this.ticketProject(ticket), { ...body, source: 'dashboard' })); }
  async mutateCategory(action: () => Promise<unknown>) { await this.mutate(action); }

  private async mutate(action: () => Promise<unknown>) {
    this.mutations += 1;
    try { await action(); }
    catch (error) { this.toast(error instanceof Error ? error.message : 'The change failed.'); throw error; }
    finally { this.mutations -= 1; this.flushPendingSnapshot(); this.requestRefresh(); }
  }

  private requestRefresh() { this.controller?.refresh(); }
  private ticketProject(ticket: Ticket) { return String(ticket.projectSlug ?? ticket.project ?? this.selectedProject); }
  private matches(ticket: Ticket) {
    const needle = this.search.trim().toLowerCase();
    const text = [ticket.ref, ticket.title, ticket.description, ...(ticket.labels ?? [])].join(' ').toLowerCase();
    if (needle && !text.includes(needle)) return false;
    if (this.priority !== 'all' && ticket.priority !== this.priority) return false;
    if (this.story !== 'all' && ticket.storyId !== this.story) return false;
    return true;
  }
  private sortTickets(tickets: Ticket[]) {
    const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...tickets].sort((left, right) => {
      if (this.sort === 'priority') return (priority[left.priority ?? 'normal'] - priority[right.priority ?? 'normal']) || ((right.order ?? 0) - (left.order ?? 0));
      if (this.sort === 'latest') return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')) || ((right.order ?? 0) - (left.order ?? 0));
      if (this.sort === 'newest') return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || ((right.order ?? 0) - (left.order ?? 0));
      return (right.order ?? 0) - (left.order ?? 0);
    });
  }
}
