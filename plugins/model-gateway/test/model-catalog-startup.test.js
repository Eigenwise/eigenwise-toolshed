'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: pause } = require('node:timers/promises');
const {
  gatewayTestEnvironment,
  isolateInProcessGatewayEnvironment,
  requestFixtureWorkerDrain,
  startGateway,
  waitForGatewayChildClose,
} = require('./support.js');

const policyHome = isolateInProcessGatewayEnvironment(test);
process.env.APPDATA = path.join(policyHome, 'appdata');
process.env.LOCALAPPDATA = path.join(policyHome, 'localappdata');
const {
  DISPATCH_MODEL_ID,
  MODEL_WINDOW_POLICY,
  gatewayAdvertisedWindow,
  resolveGatewayModelPolicy,
} = require('../lib/runtime.js');

// request-worker.js gives its boot /v1/models probe a 2500ms timeout; read the
// fallback snapshot and release the held probe before that window expires.
const WORKER_MODEL_PROBE_TIMEOUT_MS = 2500;
const DEFAULT_PICKER_IDS = [
  'claude-gpt-6.1-sol[1m]',
  'claude-gpt-5.6-sol[1m]',
  'claude-gpt-5.6-terra[1m]',
  'claude-gpt-5.6-luna[1m]',
  'claude-gpt-6-astra[1m]',
];
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

function startupEnvironment(testContext, proxyPort, listDispatch) {
  const environment = gatewayTestEnvironment(testContext);
  for (const key of Object.keys(environment)) {
    if (!fixtureKey(key)) delete environment[key];
  }
  const home = environment.HOME;
  Object.assign(environment, {
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_LIST_DISPATCH_MODEL: String(listDispatch),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_USAGE_ENDPOINT: '0',
  });
  return environment;
}

async function startFixtureServer(testContext, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  testContext.after(() => {
    instance.closeAllConnections();
    return new Promise((resolve) => instance.close(resolve));
  });
  return { server: instance, port: instance.address().port };
}

function releaseLatch() {
  let release;
  const promise = new Promise((resolve) => { release = () => resolve('ready'); });
  return { promise, release };
}

function catalogGate() {
  const arrived = releaseLatch();
  const released = releaseLatch();
  const requests = [];
  const responses = [];
  const handle = (request, response) => {
    const pathname = request.url.split('?')[0];
    requests.push({ method: request.method, pathname });
    if (request.method !== 'GET' || pathname !== '/v1/models') {
      response.writeHead(404);
      response.end();
      return;
    }
    responses.push(response);
    arrived.release();
    void released.promise.then(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-5.2' }] }));
    });
  };
  return {
    arrived: arrived.promise,
    handle,
    release: released.release,
    requests,
    responses,
  };
}

function assertProbesStillHeld(gate, bootStartedAt) {
  const budgetNote = `elapsed=${Date.now() - bootStartedAt}ms, workerProbeBudget=${WORKER_MODEL_PROBE_TIMEOUT_MS}ms`;
  assert.ok(gate.requests.length > 0, 'an actual outbound model-list request arrived');
  for (const request of gate.requests) {
    assert.deepEqual(request, { method: 'GET', pathname: '/v1/models' }, 'outbound proxy probe only requests GET /v1/models');
  }
  assert.ok(gate.responses.length > 0, 'an actual outbound model-list request was gated');
  for (const response of gate.responses) {
    assert.equal(response.headersSent, false, `no model probe completed before the initial snapshot (${budgetNote})`);
    assert.equal(response.writableEnded, false, `all initial model probes remain gated (${budgetNote})`);
    assert.equal(response.destroyed, false, `the initial probe must not time out and mask the startup fallback (${budgetNote})`);
  }
}

async function readJson(port, pathname, signal = AbortSignal.timeout(WORKER_MODEL_PROBE_TIMEOUT_MS)) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal });
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
  const signal = AbortSignal.timeout(5000);
  let observed = await readJson(port, '/healthz', signal);
  while (observed.catalog !== 'proxy') {
    await pause(10, undefined, { signal });
    observed = await readJson(port, '/healthz', signal);
  }
  assert.equal(observed.codexReadiness.ready, false, 'catalog provenance is not an authentication claim');
}

async function closeOwnedWorker(gateway) {
  const control = await requestFixtureWorkerDrain(gateway.child, Date.now() + 5000);
  assert.equal(await waitForGatewayChildClose(gateway.child, 5000), true, `owned worker closed after drain: ${JSON.stringify(control)}`);
  assert.equal(gateway.child.exitCode, 0, 'fixture worker exited gracefully');
  assert.equal(gateway.child.signalCode, null, 'fixture cleanup did not kill the worker');
}

for (const listDispatch of [0, 1]) {
  test(`initial fallback model rows are typed and policy-correct before any proxy catalog response (dispatch=${listDispatch})`, { timeout: 15000 }, async (testContext) => {
    const gate = catalogGate();
    const proxy = await startFixtureServer(testContext, gate.handle);
    const bootStartedAt = Date.now();
    try {
      const gateway = await startGateway(testContext, 'serve-worker', startupEnvironment(testContext, proxy.port, listDispatch));
      const probeOutcome = await Promise.race([
        gate.arrived,
        pause(WORKER_MODEL_PROBE_TIMEOUT_MS, 'timeout', { ref: false }),
      ]);
      assert.equal(probeOutcome, 'ready', 'worker issued its boot /v1/models probe within budget');
      const [health, initial] = await Promise.all([
        readJson(gateway.port, '/healthz'),
        readJson(gateway.port, '/v1/models'),
      ]);
      assertProbesStillHeld(gate, bootStartedAt);
      gate.release();

      const expected = codexRows(DEFAULT_PICKER_IDS, listDispatch);
      assert.equal(health.catalog, 'fallback');
      assert.equal(health.models, expected.length);
      assert.equal(health.codexReadiness.ready, false, 'held discovery is not live Codex readiness');
      assertCatalog(initial, expected);

      await waitForProxyCatalog(gateway.port);
      const authoritative = await readJson(gateway.port, '/v1/models', AbortSignal.timeout(5000));
      assertCatalog(authoritative, [...codexRows(['claude-gpt-5.2[1m]'], listDispatch), { id: 'claude-grok-4.5[1m]', family: 'grok' }]);
      await closeOwnedWorker(gateway);
    } finally {
      gate.release();
    }
  });
}
