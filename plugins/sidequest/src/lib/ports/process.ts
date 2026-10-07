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
  environment?: NodeJS.ProcessEnv;
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

// GH-290: Git for Windows sh.exe reads an unquoted backslash as an escape, so `cd C:\repo\app` arrives as
// `C:repoapp`. A command that names an unquoted backslash path runs through Command Prompt, which takes it
// verbatim. Backslashes inside quotes (`"C:\tools\node.exe" -e "...'a\n'..."`) survive sh.exe and stay there:
// Command Prompt would read the script's `\"` as quote toggles and run its `||` and `&&` as operators (SQ-3117).
const WINDOWS_BACKSLASH_PATH = /(?:^|[\s=(])(?:[A-Za-z]:|\.{1,2}|[\w.-]+)\\[\w.-]/;
const QUOTED_SEGMENT = /"(?:\\.|[^"\\])*"|'[^']*'/g;

function unquotedText(command: string): string {
  return command.replace(QUOTED_SEGMENT, ' ');
}

function commandPromptShell(): ShellDefinition {
  const commandPrompt = process.env.ComSpec || 'cmd.exe';
  return Object.freeze({ executable: commandPrompt, label: `Command Prompt (${commandPrompt})`, scriptExtension: '.cmd' });
}

function verifierShell(command: string, platform = process.platform): ShellDefinition {
  return platform === 'win32' && WINDOWS_BACKSLASH_PATH.test(unquotedText(command)) ? commandPromptShell() : shellDefinition(platform);
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
  const shell = verifierShell(command);
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

// GH-247: the board spawns verifiers from its MCP server, which Claude Code starts with the Sidequest
// plugin's CLAUDE_PLUGIN_ROOT. A project suite that locates its own files through that variable would
// read the Sidequest install instead.
export function verifierEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^CLAUDE_PLUGIN_/i.test(name)));
}

// GH-189: a shell that never started leaves no output, so the spawn error is the only text that says why.
function shellExitReason(shell: ShellDefinition, shellExitCode: number | null, spawnError?: Error): string {
  const reason = `The ${shell.label} exited ${shellExitCode ?? 'without a code'} before reporting the suite exit code.`;
  return spawnError ? `${reason} ${spawnError.message}` : reason;
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

type VerifierRun = Readonly<{
  requirement: VerificationRequirement;
  command: string;
  logPath: string;
  timeoutMilliseconds: number;
  outputTailBytes: number;
  cwd: string | undefined;
  environment: NodeJS.ProcessEnv;
  ownedTree: boolean;
}>;

type SpawnOutcome = import('node:child_process').SpawnSyncReturns<Buffer>;

const OWNED_PROCESS_TREE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'owned-process-tree.js');
// Room for the owned phase to terminate its tree and drain output after its own deadline fired:
// taskkill /T takes about a second on Windows, then the grace and drain windows.
const OWNED_TREE_SETTLE_MARGIN_MILLISECONDS = 15_000;
const OWNED_TREE_TIMEOUT_MARKER = /^__SIDEQUEST_VERIFY_TIMEOUT__=\d+$/m;

function verifierRun(requirement: VerificationRequirement, command: string, options: ProcessVerificationOptions): VerifierRun {
  return Object.freeze({
    requirement,
    command,
    logPath: options.logPath || defaultLogPath(),
    timeoutMilliseconds: options.timeoutMilliseconds || DEFAULT_TIMEOUT_MILLISECONDS,
    outputTailBytes: options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES,
    cwd: options.cwd,
    environment: verifierEnvironment(options.environment || process.env),
    ownedTree: requirement.environment === 'shared',
  });
}

function spawnFailureResult(run: VerifierRun, shell: ShellCommand, error: unknown): VerificationResult {
  const reason = error instanceof Error ? error.message : String(error);
  const tail = fs.existsSync(run.logPath) ? outputTail(run.logPath, run.outputTailBytes) : '';
  return failedResult(run.requirement, 'could_not_run', run.command, run.logPath, reason, 2, tail, undefined, shell.label);
}

// An environment-bound verifier (SQ-3425) runs its shell under the owned process tree so the
// deadline ends docker clients, browsers and drivers under it, not the shell alone. The phase's own
// deadline sits inside the spawnSync timeout; the outer timeout only backstops a phase that cannot
// end its tree.
function ownedTreeLaunch(shell: ShellCommand, run: VerifierRun): ShellCommand {
  const spec = { command: shell.executable, args: shell.arguments, cwd: run.cwd, timeoutMilliseconds: run.timeoutMilliseconds };
  return Object.freeze({ ...shell, executable: process.execPath, arguments: Object.freeze([OWNED_PROCESS_TREE_SCRIPT, JSON.stringify(spec)]) });
}

function spawnVerifier(shell: ShellCommand, run: VerifierRun): SpawnOutcome {
  const launch = run.ownedTree ? ownedTreeLaunch(shell, run) : shell;
  const timeout = run.ownedTree ? run.timeoutMilliseconds + OWNED_TREE_SETTLE_MARGIN_MILLISECONDS : run.timeoutMilliseconds;
  const log = fs.openSync(run.logPath, 'w');
  try {
    return spawnSync(launch.executable, launch.arguments, {
      cwd: run.cwd,
      env: run.environment,
      windowsHide: true,
      timeout,
      stdio: ['ignore', log, log],
    });
  } finally {
    fs.closeSync(log);
  }
}

function verifierTimedOut(run: VerifierRun, outcome: SpawnOutcome): boolean {
  if (processTimedOut(outcome.error)) return true;
  return run.ownedTree && OWNED_TREE_TIMEOUT_MARKER.test(fs.readFileSync(run.logPath, 'utf8'));
}

// A deadline the owned tree enforced exits 124, the code the CLI's timeout reports; only spawnSync's own
// kill leaves no status, and that keeps the legacy 2.
function timeoutResult(run: VerifierRun, shell: ShellCommand, outcome: SpawnOutcome, tail: string): VerificationResult {
  return failedResult(run.requirement, 'timeout', run.command, run.logPath, `Verification timed out after ${run.timeoutMilliseconds}ms; partial output captured.`, outcome.status ?? 2, tail, run.timeoutMilliseconds, shell.label);
}

function exitCodeResult(run: VerifierRun, shell: ShellCommand, outcome: SpawnOutcome, tail: string): VerificationResult {
  const exitCode = markerExitCode(run.logPath);
  if (exitCode !== null) return exitCodeVerdict(run, shell, exitCode, tail);
  const shellExitCode = outcome.status ?? (outcome.error ? 2 : null);
  return failedResult(run.requirement, 'could_not_run', run.command, run.logPath, shellExitReason(shell, shellExitCode, outcome.error), shellExitCode, tail, undefined, shell.label);
}

function exitCodeVerdict(run: VerifierRun, shell: ShellCommand, exitCode: number, tail: string): VerificationResult {
  const { requirement, command, logPath } = run;
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
  const run = verifierRun(requirement, command, options);
  const { scriptPath, shell } = temporaryScript(command);
  let outcome: SpawnOutcome;
  try {
    outcome = spawnVerifier(shell, run);
  } catch (error: unknown) {
    return spawnFailureResult(run, shell, error);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  const tail = outputTail(run.logPath, run.outputTailBytes);
  if (verifierTimedOut(run, outcome)) return timeoutResult(run, shell, outcome, tail);
  return exitCodeResult(run, shell, outcome, tail);
}

export function createProcessPort(): VerificationProcessPort {
  return Object.freeze({ run: runProcessVerification });
}

export { shellCommand };
