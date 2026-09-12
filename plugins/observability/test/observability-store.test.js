'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createConsentGate } = require('../lib/observability/consent.js');
const { openObservabilityStore } = require('../lib/observability/store.js');

const PROJECT_ID = 'a'.repeat(64);
const NOW = new Date('2026-08-07T12:00:00.000Z');

function observation(identifier, observedAt = '2026-08-07T12:00:00.000Z') {
  return {
    source: 'claude_code',
    source_event_id: `request-${identifier}`,
    source_schema: '1',
    observed_at: observedAt,
    event_name: 'claude_code.api_request',
    project_id: PROJECT_ID,
    session_id: `session-${identifier}`,
    prompt_id: `prompt-${identifier}`,
    request_id: `request-${identifier}`,
    attributes: { model: 'claude-test', backend: 'claude', effort: 'high', status: 'ok' },
    measurements: [
      { name: 'input_tokens', value: 100, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 20, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
    ],
    links: [{ relation: 'attributed_to', to_kind: 'ticket', to_id: 'SQ-1963', method: 'application_supplied', quality: 'exact' }],
  };
}

function temporaryStore(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-storage-pressure-'));
  const store = openObservabilityStore(path.join(directory, 'ledger.db'), { now: () => NOW, ...options });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('storage pressure preserves a writable reserve and records the shortened retention window', (t) => {
  const store = temporaryStore(t, { maxDatabaseBytes: 512 * 1024, storageReserveBytes: 64 * 1024 });
  for (let index = 0; index < 200; index += 1) store.ingest(observation(index));
  assert.equal(store.storageMetrics().underStorageReserve, true);

  const result = store.preserveStorageHeadroom();

  assert.equal(result.state, 'healthy');
  assert.ok(['size_prune', 'incremental_vacuum'].includes(result.action));
  assert.ok(result.remainingHeadroomBytes >= 64 * 1024);
  assert.equal(result.removed.counts.observations, 200);
  assert.deepEqual(result.removed.windows[0], {
    cutoff: '2026-08-08T00:00:00.000Z',
    counts: { observations: 200, measurements: 400, links: 200, dedupe: 200, outbox: 200 },
    oldestObservedAt: '2026-08-07T12:00:00.000Z',
    newestObservedAt: '2026-08-07T12:00:00.000Z',
  });
  assert.equal(store.storagePressure().action, result.action);
});

test('storage pressure leaves healthy retention and observations untouched', (t) => {
  const store = temporaryStore(t, { maxDatabaseBytes: 512 * 1024, storageReserveBytes: 64 * 1024 });
  store.ingest(observation('healthy'));

  const result = store.preserveStorageHeadroom();

  assert.equal(result.state, 'healthy');
  assert.equal(result.action, 'none');
  assert.deepEqual(result.removed.counts, { observations: 0, measurements: 0, links: 0, dedupe: 0, outbox: 0 });
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);
});

test('storage pressure reports an unrecoverable failure when no observation can create reserve', (t) => {
  const store = temporaryStore(t, { maxDatabaseBytes: 1, storageReserveBytes: 0 });

  const result = store.preserveStorageHeadroom();

  assert.equal(result.state, 'unrecoverable');
  assert.equal(result.action, 'unrecoverable');
  assert.equal(result.failure, 'storage_headroom_unrecoverable');
  assert.equal(store.storagePressure().failure, 'storage_headroom_unrecoverable');
});

test('ingest denies an unconsented project before persistence and before the outbox', (t) => {
  const optedProjectId = 'a'.repeat(64);
  const unoptedProjectId = 'b'.repeat(64);
  const store = temporaryStore(t, { consent: (projectId) => projectId === optedProjectId });
  const denied = store.ingest({ ...observation('unconsented'), project_id: unoptedProjectId, attributes: { invalid: 'never-store' } });

  assert.deepEqual(denied, { accepted: false, committed: true, duplicate: false, event_id: null, consent_denied: true });
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 0);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation WHERE event_name = \'schema_drop\'').get().count, 0);

  assert.equal(store.ingest(observation('opted')).accepted, true);
  assert.equal(store.pendingOutbox().length, 1);
  const schemaRejected = store.ingest({ ...observation('schema-rejected'), event_name: 'invalid_event' });
  assert.equal(schemaRejected.accepted, false);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name != 'schema_drop'").get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation WHERE event_name = \'schema_drop\'').get().count, 1);
});

test('pendingOutbox stops exporting a project after consent is withdrawn', (t) => {
  let allowed = true;
  const store = temporaryStore(t, { consent: (projectId) => allowed && projectId === PROJECT_ID });
  assert.equal(store.ingest(observation('withdrawn')).accepted, true);
  assert.equal(store.pendingOutbox().length, 1);

  allowed = false;
  assert.deepEqual(
    store.ingest(observation('after-withdrawal')),
    { accepted: false, committed: true, duplicate: false, event_id: null, consent_denied: true },
  );
  assert.deepEqual(store.pendingOutbox(), []);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);

  allowed = true;
  assert.equal(store.pendingOutbox().length, 1);
});

test('rewriting the opt-in registry withholds queued rows from export and restores them on re-opt-in', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-consent-registry-'));
  const configFile = path.join(directory, 'observability.json');
  const writeRegistry = (projectIds) => fs.writeFileSync(configFile, JSON.stringify({
    observability: { optedInProjects: projectIds.map((projectId) => ({ project_id: projectId })) },
  }));
  writeRegistry([PROJECT_ID]);
  const store = temporaryStore(t, { consent: createConsentGate({ configFile }) });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  assert.equal(store.ingest(observation('registry-first')).accepted, true);
  assert.equal(store.ingest(observation('registry-second')).accepted, true);
  assert.equal(store.pendingOutbox().length, 2);
  const observations = () => store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count;

  writeRegistry([]);
  assert.deepEqual(store.pendingOutbox(), []);
  assert.equal(observations(), 2);

  writeRegistry([PROJECT_ID]);
  assert.equal(store.pendingOutbox().length, 2);
  assert.equal(observations(), 2);
});

module.exports = { observation };
