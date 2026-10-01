'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { once } = require('node:events');
const { spawnGatewayProcess } = require('./support.js');
const probe = require('./native-budget-probe.js');

const SCRATCHPAD = process.env.SQ3248_SCRATCHPAD || require('node:os').tmpdir();
const CLIENT = path.join(__dirname, 'fixtures', 'native-budget-client.js');

function fixtureLaunch(mode, owned) {
  return (unused, binary, argumentsList, options) => {
    owned.root = path.dirname(options.cwd);
    owned.environment = options.env;
    owned.argumentsList = argumentsList;
    owned.port = new URL(options.env.ANTHROPIC_BASE_URL).port;
    const settings = JSON.parse(fs.readFileSync(path.join(options.cwd, '.claude', 'settings.json')));
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000', 'cap exists only in fixture project settings');
    assert.equal(options.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, 'launch env must not substitute for project loading');
    assert.match(fs.readFileSync(path.join(options.cwd, '.claude', 'agents', 'budget-worker.md'), 'utf8'), /model: codex-auto/);
    const child = spawnGatewayProcess(null, process.execPath, [CLIENT, mode, ...argumentsList], options);
    owned.child = child;
    return child;
  };
}

async function syntheticRun(mode, model = 'gpt-6.1-sol') {
  const owned = {};
  const result = await probe.runNativeCase({ binary: process.execPath, scratchpad: SCRATCHPAD, model,
    hostEnvironment: {}, timeout: mode === 'timeout' ? 500 : 10000, launch: fixtureLaunch(mode, owned) });
  assert.equal(fs.existsSync(owned.root), false, 'fixture home, project and numeric debug log are removed');
  assert.notEqual(owned.child.exitCode ?? owned.child.signalCode, null, 'owned process exited before cleanup returned');
  await assertPortClosed(owned.port);
  return result;
}

async function assertPortClosed(port) {
  const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
  await assert.rejects(once(socket, 'connect'), /ECONNREFUSED/, 'ephemeral fixture listener is closed');
  socket.destroy();
}

test('synthetic client exercises case reporting, project-only cap and owned cleanup without native proof', async () => {
  const custom = await syntheticRun('complete');
  const recognized = await syntheticRun('complete', 'claude-opus-5-5[1m]');
  const report = probe.reportCases(custom, recognized);
  assert.deepEqual(Object.values(report).map((entry) => entry.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'], 'synthetic evidence classifies each case separately');
  assert.equal(custom.counters.models['codex-auto'], 2, 'simulated frontmatter model reaches fixture upstream');
  assert.equal(custom.counters.compactions, 1);
  assert.equal(recognized.counters.compactions, 0);
  assert.equal(custom.counters.requests, 6);
  const owned = {};
  const combined = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD, hostEnvironment: {},
    launch: fixtureLaunch('complete', owned) });
  assert.equal(combined.runs.length, 2, 'successful synthetic observation runs both model cases');
  assert.equal(combined.cases.recognizedClaude.status, 'PASS');
  assert.equal(fs.existsSync(owned.root), false);
  await assertPortClosed(owned.port);
});

