'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { flushOutbox } = require('../lib/observability/outbox.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const grafana = require('../observability/sinks/grafana/index.js');
const {
  DEFAULT_PORTS,
  DEFAULT_SINK,
  SINK_IDS,
  normalizeObservabilityConfig,
  readObservabilityConfig,
  resolveSink,
  setupSink,
  teardownSink,
  writeObservabilityConfig,
} = require('../observability/sinks/index.js');

function observation(sourceEventId = 'sink-test-event') {
  return {
    source: 'claude_code',
    source_event_id: sourceEventId,
    source_schema: 'sink-test-v1',
    observed_at: '2026-07-19T12:00:00.000Z',
    event_name: 'claude_code.api_request',
    project_id: 'a'.repeat(64),
    request_id: `request-${sourceEventId}`,
    attributes: {
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      backend: 'claude',
      status: 'ok',
    },
  };
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-sinks-'));
}

test('registers the producer-agnostic sink contract', () => {
  assert.deepEqual(SINK_IDS, ['grafana-lgtm', 'otlp', 'posthog', 'none']);
  const defaults = normalizeObservabilityConfig({});
  assert.equal(defaults.observability.sink, DEFAULT_SINK);

  const grafana = resolveSink(defaults);
  assert.equal(grafana.collectorExporter.endpoint, 'http://127.0.0.1:14318');
  assert.equal(grafana.outbox.endpoint, 'http://127.0.0.1:14318/v1/logs');
  assert.equal(grafana.visualization.kind, 'grafana');

  const disabled = resolveSink({ observability: { sink: 'none', sinks: {} } });
  assert.equal(disabled.collectorExporter, null);
  assert.deepEqual(disabled.outbox, {
    enabled: false,
    endpoint: null,
    headers: {},
    allowRemote: false,
  });
  assert.deepEqual(setupSink({ observability: { sink: 'none', sinks: {} } }).setup, { configured: true });
  assert.deepEqual(teardownSink({ observability: { sink: 'none', sinks: {} } }), { configured: false });
});

test('normalizes consent, dashboard, and all managed ports in one record', () => {
  const fresh = normalizeObservabilityConfig({});
  assert.equal(fresh.observability.enabled, false);
  assert.equal(fresh.observability.dashboard, false);
  assert.deepEqual(fresh.observability.ports, DEFAULT_PORTS);

  const migrated = normalizeObservabilityConfig({ observability: { sink: DEFAULT_SINK, sinks: {} } });
  assert.equal(migrated.observability.enabled, true);
  assert.equal(migrated.observability.dashboard, true);
  assert.throws(() => normalizeObservabilityConfig({
    observability: {
      enabled: true,
      sink: 'none',
      dashboard: false,
      ports: { collector: 4318, observer: 4318 },
      sinks: {},
    },
  }), /ports must be distinct/);
  assert.throws(() => normalizeObservabilityConfig({
    observability: { enabled: true, sink: 'none', dashboard: true, sinks: {} },
  }), /dashboard requires/);
});

test('Grafana adopts the managed live container and honors configured loopback ports', () => {
  const config = { container: 'workbench-otel-lgtm', grafanaPort: 13000, otlpPort: 14300 };
  const runtime = grafana.resolve(config);
  assert.equal(runtime.visualization.url, 'http://127.0.0.1:13000');
  assert.equal(runtime.collectorExporter.endpoint, 'http://127.0.0.1:14300');
  const calls = [];
  const bindings = JSON.stringify({
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '13000' }],
    '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '14300' }],
  });
  const result = grafana.setup(config, {
    pluginVersion: '0.19.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: `true|${grafana.IMAGE}|<no value>|${bindings}` };
    },
  });
  assert.equal(result.container, 'workbench-otel-lgtm');
  assert.equal(calls.length, 1);
  assert.throws(() => grafana.runtimeConfig({ container: '../bad' }), /Invalid dashboard container name/);
});

