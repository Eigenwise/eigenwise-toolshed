'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcess, spawnGatewayProcessSync, startGateway } = require('./support.js');

const RUNTIME = path.join(__dirname, '..', 'lib', 'runtime.js');
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const runtime = require(RUNTIME);

function cachePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-discovery-cache-'));
  return path.join(directory, 'cache', 'gateway-models.json');
}

function shimModels() {
  return [
    { id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)', type: 'model' },
    { id: 'anthropic-custom', display_name: 'Anthropic Custom', description: 'removed' },
    { id: 'gpt-6-astra', display_name: 'Filtered out' },
  ];
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function runGatewayCommand(testContext, command, environment, isolatedOverrides) {
  return new Promise((resolve) => {
    const child = spawnGatewayProcess(testContext, process.execPath, [CLI, command], {
      cwd: environment.HOME,
      env: environment,
      isolatedOverrides,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function installProxyStub(home) {
  const proxyBinary = path.join(home, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  fs.mkdirSync(path.dirname(proxyBinary), { recursive: true });
  try {
    fs.linkSync(process.execPath, proxyBinary);
  } catch {
    fs.copyFileSync(process.execPath, proxyBinary);
  }
  return proxyBinary;
}

function discoveryEnvironment(testContext, baseUrl, shimPort, workerPort, proxyPort) {
  return gatewayTestEnvironment(testContext, {
    ANTHROPIC_BASE_URL: baseUrl,
    CODEX_GATEWAY_REQUEST_LOG: '0',
  }, {
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_WORKER_PORT: String(workerPort),
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
  });
}

function discoveryProcessOverrides(shimPort, workerPort, proxyPort) {
  return {
    CODEX_GATEWAY_PORT: String(shimPort),
    CODEX_GATEWAY_WORKER_PORT: String(workerPort),
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
  };
}

test('writes Claude Code discovery cache schema from the shim model list', () => {
  const file = cachePath();
  const result = runtime.syncGatewayDiscoveryCache({
    cachePath: file,
    models: shimModels(),
    now: () => 1786455666039,
  });

  assert.deepEqual(result, { state: 'wrote', cachePath: file, modelCount: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    baseUrl: runtime.DEFAULT_BASE_URL,
    fetchedAt: 1786455666039,
    models: [
      { id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' },
      { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
    ],
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('does not rewrite an unchanged discovery cache', () => {
  const file = cachePath();
  runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels(), now: () => 100 });
  const before = fs.statSync(file).mtimeMs;

  const result = runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels(), now: () => 200 });

  assert.deepEqual(result, { state: 'unchanged', cachePath: file, modelCount: 2 });
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('leaves a foreign discovery cache alone when its model list is current', () => {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({
    baseUrl: 'http://other-gateway.example',
    fetchedAt: 1,
    models: [
      { id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' },
      { id: 'anthropic-custom', display_name: 'Anthropic Custom' },
    ],
  });
  fs.writeFileSync(file, original);

  const result = runtime.syncGatewayDiscoveryCache({ cachePath: file, models: shimModels() });

  assert.deepEqual(result, { state: 'unchanged', cachePath: file, modelCount: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('does not touch the discovery cache in RC-compatibility mode', () => {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'keep-this-cache');

  const result = runtime.syncGatewayDiscoveryCache({
    baseUrl: runtime.COMPAT_BASE_URL,
    cachePath: file,
    models: shimModels(),
  });

  assert.deepEqual(result, { state: 'skipped', reason: 'rc-compatibility', cachePath: file, modelCount: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep-this-cache');
});

test('uses CLAUDE_CONFIG_DIR for the discovery cache', (testContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-discovery-config-home-'));
  const configDirectory = path.join(home, 'custom-claude-config');
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnGatewayProcessSync(process.execPath, ['-e', [
    `const runtime = require(${JSON.stringify(RUNTIME)});`,
    "runtime.syncGatewayDiscoveryCache({ models: [{ id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' }] });",
  ].join('')], {
    encoding: 'utf8',
    env: { HOME: home, USERPROFILE: home },
    isolatedOverrides: {
      CLAUDE_CONFIG_DIR: configDirectory,
      CODEX_GATEWAY_PORT: '27321',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const cache = JSON.parse(fs.readFileSync(path.join(configDirectory, 'cache', 'gateway-models.json'), 'utf8'));
  assert.equal(cache.baseUrl, 'http://127.0.0.1:27321');
  assert.equal(typeof cache.fetchedAt, 'number');
  assert.deepEqual(cache.models, [{ id: 'claude-gpt-6-astra', display_name: 'GPT-6 Astra (Codex)' }]);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'cache', 'gateway-models.json')), false);
});

test('refreshModels writes the configured gateway discovery cache', async (testContext) => {
  const proxy = http.createServer((request, response) => {
    if (request.url !== '/v1/models') return response.end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }));
  });
  const proxyPort = await listen(proxy);
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));
  const shimPort = await freePort();
  const workerPort = await freePort();
  const baseUrl = `http://127.0.0.1:${shimPort}`;
  const environment = discoveryEnvironment(testContext, baseUrl, shimPort, workerPort, proxyPort);
  const cache = path.join(environment.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');

  const shim = await startGateway(testContext, 'serve-shim', environment, {
    isolatedOverrides: discoveryProcessOverrides(shimPort, workerPort, proxyPort),
  });

  assert.equal(shim.port, shimPort);
  await waitUntil(() => fs.existsSync(cache), 'refreshModels did not write the discovery cache');

  const discoveryCache = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(discoveryCache.baseUrl, baseUrl);
  assert.deepEqual(discoveryCache.models, [
    { id: 'claude-gpt-6-astra', display_name: 'GPT-6-astra (Codex)' },
    { id: 'claude-grok-4.5', display_name: 'Grok 4.5' },
  ]);
});

test('ensure writes the discovery cache before reporting missing ChatGPT auth', async (testContext) => {
  const proxy = http.createServer((request, response) => {
    if (request.url !== '/v1/models') return response.end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }));
  });
  const proxyPort = await listen(proxy);
  testContext.after(() => new Promise((resolve) => proxy.close(resolve)));
  const shimPort = await freePort();
  const workerPort = await freePort();
  const baseUrl = `http://127.0.0.1:${shimPort}`;
  const environment = discoveryEnvironment(testContext, baseUrl, shimPort, workerPort, proxyPort);
  const cache = path.join(environment.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
  installProxyStub(environment.HOME);
  const shim = await startGateway(testContext, 'serve-shim', environment, {
    isolatedOverrides: discoveryProcessOverrides(shimPort, workerPort, proxyPort),
  });

  assert.equal(shim.port, shimPort);
  await waitUntil(() => fs.existsSync(cache), 'initial refresh did not write the discovery cache');
  fs.rmSync(cache);

  const result = await runGatewayCommand(
    testContext,
    'ensure',
    environment,
    discoveryProcessOverrides(shimPort, workerPort, proxyPort),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ChatGPT sign-in is required/);
  await waitUntil(() => fs.existsSync(cache), 'ensure did not write the discovery cache');
  assert.match(result.stdout, /discovery cache: (?:wrote 2 models|unchanged)/);

  const stopped = await runGatewayCommand(
    testContext,
    'stop',
    environment,
    discoveryProcessOverrides(shimPort, workerPort, proxyPort),
  );
  assert.equal(stopped.status, 0, stopped.stderr);
});
