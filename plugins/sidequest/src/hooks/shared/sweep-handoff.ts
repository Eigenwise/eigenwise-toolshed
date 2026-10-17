import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot } from './paths.js';
import { reportFile, stateDirectory } from '../../lib/sweep-state-path.js';
export { reportFile } from '../../lib/sweep-state-path.js';
import { acquireSweepFlight, reclaimSweepFlight, sweepFlightNeedsRecovery, type SweepFlight } from './sweep-flight.js';

// The sweep removes worktrees, backs up dirty ones and prunes branches: dozens of
// git subprocesses plus recursive directory deletes. Its cost is bimodal — a few
// hundred ms when there is nothing to collect, ten seconds or more when there is —
// so awaiting it unbounded is what pushes SessionStart past the harness timeout,
// and a timed-out hook has its whole stdout discarded.
const DEFAULT_DEADLINE_MS = 2500;

export const DEFERRAL_NOTICE =
  'sidequest: worktree sweep exceeded its SessionStart budget and is still running in the background. Its worker has a 60-second lifetime limit.';

export type SweepProgress = Readonly<{
  phase: 'idle' | 'classifying' | 'sweeping' | 'complete';
  candidates: number;
  observed: number;
  current: string | null;
  reason: string | null;
  planned: number;
  removed: number;
  keptByReason: Readonly<Record<string, number>>;
}>;

const EMPTY_SWEEP_PROGRESS: SweepProgress = {
  phase: 'idle',
  candidates: 0,
  observed: 0,
  current: null,
  reason: null,
  planned: 0,
  removed: 0,
  keptByReason: {},
};

const PAUSED_FOR_RECOVERY_NOTICE =
  'sidequest: previous worktree sweep could not confirm owned cleanup. Automatic sweeps remain paused until its recorded ownership is reconciled.';

export const HANDOFF_FAILED_NOTICE =
  'sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.';

export function deadlineMs(): number {
  const raw = Number(process.env.SIDEQUEST_SWEEP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEADLINE_MS;
}

function progressFile(cwd: string): string {
  return reportFile(cwd).replace(/\.json$/, '.progress.json');
}

function normalizedProgress(value: unknown): SweepProgress {
  if (!value || typeof value !== 'object') return EMPTY_SWEEP_PROGRESS;
  const record = value as {
    phase?: unknown;
    candidates?: unknown;
    observed?: unknown;
    current?: unknown;
    reason?: unknown;
    planned?: unknown;
    removed?: unknown;
    keptByReason?: unknown;
  };
  const count = (candidate: unknown) => Number.isFinite(Number(candidate)) && Number(candidate) >= 0 ? Math.floor(Number(candidate)) : 0;
  const phase = ['idle', 'classifying', 'sweeping', 'complete'].includes(String(record.phase))
    ? String(record.phase) as SweepProgress['phase']
    : 'idle';
  const text = (candidate: unknown) => typeof candidate === 'string' && candidate.trim() ? candidate : null;
  const keptByReason = Object.fromEntries(Object.entries(record.keptByReason || {})
    .map(([reason, amount]): [string, number] => [reason, count(amount)])
    .filter(([, amount]) => amount > 0));
  return {
    phase,
    candidates: count(record.candidates),
    observed: count(record.observed),
    current: text(record.current),
    reason: text(record.reason),
    planned: count(record.planned),
    removed: count(record.removed),
    keptByReason,
  };
}

export function writeSweepProgress(cwd: string, progress: SweepProgress): void {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(progressFile(cwd), JSON.stringify(normalizedProgress(progress)));
  } catch (_) {
    // A partial report must never block the detached cleanup worker.
  }
}

export function readSweepProgress(cwd: string): SweepProgress {
  try {
    return normalizedProgress(JSON.parse(fs.readFileSync(progressFile(cwd), 'utf8')));
  } catch (_) {
    return EMPTY_SWEEP_PROGRESS;
  }
}

function clearSweepProgress(cwd: string): void {
  try {
    fs.rmSync(progressFile(cwd), { force: true });
  } catch (_) {}
}

export function deferralNotice(cwd: string, progress: SweepProgress): string {
  const kept = Object.values(progress.keptByReason).reduce((total, count) => total + count, 0);
  const reasons = Object.entries(progress.keptByReason).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
  const classification = progress.phase === 'classifying'
    ? ` Classifying ${progress.observed}/${progress.candidates}${progress.current ? `: ${progress.current}` : ''}${progress.reason ? ` (${progress.reason})` : ''}.`
    : '';
  const command = `node "${pluginRoot()}/bin/sidequest.js" worktrees sweep --yes --project "${path.resolve(cwd || '.')}"`;
  return `${DEFERRAL_NOTICE}${classification} Reached planned ${progress.planned}, removed ${progress.removed}, skipped ${kept} (${reasons}). Finish with ${command}.`;
}

