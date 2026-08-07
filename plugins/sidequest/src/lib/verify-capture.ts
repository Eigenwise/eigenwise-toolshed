'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

type VerifyStatus = 'passed' | 'failed-suite' | 'could-not-run';

type VerifyCapture = {
  status: VerifyStatus;
  exitCode: number;
  logPath: string;
  reason?: string;
};

function shellCommand(command: string, platform = process.platform) {
  if (platform === 'win32') {
    return {
      executable: process.env.ComSpec || 'cmd.exe',
      arguments: ['/d', '/v:on', '/s', '/c', `${command} & echo __SIDEQUEST_VERIFY_EXIT__=!errorlevel!`],
    };
  }
  return {
    executable: process.env.SHELL || '/bin/sh',
    arguments: ['-c', `(${command}); printf '\\n__SIDEQUEST_VERIFY_EXIT__=%s\\n' "$?"`],
  };
}

function markerExitCode(logPath: string) {
  const output = fs.readFileSync(logPath, 'utf8');
  const matches = [...output.matchAll(/^__SIDEQUEST_VERIFY_EXIT__=(\d+)$/gm)];
  const match = matches.at(-1);
  return match ? Number(match[1]) : null;
}

function closeLog(stream: any) {
  return new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function runVerifyCapture(command: string, cwd = process.cwd()): Promise<VerifyCapture> {
  const logPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${Date.now()}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'wx' });
  const shell = shellCommand(command);
  let startError: Error | null = null;
  let processExitCode: number | null = null;

  try {
    const child = spawn(shell.executable, shell.arguments, { cwd, windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', (error: Error) => { startError = error; });
    await new Promise<void>((resolve) => child.once('close', (code: number | null) => {
      processExitCode = code;
      resolve();
    }));
  } catch (error: unknown) {
    startError = error instanceof Error ? error : new Error(String(error));
  }

  await closeLog(log);
  if (startError) return { status: 'could-not-run', exitCode: 2, logPath, reason: startError.message };

  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    return {
      status: 'could-not-run',
      exitCode: 2,
      logPath,
      reason: `The command shell exited ${processExitCode ?? 'without a code'} before reporting the suite exit code.`,
    };
  }
  return exitCode === 0
    ? { status: 'passed', exitCode, logPath }
    : { status: 'failed-suite', exitCode, logPath };
}

function report(capture: VerifyCapture) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : '';
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode}${reason}\n`);
  process.stdout.write(`details=${capture.logPath}\n`);
}

async function main() {
  const encoded = process.argv[2] === '--base64' ? process.argv[3] : '';
  const command = encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
  if (!command) {
    process.stderr.write('Usage: node verify-capture.js --base64 <base64 verify command>\n');
    process.exitCode = 2;
    return;
  }
  const capture = await runVerifyCapture(command);
  report(capture);
  process.exitCode = capture.exitCode;
}

module.exports = { runVerifyCapture, shellCommand };

if (require.main === module) void main();
