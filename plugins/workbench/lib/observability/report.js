'use strict';

const { buildBoardCostReport } = require('./board-cost.js');

const QUALITY_LABELS = Object.freeze({
  exact_provider: 'exact',
  exact_client: 'exact',
  derived_exact: 'derived',
  estimate: 'estimated',
  inferred: 'inferred',
  unavailable: 'unavailable',
});

const EXPLICITLY_UNAVAILABLE = Object.freeze([
  'subscription dollars',
  'provider invoice',
  'cache decision internals',
  'exact per-section cache attribution',
  'output source attribution',
  'fast-mode and WebFetch domain-safety gateway usage',
  'hidden MCP usage',
  'per-file causal allocation',
]);

function qualityLabel(quality, value) {
  if (value === null || value === undefined) return 'unavailable';
  return QUALITY_LABELS[quality] || 'unavailable';
}

function labeled(value, quality) {
  return { value: value ?? null, quality: qualityLabel(quality, value) };
}

function rows(store, statement) {
  return store.database.prepare(statement).all();
}

function requestLedger(store) {
  return store.queryView('request_usage_resolved').map((row) => ({
    session_id: row.session_id,
    prompt_id: row.prompt_id,
    request_id: row.request_id,
    observed_at: row.observed_at,
    model: row.model || null,
    backend: row.backend || row.provider || null,
    effort: row.effort || null,
    agent_id: row.agent_id || null,
    parent_agent_id: row.parent_agent_id || null,
    agent_role: row.agent_role || null,
    status: row.status || null,
    evidence: { event: row.evidence_event, source: row.evidence_source, quality: 'exact' },
    tokens: {
      input: labeled(row.input_tokens, row.input_quality),
      output: labeled(row.output_tokens, row.output_quality),
      cache_read: labeled(row.cache_read_tokens, row.cache_read_quality),
      cache_creation: labeled(row.cache_creation_tokens, row.cache_creation_quality),
      context_total: labeled(row.context_tokens, row.context_quality),
      thinking: labeled(row.thinking_tokens, row.thinking_quality),
    },
    bytes: {
      request: labeled(row.request_body_bytes, row.request_body_quality),
      response: labeled(row.response_body_bytes, row.response_body_quality),
    },
    latency_ms: labeled(row.duration_ms, row.duration_quality),
    cost_usd: labeled(row.cost_usd, row.cost_quality || 'estimate'),
  }));
}

function sessionUsage(store) {
  return store.queryView('session_rollup').map((row) => ({
    session_id: row.session_id,
    request_count: labeled(row.request_count, 'derived_exact'),
    input_tokens: labeled(row.input_tokens, 'derived_exact'),
    output_tokens: labeled(row.output_tokens, 'derived_exact'),
    total_context_tokens: labeled(row.total_context_tokens, 'derived_exact'),
    cache_read_tokens: labeled(row.cache_read_tokens, 'derived_exact'),
    cache_creation_tokens: labeled(row.cache_creation_tokens, 'derived_exact'),
    cache_read_ratio: labeled(row.cache_read_ratio, 'derived_exact'),
    first_request_at: row.first_request_at || null,
    last_request_at: row.last_request_at || null,
  }));
}

function agentUsage(store) {
  return store.queryView('agent_usage_rollup').map((row) => ({
    session_id: row.session_id,
    agent_role: row.agent_role,
    agent_id: row.agent_id || null,
    parent_agent_id: row.parent_agent_id || null,
    request_count: labeled(row.request_count, 'derived_exact'),
    input_tokens: labeled(row.input_tokens, 'derived_exact'),
    output_tokens: labeled(row.output_tokens, 'derived_exact'),
    total_context_tokens: labeled(row.total_context_tokens, 'derived_exact'),
    cache_read_tokens: labeled(row.cache_read_tokens, 'derived_exact'),
    cache_creation_tokens: labeled(row.cache_creation_tokens, 'derived_exact'),
  }));
}

function inputComposition(store) {
  return store.queryView('input_composition').map((row) => ({
    session_id: row.session_id,
    request_id: row.request_id,
    agent_id: row.agent_id || null,
    observed_at: row.observed_at,
    model: row.model || null,
    bytes: {
      request: labeled(row.request_body_bytes, 'exact_client'),
      system: labeled(row.system_bytes, 'exact_client'),
      tools: labeled(row.tools_bytes, 'exact_client'),
      native_tools: labeled(row.native_tools_bytes, 'exact_client'),
      mcp_tools: labeled(row.mcp_tools_bytes, 'exact_client'),
      messages: labeled(row.messages_bytes, 'exact_client'),
      first_message: labeled(row.first_message_bytes, 'exact_client'),
      history: labeled(row.history_bytes, 'exact_client'),
      tool_results: labeled(row.tool_result_bytes, 'exact_client'),
    },
    estimated_tokens: {
      system: labeled(row.system_tokens, 'estimate'),
      tools: labeled(row.tools_tokens, 'estimate'),
      native_tools: labeled(row.native_tools_tokens, 'estimate'),
      mcp_tools: labeled(row.mcp_tools_tokens, 'estimate'),
      first_message: labeled(row.first_message_tokens, 'estimate'),
      history: labeled(row.history_tokens, 'estimate'),
      tool_results: labeled(row.tool_result_tokens, 'estimate'),
    },
  }));
}

