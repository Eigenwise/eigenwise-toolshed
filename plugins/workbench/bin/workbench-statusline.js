#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { spool, defaultSpoolPath } = require('../hooks/observability.js');
const { estimateRequestBodyBytes, formatRequestBodyStatus } = require('../lib/observability/request-body.js');

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function rateLimitWindow(rateLimits, name) {
  const window = rateLimits && typeof rateLimits[name] === 'object' ? rateLimits[name] : {};
  const usedPercentage = nonNegative(window.used_percentage);
  const resetsAtSeconds = nonNegative(window.resets_at);
  return {
    usedPercentage,
    resetsAtMs: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    available: usedPercentage !== null || resetsAtSeconds !== null,
  };
}

// A measurement that is genuinely unavailable (e.g. before the first response or
// right after a compact) is null with quality 'unavailable', never a fabricated zero.
function measure(name, value, unit, scope, quality) {
  if (value === null) return { name, value: null, unit, scope, quality: 'unavailable' };
  return { name, value, unit, scope, quality };
}

function buildStatuslineObservations(payload, now, suppliedRequestBodyEstimate) {
  if (!payload || typeof payload !== 'object') return [];
  const observedAt = (now instanceof Date ? now : new Date()).toISOString();
  const sessionId = identifier(first(payload.session_id, payload.sessionId));
  const model = identifier(first(payload.model && payload.model.id, payload.model && payload.model.display_name, payload.model));
  const requestBodyEstimate = suppliedRequestBodyEstimate === undefined
    ? estimateRequestBodyBytes(payload.transcript_path)
    : suppliedRequestBodyEstimate;

  const context = payload.context_window && typeof payload.context_window === 'object'
    ? payload.context_window
    : (payload.context && typeof payload.context === 'object' ? payload.context : {});
  const cost = payload.cost && typeof payload.cost === 'object' ? payload.cost : {};
  const rate = payload.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : {};
  const rateLimits = payload.rate_limits && typeof payload.rate_limits === 'object' ? payload.rate_limits : {};
  const fiveHour = rateLimitWindow(rateLimits, 'five_hour');
  const sevenDay = rateLimitWindow(rateLimits, 'seven_day');

  const contextTokens = nonNegative(first(
    context.used_tokens,
    context.usedTokens,
    context.total_input_tokens,
    context.current_usage && context.current_usage.input_tokens,
    context.current_usage,
    context.tokens,
  ));
  const windowTokens = nonNegative(first(
    context.window_tokens,
    context.windowTokens,
    context.context_window_size,
    context.context_window,
    context.window,
  ));

  const snapshotAttributes = {};
  if (model) snapshotAttributes.model = model;
  const contextSnapshot = {
    source: 'statusline',
    source_event_id: `statusline_ctx_${observedAt}_${sessionId || 'unknown'}`,
    source_schema: 'statusline-v1',
    observed_at: observedAt,
    event_name: 'statusline.context_snapshot',
    attributes: snapshotAttributes,
    measurements: [
      measure('context_tokens', contextTokens, 'tokens', 'context_snapshot', 'exact_client'),
      measure('context_window_tokens', windowTokens, 'tokens', 'context_snapshot', 'exact_client'),
      measure('request_body_bytes', requestBodyEstimate ? requestBodyEstimate.value : null, 'bytes', 'context_snapshot', 'estimate'),
      measure('cost_usd', nonNegative(first(cost.total_cost_usd, cost.totalCostUsd)), 'usd', 'session', 'estimate'),
      measure('duration_ms', nonNegative(first(cost.total_duration_ms, cost.totalDurationMs)), 'ms', 'session', 'exact_client'),
    ],
  };
  if (sessionId) contextSnapshot.session_id = sessionId;

  const observations = [contextSnapshot];

  const percent = nonNegative(first(rate.percent, rate.used_percent, rate.usedPercent));
  const resetMs = nonNegative(first(rate.reset_ms, rate.resetMs, rate.reset_in_ms));
  if (percent !== null || resetMs !== null || Object.keys(rate).length > 0 || fiveHour.available || sevenDay.available) {
    const rateAttributes = {};
    if (model) rateAttributes.model = model;
    const rateLimit = {
      source: 'statusline',
      source_event_id: `statusline_rate_${observedAt}_${sessionId || 'unknown'}`,
      source_schema: 'statusline-v1',
      observed_at: observedAt,
      event_name: 'statusline.rate_limit',
      attributes: rateAttributes,
      measurements: [
        measure('rate_limit_percent', percent, 'percent', 'context_snapshot', 'exact_client'),
        measure('rate_limit_reset_ms', resetMs, 'ms', 'context_snapshot', 'exact_client'),
        measure('rate_limit_five_hour_used_percent', fiveHour.usedPercentage, 'percent', 'context_snapshot', 'exact_client'),
        measure('rate_limit_five_hour_reset_at_ms', fiveHour.resetsAtMs, 'ms', 'context_snapshot', 'exact_client'),
        measure('rate_limit_seven_day_used_percent', sevenDay.usedPercentage, 'percent', 'context_snapshot', 'exact_client'),
        measure('rate_limit_seven_day_reset_at_ms', sevenDay.resetsAtMs, 'ms', 'context_snapshot', 'exact_client'),
      ],
    };
    if (sessionId) rateLimit.session_id = sessionId;
    observations.push(rateLimit);
  }
  return observations;
}

// Preserve whatever statusline the user configured: run it with the same stdin and
// pass its output straight through. The observability tee never changes the render.
function renderPassthrough(raw) {
  const command = process.env.WORKBENCH_STATUSLINE_RENDER;
  if (!command) return '';
  try {
    const result = spawnSync(command, { input: raw, shell: true, encoding: 'utf8', timeout: 2000, windowsHide: true });
    return typeof result.stdout === 'string' ? result.stdout : '';
  } catch {
    return '';
  }
}

function formatRateLimitStatus(payload) {
  const rateLimits = payload && typeof payload.rate_limits === 'object' ? payload.rate_limits : {};
  const windows = [
    ['5h', rateLimitWindow(rateLimits, 'five_hour')],
    ['7d', rateLimitWindow(rateLimits, 'seven_day')],
  ];
  return windows
    .filter(([, window]) => window.usedPercentage !== null)
    .map(([label, window]) => `${label}: ${Math.round(window.usedPercentage)}%`)
    .join(' ');
}

function statuslinePayload(raw, suppliedPayload) {
  if (suppliedPayload && typeof suppliedPayload === 'object') return suppliedPayload;
  try { return JSON.parse(raw); } catch { return null; }
}

function renderStatusline(raw, requestBodyEstimate, suppliedPayload) {
  const rendered = renderPassthrough(raw).trimEnd();
  const additions = [
    formatRequestBodyStatus(requestBodyEstimate),
    formatRateLimitStatus(statuslinePayload(raw, suppliedPayload)),
  ].filter(Boolean);
  return [rendered, ...additions].filter(Boolean).join(' | ');
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const payload = JSON.parse(raw);
    const requestBodyEstimate = estimateRequestBodyBytes(payload.transcript_path);
    process.stdout.write(renderStatusline(raw, requestBodyEstimate, payload));
    for (const observation of buildStatuslineObservations(payload, new Date(), requestBodyEstimate)) {
      spool(process.env.WORKBENCH_HOOK_SPOOL || defaultSpoolPath(), observation);
    }
  } catch {
    process.stdout.write(renderPassthrough(raw));
  }
}

if (require.main === module) main();

module.exports = { buildStatuslineObservations, formatRateLimitStatus, renderPassthrough, renderStatusline };
