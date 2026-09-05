'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startCountingProxy, startGateway } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');
const WORKER = path.join(__dirname, '..', 'lib', 'request-worker.js');
const PINS = path.join(__dirname, '..', 'lib', 'pins.js');
const RUNTIME = path.join(__dirname, '..', 'lib', 'runtime.js');

// Neutralize a machine-set override so the default-window assertions are
// deterministic; the override test sets it explicitly in its own child env.
delete process.env.CODEX_GATEWAY_CONTEXT_WINDOW;
delete process.env.CODEX_GATEWAY_COMPACT_TRIGGER;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function requestStream(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForShim(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/healthz');
      if (response.status === 200) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('shim did not start');
}

async function spawnShim(t, proxyPort, extraEnv = {}) {
  const { port } = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    ...extraEnv,
  });
  return port;
}

function usageSse(usage) {
  return `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage })}\n\n`
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
}

const codexBody = JSON.stringify({
  model: 'claude-gpt-5.6-sol',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'test' }],
});

const sentrySessionHeaders = { 'x-claude-code-session-id': 'sentry-test-session' };

test('Codex discovery advertises context metadata but keeps the local model id unsuffixed', async (t) => {
  let forwarded;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'gpt-5.6-luna' },
        { id: 'gpt-6-astra' },
      ] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const models = JSON.parse((await request(shimPort, 'GET', '/v1/models')).body);
  const codexModels = models.data.filter(({ id }) => id.startsWith('claude-gpt-'));
  assert.deepEqual(codexModels.map(({ id, max_input_tokens }) => ({ id, max_input_tokens })), [
    { id: 'claude-gpt-5.6-sol', max_input_tokens: 920000 },
    { id: 'claude-gpt-5.6-terra', max_input_tokens: 920000 },
    { id: 'claude-gpt-5.6-luna', max_input_tokens: 920000 },
    { id: 'claude-gpt-6-astra', max_input_tokens: 920000 },
  ]);
  assert.ok(models.data.some(({ id }) => id === 'claude-grok-4.5'));
  assert.equal(codexModels.every(({ max_input_tokens }) => max_input_tokens === 920000), true);
  assert.equal(models.data.every(({ id }) => id.includes('[1m]') === false), true);

  await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol[1m]',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'legacy session' }],
  }));
  assert.equal(forwarded.model, 'gpt-5.6-sol');
});

test('Codex model windows use configured base ids and share them with fast siblings', () => {
  const { gatewayModel } = require(WORKER);
  const windows = {
    default: 920000,
    'gpt-5.6-sol': 810000,
    'gpt-6-astra': 900000,
  };

  assert.deepEqual(gatewayModel('gpt-5.6-sol', 'codex', undefined, windows), {
    id: 'claude-gpt-5.6-sol',
    display_name: 'GPT-5.6-sol (Codex)',
    type: 'model',
    max_input_tokens: 810000,
  });
  assert.equal(gatewayModel('gpt-6-astra', 'codex', undefined, windows).max_input_tokens, 900000);
  assert.equal(gatewayModel('gpt-6-astra-fast', 'codex', undefined, windows).max_input_tokens, 900000);
});

test('CODEX_GATEWAY_CONTEXT_WINDOW overrides the advertised max_input_tokens', async (t) => {
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_CONTEXT_WINDOW: '200000',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const models = JSON.parse((await request(shimPort, 'GET', '/v1/models')).body);
  assert.equal(models.data.filter(({ id }) => id.startsWith('claude-gpt-')).every(({ max_input_tokens }) => max_input_tokens === 200000), true);
});

test('Codex fallback includes GPT-6 Astra when the proxy has no model route', async (t) => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort);

  const models = JSON.parse((await request(shimPort, 'GET', '/v1/models')).body);
  assert.equal(models.data.some(({ id }) => id === 'claude-gpt-6-astra'), true);
});

test('default request route logging records Fable metadata but never prompt data', async (t) => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-routes-')), 'routes.jsonl');
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const testEnv = { ...process.env };
  delete testEnv.CODEX_GATEWAY_REQUEST_LOG;
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...testEnv,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: '0',
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG_PATH: logFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const sentinel = 'DO-NOT-LOG-this-private-prompt';
  await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-fable-5', max_tokens: 1, messages: [{ role: 'user', content: sentinel }],
  }), { 'x-claude-code-session-id': 'session-safe-id' });

  const logged = fs.readFileSync(logFile, 'utf8');
  assert.equal(logged.includes(sentinel), false);
  const entries = logged.trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries, [{
    at: entries[0].at,
    backend: 'anthropic',
    model: 'claude-fable-5',
    path: '/v1/messages',
    sessionId: 'session-safe-id',
  }]);
});

