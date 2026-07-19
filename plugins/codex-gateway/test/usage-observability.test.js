'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allocateLargestRemainder,
  buildOtlpLogPayload,
  createGatewayUsageEmitter,
  createUsageCapture,
  exactUsage,
  inputAttribution,
  inputComposition,
  mergeUsage,
  parseLimitHeaders,
  resolveUsageEndpoint,
  serializedBytes,
} = require('../lib/usage-observability.js');

function attributeMap(payload) {
  const attributes = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  return Object.fromEntries(attributes.map(({ key, value }) => {
    if (Object.hasOwn(value, 'stringValue')) return [key, value.stringValue];
    if (Object.hasOwn(value, 'intValue')) return [key, Number(value.intValue)];
    if (Object.hasOwn(value, 'boolValue')) return [key, value.boolValue];
    return [key, value.doubleValue];
  }));
}

const payload = {
  model: 'claude-codex-auto',
  system: [{ type: 'text', text: 'private system' }],
  tools: [
    { name: 'Read', description: 'private native schema' },
    { name: 'mcp__sidequest__claim', description: 'private MCP schema' },
  ],
  messages: [
    { role: 'user', content: 'private first message' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { private: true } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'private result' }] },
  ],
};

test('counts request composition without retaining content', () => {
  const composition = inputComposition(payload, 9876);
  assert.equal(composition.request_body_bytes, 9876);
  assert.equal(composition.input_system_bytes, serializedBytes(payload.system));
  assert.equal(composition.input_tools_bytes, serializedBytes(payload.tools));
  assert.equal(composition.input_native_tools_bytes, serializedBytes(payload.tools[0]));
  assert.equal(composition.input_mcp_tools_bytes, serializedBytes(payload.tools[1]));
  assert.equal(composition.input_messages_bytes, serializedBytes(payload.messages));
  assert.equal(composition.input_first_message_bytes, serializedBytes(payload.messages[0]));
  assert.equal(composition.input_history_bytes, serializedBytes(payload.messages[1]) + serializedBytes(payload.messages[2]));
  assert.equal(composition.input_tool_results_bytes, serializedBytes(payload.messages[2].content[0]));
  assert.equal(JSON.stringify(composition).includes('private'), false);
});

test('largest-remainder and source attribution preserve exact totals', () => {
  assert.deepEqual(allocateLargestRemainder(7, { a: 1, b: 1, c: 1 }), { a: 3, b: 2, c: 2 });
  const composition = inputComposition(payload);
  const attribution = inputAttribution(composition, {
    input_tokens: 100,
    output_tokens: 11,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 20,
  });
  assert.equal(attribution.context_tokens, 160);
  assert.equal(
    attribution.input_tools_tokens + attribution.input_system_tokens
      + attribution.input_first_message_tokens + attribution.input_history_tokens,
    160,
  );
  assert.equal(attribution.input_native_tools_tokens + attribution.input_mcp_tools_tokens, attribution.input_tools_tokens);
  assert.equal(
    attribution.cache_read_tools_tokens + attribution.cache_read_system_tokens
      + attribution.cache_read_first_message_tokens + attribution.cache_read_history_tokens,
    40,
  );
  assert.equal(
    attribution.fresh_tools_tokens + attribution.fresh_system_tokens
      + attribution.fresh_first_message_tokens + attribution.fresh_history_tokens,
    120,
  );
  const outputOnly = inputAttribution(composition, { output_tokens: 5 });
  assert.equal(outputOnly.context_tokens, null);
  assert.ok(outputOnly.input_history_tokens > 0);
});

test('extracts cache TTL, thinking, and server-tool details', () => {
  assert.deepEqual(exactUsage({
    input_tokens: 9,
    output_tokens: 7,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 4 },
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 1, code_execution_requests: 3 },
  }), {
    input_tokens: 9,
    output_tokens: 7,
    cache_read_tokens: 5,
    cache_creation_tokens: 3,
    cache_creation_5m_tokens: 1,
    cache_creation_1h_tokens: 2,
    thinking_tokens: 4,
    server_tool_use_count: 6,
    web_search_requests: 2,
    web_fetch_requests: 1,
    code_execution_requests: 3,
    tool_search_requests: null,
  });
  const zeroWrites = exactUsage({ cache_creation_input_tokens: 0 });
  assert.equal(zeroWrites.cache_creation_5m_tokens, 0);
  assert.equal(zeroWrites.cache_creation_1h_tokens, 0);
});

