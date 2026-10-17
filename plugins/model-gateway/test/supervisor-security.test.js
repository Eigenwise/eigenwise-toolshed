'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createShimRelay } = require('../lib/commands.js');
const { startGateway } = require('./support.js');

function request(port, headers = {}, path = '/v1/messages', body = '{}') {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1', port, path, method: 'POST', setHost: false,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', reject);
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

test('relay refuses a chunked body above 64 MiB without sending it to a worker', async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  const incoming = Readable.from(Array(65).fill(chunk));
  incoming.method = 'POST';
  incoming.url = '/v1/messages';
  incoming.headers = {};
  const relay = createShimRelay({
    httpClient: { request() { assert.fail('oversized body reached the worker'); } },
    getWorkerPort: () => 12345,
  });
  const response = {
    status: null,
    writeHead(status) { this.status = status; },
    end() {},
  };
  await relay.relay(incoming, response);
  assert.equal(response.status, 413);
});

test('supervisor returns HTTP 413 for an oversized streaming upload', async (t) => {
  const { port } = await startGateway(t, 'serve-shim');
  const chunk = Buffer.alloc(1024 * 1024);
  const response = await request(port, {}, '/v1/messages', Readable.from(Array(65).fill(chunk)));
  assert.equal(response.status, 413);
});