test('CODEX_GATEWAY_REQUEST_LOG=0 disables request route logging', async (t) => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-routes-disabled-')), 'routes.jsonl');
  const anthropic = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: '0',
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_REQUEST_LOG_PATH: logFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-fable-5', max_tokens: 1, messages: [{ role: 'user', content: 'disabled logging' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(logFile), false);
});


test('Codex sentry sums all input usage fields from SSE message_delta frames', async (t) => {
  let forwarded = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      res.writeHead(404);
      return res.end();
    }
    forwarded++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(usageSse({ input_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 19 }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_TRIGGER: '100' });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal(forwarded, 2);
});

test('Codex sentry returns one client-distinguishable context-overflow 413', async (t) => {
  let forwarded = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    forwarded++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(usageSse({ input_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 21 }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_TRIGGER: '100' });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  const overflow = await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders);
  assert.equal(overflow.status, 413);
  const error = JSON.parse(overflow.body).error;
  assert.equal(error.type, 'request_too_large');
  assert.match(error.message, /^Prompt is too long for the Codex context window; compact and retry\. \(101 tokens > 100 tokens\)$/);
  assert.equal(forwarded, 1);
});

test('Codex sentry latch lets compaction through and rearms below its low watermark', async (t) => {
  const usages = [101, 20, 101];
  let forwarded = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const usage = usages[Math.min(forwarded++, usages.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(usageSse({ input_tokens: usage }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_TRIGGER: '100' });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 413);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 413);
  assert.equal(forwarded, 3);
});

test('CODEX_GATEWAY_SENTRY=0 disables usage gating and genuine-413 rewriting', async (t) => {
  let forwarded = 0;
  const upstreamBody = JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'no numbers' } });
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    forwarded++;
    if (forwarded === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(usageSse({ input_tokens: 101 }));
    }
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, {
    CODEX_GATEWAY_COMPACT_TRIGGER: '100',
    CODEX_GATEWAY_SENTRY: '0',
  });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  const response = await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders);
  assert.equal(response.status, 413);
  assert.equal(response.body, upstreamBody);
  assert.equal(forwarded, 2);
});

test('Codex sentry never gates Claude passthrough requests', async (t) => {
  let forwarded = 0;
  const anthropic = http.createServer((req, res) => {
    forwarded++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());
  const shimPort = await spawnShim(t, 0, {
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
    CODEX_GATEWAY_COMPACT_TRIGGER: '1',
  });
  const claudeBody = JSON.stringify({ model: 'claude-opus-4-8[1m]', messages: [] });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', claudeBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', claudeBody, sentrySessionHeaders)).status, 200);
  assert.equal(forwarded, 2);
});

test('genuine no-numbers 413 gets usage numbers appended', async (t) => {
  let forwarded = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    forwarded++;
    if (forwarded === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(usageSse({ input_tokens: 360000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 }));
    }
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'request_too_large',
        message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
      },
    }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_TRIGGER: '369000' });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  const response = await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders);
  assert.equal(response.status, 413);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.type, 'error');
  assert.equal(parsed.error.type, 'request_too_large');
  assert.match(parsed.error.message, /366000 tokens > 920000 tokens/);
});

