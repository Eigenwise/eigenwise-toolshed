'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, spawnGatewayProcessSync, startGateway } = require('./support.js');
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

async function upstream(testRunner, respond) {
  const server = http.createServer(respond);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  testRunner.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function saveCatalog(home, data, updatedAt = Date.now()) {
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'anthropic-models.json'), JSON.stringify({ data, updatedAt }));
}

function fable(id, lifecycle = 'active') {
  return { id, display_name: 'Fable fixture', lifecycle };
}

function waitForDiscovery(testRunner, cacheFile) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('discovery cache was not written')), 10000);
    const watcher = fs.watch(path.dirname(cacheFile), () => {
      if (!fs.existsSync(cacheFile)) return;
      clearTimeout(timeout);
      watcher.close();
      resolve();
    });
    testRunner.after(() => { clearTimeout(timeout); watcher.close(); });
  });
}

function inference(port) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer inference-secret', 'x-api-key': 'inference-key', 'x-private': 'drop-me', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-fable-5-2', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 }),
  }).then((response) => response.json());
}

function models(port, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/models`, { headers }).then((response) => response.json());
}

test('shim merges an authenticated upstream catalog first, preserves names, and caches without credentials', async (testRunner) => {
  const seen = [];
  const endpoint = await upstream(testRunner, (request, response) => {
    seen.push(request.headers);
    response.end(JSON.stringify({ data: [fable('claude-fable-5-2')], has_more: false }));
  });
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: endpoint });
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  assert.equal(fs.existsSync(path.join(state, 'anthropic-models.json')), false, 'catalog starts absent');
  const { port } = await startGateway(testRunner, 'serve-worker', environment);
  const result = await models(port, { authorization: 'Bearer oauth-fixture', 'x-api-key': 'key-fixture', 'anthropic-beta': 'oauth-fixture', 'x-private': 'drop-me' });
  assert.equal(result.data[0].id, 'claude-fable-5-2');
  assert.equal(result.data[0].display_name, 'Fable fixture');
  assert.ok(result.data.some((row) => row.id.startsWith('claude-gpt-')));
  assert.equal(seen[0].authorization, 'Bearer oauth-fixture');
  assert.equal(seen[0]['x-api-key'], 'key-fixture');
  assert.equal(seen[0]['anthropic-beta'], 'oauth-fixture');
  assert.equal(seen[0]['x-private'], undefined);
  await models(port, { 'x-api-key': 'new-fixture-key' });
  assert.equal(seen.length, 1, 'fresh catalog avoids another request');
  const persisted = fs.readFileSync(path.join(state, 'anthropic-models.json'), 'utf8');
  assert.equal(persisted.includes('oauth-fixture'), false);
  assert.equal(persisted.includes('key-fixture'), false);
});

test('unreachable upstream keeps Codex rows and a stale cache still serves Anthropic rows', async (testRunner) => {
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:1' });
  const { port } = await startGateway(testRunner, 'serve-worker', environment);
  const empty = await models(port, { 'x-api-key': 'fixture-key' });
  assert.ok(empty.data.length > 0);
  assert.equal(empty.data.some((row) => row.id === 'claude-fable-5-2'), false);
  saveCatalog(environment.HOME, [fable('claude-fable-5-2')], 1);
  const cached = await models(port, { 'x-api-key': 'fixture-key' });
  assert.equal(cached.data[0].id, 'claude-fable-5-2');
});

test('ensure advances cached catalog defaults, preserves overrides, and never adopts retired or older ids', (testRunner) => {
  const environment = gatewayTestEnvironment(testRunner);
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  const project = path.join(environment.HOME, 'wired-project');
  const settingsFile = path.join(project, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.CODEX_GATEWAY_PORT}`, ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1m]', USER_SETTING: 'keep' } }));
  saveCatalog(environment.HOME, [fable('claude-fable-5-2'), fable('claude-fable-9-9', 'retired')]);
  fs.writeFileSync(path.join(state, 'wired-projects.json'), JSON.stringify({ projects: [project] }));
  const first = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], { env: environment, encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stderr);
  const wired = JSON.parse(fs.readFileSync(settingsFile));
  assert.equal(wired.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-2[1m]', 'registered project advances with the default');
  assert.equal(wired.env.USER_SETTING, 'keep');
  assert.match(first.stdout, /fable pin moved claude-fable-5-1\[1m\] -> claude-fable-5-2\[1m\]/);
  const pins = spawnGatewayProcessSync(process.execPath, [CLI, 'pin'], { env: environment, encoding: 'utf8', timeout: 10000 });
  assert.match(pins.stdout, /fable: claude-fable-5-2\[1m\] \(catalog default\)/);
  fs.writeFileSync(path.join(state, 'pins.json'), JSON.stringify({ fable: 'claude-fable-5-1[1m]' }));
  const overridden = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], { env: environment, encoding: 'utf8', timeout: 30000 });
  assert.match(overridden.stdout, /fable pinned by override to claude-fable-5-1\[1m\]; catalog has claude-fable-5-2\[1m\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'pins.json'))).fable, 'claude-fable-5-1[1m]');
  fs.unlinkSync(path.join(state, 'pins.json'));
  saveCatalog(environment.HOME, [fable('claude-fable-5-1'), fable('claude-fable-9-9', 'retired')]);
  const older = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], { env: environment, encoding: 'utf8', timeout: 30000 });
  assert.equal(older.status, 0, older.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(state, 'detected-pins.json')));
  assert.equal(saved.catalogPins.fable, 'claude-fable-5-2[1m]', 'older and retired ids never replace a newer adopted pin');
});

