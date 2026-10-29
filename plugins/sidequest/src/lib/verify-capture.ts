'use strict';

import type { VerificationResult } from './kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { createHash, randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { execFileSync } = require('./git-process.js') as typeof import('./git-process.js');
const { runOwnedProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');
const { canonicalPath } = require('./kernel/worktree.js') as { canonicalPath(value: string): string };
const { crossedWorktreeRefusalMessage } = require('./refusal-guidance.js') as typeof import('./refusal-guidance.js');
const { verifyCwdForRequirement } = require('./kernel/verification.js') as typeof import('./kernel/verification.js');

type CaptureSlotFileSystem = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readdirSync' | 'renameSync' | 'rmSync' | 'writeFileSync'>;

const captureSlotTimeoutMilliseconds = 30 * 60 * 1_000;
const captureSlotRetryMilliseconds = 50;
const captureSlotOperationRetryLimit = 20;
const captureSlotContentionErrorCodes = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY']);

type VerifyCapture = VerificationResult & Readonly<{
  exitCode: number | null;
  reason?: string;
  waitedForSlotMs?: number;
  queuePosition?: number;
}>;
type CaptureTarget = Readonly<{ project: string; ticket: string }>;
type RecordedCapture = NonNullable<CaptureRecordResult['capture']>;
type CaptureRecordResult = Readonly<{
  ok: boolean;
  reason?: string;
  message?: string;
  capture?: Readonly<{ id: string; candidate: Readonly<{ source: string; value: string }>; control?: boolean; controlOutcome?: string; failingTests?: readonly string[] }>;
}>;
type VerificationCaptureStore = Readonly<{
  findProject(project: string): Readonly<{ ok: boolean; slug?: string; meta?: Readonly<{ path?: string }> }>;
  getTicket(slug: string, ticket: string): unknown;
  homeRoot(): string;
  projectDir(slug: string): string;
  boardConfig(slug: string): Readonly<{ integrationVerifyTimeoutMs: number }>;
  normalizeIntegrationVerifyTimeoutMs(value?: number): number;
  workingTreeDeliveryCandidate(slug: string, ticket: unknown): Readonly<{ candidate: Readonly<{ source: string; value: string }> }> | null;
  pinnedVerificationRequirement(ticket: unknown): Readonly<{ command?: string; environment?: 'shared'; suite?: unknown }>;
  recordVerificationCapture(slug: string, ticket: string, capture: Readonly<Record<string, unknown>>): CaptureRecordResult;
  crossedWorktreeBinding(slug: string, ticket: unknown, actualWorktree: string): import('./refusal-guidance.js').CrossedWorktreeBinding | null;
}>;
type CaptureProject = Readonly<{ slug: string; path: string }>;
type CaptureSlotLease = Readonly<{
  waitedForSlotMs: number;
  queuePosition: number;
  release(): Promise<CaptureSlotFailure | null>;
}>;
type CaptureSlotTimeout = Readonly<{
  waitedForSlotMs: number;
  queuePosition: number;
  reason: string;
}>;
type CaptureSlotFailure = Readonly<{
  reason: string;
  errorCode: string;
}>;
type SynchronousCaptureSlotLease = Readonly<{
  waitedForSlotMs: number;
  queuePosition: number;
  release(): CaptureSlotFailure | null;
}>;

function captureRequirement(command: string) {
  return Object.freeze({ kind: 'command' as const, command, evidenceContract: 'command output' });
}

function captureLogPath(target: CaptureTarget | null = null): string {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = target ? captureProject(target) : null;
  const directory = project
    ? path.join(store.projectDir(project.slug), 'verification', target!.ticket)
    : path.join(store.homeRoot(), 'verification', 'unbound');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'capture-' + process.pid + '-' + randomUUID() + '.log');
}

async function runConfiguredCapture(command: string, cwd: string, target: CaptureTarget | null, environment?: NodeJS.ProcessEnv): Promise<VerifyCapture> {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = target ? captureProject(target) : null;
  const timeoutMilliseconds = project ? store.boardConfig(project.slug).integrationVerifyTimeoutMs : store.normalizeIntegrationVerifyTimeoutMs();
  const capture = await runOrdinaryCapture(command, cwd, timeoutMilliseconds, environment, captureLogPath(target), project);
  if (capture.status !== 'timeout') return capture;
  const reason = 'integrationVerifyTimeoutMs=' + timeoutMilliseconds + 'ms. ' + capture.reason;
  return Object.freeze({ ...capture, evidence: reason, reason });
}

async function runVerifyCapture(command: string, cwd = process.cwd(), timeoutMilliseconds = (require('./store.js') as VerificationCaptureStore).normalizeIntegrationVerifyTimeoutMs(), environment?: NodeJS.ProcessEnv, logPath = captureLogPath()): Promise<VerifyCapture> {
  const result = await runOwnedProcessVerification(captureRequirement(command), {
    cwd,
    logPath,
    timeoutMilliseconds,
    ...(environment === undefined ? {} : { environment }),
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...(result.status === 'passed' ? {} : { reason: result.evidence }),
  });
}

