import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot } from './paths.js';

// The sweep removes worktrees, backs up dirty ones and prunes branches: dozens of
// git subprocesses plus recursive directory deletes. Its cost is bimodal — a few
// hundred ms when there is nothing to collect, ten seconds or more when there is —
// so awaiting it unbounded is what pushes SessionStart past the harness timeout,
// and a timed-out hook has its whole stdout discarded.
const DEFAULT_DEADLINE_MS = 2500;

export const DEFERRAL_NOTICE =
  'sidequest: worktree sweep exceeded its SessionStart budget and is still running in the background.';

export type SweepProgress = Readonly<{
  planned: number;
  removed: number;
  keptByReason: Readonly<Record<string, number>>;
}>;

const EMPTY_SWEEP_PROGRESS: SweepProgress = { planned: 0, removed: 0, keptByReason: {} };

export const HANDOFF_FAILED_NOTICE =
  'sidequest: worktree sweep could not run, so stale agent worktrees were not collected this session.';

export function deadlineMs(): number {
  const raw = Number(process.env.SIDEQUEST_SWEEP_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEADLINE_MS;
}

function stateDirectory(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'sweep-reports');
}

export function reportFile(cwd: string): string {
  const key = crypto.createHash('sha1').update(path.resolve(cwd || '.')).digest('hex').slice(0, 16);
  return path.join(stateDirectory(), `${key}.json`);
}

function progressFile(cwd: string): string {
  return reportFile(cwd).replace(/\.json$/, '.progress.json');
}

function normalizedProgress(value: unknown): SweepProgress {
  if (!value || typeof value !== 'object') return EMPTY_SWEEP_PROGRESS;
  const record = value as { planned?: unknown; removed?: unknown; keptByReason?: unknown };
  const count = (candidate: unknown) => Number.isFinite(Number(candidate)) && Number(candidate) >= 0 ? Math.floor(Number(candidate)) : 0;
  const keptByReason = Object.fromEntries(Object.entries(record.keptByReason || {})
    .map(([reason, amount]): [string, number] => [reason, count(amount)])
    .filter(([, amount]) => amount > 0));
  return { planned: count(record.planned), removed: count(record.removed), keptByReason };
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
  const command = `node "${pluginRoot()}/bin/sidequest.js" worktrees sweep --yes --project "${path.resolve(cwd || '.')}"`;
  return `${DEFERRAL_NOTICE} Reached planned ${progress.planned}, removed ${progress.removed}, skipped ${kept} (${reasons}). Finish with ${command}.`;
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

function sweepCwd(data: HookInput): string {
  return stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// Always runs the sweep in a detached child and waits only up to the deadline. The
// child owns the mutating work, so a slow sweep costs the session its deadline
// rather than its entire injected context.
export async function runSweep(data: HookInput): Promise<string[]> {
  const cwd = sweepCwd(data);
  const carried = drainReport(cwd) || [];
  const budget = deadlineMs();
  writeSweepProgress(cwd, EMPTY_SWEEP_PROGRESS);
  let child;
  try {
    child = spawn(process.execPath, [
      path.join(pluginRoot(), 'hooks', 'sweep-worktrees.js'),
      '--cwd', cwd,
      '--session', stringField(data, 'session_id', 'sessionId'),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
  } catch (_) {
    clearSweepProgress(cwd);
    return [...carried, HANDOFF_FAILED_NOTICE];
  }

  const outcome = await new Promise<'exited' | 'deferred' | 'failed'>((resolve) => {
    if (budget === 0) return resolve('deferred');
    const timer = setTimeout(() => resolve('deferred'), budget);
    child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    child.once('error', () => { clearTimeout(timer); resolve('failed'); });
  });

  if (outcome === 'failed') {
    clearSweepProgress(cwd);
    return [...carried, HANDOFF_FAILED_NOTICE];
  }
  if (outcome === 'deferred') {
    child.unref();
    return [...carried, deferralNotice(cwd, readSweepProgress(cwd))];
  }
  const report = drainReport(cwd);
  return report === null ? [...carried, HANDOFF_FAILED_NOTICE] : [...carried, ...report];
}
