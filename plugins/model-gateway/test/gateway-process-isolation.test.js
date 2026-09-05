'use strict';

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startGateway } = require('./support.js');
const { commandResultAsync, createProxyRecovery, isDescendantOfAsync } = require('../lib/process-supervision.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const BODY_SESSION_ID = 'gateway-fixture-body-sentinel';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-claude-code-session-id': BODY_SESSION_ID,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    clientRequest.once('error', reject);
    clientRequest.end(body);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('foreign gateway fixture did not become ready')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`foreign gateway fixture exited before becoming ready (${code ?? signal})`));
    });
  });
}

function waitForOutput(child, expectedOutput) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`foreign gateway fixture did not write ${expectedOutput}`)), 5000);
    const onData = (chunk) => {
      if (!String(chunk).includes(expectedOutput)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
  });
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function descendantPids(parentPid) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object ProcessId | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', windowsHide: true });
    try {
      const entries = JSON.parse(result.stdout || '[]');
      return (Array.isArray(entries) ? entries : [entries]).map((entry) => Number(entry.ProcessId)).filter(Boolean);
    } catch { return []; }
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

// Probe children are spawned detached, so on POSIX they lead their own process
// group and only the parent pid links them to the supervisor.
function childPidsOf(parentPid) {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

async function waitForProcessesToExit(processIds, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !processIsRunning(pid))) return;
    await pause(20);
  }
  assert.deepEqual(processIds.filter(processIsRunning), [], 'probe child survived its supervisor');
}

function installNodeProxy(home) {
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outerSocketPath(home) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-outer-${process.pid}-${Date.now()}`
    : path.join(home, 'outer-gateway.sock');
}

function socketIsListening(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function setOuterGatewayEnvironment(t, home, endpointPort) {
  const temporaryDirectory = path.join(home, 'temporary');
  const bodyDirectory = path.join(home, 'request-body');
  const codexHome = path.join(home, 'codex-home');
  const socketPath = outerSocketPath(home);
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  fs.mkdirSync(bodyDirectory, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const sentinels = [
    [path.join(home, '.claude', 'model-gateway', 'shim.pid'), 'outer-pid'],
    [path.join(home, '.claude', 'model-gateway', 'logs', 'shim.log'), 'outer-log'],
    [path.join(home, '.claude', 'cache', 'gateway-models.json'), 'outer-cache'],
    [path.join(bodyDirectory, 'outer-body.json'), 'outer-body'],
    [path.join(codexHome, 'config.toml'), 'outer-codex-home'],
  ];
  for (const [filePath, contents] of sentinels) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  const previous = {};
  const values = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    MODEL_GATEWAY_REQUEST_BODY_DIR: bodyDirectory,
    ANTHROPIC_UNIX_SOCKET: socketPath,
    CODEX_HOME: codexHome,
    CODEX_GATEWAY_PORT: String(endpointPort),
    CODEX_GATEWAY_WORKER_PORT: String(endpointPort),
    CODEX_GATEWAY_PROXY_PORT: String(endpointPort),
    CODEX_GATEWAY_SOCKET_PATH: socketPath,
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { bodyDirectory, codexHome, sentinels, socketPath, temporaryDirectory };
}

function assertSentinelsUnchanged(sentinels) {
  for (const [filePath, contents] of sentinels) assert.equal(fs.readFileSync(filePath, 'utf8'), contents, filePath);
}

function assertNoBodyRecord(bodyDirectory) {
  const recordPath = path.join(bodyDirectory, `${Buffer.from(BODY_SESSION_ID).toString('base64url')}.json`);
  assert.equal(fs.existsSync(recordPath), false, recordPath);
}

function testHomes(directory) {
  return new Set(fs.readdirSync(directory).filter((entry) => entry.startsWith('model-gateway-test-')));
}

function assertSameEntries(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function codexMessage() {
  return JSON.stringify({
    model: 'claude-gpt-5.6-terra',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'fixture isolation' }],
  });
}

test('gateway fixture processes isolate outer body, socket, and Codex state', async (t) => {
  const outerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-'));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  let defaultContacts = 0;
  const defaultEndpoint = http.createServer((request, response) => {
    defaultContacts += 1;
    response.writeHead(502);
    response.end();
  });
  const defaultPort = await listen(defaultEndpoint);
  t.after(() => defaultEndpoint.close());
  const outer = setOuterGatewayEnvironment(t, outerHome, defaultPort);

  const isolatedEnvironment = gatewayTestEnvironment(t, { ...process.env });
  assert.notEqual(isolatedEnvironment.HOME, outerHome);
  assert.notEqual(isolatedEnvironment.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_PORT, String(defaultPort));
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_SOCKET_PATH, process.env.CODEX_GATEWAY_SOCKET_PATH);

  const proxy = http.createServer((proxyRequest, proxyResponse) => {
    if (proxyRequest.url === '/v1/models') return proxyResponse.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    proxyRequest.resume();
    proxyRequest.once('end', () => proxyResponse.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] })));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const started = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  assert.equal(await request(started.port, codexMessage()), 200);
  assert.equal(defaultContacts, 0);
  assertSentinelsUnchanged(outer.sentinels);
  assertNoBodyRecord(outer.bodyDirectory);
  assert.equal(await socketIsListening(outer.socketPath), false);
  assert.notEqual(isolatedEnvironment.MODEL_GATEWAY_REQUEST_BODY_DIR, outer.bodyDirectory);
  assert.notEqual(isolatedEnvironment.CODEX_HOME, outer.codexHome);
  assert.equal(isolatedEnvironment.ANTHROPIC_UNIX_SOCKET, undefined);
  started.child.kill();
  await waitForExit(started.child);

  const negativeControl = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { isolatedOverrides: { MODEL_GATEWAY_REQUEST_BODY_DIR: outer.bodyDirectory } });
  assert.equal(await request(negativeControl.port, codexMessage()), 200);
  negativeControl.child.kill();
  await waitForExit(negativeControl.child);
  assert.throws(() => assertNoBodyRecord(outer.bodyDirectory), /true !== false/);
});

test('sync gateway fixture cleanup removes helper-owned homes and preserves supplied homes', (t) => {
  const outerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-'));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  const outer = setOuterGatewayEnvironment(t, outerHome, 9);
  const before = testHomes(outer.temporaryDirectory);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertSameEntries(testHomes(outer.temporaryDirectory), before);

  const suppliedHome = path.join(outerHome, 'supplied-home');
  fs.mkdirSync(suppliedHome);
  const suppliedResult = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], {
    encoding: 'utf8',
    env: { HOME: suppliedHome, USERPROFILE: suppliedHome },
  });
  assert.equal(suppliedResult.status, 0, suppliedResult.stderr);
  assert.equal(fs.existsSync(suppliedHome), true);
});

test('isolated ensure preserves a foreign serve-shim process and cleans its own supervisor', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-isolation-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.writeFileSync(foreignScript, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });

  const guardianPid = Number(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'guardian.pid'), 'utf8'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(processIsRunning(foreign.pid), true, 'foreign serve-shim process survived isolated ensure');
  assert.equal(processIsRunning(guardianPid), false, 'sync fixture cleanup stopped its supervisor');
});

test('foreign configured-port supervisor is preserved and reported', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-port-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => response.end(JSON.stringify({ proxyRecovery: true }))); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));\n`);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const testOptions = {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: String(port),
      CODEX_GATEWAY_WORKER_PORT: String(port),
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  };
  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], testOptions);
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], testOptions);
  const diagnosed = spawnGatewayProcessSync(process.execPath, [CLI, 'doctor'], testOptions);
  const foreignRoot = path.dirname(path.dirname(foreignScript));

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(diagnosed.stdout, new RegExp(`shim supervisor conflict: PID ${foreign.pid} owns :${port} from a different install root`));
  assert.match(diagnosed.stdout, new RegExp(foreignRoot.replace(/[\\\\/]/g, '[\\\\\\\\/]')));
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port supervisor survived ensure and stop');
});

