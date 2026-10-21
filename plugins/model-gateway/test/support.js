'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const START_TIMEOUT_MS = 5000;
const PROCESS_CLEANUP_TIMEOUT_MS = 5000;
const PROCESS_CLEANUP_POLL_MS = 25;
const FIXTURE_REMOVAL_BUDGET_MS = 6000;
const FIXTURE_REMOVAL_TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const gatewayFixtureProcesses = new Map();
const gatewayFixtureChildClosures = new WeakMap();
const gatewayTestEnvironments = new WeakMap();
// A spread copy of a test environment (`{ ...environment, EXTRA: '1' }`) is an object the WeakMap
// never saw, so its processes went untracked: teardown removed the home under a live supervisor, and
// the supervisor's exit writes recreated logs/ mid-removal (ENOTEMPTY on Windows CI) or after it (a
// leaked home everywhere else), SQ-3142. The owned home identifies the environment instead.
const ownedGatewayTestEnvironments = new Map();

function gatewayPidFile(home, name) {
  return path.join(home, '.claude', 'model-gateway', `${name}.pid`);
}

function processIsRunning(pid, { kill = process.kill, platform = process.platform } = {}) {
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (platform === 'win32' && error.code === 'EPERM') return false;
    return error.code !== 'ESRCH';
  }
}

function waitForProcessExit(pid) {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    Atomics.wait(delay, 0, 0, PROCESS_CLEANUP_POLL_MS);
  }
  return !processIsRunning(pid);
}

function observeGatewayChildClose(child) {
  const existing = gatewayFixtureChildClosures.get(child);
  if (existing) return existing;
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const state = { closed: false, promise };
  gatewayFixtureChildClosures.set(child, state);
  child.once('close', () => { state.closed = true; finish(true); });
  return state;
}

function registerGatewayChild(child, environment, fixtureCommand) {
  const state = observeGatewayChildClose(child);
  if (fixtureCommand === 'serve-worker') {
    state.worker = { home: environment.HOME, owner: ownedGatewayTestEnvironments.get(environment.HOME), port: null };
  }
}

function registerWorkerListener(child, port) {
  const worker = gatewayFixtureChildClosures.get(child)?.worker;
  if (worker) worker.port = port;
}

function fixtureControlFailed(child) {
  const state = gatewayFixtureChildClosures.get(child);
  if (!state) return false;
  const control = state.control;
  if (!control) return false;
  return Boolean(control.kind === 'failure' || (state.escalated && control.kind === 'transport-error'));
}

function completedFixtureStop(child, closed) {
  return closed && !fixtureControlFailed(child);
}

function recordFixtureEscalation(child) {
  const state = gatewayFixtureChildClosures.get(child);
  if (state) state.escalated = true;
}

function waitForGatewayChildClose(child, timeout = PROCESS_CLEANUP_TIMEOUT_MS) {
  const state = gatewayFixtureChildClosures.get(child);
  if (!state) return Promise.resolve(false);
  if (state.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeout));
    void state.promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function gatewayChildNeedsStop(child) {
  return Boolean(child.pid && child.exitCode == null && child.signalCode == null);
}

