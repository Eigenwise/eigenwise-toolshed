'use strict';

const SCHEMA_VERSION = 1;

const MEASUREMENT_QUALITIES = Object.freeze([
  'exact_provider',
  'exact_client',
  'derived_exact',
  'estimate',
  'inferred',
  'unavailable',
]);

const MEASUREMENT_SCOPES = Object.freeze([
  'attempt',
  'request',
  'context_snapshot',
  'run',
  'session',
  'aggregate',
]);

const LINK_METHODS = Object.freeze([
  'direct_id',
  'trace_parent',
  'composite_id',
  'application_supplied',
  'temporal_inference',
  'unlinked',
]);

const LINK_QUALITIES = Object.freeze([
  'exact_provider',
  'exact_client',
  'derived_exact',
  'estimate',
  'inferred',
  'unavailable',
  'exact',
]);

const RESOLVED_VIEWS = Object.freeze([
  'request_usage_resolved',
  'session_rollup',
  'context_timeline',
  'agent_tree',
  'tool_calls',
  'ticket_rollup',
  'route_comparison',
  'coverage_gaps',
  'outbox_health',
]);

const ALLOWED_SOURCES = Object.freeze([
  'claude_code',
  'agent_sdk',
  'hook',
  'statusline',
  'sidequest',
  'codex_gateway',
  'otel_collector',
  'workbench',
]);

const ALLOWED_EVENTS = Object.freeze([
  'claude_code.api_request',
  'claude_code.api_error',
  'claude_code.llm_request',
  'claude_code.tool_result',
  'claude_code.tool_decision',
  'agent_sdk.assistant_usage',
  'agent_sdk.terminal_result',
  'otel.metric',
  'hook.session_start',
  'hook.session_end',
  'hook.user_prompt_submit',
  'hook.pre_tool_use',
  'hook.post_tool_use',
  'hook.stop',
  'hook.subagent_start',
  'hook.subagent_stop',
  'hook.task_completed',
  'statusline.context_snapshot',
  'statusline.rate_limit',
  'context.compaction',
  'tool.call',
  'sidequest.ticket',
  'codex_gateway.route',
  'coverage_gap',
  'telemetry_conflict',
  'schema_drop',
]);

const ALLOWED_MEASUREMENTS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'context_tokens',
  'context_window_tokens',
  'context_delta_tokens',
  'pre_tokens',
  'post_tokens',
  'result_tokens',
  'duration_ms',
  'blocked_ms',
  'api_duration_ms',
  'cost_usd',
  'bytes_in',
  'bytes_out',
  'request_body_bytes',
  'request_count',
  'tool_count',
  'rate_limit_percent',
  'rate_limit_reset_ms',
  'dropped_records',
  'queue_depth',
  'queue_capacity',
]);

const ALLOWED_UNITS = Object.freeze([
  'tokens',
  'ms',
  'usd',
  'bytes',
  'count',
  'percent',
  'none',
]);

const LINK_RELATIONS = Object.freeze([
  'parent_of',
  'child_of',
  'belongs_to',
  'attributed_to',
  'routes_via',
  'correlates_with',
  'conflicts_with',
]);

const LINK_TARGET_KINDS = Object.freeze([
  'event',
  'project',
  'session',
  'prompt',
  'request',
  'trace',
  'workflow',
  'agent',
  'tool',
  'task',
  'ticket',
  'route',
]);

const ATTRIBUTE_SPECS = Object.freeze({
  agent_type: 'identifier',
  backend: 'identifier',
  category: 'identifier',
  claim_session_id: 'identifier',
  claim_worker_id: 'identifier',
  configured_backend: 'identifier',
  configured_effort: 'effort',
  configured_model: 'identifier',
  decision: 'decision',
  dispatch_id: 'identifier',
  effective_model: 'identifier',
  effort: 'effort',
  end_reason: 'identifier',
  error_code: 'identifier',
  error_type: 'identifier',
  executor: 'identifier',
  fallback: 'boolean',
  field_names: 'field_names',
  is_mcp: 'boolean',
  mcp_server: 'identifier',
  mcp_tool: 'identifier',
  model: 'identifier',
  outcome: 'status',
  path_class: 'identifier',
  permission_mode: 'identifier',
  provider: 'identifier',
  requested_model: 'identifier',
  resolved_backend: 'identifier',
  resolved_effort: 'effort',
  resolved_model: 'identifier',
  retry_count: 'nonnegative_integer',
  selected_model: 'identifier',
  source: 'identifier',
  status: 'status',
  stop_reason: 'identifier',
  task_status: 'status',
  tool_kind: 'identifier',
  tool_name: 'identifier',
  turns: 'nonnegative_integer',
  via: 'identifier',
});