function cacheEconomics(store) {
  return store.queryView('cache_economics').map((row) => ({
    session_id: row.session_id,
    request_id: row.request_id,
    observed_at: row.observed_at,
    model: row.model || null,
    cache_read_tokens: labeled(row.cache_read_tokens, 'exact_provider'),
    cache_creation_tokens: labeled(row.cache_creation_tokens, 'exact_provider'),
    read_savings_base_input_tokens: labeled(row.read_savings_base_input_tokens, 'derived_exact'),
    write_surcharge_base_input_tokens: labeled(row.write_surcharge_base_input_tokens, 'derived_exact'),
    net_savings_base_input_tokens: labeled(row.net_savings_base_input_tokens, 'derived_exact'),
    net_savings_usd: labeled(row.net_savings_usd, row.net_savings_usd === null ? 'unavailable' : 'derived_exact'),
  }));
}

function limitSignals(store) {
  return store.queryView('limit_signals').map((row) => ({
    session_id: row.session_id,
    request_id: row.request_id,
    observed_at: row.observed_at,
    model: row.model || null,
    backend: row.backend || null,
    status: row.status || null,
    status_code: row.status_code,
    requests: {
      limit: labeled(row.requests_limit, 'exact_provider'),
      remaining: labeled(row.requests_remaining, 'exact_provider'),
      reset_at_ms: labeled(row.requests_reset_at_ms, 'exact_provider'),
    },
    input_tokens: {
      limit: labeled(row.input_tokens_limit, 'exact_provider'),
      remaining: labeled(row.input_tokens_remaining, 'exact_provider'),
      reset_at_ms: labeled(row.input_tokens_reset_at_ms, 'exact_provider'),
    },
    output_tokens: {
      limit: labeled(row.output_tokens_limit, 'exact_provider'),
      remaining: labeled(row.output_tokens_remaining, 'exact_provider'),
      reset_at_ms: labeled(row.output_tokens_reset_at_ms, 'exact_provider'),
    },
    combined_tokens: {
      limit: labeled(row.tokens_limit, 'exact_provider'),
      remaining: labeled(row.tokens_remaining, 'exact_provider'),
      reset_at_ms: labeled(row.tokens_reset_at_ms, 'exact_provider'),
    },
    retry_after_ms: labeled(row.retry_after_ms, 'exact_provider'),
    codex_throttle_used_percent: labeled(row.codex_throttle_used_percent, 'exact_provider'),
  }));
}

function contextTimeline(store) {
  return store.queryView('context_timeline').map((row) => {
    const occupancy = row.context_tokens !== null && row.context_window_tokens !== null && row.context_window_tokens > 0
      ? row.context_tokens / row.context_window_tokens
      : null;
    return {
      session_id: row.session_id,
      prompt_id: row.prompt_id,
      observed_at: row.observed_at,
      model: row.model || null,
      context_tokens: labeled(row.context_tokens, row.context_quality),
      context_window_tokens: labeled(row.context_window_tokens, row.context_quality),
      occupancy: labeled(occupancy, occupancy === null ? 'unavailable' : 'derived_exact'),
      growth_tokens: labeled(row.context_delta_tokens, row.delta_quality),
      compaction: {
        pre_tokens: labeled(row.pre_tokens, row.compaction_quality),
        post_tokens: labeled(row.post_tokens, row.compaction_quality),
      },
    };
  });
}

function executionTree(store) {
  const agents = store.queryView('agent_tree').map((row) => ({
    kind: 'agent', id: row.agent_id, parent_id: row.parent_agent_id || null,
    workflow_run_id: row.workflow_run_id || null, session_id: row.session_id,
    model: row.model || null, effort: row.effort || null, status: row.status || null,
    started_at: row.started_at || null, stopped_at: row.stopped_at || null, quality: 'exact',
  }));
  const requests = store.queryView('request_usage_resolved').map((row) => ({
    kind: 'request', id: row.request_id, parent_id: row.agent_id || row.session_id || null,
    workflow_run_id: row.workflow_run_id || null, session_id: row.session_id,
    model: row.model || null, backend: row.backend || row.provider || null, effort: row.effort || null,
    evidence_event: row.evidence_event, quality: 'exact',
  }));
  const tools = store.queryView('tool_calls').map((row) => ({
    kind: 'tool', id: row.tool_use_id, parent_id: row.agent_id || row.request_id || row.session_id || null,
    session_id: row.session_id, request_id: row.request_id || null, name: row.tool_name || null,
    tool_kind: row.tool_kind || null, mcp_server: row.mcp_server || null, mcp_tool: row.mcp_tool || null,
    quality: 'exact',
  }));
  return [...agents, ...requests, ...tools];
}

