'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startGateway } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gateway = require(CLI);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function freePortInRange(firstPort, lastPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > lastPort) return reject(new Error(`no free port between ${firstPort} and ${lastPort}`));
      const probe = net.createServer();
      probe.once('error', () => tryPort(port + 1));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
    };
    tryPort(firstPort);
  });
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const encoded = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/healthz');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`shim on ${port} did not become healthy`);
}

function runReadiness(home, proxyPort, options) {
  const script = `
    const gateway = require(${JSON.stringify(CLI)});
    const options = JSON.parse(process.argv[1]);
    const health = { ok: true, version: options.version };
    (async () => {
      if (options.block) gateway.setUpstreamBlocked({ statusCode: 429, evidence: 'headers:x-openai-request-id' });
      const before = await gateway.getCodexReadiness({
        binaryPresent: options.binary,
        authStatus: () => options.auth,
        shimHealth: health,
      });
      const afterHealthCheck = await gateway.getCodexReadiness({
        binaryPresent: options.binary,
        authStatus: () => options.auth,
        shimHealth: health,
      });
      if (options.success) gateway.noteCodexRequestSuccess();
      const afterSuccess = await gateway.getCodexReadiness({
        binaryPresent: options.binary,
        authStatus: () => options.auth,
        shimHealth: health,
      });
      process.stdout.write(JSON.stringify({ before, afterHealthCheck, afterSuccess }));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(options)], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`readiness child exited ${code}: ${stderr}`)));
  });
}

test('readiness reports each local failure state from an isolated home', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-readiness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    res.statusCode = 404;
    res.end();
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const downProxyPort = await freePort();

  const missing = await runReadiness(home, proxyPort, { binary: false, auth: false, version: gateway.PLUGIN_VERSION });
  assert.equal(missing.before.state, 'binary-missing');
  assert.match(missing.before.message, /claude-code-proxy is missing/);

  const proxyDown = await runReadiness(home, downProxyPort, { binary: true, auth: true, version: gateway.PLUGIN_VERSION });
  assert.equal(proxyDown.before.state, 'proxy-down');

  const authMissing = await runReadiness(home, proxyPort, { binary: true, auth: false, version: gateway.PLUGIN_VERSION });
  assert.equal(authMissing.before.state, 'auth-missing');
  assert.match(authMissing.before.message, /~\/.config\/claude-code-proxy\//);

  const staleShim = await runReadiness(home, proxyPort, { binary: true, auth: true, version: '0.0.0' });
  assert.equal(staleShim.before.state, 'serving-version-mismatch');

  const newerShim = await runReadiness(home, proxyPort, { binary: true, auth: true, version: '99.0.0' });
  assert.equal(newerShim.before.state, 'ready');
});

test('upstream-blocked survives a health check and clears on a successful Codex request', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-readiness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proxy = http.createServer((req, res) => res.end(JSON.stringify({ data: [] })));
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const result = await runReadiness(home, proxyPort, {
    binary: true,
    auth: true,
    version: gateway.PLUGIN_VERSION,
    block: true,
    success: true,
  });

  assert.equal(result.before.state, 'upstream-blocked');
  assert.equal(result.afterHealthCheck.state, 'upstream-blocked');
  assert.equal(result.afterSuccess.state, 'ready');
});

test('shim health retains an OpenAI rejection until a successful proxied request', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-readiness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let messages = 0;
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    messages += 1;
    if (messages === 1) {
      res.writeHead(429, { 'x-openai-request-id': 'req_test' });
      return res.end(JSON.stringify({ error: { message: 'OpenAI rate limit' } }));
    }
    return res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const supervisorPort = await freePortInRange(30000, 39999);
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PORT: String(supervisorPort),
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });

  assert.equal(shimPort, supervisorPort);
  const workerLog = fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'logs', 'shim.log'), 'utf8');
  const workerPort = Number(workerLog.match(/model-gateway shim listening on 127\.0\.0\.1:(\d+)/)[1]);
  assert.notEqual(workerPort, supervisorPort);

  const payload = { model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1 };
  assert.equal((await request(shimPort, 'POST', '/v1/messages', payload)).status, 429);
  const blockedHealth = JSON.parse((await request(shimPort, 'GET', '/healthz')).body);
  assert.equal(blockedHealth.codexReadiness.upstreamBlocked.state, 'upstream-blocked');

  assert.equal((await request(shimPort, 'POST', '/v1/messages', payload)).status, 200);
  const recoveredHealth = JSON.parse((await request(shimPort, 'GET', '/healthz')).body);
  assert.equal(recoveredHealth.codexReadiness.upstreamBlocked, null);
});

test('catalog carries provider readiness metadata for external consumers', () => {
  const readiness = {
    ready: false,
    state: 'auth-missing',
    message: 'sign in',
    checks: { codexAuth: false },
    upstreamBlocked: null,
  };
  const catalog = gateway.buildCatalog(['claude-gpt-5.6-terra'], readiness);
  assert.deepEqual(catalog.providers.codex, {
    ready: false,
    state: 'auth-missing',
    message: 'sign in',
  });
  assert.deepEqual(catalog.codexReadiness, catalog.providers.codex);
});

test('Grok readiness reports its CLI auth state', () => {
  assert.deepEqual(gateway.getGrokReadiness({ readAuth: () => {} }), {
    ready: true,
    state: 'ready',
    message: 'Grok CLI auth is present.',
  });
  assert.deepEqual(gateway.getGrokReadiness({
    readAuth: () => { throw new Error('Grok CLI auth is missing. Run `grok` and log in again.'); },
  }), {
    ready: false,
    state: 'auth-missing',
    message: 'Grok CLI auth is missing. Run `grok` and log in again.',
  });
});

test('upstream blocking only accepts explicit OpenAI evidence', () => {
  assert.equal(gateway.hasOpenAiRejectionEvidence(403, { 'x-openai-request-id': 'req_1' }, ''), true);
  assert.equal(gateway.hasOpenAiRejectionEvidence(429, {}, 'OpenAI rejected this request'), true);
  assert.equal(gateway.hasOpenAiRejectionEvidence(403, {}, 'forbidden'), false);
  assert.equal(gateway.hasOpenAiRejectionEvidence(500, { 'x-openai-request-id': 'req_1' }, ''), false);
});
