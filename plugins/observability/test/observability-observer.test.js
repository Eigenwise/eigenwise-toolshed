'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertLoopbackHost,
  createObserver,
  installedPluginVersion,
} = require('../bin/observer.js');
const { createOutboxDrainer, flushOutbox } = require('../lib/observability/outbox.js');
const { DEFAULT_DRAIN_BUDGET_MS, drainHookSpool } = require('../lib/observability/hook-spool.js');
const { RESOLVED_VIEWS } = require('../lib/observability/schema.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { startFakeOtlpReceiver, testSink } = require('./observability-test-support.js');

const PROJECT_ID = 'a'.repeat(64);
const FIXTURE_NOW = new Date('2026-08-07T12:00:00.000Z');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-'));
  const file = path.join(directory, 'ledger.db');
  const store = openObservabilityStore(file, { now: () => FIXTURE_NOW });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function requestObservation(overrides = {}) {
  return {
    source: 'claude_code',
    source_event_id: 'api-event-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:00.000Z',
    event_name: 'claude_code.api_request',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    prompt_id: 'prompt-1',
    request_id: 'request-1',
    trace_id: '0123456789abcdef0123456789abcdef',
    span_id: '0123456789abcdef',
    ticket_ref: 'SQ-472',
    attributes: {
      model: 'claude-test',
      provider: 'anthropic',
      backend: 'claude',
      effort: 'xhigh',
      status: 'ok',
    },
    measurements: [
      { name: 'input_tokens', value: 100, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 20, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_read_tokens', value: 30, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_creation_tokens', value: 5, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'duration_ms', value: 250, unit: 'ms', scope: 'request', quality: 'exact_client' },
    ],
    links: [{
      relation: 'attributed_to',
      to_kind: 'ticket',
      to_id: 'SQ-472',
      method: 'application_supplied',
      quality: 'exact',
    }],
    ...overrides,
  };
}

function measurement(name, value, scope = 'request', quality = 'exact_provider') {
  return { name, value, unit: name === 'duration_ms' ? 'ms' : 'tokens', scope, quality };
}

test('uses a ten-second default hook spool drain budget', () => {
  assert.equal(DEFAULT_DRAIN_BUDGET_MS, 10_000);
});

test('opens a single-writer WAL ledger with append-only facts and all resolved views', (t) => {
  const store = temporaryStore(t);
  assert.equal(store.database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.database.prepare('PRAGMA busy_timeout').get().timeout, 5000);

  const result = store.ingest(requestObservation());
  assert.equal(result.accepted, true);
  assert.equal(result.committed, true);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 1);
  assert.throws(
    () => store.database.prepare("UPDATE observation SET event_name = 'coverage_gap'").run(),
    /append-only/,
  );

  const views = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all().map((row) => row.name);
  for (const view of RESOLVED_VIEWS) assert.ok(views.includes(view), `${view} view is missing`);
});

test('deduplicates source IDs and preserves conflicting retries as telemetry conflicts', (t) => {
  const store = temporaryStore(t);
  const first = store.ingest(requestObservation());
  const duplicate = store.ingest(requestObservation({ event_id: 'different-event-id' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event_id, first.event_id);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);

  const conflicting = store.ingest(requestObservation({
    measurements: [measurement('input_tokens', 999)],
  }));
  assert.equal(conflicting.conflict, true);
  const conflict = store.getObservation(conflicting.conflict_event_ids[0]);
  assert.equal(conflict.event_name, 'telemetry_conflict');
  assert.equal(conflict.measurements[0].value, 999);
  assert.equal(conflict.links[0].to_id, first.event_id);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 2);
});

