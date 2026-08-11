'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_PORTS, normalizeManagedConfig } = require('../bin/setup-observability.js');
const { flushOutbox } = require('../lib/observability/outbox.js');
const { buildOtlpPayload, openObservabilityStore } = require('../lib/observability/store.js');
const grafana = require('../observability/sinks/grafana/index.js');
const {
  dashboardActivityStart,
  generatedDashboards,
  projectsWithActivity,
  provisionDashboards,
  resetDashboards,
} = require('../observability/sinks/grafana/dashboard-generator.js');
const {
  MODEL_PRICES_PER_MILLION,
  gatewayModelCostTargets,
  gatewayProjectCostTargets,
  gatewayTotalCostExpression,
  modelCostTargets,
  unpricedModelsExpression,
} = require('../observability/sinks/grafana/model-prices.js');
const posthog = require('../observability/sinks/posthog/index.js');
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

function undeclaredVariables(dashboard) {
  const declared = new Set(dashboard.templating.list.map(({ name }) => name));
  const referenced = new Set();
  for (const panel of dashboard.panels) {
    for (const source of [panel.interval, ...(panel.targets || []).map(({ expr }) => expr)]) {
      if (typeof source !== 'string') continue;
      for (const [, name] of source.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!name.startsWith('__') && !declared.has(name)) referenced.add(name);
      }
    }
  }
  return [...referenced].sort();
}

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

test('prices every active model label and token type from one table', () => {
  for (const model of [
    'claude-opus-4-8',
    'claude-opus-4-8[1m]',
    'claude-opus-5',
    'claude-opus-5[1m]',
    'claude-sonnet-5',
    'claude-sonnet-5[1m]',
    'claude-fable-5',
    'claude-fable-5[1m]',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-gpt-5.6-luna',
    'claude-gpt-5.6-sol',
    'claude-gpt-5.6-terra',
    // Pre-SQ-1004 labels, still carried by existing telemetry rows.
    'claude-codex-gpt-5.6-luna',
    'claude-codex-gpt-5.6-sol',
    'claude-codex-gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]) {
    assert.ok(MODEL_PRICES_PER_MILLION[model], `missing price for ${model}`);
  }
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-gpt-5.6-sol'], { input: 5, cacheRead: 0.5, cacheCreation: 5, output: 30 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['gpt-5.6-sol'], MODEL_PRICES_PER_MILLION['claude-gpt-5.6-sol']);
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-codex-gpt-5.6-sol'], MODEL_PRICES_PER_MILLION['claude-gpt-5.6-sol']);
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-gpt-5.6-terra'], { input: 2.5, cacheRead: 0.25, cacheCreation: 2.5, output: 15 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-gpt-5.6-luna'], { input: 1, cacheRead: 0.1, cacheCreation: 1, output: 6 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-haiku-4-5'], { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-haiku-4-5-20251001'], { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 });
  const target = modelCostTargets().find(({ legendFormat }) => legendFormat === 'claude-gpt-5.6-terra');
  assert.match(target.expr, /type="input"/);
  assert.match(target.expr, /type="cacheRead"/);
  assert.match(target.expr, /type="cacheCreation"/);
  assert.match(target.expr, /type="output"/);
  // The advertised ids now share the plain `claude-` prefix with the Anthropic
  // rows, so the gateway panels must still exclude them by name.
  const gatewayTargets = gatewayModelCostTargets();
  assert.equal(gatewayTargets.length, 1);
  const [gatewayTarget] = gatewayTargets;
  assert.equal(gatewayTarget.legendFormat, '{{workbench_attribute_model}}');
  assert.match(gatewayTarget.expr, /gateway\.token\.usage/);
  assert.doesNotMatch(gatewayTarget.expr, /workbench_attribute_model =/);
  assert.match(gatewayTarget.expr, /workbench_attribute_model "gpt-5\.6-terra"/);
  assert.match(gatewayTarget.expr, /workbench_measurement_input_tokens_value/);
  assert.match(gatewayTarget.expr, /workbench_measurement_cache_read_tokens_value/);
  assert.match(gatewayTarget.expr, /workbench_measurement_cache_creation_tokens_value/);
  assert.match(gatewayTarget.expr, /workbench_measurement_output_tokens_value/);
  assert.equal((gatewayTarget.expr.match(/sum_over_time/g) || []).length, 4);
  const projectTargets = gatewayProjectCostTargets([{ project_name: 'atlas' }]);
  assert.equal(projectTargets[0].legendFormat, 'atlas');
  assert.match(projectTargets[0].expr, /workbench_attribute_project_name = "atlas"/);
  assert.equal(projectTargets[1].legendFormat, 'Other / unattributed');
  assert.match(projectTargets[1].expr, /workbench_attribute_project_name !~ "atlas"/);
  for (const target of projectTargets) {
    assert.doesNotMatch(target.expr, /vector\(0\)/, `${target.legendFormat} would render as a permanent $0.00 row`);
  }
  assert.match(gatewayTotalCostExpression('$__range'), /gateway\.token\.usage/);
});