const COMMON_ROUTING_ATTRIBUTES = Object.freeze([
  'model', 'provider', 'backend', 'effort', 'status', 'outcome', 'stop_reason',
  'error_type', 'error_code', 'retry_count',
]);

const EVENT_ATTRIBUTES = Object.freeze({
  'claude_code.api_request': COMMON_ROUTING_ATTRIBUTES,
  'claude_code.api_error': COMMON_ROUTING_ATTRIBUTES,
  'claude_code.llm_request': COMMON_ROUTING_ATTRIBUTES,
  'claude_code.tool_result': ['tool_name', 'tool_kind', 'is_mcp', 'mcp_server', 'mcp_tool', 'status', 'error_type', 'error_code'],
  'claude_code.tool_decision': ['tool_name', 'tool_kind', 'is_mcp', 'mcp_server', 'mcp_tool', 'decision'],
  'agent_sdk.assistant_usage': COMMON_ROUTING_ATTRIBUTES,
  'agent_sdk.terminal_result': [...COMMON_ROUTING_ATTRIBUTES, 'turns'],
  'otel.metric': ['model', 'provider', 'backend', 'status'],
  'hook.session_start': ['source', 'permission_mode', 'effort'],
  'hook.session_end': ['end_reason', 'permission_mode', 'effort'],
  'hook.user_prompt_submit': ['permission_mode', 'effort'],
  'hook.pre_tool_use': ['tool_name', 'tool_kind', 'is_mcp', 'mcp_server', 'mcp_tool', 'permission_mode'],
  'hook.post_tool_use': ['tool_name', 'tool_kind', 'is_mcp', 'mcp_server', 'mcp_tool', 'status', 'error_type', 'error_code'],
  'hook.stop': ['end_reason', 'permission_mode', 'effort'],
  'hook.subagent_start': ['agent_type', 'model', 'effort'],
  'hook.subagent_stop': ['agent_type', 'model', 'effort', 'end_reason', 'status'],
  'hook.task_completed': ['task_status'],
  'statusline.context_snapshot': ['model', 'effort'],
  'statusline.rate_limit': ['model'],
  'context.compaction': ['model'],
  'tool.call': ['tool_name', 'tool_kind', 'is_mcp', 'mcp_server', 'mcp_tool', 'status', 'decision', 'error_type', 'error_code'],
  'sidequest.ticket': [
    'category', 'configured_model', 'configured_effort', 'configured_backend',
    'resolved_model', 'resolved_effort', 'resolved_backend', 'executor',
    'dispatch_id', 'claim_worker_id', 'claim_session_id', 'task_status',
  ],
  'codex_gateway.route': [
    'requested_model', 'selected_model', 'effective_model', 'backend', 'effort',
    'fallback', 'via', 'status', 'path_class', 'error_type', 'error_code',
  ],
  coverage_gap: ['status', 'error_type', 'error_code'],
  telemetry_conflict: ['field_names'],
  schema_drop: ['field_names'],
});

