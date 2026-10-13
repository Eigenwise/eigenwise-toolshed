'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { startGateway } = require('./support.js');

const WORKER = path.join(__dirname, '..', 'lib', 'request-worker.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function usageSse(inputTokens) {
  return `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: inputTokens } })}\n\n`
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
}

function answerUsage(res, inputTokens) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(usageSse(inputTokens));
}

function answerJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const tooLarge = (message) => ({ type: 'error', error: { type: 'request_too_large', message } });
const UPSTREAM_NO_COUNTS = 'Your input exceeds the context window of this model. Please adjust your input and try again.';

async function overflowGateway(t, respond, extraEnv = {}) {
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET') return answerJson(res, 200, { data: [{ id: 'gpt-5.6-sol' }] });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => respond(res));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const spans = [];
  const collector = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      spans.push(JSON.parse(Buffer.concat(chunks).toString()).resourceSpans[0].scopeSpans[0].spans[0]);
      res.writeHead(200);
      res.end();
    });
  });
  const collectorPort = await listen(collector);
  t.after(() => collector.close());
  const { port } = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_COMPACT_TRIGGER: '100',
    CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: `http://127.0.0.1:${collectorPort}/v1/traces`,
    ...extraEnv,
  });
  return { port, spans };
}

async function routeAttributes(spans, count) {
  const deadline = Date.now() + 5000;
  while (spans.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(spans.length, count, 'every request produced one route span');
  return Object.fromEntries(spans[count - 1].attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
}

function overflowAttributes(attributes) {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('overflow_')));
}

// The upstream path measures the body it forwarded, with the client alias replaced by the backend id.
const forwardedBytes = (body) => Buffer.byteLength(body.replace('claude-gpt-5.6-sol', 'gpt-5.6-sol'));
const session = { 'x-claude-code-session-id': 'overflow-session' };
const firstTurn = JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 1, messages: [{ role: 'user', content: 'prompt-secret' }] });
const continuation = JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 1,
  messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
const compaction = JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 1, stream: true,
  system: [{ type: 'text', text: 'You are a helpful AI assistant tasked with summarizing conversations.' }],
  messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'summarize' }] });

test('a first request over the window says there is nothing to compact and records why', async (t) => {
  const { port, spans } = await overflowGateway(t, (res) => answerJson(res, 413, tooLarge('Prompt is too long (250000 tokens > 242000 tokens)')));

  const response = await post(port, firstTurn, session);

  assert.equal(response.status, 413);
  const { error } = JSON.parse(response.body);
  assert.equal(error.type, 'request_too_large');
  assert.ok(error.message.startsWith('Prompt is too long (250000 tokens > 242000 tokens) [model-gateway: phase first_turn'), error.message);
  assert.match(error.message, /recovery: nothing to compact, the request has no prior turn: shrink the first prompt/);
  assert.equal(error.message.match(/tokens\s*>\s*\d+ tokens/g).length, 1, 'the upstream counts are not repeated');
  assert.deepEqual(error.overflow, {
    phase: 'first_turn', refused_by: 'upstream', request_bytes: forwardedBytes(firstTurn),
    tokens: 250000, tokens_from: 'upstream', limit_tokens: 242000,
  });
  const attributes = await routeAttributes(spans, 1);
  assert.equal(attributes.status_code, 413);
  assert.deepEqual(overflowAttributes(attributes), {
    overflow_phase: 'first_turn', overflow_refused_by: 'upstream', overflow_request_bytes: forwardedBytes(firstTurn),
    overflow_tokens: 250000, overflow_tokens_from: 'upstream', overflow_limit_tokens: 242000,
  });
  assert.equal(JSON.stringify(spans).includes('prompt-secret'), false);
});

