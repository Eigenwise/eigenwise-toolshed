'use strict';

import type { WorktreeLease } from './worktree.js';
import type { VerificationRequirement, VerificationResult } from './verification.js';

export { canonicalPath, createWorktreeLease, isCanonicalRegisteredWorktree, sameCanonicalPath, worktreeCleanupDecision, worktreeCreateDecision, worktreeResumeDecision, worktreeWriteDecision } from './worktree.js';
export type { LeaseDecision, LeaseIdentity, LeaseLiveness, LeasePhase, WorktreeLease, WorktreeLeaseFacts, WorktreeProvisioning } from './worktree.js';
export { captureVerificationResult, classifyVerificationKind, commandVerificationResult, validateVerificationWaiver, verificationAccepted, verificationFailureDiagnostic, verificationOutcome, verificationRequirement, verificationWaiverDiagnostic, VERIFICATION_KINDS } from './verification.js';
export type { CompletedVerificationCapture, VerificationKind, VerificationRequirement, VerificationResult, VerificationStatus, VerificationWaiver } from './verification.js';
export { assembleWave, dependentReleaseDecision, openWave, recordAssembledWaveGate, recordWaveDelivery } from './wave.js';
export type { AssembledWave, CandidateInvalidation, DeliveryResult, Wave, WaveAssemblyDecision, WaveCandidate, WaveGateResult, WaveParticipant } from './wave.js';

export type SourceRevision = Readonly<{ source: string; value: string; observedAt: string }>;
export type Baseline = Readonly<{ revision: SourceRevision; purpose: 'dispatch' | 'wave' | 'submission' }>;
export type Authority = Readonly<{ actor: string; operation: string; sessionId?: string | null }>;
export type Diagnostic = Readonly<{ code: string; message: string; actionable: boolean }>;
export type PreparedCompatibility = Readonly<{ pluginInstall: string; identity: string }>;
export type AttemptState = 'prepared' | 'launched' | 'bound' | 'claimed' | 'working' | 'verified' | 'submitted' | 'assembled' | 'integrated' | 'closed' | 'released' | 'invalidated';
export type AttemptEvent = 'launch' | 'bind' | 'bind_claim_token' | 'claim' | 'claim_direct' | 'start_work' | 'verify' | 'submit' | 'assemble' | 'integrate' | 'close' | 'release' | 'invalidate' | 'refresh';
export type Attempt = Readonly<{ state: AttemptState; execution: 'dispatched' | 'direct'; baseline: Baseline; authority: Authority; verification?: VerificationResult; verificationRequirement?: VerificationRequirement; worktree?: WorktreeLease; preparedCompatibility?: PreparedCompatibility }>;

type AttemptTransitions = { readonly [State in AttemptState]: Readonly<Partial<Record<AttemptEvent, AttemptState>>> };
export const ATTEMPT_TRANSITIONS: AttemptTransitions = {
  prepared: { launch: 'launched', bind_claim_token: 'bound', claim_direct: 'claimed', release: 'released' }, launched: { bind: 'bound', bind_claim_token: 'bound', release: 'released' }, bound: { claim: 'claimed', release: 'released' }, claimed: { start_work: 'working', release: 'released' }, working: { verify: 'verified', release: 'released' }, verified: { submit: 'submitted', release: 'released' }, submitted: { assemble: 'assembled', invalidate: 'invalidated', release: 'released' }, assembled: { integrate: 'integrated', invalidate: 'invalidated', release: 'released' }, integrated: { close: 'closed', release: 'released' }, closed: {}, released: {}, invalidated: { refresh: 'working', release: 'released' },
};
export function prepareAttempt(baseline: Baseline, authority: Authority, preparedCompatibility?: PreparedCompatibility, verificationRequirement?: VerificationRequirement): Attempt {
  return Object.freeze({
    state: 'prepared',
    execution: 'dispatched',
    baseline,
    authority,
    ...(preparedCompatibility ? { preparedCompatibility: Object.freeze({ ...preparedCompatibility }) } : {}),
    ...(verificationRequirement ? { verificationRequirement: Object.freeze({ ...verificationRequirement }) } : {}),
  });
}

export function prepareDirectAttempt(baseline: Baseline, authority: Authority): Attempt {
  return Object.freeze({ state: 'prepared', execution: 'direct', baseline, authority });
}

export function transitionAttempt(attempt: Attempt, event: AttemptEvent): Attempt | Diagnostic {
  const directDispatchEvent = attempt.execution === 'direct' && ['launch', 'bind', 'bind_claim_token', 'claim'].includes(event);
  const dispatchedDirectEvent = attempt.execution === 'dispatched' && event === 'claim_direct';
  if (directDispatchEvent || dispatchedDirectEvent) return Object.freeze({ code: 'invalid_transition', message: `Cannot ${event} a ${attempt.execution} attempt.`, actionable: false });
  const next = ATTEMPT_TRANSITIONS[attempt.state][event];
  return next ? Object.freeze({ ...attempt, state: next }) : Object.freeze({ code: 'invalid_transition', message: `Cannot ${event} an attempt in ${attempt.state}.`, actionable: false });
}

export function reduceAttempt(attempt: Attempt, events: readonly AttemptEvent[]): Attempt | Diagnostic {
  let current: Attempt | Diagnostic = attempt;
  for (const event of events) {
    if ('code' in current) return current;
    current = transitionAttempt(current, event);
  }
  return current;
}

export function attemptDiagnostic(result: Attempt | Diagnostic): Diagnostic | null {
  return 'code' in result ? result : null;
}
export type RevisionPort = Readonly<{ observe(source: string): SourceRevision | null }>;
export type GitPort = Readonly<{ revision(ref: string): SourceRevision | null; isAncestor(older: SourceRevision, newer: SourceRevision): boolean }>;
export type ProcessPort = Readonly<{ run(requirement: VerificationRequirement, options?: Readonly<{ cwd?: string; timeoutMilliseconds?: number; logPath?: string }>): VerificationResult }>;
export type WorktreePort = Readonly<{ acquire(authority: Authority): WorktreeLease | Diagnostic; release(lease: WorktreeLease): void }>;
