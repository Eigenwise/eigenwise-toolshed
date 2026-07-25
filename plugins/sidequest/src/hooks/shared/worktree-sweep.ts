import { stat } from 'node:fs/promises';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { pluginRoot, runtimeModule } from './paths.js';

const MAX_PROJECTS_PER_START = 3;
const MAX_CANDIDATES_PER_PROJECT = 8;

type Project = { slug: string; name?: string; path: string };

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (ref: string) => { ok: boolean; slug?: string; meta?: { path?: string } };
  integrationTarget: (slug: string) => { upstream: string; branch: string } | null;
  worktreeGcTickets: () => any[];
  worktreeGcProjects: (currentSlug: string, limit: number) => Project[];
}

interface Worktrees {
  sweep: (repo: string, tickets: any[], options: {
    execute: boolean;
    currentPath: string;
    integrationTarget: { upstream: string; branch: string };
    maxCandidates: number;
  }) => Promise<{ skipped?: string; failures?: Array<{ path: string | null; message: string }> }>;
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

export async function sweepWorktrees(data: HookInput, includeKnownProjects: boolean): Promise<string[]> {
  const store = require(runtimeModule('store')) as Store;
  const { project: current, currentPath } = currentProject(data, store);
  if (!current) return [];
  const projects = includeKnownProjects
    ? store.worktreeGcProjects(current.slug, MAX_PROJECTS_PER_START)
    : [current];
  const notices: string[] = [];
  const worktrees = require(runtimeModule('worktrees')) as Worktrees;

  for (const project of projects) {
    try {
      await stat(path.join(project.path, '.git'));
    } catch (_) {
      notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the project directory is unavailable or is not a git worktree.`);
      continue;
    }
    try {
      const target = store.integrationTarget(project.slug);
      if (!target) {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: no integration target. Configure one with ${projectCommand(project)}.`);
        continue;
      }
      const result = await worktrees.sweep(project.path, store.worktreeGcTickets(), {
        execute: true,
        currentPath: current?.slug === project.slug ? currentPath : '',
        integrationTarget: target,
        maxCandidates: MAX_CANDIDATES_PER_PROJECT,
      });
      if (result.skipped === 'repository_busy') {
        notices.push(`sidequest: skipped worktree sweep for ${project.name || project.slug}: the repository has an in-progress git operation.`);
      }
      for (const failure of result.failures || []) {
        notices.push(`sidequest: worktree sweep for ${project.name || project.slug} could not remove ${failure.path || 'a git entry'}: ${failure.message}`);
      }
    } catch (error: any) {
      notices.push(`sidequest: worktree sweep failed for ${project.name || project.slug}: ${(error && error.message) || error}. Check the repository is available, then run ${projectCommand(project)}.`);
    }
  }
  return notices;
}
