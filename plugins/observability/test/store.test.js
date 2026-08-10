'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openObservabilityStore } = require('../lib/observability/store.js');

const PROJECT_ID = 'a'.repeat(64);
const NOW = new Date('2026-08-07T12:00:00.000Z');

function usageObservation(id, observedAt) {
  return {
    source: 'claude_code',
    source_event_id: `request-${id}`,
    source_schema: '1',
    observed_at: observedAt,
    event_name: 'claude_code.api_request',
    project_id: PROJECT_ID,
    session_id: `session-${id}`,
    prompt_id: `prompt-${id}`,
    request_id: `request-${id}`,
    attributes: { model: 'claude-test', backend: 'claude', effort: 'high', status: 'ok' },
    measurements: [
      { name: 'input_tokens', value: 100, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 20, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
    ],
    links: [{ relation: 'attributed_to', to_kind: 'ticket', to_id: 'SQ-1813', method: 'application_supplied', quality: 'exact' }],
  };
}

function openCappedStore(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databaseFile = path.join(directory, 'ledger.db');
  const store = openObservabilityStore(databaseFile, {
    maxDatabaseBytes: 256 * 1024,
    now: () => NOW,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('the observer default leaves the file untouched, because VACUUM would block ingest', (t) => {
  const store = openCappedStore(t, 'workbench-store-novacuum-');

  for (let index = 0; index < 800; index += 1) {
    store.ingest(usageObservation(`old-${index}`, '2026-08-06T12:00:00.000Z'));
  }
  store.ingest(usageObservation('new', '2026-08-07T12:00:00.000Z'));
  const bytesBefore = store.storageMetrics().databaseBytes;

  const result = store.prune({ retentionDays: 30 });

  assert.equal(result.sizePrune.counts.observations, 800);
  assert.ok(store.storageMetrics().databaseBytes >= bytesBefore);
  assert.ok(Number(store.database.prepare('PRAGMA freelist_count').get().freelist_count) > 0);
});

test('size pruning stops at its day budget instead of blocking on a long backlog', (t) => {
  const store = openCappedStore(t, 'workbench-store-bounded-');

  for (const day of ['02', '03', '04', '05', '06']) {
    for (let index = 0; index < 400; index += 1) {
      store.ingest(usageObservation(`day${day}-${index}`, `2026-08-${day}T12:00:00.000Z`));
    }
  }
  assert.equal(store.storageMetrics().overDatabaseLimit, true);

  const result = store.prune({ retentionDays: 30 });

  assert.equal(result.sizePrune.days, 3);
  assert.equal(result.sizePrune.moreWorkPending, true);
  const oldestLeft = store.database.prepare('SELECT MIN(observed_at) AS oldest FROM observation').get();
  assert.equal(oldestLeft.oldest, '2026-08-05T12:00:00.000Z');
});

test('the reclaiming path shrinks the file back under the cap', (t) => {
  const store = openCappedStore(t, 'workbench-store-cap-');

  for (let index = 0; index < 800; index += 1) {
    assert.equal(store.ingest(usageObservation(`old-${index}`, '2026-08-06T12:00:00.000Z')).accepted, true);
  }
  assert.equal(store.ingest(usageObservation('new', '2026-08-07T12:00:00.000Z')).accepted, true);
  assert.equal(store.storageMetrics().overDatabaseLimit, true);

  const result = store.prune({ retentionDays: 30, reclaimFileSpace: true });

  assert.equal(result.sizePrune.counts.observations, 800);
  assert.equal(result.sizePrune.days, 1);
  assert.equal(result.sizePrune.storage.overDatabaseLimit, false);
  const newest = store.database.prepare("SELECT event_id FROM observation WHERE source_event_id = 'request-new'").get();
  assert.ok(newest);
  assert.equal(store.getObservation(newest.event_id).request_id, 'request-new');
});