test('merges initial and final SSE usage with final values winning', () => {
  const merged = mergeUsage(
    { input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 10 } },
    { output_tokens: 20, input_tokens: 101, cache_creation: { ephemeral_1h_input_tokens: 4 } },
  );
  assert.deepEqual(merged, {
    input_tokens: 101,
    output_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 4 },
  });
});

test('parses only recognized numeric limit evidence', () => {
  const limits = parseLimitHeaders({
    'anthropic-ratelimit-input-tokens-limit': '100000',
    'anthropic-ratelimit-input-tokens-remaining': '25000',
    'anthropic-ratelimit-input-tokens-reset': '2026-07-19T20:00:00Z',
    'retry-after': '2.5',
    'x-codex-primary-used-percent': '72%',
    'x-codex-secondary-used-percent': '64',
    'x-private-header': 'private value',
  });
  assert.equal(limits.rate_limit_input_tokens_limit, 100000);
  assert.equal(limits.rate_limit_input_tokens_remaining, 25000);
  assert.equal(limits.rate_limit_input_tokens_reset_at_ms, Date.parse('2026-07-19T20:00:00Z'));
  assert.equal(limits.retry_after_ms, 2500);
  assert.equal(limits.codex_throttle_used_percent, 72);
  assert.equal(JSON.stringify(limits).includes('private'), false);
});

