'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { syncReadinessHooks, readinessHookPresent } = require('../lib/readiness-hooks.js');
const { writeCommandLauncher } = require('../hooks/registry-writer.js');
const { startAll, PLUGIN_VERSION, startupFailureFor, writeStartupFailure } = require('../lib/commands.js');
const { recordIntentionalStop, resumeIntentionalStop } = require('../lib/lifecycle-lock.js');

function installedGateFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-installed-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'model-gateway@test': [{ version: '1.0.0', installPath: path.resolve(__dirname, '..') }] } }));
  const launcher = writeCommandLauncher({ home }).file;
  const environment = { ...process.env, HOME: home, USERPROFILE: home, MODEL_GATEWAY_CLAUDE_HOME: path.join(home, '.claude'), ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  return { home, registry, launcher, environment };
}

function invokeGate(fixture, event, extraEnvironment = {}) {
  return spawnSync(process.execPath, [fixture.launcher, 'readiness-gate'], {
    input: JSON.stringify({ hook_event_name: event, cwd: fixture.home }),
    cwd: fixture.home, env: { ...fixture.environment, ...extraEnvironment }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
}

test('owned readiness hooks preserve unrelated hooks, deduplicate and unwire exactly', () => {
  const unrelated = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] };
  const settings = { hooks: { SessionStart: [unrelated], Stop: [{}] }, permissions: { allow: ['Read'] } };
  syncReadinessHooks(settings, true);
  const expected = JSON.stringify(settings);
  syncReadinessHooks(settings, true);
  assert.equal(JSON.stringify(settings), expected);
  assert.equal(readinessHookPresent(settings), true);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].onFailure, 'block');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].timeout, 35);
  syncReadinessHooks(settings, false);
  assert.deepEqual(settings, { hooks: { SessionStart: [unrelated], Stop: [{}] }, permissions: { allow: ['Read'] } });
});

test('disabled hooks stay disabled and receive no new recovery gate', () => {
  const settings = { disableAllHooks: true, hooks: { Stop: [{}] } };
  syncReadinessHooks(settings, true);
  assert.deepEqual(settings, { disableAllHooks: true, hooks: { Stop: [{}] } });
});

test('installed stable gate accepts startup and resume stdin without enabled plugins and bypasses a non-gateway endpoint', (t) => {
  const fixture = installedGateFixture(t);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const result = invokeGate(fixture, event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'model-gateway', 'guardian.pid')), false);
  }
});

test('installed prompt gate blocks missing setup with local recovery guidance', (t) => {
  const fixture = installedGateFixture(t);
  const result = invokeGate(fixture, 'UserPromptSubmit', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /proxy binary missing/);
  assert.match(result.stderr, /start.*recover.*doctor.*env --remove.*resubmit/s);
});

test('stable launcher fails locally when the installed plugin disappears', (t) => {
  const fixture = installedGateFixture(t);
  fs.writeFileSync(fixture.registry, JSON.stringify({ plugins: {} }));
  const result = invokeGate(fixture, 'UserPromptSubmit');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reinstall Model Gateway/);
});

test('stable gate follows upgrade and downgrade registry entries after old caches disappear', (t) => {
  const fixture = installedGateFixture(t);
  for (const version of ['1.0.0', '2.0.0', '0.9.0']) {
    const installPath = path.join(fixture.home, 'cache', version);
    fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(installPath, 'bin', 'model-gateway.js'), `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(version)}));`);
    fs.writeFileSync(fixture.registry, JSON.stringify({ plugins: { 'model-gateway@test': [{ version, installPath }] } }));
    const result = invokeGate(fixture, 'UserPromptSubmit');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
    fs.rmSync(installPath, { recursive: true });
  }
});

test('installed gate waits for delayed recovery and kills its CLI at the finite deadline', { timeout: 40000 }, (t) => {
  const fixture = installedGateFixture(t);
  const installPath = path.join(fixture.home, 'delayed-install');
  const script = path.join(installPath, 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(fixture.registry, JSON.stringify({ plugins: { 'model-gateway@test': [{ version: '1.0.0', installPath }] } }));
  fs.writeFileSync(script, "process.stdin.resume(); setTimeout(() => console.log('recovery complete'), 250);");
  const ready = invokeGate(fixture, 'UserPromptSubmit');
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /recovery complete/);
  const pidFile = path.join(fixture.home, 'delayed.pid');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const started = Date.now();
  const expired = invokeGate(fixture, 'UserPromptSubmit');
  assert.equal(expired.status, 2, expired.stderr);
  assert.match(expired.stderr, /25s deadline.*start, recover, doctor.*resubmit/s);
  assert.ok(Date.now() - started < 30000, 'internal deadline finishes below the installed 35s hook timeout');
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
});

test('persistent intentional stop prevents automatic start before any launch or ownership probe', async () => {
  recordIntentionalStop();
  try {
    const result = await startAll({ proxyExists: () => { throw new Error('must not inspect proxy'); } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /intentionally stopped/);
  } finally { resumeIntentionalStop(); }
});

test('healthy recovery leaves the current supervisor untouched', async () => {
  const result = await startAll({
    proxyExists: () => true, ensureState: () => {},
    probeShim: async () => ({ state: 'running-ours', owner: { state: 'same-install' }, pid: process.pid, health: { proxyRecovery: true, supervisorVersion: PLUGIN_VERSION } }),
    reapOrphans: () => {}, refreshCatalog: async () => {},
    stopSupervisor: () => { throw new Error('healthy supervisor must not stop'); },
    spawnSupervisor: () => { throw new Error('healthy supervisor must not restart'); },
  });
  assert.equal(result.ok, true);
});

test('migration adds gates only to registered wiring and preserves pins and unrelated settings', (t) => {
  const fixture = installedGateFixture(t);
  const settingsFile = path.join(fixture.home, '.claude', 'settings.local.json');
  const initial = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764', CUSTOM: 'retained' }, permissions: { allow: ['Read'] } };
  fs.writeFileSync(settingsFile, JSON.stringify(initial));
  fs.writeFileSync(path.join(fixture.home, '.claude', 'model-gateway', 'wired-projects.json'), JSON.stringify({ projects: [fixture.home] }));
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../lib/commands.js'))}).migrateReadinessGates()`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: fixture.home, env: fixture.environment, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(migrated.hooks.UserPromptSubmit[0].hooks[0].command, `node "${fixture.launcher}" readiness-gate`);
  assert.deepEqual(migrated.env, initial.env);
  assert.deepEqual(migrated.permissions, initial.permissions);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'settings.json')), false);
});

test('startup failure evidence is scoped to its supervisor and generation', () => {
  writeStartupFailure('owned failure');
  assert.equal(startupFailureFor(process.pid, null), 'owned failure');
  assert.equal(startupFailureFor(process.pid + 1, null), null);
  assert.equal(startupFailureFor(process.pid, 'different-generation'), null);
});
