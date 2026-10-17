'use strict';

import type { Diagnostic } from './index.js';

export const VERIFICATION_KINDS = ['suite', 'command', 'typecheck', 'document', 'link', 'schema', 'manual', 'attestation', 'review', 'custom'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const VERIFICATION_STATUSES = ['passed', 'failed_suite', 'toolchain_missing', 'could_not_run', 'timeout', 'manual', 'attestation', 'skipped', 'failed_check', 'deferred'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_ENVIRONMENTS = ['isolated', 'shared'] as const;
export type VerificationEnvironment = (typeof VERIFICATION_ENVIRONMENTS)[number];

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
  environment?: 'shared';
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

const ENVIRONMENT_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)+/;

export function environmentPrefix(command: unknown): string {
  return ENVIRONMENT_ASSIGNMENTS.exec(nonEmpty(command))?.[0].trim() || '';
}

// GH-552: the generated command keeps the author's environment prefix on every step it runs.
function suiteCommand(suite: VerificationSuite, environment: string): string {
  const steps = [suite.setup, suite.command].filter(Boolean).map((step) => [environment, step].filter(Boolean).join(' '));
  return `cd ${suite.cwd} && ${steps.join(' && ')}`;
}

// GH-552: a generated suite command opens with its own `cd`, so it runs from the checkout root and verifyCwd
// applies only to a command the author wrote.
export function verifyCwdForRequirement(requirement: Readonly<{ suite?: unknown }> | null | undefined, verifyCwd?: string): string {
  return requirement?.suite ? '' : String(verifyCwd || '');
}

export function validationDiagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({ code, message, actionable: true });
}

function suiteVerificationRequirement(input: RequirementInput, command: string, evidence: string): VerificationRequirement {
  const suite = suiteFrom(input);
  if (suite) return Object.freeze({ kind: 'suite', suite, command: suiteCommand(suite, environmentPrefix(command)), evidenceContract: `suite ${suite.name} output` });
  return Object.freeze({ kind: 'suite', ...(command ? { command } : {}), evidenceContract: evidence || 'named suite output' });
}

function executableVerificationRequirement(input: RequirementInput, kind: VerificationKind, evidence: string): VerificationRequirement {
  const command = nonEmpty([input.command, ['command', 'typecheck'].includes(kind) ? evidence : ''].find(Boolean));
  if ([kind === 'suite', [!command, Boolean(suiteFrom(input))].every(Boolean)].some(Boolean)) return suiteVerificationRequirement(input, command, evidence);
  return Object.freeze({ kind, command: command || undefined, evidenceContract: command || 'command output' });
}

function evidenceVerificationRequirement(input: RequirementInput, kind: VerificationKind, evidence: string): VerificationRequirement {
  if (kind === 'attestation') {
    const artifact = nonEmpty(input.artifact);
    return Object.freeze({ kind, artifact, evidenceContract: `attestation evidence for ${artifact}` });
  }
  const defaults: Partial<Record<VerificationKind, string>> = { review: 'independent review findings', manual: 'manual verification evidence' };
  return Object.freeze({ kind, evidenceContract: evidence || defaults[kind] || `${kind} verification evidence` });
}

export function verificationRequirement(input: RequirementInput): VerificationRequirement {
  const kind = classifyVerificationKind(input.evidence || input.command, input.kind);
  const evidence = nonEmpty(input.evidence);
  const evidenceOnly = ['attestation', 'review', 'manual'].includes(kind);
  const executable = [['command', 'suite', 'typecheck'].includes(kind), [!evidenceOnly, !nonEmpty(input.command), Boolean(suiteFrom(input))].every(Boolean)].some(Boolean);
  if (executable) return executableVerificationRequirement(input, kind, evidence);
  return evidenceVerificationRequirement(input, kind, evidence.replace(/^manual:\s*/i, kind === 'manual' ? '' : '$&'));
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

function missingCaptureVerificationResult(requirement: VerificationRequirement, command: string, dirtyCapture: CompletedVerificationCapture | undefined, ticket: string, candidate: VerificationCandidate, dispatchNonce: string, directCaptureInvocation: string) {
  const message = dirtyCapture
    ? `Verification capture ${dirtyCapture.id} for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)} ran over a dirty worktree. Commit or discard the changes, then run the pinned verifier again before resubmitting.`
    : `No completed passed verification capture exists for ${ticket}, ${captureAttemptLabel(dispatchNonce)}, ${candidate.source}:${candidate.value}, and declared command ${JSON.stringify(command)}. ${missingCaptureInstruction(command, directCaptureInvocation)}`;
  return Object.freeze({
    result: Object.freeze({ kind: requirement.kind, status: 'failed_check' as const, evidence: message, command, failureIdentities: Object.freeze([dirtyCapture ? 'verification:dirty-worktree-capture' : 'verification:capture-required']) }),
    expectedEvidence: null,
    diagnostic: Object.freeze({ code: dirtyCapture ? 'verification_capture_dirty_worktree' : 'verification_capture_required', message, retryable: true }),
  });
}

export function commandVerificationResult(requirement: VerificationRequirement, evidence: string, captures: readonly CompletedVerificationCapture[], ticket: string, candidate: VerificationCandidate, dispatchNonce: string, directCaptureInvocation = '') {
  const command = requirement.command;
  if (!command) {
    const message = 'Command verification requires a dispatch-pinned verifier.';
    return Object.freeze({
      result: Object.freeze({ kind: requirement.kind, status: 'failed_check' as const, evidence: message, command, failureIdentities: Object.freeze(['verification:pinned-command-missing']) }),
      expectedEvidence: null,
      diagnostic: Object.freeze({ code: 'executor_verify_required', message, retryable: true }),
    });
  }
  const matchingCapture = (capture: CompletedVerificationCapture) => capture.ticket === ticket
    && capture.command === command
    && capture.status === 'passed'
    && capture.candidate.source === candidate.source
    && capture.candidate.value === candidate.value
    && capture.dispatchNonce === dispatchNonce;
  const provesCandidate = (capture: CompletedVerificationCapture) => capture.candidate.source === 'working-tree' || capture.cleanWorktree === true;
  const completedCapture = captures.find((capture) => matchingCapture(capture) && provesCandidate(capture));
  if (!completedCapture) {
    const dirtyCapture = captures.find((capture) => matchingCapture(capture) && capture.cleanWorktree === false);
    return missingCaptureVerificationResult(requirement, command, dirtyCapture, ticket, candidate, dispatchNonce, directCaptureInvocation);
  }
  return Object.freeze({
    result: Object.freeze({
      kind: requirement.kind,
      status: 'passed' as const,
      verifierSource: 'pinned' as const,
      evidence: command,
      command,
      logPath: completedCapture.logPath || null,
      exitCode: completedCapture.exitCode ?? null,
    }),
    expectedEvidence: command,
  });
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
