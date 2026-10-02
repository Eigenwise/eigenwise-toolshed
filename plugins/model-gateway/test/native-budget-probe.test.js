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
    owned.launches ??= [];
    owned.launches.push({ root: owned.root, port: owned.port, child });
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

test('budget overrides block preflight; native markers stay intact until a synthetic child actually refuses', async () => {
  const owned = {};
  const blocked = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD,
    hostEnvironment: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000' }, launch: fixtureLaunch('complete', owned) });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.runs.length, 1, 'inherited budget override prevents an ambiguous resolver experiment');
  assert.equal(owned.child, undefined, 'budget precheck blocks before launch');
  assert.deepEqual(Object.values(blocked.cases).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  const markers = { CLAUDECODE: 'synthetic-native-marker', CLAUDE_CODE_CHILD_SESSION: 'synthetic-child-marker' };
  assert.equal(probe.hostBlocked(markers), false, 'marker presence must not manufacture a native-host refusal');
  const refused = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD, hostEnvironment: markers,
    launch: fixtureLaunch('refuse', owned) });
  assert.equal(owned.environment.CLAUDECODE, markers.CLAUDECODE, 'native CLAUDECODE value reaches the child unchanged');
  assert.equal(owned.environment.CLAUDE_CODE_CHILD_SESSION, markers.CLAUDE_CODE_CHILD_SESSION, 'native child-session guard reaches the child unchanged');
  assert.notEqual(owned.child, undefined, 'marker presence reaches the synthetic launch boundary');
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.runs.length, 1, 'child permission refusal stops rather than trying another case');
  assert.deepEqual(Object.values(refused.cases).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  assert.equal(fs.existsSync(owned.root), false);
  await assertPortClosed(owned.port);
  const environment = probe.nativeEnvironment('/fixture', 1234, { CLAUDECODE: 'keep', CLAUDE_CODE_NESTING_GUARD: 'keep-too' });
  assert.equal(environment.CLAUDECODE, 'keep');
  assert.equal(environment.CLAUDE_CODE_NESTING_GUARD, 'keep-too');
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, 'fixture-dummy');
  assert.equal(probe.hostBlocked({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '90' }), true);
  assert.equal(probe.hostBlocked({}), false);
});

test('a synthetic native tool refusal stops the owned process and later cases without a marker precheck', async () => {
  const owned = {};
  const refused = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD,
    hostEnvironment: { CLAUDECODE: 'preserved-marker' }, launch: fixtureLaunch('refuseTool', owned) });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.runs.length, 1, 'actual synthetic tool refusal prevents the second native case');
  assert.equal(owned.environment.CLAUDECODE, 'preserved-marker');
  assert.notEqual(owned.child.exitCode ?? owned.child.signalCode, null, 'refused owned child is stopped');
  assert.equal(fs.existsSync(owned.root), false);
  await assertPortClosed(owned.port);
  assert.deepEqual(Object.values(refused.cases).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  assert.equal(probe.nativeRefusalLine('bad'), false);
  assert.equal(probe.nativeRefusalLine('null'), false);
  assert.equal(probe.nativeRefusalLine('{"type":"system","permissionMode":"default"}'), false);
  assert.equal(probe.nativeRefusalLine('{"type":"user","message":{"content":"synthetic text"}}'), false);
  assert.equal(probe.nativeRefusalLine('{"type":"user"}'), false);
  assert.equal(probe.nativeRefusalLine('{"type":"user","message":{"content":[null,{"type":"tool_result","is_error":false,"content":"permission"}]}}'), false);
});

test('output and debug bounds stop synthetic children and remove oversized fixture logs', async () => {
  const output = await syntheticRun('oversizedOutput');
  assert.equal(probe.reportCases(output, output).bareMain.status, 'FAIL');
  const debug = await syntheticRun('oversizedDebug');
  assert.equal(debug.status, 'UNVERIFIED', 'oversized numeric-observation file cannot produce a receipt');
});

