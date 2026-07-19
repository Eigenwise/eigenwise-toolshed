'use strict';

const { randomUUID } = require('node:crypto');
const {
  ALLOWED_EVENTS,
  ALLOWED_MEASUREMENTS,
  ALLOWED_SOURCES,
  ALLOWED_UNITS,
  ATTRIBUTE_SPECS,
  EVENT_ATTRIBUTES,
  LINK_METHODS,
  LINK_QUALITIES,
  LINK_RELATIONS,
  LINK_TARGET_KINDS,
  MEASUREMENT_QUALITIES,
  MEASUREMENT_SCOPES,
} = require('./schema.js');

const TOP_LEVEL_FIELDS = new Set([
  'event_id',
  'source',
  'source_event_id',
  'source_schema',
  'observed_at',
  'emitted_at',
  'event_name',
  'sequence',
  'project_id',
  'session_id',
  'prompt_id',
  'request_id',
  'client_request_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'workflow_run_id',
  'agent_id',
  'parent_agent_id',
  'tool_use_id',
  'task_id',
  'ticket_ref',
  'route_id',
  'attributes',
  'measurements',
  'links',
]);

const IDENTIFIER_FIELDS = [
  'event_id',
  'source_event_id',
  'source_schema',
  'session_id',
  'prompt_id',
  'request_id',
  'client_request_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'workflow_run_id',
  'agent_id',
  'parent_agent_id',
  'tool_use_id',
  'task_id',
  'ticket_ref',
  'route_id',
];

const OPTIONAL_IDENTIFIER_FIELDS = new Set(IDENTIFIER_FIELDS.filter((field) => ![
  'source_event_id',
  'source_schema',
].includes(field)));

const LINK_FIELDS = new Set(['relation', 'to_kind', 'to_id', 'method', 'quality']);
const MEASUREMENT_FIELDS = new Set(['name', 'value', 'unit', 'scope', 'quality']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@\[\]-]{0,254}$/;
const SAFE_PROJECT_ID = /^(?:[a-f0-9]{32,128}|hmac:[A-Za-z0-9_-]{22,128})$/;
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,127}$/;
const SAFE_STATUS = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DECISIONS = new Set(['allow', 'deny', 'ask', 'block']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function safeFieldName(name) {
  const text = String(name);
  return SAFE_FIELD_NAME.test(text) ? text : 'invalid_field_name';
}

function addField(target, name) {
  target.add(safeFieldName(name));
}

function validIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
}

function validTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function validateAttribute(spec, value) {
  if (spec === 'identifier') return validIdentifier(value);
  if (spec === 'effort') return typeof value === 'string' && EFFORTS.has(value);
  if (spec === 'boolean') return typeof value === 'boolean';
  if (spec === 'status') return typeof value === 'string' && SAFE_STATUS.test(value);
  if (spec === 'decision') return typeof value === 'string' && DECISIONS.has(value);
  if (spec === 'nonnegative_integer') return Number.isSafeInteger(value) && value >= 0;
  if (spec === 'field_names') {
    return Array.isArray(value) && value.length <= 128
      && value.every((field) => typeof field === 'string' && SAFE_FIELD_NAME.test(field));
  }
  return false;
}

