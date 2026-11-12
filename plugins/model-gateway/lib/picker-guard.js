'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeFileAtomically } = require('./atomic-file.js');
const { CLAUDE_BIN, STATE, WIN } = require('./runtime.js');
const { envBlockFor, isGatewayModelId, terminateProbe } = require('./pins.js');

// Compares Claude Code's own /model rows with the rows it shows behind the gateway, using the
// stream-json initialize handshake, which lists the picker without sending a model request.
const PICKER_GUARD_PATH = path.join(STATE, 'picker-guard.json');
const PICKER_PROBE_TIMEOUT_MS = 20000;
const PICKER_FAMILIES = ['fable', 'opus', 'sonnet'];
const PREVIOUS_LABEL = /\(previous\)$/;
const SESSION_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_SESSION_ID)$/;
const INITIALIZE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'picker-guard', request: { subtype: 'initialize' } })}\n`;
// The probe session runs SessionStart hooks like any other, and this check is itself called from
// model-gateway's SessionStart hook, so without this every probe would start two more probes.
const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', JSON.stringify({ disableAllHooks: true })];

function pickerRowsFromOutput(output) {
  for (const line of output.split('\n')) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.type === 'control_response') return message.response?.response?.models || [];
  }
  return null;
}

function probePickerRows({ env, cwd, claudeBin = CLAUDE_BIN, timeoutMs = PICKER_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, PROBE_ARGS, {
      cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: !WIN, shell: WIN && /\.(?:cmd|bat)$/i.test(claudeBin),
    });
    let output = '';
    let settled = false;
    const finish = (rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      terminateProbe(child);
      resolve(rows);
    };
    const deadline = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const rows = pickerRowsFromOutput(output);
      if (rows) finish(rows);
    });
    child.once('error', () => finish(null));
    child.once('close', () => finish(pickerRowsFromOutput(output)));
    child.stdin.on('error', () => {});
    child.stdin.write(INITIALIZE_REQUEST);
  });
}

function bareModel(id) {
  return typeof id === 'string' ? id.replace(/\[1m\]$/i, '') : null;
}

function isPreviousRow(row) {
  return PREVIOUS_LABEL.test(String(row?.displayName || ''));
}

function firstRowNamedFor(rows, family) {
  return rows.find((row) => !isPreviousRow(row) && String(row?.displayName || '').toLowerCase().split(' ')[0] === family);
}

function nativeModelFor(rows, family) {
  const row = rows.find((candidate) => candidate?.value === family) || firstRowNamedFor(rows, family);
  return bareModel(row?.resolvedModel);
}

function comparePickerRows(nativeRows, gatewayRows) {
  const failures = PICKER_FAMILIES.flatMap((family) => {
    const expected = nativeModelFor(nativeRows, family);
    if (!expected) return [];
    const actual = bareModel(firstRowNamedFor(gatewayRows, family)?.resolvedModel);
    return actual === expected ? [] : [{ family, expected, actual }];
  });
  return {
    failures,
    previous: gatewayRows.filter(isPreviousRow).map((row) => row.value),
    gatewayRows: gatewayRows.filter((row) => isGatewayModelId(row?.value)).length,
  };
}

function nativeEnvFrom(baseEnv, gatewayEnv) {
  return Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !Object.hasOwn(gatewayEnv, key) && !SESSION_MARKERS.test(key)));
}

async function runPickerGuard({ baseEnv = process.env, gatewayEnv = envBlockFor('default'), nativeEnv = nativeEnvFrom(baseEnv, gatewayEnv), claudeBin = CLAUDE_BIN, timeoutMs = PICKER_PROBE_TIMEOUT_MS } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-picker-'));
  try {
    const [nativeRows, gatewayRows] = await Promise.all([
      probePickerRows({ env: nativeEnv, cwd, claudeBin, timeoutMs }),
      probePickerRows({ env: { ...nativeEnvFrom(baseEnv, gatewayEnv), ...gatewayEnv }, cwd, claudeBin, timeoutMs }),
    ]);
    if (!nativeRows || !gatewayRows) return { unverified: `claude did not list its /model rows within ${timeoutMs}ms` };
    return comparePickerRows(nativeRows, gatewayRows);
  } finally {
    // Windows holds the folder while the just-killed probe that ran in it is still exiting.
    try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
}

function familyLabel(family) {
  return `${family[0].toUpperCase()}${family.slice(1)}`;
}

function pickerGuardFailureLines(result) {
  if (result.unverified) return [`model-gateway: /model check UNVERIFIED: ${result.unverified}`];
  const lines = result.failures.map(({ family, expected, actual }) => (
    `model-gateway: /model "${familyLabel(family)}" row runs ${actual || 'nothing (no row)'} behind the gateway, but Claude Code's own ${family} is ${expected}`
  ));
  if (result.gatewayRows === 0) lines.push('model-gateway: /model shows no Codex or Grok rows behind the gateway');
  return lines;
}

function pickerGuardReport(result) {
  const failures = pickerGuardFailureLines(result);
  if (failures.length) return failures;
  const upstream = result.previous.length
    ? `; upstream: Claude Code still lists Anthropic's older server row(s) ${result.previous.join(', ')}, shown as "(previous)"`
    : '';
  return [`model-gateway: /model check ok: Fable, Opus and Sonnet rows match Claude Code's own models; ${result.gatewayRows} Codex/Grok rows${upstream}`];
}

function readPickerGuardRecord(file = PICKER_GUARD_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// A new Claude Code release can change how the picker is built, so the check runs once per
// CLI version and the recorded verdict is reused until the version moves. An unverified run is
// recorded too: it costs SessionStart time, and `doctor` repeats the check on demand.
async function pickerGuardForCli(cliVersion, { run = runPickerGuard, file = PICKER_GUARD_PATH } = {}) {
  if (!cliVersion) return null;
  const saved = readPickerGuardRecord(file);
  if (saved?.cliVersion === cliVersion) return saved;
  const result = await run();
  const record = { cliVersion, checkedAt: Date.now(), ...result };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = {
  PICKER_GUARD_PATH, comparePickerRows, pickerGuardFailureLines, pickerGuardForCli, pickerGuardReport,
  pickerRowsFromOutput, probePickerRows, readPickerGuardRecord, runPickerGuard,
};
