'use strict';

import type { Diagnostic } from './index.js';
import type { SubmissionVerification } from './submission.js';
import { sameCanonicalPath } from './worktree.js';
import path from 'node:path';

export const VERIFICATION_KINDS = ['suite', 'command', 'document', 'link', 'schema', 'manual', 'attestation', 'review', 'custom'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const VERIFICATION_STATUSES = ['passed', 'failed_suite', 'toolchain_missing', 'could_not_run', 'timeout', 'manual', 'attestation', 'skipped', 'failed_check'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type VerificationSuite = Readonly<{
  name: string;
  cwd: string;
  setup?: string | null;
  command: string;
}>;

export type VerificationRequirement = Readonly<{
  kind: VerificationKind;
  evidenceContract: string;
  command?: string;
  suite?: VerificationSuite;
  artifact?: string;
}>;

export type VerificationWaiver = Readonly<{
  authority: string;
  reason: string;
  affectedGate: string;
  scope?: string;
  expiresAt?: string;
}>;

export type VerificationResult = Readonly<{
  kind: VerificationKind | string;
  status: VerificationStatus;
  evidence: string;
  command?: string | null;
  logPath?: string | null;
  exitCode?: number | null;
  shell?: string | null;
  timeoutMilliseconds?: number;
  outputTail?: string | null;
  failureIdentities?: readonly string[];
  waiver?: VerificationWaiver;
  diagnostics?: readonly Diagnostic[];
  verifiedTree?: string;
}>;

export type CompletedVerificationCapture = Readonly<{
  id: string;
  ticket: string;
  command: string;
  status: VerificationStatus;
  candidate: Readonly<{ source: string; value: string }>;
  completedAt: string;
  cleanWorktree?: boolean;
  worktree?: string;
  logPath?: string | null;
  exitCode?: number | null;
  shell?: string | null;
  waitedForSlotMs?: number;
  queuePosition?: number;
  dispatchNonce: string;
}>;

type VerificationCandidate = Readonly<{ source: string; value: string }>;

type RequirementInput = Readonly<{
  kind?: string;
  evidence?: string;
  command?: string;
  artifact?: string;
  suite?: Readonly<{ name?: string; cwd?: string; setup?: string | null; command?: string }> | null;
}>;

type Capture = Readonly<{
  status: string;
  reason?: string;
  command?: string;
  logPath?: string;
  exitCode?: number | null;
}>;

function nonEmpty(value: unknown): string {
  return String(value || '').trim();
}

function requiredKind(value: string): VerificationKind {
  return (VERIFICATION_KINDS as readonly string[]).includes(value) ? value as VerificationKind : 'custom';
}

export function classifyVerificationKind(verify: unknown, declaredKind?: unknown): VerificationKind {
  if (/^manual:\s+/i.test(nonEmpty(verify))) return 'manual';
  return requiredKind(nonEmpty(declaredKind || 'command').toLowerCase());
}

function suiteFrom(input: RequirementInput): VerificationSuite | undefined {
  if (!input.suite) return undefined;
  const name = nonEmpty(input.suite.name);
  const cwd = nonEmpty(input.suite.cwd);
  const command = nonEmpty(input.suite.command);
  return name && cwd && command
    ? Object.freeze({ name, cwd, setup: input.suite.setup || null, command })
    : undefined;
}

function suiteCommand(suite: VerificationSuite): string {
  return `cd ${suite.cwd} && ${[suite.setup, suite.command].filter(Boolean).join(' && ')}`;
}

export function validationDiagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({ code, message, actionable: true });
}

export function verificationRequirement(input: RequirementInput): VerificationRequirement {
  const kind = classifyVerificationKind(input.evidence || input.command, input.kind);
  const evidence = nonEmpty(input.evidence);
  const command = nonEmpty(input.command || (kind === 'command' ? evidence : ''));
  const suite = suiteFrom(input);
  if (kind === 'attestation') {
    const artifact = nonEmpty(input.artifact);
    return Object.freeze({ kind, artifact, evidenceContract: `attestation evidence for ${artifact}` });
  }
  if (kind === 'review') return Object.freeze({ kind, evidenceContract: evidence || 'independent review findings' });
  if (kind === 'manual') return Object.freeze({ kind, evidenceContract: evidence.replace(/^manual:\s*/i, '') || 'manual verification evidence' });
  if (kind === 'suite' || (!command && suite)) {
    if (!suite) return Object.freeze({ kind: 'suite', ...(command ? { command } : {}), evidenceContract: evidence || 'named suite output' });
    return Object.freeze({ kind: 'suite', suite, command: suiteCommand(suite), evidenceContract: `suite ${suite.name} output` });
  }
  if (['document', 'link', 'schema', 'custom'].includes(kind)) {
    return Object.freeze({ kind, evidenceContract: evidence || `${kind} verification evidence` });
  }
  return Object.freeze({ kind: 'command', command: command || undefined, evidenceContract: command || 'command output' });
}

export function verificationWaiverDiagnostic(waiver: VerificationWaiver): Diagnostic {
  return validationDiagnostic('verification_waived', `Verification gate ${waiver.affectedGate} waived by ${waiver.authority}: ${waiver.reason}`);
}

export function validateVerificationWaiver(value: unknown, now = new Date()): VerificationWaiver | Diagnostic {
  if (!value || typeof value !== 'object') return validationDiagnostic('verification_waiver_required', 'Skipping required verification requires a human waiver with authority, reason, affectedGate, and bounded scope or expiry.');
  const waiver = value as Record<string, unknown>;
  const authority = nonEmpty(waiver.authority);
  const reason = nonEmpty(waiver.reason);
  const affectedGate = nonEmpty(waiver.affectedGate);
  const scope = nonEmpty(waiver.scope);
  const expiresAt = nonEmpty(waiver.expiresAt);
  if (!authority || !reason || !affectedGate || (!scope && !expiresAt)) {
    return validationDiagnostic('verification_waiver_incomplete', 'A verification waiver requires authority, reason, affectedGate, and either scope or expiresAt.');
  }
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) {
    return validationDiagnostic('verification_waiver_expired', 'A verification waiver expiry must be a future ISO timestamp.');
  }
  return Object.freeze({ authority, reason, affectedGate, ...(scope ? { scope } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) });
}

