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

const { pickNewerInstall, findNewerInstall } = require('../lib/server.js');

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

test('dashboard makes categories primary and keeps legacy complexity routing collapsed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /id="categoryList"/);
  assert.match(html, /id="routingProfiles"/);
  assert.doesNotMatch(html, /id="editPlanBtn"/);
  assert.match(html, /<details class="legacy-routing">/);
  assert.match(html, /Legacy complexity routing/);
  assert.ok(html.indexOf('id="categoryList"') < html.indexOf('id="routingProfiles"'));
  assert.ok(html.indexOf('id="routingProfiles"') < html.indexOf('id="ladderView"'));
  assert.match(html, /var gradesView = modelPrefs\.profiles \|\| \{\}/);
  assert.match(html, /function categoryChipsForGrade\(grade\)/);
  assert.match(html, /category\.route\.model === grade/);
  assert.match(html, /CLAUDE_RUNTIME_OPTIONS = \[/);
  assert.match(html, /\{ slug: "haiku", label: "Claude Haiku" \}/);
  assert.match(html, /\{ slug: "sonnet", label: "Claude Sonnet" \}/);
  assert.match(html, /\{ slug: "opus", label: "Claude Opus" \}/);
  assert.match(html, /\{ slug: "fable", label: "Claude Fable" \}/);
  assert.match(html, /row\.appendChild\(backendSelect\(p\.grade, det\)\)/);
  assert.doesNotMatch(html, /if \(det\.length\) row\.appendChild\(backendSelect/);
  assert.match(html, /if \(backend !== "claude"\) return backend;/);
  assert.match(html, /"grade-1": "haiku", "grade-2": "sonnet", "grade-3": "opus", "grade-4": "fable"/);
  assert.match(html, /return dm\.source \? dm\.source \+ ":" \+ dm\.slug : dm\.slug;/);
  assert.match(html, /var value = externalBackendValue\(dm\);/);
  assert.match(html, /cur === value \|\| \(cur === dm\.slug && !isClaudeRuntime\(dm\.slug\)\)/);
  assert.match(html, /externalBackendValue\(x\) === sel\.value/);
  assert.match(html, /if \(profile\) return profile\.efforts !== null;/);
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

test('stable cwd lets a detached child outlive a removed worktree-like cwd', { timeout: 10000 }, async (t) => {
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
  await waitFor(() => fs.existsSync(marker), 5000, 'detached child marker');
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'ready');
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

test('dashboard self-updates to a newer cached install at the same URL', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dashboard-upgrade-'));
  const oldRoot = path.join(root, '1.37.0');
  const newRoot = path.join(root, '1.37.1');
  const source = path.join(__dirname, '..');
  const home = path.join(root, 'home');
  copyPlugin(source, oldRoot, '1.37.0');

  const port = 43000 + Math.floor(Math.random() * 1000);
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
  }, 5000, 'the old dashboard');

  const oldHealth = await fetchJson(port, '/api/health');
  copyPlugin(source, newRoot, '1.37.1');

  await waitFor(async () => {
    try {
      const health = await fetchJson(port, '/api/health');
      return health.version === '1.37.1';
    } catch (_) {
      return false;
    }
  }, 10000, 'the upgraded dashboard');

  const newHealth = await fetchJson(port, '/api/health');
  assert.strictEqual(newHealth.version, '1.37.1');
  assert.notStrictEqual(newHealth.pid, oldHealth.pid);
  assert.strictEqual(isAlive(old.pid), false);
});
