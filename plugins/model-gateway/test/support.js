'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const START_TIMEOUT_MS = 5000;
const PROCESS_CLEANUP_TIMEOUT_MS = 5000;
const PROCESS_CLEANUP_POLL_MS = 25;

function gatewayPidFile(home, name) {
  return path.join(home, '.claude', 'model-gateway', `${name}.pid`);
}

function waitForProcessExit(pid) {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
    }
    Atomics.wait(delay, 0, 0, PROCESS_CLEANUP_POLL_MS);
  }
}

function stopTrackedGatewayProcesses(home) {
  const pids = [];
  for (const name of ['shim', 'guardian', 'proxy']) {
    let pid;
    try { pid = Number(fs.readFileSync(gatewayPidFile(home, name), 'utf8').trim()) || null; } catch { pid = null; }
    if (!pid || pids.includes(pid)) continue;
    pids.push(pid);
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
  for (const pid of pids) waitForProcessExit(pid);
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

function gatewayTestEnvironment(t, overrides = {}, isolatedOverrides = {}) {
  const testEnvironment = createGatewayTestEnvironment(overrides, isolatedOverrides);
  if (testEnvironment.ownsHome && t) t.after(() => fs.rmSync(testEnvironment.home, { recursive: true, force: true }));
  return testEnvironment.environment;
}

function spawnGatewayProcess(t, command, args, options = {}) {
  const { env: overrides, isolatedOverrides, ...spawnOptions } = options;
  return spawn(command, args, { ...spawnOptions, env: gatewayTestEnvironment(t, overrides, isolatedOverrides) });
}

function spawnGatewayProcessSync(command, args, options = {}) {
  const { env: overrides, isolatedOverrides, ...spawnOptions } = options;
  const testEnvironment = createGatewayTestEnvironment(overrides, isolatedOverrides);
  try {
    return spawnSync(command, args, { ...spawnOptions, env: testEnvironment.environment });
  } finally {
    stopTrackedGatewayProcesses(testEnvironment.home);
    if (testEnvironment.ownsHome) fs.rmSync(testEnvironment.home, { recursive: true, force: true });
  }
}

function startGateway(t, command, environment, { cliPath = CLI, isolatedOverrides } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [cliPath, command], {
      env: environment,
      isolatedOverrides,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let listening = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not report an ephemeral listener within ${START_TIMEOUT_MS}ms: ${output}`));
    }, START_TIMEOUT_MS);
    const settle = (callback) => {
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (!match || listening) return;
      listening = true;
      const port = Number(match[1]);
      waitForHealth(port).then(
        () => settle(() => resolve({ child, port })),
        (error) => settle(() => reject(new Error(`${error.message}: ${output}`))),
      );
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, signal) => settle(() => reject(new Error(`${command} exited before listening (${code ?? signal}): ${output}`))));
    t.after(() => new Promise((done) => {
      if (child.exitCode != null || child.killed) return done();
      child.once('exit', done);
      child.once('error', done);
      child.kill();
    }));
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

module.exports = { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startCountingProxy, startGateway };
