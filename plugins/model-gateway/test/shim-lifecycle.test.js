'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { describeShimState, probeShimState } = require('../lib/shim-state.js');
const { PLUGIN_VERSION, compatibilityPortOwnerIdentifiers, processAlive, startAll, statusReport } = require('../lib/commands.js');
const { createProxyRecovery, portListening, processOwningPort, proxyModelsAnswering } = require('../lib/process-supervision.js');
const { spawnGatewayProcessSync } = require('./support.js');

test('supervisor waits out a slow-starting proxy child instead of racing it (#251)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-slow-proxy-'));
  const script = path.join(root, 'slow-proxy.js');
  fs.writeFileSync(script, [
    "const http = require('node:http');",
    'const startedAt = Date.now();',
    "const server = http.createServer((request, response) => { response.writeHead(Date.now() - startedAt >= Number(process.env.WARMUP_MS) ? 200 : 503); response.end('{}'); });",
    "server.once('error', (error) => process.exit(error.code === 'EADDRINUSE' ? 1 : 2));",
    "server.listen(Number(process.env.PORT), '127.0.0.1');",
  ].join('\n'));
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port: freePort } = probe.address(); probe.close(() => resolve(freePort)); });
  });
  const children = [];
  const exitCodes = [];
  const stopped = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recovery = createProxyRecovery({
    proxyBinary: script,
    proxyPort: port,
    probe: () => proxyModelsAnswering(port),
    listening: portListening,
    owner: async () => children.at(-1)?.pid,
    ownsProxy: async () => true,
    stop: async (pid) => { stopped.push(pid); process.kill(pid); return true; },
    start: () => {
      const child = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port), WARMUP_MS: '1500' }, stdio: 'ignore', windowsHide: true });
      child.once('exit', (code) => exitCodes.push(code));
      children.push(child);
      return child;
    },
    binaryExists: () => true,
    report: () => {},
    initialBackoffMs: 50,
  });

  let result = await recovery.recover();
  for (let tick = 0; tick < 80 && !result.ok; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await recovery.recover();
  }

  assert.equal(result.ok, true, `the first proxy finished warming up: ${JSON.stringify(result)}`);
  assert.equal(children.length, 1, 'no second proxy was started while the first was warming up');
  assert.deepEqual(stopped, [], 'the warming proxy was never stopped');
  assert.deepEqual(exitCodes, [], 'no proxy died on EADDRINUSE');
});

test('a proxy child still not ready after its startup grace is stopped before its replacement starts', async () => {
  let clock = 0;
  const started = [];
  const stopped = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => false,
    listening: async () => false,
    binaryExists: () => true,
    start: () => {
      const child = Object.assign(new EventEmitter(), { pid: 900 + started.length });
      started.push(child);
      return child;
    },
    stop: async (pid) => { stopped.push(pid); started.find((child) => child.pid === pid).emit('exit', null, 'SIGTERM'); return true; },
    waitForRelease: async () => true,
    now: () => clock,
    report: () => {},
    initialBackoffMs: 10,
  });

  assert.equal((await recovery.recover()).state, 'starting');
  clock = 5000;
  assert.deepEqual(await recovery.recover(), { ok: false, state: 'starting', pid: 900 });
  assert.equal(started.length, 1);

  clock = 31000;
  await recovery.recover();
  assert.deepEqual(stopped, [900], 'the stale child is stopped first');
  assert.equal(started.length, 2);

  started[1].emit('exit', 1, null);
  clock = 32000;
  await recovery.recover();
  assert.deepEqual(stopped, [900], 'a child that already exited needs no stop');
  assert.equal(started.length, 3);
});

const currentHealth = { ok: true, proxyRecovery: true, supervisorVersion: PLUGIN_VERSION };
const outdatedHealth = { ok: true, proxyRecovery: true, supervisorVersion: '0.0.1' };

function probeWith({ owner, health = null, recordedPid = null, record = null }) {
  return probeShimState({
    resolveOwner: async () => owner,
    fetchHealth: async () => health,
    recordedSupervisorPid: () => recordedPid,
    supervisorRecord: () => record,
  });
}

