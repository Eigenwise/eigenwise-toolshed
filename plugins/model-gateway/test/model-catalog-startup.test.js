'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, isolateInProcessGatewayEnvironment, requestFixtureWorkerDrain,
  startGateway, waitForGatewayChildClose } = require('./support.js');
const { server, waitFor } = require('./fixtures/antigravity.js');

const policyHome = isolateInProcessGatewayEnvironment(test);
process.env.APPDATA = path.join(policyHome, 'appdata');
process.env.LOCALAPPDATA = path.join(policyHome, 'localappdata');
const { DISPATCH_MODEL_ID, MODEL_WINDOW_POLICY, gatewayAdvertisedWindow,
  resolveGatewayModelPolicy } = require('../lib/runtime.js');
const { isReservedModel } = require('../lib/antigravity-contract.js');

const DEFAULT_PICKER_IDS = [
  'claude-gpt-6.1-sol[1m]', 'claude-gpt-5.6-sol[1m]', 'claude-gpt-5.6-terra[1m]',
  'claude-gpt-5.6-luna[1m]', 'claude-gpt-6-astra[1m]',
];
const RESERVED_PORTS = [18764, 18765, 18766, 29113];
const FIXTURE_KEYS = new Set([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'LANG',
  'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'MODEL_GATEWAY_CLAUDE_HOME', 'CODEX_HOME', 'CCP_CONFIG_DIR',
  'MODEL_GATEWAY_REQUEST_BODY_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'QUALITY_GATE_V8_CAPTURE',
]);

function fixtureKey(key) {
  return FIXTURE_KEYS.has(key) || key.startsWith('CODEX_GATEWAY_');
}

function startupEnvironment(t, proxyPort, listDispatch) {
  const environment = gatewayTestEnvironment(t);
  for (const key of Object.keys(environment)) {
    if (!fixtureKey(key)) delete environment[key];
  }
  const home = environment.HOME;
  Object.assign(environment, {
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    TMPDIR: home, TMP: home, TEMP: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_LIST_DISPATCH_MODEL: String(listDispatch),
    CODEX_GATEWAY_REQUEST_LOG: '0', CODEX_GATEWAY_USAGE_ENDPOINT: '0',
  });
  return environment;
}

function releaseLatch() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function catalogGate() {
  const latch = releaseLatch();
  const responses = [];
  const handle = (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.split('?')[0], '/v1/models');
    responses.push(response);
    // Every simultaneous model probe waits on the same latch, including queries.
    void latch.promise.then(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-5.2' }] }));
    });
  };
  return { handle, responses, release: latch.release, released: latch.promise };
}

function assertProbesStillHeld(gate) {
  assert.ok(gate.responses.length > 0, 'an actual outbound model-list request arrived');
  for (const response of gate.responses) {
    assert.equal(response.headersSent, false, 'no model probe completed before the initial snapshot');
    assert.equal(response.writableEnded, false, 'all initial model probes remain gated');
    assert.equal(response.destroyed, false, 'the initial probe must not time out and mask the startup fallback');
  }
}

async function readJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200, `${pathname} returns its owned worker response`);
  return response.json();
}

function codexRows(ids, listDispatch) {
  const rows = ids.map((id) => ({ id, family: 'codex' }));
  if (listDispatch) rows.push({ id: DISPATCH_MODEL_ID, family: 'codex' });
  return rows;
}

function rowPolicy(row) {
  return row.id === DISPATCH_MODEL_ID ? MODEL_WINDOW_POLICY.default : resolveGatewayModelPolicy(row.id);
}

function rowWindow(row, policy) {
  return row.id === DISPATCH_MODEL_ID ? policy.advertisedWindow : gatewayAdvertisedWindow(row.id);
}

