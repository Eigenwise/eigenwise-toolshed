import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot, runtimeModule } from './paths.js';
import { writeSweepProgress, type SweepProgress } from './sweep-handoff.js';

const MAX_PROJECTS_PER_START = 3;
const MAX_CANDIDATES_PER_PROJECT = 8;
const DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS = 7 * 24;
const MAX_ORPHAN_SUBJECT_LENGTH = 120;

type Project = { slug: string; name?: string; path: string };
type SweepSessionState = {
  sessions?: Record<string, string>;
  reportedOrphans?: Record<string, string[]>;
};

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (ref: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  integrationTarget: (slug: string) => { upstream: string; branch: string } | null;
  boardConfig: (slug: string) => { notIntegratedSalvageAgeHours?: number; worktreeRecoveryRetentionAgeHours?: number; worktreeRecoveryRetentionMaxPerAgent?: number } | null;
  worktreeGcTickets: () => any[];
  worktreeGcProjects: (currentSlug: string, limit: number) => Project[];
}

interface Worktrees {
  sweep: (repo: string, tickets: any[], options: {
    execute: boolean;
    currentPath: string;
    livePaths: string[];
    integrationTarget: { upstream: string; branch: string };
    maxCandidates: number;
    notIntegratedSalvageAgeMs: number;
    recoveryRetentionAgeMs: number;
    recoveryRetentionMaxPerAgent: number;
    onProgress?: (progress: SweepProgress) => void;
  }) => Promise<{
    skipped?: string;
    failures?: Array<{ path: string | null; message: string; suppressed?: boolean }>;
    salvaged?: Array<{ path: string; ref: string; recovery: string }>;
    orphanBranches?: Array<{ branch: string; action: string; reason: string; subject?: string }>;
  }>;
}

type WorktreeProcess = {
  pid: number;
  imageName: string;
  startTime: string;
  cpuSeconds: number | null;
  command: string;
};

type ProcessLister = () => WorktreeProcess[];

function windowsProcesses(): WorktreeProcess[] {
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CreationDate,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (result.status !== 0) return [];
    const parsed = JSON.parse(String(result.stdout || ''));
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
      const pid = Number(entry?.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const kernelSeconds = Number(entry.KernelModeTime) / 10_000_000;
      const userSeconds = Number(entry.UserModeTime) / 10_000_000;
      return [{
        pid,
        imageName: String(entry.Name || 'unknown'),
        startTime: String(entry.CreationDate || ''),
        cpuSeconds: Number.isFinite(kernelSeconds + userSeconds) ? Math.floor(kernelSeconds + userSeconds) : null,
        command: String(entry.CommandLine || ''),
      }];
    });
  } catch (_) {
    return [];
  }
}

function normalizedWindowsPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function referencesWorktree(command: string, worktreePath: string): boolean {
  const target = normalizedWindowsPath(worktreePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${target}(?=$|[\\\\/"'\\s])`, 'i').test(normalizedWindowsPath(command));
}

export function worktreeRemovalFailureNotice(
  failure: { path: string | null; message: string },
  options: { platform?: NodeJS.Platform; existsSync?: (pathname: string) => boolean; listProcesses?: ProcessLister } = {}
): string {
  const notice = `could not remove ${failure.path || 'a git entry'}: ${failure.message}`;
  if ((options.platform ?? process.platform) !== 'win32' || !failure.path || !(options.existsSync || fs.existsSync)(failure.path)) return notice;
  const processes = (options.listProcesses || windowsProcesses)().filter((entry) => referencesWorktree(entry.command, failure.path as string));
  if (!processes.length) return notice;
  const details = processes.map((entry) => {
    const started = entry.startTime ? `, started ${entry.startTime}` : '';
    const cpu = entry.cpuSeconds === null ? '' : `, CPU ${entry.cpuSeconds}s`;
    return `pid ${entry.pid} (${entry.imageName}${started}${cpu})`;
  });
  return `${notice}. Processes still using it: ${details.join('; ')}. End those PIDs and re-run the sweep.`;
}

function stateFile(): string {
  const home = String(process.env.SIDEQUEST_HOME || '').trim() || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'worktree-sweep-sessions.json');
}

function readState(): SweepSessionState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as SweepSessionState;
  } catch (_) {
    return {};
  }
}

function writeState(state: SweepSessionState): void {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state), 'utf8');
  } catch (_) {
    // Session tracking is advisory. A write failure must not block the hook.
  }
}

function sessionId(data: HookInput): string {
  return stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
}

function projectCommand(project: Project): string {
  return `node "${pluginRoot()}/bin/sidequest.js" board-config --project "${project.path}" --integration-branch <branch>`;
}

function sessionWorktreePath(start: string): string {
  const resolved = path.resolve(start);
  let candidate = resolved;
  for (;;) {
    try {
      if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
    } catch (_) {
      return resolved;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return resolved;
    candidate = parent;
  }
}

function currentProject(data: HookInput, store: Store): { project: Project | null; sessionPath: string } {
  const start = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentPath = store.nearestRepoRoot(start);
  const found = store.findProject(currentPath);
  return {
    project: found.ok && found.slug && found.meta?.path ? { slug: found.slug, path: found.meta.path } : null,
    sessionPath: sessionWorktreePath(start),
  };
}

export function registerSweepSession(data: HookInput): void {
  const id = sessionId(data);
  if (!id) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const { project, sessionPath } = currentProject(data, store);
    if (!project) return;
    const state = readState();
    state.sessions = state.sessions || {};
    state.sessions[id] = sessionPath;
    writeState(state);
  } catch (_) {
    // A session that cannot be registered is still allowed to start.
  }
}

