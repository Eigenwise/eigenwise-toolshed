'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const TEST_DEFAULT_PORTS = new Set([4318, 14318, 14319]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(['content-length', 'content-type', 'host']);
const DEFAULT_TIMEOUT_MS = 5_000;

function assertOtlpUrl(value, options = {}) {
  const url = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`OTLP endpoint must use HTTP(S), received ${url.protocol}`);
  if (url.username || url.password) throw new Error('OTLP endpoint credentials are not allowed.');
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && options.allowRemote !== true) {
    throw new Error(`OTLP endpoint must use loopback HTTP(S) unless remote egress is explicit, received ${url.origin}.`);
  }
  if (!local && url.protocol !== 'https:') throw new Error('A remote OTLP endpoint must use HTTPS.');
  return url;
}

function assertLoopbackUrl(value) {
  return assertOtlpUrl(value);
}

function assertNoTestDefaultPort(value) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const url = value instanceof URL ? value : new URL(value);
  if (LOOPBACK_HOSTS.has(url.hostname) && TEST_DEFAULT_PORTS.has(Number(url.port))) {
    throw new Error(`Tests must use an explicit ephemeral receiver, received ${url.origin}.`);
  }
}

function requestHeaders(value) {
  if (value === undefined) return { 'content-type': 'application/json' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OTLP headers must be an object.');
  const result = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower)) throw new Error(`Invalid OTLP header name: ${name}`);
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) throw new Error(`OTLP header ${name} must be a single-line string.`);
    result[name] = headerValue;
  }
  result['content-type'] = 'application/json';
  return result;
}

function retryTime(now, attempts, baseDelayMs, maxDelayMs) {
  const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempts, 16)));
  return new Date(now.getTime() + delay).toISOString();
}

function positiveTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

function requestSignal(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function sendWithDeadline(send, endpoint, request, signal) {
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([Promise.resolve().then(() => send(endpoint, request)), aborted]);
}

function boundDuration(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function flushOutbox(store, options = {}) {
  if (!store || typeof store.pendingOutbox !== 'function') throw new TypeError('A Workbench observability store is required.');
  if (options.enabled === false) {
    return { selected: 0, delivered: 0, failed: 0, exhausted: 0, disabled: true };
  }
  const endpoint = assertOtlpUrl(options.endpoint || 'http://127.0.0.1:14318/v1/logs', {
    allowRemote: options.allowRemote === true,
  });
  assertNoTestDefaultPort(endpoint);
  const send = options.fetch || globalThis.fetch;
  if (typeof send !== 'function') throw new TypeError('A fetch implementation is required.');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 8);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 1000);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || 60_000);
  const rows = store.pendingOutbox({ limit: options.limit || 100, at: now.toISOString() });
  const result = { selected: rows.length, delivered: 0, failed: 0, exhausted: 0 };
  const headers = requestHeaders(options.headers);
  const signal = requestSignal(options.signal, positiveTimeout(options.timeoutMs));

  for (const row of rows) {
    try {
      const response = await sendWithDeadline(send, endpoint, {
        method: 'POST',
        headers,
        body: row.payload_json,
        redirect: 'error',
        signal,
      }, signal);
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
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const drainTimeoutMs = positiveTimeout(options.drainTimeoutMs, timeoutMs + 1_000);
  return {
    flush() {
      if (active) return active;
      const next = boundDuration(flushOutbox(store, options), drainTimeoutMs).finally(() => {
        if (active === next) active = null;
      });
      active = next;
      return next;
    },
  };
}

module.exports = {
  assertLoopbackUrl,
  assertNoTestDefaultPort,
  assertOtlpUrl,
  createOutboxDrainer,
  flushOutbox,
};
