'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment } = require('./support.js');
isolateInProcessGatewayEnvironment(test);
const runtime = require('../lib/runtime.js');
const worker = require('../lib/request-worker.js');
const commands = require('../lib/commands.js');

const tiers = ['low', 'medium', 'high'];
const picker = (tier) => `claude-antigravity-gemini-4-argon-${tier}`;
const native = (tier) => `antigravity/gemini-4-argon-${tier}`;

function contract() { return require('../lib/antigravity-contract.js'); }
function capability(overrides = {}) {
  return { supported: true, enabled: true, mode: 'native', experimental: true,
    supported_apis: ['messages', 'count_tokens'], session_policy: 'fixed-model', context_window: 200000,
    backend_window_verified: false, status: { configuration: 'valid', auth: 'ready', project: 'configured',
      configuration_ready: true, live_verified: false }, ...overrides };
}
function envelope(provider = capability(), schema = 1) {
  return { data: tiers.map((tier) => ({ id: native(tier) })), capabilities: { schema_version: schema, providers: { antigravity: provider } } };
}

test('AGY exact picker and proxy identities have isolated unmeasured policies and schema4 ids', () => {
  const rows = commands.buildCatalog(tiers.map(picker), { antigravity: { ready: true, state: 'ready', message: 'local only' } });
  assert.equal(rows.models.length, 3);
  assert.deepEqual(rows.models.map((row) => row.id), tiers.map(picker));
  assert.equal(rows.schemaVersion, 4);
  assert.equal(rows.codexReadiness, null);
  assert.deepEqual(rows.providers.antigravity, { ready: true, state: 'ready', message: 'local only' });
  for (const tier of tiers) {
    for (const id of [picker(tier), native(tier)]) {
      const policy = runtime.resolveGatewayModelPolicy(id);
      assert.equal(policy.backend, 'antigravity');
      assert.equal(policy.backendId, native(tier));
      assert.equal(policy.backendWindow, null);
      assert.match(policy.measurement, /unmeasured/);
      assert.equal(policy.advertisedWindow, 200000);
      assert.equal(runtime.gatewayAdvertisedWindow(id), 200000);
      assert.equal(runtime.gatewayClientModelId(id), picker(tier));
      assert.equal(runtime.gatewayBackendModelId(id), native(tier));
      assert.equal(runtime.effectiveSentryPolicy(policy, 1, 1, 1), null);
      assert.equal(worker.gatewayModel(id, 'antigravity').id, picker(tier));
    }
  }
  assert.equal(rows.models[1].slug, 'antigravity-gemini-4-argo-ff064f');
  assert.ok(commands.modelWindowPolicyRows().every((row) => row.backend !== 'antigravity'));
  assert.equal(commands.modelWindowPolicyRows(tiers.map(picker)).filter((row) => row.backend === 'antigravity').length, 3);
  assert.notEqual(rows.models[1].slug, rows.models[1].id);
  for (const row of rows.models) {
    assert.equal(typeof row.contextWindowNote, 'string');
    assert.doesNotMatch(row.contextWindowNote, /bills|272|compact at/i);
  }
});

test('AGY reserves case-insensitive malformed namespaces but accepts only six exact direct IDs', () => {
  const agy = contract();
  for (const tier of tiers) {
    assert.equal(agy.resolveModel(picker(tier)), native(tier));
    assert.equal(agy.resolveModel(native(tier)), native(tier));
  }
  for (const id of [picker('low') + '[1m]', native('high') + '[1m]', picker('HIGH'), 'CLAUDE-ANTIGRAVITY-GEMINI-4-ARGON-LOW',
    'antigravity-gemini-4-argon-low', 'claude-codex-antigravity-gemini-4-argon-low', picker('unknown'), 'antigravity/other']) {
    assert.equal(agy.isReservedModel(id), true, id);
    assert.equal(agy.resolveModel(id), null, id);
    assert.equal(runtime.resolveGatewayModelPolicy(id), null, id);
  }
  for (const id of ['gemini-4-argon-low', 'claude-sonnet-5-5', 'gpt-6-astra', null, 42]) assert.equal(agy.isReservedModel(id), false);
  assert.equal(runtime.resolveGatewayModelPolicy(42), null);
  assert.equal(runtime.gatewayClientModelId(picker('unknown')), picker('unknown'));
  assert.deepEqual(commands.buildCatalog([42, null]).models, []);
});