test('a genuine overflow lowers only the model that received it', async (t) => {
  const overflowBody = JSON.stringify({
    type: 'error',
    error: {
      type: 'request_too_large',
      message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
    },
  });
  let forwarded = 0;
  let astraRequests = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwarded++;
      const { model } = JSON.parse(Buffer.concat(chunks).toString());
      if (model === 'gpt-5.6-sol' && forwarded === 2) {
        res.writeHead(413, { 'content-type': 'application/json' });
        return res.end(overflowBody);
      }
      const inputTokens = model === 'gpt-6-astra' && ++astraRequests === 1 ? 10 : 100000;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(usageSse({ input_tokens: inputTokens }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort);
  const astraBody = JSON.stringify({
    model: 'claude-gpt-6-astra',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  });

  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', codexBody, sentrySessionHeaders)).status, 413);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', astraBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', astraBody, sentrySessionHeaders)).status, 200);
  assert.equal((await request(shimPort, 'POST', '/v1/messages', astraBody, sentrySessionHeaders)).status, 200);
  assert.equal(forwarded, 5);
});

test('retries transient Codex WebSocket upgrade rejections before returning the response', async (t) => {
  let forwarded = 0;
  const rejection = JSON.stringify({
    type: 'error',
    error: { type: 'permission_error', message: 'WebSocket upgrade was rejected' },
  });
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    forwarded++;
    if (forwarded < 3) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(rejection);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-5.6-sol', ok: true }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, {
    CODEX_GATEWAY_WS_UPGRADE_RETRIES: '2',
    CODEX_GATEWAY_WS_UPGRADE_RETRY_DELAY_MS: '1',
  });

  const response = await request(shimPort, 'POST', '/v1/messages', codexBody);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).model, 'claude-gpt-5.6-sol');
  assert.equal(forwarded, 3);
});

test('exhausted Codex WebSocket upgrade retries become a transient gateway error', async (t) => {
  let forwarded = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    forwarded++;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'WebSocket upgrade was rejected' },
    }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort, {
    CODEX_GATEWAY_WS_UPGRADE_RETRIES: '1',
    CODEX_GATEWAY_WS_UPGRADE_RETRY_DELAY_MS: '1',
  });

  const response = await request(shimPort, 'POST', '/v1/messages', codexBody);
  const error = JSON.parse(response.body).error;
  assert.equal(response.status, 503);
  assert.equal(error.type, 'api_error');
  assert.match(error.message, /temporarily rejected after 2 attempts/);
  assert.doesNotMatch(error.message, /login|permission/i);
  assert.equal(forwarded, 2);
});

test('an old-proxy context error is normalized to HTTP 413 request_too_large', async (t) => {
  // claude-code-proxy <=0.1.13 signalled overflow with a 5xx of its own shape; the
  // shim must normalize that to the same 413 request_too_large the new proxy emits.
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model.' } }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'oversized' }],
  }));
  assert.equal(response.status, 413);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.type, 'error');
  assert.equal(parsed.error.type, 'request_too_large');
});

test('an upstream 413 with parseable token counts passes through untouched', async (t) => {
  const upstreamBody = JSON.stringify({
    type: 'error',
    error: { type: 'request_too_large', message: 'input is too large (935012 tokens > 920000 tokens)' },
  });
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'oversized' }],
  }));
  assert.equal(response.status, 413);
  assert.equal(response.body, upstreamBody);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.type, 'request_too_large');
});

test('Codex responses strip hallucinated plan-mode tools from JSON and SSE', async (t) => {
  let useSse = false;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    if (!useSse) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        model: 'gpt-5.6-sol',
        type: 'message',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'keep' },
          { type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: {} },
        ],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'm1', model: 'gpt-5.6-sol' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'keep' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'plan', name: 'EnterPlanMode', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'bash', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const payload = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      .replace('keep', 'keep 🎵');
    const encoded = Buffer.from(payload);
    const split = encoded.indexOf(Buffer.from('🎵')) + 2;
    res.write(encoded.subarray(0, split));
    res.end(encoded.subarray(split));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const body = JSON.stringify({ model: 'claude-gpt-5.6-sol', max_tokens: 1, messages: [] });
  const jsonResponse = await request(shimPort, 'POST', '/v1/messages', body);
  const json = JSON.parse(jsonResponse.body);
  assert.equal(json.model, 'claude-gpt-5.6-sol');
  assert.deepEqual(json.content, [{ type: 'text', text: 'keep' }]);
  assert.equal(json.stop_reason, 'end_turn');

  useSse = true;
  const sseResponse = await request(shimPort, 'POST', '/v1/messages', body, { accept: 'text/event-stream' });
  assert.equal(sseResponse.body.includes('EnterPlanMode'), false);
  assert.equal(sseResponse.body.includes('keep 🎵'), true);
  assert.equal(sseResponse.body.includes('"name":"Bash"'), true);
  const data = sseResponse.body.split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const start = data.find((event) => event.type === 'message_start');
  assert.equal(start.message.model, 'claude-gpt-5.6-sol');
  const bashStart = data.find((event) => event.type === 'content_block_start' && event.content_block?.name === 'Bash');
  assert.equal(bashStart.index, 1);
  assert.equal(data.find((event) => event.type === 'content_block_delta' && event.delta?.partial_json)?.index, 1);
});

