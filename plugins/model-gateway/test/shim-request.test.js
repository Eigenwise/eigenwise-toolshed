'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createShimRelay, PLUGIN_VERSION } = require('../lib/commands.js');

function createFailingHttpClient(getWorker, onFirstRequest = () => {}) {
  const requestedWorkers = [];
  return {
    requestedWorkers,
    request(options, onResponse) {
      requestedWorkers.push(getWorker());
      const upstream = new EventEmitter();
      upstream.end = () => {
        upstream.emit('socket', { connecting: false });
        onFirstRequest();
        queueMicrotask(() => {
          if (requestedWorkers.length === 1) {
            const error = new Error('worker connection reset');
            error.code = 'ECONNRESET';
            upstream.emit('error', error);
          } else {
            onResponse({ statusCode: 200, headers: {} });
          }
        });
      };
      return upstream;
    },
  };
}

function requestFrom(chunks) {
  const request = Readable.from(chunks);
  request.method = 'POST';
  request.url = '/v1/messages';
  request.headers = {};
  return request;
}

function failingUpload(code) {
  return requestFrom((async function* () {
    yield Buffer.from('partial upload');
    throw Object.assign(new Error('private body-read detail'), { code });
  })());
}

function unforwardedRelay() {
  let requests = 0;
  let lost = 0;
  const shimRelay = createShimRelay({
    getWorkerPort: () => 4321,
    httpClient: { request() { requests += 1; throw new Error('unexpected worker request'); } },
    onWorkerRequestLost() { lost += 1; },
  });
  return {
    async relay(request, response) {
      await shimRelay.relay(request, response);
      assert.equal(requests, 0, 'an unread upload must not reach the worker');
      assert.equal(lost, 0, 'an upload failure is not a worker failure');
    },
  };
}

function createResponseRecorder() {
  return Object.assign(new EventEmitter(), {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    flushHeaders() {},
    destroy() { this.destroyed = true; this.emit('close'); },
    end(body) {
      this.body = body;
      this.emit('close');
    },
  });
}

test('shim resends a request after the worker instance that took it is gone', async () => {
  const originalWorker = { pid: 101 };
  const replacementWorker = { pid: 102 };
  let currentWorker = originalWorker;
  const httpClient = createFailingHttpClient(
    () => currentWorker,
    () => { currentWorker = replacementWorker; },
  );
  const shimRelay = createShimRelay({
    getWorker: () => currentWorker,
    getWorkerPort: () => 4321,
    httpClient,
  });

  const response = await shimRelay.requestWorker(
    { method: 'POST', url: '/v1/messages', headers: {} },
    Buffer.from('request body'),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(httpClient.requestedWorkers, [originalWorker, replacementWorker]);
});

test('shim returns 503 without resending while the worker instance is still current', async () => {
  const currentWorker = { pid: 103 };
  let stoppedChecks = 0;
  const httpClient = createFailingHttpClient(() => currentWorker);
  const shimRelay = createShimRelay({
    getWorker: () => currentWorker,
    getWorkerPort: () => 4321,
    isStopped: () => {
      stoppedChecks += 1;
      return stoppedChecks > 1;
    },
    httpClient,
  });
  const request = Readable.from([Buffer.from('request body')]);
  request.method = 'POST';
  request.url = '/v1/messages';
  request.headers = {};
  const response = createResponseRecorder();

  await shimRelay.relay(request, response);

  assert.equal(request.destroyed, true, 'a completed readable can be destroyed while its response is still writable');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['x-should-retry'], 'false');
  assert.equal(httpClient.requestedWorkers.length, 1, 'a current worker is not sent the body again');
  assert.match(String(response.body), /after this request reached the model/);
});

for (const scenario of [
  { name: 'aborted request', request: { aborted: true } },
  { name: 'connection reset', code: 'ECONNRESET' },
  { name: 'premature close', code: 'ERR_STREAM_PREMATURE_CLOSE' },
  { name: 'cancelled read', code: 'ABORT_ERR' },
  { name: 'destroyed response', response: { destroyed: true } },
  { name: 'ended response', response: { writableEnded: true } },
  { name: 'closed response socket', response: { socket: { destroyed: true } } },
]) {
  test(`shim discards an incoming ${scenario.name} without writing or counting a worker failure`, async () => {
    const request = Object.assign(failingUpload(scenario.code), scenario.request);
    const response = Object.assign(createResponseRecorder(), scenario.response);

    await unforwardedRelay().relay(request, response);

    assert.equal(response.statusCode, null);
    assert.equal(response.body, null);
  });
}

test('shim maps a writable non-disconnect upload error to a non-retryable client error', async () => {
  const response = createResponseRecorder();

  await unforwardedRelay().relay(failingUpload('EIO'), response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers.connection, 'close');
  assert.equal(response.headers['x-should-retry'], 'false');
  assert.equal(JSON.parse(response.body).error.type, 'invalid_request_error');
  assert.doesNotMatch(response.body, /private body-read detail/);
});