test('Grafana replaces a stale managed container and can delete its data volume', () => {
  const calls = [];
  const config = { container: 'workbench-otel-lgtm', grafanaPort: 13000, otlpPort: 14300 };
  grafana.setup(config, {
    pluginVersion: '0.20.0',
    forceRecreate: true,
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${grafana.IMAGE}|0.19.0|null` };
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(calls.map((call) => call[1][0]), ['inspect', 'rm', 'run']);
  const run = calls[2][1];
  assert.ok(run.includes('127.0.0.1:13000:3000'));
  assert.ok(run.includes('127.0.0.1:14300:4318'));
  assert.ok(run.includes('dev.eigenwise.workbench.version=0.20.0'));

  const teardownCalls = [];
  const removed = grafana.teardown(config, {
    deleteData: true,
    spawnSync(command, args) {
      teardownCalls.push([command, args]);
      return { status: 0, stdout: args[0] === 'inspect' ? 'true' : '' };
    },
  });
  assert.equal(removed.dataDeleted, true);
  assert.deepEqual(teardownCalls.map((call) => call[1].slice(0, 2)), [
    ['inspect', '--format'], ['stop', 'workbench-otel-lgtm'], ['rm', '--force'], ['volume', 'rm'],
  ]);
});

test('validates explicit generic OTLP egress and credentials', () => {
  const remote = resolveSink({
    observability: {
      sink: 'otlp',
      sinks: {
        otlp: {
          endpoint: 'https://otlp.example.test',
          headers: { Authorization: 'Bearer private' },
        },
      },
    },
  });
  assert.equal(remote.egress, 'remote');
  assert.equal(remote.collectorExporter.endpoint, 'https://otlp.example.test/');
  assert.equal(remote.collectorExporter.allowRemote, true);
  assert.equal(remote.outbox.endpoint, 'https://otlp.example.test/v1/logs');
  assert.equal(remote.outbox.allowRemote, true);
  assert.equal(remote.outbox.headers.Authorization, 'Bearer private');

  assert.throws(() => normalizeObservabilityConfig({ observability: { sink: '', sinks: {} } }), /Unknown observability sink/);
  assert.throws(() => resolveSink({
    observability: { sink: 'otlp', sinks: { otlp: { endpoint: 'http://otlp.example.test' } } },
  }), /must use HTTPS/);
  assert.throws(() => resolveSink({
    observability: { sink: 'otlp', sinks: { otlp: { endpoint: 'https://token@otlp.example.test' } } },
  }), /credentials in headers/);
  assert.throws(() => resolveSink({
    observability: { sink: 'posthog', sinks: {} },
  }), /event mapper/);
});

test('persists sink config in a private dedicated file', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'observability.json');
  writeObservabilityConfig(configPath, {
    observability: {
      sink: 'otlp',
      sinks: { otlp: { endpoint: 'https://otlp.example.test', headers: { 'x-api-key': 'private' } } },
    },
  });

  const loaded = readObservabilityConfig(configPath);
  assert.equal(loaded.observability.sink, 'otlp');
  assert.equal(loaded.observability.sinks.otlp.headers['x-api-key'], 'private');
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o077, 0);
});

test('none keeps ledger observations without creating downstream rows', (t) => {
  const directory = temporaryDirectory();
  const store = openObservabilityStore(path.join(directory, 'observability.db'), { outboxEnabled: false });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const result = store.ingest(observation());
  assert.equal(result.accepted, true);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 0);
});

test('Grafana dashboard separates token breakdowns from tool and MCP activity', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'observability', 'sinks', 'grafana', 'dashboards', 'claude-code-usage.json'), 'utf8'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  for (const title of [
    'Tokens over time, by type', 'Tokens over time, by model', 'Token volume by provider / backend',
    'Tool activity by name', 'MCP activity by server / tool', 'Tool activity error rate',
    'Tool activity duration p95', 'Active vs idle time', 'MCP connection activity',
    'Hook execution overhead / failures', 'Subagent lifecycle activity',
  ]) assert.ok(byTitle.has(title), `missing dashboard panel: ${title}`);
  assert.match(byTitle.get('MCP activity by server / tool').description, /frequency only/i);
  assert.match(byTitle.get('MCP activity by server / tool').description, /token attribution is unavailable/i);
  assert.match(byTitle.get('Token volume by provider / backend').targets[0].expr, /provider, backend/);
});

test('generic OTLP forwards private headers only after explicit remote opt-in', async (t) => {
  const directory = temporaryDirectory();
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.ingest(observation('remote'));
  let sent;

  const result = await flushOutbox(store, {
    endpoint: 'https://otlp.example.test/v1/logs',
    allowRemote: true,
    headers: { Authorization: 'Bearer private' },
    fetch: async (url, request) => {
      sent = { url: String(url), headers: request.headers, redirect: request.redirect };
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.delivered, 1);
  assert.equal(sent.url, 'https://otlp.example.test/v1/logs');
  assert.equal(sent.headers.Authorization, 'Bearer private');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.equal(sent.redirect, 'error');
  await assert.rejects(() => flushOutbox(store, {
    endpoint: 'https://otlp.example.test/v1/logs',
    fetch: async () => ({ ok: true }),
  }), /loopback/);
});
