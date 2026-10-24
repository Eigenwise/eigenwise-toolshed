'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const { setTimeout: pause } = require('node:timers/promises');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment, gatewayTestEnvironment, startGateway } = require('./support.js');
isolateInProcessGatewayEnvironment(test);
const { controlRequestHeaders } = require('../lib/control-auth.js');
const { createShimRelay } = require('../lib/commands.js');
const { LIMITS, transformSse, clientLifetime, isGeneration, forwardAntigravity } = require('../lib/antigravity-relay.js');
const { replaceRequestModel } = require('../lib/antigravity-request.js');
const { server, request, waitFor, fixture, picker, native, message, sse, stream } = require('./fixtures/antigravity.js');

async function transformed(chunks, limits = LIMITS) {
  const output = [];
  for await (const chunk of transformSse(Readable.from(chunks), { requestedModel: picker(), limits })) output.push(chunk);
  return Buffer.concat(output).toString();
}

function parsedSseEvent(frame) {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  return data ? JSON.parse(data) : null;
}

function consumeClientFrames(state, chunk) {
  state.pending += state.decoder.write(chunk);
  let boundary;
  while ((boundary = /\r?\n\r?\n/.exec(state.pending))) {
    const frame = state.pending.slice(0, boundary.index);
    state.pending = state.pending.slice(boundary.index + boundary[0].length);
    if (parsedSseEvent(frame)?.type === 'message_stop') return true;
  }
  return false;
}

function terminalFinishingClient(port) {
  return new Promise((resolve) => {
    const state = { pending: '', decoder: new StringDecoder('utf8') };
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true; resolve(completed);
    };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', (chunk) => {
        if (!consumeClientFrames(state, chunk)) return;
        finish(true); res.destroy();
      });
      res.once('aborted', () => finish(false));
      res.once('error', () => finish(false));
      res.once('end', () => finish(false));
    });
    req.once('error', () => finish(false));
    req.end(JSON.stringify({ model: picker(), messages: [], stream: true }));
  });
}

test('multiline SSE rewriting preserves every data prefix and line ending except the model token', async () => {
  const json = JSON.stringify({ type: 'message_start', message: message() }, null, 2);
  const data = json.split('\n').map((line, index) => (index % 2 ? 'data:' : 'data: ') + line).join('\r\n');
  const input = ': metadata stays exact\r\nevent: message_start\r\nid: fixture-event\r\n' + data + '\r\n\r\n' + sse({ type: 'message_stop' });
  const rewritten = await transformed([Buffer.from(input)]);
  assert.equal(rewritten, input.replace(`"model": "${native()}"`, `"model": "${picker()}"`));
  const event = parsedSseEvent(rewritten.split('\r\n\r\n')[0]);
  assert.equal(event.message.model, picker());
  assert.deepEqual(event.message.content, message().content);
});

test('a malformed multiline envelope model cannot corrupt SSE data-line structure', async () => {
  const event = { type: 'message_start', message: { ...message(), model: { invalid: 'not a model string' } } };
  const frame = 'event: message_start\n' + JSON.stringify(event, null, 2).split('\n').map((line) => 'data: ' + line).join('\n') + '\n\n';
  await assert.rejects(transformed([Buffer.from(frame + sse({ type: 'message_stop' }))]), /SSE data-line structure/);
});

test('a terminal-finishing client never sees message_stop before later-chunk errors or HTTP truncation', async (t) => {
  for (const failure of ['error', 'truncated-frame', 'aborted-body']) {
    const gateway = await fixture(t, { reply: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(stream());
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        if (failure === 'aborted-body') return res.destroy();
        res.end(failure === 'error' ? sse({ type: 'error', error: { type: 'api_error', message: 'late fixture failure' } }) : 'data: {"partial":');
      }, 40);
      t.after(() => clearTimeout(timer));
    } });
    assert.equal(await terminalFinishingClient(gateway.port), false, failure);
    assert.equal(gateway.state.attempts.length, 1);
  }
});

