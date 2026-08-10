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

test('size pruning removes the oldest current day when the database exceeds its cap', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-store-cap-'));
  const databaseFile = path.join(directory, 'ledger.db');
  const store = openObservabilityStore(databaseFile, {
    maxDatabaseBytes: 256 * 1024,
    now: () => NOW,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 800; index += 1) {
    assert.equal(store.ingest(usageObservation(`old-${index}`, '2026-08-06T12:00:00.000Z')).accepted, true);
  }
  assert.equal(store.ingest(usageObservation('new', '2026-08-07T12:00:00.000Z')).accepted, true);
  assert.equal(store.storageMetrics().overDatabaseLimit, true);

  const result = store.prune({ retentionDays: 30 });

  assert.equal(result.sizePrune.counts.observations, 800);
  assert.equal(result.sizePrune.days, 1);
  assert.equal(result.sizePrune.storage.overDatabaseLimit, false);
  const newest = store.database.prepare("SELECT event_id FROM observation WHERE source_event_id = 'request-new'").get();
  assert.ok(newest);
  assert.equal(store.getObservation(newest.event_id).request_id, 'request-new');
});