for (const [credential, headers] of Object.entries({ oauth: { authorization: 'Bearer oauth-only' }, apiKey: { 'x-api-key': 'api-only' } })) {
  test(`${credential} credentials fetch every upstream catalog page`, async (testRunner) => {
    const seen = [];
    const endpoint = await upstream(testRunner, (request, response) => {
      seen.push({ url: request.url, headers: request.headers });
      const next = request.url.includes('after_id=claude-fable-5-1');
      response.end(JSON.stringify({ data: [fable(next ? 'claude-fable-5-2' : 'claude-fable-5-1')], has_more: !next, last_id: 'claude-fable-5-1' }));
    });
    const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: endpoint });
    const { port } = await startGateway(testRunner, 'serve-worker', environment);
    const result = await models(port, headers);
    assert.deepEqual(result.data.slice(0, 2).map((row) => row.id), ['claude-fable-5-1', 'claude-fable-5-2']);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].headers.authorization, headers.authorization);
    assert.equal(seen[1].headers['x-api-key'], headers['x-api-key']);
  });
}

test('unauthenticated discovery never calls upstream and rejected credentials keep the gateway usable', async (testRunner) => {
  const seen = [];
  const endpoint = await upstream(testRunner, (request, response) => {
    seen.push(request.url);
    response.writeHead(401);
    response.end('{}');
  });
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: endpoint });
  const { port } = await startGateway(testRunner, 'serve-worker', environment);
  const anonymous = await models(port);
  assert.ok(anonymous.data.some((row) => row.id.startsWith('claude-gpt-')));
  assert.equal(seen.length, 0);
  const rejected = await models(port, { authorization: 'Bearer rejected' });
  assert.deepEqual(rejected.data.filter((row) => row.id.startsWith('claude-gpt-')), anonymous.data.filter((row) => row.id.startsWith('claude-gpt-')));
  assert.equal(rejected.data.some((row) => row.id === 'claude-fable-5-2'), false);
  assert.equal(seen.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(environment.HOME, '.claude', 'model-gateway', 'anthropic-models.json')));
  assert.equal(saved.error, 'upstream HTTP 401');
});

test('OAuth picker discovery cache includes cached native models without live discovery', async (testRunner) => {
  const proxy = await upstream(testRunner, (request, response) => response.end(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] })));
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_PROXY_PORT: new URL(proxy).port });
  saveCatalog(environment.HOME, [fable('claude-fable-5-2')]);
  const settingsFile = path.join(environment.HOME, '.claude', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.CODEX_GATEWAY_PORT}` } }));
  const cacheDirectory = path.join(environment.CLAUDE_CONFIG_DIR, 'cache');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const cacheFile = path.join(cacheDirectory, 'gateway-models.json');
  const written = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('discovery cache was not written')), 10000);
    const watcher = fs.watch(cacheDirectory, () => {
      if (!fs.existsSync(cacheFile)) return;
      clearTimeout(timeout);
      watcher.close();
      resolve();
    });
    testRunner.after(() => { clearTimeout(timeout); watcher.close(); });
  });
  await startGateway(testRunner, 'serve-worker', environment, { isolatedOverrides: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.CODEX_GATEWAY_PORT}` } });
  await written;
  const discovery = JSON.parse(fs.readFileSync(cacheFile));
  assert.deepEqual(discovery.models[0], { id: 'claude-fable-5-2', display_name: 'Fable fixture' });
  assert.ok(discovery.models.some((row) => row.id.startsWith('claude-gpt-')));
});