test('accepts loopback OTLP endpoints only', () => {
  assert.equal(resolveUsageEndpoint({ CODEX_GATEWAY_USAGE_ENDPOINT: 'http://127.0.0.1:1234/custom' }).toString(), 'http://127.0.0.1:1234/custom');
  assert.equal(resolveUsageEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/base/' }).toString(), 'http://127.0.0.1:4318/base/v1/logs');
  assert.equal(resolveUsageEndpoint({ CODEX_GATEWAY_USAGE_ENDPOINT: 'https://telemetry.example.com/v1/logs' }), null);
  assert.equal(resolveUsageEndpoint({ CODEX_GATEWAY_USAGE_ENDPOINT: 'http://127.999.999.999/v1/logs' }), null);
  assert.equal(resolveUsageEndpoint({ CODEX_GATEWAY_USAGE_ENDPOINT: '0' }), null);
  assert.equal(createGatewayUsageEmitter({ endpoint: 'https://telemetry.example.com/v1/logs' }).enabled, false);
});

test('JSON capture emits exact identities, resolved route, measurements, and no content', () => {
  let emitted;
  const capture = createUsageCapture({
    payload,
    requestBodyBytes: Buffer.byteLength(JSON.stringify(payload)),
    requestHeaders: {
      'x-claude-code-session-id': 'session-1',
      'x-claude-code-agent-id': 'agent-1',
      'x-claude-code-parent-agent-id': 'parent-1',
      'x-request-id': 'client-request-1',
      authorization: 'Bearer private-credential',
      'x-private-header': 'private-header-value',
    },
    route: {
      requestedModel: 'claude-codex-auto',
      effectiveModel: 'gpt-5.6-terra',
      backend: 'codex',
      effort: 'xhigh',
      via: 'dispatch',
    },
    sequence: 3,
    emit(record) { emitted = record; },
  });
  capture.setResponse(200, {
    'request-id': 'provider-request-1',
    'anthropic-ratelimit-input-tokens-remaining': '999',
  });
  capture.observeJson(Buffer.from(JSON.stringify({
    id: 'msg-private-id',
    model: 'virtual-wrong-model',
    content: [{ type: 'text', text: 'private response content' }],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  })));
  const record = capture.finish();
  assert.equal(record, emitted);
  assert.equal(record.eventName, 'gateway.token.usage');
  assert.equal(record.attributes.request_id, 'provider-request-1');
  assert.equal(record.attributes.session_id, 'session-1');
  assert.equal(record.attributes.agent_id, 'agent-1');
  assert.equal(record.attributes.parent_agent_id, 'parent-1');
  assert.equal(record.attributes.model, 'gpt-5.6-terra');
  assert.equal(record.attributes.requested_model, 'claude-codex-auto');
  assert.equal(record.attributes.context_tokens, 35);
  assert.equal(record.attributes.rate_limit_input_tokens_remaining, 999);
  assert.equal(record.attributes.request_sequence, 3);

  const otlp = buildOtlpLogPayload(record);
  const flat = attributeMap(otlp);
  assert.equal(flat.input_tokens, 10);
  assert.equal(flat.output_tokens, 4);
  assert.equal(flat.input_native_tools_tokens + flat.input_mcp_tools_tokens, flat.input_tools_tokens);
  const serialized = JSON.stringify(otlp);
  for (const forbidden of ['private system', 'private native schema', 'private MCP schema', 'private response content', 'private-credential', 'private-header-value', 'authorization', 'x-private-header']) {
    assert.equal(serialized.includes(forbidden), false, `usage telemetry leaked ${forbidden}`);
  }
});

test('SSE capture merges usage without retaining stream content', () => {
  let emitted;
  const capture = createUsageCapture({
    payload,
    requestHeaders: {},
    route: { requestedModel: 'claude-opus-4-8', effectiveModel: 'claude-opus-4-8', backend: 'anthropic', via: 'direct' },
    emit(record) { emitted = record; },
  });
  capture.setResponse(200, {});
  capture.noteResponseBytes(100);
  capture.observeEvent({
    type: 'message_start',
    message: { id: 'msg-1', model: 'claude-opus-4-8', usage: { input_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 0 } },
  });
  capture.observeEvent({ type: 'content_block_delta', delta: { text: 'private streamed content' } });
  capture.observeEvent({ type: 'message_delta', usage: { output_tokens: 9, thinking_tokens: 2 } });
  capture.finish();
  assert.equal(emitted.attributes.request_id, 'msg-1');
  assert.equal(emitted.attributes.response_mode, 'sse');
  assert.equal(emitted.attributes.input_tokens, 3);
  assert.equal(emitted.attributes.output_tokens, 9);
  assert.equal(emitted.attributes.thinking_tokens, 2);
  assert.equal(emitted.attributes.response_body_bytes, 100);
  assert.equal(JSON.stringify(emitted).includes('private streamed content'), false);
});

test('bounded JSON side buffers drop overflowed usage and failed responses emit limits only', () => {
  const emitted = [];
  const overflow = createUsageCapture({
    payload,
    maxResponseBytes: 1024,
    route: { backend: 'anthropic', effectiveModel: 'claude-opus-4-8' },
    emit(record) { emitted.push(record); },
  });
  overflow.setResponse(200, {});
  overflow.observeChunk(Buffer.alloc(800));
  overflow.observeChunk(Buffer.alloc(800));
  assert.equal(overflow.finish(), null);
  assert.equal(emitted.length, 0);

  const limited = createUsageCapture({
    payload,
    requestHeaders: { 'x-claude-code-session-id': 'session-limited' },
    route: { backend: 'codex', effectiveModel: 'gpt-5.6-sol', requestedModel: 'claude-codex-auto' },
    emit(record) { emitted.push(record); },
  });
  limited.setResponse(429, { 'retry-after': '3', 'x-codex-primary-used-percent': '99' });
  const record = limited.finish();
  assert.equal(record.eventName, 'gateway.limit.signal');
  assert.equal(record.attributes.retry_after_ms, 3000);
  assert.equal(record.attributes.codex_throttle_used_percent, 99);
  assert.equal(record.attributes.input_tokens, undefined);
  assert.equal(emitted.length, 1);
});

test('OTLP payload carries the event.name attribute the collector filter matches on', () => {
  let emitted;
  const capture = createUsageCapture({
    payload,
    requestBodyBytes: Buffer.byteLength(JSON.stringify(payload)),
    requestHeaders: { 'x-claude-code-session-id': 'session-filter-seam' },
    route: { backend: 'codex', effectiveModel: 'gpt-5.6-terra', requestedModel: 'claude-codex-auto' },
    emit(record) { emitted = record; },
  });
  capture.setResponse(200, {});
  capture.observeJson(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } }));
  capture.finish();

  const otlp = buildOtlpLogPayload(emitted);
  const attributes = attributeMap(otlp);
  assert.equal(attributes['event.name'], 'gateway.token.usage');
  assert.equal(attributes.event_name, 'gateway.token.usage');

  // Seam guard: this is the workbench collector's filter/signals allowlist
  // (REQUIRED_LOG_FILTER in plugins/workbench/bin/install-otel-collector.js).
  // If either side changes its key or pattern, this must fail.
  const filterRegex = /^(claude_code|agent_sdk|gateway)\.|^(mcp_server_connection|hook_execution_(start|complete))$/;
  assert.match(attributes['event.name'], filterRegex);
});