function toolTable(store) {
  const qualities = new Map(rows(store, `
    SELECT o.tool_use_id, m.name, m.quality
    FROM observation o JOIN measurement m ON m.event_id = o.event_id
    WHERE o.tool_use_id IS NOT NULL AND m.name IN ('duration_ms', 'blocked_ms', 'bytes_in', 'bytes_out')
  `).map((row) => [`${row.tool_use_id}:${row.name}`, row.quality]));
  return store.queryView('tool_calls').map((row) => ({
    kind: row.is_mcp ? 'mcp' : 'native', tool_name: row.tool_name || null,
    mcp_server: row.mcp_server || null, mcp_tool: row.mcp_tool || null, status: row.status || null,
    started_at: row.started_at || null, completed_at: row.completed_at || null,
    duration_ms: labeled(row.duration_ms, qualities.get(`${row.tool_use_id}:duration_ms`)),
    blocked_ms: labeled(row.blocked_ms, qualities.get(`${row.tool_use_id}:blocked_ms`)),
    bytes_in: labeled(row.bytes_in, qualities.get(`${row.tool_use_id}:bytes_in`)),
    bytes_out: labeled(row.bytes_out, qualities.get(`${row.tool_use_id}:bytes_out`)),
    downstream_usage: { value: null, quality: 'unavailable' },
  }));
}

function ticketUsage(store) {
  return store.queryView('ticket_rollup').map((row) => ({
    ticket_ref: row.ticket_ref || null,
    attribution: row.ticket_ref ? 'direct-only' : 'unattributed',
    request_count: labeled(row.request_count, 'derived_exact'),
    tokens: {
      input: labeled(row.input_tokens, 'derived_exact'),
      output: labeled(row.output_tokens, 'derived_exact'),
      cache_read: labeled(row.cache_read_tokens, 'derived_exact'),
      cache_creation: labeled(row.cache_creation_tokens, 'derived_exact'),
    },
    estimated_cost_usd: labeled(row.estimated_cost_usd, 'estimate'),
    first_request_at: row.first_request_at || null, last_request_at: row.last_request_at || null,
  }));
}

function routeComparison(store) {
  return store.queryView('route_comparison').map((row) => ({
    request_id: row.request_id || null, route_id: row.route_id || null, observed_at: row.observed_at,
    requested_model: labeled(row.requested_model, 'exact_client'),
    selected_model: labeled(row.selected_model, 'exact_client'),
    effective_model: labeled(row.effective_model, 'exact_client'),
    backend: labeled(row.backend, 'exact_client'), effort: labeled(row.effort, 'exact_client'),
    fallback: labeled(row.fallback, 'exact_client'), via: labeled(row.via, 'exact_client'),
    status: labeled(row.status, 'exact_client'), path_class: labeled(row.path_class, 'exact_client'),
    join_quality: row.request_id || row.trace_id ? 'exact' : 'unavailable',
  }));
}

function coverage(store) {
  const qualityCounts = rows(store, `
    SELECT quality, COUNT(*) AS count FROM measurement GROUP BY quality ORDER BY quality
  `).map((row) => ({ quality: QUALITY_LABELS[row.quality] || 'unavailable', count: row.count }));
  return {
    measurements_by_quality: qualityCounts,
    gaps: store.queryView('coverage_gaps').map((row) => ({
      kind: row.gap_kind, source: row.source, observed_at: row.observed_at,
      fields: JSON.parse(row.field_names_json || '[]'),
      quality: row.gap_kind === 'unavailable' ? 'unavailable' : 'inferred',
    })),
    outbox: store.queryView('outbox_health')[0] || {},
    explicitly_unavailable: [...EXPLICITLY_UNAVAILABLE],
  };
}

function buildTokenUsageReport(store, options = {}) {
  if (!store || !store.database || typeof store.queryView !== 'function') throw new TypeError('A Workbench observability store is required.');
  return {
    generated_at: new Date().toISOString(),
    quality_labels: ['exact', 'derived', 'estimated', 'inferred', 'unavailable'],
    session_turn_ledger: requestLedger(store),
    session_usage: sessionUsage(store),
    agent_usage: agentUsage(store),
    input_composition: inputComposition(store),
    context_timeline: contextTimeline(store),
    cache_economics: cacheEconomics(store),
    limit_signals: limitSignals(store),
    execution_tree: executionTree(store), tools: toolTable(store), route_comparison: routeComparison(store),
    ticket_usage: ticketUsage(store), board_costs: buildBoardCostReport(store, options.board), coverage: coverage(store),
  };
}

