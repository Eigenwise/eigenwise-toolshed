'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeObservation, stableStringify, validIdentifier } = require('./ingest.js');
const { RESOLVED_VIEWS, SCHEMA_VERSION, TABLE_SQL } = require('./schema.js');
const { VIEW_SQL } = require('./resolve.js');

const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarningWithoutSqliteExperimentalWarning(warning, ...args) {
  if (warning === 'SQLite is an experimental feature and might change at any time' && args[0] === 'ExperimentalWarning') return;
  return originalEmitWarning.call(this, warning, ...args);
};
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} finally {
  process.emitWarning = originalEmitWarning;
}

const OBSERVATION_COLUMNS = [
  'event_id', 'source', 'source_event_id', 'source_schema', 'observed_at', 'emitted_at',
  'event_name', 'sequence', 'project_id', 'session_id', 'prompt_id', 'request_id',
  'client_request_id', 'trace_id', 'span_id', 'parent_span_id', 'workflow_run_id',
  'agent_id', 'parent_agent_id', 'tool_use_id', 'task_id', 'ticket_ref', 'route_id',
  'attributes_json',
];

const USAGE_EVENTS = new Set([
  'gateway.token.usage',
  'claude_code.api_request',
  'agent_sdk.assistant_usage',
  'claude_code.llm_request',
]);
const USAGE_NAMES = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
]);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isoNow(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { intValue: String(value) }
    : { doubleValue: value };
  return { stringValue: String(value) };
}

function buildOtlpPayload(observation, measurements = [], links = []) {
  const attributes = [];
  const add = (key, value) => {
    if (value === null || value === undefined) return;
    attributes.push({ key, value: otlpValue(value) });
  };

  add('workbench.event.id', observation.event_id);
  add('workbench.source', observation.source);
  add('workbench.source.event_id', observation.source_event_id);
  add('workbench.source.schema', observation.source_schema);
  for (const field of [
    'project_id', 'session_id', 'prompt_id', 'request_id', 'client_request_id', 'trace_id',
    'span_id', 'parent_span_id', 'workflow_run_id', 'agent_id', 'parent_agent_id',
    'tool_use_id', 'task_id', 'ticket_ref', 'route_id',
  ]) add(`workbench.${field.replaceAll('_', '.')}`, observation[field]);

  for (const [field, value] of Object.entries(observation.attributes || {})) {
    add(`workbench.attribute.${field}`, Array.isArray(value) ? JSON.stringify(value) : value);
  }
  if (measurements.length > 0) {
    add('workbench.measurements', stableStringify(measurements.map(({ name, unit, scope, quality }) => ({
      name,
      unit,
      scope,
      quality,
    }))));
  }
  for (const measurement of measurements) {
    if (measurement.value !== null) add(`workbench.measurement.${measurement.name}.value`, measurement.value);
  }
  if (links.length > 0) add('workbench.links', JSON.stringify(links));

  const timestamp = BigInt(Date.parse(observation.observed_at)) * 1_000_000n;
  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'workbench-observer' } }],
      },
      scopeLogs: [{
        scope: { name: 'workbench.observability', version: String(SCHEMA_VERSION) },
        logRecords: [{
          timeUnixNano: timestamp.toString(),
          body: { stringValue: observation.event_name },
          attributes,
        }],
      }],
    }],
  };
}

