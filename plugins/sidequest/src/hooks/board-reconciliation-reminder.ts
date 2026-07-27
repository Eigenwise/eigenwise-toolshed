#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeJson } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const MAX_MESSAGE_BYTES = 360;

interface Ticket {
  ref?: string;
  status?: string;
  claim?: { by?: string } | null;
  dispatch?: { sessionId?: string | null } | null;
  submission?: { commit?: string; integratedAt?: string | null } | null;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  listTickets: (slug: string) => Ticket[];
  sessionClaims: (sessionId: string) => Array<{ ref?: string | null }>;
}

function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

function pendingSubmission(ticket: Ticket): boolean {
  return Boolean(ticket.submission?.commit && !ticket.submission.integratedAt);
}

function byteCapped(message: string): string {
  return Buffer.byteLength(message) <= MAX_MESSAGE_BYTES ? message : message.slice(0, MAX_MESSAGE_BYTES - 1).trimEnd() + '…';
}

function countLabel(count: number, singular: string, plural = singular + 's'): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function reconciliationMessage(data: HookInput): string {
  if (nudgeOff()) return '';
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return '';

  try {
    const store = require(runtimeModule('store')) as Store;
    const start = stringField(data, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    if (!project.ok || !project.slug) return '';

    const claimedRefs = new Set(store.sessionClaims(sessionId).map((claim) => String(claim.ref || '')).filter(Boolean));
    const touched = (ticket: Ticket): boolean => claimedRefs.has(String(ticket.ref || '')) || ticket.dispatch?.sessionId === sessionId;
    const open = store.listTickets(project.slug).filter((ticket) => ticket.status !== 'done' && touched(ticket));
    const doing = open.filter((ticket) => ticket.status === 'doing' && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return '';

    const state = [
      doing.length ? `${countLabel(doing.length, 'ticket')} in doing` : '',
      submissions.length ? `${countLabel(submissions.length, 'submission')} pending integration` : '',
      otherOpen ? `${countLabel(otherOpen, 'ticket')} still open` : '',
    ].filter(Boolean).join(' / ');
    return byteCapped(`Sidequest: ${state} on this board. Update or close them before finishing.`);
  } catch (_) {
    return '';
  }
}

function main(): void {
  const data = readStdin();
  if (!data) return;
  const message = reconciliationMessage(data);
  if (message) writeJson({ systemMessage: message });
}

main();