test('drops unknown data by field name and rejects invalid enum values without storing their values', (t) => {
  const store = temporaryStore(t);
  const accepted = store.ingest(requestObservation({
    cwd: 'C:/private/Alice/secret-project',
    attributes: {
      model: 'claude-test',
      prompt: 'private prompt value',
      raw_error: 'credit-card-4111111111111111',
      headers: { authorization: 'Bearer credential-value' },
    },
  }));
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.dropped_fields, [
    'attributes.headers',
    'attributes.prompt',
    'attributes.raw_error',
    'cwd',
  ]);

  const schemaDrop = store.getObservation(accepted.schema_drop_event_id);
  assert.equal(schemaDrop.event_name, 'schema_drop');
  assert.deepEqual(schemaDrop.attributes.field_names, accepted.dropped_fields);
  const databaseText = store.database.prepare(`
    SELECT group_concat(source_event_id || attributes_json || payload_json, '') AS text
    FROM observation JOIN otlp_outbox USING (event_id)
  `).get().text;
  assert.doesNotMatch(databaseText, /Alice|private prompt value|411111|credential-value/);

  const rejected = store.ingest(requestObservation({
    source_event_id: 'bad-quality',
    measurements: [measurement('input_tokens', 10, 'request', 'probably_exact')],
  }));
  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.rejected_fields, ['measurements[0].quality']);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE source_event_id = 'bad-quality'").get().count, 0);
});

test('resolves request usage by precedence and never adds checks or context snapshots into totals', (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({
    source: 'agent_sdk',
    source_event_id: 'assistant-1',
    event_name: 'agent_sdk.assistant_usage',
    measurements: [measurement('input_tokens', 90), measurement('output_tokens', 18)],
  }));
  store.ingest(requestObservation());
  store.ingest(requestObservation({
    source_event_id: 'api-event-2',
    observed_at: '2026-07-18T12:01:00.000Z',
    request_id: 'request-2',
    measurements: [
      measurement('input_tokens', 40),
      { name: 'output_tokens', value: null, unit: 'tokens', scope: 'request', quality: 'unavailable' },
    ],
  }));
  store.ingest({
    source: 'statusline',
    source_event_id: 'snapshot-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:01:30.000Z',
    event_name: 'statusline.context_snapshot',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    prompt_id: 'prompt-1',
    attributes: { model: 'claude-test', effort: 'xhigh' },
    measurements: [
      { name: 'context_tokens', value: 10000, unit: 'tokens', scope: 'context_snapshot', quality: 'exact_client' },
    ],
  });
  store.ingest({
    source: 'agent_sdk',
    source_event_id: 'terminal-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:02:00.000Z',
    event_name: 'agent_sdk.terminal_result',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    attributes: { model: 'claude-test', status: 'ok', turns: 2 },
    measurements: [measurement('input_tokens', 999, 'run')],
  });
  store.ingest({
    source: 'otel_collector',
    source_event_id: 'metric-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:03:00.000Z',
    event_name: 'otel.metric',
    project_id: PROJECT_ID,
    attributes: { model: 'claude-test' },
    measurements: [measurement('input_tokens', 5000, 'aggregate')],
  });

  const request = store.database.prepare("SELECT * FROM request_usage_resolved WHERE request_id = 'request-1'").get();
  assert.equal(request.evidence_event, 'claude_code.api_request');
  assert.equal(request.input_tokens, 100);
  assert.equal(request.output_tokens, 20);

  const rollup = store.database.prepare("SELECT * FROM session_rollup WHERE session_id = 'session-1'").get();
  assert.equal(rollup.request_count, 2);
  assert.equal(rollup.input_tokens, 140);
  assert.equal(rollup.output_tokens, null);
  assert.notEqual(rollup.input_tokens, 10000 + 999 + 5000);
  assert.equal(store.queryView('context_timeline').length, 1);
  assert.ok(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'telemetry_conflict'").get().count >= 2);
});