function normalizeMeasurements(input, droppedFields, rejectedFields) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    addField(rejectedFields, 'measurements');
    return [];
  }

  const measurements = [];
  const seen = new Set();
  input.forEach((measurement, index) => {
    const prefix = `measurements[${index}]`;
    if (!isPlainObject(measurement)) {
      addField(rejectedFields, prefix);
      return;
    }
    for (const field of Object.keys(measurement)) {
      if (!MEASUREMENT_FIELDS.has(field)) addField(droppedFields, `${prefix}.${field}`);
    }

    for (const field of ['name', 'unit', 'scope', 'quality']) {
      if (typeof measurement[field] !== 'string') addField(rejectedFields, `${prefix}.${field}`);
    }
    if (!ALLOWED_MEASUREMENTS.includes(measurement.name)) addField(rejectedFields, `${prefix}.name`);
    if (!ALLOWED_UNITS.includes(measurement.unit)) addField(rejectedFields, `${prefix}.unit`);
    if (!MEASUREMENT_SCOPES.includes(measurement.scope)) addField(rejectedFields, `${prefix}.scope`);
    if (!MEASUREMENT_QUALITIES.includes(measurement.quality)) addField(rejectedFields, `${prefix}.quality`);

    const unavailable = measurement.quality === 'unavailable';
    if (unavailable) {
      if (measurement.value !== undefined && measurement.value !== null) addField(rejectedFields, `${prefix}.value`);
    } else if (typeof measurement.value !== 'number' || !Number.isFinite(measurement.value)) {
      addField(rejectedFields, `${prefix}.value`);
    } else if (measurement.value < 0 && measurement.name !== 'context_delta_tokens') {
      addField(rejectedFields, `${prefix}.value`);
    }

    if (measurement.name === 'cost_usd' && !['estimate', 'unavailable'].includes(measurement.quality)) {
      addField(rejectedFields, `${prefix}.quality`);
    }
    if (['pre_tokens', 'post_tokens', 'result_tokens'].includes(measurement.name)
      && !['estimate', 'unavailable'].includes(measurement.quality)) {
      addField(rejectedFields, `${prefix}.quality`);
    }
    if (measurement.name === 'context_delta_tokens'
      && !['derived_exact', 'inferred', 'unavailable'].includes(measurement.quality)) {
      addField(rejectedFields, `${prefix}.quality`);
    }

    const dedupeKey = `${measurement.name}:${measurement.scope}`;
    if (seen.has(dedupeKey)) addField(rejectedFields, `${prefix}.name`);
    seen.add(dedupeKey);

    measurements.push({
      name: measurement.name,
      value: unavailable ? null : measurement.value,
      unit: measurement.unit,
      scope: measurement.scope,
      quality: measurement.quality,
    });
  });

  return measurements.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizeLinks(input, droppedFields, rejectedFields) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    addField(rejectedFields, 'links');
    return [];
  }

  const links = [];
  const seen = new Set();
  input.forEach((link, index) => {
    const prefix = `links[${index}]`;
    if (!isPlainObject(link)) {
      addField(rejectedFields, prefix);
      return;
    }
    for (const field of Object.keys(link)) {
      if (!LINK_FIELDS.has(field)) addField(droppedFields, `${prefix}.${field}`);
    }

    if (!LINK_RELATIONS.includes(link.relation)) addField(rejectedFields, `${prefix}.relation`);
    if (!LINK_TARGET_KINDS.includes(link.to_kind)) addField(rejectedFields, `${prefix}.to_kind`);
    if (!validIdentifier(link.to_id)) addField(rejectedFields, `${prefix}.to_id`);
    if (!LINK_METHODS.includes(link.method)) addField(rejectedFields, `${prefix}.method`);
    if (!LINK_QUALITIES.includes(link.quality)) addField(rejectedFields, `${prefix}.quality`);
    if (link.method === 'temporal_inference' && link.quality !== 'inferred') addField(rejectedFields, `${prefix}.quality`);
    if (link.method === 'unlinked' && link.quality !== 'unavailable') addField(rejectedFields, `${prefix}.quality`);

    const normalized = {
      relation: link.relation,
      to_kind: link.to_kind,
      to_id: link.to_id,
      method: link.method,
      quality: link.quality,
    };
    const dedupeKey = stableStringify(normalized);
    if (seen.has(dedupeKey)) addField(rejectedFields, prefix);
    seen.add(dedupeKey);
    links.push(normalized);
  });

  return links.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizeObservation(input, options = {}) {
  const now = options.now || (() => new Date());
  const createId = options.randomUUID || randomUUID;
  const droppedFields = new Set();
  const rejectedFields = new Set();

  if (!isPlainObject(input)) {
    return {
      accepted: false,
      droppedFields: [],
      rejectedFields: ['observation'],
      observation: null,
      measurements: [],
      links: [],
      fingerprint: null,
      dropContext: { observed_at: now().toISOString() },
    };
  }

  for (const field of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(field)) addField(droppedFields, field);
  }

  if (!ALLOWED_SOURCES.includes(input.source)) addField(rejectedFields, 'source');
  if (!ALLOWED_EVENTS.includes(input.event_name)) addField(rejectedFields, 'event_name');
  if (['schema_drop', 'telemetry_conflict'].includes(input.event_name) && input.source !== 'workbench') {
    addField(rejectedFields, 'event_name');
  }

  const observedAt = validTimestamp(input.observed_at);
  if (!observedAt) addField(rejectedFields, 'observed_at');
  const emittedAt = input.emitted_at === undefined || input.emitted_at === null
    ? null
    : validTimestamp(input.emitted_at);
  if (input.emitted_at !== undefined && input.emitted_at !== null && !emittedAt) addField(rejectedFields, 'emitted_at');

  for (const field of IDENTIFIER_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      if (!OPTIONAL_IDENTIFIER_FIELDS.has(field)) addField(rejectedFields, field);
      continue;
    }
    if (!validIdentifier(value)) addField(rejectedFields, field);
  }

  if (input.project_id !== undefined && input.project_id !== null && !SAFE_PROJECT_ID.test(input.project_id)) {
    addField(rejectedFields, 'project_id');
  }
  if (input.sequence !== undefined && input.sequence !== null
    && (!Number.isSafeInteger(input.sequence) || input.sequence < 0)) {
    addField(rejectedFields, 'sequence');
  }

  const attributes = {};
  if (input.attributes !== undefined && !isPlainObject(input.attributes)) {
    addField(rejectedFields, 'attributes');
  } else if (isPlainObject(input.attributes)) {
    const allowed = new Set(EVENT_ATTRIBUTES[input.event_name] || []);
    for (const [field, value] of Object.entries(input.attributes)) {
      if (!allowed.has(field) || !ATTRIBUTE_SPECS[field]) {
        addField(droppedFields, `attributes.${field}`);
        continue;
      }
      if (!validateAttribute(ATTRIBUTE_SPECS[field], value)) {
        addField(rejectedFields, `attributes.${field}`);
        continue;
      }
      attributes[field] = ATTRIBUTE_SPECS[field] === 'field_names'
        ? [...new Set(value.map(safeFieldName))].sort()
        : value;
    }
  }

  const measurements = normalizeMeasurements(input.measurements, droppedFields, rejectedFields);
  const links = normalizeLinks(input.links, droppedFields, rejectedFields);
  const safeInputIdentifier = (field) => validIdentifier(input[field]) ? input[field] : null;
  const eventId = validIdentifier(input.event_id) ? input.event_id : createId();
  const observation = {
    event_id: eventId,
    source: input.source,
    source_event_id: input.source_event_id,
    source_schema: input.source_schema,
    observed_at: observedAt,
    emitted_at: emittedAt,
    event_name: input.event_name,
    sequence: input.sequence === undefined ? null : input.sequence,
    project_id: typeof input.project_id === 'string' && SAFE_PROJECT_ID.test(input.project_id) ? input.project_id : null,
    session_id: safeInputIdentifier('session_id'),
    prompt_id: safeInputIdentifier('prompt_id'),
    request_id: safeInputIdentifier('request_id'),
    client_request_id: safeInputIdentifier('client_request_id'),
    trace_id: safeInputIdentifier('trace_id'),
    span_id: safeInputIdentifier('span_id'),
    parent_span_id: safeInputIdentifier('parent_span_id'),
    workflow_run_id: safeInputIdentifier('workflow_run_id'),
    agent_id: safeInputIdentifier('agent_id'),
    parent_agent_id: safeInputIdentifier('parent_agent_id'),
    tool_use_id: safeInputIdentifier('tool_use_id'),
    task_id: safeInputIdentifier('task_id'),
    ticket_ref: safeInputIdentifier('ticket_ref'),
    route_id: safeInputIdentifier('route_id'),
    attributes,
  };

  const dropped = [...droppedFields].sort();
  const rejected = [...rejectedFields].sort();
  const fingerprint = rejected.length === 0
    ? stableStringify({
      observation: Object.fromEntries(Object.entries(observation).filter(([key]) => key !== 'event_id')),
      measurements,
      links,
    })
    : null;

  return {
    accepted: rejected.length === 0,
    droppedFields: dropped,
    rejectedFields: rejected,
    observation,
    measurements,
    links,
    fingerprint,
    dropContext: {
      observed_at: observedAt || now().toISOString(),
      project_id: observation.project_id,
      session_id: observation.session_id,
      prompt_id: observation.prompt_id,
      request_id: observation.request_id,
      trace_id: observation.trace_id,
      agent_id: observation.agent_id,
      task_id: observation.task_id,
      ticket_ref: observation.ticket_ref,
      route_id: observation.route_id,
    },
  };
}

function createIngestor(store) {
  if (!store || typeof store.ingest !== 'function') throw new TypeError('A Workbench observability store is required.');
  return {
    ingest: (observation) => store.ingest(observation),
    ingestBatch: (observations) => store.ingestBatch(observations),
  };
}

module.exports = {
  createIngestor,
  normalizeObservation,
  stableStringify,
  validIdentifier,
};