export function unregisterSweepSession(data: HookInput): void {
  const id = sessionId(data);
  if (!id) return;
  const state = readState();
  if (state.sessions) delete state.sessions[id];
  if (state.reportedOrphans) delete state.reportedOrphans[id];
  writeState(state);
}

function liveSessionPaths(): string[] {
  return Object.values(readState().sessions || {});
}

function abbreviated(value: string): string {
  return value.length <= MAX_ORPHAN_SUBJECT_LENGTH ? value : `${value.slice(0, MAX_ORPHAN_SUBJECT_LENGTH - 1)}…`;
}

function orphanNotices(data: HookInput, project: Project, orphanBranches: Array<{ branch: string; action: string; reason: string; subject?: string }>): string[] {
  const id = sessionId(data);
  if (!id) return [];
  const state = readState();
  const reported = new Set(state.reportedOrphans?.[id] || []);
  const kept = orphanBranches.filter((entry) => entry.action === 'keep' && entry.reason === 'not_integrated' && !reported.has(`${project.slug}:${entry.branch}`));
  if (!kept.length) return [];
  state.reportedOrphans = state.reportedOrphans || {};
  state.reportedOrphans[id] = [...reported, ...kept.map((entry) => `${project.slug}:${entry.branch}`)];
  writeState(state);
  return kept.map((entry) => `sidequest: unintegrated orphan worktree branch ${entry.branch}: ${abbreviated(String(entry.subject || 'no commit subject'))}.`);
}

function salvageNotices(salvaged: Array<{ path: string; ref: string; recovery: string }>): string[] {
  return salvaged.map((entry) => `sidequest: salvaged unintegrated worktree ${entry.path} at ${entry.ref}. Recover with ${entry.recovery}.`);
}

function missingIntegrationTarget(error: unknown): boolean {
  return /Configured integration ref .+ does not exist\./.test(String((error as Error)?.message || error));
}

export async function sweepWorktrees(data: HookInput, includeKnownProjects: boolean): Promise<string[]> {
  const store = require(runtimeModule('store')) as Store;
  const { project: current, sessionPath } = currentProject(data, store);
  if (!current) return [];
  const projects = includeKnownProjects
    ? store.worktreeGcProjects(current.slug, MAX_PROJECTS_PER_START)
    : [current];
  const notices: string[] = [];
  const worktrees = require(runtimeModule('worktrees')) as Worktrees;
  const activePaths = liveSessionPaths();
  const progressCwd = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectProgress = new Map<string, SweepProgress>();
  const updateProgress = (project: Project, progress: SweepProgress): void => {
    projectProgress.set(project.slug, progress);
    const keptByReason: Record<string, number> = {};
    let planned = 0;
    let removed = 0;
    for (const currentProgress of projectProgress.values()) {
      planned += currentProgress.planned;
      removed += currentProgress.removed;
      for (const [reason, count] of Object.entries(currentProgress.keptByReason)) {
        keptByReason[reason] = (keptByReason[reason] || 0) + count;
      }
    }
    writeSweepProgress(progressCwd, { planned, removed, keptByReason });
  };

  for (const project of projects) {
    const isCurrentProject = project.slug === current.slug;
    try {
      await stat(path.join(project.path, '.git'));
    } catch (_) {
      continue;
    }

    let target: { upstream: string; branch: string } | null;
    try {
      target = store.integrationTarget(project.slug);
    } catch (error: any) {
      if (isCurrentProject && missingIntegrationTarget(error)) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the configured integration branch is unavailable locally.`);
      }
      continue;
    }
    if (!target) {
      if (isCurrentProject) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: no integration target. Configure one with ${projectCommand(project)}.`);
      }
      continue;
    }

    try {
      const config = store.boardConfig(project.slug);
      const result = await worktrees.sweep(project.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: isCurrentProject ? sessionPath : '',
        livePaths: activePaths,
        integrationTarget: target,
        maxCandidates: MAX_CANDIDATES_PER_PROJECT,
        notIntegratedSalvageAgeMs: (config?.notIntegratedSalvageAgeHours || DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS) * 60 * 60 * 1e3,
        recoveryRetentionAgeMs: (config?.worktreeRecoveryRetentionAgeHours || 14 * 24) * 60 * 60 * 1e3,
        recoveryRetentionMaxPerAgent: config?.worktreeRecoveryRetentionMaxPerAgent || 3,
        onProgress: (progress) => updateProgress(project, progress),
      });
      if (!isCurrentProject) continue;
      if (result.skipped === 'repository_busy') {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the repository has an in-progress git operation.`);
      }
      for (const failure of result.failures || []) {
        if (!failure.suppressed) {
          notices.push(`sidequest: worktree sweep for ${project.name || project.slug} ${worktreeRemovalFailureNotice(failure)}`);
        }
      }
      notices.push(...salvageNotices(result.salvaged || []));
      notices.push(...orphanNotices(data, project, result.orphanBranches || []));
    } catch (error: any) {
      if (isCurrentProject) {
        notices.push(`sidequest: worktree sweep failed for ${project.name || project.slug}: ${(error && error.message) || error}. Check the repository is available, then run ${projectCommand(project)}.`);
      }
    }
  }
  return notices;
}
