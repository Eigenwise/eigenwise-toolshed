#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const MAX_MESSAGE_BYTES = 360;
const STATE_LOCK_WAIT_MS = 500;
const STATE_LOCK_RETRY_MS = 5;
const stateLockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface Ticket {
  ref?: string;
  status?: string;
  storyId?: string | null;
  claim?: { by?: string; at?: string; generation?: string } | null;
  dispatch?: { sessionId?: string | null; terminalAt?: string | null; claimedAt?: string | null } | null;
  submission?: { commit?: string; integratedAt?: string | null } | null;
}

interface LifecycleTicket extends Ticket {
  project?: string;
  claimLive?: boolean;
}

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  sessionClaims: (sessionId: string) => Array<{ ref?: string | null; held?: boolean }>;
  listTickets: (slug: string) => Ticket[];
  claimReclaimable: (ticket: Ticket) => boolean;
  claimMaySubmit: (ticket: Ticket) => boolean;
}

interface Reminder {
  sessionId: string;
  message: string;
  state: string;
}

interface ReminderState {
  state: string;
}

function nudgeOff(): boolean {
  const value = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'no';
}

function pendingSubmission(ticket: Ticket): boolean {
  return Boolean(ticket.submission?.commit && !ticket.submission.integratedAt);
}

function liveDispatch(ticket: LifecycleTicket, sessionId: string): boolean {
  return ticket.dispatch?.sessionId === sessionId
    && !ticket.dispatch.terminalAt
    && (!ticket.claim?.by || Boolean(ticket.claimLive));
}

function dispatchedBySession(ticket: Ticket, sessionId: string): boolean {
  return ticket.dispatch?.sessionId === sessionId;
}

