'use strict';

const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { clientLifetime, isGeneration, LIMITS } = require('./antigravity-relay.js');
const { isReservedModel } = require('./antigravity-contract.js');

function reservedRequest(body) {
  try { return isReservedModel(JSON.parse(body).model); } catch { return false; }
}

function workerResponse(req, body, context, lifetime) {
  return new Promise((resolve, reject) => {
    const port = context.getWorkerPort();
    if (!port) return reject(new Error('Antigravity worker is unavailable'));
    const upstream = context.httpClient.request({ host: '127.0.0.1', port, method: req.method, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` }, agent: context.agent, signal: lifetime.signal }, resolve);
    upstream.once('socket', (socket) => {
      if (!socket.connecting) context.delivered = true;
      else socket.once('connect', () => { context.delivered = true; });
    });
    upstream.once('error', reject);
    upstream.end(body);
  });
}

function responseFailure(res, context, error) {
  if (context.delivered) context.onWorkerRequestLost(error, context.worker);
  if (res.headersSent) return res.destroy();
  const message = context.generation
    ? 'Antigravity worker response was lost. No automatic resend was used because generation may have occurred; retry manually only if you want another generation.'
    : 'Antigravity worker is unavailable. No other provider was used.';
  res.writeHead(503, { 'content-type': 'application/json', ...(context.generation ? { 'x-should-retry': 'false' } : {}) });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

async function relayWorkerResponse(req, res, body, context, lifetime) {
  const upstream = await workerResponse(req, body, context, lifetime);
  upstream.once('error', lifetime.fail);
  upstream.once('close', () => upstream.off('error', lifetime.fail));
  const headers = { ...upstream.headers };
  if (context.generation) headers['x-should-retry'] = 'false';
  res.writeHead(upstream.statusCode || 502, headers);
  await pipeline(upstream, res, { signal: lifetime.signal });
}

async function relayAntigravityWorker(req, res, body, options) {
  const context = { httpClient: http, onWorkerRequestLost() {}, ...options,
    worker: options.getWorker(), generation: isGeneration(req, body), delivered: false };
  const lifetime = clientLifetime(req, res, options.limits?.deadlineMs || LIMITS.deadlineMs);
  try { await relayWorkerResponse(req, res, body, context, lifetime); }
  catch (error) { lifetime.fail(error); if (!lifetime.cancelled()) responseFailure(res, context, error); }
  finally { lifetime.dispose(); }
}

module.exports = { reservedRequest, relayAntigravityWorker };
