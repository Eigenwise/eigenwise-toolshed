'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gw = require(CLI);
const remoteControl = require('../lib/remote-control.js');
const { unsafeRemoteControlProcessEnv } = require('../lib/settings-wiring.js');
const { createHostsBypassResolver } = require('../lib/request-worker.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, method, pathname, body, host = '127.0.0.1', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: pathname,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function runGatewayCommand(argumentsList, environment, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argumentsList], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, output: Buffer.concat(output).toString() }));
  });
}

function loadGatewayWithEnvironment(environment) {
  const modulePaths = [
    require.resolve(CLI),
    require.resolve('../lib/commands.js'),
    require.resolve('../lib/remote-control.js'),
    require.resolve('../lib/runtime.js'),
  ];
  const cachedModules = new Map(modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]));
  const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const modulePath of modulePaths) delete require.cache[modulePath];
  const isolatedGateway = require(CLI);
  for (const modulePath of modulePaths) {
    delete require.cache[modulePath];
    if (cachedModules.get(modulePath)) require.cache[modulePath] = cachedModules.get(modulePath);
  }
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return isolatedGateway;
}
function requestSocket(socketPath, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (!child.closed) await once(child, 'close');
}

function spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home, anthropicUpstream, socketPath }) {
  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
      CODEX_GATEWAY_HOSTS_FILE: hostsFile,
      ...(socketPath ? { CODEX_GATEWAY_SOCKET_PATH: socketPath } : {}),
      ...(anthropicUpstream ? { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: anthropicUpstream } : {}),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return child;
}

function loadGatewayWithCurrentHome() {
  const cachedGateway = require.cache[CLI];
  delete require.cache[CLI];
  const isolatedGateway = require(CLI);
  if (cachedGateway) require.cache[CLI] = cachedGateway;
  return isolatedGateway;
}

async function waitForHealthz(port, host = '127.0.0.1') {
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/healthz', undefined, host);
      if (response.status === 200) return JSON.parse(response.body);
    } catch (e) { lastErr = e; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const reason = lastErr ? ` Last error: ${lastErr.message}.` : '';
  throw new Error(`Shim at ${host}:${port} did not become healthy within 5000ms.${reason}`);
}

async function waitForSocketHealthz(socketPath) {
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const response = await requestSocket(socketPath, 'GET', '/healthz');
      if (response.status === 200) return JSON.parse(response.body);
    } catch (error) { lastErr = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const reason = lastErr ? ` Last error: ${lastErr.message}.` : '';
  throw new Error(`Shim at ${socketPath} did not become healthy within 5000ms.${reason}`);
}

// ---------------------------------------------------- hosts syntax parsing

test('parseHostsCompatEntry recognizes the managed entry across Windows/macOS/Linux hosts syntaxes', () => {
  const positive = [
    '127.0.0.1 api.anthropic.com',
    '127.0.0.1\tapi.anthropic.com',
    '127.0.0.1   api.anthropic.com   # model-gateway RC compatibility',
    '  127.0.0.1  api.anthropic.com  ',
    '127.0.0.1 API.ANTHROPIC.COM',
    '127.0.0.1 other.example.com api.anthropic.com',
    '::1 api.anthropic.com',
    '127.0.0.1 api.anthropic.com.', // trailing FQDN dot
  ];
  for (const line of positive) {
    const entry = gw.parseHostsCompatEntry(line + '\r\n');
    assert.ok(entry, `expected a match for: ${JSON.stringify(line)}`);
    assert.ok(['127.0.0.1', '::1'].includes(entry.ip));
  }

  const negative = [
    '# 127.0.0.1 api.anthropic.com',
    '192.168.1.50 api.anthropic.com',
    '127.0.0.1 notapi.anthropic.com',
    '127.0.0.1 api.anthropic.com.evil.example',
    '127.0.0.1 someotherhost.com',
    '',
    '   ',
  ];
  for (const line of negative) {
    assert.equal(gw.parseHostsCompatEntry(line + '\n'), null, `expected no match for: ${JSON.stringify(line)}`);
  }
});

test('parseHostsCompatEntry scans a full multi-line hosts file and stops at the first match', () => {
  const text = [
    '# managed by model-gateway',
    '255.255.255.255 broadcast.example',
    '127.0.0.1 localhost',
    '127.0.0.1 api.anthropic.com',
    '::1 api.anthropic.com',
  ].join('\r\n');
  const entry = gw.parseHostsCompatEntry(text);
  assert.deepEqual(entry, { ip: '127.0.0.1', line: '127.0.0.1 api.anthropic.com' });
});

