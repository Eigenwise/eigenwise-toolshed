'use strict';

import fs from 'node:fs';
import path from 'node:path';

export type LeaseIdentity = Readonly<{ status: 'bound'; agentId?: string; dispatchRef?: string } | { status: 'unknown' }>;
export type LeaseLiveness = Readonly<{ status: 'live'; evidence: string } | { status: 'terminal'; evidence: string } | { status: 'unknown' }>;
export type LeasePhase = 'prepared' | 'created' | 'bound' | 'claimed' | 'working' | 'submitted' | 'integrated' | 'terminal';
export type WorktreeProvisioning = 'host' | 'sidequest-copy' | 'sidequest-link' | 'unknown';
export type WorktreeLeaseFacts = Readonly<{
  repository: string;
  gitDirectory: string;
  commonGitDirectory: string;
  dispatchRef: string | null;
  dispatchBaseline: string | null;
  observedRevision: string | null;
  observedWorktree: string | null;
  boundWorktree?: string | null;
  identity: LeaseIdentity;
  phase: LeasePhase;
  locked: boolean;
  liveness: LeaseLiveness;
  provisioning: WorktreeProvisioning;
}>;
export type WorktreeLease = Readonly<WorktreeLeaseFacts & {
  canonicalRepository: string;
  canonicalGitDirectory: string;
  canonicalCommonGitDirectory: string;
  canonicalWorktree: string | null;
  canonicalBoundWorktree: string | null;
}>;
export type LeaseDecision = Readonly<{ allowed: boolean; reason: string }>;

function platformPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function canonicalPath(value: string): string {
  const gitBashDrive = process.platform === 'win32' ? /^\/([a-zA-Z])(?=\/|$)/.exec(value) : null;
  const resolved = path.resolve(gitBashDrive ? `${gitBashDrive[1]}:${value.slice(2)}` : value);
  const missing: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return platformPath(resolved);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return platformPath(path.join(fs.realpathSync.native(existing), ...missing));
  } catch {
    return platformPath(resolved);
  }
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function createWorktreeLease(facts: WorktreeLeaseFacts): WorktreeLease {
  return Object.freeze({
    ...facts,
    identity: Object.freeze({ ...facts.identity }),
    liveness: Object.freeze({ ...facts.liveness }),
    canonicalRepository: canonicalPath(facts.repository),
    canonicalGitDirectory: canonicalPath(facts.gitDirectory),
    canonicalCommonGitDirectory: canonicalPath(facts.commonGitDirectory),
    canonicalWorktree: facts.observedWorktree ? canonicalPath(facts.observedWorktree) : null,
    canonicalBoundWorktree: facts.boundWorktree ? canonicalPath(facts.boundWorktree) : null,
  });
}

function denied(reason: string): LeaseDecision {
  return Object.freeze({ allowed: false, reason });
}

function allowed(reason: string): LeaseDecision {
  return Object.freeze({ allowed: true, reason });
}

function unknownIdentityDecision(operation: string): LeaseDecision {
  return denied(`${operation} requires a bound worktree identity.`);
}

function incorrectBaselineDecision(lease: WorktreeLease): LeaseDecision | null {
  if (!lease.dispatchBaseline || !lease.observedRevision || lease.dispatchBaseline === lease.observedRevision) return null;
  return denied(`dispatch baseline ${lease.dispatchBaseline} differs from observed worktree revision ${lease.observedRevision}.`);
}

function repositoryDecision(lease: WorktreeLease): LeaseDecision | null {
  if (lease.canonicalCommonGitDirectory !== canonicalPath(path.join(lease.canonicalRepository, '.git'))) {
    return denied('The observed worktree does not share the dispatch repository Git directory.');
  }
  if (lease.canonicalBoundWorktree && lease.canonicalBoundWorktree !== lease.canonicalWorktree) {
    return denied('The observed worktree differs from the dispatch-bound worktree.');
  }
  return null;
}

export function worktreeCreateDecision(lease: WorktreeLease): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Creation');
  if (lease.phase !== 'prepared') return denied('Creation requires a prepared worktree lease.');
  if (!lease.dispatchRef) return denied('Creation requires a dispatch binding.');
  if (!lease.canonicalWorktree || !lease.canonicalBoundWorktree) return denied('Creation requires a bound worktree target.');
  return repositoryDecision(lease) || incorrectBaselineDecision(lease) || allowed('the prepared dispatch owns the bound worktree target.');
}

export function worktreeWriteDecision(lease: WorktreeLease, target: string): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('A write');
  if (!lease.canonicalWorktree) return denied('A write requires an observed worktree.');
  if (!lease.canonicalBoundWorktree) return denied('A write requires an immutable worktree binding.');
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const baseline = incorrectBaselineDecision(lease);
  if (baseline) return baseline;
  const relative = path.relative(lease.canonicalWorktree, canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? allowed('target belongs to the bound worktree.')
    : denied('target is outside the bound worktree.');
}

export function worktreeResumeDecision(lease: WorktreeLease): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Resume');
  if (!lease.canonicalWorktree) return denied('Resume requires an observed worktree.');
  return repositoryDecision(lease) || incorrectBaselineDecision(lease) || allowed('the bound worktree matches the dispatch baseline.');
}

export function worktreeCleanupDecision(lease: WorktreeLease, registeredWorktrees: readonly string[]): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Cleanup');
  if (!lease.canonicalWorktree) return denied('Cleanup requires an observed worktree.');
  if (!registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree!))) return denied('Cleanup requires a canonical registered worktree.');
  if (lease.phase !== 'terminal' && lease.phase !== 'integrated') return denied('Cleanup requires a terminal lease phase.');
  if (lease.locked) return denied('Cleanup refuses a locked worktree.');
  if (lease.liveness.status !== 'terminal') return denied('Cleanup requires proven terminal liveness.');
  if (lease.provisioning === 'unknown') return denied('Cleanup refuses an unknown provisioning strategy.');
  return allowed('the terminal bound worktree is safe to clean.');
}

export function isCanonicalRegisteredWorktree(lease: WorktreeLease, registeredWorktrees: readonly string[]): boolean {
  return Boolean(lease.canonicalWorktree) && registeredWorktrees.some((registered) => sameCanonicalPath(registered, lease.canonicalWorktree!));
}
