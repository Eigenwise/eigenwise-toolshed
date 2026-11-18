'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  gatewayTestEnvironment,
  observeGatewayChildClose,
  processIsRunning,
  removeOwnedGatewayTestHome,
  requireFixtureShutdown,
  spawnGatewayProcess,
  stopGatewayChild,
} = require('./support.js');

const IDLE_CHILD_SCRIPT = 'process.send("ready"); setInterval(() => {}, 1000);';

function permissionDenied() {
  throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
}

function processMissing() {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

test('fixture shutdown trusts observed close without probing a reused pid', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  child.emit('close');
  let probes = 0;
  const isRunning = (pid) => {
    probes += 1;
    return processIsRunning(pid, { kill: permissionDenied, platform: 'linux' });
  };
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning));
  assert.equal(probes, 0, 'an observed close must prevent even an EPERM probe');
});

test('fixture shutdown accepts ESRCH for a pid without observed close', () => {
  const isRunning = (pid) => processIsRunning(pid, { kill: processMissing });
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [], pids: [1234], closed: true,
  }, isRunning));
});

test('fixture shutdown rejects a running pid without observed close', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  const probes = [];
  const isRunning = (pid) => processIsRunning(pid, {
    kill: (probedPid, signal) => probes.push([probedPid, signal]),
  });
  assert.throws(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning), { code: 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE' });
  assert.deepEqual(probes, [[child.pid, 0]]);
});

test('fixture process probe treats Windows EPERM as a foreign pid', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'win32' }), false);
});

test('fixture process probe preserves non-Windows EPERM liveness', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'linux' }), true);
});

test('fixture process probe treats ESRCH as exited on every platform', () => {
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'win32' }), false);
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'linux' }), false);
});

test('fixture process probe preserves unexpected errors as possibly running', () => {
  const kill = () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); };
  assert.equal(processIsRunning(1234, { kill, platform: 'win32' }), true);
});

test('fixture process probe ignores missing pids', () => {
  assert.equal(processIsRunning(null, { kill: assert.fail }), false);
});

test('fixture live-pid failure remembers only the first true candidate without probing closed or later pids', () => {
  const closed = Object.assign(new EventEmitter(), { pid: 101 });
  observeGatewayChildClose(closed);
  closed.emit('close');
  const probes = [];
  assert.throws(() => requireFixtureShutdown('synthetic-owned-root', {
    children: [closed], pids: [closed.pid, 202, 303, 404], closed: true,
  }, (pid) => { probes.push(pid); return pid === 303; }), (error) => {
    assert.equal(error.code, 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE');
    assert.equal(error.fixturePid, 303);
    return true;
  });
  assert.deepEqual(probes, [202, 303]);
});

async function removalDiagnostic(home, failedPath, shutdown = { children: [], pids: [], closed: true }, diagnosticProbe = assert.fail) {
  let clock = 0;
  const cause = Object.assign(new Error('synthetic owned-root removal fault'), {
    code: 'EBUSY', path: failedPath, syscall: 'rmdir',
  });
  try {
    await removeOwnedGatewayTestHome(home, {
      timeout: 10,
      now: () => clock,
      pause: async (milliseconds) => { clock += milliseconds; },
      remove: async () => { throw cause; },
      shutdown,
      diagnosticProbe,
    });
    assert.fail('injected removal must fail');
  } catch (error) {
    assert.equal(error.cause, cause);
    return error;
  }
}

for (const scenario of [
  { name: 'root', failedPath: (home) => home, relative: '.', inside: true },
  { name: 'descendant', failedPath: (home) => path.join(home, 'leaf.work'), relative: 'leaf.work', inside: true },
  { name: 'outside', failedPath: (home) => path.join(home, '..', 'not-this-owned-root'), relative: null, inside: false },
  { name: 'unavailable', failedPath: () => undefined, relative: null, inside: null },
]) {
  test(`owned-root teardown diagnostics type the ${scenario.name} failure path without extra process probes`, async (testContext) => {
    const environment = gatewayTestEnvironment(testContext);
    const error = await removalDiagnostic(environment.HOME, scenario.failedPath(environment.HOME));
    assert.equal(error.details.code, 'EBUSY');
    assert.equal(error.details.syscall, 'rmdir');
    assert.equal(error.details.relativePath, scenario.relative);
    assert.equal(error.details.pathInsideOwnedRoot, scenario.inside);
    assert.deepEqual(error.details.processes, []);
    assert.equal(error.details.attempts, 1);
    assert.equal(error.details.elapsedMs, 10);
  });
}

for (const scenario of [
  { name: 'unverified live child', exitCode: null, close: false, liveness: 'not-probed' },
  { name: 'observed exit without close', exitCode: 0, close: false, liveness: 'exit-observed' },
  { name: 'observed close', exitCode: 0, close: true, liveness: 'close-observed' },
]) {
  test(`failure diagnostics never probe a reused or ${scenario.name} numeric pid`, async (testContext) => {
    const environment = gatewayTestEnvironment(testContext);
    const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: scenario.exitCode, signalCode: null });
    observeGatewayChildClose(child);
    if (scenario.close) child.emit('close');
    const shutdown = {
      children: [child],
      pids: [],
      closed: true,
      stopResults: [{ pid: child.pid, source: 'recorded', result: false }],
    };
    const error = await removalDiagnostic(environment.HOME, environment.HOME, shutdown);
    const diagnostic = error.details.children[0];
    assert.equal(diagnostic.identityState, 'unverified-child-handle');
    assert.equal(diagnostic.liveness.state, scenario.liveness);
    assert.equal(diagnostic.liveness.errorCode, null);
    assert.equal(diagnostic.stopResult, false);
    assert.equal(diagnostic.closeObserved, scenario.close);
  });
}

