'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment } = require('./support.js');
const home = isolateInProcessGatewayEnvironment(test);
const { buildCatalog, writeCatalogFile } = require('../lib/commands.js');
const contract = require('../lib/antigravity-contract.js');
const { fixture, request, waitFor, tiers, picker, native, envelope, capability } = require('./fixtures/antigravity.js');

async function models(port) { return JSON.parse((await request(port, null, {}, '/v1/models', 'GET')).body).data; }
function agyIds(rows) { return rows.filter((row) => row.id.startsWith('claude-antigravity-')).map((row) => row.id); }

test('bounded capability reads preserve complete bytes and reject over-budget or failed streams', async () => {
  const { Readable } = require('node:stream');
  const { readBoundedBody } = require('../lib/antigravity-discovery.js');
  assert.equal((await readBoundedBody(Readable.from([Buffer.from('a'), Buffer.from('bc')]), 3)).toString(), 'abc');
  assert.equal((await readBoundedBody(Readable.from([]), 0)).length, 0);
  await assert.rejects(readBoundedBody(Readable.from([Buffer.from('abc')]), 2), /byte budget/);
  async function* failed() { yield Buffer.from('a'); throw new Error('fixture body failed'); }
  await assert.rejects(readBoundedBody(Readable.from(failed()), 2), /fixture body failed/);
});

test('fixture polling preserves its successful value and never calls a check after an expired deadline', async () => {
  let calls = 0;
  assert.equal(await waitFor(() => { calls++; return calls === 2 ? 'ready' : false; }, 1000), 'ready');
  assert.equal(calls, 2);
  let expiredCalled = false;
  await assert.rejects(waitFor(() => { expiredCalled = true; return true; }, 0), /fixture condition timed out/);
  assert.equal(expiredCalled, false);
});

test('unconfirmed reconciliation retains only missing native rows without duplicating current rows', () => {
  const { reconcileCatalog } = require('../lib/antigravity-discovery.js');
  const existing = { schemaVersion: 4, models: [
    { id: 'claude-gpt-6-astra[1m]', provider: 'codex' },
    { id: picker('low'), provider: 'antigravity' }, { id: picker('high'), provider: 'antigravity' },
  ] };
  const catalog = { models: [{ id: picker('high'), provider: 'antigravity' }], providers: {} };
  const result = reconcileCatalog(existing, catalog, { authoritative: false, state: 'transport-error' });
  assert.deepEqual(result.catalog.models.map((row) => row.id), [picker('high'), picker('low')]);
  assert.equal(result.catalog.providers.antigravity.ready, false);
  assert.equal(existing.models.length, 3);
});

test('native exact listed IDs become picker rows; AGY-only discovery is not a Codex fallback', async (t) => {
  const gateway = await fixture(t);
  await waitFor(async () => agyIds(await models(gateway.port)).length === 3);
  const rows = await models(gateway.port);
  assert.deepEqual(agyIds(rows), tiers.map(picker));
  assert.ok(rows.every((row) => !row.id.startsWith('claude-gpt-')));
  const health = JSON.parse((await request(gateway.port, null, {}, '/healthz', 'GET')).body);
  assert.equal(health.catalog, 'proxy');
  assert.ok(gateway.state.queries.includes('/v1/models?include_capabilities=true'));
});

test('native capability hints without an authoritative model list cannot invent picker rows', async (t) => {
  const gateway = await fixture(t, { caps: { capabilities: envelope().capabilities } });
  await waitFor(() => gateway.state.queries.length >= 2);
  assert.deepEqual(agyIds(await models(gateway.port)), []);
  assert.ok(gateway.state.queries.every((query) => query === '/v1/models'));
  assert.equal(gateway.state.attempts.length, 0);
});

test('capability query is optional for ordinary default discovery, never invented by models.json', async (t) => {
  const gateway = await fixture(t, { caps: { data: [{ id: 'gpt-6-astra' }] }, setup: (env) => {
    const state = path.join(env.HOME, '.claude', 'model-gateway'); fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'models.json'), JSON.stringify([native(), picker(), 'gpt-6-astra']));
  } });
  await waitFor(() => gateway.state.queries.length >= 3);
  assert.ok(gateway.state.queries.every((query) => query === '/v1/models'));
  assert.deepEqual(agyIds(await models(gateway.port)), []);
});