function liveVerificationCaptureCount(boardDirectory: string): number {
  const directory = path.join(boardDirectory, 'running-captures');
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory).filter(waiterProcessIsAlive).length;
}

async function runOrdinaryCapture(command: string, cwd: string, timeoutMilliseconds: number, environment: NodeJS.ProcessEnv | undefined, logPath: string, project: CaptureProject | null): Promise<VerifyCapture> {
  if (!project || isFullSuiteCommand(command)) return runVerifyCapture(command, cwd, timeoutMilliseconds, environment, logPath);
  const store = require('./store.js') as VerificationCaptureStore;
  const directory = path.join(store.projectDir(project.slug), 'running-captures');
  fs.mkdirSync(directory, { recursive: true });
  const record = path.join(directory, `${Date.now().toString().padStart(15, '0')}-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }));
  try {
    return await runVerifyCapture(command, cwd, timeoutMilliseconds, environment, logPath);
  } finally {
    fs.rmSync(record, { force: true });
  }
}

function isFullSuiteCommand(command: string): boolean {
  return /(?:^|[\s&;()])npm(?:\.cmd|\.exe)?\s+(?:(?:--(?:prefix|workspace)|-w)(?:=|\s+)(?:"[^"]+"|'[^']+'|[^\s&;|()]+)\s+|(?:--workspaces|-ws)\s+)*run\s+(?:test:full|quality:crap)(?:\s|$)/.test(command);
}

function repositoryRoot(directory: string): string {
  try {
    const commonGitDirectory = String(execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const commonGitPath = path.resolve(directory, commonGitDirectory);
    return canonicalPath(path.basename(commonGitPath).toLowerCase() === '.git' ? path.dirname(commonGitPath) : directory);
  } catch {
    return canonicalPath(directory);
  }
}

function captureSlotDirectory(project: string): string {
  // Linked worktrees share one repository runtime, so their full-suite captures share a slot.
  const projectHash = createHash('sha256').update(repositoryRoot(project)).digest('hex');
  return path.join(os.tmpdir(), 'sidequest-verify-capture-slots', projectHash);
}

function captureSlotWaiterPath(slotDirectory: string, fileSystem: CaptureSlotFileSystem = fs): string {
  const waitingDirectory = path.join(slotDirectory, 'waiting');
  fileSystem.mkdirSync(waitingDirectory, { recursive: true });
  return path.join(waitingDirectory, `${Date.now().toString().padStart(15, '0')}-${process.pid}-${randomUUID()}.json`);
}

function waiterProcessId(waiterName: string): number | null {
  const match = /^\d{15}-(\d+)-.+\.json$/.exec(waiterName);
  const processId = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
}

function waiterProcessIsAlive(waiterName: string): boolean {
  const processId = waiterProcessId(waiterName);
  if (processId === null) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return captureSlotErrorCode(error) === 'EPERM';
  }
}

function queuedWaiters(slotDirectory: string, fileSystem: CaptureSlotFileSystem = fs): readonly string[] {
  const waitingDirectory = path.join(slotDirectory, 'waiting');
  try {
    const liveWaiters: string[] = [];
    for (const waiterName of fileSystem.readdirSync(waitingDirectory).sort()) {
      if (waiterProcessIsAlive(waiterName)) {
        liveWaiters.push(waiterName);
        continue;
      }
      try {
        fileSystem.rmSync(path.join(waitingDirectory, waiterName), { force: true });
      } catch {
        liveWaiters.push(waiterName);
      }
    }
    return liveWaiters;
  } catch {
    return [];
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, milliseconds);
}

function captureSlotErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : String(error);
}

function captureSlotOperationFailure(operation: string, slotPath: string, attempts: number, error: unknown): CaptureSlotFailure {
  const errorCode = captureSlotErrorCode(error);
  return Object.freeze({
    reason: `Verification capture could not ${operation} slot path ${JSON.stringify(slotPath)} after ${attempts} retries; last errno ${errorCode}.`,
    errorCode,
  });
}

async function retryCaptureSlotOperation(operation: string, slotPath: string, execute: () => void): Promise<CaptureSlotFailure | null> {
  for (let attempts = 1; attempts <= captureSlotOperationRetryLimit; attempts += 1) {
    try {
      execute();
      return null;
    } catch (error: unknown) {
      const errorCode = captureSlotErrorCode(error);
      if (!captureSlotContentionErrorCodes.has(errorCode) || attempts === captureSlotOperationRetryLimit) {
        return captureSlotOperationFailure(operation, slotPath, attempts, error);
      }
      await wait(captureSlotRetryMilliseconds);
    }
  }
  throw new Error('Capture slot operation retry loop completed unexpectedly.');
}

// The waiter is removed even when the active directory cannot be released. A waiter left
// behind by a still-running process (the board serving integrate) stays "alive" to
// queuedWaiters by PID and would park every later capture behind it (SQ-2916).
async function releaseCaptureSlot(activeDirectory: string, fileSystem: CaptureSlotFileSystem, waiterPath?: string): Promise<CaptureSlotFailure | null> {
  const tombstoneDirectory = `${activeDirectory}.released-${process.pid}-${randomUUID()}`;
  const renameFailure = await retryCaptureSlotOperation('rename', activeDirectory, () => fileSystem.renameSync(activeDirectory, tombstoneDirectory));
  const activeFailure = renameFailure
    ? (renameFailure.errorCode === 'ENOENT' ? null : renameFailure)
    : await retryCaptureSlotOperation('remove', tombstoneDirectory, () => fileSystem.rmSync(tombstoneDirectory, { recursive: true, force: true }));
  const waiterFailure = waiterPath
    ? await retryCaptureSlotOperation('remove', waiterPath, () => fileSystem.rmSync(waiterPath, { force: true }))
    : null;
  return activeFailure || waiterFailure;
}

function retryCaptureSlotOperationSynchronously(operation: string, slotPath: string, execute: () => void): CaptureSlotFailure | null {
  for (let attempts = 1; attempts <= captureSlotOperationRetryLimit; attempts += 1) {
    try {
      execute();
      return null;
    } catch (error: unknown) {
      const errorCode = captureSlotErrorCode(error);
      if (!captureSlotContentionErrorCodes.has(errorCode) || attempts === captureSlotOperationRetryLimit) {
        return captureSlotOperationFailure(operation, slotPath, attempts, error);
      }
      waitSynchronously(captureSlotRetryMilliseconds);
    }
  }
  throw new Error('Capture slot operation retry loop completed unexpectedly.');
}

function releaseCaptureSlotSynchronously(activeDirectory: string, fileSystem: CaptureSlotFileSystem, waiterPath?: string): CaptureSlotFailure | null {
  const tombstoneDirectory = `${activeDirectory}.released-${process.pid}-${randomUUID()}`;
  const renameFailure = retryCaptureSlotOperationSynchronously('rename', activeDirectory, () => fileSystem.renameSync(activeDirectory, tombstoneDirectory));
  const activeFailure = renameFailure
    ? (renameFailure.errorCode === 'ENOENT' ? null : renameFailure)
    : retryCaptureSlotOperationSynchronously('remove', tombstoneDirectory, () => fileSystem.rmSync(tombstoneDirectory, { recursive: true, force: true }));
  const waiterFailure = waiterPath
    ? retryCaptureSlotOperationSynchronously('remove', waiterPath, () => fileSystem.rmSync(waiterPath, { force: true }))
    : null;
  return activeFailure || waiterFailure;
}

function acquireCaptureSlotSynchronously(project: string, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem: CaptureSlotFileSystem = fs): SynchronousCaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  fileSystem.writeFileSync(waiterPath, '', { encoding: 'utf8', flag: 'wx' });
  let queuePosition = 1;
  let acquireContentionAttempts = 0;

  for (;;) {
    const waiters = queuedWaiters(slotDirectory, fileSystem);
    const waiterIndex = waiters.indexOf(waiterName);
    const active = fileSystem.existsSync(activeDirectory);
    if (active && (waiters.length === 0 || waiters[0] === waiterName)) {
      const releaseFailure = releaseCaptureSlotSynchronously(activeDirectory, fileSystem);
      if (releaseFailure) {
        fileSystem.rmSync(waiterPath, { force: true });
        return releaseFailure;
      }
      continue;
    }
    queuePosition = Math.max(queuePosition, waiterIndex + 1);
    if (!active && waiterIndex === 0) {
      try {
        fileSystem.mkdirSync(activeDirectory);
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => releaseCaptureSlotSynchronously(activeDirectory, fileSystem, waiterPath),
        });
      } catch (error: unknown) {
        const errorCode = captureSlotErrorCode(error);
        if (!captureSlotContentionErrorCodes.has(errorCode)) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, 1, error);
        }
        acquireContentionAttempts += 1;
        if (acquireContentionAttempts === captureSlotOperationRetryLimit) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, acquireContentionAttempts, error);
        }
      }
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for the repository full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit.`,
      });
    }
    waitSynchronously(captureSlotRetryMilliseconds);
  }
}

