'use strict';

const VIEW_SQL = `
  DROP VIEW IF EXISTS request_usage_resolved;
  CREATE VIEW request_usage_resolved AS
  WITH usage_events AS (
    SELECT
      o.*,
      CASE o.event_name
        WHEN 'gateway.token.usage' THEN 1
        WHEN 'claude_code.api_request' THEN 2
        WHEN 'agent_sdk.assistant_usage' THEN 3
        WHEN 'claude_code.llm_request' THEN 4
        ELSE 99
      END AS evidence_rank
    FROM observation o
    WHERE o.request_id IS NOT NULL
      AND o.event_name IN (
        'gateway.token.usage',
        'claude_code.api_request',
        'agent_sdk.assistant_usage',
        'claude_code.llm_request'
      )
  ), ranked_events AS (
    SELECT
      usage_events.*,
      ROW_NUMBER() OVER (
        PARTITION BY request_id
        ORDER BY evidence_rank, COALESCE(sequence, 9223372036854775807), observed_at, event_id
      ) AS selected_rank
    FROM usage_events
  ), selected_events AS (
    SELECT * FROM ranked_events WHERE selected_rank = 1
  ), ranked_measurements AS (
    SELECT
      m.*,
      ROW_NUMBER() OVER (
        PARTITION BY m.event_id, m.name
        ORDER BY CASE m.scope WHEN 'request' THEN 1 ELSE 2 END
      ) AS selected_rank
    FROM measurement m
    JOIN selected_events e ON e.event_id = m.event_id
    WHERE m.scope IN ('request', 'attempt')
  ), selected_measurements AS (
    SELECT * FROM ranked_measurements WHERE selected_rank = 1
  )
  SELECT
    e.event_id,
    e.project_id,
    e.session_id,
    e.prompt_id,
    e.request_id,
    e.client_request_id,
    e.trace_id,
    e.workflow_run_id,
    e.agent_id,
    e.parent_agent_id,
    e.ticket_ref,
    e.route_id,
    e.event_name AS evidence_event,
    e.source AS evidence_source,
    e.observed_at,
    json_extract(e.attributes_json, '$.model') AS model,
    json_extract(e.attributes_json, '$.requested_model') AS requested_model,
    json_extract(e.attributes_json, '$.provider') AS provider,
    json_extract(e.attributes_json, '$.backend') AS backend,
    json_extract(e.attributes_json, '$.effort') AS effort,
    json_extract(e.attributes_json, '$.via') AS via,
    COALESCE(json_extract(e.attributes_json, '$.agent_role'), CASE WHEN e.agent_id IS NULL THEN 'orchestrator' ELSE 'executor' END) AS agent_role,
    json_extract(e.attributes_json, '$.status') AS status,
    MAX(CASE WHEN m.name = 'input_tokens' THEN m.value END) AS input_tokens,
    MAX(CASE WHEN m.name = 'output_tokens' THEN m.value END) AS output_tokens,
    MAX(CASE WHEN m.name = 'cache_read_tokens' THEN m.value END) AS cache_read_tokens,
    MAX(CASE WHEN m.name = 'cache_creation_tokens' THEN m.value END) AS cache_creation_tokens,
    MAX(CASE WHEN m.name = 'cache_creation_5m_tokens' THEN m.value END) AS cache_creation_5m_tokens,
    MAX(CASE WHEN m.name = 'cache_creation_1h_tokens' THEN m.value END) AS cache_creation_1h_tokens,
    MAX(CASE WHEN m.name = 'thinking_tokens' THEN m.value END) AS thinking_tokens,
    MAX(CASE WHEN m.name = 'context_tokens' THEN m.value END) AS context_tokens,
    MAX(CASE WHEN m.name = 'server_tool_use_count' THEN m.value END) AS server_tool_use_count,
    MAX(CASE WHEN m.name = 'request_body_bytes' THEN m.value END) AS request_body_bytes,
    MAX(CASE WHEN m.name = 'response_body_bytes' THEN m.value END) AS response_body_bytes,
    MAX(CASE WHEN m.name = 'duration_ms' THEN m.value END) AS duration_ms,
    MAX(CASE WHEN m.name = 'cost_usd' THEN m.value END) AS cost_usd,
    MAX(CASE WHEN m.name = 'input_tokens' THEN m.quality END) AS input_quality,
    MAX(CASE WHEN m.name = 'output_tokens' THEN m.quality END) AS output_quality,
    MAX(CASE WHEN m.name = 'cache_read_tokens' THEN m.quality END) AS cache_read_quality,
    MAX(CASE WHEN m.name = 'cache_creation_tokens' THEN m.quality END) AS cache_creation_quality,
    MAX(CASE WHEN m.name = 'thinking_tokens' THEN m.quality END) AS thinking_quality,
    MAX(CASE WHEN m.name = 'context_tokens' THEN m.quality END) AS context_quality,
    MAX(CASE WHEN m.name = 'request_body_bytes' THEN m.quality END) AS request_body_quality,
    MAX(CASE WHEN m.name = 'response_body_bytes' THEN m.quality END) AS response_body_quality,
    MAX(CASE WHEN m.name = 'duration_ms' THEN m.quality END) AS duration_quality,
    MAX(CASE WHEN m.name = 'cost_usd' THEN m.quality END) AS cost_quality
  FROM selected_events e
  LEFT JOIN selected_measurements m ON m.event_id = e.event_id
  GROUP BY e.event_id;

  DROP VIEW IF EXISTS session_rollup;
  CREATE VIEW session_rollup AS
  SELECT
    project_id,
    session_id,
    COUNT(*) AS request_count,
    CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input_tokens,
    CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output_tokens,
    CASE WHEN COUNT(cache_read_tokens) = COUNT(*) THEN SUM(cache_read_tokens) END AS cache_read_tokens,
    CASE WHEN COUNT(cache_creation_tokens) = COUNT(*) THEN SUM(cache_creation_tokens) END AS cache_creation_tokens,
    CASE WHEN COUNT(context_tokens) = COUNT(*) THEN SUM(context_tokens) END AS total_context_tokens,
    CASE WHEN COUNT(thinking_tokens) = COUNT(*) THEN SUM(thinking_tokens) END AS thinking_tokens,
    CASE WHEN COUNT(context_tokens) = COUNT(*) AND COUNT(cache_read_tokens) = COUNT(*) AND SUM(context_tokens) > 0
      THEN SUM(cache_read_tokens) * 1.0 / SUM(context_tokens) END AS cache_read_ratio,
    CASE WHEN COUNT(duration_ms) = COUNT(*) THEN SUM(duration_ms) END AS request_duration_ms,
    CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) END AS estimated_cost_usd,
    MIN(observed_at) AS first_request_at,
    MAX(observed_at) AS last_request_at
  FROM request_usage_resolved
  WHERE session_id IS NOT NULL
  GROUP BY project_id, session_id;

  DROP VIEW IF EXISTS agent_usage_rollup;
  CREATE VIEW agent_usage_rollup AS
  SELECT
    project_id,
    session_id,
    agent_role,
    agent_id,
    MAX(parent_agent_id) AS parent_agent_id,
    COUNT(*) AS request_count,
    CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input_tokens,
    CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output_tokens,
    CASE WHEN COUNT(context_tokens) = COUNT(*) THEN SUM(context_tokens) END AS total_context_tokens,
    CASE WHEN COUNT(cache_read_tokens) = COUNT(*) THEN SUM(cache_read_tokens) END AS cache_read_tokens,
    CASE WHEN COUNT(cache_creation_tokens) = COUNT(*) THEN SUM(cache_creation_tokens) END AS cache_creation_tokens,
    MIN(observed_at) AS first_request_at,
    MAX(observed_at) AS last_request_at
  FROM request_usage_resolved
  GROUP BY project_id, session_id, agent_role, agent_id;

  DROP VIEW IF EXISTS input_composition;
  CREATE VIEW input_composition AS
  SELECT
    o.event_id,
    o.project_id,
    o.session_id,
    o.request_id,
    o.sequence,
    o.agent_id,
    o.parent_agent_id,
    o.observed_at,
    json_extract(o.attributes_json, '$.agent_role') AS agent_role,
    json_extract(o.attributes_json, '$.model') AS model,
    json_extract(o.attributes_json, '$.backend') AS backend,
    json_extract(o.attributes_json, '$.effort') AS effort,
    MAX(CASE WHEN m.name = 'request_body_bytes' THEN m.value END) AS request_body_bytes,
    MAX(CASE WHEN m.name = 'input_system_bytes' THEN m.value END) AS system_bytes,
    MAX(CASE WHEN m.name = 'input_tools_bytes' THEN m.value END) AS tools_bytes,
    MAX(CASE WHEN m.name = 'input_native_tools_bytes' THEN m.value END) AS native_tools_bytes,
    MAX(CASE WHEN m.name = 'input_mcp_tools_bytes' THEN m.value END) AS mcp_tools_bytes,
    MAX(CASE WHEN m.name = 'input_messages_bytes' THEN m.value END) AS messages_bytes,
    MAX(CASE WHEN m.name = 'input_first_message_bytes' THEN m.value END) AS first_message_bytes,
    MAX(CASE WHEN m.name = 'input_history_bytes' THEN m.value END) AS history_bytes,
    MAX(CASE WHEN m.name = 'input_tool_results_bytes' THEN m.value END) AS tool_result_bytes,
    MAX(CASE WHEN m.name = 'input_system_tokens' THEN m.value END) AS system_tokens,
    MAX(CASE WHEN m.name = 'input_tools_tokens' THEN m.value END) AS tools_tokens,
    MAX(CASE WHEN m.name = 'input_native_tools_tokens' THEN m.value END) AS native_tools_tokens,
    MAX(CASE WHEN m.name = 'input_mcp_tools_tokens' THEN m.value END) AS mcp_tools_tokens,
    MAX(CASE WHEN m.name = 'input_first_message_tokens' THEN m.value END) AS first_message_tokens,
    MAX(CASE WHEN m.name = 'input_history_tokens' THEN m.value END) AS history_tokens,
    MAX(CASE WHEN m.name = 'input_tool_results_tokens' THEN m.value END) AS tool_result_tokens,
    MAX(CASE WHEN m.name = 'cache_read_system_tokens' THEN m.value END) AS cache_read_system_tokens,
    MAX(CASE WHEN m.name = 'cache_read_tools_tokens' THEN m.value END) AS cache_read_tools_tokens,
    MAX(CASE WHEN m.name = 'cache_read_first_message_tokens' THEN m.value END) AS cache_read_first_message_tokens,
    MAX(CASE WHEN m.name = 'cache_read_history_tokens' THEN m.value END) AS cache_read_history_tokens,
    MAX(CASE WHEN m.name = 'fresh_system_tokens' THEN m.value END) AS fresh_system_tokens,
    MAX(CASE WHEN m.name = 'fresh_tools_tokens' THEN m.value END) AS fresh_tools_tokens,
    MAX(CASE WHEN m.name = 'fresh_first_message_tokens' THEN m.value END) AS fresh_first_message_tokens,
    MAX(CASE WHEN m.name = 'fresh_history_tokens' THEN m.value END) AS fresh_history_tokens
  FROM observation o
  JOIN measurement m ON m.event_id = o.event_id
  WHERE o.event_name = 'gateway.token.usage'
  GROUP BY o.event_id;

  DROP VIEW IF EXISTS context_timeline;
  CREATE VIEW context_timeline AS
  WITH snapshots AS (
    SELECT
      o.event_id,
      o.project_id,
      o.session_id,
      o.prompt_id,
      o.request_id,
      o.agent_id,
      o.parent_agent_id,
      o.sequence,
      o.observed_at,
      o.event_name,
      json_extract(o.attributes_json, '$.model') AS model,
      MAX(CASE WHEN m.name = 'context_tokens' THEN m.value END) AS context_tokens,
      MAX(CASE WHEN m.name = 'context_window_tokens' THEN m.value END) AS context_window_tokens,
      MAX(CASE WHEN m.name = 'context_delta_tokens' THEN m.value END) AS measured_context_delta_tokens,
      MAX(CASE WHEN m.name = 'pre_tokens' THEN m.value END) AS pre_tokens,
      MAX(CASE WHEN m.name = 'post_tokens' THEN m.value END) AS post_tokens,
      MAX(CASE WHEN m.name = 'context_tokens' THEN m.quality END) AS context_quality,
      MAX(CASE WHEN m.name = 'context_delta_tokens' THEN m.quality END) AS measured_delta_quality,
      MAX(CASE WHEN m.name IN ('pre_tokens', 'post_tokens') THEN m.quality END) AS compaction_quality
    FROM observation o
    JOIN measurement m ON m.event_id = o.event_id
    WHERE m.scope = 'context_snapshot'
       OR o.event_name IN ('statusline.context_snapshot', 'context.compaction', 'gateway.token.usage')
    GROUP BY o.event_id
  ), with_previous AS (
    SELECT
      snapshots.*,
      LAG(context_tokens) OVER (
        PARTITION BY project_id, session_id, COALESCE(agent_id, '')
        ORDER BY observed_at, COALESCE(sequence, 9223372036854775807), event_id
      ) AS previous_context_tokens
    FROM snapshots
  )
  SELECT
    event_id,
    project_id,
    session_id,
    prompt_id,
    request_id,
    agent_id,
    parent_agent_id,
    observed_at,
    event_name,
    model,
    context_tokens,
    context_window_tokens,
    COALESCE(measured_context_delta_tokens,
      CASE WHEN context_tokens IS NOT NULL AND previous_context_tokens IS NOT NULL
        THEN context_tokens - previous_context_tokens END) AS context_delta_tokens,
    pre_tokens,
    post_tokens,
    context_quality,
    COALESCE(measured_delta_quality,
      CASE WHEN context_tokens IS NOT NULL AND previous_context_tokens IS NOT NULL THEN 'derived_exact' END) AS delta_quality,
    compaction_quality
  FROM with_previous;

  DROP VIEW IF EXISTS cache_economics;
  CREATE VIEW cache_economics AS
  SELECT
    event_id,
    project_id,
    session_id,
    request_id,
    agent_id,
    observed_at,
    model,
    cache_read_tokens,
    cache_creation_tokens,
    cache_creation_5m_tokens,
    cache_creation_1h_tokens,
    CASE WHEN cache_read_tokens IS NOT NULL THEN cache_read_tokens * 0.9 END AS read_savings_base_input_tokens,
    CASE WHEN cache_creation_5m_tokens IS NOT NULL AND cache_creation_1h_tokens IS NOT NULL
      THEN cache_creation_5m_tokens * 0.25 + cache_creation_1h_tokens END AS write_surcharge_base_input_tokens,
    CASE WHEN cache_read_tokens IS NOT NULL AND cache_creation_5m_tokens IS NOT NULL AND cache_creation_1h_tokens IS NOT NULL
      THEN cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens END AS net_savings_base_input_tokens,
    CASE model
      WHEN 'claude-fable-5' THEN 10.0
      WHEN 'claude-mythos-5' THEN 10.0
      WHEN 'claude-opus-4-8' THEN 5.0
      WHEN 'claude-opus-4-7' THEN 5.0
      WHEN 'claude-opus-4-6' THEN 5.0
      WHEN 'claude-sonnet-5' THEN 3.0
      WHEN 'claude-sonnet-4-6' THEN 3.0
      WHEN 'claude-haiku-4-5' THEN 1.0
    END AS input_price_usd_per_million,
    CASE model
      WHEN 'claude-fable-5' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 10.0 / 1000000.0
      WHEN 'claude-mythos-5' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 10.0 / 1000000.0
      WHEN 'claude-opus-4-8' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 5.0 / 1000000.0
      WHEN 'claude-opus-4-7' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 5.0 / 1000000.0
      WHEN 'claude-opus-4-6' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 5.0 / 1000000.0
      WHEN 'claude-sonnet-5' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 3.0 / 1000000.0
      WHEN 'claude-sonnet-4-6' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) * 3.0 / 1000000.0
      WHEN 'claude-haiku-4-5' THEN (cache_read_tokens * 0.9 - cache_creation_5m_tokens * 0.25 - cache_creation_1h_tokens) / 1000000.0
    END AS net_savings_usd
  FROM request_usage_resolved
  WHERE evidence_event = 'gateway.token.usage';

  DROP VIEW IF EXISTS limit_signals;
  CREATE VIEW limit_signals AS
  SELECT
    o.event_id,
    o.project_id,
    o.session_id,
    o.request_id,
    o.agent_id,
    o.parent_agent_id,
    o.observed_at,
    o.event_name,
    json_extract(o.attributes_json, '$.model') AS model,
    json_extract(o.attributes_json, '$.backend') AS backend,
    json_extract(o.attributes_json, '$.status') AS status,
    json_extract(o.attributes_json, '$.status_code') AS status_code,
    MAX(CASE WHEN m.name = 'rate_limit_requests_limit' THEN m.value END) AS requests_limit,
    MAX(CASE WHEN m.name = 'rate_limit_requests_remaining' THEN m.value END) AS requests_remaining,
    MAX(CASE WHEN m.name = 'rate_limit_requests_reset_at_ms' THEN m.value END) AS requests_reset_at_ms,
    MAX(CASE WHEN m.name = 'rate_limit_input_tokens_limit' THEN m.value END) AS input_tokens_limit,
    MAX(CASE WHEN m.name = 'rate_limit_input_tokens_remaining' THEN m.value END) AS input_tokens_remaining,
    MAX(CASE WHEN m.name = 'rate_limit_input_tokens_reset_at_ms' THEN m.value END) AS input_tokens_reset_at_ms,
    MAX(CASE WHEN m.name = 'rate_limit_output_tokens_limit' THEN m.value END) AS output_tokens_limit,
    MAX(CASE WHEN m.name = 'rate_limit_output_tokens_remaining' THEN m.value END) AS output_tokens_remaining,
    MAX(CASE WHEN m.name = 'rate_limit_output_tokens_reset_at_ms' THEN m.value END) AS output_tokens_reset_at_ms,
    MAX(CASE WHEN m.name = 'rate_limit_tokens_limit' THEN m.value END) AS tokens_limit,
    MAX(CASE WHEN m.name = 'rate_limit_tokens_remaining' THEN m.value END) AS tokens_remaining,
    MAX(CASE WHEN m.name = 'rate_limit_tokens_reset_at_ms' THEN m.value END) AS tokens_reset_at_ms,
    MAX(CASE WHEN m.name = 'retry_after_ms' THEN m.value END) AS retry_after_ms,
    MAX(CASE WHEN m.name = 'codex_throttle_used_percent' THEN m.value END) AS codex_throttle_used_percent
  FROM observation o
  JOIN measurement m ON m.event_id = o.event_id
  WHERE o.event_name IN ('gateway.token.usage', 'gateway.limit.signal')
    AND m.name IN (
      'rate_limit_requests_limit', 'rate_limit_requests_remaining', 'rate_limit_requests_reset_at_ms',
      'rate_limit_input_tokens_limit', 'rate_limit_input_tokens_remaining', 'rate_limit_input_tokens_reset_at_ms',
      'rate_limit_output_tokens_limit', 'rate_limit_output_tokens_remaining', 'rate_limit_output_tokens_reset_at_ms',
      'rate_limit_tokens_limit', 'rate_limit_tokens_remaining', 'rate_limit_tokens_reset_at_ms',
      'retry_after_ms', 'codex_throttle_used_percent'
    )
  GROUP BY o.event_id;

  DROP VIEW IF EXISTS agent_tree;
  CREATE VIEW agent_tree AS
  SELECT
    o.project_id,
    o.session_id,
    MAX(o.workflow_run_id) AS workflow_run_id,
    o.agent_id,
    MAX(o.parent_agent_id) AS parent_agent_id,
    MIN(CASE WHEN o.event_name = 'hook.subagent_start' THEN o.observed_at END) AS started_at,
    MAX(CASE WHEN o.event_name = 'hook.subagent_stop' THEN o.observed_at END) AS stopped_at,
    MAX(json_extract(o.attributes_json, '$.agent_type')) AS agent_type,
    MAX(json_extract(o.attributes_json, '$.model')) AS model,
    MAX(json_extract(o.attributes_json, '$.effort')) AS effort,
    MAX(json_extract(o.attributes_json, '$.status')) AS status
  FROM observation o
  WHERE o.agent_id IS NOT NULL
  GROUP BY o.project_id, o.session_id, o.agent_id;

  DROP VIEW IF EXISTS tool_calls;
  CREATE VIEW tool_calls AS
  SELECT
    o.project_id,
    o.session_id,
    MAX(o.prompt_id) AS prompt_id,
    MAX(o.request_id) AS request_id,
    MAX(o.agent_id) AS agent_id,
    o.tool_use_id,
    MIN(CASE WHEN o.event_name IN ('hook.pre_tool_use', 'tool.call') THEN o.observed_at END) AS started_at,
    MAX(CASE WHEN o.event_name IN ('hook.post_tool_use', 'claude_code.tool_result', 'tool.call') THEN o.observed_at END) AS completed_at,
    MAX(json_extract(o.attributes_json, '$.tool_name')) AS tool_name,
    MAX(json_extract(o.attributes_json, '$.tool_kind')) AS tool_kind,
    MAX(json_extract(o.attributes_json, '$.is_mcp')) AS is_mcp,
    MAX(json_extract(o.attributes_json, '$.mcp_server')) AS mcp_server,
    MAX(json_extract(o.attributes_json, '$.mcp_tool')) AS mcp_tool,
    MAX(json_extract(o.attributes_json, '$.status')) AS status,
    MAX(CASE WHEN m.name = 'duration_ms' THEN m.value END) AS duration_ms,
    MAX(CASE WHEN m.name = 'blocked_ms' THEN m.value END) AS blocked_ms,
    MAX(CASE WHEN m.name = 'bytes_in' THEN m.value END) AS bytes_in,
    MAX(CASE WHEN m.name = 'bytes_out' THEN m.value END) AS bytes_out
  FROM observation o
  LEFT JOIN measurement m ON m.event_id = o.event_id
  WHERE o.tool_use_id IS NOT NULL
  GROUP BY o.project_id, o.session_id, o.tool_use_id;

  DROP VIEW IF EXISTS ticket_rollup;
  CREATE VIEW ticket_rollup AS
  WITH direct_ticket_links AS (
    SELECT DISTINCT request_id, ticket_ref
    FROM observation
    WHERE request_id IS NOT NULL AND ticket_ref IS NOT NULL
    UNION
    SELECT DISTINCT o.request_id, l.to_id AS ticket_ref
    FROM observation o
    JOIN link l ON l.from_event_id = o.event_id
    WHERE o.request_id IS NOT NULL
      AND l.to_kind = 'ticket'
      AND l.method IN ('direct_id', 'composite_id', 'application_supplied')
  ), attributed_requests AS (
    SELECT r.*, t.ticket_ref AS direct_ticket_ref
    FROM request_usage_resolved r
    LEFT JOIN direct_ticket_links t ON t.request_id = r.request_id
  )
  SELECT
    project_id,
    direct_ticket_ref AS ticket_ref,
    COUNT(*) AS request_count,
    CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END AS input_tokens,
    CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END AS output_tokens,
    CASE WHEN COUNT(cache_read_tokens) = COUNT(*) THEN SUM(cache_read_tokens) END AS cache_read_tokens,
    CASE WHEN COUNT(cache_creation_tokens) = COUNT(*) THEN SUM(cache_creation_tokens) END AS cache_creation_tokens,
    CASE WHEN COUNT(cost_usd) = COUNT(*) THEN SUM(cost_usd) END AS estimated_cost_usd,
    MIN(observed_at) AS first_request_at,
    MAX(observed_at) AS last_request_at
  FROM attributed_requests
  GROUP BY project_id, direct_ticket_ref;

  DROP VIEW IF EXISTS route_comparison;
  CREATE VIEW route_comparison AS
  SELECT
    event_id,
    project_id,
    session_id,
    request_id,
    trace_id,
    route_id,
    observed_at,
    json_extract(attributes_json, '$.requested_model') AS requested_model,
    json_extract(attributes_json, '$.selected_model') AS selected_model,
    json_extract(attributes_json, '$.effective_model') AS effective_model,
    json_extract(attributes_json, '$.backend') AS backend,
    json_extract(attributes_json, '$.effort') AS effort,
    json_extract(attributes_json, '$.fallback') AS fallback,
    json_extract(attributes_json, '$.via') AS via,
    json_extract(attributes_json, '$.status') AS status,
    json_extract(attributes_json, '$.path_class') AS path_class
  FROM observation
  WHERE event_name = 'codex_gateway.route';

  DROP VIEW IF EXISTS coverage_gaps;
  CREATE VIEW coverage_gaps AS
  SELECT
    o.event_id AS gap_id,
    o.source,
    o.event_name AS gap_kind,
    o.observed_at,
    o.project_id,
    o.session_id,
    o.request_id,
    o.attributes_json AS field_names_json
  FROM observation o
  WHERE o.event_name IN ('coverage_gap', 'schema_drop', 'telemetry_conflict')
  UNION ALL
  SELECT
    o.event_id || ':' || m.name AS gap_id,
    o.source,
    'unavailable' AS gap_kind,
    o.observed_at,
    o.project_id,
    o.session_id,
    o.request_id,
    json_array(m.name) AS field_names_json
  FROM observation o
  JOIN measurement m ON m.event_id = o.event_id
  WHERE m.quality = 'unavailable'
  UNION ALL
  SELECT
    s.event_id || ':missing_session_end' AS gap_id,
    s.source,
    'missing_session_end' AS gap_kind,
    s.observed_at,
    s.project_id,
    s.session_id,
    NULL AS request_id,
    json_array('session_end') AS field_names_json
  FROM observation s
  WHERE s.event_name = 'hook.session_start'
    AND s.session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM observation e
      WHERE e.event_name = 'hook.session_end'
        AND e.session_id = s.session_id
    );

  DROP VIEW IF EXISTS outbox_health;
  CREATE VIEW outbox_health AS
  SELECT
    COUNT(*) AS pending_count,
    COALESCE(SUM(CASE WHEN available_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS retryable_count,
    COALESCE(SUM(CASE WHEN available_at IS NULL THEN 1 ELSE 0 END), 0) AS exhausted_count,
    COALESCE(SUM(attempts), 0) AS total_attempts,
    MIN(created_at) AS oldest_pending_at,
    MAX(last_attempt_at) AS last_attempt_at,
    MAX(last_error_code) AS last_error_code
  FROM otlp_outbox;
`;

module.exports = { VIEW_SQL };