test('parseHostsCompatBlock identifies absent, partial, valid, and invalid plugin blocks', () => {
  assert.equal(gw.parseHostsCompatBlock('127.0.0.1 localhost\n').state, 'absent');
  assert.equal(gw.parseHostsCompatBlock('# >>> model-gateway RC compatibility >>>\n').state, 'partial');
  assert.equal(gw.parseHostsCompatBlock('# <<< model-gateway RC compatibility <<<\n').state, 'partial');
  assert.equal(gw.parseHostsCompatBlock(gw.managedHostsBlock()).state, 'valid');
  assert.equal(gw.parseHostsCompatBlock('# >>> model-gateway RC compatibility >>>\n127.0.0.1 localhost\n# <<< model-gateway RC compatibility <<<\n').state, 'invalid');
});

test('addManagedHostsBlock and removeManagedHostsBlock preserve unrelated hosts content', () => {
  const original = '127.0.0.1 localhost\n192.168.1.20 internal.example\n';
  const added = gw.addManagedHostsBlock(original);
  assert.equal(added.changed, true);
  assert.match(added.text, /127\.0\.0\.1 localhost/);
  assert.match(added.text, /192\.168\.1\.20 internal\.example/);
  assert.match(added.text, /127\.0\.0\.1 api\.anthropic\.com/);
  assert.equal(gw.addManagedHostsBlock(added.text).changed, false);

  const removed = gw.removeManagedHostsBlock(added.text);
  assert.equal(removed.changed, true);
  assert.equal(removed.text, original);
  assert.equal(gw.removeManagedHostsBlock(removed.text).changed, false);
});

test('managed hosts transforms reject partial blocks and doctor finds non-loopback conflicts', () => {
  assert.throws(() => gw.addManagedHostsBlock('# >>> model-gateway RC compatibility >>>\n'), /partial/);
  assert.throws(() => gw.removeManagedHostsBlock('# <<< model-gateway RC compatibility <<<\n'), /partial/);
  assert.deepEqual(
    gw.findConflictingHostsMappings('203.0.113.4 api.anthropic.com\n127.0.0.1 api.anthropic.com\n'),
    ['203.0.113.4 api.anthropic.com'],
  );
});

test('remote-control enable adopts unmarked loopback mappings and distinguishes confirmed writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-'));
  const hostsFile = path.join(dir, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;

  const output = [];
  let startCalls = 0;
  function configure(args, compatibilityPortConflict = () => null) {
    remoteControl.configureRemoteControl({
      args,
      flag: (value) => args.includes(value),
      log: (message) => output.push(message),
      die: (message) => { throw new Error(message); },
      doctor: async () => {},
      fetchShimHealth: async () => ({ ok: true, supervisorPid: 321, models: 1, compat: { hostsDetected: true, port80Bound: true } }),
      requestServingCompatibility: async ({ action }) => ({ status: action === 'probe' ? 'bindable' : 'bound', supervisorPid: 321 }),
      startAll: async () => {
        startCalls += 1;
        return { ok: true };
      },
      syncCompatMode: async () => ({ mode: 'compat' }),
      compatibilityPortConflict,
    });
  }

  const original = '127.0.0.1 localhost\n  127.0.0.1\tapi.anthropic.com  # keep this\n';
  fs.writeFileSync(hostsFile, original);
  const adopted = gw.addManagedHostsBlock(original);
  assert.equal(adopted.changed, true);
  assert.match(adopted.text, /# >>> model-gateway RC compatibility >>>\n  127\.0\.0\.1\tapi\.anthropic\.com  # keep this\n# <<< model-gateway RC compatibility <<</);
  assert.equal((adopted.text.match(/api\.anthropic\.com/g) || []).length, 1);
  assert.equal(gw.addManagedHostsBlock(gw.managedHostsBlock()).changed, false);
  assert.throws(() => gw.addManagedHostsBlock('# >>> model-gateway RC compatibility >>>\n127.0.0.1 localhost\n# <<< model-gateway RC compatibility <<<\n'), /invalid/);

  configure(['doctor']);
  await remoteControl.remoteControlCommand();
  assert.match(output.join('\n'), /plugin block: absent \(unmarked loopback mapping present, enable will adopt it\)/);
  assert.match(output.join('\n'), /Remote Control transport: this bind check covers the local HTTP listener only; it does not verify end-to-end Remote Control\./);

  output.length = 0;
  configure(['enable']);
  await remoteControl.remoteControlCommand();
  assert.match(output.join('\n'), /Do you want to make this hosts-file change/);

  output.length = 0;
  configure(['enable', '--confirm'], () => 'port 80: held by node.exe (PID 321). RC-compatibility cannot start until that process releases port 80.');
  await remoteControl.remoteControlCommand();
  const enabled = fs.readFileSync(hostsFile, 'utf8');
  assert.equal((enabled.match(/api\.anthropic\.com/g) || []).length, 1);
  assert.match(enabled, /# >>> model-gateway RC compatibility >>>/);
  assert.match(enabled, /# <<< model-gateway RC compatibility <<</);
  assert.match(output.join('\n'), /updated hosts file:/);
  assert.doesNotMatch(output.join('\n'), /Do you want to make this hosts-file change|Notepad as Administrator/);
  assert.equal(startCalls, 0);

  fs.writeFileSync(hostsFile, gw.managedHostsBlock());
  output.length = 0;
  configure(['enable', '--confirm']);
  await remoteControl.remoteControlCommand();
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), gw.managedHostsBlock());
  assert.equal(startCalls, 0);
  assert.match(output.join('\n'), /already enabled/);

  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  output.length = 0;
  configure(['enable', '--confirm']);
  await remoteControl.remoteControlCommand();
  assert.match(output.join('\n'), /RC-compatibility transport: ready after Claude Code restarts with http:\/\/api\.anthropic\.com/);
  assert.match(output.join('\n'), /Remote Control end-to-end: not verified for reported Claude Code 2\.1\.259 or inspected 2\.1\.267; inspected session creation uses HTTPS while compatibility transport is HTTP\./);
});

