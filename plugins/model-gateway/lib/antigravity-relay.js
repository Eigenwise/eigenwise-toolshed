'use strict';

const { pipeline, finished } = require('node:stream/promises');
const { replaceModelIdentity } = require('./json-model-identity.js');
const { readBoundedBody, openResponse } = require('./antigravity-discovery.js');
const { isReservedModel } = require('./antigravity-contract.js');

const LIMITS = Object.freeze({ frameBytes: 16 * 1024 * 1024, bodyBytes: 24 * 1024 * 1024,
  streamBytes: 32 * 1024 * 1024, deadlineMs: 900000 });
const PROTOCOL_HEADERS = ['anthropic-version', 'anthropic-beta', 'accept'];
const CORRELATION_HEADERS = ['x-request-id', 'x-claude-code-request-id', 'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id'];
const RESPONSE_HEADERS = ['content-type', 'retry-after', 'request-id', 'x-request-id', 'cache-control'];

function safeCorrelation(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
}

function requestHeaders(incoming, body) {
  const headers = { 'content-type': 'application/json', 'accept-encoding': 'identity', 'content-length': Buffer.byteLength(body) };
  for (const name of PROTOCOL_HEADERS) if (incoming[name] !== undefined) headers[name] = incoming[name];
  for (const name of CORRELATION_HEADERS) if (safeCorrelation(incoming[name])) headers[name] = incoming[name];
  return headers;
}

function responseHeaders(incoming, generation) {
  const headers = Object.fromEntries(RESPONSE_HEADERS.filter((name) => incoming[name] !== undefined).map((name) => [name, incoming[name]]));
  if (generation) headers['x-should-retry'] = 'false';
  return headers;
}

function isGeneration(req, body) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/messages') return false;
  try { return isReservedModel(JSON.parse(body).model); } catch { return false; }
}

function clientLifetime(req, res, deadlineMs = LIMITS.deadlineMs) {
  const controller = new AbortController();
  let cancelled = false;
  const cancel = () => {
    if (controller.signal.aborted) return;
    cancelled = true; controller.abort(new Error('Antigravity client cancelled'));
  };
  const close = () => { if (!res.writableFinished) cancel(); };
  req.once('aborted', cancel);
  res.once('close', close);
  const timer = setTimeout(() => controller.abort(new Error('Antigravity relay deadline exceeded')), deadlineMs);
  if (req.aborted || res.destroyed) cancel();
  return {
    signal: controller.signal,
    fail: (error) => controller.abort(error),
    cancelled: () => cancelled,
    dispose() { clearTimeout(timer); req.off('aborted', cancel); res.off('close', close); },
  };
}

function rewriteMessage(message, requestedModel) {
  if (message?.type !== 'message' || message.error) throw new Error('Antigravity returned an invalid message envelope');
  return { ...message, model: requestedModel };
}

function dataLines(frame) {
  return frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
}

function rewrittenFrame(frame, data) {
  const values = data.split('\n');
  const lines = frame.split(/(\r?\n)/);
  if (lines.filter((line) => line.startsWith('data:')).length !== values.length) {
    throw new Error('Antigravity identity rewrite changed SSE data-line structure');
  }
  let index = 0;
  return lines.map((line) => {
    if (!line.startsWith('data:')) return line;
    const prefix = line.startsWith('data: ') ? 'data: ' : 'data:';
    return prefix + values[index++];
  }).join('');
}

function noteNamedError(state, text) {
  if (/^event: *error\s*$/m.test(text)) state.failed = true;
}

function noteStreamFailure(state, event) {
  if (event.type === 'error') state.failed = true;
  if (state.terminal && event.type !== 'ping') state.failed = true;
}

function observeEvent(state, event) {
  noteStreamFailure(state, event);
  if (event.type === 'message_stop') state.terminal = true;
  if (event.type === 'message_start') state.started = true;
  state.observe?.(event);
}

function transformFrame(frame, separator, requestedModel, state) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  noteNamedError(state, text);
  const data = dataLines(text);
  if (!data.length) return Buffer.concat([frame, separator]);
  const raw = data.join('\n');
  const event = JSON.parse(raw);
  observeEvent(state, event);
  if (event.type !== 'message_start' || state.failed) return Buffer.concat([frame, separator]);
  rewriteMessage(event.message, requestedModel);
  const rewritten = replaceModelIdentity(raw, requestedModel, ['message', 'model']);
  return Buffer.concat([Buffer.from(rewrittenFrame(text, rewritten.toString())), separator]);
}

function frameBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf < 0 ? null : { index: crlf, size: 4 };
  return crlf >= 0 && crlf < lf ? { index: crlf, size: 4 } : { index: lf, size: 2 };
}

function checkBytes(bytes, bound, label) {
  if (bytes > bound) throw new Error(`Antigravity ${label} byte budget exceeded`);
}

function appendStreamChunk(state, chunk, limits, noteBytes) {
  state.total += chunk.length;
  noteBytes?.(chunk.length);
  checkBytes(state.total, limits.streamBytes, 'stream');
  state.pending = Buffer.concat([state.pending, chunk]);
}

function flushTerminalParts(state) {
  if (!state.terminalPartBytes) return;
  state.terminalChunks.push(Buffer.concat(state.terminalParts, state.terminalPartBytes));
  state.terminalParts = [];
  state.terminalPartBytes = 0;
}

function retainTerminalFrame(state, frame) {
  state.terminalParts.push(frame);
  state.terminalPartBytes += frame.length;
  // Every retained byte is already charged to the total stream budget. Coalesce
  // tiny post-terminal pings so retained object count is bounded as well.
  if (state.terminalPartBytes >= 64 * 1024) flushTerminalParts(state);
}