test('keeps only unknown exact model labels in the unpriced query', () => {
  const expression = unpricedModelsExpression();
  const quotedPattern = expression.match(/model!~"([^"]+)"/)[1];
  const modelPattern = JSON.parse(`"${quotedPattern}"`);
  const priced = new RegExp(`^(?:${modelPattern})$`);

  assert.ok(quotedPattern.includes('claude-opus-5\\\\[1m\\\\]'));
  assert.ok(priced.test('claude-opus-5[1m]'));
  assert.ok(priced.test('claude-gpt-5.6-luna'));
  assert.ok(priced.test('claude-codex-gpt-5.6-luna'));
  assert.ok(priced.test('claude-codex-auto'));
  assert.ok(!priced.test('claude-opus-51'));
  assert.ok(!priced.test('claude-gpt-5.6-unknown'));
});

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
  const dashboardDir = path.join(os.tmpdir(), 'workbench-grafana-dashboards');
  const mounts = JSON.stringify([{
    Source: dashboardDir,
    Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
  }]);
  const result = grafana.setup(config, {
    dashboardDir,
    pluginVersion: '0.19.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: `true|${grafana.IMAGE}|<no value>|${grafana.MANAGED_CONFIG_VERSION}|${bindings}|${mounts}` };
    },
  });
  assert.equal(result.container, 'workbench-otel-lgtm');
  assert.equal(calls.length, 1);
  assert.throws(() => grafana.runtimeConfig({ container: '../bad' }), /Invalid dashboard container name/);
});

test('Grafana recognizes a dashboard mount through a canonical path alias', (t) => {
  const root = temporaryDirectory();
  const dashboardDir = path.join(root, 'dashboards');
  const alias = path.join(root, 'dashboards-alias');
  fs.mkdirSync(dashboardDir);
  fs.symlinkSync(dashboardDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = { container: 'workbench-otel-lgtm', grafanaPort: 13000, otlpPort: 14300 };
  const bindings = JSON.stringify({
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '13000' }],
    '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '14300' }],
  });
  const mounts = JSON.stringify([{
    Source: dashboardDir,
    Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
  }]);
  const calls = [];

  grafana.setup(config, {
    dashboardDir: alias,
    pluginVersion: '0.19.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: `true|${grafana.IMAGE}|0.19.0|${grafana.MANAGED_CONFIG_VERSION}|${bindings}|${mounts}` };
    },
  });

  assert.equal(calls.length, 1);
});

test('Grafana replaces a container with an outdated dashboard mount', () => {
  const calls = [];
  const config = { container: 'workbench-otel-lgtm', grafanaPort: 13000, otlpPort: 14300 };
  const bindings = JSON.stringify({
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '13000' }],
    '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '14300' }],
  });
  const dashboardDir = path.join(os.tmpdir(), 'workbench-grafana-dashboards');
  const mounts = JSON.stringify([{
    Source: path.join(os.tmpdir(), 'stale-grafana-dashboards'),
    Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
  }]);

  grafana.setup(config, {
    dashboardDir,
    pluginVersion: '0.19.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') {
        return { status: 0, stdout: `true|${grafana.IMAGE}|0.19.0|${grafana.MANAGED_CONFIG_VERSION}|${bindings}|${mounts}` };
      }
      return { status: 0, stdout: '' };
    },
  });

  assert.deepEqual(calls.map(([, args]) => args[0]), ['inspect', 'rm', 'run']);
});

