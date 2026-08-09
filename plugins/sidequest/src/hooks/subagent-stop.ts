#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'read_only_codex_dispatch' | 'read_only_claude_builtin' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}
interface Claim {
  status?: string;
  slug: string;
  ticketId: string;
  by?: string;
  held?: boolean;
  at?: string;
  ref?: string;
  effort?: string;
}
interface TicketComment {
  kind?: string;
  by?: string;
  body?: string;
  at?: string;
}
interface Ticket {
  ref: string;
  status?: string;
  comments?: TicketComment[];
  files?: string[];
  claim?: { by?: string; verification?: { startedAt?: string; command?: string } } | null;
  checkpoint?: { id?: string; commit?: string; at?: string } | null;
  dispatch?: { outcome?: string; terminalAt?: string; terminalSource?: string; turnEndedAt?: string; worktree?: string };
  submission?: { commit?: string; integratedAt?: string; unscopedPaths?: string[] };
  effort?: string;
}
interface SubmissionReadiness {
  ok: boolean;
  unscopedPaths?: string[];
}
interface Store {
  getTicket: (slug: string, ticketId: string) => Ticket | null;
  claimActivityMs: (ticket?: Ticket) => number;
  submissionReadiness: (submission?: Ticket['submission']) => SubmissionReadiness;
  markDispatchStopped: (sessionId: string, executor: string, agentId: string | null, agentName: string | null) => {
    ok?: boolean;
    stopped?: boolean;
    tickets?: Ticket[];
  };
  sessionClaims: (sessionId: string, options: Record<string, unknown>) => Claim[];
  markLongRunFlagged: (sessionId: string, slug: string, ticketId: string, at?: string) => boolean;
}

