'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createObserver } = require('../bin/workbench-observer.js');
const { buildTokenUsageReport } = require('../lib/observability/report.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { startFakeOtlpReceiver, testSink } = require('./observability-test-support.js');
const {
  buildOtlpLogPayload,
  createUsageCapture,
} = require('../../codex-gateway/lib/usage-observability.js');

const PROJECT_ID = 'a'.repeat(64);

function gatewayPayload() {
  const request = {
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'private system prompt' }],
    tools: [
      { name: 'Read', description: 'private native schema' },
      { name: 'mcp__sidequest__claim', description: 'private MCP schema' },
    ],
    messages: [
      { role: 'user', content: 'private first request' },
      { role: 'assistant', content: 'private accumulated history' },
    ],
  };
  let record;
  const capture = createUsageCapture({
    payload: request,
    requestBodyBytes: Buffer.byteLength(JSON.stringify(request)),
    requestHeaders: {
      'x-claude-code-session-id': 'session-gateway',
      'x-claude-code-agent-id': 'agent-gateway',
      'x-claude-code-parent-agent-id': 'parent-gateway',
      'x-claude-code-request-id': 'client-gateway',
      authorization: 'Bearer private credential',
    },
    route: {
      requestedModel: 'claude-codex-auto',
      effectiveModel: 'claude-opus-4-8',
      backend: 'anthropic',
      effort: 'max',
      via: 'dispatch',
    },
    sequence: 7,
    now: () => new Date('2026-07-19T20:00:00.000Z'),
    emit(value) { record = value; },
  });
  capture.setResponse(200, {
    'request-id': 'request-gateway',
    'anthropic-ratelimit-input-tokens-limit': '1000',
    'anthropic-ratelimit-input-tokens-remaining': '840',
  });
  capture.observeJson(JSON.stringify({
    id: 'msg-gateway',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'private response' }],
    usage: {
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
      thinking_tokens: 4,
      server_tool_use: { web_search_requests: 2 },
    },
  }));
  capture.finish();
  return buildOtlpLogPayload(record);
}