test('proxy recovery preserves a foreign configured-port proxy owner', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-proxy-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => { process.stdout.write('models\\n'); response.writeHead(503); response.end('unhealthy'); }); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => {
    if (processIsRunning(foreign.pid)) foreign.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);
  const proxyProbe = waitForOutput(foreign, 'models\n');
  installNodeProxy(home);

  const supervisor = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: String(port),
      CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS: '20',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    supervisor.kill();
    await waitForExit(supervisor);
  });
  await waitForReady(supervisor);
  await proxyProbe;
  await pause(2000);

  assert.equal(processIsRunning(supervisor.pid), true, 'this install supervisor stays running after the conflict');
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port proxy survives recovery');
});

test('ensure and stop discard a stale guardian PID without killing its reused process', async (t) => {
  const ensureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-ensure-'));
  const stopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-stop-'));
  const ensureSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const stopSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    ensureSleeper.kill();
    stopSleeper.kill();
    await Promise.all([waitForExit(ensureSleeper), waitForExit(stopSleeper)]);
    fs.rmSync(ensureHome, { recursive: true, force: true });
    fs.rmSync(stopHome, { recursive: true, force: true });
  });
  installNodeProxy(ensureHome);
  for (const [home, sleeper] of [[ensureHome, ensureSleeper], [stopHome, stopSleeper]]) {
    const state = path.join(home, '.claude', 'model-gateway');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'guardian.pid'), String(sleeper.pid));
  }

  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: ensureHome, USERPROFILE: ensureHome },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], {
    encoding: 'utf8',
    env: { HOME: stopHome, USERPROFILE: stopHome },
  });

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(processIsRunning(ensureSleeper.pid), true, 'ensure preserved the reused non-gateway process');
  assert.match(ensured.stderr, new RegExp(`stale pid file guardian: PID ${ensureSleeper.pid} is now`));
  assert.notEqual(Number(fs.readFileSync(path.join(ensureHome, '.claude', 'model-gateway', 'guardian.pid'), 'utf8')), ensureSleeper.pid);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, new RegExp(`stale pid file guardian: PID ${stopSleeper.pid} is now`));
  assert.equal(fs.existsSync(path.join(stopHome, '.claude', 'model-gateway', 'guardian.pid')), false);
  assert.equal(processIsRunning(stopSleeper.pid), true, 'stop preserved the reused non-gateway process');
});

