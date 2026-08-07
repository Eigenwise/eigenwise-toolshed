#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const MAX_MESSAGE_BYTES = 360;
const ESCALATION_STOP_THRESHOLD = 3;

interface Ticket {
  ref?: string;
  status?: string;
  claim?: { by?: string } | null;
  dispatch?: { sessionId?: string | null; terminalAt?: string | null } | null;
  submission?: { commit?: string; integratedAt?: string | null } | null;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  listTickets: (slug: string) => Ticket[];
  sessionClaims: (sessionId: string) => Array<{ ref?: string | null }>;
  claimPulse: (ticket: Ticket) => { reclaimable?: string | null } | null;
}

interface Reminder {
  sessionId: string;
  message: string;
  pendingRefs: string[];
  state: string;
}

interface ReminderState {
  state: string;
  count: number;
}

type ReminderKind = 'initial' | 'escalated';

function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

function pendingSubmission(ticket: Ticket): boolean {
  return Boolean(ticket.submission?.commit && !ticket.submission.integratedAt);
}

function liveDispatch(ticket: Ticket, sessionId: string, store: Store): boolean {
  return ticket.dispatch?.sessionId === sessionId
    && !ticket.dispatch.terminalAt
    && !store.claimPulse(ticket)?.reclaimable;
}

// An executor holding a live dispatch with a claim that is not reclaimable. The
// reminder is for business this session left unfinished, and a running wave is
// neither unfinished nor this session's to close — reading one as an open ticket
// asks the orchestrator to interrupt healthy work (the-bot-resurrection, three
// times in one night). This deliberately ignores which session prepared the
// dispatch: session ids diverge across a long run, and that says nothing about
// whether an executor is alive. A direct claim with no live dispatch behind it is
// still this session's own to close, so it keeps its reminder.
function heldByLiveExecutor(ticket: Ticket, store: Store): boolean {
  if (!ticket.claim?.by || !ticket.dispatch || ticket.dispatch.terminalAt) return false;
  return !store.claimPulse(ticket)?.reclaimable;
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

function canRemind(reminder: Reminder): ReminderKind | null {
  const file = reminderStateFile(reminder.sessionId);
  try {
    let prior: ReminderState | null = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8')) as ReminderState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const priorCount = prior?.state === reminder.state && Number.isInteger(prior.count) ? prior.count : 0;
    const count = Math.min(priorCount + 1, ESCALATION_STOP_THRESHOLD);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ state: reminder.state, count } satisfies ReminderState));
    if (count === 1) return 'initial';
    if (reminder.pendingRefs.length && count === ESCALATION_STOP_THRESHOLD && priorCount < count) return 'escalated';
    return null;
  } catch (_) {
    return null;
  }
}

function escalatedMessage(reminder: Reminder): string {
  const refs = reminder.pendingRefs.join(', ');
  const verb = reminder.pendingRefs.length === 1 ? 'is' : 'are';
  return byteCapped(`Sidequest: ${refs} ${verb} still pending integration after ${ESCALATION_STOP_THRESHOLD} consecutive stops. Checkpoint and hold; never release, releasing loses work.`);
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
    const open = store.listTickets(project.slug).filter((ticket) => ticket.status !== 'done'
      && touched(ticket)
      && ((!liveDispatch(ticket, sessionId, store) && !heldByLiveExecutor(ticket, store)) || pendingSubmission(ticket)));
    const doing = open.filter((ticket) => ticket.status === 'doing' && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const pendingRefs = submissions.map((ticket) => String(ticket.ref || '')).filter(Boolean);
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;

    const actionable = [
      doing.length ? `${countLabel(doing.length, 'ticket')} in doing` : '',
      otherOpen ? `${countLabel(otherOpen, 'ticket')} still open` : '',
    ].filter(Boolean);
    const waits = [
      submissions.length ? `${countLabel(submissions.length, 'submission')} pending integration` : '',
    ].filter(Boolean);
    const state = [...actionable, ...waits].join(' / ');
    const closeActionable = actionable.length
      ? ` Update or close ${actionable.length === 1 && doing.length === 1 ? 'it' : 'them'} before finishing.`
      : '';
    const holdWaits = waits.length
      ? ' Pending integration is unfinished work. Checkpoint and hold; never release it as complete.'
      : '';
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
      message: byteCapped(`Sidequest: ${state}.${closeActionable}${holdWaits}`),
      pendingRefs,
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
  const kind = reminder && canRemind(reminder);
  if (reminder && kind) writeContext('Stop', kind === 'escalated' ? escalatedMessage(reminder) : reminder.message);
}

main();