test('remote-control enable refuses a port conflict before hosts writes and names Docker Desktop', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-port-conflict-'));
  const hostsFile = path.join(directory, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const original = '127.0.0.1 localhost\n';
  fs.writeFileSync(hostsFile, original);
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;
  let startCalls = 0;
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => ({ ok: true, models: 1, compat: { port80Bound: true } }),
    requestServingCompatibility: async () => ({ status: 'unavailable', code: 'EADDRINUSE' }),
    startAll: async () => {
      startCalls += 1;
      return { ok: true };
    },
    syncCompatMode: async () => {},
    compatibilityPortConflict: () => 'port 80: held by Docker Desktop (com.docker.backend.exe, PID 71488). RC-compatibility cannot start until Docker Desktop releases port 80.',
  });

  await assert.rejects(
    remoteControl.remoteControlCommand(),
    /held by Docker Desktop \(com\.docker\.backend\.exe, PID 71488\).*cannot start until Docker Desktop releases port 80/,
  );
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);
  assert.equal(startCalls, 0);
});

test('remote-control enable refuses an HTTPS process override before hosts backup or reconciliation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-process-env-'));
  const hostsFile = path.join(directory, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const original = '127.0.0.1 localhost\n';
  fs.writeFileSync(hostsFile, original);
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;

  for (const baseUrl of ['https://api.anthropic.com', 'HTTPS://API.ANTHROPIC.COM:443/']) {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    let startCalls = 0;
    let syncCalls = 0;
    remoteControl.configureRemoteControl({
      args: ['enable', '--confirm'],
      flag: (value) => ['enable', '--confirm'].includes(value),
      log: () => {},
      die: (message) => { throw new Error(message); },
      doctor: async () => {},
      fetchShimHealth: async () => ({ ok: true, supervisorPid: 321, models: 1, compat: { hostsDetected: true, port80Bound: true } }),
      requestServingCompatibility: async ({ action }) => ({ status: action === 'probe' ? 'bindable' : 'bound', supervisorPid: 321 }),
      startAll: async () => {
        startCalls += 1;
        return { ok: true };
      },
      syncCompatMode: async () => { syncCalls += 1; },
      unsafeRemoteControlProcessEnv,
    });

    await assert.rejects(remoteControl.remoteControlCommand(), (error) => {
      assert.match(error.message, /unsupported TLS endpoint/);
      assert.match(error.message, /user-controlled Claude Code CLI launch can correct or unset ANTHROPIC_BASE_URL/);
      assert.match(error.message, /If a host replaces it, use the supported Claude Code CLI on this wired project/);
      assert.match(error.message, /Desktop routing is unsupported under forced overrides on Windows and macOS/);
      assert.match(error.message, /Settings, parent, and User-scope edits cannot be promised to win/);
      assert.doesNotMatch(error.message, /Correct ANTHROPIC_BASE_URL in the launching environment/);
      assert.doesNotMatch(error.message, /Desktop.*(?:repair|restore|correct)/i);
      return true;
    });
    assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory), ['hosts']);
    assert.equal(startCalls, 0);
    assert.equal(syncCalls, 0);
  }

  remoteControl.configureRemoteControl({
    args: ['disable'],
    flag: (value) => value === 'disable',
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => null,
    startAll: async () => ({ ok: true }),
    syncCompatMode: async () => {},
    unsafeRemoteControlProcessEnv: () => { throw new Error('disable must remain available'); },
  });
  await remoteControl.remoteControlCommand();
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);
});

