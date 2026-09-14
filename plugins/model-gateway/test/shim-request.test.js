'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createShimRelay } = require('../lib/commands.js');

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

function createResponseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
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

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['x-should-retry'], 'false');
  assert.equal(httpClient.requestedWorkers.length, 1, 'a current worker is not sent the body again');
  assert.match(String(response.body), /after this request reached the model/);
});