function createStatements(database) {
  const placeholders = OBSERVATION_COLUMNS.map(() => '?').join(', ');
  return {
    insertObservation: database.prepare(`
      INSERT INTO observation (${OBSERVATION_COLUMNS.join(', ')})
      VALUES (${placeholders})
    `),
    insertMeasurement: database.prepare(`
      INSERT INTO measurement (event_id, name, value, unit, scope, quality)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertLink: database.prepare(`
      INSERT INTO link (from_event_id, relation, to_kind, to_id, method, quality)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertDedupe: database.prepare(`
      INSERT INTO observation_dedupe (source, source_event_id, event_id, fingerprint)
      VALUES (?, ?, ?, ?)
    `),
    findDedupe: database.prepare(`
      SELECT event_id, fingerprint FROM observation_dedupe
      WHERE source = ? AND source_event_id = ?
    `),
    insertOutbox: database.prepare(`
      INSERT INTO otlp_outbox (event_id, payload_json, payload_hash, available_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    usageEvidence: database.prepare(`
      SELECT o.event_id, o.event_name, m.name, m.value, m.scope
      FROM observation o
      JOIN measurement m ON m.event_id = o.event_id
      WHERE o.request_id = ?
        AND o.event_name IN ('gateway.token.usage', 'claude_code.api_request', 'agent_sdk.assistant_usage', 'claude_code.llm_request')
        AND m.name IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens')
        AND m.scope IN ('request', 'attempt')
        AND m.value IS NOT NULL
      ORDER BY o.event_id, m.name, CASE m.scope WHEN 'request' THEN 1 ELSE 2 END
    `),
    sessionRollup: database.prepare('SELECT * FROM session_rollup WHERE session_id = ? LIMIT 1'),
    checkMeasurements: database.prepare(`
      SELECT name, value
      FROM measurement
      WHERE event_id = ?
        AND name IN ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens')
        AND value IS NOT NULL
    `),
    observationById: database.prepare('SELECT * FROM observation WHERE event_id = ?'),
    measurementsByEvent: database.prepare('SELECT * FROM measurement WHERE event_id = ? ORDER BY name, scope'),
    linksByEvent: database.prepare('SELECT * FROM link WHERE from_event_id = ? ORDER BY relation, to_kind, to_id'),
  };
}

function openObservabilityStore(databaseFile, options = {}) {
  if (typeof databaseFile !== 'string' || databaseFile.length === 0) {
    throw new TypeError('A database file is required.');
  }
  if (databaseFile !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databaseFile)), { recursive: true });

  const now = options.now || (() => new Date());
  const createId = options.randomUUID || randomUUID;
  const outboxEnabled = options.outboxEnabled !== false;
  const database = new DatabaseSync(databaseFile, { timeout: options.busyTimeoutMs || 5000 });
  database.exec(`PRAGMA busy_timeout=${Number(options.busyTimeoutMs || 5000)}`);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=FULL');
  database.exec(TABLE_SQL);
  database.exec(VIEW_SQL);
  database.prepare(`
    INSERT INTO observability_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO NOTHING
  `).run(String(SCHEMA_VERSION));
  const schema = database.prepare("SELECT value FROM observability_meta WHERE key = 'schema_version'").get();
  if (!schema || Number(schema.value) !== SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported Workbench observability schema ${schema ? schema.value : 'missing'}.`);
  }

  const statements = createStatements(database);
  let closed = false;
  let inTransaction = false;
  const sessionProjects = new Map();
  const SESSION_PROJECT_CAP = 2048;

  function rememberProject(observation) {
    if (!observation.session_id) return;
    const projectName = observation.attributes && observation.attributes.project_name;
    if (!observation.project_id && !projectName) return;
    sessionProjects.delete(observation.session_id);
    sessionProjects.set(observation.session_id, {
      project_id: observation.project_id || null,
      project_name: projectName || null,
    });
    while (sessionProjects.size > SESSION_PROJECT_CAP) sessionProjects.delete(sessionProjects.keys().next().value);
  }

  function warmProjectMap() {
    const rows = database.prepare(`
      SELECT session_id, project_id, project_name
      FROM (
        SELECT
          session_id,
          project_id,
          json_extract(attributes_json, '$.project_name') AS project_name,
          observed_at,
          event_id
        FROM observation
        WHERE event_name LIKE 'hook.%'
          AND session_id IS NOT NULL
          AND (project_id IS NOT NULL OR json_extract(attributes_json, '$.project_name') IS NOT NULL)
        ORDER BY observed_at DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY observed_at ASC, event_id ASC
    `).all(SESSION_PROJECT_CAP);
    for (const row of rows) {
      rememberProject({
        session_id: row.session_id,
        project_id: row.project_id,
        attributes: { project_name: row.project_name },
      });
    }
  }

  warmProjectMap();

  function enrichGateway(input) {
    if (!input || !['gateway.token.usage', 'gateway.tool_result.usage', 'gateway.mcp.footprint'].includes(input.event_name)) return input;
    const project = input.session_id ? sessionProjects.get(input.session_id) : null;
    if (project) {
      sessionProjects.delete(input.session_id);
      sessionProjects.set(input.session_id, project);
    }
    return {
      ...input,
      project_id: project ? project.project_id : (input.project_id || null),
      attributes: {
        ...(input.attributes || {}),
        ...(project && project.project_name ? { project_name: project.project_name } : {}),
      },
    };
  }

  function assertOpen() {
    if (closed) throw new Error('Workbench observability store is closed.');
  }

  function transaction(work) {
    assertOpen();
    if (inTransaction) return work();
    database.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const result = work();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      inTransaction = false;
    }
  }

  function insertRows(observation, measurements, links, fingerprint) {
    const stored = {
      ...observation,
      attributes_json: stableStringify(observation.attributes || {}),
    };
    statements.insertObservation.run(...OBSERVATION_COLUMNS.map((column) => stored[column] ?? null));
    for (const measurement of measurements) {
      statements.insertMeasurement.run(
        observation.event_id,
        measurement.name,
        measurement.value,
        measurement.unit,
        measurement.scope,
        measurement.quality,
      );
    }
    for (const link of links) {
      statements.insertLink.run(
        observation.event_id,
        link.relation,
        link.to_kind,
        link.to_id,
        link.method,
        link.quality,
      );
    }
    statements.insertDedupe.run(observation.source, observation.source_event_id, observation.event_id, fingerprint);
    if (outboxEnabled) {
      const payloadJson = stableStringify(buildOtlpPayload(observation, measurements, links));
      const createdAt = isoNow(now);
      statements.insertOutbox.run(observation.event_id, payloadJson, digest(payloadJson), createdAt, createdAt);
    }
    return observation.event_id;
  }

  function insertInternal(eventName, sourceEventId, context, fieldNames, measurements = [], links = []) {
    const existing = statements.findDedupe.get('workbench', sourceEventId);
    if (existing) return { eventId: existing.event_id, inserted: false };
    const observedAt = context.observed_at || isoNow(now);
    const observation = {
      event_id: createId(),
      source: 'workbench',
      source_event_id: sourceEventId,
      source_schema: String(SCHEMA_VERSION),
      observed_at: observedAt,
      emitted_at: isoNow(now),
      event_name: eventName,
      sequence: null,
      project_id: context.project_id || null,
      session_id: context.session_id || null,
      prompt_id: context.prompt_id || null,
      request_id: context.request_id || null,
      client_request_id: context.client_request_id || null,
      trace_id: context.trace_id || null,
      span_id: context.span_id || null,
      parent_span_id: context.parent_span_id || null,
      workflow_run_id: context.workflow_run_id || null,
      agent_id: context.agent_id || null,
      parent_agent_id: context.parent_agent_id || null,
      tool_use_id: context.tool_use_id || null,
      task_id: context.task_id || null,
      ticket_ref: context.ticket_ref || null,
      route_id: context.route_id || null,
      attributes: { field_names: [...new Set(fieldNames)].sort() },
    };
    const fingerprint = digest(stableStringify({ observation, measurements, links }));
    insertRows(observation, measurements, links, fingerprint);
    return { eventId: observation.event_id, inserted: true };
  }

  function recordSchemaDrop(normalized) {
    const fields = [...new Set([...normalized.droppedFields, ...normalized.rejectedFields])].sort();
    if (fields.length === 0) return null;
    const identity = stableStringify({
      source: normalized.observation && normalized.observation.source,
      source_event_id: normalized.observation && normalized.observation.source_event_id,
      fields,
      accepted: normalized.accepted,
    });
    return insertInternal(
      'schema_drop',
      `schema-drop:${digest(identity)}`,
      normalized.dropContext,
      fields,
    ).eventId;
  }

  function recordDuplicateConflict(normalized, existingEventId) {
    const fieldNames = [
      'observation',
      ...normalized.measurements.map((measurement) => `measurement.${measurement.name}`),
      ...normalized.links.map((link) => `link.${link.relation}`),
    ];
    const sourceEventId = `conflict:${digest(`${normalized.observation.source}:${normalized.observation.source_event_id}:${normalized.fingerprint}`)}`;
    return insertInternal(
      'telemetry_conflict',
      sourceEventId,
      normalized.dropContext,
      fieldNames,
      normalized.measurements,
      [{
        relation: 'conflicts_with',
        to_kind: 'event',
        to_id: existingEventId,
        method: 'direct_id',
        quality: 'exact',
      }],
    ).eventId;
  }

  function recordRequestUsageConflicts(observation) {
    if (!observation.request_id || !USAGE_EVENTS.has(observation.event_name)) return [];
    const rows = statements.usageEvidence.all(observation.request_id);
    const selected = new Map();
    for (const row of rows) {
      const key = `${row.event_id}:${row.name}`;
      if (!selected.has(key) || row.scope === 'request') selected.set(key, row);
    }
    const byName = new Map();
    for (const row of selected.values()) {
      if (!byName.has(row.name)) byName.set(row.name, []);
      byName.get(row.name).push(row);
    }

    const conflicts = [];
    for (const [name, evidence] of byName) {
      for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < evidence.length; rightIndex += 1) {
          const left = evidence[leftIndex];
          const right = evidence[rightIndex];
          if (left.value === right.value) continue;
          const eventIds = [left.event_id, right.event_id].sort();
          const sourceEventId = `conflict:${digest(`request:${observation.request_id}:${name}:${eventIds.join(':')}`)}`;
          const result = insertInternal(
            'telemetry_conflict',
            sourceEventId,
            observation,
            [`measurement.${name}`],
            [],
            eventIds.map((eventId) => ({
              relation: 'conflicts_with',
              to_kind: 'event',
              to_id: eventId,
              method: 'direct_id',
              quality: 'exact',
            })),
          );
          if (result.inserted) conflicts.push(result.eventId);
        }
      }
    }
    return conflicts;
  }

  function recordAggregateCheckConflicts(observation) {
    if (!observation.session_id || !['agent_sdk.terminal_result', 'otel.metric'].includes(observation.event_name)) return [];
    const rollup = statements.sessionRollup.get(observation.session_id);
    if (!rollup) return [];
    const measurements = statements.checkMeasurements.all(observation.event_id);
    const conflicts = [];
    for (const measurement of measurements) {
      if (!USAGE_NAMES.has(measurement.name)) continue;
      const resolvedValue = rollup[measurement.name];
      if (resolvedValue === null || resolvedValue === undefined || resolvedValue === measurement.value) continue;
      const sourceEventId = `conflict:${digest(`aggregate:${observation.event_id}:${measurement.name}:${resolvedValue}`)}`;
      const result = insertInternal(
        'telemetry_conflict',
        sourceEventId,
        observation,
        [`measurement.${measurement.name}`],
        [],
        [{
          relation: 'conflicts_with',
          to_kind: 'event',
          to_id: observation.event_id,
          method: 'direct_id',
          quality: 'exact',
        }],
      );
      if (result.inserted) conflicts.push(result.eventId);
    }
    return conflicts;
  }

  function ingestNormalized(normalized) {
    const schemaDropEventId = recordSchemaDrop(normalized);
    if (!normalized.accepted) {
      return {
        accepted: false,
        committed: true,
        duplicate: false,
        event_id: null,
        schema_drop_event_id: schemaDropEventId,
        rejected_fields: normalized.rejectedFields,
        dropped_fields: normalized.droppedFields,
      };
    }

    const fingerprint = digest(normalized.fingerprint);
    const existing = statements.findDedupe.get(
      normalized.observation.source,
      normalized.observation.source_event_id,
    );
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        return {
          accepted: true,
          committed: true,
          duplicate: true,
          event_id: existing.event_id,
          schema_drop_event_id: schemaDropEventId,
          conflict_event_ids: [],
          dropped_fields: normalized.droppedFields,
        };
      }
      const conflictEventId = recordDuplicateConflict(normalized, existing.event_id);
      return {
        accepted: false,
        committed: true,
        duplicate: false,
        conflict: true,
        event_id: existing.event_id,
        conflict_event_ids: [conflictEventId],
        schema_drop_event_id: schemaDropEventId,
        rejected_fields: [],
        dropped_fields: normalized.droppedFields,
      };
    }

    insertRows(normalized.observation, normalized.measurements, normalized.links, fingerprint);
    rememberProject(normalized.observation);
    const conflictEventIds = [
      ...recordRequestUsageConflicts(normalized.observation),
      ...recordAggregateCheckConflicts(normalized.observation),
    ];
    return {
      accepted: true,
      committed: true,
      duplicate: false,
      event_id: normalized.observation.event_id,
      schema_drop_event_id: schemaDropEventId,
      conflict_event_ids: conflictEventIds,
      dropped_fields: normalized.droppedFields,
    };
  }

  function ingest(input) {
    const normalized = normalizeObservation(enrichGateway(input), { now, randomUUID: createId });
    return transaction(() => ingestNormalized(normalized));
  }

  function ingestBatch(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new TypeError('A non-empty observation array is required.');
    const normalized = inputs.map((input) => normalizeObservation(enrichGateway(input), { now, randomUUID: createId }));
    return transaction(() => normalized.map(ingestNormalized));
  }

  function getObservation(eventId) {
    assertOpen();
    const row = statements.observationById.get(eventId);
    if (!row) return null;
    return {
      ...row,
      attributes: JSON.parse(row.attributes_json),
      measurements: statements.measurementsByEvent.all(eventId),
      links: statements.linksByEvent.all(eventId),
    };
  }

  function queryView(name, options = {}) {
    assertOpen();
    if (!RESOLVED_VIEWS.includes(name)) throw new Error(`Unknown observability view: ${name}`);
    const limit = Math.max(1, Math.min(Number(options.limit) || 1000, 10_000));
    return database.prepare(`SELECT * FROM ${name} LIMIT ?`).all(limit);
  }

  function pendingOutbox(options = {}) {
    assertOpen();
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
    const at = options.at || isoNow(now);
    return database.prepare(`
      SELECT id, event_id, payload_json, attempts, available_at, created_at
      FROM otlp_outbox
      WHERE available_at IS NOT NULL AND available_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(at, limit);
  }

  function acknowledgeOutbox(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    return transaction(() => {
      const remove = database.prepare('DELETE FROM otlp_outbox WHERE id = ?');
      let count = 0;
      for (const id of ids) count += Number(remove.run(id).changes);
      return count;
    });
  }

  function failOutbox(id, errorCode, options = {}) {
    const code = validIdentifier(errorCode) ? errorCode : 'transport_error';
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 8);
    const retryAt = options.retryAt || null;
    return transaction(() => {
      const row = database.prepare('SELECT attempts FROM otlp_outbox WHERE id = ?').get(id);
      if (!row) return false;
      const attempts = Number(row.attempts) + 1;
      const availableAt = attempts >= maxAttempts ? null : (retryAt || isoNow(now));
      database.prepare(`
        UPDATE otlp_outbox
        SET attempts = ?, available_at = ?, last_attempt_at = ?, last_error_code = ?
        WHERE id = ?
      `).run(attempts, availableAt, isoNow(now), code, id);
      return true;
    });
  }

  function close() {
    if (closed) return;
    database.close();
    closed = true;
  }

  return {
    acknowledgeOutbox,
    close,
    database,
    failOutbox,
    getObservation,
    ingest,
    ingestBatch,
    pendingOutbox,
    queryView,
    transaction,
  };
}

module.exports = {
  buildOtlpPayload,
  openObservabilityStore,
};
