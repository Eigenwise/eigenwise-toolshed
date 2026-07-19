'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inputComposition } = require('../lib/usage-observability.js');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
        elapsedMs: Date.now() - started,
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function proxyServer(onMessage) {
  return http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => onMessage(req, Buffer.concat(chunks), res));
  });
}

async function collector(t, delayMs = 0) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString(), responded: false };
      received.push(entry);
      setTimeout(() => {
        entry.responded = true;
        res.writeHead(200);
        res.end();
      }, delayMs);
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { received, endpoint: `http://127.0.0.1:${port}/v1/logs` };
}

async function spawnShim(t, proxyPort, usageEndpoint) {
  const shimPort = await unusedPort();
  const compatPort = await unusedPort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-usage-integration-'));
  const hostsFile = path.join(directory, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    cwd: directory,
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
      CODEX_GATEWAY_HOSTS_FILE: hostsFile,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_TELEMETRY_ENDPOINT: '0',
      CODEX_GATEWAY_USAGE_ENDPOINT: usageEndpoint,
      CODEX_GATEWAY_SSE_HEARTBEAT_MS: '0',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${shimPort}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  }, 'isolated shim did not start');
  return shimPort;
}

function attributesFrom(received) {
  const record = JSON.parse(received.body).resourceLogs[0].scopeLogs[0].logRecords[0];
  return {
    eventName: record.eventName,
    values: Object.fromEntries(record.attributes.map(({ key, value }) => {
      if (Object.hasOwn(value, 'stringValue')) return [key, value.stringValue];
      if (Object.hasOwn(value, 'intValue')) return [key, Number(value.intValue)];
      if (Object.hasOwn(value, 'boolValue')) return [key, value.boolValue];
      return [key, value.doubleValue];
    })),
  };
}

function dispatchBody(stream = false) {
  return JSON.stringify({
    model: 'claude-codex-auto',
    stream,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: 'private injected system' }],
    tools: [
      { name: 'Read', description: 'private native schema' },
      { name: 'mcp__sidequest__claim', description: 'private MCP schema' },
    ],
    messages: [
      { role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=xhigh] private first prompt' },
      { role: 'assistant', content: 'private history' },
    ],
  });
}

