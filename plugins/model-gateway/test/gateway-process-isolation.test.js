'use strict';

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startGateway } = require('./support.js');
const { commandIncludesFile, commandResultAsync, createProxyRecovery, installBelongsToThisPlugin, isDescendantOfAsync, probeTimeoutMs, resolvePortOwner, unknownPortOwnerReason } = require('../lib/process-supervision.js');
const { startAll } = require('../lib/commands.js');
const { canReplaceInstalledCliPath } = require('../lib/runtime.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const BODY_SESSION_ID = 'gateway-fixture-body-sentinel';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, body) {
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-claude-code-session-id': BODY_SESSION_ID,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    clientRequest.once('error', reject);
    clientRequest.end(body);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('foreign gateway fixture did not become ready')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`foreign gateway fixture exited before becoming ready (${code ?? signal})`));
    });
  });
}

function waitForOutput(child, expectedOutput) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`foreign gateway fixture did not write ${expectedOutput}`)), 5000);
    const onData = (chunk) => {
      if (!String(chunk).includes(expectedOutput)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
  });
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function killProcessTree(pid) {
  if (!pid || !processIsRunning(pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

async function waitForPidRecord(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return Number(fs.readFileSync(filePath, 'utf8')); } catch { await pause(25); }
  }
  throw new Error(`pid record was not written: ${filePath}`);
}

async function waitForPidRecordDetails(filePath, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (record.pid === pid) return;
    } catch {}
    await pause(25);
  }
  throw new Error(`pid record details were not written: ${filePath}`);
}

async function waitForReplacementPidRecord(filePath, retiredPid) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pid = await waitForPidRecord(filePath).catch(() => null);
    if (pid && pid !== retiredPid && processIsRunning(pid)) return pid;
    await pause(25);
  }
  throw new Error(`replacement pid record was not written: ${filePath}`);
}

async function waitForFileText(filePath, expectedText) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(filePath, 'utf8').trim() === expectedText) return;
    } catch {}
    await pause(25);
  }
  assert.equal(fs.readFileSync(filePath, 'utf8').trim(), expectedText);
}

function descendantPids(parentPid) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object ProcessId | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', windowsHide: true });
    try {
      const entries = JSON.parse(result.stdout || '[]');
      return (Array.isArray(entries) ? entries : [entries]).map((entry) => Number(entry.ProcessId)).filter(Boolean);
    } catch { return []; }
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

// Probe children are spawned detached, so on POSIX they lead their own process
// group and only the parent pid links them to the supervisor.
function childPidsOf(parentPid) {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, processParentPid]) => pid && processParentPid === parentPid).map(([pid]) => pid);
}

async function waitForProcessesToExit(processIds, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !processIsRunning(pid))) return;
    await pause(20);
  }
  assert.deepEqual(processIds.filter(processIsRunning), [], 'probe child survived its supervisor');
}

async function waitForFileToUnlock(filePath, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const handle = fs.openSync(filePath, 'r+');
      fs.closeSync(handle);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
    }
    await pause(20);
  }
  throw new Error(`file remained locked: ${filePath}`);
}

function installNodeProxy(home) {
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
}

function runGatewayCli(cliPath, command, environment, { arguments: commandArguments = [], cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command, ...commandArguments], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stderr, stdout }));
  });
}

function installCachedGatewayCliVersions(home) {
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'eigenwise-toolshed', 'model-gateway');
  const cliPaths = {};
  for (const version of ['0.49.0', '0.50.0']) {
    const pluginRoot = path.join(cacheRoot, version);
    fs.cpSync(path.join(__dirname, '..'), pluginRoot, { recursive: true });
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    cliPaths[version] = path.join(pluginRoot, 'bin', 'model-gateway.js');
  }
  return { olderCli: cliPaths['0.49.0'], newerCli: cliPaths['0.50.0'] };
}

