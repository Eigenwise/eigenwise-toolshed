'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildStatuslineObservations } = require('../bin/workbench-statusline.js');
const { projectName, registryEntry, telemetryEnvironment } = require('../bin/project-telemetry.js');
const { EVENT_MAP, buildObservation, projectMetadata } = require('../hooks/observability.js');
const { ticketObservation: adapterTicketObservation } = require('../lib/observability/adapters/sidequest.js');
const { normalizeObservation } = require('../lib/observability/ingest.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { otlpToObservations } = require('../lib/observability/otlp.js');
const { normalizeAssistantUsage, normalizeTerminalResult } = require('../lib/observability/sdk.js');
const { ALLOWED_EVENTS, ALLOWED_MEASUREMENTS, ATTRIBUTE_SPECS } = require('../lib/observability/schema.js');
const { generatedDashboards } = require('../observability/sinks/grafana/dashboard-generator.js');
const { buildOtlpLogPayload, createGatewayUsageEmitter } = require('../../codex-gateway/lib/usage-observability.js');
const { ticketObservation: nativeTicketObservation } = require('../../sidequest/lib/telemetry.js');

const PROJECT_DIR = 'C:\\workspace\\canonical-project';
const NOW = new Date('2026-07-20T12:00:00.000Z');

function assertAccepted(observation, fixture) {
  const result = normalizeObservation(observation);
  assert.equal(result.accepted, true, `${fixture} rejected ${result.rejectedFields.join(', ')}`);
  assert.deepEqual(result.droppedFields, [], `${fixture} dropped ${result.droppedFields.join(', ')}`);
  assert.deepEqual(result.rejectedFields, [], `${fixture} rejected ${result.rejectedFields.join(', ')}`);
  return result;
}

function hookFixtures() {
  const common = {
    cwd: PROJECT_DIR,
    session_id: 'session-canonical',
    prompt_id: 'prompt-canonical',
    agent_id: 'agent-canonical',
    parent_agent_id: 'parent-agent',
    tool_use_id: 'tool-canonical',
    task_id: 'task-canonical',
    permission_mode: 'acceptEdits',
    effort: 'high',
    model: 'gpt-5.6-terra',
    agent_type: 'sidequest-exec-dispatch-high',
    reason: 'completed',
    status: 'completed',
    task_status: 'completed',
    tool_name: 'mcp__sidequest__claim',
    tool_input: { path: 'private' },
    tool_result: { output: 'private' },
    duration_ms: 12,
  };
  return Object.keys(EVENT_MAP).map((hookEvent) => ({
    name: `hook:${hookEvent}`,
    observation: buildObservation({ ...common, hook_event_name: hookEvent }, NOW),
  }));
}

function sdkFixtures(projectId) {
  const context = {
    projectId,
    sessionId: 'session-canonical',
    workflowRunId: 'workflow-canonical',
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    observedAt: NOW.toISOString(),
    parentToolUseId: 'tool-canonical',
  };
  const assistant = normalizeAssistantUsage({
    type: 'assistant',
    session_id: 'session-canonical',
    request_id: 'request-canonical',
    parent_tool_use_id: 'tool-canonical',
    message: { id: 'message-canonical', model: 'gpt-5.6-terra', usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
  }, context);
  const terminal = normalizeTerminalResult({
    uuid: 'terminal-canonical',
    session_id: 'session-canonical',
    subtype: 'success',
    stop_reason: 'end_turn',
    num_turns: 2,
    duration_ms: 12,
    duration_api_ms: 9,
    total_cost_usd: 0.01,
    usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    modelUsage: { 'gpt-5.6-terra': { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, costUSD: 0.01 } },
  }, context);
  return [assistant, ...terminal].filter(Boolean).map((observation, index) => ({ name: `sdk:${index}`, observation }));
}

function gatewayFixtures(projectId) {
  const records = [];
  const emitter = createGatewayUsageEmitter({
    endpoint: 'http://127.0.0.1:4318/v1/logs',
    emit(record) { records.push(record); },
  });
  const baseline = {
    tools: [{ name: 'mcp__sidequest__claim', description: 'private' }],
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-canonical', name: 'mcp__sidequest__claim', input: {} }] }],
  };
  const next = {
    ...baseline,
    messages: [...baseline.messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-canonical', content: 'private' }] }],
  };
  for (const [payload, tokens] of [[baseline, 10], [next, 14]]) {
    const capture = emitter.start({
      payload,
      requestHeaders: { 'x-claude-code-session-id': 'session-canonical', 'x-claude-code-agent-id': 'agent-canonical' },
      route: { backend: 'codex', effectiveModel: 'gpt-5.6-terra', requestedModel: 'claude-codex-auto', effort: 'high', via: 'dispatch' },
    });
    capture.setResponse(200, { 'request-id': 'request-canonical' });
    capture.observeJson(JSON.stringify({ usage: { input_tokens: tokens, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }));
    capture.finish();
  }
  return records.flatMap((record) => otlpToObservations('logs', buildOtlpLogPayload(record), { projectId })
    .map((observation, index) => ({ name: `gateway:${record.eventName}:${index}`, observation })));
}

function sidequestFixtures(projectId) {
  const ticket = {
    ref: 'SQ-587',
    status: 'doing',
    updatedAt: NOW.toISOString(),
    category: { id: 'coding.normal', route: { model: 'gpt-5.6-terra', effort: 'high', backend: 'codex' } },
    model: 'gpt-5.6-terra',
    effort: 'high',
    exec: { backend: 'codex', runsModel: 'gpt-5.6-terra', agent: 'sidequest-exec-dispatch-high' },
    dispatch: { id: 'dispatch-canonical', taskId: 'task-canonical', sessionId: 'session-canonical', agentId: 'agent-canonical', executor: 'sidequest-exec-dispatch-high' },
    claim: { by: 'worker-canonical', sessionId: 'session-canonical' },
  };
  return [
    { name: 'sidequest-adapter', observation: adapterTicketObservation(ticket, { projectId }) },
    { name: 'sidequest-native', observation: nativeTicketObservation({ slug: 'canonical-project', path: PROJECT_DIR }, ticket) },
  ];
}

const EXTERNAL_INGRESS_OR_RESERVED = Object.freeze({
  events: [
    'claude_code.api_request', 'claude_code.api_error', 'claude_code.llm_request', 'claude_code.tool_result', 'claude_code.tool_decision', 'claude_code.mcp_server_connection', 'claude_code.hook_execution_start', 'claude_code.hook_execution_complete',
    'agent_sdk.assistant_usage', 'agent_sdk.terminal_result', 'otel.metric', 'hook.session_start', 'hook.session_end', 'hook.user_prompt_submit', 'hook.pre_tool_use', 'hook.post_tool_use', 'hook.stop', 'hook.subagent_start', 'hook.subagent_stop', 'hook.task_completed',
    'statusline.context_snapshot', 'statusline.rate_limit', 'context.compaction', 'tool.call', 'sidequest.ticket', 'codex_gateway.route', 'gateway.token.usage', 'gateway.mcp.footprint', 'gateway.tool_result.usage', 'gateway.limit.signal', 'coverage_gap', 'telemetry_conflict', 'schema_drop',
  ],
  attributes: [
    'agent_type', 'agent_role', 'activity_type', 'backend', 'cache_attribution', 'category', 'claim_session_id', 'claim_worker_id', 'configured_backend', 'configured_effort', 'configured_model', 'decision', 'dispatch_id', 'effective_model', 'effort', 'end_reason', 'error_code', 'error_type', 'executor', 'fallback', 'field_names', 'is_mcp', 'hook_event', 'hook_name', 'mcp_server', 'mcp_tool', 'model', 'outcome', 'path_class', 'permission_mode', 'plugin_name', 'provider', 'project_name', 'requested_model', 'request_id_source', 'response_mode', 'resolved_backend', 'resolved_effort', 'resolved_model', 'retry_count', 'selected_model', 'status', 'status_code', 'stop_reason', 'task_status', 'token_estimator', 'trace_linked', 'tool_kind', 'tool_name', 'turns', 'via',
  ],
  measurements: [
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'thinking_tokens', 'context_tokens', 'input_tools_tokens', 'input_native_tools_tokens', 'input_mcp_tools_tokens', 'input_system_tokens', 'input_first_message_tokens', 'input_history_tokens', 'input_tool_results_tokens', 'cache_read_tools_tokens', 'cache_read_system_tokens', 'cache_read_first_message_tokens', 'cache_read_history_tokens', 'fresh_tools_tokens', 'fresh_system_tokens', 'fresh_first_message_tokens', 'fresh_history_tokens', 'context_window_tokens', 'context_delta_tokens', 'pre_tokens', 'post_tokens', 'result_tokens', 'tool_input_tokens_estimate', 'tool_result_tokens_estimate', 'tool_result_tokens', 'duration_ms', 'active_time_ms', 'blocked_ms', 'api_duration_ms', 'cost_usd', 'bytes_in', 'bytes_out', 'tool_input_bytes', 'tool_result_bytes', 'request_body_bytes', 'response_body_bytes', 'input_system_bytes', 'input_tools_bytes', 'input_native_tools_bytes', 'input_mcp_tools_bytes', 'input_messages_bytes', 'input_first_message_bytes', 'input_history_bytes', 'input_tool_results_bytes', 'request_count', 'tool_count', 'server_tool_use_count', 'web_search_requests', 'web_fetch_requests', 'code_execution_requests', 'tool_search_requests', 'rate_limit_requests_limit', 'rate_limit_requests_remaining', 'rate_limit_requests_reset_at_ms', 'rate_limit_input_tokens_limit', 'rate_limit_input_tokens_remaining', 'rate_limit_input_tokens_reset_at_ms', 'rate_limit_output_tokens_limit', 'rate_limit_output_tokens_remaining', 'rate_limit_output_tokens_reset_at_ms', 'rate_limit_tokens_limit', 'rate_limit_tokens_remaining', 'rate_limit_tokens_reset_at_ms', 'retry_after_ms', 'codex_throttle_used_percent', 'rate_limit_percent', 'rate_limit_reset_ms', 'rate_limit_five_hour_used_percent', 'rate_limit_five_hour_reset_at_ms', 'rate_limit_seven_day_used_percent', 'rate_limit_seven_day_reset_at_ms', 'dropped_records', 'queue_depth', 'queue_capacity',
  ],
});

test('every local emitter is accepted by the canonical schema', () => {
  const projectId = projectMetadata(PROJECT_DIR).project_id;
  const statusline = buildStatuslineObservations({
    session_id: 'session-canonical', model: { id: 'gpt-5.6-terra' },
    context_window: { used_tokens: 10, window_tokens: 100 }, cost: { total_cost_usd: 0.01, total_duration_ms: 12 },
    rate_limit: { used_percent: 20, reset_in_ms: 30 }, rate_limits: { five_hour: { used_percentage: 20, resets_at: 100 }, seven_day: { used_percentage: 30, resets_at: 200 } },
  }, NOW, { value: 42 });
  const fixtures = [
    ...hookFixtures(),
    ...statusline.map((observation, index) => ({ name: `statusline:${index}`, observation: { ...observation, project_id: projectId } })),
    ...sdkFixtures(projectId),
    ...gatewayFixtures(projectId),
    ...sidequestFixtures(projectId),
  ];
  assert.ok(fixtures.length >= Object.keys(EVENT_MAP).length + 8);
  for (const fixture of fixtures) assertAccepted(fixture.observation, fixture.name);
});

test('declared schema members have a local fixture or an explicit external reservation', () => {
  const projectId = projectMetadata(PROJECT_DIR).project_id;
  const local = [
    ...hookFixtures(),
    ...buildStatuslineObservations({ session_id: 'session-canonical', context_window: { used_tokens: 1, window_tokens: 2 } }, NOW, { value: 1 }).map((observation) => ({ observation })),
    ...sdkFixtures(projectId),
    ...gatewayFixtures(projectId),
    ...sidequestFixtures(projectId),
  ];
  const covered = {
    events: new Set(local.map(({ observation }) => observation.event_name)),
    attributes: new Set(local.flatMap(({ observation }) => Object.keys(observation.attributes || {}))),
    measurements: new Set(local.flatMap(({ observation }) => (observation.measurements || []).map(({ name }) => name))),
  };
  for (const key of Object.keys(covered)) for (const value of EXTERNAL_INGRESS_OR_RESERVED[key]) covered[key].add(value);
  assert.deepEqual(ALLOWED_EVENTS.filter((value) => !covered.events.has(value)), []);
  assert.deepEqual(Object.keys(ATTRIBUTE_SPECS).filter((value) => !covered.attributes.has(value)), []);
  assert.deepEqual(ALLOWED_MEASUREMENTS.filter((value) => !covered.measurements.has(value)), []);
  assert.deepEqual(EXTERNAL_INGRESS_OR_RESERVED.events.filter((value) => !ALLOWED_EVENTS.includes(value)), []);
  assert.deepEqual(EXTERNAL_INGRESS_OR_RESERVED.attributes.filter((value) => !Object.hasOwn(ATTRIBUTE_SPECS, value)), []);
  assert.deepEqual(EXTERNAL_INGRESS_OR_RESERVED.measurements.filter((value) => !ALLOWED_MEASUREMENTS.includes(value)), []);
});

test('canonical project identity stays aligned across Workbench emitters and selectors', () => {
  const identity = projectMetadata(PROJECT_DIR);
  const hook = buildObservation({ hook_event_name: 'SessionStart', cwd: PROJECT_DIR, session_id: 'session-canonical', agent_id: 'agent-canonical' }, NOW);
  const statusline = { ...buildStatuslineObservations({ session_id: 'session-canonical', context_window: { used_tokens: 10, window_tokens: 100 } }, NOW, { value: 42 })[0], project_id: identity.project_id };
  const sdk = sdkFixtures(identity.project_id)[0].observation;
  const adapter = sidequestFixtures(identity.project_id)[0].observation;
  const native = sidequestFixtures(identity.project_id)[1].observation;
  const gateway = gatewayFixtures(identity.project_id)[0].observation;
  const registry = registryEntry(PROJECT_DIR, NOW);
  const resourceAttributes = new Map(telemetryEnvironment(PROJECT_DIR).OTEL_RESOURCE_ATTRIBUTES.split(',').map((entry) => entry.split('=')));
  const dashboards = generatedDashboards([registry]);
  const selectors = dashboards.flatMap(({ dashboard }) => dashboard.panels.flatMap((panel) => (panel.targets || []).map((target) => target.expr || '')));

  assert.equal(projectName(PROJECT_DIR), identity.project_name);
  assert.equal(hook.project_id, identity.project_id);
  assert.equal(hook.session_id, 'session-canonical');
  assert.equal(hook.agent_id, 'agent-canonical');
  assert.equal(hook.attributes.project_name, identity.project_name);
  assert.equal(statusline.project_id, identity.project_id);
  assert.equal(statusline.session_id, 'session-canonical');
  assert.equal(sdk.project_id, identity.project_id);
  assert.equal(sdk.session_id, 'session-canonical');
  assert.equal(adapter.project_id, identity.project_id);
  assert.equal(native.project_id, identity.project_id);
  assert.equal(native.session_id, 'session-canonical');
  assert.equal(native.agent_id, 'agent-canonical');
  assert.equal(gateway.project_id, identity.project_id);
  assert.equal(gateway.session_id, 'session-canonical');
  assert.equal(gateway.agent_id, 'agent-canonical');
  assert.equal(registry.project_id, identity.project_id);
  assert.equal(registry.project_name, identity.project_name);
  assert.equal(resourceAttributes.get('project.id'), identity.project_name);
  assert.ok(selectors.some((selector) => selector.includes(`project_id="${identity.project_name}"`)));
});

test('native Sidequest identity joins the canonical project after ingest', () => {
  const projectId = projectMetadata(PROJECT_DIR).project_id;
  const [{ observation: adapter }, { observation: native }] = sidequestFixtures(projectId);
  const store = openObservabilityStore(':memory:', { outboxEnabled: false });
  try {
    assert.equal(store.ingest(adapter).accepted, true);
    assert.equal(store.ingest(native).accepted, true);
    const rows = store.database.prepare(`
      SELECT project_id FROM observation
      WHERE event_name = 'sidequest.ticket'
      ORDER BY source_schema
    `).all();
    assert.deepEqual(rows.map(({ project_id: value }) => value), [projectId, projectId]);
  } finally {
    store.close();
  }
});
