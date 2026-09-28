'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, startGateway } = require('./support.js');

const STATE_MODULE = path.join(__dirname, '..', 'lib', 'codex-upstream-state.js');
const RUNTIME_MODULE = path.join(__dirname, '..', 'lib', 'runtime.js');
const EMPTY_COMPLETION = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Codex completed without producing output' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: Date.now() - started }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function codexMessage(stream) {
  return JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 64, stream, messages: [{ role: 'user', content: 'hi' }] });
}

async function codexReadiness(port) {
  return JSON.parse((await request(port, 'GET', '/healthz')).body).codexReadiness;
}

async function workerBehind(t, answerInference, environment = {}, { modelsStatus = 200 } = {}) {
  const proxy = { modelsFetches: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      proxy.modelsFetches++;
      res.writeHead(modelsStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    req.resume();
    req.once('end', () => answerInference(res));
  });
  const proxyPort = await listen(server);
  t.after(() => server.close());
  const { port } = await startGateway(t, 'serve-worker', {
    ...environment,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_USAGE_ENDPOINT: '0',
  });
  return { port, proxy };
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const FINISHED_TURN_WITHOUT_STOP = [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hand-back report' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
];

function runInGatewayHome(t, script) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, ['-e', script], { env: gatewayTestEnvironment(t), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`state child exited ${code}: ${stderr}`)));
  });
}

test('#190: a 429 block expires at its Retry-After, the proxy reset, or 60 s; 401 waits for setup', async (t) => {
  const result = await runInGatewayHome(t, `
    const state = require(${JSON.stringify(STATE_MODULE)});
    const { codexReadinessMessage } = require(${JSON.stringify(RUNTIME_MODULE)});
    const now = Date.parse('2026-09-28T10:00:00Z');
    const block = (statusCode, headers) => state.setUpstreamBlocked({ statusCode, evidence: 'headers:x-openai-request-id', headers, now });
    const seconds = block(429, { 'retry-after': '30' });
    const httpDate = block(429, { 'retry-after': 'Mon, 28 Sep 2026 10:05:00 GMT' });
    const proxyReset = block(429, { 'anthropic-ratelimit-unified-reset': String(Date.parse('2026-09-28T12:15:00Z') / 1000) });
    const fallback = block(429, undefined);
    const beforeExpiry = state.readUpstreamBlocked(now + state.RATE_LIMIT_BLOCK_DEFAULT_MS - 1);
    const afterExpiry = state.readUpstreamBlocked(now + state.RATE_LIMIT_BLOCK_DEFAULT_MS);
    const rateLimitedMessage = codexReadinessMessage('upstream-blocked', 'gw', fallback);
    const credential = block(401, { 'retry-after': '30' });
    const credentialNextDay = state.readUpstreamBlocked(now + 86400000);
    process.stdout.write(JSON.stringify({ seconds, httpDate, proxyReset, fallback, beforeExpiry, afterExpiry, rateLimitedMessage, credential, credentialNextDay,
      credentialMessage: codexReadinessMessage('upstream-blocked', 'gw', credential) }));
  `);

  assert.equal(result.seconds.expiresAt, '2026-09-28T10:00:30.000Z');
  assert.equal(result.httpDate.expiresAt, '2026-09-28T10:05:00.000Z');
  assert.equal(result.proxyReset.expiresAt, '2026-09-28T12:15:00.000Z');
  assert.equal(result.fallback.expiresAt, '2026-09-28T10:01:00.000Z');
  assert.equal(result.beforeExpiry?.state, 'upstream-blocked');
  assert.equal(result.afterExpiry, null, 'the reader drops the block at its expiry without any request succeeding');
  assert.match(result.rateLimitedMessage, /rate-limited by OpenAI \(429\) until 2026-09-28T10:01:00\.000Z\. The block lifts by itself then/);
  assert.equal(result.credential.expiresAt, undefined);
  assert.equal(result.credentialNextDay?.state, 'upstream-blocked');
  assert.match(result.credentialMessage, /Run `node "gw" setup`/);
});

test('#190: a live 429 carries its Retry-After into readiness, lifts on time, and a later 2xx clears it early', async (t) => {
  const answers = [
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 429, headers: { 'retry-after': '3600' } },
    { status: 200, headers: {} },
  ];
  const { port } = await workerBehind(t, (res) => {
    const { status, headers } = answers.shift();
    res.writeHead(status, { 'content-type': 'application/json', 'x-openai-request-id': 'req_1', ...headers });
    res.end(status === 200
      ? JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }));
  });

  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 429);
  const blocked = (await codexReadiness(port)).upstreamBlocked;
  assert.equal(blocked.statusCode, 429);
  assert.equal(Date.parse(blocked.expiresAt) - Date.parse(blocked.observedAt), 1000, 'readiness shows the expiry the 429 named');
  await sleep(Math.max(0, blocked.expiresAtMs - Date.now()) + 100);
  assert.equal((await codexReadiness(port)).upstreamBlocked, null, 'the block lifted with no request in between');

  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 429);
  assert.equal((await codexReadiness(port)).upstreamBlocked.statusCode, 429);
  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(false))).status, 200);
  assert.equal((await codexReadiness(port)).upstreamBlocked, null, 'a successful request clears an hour-long block at once');
});

