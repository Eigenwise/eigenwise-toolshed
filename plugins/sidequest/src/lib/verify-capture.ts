'use strict';

import type { VerificationResult } from './kernel/verification.js';

const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const { runProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');

type VerifyCapture = VerificationResult & Readonly<{ exitCode: number | null; reason?: string }>;
type CaptureTarget = Readonly<{ project: string; ticket: string }>;
type CaptureRecordResult = Readonly<{
  ok: boolean;
  reason?: string;
  capture?: Readonly<{ id: string; candidate: Readonly<{ source: string; value: string }> }>;
}>;
type VerificationCaptureStore = Readonly<{
  findProject(project: string): Readonly<{ ok: boolean; slug?: string; meta?: Readonly<{ path?: string }> }>;
  getTicket(slug: string, ticket: string): unknown;
  workingTreeDeliveryCandidate(slug: string, ticket: unknown): Readonly<{ candidate: Readonly<{ source: string; value: string }> }> | null;
  recordVerificationCapture(slug: string, ticket: string, capture: Readonly<Record<string, unknown>>): CaptureRecordResult;
}>;
type CaptureProject = Readonly<{ slug: string; path: string }>;
function captureRequirement(command: string) {
  return Object.freeze({ kind: 'command' as const, command, evidenceContract: 'command output' });
}

async function runVerifyCapture(command: string, cwd = process.cwd(), timeoutMilliseconds?: number): Promise<VerifyCapture> {
  const result = runProcessVerification(captureRequirement(command), {
    cwd,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...(result.status === 'passed' ? {} : { reason: result.evidence }),
  });
}

function captureTarget(args: readonly string[]): CaptureTarget | null {
  const projectIndex = args.indexOf('--project');
  const ticketIndex = args.indexOf('--ticket');
  const project = projectIndex >= 0 ? String(args[projectIndex + 1] || '').trim() : '';
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || '').trim() : '';
  return project && ticket ? Object.freeze({ project, ticket }) : null;
}

function captureProject(target: CaptureTarget): CaptureProject | null {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = store.findProject(target.project);
  const projectPath = String(project.meta?.path || '').trim();
  return project.ok && project.slug && projectPath ? Object.freeze({ slug: project.slug, path: projectPath }) : null;
}

async function runCapturedVerification(command: string, target: CaptureTarget | null, cwd = process.cwd()) {
  const project = target ? captureProject(target) : null;
  const captureCwd = project?.path || cwd;
  const capture = await runVerifyCapture(command, captureCwd);
  const recorded = target ? recordCapture(target, capture, captureCwd) : null;
  return Object.freeze({ capture, recorded });
}

function verifiedRevision(cwd: string) {
  try {
    const value = String(execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    })).trim().toLowerCase();
    return value ? Object.freeze({ source: 'git', value }) : null;
  } catch (_) {
    return null;
  }
}

function recordCapture(target: CaptureTarget, capture: VerifyCapture, cwd: string) {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = store.findProject(target.project);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_not_found' };
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  const candidate = workingTreeCandidate?.candidate || verifiedRevision(cwd);
  if (!candidate) return { ok: false, reason: 'verified_revision_unavailable' };
  return store.recordVerificationCapture(project.slug, target.ticket, {
    command: capture.command || '',
    status: capture.status,
    candidate,
    completedAt: new Date().toISOString(),
    worktree: cwd,
    logPath: capture.logPath,
    exitCode: capture.exitCode,
  });
}

function report(capture: VerifyCapture, recorded?: any) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : '';
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}\n`);
  process.stdout.write(`details=${capture.logPath || ''}\n`);
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}\n`);
  } else if (recorded) {
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || 'unknown'}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const encoded = args[0] === '--base64' ? args[1] : '';
  const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
  if (!command) {
    process.stderr.write('Usage: node verify-capture.js --base64 <base64 verify command> [--project <path> --ticket <ref>]\n');
    process.exitCode = 2;
    return;
  }
  const target = captureTarget(args);
  const { capture, recorded } = await runCapturedVerification(command, target);
  report(capture, recorded);
  process.exitCode = capture.exitCode === 0 && (!target || recorded?.ok) ? 0 : 2;
}

module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, recordCapture, verifiedRevision };

if (require.main === module) void main();
