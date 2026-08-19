'use strict';

import type { VerificationRequirement, VerificationResult } from '../kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

export type ProcessVerificationOptions = Readonly<{
  cwd?: string;
  timeoutMilliseconds?: number;
  logPath?: string;
  outputTailBytes?: number;
}>;

export type VerificationProcessPort = Readonly<{
  run(requirement: VerificationRequirement, options?: ProcessVerificationOptions): VerificationResult;
}>;

const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
const COMMAND_NOT_FOUND_EXIT_CODES = new Set([127, 9009]);

function shellCommand(scriptPath: string, platform = process.platform): Readonly<{ executable: string; arguments: readonly string[] }> {
  if (platform === 'win32') {
    return Object.freeze({
      executable: process.env.ComSpec || 'cmd.exe',
      arguments: Object.freeze(['/d', '/s', '/c', scriptPath]),
    });
  }
  return Object.freeze({
    executable: process.env.SHELL || '/bin/sh',
    arguments: Object.freeze([scriptPath]),
  });
}

function shellScript(command: string, platform = process.platform): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      `"%ComSpec%" /d /s /c "${command}"`,
      'set "sidequestExitCode=%ERRORLEVEL%"',
      'echo __SIDEQUEST_VERIFY_EXIT__=%sidequestExitCode%',
      'exit /b %sidequestExitCode%',
      '',
    ].join('\r\n');
  }
  return `(\n${command}\n)\nsidequest_exit_code=$?\nprintf '\\n__SIDEQUEST_VERIFY_EXIT__=%s\\n' "$sidequest_exit_code"\nexit "$sidequest_exit_code"\n`;
}

function temporaryScript(command: string): string {
  const extension = process.platform === 'win32' ? '.cmd' : '.sh';
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${extension}`);
  fs.writeFileSync(scriptPath, shellScript(command), { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  return scriptPath;
}

function defaultLogPath(): string {
  return path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}.log`);
}

function markerExitCode(logPath: string): number | null {
  const output = fs.readFileSync(logPath, 'utf8');
  const matches = [...output.matchAll(/^__SIDEQUEST_VERIFY_EXIT__=(\d+)$/gm)];
  const marker = matches.at(-1);
  return marker ? Number(marker[1]) : null;
}

function outputTail(logPath: string, maximumBytes: number): string {
  const size = fs.statSync(logPath).size;
  const length = Math.min(size, maximumBytes);
  if (!length) return '';
  const file = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(file, buffer, 0, length, size - length);
    return `${size > length ? '[output truncated]\n' : ''}${buffer.toString('utf8')}`.trim();
  } finally {
    fs.closeSync(file);
  }
}

function commandNotFound(logPath: string, exitCode: number): boolean {
  if (COMMAND_NOT_FOUND_EXIT_CODES.has(exitCode)) return true;
  if (process.platform !== 'win32' || exitCode !== 1) return false;
  return /^'[^']+' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, 'utf8'));
}

function processTimedOut(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT';
}

function failedResult(requirement: VerificationRequirement, status: 'failed_suite' | 'toolchain_missing' | 'could_not_run' | 'timeout', command: string, logPath: string, reason: string, exitCode: number | null, tail: string, timeoutMilliseconds?: number): VerificationResult {
  const identity = exitCode == null ? status : `${status}:exit-${exitCode}`;
  return Object.freeze({
    kind: requirement.kind,
    status,
    evidence: reason,
    command,
    logPath,
    exitCode,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    outputTail: tail || null,
    failureIdentities: Object.freeze([identity]),
  });
}

export function runProcessVerification(requirement: VerificationRequirement, options: ProcessVerificationOptions = {}): VerificationResult {
  const command = String(requirement.command || '').trim();
  if (!command) {
    return Object.freeze({
      kind: requirement.kind,
      status: 'could_not_run',
      evidence: 'The required command verifier has no pinned command.',
      command: null,
      failureIdentities: Object.freeze(['could_not_run:missing-command']),
    });
  }
  const logPath = options.logPath || defaultLogPath();
  const timeoutMilliseconds = options.timeoutMilliseconds || DEFAULT_TIMEOUT_MILLISECONDS;
  const outputTailBytes = options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES;
  const scriptPath = temporaryScript(command);
  let outcome: import('node:child_process').SpawnSyncReturns<Buffer> | null = null;
  try {
    const log = fs.openSync(logPath, 'w');
    try {
      const shell = shellCommand(scriptPath);
      outcome = spawnSync(shell.executable, shell.arguments, {
        cwd: options.cwd || process.cwd(),
        windowsHide: true,
        timeout: timeoutMilliseconds,
        stdio: ['ignore', log, log],
      });
    } finally {
      fs.closeSync(log);
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return failedResult(requirement, 'could_not_run', command, logPath, reason, 2, fs.existsSync(logPath) ? outputTail(logPath, outputTailBytes) : '');
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  const tail = outputTail(logPath, outputTailBytes);
  if (processTimedOut(outcome?.error)) {
    return failedResult(requirement, 'timeout', command, logPath, `Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`, 2, tail, timeoutMilliseconds);
  }
  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    const shellExitCode = outcome?.status ?? (outcome?.error ? 2 : null);
    return failedResult(requirement, 'could_not_run', command, logPath, `The command shell exited ${shellExitCode ?? 'without a code'} before reporting the suite exit code.`, shellExitCode, tail);
  }
  if (commandNotFound(logPath, exitCode)) {
    return failedResult(requirement, 'toolchain_missing', command, logPath, `The command shell could not find a command for ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail);
  }
  if (exitCode === 0) {
    return Object.freeze({ kind: requirement.kind, status: 'passed', evidence: requirement.evidenceContract, command, logPath, exitCode });
  }
  return failedResult(requirement, 'failed_suite', command, logPath, `The required command exited ${exitCode}.`, exitCode, tail);
}

export function createProcessPort(): VerificationProcessPort {
  return Object.freeze({ run: runProcessVerification });
}

export { shellCommand };