export function verificationAccepted(result: VerificationResult): boolean {
  if (result.status === 'passed' || result.status === 'manual' || result.status === 'attestation') return true;
  if (result.status !== 'skipped') return false;
  return !('code' in validateVerificationWaiver(result.waiver));
}

export function verificationOutcome(result: VerificationResult): string {
  return verificationAccepted(result) ? 'verified' : `verification_${String(result.status).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

export function verificationFailureDiagnostic(result: VerificationResult): Diagnostic | null {
  if (verificationAccepted(result)) return null;
  const identities = result.failureIdentities?.length ? ` Failures: ${result.failureIdentities.join(', ')}.` : '';
  return validationDiagnostic(`verification_${String(result.status).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, `Required ${result.kind} verification returned ${result.status}.${identities}`);
}

function captureAttemptLabel(dispatchNonce: string): string {
  return dispatchNonce ? `dispatch attempt ${dispatchNonce}` : 'this direct claim';
}

// GH-377: a direct claimant has no briefing that names the wrapper, so the refusal has to.
function missingCaptureInstruction(command: string, directCaptureInvocation: string): string {
  if (!directCaptureInvocation) return `Run ${JSON.stringify(command)} through the dispatched verify-capture wrapper again after finalizing that candidate, then resubmit.`;
  return `A direct claim has no dispatch briefing: from the checkout holding that candidate, run ${directCaptureInvocation} (it loads the pinned command from the ticket and records the capture), then resubmit.`;
}

function comparableVerificationPaths(verify: string, root: string): { command: string; root: string } {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const checkout = normalize(path.resolve(root));
  const command = normalize(verify);
  return /^[a-z]:\//i.test(checkout)
    ? { command: command.toLowerCase(), root: checkout.toLowerCase() }
    : { command, root: checkout };
}

function commandNamesCheckout(command: string, root: string): boolean {
  let offset = command.indexOf(root);
  while (offset !== -1) {
    const next = command.charAt(offset + root.length);
    if (!next || next === '/' || !/[a-z0-9._-]/i.test(next)) return true;
    offset = command.indexOf(root, offset + root.length);
  }
  return false;
}

export function verifyEmbedsWorktreeRoot(verify: unknown, root: string): boolean {
  if (typeof verify !== 'string' || !verify || !root) return false;
  const comparable = comparableVerificationPaths(verify, root);
  return commandNamesCheckout(comparable.command, comparable.root);
}

function captureMatchesExecution(capture: CompletedVerificationCapture, ticket: string, command: string, dispatchNonce: string): boolean {
  return capture.ticket === ticket && capture.command === command
    && capture.status === 'passed' && capture.dispatchNonce === dispatchNonce;
}

