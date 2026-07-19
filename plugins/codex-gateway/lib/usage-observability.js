'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318/v1/logs';
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 500;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@\[\]-]{0,254}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const RATE_LIMIT_HEADERS = Object.freeze({
  'anthropic-ratelimit-requests-limit': ['rate_limit_requests_limit', 'count'],
  'anthropic-ratelimit-requests-remaining': ['rate_limit_requests_remaining', 'count'],
  'anthropic-ratelimit-requests-reset': ['rate_limit_requests_reset_at_ms', 'timestamp'],
  'anthropic-ratelimit-input-tokens-limit': ['rate_limit_input_tokens_limit', 'count'],
  'anthropic-ratelimit-input-tokens-remaining': ['rate_limit_input_tokens_remaining', 'count'],
  'anthropic-ratelimit-input-tokens-reset': ['rate_limit_input_tokens_reset_at_ms', 'timestamp'],
  'anthropic-ratelimit-output-tokens-limit': ['rate_limit_output_tokens_limit', 'count'],
  'anthropic-ratelimit-output-tokens-remaining': ['rate_limit_output_tokens_remaining', 'count'],
  'anthropic-ratelimit-output-tokens-reset': ['rate_limit_output_tokens_reset_at_ms', 'timestamp'],
  'anthropic-ratelimit-tokens-limit': ['rate_limit_tokens_limit', 'count'],
  'anthropic-ratelimit-tokens-remaining': ['rate_limit_tokens_remaining', 'count'],
  'anthropic-ratelimit-tokens-reset': ['rate_limit_tokens_reset_at_ms', 'timestamp'],
});

function safeIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function numeric(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function serializedBytes(value) {
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : 0;
  } catch {
    return 0;
  }
}

function toolResultBytes(value) {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + toolResultBytes(entry), 0);
  if (!value || typeof value !== 'object') return 0;
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'tool_result' || type.endsWith('_tool_result')) return serializedBytes(value);
  return Object.values(value).reduce((total, entry) => total + toolResultBytes(entry), 0);
}

function inputComposition(payload, requestBodyBytes = null) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const mcpTools = tools.filter((tool) => typeof tool?.name === 'string' && tool.name.startsWith('mcp__'));
  const nativeTools = tools.filter((tool) => !(typeof tool?.name === 'string' && tool.name.startsWith('mcp__')));
  const messageItemBytes = messages.map(serializedBytes);
  const firstMessageBytes = messageItemBytes[0] || 0;
  const historyBytes = messageItemBytes.slice(1).reduce((total, value) => total + value, 0);
  return Object.freeze({
    request_body_bytes: numeric(requestBodyBytes) ?? serializedBytes(payload),
    input_system_bytes: serializedBytes(payload?.system),
    input_tools_bytes: serializedBytes(payload?.tools),
    input_native_tools_bytes: nativeTools.reduce((total, tool) => total + serializedBytes(tool), 0),
    input_mcp_tools_bytes: mcpTools.reduce((total, tool) => total + serializedBytes(tool), 0),
    input_messages_bytes: serializedBytes(messages),
    input_first_message_bytes: firstMessageBytes,
    input_history_bytes: historyBytes,
    input_tool_results_bytes: toolResultBytes(messages),
  });
}

function allocateLargestRemainder(total, weights) {
  const safeTotal = Math.max(0, Math.floor(numeric(total) || 0));
  const entries = Object.entries(weights).map(([name, value], index) => ({
    name,
    index,
    weight: Math.max(0, numeric(value) || 0),
  }));
  const weightTotal = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const allocated = Object.fromEntries(entries.map((entry) => [entry.name, 0]));
  if (safeTotal === 0 || weightTotal === 0) return allocated;

  let used = 0;
  const fractions = [];
  for (const entry of entries) {
    const exact = safeTotal * entry.weight / weightTotal;
    const base = Math.floor(exact);
    allocated[entry.name] = base;
    used += base;
    fractions.push({ ...entry, fraction: exact - base });
  }
  fractions.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < safeTotal - used; index += 1) {
    allocated[fractions[index % fractions.length].name] += 1;
  }
  return allocated;
}