test('SessionStart cleanup migrates an already-wired install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
      USER_SETTING: 'keep-me',
    },
  }));
  const gatewayCache = path.join(claudeDir, 'cache', 'gateway-models.json');
  fs.writeFileSync(gatewayCache, JSON.stringify({
    baseUrl: 'http://127.0.0.1:18764',
    models: [{ id: 'claude-gpt-5.6-sol[1m]' }],
  }));

  spawnSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18764');
  assert.equal(settings.env.USER_SETTING, 'keep-me');
  const migratedCache = JSON.parse(fs.readFileSync(gatewayCache, 'utf8'));
  assert.equal(migratedCache.baseUrl, 'http://127.0.0.1:18764');
  assert.equal(migratedCache.models[0].id, 'claude-gpt-5.6-sol');
});

test('SessionStart cleanup leaves unrelated gateway caches alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-other-cache-'));
  const cacheDir = path.join(home, '.claude', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const gatewayCache = path.join(cacheDir, 'gateway-models.json');
  const original = JSON.stringify({
    baseUrl: 'http://other-gateway.example',
    models: [null, { id: 'claude-gpt-5.6-sol[1m]' }],
  });
  fs.writeFileSync(gatewayCache, original);

  spawnSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  assert.equal(fs.readFileSync(gatewayCache, 'utf8'), original);
});

