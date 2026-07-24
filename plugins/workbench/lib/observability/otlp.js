'use strict';

const { createHash } = require('node:crypto');
const {
  ALLOWED_EVENTS,
  ALLOWED_SOURCES,
  isAllowedMeasurementName,
  ATTRIBUTE_SPECS,
  EVENT_ATTRIBUTES,
  MEASUREMENT_QUALITIES,
} = require('./schema.js');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@\[\]-]{0,254}$/;
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,127}$/;
const SAFE_STATUS = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DECISIONS = new Set(['allow', 'deny', 'ask', 'block']);
const HEX_TRACE = /^[0-9a-f]{32}$/;
const HEX_SPAN = /^[0-9a-f]{16}$/;

// OTLP resource attribute key -> canonical observation identifier column.
const RESOURCE_ID_KEYS = Object.freeze({
  'session.id': 'session_id',
  'claude.session.id': 'session_id',
  'workflow.run.id': 'workflow_run_id',
});

// OTLP attribute key (dots normalized to underscores) -> canonical measurement name.
// Only names the schema already allows are honored; anything else becomes a gap.
const MEASUREMENT_ALIASES = Object.freeze({
  'claude_code.token.usage': 'input_tokens',
  'claude_code.active_time.total': 'active_time_ms',
  'claude_code.cost.usage': 'cost_usd',
});

const STRUCTURAL_ATTRIBUTE_KEYS = new Set([
  'source', 'source_event_id', 'source_schema', 'event_name',
  'project_id', 'session_id', 'claude_session_id', 'prompt_id', 'request_id', 'client_request_id',
  'trace_id', 'span_id', 'parent_span_id', 'workflow_run_id',
  'agent_id', 'parent_agent_id', 'tool_use_id', 'task_id', 'ticket_ref', 'route_id',
  'request_sequence', 'sequence',
  // Measurement metadata the gateway sends alongside tool_result_tokens; consumed
  // by measurementsFrom, not an attribute.
  'tool_result_tokens_unit', 'tool_result_tokens_quality',
]);

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function otlpValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (value.intValue !== undefined) {
    const n = Number(value.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  return undefined; // arrayValue / kvlistValue / bytesValue are dropped.
}

function flattenAttributes(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const attribute of list) {
    if (!attribute || typeof attribute.key !== 'string') continue;
    const value = otlpValue(attribute.value);
    if (value !== undefined) out[attribute.key] = value;
  }
  return out;
}

function nanoToIso(nano) {
  if (typeof nano === 'number' && Number.isFinite(nano)) return new Date(nano / 1e6).toISOString();
  if (typeof nano === 'string' && /^[0-9]+$/.test(nano)) {
    try {
      return new Date(Number(BigInt(nano) / 1000000n)).toISOString();
    } catch { return null; }
  }
  return null;
}

function normalizeKey(key) {
  return String(key).replace(/\./g, '_');
}

// Mirror the observer ingest validators exactly so selected attributes are never
// rejected downstream.
function validAttribute(spec, value) {
  if (spec === 'identifier') return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
  if (spec === 'effort') return typeof value === 'string' && EFFORTS.has(value);
  if (spec === 'boolean') return typeof value === 'boolean';
  if (spec === 'status') return typeof value === 'string' && SAFE_STATUS.test(value);
  if (spec === 'decision') return typeof value === 'string' && DECISIONS.has(value);
  if (spec === 'nonnegative_integer') return Number.isSafeInteger(value) && value >= 0;
  return false;
}

function measurementName(rawKey) {
  const normalized = normalizeKey(rawKey);
  return MEASUREMENT_ALIASES[rawKey] || MEASUREMENT_ALIASES[normalized]
    || (isAllowedMeasurementName(normalized) ? normalized : null);
}

function measurementUnit(name) {
  if (name === 'cost_usd') return 'usd';
  if (name.endsWith('_bytes') || name === 'bytes_in' || name === 'bytes_out') return 'bytes';
  if (name.endsWith('_ms')) return 'ms';
  if (name.endsWith('_percent') || name === 'rate_limit_percent') return 'percent';
  if (name.endsWith('_count') || name.endsWith('_requests')
      || name.startsWith('rate_limit_requests_')) return 'count';
  return 'tokens';
}