test('setup restart path refuses a foreign shim before it can restart its worker', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-setup-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const { spawn } = require('node:child_process'); const http = require('node:http'); const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); const server = http.createServer((request, response) => { if (request.url === '/restart') worker.kill(); response.end(JSON.stringify({ workerPid: worker.pid })); }); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n')); process.on('SIGTERM', () => { worker.kill(); server.close(() => process.exit(0)); });`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).once('error', reject);
  });
  const script = `const supervision = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))}); supervision.restartWorkerWithDrain({ quiet: true }).then((result) => { if (!result.ok) console.error(result.reason); process.exit(result.ok ? 0 : 1); });`;
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: { CODEX_GATEWAY_PORT: String(port) },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(processIsRunning(health.workerPid), true, 'foreign shim worker survives setup restart refusal');
  assert.match(result.stderr, new RegExp(`refusing to stop PID ${foreign.pid} on :${port}; it belongs to a different install root`));
});


test('supervisor health remains responsive while a timed-out ownership probe defers recovery', async (t) => {
  const supervisor = http.createServer((request, response) => response.end(JSON.stringify({ ok: true })));
  const supervisorPort = await listen(supervisor);
  t.after(() => supervisor.close());
  const lifecycle = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => false,
    listening: async () => true,
    owner: async () => {
      const probe = await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 20 });
      return probe.timedOut ? undefined : null;
    },
    binaryExists: () => true,
    recordLifecycle: (event, details) => lifecycle.push({ event, details }),
    now: () => Date.now(),
    report: () => {},
  });
  const recoveryAttempt = recovery.recover();
  const startedAt = Date.now();
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${supervisorPort}/healthz`, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, elapsedMs: Date.now() - startedAt }));
    }).once('error', reject);
  });
  const outcome = await recoveryAttempt;

  assert.equal(health.status, 200);
  assert.ok(health.elapsedMs < 500, `health waited ${health.elapsedMs}ms for the ownership probe`);
  assert.equal(outcome.state, 'owner-unknown');
  assert.equal(lifecycle.at(-1)?.details.outcome, 'owner-unknown');
});

test('supervisor shutdown reaps a timed probe child before fixture cleanup', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-child-'));
  const supervisionPath = path.join(__dirname, '..', 'lib', 'process-supervision.js');
  const supervisorScript = `
    const { commandResultAsync, createProbeChildRegistry, createProxyRecovery } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))});
    const probeChildren = createProbeChildRegistry();
    const recovery = createProxyRecovery({
      probeChildren,
      probe: async () => false,
      listening: async () => true,
      owner: async () => {
        await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 10000, probeChildren });
        return undefined;
      },
      binaryExists: () => true,
      report: () => {},
    });
    async function stop() { await recovery.stop(); process.exit(0); }
    process.once('SIGTERM', stop);
    process.once('message', stop);
    void recovery.recover();
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const supervisor = spawn(process.execPath, ['-e', supervisorScript], {
    cwd: home,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (processIsRunning(supervisor.pid)) supervisor.kill();
    await waitForExit(supervisor);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(supervisor);
  await pause(50);

  const probePids = process.platform === 'win32'
    ? descendantPids(supervisor.pid)
    : childPidsOf(supervisor.pid);
  assert.ok(probePids.length > 0, `no timed probe child found for ${supervisionPath}`);
  if (process.platform === 'win32') supervisor.send('stop');
  else supervisor.kill('SIGTERM');
  await waitForExit(supervisor);
  await waitForProcessesToExit(probePids);
  assert.doesNotThrow(() => fs.rmSync(home, { recursive: true, force: true }));
});

test('async parent ownership walk reads the process table once', async () => {
  let processQueries = 0;
  const processes = new Map([
    [903, { parentPid: 902 }],
    [902, { parentPid: 901 }],
    [901, { parentPid: null }],
  ]);

  assert.equal(await isDescendantOfAsync(903, 901, {
    processTable: async () => {
      processQueries += 1;
      return processes;
    },
  }), true);
  assert.equal(processQueries, 1);
});