async function acquireCaptureSlot(project: string, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem: CaptureSlotFileSystem = fs): Promise<CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure> {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  fileSystem.writeFileSync(waiterPath, '', { encoding: 'utf8', flag: 'wx' });
  let waitingAnnounced = false;
  let queuePosition = 1;
  let acquireContentionAttempts = 0;

  for (;;) {
    const waiters = queuedWaiters(slotDirectory, fileSystem);
    const waiterIndex = waiters.indexOf(waiterName);
    const active = fileSystem.existsSync(activeDirectory);
    if (active && (waiters.length === 0 || waiters[0] === waiterName)) {
      const releaseFailure = await releaseCaptureSlot(activeDirectory, fileSystem);
      if (releaseFailure) {
        fileSystem.rmSync(waiterPath, { force: true });
        return releaseFailure;
      }
      continue;
    }
    queuePosition = Math.max(queuePosition, waiterIndex + 1);
    if (!active && waiterIndex === 0) {
      let acquired = false;
      try {
        fileSystem.mkdirSync(activeDirectory);
        acquired = true;
      } catch (error: unknown) {
        const errorCode = captureSlotErrorCode(error);
        if (!captureSlotContentionErrorCodes.has(errorCode)) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, 1, error);
        }
        acquireContentionAttempts += 1;
        if (acquireContentionAttempts === captureSlotOperationRetryLimit) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure('create', activeDirectory, acquireContentionAttempts, error);
        }
      }
      if (acquired) {
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => releaseCaptureSlot(activeDirectory, fileSystem, waiterPath),
        });
      }
    }
    if (!waitingAnnounced) {
      const siblingCount = queuePosition - 1;
      process.stdout.write(`verify-capture: waiting for ${siblingCount} sibling capture${siblingCount === 1 ? '' : 's'} to finish (queue position ${queuePosition}).\n`);
      waitingAnnounced = true;
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for the repository full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit.`,
      });
    }
    await wait(captureSlotRetryMilliseconds);
  }
}

function captureSlotTimeout(command: string, slot: CaptureSlotTimeout): VerifyCapture {
  return Object.freeze({
    kind: 'command',
    status: 'timeout',
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(['timeout:capture-slot-contention']),
    reason: slot.reason,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition,
  });
}

function captureSlotCouldNotRun(command: string, slot: CaptureSlotFailure): VerifyCapture {
  return Object.freeze({
    kind: 'command',
    status: 'could_not_run',
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(['could_not_run:capture-slot']),
    reason: slot.reason,
  });
}

function runFullSuiteVerification(command: string, project: string, verify: (environment: NodeJS.ProcessEnv) => VerificationResult, fileSystem: CaptureSlotFileSystem = fs): VerifyCapture {
  let slot: SynchronousCaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure;
  try {
    slot = acquireCaptureSlotSynchronously(project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire its repository full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error),
    }));
  }
  if ('reason' in slot) {
    return 'waitedForSlotMs' in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture: VerifyCapture;
  let releaseFailure: CaptureSlotFailure | null = null;
  try {
    const result = verify({
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1),
    });
    capture = Object.freeze({ ...result, exitCode: result.exitCode ?? null });
  } finally {
    releaseFailure = slot.release();
  }
  if (releaseFailure) return captureSlotCouldNotRun(command, releaseFailure);
  return Object.freeze({
    ...capture,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition,
  });
}

async function runFullSuiteCapture(command: string, target: CaptureTarget, cwd: string, fileSystem: CaptureSlotFileSystem = fs): Promise<VerifyCapture> {
  let slot: CaptureSlotLease | CaptureSlotTimeout | CaptureSlotFailure;
  try {
    slot = await acquireCaptureSlot(target.project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire its repository full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error),
    }));
  }
  if ('reason' in slot) {
    return 'waitedForSlotMs' in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture: VerifyCapture;
  let releaseFailure: CaptureSlotFailure | null = null;
  try {
    capture = await runConfiguredCapture(command, cwd, target, {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1),
    });
  } finally {
    releaseFailure = await slot.release();
  }
  if (releaseFailure) return captureSlotCouldNotRun(command, releaseFailure);
  return Object.freeze({
    ...capture,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition,
  });
}

function captureTarget(args: readonly string[]): CaptureTarget | null {
  const projectIndex = args.indexOf('--project');
  const ticketIndex = args.indexOf('--ticket');
  const project = projectIndex >= 0 ? String(args[projectIndex + 1] || '').trim() : '';
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || '').trim() : '';
  return project && ticket ? Object.freeze({ project, ticket }) : null;
}

function explicitWorktreeArgument(args: readonly string[]): string | undefined {
  const index = args.indexOf('--worktree');
  const value = index >= 0 ? String(args[index + 1] || '').trim() : '';
  return value || undefined;
}

function captureProject(target: CaptureTarget): CaptureProject | null {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = store.findProject(target.project);
  const projectPath = String(project.meta?.path || '').trim();
  return project.ok && project.slug && projectPath ? Object.freeze({ slug: project.slug, path: projectPath }) : null;
}

function captureWorkingDirectory(target: CaptureTarget, cwd: string): string {
  const project = captureProject(target);
  if (!project) return cwd;
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  if (store.workingTreeDeliveryCandidate(project.slug, ticket)) return project.path;
  // A cross-project dispatch runs its executor in the spawning checkout, where the
  // ticket's files do not exist. A doc- or lint-style verify built from negated
  // greps then matches nothing, every negation succeeds, and the capture records a
  // pass that proves nothing (SQ-2884). Verification belongs to the ticket's own
  // repository; linked worktrees of it share that repository and stay put.
  return repositoryRoot(cwd) === repositoryRoot(project.path) ? cwd : project.path;
}

function isWorkingTreeDeliveryTarget(target: CaptureTarget): boolean {
  const project = captureProject(target);
  if (!project) return false;
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  return Boolean(store.workingTreeDeliveryCandidate(project.slug, ticket));
}

// GitHub #110: the briefing command names --project/--ticket but never the
// dispatch's bound worktree, so an executor that runs it from the wrong
// checkout (the shared registered one instead of its isolated worktree) got a
// capture recorded against a revision it never touched. Only the ticket's own
// dispatch record -- not a second, invented source -- knows which worktree it
// promised.
function dispatchBoundWorktree(target: CaptureTarget): string | null {
  const project = captureProject(target);
  if (!project) return null;
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket) as { dispatch?: { sharedTree?: boolean; worktree?: string } } | null;
  const dispatch = ticket?.dispatch;
  if (!dispatch || dispatch.sharedTree === true) return null;
  const worktree = String(dispatch.worktree || '').trim();
  return worktree || null;
}

// A capture refusal has to separate "you ran this from the wrong place" from "your dispatch is bound to a
// checkout another live executor owns". The second is unactionable as written - the bound tree cannot be entered,
// and its contents are the other ticket's - so the shared crossed-binding message replaces it (GH-235).
function crossedCaptureRefusal(target: CaptureTarget, actualWorktree: string): string | null {
  const project = captureProject(target);
  if (!project) return null;
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  const crossing = store.crossedWorktreeBinding(project.slug, ticket, actualWorktree);
  return crossing ? crossedWorktreeRefusalMessage('verify-capture', crossing) : null;
}

// Both refusals a bound worktree can produce, in the order they have to be tried: a crossing first, because
// "run it from the bound worktree" is impossible advice once another live executor owns that tree.
function boundWorktreeRefusal(target: CaptureTarget, actualWorktree: string, mismatch: string): string {
  return crossedCaptureRefusal(target, actualWorktree)
    || `verify-capture: ${target.ticket}'s dispatch is bound to worktree ${canonicalPath(dispatchBoundWorktree(target)!)}, but ${mismatch}`;
}