test('remote-control enable refuses unbindable serving before backup or hosts writes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-serving-'));
  const hostsFile = path.join(directory, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  const original = '127.0.0.1 localhost\n';
  fs.writeFileSync(hostsFile, original);
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let starts = 0;
  let syncs = 0;
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => { throw new Error('must not read health after preflight refusal'); },
    requestServingCompatibility: async () => ({ status: 'unavailable', code: 'EACCES' }),
    startAll: async () => { starts += 1; return { ok: true }; },
    syncCompatMode: async () => { syncs += 1; },
    compatibilityPortConflict: () => null,
    unsafeRemoteControlProcessEnv: () => null,
  });
  await assert.rejects(remoteControl.remoteControlCommand(), /serving supervisor is unavailable \(EACCES\)/);
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['hosts']);
  assert.equal(starts, 0);
  assert.equal(syncs, 0);
});

test('remote-control enable rolls back only its own hosts bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-rollback-'));
  const hostsFile = path.join(directory, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  const original = '127.0.0.1 localhost\n';
  fs.writeFileSync(hostsFile, original);
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let action = 0;
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => ({ ok: true, supervisorPid: 12, compat: { hostsDetected: true, port80Bound: true } }),
    requestServingCompatibility: async () => {
      action += 1;
      return action === 1 ? { status: 'bindable', supervisorPid: 12 } : { status: 'unknown' };
    },
    startAll: async () => ({ ok: true }),
    syncCompatMode: async () => {},
    compatibilityPortConflict: () => null,
    unsafeRemoteControlProcessEnv: () => null,
  });
  await assert.rejects(remoteControl.remoteControlCommand(), /gateway reconciliation failed/);
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.bak')).length, 1);

  action = 0;
  fs.writeFileSync(hostsFile, original);
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => ({ ok: true, supervisorPid: 12, compat: { hostsDetected: true, port80Bound: true } }),
    requestServingCompatibility: async ({ action: requestedAction }) => {
      action += 1;
      if (action === 1) return { status: 'bindable', supervisorPid: 12 };
      if (requestedAction === 'reconcile') fs.writeFileSync(hostsFile, '127.0.0.1 externally-edited.example\n');
      return { status: 'unknown' };
    },
    startAll: async () => ({ ok: true }),
    syncCompatMode: async () => {},
    compatibilityPortConflict: () => null,
    unsafeRemoteControlProcessEnv: () => null,
  });
  await assert.rejects(remoteControl.remoteControlCommand(), /gateway reconciliation failed/);
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), '127.0.0.1 externally-edited.example\n');
});