test('the shared shim probe names each of its four states', async () => {
  const ours = await probeWith({ owner: { state: 'same-install', pid: 800, installRoot: '/cache/model-gateway/1.0.0' }, health: { ok: true, supervisorVersion: '1.2.3' } });
  assert.equal(ours.state, 'running-ours');
  assert.equal(ours.version, '1.2.3');
  assert.match(describeShimState(ours), /^shim \(model router\) on :\d+: running-ours \(serving 1\.2\.3\)$/);

  const unversioned = await probeWith({ owner: { state: 'unknown', pid: 800, reason: 'timeout' }, health: { ok: true } });
  assert.equal(unversioned.state, 'running-ours', 'our control endpoint answering outranks an ownership probe that timed out');
  assert.match(describeShimState(unversioned), /running-ours \(serving version unavailable\)$/);

  const foreign = await probeWith({ owner: { state: 'foreign-install', pid: 702, installRoot: '/foreign/model-gateway' }, health: { ok: true, version: '9.9.9' } });
  assert.deepEqual([foreign.state, foreign.pid, foreign.image], ['running-foreign', 702, '/foreign/model-gateway']);
  assert.match(describeShimState(foreign), /running-foreign \(PID 702, \/foreign\/model-gateway\)$/);

  const unidentified = await probeWith({ owner: { state: 'unknown', pid: 703, reason: 'unreadable-command' } });
  assert.equal(unidentified.state, 'running-foreign');
  assert.match(describeShimState(unidentified), /running-foreign \(PID 703, owner unidentified: unreadable-command\)$/);

  const bound = await probeWith({ owner: { state: 'same-install', pid: 801, installRoot: '/cache/model-gateway/1.0.0' }, record: { pid: 801, startedAt: '2026-09-28T10:00:00Z' } });
  assert.deepEqual([bound.state, bound.pid, bound.since], ['starting', 801, '2026-09-28T10:00:00Z']);
  assert.match(describeShimState(bound), /starting \(PID 801 since 2026-09-28T10:00:00Z\)$/);

  const unbound = await probeWith({ owner: { state: 'unowned', pid: null }, recordedPid: 802, record: { pid: 999, startedAt: 'other' } });
  assert.deepEqual([unbound.state, unbound.pid, unbound.since], ['starting', 802, null]);
  assert.match(describeShimState(unbound), /starting \(PID 802\)$/);

  const stopped = await probeWith({ owner: { state: 'unowned', pid: null } });
  assert.equal(stopped.state, 'stopped');
  assert.match(describeShimState(stopped), /: stopped$/);
});

test('a failed ownership probe reads as an unidentified listener, not a crash', async () => {
  const shim = await probeShimState({
    resolveOwner: () => { throw new Error('netstat exploded'); },
    fetchHealth: async () => null,
  });
  assert.equal(shim.state, 'running-foreign');
  assert.equal(shim.owner.reason, 'unidentified');
});

function startHarness(states, overrides = {}) {
  const calls = [];
  const probes = [...states];
  const options = {
    proxyExists: () => true,
    ensureState: () => {},
    recordLifecycle: (event) => calls.push(`lifecycle:${event}`),
    probeShim: async () => probes.length > 1 ? probes.shift() : probes[0],
    reapOrphans: (pid) => calls.push(`reap:${pid}`),
    stopSupervisor: async () => { calls.push('stop'); return { ok: true }; },
    spawnSupervisor: () => calls.push('spawn'),
    supervisorAlive: () => false,
    awaitReadiness: async (options) => { calls.push({ wait: options }); return { ok: true }; },
    refreshCatalog: async () => { calls.push('catalog'); },
    report: (line) => calls.push(`report:${line}`),
    ...overrides,
  };
  return { calls, run: (extra = {}) => startAll({ ...options, ...extra }) };
}

const oursCurrent = { state: 'running-ours', pid: 810, version: PLUGIN_VERSION, owner: { state: 'same-install', pid: 810 }, health: currentHealth };
const oursOutdated = { state: 'running-ours', pid: 811, version: '0.0.1', owner: { state: 'same-install', pid: 811 }, health: outdatedHealth };
const starting = { state: 'starting', pid: 812, since: null, owner: { state: 'same-install', pid: 812 }, health: null };
const stopped = { state: 'stopped', owner: { state: 'unowned', pid: null }, health: null };

test('ensure against its own healthy shim at the installed version is a no-op success (#230)', async () => {
  const { calls, run } = startHarness([oursCurrent]);
  const result = await run({ lifecycleOperation: 'ensure' });

  assert.deepEqual(result, { ok: true, started: [], recoveryAttempted: false });
  assert.deepEqual(calls, [`report:${describeShimState(oursCurrent)}`, 'reap:810', 'catalog']);
});

