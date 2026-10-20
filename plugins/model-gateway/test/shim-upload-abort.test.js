'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

const TIMEOUT_MS = 5000;
const FIRST_EVENT = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const LAST_EVENT = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function heldStreamProxy(t) {
  let stream;
  let messages = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    req.resume();
    req.once('end', () => {
      messages += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      stream = res;
      res.write(FIRST_EVENT);
    });
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port, finish: () => stream.end(LAST_EVENT), messages: () => messages };
}

function startSiblingStream(t, port) {
  let firstEvent;
  const started = new Promise((resolve) => { firstEvent = resolve; });
  const completed = new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-gpt-5.6-sol', max_tokens: 512, stream: true,
      messages: [{ role: 'user', content: 'synthetic sibling' }],
    });
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      let received = '';
      response.on('data', (chunk) => {
        received += chunk;
        if (received.includes(FIRST_EVENT)) firstEvent(true);
      });
      response.once('end', () => resolve({ status: response.statusCode, complete: response.complete, body: received }));
      response.once('error', (error) => resolve({ error: error.code, body: received }));
    });
    request.once('error', (error) => { firstEvent(false); resolve({ error: error.code }); });
    request.setTimeout(TIMEOUT_MS, () => { firstEvent(false); request.destroy(new Error('sibling stream timed out')); });
    t.after(() => request.destroy());
    request.end(body);
  });
  return { started, completed };
}

// Wait for the server's 100 Continue, then half-close with an incomplete body.
// Unlike destroying a just-created client request, this proves the supervisor
// accepted the headers and saw the partial upload. The server closes its side
// only after processing EOF; no sleep guesses when to abort or resume the SSE.
function abortPartialUpload(port, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    let continued = false;
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('upload did not close')));
    socket.once('error', (error) => {
      if (!continued || error.code !== 'ECONNRESET') reject(error);
    });
    socket.on('data', (chunk) => {
      received += chunk;
      if (!continued && received.includes('HTTP/1.1 100 Continue\r\n\r\n')) {
        continued = true;
        socket.end('{"action":');
      }
    });
    socket.once('close', () => {
      if (!continued) return reject(new Error(`upload was not accepted: ${received}`));
      resolve(received);
    });
    socket.once('connect', () => socket.write([
      `POST ${requestPath} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      'Content-Length: 1024',
      'Expect: 100-continue',
      'X-Model-Gateway-Control: rc-compatibility',
      '', '',
    ].join('\r\n')));
  });
}

test('upload abort fixture rejects a refused connection before 100 Continue', async () => {
  const port = await availablePort();

  await assert.rejects(abortPartialUpload(port, '/v1/messages'), { code: 'ECONNREFUSED' });
});

for (const continueUpload of [false, true]) {
  test(`upload abort fixture ${continueUpload ? 'accepts' : 'rejects'} a reset ${continueUpload ? 'after' : 'before'} 100 Continue`, async (t) => {
    const socketErrors = [];
    const connect = net.connect;
    t.mock.method(net, 'connect', (...args) => {
      const socket = connect(...args);
      socket.on('error', (error) => socketErrors.push(error.code));
      return socket;
    });
    let partial = null;
    const server = http.createServer();
    server.on('checkContinue', (req, res) => {
      req.on('error', () => {});
      if (!continueUpload) return req.socket.resetAndDestroy();
      req.once('data', (chunk) => {
        partial = chunk.toString();
        req.socket.resetAndDestroy();
      });
      res.writeContinue();
    });
    const port = await listen(server);
    t.after(() => { server.closeAllConnections(); server.close(); });

    if (continueUpload) {
      assert.equal(await abortPartialUpload(port, '/v1/messages'), 'HTTP/1.1 100 Continue\r\n\r\n');
      assert.equal(partial, '{"action":', 'the reset follows actual partial-body delivery');
    } else {
      await assert.rejects(abortPartialUpload(port, '/v1/messages'), { code: 'ECONNRESET' });
    }
    assert.deepEqual(socketErrors, ['ECONNRESET'], 'the real client socket must observe the reset');
  });
}

function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('health timed out')));
    request.once('error', reject);
  });
}

function unknownControlReply(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/internal/rc-compatibility',
      headers: { 'content-type': 'application/json', 'x-model-gateway-control': 'rc-compatibility' },
    }, (response) => {
      let received = '';
      response.on('data', (chunk) => { received += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(received) }));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('control reply timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

for (const requestPath of ['/v1/messages', '/internal/rc-compatibility']) {
  test(`aborting ${requestPath} during upload leaves the supervisor and sibling SSE alive`, { timeout: 20000 }, async (t) => {
    const proxy = await heldStreamProxy(t);
    // RC control validates the configured Host, so use a concrete isolated
    // port rather than CODEX_GATEWAY_PORT=0 for this supervisor fixture.
    const environment = gatewayTestEnvironment(t, {
      CODEX_GATEWAY_PORT: String(await availablePort()),
      CODEX_GATEWAY_PROXY_PORT: String(proxy.port),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_TELEMETRY_ENDPOINT: '0',
      CODEX_GATEWAY_USAGE_ENDPOINT: '0',
    });
    const { child, port } = await startGateway(t, 'serve-shim', environment);
    let supervisorErrors = '';
    child.stderr.on('data', (chunk) => { supervisorErrors += chunk; });
    const initial = await health(port);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.supervisorPid, child.pid);
    if (requestPath === '/internal/rc-compatibility') {
      for (const body of ['', '{', 'null', JSON.stringify({ expectedSupervisorPid: child.pid, action: 'unknown' })]) {
        assert.deepEqual(await unknownControlReply(port, body), {
          status: 200, body: { status: 'unknown', supervisorPid: child.pid },
        });
      }
    }
    const sibling = startSiblingStream(t, port);
    assert.equal(await sibling.started, true, 'the sibling SSE must be open before aborting the upload');

    // Node's HTTP parser may itself send 400 on the incomplete message. The
    // unit regressions separately assert that the application writes nothing.
    await abortPartialUpload(port, requestPath);
    const later = await health(port).catch((error) => {
      throw new Error(`supervisor stopped answering after upload abort (${error.code}): ${supervisorErrors}`, { cause: error });
    });
    assert.equal(later.status, 200, 'a subsequent request still succeeds');
    assert.equal(later.body.supervisorPid, initial.body.supervisorPid);
    assert.equal(child.exitCode, null, 'the same supervisor process remains live');
    proxy.finish();
    assert.deepEqual(await sibling.completed, { status: 200, complete: true, body: FIRST_EVENT + LAST_EVENT });
    assert.equal(proxy.messages(), 1, 'only the sibling request reaches the synthetic provider');

    const state = path.join(environment.HOME, '.claude', 'model-gateway');
    assert.equal(fs.existsSync(path.join(state, 'shim-supervisor-failure.txt')), false);
    const lifecycle = fs.readFileSync(path.join(state, 'logs', 'lifecycle.jsonl'), 'utf8');
    assert.doesNotMatch(lifecycle, /supervisor-uncaught-failure|worker-request-lost|worker-exit/);
  });
}
