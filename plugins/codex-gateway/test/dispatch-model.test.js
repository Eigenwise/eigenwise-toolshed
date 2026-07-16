'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');
const gw = require(CLI);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body ? 'POST' : 'GET',
      path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHealthz(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('shim did not become healthy');
}

test('dispatch model resolves route marker v2 model and effort', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-dispatch-'));
  const routeLog = path.join(logDir, 'routes.jsonl');
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
        return;
      }
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG_PATH: routeLog,
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data;
  assert.ok(models.some((model) => model.id === 'claude-codex-auto' && model.display_name === 'Sidequest Dispatch (Codex)'));

  const v2Response = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-sol effort=low] old [sidequest-route model=gpt-5.6-terra effort=xhigh] newest' }],
    output_config: { preserve: true },
  }));
  assert.equal(v2Response.status, 200);
  assert.equal(forwarded[0].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[0].output_config, { preserve: true, effort: 'xhigh' });
  assert.equal(JSON.parse(v2Response.body).model, 'claude-codex-auto');

  const v1Response = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-sol effort=low] superseded [sidequest-route model=gpt-5.6-terra]' }],
  }));
  assert.equal(v1Response.status, 200);
  assert.equal(forwarded[1].model, 'gpt-5.6-terra');
  assert.equal('output_config' in forwarded[1], false);

  const invalidEffortResponse = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=high] valid [sidequest-route model=gpt-5.6-sol effort=invalid] ignored' }],
  }));
  assert.equal(invalidEffortResponse.status, 200);
  assert.equal(forwarded[2].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[2].output_config, { effort: 'high' });

  const routes = fs.readFileSync(routeLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual({ backend: routes[0].backend, model: routes[0].model, via: routes[0].via, effort: routes[0].effort }, {
    backend: 'codex', model: 'gpt-5.6-terra', via: 'dispatch', effort: 'xhigh',
  });
});

test('dispatch model rejects missing and malformed route markers', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  for (const content of ['no route marker', '[sidequest-route model=GPT-5.6-terra]']) {
    const response = await request(shimPort, '/v1/messages', JSON.stringify({
      model: 'claude-codex-auto', messages: [{ role: 'user', content }],
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'codex-gateway: dispatch model requires a [sidequest-route model=...] marker in the conversation; redispatch the ticket',
      },
    });
  }
});

test('buildCatalog excludes the dispatch model', () => {
  const catalog = gw.buildCatalog(['claude-codex-auto', 'claude-codex-gpt-5.6-terra']);
  assert.deepEqual(catalog.models.map((model) => model.id), ['claude-codex-gpt-5.6-terra']);
});
