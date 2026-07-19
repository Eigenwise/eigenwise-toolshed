'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_PORTS, normalizeManagedConfig } = require('../bin/setup-observability.js');
const { flushOutbox } = require('../lib/observability/outbox.js');
const { buildOtlpPayload, openObservabilityStore } = require('../lib/observability/store.js');
const grafana = require('../observability/sinks/grafana/index.js');
const {
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
  const fresh = normalizeManagedConfig({});
  assert.equal(fresh.observability.enabled, false);
  assert.equal(fresh.observability.dashboard, false);
  assert.deepEqual(fresh.observability.ports, DEFAULT_PORTS);

  const migrated = normalizeManagedConfig({ observability: { sink: DEFAULT_SINK, sinks: {} } });
  assert.equal(migrated.observability.enabled, true);
  assert.equal(migrated.observability.dashboard, true);
  assert.throws(() => normalizeManagedConfig({
    observability: {
      enabled: true,
      sink: 'none',
      dashboard: false,
      ports: { collector: 4318, observer: 4318 },
      sinks: {},
    },
  }), /ports must be distinct/);
  assert.throws(() => normalizeManagedConfig({
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

test('OTLP outbox keeps measurement metadata without exceeding collector attribute limits', () => {
  const measurements = Array.from({ length: 60 }, (_, index) => ({
    name: `measurement_${index}`,
    value: index,
    unit: 'tokens',
    scope: 'request',
    quality: 'exact_provider',
  }));
  const payload = buildOtlpPayload({
    event_id: 'event-many-measurements',
    source: 'codex_gateway',
    source_event_id: 'gateway-many-measurements',
    source_schema: 'gateway-v1',
    observed_at: '2026-07-19T12:00:00.000Z',
    event_name: 'gateway.token.usage',
    attributes: { model: 'gpt-5.6-sol', agent_role: 'executor' },
  }, measurements);
  const attributes = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

  assert.ok(attributes.length < 128);
  assert.equal(attributes.filter(({ key }) => key === 'workbench.measurements').length, 1);
  assert.equal(attributes.filter(({ key }) => key.endsWith('.value')).length, 60);
});

test('Grafana dashboard separates token breakdowns from tool and MCP activity', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'observability', 'sinks', 'grafana', 'dashboards', 'claude-code-usage.json'), 'utf8'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  for (const title of [
    'Tokens & models', 'Tool activity', 'MCP', 'Sessions & agents',
    'Subscription & limits', 'Gateway internals',
  ]) {
    const row = byTitle.get(title);
    assert.equal(row?.type, 'row', `missing dashboard row: ${title}`);
    assert.equal(row.collapsed, false);
  }
  for (const title of [
    'Tokens over time, by type', 'Tokens over time, by model', 'Models in use', 'Token volume by backend',
    'Tool activity by name', 'MCP activity by server / tool', 'MCP definition footprint by server',
    'Tool activity error rate',
    'Tool activity duration p95', 'Active vs idle time', 'MCP connection activity',
    'Hook execution activity / failures', 'Subagent lifecycle activity',
    'Subscription rate-limit burn', 'Subscription window resets',
  ]) assert.ok(byTitle.has(title), `missing dashboard panel: ${title}`);
  for (const title of ['Tool activity by name', 'MCP activity by server / tool']) {
    const panel = byTitle.get(title);
    assert.equal(panel.type, 'table');
    assert.match(panel.description, /re-enter/i);
    assert.match(panel.targets[0].expr, /workbench_measurement_tool_result_tokens_estimate_value/);
    assert.match(panel.targets[1].expr, /count_over_time/);
  }
  assert.match(byTitle.get('MCP activity by server / tool').targets[0].expr, /sum by \(workbench_attribute_mcp_server\)/);
  const definitionPanel = byTitle.get('MCP definition footprint by server');
  assert.equal(definitionPanel.targets[0].instant, true);
  assert.match(definitionPanel.targets[0].expr, /gateway\.token\.usage/);
  assert.match(definitionPanel.targets[0].expr, /workbench_session_id !~ "\(probe\|session-gateway\)\.\*"/);
  assert.match(definitionPanel.targets[0].expr, /input_mcp_tools_plugin_sidequest_board_tokens_value/);
  assert.match(definitionPanel.targets[0].expr, /input_mcp_tools_plugin_playwright_playwright_tokens_value/);
  assert.match(definitionPanel.description, /servers are enumerated in the query/i);
  assert.ok(definitionPanel.transformations.some(({ id }) => id === 'organize'));
  assert.match(JSON.stringify(definitionPanel.transformations), /Definition tokens per request/);
  assert.match(byTitle.get('Token volume by backend').targets[0].expr, /workbench_attribute_backend/);
  for (const title of ['Models in use', 'Token volume by backend']) {
    assert.equal(byTitle.get(title).fieldConfig.defaults.min, 0);
  }
  const mcpActivity = byTitle.get('MCP activity by server / tool');
  assert.deepEqual(mcpActivity.options.footer.reducer, ['sum']);
  const mcpToolDetail = byTitle.get('MCP tool detail by server / tool');
  assert.ok(mcpToolDetail);
  assert.deepEqual(mcpToolDetail.options.footer.reducer, ['sum']);
  assert.match(mcpToolDetail.targets[0].expr, /workbench_attribute_mcp_server, workbench_attribute_tool_name/);

  for (const title of ['Tokens over time, by model', 'Models in use']) {
    const panel = byTitle.get(title);
    assert.equal(panel.datasource.type, 'loki');
    assert.match(panel.description, /resolved gateway model/i);
    assert.match(panel.targets[0].legendFormat, /workbench_attribute_model/);
    assert.match(panel.targets[0].expr, /gateway\.token\.usage/);
    assert.match(panel.targets[0].expr, /workbench_session_id !~ "\(probe\|session-gateway\)\.\*"/);
  }
  assert.match(byTitle.get('Tokens over time, by model').targets[0].expr, /\[\$__auto\]/);
  assert.match(byTitle.get('Models in use').targets[0].expr, /\[\$__range\]/);
  assert.equal(byTitle.get('Models in use').targets[0].instant, true);

  const subscriptionBurn = byTitle.get('Subscription rate-limit burn');
  assert.equal(subscriptionBurn.type, 'timeseries');
  assert.equal(subscriptionBurn.fieldConfig.defaults.unit, 'percent');
  assert.match(subscriptionBurn.targets[0].expr, /rate_limit_five_hour_used_percent_value/);
  assert.match(subscriptionBurn.targets[1].expr, /rate_limit_seven_day_used_percent_value/);
  for (const target of subscriptionBurn.targets) assert.match(target.expr, /\[\$__auto\]/);
  const subscriptionResets = byTitle.get('Subscription window resets');
  assert.equal(subscriptionResets.type, 'stat');
  assert.equal(subscriptionResets.fieldConfig.defaults.unit, 'dateTimeFromNow');
  assert.match(subscriptionResets.targets[0].expr, /rate_limit_five_hour_reset_at_ms_value/);
  assert.match(subscriptionResets.targets[1].expr, /rate_limit_seven_day_reset_at_ms_value/);
  for (const target of subscriptionResets.targets) {
    assert.equal(target.instant, true);
    assert.match(target.expr, /\[\$__range\]/);
  }

  // Binary + between per-type vectors drops any model missing a type (Codex
  // records carry no cache measurements), so the model panels must unwrap a
  // measurement present on every record.
  for (const title of ['Tokens over time, by model', 'Models in use']) {
    assert.match(byTitle.get(title).targets[0].expr, /context_tokens_value/);
    assert.doesNotMatch(byTitle.get(title).targets[0].expr, /\) \+ sum/);
  }

  const lokiExpressions = dashboard.panels
    .flatMap((panel) => panel.targets || [])
    .filter((target) => target.datasource && target.datasource.type === 'loki')
    .map((target) => target.expr);
  for (const expression of lokiExpressions) {
    assert.doesNotMatch(expression, /\| json/);
    assert.doesNotMatch(expression, /workbench_[a-z_]+(?:=|=~|!~)/);
    // Grafana only interpolates $__rate_interval for Prometheus; on Loki it
    // reaches the server verbatim and every panel parse-errors.
    assert.doesNotMatch(expression, /\$__rate_interval/);
  }
  assert.match(byTitle.get('Tool activity error rate').targets[0].expr, /or vector\(0\)$/);
  const connectionActivity = byTitle.get('MCP connection activity');
  assert.match(connectionActivity.targets[0].expr, /workbench_attribute_mcp_server/);
  assert.doesNotMatch(connectionActivity.targets[0].expr, /or vector\(0\)/);
  assert.equal(connectionActivity.targets[0].legendFormat, '{{workbench_attribute_mcp_server}} ({{workbench_attribute_status}})');
  assert.equal(connectionActivity.fieldConfig.defaults.noValue, 'No MCP connections reported');
  const headroom = byTitle.get('Rate-limit and Codex throttle headroom');
  for (const target of headroom.targets) assert.doesNotMatch(target.expr, /or vector\(0\)/);
  assert.equal(headroom.fieldConfig.defaults.unit, 'tokens');
  assert.equal(headroom.fieldConfig.defaults.noValue, 'No provider limit signal');
  for (const title of ['Tokens over time, by type', 'Tokens over time, by model', 'Context-window growth']) {
    assert.deepEqual(byTitle.get(title).options.legend, { displayMode: 'table', placement: 'right', calcs: ['sum'] });
  }
  const hookActivity = byTitle.get('Hook execution activity / failures');
  assert.match(hookActivity.targets[0].expr, /workbench_attribute_hook_name/);
  assert.equal(hookActivity.targets[0].legendFormat, '{{workbench_attribute_hook_name}}');
  const lifecycle = byTitle.get('Subagent lifecycle activity');
  assert.match(lifecycle.targets[0].expr, /workbench_attribute_agent_type != ""/);
  assert.match(lifecycle.targets[0].expr, /regexReplaceAll/);
  const sessionUsage = byTitle.get('Gateway usage by session');
  assert.match(sessionUsage.targets[0].expr, /workbench_session_id != ""/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Context tokens/);
  assert.match(JSON.stringify(sessionUsage.transformations), /"Time":true/);
  assert.equal(byTitle.get('Context-window growth').targets[0].legendFormat, 'session {{session_label}}');
  for (const title of [
    'Gateway usage by session', 'Orchestrator vs executor usage', 'Input composition over time',
    'Context-window growth', 'Prompt-cache economics', 'Rate-limit and Codex throttle headroom',
    'MCP definition footprint by server',
  ]) {
    for (const target of byTitle.get(title).targets) assert.match(target.expr, /workbench_session_id !~ "\(probe\|session-gateway\)\.\*"/);
  }
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
