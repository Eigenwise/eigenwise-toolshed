export type Status = 'todo' | 'doing' | 'done';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type Scope = 'all' | string;

export interface Project {
  slug: string;
  name: string;
  path?: string;
  archived?: number;
  archivedAt?: string | null;
  routing?: 'enabled' | 'disabled';
  notify?: boolean;
  counts?: { todo: number; doing: number; done: number };
  [key: string]: unknown;
}

export interface Claim {
  by?: string;
  at?: string;
  idleMs?: number | null;
  reclaimable?: string | null;
}

export interface Ticket {
  id: string;
  ref: string;
  project?: string;
  projectSlug?: string;
  title: string;
  /** Only on the full ticket from `ApiClient.ticket`; list rows carry `summary`. */
  description?: string;
  summary?: string;
  commentCount?: number;
  status: Status;
  priority?: Priority;
  labels?: string[];
  order?: number;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  archived?: boolean;
  claim?: Claim;
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

export type CompletionStage =
  | 'proposed' | 'blocked' | 'ready' | 'running' | 'submitted' | 'integrating'
  | 'rejected' | 'integrated' | 'released' | 'closed' | 'abandoned';
export type EvidenceKind =
  | 'captured-command' | 'mocked-test' | 'real-flow' | 'visual' | 'source-review'
  | 'agent-reported' | 'waived' | 'unavailable';
export type QualityStatus = 'measured-pass' | 'measured-fail' | 'unverified' | 'not-measured' | 'none';
export interface CompletionBlocker { reason: string; actor: 'executor' | 'orchestrator' | 'user' | 'board' | 'dependency'; nextAction: string; refs?: string[]; }
export interface CompletionFacts {
  submission: { commit: string; at: string; by: string } | null;
  delivery: { commit: string; branch: string; head: string; at: string; method: 'merge' | 'apply' | 'replay' | 'manual' } | null;
  verify: { status: 'passed' | 'failed' | 'skipped' | 'waived' | 'manual' | 'unavailable'; command: string | null; logPath: string | null; kinds: EvidenceKind[] } | null;
  quality: { status: QualityStatus; detail: string | null };
  negativeControl: { kind: string; evidence: 'captured' | 'agent-reported' | 'waived' | 'missing' };
  review: { bound: boolean; verdict: string | null; by: string | null } | null;
  release: { version: string | null; evidence: 'release-record' | 'none' };
  candidateChanged: boolean;
}
export interface CompletionSummary { version: 1; result: string; checked: string; uncertain: string; action: string; by: string; at: string; candidate: string | null; stale: boolean; }
export interface CompletionEvidence { kind: EvidenceKind; path: string; label: string; }
/** Mirrors `CompletionView` in `src/lib/store/completion.ts`; served by GET /api/tickets/:id/completion. */
export interface CompletionView { ref: string; title: string; stage: CompletionStage; blocker: CompletionBlocker | null; facts: CompletionFacts; summary: CompletionSummary | null; evidence: CompletionEvidence[]; text: string; }
/** The story form `storyCompletionPayload` returns; served by GET /api/stories/:id/completion when the store has it. */
export interface StoryCompletionView {
  ref: string;
  title: string;
  stage: CompletionStage | 'partial';
  blocker: CompletionBlocker | null;
  children: CompletionView[];
  integrated: string[];
  notYet: { ref: string; stage: string }[];
  uncertainties: string[];
  decisions: { count: number; latest: string | null };
  text: string;
}
export interface StoryCompletionRead { available: boolean; completion: StoryCompletionView | null; }