test('launch failure remains UNVERIFIED and removes only its owned fixture', async () => {
  const sibling = fs.mkdtempSync(path.join(SCRATCHPAD, 'native-budget-sibling-'));
  try {
    const before = fs.readdirSync(SCRATCHPAD).filter((name) => name.startsWith('native-budget-'));
    const failed = await probe.runNativeCase({ binary: process.execPath, scratchpad: SCRATCHPAD,
      model: 'gpt-6.1-sol', hostEnvironment: {}, launch: () => { throw new Error('synthetic launch refusal'); } });
    assert.equal(failed.status, 'UNVERIFIED');
    assert.deepEqual(fs.readdirSync(SCRATCHPAD).filter((name) => name.startsWith('native-budget-')), before);
    assert.equal(fs.existsSync(sibling), true, 'launch failure cleanup must preserve a sibling fixture');
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
  }
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
  assert.deepEqual(response.content, [{ type: 'text', text: 'fixture-done' }], 'auxiliary models get plain fixture text');
  assert.equal(counters.mainTurns, 0, 'auxiliary requests cannot consume main-turn pressure');
  assert.equal(counters.models.other, 1, 'unknown model text is reduced to an allowlisted counter');
});

test('auxiliary traffic preserves the main pressure sequence and stripped Opus IDs still need native window proof', async () => {
  const counters = { requests: 0, summaryRequests: 0, mainTurns: 0, models: { other: 0, 'gpt-6.1-sol': 0, 'codex-auto': 0 } };
  probe.fixtureReply({ model: 'fixture-auxiliary', system: '' }, counters);
  const first = probe.fixtureReply({ model: 'gpt-6.1-sol', system: '' }, counters);
  probe.fixtureReply({ model: 'codex-auto', system: '' }, counters);
  probe.fixtureReply({ model: 'fixture-auxiliary', system: '' }, counters);
  const second = probe.fixtureReply({ model: 'gpt-6.1-sol', system: '' }, counters);
  assert.equal(first.usage.input_tokens, 238000, 'first actual main turn retains below-threshold pressure');
  assert.equal(second.usage.input_tokens, 240000, 'second actual main turn retains above-threshold pressure');
  assert.equal(counters.mainTurns, 2, 'workers and auxiliary requests never advance mainTurns');
  const recognized = await syntheticRun('complete', 'claude-opus-5-5[1m]');
  assert.equal(recognized.counters.models['claude-opus-5-5'], 3, 'recognized frontend may strip the bracket suffix upstream');
  recognized.counters.windows = [];
  assert.equal(probe.reportCases(recognized, recognized).recognizedClaude.status, 'UNVERIFIED', 'model acceptance alone cannot prove a full native window');
});

test('an exact /context diagnostic uses separate count_tokens traffic and only structured native metadata', async () => {
  const owned = {};
  const result = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD, hostEnvironment: {},
    launch: fixtureLaunch('metadataOnly', owned) });
  assert.equal(owned.launches.length, 4, 'two model cases each launch an isolated pressure flow and exact context prompt');
  assert.equal(result.cases.projectEnv.status, 'PASS', 'native-shaped raw window can prove the project cap without debug prose');
  assert.equal(result.cases.recognizedClaude.status, 'PASS', 'native-shaped full raw window plus stripped model acceptance is required');
  assert.equal(result.cases.proactiveCompaction.status, 'UNVERIFIED', 'raw window and fake token counts cannot manufacture a native threshold receipt');
  const context = result.runs[0].context.counters;
  assert.equal(context.countRequests, 1, 'count_tokens requests are counted separately');
  assert.equal(context.requests, 0, 'count_tokens never generates an Agent/main response');
  assert.equal(context.mainTurns, 0, 'count_tokens never advances main pressure');
  assert.deepEqual(context.contextUsage, [{ model: 'gpt-6.1-sol', raw_max_tokens: 272000, total_tokens: 42, percentage: 0 }]);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false, 'rendered categories and memory paths never escape');
  assert.equal(result.runs[0].counters.agentAvailable, true);
  assert.equal(result.runs[0].counters.agentToolAvailable, true);
  for (const launch of owned.launches) {
    assert.equal(fs.existsSync(launch.root), false);
    assert.notEqual(launch.child.exitCode ?? launch.child.signalCode, null);
    await assertPortClosed(launch.port);
  }
});

