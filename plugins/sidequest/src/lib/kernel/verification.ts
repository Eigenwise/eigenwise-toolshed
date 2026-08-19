'use strict';

import type { Diagnostic } from './index.js';

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
  timeoutMilliseconds?: number;
  outputTail?: string | null;
  failureIdentities?: readonly string[];
  waiver?: VerificationWaiver;
}>;

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
  const kind = requiredKind(nonEmpty(input.kind || 'command').toLowerCase());
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
    if (!suite) return Object.freeze({ kind: 'suite', evidenceContract: evidence || 'named suite output' });
    return Object.freeze({ kind: 'suite', suite, command: suiteCommand(suite), evidenceContract: `suite ${suite.name} output` });
  }
  if (['document', 'link', 'schema', 'custom'].includes(kind)) {
    return Object.freeze({ kind, evidenceContract: evidence || `${kind} verification evidence`, ...(command ? { command } : {}) });
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
