#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { worktreeSetupDeadlineMs } from '../lib/hook-timeouts.js';
import { worktreeCreationRefusalMessage, type WorktreeCreationBindingFailure } from '../lib/refusal-guidance.js';

const leaseKernel = require(runtimeModule('kernel/worktree')) as {
  canonicalPath: (value: string) => string;
  checkoutInstanceIdentity: (gitDirectory: string) => string | null;
  createCheckoutInstanceMarker: (gitDirectory: string) => string;
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

// This hook only learns the spawning checkout's cwd, so a dispatch prepared for a
// sibling project reserved a creation no WorktreeCreate could bind and its executor
// died before it started (SQ-2884). The session's own reservation names the board it
// belongs to. Consulted only after the spawning checkout fails to bind, so the
// common case pays nothing for a scan across every board; an ambiguous session
// resolves to nothing and prepareDispatch refuses it.
function reservedDispatchRepository(sessionId: string): string | null {
  try {
    const store = require(runtimeModule('store')) as { isolatedDispatchRepositoryForSession: (session: string) => string | null };
    const reserved = store.isolatedDispatchRepositoryForSession(sessionId);
    return reserved ? path.resolve(reserved) : null;
  } catch (_) {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  return leaseKernel.canonicalPath(left) === leaseKernel.canonicalPath(right);
}

interface LinkedCheckoutIdentity {
  hostWorktreePath: string;
  worktree: string;
  gitDirectory: string;
  commonGitDirectory: string;
  checkoutInstance: string | null;
  revision: string;
}

function linkedCheckoutIdentity(target: string): LinkedCheckoutIdentity | null {
  try {
    const hostWorktreePath = git(target, ['rev-parse', '--show-toplevel']);
    const worktree = path.resolve(hostWorktreePath);
    const gitPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(worktree, value);
    const gitDirectory = gitPath(git(worktree, ['rev-parse', '--git-dir']));
    return {
      hostWorktreePath,
      worktree,
      gitDirectory,
      commonGitDirectory: gitPath(git(worktree, ['rev-parse', '--git-common-dir'])),
      checkoutInstance: leaseKernel.checkoutInstanceIdentity(gitDirectory),
      revision: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    };
  } catch (_) {
    return null;
  }
}

function completedTargetMatches(binding: CreationBinding): boolean {
  const identity = linkedCheckoutIdentity(String(binding.worktree));
  return Boolean(identity && binding.expectedGitDirectory && binding.expectedCommonGitDirectory && binding.expectedCheckoutInstance && binding.expectedRevision
    && samePath(identity.worktree, String(binding.worktree))
    && samePath(identity.gitDirectory, binding.expectedGitDirectory)
    && samePath(identity.commonGitDirectory, binding.expectedCommonGitDirectory)
    && identity.checkoutInstance === binding.expectedCheckoutInstance
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
  binding?: WorktreeCreationBindingFailure;
  ref?: string;
  baseline?: string;
  repository?: string;
  worktree?: string;
  attempt?: string;
  creationCompleted?: boolean;
  expectedGitDirectory?: string | null;
  expectedCommonGitDirectory?: string | null;
  expectedCheckoutInstance?: string | null;
  expectedRevision?: string | null;
}

interface ProjectLookup {
  ok: boolean;
  slug?: string;
}

interface WorktreeStore {
  findProject: (project: string) => ProjectLookup;
  nearestRepoRoot: (project: string) => string;
}

// `stale_attempt` is not an incomplete binding, it is this hook finding out it belongs to a generation the
// board already retired. Saying so is the difference between an operator chasing a binding bug and reading
// that a replacement dispatch owns this checkout now.
function retiredGenerationRefusal(reason?: string) {
  return reason === 'stale_attempt' || reason === 'missing_attempt';
}

function recordingRefusal(what: string, reason?: string, fallback = 'dispatch binding is incomplete') {
  if (reason === 'stale_attempt') {
    return `worktree lease could not record ${what}: this WorktreeCreate belongs to a retired dispatch attempt, so the board refused the stamp and the live attempt was left untouched`;
  }
  if (reason === 'missing_attempt') {
    return `worktree lease could not record ${what}: this WorktreeCreate carried no dispatch attempt generation, so the board refused the stamp and the live attempt was left untouched`;
  }
  return `worktree lease could not record ${what}: ${reason || fallback}`;
}

function registeredProject(store: WorktreeStore, repository: string): ProjectLookup {
  return store.findProject(store.nearestRepoRoot(repository));
}

function bindCreation(repository: string, sessionId: string, worktree: string): CreationBinding {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    bindDispatchWorktreeCreation: (slug: string, sessionId: string, worktree: string) => CreationBinding;
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.bindDispatchWorktreeCreation(project.slug, sessionId, worktree);
}

function completeCreation(repository: string, sessionId: string, worktree: string, attempt: string): CreationBinding {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    completeDispatchWorktreeCreation: (slug: string, sessionId: string, worktree: string, attempt: string) => CreationBinding;
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.completeDispatchWorktreeCreation(project.slug, sessionId, worktree, attempt);
}

function recordProvisioned(repository: string, sessionId: string, worktree: string, attempt: string): CreationBinding {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    recordDispatchWorktreeProvisioned: (slug: string, sessionId: string, worktree: string, attempt: string) => CreationBinding;
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.recordDispatchWorktreeProvisioned(project.slug, sessionId, worktree, attempt);
}

function recordProvisioningFailure(repository: string, sessionId: string, worktree: string, failure: { command: string; reason: string; stderrTail: string }, attempt: string): CreationBinding {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    recordDispatchWorktreeProvisioningFailure: (slug: string, sessionId: string, worktree: string, failure: { command: string; reason: string; stderrTail: string }, attempt: string) => CreationBinding;
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.recordDispatchWorktreeProvisioningFailure(project.slug, sessionId, worktree, failure, attempt);
}

function recordDependencyLink(repository: string, sessionId: string, worktree: string, link: { relativePath: string; target: string }, attempt: string): CreationBinding {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    recordDispatchWorktreeDependencyLink: (slug: string, sessionId: string, worktree: string, link: { relativePath: string; target: string }, attempt: string) => CreationBinding;
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_unavailable' };
  return store.recordDispatchWorktreeDependencyLink(project.slug, sessionId, worktree, link, attempt);
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
  const store = require(runtimeModule('store')) as WorktreeStore & {
    boardConfig: (slug: string) => { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null } | null;
  };
  const project = registeredProject(store, repository);
  return project.ok && project.slug ? store.boardConfig(project.slug) || {} : {};
}

// Recovery terminalizes an attempt and reclaims its checkout, so it is generation-scoped like every other
// callback. Without the token a retired hook that had just been told `stale_attempt` went on to mark the
// live replacement failed and clear its nonce (SQ-2953 finding 1).
function recoverCreatedWorktree(repository: string, sessionId: string, target: string, error: unknown, attempt: string): string | null {
  const store = require(runtimeModule('store')) as WorktreeStore & {
    recoverDispatchWorktreeCreation: (slug: string, sessionId: string, worktree: string, error: unknown, attempt: string) => {
      ok: boolean;
      reason?: string;
      cleanup?: { reclaimed?: boolean; reason?: string; message?: string } | null;
    };
  };
  const project = registeredProject(store, repository);
  if (!project.ok || !project.slug) return 'worktree recovery preserved the checkout because its project binding is unavailable';
  const recovery = store.recoverDispatchWorktreeCreation(project.slug, sessionId, target, error, attempt);
  if (retiredGenerationRefusal(recovery.reason)) {
    return 'worktree recovery touched no attempt and left the checkout to the replacement that now owns it';
  }
  if (!recovery.ok) return `worktree recovery preserved the checkout because ${recovery.reason || 'its dispatch binding is unavailable'}`;
  if (recovery.cleanup?.reclaimed) return null;
  return `worktree recovery preserved the checkout because ${recovery.cleanup?.message || recovery.cleanup?.reason || 'cleanup authority is incomplete'}`;
}

function main(): Promise<void> {
  return createWorktreeMain();
}

async function createWorktreeMain(): Promise<void> {
  const input = readStdin();
  if (!input || stringField(input, 'hook_event_name') !== 'WorktreeCreate') return;
  const name = stringField(input, 'name');
  const sessionId = stringField(input, 'session_id', 'sessionId');
  const cwd = stringField(input, 'cwd') || process.cwd();
  if (!name) throw new Error('WorktreeCreate requires a worktree name.');
  if (!sessionId) throw new Error('WorktreeCreate requires a dispatch session binding.');
  let repository = repositoryFor(cwd);
  const worktrees = require(runtimeModule('worktrees')) as {
    namedWorktreePath: (repo: string, worktreeName: string) => string;
    provisionWorktree: (
      repo: string,
      worktree: string,
      config: { worktreeDependencyPaths?: { path: string; mode: string }[]; worktreeSetup?: string | null },
      options: { setupTimeoutMs?: number; onDependencyLink?: (link: { relativePath: string; target: string }) => void },
    ) => Promise<{ command: string; reason: string; stderrTail: string } | null>;
  };
  let binding = bindCreation(repository, sessionId, worktrees.namedWorktreePath(repository, name));
  if (!binding.ok) {
    const reserved = reservedDispatchRepository(sessionId);
    if (reserved && !samePath(reserved, repository)) {
      const reservedBinding = bindCreation(reserved, sessionId, worktrees.namedWorktreePath(reserved, name));
      if (reservedBinding.ok) {
        repository = reserved;
        binding = reservedBinding;
      }
    }
  }
  if (!binding.ok || !binding.ref || !binding.baseline || !binding.repository || !binding.worktree) {
    throw new Error(worktreeCreationRefusalMessage(String(binding.reason || ''), repository, binding.binding));
  }
  const attempt = String(binding.attempt || '');
  // Without the generation no callback can be recorded, so fail before creating a checkout nothing can stamp.
  if (!attempt) throw new Error('worktree lease refused creation: the dispatch binding carried no attempt generation');
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
      const identity = linkedCheckoutIdentity(boundCreation.worktree);
      if (!identity) throw new Error('new worktree identity is unavailable');
      leaseKernel.createCheckoutInstanceMarker(identity.gitDirectory);
      const completed = completeCreation(boundCreation.repository, sessionId, boundCreation.worktree, attempt);
      if (!completed.ok) throw new Error(recordingRefusal('completed creation', completed.reason, 'completion binding is incomplete'));
      const provisioningFailure = await worktrees.provisionWorktree(
        boundCreation.repository,
        boundCreation.worktree,
        provisioningConfig(boundCreation.repository),
        {
          setupTimeoutMs: worktreeSetupDeadlineMs(),
          onDependencyLink: (link) => {
            const recorded = recordDependencyLink(boundCreation.repository, sessionId, boundCreation.worktree, link, attempt);
            if (!recorded.ok) throw new Error(recordingRefusal('dependency link', recorded.reason));
          },
        },
      );
      // Completion above is recorded before provisioning, so this stamp is the only board fact saying the
      // hook is done. Without it a cold `npm ci` looks identical to a dead WorktreeCreate (SQ-2934).
      const provisioned = recordProvisioned(boundCreation.repository, sessionId, boundCreation.worktree, attempt);
      if (!provisioned.ok) throw new Error(recordingRefusal('finished provisioning', provisioned.reason));
      if (provisioningFailure) {
        const recorded = recordProvisioningFailure(boundCreation.repository, sessionId, boundCreation.worktree, provisioningFailure, attempt);
        if (!recorded.ok) throw new Error(recordingRefusal('setup failure', recorded.reason));
      }
    } catch (error) {
      const preservation = recoverCreatedWorktree(boundCreation.repository, sessionId, boundCreation.worktree, error, attempt);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(preservation ? `${message}; ${preservation}` : message);
    }
  }
  const identity = linkedCheckoutIdentity(boundCreation.worktree);
  if (!identity) throw new Error('created worktree identity is unavailable');
  process.stdout.write(`${identity.hostWorktreePath}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sidequest: could not create external worktree: ${message}\n`);
  process.exit(1);
});