test('an emitted context-diagnostic refusal stops the next model case and cleans both owned launches', async () => {
  const owned = {};
  const result = await probe.runProbe({ binary: process.execPath, scratchpad: SCRATCHPAD, hostEnvironment: { CLAUDECODE: 'keep' },
    launch: fixtureLaunch('refuseContext', owned) });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(owned.launches.length, 2, 'actual context refusal prevents the recognized-model launch');
  assert.equal(result.runs[0].context.counters.toolRefusals, 1);
  assert.equal(result.runs[0].context.counters.toolErrors, 1);
  assert.deepEqual(Object.values(result.cases).map((entry) => entry.status), Array(5).fill('UNVERIFIED'));
  assert.equal(owned.environment.CLAUDECODE, 'keep');
  for (const launch of owned.launches) {
    assert.equal(fs.existsSync(launch.root), false);
    await assertPortClosed(launch.port);
  }
});

test('structured telemetry is numeric, allowlisted and bounded while unavailable agents and errors stay distinguishable', async () => {
  const result = await syntheticRun('noObservation');
  const counters = result.counters;
  probe.observeEvent('{"type":"system","subtype":"init","agents":[],"tools":[]}', counters);
  assert.equal(counters.agentAvailable, false);
  assert.equal(counters.agentToolAvailable, false);
  probe.observeEvent('{"type":"system","subtype":"init"}', counters);
  assert.equal(counters.agentAvailable, null, 'missing registration metadata stays unobserved');
  assert.equal(counters.agentToolAvailable, null);
  probe.observeEvent('{"type":"user","message":{"content":[null,{"type":"text","text":"fixture-only"},{"type":"tool_result","is_error":true,"content":"Unknown fixture worker"},{"type":"tool_result","is_error":false,"content":"fixture-done"}]}}', counters);
  probe.observeEvent('{"type":"user","message":{"content":"fixture-only"}}', counters);
  assert.equal(counters.toolResults, 2);
  assert.equal(counters.toolErrors, 1, 'nonpermission worker errors stay separate from refusal');
  assert.equal(counters.toolRefusals, 0);
  probe.observeEvent('{"type":"assistant","context_usage":{"model":"private-model","raw_max_tokens":1000000,"total_tokens":1}}', counters);
  probe.observeEvent('{"type":"assistant","context_usage":{"model":"gpt-6.1-sol","raw_max_tokens":-1,"total_tokens":1}}', counters);
  probe.observeEvent('{"type":"assistant","context_usage":{"model":"gpt-6.1-sol","raw_max_tokens":272000,"total_tokens":"1"}}', counters);
  assert.deepEqual(counters.contextUsage, [], 'invalid or arbitrary metadata never proves a native window');
  probe.observeEvent('{"type":"result","usage":{}}', counters);
  const event = JSON.stringify({ type: 'assistant', context_usage: { model: 'gpt-6.1-sol', raw_max_tokens: 272000, total_tokens: 300000, percentage: 110, agents: ['private-description'] },
    message: { usage: { input_tokens: 240000, output_tokens: -1, cache_read_input_tokens: 'no', secret: 'private' } } });
  for (let index = 0; index < 40; index++) probe.observeEvent(event, counters);
  assert.equal(counters.contextUsage.length, 32, 'structured context history is bounded');
  assert.equal(counters.nativeUsage.length, 32, 'native usage history is bounded');
  assert.deepEqual(counters.nativeUsage[0], { input_tokens: 240000 });
  assert.deepEqual(counters.contextUsage[0], { model: 'gpt-6.1-sol', raw_max_tokens: 272000, total_tokens: 300000, percentage: 110 });
  assert.equal(JSON.stringify(counters).includes('private'), false);
});

test('synthetic Messages usage has explicit nullable fields and cumulative SSE totals', () => {
  const counters = { requests: 0, mainTurns: 0, summaryRequests: 0, models: { 'gpt-6.1-sol': 0 } };
  const message = probe.fixtureReply({ model: 'gpt-6.1-sol', system: '' }, counters);
  const expected = { input_tokens: 238000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null };
  assert.deepEqual(message.usage, expected, 'complete synthetic Usage includes required cache and nullable fields');
  const events = probe.streamCompletion(message).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events[0].message.usage, { ...expected, output_tokens: 0 }, 'message_start has zero output before content');
  const delta = events.find((event) => event.type === 'message_delta');
  assert.deepEqual(delta.usage, { input_tokens: 238000, output_tokens: 1, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, output_tokens_details: null, server_tool_use: null }, 'MessageDeltaUsage preserves cumulative input and output');
  assert.equal(delta.usage.input_tokens + delta.usage.cache_creation_input_tokens + delta.usage.cache_read_input_tokens, 238000);
});

