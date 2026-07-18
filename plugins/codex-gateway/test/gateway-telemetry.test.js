'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function waitForShim(port) {
  await waitFor(async () => {
    try {
      return (await request(port, 'GET', '/healthz')).status === 200;
    } catch {
      return false;
    }
  }, 'shim did not start');
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function spawnShim(t, proxyPort, extraEnv = {}) {
  const shimPort = await unusedPort();
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);
  return shimPort;
}

function modelProxy(onRequest) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => onRequest(req, Buffer.concat(chunks), res));
  });
}

async function telemetryCollector(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200);
      res.end();
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { received, endpoint: `http://127.0.0.1:${port}/v1/traces` };
}

function attributeMap(attributes) {
  return Object.fromEntries(attributes.map(({ key, value }) => {
    if (Object.hasOwn(value, 'stringValue')) return [key, value.stringValue];
    if (Object.hasOwn(value, 'boolValue')) return [key, value.boolValue];
    if (Object.hasOwn(value, 'intValue')) return [key, Number(value.intValue)];
    return [key, value.doubleValue];
  }));
}

function spanFrom(received) {
  return JSON.parse(received.body).resourceSpans[0].scopeSpans[0].spans[0];
}

const linkedTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const directBody = JSON.stringify({
  model: 'claude-codex-gpt-5.6-sol',
  max_tokens: 1,
  output_config: { effort: 'high' },
  messages: [{ role: 'user', content: 'prompt-secret-must-not-enter-telemetry' }],
  tools: [{ name: 'PrivateTool', description: 'tool-secret-must-not-enter-telemetry' }],
});

test('emits a linked metadata-only route span and strips trace and auth before Codex', async (t) => {
  let upstream;
  const proxy = modelProxy((req, body, res) => {
    upstream = { headers: req.headers, body: body.toString() };
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const collector = await telemetryCollector(t);
  const routeLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-telemetry-'));
  const routeLog = path.join(routeLogDir, 'routes.jsonl');
  t.after(() => fs.rmSync(routeLogDir, { recursive: true, force: true }));
  const shimPort = await spawnShim(t, proxyPort, {
    CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: collector.endpoint,
    CODEX_GATEWAY_REQUEST_LOG: '1',
    CODEX_GATEWAY_REQUEST_LOG_PATH: routeLog,
  });

  const response = await request(shimPort, 'POST', '/v1/messages', directBody, {
    traceparent: linkedTraceparent,
    tracestate: 'private-vendor=trace-secret',
    baggage: 'private-key=baggage-secret',
    authorization: 'Bearer auth-secret',
    'proxy-authorization': 'Basic proxy-auth-secret',
    'x-api-key': 'api-key-secret',
    cookie: 'session=credential-secret',
    'x-private-header': 'arbitrary-header-secret',
    'x-claude-code-session-id': 'session-telemetry-1',
  });
  assert.equal(response.status, 201);
  assert.ok(upstream);
  for (const header of ['traceparent', 'tracestate', 'baggage', 'authorization', 'proxy-authorization', 'x-api-key', 'cookie']) {
    assert.equal(upstream.headers[header], undefined, `${header} reached the Codex proxy`);
  }

  const received = await waitFor(() => collector.received[0], 'route telemetry was not received');
  const span = spanFrom(received);
  const attributes = attributeMap(span.attributes);
  assert.equal(span.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(span.parentSpanId, '00f067aa0ba902b7');
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(span.spanId, span.parentSpanId);
  assert.equal(attributes.trace_linked, true);
  assert.equal(attributes.session_id, 'session-telemetry-1');
  assert.equal(attributes.selected_model, 'claude-codex-gpt-5.6-sol');
  assert.equal(attributes.effective_model, 'gpt-5.6-sol');
  assert.equal(attributes.backend, 'codex');
  assert.equal(attributes.effort, 'high');
  assert.equal(attributes.fallback, false);
  assert.equal(attributes.via, 'direct');
  assert.equal(attributes.status, 'ok');
  assert.equal(attributes.status_code, 201);
  assert.ok(attributes.duration_ms >= 0);
  assert.match(attributes.route_id, /^[0-9a-f-]{36}$/);
  assert.equal(attributes.source_event_id, attributes.route_id);
  assert.deepEqual(attributeMap(span.events[0].attributes), attributes);

  const emitted = received.body;
  for (const forbidden of [
    'prompt-secret-must-not-enter-telemetry',
    'tool-secret-must-not-enter-telemetry',
    'auth-secret',
    'proxy-auth-secret',
    'api-key-secret',
    'credential-secret',
    'trace-secret',
    'baggage-secret',
    'arbitrary-header-secret',
    'x-private-header',
  ]) assert.equal(emitted.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  for (const header of ['authorization', 'proxy-authorization', 'x-api-key', 'cookie']) {
    assert.equal(received.headers[header], undefined, `telemetry transport copied ${header}`);
  }

  const logText = fs.readFileSync(routeLog, 'utf8');
  const routeEntry = JSON.parse(logText.trim());
  assert.deepEqual(routeEntry, {
    at: routeEntry.at,
    backend: 'codex',
    model: 'gpt-5.6-sol',
    path: '/v1/messages',
    effort: 'high',
    sessionId: 'session-telemetry-1',
  });
  assert.match(routeEntry.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(logText.includes('secret'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(routeLog).mode & 0o777, 0o600);
});

test('reports dispatch and cached-route truth while invalid trace context stays unlinked', async (t) => {
  const models = [];
  const proxy = modelProxy((req, body, res) => {
    models.push(JSON.parse(body.toString()).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const collector = await telemetryCollector(t);
  const shimPort = await spawnShim(t, proxyPort, {
    CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: collector.endpoint,
  });
  const sessionHeaders = {
    'x-claude-code-session-id': 'dispatch-session',
    traceparent: '00-invalid-trace-context',
  };

  const dispatched = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=xhigh]' }],
  }), sessionHeaders);
  assert.equal(dispatched.status, 200);
  const cached = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: 'continued turn without marker' }],
  }), sessionHeaders);
  assert.equal(cached.status, 200);

  await waitFor(() => collector.received.length === 2, 'dispatch route telemetry was incomplete');
  const first = spanFrom(collector.received[0]);
  const second = spanFrom(collector.received[1]);
  const firstAttributes = attributeMap(first.attributes);
  const secondAttributes = attributeMap(second.attributes);
  assert.deepEqual(models, ['gpt-5.6-terra', 'gpt-5.6-terra']);
  assert.equal(first.parentSpanId, undefined);
  assert.equal(firstAttributes.trace_linked, false);
  assert.match(first.traceId, /^[0-9a-f]{32}$/);
  assert.equal(firstAttributes.selected_model, 'claude-codex-auto');
  assert.equal(firstAttributes.effective_model, 'gpt-5.6-terra');
  assert.equal(firstAttributes.effort, 'xhigh');
  assert.equal(firstAttributes.via, 'dispatch');
  assert.equal(firstAttributes.fallback, false);
  assert.equal(secondAttributes.effective_model, 'gpt-5.6-terra');
  assert.equal(secondAttributes.effort, 'xhigh');
  assert.equal(secondAttributes.via, 'dispatch-cached');
  assert.equal(secondAttributes.fallback, false);
});

