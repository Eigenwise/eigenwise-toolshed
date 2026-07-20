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

const DASHBOARD_BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
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

test('findNewerInstall: SIDEQUEST_NO_HOT_RECYCLE guard returns null', () => {
  // Set for the whole file (see top), so this just documents/exercises it.
  assert.strictEqual(process.env.SIDEQUEST_NO_HOT_RECYCLE, '1');
  assert.strictEqual(findNewerInstall(), null);
});

test('findNewerInstall: repo-source checkout (non-semver dir name) never self-recycles', () => {
  // Running the real suite from the repo, __dirname resolves under
  // plugins/sidequest/lib, whose parent dir basename is "sidequest" — not a
  // clean semver — so the guard must fire even with the env var unset.
  const prev = process.env.SIDEQUEST_NO_HOT_RECYCLE;
  delete process.env.SIDEQUEST_NO_HOT_RECYCLE;
  try {
    assert.strictEqual(findNewerInstall(), null);
  } finally {
    if (prev !== undefined) process.env.SIDEQUEST_NO_HOT_RECYCLE = prev;
  }
});

test('dashboard uses concrete model fallbacks and removes grade routing', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  assert.match(html, /id="categoryList"/);
  assert.match(html, /id="globalFallbackControl"/);
  assert.match(html, /Add a category-specific fallback step/);
  assert.match(html, /Global fallback/);
  assert.match(html, /Route changed:/);
  assert.doesNotMatch(html, /id="routingProfiles"/);
  assert.doesNotMatch(html, /legacy-routing/);
  assert.doesNotMatch(html, /routing-ladder/);
  assert.doesNotMatch(html, /model-prefs/);
  assert.doesNotMatch(html, /grade-1|grade-2|grade-3|grade-4/);
  assert.match(server, /pathname === '\/api\/routing-fallback'/);
  assert.match(server, /pathname === '\/api\/routing-models'/);
  assert.match(server, /fallback: body\.fallback/);
  assert.doesNotMatch(server, /getModelPrefs|routingLadder|setModelPrefs/);
});

test('findNewerInstall: never throws even with guards disabled', () => {
  assert.doesNotThrow(() => findNewerInstall());
});

test('detached dashboard spawn options use a stable cwd and preserve lifecycle flags', () => {
  const cli = fs.readFileSync(DASHBOARD_BIN, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  assert.match(cli, /spawn\(process\.execPath, args, \{ cwd: os\.homedir\(\), detached: true, stdio: 'ignore', windowsHide: true \}\)/);
  assert.match(server, /spawn\(process\.execPath, \[targetBin, 'serve', '--port', String\(ownPort\), '--handoff-pid', String\(process\.pid\)\], \{\s*cwd: os\.homedir\(\),\s*detached: true,\s*stdio: 'ignore',\s*windowsHide: true,\s*\}\)/);
});

test('stable cwd lets a detached child outlive a removed worktree-like cwd', { timeout: 60000 }, async (t) => {
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
      try { process.kill(child.pid); } catch (_) {}
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  await waitFor(() => fs.existsSync(marker), 30000, 'detached child marker');
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'ready');
});

test('dashboard exposes default and board settings with a routing opt-out', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(server, /projects.*routing/s);
  assert.match(server, /setProjectRouting/);
  assert.match(html, /Default settings/);
  assert.match(html, /Board settings/);
  assert.match(html, /INHERITED FROM DEFAULTS/);
  assert.match(html, /CUSTOMIZED ON THIS BOARD/);
  assert.match(html, /routingDisabledNote/);
  assert.match(html, /applyRoutingVisibility/);
});