function requestFixtureSupervisorStop(child) {
  return new Promise((resolve) => {
    if (!child?.connected || typeof child.send !== 'function') return resolve(false);
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), PROCESS_CLEANUP_TIMEOUT_MS);
    try {
      child.send({ type: 'fixture-shutdown' }, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

function forceStopGatewayProcess(pid) {
  if (!processIsRunning(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// A recorded pid is not a child of this process, so IPC is not available and SIGTERM is
// the only graceful stop there is. Windows has none: taskkill without /F refuses outright
// on a windowless child, so asking would only spend the wait before forcing it anyway.
function requestGatewayProcessStop(pid) {
  if (!processIsRunning(pid)) return true;
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    if (waitForProcessExit(pid)) return true;
  }
  forceStopGatewayProcess(pid);
  return waitForProcessExit(pid);
}

// A child with no IPC stop path is never going to exit on its own, so waiting for it only
// burned the full cleanup timeout per test. Windows gets taskkill /T so a supervisor's worker
// goes with it instead of surviving untracked.
async function requestUnregisteredGatewayChildStop(child) {
  if (child.gracefulShutdown && child.connected) return child.disconnect();
  if (process.platform === 'win32') return forceStopGatewayProcess(child.pid);
  child.kill('SIGTERM');
}

async function requestGatewayChildStop(child, deadline) {
  if (child.fixtureShutdown) return requestFixtureSupervisorStop(child);
  if (gatewayFixtureChildClosures.get(child)?.worker) return requestFixtureWorkerDrain(child, deadline);
  return requestUnregisteredGatewayChildStop(child);
}

function stopGatewayChild(child) {
  if (child.stopPromise) return child.stopPromise;
  const stopping = (async () => {
    if (!gatewayChildNeedsStop(child)) return completedFixtureStop(child, await waitForGatewayChildClose(child));
    // Control delivery and real close observation share this first stop budget.
    const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
    const closed = waitForGatewayChildClose(child);
    await requestGatewayChildStop(child, deadline);
    if (await closed) return completedFixtureStop(child, true);
    // A descendant can retain stdio after this child exits. Its old numeric PID
    // is no longer ours to escalate, and missing close is still a failure.
    if (!gatewayChildNeedsStop(child)) return false;
    recordFixtureEscalation(child);
    forceStopGatewayProcess(child.pid);
    return completedFixtureStop(child, await waitForGatewayChildClose(child));
  })();
  child.stopPromise = stopping;
  return stopping;
}

// Every process spawned against a home is tracked, not just the latest: a `status` run after
// `serve-shim` used to replace the supervisor here, so teardown killed only the recorded worker,
// the untracked supervisor respawned it into the home being removed, and the removal error
// skipped the after hook that would have stopped the supervisor (SQ-3075).
async function stopGatewayFixtureProcesses(home) {
  const children = [...(gatewayFixtureProcesses.get(home) || [])];
  const outcomes = await Promise.all(children.map(stopGatewayChild));
  return { children, pids: children.map((child) => child.pid).filter(Boolean), closed: outcomes.every(Boolean) };
}

function trackGatewayFixtureProcess(home, child) {
  if (!gatewayFixtureProcesses.has(home)) gatewayFixtureProcesses.set(home, new Set());
  gatewayFixtureProcesses.get(home).add(child);
}

function stopRecordedGatewayProcesses(home, pids = []) {
  for (const name of ['shim', 'guardian', 'proxy']) {
    let pid;
    try { pid = Number(fs.readFileSync(gatewayPidFile(home, name), 'utf8').trim()) || null; } catch { pid = null; }
    if (!pid || pids.includes(pid)) continue;
    pids.push(pid);
    requestGatewayProcessStop(pid);
  }
  return pids;
}

async function stopTrackedGatewayProcesses(home) {
  const shutdown = await stopGatewayFixtureProcesses(home);
  shutdown.pids = stopRecordedGatewayProcesses(home, shutdown.pids);
  return shutdown;
}

function stopTrackedGatewayProcessesSynchronously(home) {
  return stopRecordedGatewayProcesses(home);
}

function firstFixturePath(home) {
  const pendingDirectories = [home];
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(entryPath);
      else return entryPath;
    }
  }
  return home;
}

function fixtureRemovalError(home, pids, error) {
  const survivingPid = pids.find(processIsRunning);
  const retainedPath = firstFixturePath(home);
  const survivor = survivingPid
    ? `surviving fixture PID ${survivingPid}; file it still holds or recreated: ${retainedPath}`
    : `no tracked fixture PID survived; retained file: ${retainedPath}`;
  const cleanupError = new Error(`could not remove gateway test home ${home}: ${survivor}; ${error.message}`);
  cleanupError.cause = error;
  return cleanupError;
}

function removeGatewayTestHome(home, pids = []) {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    throw fixtureRemovalError(home, pids, error);
  }
}

function fixtureCleanupInvariant(code, home) {
  return Object.assign(new Error(code), { code, path: home, syscall: 'fixture-teardown' });
}

function fixtureRootIdentity(home) {
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_OWNERSHIP', home);
  return { realPath: fs.realpathSync.native(home), device: stat.dev, inode: stat.ino, created: stat.birthtimeMs };
}

function registerOwnedGatewayHome(owner) {
  owner.rootIdentity = fixtureRootIdentity(owner.home);
  ownedGatewayTestEnvironments.set(owner.home, owner);
}

function sameFixtureRoot(left, right) {
  return left.realPath === right.realPath && left.device === right.device
    && left.inode === right.inode && left.created === right.created;
}

function registeredOwnedRoot(home, owner) {
  return Boolean(owner && owner.ownsHome && owner.home === home && ownedGatewayTestEnvironments.get(home) === owner);
}

function validateOwnedFixtureRoot(home, owner) {
  if (!registeredOwnedRoot(home, owner)) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_OWNERSHIP', home);
  let current;
  try { current = fixtureRootIdentity(home); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!sameFixtureRoot(owner.rootIdentity, current)) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_OWNERSHIP', home);
  return true;
}

function validFixtureControlPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function readyWorkerMetadata(child) {
  const worker = gatewayFixtureChildClosures.get(child)?.worker;
  return validFixtureControlPort(worker?.port) ? worker : null;
}

function workerControlOwnershipConfirmed(child, worker) {
  try {
    if (!gatewayFixtureProcesses.get(worker.home)?.has(child)) return false;
    return validateOwnedFixtureRoot(worker.home, worker.owner);
  } catch { return false; }
}

function controlTokenFromDescriptor(descriptor) {
  if (fs.fstatSync(descriptor).size > 65) throw new Error('invalid fixture control token');
  const buffer = Buffer.alloc(65);
  const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  const token = buffer.subarray(0, length).toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid fixture control token');
  return token;
}

function readFixtureControlToken(home) {
  const descriptor = fs.openSync(path.join(home, '.claude', 'model-gateway', 'control-token'), 'r');
  try { return controlTokenFromDescriptor(descriptor); } finally { fs.closeSync(descriptor); }
}

function prepareFixtureWorkerControl(child) {
  const worker = readyWorkerMetadata(child);
  if (!worker) return { kind: 'skipped', code: 'not-ready' };
  if (!workerControlOwnershipConfirmed(child, worker)) return { kind: 'failure', code: 'ownership-unavailable' };
  try { return { port: worker.port, token: readFixtureControlToken(worker.home) }; }
  catch { return { kind: 'failure', code: 'token-unavailable' }; }
}

function parseFixtureDrainResponse(body) {
  try {
    const value = JSON.parse(body);
    if (value?.ok === true && value.draining === true) return { kind: 'accepted', code: 'accepted' };
  } catch { /* malformed control response is a definite failure */ }
  return { kind: 'failure', code: 'bad-response' };
}

function receiveFixtureDrain(response, finish) {
  if (response.statusCode !== 202) {
    response.resume();
    finish({ kind: 'failure', code: `http-${response.statusCode}` });
    return;
  }
  let size = 0;
  const chunks = [];
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > 4096) { finish({ kind: 'failure', code: 'response-too-large' }); return; }
    chunks.push(chunk);
  });
  response.once('end', () => finish(parseFixtureDrainResponse(Buffer.concat(chunks).toString('utf8'))));
  response.once('error', () => finish({ kind: 'transport-error', code: 'response-error' }));
  response.once('aborted', () => finish({ kind: 'transport-error', code: 'response-aborted' }));
}

