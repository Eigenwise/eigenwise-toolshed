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
const { generatedDashboards, provisionDashboards } = require('../observability/sinks/grafana/dashboard-generator.js');
const { MODEL_PRICES_PER_MILLION, modelCostTargets, unpricedModelsExpression } = require('../observability/sinks/grafana/model-prices.js');
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
    'claude-codex-gpt-5.6-luna',
    'claude-codex-gpt-5.6-sol',
    'claude-codex-gpt-5.6-terra',
  ]) {
    assert.ok(MODEL_PRICES_PER_MILLION[model], `missing price for ${model}`);
  }
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-codex-gpt-5.6-sol'], { input: 5, cacheRead: 0.5, cacheCreation: 5, output: 30 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-codex-gpt-5.6-terra'], { input: 2.5, cacheRead: 0.25, cacheCreation: 2.5, output: 15 });
  assert.deepEqual(MODEL_PRICES_PER_MILLION['claude-codex-gpt-5.6-luna'], { input: 1, cacheRead: 0.1, cacheCreation: 1, output: 6 });
  const target = modelCostTargets().find(({ legendFormat }) => legendFormat === 'claude-codex-gpt-5.6-terra');
  assert.match(target.expr, /type="input"/);
  assert.match(target.expr, /type="cacheRead"/);
  assert.match(target.expr, /type="cacheCreation"/);
  assert.match(target.expr, /type="output"/);
});

test('keeps only unknown exact model labels in the unpriced query', () => {
  const expression = unpricedModelsExpression();
  const quotedPattern = expression.match(/model!~"([^"]+)"/)[1];
  const modelPattern = JSON.parse(`"${quotedPattern}"`);
  const priced = new RegExp(`^(?:${modelPattern})$`);

  assert.ok(quotedPattern.includes('claude-opus-5\\\\[1m\\\\]'));
  assert.ok(priced.test('claude-opus-5[1m]'));
  assert.ok(priced.test('claude-codex-gpt-5.6-luna'));
  assert.ok(!priced.test('claude-opus-51'));
  assert.ok(!priced.test('claude-codex-gpt-5.6-unknown'));
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
  const result = grafana.setup(config, {
    pluginVersion: '0.19.0',
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: `true|${grafana.IMAGE}|<no value>|${grafana.MANAGED_CONFIG_VERSION}|${bindings}` };
    },
  });
  assert.equal(result.container, 'workbench-otel-lgtm');
  assert.equal(calls.length, 1);
  assert.throws(() => grafana.runtimeConfig({ container: '../bad' }), /Invalid dashboard container name/);
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

