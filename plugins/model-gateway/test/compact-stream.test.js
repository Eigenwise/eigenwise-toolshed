'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

const COMPACT_PROMPT = 'You are a helpful AI assistant tasked with summarizing conversations.';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function postStream(port, body, onFirstChunk = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      let first = true;
      res.on('data', (chunk) => {
        if (first) {
          first = false;
          onFirstChunk?.(chunk);
        }
        chunks.push(chunk);
      });
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
      const response = await get(port, '/healthz');
      if (response.status === 200) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('shim did not start');
}

async function spawnShim(t, proxyPort, extraEnv = {}) {
  const probe = http.createServer();
  const shimPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_COMPACT_STREAM_RETRY_DELAY_MS: '0',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);
  return shimPort;
}

function frame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START = frame('message_start', {
  type: 'message_start',
  message: { id: 'msg_compact', type: 'message', role: 'assistant', model: 'gpt-5.6-sol', content: [], stop_reason: null },
});
const BLOCK_START = frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const BLOCK_STOP = frame('content_block_stop', { type: 'content_block_stop', index: 0 });
const MESSAGE_DELTA = frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } });
const MESSAGE_STOP = frame('message_stop', { type: 'message_stop' });

function delta(text) {
  return frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
}

function completeStream(summary) {
  return MESSAGE_START + BLOCK_START + delta(summary) + BLOCK_STOP + MESSAGE_DELTA + MESSAGE_STOP;
}

// What claude-code-proxy actually emits when the pooled Codex socket closes
// before a terminal event: the raw detail slug, mid-stream, no message_stop.
function missingTerminalStream() {
  return MESSAGE_START + BLOCK_START + delta('partial ')
    + frame('error', { type: 'error', error: { type: 'api_error', message: 'websocket_missing_terminal' } });
}

// The other observed shape: the socket just stops, with no error event at all.
function truncatedStream() {
  return MESSAGE_START + BLOCK_START + delta('partial ');
}

function compactBody(extra = {}) {
  return JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 512,
    stream: true,
    system: [{ type: 'text', text: COMPACT_PROMPT }],
    messages: [{ role: 'user', content: 'Summarize the conversation.' }],
    ...extra,
  });
}

function normalBody() {
  return JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 512,
    stream: true,
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    messages: [{ role: 'user', content: 'hello' }],
  });
}

function countFrames(body, type) {
  return body.split(`"type":"${type}"`).length - 1;
}

// Serves a scripted sequence of SSE bodies, one per upstream attempt, so a
// retry is observable as "attempt N+1 consumed the next script entry".
function scriptedProxy(scripts) {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const index = Math.min(attempts, scripts.length - 1);
      attempts++;
      const script = scripts[index];
      if (script.status && script.status >= 400) {
        res.writeHead(script.status, { 'content-type': 'application/json' });
        return res.end(script.body);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(script.body);
    });
  });
  return { server, attemptCount: () => attempts };
}

test('a compaction stream that dies without a terminal event is retried and delivered complete', async (t) => {
  const proxy = scriptedProxy([
    { body: missingTerminalStream() },
    { body: completeStream('the real summary') },
  ]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort);

  const response = await postStream(shimPort, compactBody());

  assert.equal(response.status, 200);
  assert.equal(proxy.attemptCount(), 2, 'the failed attempt should have been retried');
  assert.match(response.body, /"type":"message_stop"/);
  assert.match(response.body, /the real summary/);
  assert.doesNotMatch(response.body, /websocket_missing_terminal/,
    'the discarded attempt must never reach the client');
  assert.equal(countFrames(response.body, 'message_start'), 1,
    'the client must see exactly one message, not a spliced pair');
  assert.doesNotMatch(response.body, /partial /);
});

test('a compaction stream truncated with no error event at all is also retried', async (t) => {
  const proxy = scriptedProxy([
    { body: truncatedStream() },
    { body: completeStream('recovered summary') },
  ]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort);

  const response = await postStream(shimPort, compactBody());

  assert.equal(proxy.attemptCount(), 2);
  assert.match(response.body, /recovered summary/);
  assert.match(response.body, /"type":"message_stop"/);
  assert.equal(countFrames(response.body, 'message_start'), 1);
});

test('a healthy compaction stream is passed through untouched and never retried', async (t) => {
  const proxy = scriptedProxy([{ body: completeStream('first try summary') }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort);

  const response = await postStream(shimPort, compactBody());

  assert.equal(proxy.attemptCount(), 1);
  assert.match(response.body, /first try summary/);
  assert.equal(countFrames(response.body, 'message_stop'), 1);
});

test('exhausted compaction retries surface a truthful error instead of a fabricated terminal', async (t) => {
  const proxy = scriptedProxy([{ body: truncatedStream() }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_STREAM_RETRIES: '1' });

  const response = await postStream(shimPort, compactBody());

  assert.equal(proxy.attemptCount(), 2, 'one retry, then give up');
  assert.doesNotMatch(response.body, /"type":"message_stop"/,
    'the shim must never invent a terminal event it did not receive');
  assert.match(response.body, /ended without a terminal message_stop event after 2 attempt/);
  assert.match(response.body, /"type":"error"/);
});

test('exhausted compaction retries replay the real upstream error events verbatim', async (t) => {
  const proxy = scriptedProxy([{ body: missingTerminalStream() }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_STREAM_RETRIES: '0' });

  const response = await postStream(shimPort, compactBody());

  assert.equal(proxy.attemptCount(), 1);
  assert.match(response.body, /websocket_missing_terminal/,
    'once retries are gone the user must see what upstream actually said');
  assert.doesNotMatch(response.body, /"type":"message_stop"/);
});

test('a request-shaped compaction failure is passed straight through without retrying', async (t) => {
  const fatal = MESSAGE_START + frame('error', {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'messages: at least one message is required' },
  });
  const proxy = scriptedProxy([{ body: fatal }, { body: completeStream('should not be reached') }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort);

  const response = await postStream(shimPort, compactBody());

  assert.equal(proxy.attemptCount(), 1, 'resending a body the backend refused on its merits is pointless');
  assert.match(response.body, /invalid_request_error/);
  assert.doesNotMatch(response.body, /should not be reached/);
});

test('a non-compaction turn keeps streaming live and is never buffered or retried', async (t) => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(MESSAGE_START + BLOCK_START + delta('live '));
      await gate;
      res.end(BLOCK_STOP + MESSAGE_DELTA + MESSAGE_STOP);
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort);

  let sawEarlyChunk = false;
  const response = await postStream(shimPort, normalBody(), () => {
    sawEarlyChunk = true;
    release();
  });

  assert.equal(sawEarlyChunk, true, 'normal turns must reach the client before the upstream finishes');
  assert.match(response.body, /live /);
  assert.match(response.body, /"type":"message_stop"/);
});