test('gateway OTLP becomes authoritative first-class usage across observer views and reports', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gateway-observer-'));
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  const receiver = await startFakeOtlpReceiver();
  const observer = createObserver({
    port: 0,
    store,
    projectId: PROJECT_ID,
    hookSpoolFile: path.join(directory, 'hook-spool.jsonl'),
    sink: testSink(receiver.endpoint),
  });
  const address = await observer.start();
  t.after(async () => {
    await observer.close();
    await receiver.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const payload = gatewayPayload();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});

  const gateway = store.database.prepare("SELECT * FROM observation WHERE event_name = 'gateway.token.usage'").get();
  assert.equal(gateway.source, 'codex_gateway');
  assert.equal(gateway.project_id, PROJECT_ID);
  assert.equal(gateway.session_id, 'session-gateway');
  assert.equal(gateway.request_id, 'request-gateway');
  assert.equal(gateway.client_request_id, 'client-gateway');
  assert.equal(gateway.agent_id, 'agent-gateway');
  assert.equal(gateway.parent_agent_id, 'parent-gateway');
  assert.equal(gateway.sequence, 7);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'schema_drop'").get().count, 0);

  store.ingest({
    source: 'claude_code',
    source_event_id: 'lower-ranked-client-usage',
    source_schema: 'test-v1',
    observed_at: '2026-07-19T20:00:01.000Z',
    event_name: 'claude_code.api_request',
    project_id: PROJECT_ID,
    session_id: 'session-gateway',
    request_id: 'request-gateway',
    attributes: { model: 'claude-codex-auto', backend: 'codex', status: 'ok' },
    measurements: [
      { name: 'input_tokens', value: 999, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 999, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
    ],
  });

  const request = store.queryView('request_usage_resolved')[0];
  assert.equal(request.evidence_event, 'gateway.token.usage');
  assert.equal(request.evidence_source, 'codex_gateway');
  assert.equal(request.model, 'claude-opus-4-8');
  assert.equal(request.requested_model, 'claude-codex-auto');
  assert.equal(request.agent_role, 'executor');
  assert.equal(request.input_tokens, 30);
  assert.equal(request.output_tokens, 12);
  assert.equal(request.cache_read_tokens, 100);
  assert.equal(request.cache_creation_tokens, 30);
  assert.equal(request.cache_creation_5m_tokens, 20);
  assert.equal(request.cache_creation_1h_tokens, 10);
  assert.equal(request.thinking_tokens, 4);
  assert.equal(request.context_tokens, 160);
  assert.equal(request.server_tool_use_count, 2);
  assert.equal(request.input_quality, 'exact_provider');
  assert.equal(request.context_quality, 'derived_exact');

  const session = store.queryView('session_rollup')[0];
  assert.equal(session.session_id, 'session-gateway');
  assert.equal(session.request_count, 1);
  assert.equal(session.total_context_tokens, 160);
  assert.equal(session.cache_read_ratio, 0.625);

  const agent = store.queryView('agent_usage_rollup')[0];
  assert.equal(agent.agent_role, 'executor');
  assert.equal(agent.agent_id, 'agent-gateway');
  assert.equal(agent.parent_agent_id, 'parent-gateway');
  assert.equal(agent.total_context_tokens, 160);

  const composition = store.queryView('input_composition')[0];
  assert.ok(composition.system_bytes > 0);
  assert.ok(composition.native_tools_bytes > 0);
  assert.ok(composition.mcp_tools_bytes > 0);
  assert.ok(composition.first_message_bytes > 0);
  assert.ok(composition.history_bytes > 0);
  assert.equal(composition.native_tools_tokens + composition.mcp_tools_tokens, composition.tools_tokens);
  assert.equal(
    composition.tools_tokens + composition.system_tokens + composition.first_message_tokens + composition.history_tokens,
    160,
  );

  const context = store.queryView('context_timeline')[0];
  assert.equal(context.request_id, 'request-gateway');
  assert.equal(context.context_tokens, 160);
  assert.equal(context.context_quality, 'derived_exact');

  const economics = store.queryView('cache_economics')[0];
  assert.equal(economics.read_savings_base_input_tokens, 90);
  assert.equal(economics.write_surcharge_base_input_tokens, 15);
  assert.equal(economics.net_savings_base_input_tokens, 75);
  assert.equal(economics.input_price_usd_per_million, 5);
  assert.equal(economics.net_savings_usd, 0.000375);

  const limits = store.queryView('limit_signals')[0];
  assert.equal(limits.input_tokens_limit, 1000);
  assert.equal(limits.input_tokens_remaining, 840);

  const qualities = Object.fromEntries(store.database.prepare('SELECT name, quality FROM measurement WHERE event_id = ?').all(gateway.event_id).map((row) => [row.name, row.quality]));
  assert.equal(qualities.input_tokens, 'exact_provider');
  assert.equal(qualities.request_body_bytes, 'exact_client');
  assert.equal(qualities.context_tokens, 'derived_exact');
  assert.equal(qualities.input_history_tokens, 'estimate');

  const report = buildTokenUsageReport(store);
  assert.equal(report.session_turn_ledger[0].tokens.context_total.value, 160);
  assert.equal(report.session_usage[0].session_id, 'session-gateway');
  assert.equal(report.agent_usage[0].agent_id, 'agent-gateway');
  assert.ok(report.input_composition[0].bytes.mcp_tools.value > 0);
  assert.equal(report.cache_economics[0].net_savings_base_input_tokens.value, 75);
  assert.equal(report.limit_signals[0].input_tokens.remaining.value, 840);

  const persisted = JSON.stringify({
    observations: store.database.prepare('SELECT * FROM observation').all(),
    outbox: store.database.prepare('SELECT payload_json FROM otlp_outbox').all(),
  });
  for (const forbidden of [
    'private system prompt', 'private native schema', 'private MCP schema', 'private first request',
    'private accumulated history', 'private response', 'private credential', 'authorization',
  ]) assert.equal(persisted.includes(forbidden), false, `observer persisted ${forbidden}`);
});