function assertModelRow(row, expected, index) {
  assert.notEqual(row, null, `initial/default catalog row ${index} must be a model object, not null`);
  assert.equal(typeof row, 'object', `catalog row ${index} has an object representation`);
  assert.equal(Array.isArray(row), false);
  assert.equal(row.type, 'model');
  assert.equal(typeof row.id, 'string');
  assert.equal(row.id, expected.id, `catalog row ${index} preserves exact id and order`);
  assert.equal(typeof row.display_name, 'string');
  const policy = rowPolicy(row);
  assert.ok(policy, `catalog row ${index} has a model-window policy`);
  assert.equal(policy.backend, expected.family, `catalog row ${index} preserves its policy family`);
  assert.equal(typeof row.max_input_tokens, 'number');
  assert.equal(row.max_input_tokens, rowWindow(row, policy), `catalog row ${index} preserves the advertised policy window`);
  assert.equal(isReservedModel(row.id), false, 'unconfirmed Antigravity rows must not be invented');
}

function assertCatalog(catalog, expected) {
  assert.equal(catalog.has_more, false);
  assert.equal(Array.isArray(catalog.data), true);
  assert.equal(catalog.data.length, expected.length, 'the whole initial or authoritative catalog has the exact row count');
  for (let index = 0; index < expected.length; index += 1) {
    assertModelRow(catalog.data[index], expected[index], index);
  }
}

async function waitForProxyCatalog(port) {
  let observed = { catalog: 'unobserved', models: null };
  await waitFor(async () => {
    observed = await readJson(port, '/healthz');
    return observed.catalog === 'proxy';
  }).catch((cause) => {
    throw new Error(`worker did not observe the proxy catalog (last source=${observed.catalog}, models=${observed.models})`, { cause });
  });
  assert.equal(observed.codexReadiness.ready, false, 'catalog provenance is not an authentication claim');
}

async function closeOwnedWorker(gateway) {
  if (!gateway) return;
  const control = await requestFixtureWorkerDrain(gateway.child, Date.now() + 5000);
  assert.equal(await waitForGatewayChildClose(gateway.child, 5000), true, `owned worker closed after drain: ${JSON.stringify(control)}`);
  assert.equal(gateway.child.exitCode, 0, 'fixture worker exited gracefully');
  assert.equal(gateway.child.signalCode, null, 'fixture cleanup did not kill the worker');
}

test('the model-probe release latch is idempotent even before a worker exists', async () => {
  const gate = catalogGate();
  gate.release();
  gate.release();
  await gate.released;
  await closeOwnedWorker(null);
});

for (const listDispatch of [0, 1]) {
  test(`initial fallback model rows are typed and policy-correct before any proxy catalog response (dispatch=${listDispatch})`, { timeout: 15000 }, async (t) => {
    const gate = catalogGate();
    let gateway;
    try {
      const proxy = await server(t, gate.handle);
      assert.equal(RESERVED_PORTS.includes(proxy.port), false);
      gateway = await startGateway(t, 'serve-worker', startupEnvironment(t, proxy.port, listDispatch));
      assert.equal(RESERVED_PORTS.includes(gateway.port), false);
      await waitFor(() => gate.responses.length > 0);
      assertProbesStillHeld(gate);
      const expected = codexRows(DEFAULT_PICKER_IDS, listDispatch);
      const health = await readJson(gateway.port, '/healthz');
      assert.equal(health.catalog, 'fallback');
      assert.equal(health.models, expected.length);
      assert.equal(health.codexReadiness.ready, false, 'held discovery is not live Codex readiness');
      const initial = await readJson(gateway.port, '/v1/models');
      assertProbesStillHeld(gate);
      assertCatalog(initial, expected);
      gate.release();
      await waitForProxyCatalog(gateway.port);
      const authoritative = await readJson(gateway.port, '/v1/models');
      assertCatalog(authoritative, [...codexRows(['claude-gpt-5.2[1m]'], listDispatch), { id: 'claude-grok-4.5[1m]', family: 'grok' }]);
    } finally {
      // First action, including on the genuine RED: unblock every pending probe.
      gate.release();
      await closeOwnedWorker(gateway);
    }
  });
}
