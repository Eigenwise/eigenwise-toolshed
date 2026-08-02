import './_temp-cleanup.js';
'use strict';
/**
 * Tests for the dashboard server's hot-reload self-recycle (SQ-136).
 * Run: node --test plugins/sidequest/test/server.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const DASHBOARD_COMMAND_BIN = path.join(__dirname, '..', 'bin', 'sidequest-cmd-server.js');
const HOME_DIR = os.homedir();
// Point the store at a throwaway home so any incidental store reads/writes
// (findNewerInstall never touches it, but requiring server.js pulls in
// store.js) never touch the real one. Also opt this whole process out of the
// real recycle watch — these tests call the pure/fs functions directly and
// must never let a background setInterval fire during the run.
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-server-test-'));
process.env.SIDEQUEST_NO_HOT_RECYCLE = '1';

const { EventEmitter } = require('events');
const { start, listenOn, pickNewerInstall, findNewerInstall, validateCategoryDraft, setCategoryDraftSpawn, setCategoryDraftAvailable, setCategoryDraftTimeout } = require('../lib/server.js');
const store = require('../lib/store.js');

/* ------------------------------------------------------------------ *
 *  pickNewerInstall — pure core
 * ------------------------------------------------------------------ */

test('pickNewerInstall: picks a strictly-newer clean-semver install with a bin', () => {
  const entries = [{ name: '1.23.0', version: '1.23.0', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), '1.23.0');
});

test('pickNewerInstall: no strictly-newer candidate -> null (newest install never recycles)', () => {
  const entries = [
    { name: '1.20.0', version: '1.20.0', hasBin: true },
    { name: '1.23.0', version: '1.23.0', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.23.0'), null);
});

test('pickNewerInstall: candidate without hasBin is skipped', () => {
  const entries = [{ name: '2.0.0', version: '2.0.0', hasBin: false }];
  assert.strictEqual(pickNewerInstall(entries, '1.0.0'), null);
});

test('pickNewerInstall: prerelease version is skipped (never auto-hops to a prerelease)', () => {
  const entries = [{ name: '1.24.0-pre.1', version: '1.24.0-pre.1', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), null);
});

test('pickNewerInstall: non-semver names are skipped', () => {
  const entries = [
    { name: 'sidequest', version: 'sidequest', hasBin: true },
    { name: 'foo', version: 'foo', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.0.0'), null);
});

test('pickNewerInstall: compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
  const entries = [
    { name: '1.9.0', version: '1.9.0', hasBin: true },
    { name: '1.10.0', version: '1.10.0', hasBin: true },
  ];
  // Lexical string comparison would rank "1.9.0" above "1.10.0" (the '9' > '1'
  // digit); numeric comparison must pick 1.10.0 instead.
  assert.strictEqual(pickNewerInstall(entries, '1.8.0'), '1.10.0');
});

test('pickNewerInstall: equal version -> null', () => {
  const entries = [{ name: '1.20.0', version: '1.20.0', hasBin: true }];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), null);
});

test('pickNewerInstall: empty entries -> null', () => {
  assert.strictEqual(pickNewerInstall([], '1.20.0'), null);
});

test('pickNewerInstall: picks the highest of several strictly-newer candidates', () => {
  const entries = [
    { name: '1.21.0', version: '1.21.0', hasBin: true },
    { name: '1.23.0', version: '1.23.0', hasBin: true },
    { name: '1.22.0', version: '1.22.0', hasBin: true },
  ];
  assert.strictEqual(pickNewerInstall(entries, '1.20.0'), '1.23.0');
});

test('pickNewerInstall: malformed input degrades to null rather than throwing', () => {
  assert.strictEqual(pickNewerInstall(null, '1.20.0'), null);
  assert.strictEqual(pickNewerInstall([{ name: 'x' }], '1.20.0'), null);
  assert.strictEqual(pickNewerInstall([{ name: '1.23.0', version: '1.23.0', hasBin: true }], 'not-a-version'), null);
});

/* ------------------------------------------------------------------ *
 *  findNewerInstall — best-effort fs wrapper + guards
 * ------------------------------------------------------------------ */

test('findNewerInstall: SIDEQUEST_NO_HOT_RECYCLE guard returns null', async () => {
  // Set for the whole file (see top), so this just documents/exercises it.
  assert.strictEqual(process.env.SIDEQUEST_NO_HOT_RECYCLE, '1');
  assert.strictEqual(await findNewerInstall(), null);
});

test('findNewerInstall: repo-source checkout (non-semver dir name) never self-recycles', async () => {
  // Running the real suite from the repo, __dirname resolves under
  // plugins/sidequest/lib, whose parent dir basename is "sidequest" — not a
  // clean semver — so the guard must fire even with the env var unset.
  const prev = process.env.SIDEQUEST_NO_HOT_RECYCLE;
  delete process.env.SIDEQUEST_NO_HOT_RECYCLE;
  try {
    assert.strictEqual(await findNewerInstall(), null);
  } finally {
    if (prev !== undefined) process.env.SIDEQUEST_NO_HOT_RECYCLE = prev;
  }
});

test('findNewerInstall: never throws even with guards disabled', async () => {
  await assert.doesNotReject(() => findNewerInstall());
});

test('findNewerInstall: resolves the registry install after the cache layout moves', async (t?: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-registry-layout-'));
  const legacyRoot = path.join(root, 'legacy-cache', '1.89.0');
  const newestRoot = path.join(root, 'registry-cache', '2.0.0');
  const registryPath = path.join(root, 'claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.mkdirSync(path.join(newestRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(newestRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(newestRoot, 'bin', 'sidequest.js'), '');
  fs.writeFileSync(path.join(newestRoot, '.claude-plugin', 'plugin.json'), '{}');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
    'sidequest@eigenwise-toolshed': [{ installPath: newestRoot, version: '2.0.0' }],
  } }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.strictEqual(await findNewerInstall({ selfRoot: legacyRoot, selfVersion: '1.89.0', registryPath, ignoreOptOut: true }), path.join(newestRoot, 'bin', 'sidequest.js'));
});