function linkDirectory(targetDirectory, linkPath) {
  fs.symlinkSync(targetDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outerSocketPath(home) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\model-gateway-outer-${process.pid}-${Date.now()}`
    : path.join(home, 'outer-gateway.sock');
}

function socketIsListening(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function setOuterGatewayEnvironment(t, home, endpointPort) {
  const temporaryDirectory = path.join(home, 'temporary');
  const bodyDirectory = path.join(home, 'request-body');
  const codexHome = path.join(home, 'codex-home');
  const socketPath = outerSocketPath(home);
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  fs.mkdirSync(bodyDirectory, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const sentinels = [
    [path.join(home, '.claude', 'model-gateway', 'shim.pid'), 'outer-pid'],
    [path.join(home, '.claude', 'model-gateway', 'logs', 'shim.log'), 'outer-log'],
    [path.join(home, '.claude', 'cache', 'gateway-models.json'), 'outer-cache'],
    [path.join(bodyDirectory, 'outer-body.json'), 'outer-body'],
    [path.join(codexHome, 'config.toml'), 'outer-codex-home'],
  ];
  for (const [filePath, contents] of sentinels) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  const previous = {};
  const values = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    MODEL_GATEWAY_REQUEST_BODY_DIR: bodyDirectory,
    ANTHROPIC_UNIX_SOCKET: socketPath,
    CODEX_HOME: codexHome,
    CODEX_GATEWAY_PORT: String(endpointPort),
    CODEX_GATEWAY_WORKER_PORT: String(endpointPort),
    CODEX_GATEWAY_PROXY_PORT: String(endpointPort),
    CODEX_GATEWAY_SOCKET_PATH: socketPath,
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { bodyDirectory, codexHome, sentinels, socketPath, temporaryDirectory };
}

function assertSentinelsUnchanged(sentinels) {
  for (const [filePath, contents] of sentinels) assert.equal(fs.readFileSync(filePath, 'utf8'), contents, filePath);
}

function assertNoBodyRecord(bodyDirectory) {
  const recordPath = path.join(bodyDirectory, `${Buffer.from(BODY_SESSION_ID).toString('base64url')}.json`);
  assert.equal(fs.existsSync(recordPath), false, recordPath);
}

function testHomes(directory) {
  return new Set(fs.readdirSync(directory).filter((entry) => entry.startsWith('model-gateway-test-')));
}

function assertSameEntries(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function codexMessage() {
  return JSON.stringify({
    model: 'claude-gpt-5.6-terra',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'fixture isolation' }],
  });
}

function probeTimeoutMsForPlatform(platform) {
  const modulePaths = [require.resolve('../lib/runtime.js'), require.resolve('../lib/process-supervision.js')];
  const cachedModules = new Map(modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const modulePath of modulePaths) delete require.cache[modulePath];
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  try {
    return require('../lib/process-supervision.js').probeTimeoutMs();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const modulePath of modulePaths) {
      delete require.cache[modulePath];
      if (cachedModules.get(modulePath)) require.cache[modulePath] = cachedModules.get(modulePath);
    }
  }
}

test('probe timeout defaults to the measured Windows lookup budget, keeps 2s elsewhere, and still clamps an explicit override', (t) => {
  const previousOverride = process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS;
    else process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS = previousOverride;
  });

  delete process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS;
  assert.equal(probeTimeoutMsForPlatform('win32'), 8000, 'win32 gets the measured ownership-probe budget');
  assert.equal(probeTimeoutMsForPlatform('linux'), 2000, 'non-Windows default is unchanged');
  assert.equal(probeTimeoutMsForPlatform('darwin'), 2000, 'non-Windows default is unchanged');

  process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS = '5000';
  assert.equal(probeTimeoutMsForPlatform('win32'), 5000, 'explicit override wins over the Windows default');
  assert.equal(probeTimeoutMsForPlatform('linux'), 5000, 'explicit override wins over the non-Windows default');

  process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS = '-5';
  assert.equal(probeTimeoutMsForPlatform('win32'), 1, 'explicit override is still clamped to a minimum of 1ms');
});

test('startup ownership resolves bounded same-install, unowned, foreign, and unknown owners', async () => {
  const gatewayScript = path.join(__dirname, '..', 'bin', 'model-gateway.js');
  const foreignGatewayScript = path.join(os.tmpdir(), 'foreign-model-gateway', 'bin', 'model-gateway.js');
  const sameInstallProcess = { command: `${process.execPath} "${gatewayScript}" serve-shim` };
  const resolve = (owners, processes, listeners = [true]) => resolvePortOwner(18764, {
    owner: async () => owners.shift(),
    inspectProcess: async () => processes.shift(),
    listening: async () => listeners.shift() ?? false,
    belongsToThisInstall: (installRoot) => installRoot === path.join(__dirname, '..'),
    timeout: 20,
  });

  assert.deepEqual(await resolve([701, 701], [null, sameInstallProcess]), {
    state: 'same-install', pid: 701, installRoot: path.join(__dirname, '..'),
  });
  assert.deepEqual(await resolve([701, null], [null], [true, false]), { state: 'unowned', pid: null });
  assert.deepEqual(await resolve([701, 702], [null, sameInstallProcess]), { state: 'unknown', pid: 702, reason: 'unidentified' });
  assert.deepEqual(await resolve([701, 701], [undefined, undefined], [true, true]), { state: 'unknown', pid: 701, reason: 'timeout', timeout: 20 });
  assert.deepEqual(await resolve([null, null], [], [true, true]), { state: 'unknown', pid: null, reason: 'unidentified' });
  assert.deepEqual(await resolve([701, 701], [{ command: 'unrecognized command' }, { command: 'unrecognized command' }]), { state: 'unknown', pid: 701, reason: 'unidentified' });
  assert.deepEqual(await resolve([701], [{ command: `${process.execPath} "${foreignGatewayScript}" serve-shim` }]), {
    state: 'foreign-install', pid: 701, installRoot: path.join(os.tmpdir(), 'foreign-model-gateway'),
  });
});

test('startup ownership names a probe budget exhaustion separately from an unrecognized owner', async () => {
  let elapsed = 0;
  const exhaustedOwner = await resolvePortOwner(18764, {
    owner: async () => { elapsed = 20; return 701; },
    inspectProcess: async () => ({ command: 'unrecognized command' }),
    timeout: 20,
    now: () => elapsed,
  });
  const unrecognizedOwner = await resolvePortOwner(18764, {
    owner: async () => 701,
    inspectProcess: async () => ({ command: 'unrecognized command' }),
    timeout: 20,
    now: () => 0,
  });

  const exhaustionReason = unknownPortOwnerReason(exhaustedOwner, 18764);
  const unrecognizedReason = unknownPortOwnerReason(unrecognizedOwner, 18764);
  assert.equal(exhaustedOwner.reason, 'timeout');
  assert.equal(unrecognizedOwner.reason, 'unidentified');
  assert.match(exhaustionReason, /20ms budget/);
  assert.match(exhaustionReason, /CODEX_GATEWAY_PROBE_TIMEOUT_MS/);
  assert.notEqual(exhaustionReason, unrecognizedReason);
  assert.match(unrecognizedReason, /could not be identified as this model-gateway install/);
  assert.doesNotMatch(unrecognizedReason, /CODEX_GATEWAY_PROBE_TIMEOUT_MS/);
});

test('startup ownership keeps unknown and expired absence evidence unknown', async () => {
  let listeningCalls = 0;
  const unknownInspection = await resolvePortOwner(18764, {
    owner: async () => 701,
    inspectProcess: async () => undefined,
    listening: async () => { listeningCalls += 1; return false; },
    timeout: 20,
    now: () => 0,
  });
  assert.deepEqual(unknownInspection, { state: 'unknown', pid: 701, reason: 'timeout', timeout: 20 });
  assert.equal(listeningCalls, 0);

  let currentTime = 0;
  let ownerCalls = 0;
  listeningCalls = 0;
  const expiredBeforeFallback = await resolvePortOwner(18764, {
    owner: async () => { ownerCalls += 1; currentTime = 20; return null; },
    inspectProcess: async () => null,
    listening: async () => { listeningCalls += 1; return false; },
    timeout: 20,
    now: () => currentTime,
  });
  assert.deepEqual(expiredBeforeFallback, { state: 'unknown', pid: null, reason: 'timeout', timeout: 20 });
  assert.equal(ownerCalls, 1);
  assert.equal(listeningCalls, 0);

  currentTime = 0;
  ownerCalls = 0;
  listeningCalls = 0;
  const expiredBeforeRetry = await resolvePortOwner(18764, {
    owner: async () => { ownerCalls += 1; return null; },
    inspectProcess: async () => null,
    listening: async () => { listeningCalls += 1; currentTime = 20; return false; },
    timeout: 20,
    now: () => currentTime,
  });
  assert.deepEqual(expiredBeforeRetry, { state: 'unknown', pid: null, reason: 'timeout', timeout: 20 });
  assert.equal(ownerCalls, 1);
  assert.equal(listeningCalls, 1);

  const confirmedAbsent = await resolvePortOwner(18764, {
    owner: async () => null,
    inspectProcess: async () => null,
    listening: async () => false,
    timeout: 20,
    now: () => 0,
  });
  assert.deepEqual(confirmedAbsent, { state: 'unowned', pid: null });

  const goneProcess = await resolvePortOwner(18764, {
    owner: async () => 701,
    inspectProcess: async () => null,
    listening: async () => false,
    timeout: 20,
    now: () => 0,
  });
  assert.deepEqual(goneProcess, { state: 'unowned', pid: 701 });
});

test('startup ownership leaves unknown and confirmed foreign listeners untouched', async () => {
  const calls = [];
  const lifecycle = [];
  const run = (owner) => startAll({
    proxyExists: () => true,
    ensureState: () => {},
    recordLifecycle: (event, details) => lifecycle.push({ event, details }),
    resolveOwner: async () => owner,
    reapOrphans: () => calls.push('cleanup'),
    stopSupervisor: async () => calls.push('stop'),
    spawnSupervisor: () => calls.push('start'),
  });

  const unknown = await run({ state: 'unknown', pid: 701 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /could not confirm the owner of :18764 \(last observed PID 701\); .*left the listener untouched/);
  assert.deepEqual(calls, []);
  assert.deepEqual(lifecycle, [{ event: 'start-owner-unknown', details: { component: 'start', pid: process.pid, outcome: 'owner-unknown' } }]);

  const foreign = await run({ state: 'foreign-install', pid: 702, installRoot: '/foreign/model-gateway' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /PID 702 owns :18764 from a different install root/);
  assert.deepEqual(calls, []);
});

test('cache ownership resolves physical install roots before accepting sibling versions', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-cache-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache');
  const olderSibling = path.join(cacheRoot, 'eigenwise-toolshed', 'model-gateway', '0.48.0');
  const currentSibling = path.join(cacheRoot, 'eigenwise-toolshed', 'model-gateway', '0.50.0');
  const foreignLinkedSibling = path.join(cacheRoot, 'eigenwise-toolshed', 'model-gateway', '0.49.0');
  const foreignRoot = path.join(home, 'dev', 'foreign-model-gateway');
  const foreignMarketplace = path.join(cacheRoot, 'other-marketplace', 'model-gateway', '0.49.0');

  fs.mkdirSync(olderSibling, { recursive: true });
  fs.mkdirSync(currentSibling, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  linkDirectory(foreignRoot, foreignLinkedSibling);

  assert.equal(installBelongsToThisPlugin(olderSibling, currentSibling), true);
  assert.equal(installBelongsToThisPlugin(olderSibling.replace('eigenwise-toolshed', 'EIGENWISE-TOOLSHED'), currentSibling), true);
  assert.equal(installBelongsToThisPlugin(`${olderSibling}${path.sep}`, currentSibling), true);
  if (process.platform === 'win32') assert.equal(installBelongsToThisPlugin(olderSibling.replaceAll('\\', '/'), currentSibling), true);
  assert.equal(installBelongsToThisPlugin(foreignLinkedSibling, currentSibling), false);
  assert.equal(installBelongsToThisPlugin(foreignMarketplace, currentSibling), false);
});

test('proxy command identity resolves the physical executable path', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-proxy-command-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proxyBinary = path.join(home, 'bin', 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.writeFileSync(proxyBinary, 'proxy fixture');
  const alternateProxyPath = `${path.dirname(proxyBinary)}${path.sep}..${path.sep}bin${path.sep}${path.basename(proxyBinary)}`;

  assert.equal(commandIncludesFile(`"${alternateProxyPath}" serve --no-monitor`, proxyBinary), true);
});

test('gateway fixture processes isolate outer body, socket, and Codex state', async (t) => {
  const outerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-'));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  let defaultContacts = 0;
  const defaultEndpoint = http.createServer((request, response) => {
    defaultContacts += 1;
    response.writeHead(502);
    response.end();
  });
  const defaultPort = await listen(defaultEndpoint);
  t.after(() => defaultEndpoint.close());
  const outer = setOuterGatewayEnvironment(t, outerHome, defaultPort);

  const isolatedEnvironment = gatewayTestEnvironment(t, { ...process.env });
  assert.notEqual(isolatedEnvironment.HOME, outerHome);
  assert.notEqual(isolatedEnvironment.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_PORT, String(defaultPort));
  assert.notEqual(isolatedEnvironment.CODEX_GATEWAY_SOCKET_PATH, process.env.CODEX_GATEWAY_SOCKET_PATH);

  const proxy = http.createServer((proxyRequest, proxyResponse) => {
    if (proxyRequest.url === '/v1/models') return proxyResponse.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
    proxyRequest.resume();
    proxyRequest.once('end', () => proxyResponse.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] })));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const started = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  assert.equal(await request(started.port, codexMessage()), 200);
  assert.equal(defaultContacts, 0);
  assertSentinelsUnchanged(outer.sentinels);
  assertNoBodyRecord(outer.bodyDirectory);
  assert.equal(await socketIsListening(outer.socketPath), false);
  assert.notEqual(isolatedEnvironment.MODEL_GATEWAY_REQUEST_BODY_DIR, outer.bodyDirectory);
  assert.notEqual(isolatedEnvironment.CODEX_HOME, outer.codexHome);
  assert.equal(isolatedEnvironment.ANTHROPIC_UNIX_SOCKET, undefined);
  started.child.kill();
  await waitForExit(started.child);

  const negativeControl = await startGateway(t, 'serve-shim', {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, { isolatedOverrides: { MODEL_GATEWAY_REQUEST_BODY_DIR: outer.bodyDirectory } });
  assert.equal(await request(negativeControl.port, codexMessage()), 200);
  negativeControl.child.kill();
  await waitForExit(negativeControl.child);
  assert.throws(() => assertNoBodyRecord(outer.bodyDirectory), /true !== false/);
});

test('sync gateway fixture cleanup removes helper-owned homes and preserves supplied homes', (t) => {
  const outerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-outer-user-'));
  t.after(() => fs.rmSync(outerHome, { recursive: true, force: true }));
  const outer = setOuterGatewayEnvironment(t, outerHome, 9);
  const before = testHomes(outer.temporaryDirectory);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertSameEntries(testHomes(outer.temporaryDirectory), before);

  const suppliedHome = path.join(outerHome, 'supplied-home');
  fs.mkdirSync(suppliedHome);
  const suppliedResult = spawnGatewayProcessSync(process.execPath, [CLI, 'env'], {
    encoding: 'utf8',
    env: { HOME: suppliedHome, USERPROFILE: suppliedHome },
  });
  assert.equal(suppliedResult.status, 0, suppliedResult.stderr);
  assert.equal(fs.existsSync(suppliedHome), true);
});

test('isolated ensure preserves a foreign serve-shim process and cleans its own supervisor', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-ensure-isolation-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  fs.writeFileSync(foreignScript, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
  fs.copyFileSync(process.execPath, proxyBinary);
  if (process.platform !== 'win32') fs.chmodSync(proxyBinary, 0o755);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });

  const guardianPid = Number(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'guardian.pid'), 'utf8'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(processIsRunning(foreign.pid), true, 'foreign serve-shim process survived isolated ensure');
  assert.equal(processIsRunning(guardianPid), false, 'sync fixture cleanup stopped its supervisor');
});

test('sibling ensure retires dead records without deleting replacement worker and proxy records', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-sibling-record-replacement-'));
  const { olderCli, newerCli } = installCachedGatewayCliVersions(home);
  const shimReservation = net.createServer();
  const shimPort = await listen(shimReservation);
  await new Promise((resolve) => shimReservation.close(resolve));
  const proxyReservation = net.createServer();
  const proxyPort = await listen(proxyReservation);
  await new Promise((resolve) => proxyReservation.close(resolve));
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  installNodeProxy(home);
  fs.writeFileSync(path.join(home, 'serve'), "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n");
  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_WORKER_PORT: '0',
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_PROBE_TIMEOUT_MS: '10000',
  });
  const olderShim = spawn(process.execPath, [olderCli, 'serve-shim'], { cwd: home, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let ensuring = null;
  let replacementGuardianPid = null;
  let replacementWorkerPid = null;
  let replacementProxyPid = null;
  t.after(async () => {
    if (ensuring?.exitCode == null) ensuring.kill();
    for (const pid of [replacementGuardianPid, replacementWorkerPid, replacementProxyPid]) killProcessTree(pid);
    await runGatewayCli(newerCli, 'stop', environment, { cwd: home });
    if (processIsRunning(olderShim.pid)) olderShim.kill();
    await waitForExit(olderShim);
    await waitForProcessesToExit([replacementGuardianPid, replacementWorkerPid, replacementProxyPid].filter(Boolean), 5000);
    await waitForFileToUnlock(proxyBinary);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(olderShim);

  const state = path.join(home, '.claude', 'model-gateway');
  await waitForPidRecord(path.join(state, 'shim.pid'));
  await waitForPidRecord(path.join(state, 'proxy.pid'));
  const retiredGuardianPid = 987654321;
  const retiredWorkerPid = 987654320;
  const retiredProxyPid = 987654319;
  for (const pid of [retiredGuardianPid, retiredWorkerPid, retiredProxyPid]) assert.equal(processIsRunning(pid), false, `fixture pid ${pid} is unavailable`);
  fs.writeFileSync(path.join(state, 'guardian.pid'), String(retiredGuardianPid));
  fs.writeFileSync(path.join(state, 'shim.pid'), String(retiredWorkerPid));
  fs.writeFileSync(path.join(state, 'proxy.pid'), String(retiredProxyPid));
  ensuring = spawn(process.execPath, [newerCli, 'ensure', '--quiet'], { cwd: home, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let ensureStdout = '';
  let ensureStderr = '';
  ensuring.stdout.on('data', (chunk) => { ensureStdout += chunk; });
  ensuring.stderr.on('data', (chunk) => { ensureStderr += chunk; });
  const ensuredResult = new Promise((resolve, reject) => {
    ensuring.once('error', reject);
    ensuring.once('exit', (status) => resolve({ status, stderr: ensureStderr, stdout: ensureStdout }));
  });
  const ensured = await ensuredResult;
  assert.equal(ensured.status, 0, `ensure exited with status ${ensured.status}\nstdout:\n${ensured.stdout}\nstderr:\n${ensured.stderr}`);
  replacementGuardianPid = await waitForReplacementPidRecord(path.join(state, 'guardian.pid'), retiredGuardianPid);
  replacementWorkerPid = await waitForReplacementPidRecord(path.join(state, 'shim.pid'), retiredWorkerPid);
  replacementProxyPid = await waitForReplacementPidRecord(path.join(state, 'proxy.pid'), retiredProxyPid);
  await waitForPidRecordDetails(path.join(state, 'shim.pid.json'), replacementWorkerPid);
  await waitForPidRecordDetails(path.join(state, 'proxy.pid.json'), replacementProxyPid);
  fs.writeFileSync(path.join(state, 'shim.pid.json'), JSON.stringify({ pid: replacementWorkerPid, command: 'replaced worker' }));
  assert.equal(processIsRunning(olderShim.pid), false, 'ensure stopped the previous sibling supervisor');
  assert.equal(processIsRunning(replacementWorkerPid), true, 'ensure launched the replacement worker');
  assert.equal(processIsRunning(replacementProxyPid), true, 'ensure launched the replacement proxy');

  const doctor = await runGatewayCli(newerCli, 'doctor', environment, { cwd: home });
  const updaterOutput = `${ensured.stderr}${doctor.stderr}`;
  const legacyUpdaterLogLines = [
    `model-gateway: stale pid file guardian: PID ${retiredGuardianPid} is now not a gateway process`,
    `model-gateway: stale pid file shim: PID ${retiredWorkerPid} is now not a gateway process`,
    `model-gateway: stale pid file proxy: PID ${retiredProxyPid} is now not a gateway process`,
    `model-gateway: stale pid file shim: PID ${replacementWorkerPid} is now ${process.execPath} ${newerCli} serve-worker`,
    `model-gateway: stale pid file proxy: PID ${replacementProxyPid} is now ${proxyBinary} serve --no-monitor`,
  ];
  const expectedPidRecordLines = [
    `model-gateway: pid record guardian retired because PID ${retiredGuardianPid} is gone`,
    `model-gateway: pid record shim retired because PID ${retiredWorkerPid} is gone`,
    `model-gateway: pid record proxy retired because PID ${retiredProxyPid} is gone`,
    `model-gateway: pid record shim rewritten for replaced PID ${replacementWorkerPid}: ${process.execPath} ${newerCli} serve-worker`,
  ];
  const pidRecordLines = updaterOutput.split(/\r?\n/).filter((line) => line.startsWith('model-gateway: pid record'));
  const stalePidFileLines = updaterOutput.split(/\r?\n/).filter((line) => line.startsWith('model-gateway: stale pid file'));

  assert.deepEqual(pidRecordLines, expectedPidRecordLines);
  assert.deepEqual(stalePidFileLines, [], `live replacement records must not produce:\n${legacyUpdaterLogLines.slice(3).join('\n')}`);
  assert.equal(Number(fs.readFileSync(path.join(state, 'shim.pid'), 'utf8')), replacementWorkerPid, 'doctor retained the replacement worker record');
  assert.equal(Number(fs.readFileSync(path.join(state, 'proxy.pid'), 'utf8')), replacementProxyPid, 'doctor retained the replacement proxy record');
  const stopped = await runGatewayCli(newerCli, 'stop', environment, { cwd: home });
  assert.equal(stopped.status, 0, stopped.stderr);
  await waitForProcessesToExit([replacementGuardianPid, replacementWorkerPid, replacementProxyPid], 5000);
});

test('version-change restart leaves the replacement proxy under its live supervisor', async (t) => {
  const shimReservation = net.createServer();
  const shimPort = await listen(shimReservation);
  await new Promise((resolve) => shimReservation.close(resolve));
  const proxyReservation = net.createServer();
  const proxyPort = await listen(proxyReservation);
  await new Promise((resolve) => proxyReservation.close(resolve));
  let replacementProxyPid = null;
  let supervisor = null;
  t.after(async () => {
    killProcessTree(supervisor?.pid);
    killProcessTree(replacementProxyPid);
    await waitForProcessesToExit([supervisor?.pid, replacementProxyPid].filter(Boolean), 5000);
  });
  const environment = gatewayTestEnvironment(t, {}, {
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_WORKER_PORT: '',
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS: '1000',
  });
  const home = environment.HOME;
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  installNodeProxy(home);
  fs.writeFileSync(path.join(home, 'serve'), "require('node:http').createServer((request, response) => request.url === '/v1/models' ? response.end(JSON.stringify({ data: [] })) : response.end('{}')).listen(process.env.PORT, '127.0.0.1'); setInterval(() => {}, 1000);\n");
  supervisor = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    cwd: home,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  supervisor.fixtureShutdown = true;
  await waitForReady(supervisor);
  const state = path.join(home, '.claude', 'model-gateway');
  const originalProxyPid = await waitForPidRecord(path.join(state, 'proxy.pid'));
  const proxyVersion = (spawnSync(proxyBinary, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.match(/\d+\.\d+\.\d+/) || [])[0];
  assert.ok(proxyVersion, 'fixture proxy reports a semver version');
  fs.writeFileSync(path.join(state, 'proxy-serving-version.txt'), '0.0.0\n');

  const updated = await runGatewayCli(CLI, 'ensure', environment, { arguments: ['--quiet'], cwd: home });
  assert.equal(updated.status, 0, updated.stderr);
  replacementProxyPid = await waitForReplacementPidRecord(path.join(state, 'proxy.pid'), originalProxyPid);
  assert.equal(await isDescendantOfAsync(replacementProxyPid, supervisor.pid), true, 'recovery starts the replacement as a supervisor descendant');
  await waitForFileText(path.join(state, 'proxy-serving-version.txt'), proxyVersion);

  supervisor.send({ type: 'fixture-shutdown' });
  await waitForExit(supervisor);
  await waitForProcessesToExit([supervisor.pid, replacementProxyPid], 5000);
});

test('older cache version cannot replace a newer sibling shim', () => {
  const cacheRoot = path.join('cache', 'eigenwise-toolshed', 'model-gateway');
  const olderCli = path.join(cacheRoot, '0.49.0', 'bin', 'model-gateway.js');
  const newerCli = path.join(cacheRoot, '0.50.0', 'bin', 'model-gateway.js');

  assert.equal(canReplaceInstalledCliPath(newerCli, olderCli), false);
  assert.equal(canReplaceInstalledCliPath(olderCli, newerCli), true);
});

test('foreign configured-port supervisor is preserved and reported', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-port-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => response.end(JSON.stringify({ proxyRecovery: true }))); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));\n`);
  const foreign = spawn(process.execPath, [foreignScript, 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const testOptions = {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: String(port),
      CODEX_GATEWAY_WORKER_PORT: String(port),
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  };
  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], testOptions);
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], testOptions);
  const diagnosed = spawnGatewayProcessSync(process.execPath, [CLI, 'doctor'], testOptions);
  const foreignRoot = path.dirname(path.dirname(foreignScript));

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(diagnosed.stdout, new RegExp(`shim supervisor conflict: PID ${foreign.pid} owns :${port} from a different install root`));
  assert.match(diagnosed.stdout, new RegExp(foreignRoot.replace(/[\\\\/]/g, '[\\\\\\\\/]')));
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port supervisor survived ensure and stop');
});

