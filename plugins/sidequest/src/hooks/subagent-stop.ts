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
}
interface Ticket {
  ref: string;
  comments?: TicketComment[];
  files?: string[];
  submission?: { commit?: string; integratedAt?: string };
  effort?: string;
}
interface Store {
  getTicket: (slug: string, ticketId: string) => Ticket | null;
  markDispatchStopped: (sessionId: string, executor: string, agentId: string | null, agentName: string | null) => { ok?: boolean };
  sessionClaims: (sessionId: string, options: Record<string, unknown>) => Claim[];
  markLongRunFlagged: (sessionId: string, slug: string, ticketId: string, at?: string) => boolean;
}

function fallbackClassify(type: string): ExecutorClassification {
  const readOnlyDispatch = /^sidequest-exec-dispatch-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyDispatch) return { kind: 'read_only_codex_dispatch', effort: readOnlyDispatch[1] || null };
  const readOnlyBuiltin = /^sidequest-exec-readonly-(low|medium|high|xhigh|max)$/.exec(type);
  if (readOnlyBuiltin) return { kind: 'read_only_claude_builtin', effort: readOnlyBuiltin[1] || null };
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
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

function stopVerdict(store: Store, claims: Claim[], classification: ExecutorClassification, dispatchStopped: boolean): string | null {
  const now = Date.now();
  for (const claim of claims) {
    if (!claim || claim.status !== 'done') continue;
    const ticket = store.getTicket(claim.slug, claim.ticketId);
    const comment = ticket && doneComment(ticket, claim.by);
    if (!ticket || !comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash
      ? ' done WITHOUT commit hash'
      : ` done${hash ? ` (${hash})` : ''}`;
    return `exec stopped clean: ${ticket.ref}${suffix}; verify, then TaskStop this executor so it doesn't linger idle`;
  }

  for (const claim of claims) {
    if (!claim || claim.held) continue;
    let ticket: Ticket | null = null;
    try {
      ticket = store.getTicket(claim.slug, claim.ticketId);
    } catch (_) {
      continue;
    }
    const submission = ticket?.submission;
    if (!ticket || !submission?.commit || submission.integratedAt) continue;
    return `exec stopped clean: ${ticket.ref} READY_FOR_INTEGRATION (${submission.commit.slice(0, 12)}); run the publish transaction (references/publishing.md), then TaskStop this executor`;
  }

  const held = claims.find((claim) => claim && claim.held && claim.status === 'doing');
  if (held) {
    const started = Date.parse(held.at || '');
    const minutes = Number.isFinite(started) ? Math.max(1, Math.round((now - started) / 60000)) : 0;
    const label = held.ref || held.ticketId || 'a ticket';
    return `exec stopped HOLDING ${label} claim (age ${minutes}m), likely dead: release + respawn, then TaskStop it`;
  }

  if (dispatchStopped && classification.kind !== 'unknown') return 'exec stopped without ever claiming, TaskStop it first, then redispatch and spawn the returned spec';
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
  if (data.stop_hook_active) return;

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

  let dispatchStopped = false;
  try {
    dispatchStopped = Boolean(store.markDispatchStopped(sessionId, agentType, agentId || null, agentName || null).ok);
  } catch (_) {}

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

  let verdict: string | null;
  try {
    verdict = stopVerdict(store, claims, classification, dispatchStopped);
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