// An executor holding a live dispatch with a claim that is not reclaimable. The
// reminder is for business this session left unfinished, and a running wave is
// neither unfinished nor this session's to close — reading one as an open ticket
// asks the orchestrator to interrupt healthy work (the-bot-resurrection, three
// times in one night). This deliberately ignores which session prepared the
// dispatch: session ids diverge across a long run, and that says nothing about
// whether an executor is alive. A direct claim with no live dispatch behind it is
// still this session's own to close, so it keeps its reminder.
function heldByLiveExecutor(ticket: LifecycleTicket): boolean {
  return Boolean(ticket.claimLive && ticket.dispatch && !ticket.dispatch.terminalAt);
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

function stateLockOwnerFile(lockDirectory: string): string | null {
  try {
    const owners = fs.readdirSync(lockDirectory).filter((name) => name.startsWith('owner-'));
    const [ownerName] = owners;
    return owners.length === 1 && ownerName ? path.join(lockDirectory, ownerName) : null;
  } catch (_) {
    return null;
  }
}

function stateLockOwnerAlive(ownerFile: string): boolean {
  try {
    const owner = Number(fs.readFileSync(ownerFile, 'utf8').trim());
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function waitForTestGate(markerVariable: string, gateVariable: string): void {
  const marker = process.env[markerVariable];
  if (marker) fs.writeFileSync(marker, `${process.pid}\n`);
  const gate = process.env[gateVariable];
  while (gate && fs.existsSync(gate)) {
    Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
  }
}

function removeStaleStateLock(lockDirectory: string, ownerFile: string): boolean {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(lockDirectory);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireStateLock(file: string): string | null {
  const lockDirectory = `${file}.lock-v2`;
  const generation = `${process.pid}-${crypto.randomUUID()}`;
  const ownerName = `owner-${generation}`;
  const candidateDirectory = `${lockDirectory}.${generation}`;
  const publishedOwnerFile = path.join(lockDirectory, ownerName);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.mkdirSync(candidateDirectory);
    fs.writeFileSync(path.join(candidateDirectory, ownerName), `${process.pid}\n`);
    while (true) {
      try {
        fs.renameSync(candidateDirectory, lockDirectory);
        waitForTestGate('SIDEQUEST_TEST_STOP_LOCK_ACQUIRED_MARKER', 'SIDEQUEST_TEST_STOP_LOCK_HOLD_GATE');
        return publishedOwnerFile;
      } catch (_) {
        const ownerFile = stateLockOwnerFile(lockDirectory);
        if (ownerFile && !stateLockOwnerAlive(ownerFile)) {
          waitForTestGate('SIDEQUEST_TEST_STOP_STALE_LOCK_MARKER', 'SIDEQUEST_TEST_STOP_STALE_LOCK_GATE');
          removeStaleStateLock(lockDirectory, ownerFile);
          const cleanedMarker = process.env.SIDEQUEST_TEST_STOP_STALE_LOCK_CLEANED_MARKER;
          if (cleanedMarker) fs.writeFileSync(cleanedMarker, `${process.pid}\n`);
          continue;
        }
        if (Date.now() >= deadline) return null;
        Atomics.wait(stateLockWaitBuffer, 0, 0, STATE_LOCK_RETRY_MS);
      }
    }
  } finally {
    try {
      fs.rmSync(candidateDirectory, { recursive: true, force: true });
    } catch (_) {}
  }
}

function releaseStateLock(ownerFile: string): void {
  try {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(path.dirname(ownerFile));
  } catch (_) {}
}

function rememberTransition(reminder: Reminder): boolean {
  const file = reminderStateFile(reminder.sessionId);
  let lockFile: string | null = null;
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return false;
    let prior: ReminderState | null = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8')) as ReminderState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (prior?.state === reminder.state) return false;
    fs.writeFileSync(file, JSON.stringify({ state: reminder.state } satisfies ReminderState));
    return true;
  } catch (_) {
    return false;
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}

function clearReminderState(sessionId: string): void {
  if (!sessionId) return;
  const file = reminderStateFile(sessionId);
  let lockFile: string | null = null;
  try {
    lockFile = acquireStateLock(file);
    if (!lockFile) return;
    fs.rmSync(file, { force: true });
  } catch (_) {
  } finally {
    if (lockFile) releaseStateLock(lockFile);
  }
}

function reminderSessionId(data: HookInput): string {
  return stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
}

function acknowledgementFreeContinuation(action: string): string {
  return `${action} Continue working without replying to this reminder; do not send an acknowledgment-only or progress reply.`;
}

function reconciliationMessage(data: HookInput, providedStore?: Store): Reminder | null {
  if (nudgeOff()) return null;
  const sessionId = reminderSessionId(data);
  if (!sessionId) return null;

  try {
    const store = providedStore || require(runtimeModule('store')) as Store;
    const start = stringField(data, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let project = store.findProject(store.nearestRepoRoot(start));
    if (!project.ok || !project.slug) project = store.findProject(start);
    if (!project.ok || !project.slug) return null;

    const claimedRefs = new Set(store.sessionClaims(sessionId)
      .filter((claim) => claim.held)
      .map((claim) => String(claim.ref || ''))
      .filter(Boolean));
    const claimedByThisSession = (ticket: Ticket): boolean => claimedRefs.has(String(ticket.ref || ''))
      || Boolean(ticket.claim?.by && dispatchedBySession(ticket, sessionId));
    const touched = (ticket: Ticket): boolean => claimedByThisSession(ticket)
      || (pendingSubmission(ticket) && dispatchedBySession(ticket, sessionId))
      || (dispatchedBySession(ticket, sessionId) && !ticket.dispatch?.terminalAt && !liveDispatch(ticket, sessionId));
    const projectTickets = store.listTickets(project.slug).map((ticket) => ({
      ...ticket,
      project: project.slug,
      claimLive: Boolean(ticket.claim?.by && !store.claimReclaimable(ticket)),
    }));
    const open = projectTickets.filter((ticket) => ticket.status !== 'done'
      && touched(ticket)
      && ((!liveDispatch(ticket, sessionId) && !heldByLiveExecutor(ticket)) || pendingSubmission(ticket)));
    const doing = open.filter((ticket) => ticket.status === 'doing' && !pendingSubmission(ticket));
    const submissions = open.filter(pendingSubmission);
    const submissionStoryIds = new Set(submissions.map((ticket) => ticket.storyId).filter(Boolean));
    const liveClaimCount = projectTickets.filter((ticket) => ticket.claimLive
      && store.claimMaySubmit(ticket)
      && (submissionStoryIds.size ? submissionStoryIds.has(ticket.storyId) : dispatchedBySession(ticket, sessionId))).length;
    const otherOpen = open.length - doing.length - submissions.length;
    if (!open.length) return null;

    const actionable = [
      doing.length ? `${countLabel(doing.length, 'ticket')} in doing` : '',
      otherOpen ? `${countLabel(otherOpen, 'ticket')} still open` : '',
    ].filter(Boolean);
    const waits = [
      submissions.length ? `${countLabel(submissions.length, 'submission')} pending integration` : '',
      submissions.length && liveClaimCount ? `${countLabel(liveClaimCount, 'live claim')} in progress` : '',
    ].filter(Boolean);
    const state = [...actionable, ...waits].join(' / ');
    const closeActionable = actionable.length
      ? `Update or close ${actionable.length === 1 && doing.length === 1 ? 'it' : 'them'} before finishing.`
      : 'Continue working on the board.';
    const action = submissions.length
      ? liveClaimCount
        ? `Hold integration until ${countLabel(liveClaimCount, 'live claim')} ${liveClaimCount === 1 ? 'becomes' : 'become'} terminal.`
        : 'Integrate pending submissions now.'
      : closeActionable;
    const holdWaits = submissions.length && !liveClaimCount
      ? ' If integration cannot proceed, record why as a ticket comment and hold the submission; never release it as complete.'
      : '';
    const signature = JSON.stringify({
      liveClaimCount,
      tickets: open.map((ticket) => ({
        ref: ticket.ref || '',
        status: ticket.status || '',
        claimBy: ticket.claim?.by || '',
        claimAt: ticket.claim?.at || '',
        claimGeneration: ticket.claim?.generation || '',
        dispatchSessionId: ticket.dispatch?.sessionId || '',
        dispatchClaimedAt: ticket.dispatch?.claimedAt || '',
        submissionCommit: ticket.submission?.commit || '',
        integratedAt: ticket.submission?.integratedAt || '',
      })).sort((left, right) => left.ref.localeCompare(right.ref)),
    });
    return {
      sessionId,
      message: byteCapped(`Sidequest: ${acknowledgementFreeContinuation(action)} ${state}.${holdWaits}`),
      state: signature,
    };
  } catch (_) {
    return null;
  }
}

function reconciliationReminder(data: HookInput, store?: Store): string | null {
  const reminder = reconciliationMessage(data, store);
  if (!reminder) {
    clearReminderState(reminderSessionId(data));
    return null;
  }
  return rememberTransition(reminder) ? reminder.message : null;
}

export function boardReconciliationReminder(data: HookInput): string | null {
  return reconciliationReminder(data);
}

export function boardReconciliationReminderForStore(data: HookInput, store: Store): string | null {
  return reconciliationReminder(data, store);
}

function main(): void {
  const data = readStdin();
  if (!data || data.stop_hook_active === true) return;
  const message = boardReconciliationReminder(data);
  if (message) writeContext('Stop', message);
}

if (path.basename(process.argv[1] || '') === 'board-reconciliation-reminder.js') main();
