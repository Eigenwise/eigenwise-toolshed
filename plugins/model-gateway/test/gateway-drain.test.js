'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startGateway, spawnGatewayProcess } = require('./support.js');
const { createProxyRecovery } = require('../lib/process-supervision.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gateway = require(CLI);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
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

function createCachedCli(cacheRoot, version) {
  const pluginDirectory = path.join(cacheRoot, version);
  fs.cpSync(path.join(__dirname, '..'), pluginDirectory, { recursive: true });
  const manifestPath = path.join(pluginDirectory, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return path.join(pluginDirectory, 'bin', 'model-gateway.js');
}

async function waitForChangedWorkerPid(pidFile, previousPid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (workerPid && workerPid !== previousPid) return workerPid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`worker PID did not change from ${previousPid}`);
}

async function waitForWorkerVersion(port, version) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse((await request(port, 'GET', '/healthz')).body);
      if (health.version === version) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`worker did not report version ${version}`);
}

function lifecycleRecords(home) {
  const recordPath = path.join(home, '.claude', 'model-gateway', 'logs', 'lifecycle.jsonl');
  try {
    return fs.readFileSync(recordPath, 'utf8').split(/\r?\n/).flatMap((line) => line ? [JSON.parse(line)] : []);
  } catch { return []; }
}

async function waitForLifecycleRecord(home, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const record = lifecycleRecords(home).find(predicate);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('lifecycle record was not written');
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
  });
}

test('restart with drain submits the newest installed CLI path', async (t) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-worker-cache-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const olderCliPath = createCachedCli(cacheRoot, '0.48.12');
  const newerCliPath = createCachedCli(cacheRoot, '0.48.13');
  let resolveRestart;
  const restarted = new Promise((resolve) => { resolveRestart = resolve; });
  const shim = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      resolveRestart(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(202);
      res.end();
    });
  });
  const shimPort = await listen(shim);
  t.after(() => shim.close());

  const script = `require(${JSON.stringify(path.join(path.dirname(olderCliPath), '..', 'lib', 'process-supervision.js'))}).restartWorkerWithDrain({ quiet: true }).then((result) => process.exit(result.ok ? 0 : 1))`;
  const child = spawnGatewayProcess(t, process.execPath, ['-e', script], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort) },
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(await restarted, { script: newerCliPath });
});

test('drain timeout says that the shim was force-stopped', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-drain-'));
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
  const child = spawnGatewayProcess(t, process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_WORKER_PORT: String(shimPort) },
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-drain-'));
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

  const { child, port: shimPort } = await startGateway(t, 'serve-worker', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });

  const inFlight = request(shimPort, 'POST', '/v1/messages', {
    model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1,
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
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

  const { child: supervisor, port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  const supervisorStarted = await waitForLifecycleRecord(home, (record) => record.event === 'supervisor-started');
  assert.equal(supervisorStarted.component, 'supervisor');
  assert.equal(supervisorStarted.pid, supervisor.pid);
  assert.match(supervisorStarted.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const requestPromise = request(shimPort, 'POST', '/v1/messages', {
    model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1,
  });
  while (requests === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  const pidFile = path.join(home, '.claude', 'model-gateway', 'shim.pid');
  const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(oldPid, 'SIGKILL');
  const workerExit = await waitForLifecycleRecord(home, (record) => record.event === 'worker-exit' && record.child?.pid === oldPid);
  assert.equal(workerExit.component, 'supervisor');
  assert.equal(workerExit.child.component, 'worker');
  assert.equal(Object.hasOwn(workerExit, 'exitCode'), true);
  assert.equal(workerExit.exitCode !== null || workerExit.signal != null, true);

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
  assert.equal(lifecycleRecords(home).length <= 200, true);
  assert.equal(lifecycleRecords(home).some((record) => record.event.includes('request')), false);
});

test('supervisor records an orderly signal before it exits', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows process signals terminate child processes before JavaScript can record a final supervisor event');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const { child: supervisor } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });

  supervisor.kill('SIGTERM');
  await waitForChildExit(supervisor);
  const orderlyStop = await waitForLifecycleRecord(home, (record) => record.event === 'supervisor-stop-requested');
  const supervisorExit = await waitForLifecycleRecord(home, (record) => record.event === 'supervisor-exit');
  assert.equal(orderlyStop.component, 'supervisor');
  assert.equal(orderlyStop.pid, supervisor.pid);
  assert.equal(orderlyStop.signal, 'SIGTERM');
  assert.equal(supervisorExit.pid, supervisor.pid);
  assert.equal(supervisorExit.exitCode, 0);
});

test('supervisor drains a planned worker restart without refusing connections', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let release;
  const proxy = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    release = () => res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });

  const inFlight = request(shimPort, 'POST', '/v1/messages', { model: 'claude-gpt-5.6-terra', messages: [], max_tokens: 1 });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await request(shimPort, 'POST', '/restart', {})).status, 202);
  const restartRequested = await waitForLifecycleRecord(home, (record) => record.event === 'restart-worker-requested');
  assert.equal(restartRequested.component, 'supervisor');
  assert.equal(restartRequested.outcome, 'drain');
  const health = request(shimPort, 'GET', '/healthz');
  release();
  assert.equal((await inFlight).status, 200);
  assert.equal((await health).status, 200);
});