test('auth missing retains implemented rows, while authoritative disable and model removal prune AGY', async (t) => {
  const gateway = await fixture(t, { environment: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:0' } });
  await waitFor(async () => agyIds(await models(gateway.port)).length === 3);
  gateway.state.caps = envelope(capability({ status: { configuration: 'valid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } }));
  await waitFor(() => gateway.state.queries.filter((url) => url.includes('?')).length > 2);
  assert.equal(agyIds(await models(gateway.port)).length, 3);
  gateway.state.caps = envelope(capability(), [native('high')]);
  await waitFor(async () => JSON.stringify(agyIds(await models(gateway.port))) === JSON.stringify([picker('high')]));
  gateway.state.caps = envelope(capability({ enabled: false }), []);
  await waitFor(async () => agyIds(await models(gateway.port)).length === 0);
  const cache = JSON.parse(fs.readFileSync(path.join(gateway.env.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json'), 'utf8'));
  assert.deepEqual(agyIds(cache.models), [], 'authoritative removal must also reach the OAuth picker cache');
  assert.ok(gateway.state.queries.filter((url) => url.includes('?')).length >= 3, 'previous confirmed snapshot requires reconciliation even without AGY rows');
});

test('a failed OAuth cache write does not crash native discovery or alter the obstructing file', async (t) => {
  const gateway = await fixture(t, { environment: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:0' }, setup: (env) => {
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'cache'), 'fixture obstruction');
  } });
  await waitFor(async () => agyIds(await models(gateway.port)).length === 3);
  assert.equal((await request(gateway.port, { model: picker(), messages: [] })).status, 200);
  assert.equal(fs.readFileSync(path.join(gateway.env.CLAUDE_CONFIG_DIR, 'cache'), 'utf8'), 'fixture obstruction');
  const log = fs.readFileSync(path.join(gateway.env.HOME, '.claude', 'model-gateway', 'logs', 'shim.log'), 'utf8');
  assert.match(log, /could not update discovery cache/);
});

test('authoritative AGY-only removals bypass subset preservation without pruning unrelated providers', () => {
  const file = path.join(home, 'catalog-removal.json');
  const codex = 'claude-gpt-6-astra';
  const all = buildCatalog([codex, ...tiers.map(picker)], { codex: { ready: true }, antigravity: { ready: true } });
  writeCatalogFile(file, all);
  const subset = buildCatalog([codex, picker('high')], { codex: { ready: true }, antigravity: { ready: true } });
  const stored = writeCatalogFile(file, subset, { antigravitySnapshot: contract.inspectCapabilities(envelope(capability(), [native('high')])) });
  assert.deepEqual(stored.models.filter((row) => row.provider === 'antigravity').map((row) => row.id), [picker('high')]);
  const disabled = writeCatalogFile(file, buildCatalog([]), { antigravitySnapshot: contract.inspectCapabilities(envelope(capability({ enabled: false }), [])) });
  assert.deepEqual(disabled.models.map((row) => row.provider), ['codex']);
  assert.equal(Object.hasOwn(disabled.providers, 'antigravity'), false);
});

test('persisted provenance stays historical after restart and invalid configuration is not authoritative disablement', async () => {
  const { createDiscoveryTracker, readObservation } = require('../lib/antigravity-discovery.js');
  const file = path.join(home, 'native-observation.json');
  const secret = 'not-allowed-in-observation';
  const provider = capability(); provider.private = secret; provider.status.account = secret;
  const tracker = createDiscoveryTracker({ file, now: () => 100, probe: async () => contract.inspectCapabilities(envelope(provider), 100) });
  await tracker.observe(tiers.map(native));
  assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false);
  assert.equal(readObservation(file).observedAt, 100);
  const restarted = createDiscoveryTracker({ file, now: () => 200, probe: async () => contract.inspectCapabilities(envelope(capability({ enabled: false,
    status: { configuration: 'invalid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } }), []), 200) });
  assert.equal(restarted.current().readiness.ready, false, 'a disk observation is never current serving readiness');
  const next = await restarted.observe([]);
  assert.equal(next.authoritative, false);
  assert.equal(next.observedAt, 100);
  assert.deepEqual(next.models, tiers.map(native));
  assert.equal(next.readiness.ready, false);
  assert.equal(next.readiness.state, 'configuration-invalid');
  for (const bytes of ['invalid', 'null', '{"schemaVersion":99}', JSON.stringify({ schemaVersion: 1, observedAt: 100, envelope: { capabilities: { schema_version: 2 } } })]) {
    fs.writeFileSync(file, bytes);
    assert.equal(readObservation(file), null);
  }
});

test('transient capability observation keeps old AGY identity and observation time, but cannot refresh readiness', async () => {
  const { createDiscoveryTracker } = require('../lib/antigravity-discovery.js');
  let now = 10;
  let next = envelope();
  const queries = [];
  const tracker = createDiscoveryTracker({ now: () => now, probe: async () => { queries.push('caps'); return contract.inspectCapabilities(next, now); } });
  let result = await tracker.observe(tiers.map(native));
  assert.equal(result.observedAt, 10);
  now = 20; next = { capabilities: { schema_version: 99 } };
  result = await tracker.observe([]);
  assert.equal(result.observedAt, 10);
  assert.equal(result.attemptedAt, 20);
  assert.equal(result.authoritative, false);
  assert.equal(result.readiness.ready, false);
  assert.deepEqual(result.models, tiers.map(native));
  assert.equal(queries.length, 2);
  const file = path.join(home, 'catalog-transient.json');
  writeCatalogFile(file, buildCatalog(tiers.map(picker), { antigravity: { ready: true, state: 'ready', message: 'old' } }));
  const stored = writeCatalogFile(file, buildCatalog(['claude-gpt-6-astra']), { antigravitySnapshot: result });
  assert.equal(stored.models.filter((row) => row.provider === 'antigravity').length, 3);
  assert.equal(stored.providers.antigravity.ready, false);
  assert.deepEqual(Object.keys(stored.providers.antigravity).sort(), ['message', 'ready', 'state']);
  assert.deepEqual(Object.keys(stored).sort(), ['codexReadiness', 'models', 'providers', 'schemaVersion', 'source', 'updatedAt', 'writtenBy']);
});
