'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment } = require('./support.js');
isolateInProcessGatewayEnvironment(test);
const usage = require('../lib/usage-observability.js');
const { fixture, request, server, waitFor, picker, native, carrier, message } = require('./fixtures/antigravity.js');

test('AGY aggregate capture never attributes carrier bytes to tokens, cache sections, TTLs or tools', () => {
  const records = [];
  const capture = usage.createAggregateUsageCapture({ requestBodyBytes: 12345678,
    payload: { messages: [{ content: carrier() }], tools: [{ name: 'mcp__private__tool' }] },
    requestHeaders: { 'x-claude-code-session-id': 'not/a/session', 'x-claude-code-agent-id': 'fixture' },
    route: { backend: 'antigravity', requestedModel: picker(), effectiveModel: native(), via: 'direct' }, emit: (record) => records.push(record) });
  capture.setResponse(200, {});
  capture.noteResponseBytes(56789);
  capture.observeEvent({ type: 'message_start', message: message() });
  capture.observeEvent({ type: 'message_delta', usage: { output_tokens: 19, cache_creation_input_tokens: 4, reasoning_tokens: 5,
    fake_metric: 100, input_tokens: '999', server_tool_use: { tool_search_requests: 42 } } });
  const record = capture.finish();
  assert.equal(records.length, 1);
  assert.equal(record.eventName, 'gateway.token.usage');
  assert.equal(record.attributes.model, native());
  assert.equal(record.attributes.requested_model, picker());
  assert.equal(record.attributes.input_tokens, 7);
  assert.equal(record.attributes.output_tokens, 19, 'reasoning is already included, never added again');
  assert.equal(record.attributes.thinking_tokens, 5);
  assert.equal(record.attributes.request_body_bytes, 12345678);
  assert.equal(record.attributes.response_body_bytes, 56789);
  assert.equal(record.attributes.session_id, null, 'model slash support must not relax session identifiers');
  for (const key of ['token_estimator', 'cache_attribution', 'input_tools_tokens', 'input_tool_results_tokens', 'cache_read_history_tokens',
    'cache_creation_5m_tokens', 'cache_creation_1h_tokens', 'server_tool_use_count', 'fake_metric']) assert.equal(record.attributes[key], undefined);
  assert.equal(JSON.stringify(record).includes('ccp:antigravity:v1:'), false);
  assert.equal(capture.finish(), null);
});

test('aggregate usage retains safe request and project correlation without changing consent switches', () => {
  const capture = usage.createAggregateUsageCapture({ requestBodyBytes: 1,
    requestHeaders: { 'x-claude-code-session-id': 'fixture-session' }, resolveProjectId: () => 'fixture-repo',
    route: { requestedModel: picker(), effectiveModel: native() } });
  capture.setResponse(200, { 'request-id': 'safe-upstream-id' });
  capture.observeEvent({ type: 'message_start', message: message() });
  const record = capture.finish();
  assert.equal(record.attributes.project_name, 'fixture-repo');
  assert.equal(record.attributes.request_id, 'safe-upstream-id');
  assert.equal(record.attributes.request_id_source, 'response_header');
  assert.equal(usage.createAggregateUsageEmitter({ environment: { CODEX_GATEWAY_USAGE_ENDPOINT: '0' } }).enabled, false);
});

test('active AGY telemetry uses existing consent and event names, exact wire bytes and canonical slash model', async (t) => {
  const logs = [];
  const spans = [];
  const collector = await server(t, (req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks));
      (req.url === '/v1/traces' ? spans : logs).push(payload); res.end();
    });
  });
  const gateway = await fixture(t, { environment: { CODEX_GATEWAY_USAGE_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    CODEX_GATEWAY_TELEMETRY_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/traces`, CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1' } });
  const response = await request(gateway.port, { model: picker(), messages: [{ role: 'user', content: carrier() }] }, { 'x-claude-code-session-id': 'aggregate-session' });
  assert.equal(response.status, 200);
  await waitFor(() => logs.length && spans.length);
  const logRecords = logs.flatMap((payload) => payload.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)));
  assert.equal(logRecords.length, 1);
  const attributes = Object.fromEntries(logRecords[0].attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
  assert.equal(attributes.backend, 'antigravity');
  assert.equal(attributes.model, native());
  assert.equal(attributes.request_body_bytes, Buffer.byteLength(gateway.state.attempts[0].wire));
  assert.equal(attributes.response_body_bytes, Buffer.byteLength(JSON.stringify(message())));
  assert.equal(attributes.output_tokens, 11);
  assert.equal(attributes.token_estimator, undefined);
  const route = spans[0].resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(route.attributes.find(({ key }) => key === 'backend').value.stringValue, 'antigravity');
  assert.equal(route.attributes.find(({ key }) => key === 'effective_model').value.stringValue, native());
  assert.equal(JSON.stringify(logs).includes(carrier()), false);
});