test('ensure waits for a starting shim instead of binding a second supervisor (#230, #251)', async () => {
  const { calls, run } = startHarness([starting, oursCurrent]);
  const result = await run({ lifecycleOperation: 'ensure' });

  assert.equal(result.ok, true);
  assert.equal(calls.includes('spawn'), false, 'no second supervisor while the first is starting');
  assert.equal(calls.includes('stop'), false, 'the starting supervisor is left running');
  const [wait] = calls.filter((call) => call.wait).map((call) => call.wait);
  assert.equal(await wait.proxyAnswers(), true, 'the settle wait is about the shim, not the proxy');
  assert.equal(wait.shimFailureExists(), false, 'an old failure file is not evidence about this start');
});

test('a shim that never finishes starting is replaced after the bounded wait', async () => {
  const { calls, run } = startHarness([starting, starting]);
  const result = await run({ lifecycleOperation: 'ensure' });

  assert.deepEqual(result, { ok: true, started: ['shim'], recoveryAttempted: true });
  assert.equal(calls.filter((call) => call.wait).length, 2);
  assert.deepEqual(calls.filter((call) => typeof call === 'string' && !call.startsWith('report:')), [
    'lifecycle:ensure-recovery-started', 'stop', 'spawn', 'catalog', 'lifecycle:ensure-recovery-finished',
  ]);
  assert.ok(calls.includes('report:started: shim'));
});

test('setup keeps a starting supervisor it handed the proxy to', async () => {
  const { calls, run } = startHarness([starting, starting]);
  const result = await run({ lifecycleOperation: 'setup', preserveRunningSupervisor: true, quiet: true });

  assert.deepEqual(result, { ok: true, started: [], recoveryAttempted: false });
  assert.equal(calls.includes('stop') || calls.includes('spawn'), false);
});

test('setup waits for the handed-off proxy behind a current supervisor', async () => {
  const { calls, run } = startHarness([oursCurrent]);
  const result = await run({ preserveRunningSupervisor: true, quiet: true });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter((call) => call.wait).length, 1, 'the proxy readiness wait still runs');
  assert.equal(calls.includes('spawn'), false);
});

test('a stopped shim is started and an outdated one replaced', async () => {
  const fromStopped = startHarness([stopped]);
  assert.deepEqual(await fromStopped.run({ quiet: true }), { ok: true, started: ['shim'], recoveryAttempted: false });
  assert.deepEqual(fromStopped.calls.filter((call) => typeof call === 'string'), ['reap:null', 'spawn', 'catalog']);

  const fromOutdated = startHarness([oursOutdated]);
  assert.deepEqual(await fromOutdated.run({ quiet: true }), { ok: true, started: ['shim'], recoveryAttempted: false });
  assert.deepEqual(fromOutdated.calls.filter((call) => typeof call === 'string'), ['stop', 'spawn', 'catalog']);
});

test('a refused stop and a failed start both report why', async () => {
  const refusedStop = startHarness([oursOutdated], { stopSupervisor: async () => ({ ok: false, reason: 'owner changed' }) });
  assert.deepEqual(await refusedStop.run({ quiet: true, lifecycleOperation: 'ensure' }), { ok: false, reason: 'owner changed', recoveryAttempted: true });
  assert.equal(refusedStop.calls.includes('spawn'), false);

  const failedStart = startHarness([stopped], { awaitReadiness: async () => ({ ok: false, timedOut: false, reason: 'cannot bind' }) });
  assert.deepEqual(await failedStart.run({ quiet: true }), { ok: false, reason: 'cannot bind', recoveryAttempted: false });

  const slowStart = startHarness([stopped], { awaitReadiness: async () => ({ ok: false, timedOut: true }) });
  const slow = await slowStart.run({ quiet: true });
  assert.match(slow.reason, /^not healthy after 12s/);
  assert.deepEqual([slow.started, slow.waitCutShort], [['shim'], true]);

  const missingProxy = startHarness([stopped], { proxyExists: () => false });
  assert.deepEqual(await missingProxy.run(), { ok: false, reason: 'proxy binary missing (run setup)' });
});