test('resolves direct ticket, agent, tool, route, coverage, and outbox projections', (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({ ticket_ref: undefined }));
  store.ingest({
    source: 'hook',
    source_event_id: 'session-start-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:00.500Z',
    event_name: 'hook.session_start',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    attributes: { permission_mode: 'acceptEdits', effort: 'xhigh' },
  });
  store.ingest({
    source: 'hook',
    source_event_id: 'agent-start-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:01.000Z',
    event_name: 'hook.subagent_start',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    workflow_run_id: 'workflow-1',
    agent_id: 'agent-1',
    parent_agent_id: 'agent-main',
    attributes: { agent_type: 'worker', model: 'claude-test', effort: 'xhigh' },
  });
  store.ingest({
    source: 'hook',
    source_event_id: 'tool-start-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:02.000Z',
    event_name: 'hook.pre_tool_use',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    agent_id: 'agent-1',
    tool_use_id: 'tool-1',
    attributes: { tool_name: 'mcp__server__read', tool_kind: 'mcp', is_mcp: true, mcp_server: 'server', mcp_tool: 'read' },
  });
  store.ingest({
    source: 'hook',
    source_event_id: 'tool-end-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:03.000Z',
    event_name: 'hook.post_tool_use',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    agent_id: 'agent-1',
    tool_use_id: 'tool-1',
    attributes: { tool_name: 'mcp__server__read', tool_kind: 'mcp', is_mcp: true, mcp_server: 'server', mcp_tool: 'read', status: 'ok' },
    measurements: [{ name: 'duration_ms', value: 1000, unit: 'ms', scope: 'attempt', quality: 'exact_client' }],
  });
  store.ingest({
    source: 'codex_gateway',
    source_event_id: 'route-1',
    source_schema: '1',
    observed_at: '2026-07-18T12:00:04.000Z',
    event_name: 'codex_gateway.route',
    project_id: PROJECT_ID,
    session_id: 'session-1',
    request_id: 'request-1',
    route_id: 'route-1',
    attributes: {
      requested_model: 'sol', selected_model: 'gpt-test', effective_model: 'gpt-test',
      backend: 'codex', effort: 'xhigh', fallback: false, via: 'gateway', status: 'ok', path_class: 'messages',
    },
  });

  assert.equal(store.queryView('ticket_rollup')[0].ticket_ref, 'SQ-472');
  assert.equal(store.queryView('agent_tree')[0].parent_agent_id, 'agent-main');
  assert.equal(store.queryView('tool_calls')[0].duration_ms, 1000);
  assert.equal(store.queryView('route_comparison')[0].effective_model, 'gpt-test');
  assert.ok(store.queryView('coverage_gaps').some((row) => row.gap_kind === 'missing_session_end'));
  assert.equal(store.queryView('outbox_health')[0].pending_count, 6);
});

test('keeps unavailable values null and rejects human project names and path-shaped IDs', (t) => {
  const store = temporaryStore(t);
  const unavailable = store.ingest(requestObservation({
    source_event_id: 'unavailable-1',
    measurements: [{ name: 'output_tokens', value: null, unit: 'tokens', scope: 'request', quality: 'unavailable' }],
  }));
  assert.equal(unavailable.accepted, true);
  assert.equal(store.getObservation(unavailable.event_id).measurements[0].value, null);

  const humanProject = store.ingest(requestObservation({ source_event_id: 'human-project', project_id: 'Secret Client Project' }));
  assert.equal(humanProject.accepted, false);
  assert.deepEqual(humanProject.rejected_fields, ['project_id']);

  const pathId = store.ingest(requestObservation({ source_event_id: 'path-id', task_id: 'C:/Users/Alice/task.txt' }));
  assert.equal(pathId.accepted, false);
  assert.deepEqual(pathId.rejected_fields, ['task_id']);

  const persisted = JSON.stringify({
    observations: store.database.prepare('SELECT * FROM observation').all(),
    links: store.database.prepare('SELECT * FROM link').all(),
    outbox: store.database.prepare('SELECT * FROM otlp_outbox').all(),
  });
  assert.doesNotMatch(persisted, /Secret Client Project|C:\/Users\/Alice\/task\.txt/);
});

