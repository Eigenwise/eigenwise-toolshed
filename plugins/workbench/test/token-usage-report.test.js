'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildTokenUsageReport, formatTokenUsageReport } = require('../lib/observability/report.js');
const { defaultSidequestHome, readSidequestBoard } = require('../lib/observability/board-cost.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { parseArgs } = require('../bin/token-usage-report.js');
const { DatabaseSync } = require('node:sqlite');

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

function ingestGatewayUsage(store, id, agentId, contextTokens, outputTokens, costUsd) {
  ingest(store, {
    source: 'codex_gateway',
    source_event_id: `gateway-${id}`,
    observed_at: `2026-07-19T12:${String(id).padStart(2, '0')}:00.000Z`,
    event_name: 'gateway.token.usage',
    session_id: 'board-cost-session',
    request_id: `board-cost-request-${id}`,
    ...(agentId ? { agent_id: agentId } : {}),
    attributes: { model: 'gpt-fixture', backend: 'codex', effort: 'high', status: 'ok' },
    measurements: [
      { name: 'input_tokens', value: contextTokens, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: outputTokens, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_read_tokens', value: 0, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cache_creation_tokens', value: 0, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'context_tokens', value: contextTokens, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'cost_usd', value: costUsd, unit: 'usd', scope: 'request', quality: 'estimate' },
    ],
  });
}

function seedSidequestBoard(t) {
  const sidequestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-board-cost-'));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-board-project-'));
  t.after(() => {
    fs.rmSync(sidequestHome, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  const database = new DatabaseSync(path.join(sidequestHome, 'sidequest.db'));
  database.exec(`
    CREATE TABLE projects (slug TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project TEXT, ref TEXT, status TEXT, archived INTEGER, ord REAL, claim_by TEXT, data TEXT);
    CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE project_categories (project TEXT, id TEXT, kind TEXT, data TEXT, PRIMARY KEY (project, id));
  `);
  const slug = 'board-cost-fixture';
  database.prepare('INSERT INTO projects (slug, data) VALUES (?, ?)')
    .run(slug, JSON.stringify({ path: projectPath, name: 'Board cost fixture' }));
  database.prepare('INSERT INTO categories (id, data) VALUES (?, ?)').run('coding.hard', JSON.stringify({
    id: 'coding.hard',
    name: 'Hard coding',
    route: { model: 'gpt-primary', effort: 'xhigh' },
    fallback: { model: 'gpt-fallback', effort: 'xhigh' },
    enabled: true,
  }));
  const insertTicket = database.prepare(`
    INSERT INTO tickets (id, project, ref, status, archived, ord, claim_by, data)
    VALUES (?, ?, ?, ?, 0, ?, NULL, ?)
  `);
  insertTicket.run('ticket-1', slug, 'SQ-1', 'done', 1, JSON.stringify({
    id: 'ticket-1',
    ref: 'SQ-1',
    status: 'done',
    category: 'coding.hard',
    workedBy: { model: 'gpt-fallback', effort: 'xhigh' },
    reworkEvents: [{
      kind: 'released_to_todo',
      at: '2026-07-19T11:30:00.000Z',
      attempt: {
        agentId: 'agent-attempt-1',
        route: { model: 'gpt-primary', effort: 'xhigh' },
        preparedAt: '2026-07-19T11:00:00.000Z',
        terminalAt: '2026-07-19T11:30:00.000Z',
        outcome: 'released',
      },
    }],
    dispatch: {
      agentId: 'agent-attempt-2',
      route: { model: 'gpt-fallback', effort: 'xhigh' },
      preparedAt: '2026-07-19T11:31:00.000Z',
      terminalAt: '2026-07-19T12:30:00.000Z',
      outcome: 'done',
    },
  }));
  insertTicket.run('ticket-2', slug, 'SQ-2', 'done', 2, JSON.stringify({
    id: 'ticket-2',
    ref: 'SQ-2',
    status: 'done',
    category: 'coding.hard',
    workedBy: { model: 'gpt-primary', effort: 'xhigh' },
    dispatch: {
      agentId: 'agent-ticket-2',
      route: { model: 'gpt-primary', effort: 'xhigh' },
      preparedAt: '2026-07-19T11:45:00.000Z',
      terminalAt: '2026-07-19T12:20:00.000Z',
      outcome: 'done',
    },
  }));
  database.close();
  return {
    sidequestHome,
    projectPath,
    board: readSidequestBoard({ sidequestHome, projectPath }),
  };
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

test('joins the read-only Sidequest board to gateway usage by dispatch agent', (t) => {
  const store = temporaryStore(t);
  const fixture = seedSidequestBoard(t);
  assert.equal(fixture.board.available, true);
  assert.equal(fixture.board.source, undefined);

  ingestGatewayUsage(store, 1, 'agent-attempt-1', 100, 20, 0.2);
  ingestGatewayUsage(store, 2, 'agent-attempt-2', 200, 30, 0.4);
  ingestGatewayUsage(store, 3, 'agent-ticket-2', 50, 10, 0.1);
  ingestGatewayUsage(store, 4, null, 500, 50, 0.8);
  ingestGatewayUsage(store, 5, 'unmapped-agent', 40, 5, 0.05);

  const report = buildTokenUsageReport(store, { board: fixture.board });
  const board = report.board_costs;
  assert.equal(board.available, true);
  assert.equal(board.source.read_only, true);
  assert.equal(board.source.join_key, 'agent_id');

  const bounced = board.tickets.find((row) => row.ticket_ref === 'SQ-1');
  assert.equal(bounced.attempt_count.value, 2);
  assert.equal(bounced.bounce_count.value, 1);
  assert.equal(bounced.usage.request_count.value, 2);
  assert.equal(bounced.usage.tokens.total.value, 350);
  assert.ok(Math.abs(bounced.usage.estimated_cost_usd.value - 0.6) < 1e-9);
  assert.deepEqual(bounced.attempts.map((attempt) => attempt.usage.tokens.total.value), [120, 230]);

  const category = board.categories.find((row) => row.category === 'coding.hard');
  assert.equal(category.ticket_count.value, 2);
  assert.equal(category.attempt_count.value, 3);
  assert.equal(category.usage.tokens.total.value, 410);
  assert.equal(category.average_tokens_per_ticket.value, 205);
  assert.ok(Math.abs(category.average_estimated_cost_usd_per_ticket.value - 0.35) < 1e-9);

  const split = new Map(board.execution_split.map((row) => [row.role, row.usage]));
  assert.equal(split.get('board_executor').tokens.total.value, 410);
  assert.equal(split.get('orchestrator').tokens.total.value, 550);
  assert.equal(split.get('unmapped_agent').tokens.total.value, 45);

  assert.equal(board.rework.length, 1);
  assert.equal(board.rework[0].attempts.length, 2);
  const drift = board.route_drift.tickets.find((row) => row.ticket_ref === 'SQ-1');
  assert.equal(drift.configured_model, 'gpt-primary');
  assert.equal(drift.worked_model, 'gpt-fallback');
  assert.equal(drift.drifted, true);
  assert.equal(drift.usage.tokens.total.value, 350);
  assert.match(formatTokenUsageReport(report), /SQ-1 \[coding\.hard\]: 350 \(derived\) tokens/);
  assert.match(formatTokenUsageReport(report), /gpt-primary -> gpt-fallback/);
});

test('does not duplicate a batched agent across multiple tickets', (t) => {
  const store = temporaryStore(t);
  ingestGatewayUsage(store, 6, 'shared-batch-agent', 90, 10, 0.25);
  const board = {
    available: true,
    reason: null,
    sidequest_home: 'C:/fixture/sidequest',
    database_file: 'C:/fixture/sidequest/sidequest.db',
    project_path: 'C:/fixture/project',
    project_slug: 'fixture',
    categories: [{ id: 'coding.hard', route: { model: 'gpt-primary', effort: 'xhigh' } }],
    tickets: ['SQ-10', 'SQ-11'].map((ref) => ({
      ref,
      status: 'done',
      category: 'coding.hard',
      workedBy: { model: 'gpt-primary', effort: 'xhigh' },
      dispatch: {
        agentId: 'shared-batch-agent',
        route: { model: 'gpt-primary', effort: 'xhigh' },
        preparedAt: '2026-07-19T12:00:00.000Z',
        outcome: 'done',
      },
    })),
  };

  const costs = buildTokenUsageReport(store, { board }).board_costs;
  assert.deepEqual(costs.coverage.ambiguous_agent_ids, ['shared-batch-agent']);
  assert.equal(costs.execution_split.find((row) => row.role === 'board_executor').usage.tokens.total.value, 100);
  for (const ticket of costs.tickets) {
    assert.equal(ticket.attribution, 'unavailable');
    assert.equal(ticket.usage.tokens.total.value, null);
    assert.equal(ticket.attempts[0].attribution, 'ambiguous-shared-agent');
  }
});

test('uses SIDEQUEST_HOME and project overrides in report arguments', () => {
  const options = parseArgs(
    ['--sidequest-home', 'C:/fixture/sidequest', '--project', 'C:/fixture/project', '--format', 'json'],
    { SIDEQUEST_HOME: 'C:/ignored', CLAUDE_PROJECT_DIR: 'C:/ignored-project' },
    'C:/ignored-cwd',
  );
  assert.equal(options.sidequestHome, 'C:/fixture/sidequest');
  assert.equal(options.projectPath, 'C:/fixture/project');
  assert.equal(options.format, 'json');
  assert.equal(defaultSidequestHome({ SIDEQUEST_HOME: 'C:/configured' }, 'C:/home'), path.resolve('C:/configured'));
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