test('setup judges the supervisor stop by whether its PID is gone, not by the kill exit code (GH-371)', () => {
  // Runs in an isolated home because the real stop path reads PID records and reaps orphans.
  const script = `
    const { spawnSync } = require('node:child_process');
    const supervision = require(${JSON.stringify(require.resolve('../lib/process-supervision.js'))});
    const { startAll } = require(${JSON.stringify(require.resolve('../lib/commands.js'))});
    async function setupAgainst(supervisorPid, killResult) {
      const spawned = [];
      const result = await startAll({
        quiet: true,
        lifecycleOperation: 'setup',
        proxyExists: () => true,
        ensureState: () => {},
        recordLifecycle: () => {},
        probeShim: async () => ({ state: 'running-ours', pid: supervisorPid, version: '0.0.1', owner: { state: 'same-install', pid: supervisorPid }, health: { ok: true, proxyRecovery: true, supervisorVersion: '0.0.1' } }),
        reapOrphans: () => {},
        stopSupervisor: (options) => supervision.stopRunningSupervisor({
          ...options,
          resolveOwner: async () => ({ state: 'same-install', pid: supervisorPid, installRoot: supervision.gatewayInstallRoot() }),
          kill: async () => killResult,
        }),
        spawnSupervisor: () => { spawned.push(supervisorPid); return 1; },
        supervisorAlive: () => false,
        awaitReadiness: async () => ({ ok: true }),
        refreshCatalog: async () => {},
        report: () => {},
      });
      return { ok: result.ok, reason: result.reason || null, spawned: spawned.length };
    }
    (async () => {
      const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
      const killFailedButGone = await setupAgainst(exitedPid, false);
      const killSucceededButAlive = await setupAgainst(process.pid, true);
      process.stdout.write(JSON.stringify({ killFailedButGone, killSucceededButAlive, alivePid: process.pid }));
    })();
  `;
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { killFailedButGone, killSucceededButAlive, alivePid } = JSON.parse(result.stdout);

  assert.deepEqual(killFailedButGone, { ok: true, reason: null, spawned: 1 }, 'a non-zero taskkill with the supervisor gone still starts the replacement');
  assert.equal(killSucceededButAlive.ok, false);
  assert.equal(killSucceededButAlive.spawned, 0);
  assert.equal(killSucceededButAlive.reason, `could not stop the shim supervisor on :0 (PID ${alivePid}); it is still running after the stop request`);
});

function timedOutStartHarness(states, { supervisorAlive, readiness = { ok: false, timedOut: true } }) {
  const finished = [];
  const harness = startHarness(states, {
    spawnSupervisor: () => 4242,
    supervisorAlive,
    awaitReadiness: async () => readiness,
    recordLifecycle: (event, fields) => { if (event.endsWith('-recovery-finished')) finished.push(fields); },
  });
  return { finished, run: harness.run };
}

test('a start that outlasts the wait with its supervisor alive is still starting, not failed (GH-360)', async () => {
  const alive = timedOutStartHarness([stopped], { supervisorAlive: (pid) => pid === 4242 });
  const result = await alive.run({ lifecycleOperation: 'setup' });

  assert.equal(result.ok, false);
  assert.equal(result.stillStarting, true);
  assert.equal(result.supervisorPid, 4242);
  assert.match(result.reason, /^still starting after \d+s; supervisor pid 4242 is running$/);
  assert.deepEqual(alive.finished.map(({ outcome, supervisorPid }) => [outcome, supervisorPid]), [['starting', 4242]]);
});

test('a timed-out start whose supervisor died is a failure (GH-360)', async () => {
  const dead = timedOutStartHarness([stopped], { supervisorAlive: () => false });
  const result = await dead.run({ lifecycleOperation: 'setup' });

  assert.equal(result.stillStarting, undefined);
  assert.match(result.reason, /^not healthy after \d+s/);
  assert.deepEqual(dead.finished.map(({ outcome, supervisorPid }) => [outcome, supervisorPid]), [['failed', undefined]]);
});

test('a shim failure file fails the start with its reason even while the supervisor lives (GH-360)', async () => {
  const crashed = timedOutStartHarness([stopped], {
    supervisorAlive: () => true,
    readiness: { ok: false, timedOut: false, reason: 'shim exited: EADDRINUSE' },
  });
  const result = await crashed.run({ lifecycleOperation: 'setup' });

  assert.deepEqual(result, { ok: false, reason: 'shim exited: EADDRINUSE', recoveryAttempted: true });
  assert.deepEqual(crashed.finished.map(({ outcome }) => outcome), ['failed']);
});

test('a preserved starting supervisor that outlasts the wait is judged by its own pid (GH-360)', async () => {
  const preserved = timedOutStartHarness([starting, starting], { supervisorAlive: (pid) => pid === starting.pid });
  const result = await preserved.run({ lifecycleOperation: 'setup', preserveRunningSupervisor: true });

  assert.deepEqual([result.stillStarting, result.supervisorPid], [true, starting.pid]);
});

test('the supervisor liveness probe tells a live pid from an exited or missing one (GH-360)', () => {
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(exited.pid), false);
  assert.equal(processAlive(0), false, 'pid 0 probes as live on Windows, so it must never reach process.kill');
  assert.equal(processAlive(undefined), false);
});