test('detached dashboard spawn options use a stable cwd and preserve lifecycle flags', () => {
  const cli = fs.readFileSync(DASHBOARD_COMMAND_BIN, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  assert.match(cli, /spawn\(process\.execPath, args, \{ cwd: os\.homedir\(\), detached: true, stdio: "ignore", windowsHide: true \}\)/);
  assert.match(server, /spawn\(process\.execPath, \[targetBin, "serve", "--port", String\(ownPort\), "--handoff-pid", String\(process\.pid\)\], \{\s*cwd: os\.homedir\(\),\s*detached: true,\s*stdio: "ignore",\s*windowsHide: true\s*\}\)/);
});

test('stable cwd lets a detached child outlive a removed worktree-like cwd', { timeout: 60000 }, async (t?: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-detached-cwd-'));
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  const marker = path.join(root, 'marker.txt');
  const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'), 200)`], {
    cwd: HOME_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.rmSync(worktree, { recursive: true, force: true });
  t.after(() => {
    if (child.pid && isAlive(child.pid)) {
      try { process.kill(child.pid); } catch (_: any) {}
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_: any) {}
  });
  await waitFor(() => fs.existsSync(marker), 30000, 'detached child marker');
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'ready');
});

test('dashboard exposes board archive routes and guarded project controls', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  const bundle = fs.readdirSync(path.join(__dirname, '..', 'dashboard', 'dist', 'assets'))
    .map((name: string) => fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'dist', 'assets', name), 'utf8')).join('\n');
  assert.match(server, /\/api\/projects\/archived/);
  assert.match(server, /archive\|unarchive/);
  assert.match(server, /store\.deleteProjectExact/);
  assert.match(bundle, /Archive board/);
  assert.match(bundle, /Delete board/);
  assert.match(bundle, /Archived boards/);
  assert.match(bundle, /This cannot be undone/);
});

let stagingId = 0;

// The upgrade tests run a real server whose version watch polls the install
// path every 100ms, so an install must never be observable half-built: copying
// ~5MB in place takes longer than a poll under suite load, and the watcher then
// hands the port to a tree that is missing lib/store.js, or whose manifest
// still carries the source version (SQ-859). Build it under a name the watcher
// and the sibling scan both ignore, then rename it into place in one step.
function copyPlugin(from?: any, to?: any, version?: any) {
  const staging = path.join(path.dirname(to), `staging-${process.pid}-${stagingId++}`);
  fs.cpSync(from, staging, {
    recursive: true,
    filter: (source?: any) => path.basename(source) !== 'node_modules',
  });
  const manifest = path.join(staging, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  plugin.version = version;
  fs.writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
  fs.renameSync(staging, to);
}

function waitFor(check?: any, timeoutMs?: any, label?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        if (await check()) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${label}`));
          return;
        }
        setTimeout(tick, 50);
      } catch (_: any) {
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${label}`));
          return;
        }
        setTimeout(tick, 50);
      }
    };
    tick();
  });
}

