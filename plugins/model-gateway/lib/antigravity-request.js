'use strict';

const contract = require('./antigravity-contract.js');
const { fetchCapabilities } = require('./antigravity-discovery.js');
const { clientLifetime, forwardAntigravity } = require('./antigravity-relay.js');
const { replaceModelIdentity } = require('./json-model-identity.js');

function parsePayload(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function replaceRequestModel(raw, target) {
  return replaceModelIdentity(raw, target);
}

function sendRefusal(res, status, message) {
  const body = JSON.stringify({ type: 'error', error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-should-retry': 'false' });
  res.end(body);
}

function dispatchRefusal(payload, { markers, identity, cache }) {
  if (contract.hasReservedRouteMarker(payload.messages)) return contract.LEGACY_REFUSAL;
  if (markers.length !== 0) return null;
  const cached = cache.peek(identity?.key) || cache.peek(identity?.parentKey);
  return contract.isReservedModel(cached?.model) ? contract.LEGACY_REFUSAL : null;
}

function admissionRefusal(snapshot, target) {
  const ready = contract.readiness(snapshot);
  if (!ready.ready) return ready.message;
  return snapshot.models.includes(target) ? null : `Antigravity model is not listed by the serving native backend. ${contract.FRESH_SESSION}`;
}

function directRoute(payload, target) {
  return { selectedModel: payload.model, effectiveModel: target, backend: 'antigravity', effort: null, fallback: false, via: 'direct' };
}

async function admitAndForward(req, res, payload, body, target, context) {
  const lifetime = clientLifetime(req, res);
  try {
    const snapshot = await fetchCapabilities({ port: context.port, signal: lifetime.signal });
    if (lifetime.signal.aborted) return;
    const refusal = admissionRefusal(snapshot, target);
    if (refusal) return sendRefusal(res, 503, refusal);
    context.onAdmitted?.(target, body.length);
    await forwardAntigravity(req, res, { port: context.port, body, requestedModel: payload.model, lifetime,
      routeTelemetry: context.routeTelemetry, usageCapture: context.startUsage?.(payload, target, body.length) });
  } finally { lifetime.dispose(); }
}

async function handleDirect(req, res, raw, payload, context) {
  let target;
  let body;
  try {
    target = contract.validateRequest({ method: req.method, pathname: req.url.split('?')[0], model: payload.model, headers: req.headers });
    body = replaceRequestModel(raw, target);
  } catch (error) { return sendRefusal(res, 400, error.message); }
  context.routeTelemetry.setRoute(directRoute(payload, target));
  try { await admitAndForward(req, res, payload, body, target, context); }
  catch { if (!res.headersSent) sendRefusal(res, 503, 'Antigravity native admission failed. No other provider was used.'); }
}

module.exports = { parsePayload, replaceRequestModel, sendRefusal, dispatchRefusal, handleDirect };