test('isolated JSON proxy emits resolved, exact, counts-only gateway usage', async (t) => {
  let forwarded;
  const rawUsage = {
    input_tokens: 13,
    output_tokens: 8,
    cache_read_input_tokens: 21,
    cache_creation_input_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 4 },
    server_tool_use: { web_search_requests: 1 },
  };
  const proxy = proxyServer((req, body, res) => {
    forwarded = JSON.parse(body.toString());
    res.writeHead(200, {
      'content-type': 'application/json',
      'request-id': 'provider-json-request',
      'anthropic-ratelimit-input-tokens-limit': '1000',
      'anthropic-ratelimit-input-tokens-remaining': '900',
    });
    res.end(JSON.stringify({
      id: 'msg-json',
      model: 'gpt-5.6-terra',
      content: [{ type: 'text', text: 'private upstream response' }],
      usage: rawUsage,
    }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const usageCollector = await collector(t);
  const shimPort = await spawnShim(t, proxyPort, usageCollector.endpoint);

  const response = await request(shimPort, dispatchBody(), {
    'x-claude-code-session-id': 'session-json',
    'x-claude-code-agent-id': 'agent-json',
    'x-claude-code-parent-agent-id': 'parent-json',
    'x-claude-code-request-id': 'client-json-request',
    authorization: 'Bearer private-credential',
    'x-private-header': 'private-header-value',
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).usage.output_tokens, rawUsage.output_tokens);
  const received = await waitFor(() => usageCollector.received[0], 'usage log was not received');
  assert.equal(received.path, '/v1/logs');
  const { eventName, values } = attributesFrom(received);
  assert.equal(eventName, 'gateway.token.usage');
  assert.equal(values.request_id, 'provider-json-request');
  assert.equal(values.client_request_id, 'client-json-request');
  assert.equal(values.session_id, 'session-json');
  assert.equal(values.agent_id, 'agent-json');
  assert.equal(values.parent_agent_id, 'parent-json');
  assert.equal(values.agent_role, 'executor');
  assert.equal(values.model, 'gpt-5.6-terra');
  assert.equal(values.requested_model, 'claude-codex-auto');
  assert.equal(values.backend, 'codex');
  assert.equal(values.effort, 'xhigh');
  assert.equal(values.via, 'dispatch');
  assert.equal(values.input_tokens, rawUsage.input_tokens);
  assert.equal(values.output_tokens, rawUsage.output_tokens);
  assert.equal(values.cache_read_tokens, rawUsage.cache_read_input_tokens);
  assert.equal(values.cache_creation_tokens, rawUsage.cache_creation_input_tokens);
  assert.equal(values.cache_creation_5m_tokens, 2);
  assert.equal(values.cache_creation_1h_tokens, 3);
  assert.equal(values.thinking_tokens, 4);
  assert.equal(values.server_tool_use_count, 1);
  assert.equal(values.context_tokens, 39);
  assert.equal(values.rate_limit_input_tokens_limit, 1000);
  assert.equal(values.rate_limit_input_tokens_remaining, 900);

  const expectedComposition = inputComposition(forwarded, Buffer.byteLength(JSON.stringify(forwarded)));
  for (const [name, value] of Object.entries(expectedComposition)) assert.equal(values[name], value, name);
  assert.equal(values.input_native_tools_tokens + values.input_mcp_tools_tokens, values.input_tools_tokens);

  const emitted = received.body;
  for (const forbidden of [
    'private injected system', 'private native schema', 'private MCP schema', 'private first prompt',
    'private history', 'private upstream response', 'private-credential', 'private-header-value',
    'authorization', 'x-private-header',
  ]) assert.equal(emitted.includes(forbidden), false, `usage log leaked ${forbidden}`);
});

test('isolated SSE usage merges final counts and a slow collector cannot delay inference', async (t) => {
  const proxy = proxyServer((req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'provider-sse-request' });
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg-sse',
        model: 'gpt-5.6-terra',
        usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
      },
    })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'private SSE content' } })}\n\n`);
    res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, reasoning_tokens: 3 } })}\n\n`);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const usageCollector = await collector(t, 750);
  const shimPort = await spawnShim(t, proxyPort, usageCollector.endpoint);

  const response = await request(shimPort, dispatchBody(true), {
    'x-claude-code-session-id': 'session-sse',
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.includes('private SSE content'));

  const received = await waitFor(() => usageCollector.received[0], 'SSE usage log was not received');
  assert.equal(received.responded, false, 'proxied response waited for the telemetry collector response');
  const { eventName, values } = attributesFrom(received);
  assert.equal(eventName, 'gateway.token.usage');
  assert.equal(values.request_id, 'provider-sse-request');
  assert.equal(values.session_id, 'session-sse');
  assert.equal(values.agent_role, 'orchestrator');
  assert.equal(values.response_mode, 'sse');
  assert.equal(values.input_tokens, 5);
  assert.equal(values.cache_read_tokens, 10);
  assert.equal(values.output_tokens, 7);
  assert.equal(values.thinking_tokens, 3);
  assert.ok(values.response_body_bytes > 0);
  assert.equal(received.body.includes('private SSE content'), false);
});

test('isolated throttled proxy emits header-only limit evidence', async (t) => {
  const proxy = proxyServer((req, body, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '4',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '0',
      'x-codex-primary-used-percent': '100%',
    });
    res.end(JSON.stringify({ error: { message: 'private throttle error' } }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const usageCollector = await collector(t);
  const shimPort = await spawnShim(t, proxyPort, usageCollector.endpoint);

  const response = await request(shimPort, dispatchBody(), {
    'x-claude-code-session-id': 'session-limit',
    'x-claude-code-agent-id': 'agent-limit',
  });
  assert.equal(response.status, 429);
  const received = await waitFor(() => usageCollector.received[0], 'limit signal was not received');
  const { eventName, values } = attributesFrom(received);
  assert.equal(eventName, 'gateway.limit.signal');
  assert.equal(values.status, 'throttled');
  assert.equal(values.status_code, 429);
  assert.equal(values.retry_after_ms, 4000);
  assert.equal(values.rate_limit_requests_limit, 50);
  assert.equal(values.rate_limit_requests_remaining, 0);
  assert.equal(values.codex_throttle_used_percent, 100);
  assert.equal(values.input_tokens, undefined);
  assert.equal(received.body.includes('private throttle error'), false);
});