test('restart keeps a newer installed worker script when supplied an older one', async (t) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-worker-cache-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const currentCliPath = createCachedCli(cacheRoot, '0.48.12');
  const olderCliPath = createCachedCli(cacheRoot, '0.48.11');
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { cliPath: currentCliPath });
  const pidFile = path.join(home, '.claude', 'model-gateway', 'shim.pid');
  const previousPid = Number(fs.readFileSync(pidFile, 'utf8'));

  assert.equal((await request(shimPort, 'POST', '/restart', { script: olderCliPath })).status, 202);
  await waitForChangedWorkerPid(pidFile, previousPid);
  await waitForWorkerVersion(shimPort, '0.48.12');
});

test('restart adopts a newer installed worker script', async (t) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-worker-cache-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const currentCliPath = createCachedCli(cacheRoot, '0.48.12');
  const newerCliPath = createCachedCli(cacheRoot, '0.48.13');
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { cliPath: currentCliPath });
  const pidFile = path.join(home, '.claude', 'model-gateway', 'shim.pid');
  const previousPid = Number(fs.readFileSync(pidFile, 'utf8'));

  assert.equal((await request(shimPort, 'POST', '/restart', { script: newerCliPath })).status, 202);
  await waitForChangedWorkerPid(pidFile, previousPid);
  await waitForWorkerVersion(shimPort, '0.48.13');
});

test('restart does not treat a dev-checkout worker script as newer than an installed script', async (t) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-worker-cache-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-supervisor-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const installedCliPath = createCachedCli(cacheRoot, '0.48.12');
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  const pidFile = path.join(home, '.claude', 'model-gateway', 'shim.pid');
  const previousPid = Number(fs.readFileSync(pidFile, 'utf8'));

  assert.equal((await request(shimPort, 'POST', '/restart', { script: installedCliPath })).status, 202);
  await waitForChangedWorkerPid(pidFile, previousPid);
  await waitForWorkerVersion(shimPort, '0.48.12');
});

test('a second supervisor exits when the singleton listener is already owned', async (t) => {
  const firstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-singleton-'));
  const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-singleton-'));
  t.after(() => fs.rmSync(firstHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondHome, { recursive: true, force: true }));
  const { port: shimPort } = await startGateway(t, 'serve-shim', {
    HOME: firstHome,
    USERPROFILE: firstHome,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });

  const second = await new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
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

test('older serving supervisor is replaced instead of draining its worker', async () => {
  const calls = [];
  const result = await gateway.restartShimIfOutdated({
    fetchHealth: async () => ({ version: '0.0.0', supervisorVersion: '0.0.0', proxyRecovery: true }),
    restartWorker: async () => { calls.push('worker'); return { ok: true }; },
    restartSupervisor: async () => { calls.push('supervisor'); return { ok: true }; },
  });

  assert.deepEqual(calls, ['supervisor']);
  assert.deepEqual(result, { ok: true });
});

test('newer serving supervisor stays up and tells stale sessions to reload plugins', async () => {
  const calls = [];
  const health = { version: '99.0.0', supervisorVersion: '99.0.0', proxyRecovery: true };
  const result = await gateway.restartShimIfOutdated({
    fetchHealth: async () => health,
    restartWorker: async () => { calls.push('worker'); return { ok: true }; },
    restartSupervisor: async () => { calls.push('supervisor'); return { ok: true }; },
  });

  assert.equal(result, null);
  assert.deepEqual(calls, []);
  assert.match(gateway.staleSessionReloadNotice(gateway.PLUGIN_VERSION, health), new RegExp(`loaded ${gateway.PLUGIN_VERSION.replaceAll('.', '\\.')}, but the serving shim is newer \\(99\\.0\\.0\\)`));
  assert.match(gateway.staleSessionReloadNotice(gateway.PLUGIN_VERSION, health), /\/reload-plugins or restart Claude Code/);
});

test('missing version, unparseable version, and missing proxy recovery restart the supervisor', async () => {
  for (const health of [
    { proxyRecovery: true },
    { supervisorVersion: 'not-a-version', proxyRecovery: true },
    { supervisorVersion: gateway.PLUGIN_VERSION, proxyRecovery: false },
  ]) {
    const calls = [];
    const result = await gateway.restartShimIfOutdated({
      fetchHealth: async () => health,
      restartSupervisor: async () => { calls.push('supervisor'); return { ok: true }; },
    });

    assert.deepEqual(calls, ['supervisor']);
    assert.deepEqual(result, { ok: true });
  }
});

test('newer installed sibling CLI is selected and missing cache layout keeps the invoker', (t) => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-install-cache-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const ownCliPath = path.join(cacheRoot, '0.48.8', 'bin', 'model-gateway.js');
  const newestCliPath = path.join(cacheRoot, '0.48.12', 'bin', 'model-gateway.js');
  for (const cliPath of [ownCliPath, path.join(cacheRoot, '0.48.10', 'bin', 'model-gateway.js'), newestCliPath]) {
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '');
  }

  assert.equal(gateway.resolveNewestInstalledCliPath({ cliPath: ownCliPath }), newestCliPath);
  const unavailableCliPath = path.join(cacheRoot, 'absent-cache', '0.48.8', 'bin', 'model-gateway.js');
  assert.equal(gateway.resolveNewestInstalledCliPath({ cliPath: unavailableCliPath }), unavailableCliPath);
});