test('a first request without upstream counts keeps the placeholder but reports its tokens as UNVERIFIED', async (t) => {
  const { port, spans } = await overflowGateway(t, (res) => answerJson(res, 413, tooLarge(UPSTREAM_NO_COUNTS)), { CODEX_GATEWAY_CONTEXT_WINDOW: 'full' });

  const { error } = JSON.parse((await post(port, firstTurn, session)).body);

  assert.match(error.message, /^Your input exceeds the context window of this model\. Please adjust your input and try again\. \(920001 tokens > 920000 tokens\) \[model-gateway: phase first_turn, refused by upstream; request \d+ bytes, tokens UNVERIFIED, limit 920000 tokens; recovery: nothing to compact/);
  assert.equal(error.overflow.tokens, null);
  assert.equal(error.overflow.tokens_from, null);
  const attributes = await routeAttributes(spans, 1);
  assert.equal(attributes.overflow_phase, 'first_turn');
  assert.equal(attributes.overflow_limit_tokens, 920000);
  assert.equal(Object.hasOwn(attributes, 'overflow_tokens'), false);
});

test('a continuation refused by the sentry says compact and retry with the measured previous turn', async (t) => {
  const { port, spans } = await overflowGateway(t, (res) => answerUsage(res, 150));

  assert.equal((await post(port, continuation, session)).status, 200);
  const response = await post(port, continuation, session);

  assert.equal(response.status, 413);
  const { error } = JSON.parse(response.body);
  assert.ok(error.message.startsWith('Prompt is too long for the Codex context window; compact and retry. (150 tokens > 100 tokens) [model-gateway: phase continuation, refused by gateway_sentry;'), error.message);
  assert.match(error.message, /150 tokens from previous_turn_usage, limit 100 tokens; recovery: compact the conversation and retry\]$/);
  assert.deepEqual(error.overflow, {
    phase: 'continuation', refused_by: 'gateway_sentry', request_bytes: Buffer.byteLength(continuation),
    tokens: 150, tokens_from: 'previous_turn_usage', limit_tokens: 100,
  });
  assert.deepEqual(overflowAttributes(await routeAttributes(spans, 2)), {
    overflow_phase: 'continuation', overflow_refused_by: 'gateway_sentry', overflow_request_bytes: Buffer.byteLength(continuation),
    overflow_tokens: 150, overflow_tokens_from: 'previous_turn_usage', overflow_limit_tokens: 100,
  });
});

test('a compaction request over the window says compacting again cannot shrink it', async (t) => {
  let calls = 0;
  const { port, spans } = await overflowGateway(t, (res) => (++calls === 1 ? answerUsage(res, 150) : answerJson(res, 413, tooLarge(UPSTREAM_NO_COUNTS))));

  assert.equal((await post(port, continuation, session)).status, 200);
  assert.equal((await post(port, continuation, session)).status, 413);
  const response = await post(port, compaction, session);

  assert.equal(response.status, 413);
  const { error } = JSON.parse(response.body);
  assert.match(error.message, /\(150 tokens > 272000 tokens\) \[model-gateway: phase compaction, refused by upstream;/);
  assert.match(error.message, /recovery: the compaction request itself is over the limit/);
  assert.deepEqual(error.overflow, {
    phase: 'compaction', refused_by: 'upstream', request_bytes: forwardedBytes(compaction),
    tokens: 150, tokens_from: 'previous_turn_usage', limit_tokens: 272000,
  });
  const attributes = await routeAttributes(spans, 3);
  assert.equal(attributes.overflow_phase, 'compaction');
  assert.equal(attributes.overflow_refused_by, 'upstream');
  assert.equal(attributes.status_code, 413);
});

test('one agent crossing the sentry never refuses another agent in the same session', async (t) => {
  let forwarded = 0;
  const { port } = await overflowGateway(t, (res) => { forwarded++; answerUsage(res, 150); });
  const parent = { ...session, 'x-claude-code-agent-id': 'parent-agent' };
  const subagent = { ...session, 'x-claude-code-agent-id': 'subagent', 'x-claude-code-parent-agent-id': 'parent-agent' };

  assert.equal((await post(port, continuation, parent)).status, 200);
  assert.equal((await post(port, firstTurn, subagent)).status, 200);
  assert.equal((await post(port, continuation, parent)).status, 413);
  assert.equal(forwarded, 2);
});

test('a legacy proxy context error carries the same diagnostics with the sentry off', async (t) => {
  const { port, spans } = await overflowGateway(t,
    (res) => answerJson(res, 400, { error: { message: 'input exceeds context window' } }), { CODEX_GATEWAY_SENTRY: '0' });

  const response = await post(port, firstTurn, session);

  assert.equal(response.status, 413);
  assert.equal(response.headers['x-model-gateway-upstream-status'], '400');
  const { error } = JSON.parse(response.body);
  assert.ok(error.message.startsWith('Input exceeds the model context window; compact and retry. [model-gateway: phase first_turn,'), error.message);
  assert.equal(error.overflow.tokens, null);
  assert.equal((await routeAttributes(spans, 1)).overflow_phase, 'first_turn');
});

test('request phase reads the request shape and says UNVERIFIED when it has no message list', () => {
  const { requestPhase } = require(WORKER);
  assert.equal(requestPhase(JSON.parse(firstTurn)), 'first_turn');
  assert.equal(requestPhase(JSON.parse(continuation)), 'continuation');
  assert.equal(requestPhase(JSON.parse(compaction)), 'compaction');
  assert.equal(requestPhase({ model: 'claude-gpt-5.6-sol' }), 'UNVERIFIED');
  assert.equal(requestPhase({ messages: [null, { role: 'user', content: 'x' }] }), 'first_turn');
});