test('cache-junction gateway process is preserved as a foreign port owner', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-cache-junction-port-'));
  const { olderCli, newerCli } = installCachedGatewayCliVersions(home);
  const foreignRoot = path.join(home, 'dev', 'foreign-model-gateway');
  const junctionRoot = path.dirname(path.dirname(olderCli));
  const foreignScript = path.join(foreignRoot, 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.rmSync(junctionRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => response.end('foreign')); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));\n`);
  linkDirectory(foreignRoot, junctionRoot);
  const foreign = spawn(process.execPath, [path.join(junctionRoot, 'bin', 'model-gateway.js'), 'serve-shim'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (processIsRunning(foreign.pid)) foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);

  const environment = gatewayTestEnvironment(null, { HOME: home, USERPROFILE: home }, {
    CODEX_GATEWAY_PORT: String(port),
    CODEX_GATEWAY_WORKER_PORT: String(port),
    CODEX_GATEWAY_PROXY_PORT: '0',
  });
  const stopped = await runGatewayCli(newerCli, 'stop', environment);

  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stdout, /belongs to a different install root/);
  assert.equal(processIsRunning(foreign.pid), true, 'cache-junction foreign supervisor survived stop');
});

test('proxy recovery preserves a foreign configured-port proxy owner', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-proxy-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const http = require('node:http'); const server = http.createServer((request, response) => { process.stdout.write('models\\n'); response.writeHead(503); response.end('unhealthy'); }); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'));`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    if (processIsRunning(foreign.pid)) foreign.kill();
    await waitForExit(foreign);
  });
  await waitForReady(foreign);
  const proxyProbe = waitForOutput(foreign, 'models\n');
  installNodeProxy(home);

  const supervisor = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: String(port),
      CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS: '20',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    supervisor.kill();
    await waitForExit(supervisor);
  });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => assert.equal(
    fs.existsSync(home),
    false,
    'fixture teardown removes the home after the supervisor and worker exit',
  ));
  await waitForReady(supervisor);
  await proxyProbe;
  await pause(2000);

  assert.equal(processIsRunning(supervisor.pid), true, 'this install supervisor stays running after the conflict');
  assert.equal(processIsRunning(foreign.pid), true, 'foreign configured-port proxy survives recovery');
});