function exactUsage(usage) {
  const inputTokens = numeric(usage?.input_tokens);
  const outputTokens = numeric(usage?.output_tokens);
  const cacheReadTokens = numeric(usage?.cache_read_input_tokens);
  const cacheCreationTokens = numeric(usage?.cache_creation_input_tokens);
  let cacheCreation5mTokens = numeric(usage?.cache_creation?.ephemeral_5m_input_tokens);
  let cacheCreation1hTokens = numeric(usage?.cache_creation?.ephemeral_1h_input_tokens);
  if (cacheCreationTokens !== null
      && cacheCreation5mTokens === null && cacheCreation1hTokens === null) {
    cacheCreation5mTokens = cacheCreationTokens;
    cacheCreation1hTokens = 0;
  }
  const thinkingTokens = [
    usage?.thinking_tokens,
    usage?.reasoning_tokens,
    usage?.output_tokens_details?.thinking_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
  ].map(numeric).find((value) => value !== null) ?? null;

  const serverToolUse = usage?.server_tool_use && typeof usage.server_tool_use === 'object'
    ? usage.server_tool_use
    : {};
  const serverToolCounts = Object.values(serverToolUse).map(numeric).filter((value) => value !== null);
  const serverToolUseCount = serverToolCounts.length > 0
    ? serverToolCounts.reduce((total, value) => total + value, 0)
    : null;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_creation_5m_tokens: cacheCreation5mTokens,
    cache_creation_1h_tokens: cacheCreation1hTokens,
    thinking_tokens: thinkingTokens,
    server_tool_use_count: serverToolUseCount,
    web_search_requests: numeric(serverToolUse.web_search_requests),
    web_fetch_requests: numeric(serverToolUse.web_fetch_requests),
    code_execution_requests: numeric(serverToolUse.code_execution_requests),
    tool_search_requests: numeric(serverToolUse.tool_search_requests),
  };
}

function inputAttribution(composition, usage) {
  const exact = exactUsage(usage);
  const inputEvidence = [exact.input_tokens, exact.cache_read_tokens, exact.cache_creation_tokens]
    .some((value) => value !== null);
  const totalInput = [exact.input_tokens, exact.cache_read_tokens, exact.cache_creation_tokens]
    .reduce((total, value) => total + (value || 0), 0);
  const weights = {
    tools: composition.input_tools_bytes,
    system: composition.input_system_bytes,
    first_message: composition.input_first_message_bytes,
    history: composition.input_history_bytes,
  };
  const sectionTokens = inputEvidence
    ? allocateLargestRemainder(totalInput, weights)
    : Object.fromEntries(Object.entries(weights).map(([name, bytes]) => [name, Math.ceil(bytes / 4)]));

  const toolKindTokens = allocateLargestRemainder(sectionTokens.tools, {
    native: composition.input_native_tools_bytes,
    mcp: composition.input_mcp_tools_bytes,
  });
  let cacheReadRemaining = Math.floor(exact.cache_read_tokens || 0);
  const cacheRead = {};
  const fresh = {};
  for (const source of ['tools', 'system', 'first_message', 'history']) {
    cacheRead[source] = Math.min(sectionTokens[source], cacheReadRemaining);
    cacheReadRemaining -= cacheRead[source];
    fresh[source] = sectionTokens[source] - cacheRead[source];
  }

  const messageTokens = sectionTokens.first_message + sectionTokens.history;
  const toolResultTokens = composition.input_messages_bytes > 0
    ? Math.min(messageTokens, Math.round(messageTokens
      * composition.input_tool_results_bytes / composition.input_messages_bytes))
    : 0;

  return {
    context_tokens: inputEvidence ? totalInput : null,
    input_tools_tokens: sectionTokens.tools,
    input_native_tools_tokens: toolKindTokens.native,
    input_mcp_tools_tokens: toolKindTokens.mcp,
    input_system_tokens: sectionTokens.system,
    input_first_message_tokens: sectionTokens.first_message,
    input_history_tokens: sectionTokens.history,
    input_tool_results_tokens: toolResultTokens,
    cache_read_tools_tokens: cacheRead.tools,
    cache_read_system_tokens: cacheRead.system,
    cache_read_first_message_tokens: cacheRead.first_message,
    cache_read_history_tokens: cacheRead.history,
    fresh_tools_tokens: fresh.tools,
    fresh_system_tokens: fresh.system,
    fresh_first_message_tokens: fresh.first_message,
    fresh_history_tokens: fresh.history,
  };
}

