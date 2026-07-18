'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function assertLoopbackUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`OTLP endpoint must use loopback HTTP(S), received ${url.origin}.`);
  }
  if (url.username || url.password) throw new Error('OTLP endpoint credentials are not allowed.');
  return url;
}

function retryTime(now, attempts, baseDelayMs, maxDelayMs) {
  const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempts, 16)));
  return new Date(now.getTime() + delay).toISOString();
}

async function flushOutbox(store, options = {}) {
  if (!store || typeof store.pendingOutbox !== 'function') throw new TypeError('A Workbench observability store is required.');
  const endpoint = assertLoopbackUrl(options.endpoint || 'http://127.0.0.1:14318/v1/logs');
  const send = options.fetch || globalThis.fetch;
  if (typeof send !== 'function') throw new TypeError('A fetch implementation is required.');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 8);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 1000);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 60_000);
  const rows = store.pendingOutbox({ limit: options.limit || 100, at: now.toISOString() });
  const result = { selected: rows.length, delivered: 0, failed: 0, exhausted: 0 };

  for (const row of rows) {
    try {
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: row.payload_json,
        signal: options.signal,
      });
      if (response.ok) {
        store.acknowledgeOutbox([row.id]);
        result.delivered += 1;
        continue;
      }
      const nextAttempts = Number(row.attempts) + 1;
      store.failOutbox(row.id, `http_${response.status}`, {
        maxAttempts,
        retryAt: retryTime(now, Number(row.attempts), baseDelayMs, maxDelayMs),
      });
      result.failed += 1;
      if (nextAttempts >= maxAttempts) result.exhausted += 1;
    } catch (error) {
      const nextAttempts = Number(row.attempts) + 1;
      const code = error && typeof error.name === 'string'
        ? `transport_${error.name.toLowerCase()}`
        : 'transport_error';
      store.failOutbox(row.id, code, {
        maxAttempts,
        retryAt: retryTime(now, Number(row.attempts), baseDelayMs, maxDelayMs),
      });
      result.failed += 1;
      if (nextAttempts >= maxAttempts) result.exhausted += 1;
    }
  }

  return result;
}

function createOutboxDrainer(store, options = {}) {
  let active = null;
  return {
    flush() {
      if (!active) active = flushOutbox(store, options).finally(() => { active = null; });
      return active;
    },
  };
}

module.exports = {
  assertLoopbackUrl,
  createOutboxDrainer,
  flushOutbox,
};