test('proxy recovery replaces a shared proxy binary descended from its supervisor', async () => {
  const proxyPid = 903;
  let modelsAvailable = false;
  const stopped = [];
  const sharedProxyBinary = path.join(os.tmpdir(), 'model-gateway-shared-proxy');
  const processes = new Map([
    [proxyPid, { command: `${sharedProxyBinary} serve --no-monitor`, parentPid: process.pid, pid: proxyPid }],
  ]);
  const recovery = createProxyRecovery({
    proxyBinary: sharedProxyBinary,
    probe: async () => modelsAvailable,
    listening: async () => true,
    owner: async () => proxyPid,
    inspectProcess: async (pid) => processes.get(pid) || null,
    processTable: async () => processes,
    stop: async (pid) => stopped.push(pid),
    waitForRelease: async () => true,
    start: async () => { modelsAvailable = true; },
    binaryExists: () => true,
    now: () => 0,
    report: () => {},
  });

  assert.equal((await recovery.recover()).state, 'recovered');
  assert.deepEqual(stopped, [proxyPid]);
});

test('proxy recovery preserves a foreign install proxy using the shared binary', async () => {
  const proxyPid = 903;
  const foreignSupervisorPid = 902;
  const sharedProxyBinary = path.join(os.tmpdir(), 'model-gateway-shared-proxy');
  const foreignInstallScript = path.join(os.tmpdir(), 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const processes = new Map([
    [proxyPid, { command: `${sharedProxyBinary} serve --no-monitor`, parentPid: foreignSupervisorPid, pid: proxyPid }],
    [foreignSupervisorPid, { command: `${process.execPath} ${foreignInstallScript} serve-shim`, parentPid: null, pid: foreignSupervisorPid }],
  ]);
  let stopped = false;
  let started = false;
  const recovery = createProxyRecovery({
    proxyBinary: sharedProxyBinary,
    probe: async () => false,
    listening: async () => true,
    owner: async () => proxyPid,
    inspectProcess: async (pid) => processes.get(pid) || null,
    processTable: async () => processes,
    stop: async () => { stopped = true; },
    start: async () => { started = true; },
    binaryExists: () => true,
    now: () => 0,
    report: () => {},
  });

  assert.equal((await recovery.recover()).state, 'foreign-port-owner');
  assert.equal(stopped, false, 'recovery leaves a foreign shared-binary proxy running');
  assert.equal(started, false, 'recovery does not replace a foreign shared-binary proxy');
});

test('ensure and stop discard a stale guardian PID without killing its reused process', async (t) => {
  const ensureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-ensure-'));
  const stopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-stale-stop-'));
  const ensureSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const stopSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    ensureSleeper.kill();
    stopSleeper.kill();
    await Promise.all([waitForExit(ensureSleeper), waitForExit(stopSleeper)]);
    fs.rmSync(ensureHome, { recursive: true, force: true });
    fs.rmSync(stopHome, { recursive: true, force: true });
  });
  installNodeProxy(ensureHome);
  for (const [home, sleeper] of [[ensureHome, ensureSleeper], [stopHome, stopSleeper]]) {
    const state = path.join(home, '.claude', 'model-gateway');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'guardian.pid'), String(sleeper.pid));
  }

  const ensured = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    encoding: 'utf8',
    env: { HOME: ensureHome, USERPROFILE: ensureHome },
    isolatedOverrides: {
      CODEX_GATEWAY_PORT: '0',
      CODEX_GATEWAY_WORKER_PORT: '0',
      CODEX_GATEWAY_PROXY_PORT: '0',
    },
  });
  const stopped = spawnGatewayProcessSync(process.execPath, [CLI, 'stop'], {
    encoding: 'utf8',
    env: { HOME: stopHome, USERPROFILE: stopHome },
  });

  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(processIsRunning(ensureSleeper.pid), true, 'ensure preserved the reused non-gateway process');
  assert.match(ensured.stderr, new RegExp(`pid record guardian retired because PID ${ensureSleeper.pid} no longer belongs to this gateway`));
  assert.notEqual(Number(fs.readFileSync(path.join(ensureHome, '.claude', 'model-gateway', 'guardian.pid'), 'utf8')), ensureSleeper.pid);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, new RegExp(`pid record guardian retired because PID ${stopSleeper.pid} no longer belongs to this gateway`));
  assert.equal(fs.existsSync(path.join(stopHome, '.claude', 'model-gateway', 'guardian.pid')), false);
  assert.equal(processIsRunning(stopSleeper.pid), true, 'stop preserved the reused non-gateway process');
});