function isWithinWorktree(root: string, candidate: string): boolean {
  const relative = path.relative(root, canonicalPath(candidate));
  if (relative === '') return true;
  const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !climbsOut && !path.isAbsolute(relative);
}

type CaptureCwdResolution = Readonly<{ cwd: string; refusal: string | null }>;

function resolveCaptureCwd(target: CaptureTarget | null, cwd: string, explicitWorktree?: string): CaptureCwdResolution {
  // The working-tree-delivery override runs the shared checkout by design, so it
  // outranks both the --worktree flag and the bound-worktree refusal below.
  if (target && isWorkingTreeDeliveryTarget(target)) {
    return Object.freeze({ cwd: captureWorkingDirectory(target, cwd), refusal: null });
  }
  const bound = target ? dispatchBoundWorktree(target) : null;
  const canonicalBound = bound ? canonicalPath(bound) : null;
  if (explicitWorktree) {
    const canonicalWorktree = canonicalPath(explicitWorktree);
    // The flag is as caller-controlled as cwd was, so it may only name the worktree the
    // dispatch record already bound; any other tree with the same HEAD but different
    // ignored build state could otherwise certify the bound candidate.
    if (canonicalBound && canonicalWorktree !== canonicalBound) {
      return Object.freeze({
        cwd,
        refusal: boundWorktreeRefusal(target!, canonicalWorktree, `--worktree names ${canonicalWorktree}. Only the bound worktree can verify this ticket; run it from ${canonicalBound}, or pass --worktree ${canonicalBound}.`),
      });
    }
    if (!isWithinWorktree(canonicalWorktree, cwd)) {
      process.stdout.write(`verify-capture: running from ${cwd}, but --worktree names ${canonicalWorktree}; continuing in the bound worktree.\n`);
    }
    return Object.freeze({ cwd: canonicalWorktree, refusal: null });
  }
  if (canonicalBound && !isWithinWorktree(canonicalBound, cwd)) {
    return Object.freeze({
      cwd,
      refusal: boundWorktreeRefusal(target!, cwd, `this command ran from ${cwd}. Run it from ${canonicalBound}, or pass --worktree ${canonicalBound}.`),
    });
  }
  return Object.freeze({ cwd: target ? captureWorkingDirectory(target, cwd) : cwd, refusal: null });
}