function fallbackClassify(type: string): ExecutorClassification {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (readOnlyDispatch) return { kind: 'read_only_codex_dispatch', effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: 'read_only_claude_builtin', effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch(?:-(low|medium|high|xhigh|max))?$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

function thresholdMs(effort: unknown): number {
  const raw = process.env.SIDEQUEST_LONG_RUN_MIN;
  const configured = raw != null && raw.trim() !== '' ? Number(raw) : Number.NaN;
  const defaults: Record<string, number> = { low: 10, medium: 15, high: 25, xhigh: 40 };
  const minutes = Number.isFinite(configured) && configured > 0
    ? configured
    : defaults[String(effort || '').trim().toLowerCase()] || 15;
  return minutes * 60 * 1000;
}

function doneComment(ticket: Ticket, by?: string): TicketComment | null {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  return comments.slice().reverse().find((comment) =>
    comment.kind === 'comment' && (!by || comment.by === by) && /\b(done|shipped|commit)\b/i.test(String(comment.body || '')),
  ) || null;
}

function commitHash(comment: TicketComment | null): string | null {
  const match = comment && String(comment.body || '').match(/\b[0-9a-f]{7,40}\b/i);
  return match ? match[0] || null : null;
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function diedVerdict(store: Store, claim: Claim, ticket: Ticket | null): string {
  const label = ticket?.ref || claim.ref || claim.ticketId || 'a ticket';
  const activityMs = ticket ? store.claimActivityMs(ticket) : Date.parse(claim.at || '');
  const quietSince = Number.isFinite(activityMs) ? new Date(activityMs).toISOString() : 'unknown';
  const checkpoint = ticket?.checkpoint;
  const checkpointLabel = checkpoint?.id ? compactText(checkpoint.id, 28) : 'none';
  const commit = checkpoint?.commit ? compactText(checkpoint.commit, 12) : 'none';
  const holder = ticket?.claim?.by || claim.by;
  const comment = (Array.isArray(ticket?.comments) ? ticket.comments : []).slice().reverse()
    .find((entry) => !holder || entry.by === holder);
  const commentLabel = comment?.body ? `"${compactText(comment.body, 64)}"` : 'none';
  const diedAt = ticket?.dispatch?.terminalAt || new Date().toISOString();
  const worktree = ticket?.dispatch?.worktree ? `; worktree ${ticket.dispatch.worktree}` : '';
  return `exec DIED: ${label} at ${diedAt}; board quiet since ${quietSince}; checkpoint ${checkpointLabel}; commit ${commit}; comment ${commentLabel}${worktree}. Next: recover the worktree diff, or release + fresh dispatch.`;
}

function submissionVerdict(store: Store, ticket: Ticket): string | null {
  const submission = ticket?.submission;
  if (!submission?.commit || submission.integratedAt) return null;
  const readiness = store.submissionReadiness(submission);
  if (!readiness.ok) {
    return `exec FINISHED with PARTIAL_SUBMISSION: ${ticket.ref} has scope-gated paths (${(readiness.unscopedPaths || []).join(', ')}); do not integrate it`;
  }
  return `exec FINISHED: ${ticket.ref} READY_FOR_INTEGRATION (${submission.commit.slice(0, 12)}); run the publish transaction (references/publishing.md). The terminal board state is authoritative; do not TaskStop, redispatch, or investigate a contradictory task notification.`;
}

function terminalDispatchVerdict(store: Store, tickets: Ticket[]): string | null {
  for (const ticket of tickets) {
    const submissionVerdictText = submissionVerdict(store, ticket);
    if (submissionVerdictText) return submissionVerdictText;
    if (ticket?.dispatch?.terminalAt && ticket.dispatch.outcome === 'released') {
      return `exec FINISHED after terminal release: ${ticket.ref}. The terminal board state is authoritative; do not TaskStop, redispatch, or investigate a contradictory task notification.`;
    }
    if (!ticket || ticket.status !== 'done') continue;
    const comment = doneComment(ticket);
    if (!comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash
      ? ' done WITHOUT commit hash'
      : ` done${hash ? ` (${hash})` : ''}`;
    return `exec FINISHED: ${ticket.ref}${suffix}; review the recorded board result. The terminal board state is authoritative; do not TaskStop, redispatch, or investigate a contradictory task notification.`;
  }
  return null;
}

function stopVerdict(
  store: Store,
  claims: Claim[],
  classification: ExecutorClassification,
  dispatchStopped: boolean,
  terminalTickets: Ticket[],
): string | null {
  for (const claim of claims) {
    if (!claim || claim.status !== 'done') continue;
    const ticket = store.getTicket(claim.slug, claim.ticketId);
    const comment = ticket && doneComment(ticket, claim.by);
    if (!ticket || !comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash
      ? ' done WITHOUT commit hash'
      : ` done${hash ? ` (${hash})` : ''}`;
    return `exec FINISHED: ${ticket.ref}${suffix}; review the recorded board result. The terminal board state is authoritative; do not TaskStop, redispatch, or investigate a contradictory task notification.`;
  }

  for (const claim of claims) {
    if (!claim || claim.held) continue;
    let ticket: Ticket | null = null;
    try {
      ticket = store.getTicket(claim.slug, claim.ticketId);
    } catch (_) {
      continue;
    }
    const submissionVerdictText = ticket && submissionVerdict(store, ticket);
    if (!submissionVerdictText) continue;
    return submissionVerdictText;
  }

  const terminal = terminalDispatchVerdict(store, terminalTickets);
  if (terminal) return terminal;

  const held = claims.find((claim) => claim && claim.held && claim.status === 'doing');
  if (held) {
    let ticket: Ticket | null = null;
    try {
      ticket = store.getTicket(held.slug, held.ticketId);
    } catch (_) {}
    const label = held.ref || held.ticketId || 'a ticket';
    if (ticket?.dispatch?.outcome === 'died' && ticket.dispatch.terminalAt) return diedVerdict(store, held, ticket);
    return `exec WAITING: ${label} ended a turn while holding its claim; it may resume. Do not re-dispatch or release it without a recorded terminal Agent failure.`;
  }

  if (dispatchStopped && classification.kind !== 'unknown') return 'exec DIED before claiming; TaskStop it first, then fresh-dispatch and spawn the returned spec';
  return null;
}

function clearNearTurnCapCounter(agentId: string): void {
  if (!agentId) return;
  const counter = path.join(os.tmpdir(), 'sidequest-near-turn-cap', encodeURIComponent(agentId));
  try {
    fs.unlinkSync(counter);
  } catch (_) {}
}

function main(): void {
  const data = readStdin();
  if (!data) return;
  const agentId = stringField(data, 'agent_id', 'agentId');
  const agentName = stringField(data, 'agent_name', 'agentName', 'name');
  clearNearTurnCapCounter(agentId);

  const agentType = stringField(data, 'agent_type', 'agentType');
  const classification = classifyExecutor(agentType);
  if ((agentType && classification.kind === 'unknown') || (!agentId && !agentName)) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return;

  let store: Store;
  try {
    store = require(runtimeModule('store')) as Store;
  } catch (_) {
    return;
  }

  let claims: Claim[];
  try {
    claims = store.sessionClaims(sessionId, {
      agentId: agentId || null,
      agentName: agentName || null,
      executor: agentType || null,
    });
  } catch (_) {
    return;
  }
  if (!Array.isArray(claims)) return;

  if (data.stop_hook_active) return;

  let dispatchStopped = false;
  let terminalTickets: Ticket[] = [];
  try {
    const result = store.markDispatchStopped(sessionId, agentType, agentId || null, agentName || null);
    dispatchStopped = Boolean(result.ok && result.stopped !== false);
    terminalTickets = Array.isArray(result.tickets) ? result.tickets : [];
  } catch (_) {}

  let verdict: string | null;
  try {
    verdict = stopVerdict(store, claims, classification, dispatchStopped, terminalTickets);
  } catch (_) {
    return;
  }
  if (verdict) {
    writeContext('SubagentStop', verdict);
    return;
  }
  if (!claims.length) return;

  const now = Date.now();
  let worst: { elapsed: number; cutoff: number; ref?: string; ticketId: string; slug: string; at?: string } | null = null;
  for (const claim of claims) {
    if (!claim || !claim.held || claim.status === 'done') continue;
    const started = claim.at ? Date.parse(claim.at) : Number.NaN;
    if (!Number.isFinite(started)) continue;
    let ticket: Ticket | null = null;
    if (!claim.effort) {
      try {
        ticket = store.getTicket(claim.slug, claim.ticketId);
      } catch (_) {}
    }
    const cutoff = thresholdMs(claim.effort || ticket?.effort);
    const elapsed = now - started;
    if (elapsed <= cutoff) continue;
    if (!worst || elapsed > worst.elapsed) {
      worst = { elapsed, cutoff, ref: claim.ref, ticketId: claim.ticketId, slug: claim.slug, at: claim.at };
    }
  }
  if (!worst || !store.markLongRunFlagged(sessionId, worst.slug, worst.ticketId, worst.at)) return;

  const minutes = Math.max(1, Math.round(worst.elapsed / 60000));
  const label = worst.ref || worst.ticketId || 'a claimed ticket';
  const budgetMinutes = Math.round(worst.cutoff / 60000);
  writeContext(
    'SubagentStop',
    `⚠️ sidequest: the executor for ${label} held its claim ~${minutes}m (over the ${budgetMinutes}m long-run mark). ` +
      `Was that ticket really atomic, or should it have been split? Check its diff/report before trusting the result.`,
  );
}

try {
  main();
} catch (_) {
  process.exit(0);
}
