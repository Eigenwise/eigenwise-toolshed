import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSubagent } from './input.js';
import { runtimeModule } from './paths.js';

const CLOSED_TICKETS_THRESHOLD = 3;
const TRANSCRIPT_BYTES_THRESHOLD = 3 * 1024 * 1024;
const RETRY_MULTIPLIER = 2;

interface CompactionState {
  resetAt: string;
  ticketBaselineAt: string;
  transcriptBytes: number;
  suggestedAt?: string;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  listTickets: (slug: string) => any[];
  worktreeGcTickets: () => Array<{ project?: string; ref?: string; claimLive?: boolean }>;
}

function disabledValue(value: unknown): boolean {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

export function compactionSuggestionsEnabled(): boolean {
  return !disabledValue(process.env.SIDEQUEST_COMPACTION_SUGGESTIONS);
}

export function isPrimarySession(input: Record<string, unknown>): boolean {
  return !isSubagent(input);
}

function stateDirectory(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'compaction-suggestions');
}

function stateFile(sessionId: string): string {
  return path.join(stateDirectory(), `${encodeURIComponent(sessionId)}.json`);
}

function transcriptBytes(transcriptPath: unknown): number {
  try {
    return fs.statSync(String(transcriptPath || '')).size;
  } catch (_) {
    return 0;
  }
}

function readState(sessionId: string, currentBytes: number): CompactionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8')) as CompactionState;
    if (parsed && Number.isFinite(parsed.transcriptBytes) && Number.isFinite(Date.parse(parsed.resetAt))) {
      return { ...parsed, ticketBaselineAt: parsed.ticketBaselineAt || parsed.resetAt };
    }
  } catch (_) {}
  const now = new Date().toISOString();
  return { resetAt: now, ticketBaselineAt: now, transcriptBytes: currentBytes };
}

function writeState(sessionId: string, state: CompactionState): boolean {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}

export function initializeCompactionState(sessionId: string, transcriptPath: unknown): void {
  if (!sessionId || !compactionSuggestionsEnabled()) return;
  const file = stateFile(sessionId);
  if (fs.existsSync(file)) return;
  const now = new Date().toISOString();
  writeState(sessionId, { resetAt: now, ticketBaselineAt: now, transcriptBytes: transcriptBytes(transcriptPath) });
}

export function resetCompactionState(sessionId: string, transcriptPath: unknown): void {
  if (!sessionId) return;
  const now = new Date().toISOString();
  writeState(sessionId, { resetAt: now, ticketBaselineAt: now, transcriptBytes: transcriptBytes(transcriptPath) });
}

function completionAt(ticket: any): number {
  const values = [ticket?.submission?.integratedAt, ticket?.completion?.at, ticket?.updatedAt];
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function versionFor(ticket: any): string {
  const text = Array.isArray(ticket?.comments) ? ticket.comments.map((comment: any) => String(comment?.body || '')).join('\n') : '';
  const matched = text.match(/\b(?:sidequest|release)\s+v?(\d+\.\d+\.\d+)\b/i);
  if (matched?.[1]) return `v${matched[1]}`;
  const commit = String(ticket?.submission?.commit || '').trim();
  return commit ? commit.slice(0, 10) : 'closed';
}

function recentlyClosed(tickets: any[], resetAt: string): any[] {
  const since = Date.parse(resetAt);
  return tickets.filter((ticket) => ticket?.status === 'done' && completionAt(ticket) >= since);
}

function closedAfter(tickets: any[], baselineAt: string): any[] {
  const since = Date.parse(baselineAt);
  return tickets.filter((ticket) => ticket?.status === 'done' && completionAt(ticket) > since);
}

function activeBoardWork(tickets: any[], liveClaimRefs: Set<string>): boolean {
  return tickets.some((ticket) => {
    if (ticket?.status === 'doing' && liveClaimRefs.has(ticket.ref)) return true;
    return Boolean(ticket?.dispatch && !ticket.dispatch.terminalAt);
  });
}

function projectFor(cwd: string): { slug: string; path: string } | null {
  try {
    const store = require(runtimeModule('store')) as Store;
    const found = store.findProject(store.nearestRepoRoot(cwd));
    if (!found.ok || !found.slug || !found.meta?.path) return null;
    return { slug: found.slug, path: found.meta.path };
  } catch (_) {
    return null;
  }
}

async function publishLockHeld(repoPath: string): Promise<boolean> {
  try {
    const publish = require(runtimeModule('publish')) as { publishLockStatus: (path: string) => Promise<{ locked?: boolean }> };
    return Boolean((await publish.publishLockStatus(repoPath)).locked);
  } catch (_) {
    return false;
  }
}

function byteLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function compactedRefs(tickets: any[]): string {
  return tickets.slice(0, 5).map((ticket) => `${ticket.ref} (${versionFor(ticket)})`).join(', ') + (tickets.length > 5 ? `, +${tickets.length - 5} more` : '');
}

export async function compactionSuggestion(input: Record<string, unknown>): Promise<string | null> {
  if (!compactionSuggestionsEnabled() || !isPrimarySession(input)) return null;
  const sessionId = String(input.session_id || input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (!sessionId) return null;

  const currentBytes = transcriptBytes(input.transcript_path || input.transcriptPath);
  const state = readState(sessionId, currentBytes);
  const project = projectFor(String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  if (!project) return null;

  try {
    const store = require(runtimeModule('store')) as Store;
    const tickets = store.listTickets(project.slug);
    const liveClaimRefs = new Set(store.worktreeGcTickets()
      .filter((ticket) => ticket.project === project.slug && ticket.claimLive && ticket.ref)
      .map((ticket) => String(ticket.ref)));
    if (activeBoardWork(tickets, liveClaimRefs) || await publishLockHeld(project.path)) return null;

    const closed = recentlyClosed(tickets, state.resetAt);
    const newlyClosed = closedAfter(tickets, state.ticketBaselineAt);
    const growth = Math.max(0, currentBytes - state.transcriptBytes);
    const multiplier = state.suggestedAt ? RETRY_MULTIPLIER : 1;
    const enoughClosed = newlyClosed.length >= CLOSED_TICKETS_THRESHOLD * multiplier;
    const enoughTranscript = growth >= TRANSCRIPT_BYTES_THRESHOLD * multiplier;
    if (!enoughClosed && !enoughTranscript) return null;

    const now = new Date().toISOString();
    state.suggestedAt = now;
    state.ticketBaselineAt = now;
    state.transcriptBytes = currentBytes;
    if (!writeState(sessionId, state)) return null;
    const accumulated = [
      closed.length ? `Closed/shipped: ${compactedRefs(closed)}.` : '',
      growth ? `Transcript growth: ${byteLabel(growth)}.` : '',
    ].filter(Boolean).join(' ');
    // This fires on Stop, i.e. exactly when a model is deciding whether it is done, so it
    // says outright that it is not a stop signal. "Safe at this boundary" used to read as
    // "here is a good place to finish".
    return [
      'sidequest: compaction checkpoint, not a stopping point. Keep working; summarization is how a long session continues.',
      accumulated,
      'Safe to lose: closed-ticket screenshots, CI output, superseded tool results.',
      'Keep: open ticket specs and board decisions. Run /compact whenever it suits.',
    ].join('\n');
  } catch (_) {
    return null;
  }
}