test('Grafana replaces a container missing the managed delete configuration', () => {
  const calls = [];
  const bindings = JSON.stringify({
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '13000' }],
    '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '14300' }],
  });
  grafana.setup({ container: 'workbench-otel-lgtm', grafanaPort: 13000, otlpPort: 14300 }, {
    pluginVersion: '0.20.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${grafana.IMAGE}|0.20.0|<no value>|${bindings}` };
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(calls.map((call) => call[1][0]), ['inspect', 'rm', 'run']);
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
  assert.ok(run.includes(`dev.eigenwise.workbench.lgtm-config-version=${grafana.MANAGED_CONFIG_VERSION}`));
  assert.ok(run.some((value) => /managed[\\/]loki-config\.yaml:\/otel-lgtm\/loki-config\.yaml:ro$/.test(value)));
  assert.ok(run.some((value) => /managed[\\/]run-prometheus\.sh:\/workbench-managed\/run-prometheus\.sh:ro$/.test(value)));
  assert.ok(run.includes('--entrypoint'));
  assert.ok(run.includes('/bin/bash'));
  assert.ok(run.includes('cp /workbench-managed/run-prometheus.sh /otel-lgtm/run-prometheus.sh && chmod +x /otel-lgtm/run-prometheus.sh && exec /otel-lgtm/run-all.sh'));

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

test('discovers recently active projects from Prometheus series with a default start', () => {
  const calls = [];
  const active = grafana.activeProjectNames({}, {
    now: Date.parse('2026-08-07T12:00:00.000Z'),
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${grafana.IMAGE}||${grafana.MANAGED_CONFIG_VERSION}|null|null` };
      return { status: 0, stdout: JSON.stringify({ status: 'success', data: [{ project_id: 'atlas' }, { project_id: 'beacon' }] }) };
    },
  });

  assert.deepEqual([...active], ['atlas', 'beacon']);
  assert.deepEqual(calls.map(([, args]) => args[0]), ['inspect', 'exec']);
  assert.ok(calls[1][1].includes('start=2026-07-08T12:00:00.000Z'));
  assert.ok(calls[1][1].includes('match[]=claude_code_token_usage_tokens_total'));
  assert.throws(() => grafana.activeProjectNames({}, { activityStart: 'undefined' }), /activityStart must be an ISO-8601 timestamp/);
});

test('a dashboard reset removes generated files and excludes old activity', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projects = [
    { project_name: 'atlas', project_id: 'a'.repeat(64) },
    { project_name: 'beacon', project_id: 'b'.repeat(64) },
  ];
  const active = projectsWithActivity(projects, new Set(['beacon']));
  assert.deepEqual(active.map(({ project_name }) => project_name), ['beacon']);

  provisionDashboards(directory, active);
  const resetAt = Date.parse('2026-08-07T12:00:00.000Z');
  const reset = resetDashboards(directory, resetAt);
  assert.equal(fs.existsSync(reset.directory), false);
  assert.equal(dashboardActivityStart(directory, resetAt + 1000), '2026-08-07T12:00:00.000Z');
});

test('provisions global and active per-project Grafana dashboards', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projects = [
    { project_name: 'atlas', project_id: 'a'.repeat(64) },
    { project_name: 'beacon', project_id: 'b'.repeat(64) },
  ];
  const dashboards = generatedDashboards(projects);
  assert.equal(dashboards.length, 3);
  const global = dashboards.find(({ fileName }) => fileName === 'claude-code-usage.json').dashboard;
  assert.equal(global.title, 'Claude Code Usage');
  assert.equal(global.uid, 'claude-code-usage');

  const costByModel = global.panels.find(({ title }) => title === 'Cost by model');
  assert.equal(costByModel.datasource.uid, 'loki');
  assert.equal(costByModel.interval, '$bucket');
  assert.equal(costByModel.targets.length, 1);
  assert.equal(costByModel.targets[0].legendFormat, '{{workbench_attribute_model}}');
  assert.match(costByModel.targets[0].expr, /gateway\.token\.usage/);
  assert.equal((costByModel.targets[0].expr.match(/sum_over_time/g) || []).length, 4);

  const totalSpend = global.panels.find(({ title }) => title === 'Total spend');
  assert.equal(totalSpend.datasource.uid, 'loki');
  assert.equal(totalSpend.interval, '$bucket');
  assert.deepEqual(totalSpend.options.reduceOptions.calcs, ['sum']);
  assert.equal(totalSpend.targets[0].instant, undefined);
  assert.match(totalSpend.targets[0].expr, /gateway\.token\.usage/);

  const costByProject = global.panels.find(({ title }) => title === 'Cost by project');
  assert.deepEqual(costByProject.targets.map(({ legendFormat }) => legendFormat), ['atlas', 'beacon', 'Other / unattributed']);
  assert.ok(costByProject.targets.every(({ expr }) => expr.includes('workbench_attribute_project_name')));

  for (const { fileName, dashboard } of dashboards) {
    assert.deepEqual(dashboard.templating.list.map(({ name }) => name), ['bucket'], fileName + ' lost its bucket selector');
    assert.deepEqual(dashboard.templating.list[0].current, { text: '5m', value: '5m' });
    assert.doesNotMatch(JSON.stringify(dashboard), /\$__auto_interval_/);
    assert.deepEqual(undeclaredVariables(dashboard), []);
  }

  const globalExpressions = global.panels.flatMap((panel) => panel.targets || []).map(({ expr }) => expr);
  assert.ok(globalExpressions.every((expression) => !expression.includes('$project')));
  for (const expression of globalExpressions.filter((expression) => expression.includes('claude_code_'))) {
    assert.match(expression, /project_id=~"atlas\|beacon"/);
    assert.doesNotMatch(expression, /[0-9a-f]{64}/);
  }

  const atlas = dashboards.find(({ dashboard }) => dashboard.title === 'Claude Code — atlas').dashboard;
  const atlasTitles = new Set(atlas.panels.map(({ title }) => title));
  for (const globalOnlyTitle of [
    'Cost by project', 'Gateway errors and throttles', 'Gateway records, 5m',
  ]) assert.equal(atlasTitles.has(globalOnlyTitle), false, globalOnlyTitle);
  assert.equal(atlasTitles.has('Work routed to Codex'), true);
  assert.equal(atlasTitles.has('Cost by model'), true);
  const atlasExpressions = atlas.panels.flatMap((panel) => panel.targets || []).map(({ expr }) => expr);
  for (const expression of atlasExpressions.filter((expression) => expression.includes('claude_code_'))) {
    assert.match(expression, /project_id="atlas"/);
  }
  for (const expression of atlasExpressions.filter((expression) => expression.includes('service_name="workbench-observer"'))) {
    assert.match(expression, /workbench_attribute_project_name="atlas"/);
  }

  const output = provisionDashboards(directory, projects);
  assert.deepEqual(fs.readdirSync(output).sort(), dashboards.map(({ fileName }) => fileName).sort());
  provisionDashboards(directory, []);
  assert.deepEqual(fs.readdirSync(output), ['claude-code-usage.json']);
});

test('refuses to generate a dashboard whose panels outlive their variables', () => {
  const template = () => ({
    templating: { list: [{ name: 'project' }, { name: 'bucket', type: 'interval' }] },
    panels: [{
      title: 'Tokens over time, by type',
      interval: '$bucket',
      gridPos: { x: 0, y: 0, w: 24, h: 8 },
      targets: [{ expr: 'sum(increase(claude_code_token_usage_tokens_total{project_id=~"$project"}[$bucket]))' }],
    }],
  });
  const projects = [{ project_name: 'atlas', project_id: 'a'.repeat(64) }];
  assert.equal(generatedDashboards(projects, template()).length, 2);

  const orphaned = template();
  orphaned.panels[0].interval = '$window';
  assert.throws(
    () => generatedDashboards(projects, orphaned),
    /references undeclared variables: window/,
  );

  const orphanedQuery = template();
  orphanedQuery.panels[0].targets[0].expr = orphanedQuery.panels[0].targets[0].expr.replace('[$bucket]', '[$step]');
  assert.throws(
    () => generatedDashboards(projects, orphanedQuery),
    /references undeclared variables: step/,
  );
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
    observability: { sink: 'posthog', sinks: { posthog: { host: 'https://us.i.posthog.com', apiKey: 'phc_test' } } },
  }), /allowRemote/);
  assert.throws(() => resolveSink({
    observability: { sink: 'posthog', sinks: { posthog: { host: 'https://example.test', apiKey: 'phc_test', allowRemote: true } } },
  }), /US or EU/);
  assert.throws(() => resolveSink({
    observability: { sink: 'posthog', sinks: { posthog: { host: 'https://eu.i.posthog.com', apiKey: 'phx_private', allowRemote: true } } },
  }), /project API key/);
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

test('Grafana dashboard answers cost, attribution, role, and reliability questions graphically', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'observability', 'sinks', 'grafana', 'dashboards', 'claude-code-usage.json'), 'utf8'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  assert.equal(dashboard.panels.length, 18);
  assert.deepEqual(
    dashboard.panels.filter(({ type }) => type === 'row').map(({ title }) => title),
    ['At a glance', 'Where the spend goes', 'Failures and source activity', 'Context recharge'],
  );
  assert.equal(dashboard.panels.some(({ type }) => type === 'table'), false);

  for (const title of [
    'Cost by model', 'Cost by project',
    'Context by orchestrator vs executor', 'Hook failures over time', 'Gateway errors and throttles',
    'Assistant turns by project', 'Tool-result bytes by tool', 'Recharge-weighted result bytes by tool',
  ]) {
    assert.equal(byTitle.get(title)?.type, 'timeseries', 'missing graphical panel: ' + title);
    assert.equal(byTitle.get(title).interval, '$bucket');
  }

  for (const title of ['Total spend', 'Work routed to Codex', 'Tool failure rate']) {
    assert.equal(byTitle.get(title)?.type, 'stat', 'missing summary stat: ' + title);
  }

  for (const title of ['Claude metric samples, 5m', 'Observer records, 5m', 'Gateway records, 5m']) {
    const health = byTitle.get(title);
    assert.equal(health?.type, 'stat', 'missing source activity stat: ' + title);
    assert.match(health.description, /five minutes|Recent/);
    assert.match(health.fieldConfig.defaults.noValue, /No samples/);
  }

  assert.equal(byTitle.get('Total spend').datasource.uid, 'loki');
  assert.equal(byTitle.get('Cost by model').datasource.uid, 'loki');
  assert.equal(byTitle.get('Cost by model').fieldConfig.defaults.decimals, 2);
  assert.equal(byTitle.get('Cost by project').datasource.uid, 'loki');
  assert.equal(byTitle.get('Cost by project').fieldConfig.defaults.decimals, 2);
  assert.equal(byTitle.get('Work routed to Codex').options.textMode, 'value');
  assert.equal(byTitle.has('Gateway cost by resolved model'), false);
  assert.equal(byTitle.has('Claude cost by model'), false);
  assert.match(byTitle.get('Context by orchestrator vs executor').targets[0].expr, /workbench_attribute_agent_role/);
  assert.match(byTitle.get('Hook failures over time').targets[0].expr, /workbench_attribute_status =~ \"error\|failed\"/);
  assert.match(byTitle.get('Gateway errors and throttles').targets[0].expr, /throttl\|rate\.\?limit\|429/);
  for (const title of ['Assistant turns by project', 'Tool-result bytes by tool', 'Recharge-weighted result bytes by tool']) {
    const expression = byTitle.get(title).targets[0].expr;
    assert.match(expression, /workbench\.recharge_rollup/);
    assert.equal((expression.match(/sum_over_time/g) || []).length, 1);
  }

  const lokiExpressions = dashboard.panels
    .flatMap((panel) => panel.targets || [])
    .filter((target) => target.datasource?.type === 'loki')
    .map((target) => target.expr);
  for (const expression of lokiExpressions) {
    assert.doesNotMatch(expression, /\| json/);
    assert.doesNotMatch(expression, /\$__rate_interval/);
  }
});

function overlappingPanels(panels) {
  const overlaps = [];
  for (const [index, panel] of panels.entries()) {
    for (const other of panels.slice(index + 1)) {
      const horizontal = panel.gridPos.x < other.gridPos.x + other.gridPos.w && other.gridPos.x < panel.gridPos.x + panel.gridPos.w;
      const vertical = panel.gridPos.y < other.gridPos.y + other.gridPos.h && other.gridPos.y < panel.gridPos.y + panel.gridPos.h;
      if (horizontal && vertical) overlaps.push(`${panel.title} <> ${other.title}`);
    }
  }
  return overlaps;
}

function bandWidths(panels) {
  const bands = new Map();
  for (const { gridPos } of panels) bands.set(gridPos.y, (bands.get(gridPos.y) || 0) + gridPos.w);
  return [...bands].map(([y, width]) => `y=${y} spans ${width}`).filter((band) => !band.endsWith('spans 24'));
}

// Overlapping panels do not fail: Grafana silently shoves them somewhere else,
// and a filtered-out panel leaves its hole behind. Both only show up on screen.
test('every generated dashboard lays out in full-width bands with no overlaps or holes', () => {
  const projects = [
    { project_name: 'atlas', project_id: 'a'.repeat(64) },
    { project_name: 'beacon', project_id: 'b'.repeat(64) },
  ];
  const dashboards = generatedDashboards(projects);
  assert.equal(dashboards.length, 3);
  for (const { fileName, dashboard } of dashboards) {
    assert.deepEqual(overlappingPanels(dashboard.panels), [], `${fileName} has overlapping panels`);
    assert.deepEqual(bandWidths(dashboard.panels), [], `${fileName} has a band that does not fill the grid`);
    const ordered = dashboard.panels.map(({ gridPos }) => gridPos.y * 24 + gridPos.x);
    assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right), `${fileName} panels are out of layout order`);
  }
  const [, perProject] = dashboards;
  const byTitle = new Map(perProject.dashboard.panels.map((panel) => [panel.title, panel]));
  assert.equal(byTitle.get('Total spend').gridPos.w, 8);
  assert.equal(byTitle.get('Work routed to Codex').gridPos.w, 8);
  assert.equal(byTitle.get('Tool failure rate').gridPos.x, 16);
  assert.equal(byTitle.get('Cost by model').gridPos.w, 24);
  assert.equal(byTitle.get('Hook failures over time').gridPos.w, 24);
  assert.deepEqual(
    ['Claude metric samples, 5m', 'Observer records, 5m'].map((title) => byTitle.get(title).gridPos.w),
    [12, 12],
  );
});

test('PostHog batches canonical events through an isolated receiver and retries atomically', async (t) => {
  const directory = temporaryDirectory();
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  const requests = [];
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(requests.length === 1 ? 503 : 200).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    receiver.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  store.ingest(observation('posthog-one'));
  store.ingest({ ...observation('posthog-two'), session_id: 'session-posthog' });
  const runtime = posthog.resolve({
    host: `http://127.0.0.1:${receiver.address().port}`,
    apiKey: 'phc_private_project_key',
    batchSize: 10,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  assert.equal(runtime.collectorExporter, null);
  assert.equal(JSON.stringify(runtime), JSON.stringify({
    id: 'posthog',
    egress: 'loopback',
    collectorExporter: null,
    outbox: {
      enabled: true,
      endpoint: `http://127.0.0.1:${receiver.address().port}/batch/`,
      headers: {},
      allowRemote: false,
      batchSize: 10,
      maxAttempts: 8,
      baseDelayMs: 1,
      maxDelayMs: 2,
    },
  }));

  const first = await flushOutbox(store, { ...runtime.outbox, now: new Date(Date.now() + 1_000) });
  assert.deepEqual(first, { selected: 2, delivered: 0, failed: 2, exhausted: 0 });
  const second = await flushOutbox(store, { ...runtime.outbox, now: new Date(Date.now() + 5_000) });
  assert.deepEqual(second, { selected: 2, delivered: 2, failed: 0, exhausted: 0 });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/batch/');
  assert.equal(requests[1].headers.authorization, undefined);
  assert.equal(requests[1].body.api_key, 'phc_private_project_key');
  assert.equal(requests[1].body.batch.length, 2);
  assert.equal(requests[1].body.batch[0].event, 'workbench.claude_code.api_request');
  assert.equal(requests[1].body.batch[1].properties.distinct_id, 'session-posthog');
  assert.equal(requests[1].body.batch[1].properties.$session_id, 'session-posthog');
  assert.equal(requests[1].body.batch[0].properties.$process_person_profile, false);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 0);

  const mapped = posthog.mapObservation({
    ...observation('redaction-check'),
    event_id: 'redaction-check',
    attributes: { model: 'claude-opus-4-8', raw_body: 'private content' },
    measurements: [],
  });
  assert.equal(mapped.properties.workbench_attribute_model, 'claude-opus-4-8');
  assert.doesNotMatch(JSON.stringify(mapped), /private content|raw_body/);
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
