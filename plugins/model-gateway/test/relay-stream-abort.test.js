'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startGateway } = require('./support.js');

// Long enough that a slow machine does not call a live stream dead, short
// enough that a hang fails this test instead of the suite timeout.
const SETTLE_TIMEOUT_MS = 5000;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The shape SQ-2846's probe hit: SSE headers and one event arrive, then the
// upstream socket dies with no terminal frame.
function dyingStreamProxy() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n', () => res.destroy());
    });
  });
}

// Reports how the client's response finished rather than waiting on it: an
// open, never-completing response settles as `open` instead of hanging.
function streamOutcome(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      const timer = setTimeout(() => settle('open'), SETTLE_TIMEOUT_MS);
      const settle = (outcome) => {
        clearTimeout(timer);
        resolve({ outcome, status: response.statusCode, complete: response.complete, body: Buffer.concat(chunks).toString() });
      };
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => settle(response.complete ? 'complete' : 'truncated'));
      response.once('aborted', () => settle('aborted'));
      response.once('error', () => settle('aborted'));
    });
    request.once('error', reject);
    request.end(body);
  });
}

// Both relays pipe the upstream response at a client response whose headers are
// already out, so each one is checked on its own: the worker alone, then the
// supervisor in front of it.
for (const command of ['serve-worker', 'serve-shim']) {
  test(`${command}: a streaming upstream that dies mid-answer terminates the client response`, async (t) => {
    const proxy = dyingStreamProxy();
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());
    const { port } = await startGateway(t, command, {
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_USAGE_ENDPOINT: '0',
    });

    const result = await streamOutcome(port, JSON.stringify({
      model: 'claude-gpt-5.6-sol',
      max_tokens: 512,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }));

    assert.notEqual(result.outcome, 'open', `client response never finished after the upstream stream died (${JSON.stringify(result)})`);
    assert.equal(result.status, 200, 'headers were already sent, so the status cannot become an error');
    assert.equal(result.complete, false, 'a broken stream must not be reported as a complete response');
    assert.match(result.body, /message_start/, 'the healthy part of the stream still reaches the client');
  });

  test(`${command}: a passthrough Anthropic SSE upstream that closes mid-chunk terminates the client response`, async (t) => {
    const upstream = net.createServer((socket) => {
      socket.once('data', () => {
        const frame = 'event: message_start\ndata: {"type":"message_start"}\n\n';
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${frame.length.toString(16)}\r\n${frame}\r\n`,
          () => socket.end(),
        );
      });
    });
    const anthropicPort = await listen(upstream);
    t.after(() => upstream.close());
    const proxy = dyingStreamProxy();
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());
    const { port } = await startGateway(t, command, {
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_USAGE_ENDPOINT: '0',
    });

    const result = await streamOutcome(port, JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }));

    assert.notEqual(result.outcome, 'open', `passthrough client response hung open after upstream died (${JSON.stringify(result)})`);
    assert.equal(result.status, 200);
    assert.equal(result.complete, false);
    assert.match(result.body, /message_start/);
  });

  test(`${command}: a Grok SSE upstream that closes mid-chunk terminates the client response`, async (t) => {
    const grokUpstream = net.createServer((socket) => {
      socket.once('data', () => {
        const frame = 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${frame.length.toString(16)}\r\n${frame}\r\n`,
          () => socket.end(),
        );
      });
    });
    const grokPort = await listen(grokUpstream);
    t.after(() => grokUpstream.close());
    const authDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-grok-abort-'));
    t.after(() => fs.rmSync(authDirectory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify({
      'https://auth.x.ai::fixture-client': {
        key: 'fixture-token',
        refresh_token: 'fixture-refresh',
        expires_at: Date.now() + 3600000,
        oidc_client_id: 'fixture-client',
      },
    }));
    fs.writeFileSync(path.join(authDirectory, 'models_cache.json'), JSON.stringify({
      models: {
        'grok-4.5': {
          info: { id: 'grok-4.5', context_window: 500000, supports_reasoning_effort: true },
        },
      },
    }));
    const proxy = dyingStreamProxy();
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());
    const { port } = await startGateway(t, command, {
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_GROK_HOME: authDirectory,
      CODEX_GATEWAY_GROK_ENDPOINT: `http://127.0.0.1:${grokPort}/v1/responses`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_USAGE_ENDPOINT: '0',
    });

    const result = await streamOutcome(port, JSON.stringify({
      model: 'claude-grok-4.5[1m]',
      max_tokens: 512,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }));

    assert.notEqual(result.outcome, 'open', `Grok client response hung open after upstream died (${JSON.stringify(result)})`);
    assert.equal(result.status, 200);
    assert.equal(result.complete, false);
    assert.match(result.body, /message_start/);
  });
}