test('remote-control enable rolls back when required wiring does not attest compat', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-sync-'));
  const hostsFile = path.join(directory, 'hosts');
  const previousHostsFile = process.env.CODEX_GATEWAY_HOSTS_FILE;
  const original = '127.0.0.1 localhost\n';
  fs.writeFileSync(hostsFile, original);
  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;
  t.after(() => {
    if (previousHostsFile === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = previousHostsFile;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => ({ ok: true, supervisorPid: 12, compat: { hostsDetected: true, port80Bound: true } }),
    requestServingCompatibility: async ({ action }) => ({ status: action === 'probe' ? 'bindable' : 'bound', supervisorPid: 12 }),
    startAll: async () => ({ ok: true }),
    syncCompatMode: async () => undefined,
    unsafeRemoteControlProcessEnv: () => null,
  });
  await assert.rejects(remoteControl.remoteControlCommand(), /wiring synchronization achieved unknown mode instead of compat/);
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), original);

  fs.writeFileSync(hostsFile, original);
  remoteControl.configureRemoteControl({
    args: ['enable', '--confirm'],
    flag: (value) => ['enable', '--confirm'].includes(value),
    log: () => {},
    die: (message) => { throw new Error(message); },
    doctor: async () => {},
    fetchShimHealth: async () => ({ ok: true, supervisorPid: 12, compat: { hostsDetected: true, port80Bound: true } }),
    requestServingCompatibility: async ({ action }) => ({ status: action === 'probe' ? 'bindable' : 'bound', supervisorPid: 12 }),
    startAll: async () => ({ ok: true }),
    syncCompatMode: async () => {
      fs.writeFileSync(hostsFile, '127.0.0.1 externally-edited.example\n');
      return { mode: 'default' };
    },
    unsafeRemoteControlProcessEnv: () => null,
  });
  await assert.rejects(remoteControl.remoteControlCommand(), /wiring synchronization achieved default mode instead of compat/);
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), '127.0.0.1 externally-edited.example\n');
});

test('remote-control CLI adopts an unmarked mapping from its serving supervisor', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-cli-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-cli-project-'));
  const callerProject = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-remote-control-cli-caller-'));
  const projectSettings = path.join(project, '.claude', 'settings.local.json');
  const callerSettings = path.join(callerProject, '.claude', 'settings.local.json');
  const callerBytes = '{\n  "sentinel": "caller-project"\n}\n';
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  fs.mkdirSync(path.dirname(callerSettings), { recursive: true });
  fs.writeFileSync(projectSettings, JSON.stringify({ env: gw.envBlockFor('default') }));
  fs.writeFileSync(callerSettings, callerBytes);
  const cleanupProjectFixtures = () => {
    for (const directory of [project, callerProject]) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  const hostsFile = path.join(home, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 api.anthropic.com\n');
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();
  const shim = spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home });
  shim.once('close', cleanupProjectFixtures);
  const health = await waitForHealthz(shimPort);
  assert.equal(health.supervisorPid, shim.pid);
  assert.equal(health.compat.port80Bound, true);
  const gatewayEnvironment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
    CODEX_GATEWAY_HOSTS_FILE: hostsFile,
  };
  delete gatewayEnvironment.ANTHROPIC_BASE_URL;
  delete gatewayEnvironment.CODEX_GATEWAY_WORKER_PORT;
  const command = await runGatewayCommand(['remote-control', 'enable', '--confirm'], gatewayEnvironment, project);
  assert.equal(command.exitCode, 0, command.output);
  assert.equal(JSON.parse(fs.readFileSync(projectSettings, 'utf8')).env.ANTHROPIC_BASE_URL, gw.COMPAT_BASE_URL);
  assert.equal(fs.readFileSync(callerSettings, 'utf8'), callerBytes);
  assert.match(fs.readFileSync(hostsFile, 'utf8'), /# >>> model-gateway RC compatibility >>>/);
  const activeHealth = await waitForHealthz(shimPort);
  assert.equal(activeHealth.supervisorPid, shim.pid);
  assert.equal(activeHealth.compat.port80Bound, true);
});

// ------------------------------------------------------- detectHostsCompat

test('detectHostsCompat reads an overridden path and never touches the real hosts file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-hosts-'));
  const hostsFile = path.join(dir, 'hosts');
  const prevOverride = process.env.CODEX_GATEWAY_HOSTS_FILE;
  t.after(() => {
    if (prevOverride === undefined) delete process.env.CODEX_GATEWAY_HOSTS_FILE;
    else process.env.CODEX_GATEWAY_HOSTS_FILE = prevOverride;
  });

  process.env.CODEX_GATEWAY_HOSTS_FILE = hostsFile;
  assert.equal(gw.detectHostsCompat(), null); // file doesn't exist yet

  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n127.0.0.1 api.anthropic.com\n');
  assert.deepEqual(gw.detectHostsCompat(), { ip: '127.0.0.1', line: '127.0.0.1 api.anthropic.com' });

  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n'); // entry removed
  assert.equal(gw.detectHostsCompat(), null);
});

// -------------------------------------------------------------- env block