test('gateway tool-result usage records land with their declared quality and no schema drops', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gateway-toolresult-'));
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  const receiver = await startFakeOtlpReceiver();
  const observer = createObserver({
    port: 0,
    store,
    projectId: PROJECT_ID,
    hookSpoolFile: path.join(directory, 'hook-spool.jsonl'),
    sink: testSink(receiver.endpoint),
  });
  const address = await observer.start();
  t.after(async () => {
    await observer.close();
    await receiver.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const toolResultRecord = (id, quality) => ({
    eventName: 'gateway.tool_result.usage',
    observedAt: new Date('2026-07-19T20:00:02.000Z'),
    attributes: {
      source: 'codex_gateway',
      source_event_id: `gateway-tool-result-${id}`,
      source_schema: 'gateway-usage-v1',
      'event.name': 'gateway.tool_result.usage',
      event_name: 'gateway.tool_result.usage',
      request_id: 'request-gateway',
      client_request_id: 'client-gateway',
      session_id: 'session-gateway',
      agent_id: 'agent-gateway',
      parent_agent_id: 'parent-gateway',
      agent_role: 'executor',
      model: 'claude-opus-4-8',
      requested_model: 'claude-codex-auto',
      backend: 'anthropic',
      effort: 'max',
      via: 'dispatch',
      request_sequence: 8,
      tool_use_id: `toolu_seam_${id}`,
      tool_name: 'Read',
      tool_result_tokens: 421,
      tool_result_tokens_unit: 'tokens',
      tool_result_tokens_quality: quality,
    },
  });

  for (const [id, quality] of [['exact', 'derived_exact'], ['alloc', 'estimate'], ['bogus', 'not-a-quality']]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOtlpLogPayload(toolResultRecord(id, quality))),
    });
    assert.equal(response.status, 200);
  }

  const rows = store.database.prepare(
    "SELECT o.tool_use_id, o.agent_id, m.name, m.unit, m.quality, m.value FROM observation o JOIN measurement m ON m.event_id = o.event_id WHERE o.event_name = 'gateway.tool_result.usage' ORDER BY o.tool_use_id",
  ).all();
  assert.equal(rows.length, 3);
  const byToolUse = Object.fromEntries(rows.map((row) => [row.tool_use_id, row]));
  assert.equal(byToolUse.toolu_seam_exact.quality, 'derived_exact');
  assert.equal(byToolUse.toolu_seam_alloc.quality, 'estimate');
  assert.equal(byToolUse.toolu_seam_bogus.quality, 'estimate');
  for (const row of rows) {
    assert.equal(row.name, 'tool_result_tokens');
    assert.equal(row.unit, 'tokens');
    assert.equal(row.value, 421);
    assert.equal(row.agent_id, 'agent-gateway');
  }
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'schema_drop'").get().count, 0);
});

test('gateway mcp-footprint records keep their server label and drop nothing', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gateway-footprint-'));
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  const receiver = await startFakeOtlpReceiver();
  const observer = createObserver({
    port: 0,
    store,
    projectId: PROJECT_ID,
    hookSpoolFile: path.join(directory, 'hook-spool.jsonl'),
    sink: testSink(receiver.endpoint),
  });
  const address = await observer.start();
  t.after(async () => {
    await observer.close();
    await receiver.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const footprintRecord = (server, tokens) => ({
    eventName: 'gateway.mcp.footprint',
    observedAt: new Date('2026-07-19T20:00:03.000Z'),
    attributes: {
      source: 'codex_gateway',
      source_event_id: `gateway-mcp-footprint-${server}`,
      source_schema: 'gateway-usage-v1',
      'event.name': 'gateway.mcp.footprint',
      event_name: 'gateway.mcp.footprint',
      request_id: 'request-gateway',
      session_id: 'session-gateway',
      agent_id: 'agent-gateway',
      agent_role: 'orchestrator',
      model: 'claude-opus-4-8',
      requested_model: 'claude-codex-auto',
      backend: 'anthropic',
      effort: 'max',
      via: 'dispatch',
      mcp_server: server,
      input_mcp_tools_tokens: tokens,
    },
  });

  for (const [server, tokens] of [['plugin_sidequest_board', 1800], ['plugin_playwright_playwright', 1650]]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOtlpLogPayload(footprintRecord(server, tokens))),
    });
    assert.equal(response.status, 200);
  }

  const rows = store.database.prepare(
    "SELECT attributes_json, m.value FROM observation o JOIN measurement m ON m.event_id = o.event_id WHERE o.event_name = 'gateway.mcp.footprint' AND m.name = 'input_mcp_tools_tokens'",
  ).all();
  assert.equal(rows.length, 2);
  const byServer = {};
  for (const row of rows) byServer[JSON.parse(row.attributes_json).mcp_server] = row.value;
  assert.equal(byServer.plugin_sidequest_board, 1800);
  assert.equal(byServer.plugin_playwright_playwright, 1650);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'schema_drop'").get().count, 0);
});