function numericTree(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const number = numeric(entry);
    if (number !== null) result[key] = number;
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nested = numericTree(entry, depth + 1);
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
}

function mergeUsage(current, next) {
  const incoming = numericTree(next);
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeUsage(current?.[key] && typeof current[key] === 'object' ? current[key] : {}, value)
      : value;
  }
  return merged;
}

function parseTimestampMilliseconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const number = Number(trimmed);
  if (Number.isFinite(number) && number >= 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLimitHeaders(headers) {
  const measurements = {};
  for (const [header, [name, kind]] of Object.entries(RATE_LIMIT_HEADERS)) {
    const raw = headerValue(headers, header);
    if (raw === null) continue;
    const value = kind === 'timestamp' ? parseTimestampMilliseconds(raw) : numeric(raw);
    if (value !== null) measurements[name] = value;
  }

  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== null) {
    const seconds = numeric(retryAfter);
    const timestamp = parseTimestampMilliseconds(retryAfter);
    if (seconds !== null) measurements.retry_after_ms = seconds * 1000;
    else if (timestamp !== null) measurements.retry_after_ms = Math.max(0, timestamp - Date.now());
  }

  let codexThrottle = null;
  for (const [name, rawValue] of Object.entries(headers || {})) {
    if (!/^x-codex-.*-used-percent$/i.test(name)) continue;
    const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    const value = typeof raw === 'string' ? numeric(raw.replace(/%$/, '').trim()) : numeric(raw);
    if (value !== null) codexThrottle = codexThrottle === null ? value : Math.max(codexThrottle, value);
  }
  if (codexThrottle !== null) measurements.codex_throttle_used_percent = codexThrottle;
  return measurements;
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normalizeLoopbackEndpoint(raw, appendLogsPath = false) {
  try {
    const endpoint = new URL(raw);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!isLoopbackHostname(hostname) || !['http:', 'https:'].includes(endpoint.protocol)) return null;
    if (hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    if (appendLogsPath) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1/logs`;
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint;
  } catch {
    return null;
  }
}

function resolveUsageEndpoint(environment = process.env) {
  const explicit = environment.CODEX_GATEWAY_USAGE_ENDPOINT;
  if (explicit === '0') return null;
  if (explicit) return normalizeLoopbackEndpoint(explicit);
  if (environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    return normalizeLoopbackEndpoint(environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
  }
  if (environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return normalizeLoopbackEndpoint(environment.OTEL_EXPORTER_OTLP_ENDPOINT, true);
  }
  return normalizeLoopbackEndpoint(DEFAULT_ENDPOINT);
}

function statusClass(statusCode) {
  if (!Number.isInteger(statusCode)) return 'unknown';
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return statusCode === 429 ? 'throttled' : 'client_error';
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  return 'other';
}

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value };
  return { stringValue: String(value) };
}

function buildOtlpLogPayload(record) {
  const attributes = Object.entries(record.attributes)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
  const logRecord = {
    timeUnixNano: String(BigInt(record.observedAt.getTime()) * 1000000n),
    observedTimeUnixNano: String(BigInt(record.observedAt.getTime()) * 1000000n),
    eventName: record.eventName,
    body: { stringValue: record.eventName },
    attributes,
  };
  if (record.traceId) logRecord.traceId = record.traceId;
  if (record.spanId) logRecord.spanId = record.spanId;
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'codex-gateway' } }] },
      scopeLogs: [{
        scope: { name: 'eigenwise.codex-gateway.usage', version: '1' },
        logRecords: [logRecord],
      }],
    }],
  };
}

function postOtlpLog(endpoint, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const body = JSON.stringify(payload);
    const client = endpoint.protocol === 'https:' ? https : http;
    const request = client.request(endpoint, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => response.resume());
    request.on('socket', (socket) => socket.unref());
    request.on('error', () => {});
    request.setTimeout(timeoutMs, () => request.destroy());
    request.end(body);
  } catch {}
}

function parseTraceparent(headers) {
  const value = headerValue(headers, 'traceparent');
  if (!value) return {};
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-[0-9a-f-]+)?$/.exec(value.trim());
  if (!match || match[1] === 'ff' || /^0{32}$/.test(match[2]) || /^0{16}$/.test(match[3])) return {};
  return { traceId: match[2], spanId: crypto.randomBytes(8).toString('hex') };
}

function providerRequestId(headers) {
  for (const name of ['request-id', 'x-request-id', 'x-codex-request-id']) {
    const value = safeIdentifier(headerValue(headers, name));
    if (value) return { value, source: 'response_header' };
  }
  return null;
}

function createUsageCapture(options) {
  const startedAt = options.startedAt || new Date();
  const started = options.started || process.hrtime.bigint();
  const maxResponseBytes = Math.max(1024, Number(options.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const composition = inputComposition(options.payload, options.requestBodyBytes);
  const requestHeaders = options.requestHeaders || {};
  const trace = parseTraceparent(requestHeaders);
  const fallbackRequestId = `gateway-request-${crypto.randomUUID()}`;
  let usage = {};
  let responseId = null;
  let responseModel = null;
  let responseMode = null;
  let responseStatus = null;
  let responseHeaders = {};
  let responseBytes = 0;
  let retainedBytes = 0;
  let retainedChunks = [];
  let overflowed = false;
  let finished = false;

  function observeIdentity(message) {
    if (!message || typeof message !== 'object') return;
    responseId = responseId || safeIdentifier(message.id);
    responseModel = responseModel || safeIdentifier(message.model);
  }

  function observeJson(body) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    responseBytes += buffer.length;
    if (buffer.length > maxResponseBytes) {
      overflowed = true;
      return;
    }
    try {
      const parsed = JSON.parse(buffer.toString());
      observeIdentity(parsed);
      usage = mergeUsage(usage, parsed.usage);
      responseMode = responseMode || 'json';
    } catch {}
  }

  function observeChunk(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
    responseBytes += buffer.length;
    if (overflowed) return;
    if (retainedBytes + buffer.length > maxResponseBytes) {
      overflowed = true;
      retainedChunks = [];
      retainedBytes = 0;
      return;
    }
    retainedChunks.push(Buffer.from(buffer));
    retainedBytes += buffer.length;
  }

  function finishJsonChunks() {
    if (retainedChunks.length === 0 || overflowed) return;
    const buffer = Buffer.concat(retainedChunks, retainedBytes);
    retainedChunks = [];
    retainedBytes = 0;
    try {
      const parsed = JSON.parse(buffer.toString());
      observeIdentity(parsed);
      usage = mergeUsage(usage, parsed.usage);
      responseMode = responseMode || 'json';
    } catch {}
  }

  function observeEvent(event) {
    if (overflowed || !event || typeof event !== 'object') return;
    responseMode = 'sse';
    if (event.type === 'message_start') {
      observeIdentity(event.message);
      usage = mergeUsage(usage, event.message?.usage);
    } else if (event.type === 'message_delta') {
      usage = mergeUsage(usage, event.usage);
    }
  }

  function markOverflow() {
    overflowed = true;
    retainedChunks = [];
    retainedBytes = 0;
  }

  function setResponse(statusCode, headers) {
    responseStatus = Number.isInteger(statusCode) ? statusCode : null;
    responseHeaders = headers || {};
  }

  function finish() {
    if (finished) return null;
    finished = true;
    finishJsonChunks();
    const limits = parseLimitHeaders(responseHeaders);
    const isSuccess = responseStatus >= 200 && responseStatus < 300;
    const exact = exactUsage(usage);
    const hasUsage = [exact.input_tokens, exact.output_tokens, exact.cache_read_tokens, exact.cache_creation_tokens]
      .some((value) => value !== null);
    if (isSuccess && (overflowed || !hasUsage)) return null;
    if (!isSuccess && Object.keys(limits).length === 0) return null;

    const requestIdEvidence = providerRequestId(responseHeaders)
      || (responseId ? { value: responseId, source: 'message_id' } : null)
      || { value: fallbackRequestId, source: 'generated' };
    const route = options.route || {};
    const backend = safeIdentifier(route.backend);
    const resolvedModel = backend === 'anthropic'
      ? responseModel || safeIdentifier(route.effectiveModel || route.model)
      : safeIdentifier(route.effectiveModel || route.model) || responseModel;
    const sourceEventId = `gateway-usage-${crypto.randomUUID()}`;
    const elapsed = process.hrtime.bigint() - started;
    const measurements = {
      duration_ms: Number(elapsed) / 1000000,
      response_body_bytes: responseBytes,
      ...limits,
    };
    if (isSuccess) {
      Object.assign(measurements, composition, exact, inputAttribution(composition, usage));
    }

    const eventName = isSuccess ? 'gateway.token.usage' : 'gateway.limit.signal';
    const attributes = {
      source: 'codex_gateway',
      source_event_id: sourceEventId,
      source_schema: 'gateway-usage-v1',
      // Both spellings: the collector's filter/signals matches the OTel
      // convention attributes["event.name"]; event_name stays for the
      // observer's existing column mapping.
      'event.name': eventName,
      event_name: eventName,
      request_id: requestIdEvidence.value,
      request_id_source: requestIdEvidence.source,
      client_request_id: safeIdentifier(headerValue(requestHeaders, 'x-claude-code-request-id'))
        || safeIdentifier(headerValue(requestHeaders, 'x-request-id')),
      session_id: safeIdentifier(headerValue(requestHeaders, 'x-claude-code-session-id')),
      agent_id: safeIdentifier(headerValue(requestHeaders, 'x-claude-code-agent-id')),
      parent_agent_id: safeIdentifier(headerValue(requestHeaders, 'x-claude-code-parent-agent-id')),
      agent_role: safeIdentifier(headerValue(requestHeaders, 'x-claude-code-agent-id')) ? 'executor' : 'orchestrator',
      model: resolvedModel,
      requested_model: safeIdentifier(route.requestedModel || route.selectedModel),
      backend,
      effort: EFFORTS.has(route.effort) ? route.effort : null,
      via: safeIdentifier(route.via),
      status: statusClass(responseStatus),
      status_code: responseStatus,
      response_mode: responseMode,
      token_estimator: isSuccess ? 'utf8_bytes_div_4_normalized' : null,
      cache_attribution: isSuccess ? 'prefix_order_estimate' : null,
      request_sequence: Number.isSafeInteger(options.sequence) ? options.sequence : null,
      ...measurements,
    };
    const record = {
      eventName,
      observedAt: options.now ? options.now() : new Date(),
      attributes,
      ...trace,
    };
    try { options.emit?.(record); } catch {}
    return record;
  }

  return {
    finish,
    markOverflow,
    noteResponseBytes(value) { responseBytes += Math.max(0, Number(value) || 0); },
    observeChunk,
    observeEvent,
    observeJson,
    setResponse,
    startedAt,
  };
}

function createGatewayUsageEmitter(options = {}) {
  const endpoint = options.endpoint === null
    ? null
    : options.endpoint instanceof URL
      ? options.endpoint
      : options.endpoint
        ? normalizeLoopbackEndpoint(options.endpoint)
        : resolveUsageEndpoint(options.environment || process.env);
  const timeoutMs = Math.max(10, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = Math.max(1024, Number(options.maxResponseBytes)
    || Number((options.environment || process.env).CODEX_GATEWAY_USAGE_MAX_RESPONSE_BYTES)
    || DEFAULT_MAX_RESPONSE_BYTES);
  const schedule = options.schedule || ((work) => {
    const immediate = setImmediate(work);
    immediate.unref?.();
    return immediate;
  });
  let sequence = 0;

  function emit(record) {
    if (!endpoint) return;
    const payload = buildOtlpLogPayload(record);
    schedule(() => postOtlpLog(endpoint, payload, timeoutMs));
  }

  return {
    enabled: !!endpoint,
    endpoint: endpoint ? endpoint.toString() : null,
    maxResponseBytes,
    start(input) {
      sequence += 1;
      return createUsageCapture({ ...input, sequence, maxResponseBytes, emit: options.emit || emit });
    },
  };
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
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
};
