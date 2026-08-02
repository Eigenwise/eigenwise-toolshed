'use strict';

const { EVENT_ATTRIBUTES } = require('../../../lib/observability/schema.js');

const ID = 'posthog';
const REGIONAL_HOSTS = new Set(['us.i.posthog.com', 'eu.i.posthog.com']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const IDENTITY_FIELDS = Object.freeze([
  'project_id', 'session_id', 'prompt_id', 'request_id', 'client_request_id', 'trace_id',
  'span_id', 'parent_span_id', 'workflow_run_id', 'agent_id', 'parent_agent_id',
  'tool_use_id', 'task_id', 'ticket_ref', 'route_id',
]);

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`PostHog numeric settings must be integers between 1 and ${maximum}.`);
  }
  return number;
}

function projectApiKey(value) {
  if (typeof value !== 'string' || !/^phc_[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('The PostHog sink requires a project API key beginning with phc_.');
  }
  return value;
}

function captureEndpoint(value, allowRemote) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('The PostHog sink requires observability.sinks.posthog.host.');
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The PostHog host must use HTTP(S).');
  if (url.username || url.password) throw new Error('Put the PostHog project API key in apiKey, not the host URL.');
  if (url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('The PostHog host must be an origin without a path, query, or fragment.');
  }
  const local = LOOPBACK_HOSTS.has(url.hostname);
  if (!local && !REGIONAL_HOSTS.has(url.hostname)) {
    throw new Error('The PostHog host must be the US or EU regional capture host.');
  }
  if (!local && url.protocol !== 'https:') throw new Error('A remote PostHog host must use HTTPS.');
  if (!local && allowRemote !== true) throw new Error('Remote PostHog egress requires allowRemote: true.');
  url.pathname = '/batch/';
  return { value: url.toString(), local };
}

function posthogEventName(eventName) {
  return `workbench.${eventName}`;
}

function mapObservation(observation) {
  const distinctId = observation.session_id || observation.project_id || `observation:${observation.event_id}`;
  const properties = {
    distinct_id: distinctId,
    $process_person_profile: false,
    workbench_event_id: observation.event_id,
    workbench_source: observation.source,
    workbench_source_schema: observation.source_schema,
  };
  if (observation.session_id) properties.$session_id = observation.session_id;
  for (const field of IDENTITY_FIELDS) {
    if (observation[field] !== null && observation[field] !== undefined) properties[`workbench_${field}`] = observation[field];
  }
  const allowedAttributes = new Set(EVENT_ATTRIBUTES[observation.event_name] || []);
  for (const [name, value] of Object.entries(observation.attributes || {})) {
    if (allowedAttributes.has(name)) properties[`workbench_attribute_${name}`] = value;
  }
  for (const measurement of observation.measurements || []) {
    if (measurement.value !== null) properties[`workbench_measurement_${measurement.name}`] = measurement.value;
  }
  return {
    event: posthogEventName(observation.event_name),
    timestamp: observation.observed_at,
    properties,
  };
}

function batchEncoder(apiKey) {
  return (events) => JSON.stringify({ api_key: apiKey, batch: events });
}

function resolve(config = {}) {
  const apiKey = projectApiKey(config.apiKey);
  const target = captureEndpoint(config.host, config.allowRemote);
  const batchSize = positiveInteger(config.batchSize, DEFAULT_BATCH_SIZE, 100);
  const maxAttempts = positiveInteger(config.maxAttempts, DEFAULT_MAX_ATTEMPTS, 100);
  const baseDelayMs = positiveInteger(config.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = positiveInteger(config.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  if (maxDelayMs < baseDelayMs) throw new Error('PostHog maxDelayMs must be at least baseDelayMs.');
  return {
    id: ID,
    egress: target.local ? 'loopback' : 'remote',
    collectorExporter: null,
    outbox: {
      enabled: true,
      endpoint: target.value,
      headers: {},
      allowRemote: !target.local,
      batchSize,
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      mapObservation,
      encodeBatch: batchEncoder(apiKey),
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
  mapObservation,
  posthogEventName,
  resolve,
  setup,
  teardown,
};