test('gateway records inherit projects from post-tool hooks after an observer restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gateway-project-'));
  const store = openObservabilityStore(path.join(directory, 'observability.db'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const projectId = 'b'.repeat(64);
  store.ingest({
    source: 'hook',
    source_event_id: 'post-tool-project',
    source_schema: 'hook-v1',
    observed_at: '2026-07-20T08:00:00.000Z',
    event_name: 'hook.post_tool_use',
    project_id: projectId,
    session_id: 'session-with-project',
    attributes: { project_name: 'eigenwise-toolshed', tool_name: 'Bash', tool_kind: 'native', is_mcp: false },
  });

  const gatewayRecord = (id, sessionId) => ({
    source: 'codex_gateway',
    source_event_id: `gateway-project-${id}`,
    source_schema: 'gateway-usage-v1',
    observed_at: '2026-07-20T08:00:01.000Z',
    event_name: 'gateway.token.usage',
    session_id: sessionId,
    request_id: `request-project-${id}`,
    attributes: { model: 'claude-opus-4-8', backend: 'anthropic', agent_role: 'orchestrator' },
    measurements: [
      { name: 'context_tokens', value: 1000, unit: 'tokens', scope: 'request', quality: 'derived_exact' },
    ],
  });
  store.ingest(gatewayRecord('known', 'session-with-project'));
  store.ingest(gatewayRecord('unknown', 'session-without-hook'));

  const rows = store.database.prepare(
    "SELECT source_event_id, project_id, attributes_json FROM observation WHERE event_name = 'gateway.token.usage'",
  ).all();
  const byId = Object.fromEntries(rows.map((row) => [row.source_event_id, row]));
  assert.equal(byId['gateway-project-known'].project_id, projectId);
  assert.equal(JSON.parse(byId['gateway-project-known'].attributes_json).project_name, 'eigenwise-toolshed');
  assert.equal(byId['gateway-project-unknown'].project_id, null);
  assert.equal(JSON.parse(byId['gateway-project-unknown'].attributes_json).project_name, undefined);
});

test('store warms session projects from stored hook observations', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gateway-warm-project-'));
  const databaseFile = path.join(directory, 'observability.db');
  const projectId = 'c'.repeat(64);
  const first = openObservabilityStore(databaseFile, { outboxEnabled: false });
  first.ingest({
    source: 'hook',
    source_event_id: 'post-tool-warm-project',
    source_schema: 'hook-v1',
    observed_at: '2026-07-20T08:00:00.000Z',
    event_name: 'hook.post_tool_use',
    project_id: projectId,
    session_id: 'session-warm-project',
    attributes: { project_name: 'eigenwise-toolshed', tool_name: 'Bash', tool_kind: 'native', is_mcp: false },
  });
  first.close();

  const store = openObservabilityStore(databaseFile, { outboxEnabled: false });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  store.ingest({
    source: 'codex_gateway',
    source_event_id: 'gateway-warm-project',
    source_schema: 'gateway-usage-v1',
    observed_at: '2026-07-20T08:00:01.000Z',
    event_name: 'gateway.token.usage',
    session_id: 'session-warm-project',
    request_id: 'request-warm-project',
    attributes: { model: 'claude-opus-4-8', backend: 'anthropic', agent_role: 'orchestrator' },
    measurements: [{ name: 'context_tokens', value: 1000, unit: 'tokens', scope: 'request', quality: 'derived_exact' }],
  });

  const gateway = store.database.prepare("SELECT project_id, attributes_json FROM observation WHERE source_event_id = 'gateway-warm-project'").get();
  assert.equal(gateway.project_id, projectId);
  assert.equal(JSON.parse(gateway.attributes_json).project_name, 'eigenwise-toolshed');
});