test('setup restart path refuses a foreign shim before it can restart its worker', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-foreign-setup-'));
  const foreignScript = path.join(home, 'foreign-install', 'model-gateway', 'bin', 'model-gateway.js');
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.mkdirSync(path.dirname(foreignScript), { recursive: true });
  fs.writeFileSync(foreignScript, `const { spawn } = require('node:child_process'); const http = require('node:http'); const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); const server = http.createServer((request, response) => { if (request.url === '/restart') worker.kill(); response.end(JSON.stringify({ workerPid: worker.pid })); }); server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n')); process.on('SIGTERM', () => { worker.kill(); server.close(() => process.exit(0)); });`);
  const foreign = spawn(process.execPath, [foreignScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    foreign.kill();
    await waitForExit(foreign);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(foreign);
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).once('error', reject);
  });
  const script = `const supervision = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))}); supervision.restartWorkerWithDrain({ quiet: true }).then((result) => { if (!result.ok) console.error(result.reason); process.exit(result.ok ? 0 : 1); });`;
  const result = spawnGatewayProcessSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: { CODEX_GATEWAY_PORT: String(port) },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(processIsRunning(health.workerPid), true, 'foreign shim worker survives setup restart refusal');
  assert.match(result.stderr, new RegExp(`refusing to stop PID ${foreign.pid} on :${port}; it belongs to a different install root`));
});