test('#192: a Codex turn that completed with no output answers an empty end_turn, not a retryable 503', async (t) => {
  const answers = [EMPTY_COMPLETION, EMPTY_COMPLETION, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream overloaded' } })];
  const { port } = await workerBehind(t, (res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(answers.shift());
  });

  const streamed = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers['content-type'], /text\/event-stream/);
  const events = streamed.body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.type), ['message_start', 'message_delta', 'message_stop']);
  assert.equal(events[0].message.model, 'claude-gpt-5.6-sol');
  assert.deepEqual(events[0].message.content, []);
  assert.equal(events[1].delta.stop_reason, 'end_turn');

  const buffered = await request(port, 'POST', '/v1/messages', codexMessage(false));
  assert.equal(buffered.status, 200);
  const message = JSON.parse(buffered.body);
  assert.deepEqual([message.type, message.content, message.stop_reason], ['message', [], 'end_turn']);

  assert.equal((await request(port, 'POST', '/v1/messages', codexMessage(true))).status, 503, 'any other 503 still reaches the client');
});

test('#192: a stream that finished its turn but lost message_stop is closed for the client; a cut-off turn is not', async (t) => {
  const answers = [FINISHED_TURN_WITHOUT_STOP, FINISHED_TURN_WITHOUT_STOP.slice(0, 3)];
  const { port } = await workerBehind(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(answers.shift()));
  });

  const finished = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.match(finished.body, /hand-back report/);
  assert.match(finished.body, /event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/);

  const cutOff = await request(port, 'POST', '/v1/messages', codexMessage(true));
  assert.doesNotMatch(cutOff.body, /message_stop/, 'a turn with no stop reason and an open block is not dressed up as finished');
});

test('#238: /v1/models refreshes on a timer and a burst of 50 never triggers a refresh or waits on file writes', async (t) => {
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_MODELS_REFRESH_MS: '150' });
  const modelsFile = path.join(environment.HOME, '.claude', 'model-gateway', 'models.json');
  const { port, proxy } = await workerBehind(t, (res) => { res.writeHead(500); res.end(); }, environment, { modelsStatus: 500 });
  await sleep(800);
  assert.ok(proxy.modelsFetches >= 3, `the snapshot refreshed ${proxy.modelsFetches} time(s) with no request asking`);

  fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
  let rewriting = true;
  const rewrite = (async () => {
    while (rewriting) {
      fs.writeFileSync(modelsFile, JSON.stringify(Array.from({ length: 2000 }, (_, index) => `gpt-5.6-${index}`)));
      await sleep(1);
    }
  })();
  const fetchesBefore = proxy.modelsFetches;
  const started = Date.now();
  const burst = await Promise.all(Array.from({ length: 50 }, () => request(port, 'GET', '/v1/models')));
  const burstMs = Date.now() - started;
  rewriting = false;
  await rewrite;

  assert.ok(burst.every((response) => response.status === 200 && JSON.parse(response.body).data.length > 0));
  assert.ok(proxy.modelsFetches - fetchesBefore <= Math.ceil(burstMs / 150) + 1,
    `${proxy.modelsFetches - fetchesBefore} refreshes in a ${burstMs} ms burst means requests are starting them`);
  const slowest = Math.max(...burst.map((response) => response.ms));
  assert.ok(slowest < 1500, `slowest /v1/models took ${slowest} ms`);
});

test('#238: a slow proxy auth status inside /healthz does not stall /v1/models', async (t) => {
  const environment = gatewayTestEnvironment(t);
  const home = environment.HOME;
  const bin = path.join(home, '.claude', 'model-gateway', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakeProxy = path.join(bin, process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  try { fs.linkSync(process.execPath, fakeProxy); } catch { fs.copyFileSync(process.execPath, fakeProxy); }
  const slowAuthStatus = path.join(home, 'slow-auth-status.js');
  fs.writeFileSync(slowAuthStatus, [
    "if (/codex$/.test(process.argv[1] || '')) {",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);',
    "  process.stdout.write('account: fixture\\n');",
    '  process.exit(0);',
    '}',
  ].join('\n'));
  environment.NODE_OPTIONS = `--require "${slowAuthStatus.replace(/\\/g, '/')}"`;
  const { port } = await workerBehind(t, (res) => { res.writeHead(500); res.end(); }, environment);

  const health = request(port, 'GET', '/healthz');
  await sleep(200);
  const models = await Promise.all(Array.from({ length: 10 }, () => request(port, 'GET', '/v1/models')));
  const healthResult = await health;

  assert.ok(healthResult.ms >= 1400, `the fixture auth status must actually be slow (healthz took ${healthResult.ms} ms)`);
  assert.equal(JSON.parse(healthResult.body).codexReadiness.checks.codexAuth, true);
  const slowest = Math.max(...models.map((response) => response.ms));
  assert.ok(slowest < 750, `/v1/models waited ${slowest} ms behind the auth status`);
});