test('ensure refuses a foreign or unidentified listener without touching it', async () => {
  const foreign = startHarness([{ state: 'running-foreign', pid: 702, image: '/foreign', owner: { state: 'foreign-install', pid: 702, installRoot: '/foreign' }, health: null }]);
  assert.match((await foreign.run({ quiet: true })).reason, /PID 702 owns :\d+ from a different install root \(\/foreign\)/);

  const unidentified = startHarness([{ state: 'running-foreign', pid: 703, image: null, owner: { state: 'unknown', pid: 703, reason: 'unidentified' }, health: null }]);
  assert.match((await unidentified.run({ quiet: true, lifecycleOperation: 'ensure' })).reason, /could not confirm the owner/);
  assert.deepEqual(unidentified.calls, ['lifecycle:ensure-owner-unknown']);
});

test('status, doctor and ensure print the same shim state line (#275)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-shim-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const commandsPath = path.join(__dirname, '..', 'lib', 'commands.js');
  const script = `
    const gateway = require(${JSON.stringify(commandsPath)});
    const health = { ok: true, proxyRecovery: true, supervisorVersion: gateway.PLUGIN_VERSION, models: 3 };
    const readiness = { ready: true, state: 'ready', message: '', health,
      checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning: true, servingVersion: gateway.PLUGIN_VERSION, servingVersionMatches: true } };
    (async () => {
      console.log('<<status');
      await gateway.statusReport({ readiness });
      console.log('<<doctor');
      await gateway.commands.doctor({ readiness });
      console.log('<<ensure');
      await gateway.startAll({ proxyExists: () => true, ensureState: () => {}, fetchHealth: async () => health, refreshCatalog: async () => {} });
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    isolatedOverrides: { CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_WORKER_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
    env: { ...environment, HOME: home, USERPROFILE: home, CODEX_GATEWAY_PORT: '9', CODEX_GATEWAY_PROXY_PORT: '9' },
  });
  assert.ifError(result.error);
  assert.match(result.stdout, /<<ensure/, result.stderr);
  const sections = Object.fromEntries(result.stdout.split('<<').slice(1).map((section) => [section.split(/\r?\n/)[0], section]));
  const expected = `shim (model router) on :9: running-ours (serving ${PLUGIN_VERSION})`;
  for (const command of ['status', 'doctor', 'ensure']) {
    assert.ok(sections[command].includes(expected), `${command} printed:\n${sections[command]}`);
  }
});

test('RC-compatibility port owners are read from numeric columns in any UI language (#296)', () => {
  const germanNetstat = [
    'Aktive Verbindungen',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    0.0.0.0:80             0.0.0.0:0              ABHÖREN         71488',
    '  TCP    0.0.0.0:8080           0.0.0.0:0              ABHÖREN         9001',
    '  TCP    127.0.0.1:80           127.0.0.1:50123        HERGESTELLT     71488',
  ].join('\r\n');
  const lookup = (command) => ({ status: 0, stdout: command === 'netstat' ? germanNetstat : '71488\n' });
  assert.deepEqual(compatibilityPortOwnerIdentifiers(lookup), [71488]);
  assert.deepEqual(compatibilityPortOwnerIdentifiers(() => ({ status: 1, stdout: '' })), []);
});

test('the synchronous port owner lookup finds this process on its own listener', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.equal(processOwningPort(server.address().port), process.pid);
  assert.equal(processOwningPort(0), null);
});

test('status reports the RC-compatibility listener for each hosts and bind outcome', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const stoppedShim = async () => ({ state: 'stopped', pid: null, owner: { state: 'unowned', pid: null }, health: null });
  const compatOutcomes = [
    undefined,
    { hostsDetected: false },
    { hostsDetected: true, hostsLine: '127.0.0.1 api.anthropic.com', port80Bound: false, reason: 'EACCES' },
    { hostsDetected: true, hostsLine: '127.0.0.1 api.anthropic.com', port80Bound: true },
  ];
  for (const compat of compatOutcomes) {
    const readiness = { ready: false, state: 'proxy-down', message: 'proxy is down', health: { compat }, checks: { proxyModels: false, shimRunning: false } };
    await statusReport({ readiness, probeShim: stoppedShim });
  }
  const compatLines = lines.filter((line) => /RC-compatibility|bound:/.test(line));
  assert.deepEqual(compatLines, [
    'RC-compatibility hosts entry: not present (default gateway mode)',
    'RC-compatibility hosts entry: detected (127.0.0.1 api.anthropic.com)',
    '  127.0.0.1:80 bound: no (EACCES)',
    'RC-compatibility hosts entry: detected (127.0.0.1 api.anthropic.com)',
    '  127.0.0.1:80 bound: yes',
  ]);
});