function textValue(entry) {
  return `${entry.value === null ? 'unavailable' : entry.value} (${entry.quality})`;
}

function formatTokenUsageReport(report) {
  const lines = ['Workbench token usage report', `Generated: ${report.generated_at}`, '', `Session / turn ledger (${report.session_turn_ledger.length})`];
  for (const row of report.session_turn_ledger) {
    lines.push(`${row.observed_at} ${row.request_id || 'unlinked request'} ${row.model || 'model unavailable'} ${row.backend || 'backend unavailable'} ${row.effort || 'effort unavailable'}`);
    lines.push(`  input ${textValue(row.tokens.input)} | output ${textValue(row.tokens.output)} | cache read ${textValue(row.tokens.cache_read)} | cache creation ${textValue(row.tokens.cache_creation)} | latency ${textValue(row.latency_ms)} | cost ${textValue(row.cost_usd)}`);
    lines.push(`  evidence: ${row.evidence.source}/${row.evidence.event} (${row.evidence.quality})`);
  }
  lines.push('', `Session usage (${report.session_usage.length})`, `Agent usage (${report.agent_usage.length})`, `Input composition (${report.input_composition.length})`);
  lines.push(`Cache economics (${report.cache_economics.length})`, `Limit signals (${report.limit_signals.length})`);
  lines.push('', `Context timeline (${report.context_timeline.length})`);
  for (const row of report.context_timeline) lines.push(`${row.observed_at} context ${textValue(row.context_tokens)} / window ${textValue(row.context_window_tokens)} | occupancy ${textValue(row.occupancy)} | growth ${textValue(row.growth_tokens)} | compaction pre ${textValue(row.compaction.pre_tokens)} post ${textValue(row.compaction.post_tokens)}`);
  lines.push('', `Execution tree (${report.execution_tree.length})`, `Tools (${report.tools.length})`, `Route comparison (${report.route_comparison.length})`, `Ticket usage (${report.ticket_usage.length})`);
  for (const row of report.ticket_usage) lines.push(`${row.ticket_ref || 'unattributed'}: ${textValue(row.request_count)} requests, cost ${textValue(row.estimated_cost_usd)} (${row.attribution})`);
  const board = report.board_costs;
  if (board.available) {
    lines.push('', `Board cost attribution (${board.tickets.length} tickets)`);
    for (const row of board.tickets) {
      lines.push(`${row.ticket_ref} [${row.category || 'uncategorized'}]: ${textValue(row.usage.tokens.total)} tokens, ${textValue(row.usage.estimated_cost_usd)} cost, ${textValue(row.attempt_count)} attempts (${row.attribution})`);
    }
    lines.push('', `Category cost (${board.categories.length})`);
    for (const row of board.categories) {
      lines.push(`${row.category}: ${textValue(row.usage.tokens.total)} tokens total, ${textValue(row.average_tokens_per_ticket)} average per ticket, ${textValue(row.average_estimated_cost_usd_per_ticket)} average cost`);
    }
    lines.push('', 'Orchestrator / executor split');
    for (const row of board.execution_split) lines.push(`${row.role}: ${textValue(row.usage.tokens.total)} tokens, ${textValue(row.usage.estimated_cost_usd)} cost`);
    lines.push('', `Bounce / rework (${board.rework.length})`);
    for (const row of board.rework) lines.push(`${row.ticket_ref}: ${textValue(row.bounce_count)} bounces, ${textValue(row.attempt_count)} attempts, ${textValue(row.usage.tokens.total)} tokens, ${textValue(row.usage.estimated_cost_usd)} cost`);
    lines.push('', `Route drift (${board.route_drift.rollups.length})`);
    for (const row of board.route_drift.rollups) lines.push(`${row.configured_model} -> ${row.worked_model}: ${textValue(row.ticket_count)} tickets, ${textValue(row.usage.tokens.total)} tokens, ${textValue(row.usage.estimated_cost_usd)} cost`);
  } else {
    lines.push('', `Board cost attribution unavailable: ${board.reason}`);
  }
  lines.push('', 'Data quality');
  for (const row of report.coverage.measurements_by_quality) lines.push(`${row.quality}: ${row.count}`);
  lines.push(`Explicitly unavailable: ${report.coverage.explicitly_unavailable.join('; ')}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { EXPLICITLY_UNAVAILABLE, QUALITY_LABELS, buildTokenUsageReport, formatTokenUsageReport, qualityLabel };