test('owned-root cleanup refuses removal while a recorded process is alive', async (testContext) => {
  const child = spawn(process.execPath, ['-e', IDLE_CHILD_SCRIPT], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  observeGatewayChildClose(child);
  testContext.after(() => stopGatewayChild(child));
  const environment = gatewayTestEnvironment(testContext);
  assert.equal(gatewayTestEnvironment(null, { HOME: environment.HOME }).HOME, environment.HOME);
  const stateDirectory = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(stateDirectory, { recursive: true });
  await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  fs.writeFileSync(path.join(stateDirectory, 'shim.pid'), `${child.pid}\n`);
  fs.writeFileSync(path.join(stateDirectory, 'guardian.pid'), '\n');

  await assert.rejects(removeOwnedGatewayTestHome(environment.HOME, {
    shutdown: {
      children: [],
      closed: true,
      pids: [child.pid],
      stopResults: [{ pid: child.pid, source: 'recorded', result: false }],
    },
    remove: () => assert.fail('a live recorded process must prevent home removal'),
    diagnosticProbe: assert.fail,
  }), (error) => {
    assert.equal(error.cause.code, 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE');
    assert.equal(error.cause.fixturePid, child.pid);
    assert.equal(error.details.failingPid, child.pid);
    assert.deepEqual(error.details.knownPids, [child.pid]);
    assert.equal(error.details.processes[0].ownership, 'recorded-only');
    assert.equal(error.details.processes[0].identityState, 'unverified-recorded-pid');
    assert.equal(error.details.processes[0].liveness.state, 'not-probed');
    assert.equal(error.details.processes[0].stopResult, false);
    return true;
  });
  assert.equal(fs.existsSync(environment.HOME), true);
});

test('failure diagnostics classify probe outcomes on a tracked live child', async (testContext) => {
  const environment = gatewayTestEnvironment(testContext);
  const stateDirectory = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const child = spawnGatewayProcess(testContext, process.execPath, ['-e', IDLE_CHILD_SCRIPT], {
    cwd: environment.HOME,
    env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  fs.writeFileSync(path.join(stateDirectory, 'shim.pid'), `${child.pid}\n`);

  for (const [diagnosticCode, expectedState] of [
    [null, 'probe-succeeded'],
    ['EPERM', 'unknown'],
    ['ESRCH', 'absent'],
  ]) {
    const probes = [];
    const error = await removalDiagnostic(environment.HOME, environment.HOME, {
      children: [child],
      pids: [],
      closed: true,
      stopResults: [{ pid: child.pid, source: 'direct', result: true }],
    }, (pid, signal) => {
      probes.push([pid, signal]);
      if (diagnosticCode) throw Object.assign(new Error('synthetic diagnostic probe'), { code: diagnosticCode });
    });
    const diagnostic = error.details.children[0];
    assert.equal(diagnostic.ownership, 'direct-child');
    assert.equal(diagnostic.identityState, 'tracked-child-handle');
    assert.equal(diagnostic.closeObserved, false);
    assert.equal(diagnostic.stopResult, true);
    assert.equal(diagnostic.liveness.state, expectedState);
    assert.equal(diagnostic.liveness.errorCode, diagnosticCode);
    assert.deepEqual(probes, [[child.pid, 0]]);
  }

  assert.equal(await stopGatewayChild(child), true);
  const closedError = await removalDiagnostic(environment.HOME, environment.HOME, {
    children: [child],
    pids: [child.pid],
    closed: true,
  });
  assert.equal(closedError.details.processes[0].liveness.state, 'close-observed');
  assert.equal(closedError.details.processes[0].stopResult, null);
});
