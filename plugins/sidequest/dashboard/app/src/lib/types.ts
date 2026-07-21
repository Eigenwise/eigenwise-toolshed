export type Status = 'todo' | 'doing' | 'done';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type Scope = 'all' | string;

export interface Project {
  slug: string;
  name: string;
  path?: string;
  archived?: boolean;
  routing?: 'enabled' | 'disabled';
  notify?: boolean;
  [key: string]: unknown;
}

export interface Ticket {
  id: string;
  ref: string;
  project?: string;
  projectSlug?: string;
  title: string;
  description?: string;
  status: Status;
  priority?: Priority;
  labels?: string[];
  order?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  archived?: boolean;
  [key: string]: unknown;
}

export interface Story { id: string; ref?: string; project?: string; title: string; color?: string; ticketCount?: number; [key: string]: unknown; }
export interface Category { id: string; name: string; enabled?: boolean; usageCount?: number; origin?: 'profile' | 'override' | 'detached' | 'added' | 'disabled'; baseProfileId?: string | null; layer?: { kind: 'ADD' | 'OVERRIDE' | 'DETACH' | 'DISABLE'; [key: string]: unknown }; [key: string]: unknown; }
export interface RoutingProfile { id: string; name: string; description?: string; revision: number; entryCount: number; retiredAt?: string | null; [key: string]: unknown; }
export interface RoutingPreview { project: string; from: RoutingProfile; to: RoutingProfile; drift: { changed: string[]; missing: string[]; added: string[] }; addCollisions: string[]; foreignBase: { id: string; baseProfileId: string; profileId: string; kind: string }[]; preparedDispatches: { id: string; ref: string; title: string }[]; }
export interface Notification { id: string; kind: string; read?: boolean; ticketId?: string; projectSlug?: string; [key: string]: unknown; }
export interface Health { ok: true; name: string; pid: number; startedAt: string; version: string; }
export interface NotificationPayload { notifications: Notification[]; unread: number; unreadNeeds: number; }
export interface Snapshot { projects: Project[]; tickets: Ticket[]; stories: Story[]; categories: Category[]; notifications: NotificationPayload; health: Health; }
export interface RoutingCatalog { categoryDraftAvailable?: boolean; [key: string]: unknown; }
export type JsonRecord = Record<string, unknown>;
