'use strict';

import type { VerificationResult } from './kernel/verification.js';

const { runProcessVerification, shellCommand } = require('./ports/process.js') as typeof import('./ports/process.js');

type VerifyCapture = VerificationResult & Readonly<{ exitCode: number | null; reason?: string }>;

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

function report(capture: VerifyCapture) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : '';
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}\n`);
  process.stdout.write(`details=${capture.logPath || ''}\n`);
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
  process.exitCode = capture.exitCode === 0 ? 0 : 2;
}

module.exports = { runVerifyCapture, shellCommand };

if (require.main === module) void main();