for (const responseState of [{ destroyed: true }, { socket: { destroyed: true } }]) {
  test(`shim does not forward a completed upload to a disconnected response (${JSON.stringify(responseState)})`, async () => {
    const response = Object.assign(createResponseRecorder(), responseState);

    await unforwardedRelay().relay(requestFrom([Buffer.from('complete')]), response);

    assert.equal(response.statusCode, null);
    assert.equal(response.body, null);
  });
}

for (const disconnected of [false, true]) {
  test(`shim preserves its 64 MiB upload cap${disconnected ? ' without writing to a disconnected client' : ''}`, async () => {
    const response = Object.assign(createResponseRecorder(), { destroyed: disconnected });
    const chunk = Buffer.alloc(1024 * 1024);
    const request = requestFrom([...Array(64).fill(chunk), Buffer.from('x')]);

    await unforwardedRelay().relay(request, response);

    assert.equal(response.statusCode, disconnected ? null : 413);
    if (!disconnected) {
      assert.equal(response.headers.connection, 'close');
      assert.equal(response.headers['x-should-retry'], 'false');
    }
  });
}

test('shim leaves failures before worker delivery retryable', async () => {
  const response = createResponseRecorder();
  const shimRelay = createShimRelay({
    getWorkerPort: () => 4321,
    httpClient: { request() { throw new Error('worker unavailable'); } },
    onWorkerRequestLost() { assert.fail('no worker accepted this request'); },
  });

  await shimRelay.relay(requestFrom([]), response);

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['x-should-retry'], undefined);
  assert.match(response.body, /could not deliver this request/);
});

for (const event of ['error', 'aborted']) {
  test(`shim still closes the client when a worker response emits ${event}`, async () => {
    const response = createResponseRecorder();
    response.destroy = () => { response.destroyed = true; };
    const upstream = new EventEmitter();
    upstream.headers = {};
    upstream.pipe = () => {};
    const shimRelay = createShimRelay({
      getWorkerPort: () => 4321,
      httpClient: {
        request(options, onResponse) {
          const request = new EventEmitter();
          request.end = () => onResponse(upstream);
          return request;
        },
      },
    });

    await shimRelay.relay(requestFrom([]), response);
    assert.equal(response.statusCode, 502, 'missing upstream status keeps the fallback');
    upstream.emit(event, new Error('worker response lost'));
    assert.equal(response.destroyed, true);
  });
}

for (const statusCode of [200, undefined]) {
  test(`shim preserves worker health metadata and status ${statusCode ?? 'fallback'}`, async () => {
    const response = createResponseRecorder();
    const finished = new Promise((resolve) => {
      response.end = (body) => { response.body = body; resolve(); };
    });
    const upstream = Readable.from([Buffer.from('{"ok":true,"models":2}')]);
    upstream.statusCode = statusCode;
    upstream.headers = { 'content-type': 'application/json' };
    const shimRelay = createShimRelay({
      getWorkerPort: () => 4321,
      getHealthMetadata: () => ({ hostsDetected: false }),
      httpClient: {
        request(options, onResponse) {
          const request = new EventEmitter();
          request.end = () => onResponse(upstream);
          return request;
        },
      },
    });
    const request = requestFrom([]);
    request.url = '/healthz?probe=1';

    await shimRelay.relay(request, response);
    await finished;

    assert.equal(response.statusCode, statusCode || 502);
    assert.deepEqual(JSON.parse(response.body), {
      ok: true, models: 2, supervisorVersion: PLUGIN_VERSION, supervisorPid: process.pid,
      proxyRecovery: true, compat: { hostsDetected: false },
    });
  });
}

for (const body of [Buffer.alloc(0), Buffer.from('byte-preserving\0雪 upload'), Buffer.alloc(64 * 1024 * 1024, 'x')]) {
  test(`shim forwards a completed ${body.length}-byte upload unchanged`, async () => {
    const request = requestFrom([body]);
    const response = createResponseRecorder();
    const shimRelay = createShimRelay({
      getWorkerPort: () => 4321,
      httpClient: {
        request(options, onResponse) {
          assert.equal(options.method, 'POST');
          assert.equal(options.path, '/v1/messages');
          const upstream = new EventEmitter();
          upstream.end = (forwarded) => {
            assert.deepEqual(forwarded, body);
            assert.equal(request.destroyed, true, 'completed request destruction is not a client disconnect');
            const answer = new EventEmitter();
            answer.statusCode = 200;
            answer.headers = {};
            answer.pipe = (res) => res.end('ok');
            onResponse(answer);
          };
          return upstream;
        },
      },
    });

    await shimRelay.relay(request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'ok');
  });
}
