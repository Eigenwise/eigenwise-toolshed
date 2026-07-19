#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { spool, defaultSpoolPath } = require('../hooks/observability.js');

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

// A measurement that is genuinely unavailable (e.g. before the first response or
// right after a compact) is null with quality 'unavailable', never a fabricated zero.
function measure(name, value, unit, scope, quality) {
  if (value === null) return { name, value: null, unit, scope, quality: 'unavailable' };
  return { name, value, unit, scope, quality };
}

function buildStatuslineObservations(payload, now) {
  if (!payload || typeof payload !== 'object') return [];
  const observedAt = (now instanceof Date ? now : new Date()).toISOString();
  const sessionId = identifier(first(payload.session_id, payload.sessionId));
  const model = identifier(first(payload.model && payload.model.id, payload.model && payload.model.display_name, payload.model));

  const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
  const cost = payload.cost && typeof payload.cost === 'object' ? payload.cost : {};
  const rate = payload.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : {};

  const contextTokens = nonNegative(first(context.used_tokens, context.usedTokens, context.current_usage, context.tokens));
  const windowTokens = nonNegative(first(context.window_tokens, context.windowTokens, context.context_window, context.window));

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
      measure('cost_usd', nonNegative(first(cost.total_cost_usd, cost.totalCostUsd)), 'usd', 'session', 'estimate'),
      measure('duration_ms', nonNegative(first(cost.total_duration_ms, cost.totalDurationMs)), 'ms', 'session', 'exact_client'),
    ],
  };
  if (sessionId) contextSnapshot.session_id = sessionId;

  const observations = [contextSnapshot];

  const percent = nonNegative(first(rate.percent, rate.used_percent, rate.usedPercent));
  const resetMs = nonNegative(first(rate.reset_ms, rate.resetMs, rate.reset_in_ms));
  if (percent !== null || resetMs !== null || Object.keys(rate).length > 0) {
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
    const result = spawnSync(command, { input: raw, shell: true, encoding: 'utf8', timeout: 2000 });
    return typeof result.stdout === 'string' ? result.stdout : '';
  } catch {
    return '';
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let rendered = '';
  try { rendered = renderPassthrough(raw); } catch { rendered = ''; }
  process.stdout.write(rendered);
  try {
    const payload = JSON.parse(raw);
    for (const observation of buildStatuslineObservations(payload, new Date())) {
      spool(process.env.WORKBENCH_HOOK_SPOOL || defaultSpoolPath(), observation);
    }
  } catch {
    // Fail open: the statusline must render regardless of observability.
  }
}

if (require.main === module) main();

module.exports = { buildStatuslineObservations, renderPassthrough };
