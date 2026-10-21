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

test('stable wired gate fails with exit 2 when the installed plugin disappears', (t) => {
  const fixture = installedGateFixture(t);
  fs.writeFileSync(fixture.registry, JSON.stringify({ plugins: {} }));
  const result = invokeGate(fixture, 'UserPromptSubmit', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Reinstall Model Gateway/);
});

test('stable non-gateway gate succeeds without an installed CLI or spawn', (t) => {
  const fixture = installedGateFixture(t);
  fs.rmSync(fixture.registry);
  const result = invokeGate(fixture, 'UserPromptSubmit');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('absent plugin entry still attempts wired recovery', (t) => {
  const fixture = installedGateFixture(t);
  const result = invokeGate(fixture, 'UserPromptSubmit', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /proxy binary missing/);
});

test('explicit effective plugin false skips recovery before CLI resolution or spawn', (t) => {
  const fixture = installedGateFixture(t);
  fs.writeFileSync(path.join(fixture.home, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'model-gateway@eigenwise-toolshed': false } }));
  fs.rmSync(fixture.registry);
  const result = invokeGate(fixture, 'UserPromptSubmit', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /explicitly disabled.*re-enable.*env --remove/);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'model-gateway', 'lifecycle.lock')), false);
});

test('stable gate follows upgrade and downgrade registry entries after old caches disappear', (t) => {
  const fixture = installedGateFixture(t);
  for (const version of ['1.0.0', '2.0.0', '0.9.0']) {
    const installPath = path.join(fixture.home, 'cache', version);
    fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(installPath, 'bin', 'model-gateway.js'), `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(version)}));`);
    fs.writeFileSync(fixture.registry, JSON.stringify({ plugins: { 'model-gateway@test': [{ version, installPath }] } }));
    const result = invokeGate(fixture, 'UserPromptSubmit', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764' });
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
  fixture.environment.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18764';
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

test('maintenance setup preserves persistent stop through a bounded acquisition failure', (t) => {
  const fixture = installedGateFixture(t);
  const script = `
    require(${JSON.stringify(require.resolve('../lib/lifecycle-lock.js'))}).recordIntentionalStop();
    require(${JSON.stringify(require.resolve('../lib/process-supervision.js'))}).fetchUrl = async () => ({ status: 503 });
    process.argv = [process.execPath, ${JSON.stringify(require.resolve('../bin/model-gateway.js'))}, 'setup', '--preserve-wiring'];
    require(${JSON.stringify(require.resolve('../lib/commands.js'))}).commands.setup();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: fixture.home, env: fixture.environment, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /GitHub API returned 503/);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'model-gateway', 'intentionally-stopped.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'settings.local.json')), false);
});

function launchHandoffFixture(testContext, scenario) {
    const fixture = installedGateFixture(testContext);
    const spawnWithoutPid = scenario.spawnFailure ? `
      require(${JSON.stringify(require.resolve('../lib/runtime.js'))}).WIN = false;
      require(${JSON.stringify(require.resolve('../lib/lifecycle-lock.js'))}).withLifecycleLock = async (operation) => operation();
      const children = require('node:child_process');
      const nativeSpawn = children.spawn;
      children.spawn = (command, arguments_, options) => (arguments_.includes('serve-shim')
        ? nativeSpawn(${JSON.stringify(path.join(fixture.home, 'sq3816-nonexistent-executable'))}, [], options)
        : nativeSpawn(command, arguments_, options));
    ` : '';
    const script = `
      ${spawnWithoutPid}
      const fs = require('node:fs');
      const path = require('node:path');
      const home = require('node:os').homedir();
      const binary = process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy';
      const bin = path.join(home, '.claude', 'model-gateway', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, binary), 'fixture');
      require('node:child_process').spawnSync = (command, arguments_, options) => {
        if (arguments_[0] === 'codex') return { status: 1, stdout: '', stderr: '' };
        if (arguments_[0] === '-xf') fs.writeFileSync(path.join(options.cwd, binary), 'fixture');
        const version = command.includes('stage-') ? '2.0.0' : '1.0.0';
        return { status: 0, stdout: version, stderr: '' };
      };
      const supervision = require(${JSON.stringify(require.resolve('../lib/process-supervision.js'))});
      supervision.fetchUrl = async () => ({ status: 200, body: Buffer.from('{}') });
      const assert = require('node:assert/strict');
      const marker = path.join(bin, '..', 'intentionally-stopped.json');
      const guardian = path.join(bin, '..', 'guardian.pid');
      const remove = fs.rmSync;
      fs.rmSync = (file, options) => {
        if (String(file).includes('stage-')) {
          if (${JSON.stringify(scenario.name)} === 'cleanup-failure') throw Object.assign(new Error('fixture EPERM stage cleanup'), { code: 'EPERM' });
          assert.equal(fs.existsSync(marker), true, 'cleanup precedes resume');
        }
        return remove(file, options);
      };
      supervision.portListening = async () => {
        if (${JSON.stringify(scenario.name)} === 'cleanup-failure') return false;
        throw new Error('stopped gateway must not be probed');
      };
      supervision.resolvePortOwner = async () => {
        if (${JSON.stringify(scenario.name)} === 'cleanup-failure') return { state: 'free' };
        throw new Error('pre-start ownership probe');
      };
      supervision.shimHealthy = async () => true;
      supervision.restartWorkerWithDrain = async () => { throw new Error('stopped worker must not restart'); };
      const fakeLaunch = (name) => {
        assert.equal(fs.existsSync(marker), true, 'stop persists between spawn and guardian record');
        fs.writeFileSync(guardian, '12345');
        return 12345;
      };
      if (!${JSON.stringify(Boolean(scenario.launchFailure || scenario.spawnFailure))}) supervision.spawnDetached = fakeLaunch;
      const makeDirectory = fs.mkdtempSync;
      fs.mkdtempSync = (prefix, options) => {
        if (path.basename(String(prefix)).startsWith('launch-')) throw Object.assign(new Error('fixture EPERM detached launch directory'), { code: 'EPERM' });
        return makeDirectory(prefix, options);
      };
      const shimState = require(${JSON.stringify(require.resolve('../lib/shim-state.js'))});
      shimState.fetchShimHealth = async () => { throw new Error('pre-start health probe'); };
      shimState.probeShimState = async () => {
        if (fs.existsSync(guardian)) return { state: 'stopped', owner: { state: 'free' } };
        assert.equal(fs.existsSync(marker), true, 'ownership decision precedes resume');
        if (${JSON.stringify(scenario.name)} === 'foreign-owner') return { state: 'running-foreign', pid: 42, owner: { state: 'foreign-install', pid: 42 } };
        return { state: 'stopped', owner: { state: 'free' } };
      };
      supervision.reapGatewayOrphans = () => {};
      require(${JSON.stringify(require.resolve('../lib/release-verification.js'))}).downloadVerifiedArchive = async () => Buffer.from('verified fixture');
      require(${JSON.stringify(require.resolve('../lib/lifecycle-lock.js'))}).recordIntentionalStop();
      const command = ${JSON.stringify(scenario.name)};
      process.argv = [process.execPath, 'fixture', command === 'start' || command === 'foreign-owner' ? 'start' : 'setup', ...${JSON.stringify(scenario.arguments)}];
      const commands = require(${JSON.stringify(require.resolve('../lib/commands.js'))});
      if (command === 'start' || command === 'foreign-owner') {
        commands.commands.start().catch(error => { console.error(error); process.exitCode = 1; });
      } else {
        commands.commands.setup().catch(error => { console.error(error); process.exitCode = 1; });
      }
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: fixture.home, env: fixture.environment, encoding: 'utf8', timeout: 10000, windowsHide: true });
    return { fixture, result };
}

const launchHandoffScenarios = [
  { name: 'maintenance', arguments: ['--preserve-wiring'], stopped: true, status: 0 },
  { name: 'cleanup-failure', arguments: [], stopped: true, status: 1, error: /EPERM stage cleanup/ },
  { name: 'setup', arguments: [], stopped: false, status: 0 },
  { name: 'start', arguments: [], stopped: false, status: 0 },
  { name: 'foreign-owner', arguments: [], stopped: true, status: 1 },
  { name: 'start', label: 'start launch failure', arguments: [], launchFailure: true, stopped: true, status: 1, error: /EPERM detached launch directory/ },
  { name: 'setup', label: 'setup launch failure', arguments: [], launchFailure: true, stopped: true, status: 1, error: /EPERM detached launch directory/ },
  { name: 'start', label: 'start spawn without a pid', arguments: [], spawnFailure: true, stopped: true, status: 1, error: /launch produced no process id/ },
  { name: 'setup', label: 'setup spawn without a pid', arguments: [], spawnFailure: true, stopped: true, status: 1, error: /launch produced no process id/ },
];

for (const scenario of launchHandoffScenarios) {
  test(`intentional stop launch handoff: ${scenario.label || scenario.name}`, { skip: scenario.launchFailure && process.platform !== 'win32' }, (testContext) => {
    const { fixture, result } = launchHandoffFixture(testContext, scenario);
    assert.equal(result.status, scenario.status, result.stderr);
    if (scenario.error) assert.match(result.stderr, scenario.error);
    const state = path.join(fixture.home, '.claude', 'model-gateway');
    assert.equal(fs.existsSync(path.join(state, 'intentionally-stopped.json')), scenario.stopped, 'failed launch preserves intentional stop');
    assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), !scenario.stopped, 'only a created supervisor has a guardian record');
    if (!scenario.stopped) assert.equal(fs.readFileSync(path.join(state, 'guardian.pid'), 'utf8'), '12345');
  });
}

test('startup failure evidence is scoped to its supervisor and generation', () => {
  writeStartupFailure('owned failure');
  assert.equal(startupFailureFor(process.pid, null), 'owned failure');
  assert.equal(startupFailureFor(process.pid + 1, null), null);
  assert.equal(startupFailureFor(process.pid, 'different-generation'), null);
});
