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
const { server, request, waitFor, fixture, picker, native, envelope, message, sse, stream } = require('./fixtures/antigravity.js');

async function transformed(chunks, limits = LIMITS, output = []) {
  for await (const chunk of transformSse(Readable.from(chunks), { requestedModel: picker(), limits })) output.push(chunk);
  return Buffer.concat(output).toString();
}

function parsedSseEvent(frame) {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  return data ? JSON.parse(data) : null;
}

function consumeClientFrames(state, chunk) {
  state.pending += state.decoder.write(chunk);
  const separator = /\r?\n\r?\n/;
  let boundary = separator.exec(state.pending);
  let stopped = false;
  while (boundary) {
    const frame = state.pending.slice(0, boundary.index);
    state.pending = state.pending.slice(boundary.index + boundary[0].length);
    stopped = parsedSseEvent(frame)?.type === 'message_stop';
    boundary = stopped ? null : separator.exec(state.pending);
  }
  return stopped;
}

function terminalFinishingClient(port, { cancelOnData = false } = {}) {
  return new Promise((resolve) => {
    const state = { pending: '', decoder: new StringDecoder('utf8') };
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true; resolve(completed);
    };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', (chunk) => {
        if (cancelOnData) { finish(false); req.destroy(); return; }
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

test('terminal frame parsing preserves partial frames and leaves the post-terminal tail untouched', () => {
  const state = { pending: '', decoder: new StringDecoder('utf8') };
  const wire = ': metadata\n\n' + sse({ type: 'ping' }) + sse({ type: 'message_stop' }) + sse({ type: 'ping', tail: true });
  const boundary = wire.indexOf('message_stop') + 3;
  assert.equal(consumeClientFrames(state, Buffer.from(wire.slice(0, boundary))), false);
  assert.equal(consumeClientFrames(state, Buffer.from(wire.slice(boundary))), true);
  assert.match(state.pending, /"tail":true/);
  const malformed = { pending: '', decoder: new StringDecoder('utf8') };
  assert.throws(() => consumeClientFrames(malformed, Buffer.from('data: malformed\n\n')), SyntaxError);
});

test('a terminal-finishing client accepts a clean native stream only after its real terminal reaches EOF', async (t) => {
  const gateway = await fixture(t, { reply: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(stream());
  } });
  assert.equal(await terminalFinishingClient(gateway.port), true);
  assert.equal(gateway.state.attempts.length, 1);
});

test('mixed LF and CRLF SSE frame boundaries preserve exact native framing', async () => {
  const input = sse({ type: 'message_start', message: message() })
    + sse({ type: 'ping' }).replace(/\n/g, '\r\n') + sse({ type: 'message_stop' });
  assert.equal(await transformed([Buffer.from(input)]), input.replace(`"model":"${native()}"`, `"model":"${picker()}"`));
});

test('already-cancelled client lifetimes abort immediately and release only their own listeners', () => {
  for (const initial of [{ aborted: true, destroyed: false }, { aborted: false, destroyed: true }]) {
    const req = Object.assign(new EventEmitter(), { aborted: initial.aborted });
    const res = Object.assign(new EventEmitter(), { destroyed: initial.destroyed, writableFinished: false });
    const lifetime = clientLifetime(req, res, 1000);
    assert.equal(lifetime.signal.aborted, true);
    assert.equal(lifetime.cancelled(), true);
    req.emit('aborted');
    lifetime.dispose();
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

function collectedResponse() {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; response.headersSent = true; };
  return { response, chunks };
}

function mockedWorkerHttp(finish) {
  const calls = [];
  return { calls, request(options, callback) {
    const request = new EventEmitter();
    request.end = (body) => { calls.push({ options, body }); queueMicrotask(() => finish(request, callback)); };
    return request;
  } };
}

for (const pathname of ['/v1/messages', '/v1/messages/count_tokens']) {
  test(`an unavailable worker refuses ${pathname} without treating an undelivered request as worker failure`, async () => {
    const { relayAntigravityWorker } = require('../lib/antigravity-supervisor.js');
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: pathname, headers: {}, aborted: false });
    const { response, chunks } = collectedResponse();
    let lost = 0;
    await relayAntigravityWorker(req, response, JSON.stringify({ model: picker() }), {
      getWorker: () => ({ fixture: true }), getWorkerPort: () => 0,
      onWorkerRequestLost: () => { lost++; }, limits: { deadlineMs: 1000 },
    });
    assert.equal(response.status, 503);
    assert.match(Buffer.concat(chunks).toString(), /Antigravity worker/);
    assert.equal(lost, 0);
  });
}

test('a reused worker socket records exactly one delivered failure without generation resend', async () => {
  const { relayAntigravityWorker } = require('../lib/antigravity-supervisor.js');
  const worker = { fixture: true };
  const lost = [];
  const httpClient = mockedWorkerHttp((request) => {
    request.emit('socket', Object.assign(new EventEmitter(), { connecting: false }));
    request.emit('error', new Error('fixture worker response lost'));
  });
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/messages', headers: {}, aborted: false });
  const { response } = collectedResponse();
  await relayAntigravityWorker(req, response, JSON.stringify({ model: picker() }), {
    getWorker: () => worker, getWorkerPort: () => 12345, httpClient,
    onWorkerRequestLost: (_error, identity) => lost.push(identity), limits: { deadlineMs: 1000 },
  });
  assert.deepEqual(lost, [worker]);
  assert.equal(httpClient.calls.length, 1);
  assert.equal(response.status, 503);
  assert.equal(response.headers['x-should-retry'], 'false');
});

test('a worker response missing status fails closed at 502 while preserving count-token bytes', async () => {
  const { relayAntigravityWorker } = require('../lib/antigravity-supervisor.js');
  const upstream = Object.assign(Readable.from([Buffer.from('fixture bytes')]), { headers: {} });
  const httpClient = mockedWorkerHttp((request, callback) => {
    const socket = Object.assign(new EventEmitter(), { connecting: true });
    request.emit('socket', socket); socket.emit('connect'); callback(upstream);
  });
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/messages/count_tokens', headers: { host: 'untrusted.example' }, aborted: false });
  const { response, chunks } = collectedResponse();
  await relayAntigravityWorker(req, response, JSON.stringify({ model: picker() }), {
    getWorker: () => ({ fixture: true }), getWorkerPort: () => 12345, httpClient, limits: { deadlineMs: 1000 },
  });
  assert.equal(response.status, 502);
  assert.equal(Buffer.concat(chunks).toString(), 'fixture bytes');
  assert.equal(response.headers['x-should-retry'], undefined);
  assert.equal(httpClient.calls[0].options.headers.host, '127.0.0.1:12345');
  assert.equal(httpClient.calls.length, 1);
});

test('standalone compatibility drain rejects missing control credentials and closes only its owned listeners', async (t) => {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const compatPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  assert.equal([18764, 18765, 18766].includes(compatPort), false);
  const proxy = await server(t, (_req, res) => res.end(JSON.stringify(require('./fixtures/antigravity.js').envelope())));
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port), CODEX_GATEWAY_COMPAT_PORT: String(compatPort) });
  require('node:fs').writeFileSync(environment.CODEX_GATEWAY_HOSTS_FILE, '127.0.0.1 api.anthropic.com\n');
  const gateway = await startGateway(t, 'serve-worker', environment, { isolatedOverrides: { CODEX_GATEWAY_WORKER_PORT: '' } });
  await waitFor(async () => JSON.parse((await request(gateway.port, null, {}, '/healthz', 'GET')).body).compat.port80Bound);
  assert.equal((await request(gateway.port, {}, {}, '/drain')).status, 403);
  assert.equal((await request(gateway.port, null, {}, '/healthz', 'GET')).status, 200);
  const headers = { ...controlRequestHeaders(path.join(environment.HOME, '.claude', 'model-gateway', 'control-token')),
    host: `api.anthropic.com:${compatPort}` };
  const refusedCompat = await request(compatPort, {}, headers, '/drain');
  assert.equal(refusedCompat.status, 403, 'compatibility listeners never authenticate lifecycle control');
  const drained = await request(gateway.port, {}, controlRequestHeaders(path.join(environment.HOME, '.claude', 'model-gateway', 'control-token')), '/drain');
  assert.equal(drained.status, 202);
  assert.equal(JSON.parse(drained.body).draining, true);
  await waitFor(() => gateway.child.exitCode === 0);
});