function deliverFixtureWorkerDrain(child, prepared, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    let response;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('close', onExit);
      request?.destroy();
      response?.destroy();
      resolve(result);
    };
    const onExit = () => finish({ kind: 'skipped', code: 'exited' });
    const timer = setTimeout(() => finish({ kind: 'failure', code: 'timeout' }), timeout);
    child.once('exit', onExit);
    child.once('close', onExit);
    try {
      request = http.request({
        hostname: '127.0.0.1', port: prepared.port, path: '/drain', method: 'POST', agent: false,
        headers: { connection: 'close', 'content-type': 'application/json', 'content-length': '2',
          'x-model-gateway-control-token': prepared.token },
      }, (incoming) => { response = incoming; receiveFixtureDrain(incoming, finish); });
      request.once('error', (error) => finish({ kind: 'transport-error', code: cleanupDiagnostic(error.code) }));
      request.end('{}');
    } catch { finish({ kind: 'failure', code: 'request-error' }); }
  });
}

function sendPreparedFixtureControl(child, state, prepared, deadline) {
  if (!gatewayChildNeedsStop(child) || state.closed) return { kind: 'skipped', code: 'exited' };
  const timeout = Math.min(1000, deadline - Date.now());
  if (timeout <= 0) return { kind: 'failure', code: 'timeout' };
  return deliverFixtureWorkerDrain(child, prepared, timeout);
}