function requestJson(port?: any, method?: any, endpoint?: any, body?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: endpoint, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, timeout: 1000 }, (res?: any) => {
      let text = '';
      res.on('data', (chunk?: any) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchJson(port?: any, endpoint?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    http.get({ host: '127.0.0.1', port, path: endpoint, timeout: 1000 }, (res?: any) => {
      let body = '';
      res.on('data', (chunk?: any) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err: any) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function requestRaw(port?: any, endpoint?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    http.get({ host: '127.0.0.1', port, path: endpoint, timeout: 1000 }, (res?: any) => {
      const chunks: any[] = [];
      res.on('data', (chunk?: any) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function isAlive(pid?: any) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_: any) {
    return false;
  }
}

function runCli(script?: any, args?: any, env?: any) {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const child = spawn(process.execPath, [script, ...args], { env, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk?: any) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code?: any) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `sidequest exited ${code}`));
    });
  });
}

function availablePort() {
  return new Promise<any>((resolve?: any, reject?: any) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error?: any) => error ? reject(error) : resolve(port));
    });
  });
}

test('server keeps API matching ahead of the legacy dashboard fallback', async (t?: any) => {
  const started = await start(await availablePort());
  t.after(() => started.server.close());

  const health = await requestRaw(started.port, '/api/health');
  assert.strictEqual(health.status, 200);
  assert.match(health.headers['content-type'], /^application\/json/);
  assert.strictEqual(JSON.parse(health.body).compactionSuggestionsEnabled, true);

  const shell = await requestRaw(started.port, '/');
  assert.strictEqual(shell.status, 200);
  assert.match(shell.headers['content-type'], /^text\/html/);
  assert.strictEqual(shell.headers['cache-control'], 'no-store');
  assert.match(shell.body, /<!doctype html>/i);

  const traversal = await requestRaw(started.port, '/..%2f.claude-plugin%2fplugin.json');
  assert.strictEqual(traversal.status, 404);
  assert.deepStrictEqual(JSON.parse(traversal.body), { error: 'not found' });
});

test('all-project tickets use the filtered store query', async (t?: any) => {
  const originalListTickets = store.listTickets;
  store.listTickets = () => { throw new Error('broad per-project list should not run'); };
  t.after(() => { store.listTickets = originalListTickets; });
  const started = await start(await availablePort());
  t.after(() => started.server.close());

  const payload = await fetchJson(started.port, '/api/tickets?project=all');
  assert.strictEqual(payload.project, 'all');
  assert.strictEqual(payload.archived, false);
  assert.ok(Array.isArray(payload.tickets));
});

test('dashboard ticket feed retains done tickets', async (t?: any) => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-dashboard-done-tickets'), 'Dashboard done tickets').slug;
  const done = store.createTicket(project, { title: 'dashboard done ticket', status: 'done' });
  const started = await start(await availablePort());
  t.after(() => started.server.close());

  const payload = await fetchJson(started.port, `/api/tickets?project=${encodeURIComponent(project)}`);
  assert.equal(payload.tickets.some((ticket?: any) => ticket.ref === done.ref && ticket.status === 'done'), true);
});

