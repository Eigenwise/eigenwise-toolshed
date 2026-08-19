'use strict';

import type { WorktreeLease } from './worktree.js';
import type { VerificationRequirement, VerificationResult } from './verification.js';

export { canonicalPath, createWorktreeLease, isCanonicalRegisteredWorktree, sameCanonicalPath, worktreeCleanupDecision, worktreeCreateDecision, worktreeResumeDecision, worktreeWriteDecision } from './worktree.js';
export type { LeaseDecision, LeaseIdentity, LeaseLiveness, LeasePhase, WorktreeLease, WorktreeLeaseFacts, WorktreeProvisioning } from './worktree.js';
export { captureVerificationResult, validateVerificationWaiver, verificationAccepted, verificationFailureDiagnostic, verificationOutcome, verificationRequirement, verificationWaiverDiagnostic } from './verification.js';
export type { VerificationKind, VerificationRequirement, VerificationResult, VerificationStatus, VerificationWaiver } from './verification.js';

export type SourceRevision = Readonly<{ source: string; value: string; observedAt: string }>;
export type Baseline = Readonly<{ revision: SourceRevision; purpose: 'dispatch' | 'wave' | 'submission' }>;
export type Authority = Readonly<{ actor: string; operation: string; sessionId?: string | null }>;
export type Diagnostic = Readonly<{ code: string; message: string; actionable: boolean }>;
export type InlineEligibility = Readonly<{ eligible: boolean; reasons: readonly string[] }>;
export type PreparedCompatibility = Readonly<{ pluginInstall: string; identity: string }>;
export type AttemptState = 'prepared' | 'launched' | 'bound' | 'claimed' | 'working' | 'verified' | 'submitted' | 'assembled' | 'integrated' | 'closed' | 'released';
export type AttemptEvent = 'launch' | 'bind' | 'bind_claim_token' | 'claim' | 'claim_direct' | 'start_work' | 'verify' | 'submit' | 'assemble' | 'integrate' | 'close' | 'release';
export type Attempt = Readonly<{ state: AttemptState; execution: 'dispatched' | 'direct'; baseline: Baseline; authority: Authority; verification?: VerificationResult; verificationRequirement?: VerificationRequirement; worktree?: WorktreeLease; preparedCompatibility?: PreparedCompatibility }>;

type AttemptTransitions = { readonly [State in AttemptState]: Readonly<Partial<Record<AttemptEvent, AttemptState>>> };
export const ATTEMPT_TRANSITIONS: AttemptTransitions = {
  prepared: { launch: 'launched', bind_claim_token: 'bound', claim_direct: 'claimed', release: 'released' }, launched: { bind: 'bound', bind_claim_token: 'bound', release: 'released' }, bound: { claim: 'claimed', release: 'released' }, claimed: { start_work: 'working', release: 'released' }, working: { verify: 'verified', release: 'released' }, verified: { submit: 'submitted', release: 'released' }, submitted: { assemble: 'assembled', release: 'released' }, assembled: { integrate: 'integrated', release: 'released' }, integrated: { close: 'closed', release: 'released' }, closed: {}, released: {},
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
export function inlineEligibility(input: Readonly<{ namedFiles?: readonly string[]; prompt?: string; requestedResult?: string; unresolvedDesign?: boolean; dependencySequencing?: boolean; destructive?: boolean; highStakes?: boolean; scopeExpanded?: boolean; attempt?: Attempt | null }>): InlineEligibility {
  const reasons: string[] = [];
  if (input.attempt) reasons.push('attempt_exists');
  if ((input.namedFiles || []).length !== 1 && !String(input.prompt || '').trim()) reasons.push('single_named_target_required');
  if (!String(input.requestedResult || '').trim()) reasons.push('explicit_result_required');
  if (input.unresolvedDesign) reasons.push('unresolved_design');
  if (input.dependencySequencing) reasons.push('dependency_sequence');
  if (input.destructive) reasons.push('destructive_operation');
  if (input.highStakes) reasons.push('high_stakes_operation');
  if (input.scopeExpanded) reasons.push('scope_expansion');
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}
export type RevisionPort = Readonly<{ observe(source: string): SourceRevision | null }>;
export type GitPort = Readonly<{ revision(ref: string): SourceRevision | null; isAncestor(older: SourceRevision, newer: SourceRevision): boolean }>;
export type ProcessPort = Readonly<{ run(requirement: VerificationRequirement, options?: Readonly<{ cwd?: string; timeoutMilliseconds?: number; logPath?: string }>): VerificationResult }>;
export type WorktreePort = Readonly<{ acquire(authority: Authority): WorktreeLease | Diagnostic; release(lease: WorktreeLease): void }>;