test('inference credentials populate the picker once without persisting secrets', { timeout: 20000 }, async (testRunner) => {
  const catalogs = [];
  const catalogStarted = Promise.withResolvers();
  const endpoint = await upstream(testRunner, (request, response) => {
    if (request.url.startsWith('/v1/models')) {
      catalogs.push({ request, response });
      catalogStarted.resolve();
      return;
    }
    response.end(JSON.stringify({ content: [] }));
  });
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: endpoint });
  const cacheFile = path.join(environment.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
  assert.equal(fs.existsSync(cacheFile), false, 'picker cache starts absent');
  assert.equal(fs.existsSync(path.join(environment.HOME, '.claude', 'model-gateway')), false, 'state starts absent');
  const baseUrl = `http://127.0.0.1:${environment.CODEX_GATEWAY_PORT}`;
  const { port } = await startGateway(testRunner, 'serve-worker', environment, { isolatedOverrides: { ANTHROPIC_BASE_URL: baseUrl } });
  await inference(port);
  await catalogStarted.promise;
  await inference(port);
  assert.equal(catalogs.length, 1, 'in-flight refresh is shared');
  assert.equal(catalogs[0].request.headers.authorization, 'Bearer inference-secret');
  assert.equal(catalogs[0].request.headers['x-api-key'], 'inference-key');
  assert.equal(catalogs[0].request.headers['x-private'], undefined);
  const written = waitForDiscovery(testRunner, cacheFile);
  catalogs[0].response.end(JSON.stringify({ data: [fable('claude-fable-5-2'), fable('claude-sonnet-5-5')], has_more: false }));
  await written;
  const discovery = JSON.parse(fs.readFileSync(cacheFile));
  assert.deepEqual(discovery.models.slice(0, 2).map((row) => row.id), ['claude-fable-5-2', 'claude-sonnet-5-5']);
  assert.equal(discovery.models[0].display_name, 'Fable fixture');
  assert.ok(discovery.models.some((row) => row.id.startsWith('claude-gpt-')));
  assert.ok(discovery.fetchedAt >= Date.now() - 10000);
  await inference(port);
  assert.equal(catalogs.length, 1, 'fresh catalog avoids another inference refresh');
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  for (const file of fs.readdirSync(state, { recursive: true })) {
    const filename = path.join(state, file);
    if (!fs.statSync(filename).isFile()) continue;
    assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /inference-secret|inference-key/);
  }
  assert.doesNotMatch(fs.readFileSync(cacheFile, 'utf8'), /inference-secret|inference-key/);
});

test('inference catalog rejection retains old rows and reports the refresh reason', async (testRunner) => {
  const endpoint = await upstream(testRunner, (request, response) => {
    response.writeHead(request.url.startsWith('/v1/models') ? 401 : 200);
    response.end('{}');
  });
  const environment = gatewayTestEnvironment(testRunner, { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: endpoint });
  saveCatalog(environment.HOME, [fable('claude-fable-5-1')], 1);
  const { port } = await startGateway(testRunner, 'serve-worker', environment);
  const savedFile = path.join(environment.HOME, '.claude', 'model-gateway', 'anthropic-models.json');
  const written = waitForDiscovery(testRunner, savedFile);
  await inference(port);
  await written;
  const saved = JSON.parse(fs.readFileSync(savedFile));
  assert.equal(saved.data[0].id, 'claude-fable-5-1');
  assert.equal(saved.updatedAt, 1);
  assert.equal(saved.error, 'upstream HTTP 401');
});

test('invalid persisted catalog pins cannot override shipped defaults', (testRunner) => {
  const environment = gatewayTestEnvironment(testRunner);
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'detected-pins.json'), JSON.stringify({ catalogPins: { opus: 123, sonnet: 'claude-sonnet-9;invalid', fable: 'claude-opus-99' } }));
  const result = spawnGatewayProcessSync(process.execPath, [CLI, 'pin'], { env: environment, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fable: claude-fable-5-1\[1m\]/);
  assert.match(result.stdout, /sonnet: claude-sonnet-5-5\[1m\]/);
});