function checkoutRoot(directory: string): string {
  try {
    return String(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim() || directory;
  } catch {
    return directory;
  }
}

// GH-259: a nested workspace's gate runs from the ticket's verifyCwd, which is relative to the checkout
// root; the checkout itself (and so the revision and cleanliness checks) stays where it was resolved.
function verifyCommandDirectory(target: CaptureTarget, captureCwd: string): string {
  const project = captureProject(target);
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = project ? store.getTicket(project.slug, target.ticket) as { executorVerifyCwd?: string } | null : null;
  const directory = ticket ? verifyCwdForRequirement(store.pinnedVerificationRequirement(ticket), ticket.executorVerifyCwd) : '';
  return directory ? path.join(checkoutRoot(captureCwd), directory) : captureCwd;
}

async function runCapturedVerification(command: string, target: CaptureTarget | null, cwd = process.cwd(), fileSystem: CaptureSlotFileSystem = fs, explicitWorktree?: string, control = false) {
  const resolution = resolveCaptureCwd(target, cwd, explicitWorktree);
  if (resolution.refusal) return Object.freeze({ capture: null, recorded: null, refusal: resolution.refusal });
  if (!target) return Object.freeze({ capture: await runConfiguredCapture(command, resolution.cwd, null), recorded: null, refusal: null });
  return runTargetCapture(command, target, resolution.cwd, fileSystem, control);
}

// A negative control runs over source the executor reverted on purpose, so its dirty tree is the
// point of the run rather than a hole in the proof; it is recorded as a control, never as the
// candidate's verification.
function dirtyCaptureRefusal(target: CaptureTarget, captureCwd: string, cleanWorktree: boolean, control: boolean): string | null {
  if (cleanWorktree || control || isWorkingTreeDeliveryTarget(target)) return null;
  return `verify-capture: capture=unrecorded reason=verification_capture_dirty_worktree\nVerification capture for ${target.ticket} ran with uncommitted changes in ${captureCwd}. A verifier must run over the committed candidate, so nothing is recorded. Commit or discard the changes, then rerun the pinned verifier.`;
}

async function runTargetCapture(command: string, target: CaptureTarget, captureCwd: string, fileSystem: CaptureSlotFileSystem, control: boolean) {
  // Cleanliness is observed before the run: a verifier may leave logs or coverage output behind,
  // and what matters is the content it read.
  const statusPaths = worktreeStatusPaths(captureCwd);
  const cleanWorktree = statusPaths?.length === 0;
  const refusal = dirtyCaptureRefusal(target, captureCwd, cleanWorktree, control);
  if (refusal) return Object.freeze({ capture: null, recorded: null, refusal });
  const commandCwd = verifyCommandDirectory(target, captureCwd);
  const capture = isFullSuiteCommand(command)
    ? await runFullSuiteCapture(command, target, commandCwd, fileSystem)
    : await runConfiguredCapture(command, commandCwd, target);
  const observation = control ? Object.freeze({ dirtyPaths: statusPaths ?? [] }) : null;
  return Object.freeze({ capture, recorded: recordCapture(target, capture, captureCwd, cleanWorktree, observation), refusal: null });
}

const TAP_FAILURE = /^\s*not ok \d+ - (.+)$/;
const SPEC_FAILURE = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/;
const TAP_DIRECTIVE = /\s#\s*(?:TODO|SKIP)\b/i;
// node --test reports a file that failed to load or run under the file's own path; that is an
// import or collection failure, which proves nothing about an assertion.
const TEST_FILE_ENTRY = /\.[cm]?[jt]sx?$/i;

function failingTestName(line: string): string | null {
  const match = TAP_FAILURE.exec(line) || SPEC_FAILURE.exec(line);
  const name = (match?.[1] ?? '').trim().replace(/\\(.)/g, '$1');
  return [name, name !== 'failing tests:', !TAP_DIRECTIVE.test(line), !TEST_FILE_ENTRY.test(name)].every(Boolean) ? name : null;
}

function failingTestNames(output: string): string[] {
  const names = output.split(/\r?\n/).map(failingTestName).filter((name): name is string => name !== null);
  return [...new Set(names)];
}

function captureLogText(logPath: string | null | undefined): string {
  try {
    return logPath ? fs.readFileSync(logPath, 'utf8') : '';
  } catch {
    return '';
  }
}

type ControlObservation = Readonly<{ dirtyPaths: readonly string[] }>;

function controlCaptureFields(capture: VerifyCapture, observation: ControlObservation | null) {
  if (!observation) return {};
  return { control: true, failingTests: failingTestNames(captureLogText(capture.logPath)), dirtyPaths: observation.dirtyPaths };
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

// SQ-2789: the recorded revision is the cwd's HEAD, which says nothing about what the run
// actually read. Captures over uncommitted edits are refused before they can certify content
// that no verifier ran.
function verifiedWorktreeIsClean(cwd: string) {
  return worktreeStatusPaths(cwd)?.length === 0;
}

function worktreeStatusPaths(cwd: string): string[] | null {
  try {
    return String(execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    })).split(/\r?\n/).filter((line) => line.trim()).map((line) => line.slice(3).trim());
  } catch (_) {
    return null;
  }
}

