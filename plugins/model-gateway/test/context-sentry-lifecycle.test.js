'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startGateway } = require('./support.js');

const sessionHeaders = { 'x-claude-code-session-id': 'sentry-lifecycle' };
const ordinaryPayload = { model: 'claude-gpt-6.1-sol[1m]', stream: true, max_tokens: 1,
  messages: [{ role: 'user', content: 'synthetic turn' }] };
const compactionPayload = { ...ordinaryPayload,
  system: 'You are a helpful AI assistant tasked with summarizing conversations.' };

function codexUsage(inputTokens, terminal = true) {
  const delta = `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: inputTokens } })}\n\n`;
  return delta + (terminal ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : '');
}

function grokUsage(inputTokens, type = 'response.completed') {
  return `data: ${JSON.stringify({ type, response: { id: 'synthetic-response', output: [], usage: { input_tokens: inputTokens } } })}\n\n`;
}

function sseAnswer(body) {
  return (response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(body); };
}

function jsonAnswer(status, body) {
  return (response) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
}

async function lifecycleGateway(testRunner, answers, grok = false) {
  let forwarded = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-luna' }] }));
    }
    forwarded++;
    const answer = answers.shift();
    assert.ok(answer, 'every forwarded synthetic request has a scripted response');
    answer(response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  testRunner.after(() => upstream.close());
  const environment = { CODEX_GATEWAY_PROXY_PORT: String(upstream.address().port),
    CODEX_GATEWAY_REQUEST_LOG: '0', CODEX_GATEWAY_COMPACT_TRIGGER: '100', CODEX_GATEWAY_COMPACT_STREAM_RETRIES: '0' };
  if (grok) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-lifecycle-grok-'));
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::fixture-client': { key: 'fixture-token', refresh_token: 'fixture-refresh',
        expires_at: Date.now() + 3600000, oidc_client_id: 'fixture-client' },
    }));
    testRunner.after(() => fs.rmSync(home, { recursive: true, force: true }));
    environment.CODEX_GATEWAY_GROK_HOME = home;
    environment.CODEX_GATEWAY_GROK_ENDPOINT = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  }
  const gateway = await startGateway(testRunner, 'serve-shim', environment);
  return { port: gateway.port, forwarded: () => forwarded };
}

async function send(gateway, payload = ordinaryPayload, headers = sessionHeaders) {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.text() };
}

function assertOverflow(response, tokens) {
  assert.equal(response.status, 413, 'completed ordinary high-usage turn rearms the next refusal');
  const error = JSON.parse(response.body).error;
  assert.equal(error.type, 'request_too_large');
  assert.equal(error.overflow.refused_by, 'gateway_sentry');
  assert.equal(error.overflow.tokens_from, 'previous_turn_usage');
  assert.equal(error.overflow.tokens, tokens, 'refusal reports the actual latest completed input usage');
  assert.equal(error.overflow.limit_tokens, 100);
  assert.ok(error.message.includes(`(${tokens} tokens > 100 tokens)`));
}

test('Codex sentry rearms after failed compaction and a completed ordinary turn, not incomplete or failed attempts', async (testRunner) => {
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)),
    jsonAnswer(500, { error: { type: 'api_error', message: 'synthetic compaction failure' } }),
    sseAnswer(codexUsage(102, false)), jsonAnswer(500, { error: { type: 'api_error', message: 'synthetic failure' } }),
    sseAnswer(codexUsage(103)), sseAnswer(codexUsage(104))]);
  assert.equal((await send(gateway)).status, 200);
  assertOverflow(await send(gateway), 101);
  assert.equal((await send(gateway, compactionPayload)).status, 500);
  assert.equal((await send(gateway)).status, 200, 'incomplete turn leaves the current refusal attempt latched');
  assert.equal((await send(gateway)).status, 500, 'failed request does not rearm a tight refusal loop');
  assert.equal((await send(gateway)).status, 200);
  assertOverflow(await send(gateway), 103);
  assert.equal(gateway.forwarded(), 5);
});