function performFixtureWorkerDrain(child, state, deadline) {
  if (!gatewayChildNeedsStop(child) || state.closed) return { kind: 'skipped', code: 'exited' };
  const prepared = prepareFixtureWorkerControl(child);
  if (prepared.kind) return prepared;
  return sendPreparedFixtureControl(child, state, prepared, deadline);
}

async function requestFixtureWorkerDrain(child, deadline) {
  const state = gatewayFixtureChildClosures.get(child);
  if (!state?.worker) return { kind: 'skipped', code: 'not-worker' };
  if (state.control?.kind === 'failure') return state.control;
  const result = await performFixtureWorkerDrain(child, state, deadline);
  state.control = result;
  return result;
}

function requireFixtureShutdown(home, shutdown, isRunning = processIsRunning) {
  if (shutdown.children.some(fixtureControlFailed)) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_CONTROL_FAILED', home);
  if (!shutdown.closed) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_CLOSE_TIMEOUT', home);
  const closedPids = new Set(shutdown.children.filter((child) => gatewayFixtureChildClosures.get(child)?.closed === true)
    .map((child) => child.pid));
  if (shutdown.pids.some((pid) => !closedPids.has(pid) && isRunning(pid))) throw fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_PROCESS_ALIVE', home);
}

function removalDeadlineError(context) {
  return context.lastError ?? fixtureCleanupInvariant('ERR_GATEWAY_FIXTURE_REMOVAL_TIMEOUT', context.home);
}

function prepareOwnedRemovalAttempt(context) {
  if (!validateOwnedFixtureRoot(context.home, context.owner)) return false;
  // Root validation is synchronous IO too; do not start rm if it spent the budget.
  if (context.now() >= context.deadline) throw removalDeadlineError(context);
  context.attempts += 1;
  return true;
}

async function attemptOwnedRemoval(context) {
  if (!prepareOwnedRemovalAttempt(context)) return true;
  try {
    await context.remove(context.home, { recursive: true, force: true, maxRetries: 0 });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    context.lastError = error;
    if (!FIXTURE_REMOVAL_TRANSIENT_CODES.has(error.code)) throw error;
    return false;
  }
}

async function retryOwnedRemoval(context) {
  while (context.now() < context.deadline) {
    if (await attemptOwnedRemoval(context)) return;
    const remaining = Math.max(0, context.deadline - context.now());
    await context.pause(Math.min(100 * context.attempts, 500, remaining));
  }
  throw removalDeadlineError(context);
}

function cleanupDiagnostic(value, fallback = 'unknown') {
  return String(value ?? fallback).slice(0, 512);
}

function knownFixtureChildState(child) {
  const state = gatewayFixtureChildClosures.get(child);
  return {
    pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
    closeObserved: state?.closed === true, control: state?.control?.code ?? null,
  };
}

function ownedFixtureCleanupError(error, context, shutdown) {
  const details = {
    code: cleanupDiagnostic(error.code), path: cleanupDiagnostic(error.path, context.home),
    syscall: cleanupDiagnostic(error.syscall), attempts: context.attempts,
    elapsedMs: Math.max(0, context.now() - context.startedAt),
    knownPids: shutdown.pids.slice(0, 32),
    children: shutdown.children.slice(0, 32).map(knownFixtureChildState),
  };
  return Object.assign(new Error(`gateway test fixture cleanup failed: ${JSON.stringify(details)}`, { cause: error }), { details });
}

async function removeOwnedGatewayTestHome(home, {
  timeout = FIXTURE_REMOVAL_BUDGET_MS, now = Date.now, pause = sleep, remove = fs.promises.rm,
  shutdown = { pids: [], children: [], closed: true },
} = {}) {
  const startedAt = now();
  const context = { home, owner: ownedGatewayTestEnvironments.get(home), startedAt, deadline: startedAt + timeout,
    now, pause, remove, attempts: 0, lastError: null };
  try {
    requireFixtureShutdown(home, shutdown);
    await retryOwnedRemoval(context);
    ownedGatewayTestEnvironments.delete(home);
    gatewayFixtureProcesses.delete(home);
  } catch (error) {
    throw ownedFixtureCleanupError(error, context, shutdown);
  }
}