test('AGY request admission rejects contexts and unsupported APIs without normalizing selectors', () => {
  const agy = contract();
  for (const pathname of ['/v1/messages', '/v1/messages/count_tokens']) {
    for (const model of [picker('low'), native('medium')]) {
      assert.equal(agy.validateRequest({ method: 'POST', pathname, model, headers: {} }), agy.resolveModel(model));
      for (const beta of ['context-1m-2025-08-07', 'tools-x, context-1m-2025-08-07', ['tools-x', 'CONTEXT-1M-2025-08-07']]) {
        assert.throws(() => agy.validateRequest({ method: 'POST', pathname, model, headers: { 'anthropic-beta': beta } }), /1m/);
      }
      assert.throws(() => agy.validateRequest({ method: 'POST', pathname, model: model + '[1m]', headers: {} }), /1m/);
    }
  }
  for (const pathname of ['/v1/chat/completions', '/v1/responses', '/v1/messages/other']) {
    assert.throws(() => agy.validateRequest({ method: 'POST', pathname, model: picker('high'), headers: {} }), /messages.*count_tokens/);
  }
  assert.throws(() => agy.validateRequest({ method: 'GET', pathname: '/v1/messages', model: picker('high'), headers: {} }), /POST/);
});

test('capability validation distinguishes serving confirmation from absence, malformed, disabled and unready', () => {
  const agy = contract();
  const snapshot = agy.inspectCapabilities(envelope(), 123);
  assert.equal(snapshot.state, 'confirmed');
  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.observedAt, 123);
  assert.deepEqual(snapshot.models, tiers.map(native));
  assert.deepEqual(Object.keys(agy.readiness(snapshot)).sort(), ['message', 'ready', 'state']);
  assert.equal(agy.readiness(snapshot).ready, true);
  assert.match(agy.readiness(snapshot).message, /does not verify Google/);
  assert.equal(agy.inspectCapabilities({}).state, 'unsupported');
  assert.equal(agy.inspectCapabilities({}).authoritative, false);
  assert.equal(agy.inspectCapabilities(envelope(capability(), 2)).state, 'unknown-version');
  assert.equal(agy.inspectCapabilities(envelope(capability({ mode: 'openai' }))).state, 'malformed');
  assert.equal(agy.inspectCapabilities(envelope(capability({ supported_apis: ['messages'] }))).state, 'malformed');
  assert.equal(agy.inspectCapabilities({ ...envelope(), data: null }).authoritative, false, 'malformed model list cannot authoritatively remove AGY');
  const disabled = agy.inspectCapabilities(envelope(capability({ enabled: false })));
  assert.equal(disabled.authoritative, true);
  assert.deepEqual(disabled.models, []);
  assert.equal(agy.readiness(disabled).state, 'disabled');
  const unsupported = agy.inspectCapabilities(envelope({ supported: false }));
  assert.equal(unsupported.authoritative, true);
  assert.deepEqual(unsupported.models, []);
  const missing = agy.inspectCapabilities(envelope(capability({ status: { configuration: 'valid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } })));
  assert.equal(agy.readiness(missing).ready, false);
  assert.deepEqual(missing.models, tiers.map(native), 'missing auth must not prune implemented models');
  const refresh = agy.inspectCapabilities(envelope(capability({ status: { configuration: 'valid', auth: 'refresh_required', project: 'configured', configuration_ready: true, live_verified: false } })));
  assert.equal(agy.readiness(refresh).ready, true);
  const poisoned = envelope();
  poisoned.data.push({ id: 'antigravity/gemini-4-argon-fake' }, { id: picker('high') });
  assert.deepEqual(agy.inspectCapabilities(poisoned).models, tiers.map(native));
});

test('legacy AGY guard examines only marker-shaped user text, including invalid slash and bracket grammar', () => {
  const agy = contract();
  for (const model of [picker('low'), native('medium'), 'antigravity-gemini-4-argon-high', native('high') + '[1m]', 'ANTIGRAVITY/other']) {
    assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: `[sidequest-route model=${model} effort=invalid]` }]), true);
    assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: [{ type: 'text', text: `[sidequest-route model=${model}]` }] }]), true);
    assert.equal(agy.hasReservedRouteMarker([{ role: 'assistant', content: `[sidequest-route model=${model}]` }]), false);
    assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: [{ type: 'tool_result', content: `[sidequest-route model=${model}]` }] }]), false);
    assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: `Please discuss ${model}` }]), false);
  }
  assert.equal(agy.hasReservedRouteMarker(null), false);
});

