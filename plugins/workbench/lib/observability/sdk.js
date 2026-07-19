'use strict';

const { randomBytes, createHash } = require('node:crypto');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN = '0000000000000000';

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function assign(target, key, value) {
  if (value !== null && value !== undefined) target[key] = value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function isoTime(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff' || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { version, traceId, spanId, flags, sampled: (parseInt(flags, 16) & 0x01) === 1 };
}

function formatTraceparent(traceId, spanId, sampled = true) {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

// Application-owned correlation context: mint a W3C trace context to inject into the SDK
// `query()` call so native children join by trace parentage. This emits NO observation —
// the single terminal observation is produced only from a real SDKResultMessage by
// normalizeTerminalResult(). `workflow_run_id` is application metadata, not an SDK field.
function createWorkflowRun(options = {}) {
  const workflowRunId = identifier(first(options.workflowRunId, options.workflow_run_id));
  const parent = parseTraceparent(first(options.traceparent, options.parentTraceparent));
  const traceId = parent ? parent.traceId : randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const sampled = parent ? parent.sampled : true;

  return {
    workflowRunId,
    traceId,
    spanId,
    sampled,
    parentSpanId: parent ? parent.spanId : null,
    traceparent: formatTraceparent(traceId, spanId, sampled),
    projectId: identifier(options.projectId),
  };
}

function usageMeasurements(usage, scope) {
  if (!isPlainObject(usage)) return [];
  const pairs = [
    ['input_tokens', first(usage.input_tokens, usage.inputTokens)],
    ['output_tokens', first(usage.output_tokens, usage.outputTokens)],
    ['cache_read_tokens', first(usage.cache_read_input_tokens, usage.cacheReadInputTokens)],
    ['cache_creation_tokens', first(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens)],
  ];
  const measurements = [];
  for (const [name, raw] of pairs) {
    const value = nonNegative(raw);
    if (value === null) continue;
    measurements.push({ name, value, unit: 'tokens', scope, quality: 'exact_client' });
  }
  return measurements;
}

function costMeasurement(raw, scope) {
  const value = nonNegative(raw);
  if (value === null) return null;
  return { name: 'cost_usd', value, unit: 'usd', scope, quality: 'estimate' };
}

// Whole-tree per-model breakdown (includes subagents) from the terminal `modelUsage`
// field: one assistant_usage observation per model at run scope. Kept separate from the
// top-level query-scope `usage` on the terminal observation; the two are never summed.
function modelUsageObservations(result, base) {
  const breakdown = result.modelUsage;
  if (!isPlainObject(breakdown)) return [];
  const observations = [];
  for (const [rawModel, usage] of Object.entries(breakdown)) {
    const model = identifier(rawModel);
    if (!model || !isPlainObject(usage)) continue;
    const measurements = usageMeasurements(usage, 'run');
    const cost = costMeasurement(usage.costUSD, 'run');
    if (cost) measurements.push(cost);
    if (measurements.length === 0) continue;
    observations.push({
      ...base,
      source_event_id: `${base.source_event_id}_model_${createHash('sha256').update(model).digest('hex').slice(0, 16)}`,
      event_name: 'agent_sdk.assistant_usage',
      attributes: { model },
      measurements,
    });
  }
  return observations;
}

function runLink(relation, kind, id, method, quality) {
  const safeId = identifier(id);
  if (!safeId) return null;
  return { relation, to_kind: kind, to_id: safeId, method, quality };
}

function normalizeAssistantUsage(message, context = {}) {
  if (!isPlainObject(message) || message.type !== 'assistant' || !isPlainObject(message.message)) return null;

  const providerMessageId = identifier(message.message.id);
  if (!providerMessageId) return null;
  const measurements = usageMeasurements(message.message.usage, 'request');
  if (measurements.length === 0) return null;

  const sessionId = identifier(first(message.session_id, context.sessionId));
  const messageUuid = identifier(message.uuid);
  const trace = parseTraceparent(context.traceparent) || {
    traceId: identifier(context.traceId),
    spanId: identifier(context.spanId),
  };
  const attributes = {};
  assign(attributes, 'model', identifier(message.message.model));
  assign(attributes, 'message_uuid', messageUuid);

  const observation = {
    source: 'agent_sdk',
    source_event_id: `agent_sdk_assistant_${createHash('sha256').update(providerMessageId).digest('hex').slice(0, 32)}`,
    source_schema: 'agent-sdk-v1',
    observed_at: isoTime(context.observedAt, new Date().toISOString()),
    event_name: 'agent_sdk.assistant_usage',
    attributes,
    measurements,
  };
  assign(observation, 'project_id', identifier(context.projectId));
  assign(observation, 'session_id', sessionId);
  assign(observation, 'workflow_run_id', identifier(first(context.workflowRunId, context.workflow_run_id)));
  assign(observation, 'request_id', identifier(message.request_id));
  assign(observation, 'trace_id', identifier(trace.traceId));
  assign(observation, 'span_id', identifier(trace.spanId));

  const parentToolUse = runLink('child_of', 'tool', first(message.parent_tool_use_id, context.parentToolUseId), 'direct_id', 'exact_client');
  if (parentToolUse) observation.links = [parentToolUse];
  return observation;
}

// Normalize the SDK/Workflow terminal `result` message into canonical observations.
// Metadata only: never reads prompt, response, tool content, cwd, transcript, or env.
function normalizeTerminalResult(result, context = {}) {
  if (!isPlainObject(result)) throw new TypeError('An SDK terminal result object is required.');

  const sessionId = identifier(first(result.session_id, context.sessionId));
  const messageUuid = identifier(result.uuid);
  const workflowRunId = identifier(first(context.workflowRunId, context.workflow_run_id));
  const trace = parseTraceparent(context.traceparent) || {
    traceId: identifier(context.traceId),
    spanId: identifier(context.spanId),
  };

  const attributes = {};
  assign(attributes, 'status', identifier(result.subtype));
  assign(attributes, 'stop_reason', identifier(result.stop_reason));
  assign(attributes, 'message_uuid', messageUuid);
  const turns = nonNegative(result.num_turns);
  if (turns !== null) attributes.turns = turns;

  const measurements = [];
  const duration = nonNegative(result.duration_ms);
  if (duration !== null) measurements.push({ name: 'duration_ms', value: duration, unit: 'ms', scope: 'run', quality: 'exact_client' });
  // duration_api_ms is the SDK's own API-time figure; it carries no provider-blocked-time
  // contract, so it is recorded under an SDK-native name (never blocked_ms, which is a
  // tool-scoped measurement with a different meaning).
  const apiDuration = nonNegative(result.duration_api_ms);
  if (apiDuration !== null) measurements.push({ name: 'api_duration_ms', value: apiDuration, unit: 'ms', scope: 'run', quality: 'exact_client' });
  // Top-level `usage` is the query() call total and EXCLUDES subagents. It stays at run
  // scope, kept distinct from the whole-tree per-model `modelUsage` breakdown below; the
  // two are never summed.
  for (const measurement of usageMeasurements(result.usage, 'run')) measurements.push(measurement);
  const cost = costMeasurement(result.total_cost_usd, 'run');
  if (cost) measurements.push(cost);

  const observedAt = isoTime(context.observedAt, new Date().toISOString());
  const sourceSeed = first(messageUuid, sessionId, trace.spanId, 'agent_sdk_result');
  const terminal = {
    source: 'agent_sdk',
    source_event_id: `agent_sdk_result_${createHash('sha256').update(String(sourceSeed)).digest('hex').slice(0, 32)}`,
    source_schema: 'agent-sdk-v1',
    observed_at: observedAt,
    event_name: 'agent_sdk.terminal_result',
    attributes,
  };
  if (measurements.length > 0) terminal.measurements = measurements;
  assign(terminal, 'project_id', identifier(context.projectId));
  assign(terminal, 'session_id', sessionId);
  assign(terminal, 'workflow_run_id', workflowRunId);
  assign(terminal, 'trace_id', identifier(trace.traceId));
  assign(terminal, 'span_id', identifier(trace.spanId));

  const links = [];
  // Missing parent/workflow IDs are left unlinked rather than guessed.
  const workflowLink = runLink('belongs_to', 'workflow', workflowRunId, 'application_supplied', 'exact');
  if (workflowLink) links.push(workflowLink);
  const parentToolUse = runLink('child_of', 'tool', first(context.parentToolUseId, context.parent_tool_use_id), 'direct_id', 'exact_client');
  if (parentToolUse) links.push(parentToolUse);
  if (links.length > 0) terminal.links = links;

  const base = {
    source: 'agent_sdk',
    source_event_id: terminal.source_event_id,
    source_schema: 'agent-sdk-v1',
    observed_at: observedAt,
    event_name: 'agent_sdk.assistant_usage',
  };
  assign(base, 'project_id', identifier(context.projectId));
  assign(base, 'session_id', sessionId);
  assign(base, 'workflow_run_id', workflowRunId);
  assign(base, 'trace_id', identifier(trace.traceId));

  return [terminal, ...modelUsageObservations(result, base)];
}

// Send observations to the loopback observer with a hard timeout, fail-open, and
// without keeping the event loop alive for short headless runs.
async function flushObservations(observations, options = {}) {
  const list = Array.isArray(observations) ? observations.filter(isPlainObject) : [];
  if (list.length === 0) return { sent: 0, ok: true };
  const url = typeof options.url === 'string' ? options.url : 'http://127.0.0.1:14319/v1/observations';
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 1500;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { sent: 0, ok: false, error: 'no_fetch' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(list),
      signal: controller.signal,
    });
    return { sent: list.length, ok: response.ok === true, status: response.status };
  } catch (error) {
    return { sent: 0, ok: false, error: error && error.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  createWorkflowRun,
  flushObservations,
  formatTraceparent,
  normalizeAssistantUsage,
  normalizeTerminalResult,
  parseTraceparent,
};
