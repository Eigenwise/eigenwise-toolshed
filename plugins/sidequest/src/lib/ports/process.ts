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

type ShellDefinition = Readonly<{
  executable: string;
  label: string;
  scriptExtension: '.cmd' | '.sh';
}>;

type ShellCommand = ShellDefinition & Readonly<{ arguments: readonly string[] }>;

function windowsPosixShell(): string | null {
  const programFilesDirectories = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((directory): directory is string => Boolean(directory));
  const candidates = [...new Set(programFilesDirectories.map((directory) => path.join(directory, 'Git', 'bin', 'sh.exe')))];
  const installedShell = candidates.find((candidate) => fs.existsSync(candidate));
  if (installedShell) return installedShell;
  const discovered = spawnSync('where.exe', ['sh.exe'], { encoding: 'utf8', windowsHide: true });
  if (discovered.status !== 0) return null;
  return String(discovered.stdout || '')
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => fs.existsSync(candidate)) || null;
}

function shellDefinition(platform = process.platform): ShellDefinition {
  if (platform === 'win32') {
    const posixShell = windowsPosixShell();
    if (posixShell) return Object.freeze({ executable: posixShell, label: `POSIX shell (${posixShell})`, scriptExtension: '.sh' });
    const commandPrompt = process.env.ComSpec || 'cmd.exe';
    return Object.freeze({ executable: commandPrompt, label: `Command Prompt (${commandPrompt})`, scriptExtension: '.cmd' });
  }
  const posixShell = process.env.SHELL || '/bin/sh';
  return Object.freeze({ executable: posixShell, label: `POSIX shell (${posixShell})`, scriptExtension: '.sh' });
}

function commandForShell(scriptPath: string, shell: ShellDefinition): ShellCommand {
  const arguments_ = shell.scriptExtension === '.cmd'
    ? Object.freeze(['/d', '/s', '/c', scriptPath])
    : Object.freeze([scriptPath]);
  return Object.freeze({ ...shell, arguments: arguments_ });
}

function shellCommand(scriptPath: string, platform = process.platform): ShellCommand {
  return commandForShell(scriptPath, shellDefinition(platform));
}

function shellScript(command: string, shell: ShellDefinition): string {
  if (shell.scriptExtension === '.cmd') {
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

function temporaryScript(command: string): Readonly<{ scriptPath: string; shell: ShellCommand }> {
  const shell = shellDefinition();
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${shell.scriptExtension}`);
  fs.writeFileSync(scriptPath, shellScript(command, shell), { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  return Object.freeze({ scriptPath, shell: commandForShell(scriptPath, shell) });
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

function missingCommandName(logPath: string): string | null {
  const output = fs.readFileSync(logPath, 'utf8');
  const windowsMatch = output.match(/^'([^']+)' is not recognized as an internal or external command,$/m);
  if (windowsMatch?.[1]) return windowsMatch[1];
  for (const line of output.split(/\r?\n/)) {
    const posixMatch = line.match(/(?:^|:\s)([^:\s]+): (?:command )?not found$/);
    if (posixMatch?.[1]) return posixMatch[1];
  }
  return null;
}

function shellCannotParsePosixSyntax(logPath: string, exitCode: number, shell: ShellCommand): boolean {
  if (exitCode !== 1 || shell.scriptExtension !== '.cmd') return false;
  return /^'!' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, 'utf8'));
}

function processTimedOut(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT';
}

function failedResult(requirement: VerificationRequirement, status: 'failed_suite' | 'toolchain_missing' | 'could_not_run' | 'timeout', command: string, logPath: string, reason: string, exitCode: number | null, tail: string, timeoutMilliseconds?: number, shell?: string): VerificationResult {
  const identity = exitCode == null ? status : `${status}:exit-${exitCode}`;
  return Object.freeze({
    kind: requirement.kind,
    status,
    evidence: reason,
    command,
    logPath,
    exitCode,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(shell === undefined ? {} : { shell }),
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
  const temporary = temporaryScript(command);
  const { scriptPath, shell } = temporary;
  let outcome: import('node:child_process').SpawnSyncReturns<Buffer> | null = null;
  try {
    const log = fs.openSync(logPath, 'w');
    try {
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
    return failedResult(requirement, 'could_not_run', command, logPath, reason, 2, fs.existsSync(logPath) ? outputTail(logPath, outputTailBytes) : '', undefined, shell.label);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  const tail = outputTail(logPath, outputTailBytes);
  if (processTimedOut(outcome?.error)) {
    return failedResult(requirement, 'timeout', command, logPath, `Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`, 2, tail, timeoutMilliseconds, shell.label);
  }
  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    const shellExitCode = outcome?.status ?? (outcome?.error ? 2 : null);
    return failedResult(requirement, 'could_not_run', command, logPath, `The ${shell.label} exited ${shellExitCode ?? 'without a code'} before reporting the suite exit code.`, shellExitCode, tail, undefined, shell.label);
  }
  if (shellCannotParsePosixSyntax(logPath, exitCode, shell)) {
    return failedResult(requirement, 'could_not_run', command, logPath, `The ${shell.label} fallback could not parse POSIX syntax while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, undefined, shell.label);
  }
  if (commandNotFound(logPath, exitCode)) {
    const missingCommand = missingCommandName(logPath);
    const missingCommandEvidence = missingCommand ? `command ${JSON.stringify(missingCommand)}` : 'a command';
    return failedResult(requirement, 'toolchain_missing', command, logPath, `The verification environment could not find ${missingCommandEvidence} while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, undefined, shell.label);
  }
  if (exitCode === 0) {
    return Object.freeze({ kind: requirement.kind, status: 'passed', evidence: requirement.evidenceContract, command, logPath, exitCode, shell: shell.label });
  }
  return failedResult(requirement, 'failed_suite', command, logPath, `The required command exited ${exitCode}.`, exitCode, tail, undefined, shell.label);
}

export function createProcessPort(): VerificationProcessPort {
  return Object.freeze({ run: runProcessVerification });
}

export { shellCommand };
