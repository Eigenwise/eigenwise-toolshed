#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const MAX_MESSAGE_BYTES = 360;
const MAX_REMINDERS_PER_STATE = 2;

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

interface Reminder {
  sessionId: string;
  message: string;
  state: string;
}

interface ReminderState {
  state: string;
  count: number;
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

function reminderStateFile(sessionId: string): string {
  const home = process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest');
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(home, 'hook-state', `stop-reminder-${key}.json`);
}

function canRemind(reminder: Reminder): boolean {
  const file = reminderStateFile(reminder.sessionId);
  try {
    let prior: ReminderState | null = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8')) as ReminderState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const count = prior?.state === reminder.state && Number.isInteger(prior.count) ? prior.count + 1 : 1;
    if (count > MAX_REMINDERS_PER_STATE) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ state: reminder.state, count } satisfies ReminderState));
    return true;
  } catch (_) {
    return false;
  }
}

function reconciliationMessage(data: HookInput): Reminder | null {
  if (nudgeOff()) return null;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return null;

  try {
    const store = require(runtimeModule('store')) as Store;
    const start = stringField(data, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    if (!project.ok || !project.slug) return null;

    const claimedRefs = new Set(store.sessionClaims(sessionId).map((claim) => String(claim.ref || '')).filter(Boolean));
    const touched = (ticket: Ticket): boolean => claimedRefs.has(String(ticket.ref || '')) || ticket.dispatch?.sessionId === sessionId;
    const open = store.listTickets(project.slug).filter((ticket) => ticket.status !== 'done' && touched(ticket));
    const doing = open.filter((ticket) => ticket.status === 'doing' && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;

    const state = [
      doing.length ? `${countLabel(doing.length, 'ticket')} in doing` : '',
      submissions.length ? `${countLabel(submissions.length, 'submission')} pending integration` : '',
      otherOpen ? `${countLabel(otherOpen, 'ticket')} still open` : '',
    ].filter(Boolean).join(' / ');
    const signature = JSON.stringify(open.map((ticket) => ({
      ref: ticket.ref || '',
      status: ticket.status || '',
      claimBy: ticket.claim?.by || '',
      dispatchSessionId: ticket.dispatch?.sessionId || '',
      submissionCommit: ticket.submission?.commit || '',
      integratedAt: ticket.submission?.integratedAt || '',
    })).sort((left, right) => left.ref.localeCompare(right.ref)));
    return {
      sessionId,
      message: byteCapped(`Sidequest: ${state} on this board. Update or close them before finishing.`),
      state: signature,
    };
  } catch (_) {
    return null;
  }
}

function main(): void {
  const data = readStdin();
  if (!data || data.stop_hook_active === true) return;
  const reminder = reconciliationMessage(data);
  if (reminder && canRemind(reminder)) writeContext('Stop', reminder.message);
}

main();
