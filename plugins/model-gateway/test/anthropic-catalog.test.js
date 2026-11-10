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
  saveCatalog(environment.HOME, [fable('claude-fable-5-2'), fable('claude-fable-9-9', 'retired')]);
  const first = spawnGatewayProcessSync(process.execPath, [CLI, 'ensure', '--quiet'], { env: environment, encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stderr);
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