test('malformed native metadata never gains support or routing authority', () => {
  const agy = contract();
  assert.equal(agy.pickerId('unknown'), null);
  assert.deepEqual(agy.listedNativeModels(null), []);
  assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: 42 }]), false);
  assert.equal(agy.hasReservedRouteMarker([{ role: 'user', content: [{ type: 'text', text: 42 }] }]), false);
  for (const status of [null, 42, []]) assert.equal(agy.inspectCapabilities(envelope(capability({ status }))).state, 'malformed');
  const inconsistent = { configuration: 'invalid', auth: 'ready', project: 'configured', configuration_ready: true, live_verified: false };
  assert.equal(agy.inspectCapabilities(envelope(capability({ status: inconsistent }))).state, 'malformed');
  assert.equal(agy.inspectCapabilities(envelope(capability({ supported_apis: null }))).state, 'malformed');
  assert.equal(agy.inspectCliStatus({ schema_version: 1, provider: 'codex', ...capability() }).state, 'malformed');
});

test('local readiness distinguishes missing project, shim failure and unknown observations without live claims', () => {
  const agy = contract();
  const configured = agy.inspectCapabilities(envelope());
  const missingProject = agy.inspectCapabilities(envelope(capability({ status: {
    configuration: 'valid', auth: 'ready', project: 'missing', configuration_ready: false, live_verified: false,
  } })));
  assert.equal(agy.readiness(missingProject).state, 'project-missing');
  assert.equal(agy.readiness(configured, { shimReady: false }).state, 'shim-down');
  assert.equal(agy.readiness({ state: 'confirmed', provider: { status: { configuration: 'invalid' } } }).state, 'configuration-invalid');
  assert.equal(agy.readiness().state, 'unsupported');
  assert.equal(agy.readiness({ state: 'future' }).ready, false);
  assert.match(agy.readiness({ state: 'future' }).message, /unsupported or unconfirmed/);
});

test('identity tokenization preserves escaped strings, scalar endings and compound model spans', () => {
  const { jsonTokens, replaceModelIdentity } = require('../lib/json-model-identity.js');
  const quoted = JSON.stringify('quoted " slash ' + String.fromCharCode(92) + ' and 🛰');
  assert.deepEqual([...jsonTokens(quoted)].map((token) => token[0]), [quoted]);
  assert.deepEqual([...jsonTokens('true')].map((token) => token[0]), ['true']);
  assert.deepEqual([...jsonTokens('true false,12]')].map((token) => token[0]), ['true', 'false', ',', '12', ']']);
  for (const wire of ['"unfinished', '"unfinished' + String.fromCharCode(92)]) {
    assert.throws(() => [...jsonTokens(wire)], /string is incomplete/);
  }
  const input = '{"model":{"nested":[1,true]},"opaque":{"model":"keep"}}';
  assert.deepEqual(JSON.parse(replaceModelIdentity(input, picker('low'))), { model: picker('low'), opaque: { model: 'keep' } });
});

test('compound model spans retain exact closing-token validation under isolated inherited scalar pollution', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(require.resolve('../lib/json-model-identity.js'), 'utf8');
  for (const literal of ['true', 'false', 'null']) {
    const context = vm.createContext({ module: { exports: {} }, Buffer, TextDecoder });
    vm.runInContext(`Object.prototype[${JSON.stringify(literal)}] = -1;`, context);
    vm.runInContext(source, context, { filename: path.join(require('node:os').tmpdir(), 'json-prototype-control.cjs') });
    const input = '{"model":{"nested":' + literal + '},"other":0}';
    assert.throws(() => context.module.exports.replaceModelIdentity(input, picker('low')), /unambiguous envelope model identity/);
  }
});

module.exports = { capability, envelope, tiers, picker, native };
