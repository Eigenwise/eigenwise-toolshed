'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

// Node warns once the 11th listener lands on an emitter, so a per-request
// registration on the shared keep-alive socket shows up well before this.
const KEEP_ALIVE_REQUESTS = 15;

function threadRefusalRequest(port, agent) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model: 'claude-gpt-5.6-terra',
      thread: { type: 'resume' },
      messages: [{ role: 'user', content: 'current turn' }],
      max_tokens: 1,
    }));
    const clientRequest = http.request({
      host: '127.0.0.1',
      port,
      agent,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, (response) => {
      const socket = response.socket;
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, socket }));
    });
    clientRequest.once('error', reject);
    clientRequest.end(body);
  });
}

test('sequential keep-alive requests leave the shared socket listener count flat', async (t) => {
  const environment = gatewayTestEnvironment(t);
  const { child, port } = await startGateway(t, 'serve-worker', environment, {
    isolatedOverrides: { CODEX_GATEWAY_REQUEST_LOG: '0', CODEX_GATEWAY_SENTRY: '0' },
  });
  let workerErrors = '';
  child.stderr.on('data', (chunk) => { workerErrors += chunk; });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const sockets = new Set();
  for (let attempt = 0; attempt < KEEP_ALIVE_REQUESTS; attempt += 1) {
    const response = await threadRefusalRequest(port, agent);
    assert.equal(response.status, 400, 'every keep-alive request reaches the stateless-thread refusal');
    sockets.add(response.socket);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(sockets.size, 1, `${KEEP_ALIVE_REQUESTS} requests must share one connection for this to test anything`);
  assert.doesNotMatch(
    workerErrors,
    /MaxListenersExceededWarning/,
    `worker accumulated listeners across ${KEEP_ALIVE_REQUESTS} keep-alive requests: ${workerErrors}`,
  );
});
