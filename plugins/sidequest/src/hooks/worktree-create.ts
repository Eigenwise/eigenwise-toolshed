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

interface LinkedCheckoutIdentity {
  worktree: string;
  gitDirectory: string;
  commonGitDirectory: string;
  revision: string;
}

function linkedCheckoutIdentity(target: string): LinkedCheckoutIdentity | null {
  try {
    const worktree = path.resolve(git(target, ['rev-parse', '--show-toplevel']));
    const gitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(worktree, value);
    return {
      worktree,
      gitDirectory: gitPath(git(worktree, ['rev-parse', '--git-dir'])),
      commonGitDirectory: gitPath(git(worktree, ['rev-parse', '--git-common-dir'])),
      revision: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    };
  } catch (_) {
    return null;
  }
}

function completedTargetMatches(binding: CreationBinding): boolean {
  const identity = linkedCheckoutIdentity(String(binding.worktree));
  return Boolean(identity && binding.expectedGitDirectory && binding.expectedCommonGitDirectory && binding.expectedRevision
    && samePath(identity.worktree, String(binding.worktree))
    && samePath(identity.gitDirectory, binding.expectedGitDirectory)
    && samePath(identity.commonGitDirectory, binding.expectedCommonGitDirectory)
    && identity.revision === binding.expectedRevision);
}

function createWorktree(binding: CreationBinding, name: string): boolean {
  const repository = String(binding.repository);
  const target = String(binding.worktree);
  const baseline = String(binding.baseline);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (binding.creationCompleted && completedTargetMatches(binding)) return false;
    throw new Error(`worktree destination existed before this dispatch completed its creation: ${target}`);
  }
  if (binding.creationCompleted) throw new Error(`completed worktree creation is missing its bound checkout: ${target}`);
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
  creationCompleted?: boolean;
  expectedGitDirectory?: string | null;
  expectedCommonGitDirectory?: string | null;
  expectedRevision?: string | null;
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

function completeCreation(repository: string, sessionId: string, worktree: string): CreationBinding {
  const store = require(runtimeModule('store')) as {
    findProject: (project: string) => { ok: boolean; slug?: string };
    completeDispatchWorktreeCreation: (slug: string, sessionId: string, worktree: string) => CreationBinding;
  };
  const project = store.findProject(repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.completeDispatchWorktreeCreation(project.slug, sessionId, worktree);
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
  const boundCreation: CreationBinding & Required<Pick<CreationBinding, 'ref' | 'baseline' | 'repository' | 'worktree'>> = {
    ...binding,
    ref: binding.ref,
    baseline: binding.baseline,
    repository: binding.repository,
    worktree: binding.worktree,
  };
  const decision = leaseKernel.worktreeCreateDecision(preparedWorktreeLease(boundCreation, name));
  if (!decision.allowed) throw new Error(`worktree lease refused creation: ${decision.reason}`);
  const created = createWorktree(boundCreation, name);
  if (created) {
    try {
      worktrees.provisionWorktree(boundCreation.repository, boundCreation.worktree, provisioningConfig(boundCreation.repository));
      const completed = completeCreation(boundCreation.repository, sessionId, boundCreation.worktree);
      if (!completed.ok) throw new Error(`worktree lease could not record completed creation: ${completed.reason || 'completion binding is incomplete'}`);
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
