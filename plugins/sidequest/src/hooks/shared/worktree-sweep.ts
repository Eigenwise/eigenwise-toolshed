import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot, runtimeModule } from './paths.js';

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
  boardConfig: (slug: string) => { notIntegratedSalvageAgeHours?: number } | null;
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
  }) => Promise<{
    skipped?: string;
    failures?: Array<{ path: string | null; message: string; suppressed?: boolean }>;
    salvaged?: Array<{ path: string; ref: string; recovery: string }>;
    orphanBranches?: Array<{ branch: string; action: string; reason: string; subject?: string }>;  }>;
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

function currentProject(data: HookInput, store: Store): { project: Project | null; currentPath: string } {
  const start = stringField(data, 'cwd', 'project_dir', 'projectDir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const currentPath = store.nearestRepoRoot(start);
  const found = store.findProject(currentPath);
  return {
    project: found.ok && found.slug && found.meta?.path ? { slug: found.slug, path: found.meta.path } : null,
    currentPath,
  };
}

export function registerSweepSession(data: HookInput): void {
  const id = sessionId(data);
  if (!id) return;
  try {
    const store = require(runtimeModule('store')) as Store;
    const { project, currentPath } = currentProject(data, store);
    if (!project) return;
    const state = readState();
    state.sessions = state.sessions || {};
    state.sessions[id] = currentPath;
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
  const { project: current, currentPath } = currentProject(data, store);
  if (!current) return [];
  const projects = includeKnownProjects
    ? store.worktreeGcProjects(current.slug, MAX_PROJECTS_PER_START)
    : [current];
  const notices: string[] = [];
  const worktrees = require(runtimeModule('worktrees')) as Worktrees;
  const activePaths = liveSessionPaths();

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
        currentPath: isCurrentProject ? currentPath : '',
        livePaths: activePaths,
        integrationTarget: target,
        maxCandidates: MAX_CANDIDATES_PER_PROJECT,
        notIntegratedSalvageAgeMs: (config?.notIntegratedSalvageAgeHours || DEFAULT_NOT_INTEGRATED_SALVAGE_AGE_HOURS) * 60 * 60 * 1e3,
      });
      if (!isCurrentProject) continue;
      if (result.skipped === 'repository_busy') {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the repository has an in-progress git operation.`);
      }
      for (const failure of result.failures || []) {
        if (!failure.suppressed) {
          notices.push(`sidequest: worktree sweep for ${project.name || project.slug} could not remove ${failure.path || 'a git entry'}: ${failure.message}`);
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