test('absence, error and timeout never become native compatibility receipts', async () => {
  const absent = await syntheticRun('noObservation');
  assert.deepEqual(Object.values(probe.reportCases(absent, absent)).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  const malformed = await syntheticRun('malformed');
  assert.equal(probe.reportCases(malformed, malformed).bareMain.status, 'FAIL');
  const timedOut = await syntheticRun('timeout');
  assert.equal(timedOut.timedOut, true, 'bounded timeout kills the synthetic owned child');
  assert.equal(probe.reportCases(timedOut, timedOut).proactiveCompaction.status, 'UNVERIFIED');
});

test('host and child refusals stop the probe, preserve guards and clean fixture resources', async () => {
  const owned = {};
  const blocked = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD,
    hostEnvironment: { CLAUDECODE: 'synthetic-nesting-guard' }, launch: fixtureLaunch('complete', owned) });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.runs.length, 1, 'host refusal prevents every subsequent native case');
  assert.equal(owned.child, undefined, 'guard blocks before launch');
  assert.deepEqual(Object.values(blocked.cases).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  const refused = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD, hostEnvironment: {},
    launch: fixtureLaunch('refuse', owned) });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.runs.length, 1, 'child permission refusal stops rather than trying another case');
  assert.equal(fs.existsSync(owned.root), false);
  await assertPortClosed(owned.port);
  const environment = probe.nativeEnvironment('/fixture', 1234, { CLAUDECODE: 'keep', CLAUDE_CODE_NESTING_GUARD: 'keep-too' });
  assert.equal(environment.CLAUDECODE, 'keep');
  assert.equal(environment.CLAUDE_CODE_NESTING_GUARD, 'keep-too');
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, 'fixture-dummy');
  assert.equal(probe.hostBlocked({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90' }), true);
  assert.equal(probe.hostBlocked({}), false);
});

test('output and debug bounds stop synthetic children and remove oversized fixture logs', async () => {
  const output = await syntheticRun('oversizedOutput');
  assert.equal(probe.reportCases(output, output).bareMain.status, 'FAIL');
  const debug = await syntheticRun('oversizedDebug');
  assert.equal(debug.status, 'UNVERIFIED', 'oversized numeric-observation file cannot produce a receipt');
});

test('launch failure remains UNVERIFIED and leaves no temporary fixture', async () => {
  const before = fs.readdirSync(SCRATCHPAD).filter((name) => name.startsWith('native-budget-'));
  const failed = await probe.runNativeCase({ binary: process.execPath, scratchpad: SCRATCHPAD,
    model: 'gpt-6.1-sol', hostEnvironment: {}, launch: () => { throw new Error('synthetic launch refusal'); } });
  assert.equal(failed.status, 'UNVERIFIED');
  assert.deepEqual(fs.readdirSync(SCRATCHPAD).filter((name) => name.startsWith('native-budget-')), before);
});

test('numeric telemetry ignores unrelated text, malformed events and missing resolver fields', () => {
  const counters = { windows: [], compactions: 0, completed: false };
  probe.observeWindow('headers fixture-dummy, tokens=240000', counters);
  probe.observeWindow('autocompact: tokens=240000 threshold=239000 effectiveWindow=252000', counters);
  assert.deepEqual(counters.windows, [{ tokens: 240000, threshold: 239000, effectiveWindow: 252000 }]);
  for (let index = 0; index < 40; index++) probe.observeWindow('autocompact: tokens=240000 threshold=239000 effectiveWindow=252000', counters);
  assert.equal(counters.windows.length, 32, 'numeric history is bounded');
  probe.observeEvent('bad', counters);
  probe.observeEvent('{"type":"assistant","content":"fixture-only"}', counters);
  probe.observeEvent('{"type":"result","is_error":true}', counters);
  assert.equal(counters.completed, false);
  const report = probe.initialReport();
  assert.equal(report.projectEnv.status, 'UNVERIFIED');
  assert.equal(probe.nativeArguments('gpt-6.1-sol', '/fixture/debug').includes('--dangerously-skip-permissions'), false);
});

test('fixture protocol supports streamed replies and bounds model metadata', () => {
  const counters = { requests: 0, mainTurns: 0, summaryRequests: 0, models: { other: 0 } };
  const response = probe.fixtureReply({ model: 'fixture-unknown', system: '' }, counters);
  const stream = probe.streamCompletion(response);
  assert.match(stream, /event: message_start/);
  assert.match(stream, /event: content_block_start/);
  assert.match(stream, /event: message_stop/);
  assert.equal(counters.models.other, 1, 'unknown model text is reduced to an allowlisted counter');
});

test('CLI validation and guarded executable invocation use only synthetic processes', async () => {
  await assert.rejects(probe.main(), /absolute existing binary/);
  const child = spawnGatewayProcess(null, process.execPath, [path.join(__dirname, 'native-budget-probe.js'), process.execPath, SCRATCHPAD], {
    env: { ...process.env, CLAUDECODE: 'synthetic-guard' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).status, 'BLOCKED');
  const invalid = spawnGatewayProcess(null, process.execPath, [path.join(__dirname, 'native-budget-probe.js')], { stdio: 'ignore' });
  const [invalidCode] = await once(invalid, 'close');
  assert.equal(invalidCode, 1, 'CLI failure never prints a passing receipt');
});