test('dashboard self-updates to a newer cached install at the same URL', { timeout: 180000 }, async (t?: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dashboard-upgrade-'));
  const oldRoot = path.join(root, '1.37.0');
  const newRoot = path.join(root, '1.37.1');
  const source = path.join(__dirname, '..');
  const home = path.join(root, 'home');
  const claudeHome = path.join(root, 'claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  copyPlugin(source, oldRoot, '1.37.0');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
    'sidequest@eigenwise-toolshed': [{ installPath: newRoot, version: '1.37.1' }],
  } }));

  const port = await availablePort();
  const env = Object.assign({}, process.env, {
    SIDEQUEST_HOME: home,
    SIDEQUEST_CLAUDE_HOME: claudeHome,
    SIDEQUEST_VERSION_WATCH_MS: '100',
  });
  delete env.SIDEQUEST_NO_HOT_RECYCLE;
  const old = spawn(process.execPath, [path.join(oldRoot, 'bin', 'sidequest.js'), 'serve', '--port', String(port)], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  // The successor is detached and outlives this process unless we reap it —
  // a leaked dashboard keeps polling every 100ms for the rest of the suite.
  let upgradedPid: any = null;
  t.after(() => {
    for (const pid of [old.pid, upgradedPid]) {
      if (pid && isAlive(pid)) {
        try { process.kill(pid); } catch (_: any) {}
      }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_: any) {}
  });

  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      return health.version === '1.37.0';
    } catch (_: any) {
      return false;
    }
  }, 120000, 'the old dashboard');

  const oldHealth = await fetchJson(port, '/api/health');
  copyPlugin(source, newRoot, '1.37.1');

  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      upgradedPid = health.pid;
      return health.version === '1.37.1';
    } catch (_: any) {
      return false;
    }
  }, 30000, 'the upgraded dashboard');

  const newHealth = await fetchJson(port, '/api/health');
  assert.strictEqual(newHealth.version, '1.37.1');
  assert.notStrictEqual(newHealth.pid, oldHealth.pid);
  assert.strictEqual(isAlive(old.pid), false);
});

test('dashboard heals a stale recorded server through the registry launcher', { timeout: 180000 }, async (t?: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dashboard-heal-'));
  const oldRoot = path.join(root, 'legacy-cache', '1.89.0');
  const newRoot = path.join(root, 'registry-cache', '2.0.0');
  const claudeHome = path.join(root, 'claude');
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const source = path.join(__dirname, '..');
  const home = path.join(root, 'home');
  const port = await availablePort();
  copyPlugin(source, oldRoot, '1.89.0');
  copyPlugin(source, newRoot, '2.0.0');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
    'sidequest@eigenwise-toolshed': [{ installPath: newRoot, version: '2.0.0' }],
  } }));
  const env = Object.assign({}, process.env, {
    SIDEQUEST_HOME: home,
    SIDEQUEST_CLAUDE_HOME: claudeHome,
    SIDEQUEST_NO_HOT_RECYCLE: '1',
  });
  const old = spawn(process.execPath, [path.join(oldRoot, 'bin', 'sidequest.js'), 'serve', '--port', String(port)], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  let replacementPid: any = null;
  t.after(() => {
    for (const pid of [old.pid, replacementPid]) {
      if (pid && isAlive(pid)) {
        try { process.kill(pid); } catch (_: any) {}
      }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_: any) {}
  });

  await waitFor(async () => {
    try { return (await fetchJson(port, '/api/health')).version === '1.89.0'; } catch (_: any) { return false; }
  }, 120000, 'the stale dashboard');
  await runCli(path.join(newRoot, 'bin', 'sidequest.js'), ['dashboard', '--port', String(port), '--no-open'], env);
  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      replacementPid = health.pid;
      return health.version === '2.0.0';
    } catch (_: any) {
      return false;
    }
  }, 30000, 'the healed dashboard');
});


function fakeServer(refusals?: any) {
  const server = new EventEmitter();
  server.listen = (port?: any) => {
    setImmediate(() => {
      const code = refusals.get(port);
      if (code) server.emit('error', Object.assign(new Error(code), { code }));
      else server.emit('listening');
    });
  };
  return server;
}

test('listenOn walks past EADDRINUSE and Windows-excluded EACCES ports', async () => {
  const refusals = new Map([[50000, 'EACCES'], [50001, 'EACCES'], [50002, 'EADDRINUSE']]);
  const port = await listenOn(fakeServer(refusals), 50000, '127.0.0.1', 700);
  assert.strictEqual(port, 50003);
});

test('listenOn clears a 600-port excluded block within its walk budget', async () => {
  const refusals = new Map();
  for (let port = 52092; port <= 52691; port++) refusals.set(port, 'EACCES');
  const port = await listenOn(fakeServer(refusals), 52092, '127.0.0.1', 700);
  assert.strictEqual(port, 52692);
});

test('listenOn rejects non-retryable errors and an exhausted budget', async () => {
  await assert.rejects(
    () => listenOn(fakeServer(new Map([[50000, 'EPERM']])), 50000, '127.0.0.1', 700),
    (err?: any) => err.code === 'EPERM',
  );
  const refusals = new Map([[50000, 'EACCES'], [50001, 'EACCES']]);
  await assert.rejects(
    () => listenOn(fakeServer(refusals), 50000, '127.0.0.1', 1),
    (err?: any) => err.code === 'EACCES',
  );
});
