'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  // Revisions the board itself authored for this dispatch, while its claim is still held. A commit the
  // lifecycle sanctioned is not drift away from the baseline, so it must not revoke the lease that
  // authorized it (SQ-2182).
  sanctionedRevisions?: readonly string[];
  observedRevision: string | null;
  observedWorktree: string | null;
  boundRevision?: string | null;
  boundWorktree?: string | null;
  boundGitDirectory?: string | null;
  boundCommonGitDirectory?: string | null;
  boundCheckoutInstance?: string | null;
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
  canonicalBoundGitDirectory: string | null;
  canonicalBoundCommonGitDirectory: string | null;
  observedCheckoutInstance: string | null;
}>;
export type LeaseDecision = Readonly<{ allowed: boolean; reason: string }>;

const CHECKOUT_INSTANCE_MARKER = 'sidequest-checkout-instance';

function checkoutInstanceDigest(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function checkoutInstanceIdentity(gitDirectory: string): string | null {
  try {
    const token = fs.readFileSync(path.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(token) ? checkoutInstanceDigest(token) : null;
  } catch {
    return null;
  }
}

export function createCheckoutInstanceMarker(gitDirectory: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(gitDirectory, CHECKOUT_INSTANCE_MARKER), `${token}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return checkoutInstanceDigest(token);
}

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
    sanctionedRevisions: Object.freeze((facts.sanctionedRevisions || []).map((revision) => String(revision).toLowerCase())),
    canonicalRepository: canonicalPath(facts.repository),
    canonicalGitDirectory: canonicalPath(facts.gitDirectory),
    canonicalCommonGitDirectory: canonicalPath(facts.commonGitDirectory),
    canonicalWorktree: facts.observedWorktree ? canonicalPath(facts.observedWorktree) : null,
    canonicalBoundWorktree: facts.boundWorktree ? canonicalPath(facts.boundWorktree) : null,
    canonicalBoundGitDirectory: facts.boundGitDirectory ? canonicalPath(facts.boundGitDirectory) : null,
    canonicalBoundCommonGitDirectory: facts.boundCommonGitDirectory ? canonicalPath(facts.boundCommonGitDirectory) : null,
    observedCheckoutInstance: checkoutInstanceIdentity(facts.gitDirectory),
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

function sanctionedRevision(lease: WorktreeLease, revision: string | null): boolean {
  return Boolean(revision && (lease.sanctionedRevisions || []).includes(revision.toLowerCase()));
}

// A refusal delivered through a hook has a hard byte budget, and full hashes are 40 bytes each of the
// least actionable content in the sentence. Twelve is past any collision an executor will meet, and the
// full value is one rev-parse away.
function shortRevision(revision: string | null): string {
  return String(revision || '').slice(0, 12);
}

function incorrectBaselineDecision(lease: WorktreeLease): LeaseDecision | null {
  if (!lease.dispatchBaseline || !lease.observedRevision || lease.dispatchBaseline === lease.observedRevision) return null;
  // The board sanctioned this HEAD for this dispatch while its claim was held, so the executor's own
  // committed work is not drift. Before this, the first sanctioned commit permanently revoked the write
  // lease, and submit then demanded a release fragment the executor was mechanically forbidden to create
  // (SQ-2182). Scope is named as a non-cause on purpose: the refusal read like a permission problem and
  // sent executors to request access they already held. Both clauses lead, ahead of the hashes, because
  // the hook budget truncates the tail and the meaning must be what survives.
  if (sanctionedRevision(lease, lease.observedRevision)) return null;
  return denied(
    'this revision was not sanctioned by the board for this claim, so it reads as drift from the dispatch baseline; '
    + `not a scope decision (baseline ${shortRevision(lease.dispatchBaseline)}, observed ${shortRevision(lease.observedRevision)}).`,
  );
}

function boundRevisionDecision(lease: WorktreeLease): LeaseDecision | null {
  if (!lease.boundRevision || !lease.observedRevision || lease.boundRevision === lease.observedRevision) return null;
  return denied(`bound worktree revision ${lease.boundRevision} differs from observed worktree revision ${lease.observedRevision}.`);
}

function repositoryDecision(lease: WorktreeLease): LeaseDecision | null {
  if (lease.canonicalCommonGitDirectory !== canonicalPath(path.join(lease.canonicalRepository, '.git'))) {
    return denied('The observed worktree does not share the dispatch repository Git directory.');
  }
  if (lease.canonicalBoundWorktree && lease.canonicalBoundWorktree !== lease.canonicalWorktree) {
    return denied('The observed worktree differs from the dispatch-bound worktree.');
  }
  if (lease.canonicalBoundGitDirectory && lease.canonicalBoundGitDirectory !== lease.canonicalGitDirectory) {
    return denied('The observed worktree Git directory differs from the dispatch-bound Git directory.');
  }
  if (lease.canonicalBoundCommonGitDirectory && lease.canonicalBoundCommonGitDirectory !== lease.canonicalCommonGitDirectory) {
    return denied('The observed common Git directory differs from the dispatch-bound common Git directory.');
  }
  return null;
}

function checkoutInstanceDecision(lease: WorktreeLease): LeaseDecision | null {
  if (lease.canonicalGitDirectory === lease.canonicalCommonGitDirectory) return null;
  if (!lease.boundCheckoutInstance) return denied('The dispatch-bound checkout instance is unavailable.');
  if (!lease.observedCheckoutInstance) return denied('The observed checkout instance is unavailable.');
  return lease.boundCheckoutInstance === lease.observedCheckoutInstance
    ? null
    : denied('The observed checkout instance differs from the dispatch-bound checkout instance.');
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
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
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
  return repositoryDecision(lease) || checkoutInstanceDecision(lease) || boundRevisionDecision(lease) || allowed('the bound worktree matches its release-time identity.');
}

export function worktreeCleanupDecision(lease: WorktreeLease, registeredWorktrees: readonly string[]): LeaseDecision {
  if (lease.identity.status === 'unknown') return unknownIdentityDecision('Cleanup');
  if (!lease.canonicalWorktree) return denied('Cleanup requires an observed worktree.');
  const repository = repositoryDecision(lease);
  if (repository) return repository;
  const checkoutInstance = checkoutInstanceDecision(lease);
  if (checkoutInstance) return checkoutInstance;
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