function foreignCaptureRepository(projectPath: string, cwd: string): string | null {
  const ticketRepository = repositoryRoot(projectPath);
  return repositoryRoot(cwd) === ticketRepository ? null : ticketRepository;
}

type CandidateRevision = Readonly<{ source: string; value: string }>;
type CandidateResolution = Readonly<{ ok: true; candidate: CandidateRevision }> | Readonly<{ ok: false; reason: string; message?: string }>;

function revisionCandidate(cwd: string): CandidateResolution {
  const candidate = verifiedRevision(cwd);
  return candidate ? { ok: true, candidate } : { ok: false, reason: 'verified_revision_unavailable' };
}

function committedCaptureCandidate(store: VerificationCaptureStore, slug: string, target: CaptureTarget, cwd: string, cleanWorktree: boolean): CandidateResolution {
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(slug, store.getTicket(slug, target.ticket));
  // A working-tree delivery is identified by the content hash of its uncommitted paths, so the
  // tree being dirty is the candidate, not a hole in the proof.
  if (workingTreeCandidate) return { ok: true, candidate: workingTreeCandidate.candidate };
  return cleanWorktree ? revisionCandidate(cwd) : {
    ok: false,
    reason: 'verification_capture_dirty_worktree',
    message: `Verification capture for ${target.ticket} ran with uncommitted changes in ${cwd}. A verifier must run over the committed candidate, so nothing is recorded. Commit or discard the changes, then rerun the pinned verifier.`,
  };
}