const TABLE_SQL = `
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS observability_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS observation (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_schema TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    emitted_at TEXT,
    event_name TEXT NOT NULL,
    sequence INTEGER,
    project_id TEXT,
    session_id TEXT,
    prompt_id TEXT,
    request_id TEXT,
    client_request_id TEXT,
    trace_id TEXT,
    span_id TEXT,
    parent_span_id TEXT,
    workflow_run_id TEXT,
    agent_id TEXT,
    parent_agent_id TEXT,
    tool_use_id TEXT,
    task_id TEXT,
    ticket_ref TEXT,
    route_id TEXT,
    attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
    UNIQUE(source, source_event_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS observation_observed_at_idx ON observation(observed_at);
  CREATE INDEX IF NOT EXISTS observation_session_idx ON observation(session_id, observed_at);
  CREATE INDEX IF NOT EXISTS observation_request_idx ON observation(request_id, observed_at);
  CREATE INDEX IF NOT EXISTS observation_trace_idx ON observation(trace_id, span_id);
  CREATE INDEX IF NOT EXISTS observation_agent_idx ON observation(agent_id, parent_agent_id);
  CREATE INDEX IF NOT EXISTS observation_tool_idx ON observation(tool_use_id);
  CREATE INDEX IF NOT EXISTS observation_ticket_idx ON observation(ticket_ref);
  CREATE INDEX IF NOT EXISTS observation_route_idx ON observation(route_id);

  CREATE TABLE IF NOT EXISTS measurement (
    event_id TEXT NOT NULL REFERENCES observation(event_id),
    name TEXT NOT NULL,
    value REAL,
    unit TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('attempt', 'request', 'context_snapshot', 'run', 'session', 'aggregate')),
    quality TEXT NOT NULL CHECK (quality IN ('exact_provider', 'exact_client', 'derived_exact', 'estimate', 'inferred', 'unavailable')),
    PRIMARY KEY(event_id, name, scope),
    CHECK ((quality = 'unavailable' AND value IS NULL) OR (quality <> 'unavailable' AND value IS NOT NULL))
  ) STRICT;

  CREATE INDEX IF NOT EXISTS measurement_name_scope_idx ON measurement(name, scope, quality);

  CREATE TABLE IF NOT EXISTS link (
    from_event_id TEXT NOT NULL REFERENCES observation(event_id),
    relation TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('direct_id', 'trace_parent', 'composite_id', 'application_supplied', 'temporal_inference', 'unlinked')),
    quality TEXT NOT NULL CHECK (quality IN ('exact_provider', 'exact_client', 'derived_exact', 'estimate', 'inferred', 'unavailable', 'exact')),
    PRIMARY KEY(from_event_id, relation, to_kind, to_id, method)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS link_target_idx ON link(to_kind, to_id, method);

  CREATE TABLE IF NOT EXISTS observation_dedupe (
    source TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES observation(event_id),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY(source, source_event_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS otlp_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE REFERENCES observation(event_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT,
    last_error_code TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS otlp_outbox_available_idx ON otlp_outbox(available_at, id);

  CREATE TRIGGER IF NOT EXISTS observation_no_update
  BEFORE UPDATE ON observation BEGIN
    SELECT RAISE(ABORT, 'observation is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS observation_no_delete
  BEFORE DELETE ON observation BEGIN
    SELECT RAISE(ABORT, 'observation is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS measurement_no_update
  BEFORE UPDATE ON measurement BEGIN
    SELECT RAISE(ABORT, 'measurement is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS measurement_no_delete
  BEFORE DELETE ON measurement BEGIN
    SELECT RAISE(ABORT, 'measurement is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS link_no_update
  BEFORE UPDATE ON link BEGIN
    SELECT RAISE(ABORT, 'link is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS link_no_delete
  BEFORE DELETE ON link BEGIN
    SELECT RAISE(ABORT, 'link is append-only');
  END;
`;

module.exports = {
  ALLOWED_EVENTS,
  ALLOWED_MEASUREMENTS,
  ALLOWED_SOURCES,
  ALLOWED_UNITS,
  ATTRIBUTE_SPECS,
  EVENT_ATTRIBUTES,
  LINK_METHODS,
  LINK_QUALITIES,
  LINK_RELATIONS,
  LINK_TARGET_KINDS,
  MEASUREMENT_QUALITIES,
  MEASUREMENT_SCOPES,
  RESOLVED_VIEWS,
  SCHEMA_VERSION,
  TABLE_SQL,
};
