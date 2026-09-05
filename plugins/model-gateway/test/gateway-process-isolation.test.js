'use strict';

const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcessSync, startGateway } = require('./support.js');

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

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
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
