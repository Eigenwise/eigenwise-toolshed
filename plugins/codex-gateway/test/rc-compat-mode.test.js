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
  throw lastErr || new Error('shim did not become healthy');
}

// ---------------------------------------------------- hosts syntax parsing

test('parseHostsCompatEntry recognizes the managed entry across Windows/macOS/Linux hosts syntaxes', () => {
  const positive = [
    '127.0.0.1 api.anthropic.com',
    '127.0.0.1\tapi.anthropic.com',
    '127.0.0.1   api.anthropic.com   # codex-gateway RC compatibility',
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
    '# managed by codex-gateway',
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
  assert.equal(gw.parseHostsCompatBlock('# >>> codex-gateway RC compatibility >>>\n').state, 'partial');
  assert.equal(gw.parseHostsCompatBlock('# <<< codex-gateway RC compatibility <<<\n').state, 'partial');
  assert.equal(gw.parseHostsCompatBlock(gw.managedHostsBlock()).state, 'valid');
  assert.equal(gw.parseHostsCompatBlock('# >>> codex-gateway RC compatibility >>>\n127.0.0.1 localhost\n# <<< codex-gateway RC compatibility <<<\n').state, 'invalid');
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
  assert.throws(() => gw.addManagedHostsBlock('# >>> codex-gateway RC compatibility >>>\n'), /partial/);
  assert.throws(() => gw.removeManagedHostsBlock('# <<< codex-gateway RC compatibility <<<\n'), /partial/);
  assert.deepEqual(
    gw.findConflictingHostsMappings('203.0.113.4 api.anthropic.com\n127.0.0.1 api.anthropic.com\n'),
    ['203.0.113.4 api.anthropic.com'],
  );
});

// ------------------------------------------------------- detectHostsCompat

test('detectHostsCompat reads an overridden path and never touches the real hosts file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-hosts-'));
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

test('writeEnv switches only the plugin-owned base URL and leaves unrelated settings alone', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-writeenv-'));
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  t.after(() => {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });
  process.env.USERPROFILE = home;
  process.env.HOME = home;

  const file = gw.settingsPath('user');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { USER_SETTING: 'keep-me' } }));

  gw.writeEnv('user', false, { mode: 'default', quiet: true });
  let settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, gw.DEFAULT_BASE_URL);
  assert.equal(settings.env.USER_SETTING, 'keep-me');

  gw.writeEnv('user', false, { mode: 'compat', quiet: true });
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, gw.COMPAT_BASE_URL);
  assert.equal(settings.env.USER_SETTING, 'keep-me'); // untouched across the switch
  assert.deepEqual(gw.wiredMode(), { scope: 'user', mode: 'compat' });

  gw.writeEnv('user', true, { quiet: true }); // --remove
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');
  assert.equal(gw.wiredMode(), null);
});

// ---------------------------------------------------- DNS recursion guard

test('createHostsBypassResolver resolves via DNS directly, never via the hosts-aware OS resolver', async () => {
  let resolve4Calls = 0;
  const resolver = gw.createHostsBypassResolver({
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

test('createHostsBypassResolver falls back to AAAA when A resolution fails', async () => {
  const resolver = gw.createHostsBypassResolver({
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
  const resolver = gw.createHostsBypassResolver({
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
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-shimhosts-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n127.0.0.1 api.anthropic.com\n');

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
      CODEX_GATEWAY_HOSTS_FILE: hostsFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, true);
  assert.equal(health.compat.port80Bound, true);
  assert.match(health.compat.hostsLine, /api\.anthropic\.com/);

  // the second listener answers the same handler on the compat port
  const compatHealth = await waitForHealthz(compatPort);
  assert.equal(compatHealth.compat.hostsDetected, true);
  assert.equal(compatHealth.compat.port80Bound, true);
});

test('serve-shim stays default-only when no hosts entry is present', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-shimnohosts-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n'); // no api.anthropic.com entry

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
      CODEX_GATEWAY_HOSTS_FILE: hostsFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, false);
  assert.equal(health.compat.port80Bound, false);

  // nothing should be listening on the would-be compat port
  await assert.rejects(request(compatPort, 'GET', '/healthz'));
});

test('serve-shim safely retains default mode when the compatibility port is unavailable', async (t) => {
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-shimportbusy-'));
  const hostsFile = path.join(hostsDir, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 api.anthropic.com\n');

  const shimPort = await freePort();
  const proxyPort = await freePort();
  const compatPort = await freePort();

  // occupy the compat port first so the shim's bind attempt fails
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(compatPort, '127.0.0.1', resolve));
  t.after(() => blocker.close());

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_COMPAT_PORT: String(compatPort),
      CODEX_GATEWAY_HOSTS_FILE: hostsFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const health = await waitForHealthz(shimPort);
  assert.equal(health.compat.hostsDetected, true);
  assert.equal(health.compat.port80Bound, false);
  assert.ok(health.compat.reason, 'expected a reason describing the bind failure');

  // main gateway functionality is unaffected by the failed compat bind
  const models = await request(shimPort, 'GET', '/v1/models');
  assert.equal(models.status, 200);
});