test('same-version health keeps the supervisor and worker running', async () => {
  const calls = [];
  const result = await gateway.restartShimIfOutdated({
    fetchHealth: async () => ({ version: gateway.PLUGIN_VERSION, supervisorVersion: gateway.PLUGIN_VERSION, proxyRecovery: true }),
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const output = await new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, 'doctor'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_WORKER_PORT: String(shimPort) },
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
  assert.match(output.text, /lifecycle evidence: .*model-gateway[\\/]logs[\\/]lifecycle\.jsonl/);
  assert.match(output.text, /lifecycle exit evidence: no observed exit record/);
  assert.match(output.text, new RegExp(`VERSION MISMATCH: CLI ${gateway.PLUGIN_VERSION.replaceAll('.', '\\.')}, serving shim 0\\.0\\.0`));
  assert.match(output.text, new RegExp(`Run node "${CLI.replace(/[\\/]/g, '[\\\\/]')}" ensure`));
});

test('doctor describes an observed lifecycle exit', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recordPath = path.join(home, '.claude', 'model-gateway', 'logs', 'lifecycle.jsonl');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify({
    at: new Date().toISOString(),
    event: 'worker-exit',
    component: 'supervisor',
    pid: 4320,
    child: { component: 'worker', pid: 4321 },
    exitCode: null,
    signal: 'SIGKILL',
  }) + '\n');

  const output = await new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, 'doctor'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, text }));
  });

  assert.equal(output.code, 1);
  assert.match(output.text, /lifecycle exit evidence: observed worker PID 4321; exit code null; signal SIGKILL/);
});

test('supervisor restores a proxy that dies after startup without another session', async () => {
  let modelsAvailable = true;
  let starts = 0;
  const logs = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => modelsAvailable,
    listening: async () => false,
    binaryExists: () => true,
    start: () => { starts += 1; modelsAvailable = true; },
    now: () => 0,
    report: (message) => logs.push(message),
  });

  assert.equal((await recovery.recover()).state, 'healthy');
  modelsAvailable = false;
  assert.equal((await recovery.recover()).state, 'recovered');
  assert.equal(starts, 1);
  assert.match(logs.join('\n'), /^1970-01-01T00:00:00\.000Z model-gateway: proxy \/v1\/models unavailable; restart attempt 1/m);
  assert.match(logs.join('\n'), /proxy recovered and \/v1\/models is ready/);
});

test('supervisor replaces an unresponsive bound proxy only after its owner releases the port', async () => {
  let modelsAvailable = false;
  const stopped = [];
  let releaseChecks = 0;
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => modelsAvailable,
    listening: async () => true,
    owner: () => 4242,
    stop: (pid) => stopped.push(pid),
    waitForRelease: async () => { releaseChecks += 1; return true; },
    binaryExists: () => true,
    start: () => { modelsAvailable = true; },
    now: () => 0,
    report: () => {},
  });

  assert.equal((await recovery.recover()).state, 'recovered');
  assert.deepEqual(stopped, [4242]);
  assert.equal(releaseChecks, 1);
});

test('concurrent supervisor checks share one proxy recovery attempt', async () => {
  let releaseProbe;
  const probeStarted = new Promise((resolve) => { releaseProbe = resolve; });
  let starts = 0;
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => { await probeStarted; return starts > 0; },
    listening: async () => false,
    binaryExists: () => true,
    start: () => { starts += 1; releaseProbe(); },
    now: () => 0,
    report: () => {},
  });

  const first = recovery.recover();
  const second = recovery.recover();
  releaseProbe();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(firstResult.state, 'recovered');
  assert.equal(secondResult.state, 'recovered');
});