function deferFixtureCleanupFailure(t, error) {
  // Node can retain the primary assertion as the test error. Keep cleanup's
  // bounded evidence visible too, and fail a passing test after other hooks run.
  t.diagnostic(error.message);
  t.after(() => { throw error; });
}

function waitForHealth(port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const retry = () => {
      if (settled || timer) return;
      if (Date.now() >= deadline) {
        return finish(new Error(`listener ${port} did not become healthy within ${START_TIMEOUT_MS}ms`));
      }
      timer = setTimeout(() => {
        timer = null;
        attempt();
      }, 25);
    };
    const attempt = () => {
      if (settled) return;
      const request = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (response) => {
        response.resume();
        response.once('end', () => {
          if (response.statusCode === 200) finish();
          else retry();
        });
      });
      request.once('error', retry);
    };
    attempt();
  });
}

const FIXTURE_STARTUP_FILES = [
  'shim-supervisor-failure.txt', 'logs/lifecycle.jsonl', 'logs/guardian.log', 'logs/proxy.log', 'logs/shim.log',
  'guardian.pid', 'guardian.pid.json', 'shim.pid', 'shim.pid.json', 'proxy.pid', 'proxy.pid.json', 'proxy-serving-version.txt',
];

function fixtureFileExcerpt(file, maximumBytes = 2048) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, maximumBytes));
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    return `<unavailable: ${error.code}>`;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fixtureProxyPid(home) {
  const value = Number(fixtureFileExcerpt(gatewayPidFile(home, 'proxy'), 64));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function captureFixtureOutput(stream) {
  let buffer = Buffer.alloc(0);
  const append = (chunk) => {
    const recent = Buffer.from(chunk).subarray(-4096);
    buffer = Buffer.concat([buffer, recent]).subarray(-4096);
  };
  stream?.on('data', append);
  return {
    text: () => buffer.toString('utf8'),
    dispose: () => stream?.off('data', append),
  };
}

function fixtureSupervisorExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function observeFixtureExit(child) {
  let rejectExit;
  const exited = new Promise((_resolve, reject) => { rejectExit = reject; });
  const onExit = (code, signal) => rejectExit(new Error(`supervisor exited: code=${code} signal=${signal}`));
  const onError = (error) => rejectExit(error);
  child.once('exit', onExit);
  child.once('error', onError);
  if (fixtureSupervisorExited(child)) onExit(child.exitCode, child.signalCode);
  return {
    exited,
    dispose: () => { child.off('exit', onExit); child.off('error', onError); },
  };
}

function fixtureStartupFailure(error, home, stdout, stderr) {
  const state = path.join(home, '.claude', 'model-gateway');
  const files = FIXTURE_STARTUP_FILES.map((file) => `[${file}]\n${fixtureFileExcerpt(path.join(state, file))}`);
  return new Error([String(error.message).slice(0, 2048), `[supervisor stdout]\n${stdout.text()}`,
    `[supervisor stderr]\n${stderr.text()}`, ...files].join('\n'));
}

function receiveFixtureModels(response, finish) {
  response.resume();
  response.once('end', () => finish(response.statusCode === 200));
  response.once('error', () => finish(false));
}

function probeFixtureModels(port, timeout, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(ready);
    };
    // Wall-clock timer covers connection, headers and a response body that never ends.
    const timer = setTimeout(() => finish(false), timeout);
    request = http.get({ host: '127.0.0.1', port, path: '/v1/models', agent: false, signal },
      (response) => receiveFixtureModels(response, finish));
    request.once('error', () => finish(false));
  });
}

async function fixtureProxyReady(pid, context) {
  if (!pid || !context.isRunning(pid)) return false;
  const budget = Math.min(500, context.deadline - context.now());
  if (budget <= 0) return false;
  const ready = await context.probe(context.port, budget, context.signal);
  return ready && context.isRunning(pid);
}

function pauseFixtureStartup(milliseconds, signal) {
  return sleep(milliseconds, null, { signal });
}

async function pollFixtureProxy(context) {
  while (context.now() < context.deadline) {
    context.signal.throwIfAborted();
    const pid = context.readPid();
    if (await fixtureProxyReady(pid, context) && context.now() < context.deadline) return pid;
    await context.pause(Math.min(25, Math.max(0, context.deadline - context.now())), context.signal);
  }
  throw new Error(`fixture proxy not ready within ${context.timeout}ms of supervisor launch`);
}