test('Codex compaction bypasses an armed sentry, preserves hysteresis, and resets after lower usage', async (testRunner) => {
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)), sseAnswer(codexUsage(102)),
    sseAnswer(codexUsage(103)), sseAnswer(codexUsage(80)), sseAnswer(codexUsage(101)),
    sseAnswer(codexUsage(20)), sseAnswer(codexUsage(99)), sseAnswer(codexUsage(101))]);
  assert.equal((await send(gateway)).status, 200);
  assert.equal((await send(gateway, compactionPayload)).status, 200, 'compaction bypass does not consume the pending ordinary refusal');
  assertOverflow(await send(gateway), 102);
  assert.equal((await send(gateway, compactionPayload)).status, 200, 'high compaction completion leaves the attempt latched');
  assert.equal((await send(gateway)).status, 200);
  assert.equal((await send(gateway)).status, 200, 'usage between low watermark and trigger preserves hysteresis');
  assertOverflow(await send(gateway), 101);
  assert.equal((await send(gateway, compactionPayload)).status, 200);
  assert.equal((await send(gateway)).status, 200);
  assert.equal((await send(gateway)).status, 200, 'healthy usage stays below the trigger');
  assertOverflow(await send(gateway), 101);
});

test('Codex sentry keeps sessions, agents and models independent and rearms completed JSON responses', async (testRunner) => {
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)), sseAnswer(codexUsage(99)),
    sseAnswer(codexUsage(99)), sseAnswer(codexUsage(99)),
    jsonAnswer(200, { type: 'message', content: [], stop_reason: 'end_turn', usage: { input_tokens: 104 } })]);
  assert.equal((await send(gateway)).status, 200);
  assert.equal((await send(gateway, ordinaryPayload, { ...sessionHeaders, 'x-claude-code-agent-id': 'sibling' })).status, 200);
  assert.equal((await send(gateway, ordinaryPayload, { 'x-claude-code-session-id': 'another-session' })).status, 200);
  assert.equal((await send(gateway, { ...ordinaryPayload, model: 'claude-gpt-5.6-luna[1m]' })).status, 200);
  assertOverflow(await send(gateway), 101);
  assert.equal((await send(gateway, { ...ordinaryPayload, stream: false })).status, 200);
  assertOverflow(await send(gateway), 104);
});

test('Codex sentry waits for the ordinary stream to finish before rearming', async (testRunner) => {
  let finishResponse;
  let beginResponse;
  const begun = new Promise((resolve) => { beginResponse = resolve; });
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)), (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(codexUsage(105, false));
    finishResponse = () => response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    beginResponse();
  }, sseAnswer(codexUsage(106, false))]);
  assert.equal((await send(gateway)).status, 200);
  assertOverflow(await send(gateway), 101);
  const running = send(gateway);
  await begun;
  assert.equal((await send(gateway)).status, 200, 'stream chunks cannot rearm while the ordinary request is running');
  finishResponse();
  assert.equal((await running).status, 200);
  assertOverflow(await send(gateway), 105);
});

test('running compaction cannot rearm either backend before or after high-usage completion', async (testRunner) => {
  for (const grok of [false, true]) {
    const ordinary = { ...ordinaryPayload, model: grok ? 'claude-grok-4.5[1m]' : ordinaryPayload.model };
    const compact = { ...compactionPayload, model: ordinary.model };
    const completedUsage = grok ? grokUsage : codexUsage;
    const unfinishedUsage = grok ? grokUsage(102, 'response.created') : codexUsage(102, false);
    let finishCompaction;
    let beginCompaction;
    const begun = new Promise((resolve) => { beginCompaction = resolve; });
    const gateway = await lifecycleGateway(testRunner, [sseAnswer(completedUsage(101)), (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(unfinishedUsage);
      finishCompaction = () => response.end(completedUsage(104));
      beginCompaction();
    }, sseAnswer(unfinishedUsage), sseAnswer(completedUsage(105))], grok);
    assert.equal((await send(gateway, ordinary)).status, 200);
    assertOverflow(await send(gateway, ordinary), 101);
    const running = send(gateway, compact);
    await begun;
    assert.equal((await send(gateway, ordinary)).status, 200, 'running compaction chunks cannot rearm');
    finishCompaction();
    assert.equal((await running).status, 200);
    assert.equal((await send(gateway, ordinary)).status, 200, 'high compaction completion cannot rearm');
    assertOverflow(await send(gateway, ordinary), 105);
  }
});

