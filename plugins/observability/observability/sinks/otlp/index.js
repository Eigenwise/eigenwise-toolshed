'use strict';

const ID = 'otlp';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(['content-length', 'content-type', 'host']);

function endpoint(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('The OTLP sink requires observability.sinks.otlp.endpoint.');
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The OTLP sink endpoint must use HTTP(S).');
  if (url.username || url.password) throw new Error('Put OTLP credentials in headers, not the endpoint URL.');
  if (url.search || url.hash) throw new Error('The OTLP sink base endpoint cannot include a query or fragment.');
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && url.protocol !== 'https:') throw new Error('A remote OTLP sink endpoint must use HTTPS.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return { value: url.toString(), local };
}

function headers(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('observability.sinks.otlp.headers must be an object of string values.');
  }
  const normalized = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower)) throw new Error(`Invalid OTLP header name: ${name}`);
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new Error(`OTLP header ${name} must be a single-line string.`);
    }
    normalized[name] = headerValue;
  }
  return normalized;
}

function signalEndpoint(base, signal) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}/v1/${signal}`;
  return url.toString();
}

function resolve(config = {}) {
  const target = endpoint(config.endpoint);
  const requestHeaders = headers(config.headers);
  const collectorExporter = {
    endpoint: target.value,
    headers: requestHeaders,
    allowRemote: !target.local,
  };
  return {
    id: ID,
    egress: target.local ? 'loopback' : 'remote',
    collectorExporter,
    outbox: {
      enabled: true,
      endpoint: signalEndpoint(target.value, 'logs'),
      headers: requestHeaders,
      allowRemote: !target.local,
    },
  };
}

function setup(config = {}) {
  const runtime = resolve(config);
  return { configured: true, egress: runtime.egress };
}

function teardown() {
  return { configured: false };
}

module.exports = {
  ID,
  resolve,
  setup,
  teardown,
};