function* drainFrames(state, requestedModel, limits) {
  let boundary;
  while ((boundary = frameBoundary(state.pending))) {
    checkBytes(boundary.index + boundary.size, limits.frameBytes, 'frame');
    const frame = state.pending.subarray(0, boundary.index);
    const separator = state.pending.subarray(boundary.index, boundary.index + boundary.size);
    state.pending = state.pending.subarray(boundary.index + boundary.size);
    const transformed = transformFrame(frame, separator, requestedModel, state);
    if (state.terminal) retainTerminalFrame(state, transformed);
    else yield transformed;
  }
  checkBytes(state.pending.length, limits.frameBytes, 'frame');
}

function assertTerminal(state) {
  if (![state.pending.length === 0, state.started, state.terminal, !state.failed].every(Boolean)) throw new Error('Antigravity stream was incomplete or failed');
}

async function* transformSse(source, { requestedModel, limits = LIMITS, observe, noteBytes } = {}) {
  const state = { pending: Buffer.alloc(0), total: 0, started: false, terminal: false, failed: false, observe,
    terminalChunks: [], terminalParts: [], terminalPartBytes: 0 };
  for await (const chunk of source) {
    appendStreamChunk(state, chunk, limits, noteBytes);
    yield* drainFrames(state, requestedModel, limits);
  }
  // IncomingMessage iteration ends at clean HTTP-body EOF, not TCP socket
  // close. A client may finish immediately on message_stop, so release it only
  // after late frames, framing truncation and transport errors are ruled out.
  assertTerminal(state);
  flushTerminalParts(state);
  yield* state.terminalChunks;
}

function successful(status) { return status >= 200 && status < 300; }
function streamed(response) { return String(response.headers['content-type']).includes('text/event-stream'); }

function observeMessage(capture, message) {
  // Passing only the compact aggregate envelope keeps opaque carriers out of the
  // legacy observer and its independent 4MiB cap.
  capture?.observeEvent({ type: 'message_start', message: { id: message.id, model: message.model, usage: message.usage } });
}

async function relayJson(upstream, res, context) {
  const bytes = await readBoundedBody(upstream, context.limits.bodyBytes);
  context.usageCapture?.noteResponseBytes(bytes.length);
  let body = bytes;
  if (successful(upstream.statusCode) && context.generation) {
    const message = JSON.parse(bytes.toString());
    rewriteMessage(message, context.requestedModel);
    body = replaceModelIdentity(bytes, context.requestedModel);
    observeMessage(context.usageCapture, message);
  }
  res.writeHead(upstream.statusCode, { ...context.headers, 'content-length': body.length });
  res.end(body);
  await finished(res, { readable: false, cleanup: true, signal: context.signal });
}

async function* guardedSse(source, context) {
  try {
    yield* transformSse(source, { requestedModel: context.requestedModel, limits: context.limits,
      observe: (event) => context.usageCapture?.observeEvent(event),
      noteBytes: (bytes) => context.usageCapture?.noteResponseBytes(bytes) });
  } catch (error) { context.fail(error); throw error; }
}

async function relaySse(upstream, res, context) {
  res.writeHead(upstream.statusCode, context.headers);
  await pipeline(upstream, (source) => guardedSse(source, context), res, { signal: context.signal });
}

function assertIdentityEncoding(headers) {
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new Error('Antigravity returned an unsupported response encoding');
}

async function relayProxyResponse(upstream, res, context) {
  assertIdentityEncoding(upstream.headers);
  context.headers = responseHeaders(upstream.headers, context.generation);
  context.usageCapture?.setResponse(upstream.statusCode, upstream.headers);
  const transfer = successful(upstream.statusCode) && streamed(upstream) ? relaySse : relayJson;
  await transfer(upstream, res, context);
  context.routeTelemetry?.finish(upstream.statusCode);
  context.usageCapture?.finish();
}

function relayFailureMessage(generation) {
  return generation
    ? 'Antigravity response failed or exceeded a relay bound. No fallback or automatic resend was used; retry manually only if you want another generation.'
    : 'Antigravity count_tokens request failed or exceeded a relay bound. No other provider was used.';
}

function failRelay(res, context, lifetime) {
  context.usageCapture?.setResponseComplete(false);
  if (lifetime.cancelled()) return context.routeTelemetry?.cancel();
  context.routeTelemetry?.finish(502, 'upstream_error');
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: relayFailureMessage(context.generation) } });
  res.writeHead(502, { 'content-type': 'application/json', ...responseHeaders({}, context.generation) });
  res.end(body);
}

async function transferOwnedResponse(upstream, res, context, lifetime) {
  upstream.once('error', lifetime.fail);
  upstream.once('close', () => upstream.off('error', lifetime.fail));
  await relayProxyResponse(upstream, res, context);
}

async function forwardAntigravity(req, res, options) {
  const limits = { ...LIMITS, ...options.limits };
  const lifetime = options.lifetime || clientLifetime(req, res, limits.deadlineMs);
  const context = { ...options, limits, signal: lifetime.signal, fail: lifetime.fail, generation: req.url.split('?')[0] === '/v1/messages' };
  try {
    const upstream = await openResponse(`http://127.0.0.1:${options.port}${req.url}`, {
      method: req.method, headers: requestHeaders(req.headers, options.body), body: options.body, signal: lifetime.signal, agent: false,
    });
    await transferOwnedResponse(upstream, res, context, lifetime);
  } catch (error) { lifetime.fail(error); failRelay(res, context, lifetime); }
  finally { lifetime.dispose(); }
}

module.exports = { LIMITS, isGeneration, requestHeaders, responseHeaders, clientLifetime, rewriteMessage, transformSse,
  forwardAntigravity, failRelay };