test('provisions opted-in global and per-project Grafana dashboards', (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projects = [
    { project_name: 'atlas', project_id: 'a'.repeat(64), optedInAt: '2026-07-20T00:00:00.000Z' },
    { project_name: 'beacon', project_id: 'b'.repeat(64), optedInAt: '2026-07-20T00:00:00.000Z' },
  ];
  const dashboards = generatedDashboards(projects);
  assert.equal(dashboards.length, 3);
  const global = dashboards.find(({ fileName }) => fileName === 'claude-code-usage.json').dashboard;
  assert.equal(global.title, 'Claude Code Usage');
  assert.equal(global.uid, 'claude-code-usage');
  // Panel-level "interval": "$bucket" reaches Grafana verbatim, so dropping the
  // variable fails every bucketed panel with "Invalid interval string" (SQ-854).
  for (const { fileName, dashboard } of dashboards) {
    assert.deepEqual(
      dashboard.templating.list.map(({ name }) => name),
      ['bucket'],
      `${fileName} lost its bucket selector`,
    );
    const bucket = dashboard.templating.list[0];
    assert.equal(bucket.type, 'interval');
    assert.equal(bucket.auto, true);
    assert.equal(bucket.query, '1m,5m,15m,1h,6h,1d');
    assert.equal(bucket.current.value, '$__auto_interval_bucket');
    assert.deepEqual(undeclaredVariables(dashboard), []);
  }
  const projectUnscopedTitles = new Set(['MCP connection activity', 'Work moved off the Anthropic limit']);
  const regularPanels = global.panels
    .filter(({ title }) => !projectUnscopedTitles.has(title));
  const regularExpressions = regularPanels.flatMap((panel) => panel.targets || []).map(({ expr }) => expr);
  assert.ok(regularExpressions.every((expression) => !expression.includes('$project')));
  for (const expression of regularExpressions.filter((expression) => expression.includes('claude_code_'))) {
    // The metric's project_id label carries the sanitized basename (OTel
    // resource attribute), never the registry's sha256 — matching hashes
    // starved every claude_code panel.
    assert.match(expression, /project_id=~"atlas\|beacon"/);
    assert.doesNotMatch(expression, /[0-9a-f]{64}/);
  }
  for (const expression of regularExpressions.filter((expression) => expression.includes('service_name="workbench-observer"'))) {
    assert.match(expression, /workbench_attribute_project_name=~"atlas\|beacon"/);
  }
  // claude_code.* events carry no project attribution, so the injected matcher
  // would filter on a label that is never present and starve the panel.
  const connections = global.panels.find(({ title }) => title === 'MCP connection activity');
  assert.doesNotMatch(connections.targets[0].expr, /workbench_attribute_project_name/);
  assert.doesNotMatch(connections.targets[0].expr, /\$project/);
  assert.match(connections.targets[0].expr, /^sum by \(mcp_server, connection_status\)/);
  const offload = global.panels.find(({ title }) => title === 'Work moved off the Anthropic limit');
  assert.equal(offload.type, 'stat');
  assert.ok(offload.targets.every(({ expr }) => !expr.includes('project_id')));
  assert.ok(offload.targets.every(({ expr }) => !expr.includes('$project')));
  const topStats = global.panels.filter(({ gridPos }) => gridPos?.y === 1 && gridPos.h === 4);
  assert.deepEqual(topStats.map(({ gridPos }) => gridPos), [
    { x: 0, y: 1, w: 6, h: 4 },
    { x: 6, y: 1, w: 6, h: 4 },
    { x: 12, y: 1, w: 6, h: 4 },
    { x: 18, y: 1, w: 6, h: 4 },
  ]);
  assert.ok(dashboards.every(({ dashboard }) => dashboard.panels.every(({ title }) => title !== 'Unattributed sessions')));

  const atlas = dashboards.find(({ dashboard }) => dashboard.title === 'Claude Code — atlas').dashboard;
  const atlasExpressions = atlas.panels.flatMap((panel) => panel.targets || []).map(({ expr }) => expr);
  for (const expression of atlasExpressions.filter((expression) => expression.includes('claude_code_'))) {
    assert.match(expression, /project_id="atlas"/);
    assert.doesNotMatch(expression, /[0-9a-f]{64}/);
  }
  // By-project breakdowns are global-only; on a one-project board they can
  // only ever show the board itself.
  const atlasTitles = atlas.panels.map(({ title }) => title);
  assert.equal(atlasTitles.includes('Usage by project'), false);
  assert.equal(atlasTitles.includes('Cost over time, by project'), false);
  assert.equal(atlasTitles.includes('MCP connection activity'), false);
  assert.equal(atlasTitles.includes('Work moved off the Anthropic limit'), false);
  const globalTitles = global.panels.map(({ title }) => title);
  assert.ok(globalTitles.includes('Usage by project'));
  assert.ok(globalTitles.includes('Cost over time, by project'));
  assert.ok(globalTitles.includes('MCP connection activity'));
  assert.ok(globalTitles.includes('Work moved off the Anthropic limit'));
  for (const expression of atlasExpressions.filter((expression) => expression.includes('service_name="workbench-observer"'))) {
    assert.match(expression, /workbench_attribute_project_name="atlas"/);
  }

  const output = provisionDashboards(directory, projects);
  assert.deepEqual(fs.readdirSync(output).sort(), dashboards.map(({ fileName }) => fileName).sort());
  provisionDashboards(directory, []);
  const empty = JSON.parse(fs.readFileSync(path.join(output, 'claude-code-usage.json'), 'utf8'));
  assert.deepEqual(fs.readdirSync(output), ['claude-code-usage.json']);
  assert.equal(empty.panels.length, global.panels.length);
  assert.ok(empty.panels.every(({ title }) => title !== 'Unattributed sessions'));
  assert.ok(empty.panels.flatMap((panel) => panel.targets || []).map(({ expr }) => expr).every((expression) => !expression.includes('$project')));
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

test('Grafana dashboard separates token breakdowns from tool and MCP activity', () => {
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'observability', 'sinks', 'grafana', 'dashboards', 'claude-code-usage.json'), 'utf8'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  for (const title of [
    'Tokens & models', 'Efficiency', 'Tool activity', 'MCP', 'Sessions & agents',
    'Gateway internals', 'Board cost attribution',
  ]) {
    const row = byTitle.get(title);
    assert.equal(row?.type, 'row', `missing dashboard row: ${title}`);
    assert.equal(row.collapsed, false);
  }
  for (const title of [
    'Tokens over time, by type', 'Cost allocation, by token type (USD)', 'Tokens over time, by model', 'Models in use', 'Token volume by backend',
    'Background/compaction cost by model and project',
    'Tool activity by name', 'MCP activity by server / tool', 'MCP definition footprint by server',
    'Tool activity error rate',
    'Tool activity duration p95', 'Active vs idle time', 'MCP connection activity',
    'Hook execution activity / failures', 'Subagent lifecycle activity',
    'Gateway usage by session and role',
    'Ticket dispatch usage and route drift',
  ]) assert.ok(byTitle.has(title), `missing dashboard panel: ${title}`);
  const costByModel = byTitle.get('Cost over time, by model');
  assert.equal(costByModel.type, 'timeseries');
  assert.equal(costByModel.fieldConfig.defaults.custom.stacking.mode, 'normal');
  assert.match(costByModel.description, /not money owed/);
  assert.equal(byTitle.get('Unpriced model usage').type, 'table');
  assert.ok(byTitle.get('How to read this row').options.content.includes('list-price-equivalent'));
  for (const title of ['Tokens over time, by type', 'Tokens over time, by model', 'Cost over time, by project']) {
    const overTime = byTitle.get(title);
    assert.equal(overTime.interval, '$bucket');
    assert.match(overTime.targets[0].expr, /\[\$bucket\]/);
    assert.equal(overTime.fieldConfig.defaults.custom.stacking.mode, 'normal');
  }

  for (const title of [
    'Fresh input (uncached)', 'Cache reads (billed at 10%)',
    'Output tokens (raw)', 'Cost (USD estimate)',
    'Context spent per answer token (lower is better)', 'Work moved off the Anthropic limit',
  ]) assert.equal(byTitle.get(title)?.type, 'stat', `missing explanatory stat: ${title}`);
  const billedPerOutput = byTitle.get('Context spent per answer token (lower is better)');
  assert.equal(billedPerOutput.targets[0].instant, true);
  assert.match(billedPerOutput.targets[0].expr, /sum by \(query_source\)/);
  assert.match(billedPerOutput.targets[0].expr, /type=~"cacheRead\|cacheCreation\|input"/);
  assert.match(billedPerOutput.targets[0].expr, /and \(sum by \(query_source\).*type="output".* > 0\)/);
  assert.match(billedPerOutput.targets[0].expr, /\[\$__range\]/);
  const offloadShare = byTitle.get('Work moved off the Anthropic limit');
  assert.equal(offloadShare.targets.length, 3);
  assert.ok(offloadShare.targets.every((target) => target.instant));
  assert.match(offloadShare.targets[0].expr, /model=~"claude-codex-\.\*"/);
  assert.match(offloadShare.targets[0].expr, /and \(sum\(increase\(claude_code_cost_usage_USD_total\[\$__range\]\)\) > 0\)/);
  assert.ok(offloadShare.targets.every(({ expr }) => !expr.includes('project_id')));
  const auxiliarySpend = byTitle.get('Background/compaction cost by model and project');
  assert.equal(auxiliarySpend.type, 'table');
  assert.equal(auxiliarySpend.targets[0].instant, true);
  assert.match(auxiliarySpend.targets[0].expr, /^sort_desc\(sum by \(model, project_id\)/);
  assert.match(auxiliarySpend.targets[0].expr, /query_source="auxiliary"/);
  assert.match(auxiliarySpend.targets[0].expr, /\[\$__range\]/);
  assert.match(JSON.stringify(auxiliarySpend.transformations), /"Model"/);
  assert.match(JSON.stringify(auxiliarySpend.transformations), /"Project"/);
  const tokenModel = byTitle.get('How tokens become cost');
  assert.equal(tokenModel?.type, 'text');
  assert.match(tokenModel.options.content, /Context volume = fresh input \+ cache reads \+ cache creation/);
  assert.match(tokenModel.options.content, /cache reads × 0\.1/);
  const tokenByType = byTitle.get('Tokens over time, by type');
  const costByType = byTitle.get('Cost allocation, by token type (USD)');
  assert.equal(costByType.fieldConfig.defaults.unit, 'currencyUSD');
  assert.equal(costByType.gridPos.y, tokenByType.gridPos.y);
  assert.equal(costByType.gridPos.x, tokenByType.gridPos.x + tokenByType.gridPos.w);
  assert.equal(costByType.gridPos.h, tokenByType.gridPos.h);
  assert.match(costByType.description, /four legend Totals add up to that card within rounding/);
  assert.deepEqual(costByType.targets.map(({ legendFormat }) => legendFormat), ['fresh input', 'cache reads', 'cache creation', 'output']);
  // Instant $__range targets are a snapshot allocation. On a time axis they draw
  // one point at the right edge, and a per-step window would make the legend
  // Total over-count by the window/step overlap and stop matching the USD card.
  assert.equal(costByType.type, 'piechart');
  assert.equal(costByType.fieldConfig.defaults.custom, undefined);
  assert.deepEqual(costByType.options.legend.values, ['value', 'percent']);
  for (const target of costByType.targets) {
    assert.equal(target.instant, true);
    assert.match(target.expr, /\[\$__range\]/);
    assert.match(target.expr, /or vector\(0\)/);
    assert.match(target.expr, /claude_code_cost_usage_USD_total/);
  }
  const toolDurationP95 = byTitle.get('Tool activity duration p95');
  assert.equal(toolDurationP95.targets[0].expr, 'quantile_over_time(0.95, {service_name="workbench-observer"} |= "hook.post_tool_use" | unwrap workbench_measurement_duration_ms_value [$__range]) by ()');
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
  assert.match(definitionPanel.targets[0].expr, /gateway\.mcp\.footprint/);
  assert.match(definitionPanel.targets[0].expr, /workbench_attribute_mcp_server/);
  assert.match(definitionPanel.targets[0].expr, /workbench_measurement_input_mcp_tools_tokens_value/);
  assert.match(definitionPanel.targets[0].expr, /avg_over_time/);
  assert.doesNotMatch(definitionPanel.targets[0].expr, /sum_over_time/);
  assert.doesNotMatch(definitionPanel.targets[0].expr, /plugin_sidequest_board|plugin_playwright_playwright/);
  assert.match(definitionPanel.description, /new servers appear automatically/i);
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
  assert.match(byTitle.get('Tokens over time, by model').targets[0].expr, /\[\$bucket\]/);
  assert.match(byTitle.get('Models in use').targets[0].expr, /\[\$__range\]/);
  assert.equal(byTitle.get('Models in use').targets[0].instant, true);

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
  // Claude Code names only plugin-hosted servers on this event, so a `!= ""`
  // guard on either label drops every row and the panel reads as a healthy zero.
  assert.doesNotMatch(connectionActivity.targets[0].expr, /workbench_attribute_\w+ != ""/);
  assert.match(connectionActivity.targets[0].expr, /label_format mcp_server=/);
  assert.match(connectionActivity.targets[0].expr, /workbench_attribute_plugin_name/);
  assert.match(connectionActivity.targets[0].expr, /unnamed \(non-plugin server\)/);
  assert.equal(connectionActivity.targets[0].legendFormat, '{{mcp_server}} ({{connection_status}})');
  assert.match(connectionActivity.fieldConfig.defaults.noValue, /the observer is not receiving them/);
  for (const title of ['Tokens over time, by type', 'Tokens over time, by model', 'Context-window growth']) {
    assert.deepEqual(byTitle.get(title).options.legend, { displayMode: 'table', placement: 'right', calcs: ['sum'] });
  }
  const hookActivity = byTitle.get('Hook execution activity / failures');
  assert.match(hookActivity.targets[0].expr, /workbench_attribute_hook_name/);
  assert.equal(hookActivity.targets[0].legendFormat, '{{workbench_attribute_hook_name}}');
  const wakeupJoin = byTitle.get('Wakeup join keys');
  assert.equal(wakeupJoin?.type, 'text');
  assert.match(wakeupJoin.options.content, /workbench_attribute_recipient/);
  assert.match(wakeupJoin.options.content, /workbench_tool_use_id/);
  assert.match(wakeupJoin.options.content, /workbench_attribute_wake_reason/);
  const lifecycle = byTitle.get('Subagent lifecycle activity');
  assert.match(lifecycle.targets[0].expr, /workbench_attribute_agent_type != ""/);
  assert.match(lifecycle.targets[0].expr, /regexReplaceAll/);
  const sessionUsage = byTitle.get('Gateway usage by session and role');
  assert.equal(sessionUsage.type, 'table');
  assert.deepEqual(sessionUsage.options.footer.reducer, ['sum']);
  assert.equal(sessionUsage.targets.length, 3);
  assert.ok(sessionUsage.targets.every((target) => target.instant === true));
  assert.match(sessionUsage.targets[0].expr, /sum by \(workbench_session_id, session_label, workbench_attribute_agent_role, workbench_attribute_model\)/);
  assert.match(sessionUsage.targets[0].expr, /workbench_measurement_context_tokens_value/);
  assert.match(sessionUsage.targets[1].expr, /count_over_time/);
  assert.match(sessionUsage.targets[2].expr, /hook\.session_start/);
  assert.match(sessionUsage.targets[2].expr, /workbench_attribute_project_name/);
  assert.ok(sessionUsage.transformations.some(({ id }) => id === 'joinByField'));
  assert.match(JSON.stringify(sessionUsage.transformations), /"byField":"workbench_session_id"/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Project/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Session/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Role/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Model/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Context tokens/);
  assert.match(JSON.stringify(sessionUsage.transformations), /Requests/);
  assert.match(JSON.stringify(sessionUsage.transformations), /"desc":true/);
  const boardCost = byTitle.get('Ticket dispatch usage and route drift');
  assert.equal(boardCost.type, 'table');
  assert.match(boardCost.description, /Batched agents mapped to multiple tickets are excluded/i);
  assert.ok(boardCost.targets.every((target) => target.instant === true));
  assert.ok(boardCost.targets.every((target) => target.expr.includes('$__range')));
  assert.ok(boardCost.targets.slice(0, 3).every((target) => target.expr.includes('gateway.token.usage')));
  assert.match(boardCost.targets[3].expr, /sidequest\.ticket/);
  assert.match(boardCost.targets[3].expr, /on \(workbench_agent_id\)/);
  assert.match(boardCost.targets[3].expr, /== 1/);
  assert.doesNotMatch(JSON.stringify(boardCost.targets), /group_left/);
  assert.match(boardCost.targets[0].expr, /workbench_measurement_context_tokens_value/);
  assert.match(boardCost.targets[2].expr, /workbench_measurement_cost_usd_value/);
  assert.ok(boardCost.transformations.some(({ id }) => id === 'merge'));
  assert.match(JSON.stringify(boardCost.transformations), /Configured route/);
  assert.match(JSON.stringify(boardCost.transformations), /Resolved model/);
  assert.equal(byTitle.get('Context-window growth').targets[0].legendFormat, 'session {{session_label}}');
  for (const title of [
    'Gateway usage by session and role', 'Orchestrator vs executor usage', 'Input composition over time',
    'Context-window growth', 'Prompt-cache economics',
    'MCP definition footprint by server',
  ]) {
    for (const target of byTitle.get(title).targets) assert.match(target.expr, /workbench_session_id !~ "\(probe\|session-gateway\)\.\*"/);
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
  // 'Work moved off the Anthropic limit' sat between these two on the global
  // dashboard; per-project they close over its slot instead of framing a gap.
  assert.deepEqual(byTitle.get('Context spent per answer token (lower is better)').gridPos.w, 12);
  assert.deepEqual(byTitle.get('Background/compaction cost by model and project').gridPos.x, 12);
  assert.deepEqual(byTitle.get('Tokens over time, by model').gridPos.w, 24);
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