test('envBlockFor differs only on ANTHROPIC_BASE_URL between modes', () => {
  const def = gw.envBlockFor('default');
  const compat = gw.envBlockFor('compat');
  assert.equal(def.ANTHROPIC_BASE_URL, gw.DEFAULT_BASE_URL);
  assert.equal(compat.ANTHROPIC_BASE_URL, gw.COMPAT_BASE_URL);
  assert.notEqual(def.ANTHROPIC_BASE_URL, compat.ANTHROPIC_BASE_URL);
  const { ANTHROPIC_BASE_URL: _a, ...defRest } = def;
  const { ANTHROPIC_BASE_URL: _b, ...compatRest } = compat;
  assert.deepEqual(defRest, compatRest);
});

test('syncCompatMode attests default without writing fallback when required compat health is unavailable', async () => {
  const shimPort = await freePort();
  const isolatedGateway = loadGatewayWithEnvironment({
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_WORKER_PORT: undefined,
  });
  const synchronized = await isolatedGateway.syncCompatMode({ requiredMode: 'compat' });
  assert.equal(synchronized.mode, 'default');
  assert.equal(synchronized.changed, false);
});

test('writeEnv removes retired socket wiring while preserving unrelated settings', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-writeenv-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-writeenv-project-'));
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  // wiredMode() reads the environment too, and this suite runs inside a wired
  // Claude Code session, so the ambient base URL has to go or the file under
  // test is not what is being measured.
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousCwd = process.cwd();
  t.after(() => {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    process.chdir(previousCwd);
    for (const directory of [home, project]) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.chdir(project);
  delete process.env.ANTHROPIC_BASE_URL;
  const isolatedGateway = loadGatewayWithCurrentHome();

  const file = isolatedGateway.settingsPath('user');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { USER_SETTING: 'keep-me' } }));

  isolatedGateway.writeEnv('user', false, { mode: 'default', quiet: true });
  let settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, isolatedGateway.DEFAULT_BASE_URL);
  assert.equal(settings.env.ANTHROPIC_UNIX_SOCKET, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');

  settings.env.ANTHROPIC_UNIX_SOCKET = 'retired-socket-value';
  fs.writeFileSync(file, JSON.stringify(settings));

  isolatedGateway.writeEnv('user', false, { mode: 'compat', quiet: true });
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, isolatedGateway.COMPAT_BASE_URL);
  assert.equal(settings.env.ANTHROPIC_UNIX_SOCKET, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me'); // untouched across the switch
  assert.deepEqual(isolatedGateway.wiredMode(), { scope: 'user', mode: 'compat', source: 'user', file });

  isolatedGateway.writeEnv('user', true, { quiet: true }); // --remove
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_UNIX_SOCKET, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');
  assert.equal(isolatedGateway.wiredMode(), null);
});

// A project that wires itself in its own settings.local.json leaves the user
// scope empty, and setup crashed with "Cannot read properties of null (reading
// 'scope')" because isWired() saw the environment while wiredMode() only read
// the selected scope. Whatever the two disagree about, they must never disagree
// about whether anything is wired at all.
test('wiredMode agrees with isWired for environment-only and project-local wiring', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wiredmode-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-project-'));
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const directory of [home, project]) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.chdir(project);
  const isolatedGateway = loadGatewayWithCurrentHome();

  delete process.env.ANTHROPIC_BASE_URL;
  assert.equal(isolatedGateway.isWired(), false);
  assert.equal(isolatedGateway.wiredMode(), null);

  process.env.ANTHROPIC_BASE_URL = isolatedGateway.DEFAULT_BASE_URL;
  assert.equal(isolatedGateway.isWired(), true);
  assert.deepEqual(isolatedGateway.wiredMode(), { scope: null, mode: 'default', source: 'env', file: null });

  const projectFile = isolatedGateway.settingsPath('project');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: isolatedGateway.COMPAT_BASE_URL } }));
  assert.deepEqual(isolatedGateway.wiredMode(), { scope: 'project', mode: 'compat', source: 'project-local', file: projectFile });
});