test('proxy recovery keeps an unresolved process owner eligible for retry', async () => {
  const lifecycle = [];
  let stopped = false;
  let started = false;
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => false,
    listening: async () => true,
    owner: async () => 903,
    inspectProcess: async () => null,
    processTable: async () => new Map(),
    stop: async () => { stopped = true; },
    start: async () => { started = true; },
    binaryExists: () => true,
    recordLifecycle: (event, details) => lifecycle.push({ event, details }),
    now: () => 0,
    report: () => {},
  });

  assert.equal((await recovery.recover()).state, 'owner-unknown');
  assert.equal(stopped, false, 'recovery does not stop an unresolved process owner');
  assert.equal(started, false, 'recovery does not replace an unresolved process owner');
  assert.equal(lifecycle.at(-1)?.details.outcome, 'owner-unknown');
});

test('supervisor health remains responsive while a timed-out ownership probe defers recovery', async (t) => {
  const supervisor = http.createServer((request, response) => response.end(JSON.stringify({ ok: true })));
  const supervisorPort = await listen(supervisor);
  t.after(() => supervisor.close());
  const lifecycle = [];
  const recovery = createProxyRecovery({
    proxyBinary: 'fake-proxy',
    probe: async () => false,
    listening: async () => true,
    owner: async () => {
      const probe = await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 20 });
      return probe.timedOut ? undefined : null;
    },
    binaryExists: () => true,
    recordLifecycle: (event, details) => lifecycle.push({ event, details }),
    now: () => Date.now(),
    report: () => {},
  });
  const recoveryAttempt = recovery.recover();
  const startedAt = Date.now();
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${supervisorPort}/healthz`, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, elapsedMs: Date.now() - startedAt }));
    }).once('error', reject);
  });
  const outcome = await recoveryAttempt;

  assert.equal(health.status, 200);
  assert.ok(health.elapsedMs < 500, `health waited ${health.elapsedMs}ms for the ownership probe`);
  assert.equal(outcome.state, 'owner-unknown');
  assert.equal(lifecycle.at(-1)?.details.outcome, 'owner-unknown');
});

test('supervisor shutdown reaps a timed probe child before fixture cleanup', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-probe-child-'));
  const supervisionPath = path.join(__dirname, '..', 'lib', 'process-supervision.js');
  const supervisorScript = `
    const { commandResultAsync, createProbeChildRegistry, createProxyRecovery } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'process-supervision.js'))});
    const probeChildren = createProbeChildRegistry();
    const recovery = createProxyRecovery({
      probeChildren,
      probe: async () => false,
      listening: async () => true,
      owner: async () => {
        await commandResultAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 10000, probeChildren });
        return undefined;
      },
      binaryExists: () => true,
      report: () => {},
    });
    async function stop() { await recovery.stop(); process.exit(0); }
    process.once('SIGTERM', stop);
    process.once('message', stop);
    void recovery.recover();
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const supervisor = spawn(process.execPath, ['-e', supervisorScript], {
    cwd: home,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (processIsRunning(supervisor.pid)) supervisor.kill();
    await waitForExit(supervisor);
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForReady(supervisor);
  await pause(50);

  const probePids = process.platform === 'win32'
    ? descendantPids(supervisor.pid)
    : childPidsOf(supervisor.pid);
  assert.ok(probePids.length > 0, `no timed probe child found for ${supervisionPath}`);
  if (process.platform === 'win32') supervisor.send('stop');
  else supervisor.kill('SIGTERM');
  await waitForExit(supervisor);
  await waitForProcessesToExit(probePids);
  assert.doesNotThrow(() => fs.rmSync(home, { recursive: true, force: true }));
});

test('async parent ownership walk reads the process table once', async () => {
  let processQueries = 0;
  const processes = new Map([
    [903, { parentPid: 902 }],
    [902, { parentPid: 901 }],
    [901, { parentPid: null }],
  ]);

  assert.equal(await isDescendantOfAsync(903, 901, {
    processTable: async () => {
      processQueries += 1;
      return processes;
    },
  }), true);
  assert.equal(processQueries, 1);
});
