import type { Category, Health, JsonRecord, NotificationPayload, Project, RoutingCatalog, Story, Ticket } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Query = Record<string, string | number | boolean | undefined>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function path(segment: string) { return encodeURIComponent(segment); }
function query(values: Query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export class ApiClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(method: Method, pathname: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(pathname, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ApiError(response.status, payload.error || response.statusText);
    return payload;
  }

  health() { return this.request<Health>('GET', '/api/health'); }
  projects() { return this.request<{ projects: Project[] }>('GET', '/api/projects'); }
  archivedProjects() { return this.request<{ projects: Project[] }>('GET', '/api/projects/archived'); }
  archiveProject(slug: string) { return this.request<JsonRecord>('POST', `/api/projects/${path(slug)}/archive`); }
  unarchiveProject(slug: string) { return this.request<JsonRecord>('POST', `/api/projects/${path(slug)}/unarchive`); }
  deleteProject(slug: string) { return this.request<JsonRecord>('DELETE', `/api/projects/${path(slug)}`); }
  setProjectRouting(slug: string, routing: 'enabled' | 'disabled') { return this.request<JsonRecord>('PUT', `/api/projects/${path(slug)}/routing`, { routing }); }
  setProjectNotify(slug: string, on: boolean) { return this.request<JsonRecord>('PUT', `/api/projects/${path(slug)}/notify`, { on }); }

  stories(project: string = 'all') { return this.request<{ project: string; stories: Story[] }>('GET', `/api/stories${query({ project })}`); }
  createStory(body: JsonRecord) { return this.request<{ story: Story }>('POST', '/api/stories', { ...body, source: 'dashboard' }); }
  updateStory(id: string, project: string, body: JsonRecord) { return this.request<{ story: Story }>('PATCH', `/api/stories/${path(id)}${query({ project })}`, { ...body, source: 'dashboard' }); }
  deleteStory(id: string, project: string) { return this.request<JsonRecord>('DELETE', `/api/stories/${path(id)}${query({ project })}`); }

  categories(project: string = 'all') { return this.request<{ project: string; categories: Category[]; warnings: unknown[] }>('GET', `/api/categories${query({ project })}`); }
  draftCategory(sentence: string, project?: string) { return this.request<{ draft: JsonRecord }>('POST', '/api/categories/draft', { sentence, project }); }
  createCategory(body: JsonRecord) { return this.request<{ category: Category }>('POST', '/api/categories', { ...body, source: 'dashboard' }); }
  detachCategory(id: string, project: string) { return this.request<JsonRecord>('POST', `/api/categories/${path(id)}/detach`, { project, source: 'dashboard' }); }
  relinkCategory(id: string, project: string) { return this.request<JsonRecord>('POST', `/api/categories/${path(id)}/relink`, { project, source: 'dashboard' }); }
  updateCategory(id: string, project: string | undefined, body: JsonRecord) { return this.request<{ category: Category }>('PATCH', `/api/categories/${path(id)}${query({ project })}`, { ...body, source: 'dashboard' }); }
  deleteCategory(id: string, project?: string) { return this.request<JsonRecord>('DELETE', `/api/categories/${path(id)}${query({ project })}`); }
  routingFallback() { return this.request<{ fallback: JsonRecord; catalog: RoutingCatalog }>('GET', '/api/routing-fallback'); }
  setRoutingFallback(fallback: JsonRecord) { return this.request<{ fallback: JsonRecord; catalog: RoutingCatalog }>('PUT', '/api/routing-fallback', { fallback }); }
  routingModels(project?: string) { return this.request<RoutingCatalog>('GET', `/api/routing-models${query({ project })}`); }

  tickets(project: string = 'all', archived = false) { return this.request<{ project: string; tickets: Ticket[] }>('GET', `/api/tickets${query({ project, archived: archived || undefined })}`); }
  createTicket(body: JsonRecord) { return this.request<{ ticket: Ticket }>('POST', '/api/tickets', { ...body, source: 'dashboard' }); }
  updateTicket(id: string, project: string, body: JsonRecord) { return this.request<{ ticket: Ticket }>('PATCH', `/api/tickets/${path(id)}${query({ project })}`, { ...body, source: 'dashboard' }); }
  uploadAttachments(id: string, project: string, imagesData: { name: string; base64: string }[]) { return this.updateTicket(id, project, { imagesData }); }
  removeAttachments(id: string, project: string, removeAssets: string[]) { return this.updateTicket(id, project, { removeAssets }); }
  deleteTicket(id: string, project: string) { return this.request<JsonRecord>('DELETE', `/api/tickets/${path(id)}${query({ project })}`); }
  addComment(id: string, project: string, body: JsonRecord) { return this.request<JsonRecord>('POST', `/api/tickets/${path(id)}/comment${query({ project })}`, { by: 'you', ...body, source: 'dashboard' }); }
  setReminder(id: string, project: string, fireAt: string) { return this.request<JsonRecord>('POST', `/api/tickets/${path(id)}/reminder${query({ project })}`, { fireAt, source: 'dashboard' }); }
  cancelReminder(id: string, project: string) { return this.request<JsonRecord>('DELETE', `/api/tickets/${path(id)}/reminder${query({ project })}`); }
  linkTicket(id: string, project: string, verb: string, to: string) { return this.request<JsonRecord>('POST', `/api/tickets/${path(id)}/link${query({ project })}`, { verb, to, source: 'dashboard' }); }
  unlinkTicket(id: string, other: string, project: string) { return this.request<JsonRecord>('DELETE', `/api/tickets/${path(id)}/link/${path(other)}${query({ project })}`); }
  archiveTicket(id: string, project: string) { return this.request<JsonRecord>('POST', `/api/tickets/${path(id)}/archive${query({ project })}`, { source: 'dashboard' }); }
  unarchiveTicket(id: string, project: string) { return this.request<JsonRecord>('POST', `/api/tickets/${path(id)}/unarchive${query({ project })}`, { source: 'dashboard' }); }
  archiveDone(project: string = 'all') { return this.request<JsonRecord>('POST', `/api/archive-done${query({ project })}`, { source: 'dashboard' }); }

  notifications(values: Query = {}) { return this.request<NotificationPayload>('GET', `/api/notifications${query(values)}`); }
  markNotificationsRead(body: { id: string } | { all: true }) { return this.request<JsonRecord>('POST', '/api/notifications/read', body); }
  dismissNotification(id: string) { return this.request<JsonRecord>('DELETE', `/api/notifications/${path(id)}`); }
  notifyPrefs() { return this.request<{ prefs: JsonRecord }>('GET', '/api/notify-prefs'); }
  setNotifyPrefs(prefs: JsonRecord) { return this.request<{ prefs: JsonRecord }>('PUT', '/api/notify-prefs', prefs); }
  assetUrl(project: string, ticket: string, filename: string) { return `/api/asset/${path(project)}/${path(ticket)}/${path(filename)}`; }
}