test('Agent availability observes the documented legacy Task init alias without inventing missing metadata', () => {
  const counters = {};
  probe.observeEvent('{"type":"system","subtype":"init","tools":["Task"],"agents":["budget-worker"]}', counters);
  assert.equal(counters.agentToolAvailable, true, 'Task init alias proves advertised Agent availability');
  probe.observeEvent('{"type":"system","subtype":"init","tools":["Agent"]}', counters);
  assert.equal(counters.agentToolAvailable, true);
  probe.observeEvent('{"type":"system","subtype":"init","tools":["private-tool"]}', counters);
  assert.equal(counters.agentToolAvailable, false);
  probe.observeEvent('{"type":"system","subtype":"init"}', counters);
  assert.equal(counters.agentToolAvailable, null, 'absent init tools remain UNVERIFIED');
});

test('fixture emits only the Agent or Task schema advertised by the current request', () => {
  const cases = [[], [{ name: 'private-tool', input_schema: { type: 'object' } }], [{ name: 'Agent' }],
    [{ name: 'Agent', input_schema: { type: 'object' } }], [{ name: 'Task', input_schema: { type: 'object' } }]];
  const expectedNames = [undefined, undefined, undefined, 'Agent', 'Task'];
  for (const [index, tools] of cases.entries()) {
    const counters = { requests: 0, mainTurns: 0, summaryRequests: 0, models: { 'gpt-6.1-sol': 0 } };
    const message = probe.fixtureReply({ model: 'gpt-6.1-sol', system: '', tools }, counters);
    assert.equal(message.content[0].name, expectedNames[index], 'tool_use name comes only from this request advertised known schema');
    assert.equal(counters.agentToolAdvertised, expectedNames[index] === 'Agent');
    assert.equal(counters.taskToolAdvertised, expectedNames[index] === 'Task');
    const next = probe.fixtureReply({ model: 'gpt-6.1-sol', system: '', tools: [] }, counters);
    assert.equal(next.content[0].type, 'text', 'previous request schema never authorizes an unavailable tool');
    assert.equal(next.usage.input_tokens, 240000, 'absence of tools preserves synthetic pressure without claiming Agent execution');
    assert.equal(JSON.stringify(counters).includes('private-tool'), false);
  }
});

test('tool error classification retains only allowlisted counters and guard refusal takes precedence', async () => {
  const result = await syntheticRun('noObservation');
  const counters = result.counters;
  const errors = ['Unknown tool: fixture-secret', 'Agent type fixture-secret not found', 'Model fixture-secret not supported',
    'Permission denied: unknown tool fixture-secret', [{ type: 'text', text: 'fixture-secret failure' }]];
  for (const content of errors) probe.observeEvent(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', is_error: true, content },
  ] } }), counters);
  assert.deepEqual(counters.toolErrorKinds, { unknown_tool: 1, unknown_subagent: 1, unsupported_model: 1, native_guard_refusal: 1, other: 1 });
  assert.equal(counters.toolErrors, 5);
  assert.equal(counters.toolRefusals, 1, 'unsupported fixture schemas never manufacture a native guard refusal');
  assert.equal(JSON.stringify(counters).includes('fixture-secret'), false, 'error text and arbitrary identifiers never escape');
  assert.equal(probe.reportCases(result, result).agentFrontmatter.status, 'UNVERIFIED');
});

test('CLI validation and inherited-budget refusal use only synthetic processes', async () => {
  await assert.rejects(probe.main(), /absolute existing binary/);
  const child = spawnGatewayProcess(null, process.execPath, [path.join(__dirname, 'native-budget-probe.js'), process.execPath, SCRATCHPAD], {
    env: { ...process.env, CLAUDECODE: 'synthetic-guard', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000' }, stdio: ['ignore', 'pipe', 'pipe'],
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
