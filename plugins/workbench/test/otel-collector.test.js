'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROJECT_LABEL_PROMOTION,
  REDACTED_KEYS,
  REQUIRED_PROCESSOR_ORDER,
  SINK_EXPORTER,
  buildCollectorConfig,
  renderCollectorYaml,
  toYaml,
  validateCollectorConfig,
  writeCollectorConfig,
} = require('../bin/install-otel-collector.js');

test('the default collector config is valid, loopback-only, and commits to the observer', () => {
  const config = buildCollectorConfig();
  assert.deepEqual(validateCollectorConfig(config), []);
  assert.equal(config.receivers.otlp.protocols.http.endpoint, '127.0.0.1:4318');
  assert.equal(config.exporters['otlphttp/observer'].endpoint, 'http://127.0.0.1:14319');
  assert.equal(config.exporters['otlphttp/observer'].encoding, 'json');
  assert.equal(config.exporters['otlphttp/observer'].compression, 'none');
  assert.equal(config.exporters['otlphttp/observer'].sending_queue.storage, 'file_storage/observer_queue');
  for (const signal of ['logs', 'traces', 'metrics']) {
    assert.deepEqual(config.service.pipelines[signal].processors, REQUIRED_PROCESSOR_ORDER);
  }
});

test('fans every redacted signal out to an explicitly declared sink', () => {
  const sinkExporter = {
    endpoint: 'https://otlp.example.test',
    headers: { Authorization: 'Bearer private' },
    allowRemote: true,
  };
  const config = buildCollectorConfig({ sinkExporter });
  assert.deepEqual(validateCollectorConfig(config, { sinkExporter }), []);
  assert.equal(config.exporters[SINK_EXPORTER].endpoint, 'https://otlp.example.test/');
  assert.equal(config.exporters[SINK_EXPORTER].headers.Authorization, 'Bearer private');
  for (const signal of ['logs', 'traces', 'metrics']) {
    assert.deepEqual(config.service.pipelines[signal].exporters, ['otlphttp/observer', SINK_EXPORTER]);
    assert.deepEqual(config.service.pipelines[signal].processors, REQUIRED_PROCESSOR_ORDER);
  }

  assert.ok(validateCollectorConfig(config).some((error) => error.includes('unexpected exporter')));
  config.exporters[SINK_EXPORTER].endpoint = 'https://other.example.test/';
  assert.ok(validateCollectorConfig(config, { sinkExporter }).some((error) => error.includes('declared sink endpoint')));
});

test('promotes the project resource attribute to a metric datapoint label', () => {
  const config = buildCollectorConfig();
  const statements = config.processors['transform/redact'].metric_statements[0].statements;
  assert.equal(statements[0], PROJECT_LABEL_PROMOTION);

  statements.shift();
  assert.ok(validateCollectorConfig(config).some((error) => error.includes('promote resource project.id')));
});

test('validation rejects a non-loopback exporter endpoint', () => {
  const config = buildCollectorConfig();
  config.exporters['otlphttp/observer'].endpoint = 'http://10.0.0.5:4318';
  const errors = validateCollectorConfig(config);
  assert.ok(errors.some((e) => e.includes('loopback')));
});

test('validation requires the observer-compatible OTLP transport', () => {
  const protobuf = buildCollectorConfig();
  protobuf.exporters['otlphttp/observer'].encoding = 'proto';
  assert.ok(validateCollectorConfig(protobuf).some((e) => e.includes('encoding must be json')));

  const compressed = buildCollectorConfig();
  compressed.exporters['otlphttp/observer'].compression = 'gzip';
  assert.ok(validateCollectorConfig(compressed).some((e) => e.includes('compression must be none')));
});

test('validation rejects a reordered pipeline and a debug exporter', () => {
  const reordered = buildCollectorConfig();
  reordered.service.pipelines.logs.processors = ['batch', 'memory_limiter', 'filter/signals', 'transform/redact'];
  assert.ok(validateCollectorConfig(reordered).some((e) => e.includes('processor order')));

  const withDebug = buildCollectorConfig();
  withDebug.exporters.debug = { verbosity: 'detailed' };
  withDebug.service.pipelines.logs.exporters = ['otlphttp/observer', 'debug'];
  assert.ok(validateCollectorConfig(withDebug).some((e) => e.includes('forbidden exporter')));
});

test('validation requires the content-stripping processor and the persistent queue', () => {
  const noRedact = buildCollectorConfig();
  delete noRedact.processors['transform/redact'];
  assert.ok(validateCollectorConfig(noRedact).some((e) => e.includes('transform/redact')));

  const incompleteRedaction = buildCollectorConfig();
  incompleteRedaction.processors['transform/redact'].log_statements[0].statements.pop();
  assert.ok(validateCollectorConfig(incompleteRedaction).some((e) => e.includes('content stripping')));

  const noQueue = buildCollectorConfig();
  delete noQueue.extensions['file_storage/observer_queue'];
  assert.ok(validateCollectorConfig(noQueue).some((e) => e.includes('file_storage')));
});

test('the redaction processor deletes content-bearing attributes for every signal', () => {
  const config = buildCollectorConfig();
  const statements = config.processors['transform/redact'].log_statements[0].statements.join(' ');
  for (const key of ['prompt', 'content', 'tool_response', 'authorization', 'transcript_path']) {
    assert.ok(REDACTED_KEYS.includes(key));
    assert.ok(statements.includes(`delete_key(attributes, "${key}")`), `not redacted: ${key}`);
  }
  assert.ok(config.processors['transform/redact'].trace_statements);
  assert.ok(config.processors['transform/redact'].metric_statements);
});

test('toYaml aligns object-array fields as a YAML block sequence', () => {
  assert.equal(toYaml({
    statements: [{ context: 'log', statements: ['delete(attributes["body"])'] }],
  }), [
    'statements:',
    '  - context: "log"',
    '    statements: ["delete(attributes[\\"body\\"])\"]',
  ].join('\n'));
});

test('renderCollectorYaml emits parseable-looking YAML with the right markers and no debug exporter', () => {
  const yaml = renderCollectorYaml();
  assert.ok(yaml.includes('endpoint: "127.0.0.1:4318"'));
  assert.ok(yaml.includes('otlphttp/observer:'));
  assert.ok(yaml.includes('encoding: "json"'));
  assert.ok(yaml.includes('compression: "none"'));
  assert.ok(yaml.includes('memory_limiter:'));
  assert.ok(yaml.includes('transform/redact:'));
  assert.ok(yaml.includes('set(attributes[\\"project.id\\"], resource.attributes[\\"project.id\\"])'));
  assert.ok(yaml.includes('file_storage/observer_queue:'));
  assert.equal(/\n\s+debug:/.test(yaml), false);
  // processors list renders inline in order.
  assert.ok(yaml.includes('processors: ["memory_limiter", "filter/signals", "transform/redact", "batch"]'));
});

test('writeCollectorConfig writes a config file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-collector-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'nested', 'config.yaml');
  const written = writeCollectorConfig(target);
  assert.equal(written, target);
  assert.ok(fs.readFileSync(target, 'utf8').includes('otlphttp/observer:'));
});