// A control reverts source on top of the committed candidate, so the commit it binds to is HEAD,
// whatever the reverted tree's content hash would be.
function captureCandidate(store: VerificationCaptureStore, slug: string, target: CaptureTarget, cwd: string, cleanWorktree: boolean, control: boolean): CandidateResolution {
  return control ? revisionCandidate(cwd) : committedCaptureCandidate(store, slug, target, cwd, cleanWorktree);
}

function recordCapture(target: CaptureTarget, capture: VerifyCapture, cwd: string, cleanWorktree = verifiedWorktreeIsClean(cwd), control: ControlObservation | null = null) {
  const store = require('./store.js') as VerificationCaptureStore;
  const project = store.findProject(target.project);
  if (!project.ok || !project.slug) return { ok: false, reason: 'project_not_found' };
  const projectPath = String(project.meta?.path || '').trim();
  // The capture's own status says nothing about where it ran, so a run outside the
  // ticket's repository is refused rather than certified: it never saw the files
  // the ticket changed (SQ-2884).
  const ticketRepository = projectPath ? foreignCaptureRepository(projectPath, cwd) : null;
  if (ticketRepository) {
    return {
      ok: false,
      reason: 'verification_capture_foreign_repository',
      message: `Verification capture for ${target.ticket} ran in ${cwd}, which is not the ticket's repository ${ticketRepository}. A verify that never saw the ticket's files proves nothing about them, so nothing is recorded. Run the pinned verifier from the ticket's own checkout.`,
    };
  }
  const resolved = captureCandidate(store, project.slug, target, cwd, cleanWorktree, control !== null);
  if (!resolved.ok) return resolved;
  return store.recordVerificationCapture(project.slug, target.ticket, {
    command: capture.command || '',
    status: capture.status,
    candidate: resolved.candidate,
    cleanWorktree,
    completedAt: new Date().toISOString(),
    worktree: cwd,
    logPath: capture.logPath,
    exitCode: capture.exitCode,
    shell: capture.shell,
    ...(capture.waitedForSlotMs === undefined ? {} : { waitedForSlotMs: capture.waitedForSlotMs }),
    ...(capture.queuePosition === undefined ? {} : { queuePosition: capture.queuePosition }),
    ...controlCaptureFields(capture, control),
  });
}

function report(capture: VerifyCapture, recorded?: CaptureRecordResult | null) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : '';
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}\n`);
  process.stdout.write(`shell=${capture.shell || ''}\n`);
  process.stdout.write(`details=${capture.logPath || ''}\n`);
  if (capture.waitedForSlotMs !== undefined) {
    process.stdout.write(`capture-slot waitedForSlotMs=${capture.waitedForSlotMs} queuePosition=${capture.queuePosition || 1}\n`);
  }
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}\n`);
  } else if (recorded) {
    // SQ-2713: the reason alone is undiagnosable. The store's message is the only
    // place the pinned and captured commands are printed side by side, and a
    // reviewer that cannot see them can only retry blind.
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || 'unknown'}\n`);
    if (recorded.message) process.stdout.write(`${recorded.message}\n`);
  }
}

function controlNextStep(capture: RecordedCapture): string {
  return capture.controlOutcome === 'failed'
    ? `Restore the change, then post: [sidequest:negative-control] capture=${capture.id}`
    : 'This control proves nothing: a control must fail at least one named test assertion on the reverted source.';
}

function writeControlLines(capture: RecordedCapture) {
  const failingTests = capture.failingTests ?? [];
  process.stdout.write(`control=${capture.controlOutcome || 'unknown'} failures=${failingTests.length}\n`);
  for (const name of failingTests) process.stdout.write(`control-failed=${name}\n`);
  process.stdout.write(`${controlNextStep(capture)}\n`);
}

function reportControl(recorded: CaptureRecordResult | null) {
  const capture = recorded?.ok ? recorded.capture : null;
  if (capture?.control) writeControlLines(capture);
}

// The wrapper's own exit says whether the run proved what was asked: a candidate capture must pass,
// and a control capture must be recorded with failing tests.
function captureSucceeded(capture: VerifyCapture, recorded: CaptureRecordResult | null, control: boolean): boolean {
  if (control) return recorded?.capture?.controlOutcome === 'failed';
  return capture.exitCode === 0 && (!recorded || recorded.ok);
}

const usage = 'Usage: node verify-capture.js --project <path> --ticket <ref> [--worktree <path>] [--control]\n'
  + '       node verify-capture.js --base64 <base64 verify command> [--worktree <path>]';

function base64Command(args: readonly string[]): string {
  const encoded = args[0] === '--base64' ? args[1] : '';
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
}

function unrecordedRefusal(reason: string, message: string): Readonly<{ refusal: string }> {
  return Object.freeze({ refusal: `verify-capture: capture=unrecorded reason=${reason}\n${message}` });
}

// GH-373: executors retyped the briefing's base64 blob, and one wrong character ran a different
// command. The ticket's pinned requirement is the same authority recordVerificationCapture compares
// against, so loading it here leaves nothing to copy.
function pinnedRequirementCommand(target: CaptureTarget, requirement: Readonly<{ command?: string; environment?: 'shared' }>): Readonly<{ command: string }> | Readonly<{ refusal: string }> {
  const command = String(requirement.command || '').trim();
  if (!command) return unrecordedRefusal('verification_capture_no_pinned_command', `${target.ticket} has no pinned verify command, so there is nothing for the wrapper to run. Record the evidence its verifier asks for instead.`);
  // SQ-3424: an environment-bound command runs in the shared checkout at integrate, never in the executor's worktree.
  if (requirement.environment === 'shared') {
    return unrecordedRefusal('verification_capture_environment_lane', `${target.ticket}'s pinned verifier is environment-bound (board verifyEnvironment: shared). The orchestrator runs it in the shared checkout at integrate. Run focused checks that need no environment, commit, and submit; submit records the capture as deferred.`);
  }
  return Object.freeze({ command });
}