test('exports sanitized OTLP only after acknowledgement and bounds retries without raw errors', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation());
  const sent = [];
  const delivered = await flushOutbox(store, {
    endpoint: 'http://127.0.0.1:45678/v1/logs',
    fetch: async (url, request) => {
      sent.push({ url: String(url), payload: JSON.parse(request.body) });
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(delivered, { selected: 1, delivered: 1, failed: 0, exhausted: 0 });
  assert.deepEqual({ ...store.queryView('outbox_health')[0] }, {
    pending_count: 0,
    retryable_count: 0,
    exhausted_count: 0,
    total_attempts: 0,
    oldest_pending_at: null,
    last_attempt_at: null,
    last_error_code: null,
  });
  assert.equal(sent[0].payload.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'claude_code.api_request');

  store.ingest(requestObservation({ source_event_id: 'api-event-2', request_id: 'request-2' }));
  const failed = await flushOutbox(store, {
    endpoint: 'http://127.0.0.1:45678/v1/logs',
    maxAttempts: 1,
    fetch: async () => { throw new Error('raw upstream credential-value'); },
  });
  assert.equal(failed.exhausted, 1);
  const health = store.queryView('outbox_health')[0];
  assert.equal(health.exhausted_count, 1);
  assert.match(health.last_error_code, /^transport_/);
  assert.doesNotMatch(JSON.stringify(store.database.prepare('SELECT * FROM otlp_outbox').all()), /credential-value|raw upstream/);

  store.ingest(requestObservation({ source_event_id: 'api-event-type-error', request_id: 'request-type-error' }));
  const typeError = await flushOutbox(store, {
    endpoint: 'http://127.0.0.1:45678/v1/logs',
    maxAttempts: 1,
    fetch: async () => { throw new TypeError('sender implementation failed'); },
  });
  assert.equal(typeError.exhausted, 0);
  const typeErrorRow = store.database.prepare("SELECT attempts, available_at, last_error_code FROM otlp_outbox WHERE last_error_code = 'transport_typeerror'").get();
  assert.deepEqual(typeErrorRow.attempts, 0);
  assert.ok(typeErrorRow.available_at);
  assert.equal(typeErrorRow.last_error_code, 'transport_typeerror');

  await assert.rejects(
    () => flushOutbox(store, { endpoint: 'http://0.0.0.0:4318/v1/logs', fetch: async () => ({ ok: true }) }),
    /loopback/,
  );
  await assert.rejects(
    () => flushOutbox(store, { endpoint: 'http://127.0.0.1:14318/v1/logs', fetch: async () => ({ ok: true }) }),
    /Tests must use an explicit ephemeral receiver/,
  );
});

test('requeues exhausted outbox records through the observer', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({ source_event_id: 'exhausted-outbox' }));
  await flushOutbox(store, {
    endpoint: 'http://127.0.0.1:45678/v1/logs',
    maxAttempts: 1,
    fetch: async () => { throw new Error('sink unavailable'); },
  });
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-spool-'));
  t.after(() => fs.rmSync(spoolDirectory, { recursive: true, force: true }));
  const observer = createObserver({
    store,
    host: '127.0.0.1',
    port: 0,
    hookSpoolFile: path.join(spoolDirectory, 'spool.jsonl'),
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  t.after(() => observer.close());
  const address = await observer.start();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/outbox/requeue`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requeued: 1 });
  assert.equal(store.pendingOutbox().length, 1);
  const outboxRow = store.database.prepare('SELECT attempts, last_attempt_at, last_error_code FROM otlp_outbox').get();
  assert.deepEqual({ ...outboxRow }, { attempts: 0, last_attempt_at: null, last_error_code: null });
  assert.equal(store.queryView('outbox_health')[0].exhausted_count, 0);
  const secondResponse = await fetch(`http://127.0.0.1:${address.port}/v1/outbox/requeue`, { method: 'POST' });
  assert.deepEqual(await secondResponse.json(), { requeued: 0 });
});

test('outbox transport deadlines release the drainer for the next tick', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({ source_event_id: 'hanging-outbox' }));
  let sends = 0;
  const hangingTransport = new Promise(() => {});
  const drainer = createOutboxDrainer(store, {
    endpoint: 'http://127.0.0.1:4319/v1/logs',
    timeoutMs: 25,
    baseDelayMs: 1,
    maxDelayMs: 1,
    fetch: async () => {
      sends += 1;
      return hangingTransport;
    },
  });

  const first = await drainer.flush();
  assert.deepEqual(first, { selected: 1, delivered: 0, failed: 1, exhausted: 0 });
  assert.match(store.queryView('outbox_health')[0].last_error_code, /^transport_/);

  const second = await drainer.flush();
  assert.deepEqual(second, { selected: 1, delivered: 0, failed: 1, exhausted: 0 });
  assert.equal(sends, 2);
});