export function writeReport(cwd: string, notices: string[]): void {
  try {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    fs.writeFileSync(reportFile(cwd), JSON.stringify({ notices, finishedAt: new Date().toISOString() }));
  } catch (_) {
    // A sweep report that cannot be persisted is not worth failing a session over.
  }
}

// Reads and clears whatever a previous background sweep left behind, so a deferred
// run reports on the next start instead of vanishing. null means no report was
// waiting, which is how a crashed sweep is told apart from a clean quiet one.
export function drainReport(cwd: string): string[] | null {
  const file = reportFile(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  fs.rmSync(file, { force: true });
  clearSweepProgress(cwd);
  try {
    const parsed: unknown = JSON.parse(raw);
    const notices = (parsed as { notices?: unknown } | null)?.notices;
    return Array.isArray(notices) ? notices.map((notice) => String(notice)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

// A SessionEnd sweep has no session left to tell, so it adds to whatever report the next start drains.
export function appendReport(cwd: string, notices: string[]): void {
  if (!notices.length) return;
  writeReport(cwd, [...(drainReport(cwd) || []), ...notices]);
}

function sweepCwd(data: HookInput): string {
  return stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// SessionEnd gets about 1.5 s whatever its declared timeout says, and an inline sweep was cancelled
// on every exit that ran past it (SQ-51, GH-400). The worker owns the sweep and the session's
// unregistration; the hook only starts it. False means nothing was started.
export function detachSessionEndSweep(data: HookInput): boolean {
  try {
    const child = spawn(process.execPath, [
      path.join(pluginRoot(), 'hooks', 'sweep-worktrees.js'),
      '--cwd', sweepCwd(data),
      '--session', stringField(data, 'session_id', 'sessionId'),
      '--mode', 'session-end',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {});
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// Always runs the sweep in a detached child and waits only up to the deadline. The
// child owns the mutating work, so a slow sweep costs the session its deadline
// rather than its entire injected context.
function startSweepWorker(data: HookInput, cwd: string, flight: SweepFlight) {
  const child = spawn(process.execPath, [
    path.join(pluginRoot(), 'hooks', 'sweep-worktrees.js'),
    '--cwd', cwd,
    '--session', stringField(data, 'session_id', 'sessionId'),
    '--supervise', flight.token,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', flight.release);
  if (child.pid === undefined) flight.release();
  else flight.transfer(child.pid);
  return child;
}

export async function runSweep(data: HookInput): Promise<string[]> {
  const cwd = sweepCwd(data);
  let flight;
  try {
    reclaimSweepFlight(cwd);
    flight = acquireSweepFlight(cwd);
  } catch {
    return [HANDOFF_FAILED_NOTICE];
  }
  if (!flight) return heldFlightNotices(cwd);
  return runSweepWorker(data, cwd, flight, drainReport(cwd) || []);
}

// The live worker writes its report before its supervisor releases the flight, so a
// start that lands in that window must still collect it instead of leaving it behind.
function heldFlightNotices(cwd: string): string[] {
  if (sweepFlightNeedsRecovery(cwd)) return [...(drainReport(cwd) ?? []), PAUSED_FOR_RECOVERY_NOTICE];
  return drainReport(cwd) ?? [deferralNotice(cwd, readSweepProgress(cwd))];
}

async function runSweepWorker(data: HookInput, cwd: string, flight: SweepFlight, carried: string[]): Promise<string[]> {
  const budget = deadlineMs();
  writeSweepProgress(cwd, EMPTY_SWEEP_PROGRESS);
  let child;
  try {
    child = startSweepWorker(data, cwd, flight);
  } catch (_) {
    flight.release();
    clearSweepProgress(cwd);
    return [...carried, HANDOFF_FAILED_NOTICE];
  }

  const outcome = await waitForSweep(child, budget);
  if (outcome === 'deferred') {
    child.unref();
    return [...carried, deferralNotice(cwd, readSweepProgress(cwd))];
  }
  return [...carried, ...(drainReport(cwd) ?? [HANDOFF_FAILED_NOTICE])];
}

function waitForSweep(child: ReturnType<typeof spawn>, budget: number): Promise<'exited' | 'deferred' | 'failed'> {
  return new Promise((resolve) => {
    if (budget === 0) return resolve('deferred');
    const timer = setTimeout(() => resolve('deferred'), budget);
    child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    child.once('error', () => { clearTimeout(timer); resolve('failed'); });
  });
}