// An unwire must not take ANTHROPIC_DEFAULT_*_MODEL pins the user set for
// themselves: they are ordinary Claude Code settings this plugin only sometimes
// owns, and claiming them by key wiped a working configuration.
test('env --remove keeps alias pins the gateway did not write', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-pins-'));
  const previous = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const isolatedGateway = loadGatewayWithCurrentHome();

  const file = isolatedGateway.settingsPath('user');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  isolatedGateway.writeEnv('user', false, { mode: 'default', quiet: true });

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gatewayWrittenPin = written.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  assert.ok(gatewayWrittenPin, 'the gateway writes an opus pin it owns');
  written.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-my-own-choice';
  fs.writeFileSync(file, JSON.stringify(written));

  isolatedGateway.writeEnv('user', true, { quiet: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, 'a pin holding our own value is removed');
  assert.equal(after.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-my-own-choice', 'a pin the user set survives');
});

// ---------------------------------------------------- DNS recursion guard

test('worker hosts-bypass lookup preserves the legacy single-address callback contract', async () => {
  let resolve4Calls = 0;
  const resolver = createHostsBypassResolver({
    resolve4: async () => { resolve4Calls++; return ['203.0.113.9']; }, // TEST-NET-3, stands in for "the real IP"
    resolve6: async () => { throw new Error('should not be reached when A succeeds'); },
  });
  const result = await new Promise((resolve, reject) => {
    resolver.lookup('api.anthropic.com', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
  assert.equal(result.address, '203.0.113.9');
  assert.equal(result.family, 4);
  assert.notEqual(result.address, '127.0.0.1'); // never the loopback the hosts file would have poisoned it with
  assert.equal(resolve4Calls, 1);
});

test('worker hosts-bypass lookup honors Node 22 all:true with an address-record array', async () => {
  const resolver = createHostsBypassResolver({
    resolve4: async () => ['203.0.113.10'],
    resolve6: async () => { throw new Error('should not be reached when A succeeds'); },
  });
  const result = await new Promise((resolve, reject) => {
    resolver.lookup('api.anthropic.com', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
  assert.deepEqual(result, [{ address: '203.0.113.10', family: 4 }]);
});

test('createHostsBypassResolver falls back to AAAA when A resolution fails', async () => {
  const resolver = createHostsBypassResolver({
    resolve4: async () => { throw new Error('no A record'); },
    resolve6: async () => ['2001:db8::9'], // documentation range, stands in for a real AAAA
  });
  const result = await new Promise((resolve, reject) => {
    resolver.lookup('api.anthropic.com', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
  assert.equal(result.address, '2001:db8::9');
  assert.equal(result.family, 6);
});

test('createHostsBypassResolver errors closed instead of recursing when DNS is unreachable', async () => {
  const resolver = createHostsBypassResolver({
    resolve4: async () => { throw new Error('ENOTFOUND'); },
    resolve6: async () => { throw new Error('ENOTFOUND'); },
  });
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      resolver.lookup('api.anthropic.com', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    }),
    /could not resolve/,
  );
});

// -------------------------------------------------- live shim, dual listen

test('serve-shim binds a second RC-compatibility listener only when the hosts entry is present', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shimhosts-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n127.0.0.1 api.anthropic.com\n');

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home: hostsDir });

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, true);
  assert.equal(health.compat.port80Bound, true);
  assert.match(health.compat.hostsLine, /api\.anthropic\.com/);

  // the second listener answers the same handler on the compat port
  const compatHealth = await waitForHealthz(compatPort);
  assert.equal(compatHealth.compat.hostsDetected, true);
  assert.equal(compatHealth.compat.port80Bound, true);

  const catalog = await request(compatPort, 'GET', '/v1/models');
  assert.equal(catalog.status, 200);
  assert.ok(JSON.parse(catalog.body).data.some((model) => model.id === 'claude-gpt-5.6-terra[1m]'));
});

test('serve-shim stays default-only when no hosts entry is present', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shimnohosts-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n'); // no api.anthropic.com entry

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home: hostsDir });

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, false);
  assert.equal(health.compat.port80Bound, false);

  // nothing should be listening on the would-be compat port
  await assert.rejects(request(compatPort, 'GET', '/healthz'));
});