test('terminal retention remains byte-bounded and preserves a clean post-terminal ping tail', async () => {
  const tail = ': after terminal\n\n' + sse({ type: 'ping', padding: 'x'.repeat(100000) });
  const input = stream() + tail;
  assert.equal(await transformed([Buffer.from(stream()), Buffer.from(tail)]), input.replace(`"model":"${native()}"`, `"model":"${picker()}"`));
  const emitted = [];
  await assert.rejects(async () => {
    for await (const chunk of transformSse(Readable.from([Buffer.from(stream()), Buffer.from(tail)]), {
      requestedModel: picker(), limits: { ...LIMITS, streamBytes: Buffer.byteLength(stream()) + 10 },
    })) emitted.push(chunk);
  }, /stream.*budget/);
  assert.doesNotMatch(Buffer.concat(emitted).toString(), /event: message_stop/);
});

test('a held terminal is discarded on the relay deadline and releases its owned native request', async (t) => {
  let nativeClosed = false;
  let attempts = 0;
  const upstream = await server(t, (req, res) => {
    attempts++;
    req.resume(); res.once('close', () => { nativeClosed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(stream());
  });
  const gateway = await server(t, (req, res) => {
    req.resume(); req.once('end', () => { void forwardAntigravity(req, res, { port: upstream.port, requestedModel: picker(), body: '{}', limits: { deadlineMs: 80 } }); });
  });
  const started = performance.now();
  assert.equal(await terminalFinishingClient(gateway.port), false);
  assert.ok(performance.now() - started >= 60, 'the complete terminal must wait for HTTP-body EOF or the elapsed deadline');
  await waitFor(() => nativeClosed);
  assert.equal(attempts, 1);
});

test('the held terminal is released at clean HTTP body EOF without waiting for keep-alive socket close', async (t) => {
  const proxy = await server(t, (_req, res) => {
    const body = stream();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(body), connection: 'keep-alive' });
    res.end(body);
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const response = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.port, agent }, resolve).once('error', reject);
  });
  const socket = response.socket;
  const output = [];
  for await (const chunk of transformSse(response, { requestedModel: picker() })) output.push(chunk);
  assert.equal(response.complete, true);
  assert.equal(socket.destroyed, false);
  assert.match(Buffer.concat(output).toString(), /event: message_stop/);
});

test('request rewrite preserves every original byte outside the top-level model token', () => {
  const raw = '{ "model" : "claude-antigravity-gemini-4-argon-low", "unknown":900719925474099312345, "messages":[{"role":"user","content":"秘密\\n"}], "tools":[{"model":"keep", "value":1e20}], "other":-0 }';
  assert.equal(replaceRequestModel(raw, native()).toString(), raw.replace('"claude-antigravity-gemini-4-argon-low"', '"antigravity/gemini-4-argon-low"'));
  assert.throws(() => replaceRequestModel('{"model":"one","model":"two"}', native()), /unambiguous/);
});

test('dedicated SSE parser handles a 12MiB carrier frame and fragmented UTF8 without the legacy observer cap', async () => {
  const payload = message();
  payload.content[0].signature = 'ccp:antigravity:v1:' + 'a'.repeat(12 * 1024 * 1024);
  const wire = Buffer.from(sse({ type: 'message_start', message: payload }) + sse({ type: 'message_stop' }));
  const chunks = [];
  for (let index = 0; index < wire.length; index += 32767) chunks.push(wire.subarray(index, index + 32767));
  const result = await transformed(chunks);
  assert.equal(result, wire.toString().replace(`"model":"${native()}"`, `"model":"${picker()}"`));
  assert.deepEqual(LIMITS, { frameBytes: 16777216, bodyBytes: 25165824, streamBytes: 33554432, deadlineMs: 900000 });
  const unicode = Buffer.from(stream());
  assert.equal(await transformed([...unicode].map((value) => Buffer.from([value]))), stream().replace(`"model":"${native()}"`, `"model":"${picker()}"`));
});

test('SSE enforces per-frame and aggregate wire bounds, and truncation/error never synthesize success', async () => {
  await assert.rejects(transformed([Buffer.from(': ' + 'a'.repeat(129))], { ...LIMITS, frameBytes: 128 }), /frame/);
  await assert.rejects(transformed([Buffer.from(': ping\n\n'.repeat(10))], { ...LIMITS, streamBytes: 64 }), /stream/);
  await assert.rejects(transformed([Buffer.from(sse({ type: 'message_start', message: message() }))]), /incomplete/);
  await assert.rejects(transformed([Buffer.from(stream() + sse({ type: 'error', error: { type: 'api_error', message: 'private' } }))]), /failed/);
  await assert.rejects(transformed([Buffer.from(stream().slice(0, -2))]), /incomplete/);
  await assert.rejects(transformed([Buffer.from(stream() + 'event: error\ndata: {"notice":"failed"}\n\n')]), /failed/);
  await assert.rejects(transformed([Buffer.from(stream() + 'event: error\n\n')]), /failed/);
  await assert.rejects(transformed([Buffer.from(stream() + sse({ type: 'content_block_start', content_block: { type: 'text', text: 'after stop' } }))]), /failed/);
});

