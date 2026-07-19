'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildCollectorConfig, writeCollectorConfig } = require('../bin/install-otel-collector.js');
const { downloadCollector } = require('../bin/setup-observability.js');

const configuredBinary = process.env.WORKBENCH_OTELCOL_CONTRIB;
const runRealCollectorTest = Boolean(configuredBinary || process.env.CI);

test('the Collector config uses supported redaction and creates its queue directory', () => {
  const config = buildCollectorConfig();
  const redact = config.processors['transform/redact'];
  for (const group of ['log_statements', 'trace_statements', 'metric_statements']) {
    assert.equal(redact[group][0].statements.length, 22);
    assert.ok(redact[group][0].statements.every((statement) => statement.startsWith('delete_key(attributes, ')));
  }
  assert.equal(config.extensions['file_storage/observer_queue'].create_directory, true);
});

test('the pinned real Collector accepts the generated config', {
  skip: runRealCollectorTest ? false : 'set WORKBENCH_OTELCOL_CONTRIB to validate with a real Collector',
  timeout: 180_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-real-collector-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const binary = configuredBinary || await downloadCollector({ dataDir: directory });
  const configPath = path.join(directory, 'otel-collector-config.yaml');
  writeCollectorConfig(configPath, { queueDirectory: path.join(directory, 'collector-queue') });

  const result = spawnSync(binary, ['validate', '--config', configPath], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
});
