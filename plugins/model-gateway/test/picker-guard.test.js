'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { DEFAULT_BASE_URL, PIN_OVERRIDE_PATH, syncGatewayDiscoveryCache } = require('../lib/runtime.js');
const { envBlockFor, FABLE_OPTION_KEYS, ownedPinValues, pinEnvBlock, writePinOverrides } = require('../lib/pins.js');
const { previousServerRows, withPreviousServerRows } = require('../lib/previous-picker-rows.js');
const guard = require('../lib/picker-guard.js');
const wiring = require('../lib/settings-wiring.js');

const STALE_SERVER_ROW = { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' };
const CODEX_ROW = { id: 'claude-gpt-5.5[1m]', display_name: 'GPT-5.5 (Codex)' };
const row = (value, displayName, resolvedModel) => ({ value, displayName, resolvedModel });
const NATIVE_ROWS = [row('opus', 'Opus 5.5', 'claude-opus-5-5'), row('fable', 'Fable 5.2', 'claude-fable-5-2'), row('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5')];

function writeClaudeGlobalConfig(configDir, serverRows) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, additionalModelOptionsCache: serverRows, additionalModelOptionsAnsweredAt: Date.now(),
  }));
}

function withPins(pins, body) {
  writePinOverrides(pins);
  try { return body(); } finally { fs.rmSync(PIN_OVERRIDE_PATH, { force: true }); }
}

test('a stale server Fable row ahead of the current one fails the picker check by name', () => {
  const gatewayRows = [row('opus', 'Opus', 'claude-opus-5-5'), row('claude-fable-5-1[1m]', 'Fable', 'claude-fable-5-1'),
    row('sonnet', 'Sonnet', 'claude-sonnet-5-5'), row('claude-fable-5-2[1m]', 'Fable', 'claude-fable-5-2'), row('claude-gpt-5.5[1m]', 'GPT-5.5 (Codex)', 'claude-gpt-5.5[1m]')];
  const result = guard.comparePickerRows(NATIVE_ROWS, gatewayRows);
  assert.deepEqual(result.failures, [{ family: 'fable', expected: 'claude-fable-5-2', actual: 'claude-fable-5-1' }]);
  assert.match(guard.pickerGuardFailureLines(result)[0], /"Fable" row runs claude-fable-5-1 behind the gateway, but Claude Code's own fable is claude-fable-5-2/);
});

test('a relabelled previous row is an upstream note, and missing Codex rows fail', () => {
  const relabelled = [row('claude-fable-5-1[1m]', 'Fable 5.1 (previous)', 'claude-fable-5-1'), row('opus', 'Opus', 'claude-opus-5-5'),
    row('sonnet', 'Sonnet', 'claude-sonnet-5-5'), row('claude-fable-5-2[1m]', 'Fable', 'claude-fable-5-2'), row('claude-grok-4.5[1m]', 'Grok 4.5', 'claude-grok-4.5[1m]')];
  const passing = guard.comparePickerRows(NATIVE_ROWS, relabelled);
  assert.deepEqual(passing.failures, []);
  assert.deepEqual(passing.previous, ['claude-fable-5-1[1m]']);
  assert.match(guard.pickerGuardReport(passing)[0], /check ok: .*1 Codex\/Grok rows; upstream: .*claude-fable-5-1\[1m\]/);
  const withoutCodex = guard.comparePickerRows(NATIVE_ROWS, relabelled.slice(0, 4));
  assert.deepEqual(guard.pickerGuardFailureLines(withoutCodex), ['model-gateway: /model shows no Codex or Grok rows behind the gateway']);
});

test('only server rows older than the current pin of their family are relabelled', () => {
  const serverRows = [STALE_SERVER_ROW, { value: 'claude-opus-5-5[1m]' }, { value: 'claude-sonnet-6' }, { value: 'not-a-model' }, null];
  const current = { fable: 'claude-fable-5-2[1m]', opus: 'claude-opus-5-5[1m]', sonnet: 'claude-sonnet-5-5[1m]' };
  assert.deepEqual(previousServerRows(serverRows, current), [{ id: 'claude-fable-5-1[1m]', display_name: 'Fable 5.1 (previous)' }]);
  assert.deepEqual(withPreviousServerRows([{ id: 'claude-fable-5-1[1m]', display_name: 'Claude Fable 5.1' }, CODEX_ROW], { serverRows, currentPins: current }),
    [{ id: 'claude-fable-5-1[1m]', display_name: 'Fable 5.1 (previous)' }, CODEX_ROW]);
});

test('the Fable picker option follows the effective Fable pin and stays gateway-owned', () => withPins({ fable: 'claude-fable-5-3[1m]' }, () => {
  const block = pinEnvBlock();
  assert.equal(block[FABLE_OPTION_KEYS.model], 'claude-fable-5-3[1m]');
  assert.equal(block[FABLE_OPTION_KEYS.name], 'Fable');
  assert.equal(block[FABLE_OPTION_KEYS.description], 'Fable 5.3 · current Fable, through the gateway');
  const owned = ownedPinValues();
  assert.ok(owned[FABLE_OPTION_KEYS.description].has('Fable 5.3 · current Fable, through the gateway'));
  assert.ok(owned[FABLE_OPTION_KEYS.model].has('claude-fable-5-1[1m]'));
}));

test('a project wired before the update gets the current Fable option at the next sync, and a moved pin rewrites it', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-picker-project-'));
  const file = path.join(project, '.claude', 'settings.local.json');
  const { ANTHROPIC_CUSTOM_MODEL_OPTION, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, ...oldBlock } = envBlockFor('default');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: oldBlock }));
  wiring.recordProjectWiring(project);
  wiring.syncRegisteredProjectPins();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env, envBlockFor('default'));
  withPins({ fable: 'claude-fable-5-3[1m]' }, () => {
    wiring.syncRegisteredProjectPins();
    const env = JSON.parse(fs.readFileSync(file, 'utf8')).env;
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'claude-fable-5-3[1m]');
    assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, 'Fable 5.3 · current Fable, through the gateway');
  });
  const usersOwnOption = { ...envBlockFor('default'), ANTHROPIC_CUSTOM_MODEL_OPTION: 'my-own-model' };
  fs.writeFileSync(file, JSON.stringify({ env: usersOwnOption }));
  const result = wiring.syncRegisteredProjectPins();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'my-own-model');
  assert.equal(result.skipped[0]?.key, 'ANTHROPIC_CUSTOM_MODEL_OPTION');
});

