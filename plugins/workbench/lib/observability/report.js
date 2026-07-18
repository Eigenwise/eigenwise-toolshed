'use strict';

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
    status: row.status || null,
    evidence: { event: row.evidence_event, source: row.evidence_source, quality: 'exact' },
    tokens: {
      input: labeled(row.input_tokens, row.input_quality),
      output: labeled(row.output_tokens, row.output_quality),
      cache_read: labeled(row.cache_read_tokens, row.cache_read_quality),
      cache_creation: labeled(row.cache_creation_tokens, row.cache_creation_quality),
    },
    latency_ms: labeled(row.duration_ms, row.duration_quality),
    cost_usd: labeled(row.cost_usd, row.cost_quality || 'estimate'),
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

function buildTokenUsageReport(store) {
  if (!store || !store.database || typeof store.queryView !== 'function') throw new TypeError('A Workbench observability store is required.');
  return {
    generated_at: new Date().toISOString(),
    quality_labels: ['exact', 'derived', 'estimated', 'inferred', 'unavailable'],
    session_turn_ledger: requestLedger(store), context_timeline: contextTimeline(store),
    execution_tree: executionTree(store), tools: toolTable(store), route_comparison: routeComparison(store),
    ticket_usage: ticketUsage(store), coverage: coverage(store),
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
  lines.push('', `Context timeline (${report.context_timeline.length})`);
  for (const row of report.context_timeline) lines.push(`${row.observed_at} context ${textValue(row.context_tokens)} / window ${textValue(row.context_window_tokens)} | occupancy ${textValue(row.occupancy)} | growth ${textValue(row.growth_tokens)} | compaction pre ${textValue(row.compaction.pre_tokens)} post ${textValue(row.compaction.post_tokens)}`);
  lines.push('', `Execution tree (${report.execution_tree.length})`, `Tools (${report.tools.length})`, `Route comparison (${report.route_comparison.length})`, `Ticket usage (${report.ticket_usage.length})`);
  for (const row of report.ticket_usage) lines.push(`${row.ticket_ref || 'unattributed'}: ${textValue(row.request_count)} requests, cost ${textValue(row.estimated_cost_usd)} (${row.attribution})`);
  lines.push('', 'Data quality');
  for (const row of report.coverage.measurements_by_quality) lines.push(`${row.quality}: ${row.count}`);
  lines.push(`Explicitly unavailable: ${report.coverage.explicitly_unavailable.join('; ')}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { EXPLICITLY_UNAVAILABLE, QUALITY_LABELS, buildTokenUsageReport, formatTokenUsageReport, qualityLabel };
