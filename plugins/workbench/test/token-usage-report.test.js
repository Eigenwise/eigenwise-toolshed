'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildTokenUsageReport, formatTokenUsageReport } = require('../lib/observability/report.js');
const { openObservabilityStore } = require('../lib/observability/store.js');

const PROJECT_ID = 'a'.repeat(64);

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-token-report-'));
  const store = openObservabilityStore(path.join(directory, 'ledger.db'));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function ingest(store, input) {
  const result = store.ingest({ source_schema: '1', project_id: PROJECT_ID, ...input });
  assert.equal(result.accepted, true);
}

test('builds a quality-labeled report from resolved SQLite views', (t) => {
  const store = temporaryStore(t);
  ingest(store, {
    source: 'claude_code', source_event_id: 'request', observed_at: '2026-07-19T12:00:00.000Z',
    event_name: 'claude_code.api_request', session_id: 'session-1', prompt_id: 'prompt-1', request_id: 'request-1',
    agent_id: 'agent-1', ticket_ref: 'SQ-473',
    attributes: { model: 'claude-test', backend: 'claude', effort: 'high', status: 'ok' },
    measurements: [
      { name: 'input_tokens', value: 100, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 20, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_read_tokens', value: 30, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_creation_tokens', value: 5, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'duration_ms', value: 250, unit: 'ms', scope: 'request', quality: 'exact_client' },
      { name: 'cost_usd', value: 0.12, unit: 'usd', scope: 'request', quality: 'estimate' },
    ],
  });
  ingest(store, {
    source: 'statusline', source_event_id: 'context', observed_at: '2026-07-19T12:01:00.000Z',
    event_name: 'statusline.context_snapshot', session_id: 'session-1', prompt_id: 'prompt-1',
    attributes: { model: 'claude-test' },
    measurements: [
      { name: 'context_tokens', value: 5000, unit: 'tokens', scope: 'context_snapshot', quality: 'exact_client' },
      { name: 'context_window_tokens', value: 10000, unit: 'tokens', scope: 'context_snapshot', quality: 'exact_client' },
      { name: 'context_delta_tokens', value: 500, unit: 'tokens', scope: 'context_snapshot', quality: 'derived_exact' },
    ],
  });
  ingest(store, {
    source: 'hook', source_event_id: 'tool', observed_at: '2026-07-19T12:02:00.000Z',
    event_name: 'hook.post_tool_use', session_id: 'session-1', agent_id: 'agent-1', tool_use_id: 'tool-1',
    attributes: { tool_name: 'mcp__sidequest__list', tool_kind: 'mcp', is_mcp: true, mcp_server: 'sidequest', mcp_tool: 'list', status: 'ok' },
    measurements: [{ name: 'duration_ms', value: 42, unit: 'ms', scope: 'attempt', quality: 'exact_client' }],
  });
  ingest(store, {
    source: 'codex_gateway', source_event_id: 'route', observed_at: '2026-07-19T12:03:00.000Z',
    event_name: 'codex_gateway.route', session_id: 'session-1', request_id: 'request-1', route_id: 'route-1',
    attributes: { requested_model: 'terra', selected_model: 'gpt-test', effective_model: 'gpt-test', backend: 'codex', effort: 'high', fallback: false, via: 'gateway', status: 'ok', path_class: 'messages' },
  });

  const report = buildTokenUsageReport(store);
  assert.equal(report.session_turn_ledger[0].tokens.input.quality, 'exact');
  assert.equal(report.session_turn_ledger[0].cost_usd.quality, 'estimated');
  assert.equal(report.context_timeline[0].occupancy.value, 0.5);
  assert.equal(report.context_timeline[0].occupancy.quality, 'derived');
  assert.equal(report.tools[0].kind, 'mcp');
  assert.equal(report.tools[0].downstream_usage.quality, 'unavailable');
  assert.equal(report.route_comparison[0].backend.value, 'codex');
  assert.equal(report.ticket_usage[0].attribution, 'direct-only');
  assert.ok(report.coverage.explicitly_unavailable.includes('hidden MCP usage'));
  assert.match(formatTokenUsageReport(report), /cache creation 5 \(exact\)/);
});

test('keeps unavailable report values explicit', (t) => {
  const store = temporaryStore(t);
  ingest(store, {
    source: 'claude_code', source_event_id: 'partial', observed_at: '2026-07-19T12:00:00.000Z',
    event_name: 'claude_code.api_request', session_id: 'session-2', request_id: 'request-2',
    attributes: { model: 'claude-test' },
    measurements: [{ name: 'output_tokens', value: null, unit: 'tokens', scope: 'request', quality: 'unavailable' }],
  });
  const report = buildTokenUsageReport(store);
  assert.equal(report.session_turn_ledger[0].tokens.output.quality, 'unavailable');
  assert.equal(report.session_turn_ledger[0].cost_usd.value, null);
  assert.equal(report.session_turn_ledger[0].cost_usd.quality, 'unavailable');
});
