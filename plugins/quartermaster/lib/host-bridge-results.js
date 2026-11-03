'use strict';

const { createHash } = require('node:crypto');

const MAX_RESULT_FRAMES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBTYPES = new Set(['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']);
const TERMINAL_REASONS = new Set(['completed', 'max_turns', 'tool_deferred', 'aborted_streaming', 'aborted_tools', 'hook_stopped', 'stop_hook_prevented', 'background_requested', 'blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error', 'model_error', 'api_error', 'malformed_tool_use_exhausted', 'budget_exhausted', 'structured_output_retry_exhausted', 'tool_deferred_unavailable', 'turn_setup_failed']);
const STOP_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'tool_deferred']);
const ORIGIN_KINDS = new Set(['human', 'channel', 'peer', 'task-notification', 'coordinator', 'auto-continuation', 'unclassified']);
const ORIGIN_SUBKINDS = new Set(['scheduled-trigger', 'peer-send-message']);

function identifier(value) { return value == null ? null : typeof value === 'string' && UUID.test(value) ? value : '[invalid-id]'; }
function token(value, allowed) { return value == null ? null : allowed.has(value) ? value : '[other]'; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function resultMetadata(result, sequence) {
  const text = typeof result.result === 'string' ? result.result : '';
  return {
    sequence,
    receivedAt: new Date().toISOString(),
    resultIndexPresent: Object.hasOwn(result, 'result_index'),
    resultIndex: count(result.result_index),
    uuid: identifier(result.uuid),
    sessionId: identifier(result.session_id),
    subtype: token(result.subtype, SUBTYPES),
    isError: typeof result.is_error === 'boolean' ? result.is_error : null,
    terminalReason: token(result.terminal_reason, TERMINAL_REASONS),
    stopReason: token(result.stop_reason, STOP_REASONS),
    origin: result.origin && typeof result.origin === 'object' ? { kind: token(result.origin.kind, ORIGIN_KINDS), subkind: token(result.origin.subkind, ORIGIN_SUBKINDS) } : null,
    userMessageUuid: identifier(result.user_message_uuid),
    userMessageUuids: Array.isArray(result.user_message_uuids) ? result.user_message_uuids.slice(0, 16).map(identifier) : [],
    numTurns: count(result.num_turns),
    queuedTurnCount: count(result.queued_turn_count),
    permissionDenialCount: Array.isArray(result.permission_denials) ? result.permission_denials.length : 0,
    errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
    resultTextBytes: Buffer.byteLength(text),
    resultTextSha256: digest(text),
    envelopeSha256: digest(JSON.stringify(result)),
  };
}

function createResultCollector({ sessionId, sanitizeText = () => '[native error]' }) {
  const diagnostics = { format: null, received: 0, valid: 0, failedResults: 0, frames: [] };
  const errors = [];
  const permissionDenials = [];
  const seenResultUuids = new Set();
  let lastResult = null;
  let hasErrors = false;
  let hasDenials = false;
  let errorMessages = 0;
  const fail = (code, message) => ({ code, message });
  function record(result) {
    diagnostics.received += 1;
    if (diagnostics.frames.length < MAX_RESULT_FRAMES) diagnostics.frames.push(resultMetadata(result, diagnostics.received - 1));
    if (diagnostics.received > MAX_RESULT_FRAMES) return fail('result_limit', `Claude exceeded the ${MAX_RESULT_FRAMES}-result diagnostic limit.`);
    if (result.session_id !== sessionId) return fail('session_mismatch', 'Claude returned a different or missing result session ID; this bridge will not resume it.');
    if (typeof result.is_error !== 'boolean' || typeof result.subtype !== 'string' || !result.subtype || (result.subtype === 'success' && typeof result.result !== 'string')
      || (result.permission_denials !== undefined && !Array.isArray(result.permission_denials)) || (result.errors !== undefined && !Array.isArray(result.errors))) return fail('invalid_result', 'Claude emitted an invalid result envelope.');
    const indexed = Object.hasOwn(result, 'result_index');
    // Preserve native failures/denials even when a same-session frame later fails
    // sequence validation. Protocol failure must not erase useful refusal evidence.
    const nativeErrors = Array.isArray(result.errors) ? result.errors : [];
    const failed = result.is_error !== false || result.subtype !== 'success' || nativeErrors.length > 0;
    if (failed) {
      hasErrors = true; diagnostics.failedResults += 1;
      if (errorMessages < 20) {
        const messages = nativeErrors.length ? nativeErrors.slice(0, 20 - errorMessages).map((error) => sanitizeText(typeof error === 'string' ? error : '[non-string native error]', 2000)) : ['Native result reported an unsuccessful turn.'];
        errors.push({ resultIndex: indexed ? count(result.result_index) : null, subtype: token(result.subtype, SUBTYPES), messages });
        errorMessages += messages.length;
      }
    }
    if (result.permission_denials?.length) {
      hasDenials = true;
      for (const denial of result.permission_denials.slice(0, 100 - permissionDenials.length)) permissionDenials.push({ tool: sanitizeText(denial?.tool_name || denial?.tool || 'unknown', 120) });
    }
    const format = indexed ? 'indexed' : 'legacy';
    if (diagnostics.format && diagnostics.format !== format) return fail('mixed_result_format', 'Claude mixed indexed and legacy result envelopes.');
    diagnostics.format ||= format;
    if (indexed && (!Number.isSafeInteger(result.result_index) || result.result_index !== diagnostics.valid)) return fail('result_index_invalid', `Claude result_index must be contiguous and increasing from 0; expected ${diagnostics.valid}.`);
    if (!indexed && diagnostics.valid) return fail('duplicate_result', 'Claude emitted more than one legacy result without result_index correlation.');
    if (indexed && typeof result.uuid === 'string' && UUID.test(result.uuid)) {
      const uuid = result.uuid.toLowerCase();
      if (seenResultUuids.has(uuid)) return fail('duplicate_result_uuid', 'Claude repeated a result UUID under a new result_index.');
      seenResultUuids.add(uuid);
    }
    diagnostics.valid += 1;
    lastResult = result;
    return null;
  }
  return { diagnostics, errors, permissionDenials, record, get lastResult() { return lastResult; }, get hasErrors() { return hasErrors; }, get hasDenials() { return hasDenials; } };
}

module.exports = { MAX_RESULT_FRAMES, createResultCollector };
