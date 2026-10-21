'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createShimRelay } = require('../lib/commands.js');
const { startGateway } = require('./support.js');

function request(port, headers = {}, path = '/v1/messages', body = '{}') {
  return new Promise((resolve, reject) => {
    let responseReceived = false;
    const outgoing = http.request({
      host: '127.0.0.1', port, path, method: 'POST', setHost: false,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', ...headers },
    }, (response) => {
      responseReceived = true;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', (error) => {
      // Windows can reset a pending upload write after the response head is readable.
      if (responseReceived && error.code === 'ECONNRESET') return;
      reject(error);
    });
    if (body instanceof Readable) body.pipe(outgoing);
    else outgoing.end(body);
  });
}

test('supervisor refuses browser Origin headers before relaying inference', async (t) => {
  const { port } = await startGateway(t, 'serve-shim');
  for (const origin of ['https://fixture.invalid', 'null', '']) {
    const response = await request(port, { origin });
    assert.equal(response.status, 403);
  }
});

test('supervisor refuses foreign and missing Host headers before relaying inference', async (t) => {
  const { port } = await startGateway(t, 'serve-shim');
  for (const host of [`fixture.invalid:${port}`, 'api.anthropic.com', '']) {
    const response = await request(port, { host });
    assert.equal(response.status, 403);
  }
});

test('supervisor relays Origin-less requests with either local Host', async (t) => {
  const { port } = await startGateway(t, 'serve-shim');
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const response = await request(port, { host }, '/healthz');
    assert.equal(response.status, 200);
    assert.ok(JSON.parse(response.body).supervisorPid);
  }
});

function uploadResponse() {
  return Object.assign(new EventEmitter(), {
    status: null,
    headers: null,
    flushed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    flushHeaders() { this.flushed = true; },
    end() { this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
}

test('relay refuses a chunked body above 64 MiB without sending it to a worker', async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  const incoming = Readable.from(Array(128).fill(chunk));
  incoming.method = 'POST';
  incoming.url = '/v1/messages';
  incoming.headers = {};
  const relay = createShimRelay({
    httpClient: { request() { assert.fail('oversized body reached the worker'); } },
    getWorkerPort: () => 12345,
  });
  const response = uploadResponse();
  await relay.relay(incoming, response);
  assert.equal(response.status, 413);
  assert.equal(incoming.destroyed, false, 'unread upload must not destroy the socket carrying the 413');
});

test('relay bounds oversized upload draining after flushing the 413 head', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const incoming = new Readable({ read() {} });
  incoming.push(Buffer.alloc(64 * 1024 * 1024 + 1));
  const response = uploadResponse();
  const relay = createShimRelay({
    httpClient: { request() { assert.fail('oversized body reached the worker'); } },
  });
  await relay.relay(incoming, response);
  assert.equal(response.status, 413);
  assert.equal(response.headers['content-length'], '0');
  assert.equal(response.flushed, true, '413 head is flushed before the drain grace');
  t.mock.timers.tick(249);
  assert.notEqual(response.destroyed, true, 'client has a bounded grace to read the 413');
  t.mock.timers.tick(1);
  assert.equal(response.destroyed, true, 'ongoing upload is disconnected after 250 ms');
  incoming.destroy();
});

test('supervisor returns HTTP 413 for an oversized streaming upload', async (t) => {
  const { port } = await startGateway(t, 'serve-shim');
  const chunk = Buffer.alloc(1024 * 1024);
  const response = await request(port, {}, '/v1/messages', Readable.from(Array(128).fill(chunk)));
  assert.equal(response.status, 413);
});
