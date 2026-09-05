'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DOCTOR_TIMEOUT_MS = 3000;
const MAX_DIAGNOSTIC_LENGTH = 240;

function parseGatewayDoctorOutput(output) {
  const auth = output.match(/^codex auth:\s*(.+)$/m)?.[1];
  return {
    available: true,
    proxyVersion: output.match(/^version:.*?(\d+\.\d+\.\d+\S*)\s*$/m)?.[1],
    auth: /authenticated/i.test(auth || '') && !/not authenticated/i.test(auth || ''),
    proxy: /^proxy \(claude-code-proxy\).*(answering \/v1\/models|running)/im.test(output),
    shim: /^shim \(model router\).*running/im.test(output),
  };
}

function doctorOutput(result) {
  return `${result?.stdout || ''}${result?.stderr || ''}`.trim();
}

function compactDiagnostic(output) {
  const candidates = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/(?:token|secret|password|authorization|bearer)/i.test(line));
  const diagnostic = candidates.find((line) => /(?:error|down|missing|unavailable|failed|not authenticated|not wired)/i.test(line)) || candidates[0] || '';
  return diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function errorCode(error) {
  const code = String(error?.code || '').trim();
  return /^[A-Z][A-Z0-9_-]*$/i.test(code) ? code : 'unknown error';
}

function failedCheck(state, diagnostic = '') {
  return { available: false, state, ...(diagnostic ? { diagnostic } : {}) };
}

function doctorResult(result) {
  if (result?.error?.code === 'ETIMEDOUT') return failedCheck('timeout', `timed out after ${DOCTOR_TIMEOUT_MS / 1000}s`);
  if (result?.error) return failedCheck('spawn-error', `could not start (${errorCode(result.error)})`);

  const output = doctorOutput(result);
  if (result?.status !== 0) {
    const diagnostic = compactDiagnostic(output);
    return failedCheck('doctor-exit', `exited with status ${result?.status ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  if (!output) return failedCheck('empty-output', 'returned no diagnostic output');
  return { state: 'healthy', ...parseGatewayDoctorOutput(output) };
}

function runGatewayDoctor(command, args, timeout) {
  try {
    return childProcess.spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true });
  } catch (error) {
    return { error };
  }
}

function localGatewayCheck(gateway, {
  existsSync = fs.existsSync,
  nodePath = process.execPath,
  runDoctor = runGatewayDoctor,
} = {}) {
  if (!gateway?.installPath) return failedCheck('missing-checker', 'install path is unavailable');
  const gatewayScript = path.join(gateway.installPath, 'bin', 'model-gateway.js');
  if (!existsSync(gatewayScript)) return failedCheck('missing-checker', 'checker script is missing');
  return doctorResult(runDoctor(nodePath, [gatewayScript, 'doctor'], DOCTOR_TIMEOUT_MS));
}

module.exports = {
  DOCTOR_TIMEOUT_MS,
  MAX_DIAGNOSTIC_LENGTH,
  compactDiagnostic,
  doctorResult,
  localGatewayCheck,
  parseGatewayDoctorOutput,
};