async function waitForFixtureProxy(child, {
  home, port, startedAt, timeout = 15000, now = Date.now, pause = pauseFixtureStartup,
  readPid = () => fixtureProxyPid(home), isRunning = processIsRunning, probe = probeFixtureModels,
}) {
  if (!Number.isFinite(startedAt)) throw new TypeError('fixture supervisor launch time is required');
  const stdout = captureFixtureOutput(child.stdout);
  const stderr = captureFixtureOutput(child.stderr);
  const exit = observeFixtureExit(child);
  const controller = new AbortController();
  const context = { port, timeout, deadline: startedAt + timeout, now, pause, readPid, isRunning, probe, signal: controller.signal };
  try {
    return await Promise.race([exit.exited, pollFixtureProxy(context)]);
  } catch (error) {
    throw fixtureStartupFailure(error, home, stdout, stderr);
  } finally {
    controller.abort();
    exit.dispose();
    stdout.dispose();
    stderr.dispose();
  }
}

const ISOLATED_GATEWAY_ENVIRONMENT_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CODEX_HOME',
  'MODEL_GATEWAY_REQUEST_BODY_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

function isInheritedGatewayOverride(key, value) {
  return (key.startsWith('CODEX_GATEWAY_') || ISOLATED_GATEWAY_ENVIRONMENT_KEYS.includes(key))
    && value === process.env[key];
}