test('refuses stale observer versions and removes them after the installed version advances', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryDirectory = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'observability@eigenwise-toolshed': [{ version: '0.5.2' }, { version: '0.5.3' }],
    },
  }));
  assert.equal(installedPluginVersion(home), '0.5.3');

  const staleObserver = createObserver({
    databaseFile: path.join(home, 'stale.db'),
    pluginVersion: '0.5.2',
    home,
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  await assert.rejects(staleObserver.start(), /older than installed version 0\.5\.3/);
  await staleObserver.close();

  let installedVersion = '0.5.2';
  const observer = createObserver({
    databaseFile: path.join(home, 'active.db'),
    pluginVersion: '0.5.2',
    host: '127.0.0.1',
    port: 0,
    getInstalledPluginVersion: () => installedVersion,
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  t.after(() => observer.close());
  const address = await observer.start();
  installedVersion = '0.5.3';
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.ok, false);
  assert.equal(health.pluginVersion, '0.5.2');
  assert.equal(health.error, 'plugin_version_outdated');
});

test('health reports an outbox that stopped attempting delivery', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({ source_event_id: 'stalled-outbox' }));
  const observer = createObserver({
    store,
    host: '127.0.0.1',
    port: 0,
    outboxIntervalMs: 250,
    hookSpoolFile: path.join(os.tmpdir(), `workbench-observer-spool-${process.pid}-stalled.jsonl`),
    sink: {
      id: 'test',
      egress: 'loopback',
      outbox: { enabled: true, endpoint: 'http://127.0.0.1:45679/v1/logs', headers: {}, allowRemote: false },
    },
    fetch: async () => { throw new TypeError('sender implementation failed'); },
  });
  t.after(() => observer.close());
  const address = await observer.start();
  while (!store.queryView('outbox_health')[0].last_attempt_at) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.ok, false);
  assert.equal(health.error, 'outbox_stalled');
  assert.equal(health.outbox.exhausted_count, 0);
  assert.equal(health.outbox.last_error_code, 'transport_typeerror');
});

