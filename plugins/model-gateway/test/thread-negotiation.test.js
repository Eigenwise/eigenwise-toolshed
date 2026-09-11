'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const THREAD_REFUSAL = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'capability_rejected: beta_header:message-threads-2026-08-12; model-gateway Codex and Grok backends hold no conversation state. Resend this turn with the full message history.',
    details: { error_code: 'thread_unsupported_request' },
  },
};
const THREAD_REFUSAL_BODY = JSON.stringify(THREAD_REFUSAL);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const requestHeaders = body == null ? {} : {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    const clientRequest = http.request({
      host: '127.0.0.1',
      port,
      method: body == null ? 'GET' : 'POST',
      path: pathname,
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    clientRequest.once('error', reject);
    clientRequest.end(body);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('shim did not become healthy');
}

async function startGatewayFixture(testContext, { anthropic = false } = {}) {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const codexBodies = [];
  const proxy = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
        return;
      }
      codexBodies.push(Buffer.concat(chunks));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));

  const anthropicBodies = [];
  let anthropicPort;
  if (anthropic) {
    const anthropicServer = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        anthropicBodies.push(Buffer.concat(chunks));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ type: 'message', model: 'claude-opus-5', content: [] }));
      });
    });
    anthropicPort = await new Promise((resolve) => anthropicServer.listen(0, '127.0.0.1', () => resolve(anthropicServer.address().port)));
    testContext.after(() => new Promise((resolve) => anthropicServer.close(resolve)));
  }

  spawnGatewayProcess(testContext, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: anthropicPort ? `http://127.0.0.1:${anthropicPort}` : 'http://127.0.0.1:9',
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  await waitForHealth(shimPort);
  return { shimPort, codexBodies, anthropicBodies };
}

function codexPayload(thread) {
  const payload = {
    model: 'claude-gpt-5.6-terra',
    messages: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'current turn' },
    ],
  };
  if (arguments.length) payload.thread = thread;
  return payload;
}

function assertThreadRefusal(response) {
  assert.equal(response.status, 400);
  assert.equal(response.headers['content-type'], 'application/json');
  assert.equal(response.body.toString(), THREAD_REFUSAL_BODY);
  const refusal = JSON.parse(response.body);
  assert.equal(refusal.error.details.error_code, 'thread_unsupported_request');
  assert.match(refusal.error.message, /capability_rejected: beta_header:message-threads-2026-08-12[^A-Za-z0-9_:.-]/);
}

test('Codex continuation receives the client-compatible local refusal without forwarding', async (testContext) => {
  const fixture = await startGatewayFixture(testContext);
  const response = await request(fixture.shimPort, '/v1/messages', JSON.stringify({
    ...codexPayload({ type: 'continue', previous_message_id: 'message_123' }),
    stream: true,
  }));

  assertThreadRefusal(response);
  assert.equal(fixture.codexBodies.length, 0);
});

for (const [description, thread] of [
  ['null', null],
  ['string', 'continue'],
  ['array', []],
  ['empty object', {}],
  ['unknown type', { type: 'resume' }],
]) {
  test(`Codex refuses malformed thread ${description} without forwarding`, async (testContext) => {
    const fixture = await startGatewayFixture(testContext);
    const response = await request(fixture.shimPort, '/v1/messages', JSON.stringify(codexPayload(thread)));

    assertThreadRefusal(response);
    assert.equal(fixture.codexBodies.length, 0);
  });
}

test('Codex forwards a self-contained thread creation with its complete history', async (testContext) => {
  const fixture = await startGatewayFixture(testContext);
  const payload = codexPayload({ type: 'create' });
  const response = await request(fixture.shimPort, '/v1/messages', JSON.stringify(payload));

  assert.equal(response.status, 200);
  assert.equal(fixture.codexBodies.length, 1);
  assert.deepEqual(JSON.parse(fixture.codexBodies[0]), {
    ...payload,
    model: 'gpt-5.6-terra',
  });
});

test('Codex forwards requests without a thread unchanged apart from model routing', async (testContext) => {
  const fixture = await startGatewayFixture(testContext);
  const payload = codexPayload();
  const response = await request(fixture.shimPort, '/v1/messages', JSON.stringify(payload));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(fixture.codexBodies[0]), {
    ...payload,
    model: 'gpt-5.6-terra',
  });
});

test('Anthropic passthrough retains continuation bytes unchanged', async (testContext) => {
  const fixture = await startGatewayFixture(testContext, { anthropic: true });
  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'current turn' }],
    thread: { type: 'continue', previous_message_id: 'message_123' },
  }));
  const response = await request(fixture.shimPort, '/v1/messages', body);

  assert.equal(response.status, 200);
  assert.equal(fixture.anthropicBodies.length, 1);
  assert.deepEqual(fixture.anthropicBodies[0], body);
});

test('count_tokens carries thread payloads through the Codex path', async (testContext) => {
  const fixture = await startGatewayFixture(testContext);
  const payload = codexPayload({ type: 'continue', previous_message_id: 'message_123' });
  const response = await request(fixture.shimPort, '/v1/messages/count_tokens', JSON.stringify(payload));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(fixture.codexBodies[0]), {
    ...payload,
    model: 'gpt-5.6-terra',
  });
});

test('Grok continuation refuses before authentication or forwarding', async (testContext) => {
  const fixture = await startGatewayFixture(testContext);
  const response = await request(fixture.shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-grok-4.5',
    messages: [{ role: 'user', content: 'current turn' }],
    thread: { type: 'continue', previous_message_id: 'message_123' },
  }));

  assertThreadRefusal(response);
  assert.equal(fixture.codexBodies.length, 0);
});