test('SSE transfer respects downstream backpressure instead of consuming an unbounded source', async () => {
  let produced = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const chunks = async function* () {
    yield Buffer.from(sse({ type: 'message_start', message: message() }));
    for (let index = 0; index < 1000; index++) { produced++; yield Buffer.from(': ' + 'x'.repeat(4096) + '\n\n'); }
    yield Buffer.from(sse({ type: 'message_stop' }));
  };
  const target = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { hold.then(() => callback()); } });
  const done = pipeline(Readable.from(chunks()), (source) => transformSse(source, { requestedModel: picker() }), target);
  await pause(40);
  assert.ok(produced < 20, `source ran ahead by ${produced} frames`);
  release(); await done;
});

test('normal writableFinished does not cancel; writableEnded without flush completion does cancel', () => {
  for (const [finished, expected] of [[true, false], [false, true]]) {
    const req = new EventEmitter(); req.destroyed = true;
    const res = new EventEmitter(); res.writableFinished = finished; res.writableEnded = true;
    const owned = clientLifetime(req, res, 100);
    assert.equal(owned.signal.aborted, false, 'req.destroyed alone is not an upload abort');
    res.emit('close');
    assert.equal(owned.signal.aborted, expected);
    owned.dispose();
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

async function relayFixture(t, handler, options = {}) {
  let worker = { pid: 100 };
  const lost = [];
  const workerServer = await server(t, handler);
  const shim = createShimRelay({ getWorker: () => worker, getWorkerPort: () => workerServer.port,
    onWorkerRequestLost: (...args) => lost.push(args), antigravityLimits: options.limits });
  const publicServer = await server(t, (req, res) => { void shim.relay(req, res); });
  return { port: publicServer.port, lost, replace: () => { worker = { pid: 101 }; } };
}

test('AGY supervisor never resends a possibly delivered generation after worker replacement', async (t) => {
  let attempts = 0;
  let gateway;
  gateway = await relayFixture(t, (req) => {
    req.resume(); req.on('end', () => { attempts++; gateway.replace(); req.socket.destroy(); });
  });
  const response = await request(gateway.port, { model: picker(), messages: [] });
  assert.equal(response.status, 503);
  assert.equal(response.headers['x-should-retry'], 'false');
  assert.equal(attempts, 1);
  assert.equal(isGeneration({ method: 'POST', url: '/v1/messages/count_tokens' }, JSON.stringify({ model: picker() })), false);
  assert.equal(isGeneration({ method: 'GET', url: '/v1/models' }, ''), false);
});

test('two-hop cancellation after upload reaches owned native request before headers and during streaming', async (t) => {
  for (const sendHeaders of [false, true]) {
    let accepted = false;
    let closed = false;
    const gateway = await fixture(t, { reply: (_req, res) => {
      accepted = true;
      res.once('close', () => { closed = true; });
      if (sendHeaders) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse({ type: 'message_start', message: message() })); }
    } });
    const req = http.request({ host: '127.0.0.1', port: gateway.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => res.resume());
    req.on('error', () => {});
    req.end(JSON.stringify({ model: picker(), messages: [], stream: true }));
    await waitFor(() => accepted);
    req.destroy();
    await waitFor(() => closed, 1500);
    assert.equal(gateway.state.attempts.length, 1);
  }
});

test('supervisor deadline cancels owned work and client cancellation is not worker failure', async (t) => {
  let closed = 0;
  const gateway = await relayFixture(t, (req, res) => { req.resume(); res.once('close', () => { closed++; }); }, { limits: { deadlineMs: 80 } });
  const response = await request(gateway.port, { model: picker(), messages: [] });
  assert.equal(response.status, 503);
  assert.equal(response.headers['x-should-retry'], 'false');
  await waitFor(() => closed === 1);
  const priorLost = gateway.lost.length;
  const req = http.request({ host: '127.0.0.1', port: gateway.port, method: 'POST', path: '/v1/messages' });
  req.on('error', () => {}); req.end(JSON.stringify({ model: picker() }));
  await pause(30); req.destroy(); await pause(100);
  assert.equal(gateway.lost.length, priorLost);
});

test('a worker refuses pipelined generation after authenticated drain without forwarding it', async (t) => {
  let attempts = 0;
  const proxy = await server(t, (req, res) => {
    if (!req.url.startsWith('/v1/models')) attempts++;
    req.resume(); res.end('{"data":[]}');
  });
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
  const worker = await startGateway(t, 'serve-worker', environment);
  const headers = controlRequestHeaders(path.join(environment.HOME, '.claude', 'model-gateway', 'control-token'));
  const auth = Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
  const body = JSON.stringify({ model: picker(), messages: [] });
  const wire = `POST /drain HTTP/1.1\r\nHost: 127.0.0.1:${worker.port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n${auth}\r\n\r\n{}`
    + `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${worker.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(worker.port, '127.0.0.1');
    const chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture pipeline timeout')));
    socket.on('data', (chunk) => chunks.push(chunk)); socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.once('connect', () => socket.end(wire));
    t.after(() => socket.destroy());
  });
  assert.match(response, /HTTP\/1.1 202/);
  assert.match(response, /HTTP\/1.1 503/);
  assert.equal(attempts, 0);
});

test('count_tokens transport failure is not described as an ambiguous paid generation', async (t) => {
  const upstream = await server(t, (req) => { req.resume(); req.on('end', () => req.socket.destroy()); });
  const gateway = await server(t, (req, res) => {
    req.resume(); req.on('end', () => { void forwardAntigravity(req, res, { port: upstream.port, requestedModel: picker(), body: '{}' }); });
  });
  const result = await request(gateway.port, { model: picker() }, {}, '/v1/messages/count_tokens');
  assert.equal(result.status, 502);
  assert.equal(result.headers['x-should-retry'], undefined);
  assert.doesNotMatch(result.body, /another generation|paid|generation may/);
});

test('the native-hop overall deadline also bounds a stalled nonstream downstream flush', async (t) => {
  let nativeSocketClosed = false;
  const upstream = await server(t, (req, res) => {
    req.socket.once('close', () => { nativeSocketClosed = true; });
    req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message()));
  });
  const response = new Writable({ highWaterMark: 1, write() { /* the client never drains this body */ } });
  response.writeHead = () => { response.headersSent = true; };
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/messages', headers: {} });
  const completion = forwardAntigravity(req, response, { port: upstream.port, requestedModel: picker(), body: '{}', limits: { deadlineMs: 80 } });
  try {
    await waitFor(() => response.writableEnded);
    await pause(150);
    assert.equal(response.destroyed, true, 'elapsed deadline must cancel a body already queued to a slow client');
  } finally { response.destroy(); await completion; }
  await waitFor(() => response.closed && nativeSocketClosed);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);
});

test('unsupported native response encoding fails closed and cancels its unconsumed body', async (t) => {
  let closed = false;
  const upstream = await server(t, (req, res) => {
    req.resume(); res.once('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.write('not consumed');
  });
  const gateway = await server(t, (req, res) => {
    req.resume(); req.on('end', () => { void forwardAntigravity(req, res, { port: upstream.port, requestedModel: picker(), body: '{}' }); });
  });
  const result = await request(gateway.port, { model: picker() });
  assert.equal(result.status, 502);
  await waitFor(() => closed, 1500);
});

test('native relay overall deadline and nonstream body budget are bounded with injected limits', async (t) => {
  for (const kind of ['deadline', 'bytes']) {
    let closed = false;
    const upstream = await server(t, (req, res) => {
      req.resume(); res.once('close', () => { closed = true; });
      if (kind === 'bytes') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message())); }
    });
    const gateway = await server(t, (req, res) => {
      req.resume(); req.on('end', () => { void forwardAntigravity(req, res, { port: upstream.port, requestedModel: picker(), body: JSON.stringify({ model: native() }), limits: { deadlineMs: 80, bodyBytes: 64 } }); });
    });
    const response = await request(gateway.port, { model: picker() });
    assert.equal(response.status, 502);
    assert.equal(response.headers['x-should-retry'], 'false');
    await waitFor(() => closed);
  }
});