test('quarantines repeatedly failing hook spools, logs their error, and keeps health answering', async (t) => {
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-poison-spool-'));
  t.after(() => fs.rmSync(spoolDirectory, { recursive: true, force: true }));
  const spoolPath = path.join(spoolDirectory, 'hook-spool.jsonl');
  fs.writeFileSync(spoolPath, '{"event":"one"}\n');
  const logs = [];
  let resolveSecondFailure;
  const secondFailure = new Promise((resolve) => { resolveSecondFailure = resolve; });
  const observer = createObserver({
    store: {
      ingestBatch() { throw Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' }); },
      queryView() { return [{ pending_count: 0 }]; },
      storageMetrics() { return {}; },
    },
    host: '127.0.0.1',
    port: 0,
    hookSpoolFile: spoolPath,
    hookSpoolFailureThreshold: 2,
    hookSpoolIntervalMs: 250,
    logger: {
      error(message, details) {
        logs.push({ message, details });
        if (logs.length === 2) resolveSecondFailure();
      },
    },
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  t.after(() => observer.close());
  const address = await observer.start();
  await secondFailure;

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.spool.last_error.code, 'SQLITE_BUSY');
  assert.equal(health.spool.consecutive_failures, 0);
  assert.match(health.spool.last_quarantined_file, /hook-spool\.jsonl\.poison-\d{4}-\d{2}-\d{2}$/);
  assert.equal(fs.existsSync(`${spoolPath}.draining`), false);
  assert.equal(fs.existsSync(health.spool.last_quarantined_file), true);
  assert.deepEqual(logs[0], {
    message: 'Observer hook spool drain failed',
    details: { code: 'SQLITE_BUSY', message: 'database is busy', file: `${spoolPath}.draining` },
  });
});

test('hook spool drain keeps committed rows out of the next attempt after its budget expires', async (t) => {
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-budget-spool-'));
  t.after(() => fs.rmSync(spoolDirectory, { recursive: true, force: true }));
  const spoolPath = path.join(spoolDirectory, 'hook-spool.jsonl');
  fs.writeFileSync(spoolPath, '{"event":"one"}\n{"event":"two"}\n');
  const state = { consecutive_failures: 0, last_error: null };
  let ingestCalls = 0;
  const store = {
    ingestBatch() {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        const deadline = Date.now() + 20;
        while (Date.now() < deadline) {}
      }
      return [{ accepted: true, duplicate: false }];
    },
  };

  await assert.rejects(
    drainHookSpool({ spoolPath, store, batchSize: 1, drainBudgetMs: 10, failureState: state }),
    (error) => {
      assert.equal(error.code, 'HOOK_SPOOL_DRAIN_TIMEOUT');
      assert.match(error.message, /10ms time budget after \d+ms with 1 spool entries remaining/);
      assert.equal(error.drain_budget_ms, 10);
      assert.equal(error.remaining_spool_entries, 1);
      return true;
    },
  );
  assert.equal(state.consecutive_failures, 0);
  assert.equal(fs.readFileSync(`${spoolPath}.draining`, 'utf8'), '{"event":"two"}\n');
  assert.deepEqual(
    await drainHookSpool({ spoolPath, store, batchSize: 1, drainBudgetMs: 100, failureState: state }),
    { drained: 1, duplicates: 0, rejected: 0, malformed: 0, droppedBytes: 0 },
  );
  assert.equal(fs.existsSync(`${spoolPath}.draining`), false);
});

test('hook spool drain finishes late final batches and records success', async (t) => {
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-late-final-batch-'));
  t.after(() => fs.rmSync(spoolDirectory, { recursive: true, force: true }));
  const spoolPath = path.join(spoolDirectory, 'hook-spool.jsonl');
  fs.writeFileSync(spoolPath, '{"event":"one"}\n');
  const state = { consecutive_failures: 2, last_error: { code: 'SQLITE_BUSY' } };
  const store = {
    async ingestBatch() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ accepted: true, duplicate: false }];
    },
  };

  assert.deepEqual(
    await drainHookSpool({ spoolPath, store, batchSize: 1, drainBudgetMs: 10, failureState: state }),
    { drained: 1, duplicates: 0, rejected: 0, malformed: 0, droppedBytes: 0 },
  );
  assert.equal(fs.existsSync(`${spoolPath}.draining`), false);
  assert.equal(state.consecutive_failures, 0);
  assert.equal(state.last_error, null);
  assert.equal(typeof state.last_success_at, 'string');
});