function captureMatchesRoot(capture: CompletedVerificationCapture, root: string): boolean {
  if (!root) return true;
  return Boolean(capture.worktree) && sameCanonicalPath(capture.worktree || '', root);
}

function captureMatchesCandidate(capture: CompletedVerificationCapture, candidate: VerificationCandidate, root: string): boolean {
  return capture.candidate.source === candidate.source && capture.candidate.value === candidate.value
    && captureMatchesRoot(capture, root);
}

function failedCommandVerification(requirement: VerificationRequirement, command: string, message: string, identity: string, code: string, expectedEvidence: string | null): SubmissionVerification {
  return Object.freeze({
    result: Object.freeze({ kind: requirement.kind, status: 'failed_check', evidence: message, command, failureIdentities: Object.freeze([identity]) }),
    expectedEvidence,
    diagnostic: Object.freeze({ code, message, retryable: true }),
  });
}

function missingCommandCaptureMessage(ticket: string, command: string, candidate: VerificationCandidate, dispatchNonce: string, directCaptureInvocation: string, dirtyCapture: CompletedVerificationCapture | undefined): string {
  if (dirtyCapture) return `Verification capture ${dirtyCapture.id} for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)} ran over a dirty worktree. Commit or discard the changes, then run the pinned verifier again before resubmitting.`;
  return `No completed passed verification capture exists for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)}. ${missingCaptureInstruction(command, directCaptureInvocation)}`;
}

function passedCommandVerification(requirement: VerificationRequirement, command: string, capture: CompletedVerificationCapture): SubmissionVerification {
  return Object.freeze({ result: Object.freeze({
    kind: requirement.kind, status: 'passed', evidence: command, command,
    logPath: capture.logPath || null, exitCode: capture.exitCode ?? null,
  }), expectedEvidence: command });
}

export function commandVerificationResult(requirement: VerificationRequirement, evidence: string, captures: readonly CompletedVerificationCapture[], ticket: string, candidate: VerificationCandidate, dispatchNonce: string, directCaptureInvocation = '', root = ''): SubmissionVerification {
  const command = requirement.command || '';
  if (evidence !== command) return failedCommandVerification(requirement, command,
    'verification must match the declared executor verify command and the prepared command verifier; executors cannot replace the required command.',
    'verification:evidence-mismatch', 'executor_verify_mismatch', command);
  const matchingCapture = (capture: CompletedVerificationCapture): boolean => captureMatchesExecution(capture, ticket, command, dispatchNonce)
    && captureMatchesCandidate(capture, candidate, root);
  const provesCandidate = (capture: CompletedVerificationCapture): boolean => capture.candidate.source === 'working-tree' || capture.cleanWorktree === true;
  const completedCapture = captures.find((capture): boolean => matchingCapture(capture) && provesCandidate(capture));
  if (completedCapture) return passedCommandVerification(requirement, command, completedCapture);
  const dirtyCapture = captures.find((capture): boolean => matchingCapture(capture) && capture.cleanWorktree === false);
  const message = missingCommandCaptureMessage(ticket, command, candidate, dispatchNonce, directCaptureInvocation, dirtyCapture);
  const failure = dirtyCapture
    ? { identity: 'verification:dirty-worktree-capture', code: 'verification_capture_dirty_worktree' }
    : { identity: 'verification:capture-required', code: 'verification_capture_required' };
  return failedCommandVerification(requirement, command, message, failure.identity, failure.code, null);
}

export function captureVerificationResult(requirement: VerificationRequirement, capture: Capture): VerificationResult {
  if (capture.status === 'passed') {
    return Object.freeze({ kind: requirement.kind, status: 'passed', evidence: requirement.evidenceContract, command: capture.command || requirement.command || null, logPath: capture.logPath || null });
  }
  const status: VerificationStatus = capture.status === 'failed_suite'
    ? 'failed_suite'
    : capture.status === 'timeout'
      ? 'timeout'
      : capture.status === 'toolchain_missing'
        ? 'toolchain_missing'
        : 'could_not_run';
  const identity = capture.exitCode == null ? status : `${status}:exit-${capture.exitCode}`;
  return Object.freeze({ kind: requirement.kind, status, evidence: String(capture.reason || ''), command: capture.command || requirement.command || null, logPath: capture.logPath || null, failureIdentities: Object.freeze([identity]) });
}
