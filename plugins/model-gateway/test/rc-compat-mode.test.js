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

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gw = require(CLI);
const remoteControl = require('../lib/remote-control.js');
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

function request(port, method, pathname, body, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
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
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
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
  function configure(args) {
    remoteControl.configureRemoteControl({
      args,
      flag: (value) => args.includes(value),
      log: (message) => output.push(message),
      die: (message) => { throw new Error(message); },
      doctor: async () => {},
      fetchShimHealth: async () => ({ ok: true, models: 1, compat: { port80Bound: true } }),
      startAll: async () => {
        startCalls += 1;
        return { ok: true };
      },
      syncCompatMode: async () => {},
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

  output.length = 0;
  configure(['enable']);
  await remoteControl.remoteControlCommand();
  assert.match(output.join('\n'), /Do you want to make this hosts-file change/);

  output.length = 0;
  configure(['enable', '--confirm']);
  await remoteControl.remoteControlCommand();
  const enabled = fs.readFileSync(hostsFile, 'utf8');
  assert.equal((enabled.match(/api\.anthropic\.com/g) || []).length, 1);
  assert.match(enabled, /# >>> model-gateway RC compatibility >>>/);
  assert.match(enabled, /# <<< model-gateway RC compatibility <<</);
  assert.match(output.join('\n'), /updated hosts file:/);
  assert.doesNotMatch(output.join('\n'), /Do you want to make this hosts-file change|Notepad as Administrator/);
  assert.equal(startCalls, 1);

  fs.writeFileSync(hostsFile, gw.managedHostsBlock());
  output.length = 0;
  configure(['enable', '--confirm']);
  await remoteControl.remoteControlCommand();
  assert.equal(fs.readFileSync(hostsFile, 'utf8'), gw.managedHostsBlock());
  assert.equal(startCalls, 1);
  assert.match(output.join('\n'), /already enabled/);
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

test('writeEnv removes retired socket wiring while preserving unrelated settings', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-writeenv-'));
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  t.after(() => {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
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
  assert.deepEqual(isolatedGateway.wiredMode(), { scope: 'user', mode: 'compat' });

  isolatedGateway.writeEnv('user', true, { quiet: true }); // --remove
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.ANTHROPIC_UNIX_SOCKET, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');
  assert.equal(isolatedGateway.wiredMode(), null);
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
  assert.ok(JSON.parse(catalog.body).data.some((model) => model.id === 'claude-gpt-5.6-terra'));
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
  assert.ok(JSON.parse(catalog.body).data.some((model) => model.id === 'claude-gpt-5.6-terra'));
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