test('fault-injected parser metadata cannot invent passthrough body bytes', async (t) => {
  const fs = require('node:fs');
  const bodies = [];
  const anthropic = await server(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { bodies.push(Buffer.concat(chunks)); res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5-5', content: [] })); });
  });
  const proxy = await server(t, (_req, res) => res.end(JSON.stringify(require('./fixtures/antigravity.js').envelope())));
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port),
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropic.port}` });
  const preload = path.join(environment.HOME, 'parser-metadata.cjs');
  const adapter = path.resolve(__dirname, '..', 'lib', 'antigravity-request.js');
  fs.writeFileSync(preload, `const api=require(${JSON.stringify(adapter)});const previous=api.parsePayload;api.parsePayload=(raw)=>raw===null?{model:'claude-opus-5-5',messages:[]}:previous(raw);\n`);
  environment.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const gateway = await startGateway(t, 'serve-worker', environment);
  const response = await request(gateway.port, undefined);
  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].length, 0);
});

test('message-envelope rewriting rejects provider errors and preserves nested content identity', () => {
  const { rewriteMessage } = require('../lib/antigravity-relay.js');
  for (const value of [null, { type: 'error' }, { type: 'message', error: { message: 'fixture error' } }]) {
    assert.throws(() => rewriteMessage(value, picker()), /invalid message envelope/);
  }
  const original = message();
  const rewritten = rewriteMessage(original, picker());
  assert.equal(rewritten.model, picker());
  assert.equal(rewritten.content, original.content);
  assert.equal(original.model, native());
});

for (const scenario of [{ headersSent: false, writes: [503], bodies: 1 }, { headersSent: true, writes: [], bodies: 0 }]) {
  test(`native admission observer failure stays handled with headersSent=${scenario.headersSent}`, async (t) => {
    const { handleDirect } = require('../lib/antigravity-request.js');
    const queries = [];
    const proxy = await server(t, (req, res) => { queries.push(req.url); res.end(JSON.stringify(require('./fixtures/antigravity.js').envelope())); });
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/messages', headers: {}, aborted: false });
    const res = Object.assign(new EventEmitter(), { headersSent: scenario.headersSent, destroyed: false, writableFinished: false });
    const writes = [];
    const bodies = [];
    res.writeHead = (code) => { writes.push(code); res.headersSent = true; };
    res.end = (body) => { bodies.push(body); res.writableFinished = true; };
    const payload = { model: picker(), messages: [] };
    await handleDirect(req, res, JSON.stringify(payload), payload, { port: proxy.port, routeTelemetry: { setRoute() {} },
      onAdmitted: () => { throw new Error('fixture observer fault'); } });
    assert.deepEqual(writes, scenario.writes);
    assert.equal(bodies.length, scenario.bodies);
    assert.ok(bodies.every((body) => body.includes('No other provider was used.')));
    assert.ok(bodies.every((body) => !body.includes('fixture observer fault')));
    assert.deepEqual(queries, ['/v1/models?include_capabilities=true']);
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
  });
}

test('a client cancelled before admission cannot send generation or emit a refusal to its closed response', async (t) => {
  const { handleDirect } = require('../lib/antigravity-request.js');
  let queries = 0;
  const proxy = await server(t, (_req, res) => { queries++; res.end('{}'); });
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/messages', headers: {}, aborted: true });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false, headersSent: false });
  const writes = [];
  res.writeHead = () => writes.push('headers');
  res.end = () => writes.push('body');
  const payload = { model: picker(), messages: [] };
  await handleDirect(req, res, JSON.stringify(payload), payload, { port: proxy.port, routeTelemetry: { setRoute() {} },
    onAdmitted: () => writes.push('generation admitted') });
  assert.deepEqual(writes, []);
  assert.equal(queries, 0);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('an invalid native status from a faulty transport cannot become a successful message', async (t) => {
  const upstream = Object.assign(Readable.from([Buffer.from(JSON.stringify(message()))]), {
    statusCode: 0, headers: { 'content-type': 'application/json' },
  });
  t.mock.method(http, 'request', (_url, _options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.end = () => queueMicrotask(() => callback(upstream));
    return outgoing;
  });
  const relay = await server(t, (req, res) => {
    req.resume();
    void forwardAntigravity(req, res, { port: 12345, body: Buffer.from(JSON.stringify({ model: native() })),
      requestedModel: picker(), limits: { deadlineMs: 1000 } });
  });
  const response = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.match(await response.text(), /No fallback or automatic resend/);
});

test('all-CRLF SSE streams preserve their original separators and exact model identity', async () => {
  const input = stream().replace(/\n/g, '\r\n');
  assert.equal(await transformed([Buffer.from(input)]), input.replace(`"model":"${native()}"`, `"model":"${picker()}"`));
});

test('terminal parsing performs no extra regex work on a retained tail but probes ordinary exhaustion once', (t) => {
  const calls = [];
  const source = /\r?\n\r?\n/.source;
  const original = RegExp.prototype.exec;
  t.mock.method(RegExp.prototype, 'exec', function(input) {
    if (this.source === source) calls.push(input);
    return original.call(this, input);
  });
  const tail = sse({ type: 'ping', tail: true });
  const wire = sse({ type: 'message_stop' }) + tail;
  assert.equal(consumeClientFrames({ pending: '', decoder: new StringDecoder('utf8') }, Buffer.from(wire)), true);
  assert.deepEqual(calls, [wire]);
  calls.length = 0;
  const ping = sse({ type: 'ping' });
  assert.equal(consumeClientFrames({ pending: '', decoder: new StringDecoder('utf8') }, Buffer.from(ping)), false);
  assert.deepEqual(calls, [ping, '']);
});

test('a serializer adding a surplus data line is rejected before any malformed SSE frame can escape', async (t) => {
  const input = Buffer.from(stream());
  const original = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...rest) => {
    const encoded = original(value, ...rest);
    return value === picker() ? encoded + '\n' : encoded;
  });
  assert.equal(JSON.stringify({ fixture: true }), '{"fixture":true}', 'the serializer fault is limited to the model token');
  await assert.rejects(transformed([input]), /identity rewrite changed SSE data-line structure/);
});

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

test('a terminal-finishing client never sees message_stop before later-chunk errors, truncation or cancellation', async (t) => {
  for (const scenario of [
    { failure: 'error', delay: 40, cancelOnData: false, settle: 0, closed: false },
    { failure: 'truncated-frame', delay: 40, cancelOnData: false, settle: 0, closed: false },
    { failure: 'aborted-body', delay: 40, cancelOnData: false, settle: 0, closed: false },
    { failure: 'client-cancelled', delay: 200, cancelOnData: true, settle: 250, closed: true },
  ]) {
    const closed = [];
    const gateway = await fixture(t, { reply: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(stream());
      const timer = setTimeout(() => {
        closed.push(res.destroyed);
        if (res.destroyed) return;
        if (scenario.failure === 'aborted-body') return res.destroy();
        res.end(scenario.failure === 'error' ? sse({ type: 'error', error: { type: 'api_error', message: 'late fixture failure' } }) : 'data: {"partial":');
      }, scenario.delay);
      t.after(() => clearTimeout(timer));
    } });
    assert.equal(await terminalFinishingClient(gateway.port, { cancelOnData: scenario.cancelOnData }), false, scenario.failure);
    await pause(scenario.settle);
    assert.deepEqual(closed, [scenario.closed]);
    assert.equal(gateway.state.attempts.length, 1);
  }
});

test('a shared transformed-stream collector observes the same bytes as the completed result', async () => {
  const emitted = [];
  const result = await transformed([Buffer.from(stream())], LIMITS, emitted);
  assert.ok(emitted.length > 0);
  assert.equal(Buffer.concat(emitted).toString(), result);
});

test('terminal retention remains byte-bounded and preserves a clean post-terminal ping tail', async () => {
  const tail = ': after terminal\n\n' + sse({ type: 'ping', padding: 'x'.repeat(100000) });
  const input = stream() + tail;
  assert.equal(await transformed([Buffer.from(stream()), Buffer.from(tail)]), input.replace(`"model":"${native()}"`, `"model":"${picker()}"`));
  const emitted = [];
  await assert.rejects(transformed([Buffer.from(stream()), Buffer.from(tail)],
    { ...LIMITS, streamBytes: Buffer.byteLength(stream()) + 10 }, emitted), /stream.*budget/);
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
    res.setHeader('content-type', 'application/json');
    req.resume();
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify(envelope()));
    attempts++;
    res.end(JSON.stringify(message()));
  });
  const environment = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
  const worker = await startGateway(t, 'serve-worker', environment);
  const accepted = await request(worker.port, { model: picker(), messages: [] });
  assert.equal(accepted.status, 200, 'the same generation must be forwardable before drain');
  assert.equal(JSON.parse(accepted.body).model, picker());
  assert.deepEqual(JSON.parse(accepted.body).content, message().content);
  assert.equal(attempts, 1);
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
  assert.equal(attempts, 1, 'drained pipelined generation must not add another upstream attempt');
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
  await waitFor(() => response.closed);
  await waitFor(() => nativeSocketClosed);
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