test('Grok sentry rearms only completed ordinary SSE and JSON responses and bypasses compaction', async (testRunner) => {
  const ordinary = { ...ordinaryPayload, model: 'claude-grok-4.5[1m]' };
  const compact = { ...compactionPayload, model: ordinary.model };
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(grokUsage(101)),
    jsonAnswer(500, { error: { message: 'synthetic compaction failure' } }),
    sseAnswer('data: not-json\n\ndata: [DONE]\n\n' + grokUsage(102, 'response.created')),
    sseAnswer(grokUsage(103, 'response.failed')), sseAnswer(grokUsage(104)),
    sseAnswer(grokUsage(105)), jsonAnswer(200, { id: 'synthetic-json', status: 'completed', output: [], usage: { input_tokens: 106 } }),
    sseAnswer(grokUsage(20))], true);
  assert.equal((await send(gateway, ordinary)).status, 200);
  assertOverflow(await send(gateway, ordinary), 101);
  assert.equal((await send(gateway, compact)).status, 500);
  assert.equal((await send(gateway, ordinary)).status, 200, 'Grok transport EOF without response.completed is incomplete');
  assert.equal((await send(gateway, ordinary)).status, 200, 'failed Grok event leaves the attempt latched');
  assert.equal((await send(gateway, ordinary)).status, 200);
  assert.equal((await send(gateway, compact)).status, 200, 'Grok compaction bypasses the rearmed ordinary refusal');
  assertOverflow(await send(gateway, ordinary), 105);
  assert.equal((await send(gateway, { ...ordinary, stream: false })).status, 200);
  assertOverflow(await send(gateway, ordinary), 106);
  assert.equal((await send(gateway, compact)).status, 200, 'successful lower-usage Grok compaction can still run');
});


test('high-usage Codex JSON compaction keeps the refusal latched and lower usage resets it', async (testRunner) => {
  const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)),
    jsonAnswer(200, { type: 'message', content: [], stop_reason: 'end_turn', usage: { input_tokens: 102 } }),
    sseAnswer(codexUsage(103, false)),
    jsonAnswer(200, { type: 'message', content: [], stop_reason: 'end_turn', usage: { input_tokens: 20 } }),
    jsonAnswer(200, { type: 'message', content: [], stop_reason: 'end_turn', usage: { input_tokens: 104 } })]);
  assert.equal((await send(gateway)).status, 200);
  assertOverflow(await send(gateway), 101);
  assert.equal((await send(gateway, compactionPayload)).status, 200);
  assert.equal((await send(gateway)).status, 200, 'high-usage Codex JSON compaction keeps the refusal latched');
  assert.equal((await send(gateway, compactionPayload)).status, 200, 'lower-usage JSON compaction still bypasses the sentry');
  assert.equal((await send(gateway)).status, 200, 'lower-usage JSON compaction resets the existing watermark');
  assertOverflow(await send(gateway), 104);
  assert.equal(gateway.forwarded(), 5);
});

for (const stopReason of [null, 'max_tokens', 'pause_turn', 'refusal', 'model_context_window_exceeded', 'unknown', undefined]) {
  test('incomplete Codex JSON keeps the refusal latched: ' + String(stopReason), async (testRunner) => {
    const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)),
      jsonAnswer(200, { type: 'message', content: [], stop_reason: stopReason, usage: { input_tokens: 102 } }),
      sseAnswer(codexUsage(103, false)),
      jsonAnswer(200, { type: 'message', content: [], stop_reason: 'end_turn', usage: { input_tokens: 104 } })]);
    assert.equal((await send(gateway)).status, 200);
    assertOverflow(await send(gateway), 101);
    assert.equal((await send(gateway, { ...ordinaryPayload, stream: false })).status, 200);
    assert.equal((await send(gateway)).status, 200, 'incomplete Codex JSON keeps the refusal latched');
    assert.equal((await send(gateway)).status, 200);
    assertOverflow(await send(gateway), 104);
    assert.equal(gateway.forwarded(), 4);
  });
}

for (const stopReason of ['end_turn', 'stop_sequence', 'tool_use']) {
  test('completed ordinary Codex JSON rearms the refusal: ' + stopReason, async (testRunner) => {
    const content = stopReason === 'tool_use'
      ? [{ type: 'tool_use', id: 'synthetic-tool', name: 'synthetic_tool', input: {} }]
      : [{ type: 'text', text: 'synthetic answer' }];
    const gateway = await lifecycleGateway(testRunner, [sseAnswer(codexUsage(101)),
      jsonAnswer(200, { type: 'message', content, stop_reason: stopReason, usage: { input_tokens: 104 } })]);
    assert.equal((await send(gateway)).status, 200);
    assertOverflow(await send(gateway), 101);
    assert.equal((await send(gateway, { ...ordinaryPayload, stream: false })).status, 200);
    assertOverflow(await send(gateway), 104);
    assert.equal(gateway.forwarded(), 2);
  });
}