test('dashboard exposes board archive routes and guarded project controls', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(server, /\/api\/projects\/archived/);
  assert.match(server, /archive\|unarchive/);
  assert.match(server, /store\.deleteProjectExact/);
  assert.match(html, /openProjectMenu/);
  assert.match(html, /Archive board/);
  assert.match(html, /Delete board…/);
  assert.match(html, /Archived boards/);
  assert.match(html, /projectTicketCount/);
  assert.match(html, /and its ' \+ count \+ ' ticket/);
  assert.match(html, /if \(archived\) item\("Restore board"/);
  assert.match(html, /else \{\s*item\("Archive board"[\s\S]*item\("Delete board…"/);
  assert.match(html, /This cannot be undone/);
  assert.match(html, /Archive failed:/);
  assert.match(html, /Restore failed:/);
});

test('category draft validation accepts only live routes', () => {
  const draft = validateCategoryDraft({ id: 'poker.analysis', name: 'Poker analysis', description: 'Analyze poker hand histories and related strategy work.', contract: 'Review the supplied hands and explain the result.', route: { model: 'sonnet', effort: 'high' }, fallback: null });
  assert.equal(draft.id, 'poker.analysis');
  assert.throws(() => validateCategoryDraft({ ...draft, name: { value: 'not a string' } }), /omitted name/);
  assert.throws(() => validateCategoryDraft({ ...draft, route: { model: 'missing', effort: 'high' } }), /live catalog/);
});

test('category draft endpoint handles success, malformed output, missing CLI, and timeout', { concurrency: false }, async (t) => {
  const started = await start(45000 + Math.floor(Math.random() * 1000));
  t.after(() => { started.server.close(); setCategoryDraftSpawn(null); setCategoryDraftTimeout(null); });
  const childFor = (stdout, code) => () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', null);
    process.nextTick(() => { if (stdout) child.stdout.emit('data', stdout); child.emit('close', code == null ? 0 : code); });
    return child;
  };
  setCategoryDraftAvailable(true);
  setCategoryDraftSpawn(childFor(JSON.stringify({ id: 'poker.analysis', name: 'Poker analysis', description: 'Analyze poker hand histories and related strategy work.', contract: 'Review the supplied hands.', route: { model: 'sonnet', effort: 'high' }, fallback: null })));
  const ok = await requestJson(started.port, 'POST', '/api/categories/draft', { sentence: 'an agent that analyzes poker hand histories' });
  assert.equal(ok.status, 200); assert.equal(ok.body.draft.id, 'poker.analysis');
  setCategoryDraftSpawn(childFor('```json\n' + JSON.stringify({ id: 'fenced.category', name: 'Fenced category', description: 'Accept category drafts returned in fenced JSON.', contract: 'Review the draft.', route: { model: 'haiku', effort: 'medium' }, fallback: null }) + '\n```'));
  const fenced = await requestJson(started.port, 'POST', '/api/categories/draft', { sentence: 'test' });
  assert.equal(fenced.status, 200); assert.equal(fenced.body.draft.id, 'fenced.category');
  setCategoryDraftSpawn(childFor('not json'));
  const malformed = await requestJson(started.port, 'POST', '/api/categories/draft', { sentence: 'test' });
  assert.equal(malformed.status, 422);
  setCategoryDraftAvailable(false);
  const missing = await requestJson(started.port, 'POST', '/api/categories/draft', { sentence: 'test' });
  assert.equal(missing.status, 503);
  setCategoryDraftAvailable(true);
  setCategoryDraftSpawn(() => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; });
  setCategoryDraftTimeout(10);
  const timedOut = await requestJson(started.port, 'POST', '/api/categories/draft', { sentence: 'test' });
  assert.equal(timedOut.status, 422);
});


test('category endpoints project scope preserves global taxonomy and reports local layers', { concurrency: false }, async (t) => {
  const one = store.ensureProject(path.join(process.env.SIDEQUEST_HOME, 'one')).slug;
  const two = store.ensureProject(path.join(process.env.SIDEQUEST_HOME, 'two')).slug;
  store.setCategory({ id: 'general', name: 'General', description: '', contract: '', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true });
  store.setCategory({ id: 'coding', name: 'Coding', description: 'Global coding', contract: '', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true });
  const started = await start(44000 + Math.floor(Math.random() * 1000));
  t.after(() => started.server.close());

  const local = await requestJson(started.port, 'POST', '/api/categories', { project: one, id: 'music', name: 'Music', description: 'Local', contract: '', route: { model: 'opus', effort: 'high' }, fallback: null, enabled: true });
  assert.strictEqual(local.status, 201);
  assert.strictEqual(local.body.category.layer.kind, 'ADD');
  const forked = await requestJson(started.port, 'PATCH', `/api/categories/coding?project=${one}`, { route: { model: 'opus', effort: 'high' } });
  assert.strictEqual(forked.status, 200);
  assert.strictEqual(forked.body.category.layer.kind, 'DETACH'); // editing a board category forks it
  assert.deepStrictEqual(forked.body.category.route, { model: 'opus', effort: 'high' });
  const disabled = await requestJson(started.port, 'PATCH', `/api/categories/coding?project=${one}`, { disable: true });
  assert.strictEqual(disabled.status, 200);
  assert.strictEqual(disabled.body.category.disabled, true);
  const other = await fetchJson(started.port, `/api/categories?project=${two}`);
  assert.ok(!other.categories.some((category) => category.id === 'music'));
  assert.ok(other.categories.some((category) => category.id === 'coding' && !category.disabled));
  const global = await fetchJson(started.port, '/api/categories?project=all');
  assert.ok(!global.categories.some((category) => category.id === 'music'));
  assert.ok(global.categories.some((category) => category.id === 'coding' && !category.disabled));
  assert.strictEqual((await requestJson(started.port, 'PATCH', `/api/categories/general?project=${one}`, { disable: true })).status, 400);
  assert.strictEqual((await requestJson(started.port, 'DELETE', `/api/categories/coding?project=${one}`)).status, 200);

  const detached = await requestJson(started.port, 'POST', '/api/categories/coding/detach', { project: one });
  assert.strictEqual(detached.status, 200);
  assert.strictEqual(detached.body.category.linkState, 'detached');
  assert.deepStrictEqual(detached.body.warnings, []); // a forked copy is not a warning

  const relinked = await requestJson(started.port, 'POST', '/api/categories/coding/relink', { project: one });
  assert.strictEqual(relinked.status, 200);
  assert.strictEqual(relinked.body.category.linkState, 'linked');
});

function copyPlugin(from, to, version) {
  fs.cpSync(from, to, { recursive: true });
  const manifest = path.join(to, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  plugin.version = version;
  fs.writeFileSync(manifest, `${JSON.stringify(plugin, null, 2)}\n`);
}

function waitFor(check, timeoutMs, label) {
  return new Promise((resolve, reject) => {
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
      } catch (_) {
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

function requestJson(port, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: endpoint, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, timeout: 1000 }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchJson(port, endpoint) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: endpoint, timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

test('dashboard self-updates to a newer cached install at the same URL', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dashboard-upgrade-'));
  const oldRoot = path.join(root, '1.37.0');
  const newRoot = path.join(root, '1.37.1');
  const source = path.join(__dirname, '..');
  const home = path.join(root, 'home');
  copyPlugin(source, oldRoot, '1.37.0');

  const port = 50000 + Math.floor(Math.random() * 10000);
  const env = Object.assign({}, process.env, {
    SIDEQUEST_HOME: home,
    SIDEQUEST_VERSION_WATCH_MS: '100',
  });
  delete env.SIDEQUEST_NO_HOT_RECYCLE;
  const old = spawn(process.execPath, [path.join(oldRoot, 'bin', 'sidequest.js'), 'serve', '--port', String(port)], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    for (const child of [old]) {
      if (child.pid && isAlive(child.pid)) {
        try { process.kill(child.pid); } catch (_) {}
      }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      return health.version === '1.37.0';
    } catch (_) {
      return false;
    }
  }, 120000, 'the old dashboard');

  const oldHealth = await fetchJson(port, '/api/health');
  copyPlugin(source, newRoot, '1.37.1');

  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      return health.version === '1.37.1';
    } catch (_) {
      return false;
    }
  }, 30000, 'the upgraded dashboard');

  const newHealth = await fetchJson(port, '/api/health');
  assert.strictEqual(newHealth.version, '1.37.1');
  assert.notStrictEqual(newHealth.pid, oldHealth.pid);
  assert.strictEqual(isAlive(old.pid), false);
});

/* ------------------------------------------------------------------ *
 *  listenOn — walks past refused ports (SQ-591)
 * ------------------------------------------------------------------ */

function fakeServer(refusals) {
  const server = new EventEmitter();
  server.listen = (port) => {
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
    (err) => err.code === 'EPERM',
  );
  const refusals = new Map([[50000, 'EACCES'], [50001, 'EACCES']]);
  await assert.rejects(
    () => listenOn(fakeServer(refusals), 50000, '127.0.0.1', 1),
    (err) => err.code === 'EACCES',
  );
});