function measurementQuality(eventName, name, flat) {
  if (eventName === 'gateway.tool_result.usage' && name === 'tool_result_tokens') {
    const declared = flat?.tool_result_tokens_quality;
    return MEASUREMENT_QUALITIES.includes(declared) ? declared : 'estimate';
  }
  if (eventName === 'codex_gateway.route' && name === 'duration_ms') return 'exact_client';
  if (eventName !== 'gateway.token.usage' && eventName !== 'gateway.limit.signal') {
    return name === 'cost_usd' ? 'estimate' : 'exact_provider';
  }
  if (name.endsWith('_bytes') || name === 'duration_ms') return 'exact_client';
  if (name === 'context_tokens') return 'derived_exact';
  if (/^(?:input_(?:tools|native_tools|mcp_tools|system|first_message|history|tool_results)|cache_read_(?:tools|system|first_message|history)|fresh_(?:tools|system|first_message|history))_tokens$/.test(name)) {
    return 'estimate';
  }
  return 'exact_provider';
}

// Keep only attributes the canonical schema allows for this event; report the rest
// as dropped field NAMES (never values).
function selectAttributes(eventName, flat, dropped) {
  const allowed = new Set(EVENT_ATTRIBUTES[eventName] || []);
  const attributes = {};
  for (const [rawKey, value] of Object.entries(flat)) {
    const key = normalizeKey(rawKey);
    if (measurementName(rawKey)) continue;
    if (key === 'source' && allowed.has(key) && ATTRIBUTE_SPECS[key]) {
      if (validAttribute(ATTRIBUTE_SPECS[key], value)) attributes[key] = value;
      else dropped.add(key);
      continue;
    }
    if (STRUCTURAL_ATTRIBUTE_KEYS.has(key)) continue;
    if (!allowed.has(key) || !ATTRIBUTE_SPECS[key]) {
      dropped.add(key);
      continue;
    }
    const spec = ATTRIBUTE_SPECS[key];
    if (validAttribute(spec, value)) attributes[key] = value;
    else dropped.add(key);
  }
  return attributes;
}