test('the picker check runs once per Claude Code version and reuses the recorded verdict', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-picker-record-')), 'picker-guard.json');
  let runs = 0;
  const run = async () => { runs++; return { failures: [], previous: [], gatewayRows: 3 }; };
  await guard.pickerGuardForCli('2.1.322 (Claude Code)', { run, file });
  const reused = await guard.pickerGuardForCli('2.1.322 (Claude Code)', { run, file });
  assert.equal(runs, 1);
  assert.equal(reused.cliVersion, '2.1.322 (Claude Code)');
  await guard.pickerGuardForCli('2.1.323 (Claude Code)', { run, file });
  assert.equal(runs, 2);
  assert.equal(await guard.pickerGuardForCli(null, { run, file }), null);
  const timedOut = async () => { runs++; return { unverified: 'claude did not list its /model rows within 8000ms' }; };
  await guard.pickerGuardForCli('2.1.324 (Claude Code)', { run: timedOut, file });
  const reusedUnverified = await guard.pickerGuardForCli('2.1.324 (Claude Code)', { run: timedOut, file });
  assert.equal(runs, 3);
  assert.match(reusedUnverified.unverified, /within 8000ms/);
});

function realClaudeBinary() {
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  return lookup.status === 0 ? lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/\.(cmd|ps1)$/i.test(line)) : null;
}

test('real claude: the wired picker offers the native Fable, Opus and Sonnet plus gateway rows', async (t) => {
  const claudeBin = realClaudeBinary();
  if (!claudeBin) {
    t.diagnostic('skipped: no real `claude` binary on PATH, so the /model rows cannot be listed');
    t.skip('no real claude binary on PATH');
    return;
  }
  const configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-picker-claude-')), '.claude');
  writeClaudeGlobalConfig(configDir, [STALE_SERVER_ROW]);
  const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  // Signed out, nothing hides cached server rows even without the gateway, so the native side reads a config
  // without one, as a signed-in session does through its served catalog.
  const nativeConfigDir = path.join(path.dirname(configDir), 'native-claude');
  writeClaudeGlobalConfig(nativeConfigDir, []);
  const nativeEnv = { ...process.env, CLAUDE_CONFIG_DIR: nativeConfigDir };
  const nativeRows = await guard.probePickerRows({ env: nativeEnv, cwd: path.dirname(configDir), claudeBin });
  assert.ok(nativeRows, 'claude listed its /model rows');
  const nativeFable = nativeRows.find((candidate) => candidate.value === 'fable')?.resolvedModel;
  assert.ok(nativeFable, 'claude has its own fable row');
  const cachePath = path.join(configDir, 'cache', 'gateway-models.json');
  const check = (models) => withPins({ fable: `${nativeFable}[1m]` }, () => {
    syncGatewayDiscoveryCache({ models, baseUrl: DEFAULT_BASE_URL, cachePath, force: true });
    return guard.runPickerGuard({ baseEnv, nativeEnv, gatewayEnv: envBlockFor('default'), claudeBin });
  });
  const stale = await check([CODEX_ROW]);
  t.diagnostic(`without relabelling: ${JSON.stringify(stale)}`);
  const fixed = await check(withPreviousServerRows([CODEX_ROW], { serverRows: [STALE_SERVER_ROW], currentPins: { fable: `${nativeFable}[1m]` } }));
  assert.deepEqual(fixed.failures, [], guard.pickerGuardReport(fixed).join('\n'));
  assert.ok(fixed.gatewayRows > 0, 'Codex rows are listed');
  assert.ok(fixed.previous.length > 0, 'the stale server row is shown as previous');
});