test('health reports a hook spool drain that remains in flight past its deadline', async (t) => {
  const spoolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-stalled-spool-'));
  t.after(() => fs.rmSync(spoolDirectory, { recursive: true, force: true }));
  const spoolPath = path.join(spoolDirectory, 'hook-spool.jsonl');
  fs.writeFileSync(spoolPath, '{"event":"one"}\n');
  const observer = createObserver({
    store: {
      ingestBatch() { return new Promise(() => {}); },
      queryView() { return [{ pending_count: 0 }]; },
      storageMetrics() { return {}; },
    },
    host: '127.0.0.1',
    port: 0,
    hookSpoolFile: spoolPath,
    hookSpoolDrainBudgetMs: 10,
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  t.after(() => observer.close());
  const address = await observer.start();
  await new Promise((resolve) => setTimeout(resolve, 120));

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.error, 'hook_spool_drain_stalled');
  assert.match(health.spool.in_flight_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('observer reports unrecoverable storage pressure without dropping the triggering ingestion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observer-pressure-'));
  const store = openObservabilityStore(path.join(directory, 'ledger.db'), {
    maxDatabaseBytes: 1,
    storageReserveBytes: 0,
    now: () => FIXTURE_NOW,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const observer = createObserver({
    store,
    host: '127.0.0.1',
    port: 0,
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
    hookSpoolFile: path.join(directory, 'spool.jsonl'),
  });
  t.after(() => observer.close());
  const address = await observer.start();
  const base = `http://127.0.0.1:${address.port}`;

  const ingestion = await fetch(`${base}/v1/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestObservation({ source_event_id: 'storage-pressure' })),
  });
  const body = await ingestion.json();
  assert.equal(ingestion.status, 200);
  assert.equal(body.committed, true);
  assert.equal(body.storagePressure.failure, 'storage_headroom_unrecoverable');

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).error, 'storage_headroom_unrecoverable');
});

test('observer binds only to loopback and acknowledges HTTP ingestion after commit', async (t) => {
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /loopback/);
  const store = temporaryStore(t);
  const receiver = await startFakeOtlpReceiver();
  const observer = createObserver({ store, host: '127.0.0.1', port: 0, sink: testSink(receiver.endpoint), hookSpoolFile: path.join(os.tmpdir(), `workbench-observer-spool-${process.pid}.jsonl`) });
  t.after(() => receiver.close());
  t.after(() => observer.close());
  const address = await observer.start();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/v1/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestObservation()),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.committed, true);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);

  const view = await fetch(`${base}/v1/views/request_usage_resolved?limit=10`);
  assert.equal(view.status, 200);
  assert.equal((await view.json()).rows[0].input_tokens, 100);
  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.pid, process.pid);
  assert.equal(healthBody.pluginVersion, require('../.claude-plugin/plugin.json').version);
  assert.equal(healthBody.storage.overDatabaseLimit, false);
  assert.equal(healthBody.storage.overWalLimit, false);
});

test('observer runs retention and WAL maintenance after startup', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({
    source_event_id: 'expired-maintenance',
    observed_at: '2020-01-01T00:00:00.000Z',
  }));
  const observer = createObserver({
    store,
    host: '127.0.0.1',
    port: 0,
    hookSpoolFile: path.join(os.tmpdir(), `workbench-observer-maintenance-${process.pid}.jsonl`),
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
  });
  t.after(() => observer.close());

  await observer.start();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 0);
});

test('continuous outbox drain is fail-open and shares one in-flight flush', async (t) => {
  const store = temporaryStore(t);
  store.ingest(requestObservation({ source_event_id: 'continuous-outbox' }));
  let fetchCalls = 0;
  let releaseFetch;
  const upstream = new Promise((resolve) => { releaseFetch = resolve; });
  const observer = createObserver({
    store,
    host: '127.0.0.1',
    port: 0,
    hookSpoolFile: path.join(os.tmpdir(), `workbench-observer-spool-${process.pid}-outbox.jsonl`),
    outboxIntervalMs: 60_000,
    sink: {
      id: 'test',
      egress: 'loopback',
      outbox: { enabled: true, endpoint: 'http://127.0.0.1:45679/v1/logs', headers: {}, allowRemote: false },
    },
    fetch: async () => {
      fetchCalls += 1;
      return upstream;
    },
  });
  t.after(() => observer.close());
  const address = await observer.start();
  while (fetchCalls === 0) await new Promise((resolve) => setImmediate(resolve));

  const manualFlush = fetch(`http://127.0.0.1:${address.port}/v1/outbox/flush`, { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  releaseFetch({ ok: true, status: 200 });
  assert.equal((await manualFlush).status, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(store.queryView('outbox_health')[0].pending_count, 0);
});