test('serve-shim exposes bounded RC control only through the main loopback listener', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shimcontrol-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();
  spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home: hostsDir });
  const health = await waitForHealthz(shimPort);
  const body = JSON.stringify({ action: 'probe', expectedSupervisorPid: health.supervisorPid });
  const controlHeaders = { 'x-model-gateway-control': 'rc-compatibility' };
  for (const headers of [
    {},
    { ...controlHeaders, origin: 'http://127.0.0.1' },
    { ...controlHeaders, host: `localhost:${shimPort}` },
    { ...controlHeaders, 'content-type': 'text/plain' },
  ]) {
    const response = await request(shimPort, 'POST', '/internal/rc-compatibility', body, '127.0.0.1', headers);
    assert.equal(response.status, 404);
  }
  const wrongMethod = await request(shimPort, 'GET', '/internal/rc-compatibility');
  assert.equal(wrongMethod.status, 404);

  const startedAt = Date.now();
  const probe = await request(shimPort, 'POST', '/internal/rc-compatibility', body, '127.0.0.1', controlHeaders);
  assert.equal(probe.status, 200);
  assert.equal(JSON.parse(probe.body).status, 'bindable');
  assert.ok(Date.now() - startedAt < 1000, 'probe releases the port once bind succeeds');
  const freeAfterProbe = net.createServer();
  await new Promise((resolve, reject) => {
    freeAfterProbe.once('error', reject);
    freeAfterProbe.listen(compatPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => freeAfterProbe.close((error) => (error ? reject(error) : resolve())));

  fs.writeFileSync(hostsFile, '127.0.0.1 api.anthropic.com\n');
  const activate = await request(shimPort, 'POST', '/internal/rc-compatibility', JSON.stringify({ action: 'reconcile', expectedSupervisorPid: health.supervisorPid }), '127.0.0.1', controlHeaders);
  assert.equal(JSON.parse(activate.body).status, 'bound');
  const compatControl = await request(compatPort, 'POST', '/internal/rc-compatibility', body, '127.0.0.1', controlHeaders);
  assert.equal(compatControl.status, 404);
  const wrongIdentity = await request(shimPort, 'POST', '/internal/rc-compatibility', JSON.stringify({ action: 'reconcile', expectedSupervisorPid: health.supervisorPid + 1 }), '127.0.0.1', controlHeaders);
  assert.equal(JSON.parse(wrongIdentity.body).status, 'unknown');
  assert.equal((await waitForHealthz(shimPort)).compat.port80Bound, true);
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  const deactivate = await request(shimPort, 'POST', '/internal/rc-compatibility', JSON.stringify({ action: 'reconcile', expectedSupervisorPid: health.supervisorPid }), '127.0.0.1', controlHeaders);
  assert.equal(JSON.parse(deactivate.body).status, 'bound');
  const afterDeactivate = await waitForHealthz(shimPort);
  assert.equal(afterDeactivate.supervisorPid, health.supervisorPid);
  assert.equal(afterDeactivate.compat.port80Bound, false);
  await assert.rejects(request(compatPort, 'GET', '/healthz'));
});

test('serve-shim accepts requests through ANTHROPIC_UNIX_SOCKET', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shimsocket-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-test-${process.pid}-${Date.now()}`
    : path.join(hostsDir, 'gateway.sock');

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();
  spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home: hostsDir, socketPath });

  const health = await waitForSocketHealthz(socketPath);
  assert.equal(health.ok, true);
  const catalog = await requestSocket(socketPath, 'GET', '/v1/models');
  assert.equal(catalog.status, 200);
  assert.ok(JSON.parse(catalog.body).data.some((model) => model.id === 'claude-gpt-5.6-terra[1m]'));
});

test('serve-shim forwards an unexpected bodyless request without crashing on raw.length', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-bodyless-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');

  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/unexpected-probe');
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve()))));

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();
  spawnShim(t, {
    shimPort,
    proxyPort,
    compatPort,
    hostsFile,
    home: hostsDir,
    anthropicUpstream: `http://127.0.0.1:${upstreamPort}`,
  });

  await waitForHealthz(shimPort);
  const response = await request(shimPort, 'GET', '/unexpected-probe');
  assert.equal(response.status, 204);
  assert.equal(response.body, '');
  assert.equal((await waitForHealthz(shimPort)).ok, true);
});

test('serve-shim safely retains default mode when the compatibility port is unavailable', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shimportbusy-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 api.anthropic.com\n');

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  // occupy the compat port first so the shim's bind attempt fails
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(compatPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve()))));

  spawnShim(t, { shimPort, proxyPort, compatPort, hostsFile, home: hostsDir });

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, true);
  assert.equal(health.compat.port80Bound, false);
  assert.ok(health.compat.reason, 'expected a reason describing the bind failure');

  // main gateway functionality is unaffected by the failed compat bind
  const models = await request(shimPort, 'GET', '/v1/models');
  assert.equal(models.status, 200);
});