function testSocketPath(home) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\model-gateway-test-${path.basename(home)}`;
  return path.join(home, 'gateway.sock');
}

function createGatewayTestEnvironment(overrides = {}, isolatedOverrides = {}) {
  const suppliedHome = overrides.HOME || overrides.USERPROFILE;
  const home = suppliedHome && suppliedHome !== process.env.HOME && suppliedHome !== process.env.USERPROFILE
    ? suppliedHome
    : fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-test-'));
  const ownsHome = home !== suppliedHome;
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CODEX_GATEWAY_') || ISOLATED_GATEWAY_ENVIRONMENT_KEYS.includes(key)) delete environment[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!isInheritedGatewayOverride(key, value)) environment[key] = value;
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    MODEL_GATEWAY_REQUEST_BODY_DIR: path.join(home, '.claude', 'model-gateway', 'request-body'),
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '*',
    no_proxy: '*',
    CODEX_GATEWAY_PORT: '0',
    CODEX_GATEWAY_WORKER_PORT: '0',
    CODEX_GATEWAY_PROXY_PORT: '0',
    CODEX_GATEWAY_COMPAT_PORT: '0',
    CODEX_GATEWAY_SOCKET_PATH: testSocketPath(home),
    CODEX_GATEWAY_GROK_HOME: path.join(home, '.grok'),
    CODEX_GATEWAY_GROK_ENDPOINT: 'http://127.0.0.1:9/v1/responses',
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
    CODEX_GATEWAY_CLAUDE_BIN: path.join(home, 'missing-claude'),
    CODEX_GATEWAY_HOSTS_FILE: path.join(home, 'hosts'),
    CODEX_GATEWAY_DISPATCH_CACHE_PATH: path.join(home, 'dispatch-routes.json'),
    CODEX_GATEWAY_REQUEST_LOG_PATH: path.join(home, 'request-routes.jsonl'),
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9',
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (!isInheritedGatewayOverride(key, value)) environment[key] = value;
  }
  for (const [key, value] of Object.entries(isolatedOverrides)) environment[key] = value;
  return { environment, home, ownsHome };
}

// runtime.js resolves the state directory from os.homedir() and reads context-window.json when it loads,
// and the catalog notes read CODEX_GATEWAY_COMPACT_TRIGGER per call, so a test that requires the CLI
// in-process must point this process at a throwaway home before that require, or a developer's saved
// compact-at and session env change what the assertions see (SQ-3435). Call it before `require(CLI)`.
function isolateInProcessGatewayEnvironment(testRunner) {
  const { environment, home } = createGatewayTestEnvironment();
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, key)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  testRunner.after(() => removeGatewayTestHome(home));
  return home;
}

function gatewayTestEnvironment(t, overrides = {}, isolatedOverrides = {}) {
  const testEnvironment = createGatewayTestEnvironment(overrides, isolatedOverrides);
  gatewayTestEnvironments.set(testEnvironment.environment, testEnvironment);
  if (testEnvironment.ownsHome) registerOwnedGatewayHome(testEnvironment);
  if (testEnvironment.ownsHome && t) t.after(async () => {
    try {
      const shutdown = await stopTrackedGatewayProcesses(testEnvironment.home);
      await removeOwnedGatewayTestHome(testEnvironment.home, { shutdown });
    } catch (error) {
      // Run the reporting hook last so other fixture resources still get closed.
      deferFixtureCleanupFailure(t, error);
    }
  });
  return testEnvironment.environment;
}

function spawnGatewayProcess(t, command, args, options = {}) {
  const { env: overrides, isolatedOverrides, fixtureCommand = null, ...spawnOptions } = options;
  const existingTestEnvironment = gatewayTestEnvironments.get(overrides) || ownedGatewayTestEnvironments.get(overrides?.HOME);
  const environment = existingTestEnvironment
    ? { ...overrides, ...isolatedOverrides }
    : gatewayTestEnvironment(t, overrides, isolatedOverrides);
  const child = spawn(command, args, { ...spawnOptions, env: environment });
  registerGatewayChild(child, environment, fixtureCommand);
  const testEnvironment = existingTestEnvironment || gatewayTestEnvironments.get(environment);
  if (testEnvironment?.ownsHome) trackGatewayFixtureProcess(testEnvironment.home, child);
  return child;
}

function spawnGatewayProcessSync(command, args, options = {}) {
  const { env: overrides, isolatedOverrides, ...spawnOptions } = options;
  const testEnvironment = createGatewayTestEnvironment(overrides, isolatedOverrides);
  try {
    return spawnSync(command, args, { ...spawnOptions, env: testEnvironment.environment });
  } finally {
    stopTrackedGatewayProcessesSynchronously(testEnvironment.home);
    if (testEnvironment.ownsHome) removeGatewayTestHome(testEnvironment.home);
  }
}

function startGateway(t, command, environment, { cliPath = CLI, isolatedOverrides } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [cliPath, command], {
      env: environment,
      isolatedOverrides,
      fixtureCommand: command,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.fixtureShutdown = command === 'serve-shim';
    child.gracefulShutdown = child.fixtureShutdown || command === 'serve-worker';
    let output = '';
    let listening = false;
    const listenerTimeout = setTimeout(() => {
      void stopGatewayChild(child);
      reject(new Error(`${command} did not report an ephemeral listener within ${START_TIMEOUT_MS}ms: ${output}`));
    }, START_TIMEOUT_MS);
    const settle = (callback) => {
      clearTimeout(listenerTimeout);
      callback();
    };
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (!match || listening) return;
      listening = true;
      clearTimeout(listenerTimeout);
      const port = Number(match[1]);
      registerWorkerListener(child, port);
      waitForHealth(port).then(
        () => settle(() => resolve({ child, port })),
        (error) => settle(() => {
          void stopGatewayChild(child);
          reject(new Error(`${error.message}: ${output}`));
        }),
      );
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, signal) => settle(() => reject(new Error(`${command} exited before listening (${code ?? signal}): ${output}`))));
    t.after(() => stopGatewayChild(child));
  });
}

function proxyTarget(requestLine) {
  const connect = requestLine.match(/^CONNECT\s+([^\s]+)\s+HTTP\/\d\.\d$/i);
  if (connect) return connect[1];
  const absoluteUri = requestLine.match(/^[A-Z]+\s+(https?:\/\/[^\s/]+)(?:\/[^\s]*)?\s+HTTP\/\d\.\d$/i);
  if (!absoluteUri) return requestLine;
  const target = new URL(absoluteUri[1]);
  return `${target.hostname}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`;
}

async function startCountingProxy(t) {
  let connectionCount = 0;
  const targets = [];
  const proxy = net.createServer((socket) => {
    connectionCount += 1;
    socket.once('data', (data) => {
      targets.push(proxyTarget(data.toString('latin1').split(/\r?\n/, 1)[0]));
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address();
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, connectionCount: () => connectionCount, targets: () => [...targets] };
}

module.exports = { gatewayTestEnvironment, isolateInProcessGatewayEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startCountingProxy, startGateway, stopGatewayChild, waitForFixtureProxy,
  removeOwnedGatewayTestHome, observeGatewayChildClose, waitForGatewayChildClose, requestFixtureWorkerDrain,
  processIsRunning, requireFixtureShutdown };