test('env wiring preserves Claude 1M aliases and removes the unsafe global threshold', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-env-'));
  // Isolated home plus an unrunnable probe: wiring writes pin state under
  // ~/.claude, and the assertions below are about the shipped defaults, not
  // whatever a locally installed Claude CLI happens to report.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-env-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_CLAUDE_BIN: missingClaude(home) };
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
      USER_SETTING: 'keep-me',
    },
  }));

  const result = spawnSync(process.execPath, [CLI, 'env', '--write-user'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5[1m]');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  // Fable is a 1M Claude model too; pin it so a gateway session gets its full
  // window instead of Claude Code's 200k gateway default.
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1[1m]');
  assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000');
  assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'true');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18764');
  assert.equal(legacy.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(legacy.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(legacy.env.USER_SETTING, 'keep-me');

  const removed = spawnSync(process.execPath, [CLI, 'env', '--write-user', '--remove'], { cwd, env, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.env?.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.equal(after.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(after.env?.ENABLE_TOOL_SEARCH, undefined);
  assert.equal(legacy.env?.USER_SETTING, 'keep-me');
});

// Pin detection shells out to whatever `claude` is on PATH, so any test that
// asserts on detected pins has to bring its own. Machines with the real CLI
// installed and CI runners without one otherwise disagree about whether a
// detection cache exists at all.
function installFakeClaude(home) {
  const bin = path.join(home, 'bin');
  const fake = path.join(bin, 'fake-claude.js');
  const command = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(fake, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }",
    "const alias = args[args.indexOf('--model') + 1];",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const attemptFile = process.env.FAKE_CLAUDE_ATTEMPT_FILE;",
    "  const attempts = attemptFile && fs.existsSync(attemptFile) ? JSON.parse(fs.readFileSync(attemptFile, 'utf8')) : {};",
    "  const attempt = (attempts[alias] || 0) + 1;",
    "  if (attemptFile) { attempts[alias] = attempt; fs.writeFileSync(attemptFile, JSON.stringify(attempts)); }",
    "  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input, baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, proxies: { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY }, trafficControls: { nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, autoUpdater: process.env.DISABLE_AUTOUPDATER, telemetry: process.env.DISABLE_TELEMETRY, errorReporting: process.env.DISABLE_ERROR_REPORTING } }) + '\\n');",
    "  if (alias === 'fable' && attempt <= Number(process.env.FAKE_CLAUDE_FABLE_FAILURES || 0)) return;",
    "  const printInit = () => console.log(JSON.stringify({ type: 'system', subtype: 'init', model: process.env[`FAKE_CLAUDE_${alias.toUpperCase()}`] || `claude-${alias}-9` }));",
    "  if (process.env.FAKE_CLAUDE_EGRESS === '1' && process.env.HTTPS_PROXY) {",
    "    const proxy = new URL(process.env.HTTPS_PROXY);",
    "    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));",
    "    const socket = net.connect(port, proxy.hostname, () => {",
    "      socket.end('CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n');",
    "      printInit();",
    "    });",
    "    socket.once('error', printInit);",
    "    return;",
    "  }",
    "  printInit();",
    "});",
  ].join('\n'));
  if (process.platform === 'win32') fs.writeFileSync(command, `@"${process.execPath}" "${fake}" %*\r\n`);
  else {
    fs.writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(command, 0o755);
  }
  return { bin, command, logFile: path.join(home, 'probes.jsonl') };
}

// A path that no probe can ever execute, for tests that want the shipped
// defaults regardless of what the host machine has installed.
function missingClaude(home) {
  return path.join(home, 'bin', 'claude-not-installed');
}

function runPinRefreshes(env) {
  const script = [
    `const fs = require('node:fs');`,
    `const { PIN_CACHE_PATH } = require(${JSON.stringify(RUNTIME)});`,
    `const { detectedPinDefaults, refreshDetectedPins } = require(${JSON.stringify(PINS)});`,
    '(async () => {',
    '  await refreshDetectedPins({ force: true });',
    '  console.log(JSON.stringify({ cache: JSON.parse(fs.readFileSync(PIN_CACHE_PATH, \'utf8\')), defaults: detectedPinDefaults() }));',
    '  await refreshDetectedPins();',
    '  console.log(JSON.stringify({ cache: JSON.parse(fs.readFileSync(PIN_CACHE_PATH, \'utf8\')), defaults: detectedPinDefaults() }));',
    '})().catch((error) => { console.error(error.stack); process.exitCode = 1; });',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}

test('a failed alias does not carry a stale pin into a new Claude CLI version', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-pin-home-'));
  const claude = installFakeClaude(home);
  const cachePath = path.join(home, '.claude', 'model-gateway', 'detected-pins.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    cliVersion: 'fake-claude 0.9.0',
    updatedAt: Date.now(),
    pins: {
      opus: 'claude-opus-8[1m]',
      sonnet: 'claude-sonnet-8[1m]',
      fable: 'claude-fable-8[1m]',
    },
  }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    FAKE_CLAUDE_ATTEMPT_FILE: path.join(home, 'attempts.json'),
    FAKE_CLAUDE_FABLE_FAILURES: '2',
    FAKE_CLAUDE_LOG: claude.logFile,
    CODEX_GATEWAY_PIN_PROBE_TIMEOUT_MS: '30000',
    CODEX_GATEWAY_CLAUDE_BIN: claude.command,
  };
  try {
    const [afterFailedProbe, afterStaleRetry] = runPinRefreshes(env);
    assert.equal(afterFailedProbe.cache.cliVersion, 'fake-claude 1.0.0');
    assert.equal(afterFailedProbe.cache.pins.fable, 'claude-fable-8[1m]');
    assert.equal(afterFailedProbe.cache.detectedFor.fable, 'fake-claude 0.9.0');
    assert.equal(afterFailedProbe.defaults.fable, 'claude-fable-5-1[1m]');
    assert.equal(afterStaleRetry.cache.pins.fable, 'claude-fable-9[1m]');
    assert.equal(afterStaleRetry.cache.detectedFor.fable, 'fake-claude 1.0.0');
    const aliases = fs.readFileSync(claude.logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).args[3]);
    assert.deepEqual([...aliases].sort(), ['fable', 'fable', 'fable', 'opus', 'sonnet'], `aliases probe in parallel, so only the multiset is stable: ${aliases.join(',')}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function probeClaudeAliasWithEnvironment(alias, endpoint, environment) {
  const script = `const { probeClaudeAlias } = require(${JSON.stringify(PINS)}); probeClaudeAlias(${JSON.stringify(alias)}, ${JSON.stringify(endpoint)}).then((pin) => console.log(JSON.stringify({ pin })));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function probeRealClaudeFable(endpoint, environment) {
  return probeClaudeAliasWithEnvironment('fable', endpoint, {
    ...environment,
    CODEX_GATEWAY_CLAUDE_BIN: 'claude',
  });
}

function fakeProbeEnvironment(home, claude, proxyUrl) {
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    FAKE_CLAUDE_LOG: claude.logFile,
    CODEX_GATEWAY_CLAUDE_BIN: claude.command,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
  };
  delete environment.NO_PROXY;
  delete environment.no_proxy;
  return environment;
}

test('the local Fable probe keeps proxy observation active for the installed Claude CLI', async (t) => {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !version.stdout.trim()) return t.skip('claude --version is unavailable');
  const proxy = await startCountingProxy(t);
  const localRequests = [];
  const server = http.createServer((request, response) => {
    localRequests.push({ localAddress: request.socket.localAddress, remoteAddress: request.socket.remoteAddress });
    response.writeHead(request.method === 'HEAD' ? 204 : 404);
    response.end();
  });
  const port = await listen(server);
  const environment = {
    ...process.env,
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
  };
  delete environment.NO_PROXY;
  delete environment.no_proxy;
  try {
    const result = await probeRealClaudeFable(`http://127.0.0.1:${port}`, environment);
    const versionText = version.stdout.trim();
    assert.equal(result.status, 0, `Claude ${versionText}; status=${result.status}; proxy connections=${proxy.connectionCount()}; proxy targets=${proxy.targets().join(',') || '(none)'}; local requests=${localRequests.length}; stderr=${result.stderr}`);
    const { pin } = JSON.parse(result.stdout);
    const localSocketRequests = localRequests.filter(({ localAddress }) => localAddress === '127.0.0.1');
    const proxyTargets = proxy.targets();
    const observation = `Claude ${versionText}; init model=${pin}; proxy connections=${proxy.connectionCount()}; proxy targets=${proxyTargets.join(',') || '(none)'}; local requests=${localRequests.length}; local socket requests=${localSocketRequests.length}`;
    assert.equal(pin, 'claude-fable-5-1[1m]', observation);
    assert.deepEqual(proxyTargets, [], observation);
    assert.equal(proxy.connectionCount(), 0, observation);
    assert.equal(localSocketRequests.length, localRequests.length, observation);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the proxy observer sees no egress from a fake Claude probe', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-pin-home-'));
  const claude = installFakeClaude(home);
  const proxy = await startCountingProxy(t);
  const environment = fakeProbeEnvironment(home, claude, proxy.url);
  delete environment.FAKE_CLAUDE_EGRESS;
  try {
    const result = await probeClaudeAliasWithEnvironment('fable', 'http://127.0.0.1:1', environment);
    assert.equal(result.status, 0, result.stderr);
    const { pin } = JSON.parse(result.stdout);
    const observation = `fake init model=${pin}; proxy connections=${proxy.connectionCount()}; proxy targets=${proxy.targets().join(',') || '(none)'}`;
    assert.equal(pin, 'claude-fable-9[1m]', observation);
    assert.deepEqual(proxy.targets(), [], observation);
    assert.equal(proxy.connectionCount(), 0, observation);
    const [{ trafficControls }] = fs.readFileSync(claude.logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(trafficControls, {
      nonessential: '1',
      autoUpdater: '1',
      telemetry: '1',
      errorReporting: '1',
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the proxy observer catches fake Claude egress', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-pin-home-'));
  const claude = installFakeClaude(home);
  const proxy = await startCountingProxy(t);
  const environment = { ...fakeProbeEnvironment(home, claude, proxy.url), FAKE_CLAUDE_EGRESS: '1' };
  try {
    const result = await probeClaudeAliasWithEnvironment('fable', 'http://127.0.0.1:1', environment);
    assert.equal(result.status, 0, result.stderr);
    const { pin } = JSON.parse(result.stdout);
    const observation = `fake init model=${pin}; proxy connections=${proxy.connectionCount()}; proxy targets=${proxy.targets().join(',') || '(none)'}`;
    assert.equal(pin, 'claude-fable-9[1m]', observation);
    assert.deepEqual(proxy.targets(), ['api.anthropic.com:443'], observation);
    assert.equal(proxy.connectionCount(), 1, observation);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Claude pin overrides persist outside the plugin and are applied by rewiring', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-pins-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-pins-project-'));
  const claude = installFakeClaude(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    FAKE_CLAUDE_LOG: claude.logFile,
    CODEX_GATEWAY_CLAUDE_BIN: claude.command,
  };
  try {
    const set = spawnSync(process.execPath, [CLI, 'pin', '--opus', 'claude-opus-4-8[1m]'], { env, encoding: 'utf8' });
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'pins.json'), 'utf8')), {
      opus: 'claude-opus-4-8[1m]',
    });

    const wired = spawnSync(process.execPath, [CLI, 'env', '--write-user'], { cwd, env, encoding: 'utf8' });
    assert.equal(wired.status, 0, wired.stderr);
    const settingsFile = path.join(home, '.claude', 'settings.json');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8[1m]');

    const pins = spawnSync(process.execPath, [CLI, 'pin'], { env, encoding: 'utf8' });
    assert.equal(pins.status, 0, pins.stderr);
    assert.match(pins.stdout, /opus: claude-opus-4-8\[1m\] \(overridden; shipped default: claude-opus-9\[1m\]\)/);

    const cleared = spawnSync(process.execPath, [CLI, 'pin', '--opus', 'default'], { env, encoding: 'utf8' });
    assert.equal(cleared.status, 0, cleared.stderr);
    const rewired = spawnSync(process.execPath, [CLI, 'env', '--write-user'], { cwd, env, encoding: 'utf8' });
    assert.equal(rewired.status, 0, rewired.stderr);
    const detected = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'detected-pins.json'), 'utf8'));
    assert.equal(detected.pins.opus, 'claude-opus-9[1m]');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.ANTHROPIC_DEFAULT_OPUS_MODEL, detected.pins.opus);

    const invalid = spawnSync(process.execPath, [CLI, 'pin', '--opus', 'bad;value'], { env, encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /invalid opus pin/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('rewiring without a Claude CLI wires the shipped pins and caches no detection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-nocli-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-nocli-project-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_CLAUDE_BIN: missingClaude(home) };
  try {
    const wired = spawnSync(process.execPath, [CLI, 'env', '--write-user'], { cwd, env, encoding: 'utf8' });
    assert.equal(wired.status, 0, wired.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env;
    assert.equal(settings.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5[1m]');
    assert.equal(settings.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
    assert.equal(settings.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1[1m]');
    assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'detected-pins.json')), false);

    const override = spawnSync(process.execPath, [CLI, 'pin', '--opus', 'claude-opus-4-8[1m]'], { env, encoding: 'utf8' });
    assert.equal(override.status, 0, override.stderr);
    const rewired = spawnSync(process.execPath, [CLI, 'env', '--write-user'], { cwd, env, encoding: 'utf8' });
    assert.equal(rewired.status, 0, rewired.stderr);
    const afterOverride = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env;
    assert.equal(afterOverride.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8[1m]');
    assert.equal(afterOverride.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('credential-free alias probes cache valid 1M defaults without replacing overrides', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-project-'));
  const { bin, command, logFile } = installFakeClaude(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    Path: `${bin}${path.delimiter}${process.env.Path || process.env.PATH}`,
    FAKE_CLAUDE_LOG: logFile,
    CODEX_GATEWAY_CLAUDE_BIN: command,
    ANTHROPIC_API_KEY: 'must-not-reach-probe',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-reach-probe',
  };
  try {
    const override = spawnSync(process.execPath, [CLI, 'pin', '--opus', 'claude-opus-4-8[1m]'], { cwd, env, encoding: 'utf8' });
    assert.equal(override.status, 0, override.stderr);
    const wired = spawnSync(process.execPath, [CLI, 'env', '--write-user'], { cwd, env, encoding: 'utf8' });
    assert.equal(wired.status, 0, wired.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env;
    assert.equal(settings.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8[1m]');
    assert.equal(settings.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-9[1m]');
    assert.equal(settings.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-9[1m]');
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'detected-pins.json'), 'utf8'));
    assert.equal(cache.pins.opus, 'claude-opus-9[1m]');
    assert.equal(cache.pins.fable, 'claude-fable-9[1m]');
    const probes = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(probes.length, 3);
    for (const probe of probes) {
      assert.deepEqual(probe.args.slice(0, 8), ['--bare', '--no-session-persistence', '--model', probe.args[3], '-p', '--output-format', 'stream-json', '--verbose']);
      assert.equal(probe.input, `/model ${probe.args[3]}\n`);
      assert.match(probe.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(probe.apiKey, undefined);
      assert.equal(probe.oauth, undefined);
    }

    const mismatched = spawnSync(process.execPath, [CLI, 'env', '--write-user'], {
      cwd,
      env: { ...env, FAKE_CLAUDE_FABLE: 'claude-sonnet-99' },
      encoding: 'utf8',
    });
    assert.equal(mismatched.status, 0, mismatched.stderr);
    const afterMismatch = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env;
    assert.equal(afterMismatch.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-9[1m]');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor describes project-local wiring as the default', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-doctor-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-doctor-project-'));
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  try {
    const result = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd,
      env: { ...environment, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    assert.match(result.stdout, /wiring: effective none/);
    assert.match(result.stdout, /default wiring target: this project's \.claude\/settings\.local\.json/);
    assert.match(result.stdout, /Claude opus pin: claude-opus-5\[1m\] \(default\)/);
    assert.match(result.stdout, /project settings\.local\.json: not wired .*\[default write target\]/);
    assert.doesNotMatch(result.stdout, /wiring mode: local/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('env with no scope flag explains project wiring and writes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wiring-mode-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wiring-project-'));
  try {
    const shown = spawnSync(process.execPath, [CLI, 'env'], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Project wiring is the default/);
    assert.match(shown.stdout, /env --write-project/);
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), false);

    const retired = spawnSync(process.execPath, [CLI, 'env', '--mode', 'global'], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    assert.equal(retired.status, 2);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'wiring.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('SessionStart nudges hand off gateway actions to the runnable skill', () => {
  const source = fs.readFileSync(COMMANDS, 'utf8');
  assert.match(source, /Run \/model-gateway:model-gateway, then use its env --write-project command/);
  assert.match(source, /claude-code-proxy is missing[\s\S]*No Anthropic fallback was used\./);
  assert.doesNotMatch(source, /(?:Run|run):? env --/);
});

test('claude-* passthrough is byte-identical and never subjected to Codex window/error rewriting', async (t) => {
  // The Anthropic path returns a context-overflow-shaped 400. A claude model must
  // see it UNCHANGED (no 413 normalization, no 'prompt is too long' rewrite) and
  // the body forwarded upstream must be the exact bytes the client sent (prompt
  // caching keys on them).
  const overflowBody = JSON.stringify({ error: { message: 'input exceeds the context window of this model' } });
  let forwardedRaw;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedRaw = Buffer.concat(chunks).toString();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(overflowBody);
    });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: '0',
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const sent = JSON.stringify({
    model: 'claude-opus-4-8[1m]',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'huge history' }],
  });
  const response = await request(shimPort, 'POST', '/v1/messages', sent);
  // forwarded bytes untouched (including the [1m] suffix on a real Claude model)
  assert.equal(forwardedRaw, sent);
  // upstream error passed through verbatim: not rewritten to 413 request_too_large
  // and not rewritten to the old 400 'prompt is too long'
  assert.equal(response.status, 400);
  assert.equal(response.body, overflowBody);
});

test('count_tokens for a Codex model still routes to the proxy', async (t) => {
  let countTokensPath;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      countTokensPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 42 }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages/count_tokens', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    messages: [{ role: 'user', content: 'count me' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(countTokensPath, '/v1/messages/count_tokens');
  assert.equal(JSON.parse(response.body).input_tokens, 42);
});

test('Codex SSE sends heartbeat comments while upstream is silent', async (t) => {
  const firstEvent = 'event: message\ndata: {"type":"message_start"}\n\n';
  const secondEvent = 'event: message\ndata: {"type":"message_stop"}\n\n';
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(firstEvent);
    setTimeout(() => res.end(secondEvent), 75);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SSE_HEARTBEAT_S: '0.02',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await requestStream(shimPort, JSON.stringify({
    model: 'claude-gpt-5.6-terra',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'stream' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.replace(/: ping\n\n/g, ''), firstEvent + secondEvent);
  assert.match(response.body, /: ping\n\n/);
});

test('proxy version floor uses a numeric semver compare, not a string compare', () => {
  const gw = require(CLI);
  assert.equal(gw.MIN_PROXY_VERSION, '0.1.14');
  const floor = gw.parseSemver(gw.MIN_PROXY_VERSION);
  // string compare would read '0.1.9' as >= '0.1.14'; numeric must read it as older
  assert.equal(gw.semverLt(gw.parseSemver('0.1.9'), floor), true);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.13'), floor), true);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.14'), floor), false);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.15'), floor), false);
  assert.equal(gw.semverLt(gw.parseSemver('v0.2.0'), floor), false);
  assert.equal(gw.parseSemver('not a version'), null);
});
