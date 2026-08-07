'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { formatResult, parseArgs } = require('../bin/prune-observability.js');
const { buildTokenUsageReport } = require('../lib/observability/report.js');
const { openObservabilityStore } = require('../lib/observability/store.js');

const PROJECT_ID = 'a'.repeat(64);
const NOW = new Date('2026-08-07T12:00:00.000Z');
const pruneScript = path.join(__dirname, '..', 'bin', 'prune-observability.js');

function rowCounts(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Object.fromEntries([
      'observation',
      'measurement',
      'link',
      'observation_dedupe',
      'otlp_outbox',
    ].map((tableName) => [tableName, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count)]));
  } finally {
    database.close();
  }
}

function waitForWriterLock(writer) {
  return new Promise((resolve, reject) => {
    writer.once('message', resolve);
    writer.once('error', reject);
    writer.once('exit', (code) => reject(new Error(`Writer exited before acquiring its lock: ${code}`)));
  });
}

function temporaryStore(t, file = null) {
  const directory = file ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-retention-'));
  const databaseFile = file || path.join(directory, 'ledger.db');
  const store = openObservabilityStore(databaseFile, { now: () => NOW });
  if (directory) {
    t.after(() => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
  }
  return { databaseFile, store };
}

function usageObservation(id, observedAt, inputTokens) {
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
      { name: 'input_tokens', value: inputTokens, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
      { name: 'output_tokens', value: 20, unit: 'tokens', scope: 'request', quality: 'exact_provider' },
    ],
    links: [{ relation: 'attributed_to', to_kind: 'ticket', to_id: 'SQ-1423', method: 'application_supplied', quality: 'exact' }],
  };
}

function ingest(store, observation) {
  const result = store.ingest(observation);
  assert.equal(result.accepted, true);
}

test('retention dry run reports old rows without changing the database', (t) => {
  const { store } = temporaryStore(t);
  ingest(store, usageObservation('old', '2026-05-01T12:00:00.000Z', 100));
  ingest(store, usageObservation('fresh', '2026-08-01T12:00:00.000Z', 200));

  const result = store.prune({ retentionDays: 30, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.counts.observations, 1);
  assert.equal(result.counts.measurements, 2);
  assert.equal(result.counts.links, 1);
  assert.equal(result.counts.dedupe, 1);
  assert.equal(result.counts.outbox, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 2);
  assert.match(formatResult(result), /estimated reusable space/);
  assert.match(formatResult(result), /VACUUM needs roughly/);
});

test('retention removes only expired rows and preserves current report totals', (t) => {
  const { store } = temporaryStore(t);
  ingest(store, usageObservation('old', '2026-05-01T12:00:00.000Z', 100));
  ingest(store, usageObservation('fresh-one', '2026-08-01T12:00:00.000Z', 200));
  ingest(store, usageObservation('fresh-two', '2026-08-02T12:00:00.000Z', 300));

  const before = buildTokenUsageReport(store);
  const result = store.prune({ retentionDays: 30 });
  const after = buildTokenUsageReport(store);

  assert.equal(result.dryRun, false);
  assert.equal(result.counts.observations, 1);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 2);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM measurement').get().count, 4);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM link').get().count, 2);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM observation_dedupe').get().count, 2);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM otlp_outbox').get().count, 2);
  assert.equal(before.session_turn_ledger.find((row) => row.request_id === 'request-fresh-one').tokens.input.value, 200);
  assert.equal(after.session_turn_ledger.find((row) => row.request_id === 'request-fresh-one').tokens.input.value, 200);
  assert.equal(after.session_turn_ledger.find((row) => row.request_id === 'request-fresh-two').tokens.input.value, 300);
});

test('a second observer can write after retention pruning', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-retention-writer-'));
  const databaseFile = path.join(directory, 'ledger.db');
  const first = openObservabilityStore(databaseFile, { now: () => NOW });
  const second = openObservabilityStore(databaseFile, { now: () => NOW });
  t.after(() => {
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ingest(first, usageObservation('old', '2026-05-01T12:00:00.000Z', 100));

  first.prune({ retentionDays: 30 });
  ingest(second, usageObservation('writer', '2026-08-07T12:00:00.000Z', 400));

  assert.equal(first.database.prepare('SELECT COUNT(*) AS count FROM observation').get().count, 1);
});

test('retention CLI previews by default and requires an explicit apply flag', (t) => {
  const { databaseFile, store } = temporaryStore(t);
  ingest(store, usageObservation('old', '2026-05-01T12:00:00.000Z', 100));
  ingest(store, usageObservation('fresh', '2026-08-01T12:00:00.000Z', 200));
  store.close();
  const before = rowCounts(databaseFile);

  const preview = spawnSync(process.execPath, [pruneScript, '--db', databaseFile, '--retention-days', '30'], { encoding: 'utf8' });

  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Retention prune preview/);
  assert.match(preview.stdout, /Run again with --apply/);
  assert.deepEqual(rowCounts(databaseFile), before);

  const applied = spawnSync(process.execPath, [pruneScript, '--db', databaseFile, '--retention-days', '30', '--apply'], { encoding: 'utf8' });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(rowCounts(databaseFile).observation, 1);
});

test('retention dry run reports old rows while a separate process holds a write lock', async (t) => {
  const { databaseFile, store } = temporaryStore(t);
  ingest(store, usageObservation('old', '2026-05-01T12:00:00.000Z', 100));
  store.close();
  const writer = spawn(process.execPath, [
    '-e',
    "const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1]); database.exec('BEGIN IMMEDIATE'); process.send('locked'); setInterval(() => {}, 1000);",
    databaseFile,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => writer.kill());
  await waitForWriterLock(writer);

  try {
    const preview = spawnSync(process.execPath, [pruneScript, '--db', databaseFile, '--dry-run', '--retention-days', '30'], { encoding: 'utf8' });

    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Retention prune preview/);
    assert.match(preview.stdout, /observations: 1/);
  } finally {
    await new Promise((resolve) => {
      writer.once('exit', resolve);
      writer.kill();
    });
  }
});

test('retention CLI defaults to a safe preview and validates its window', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--retention-days', '14', '--db', 'C:/fixture.db']), {
    databaseFile: 'C:/fixture.db',
    dryRun: true,
    format: 'text',
    retentionDays: 14,
  });
  assert.equal(parseArgs(['--apply']).dryRun, false);
  assert.equal(parseArgs(['--apply', '--dry-run']).dryRun, true);
  assert.throws(() => parseArgs(['--retention-days', '0']), /positive integer/);
});

test('retention CLI help lists every option and marks destructive flags', () => {
  const help = spawnSync(process.execPath, [pruneScript, '--help'], { encoding: 'utf8' });

  assert.equal(help.status, 0, help.stderr);
  for (const flag of ['--apply', '--yes', '--dry-run', '--db', '--format', '--retention-days', '--help']) {
    assert.match(help.stdout, new RegExp(flag));
  }
  assert.match(help.stdout, /--apply\s+Delete matching rows\. Destructive\./);
});
