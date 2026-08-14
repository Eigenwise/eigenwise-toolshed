'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openObservabilityStore } = require('../lib/observability/store.js');

function oldObservation(identifier) {
  return {
    source: 'claude_code',
    source_event_id: `old-${identifier}`,
    source_schema: '1',
    observed_at: '2026-07-01T12:00:00.000Z',
    event_name: 'claude_code.api_request',
    project_id: 'a'.repeat(64),
    session_id: `session-${identifier}`,
    prompt_id: `prompt-${identifier}`,
    request_id: `request-${identifier}`,
    attributes: { model: 'claude-test', backend: 'claude', effort: 'high', status: 'ok' },
    measurements: [{ name: 'input_tokens', value: 100, unit: 'tokens', scope: 'request', quality: 'exact_provider' }],
    links: [],
  };
}

test('storage pressure uses retention first and records its exact removal window', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-pressure-prune-'));
  const store = openObservabilityStore(path.join(directory, 'ledger.db'), {
    now: () => new Date('2026-08-07T12:00:00.000Z'),
    maxDatabaseBytes: 256 * 1024,
    storageReserveBytes: 64 * 1024,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 200; index += 1) store.ingest(oldObservation(index));
  assert.equal(store.storageMetrics().underStorageReserve, true);

  const result = store.preserveStorageHeadroom();

  assert.equal(result.state, 'healthy');
  assert.equal(result.action, 'retention_prune');
  assert.equal(result.removed.counts.observations, 200);
  assert.deepEqual(result.removed.windows[0], {
    cutoff: '2026-07-08T12:00:00.000Z',
    counts: { observations: 200, measurements: 200, links: 0, dedupe: 200, outbox: 200 },
    oldestObservedAt: '2026-07-01T12:00:00.000Z',
    newestObservedAt: '2026-07-01T12:00:00.000Z',
  });
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 0);
});