test('the guard can be turned off entirely', async (t) => {
  const proxy = scriptedProxy([{ body: truncatedStream() }, { body: completeStream('unused') }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_STREAM_GUARD: '0' });

  const health = JSON.parse((await get(shimPort, '/healthz')).body);
  assert.equal(health.compaction.streamGuard, false);

  const response = await postStream(shimPort, compactBody());
  assert.equal(proxy.attemptCount(), 1);
  assert.match(response.body, /partial /);
});

test('healthz reports the compaction guard settings', async (t) => {
  const proxy = scriptedProxy([{ body: completeStream('x') }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_STREAM_RETRIES: '4' });

  const health = JSON.parse((await get(shimPort, '/healthz')).body);
  assert.equal(health.compaction.streamGuard, true);
  assert.equal(health.compaction.retries, 4);
  assert.ok(health.compaction.maxBufferedBytes > 0);
});

test('an upstream error status on a compaction retry is reported in-band, not as a crash', async (t) => {
  const proxy = scriptedProxy([
    { body: truncatedStream() },
    { status: 500, body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }) },
  ]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, { CODEX_GATEWAY_COMPACT_STREAM_RETRIES: '1' });

  const response = await postStream(shimPort, compactBody());

  assert.equal(response.status, 200, 'the SSE status line was already committed on the first attempt');
  assert.match(response.body, /upstream returned 500/);
  assert.match(response.body, /upstream exploded/);
  assert.doesNotMatch(response.body, /"type":"message_stop"/);

  const health = await get(shimPort, '/healthz');
  assert.equal(health.status, 200, 'the shim must survive to serve the next session');
});

// The control for the live A/B that isolated this to the Codex path: the same
// compaction prompt on a Claude model must stay a byte-identical passthrough.
test('a Claude-native compaction request is never buffered, retried, or rewritten', async (t) => {
  let upstreamAttempts = 0;
  let forwardedBody = null;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamAttempts++;
      forwardedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(truncatedStream());
    });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());
  const proxy = scriptedProxy([{ body: completeStream('unused') }]);
  const proxyPort = await listen(proxy.server);
  t.after(() => proxy.server.close());
  const shimPort = await spawnShim(t, proxyPort, {
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
  });

  const body = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 512,
    stream: true,
    system: [{ type: 'text', text: COMPACT_PROMPT }],
    messages: [{ role: 'user', content: 'Summarize the conversation.' }],
  });
  const response = await postStream(shimPort, body);

  assert.equal(upstreamAttempts, 1, 'the Claude path must not gain retry behaviour');
  assert.equal(forwardedBody, body, 'prompt caching keys on the exact bytes');
  assert.equal(response.body, truncatedStream(), 'the Claude stream is passed through untouched');
  assert.equal(proxy.attemptCount(), 0, 'nothing may fall through to the Codex backend');
});

test('20 compaction requests whose first upstream attempt dies all come back complete', async (t) => {
  const attemptsByBody = new Map();
  let upstreamAttempts = 0;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const key = payload.messages[0].content;
      const seen = (attemptsByBody.get(key) || 0) + 1;
      attemptsByBody.set(key, seen);
      upstreamAttempts++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Alternate the two real-world failure shapes on every first attempt.
      if (seen === 1) return res.end(seen % 2 ? missingTerminalStream() : truncatedStream());
      res.end(completeStream(`summary for ${key}`));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await spawnShim(t, proxyPort);

  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => postStream(shimPort, JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 512,
    stream: true,
    system: [{ type: 'text', text: COMPACT_PROMPT }],
    messages: [{ role: 'user', content: `compact-${i}` }],
  }))));

  assert.equal(upstreamAttempts, 40, 'every request should have needed exactly one retry');
  responses.forEach((response, i) => {
    assert.equal(response.status, 200, `request ${i} status`);
    assert.match(response.body, new RegExp(`summary for compact-${i}`), `request ${i} content`);
    assert.equal(countFrames(response.body, 'message_stop'), 1, `request ${i} terminal event`);
    assert.equal(countFrames(response.body, 'message_start'), 1, `request ${i} single message`);
    assert.doesNotMatch(response.body, /websocket_missing_terminal/, `request ${i} leaked the upstream failure`);
    assert.doesNotMatch(response.body, /partial /, `request ${i} leaked a discarded attempt`);
  });
});