function measurementsFrom(flat, scope, eventName = null) {
  const measurements = [];
  const seen = new Set();
  for (const [rawKey, value] of Object.entries(flat)) {
    const name = measurementName(rawKey);
    if (!name || !isAllowedMeasurementName(name)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    measurements.push({
      name,
      value,
      unit: measurementUnit(name),
      scope,
      quality: measurementQuality(eventName, name, flat),
    });
  }
  return measurements;
}

function idColumns(flat, resourceIds) {
  const ids = { ...resourceIds };
  const mappings = [
    [['session.id', 'claude.session.id', 'session_id'], 'session_id'],
    [['prompt.id', 'prompt_id'], 'prompt_id'],
    [['request.id', 'request_id'], 'request_id'],
    [['client.request.id', 'client_request_id'], 'client_request_id'],
    [['workflow.run.id', 'workflow_run_id'], 'workflow_run_id'],
    [['agent.id', 'agent_id'], 'agent_id'],
    [['parent.agent.id', 'parent_agent_id'], 'parent_agent_id'],
    [['tool_use.id', 'tool_use_id'], 'tool_use_id'],
    [['task.id', 'task_id'], 'task_id'],
    [['ticket.ref', 'ticket_ref'], 'ticket_ref'],
    [['route.id', 'route_id'], 'route_id'],
  ];
  for (const [keys, column] of mappings) {
    const value = identifier(keys.map((key) => flat[key]).find((entry) => entry !== undefined));
    if (value) ids[column] = value;
  }
  const sequence = flat.request_sequence ?? flat.sequence;
  if (Number.isSafeInteger(sequence) && sequence >= 0) ids.sequence = sequence;
  return ids;
}

function canonicalSource(flat, fallback) {
  const raw = typeof flat.source === 'string' ? flat.source.replace(/-/g, '_') : null;
  return raw && ALLOWED_SOURCES.includes(raw) ? raw : fallback;
}

function canonicalSourceEventId(flat, fallback) {
  return identifier(flat.source_event_id) || fallback;
}

function canonicalSourceSchema(flat) {
  return identifier(flat.source_schema) || 'otlp-json-v1';
}

const EVENT_ALIASES = Object.freeze({
  mcp_server_connection: 'claude_code.mcp_server_connection',
  hook_execution_start: 'claude_code.hook_execution_start',
  hook_execution_complete: 'claude_code.hook_execution_complete',
});

function eventNameFrom(candidate, flat) {
  const explicit = candidate || flat['event.name'] || flat.event_name;
  const canonical = EVENT_ALIASES[explicit] || explicit;
  return typeof canonical === 'string' && ALLOWED_EVENTS.includes(canonical) ? canonical : null;
}

function canonicalEventAttributes(eventName, flat) {
  const normalized = { ...flat };
  if (eventName === 'claude_code.mcp_server_connection') {
    normalized.mcp_server = normalized.mcp_server || normalized.server_name || normalized.server || normalized.plugin_name;
    normalized.status = normalized.status || normalized.connection_status;
    delete normalized.server_name;
    delete normalized.server;
    delete normalized.connection_status;
  } else if (eventName.startsWith('claude_code.hook_execution_')) {
    normalized.hook_name = normalized.hook_name || normalized.hook || normalized.name;
    delete normalized.hook;
    delete normalized.name;
  }
  return normalized;
}

function stableSourceId(kind, parts) {
  return `otlp_${kind}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
}

function coverageGap(reason, observedAt, resourceIds) {
  return {
    source: 'workbench',
    source_event_id: stableSourceId('gap', [reason, observedAt, resourceIds]),
    source_schema: 'otlp-json-v1',
    observed_at: observedAt,
    event_name: 'coverage_gap',
    attributes: { status: reason },
    ...resourceIds,
  };
}

function schemaDrop(fields, observedAt) {
  const fieldNames = [...new Set([...fields].filter((field) => SAFE_FIELD_NAME.test(field)))].sort().slice(0, 128);
  return {
    source: 'workbench',
    source_event_id: stableSourceId('drop', [fieldNames, observedAt]),
    source_schema: 'otlp-json-v1',
    observed_at: observedAt,
    event_name: 'schema_drop',
    attributes: { field_names: fieldNames },
  };
}

function resourceScopes(root, signalKey, scopeKey, itemKey) {
  const groups = [];
  for (const resource of Array.isArray(root[signalKey]) ? root[signalKey] : []) {
    const resourceIds = {};
    const resAttrs = flattenAttributes(resource.resource && resource.resource.attributes);
    for (const [otlpKey, column] of Object.entries(RESOURCE_ID_KEYS)) {
      const id = identifier(resAttrs[otlpKey]);
      if (id) resourceIds[column] = id;
    }
    for (const scope of Array.isArray(resource[scopeKey]) ? resource[scopeKey] : []) {
      const items = Array.isArray(scope[itemKey]) ? scope[itemKey] : [];
      groups.push({ resourceIds, items });
    }
  }
  return groups;
}

function convertLogs(root, options, observations, dropped) {
  for (const { resourceIds, items } of resourceScopes(root, 'resourceLogs', 'scopeLogs', 'logRecords')) {
    for (const record of items) {
      const flat = flattenAttributes(record.attributes);
      const observedAt = nanoToIso(record.timeUnixNano || record.observedTimeUnixNano);
      if (!observedAt) continue;
      const eventName = eventNameFrom(record.eventName, flat);
      if (!eventName) { observations.push(coverageGap('unmapped_log', observedAt, resourceIds)); continue; }
      const canonicalFlat = canonicalEventAttributes(eventName, flat);
      const localDropped = new Set();
      const attributes = selectAttributes(eventName, canonicalFlat, localDropped);
      for (const key of localDropped) dropped.add(key);
      const measurements = measurementsFrom(flat, 'request', eventName);
      const ids = idColumns(flat, resourceIds);
      if (identifier(record.traceId) && HEX_TRACE.test(record.traceId)) ids.trace_id = record.traceId;
      if (identifier(record.spanId) && HEX_SPAN.test(record.spanId)) ids.span_id = record.spanId;
      const fallbackSource = eventName.startsWith('gateway.') ? 'codex_gateway' : 'claude_code';
      const fallbackSourceId = stableSourceId('log', [eventName, observedAt, ids, flat]);
      const observation = {
        source: canonicalSource(flat, fallbackSource),
        source_event_id: canonicalSourceEventId(flat, fallbackSourceId),
        source_schema: canonicalSourceSchema(flat),
        observed_at: observedAt,
        event_name: eventName,
        attributes,
        ...ids,
      };
      if (measurements.length > 0) observation.measurements = measurements;
      if (options.projectId) observation.project_id = options.projectId;
      observations.push(observation);
    }
  }
}

function convertTraces(root, options, observations, dropped) {
  for (const { resourceIds, items } of resourceScopes(root, 'resourceSpans', 'scopeSpans', 'spans')) {
    for (const span of items) {
      const flat = flattenAttributes(span.attributes);
      const observedAt = nanoToIso(span.startTimeUnixNano);
      if (!observedAt) continue;
      const eventName = eventNameFrom(span.name, flat);
      if (!eventName) { observations.push(coverageGap('unmapped_span', observedAt, resourceIds)); continue; }
      const localDropped = new Set();
      const attributes = selectAttributes(eventName, flat, localDropped);
      for (const key of localDropped) dropped.add(key);
      const measurements = measurementsFrom(flat, 'request', eventName);
      const ids = idColumns(flat, resourceIds);
      if (typeof span.traceId === 'string' && HEX_TRACE.test(span.traceId)) ids.trace_id = span.traceId;
      if (typeof span.spanId === 'string' && HEX_SPAN.test(span.spanId)) ids.span_id = span.spanId;
      // Trace parentage is carried by the parent_span_id column; the link table has no
      // span target kind, so the column is the join key for the agent/trace views.
      if (typeof span.parentSpanId === 'string' && HEX_SPAN.test(span.parentSpanId)) ids.parent_span_id = span.parentSpanId;
      const fallbackSource = eventName === 'codex_gateway.route' ? 'codex_gateway' : 'claude_code';
      const fallbackSourceId = stableSourceId('span', [eventName, ids.span_id || observedAt]);
      const observation = {
        source: canonicalSource(flat, fallbackSource),
        source_event_id: canonicalSourceEventId(flat, fallbackSourceId),
        source_schema: canonicalSourceSchema(flat),
        observed_at: observedAt,
        event_name: eventName,
        attributes,
        ...ids,
      };
      if (measurements.length > 0) observation.measurements = measurements;
      if (options.projectId) observation.project_id = options.projectId;
      observations.push(observation);
    }
  }
}

function convertMetrics(root, options, observations) {
  for (const { resourceIds, items } of resourceScopes(root, 'resourceMetrics', 'scopeMetrics', 'metrics')) {
    for (const metric of items) {
      const points = metric.sum && metric.sum.dataPoints ? metric.sum.dataPoints
        : metric.gauge && metric.gauge.dataPoints ? metric.gauge.dataPoints
          : null;
      if (!points) {
        // Histogram / summary / exponential payloads carry no single scalar we can
        // map to a measurement without guessing; record an explicit gap instead.
        const at = nanoToIso((metric.histogram && metric.histogram.dataPoints && metric.histogram.dataPoints[0]
          && metric.histogram.dataPoints[0].timeUnixNano)) || new Date(0).toISOString();
        observations.push(coverageGap('unsupported_metric_shape', at, resourceIds));
        continue;
      }
      for (const point of Array.isArray(points) ? points : []) {
        const observedAt = nanoToIso(point.timeUnixNano);
        if (!observedAt) continue;
        const flat = flattenAttributes(point.attributes);
        const activeTime = metric.name === 'claude_code.active_time.total';
        const metricAttributes = activeTime
          ? { ...flat, activity_type: flat.activity_type || flat.type || flat.state }
          : flat;
        if (activeTime) {
          delete metricAttributes.type;
          delete metricAttributes.state;
        }
        const named = { ...metricAttributes };
        const raw = point.asInt !== undefined ? Number(point.asInt)
          : typeof point.asDouble === 'number' ? point.asDouble : null;
        if (raw !== null) named[metric.name] = activeTime ? raw * 1000 : raw;
        const measurements = measurementsFrom(named, 'aggregate', 'otel.metric');
        if (measurements.length === 0) { observations.push(coverageGap('unmapped_metric', observedAt, resourceIds)); continue; }
        const localDropped = new Set();
        const attributes = selectAttributes('otel.metric', metricAttributes, localDropped);
        const ids = idColumns(flat, resourceIds);
        observations.push({
          source: 'otel_collector',
          source_event_id: stableSourceId('metric', [metric.name, observedAt, ids, flat]),
          source_schema: 'otlp-json-v1',
          observed_at: observedAt,
          event_name: 'otel.metric',
          attributes,
          measurements,
          ...ids,
          ...(options.projectId ? { project_id: options.projectId } : {}),
        });
      }
    }
  }
}

const SIGNAL_ROOTS = Object.freeze({
  logs: 'resourceLogs',
  traces: 'resourceSpans',
  metrics: 'resourceMetrics',
});

// Convert an OTLP/HTTP JSON export request body into canonical observations.
// Content-bearing fields (log bodies, span events) are never read.
function otlpToObservations(signal, body, options = {}) {
  if (!SIGNAL_ROOTS[signal]) throw new TypeError(`Unsupported OTLP signal: ${signal}`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('invalid_otlp_body');
    error.statusCode = 400;
    throw error;
  }
  const observations = [];
  const dropped = new Set();
  if (signal === 'logs') convertLogs(body, options, observations, dropped);
  else if (signal === 'traces') convertTraces(body, options, observations, dropped);
  else convertMetrics(body, options, observations);

  if (dropped.size > 0) {
    const at = observations.find((o) => o.observed_at)?.observed_at || new Date(0).toISOString();
    const drop = schemaDrop(dropped, at);
    if (drop.attributes.field_names.length > 0) observations.push(drop);
  }
  return observations;
}

module.exports = {
  MEASUREMENT_ALIASES,
  flattenAttributes,
  nanoToIso,
  otlpToObservations,
};