test('telemetry transport failure cannot change the routed response', async (t) => {
  let routed = 0;
  const proxy = modelProxy((req, body, res) => {
    routed++;
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const unavailableCollectorPort = await unusedPort();
  const shimPort = await spawnShim(t, proxyPort, {
    CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: `http://127.0.0.1:${unavailableCollectorPort}/v1/traces`,
  });

  const response = await request(shimPort, 'POST', '/v1/messages', directBody, {
    traceparent: linkedTraceparent,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.body), { accepted: true });
  assert.equal(routed, 1);
});

test('Anthropic passthrough consumes trace context but keeps its required credential', async (t) => {
  let upstreamHeaders;
  const anthropic = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());
  const proxy = modelProxy((req, body, res) => {
    res.writeHead(500);
    res.end();
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const collector = await telemetryCollector(t);
  const shimPort = await spawnShim(t, proxyPort, {
    CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: collector.endpoint,
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
  });

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'passthrough' }],
  }), {
    traceparent: linkedTraceparent,
    tracestate: 'vendor=private',
    baggage: 'private=value',
    authorization: 'Bearer anthropic-credential',
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamHeaders.traceparent, undefined);
  assert.equal(upstreamHeaders.tracestate, undefined);
  assert.equal(upstreamHeaders.baggage, undefined);
  assert.equal(upstreamHeaders.authorization, 'Bearer anthropic-credential');

  const received = await waitFor(() => collector.received[0], 'Anthropic route telemetry was not received');
  const attributes = attributeMap(spanFrom(received).attributes);
  assert.equal(attributes.backend, 'anthropic');
  assert.equal(attributes.selected_model, 'claude-sonnet-5');
  assert.equal(attributes.effective_model, 'claude-sonnet-5');
  assert.equal(received.body.includes('anthropic-credential'), false);
  assert.equal(received.body.includes('vendor=private'), false);
});
