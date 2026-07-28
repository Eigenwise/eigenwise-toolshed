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

async function waitFor(port, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/healthz');
      if (response.status === expected) return;
    } catch {
      if (expected === 'closed') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`port ${port} did not become ${expected}`);
}

test('drain timeout says that the shim was force-stopped', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-drain-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stuckShim = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/drain') {
      res.writeHead(202);
      return res.end(JSON.stringify({ ok: true }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  const shimPort = await listen(stuckShim);
  t.after(() => stuckShim.close());

  const script = `require(${JSON.stringify(CLI)}).stopShimWithDrain({ timeout: 20, report: console.log }).then((result) => console.log(JSON.stringify(result)))`;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: String(shimPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(text) : reject(new Error(`controller exited ${code}: ${text}`)));
  });

  assert.match(output, /drain timed out after 1s; force-stopping it/);
  assert.match(output, /"forced":true/);
});
test('draining shim finishes an in-flight request before it exits', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-drain-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let release;
  let proxyReceived;
  const received = new Promise((resolve) => { proxyReceived = resolve; });
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    proxyReceived();
    release = () => res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimPort = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve-worker'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitFor(shimPort, 200);

  const inFlight = request(shimPort, 'POST', '/v1/messages', {
    model: 'claude-codex-gpt-5.6-terra', messages: [], max_tokens: 1,
  });
  await received;
  const draining = await request(shimPort, 'POST', '/drain', {});
  assert.equal(draining.status, 202);

  let exited = false;
  child.once('exit', () => { exited = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(exited, false);

  release();
  const completed = await inFlight;
  assert.equal(completed.status, 200);
  await waitFor(shimPort, 'closed');
});

test('supervisor keeps its listener available while a hard-killed worker restarts', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let requests = 0;
  let release;
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    requests += 1;
    if (requests === 2) {
      release();
      return res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    }
    release = () => res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimPort = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitFor(shimPort, 200);

  const requestPromise = request(shimPort, 'POST', '/v1/messages', {
    model: 'claude-codex-gpt-5.6-terra', messages: [], max_tokens: 1,
  });
  while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const pidFile = path.join(home, '.claude', 'codex-gateway', 'shim.pid');
  const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(oldPid, 'SIGKILL');

  const refused = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await request(shimPort, 'GET', '/healthz'); } catch (error) { refused.push(error.code); }
    if (requests === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(refused.includes('ECONNREFUSED'), false);
  const completed = await requestPromise;
  assert.equal(completed.status, 200);
  assert.notEqual(Number(fs.readFileSync(pidFile, 'utf8')), oldPid);
});

test('supervisor drains a planned worker restart without refusing connections', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let release;
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    release = () => res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const shimPort = await freePort();
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitFor(shimPort, 200);

  const inFlight = request(shimPort, 'POST', '/v1/messages', { model: 'claude-codex-gpt-5.6-terra', messages: [], max_tokens: 1 });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await request(shimPort, 'POST', '/restart', {})).status, 202);
  const health = request(shimPort, 'GET', '/healthz');
  release();
  assert.equal((await inFlight).status, 200);
  assert.equal((await health).status, 200);
});

test('a second supervisor exits when the singleton listener is already owned', async (t) => {
  const firstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-singleton-'));
  const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-singleton-'));
  t.after(() => fs.rmSync(firstHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondHome, { recursive: true, force: true }));
  const shimPort = await freePort();
  const first = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, HOME: firstHome, USERPROFILE: firstHome, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
    stdio: 'ignore',
  });
  t.after(() => first.kill());
  await waitFor(shimPort, 200);

  const second = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve-shim'], {
      env: { ...process.env, HOME: secondHome, USERPROFILE: secondHome, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_REQUEST_LOG: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, text }));
  });

  assert.equal(second.code, 1);
  assert.match(second.text, /shim supervisor cannot bind/);
  assert.equal((await request(shimPort, 'GET', '/healthz')).status, 200);
});

test('version mismatch replaces the supervisor instead of draining its worker', async () => {
  const calls = [];
  const result = await gateway.restartShimIfOutdated({
    fetchHealth: async () => ({ version: '0.0.0', supervisorVersion: '0.0.0' }),
    restartWorker: async () => { calls.push('worker'); return { ok: true }; },
    restartSupervisor: async () => { calls.push('supervisor'); return { ok: true }; },
  });

  assert.deepEqual(calls, ['supervisor']);
  assert.deepEqual(result, { ok: true });
});

test('same-version health keeps the supervisor and worker running', async () => {
  const calls = [];
  const result = await gateway.restartShimIfOutdated({
    fetchHealth: async () => ({ version: gateway.PLUGIN_VERSION, supervisorVersion: gateway.PLUGIN_VERSION }),
    restartWorker: async () => { calls.push('worker'); return { ok: true }; },
    restartSupervisor: async () => { calls.push('supervisor'); return { ok: true }; },
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('doctor reports a serving version mismatch and the ensure remedy', async (t) => {
  const shim = http.createServer((req, res) => {
    if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, version: '0.0.0', supervisorVersion: '0.0.0' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    res.statusCode = 404;
    res.end();
  });
  const shimPort = await listen(shim);
  t.after(() => shim.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'doctor'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: String(shimPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, text }));
  });

  assert.equal(output.code, 1);
  assert.match(output.text, /serving shim version: 0\.0\.0/);
  assert.match(output.text, new RegExp(`VERSION MISMATCH: CLI ${gateway.PLUGIN_VERSION.replaceAll('.', '\\.')}, serving shim 0\\.0\\.0`));
  assert.match(output.text, new RegExp(`Run node "${CLI.replace(/[\\/]/g, '[\\\\/]')}" ensure`));
});
