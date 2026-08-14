#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

const leaseKernel = require(runtimeModule('kernel/worktree')) as {
  canonicalPath: (value: string) => string;
  createWorktreeLease: (facts: unknown) => unknown;
  worktreeCreateDecision: (lease: unknown) => { allowed: boolean; reason: string };
};

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(repository: string, args: string[]): boolean {
  try {
    git(repository, args);
    return true;
  } catch (_) {
    return false;
  }
}

function repositoryFor(cwd: string): string {
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']));
}

function samePath(left: string, right: string): boolean {
  return leaseKernel.canonicalPath(left) === leaseKernel.canonicalPath(right);
}

function existingWorktreeMatches(repository: string, target: string): boolean {
  try {
    const checkout = path.resolve(git(target, ['rev-parse', '--show-toplevel']));
    const commonOutput = git(target, ['rev-parse', '--git-common-dir']);
    const common = path.resolve(target, commonOutput);
    return samePath(checkout, target) && samePath(common, path.join(repository, '.git'));
  } catch (_) {
    return false;
  }
}

function createWorktree(repository: string, name: string, target: string, baseline: string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (existingWorktreeMatches(repository, target)) return false;
    if (fs.statSync(target).isDirectory() && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    else throw new Error(`worktree destination already exists and is not registered to this repository: ${target}`);
  }
  const branch = `worktree-${name}`;
  git(repository, ['check-ref-format', '--branch', branch]);
  if (gitSucceeds(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    git(repository, ['worktree', 'add', target, branch]);
    return true;
  }
  git(repository, ['worktree', 'add', '-b', branch, target, baseline]);
  return true;
}

interface CreationBinding {
  ok: boolean;
  reason?: string;
  ref?: string;
  baseline?: string;
  repository?: string;
  worktree?: string;
}

function bindCreation(repository: string, sessionId: string, worktree: string): CreationBinding {
  const store = require(runtimeModule('store')) as {
    findProject: (project: string) => { ok: boolean; slug?: string };
    bindDispatchWorktreeCreation: (slug: string, sessionId: string, worktree: string) => CreationBinding;
  };
  const project = store.findProject(repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.bindDispatchWorktreeCreation(project.slug, sessionId, worktree);
}

function plannedRevision(repository: string, name: string, baseline: string): string {
  const branch = `worktree-${name}`;
  git(repository, ['check-ref-format', '--branch', branch]);
  return gitSucceeds(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    ? git(repository, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    : git(repository, ['rev-parse', '--verify', `${baseline}^{commit}`]);
}

function preparedWorktreeLease(binding: Required<Pick<CreationBinding, 'ref' | 'baseline' | 'repository' | 'worktree'>>, name: string) {
  const gitDirectory = git(binding.repository, ['rev-parse', '--git-dir']);
  const commonGitDirectory = git(binding.repository, ['rev-parse', '--git-common-dir']);
  const gitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(binding.repository, value);
  return leaseKernel.createWorktreeLease({
    repository: binding.repository,
    gitDirectory: gitPath(gitDirectory),
    commonGitDirectory: gitPath(commonGitDirectory),
    dispatchRef: binding.ref,
    dispatchBaseline: binding.baseline,
    observedRevision: plannedRevision(binding.repository, name, binding.baseline),
    observedWorktree: binding.worktree,
    boundWorktree: binding.worktree,
    identity: { status: 'bound', dispatchRef: binding.ref },
    phase: 'prepared',
    locked: false,
    liveness: { status: 'live', evidence: `dispatch ${binding.ref} reserved this creation` },
    provisioning: 'host',
  });
}

function provisioningConfig(repository: string): { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null } {
  const store = require(runtimeModule('store')) as {
    findProject: (project: string) => { ok: boolean; slug?: string };
    boardConfig: (slug: string) => { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null } | null;
  };
  const project = store.findProject(repository);
  return project.ok && project.slug ? store.boardConfig(project.slug) || {} : {};
}

function removeCreatedWorktree(repository: string, target: string): void {
  try {
    git(repository, ['worktree', 'remove', '--force', target]);
  } catch (_) {
    fs.rmSync(target, { recursive: true, force: true });
    git(repository, ['worktree', 'prune']);
  }
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'hook_event_name') !== 'WorktreeCreate') return;
  const name = stringField(input, 'name');
  const sessionId = stringField(input, 'session_id', 'sessionId');
  const cwd = stringField(input, 'cwd') || process.cwd();
  if (!name) throw new Error('WorktreeCreate requires a worktree name.');
  if (!sessionId) throw new Error('WorktreeCreate requires a dispatch session binding.');
  const repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule('worktrees')) as {
    namedWorktreePath: (repo: string, worktreeName: string) => string;
    provisionWorktree: (repo: string, worktree: string, config: { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null }) => void;
  };
  const target = worktrees.namedWorktreePath(repository, name);
  const binding = bindCreation(repository, sessionId, target);
  if (!binding.ok || !binding.ref || !binding.baseline || !binding.repository || !binding.worktree) {
    throw new Error(`worktree lease refused creation: ${binding.reason || 'dispatch binding is incomplete'}`);
  }
  const boundCreation = {
    ref: binding.ref,
    baseline: binding.baseline,
    repository: binding.repository,
    worktree: binding.worktree,
  };
  const decision = leaseKernel.worktreeCreateDecision(preparedWorktreeLease(boundCreation, name));
  if (!decision.allowed) throw new Error(`worktree lease refused creation: ${decision.reason}`);
  const created = createWorktree(boundCreation.repository, name, boundCreation.worktree, boundCreation.baseline);
  if (created) {
    try {
      worktrees.provisionWorktree(boundCreation.repository, boundCreation.worktree, provisioningConfig(boundCreation.repository));
    } catch (error) {
      removeCreatedWorktree(boundCreation.repository, boundCreation.worktree);
      throw error;
    }
  }
  process.stdout.write(`${boundCreation.worktree}\n`);
}

try {
  main();
} catch (error: any) {
  process.stderr.write(`sidequest: could not create external worktree: ${error?.message || String(error)}\n`);
  process.exit(1);
}
