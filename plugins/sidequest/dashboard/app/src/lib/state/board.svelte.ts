import { SvelteSet } from 'svelte/reactivity';
import type { Snapshot, Ticket, Project, Story, Category, Notification, Scope, Status, JsonRecord, RoutingCatalog } from '../types';
import { ApiClient } from '../api';
import type { PollingController } from './polling';

const statusOrder: Status[] = ['todo', 'doing', 'done'];
type AssigneeFilter = 'all' | 'you' | 'agent' | 'unassigned';
type NotificationKind = 'question' | 'comment' | 'created' | 'status';

export interface LightboxSelection {
  project: string;
  ticket: string;
  filename: string;
  src: string;
}

export interface DesktopNotificationEvent {
  key: string;
  ticket: Ticket;
  kind: NotificationKind;
}

export class BoardState {
  raw = $state.raw<Snapshot | null>(null);
  archivedProjects = $state.raw<Project[]>([]);
  archivedTickets = $state.raw<Ticket[]>([]);
  routingCatalog = $state.raw<RoutingCatalog>({});
  notifyPreferences = $state.raw<JsonRecord>({});

  selectedProject = $state<Scope>('all');
  view = $state<'board' | 'archive'>('board');
  priority = $state<'all' | 'urgent' | 'high' | 'normal' | 'low'>('all');
  assignee = $state<AssigneeFilter>('all');
  story = $state<string>('all');
  search = $state('');
  sort = $state<'manual' | 'priority' | 'latest' | 'newest'>('manual');
  inboxTab = $state<'all' | 'needs' | 'activity'>('all');
  openDialog = $state<string | null>(null);
  popover = $state<string | null>(null);
  lightbox = $state<LightboxSelection | null>(null);
  desktopNotificationEvents = $state<DesktopNotificationEvent[]>([]);
  desktopNotificationPermission = $state<'unsupported' | 'default' | 'granted' | 'denied'>('default');
  dragging = $state(false);
  mutations = $state(0);
  offline = $state(false);
  reloadGuard = $state(false);
  healthIdentity = $state<string | null>(null);
  toasts = $state<string[]>([]);
  pendingSnapshot: Snapshot | null = null;
  controller: PollingController | null = null;
  private notificationEventKeys: SvelteSet<string> | null = null;
  private dialogSaveAction: (() => Promise<void>) | null = null;

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
    this.recordDesktopNotificationEvents(snapshot.tickets);
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
  openLightbox(selection: LightboxSelection) { this.lightbox = selection; this.popover = 'lightbox'; }
  selectLightboxImage(ticket: Ticket, filename: string) { this.openLightbox({ project: this.ticketProject(ticket), ticket: ticket.id, filename, src: this.api.assetUrl(this.ticketProject(ticket), ticket.id, filename) }); }
  closeLightbox() { this.lightbox = null; if (this.popover === 'lightbox') this.popover = null; }
  setDesktopNotificationPermission(permission: 'unsupported' | 'default' | 'granted' | 'denied') { this.desktopNotificationPermission = permission; }
  takeDesktopNotificationEvents() { const events = this.desktopNotificationEvents; this.desktopNotificationEvents = []; return events; }
  setDialogSaveAction(action: (() => Promise<void>) | null) { this.dialogSaveAction = action; }
  async saveDialogFromShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'key' | 'preventDefault'>) {
    if (!this.openDialog || !this.dialogSaveAction || !(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return false;
    event.preventDefault();
    await this.dialogSaveAction();
    return true;
  }

  async moveTicket(ticket: Ticket, status: Status) { await this.mutate(() => this.api.updateTicket(ticket.id, this.ticketProject(ticket), { status, order: Date.now(), source: 'dashboard' })); }
  async createTicket(body: JsonRecord) { return this.mutate(() => this.api.createTicket({ ...body, source: 'dashboard' })); }
  async patchTicket(ticket: Ticket, body: JsonRecord) { return this.mutate(() => this.api.updateTicket(ticket.id, this.ticketProject(ticket), { ...body, source: 'dashboard' })); }
  async autosaveTicket(ticket: Ticket, body: JsonRecord) { return this.patchTicket(ticket, body); }
  async deleteTicket(ticket: Ticket) { await this.mutate(() => this.api.deleteTicket(ticket.id, this.ticketProject(ticket))); }
  async archiveTicket(ticket: Ticket) { await this.mutate(() => this.api.archiveTicket(ticket.id, this.ticketProject(ticket))); }
  async restoreTicket(ticket: Ticket) { await this.mutate(() => this.api.unarchiveTicket(ticket.id, this.ticketProject(ticket))); }
  async archiveDone(project: Scope = this.selectedProject) { await this.mutate(() => this.api.archiveDone(project)); }
  async addComment(ticket: Ticket, body: string) { await this.mutate(() => this.api.addComment(ticket.id, this.ticketProject(ticket), { body, kind: 'comment' })); }
  async askQuestion(ticket: Ticket, body: string) { await this.mutate(() => this.api.addComment(ticket.id, this.ticketProject(ticket), { body, kind: 'question' })); }
  async scheduleReminder(ticket: Ticket, fireAt: string) { await this.mutate(() => this.api.setReminder(ticket.id, this.ticketProject(ticket), fireAt)); }
  async cancelReminder(ticket: Ticket) { await this.mutate(() => this.api.cancelReminder(ticket.id, this.ticketProject(ticket))); }
  async linkTicket(ticket: Ticket, verb: string, to: string) { await this.mutate(() => this.api.linkTicket(ticket.id, this.ticketProject(ticket), verb, to)); }
  async unlinkTicket(ticket: Ticket, other: string) { await this.mutate(() => this.api.unlinkTicket(ticket.id, other, this.ticketProject(ticket))); }
  async uploadAttachments(ticket: Ticket, imagesData: { name: string; base64: string }[]) { return this.mutate(() => this.api.uploadAttachments(ticket.id, this.ticketProject(ticket), imagesData)); }
  async removeAttachment(ticket: Ticket, filename: string) { return this.mutate(() => this.api.removeAttachments(ticket.id, this.ticketProject(ticket), [filename])); }

  async archiveProject(project: Project | string) { await this.mutate(() => this.api.archiveProject(this.projectSlug(project))); }
  async restoreProject(project: Project | string) { await this.mutate(() => this.api.unarchiveProject(this.projectSlug(project))); }
  async deleteProject(project: Project | string) { await this.mutate(() => this.api.deleteProject(this.projectSlug(project))); }
  async setProjectRouting(project: Project | string, routing: 'enabled' | 'disabled') { await this.mutate(() => this.api.setProjectRouting(this.projectSlug(project), routing)); }
  async setProjectMuted(project: Project | string, muted: boolean) { await this.mutate(() => this.api.setProjectNotify(this.projectSlug(project), !muted)); }
  async setNotifyPreferences(prefs: JsonRecord) { const result = await this.mutate(() => this.api.setNotifyPrefs(prefs)); this.notifyPreferences = result.prefs; return result; }

  async createStory(body: JsonRecord) { const result = await this.mutate(() => this.api.createStory(body)); return result.story; }
  async updateStory(story: Story, project: string, body: JsonRecord) { const result = await this.mutate(() => this.api.updateStory(story.id, project, body)); return result.story; }
  async deleteStory(story: Story, project: string) { await this.mutate(() => this.api.deleteStory(story.id, project)); }
  async createStoryAndAssign(ticket: Ticket, body: JsonRecord) {
    return this.mutate(async () => {
      const result = await this.api.createStory(body);
      await this.api.updateTicket(ticket.id, this.ticketProject(ticket), { storyId: result.story.id, source: 'dashboard' });
      return result.story;
    });
  }

  draftCategory(sentence: string, project: string | undefined = this.categoryProject()) { return this.api.draftCategory(sentence, project); }
  async createCategory(body: JsonRecord) { const result = await this.mutate(() => this.api.createCategory(body)); return result.category; }
  async updateCategory(category: Category, body: JsonRecord, project: string | undefined = this.categoryProject()) { const result = await this.mutate(() => this.api.updateCategory(category.id, project, body)); return result.category; }
  async disableCategory(category: Category, project: string = this.requiredCategoryProject()) { const result = await this.mutate(() => this.api.updateCategory(category.id, project, { disable: true })); return result.category; }
  async detachCategory(category: Category, project: string = this.requiredCategoryProject()) { await this.mutate(() => this.api.detachCategory(category.id, project)); }
  async relinkCategory(category: Category, project: string = this.requiredCategoryProject()) { await this.mutate(() => this.api.relinkCategory(category.id, project)); }
  async deleteCategory(category: Category, project: string | undefined = this.categoryProject()) { await this.mutate(() => this.api.deleteCategory(category.id, project)); }
  async setGlobalFallback(fallback: JsonRecord) { const result = await this.mutate(() => this.api.setRoutingFallback(fallback)); this.routingCatalog = result.catalog; return result.fallback; }
  async mutateCategory(action: () => Promise<unknown>) { return this.mutate(action); }

  async markNotificationsRead(body: { id: string } | { all: true }) { await this.mutate(() => this.api.markNotificationsRead(body)); }
  async dismissNotification(notification: Notification | string) { await this.mutate(() => this.api.dismissNotification(typeof notification === 'string' ? notification : notification.id)); }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    this.mutations += 1;
    try { return await action(); }
    catch (error) { this.toast(error instanceof Error ? error.message : 'The change failed.'); throw error; }
    finally { this.mutations -= 1; this.flushPendingSnapshot(); this.requestRefresh(); }
  }

  private requestRefresh() { this.controller?.refresh(); }
  private ticketProject(ticket: Ticket) { return String(ticket.projectSlug ?? ticket.project ?? this.selectedProject); }
  private projectSlug(project: Project | string) { return typeof project === 'string' ? project : project.slug; }
  private categoryProject() { return this.selectedProject === 'all' ? undefined : this.selectedProject; }
  private requiredCategoryProject() {
    const project = this.categoryProject();
    if (!project) throw new Error('Select a board first.');
    return project;
  }
  private matches(ticket: Ticket) {
    const needle = this.search.trim().toLowerCase();
    const text = [ticket.ref, ticket.title, ticket.description, ...(ticket.labels ?? [])].join(' ').toLowerCase();
    if (needle && !text.includes(needle)) return false;
    if (this.priority !== 'all' && ticket.priority !== this.priority) return false;
    if (this.assignee === 'you' && !this.isAssignedToYou(ticket)) return false;
    if (this.assignee === 'agent' && !this.isAgentHeld(ticket)) return false;
    if (this.assignee === 'unassigned' && (this.isAssignedToYou(ticket) || this.isAgentHeld(ticket))) return false;
    if (this.story === 'none' ? Boolean(ticket.storyId) : this.story !== 'all' && ticket.storyId !== this.story) return false;
    return true;
  }
  private isAssignedToYou(ticket: Ticket) { return String(ticket.assignee ?? '').toLowerCase() === 'you'; }
  private isAgentHeld(ticket: Ticket) {
    const claim = ticket.claim as { by?: unknown; at?: unknown } | undefined;
    if (claim?.by && !this.isStaleClaim(claim.at)) return true;
    const assignee = String(ticket.assignee ?? '');
    return Boolean(assignee) && assignee.toLowerCase() !== 'you';
  }
  private isStaleClaim(value: unknown) {
    const at = Date.parse(String(value ?? ''));
    return !Number.isFinite(at) || Date.now() - at > 60 * 60 * 1000;
  }
  private recordDesktopNotificationEvents(tickets: Ticket[]) {
    const keys = tickets.map((ticket) => this.notificationEventKey(ticket));
    if (!this.notificationEventKeys) {
      this.notificationEventKeys = new SvelteSet(keys);
      return;
    }
    const events = tickets.flatMap((ticket) => {
      const key = this.notificationEventKey(ticket);
      if (this.notificationEventKeys?.has(key)) return [];
      this.notificationEventKeys?.add(key);
      const kind = this.notificationKind(ticket);
      return kind && this.canNotify(ticket, kind) ? [{ key, ticket, kind }] : [];
    });
    if (events.length) this.desktopNotificationEvents = [...this.desktopNotificationEvents, ...events];
    if (this.notificationEventKeys.size > 4000) this.notificationEventKeys = new SvelteSet(keys);
  }
  private notificationEventKey(ticket: Ticket) { return `${ticket.id}|${ticket.updatedAt ?? ''}`; }
  private notificationKind(ticket: Ticket): NotificationKind | null {
    const kind = ticket.lastEventType;
    return kind === 'question' || kind === 'comment' || kind === 'created' || kind === 'status' ? kind : null;
  }
  private canNotify(ticket: Ticket, kind: NotificationKind) {
    return ticket.source !== 'dashboard' && this.notifyPreferences[kind] !== false;
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
