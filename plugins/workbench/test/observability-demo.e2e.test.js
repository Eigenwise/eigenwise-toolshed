'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { setupObservability } = require('../bin/setup-observability.js');
const { createObserver } = require('../bin/workbench-observer.js');
const { buildStatuslineObservations } = require('../bin/workbench-statusline.js');
const { buildObservation, spool } = require('../hooks/observability.js');
const { captureCodexRouteLog } = require('../lib/observability/adapters/codex-gateway.js');
const { ticketObservation } = require('../lib/observability/adapters/sidequest.js');
const { flushOutbox } = require('../lib/observability/outbox.js');
const { drainHookSpool } = require('../lib/observability/hook-spool.js');
const { buildTokenUsageReport, formatTokenUsageReport } = require('../lib/observability/report.js');
const { createWorkflowRun } = require('../lib/observability/sdk.js');
const { AgentSdkQueryFailure, observeQuery } = require('../lib/observability/sdk-query.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { startFakeOtlpReceiver, testSink } = require('./observability-test-support.js');

const DEMO_ROOT = path.resolve(__dirname, '../../../examples/token-observability-demo');
const PROJECT_ID = 'b'.repeat(64);
const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

function isoNano(value) {
  return String(BigInt(Date.parse(value)) * 1000000n);
}

function attr(key, value) {
  const encoded = typeof value === 'boolean' ? { boolValue: value }
    : typeof value === 'number' ? { intValue: String(value) }
      : { stringValue: value };
  return { key, value: encoded };
}

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function hook(payload, observedAt) {
  return buildObservation(payload, new Date(observedAt));
}

function measurement(name, value, unit = name.endsWith('_ms') ? 'ms' : 'tokens', scope = 'request', quality = 'exact_provider') {
  return { name, value, unit, scope, quality };
}

function apiRequest(overrides = {}) {
  return {
    source: 'claude_code',
    source_event_id: 'api-manual-codex',
    source_schema: 'fixture-v1',
    observed_at: '2026-07-19T12:00:02.000Z',
    event_name: 'claude_code.api_request',
    project_id: PROJECT_ID,
    session_id: 'session-demo',
    prompt_id: 'prompt-demo-2',
    request_id: 'request-codex',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    attributes: {
      model: 'gpt-5.6-sol',
      provider: 'codex',
      backend: 'codex',
      effort: 'high',
      status: 'ok',
    },
    measurements: [
      measurement('input_tokens', 600),
      measurement('output_tokens', 110),
      measurement('cache_read_tokens', 80),
      measurement('cache_creation_tokens', 12),
      measurement('duration_ms', 310, 'ms', 'request', 'exact_client'),
      measurement('cost_usd', 0.012, 'usd', 'request', 'estimate'),
    ],
    ...overrides,
  };
}

function copyDemoProject(directory) {
  const projectDir = path.join(directory, 'project');
  fs.cpSync(path.join(DEMO_ROOT, 'project'), projectDir, { recursive: true });
  fs.mkdirSync(path.join(directory, 'application-data'), { recursive: true });
  return projectDir;
}

test('runs the disposable demo through setup, local OTLP, hooks, SDK, tools, routes, and reports', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-observability-demo-'));
  const projectDir = copyDemoProject(directory);
  const dataDir = path.join(directory, 'application-data');
  const collectorQueue = path.join(dataDir, 'collector-queue');
  fs.mkdirSync(collectorQueue, { recursive: true });
  fs.writeFileSync(path.join(collectorQueue, 'wal-replay.fixture'), '{"source":"collector-wal"}\n');
  const setup = await setupObservability({
    projectDir,
    dataDir,
    sink: 'none',
    dockerAvailable: false,
    claudeVersion: '2.1.212',
    environment: { WORKBENCH_OTELCOL_CONTRIB: process.execPath },
    ensure: async () => ({ enabled: true, started: [] }),
  });
  const observerStore = openObservabilityStore(setup.databaseFile);
  const receiver = await startFakeOtlpReceiver();
  const observer = createObserver({ store: observerStore, host: '127.0.0.1', port: 0, sink: testSink(receiver.endpoint), hookSpoolFile: path.join(dataDir, 'observer-hook-spool.jsonl') });
  const address = await observer.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await observer.close();
    await receiver.close();
    observerStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const localSettings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8'));
  const projectSettings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(projectSettings.customSetting, 'preserve-this');
  assert.equal(localSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(localSettings.env.OTEL_METRICS_INCLUDE_SESSION_ID, 'false');
  assert.match(fs.readFileSync(setup.collectorConfig, 'utf8'), /file_storage\/observer_queue/);
  assert.match(fs.readFileSync(setup.collectorConfig, 'utf8'), /sending_queue:/);
  assert.match(fs.readFileSync(setup.collectorConfig, 'utf8'), /retry_on_failure:/);
  assert.equal(fs.readFileSync(path.join(collectorQueue, 'wal-replay.fixture'), 'utf8'), '{"source":"collector-wal"}\n');
  assert.equal(fs.existsSync(path.join(directory, 'project', '.claude', 'settings.json')), true);
  assert.equal(fs.existsSync(path.join(collectorQueue, 'real-user-state')), false);

  const otlpLogs = {
    resourceLogs: [{
      resource: { attributes: [attr('session.id', 'session-demo')] },
      scopeLogs: [{ logRecords: [{
        eventName: 'claude_code.api_request',
        timeUnixNano: isoNano('2026-07-19T12:00:01.000Z'),
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        body: { stringValue: 'private provider response must never be stored' },
        attributes: [
          attr('request.id', 'request-claude'), attr('prompt.id', 'prompt-demo'), attr('ticket.ref', 'SQ-474'),
          attr('model', 'claude-opus-4-8'), attr('provider', 'anthropic'), attr('backend', 'claude'),
          attr('effort', 'xhigh'), attr('status', 'ok'), attr('input_tokens', 1200), attr('output_tokens', 340),
          attr('cache_read_tokens', 800), attr('cache_creation_tokens', 64), attr('duration_ms', 450), attr('cost_usd', 0.04),
          attr('prompt', 'private prompt must be dropped'),
        ],
      }] }],
    }],
  };
  const logsResult = await postJson(base, '/v1/logs', otlpLogs);
  assert.equal(logsResult.response.status, 200);
  assert.equal(logsResult.body.committed, undefined);

  const otlpTrace = {
    resourceSpans: [{
      resource: { attributes: [attr('session.id', 'session-demo')] },
      scopeSpans: [{ spans: [{
        name: 'claude_code.llm_request', startTimeUnixNano: isoNano('2026-07-19T12:00:01.100Z'),
        traceId: TRACE_ID, spanId: '1122334455667788', parentSpanId: SPAN_ID,
        attributes: [attr('request.id', 'request-claude'), attr('model', 'claude-opus-4-8'), attr('provider', 'anthropic'), attr('backend', 'claude'), attr('effort', 'xhigh')],
      }] }],
    }],
  };
  assert.equal((await postJson(base, '/v1/traces', otlpTrace)).response.status, 200);

  const otlpMetric = {
    resourceMetrics: [{
      resource: { attributes: [attr('session.id', 'session-demo')] },
      scopeMetrics: [{ metrics: [{
        name: 'input_tokens', sum: { dataPoints: [{ timeUnixNano: isoNano('2026-07-19T12:00:01.200Z'), asInt: 999 }] },
      }] }],
    }],
  };
  assert.equal((await postJson(base, '/v1/metrics', otlpMetric)).response.status, 200);

  const hookEvents = [
    ['SessionStart', { session_id: 'session-demo', source: 'startup', permission_mode: 'acceptEdits', effort: 'xhigh' }, '2026-07-19T12:00:00.000Z'],
    ['UserPromptSubmit', { session_id: 'session-demo', prompt_id: 'prompt-demo', permission_mode: 'acceptEdits', effort: 'xhigh' }, '2026-07-19T12:00:00.100Z'],
    ['SubagentStart', { session_id: 'session-demo', agent_id: 'agent-child', parent_agent_id: 'agent-main', agent_type: 'worker', model: 'claude-opus-4-8', effort: 'high' }, '2026-07-19T12:00:00.200Z'],
    ['SubagentStop', { session_id: 'session-demo', agent_id: 'agent-child', parent_agent_id: 'agent-main', agent_type: 'worker', model: 'claude-opus-4-8', effort: 'high', status: 'completed' }, '2026-07-19T12:00:04.000Z'],
    ['PreToolUse', { session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'Bash', tool_use_id: 'tool-native', tool_input: { command: 'private command' } }, '2026-07-19T12:00:00.300Z'],
    ['PostToolUse', { session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'Bash', tool_use_id: 'tool-native', status: 'ok' }, '2026-07-19T12:00:00.500Z'],
    ['PreToolUse', { session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'mcp__demo_server__read', tool_use_id: 'tool-mcp' }, '2026-07-19T12:00:00.600Z'],
    ['PostToolUse', { session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'mcp__demo_server__read', tool_use_id: 'tool-mcp', status: 'error', error_type: 'timeout', error_code: 'mcp_timeout' }, '2026-07-19T12:00:00.900Z'],
    ['SessionEnd', { session_id: 'session-demo', reason: 'logout', permission_mode: 'acceptEdits', effort: 'xhigh' }, '2026-07-19T12:00:05.000Z'],
  ];
  for (const [event, payload, observedAt] of hookEvents) {
    const observation = hook({ hook_event_name: event, ...payload }, observedAt);
    const result = observerStore.ingest(observation);
    assert.equal(result.accepted, true, `${event} was rejected`);
  }
  const nativePost = hook({ hook_event_name: 'PostToolUse', session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'Bash', tool_use_id: 'tool-native', status: 'ok' }, '2026-07-19T12:00:00.501Z');
  nativePost.measurements = [measurement('duration_ms', 200, 'ms', 'attempt', 'exact_client'), measurement('bytes_in', 10, 'bytes', 'attempt', 'exact_client'), measurement('bytes_out', 20, 'bytes', 'attempt', 'exact_client')];
  observerStore.ingest(nativePost);
  const mcpPost = hook({ hook_event_name: 'PostToolUse', session_id: 'session-demo', agent_id: 'agent-child', tool_name: 'mcp__demo_server__read', tool_use_id: 'tool-mcp', status: 'error', error_type: 'timeout', error_code: 'mcp_timeout' }, '2026-07-19T12:00:00.901Z');
  mcpPost.measurements = [measurement('duration_ms', 300, 'ms', 'attempt', 'exact_client'), measurement('blocked_ms', 50, 'ms', 'attempt', 'exact_client')];
  observerStore.ingest(mcpPost);

  const snapshots = buildStatuslineObservations({
    session_id: 'session-demo', model: { id: 'claude-opus-4-8' },
    context: { used_tokens: 40000, window_tokens: 100000 },
    cost: { total_cost_usd: 0.04, total_duration_ms: 900 },
    rate_limit: { percent: 17, reset_ms: 3600000 },
  }, new Date('2026-07-19T12:00:01.500Z'), { value: 2048, quality: 'estimate' });
  observerStore.ingestBatch(snapshots);
  const growth = buildStatuslineObservations({ session_id: 'session-demo', model: { id: 'claude-opus-4-8' }, context: { used_tokens: 40800, window_tokens: 100000 } }, new Date('2026-07-19T12:00:03.500Z'), { value: 2300, quality: 'estimate' });
  growth[0].measurements.push(measurement('context_delta_tokens', 800, 'tokens', 'context_snapshot', 'derived_exact'));
  observerStore.ingestBatch(growth);
  observerStore.ingest({
    source: 'claude_code', source_event_id: 'compact-demo', source_schema: 'fixture-v1', observed_at: '2026-07-19T12:00:03.600Z',
    event_name: 'context.compaction', project_id: PROJECT_ID, session_id: 'session-demo', attributes: { model: 'claude-opus-4-8' },
    measurements: [measurement('pre_tokens', 40800, 'tokens', 'context_snapshot', 'estimate'), measurement('post_tokens', 12000, 'tokens', 'context_snapshot', 'estimate')],
  });
  const unavailable = buildStatuslineObservations({ session_id: 'session-demo', model: { id: 'claude-opus-4-8' }, context: {} }, new Date('2026-07-19T12:00:03.700Z'))[0];
  observerStore.ingest(unavailable);

  const workflow = createWorkflowRun({ workflowRunId: 'workflow-demo', projectId: PROJECT_ID });
  const sdkMessages = [];
  const query = observeQuery({
    prompt: 'private prompt never captured',
    options: {},
    context: { ...workflow, sessionId: 'session-demo', parentToolUseId: 'tool-native', observedAt: '2026-07-19T12:00:02.500Z' },
    query: async function* ({ options }) {
      assert.equal(options.env.TRACEPARENT, workflow.traceparent);
      yield { type: 'assistant', session_id: 'session-demo', request_id: 'request-sdk', message: { id: 'provider-msg-1', model: 'gpt-5.6-sol', usage: { input_tokens: 90, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } } };
      yield { type: 'result', subtype: 'success', uuid: 'sdk-result-1', session_id: 'session-demo', num_turns: 2, duration_ms: 700, duration_api_ms: 500, total_cost_usd: 0.01, usage: { input_tokens: 90, output_tokens: 20 }, modelUsage: { 'gpt-5.6-sol': { inputTokens: 90, outputTokens: 20, cacheReadInputTokens: 30, costUSD: 0.01 } }, result: 'private result' };
    },
    flushOptions: { url: `${base}/v1/observations` },
    onObservations: (observations) => sdkMessages.push(...observations),
  });
  for await (const message of query) assert.ok(message.type);
  assert.equal(sdkMessages.some((row) => row.workflow_run_id === 'workflow-demo'), true);
  await assert.rejects(async () => {
    for await (const _message of observeQuery({ query: async function* () { throw new Error('fixture failure'); } })) {}
  }, (error) => error instanceof AgentSdkQueryFailure);

  const ticket = ticketObservation({
    ref: 'SQ-474', story: 'US-16', categoryId: 'coding', configuredModel: 'gpt-5.6-sol', configuredEffort: 'high', configuredBackend: 'codex',
    resolvedModel: 'gpt-5.6-sol', resolvedEffort: 'high', resolvedBackend: 'codex', resolvedExecutor: 'sidequest-exec-dispatch-high',
    dispatchId: 'dispatch-demo', taskId: 'task-demo', claim: { by: 'worker-demo', sessionId: 'session-demo' }, status: 'doing', updatedAt: '2026-07-19T12:00:02.700Z',
  }, { projectId: PROJECT_ID });
  observerStore.ingest(ticket);

  const routeLog = path.join(directory, 'routes.jsonl');
  const routeCursor = path.join(directory, 'routes.cursor.json');
  const route = (model, at) => ({ at, backend: 'codex', model, path: '/v1/messages?secret=query', via: 'gateway', effort: 'high', sessionId: 'session-demo', prompt: 'private' });
  fs.writeFileSync(routeLog, `${JSON.stringify(route('gpt-5.6-sol', '2026-07-19T12:00:02.800Z'))}\n${JSON.stringify(route('gpt-5.6-sol', '2026-07-19T12:00:02.800Z'))}\n{malformed}\n${JSON.stringify(route('gpt-5.6-terra', '2026-07-19T12:00:02.900Z'))}`);
  const routeResult = await captureCodexRouteLog({
    logPath: routeLog,
    cursorPath: routeCursor,
    projectId: PROJECT_ID,
    nearestRequest: ({ model }) => model === 'gpt-5.6-sol' ? null : 'request-inferred',
    ingest: (observation) => {
      if (observation.attributes.effective_model === 'gpt-5.6-sol') {
        observation.request_id = 'request-codex';
        observation.route_id = 'route-direct';
        observation.attributes = { ...observation.attributes, requested_model: 'sol', selected_model: 'gpt-5.6-sol', fallback: false, status: 'ok' };
        observation.links = [{ relation: 'routes_via', to_kind: 'route', to_id: 'route-direct', method: 'direct_id', quality: 'exact' }];
      }
      return observerStore.ingest(observation);
    },
  });
  assert.deepEqual({ accepted: routeResult.accepted, duplicates: routeResult.duplicates, malformed: routeResult.malformed }, { accepted: 1, duplicates: 1, malformed: 1 });
  fs.appendFileSync(routeLog, '\n');
  await captureCodexRouteLog({ logPath: routeLog, cursorPath: routeCursor, projectId: PROJECT_ID, nearestRequest: () => 'request-inferred', ingest: (observation) => observerStore.ingest(observation) });
  fs.renameSync(routeLog, `${routeLog}.1`);
  fs.writeFileSync(routeLog, `${JSON.stringify(route('gpt-5.6-fable', '2026-07-19T12:00:03.000Z'))}\n`);
  await captureCodexRouteLog({ logPath: routeLog, cursorPath: routeCursor, projectId: PROJECT_ID, nearestRequest: () => 'request-inferred', ingest: (observation) => observerStore.ingest(observation) });
  observerStore.ingest({
    source: 'codex_gateway', source_event_id: 'route-unavailable', source_schema: 'route-v1', observed_at: '2026-07-19T12:00:03.100Z', event_name: 'codex_gateway.route', project_id: PROJECT_ID, session_id: 'session-demo', route_id: 'route-unavailable',
    attributes: { requested_model: 'terra', selected_model: 'gpt-5.6-terra', effective_model: 'gpt-5.6-terra', backend: 'codex', effort: 'high', fallback: false, via: 'gateway', status: 'ok', path_class: 'messages' },
  });

  observerStore.ingest({ source: 'claude_code', source_event_id: 'retry-error', source_schema: 'fixture-v1', observed_at: '2026-07-19T12:00:01.900Z', event_name: 'claude_code.api_error', project_id: PROJECT_ID, session_id: 'session-demo', request_id: 'request-claude', attributes: { model: 'claude-opus-4-8', provider: 'anthropic', backend: 'claude', effort: 'xhigh', status: 'error', error_type: 'timeout', error_code: 'transport_timeout', retry_count: 1 } });
  observerStore.ingest(apiRequest({ source_event_id: 'retry-evidence', observed_at: '2026-07-19T12:00:02.100Z' }));
  observerStore.ingest(apiRequest({ source_event_id: 'retry-evidence', measurements: [measurement('input_tokens', 601)] }));
  observerStore.ingest(apiRequest({ source_event_id: 'out-of-order', observed_at: '2026-07-19T11:59:59.000Z', request_id: 'request-old', prompt_id: 'prompt-old' }));
  const privacy = observerStore.ingest({
    source: 'claude_code', source_event_id: 'privacy-drop', source_schema: 'fixture-v1', observed_at: '2026-07-19T12:00:04.100Z', event_name: 'claude_code.api_error', project_id: PROJECT_ID, session_id: 'session-demo',
    cwd: 'C:/Users/real-user/private', attributes: { model: 'gpt-5.6-sol', provider: 'codex', backend: 'codex', effort: 'high', status: 'error', prompt: 'secret prompt', high_cardinality_label: 'secret-label' },
  });
  assert.equal(privacy.accepted, true);
  observerStore.ingest({ source: 'otel_collector', source_event_id: 'queue-saturated', source_schema: 'collector-v1', observed_at: '2026-07-19T12:00:04.200Z', event_name: 'coverage_gap', project_id: PROJECT_ID, attributes: { status: 'queue_saturated', error_type: 'queue_full', error_code: 'dropped_batch' }, measurements: [measurement('dropped_records', 3, 'count', 'aggregate', 'exact_client'), measurement('queue_depth', 100, 'count', 'aggregate', 'exact_client'), measurement('queue_capacity', 100, 'count', 'aggregate', 'exact_client')] });
  observerStore.ingest(hook({ hook_event_name: 'SessionStart', session_id: 'session-missing-end', source: 'startup' }, '2026-07-19T12:00:04.300Z'));
  const spoolPath = path.join(dataDir, 'hook-spool.jsonl');
  assert.equal(spool(spoolPath, hook({ hook_event_name: 'Stop', session_id: 'session-demo', reason: 'manual_compact' }, '2026-07-19T12:00:04.400Z')), true);
  assert.equal(JSON.parse(fs.readFileSync(spoolPath, 'utf8')).source, 'hook');
  assert.deepEqual(drainHookSpool({ spoolPath, store: observerStore, projectId: PROJECT_ID }), {
    drained: 1, duplicates: 0, rejected: 0, malformed: 0, droppedBytes: 0,
  });
  assert.equal(observerStore.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'hook.stop' AND observed_at = '2026-07-19T12:00:04.400Z'").get().count, 1);

  const databaseText = JSON.stringify(observerStore.database.prepare('SELECT * FROM observation').all()) + JSON.stringify(observerStore.database.prepare('SELECT * FROM otlp_outbox').all());
  assert.doesNotMatch(databaseText, /private provider response|private prompt|private result|private command|secret-label|real-user/);
  assert.equal(observerStore.queryView('request_usage_resolved').some((row) => row.request_id === 'request-claude' && row.input_tokens === 1200 && row.cache_read_tokens === 800), true);
  assert.equal(observerStore.queryView('request_usage_resolved').some((row) => row.request_id === 'request-codex' && row.backend === 'codex'), true);
  assert.equal(observerStore.queryView('agent_tree').some((row) => row.agent_id === 'agent-child' && row.parent_agent_id === 'agent-main'), true);
  assert.equal(observerStore.queryView('tool_calls').some((row) => row.tool_use_id === 'tool-mcp' && row.mcp_server === 'demo_server' && row.mcp_tool === 'read'), true);
  assert.equal(observerStore.queryView('coverage_gaps').some((row) => row.gap_kind === 'missing_session_end'), true);
  assert.equal(observerStore.queryView('coverage_gaps').some((row) => row.gap_kind === 'coverage_gap'), true);
  assert.equal(observerStore.queryView('coverage_gaps').some((row) => row.gap_kind === 'schema_drop'), true);
  assert.equal(observerStore.queryView('coverage_gaps').some((row) => row.gap_kind === 'telemetry_conflict'), true);

  const links = observerStore.database.prepare('SELECT method, quality, to_kind, to_id FROM link').all();
  assert.equal(links.some((row) => row.method === 'direct_id' && row.quality === 'exact'), true);
  assert.equal(links.some((row) => row.method === 'temporal_inference' && row.quality === 'inferred'), true);
  assert.equal(links.some((row) => row.to_kind === 'workflow' && row.to_id === 'workflow-demo'), true);
  assert.equal(observerStore.database.prepare("SELECT COUNT(*) AS count FROM link WHERE method = 'unlinked'").get().count, 0);
  assert.equal(observerStore.queryView('route_comparison').some((row) => row.route_id === 'route-unavailable' && row.request_id === null), true);
  assert.equal(observerStore.queryView('route_comparison').some((row) => row.request_id === 'request-codex' && row.backend === 'codex'), true);

  const report = buildTokenUsageReport(observerStore);
  assert.deepEqual(report.quality_labels, ['exact', 'derived', 'estimated', 'inferred', 'unavailable']);
  assert.equal(report.session_turn_ledger.some((row) => row.tokens.cache_read.quality === 'exact'), true);
  assert.equal(report.session_turn_ledger.some((row) => row.cost_usd.quality === 'unavailable'), true);
  assert.equal(report.context_timeline.some((row) => row.growth_tokens.quality === 'derived'), true);
  assert.equal(report.context_timeline.some((row) => row.compaction.pre_tokens.quality === 'estimated'), true);
  assert.equal(report.tools.some((row) => row.kind === 'mcp' && row.downstream_usage.quality === 'unavailable'), true);
  assert.equal(report.ticket_usage.some((row) => row.ticket_ref === 'SQ-474' && row.attribution === 'direct-only'), true);
  assert.equal(report.ticket_usage.some((row) => row.ticket_ref === null && row.attribution === 'unattributed'), true);
  assert.equal(report.route_comparison.some((row) => row.request_id === 'request-codex' && row.backend.quality === 'exact'), true);
  assert.ok(report.coverage.explicitly_unavailable.includes('provider invoice'));
  assert.match(formatTokenUsageReport(report), /estimated/);
  assert.match(formatTokenUsageReport(report), /unavailable/);

  const outage = await flushOutbox(observerStore, {
    endpoint: 'http://127.0.0.1:1/v1/logs', maxAttempts: 2, now: new Date('2099-01-01T00:00:00.000Z'),
    fetch: async () => { throw new Error('fixture observer outage'); },
  });
  assert.ok(outage.failed > 0);
  const replay = await flushOutbox(observerStore, {
    endpoint: receiver.endpoint, maxAttempts: 2, now: new Date('2099-01-02T00:00:00.000Z'),
  });
  assert.equal(replay.delivered, outage.failed);
  assert.equal(observerStore.queryView('outbox_health')[0].pending_count, 0);
});

test('keeps SDK and adapter telemetry fail-open during local outages', async () => {
  const failed = await require('../lib/observability/sdk.js').flushObservations([{ source: 'fixture' }], {
    url: 'http://127.0.0.1:1/v1/observations',
    fetch: async () => { throw new Error('fixture observer outage'); },
  });
  assert.deepEqual({ ok: failed.ok, error: failed.error }, { ok: false, error: 'unreachable' });
});