function pinnedTicketCommand(target: CaptureTarget): Readonly<{ command: string }> | Readonly<{ refusal: string }> {
  const project = captureProject(target);
  if (!project) return unrecordedRefusal('project_not_found', `No Sidequest board is registered for ${target.project}, so there is no pinned verify command to run for ${target.ticket}.`);
  const store = require('./store.js') as VerificationCaptureStore;
  const ticket = store.getTicket(project.slug, target.ticket);
  if (!ticket) return unrecordedRefusal('not_found', `Ticket ${target.ticket} does not exist on the board for ${target.project}.`);
  return pinnedRequirementCommand(target, store.pinnedVerificationRequirement(ticket));
}

// A passed command that matches the pin changes nothing; one that differs is refused rather than
// silently replaced, so the caller learns its copy was wrong.
function pinnedCommandMatching(target: CaptureTarget, passedCommand: string): Readonly<{ command: string }> | Readonly<{ refusal: string }> {
  const pinned = pinnedTicketCommand(target);
  if ('refusal' in pinned || !passedCommand || passedCommand === pinned.command) return pinned;
  return unrecordedRefusal('verification_capture_command_mismatch', [
    `The command passed with --base64 is not the verify command pinned on ${target.ticket}, so nothing ran.`,
    `Pinned command: ${JSON.stringify(pinned.command)}`,
    `Passed command: ${JSON.stringify(passedCommand)}`,
    'Drop --base64 and rerun with only --project and --ticket (and --worktree if the briefing gave one): the wrapper then loads the pinned command from the ticket itself.',
  ].join('\n'));
}

function captureCommand(args: readonly string[], target: CaptureTarget | null): Readonly<{ command: string }> | Readonly<{ refusal: string }> {
  const passedCommand = base64Command(args);
  if (target) return pinnedCommandMatching(target, passedCommand);
  return passedCommand ? Object.freeze({ command: passedCommand }) : Object.freeze({ refusal: usage });
}

// --control runs the pinned command over source the executor reverted, so it needs a ticket to
// record against; a bare --base64 run has nothing to bind the failure to.
function captureCommandForArguments(args: readonly string[], target: CaptureTarget | null, control: boolean): Readonly<{ command: string }> | Readonly<{ refusal: string }> {
  if (control && !target) return Object.freeze({ refusal: `--control needs --project and --ticket so the failing control is recorded against its ticket.\n${usage}` });
  return captureCommand(args, target);
}

async function captureFromArguments(args: readonly string[]) {
  const target = captureTarget(args);
  const control = args.includes('--control');
  const resolved = captureCommandForArguments(args, target, control);
  if ('refusal' in resolved) return Object.freeze({ capture: null, recorded: null, refusal: resolved.refusal });
  return runCapturedVerification(resolved.command, target, process.cwd(), fs, explicitWorktreeArgument(args), control);
}

async function main() {
  const args = process.argv.slice(2);
  const { capture, recorded, refusal } = await captureFromArguments(args);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
    return;
  }
  report(capture!, recorded);
  reportControl(recorded);
  process.exitCode = captureSucceeded(capture!, recorded, args.includes('--control')) ? 0 : 2;
}

module.exports = { liveVerificationCaptureCount, runOrdinaryCapture, runVerifyCapture, runCapturedVerification, captureCommand, failingTestNames, runFullSuiteVerification, shellCommand, captureTarget, explicitWorktreeArgument, captureProject, captureSlotDirectory, isFullSuiteCommand, recordCapture, verifiedRevision };

if (require.main === module) void main();
