'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildCollectorConfig } = require('../bin/install-otel-collector.js');
const { normalizeObservation } = require('../lib/observability/ingest.js');
const { otlpToObservations, nanoToIso } = require('../lib/observability/otlp.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { createObserver } = require('../bin/workbench-observer.js');

const TRACE = '0123456789abcdef0123456789abcdef';
const SPAN = '1122334455667788';
const PARENT = 'aabbccddeeff0011';
const NANO = '1721378400000000000';

function attrs(map) {
  return Object.entries(map).map(([key, value]) => {
    if (typeof value === 'boolean') return { key, value: { boolValue: value } };
    if (typeof value === 'number') return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
    return { key, value: { stringValue: value } };
  });
}

function accept(observations) {
  for (const observation of observations) {
    const result = normalizeObservation(observation);
    assert.equal(result.accepted, true, `${observation.event_name} rejected: ${JSON.stringify(result.rejectedFields)}`);
  }
}

test('nanoToIso converts nanosecond strings and rejects junk', () => {
  assert.equal(nanoToIso(NANO), new Date(1721378400000).toISOString());
  assert.equal(nanoToIso('not-a-number'), null);
});

test('logs convert to canonical claude_code observations with measurements and drop unknown fields', () => {
  const body = {
    resourceLogs: [{
      resource: { attributes: attrs({ 'session.id': 'session-1' }) },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: NANO,
          eventName: 'claude_code.api_request',
          traceId: TRACE,
          spanId: SPAN,
          body: { stringValue: 'PROMPT TEXT MUST NOT LEAK' },
          attributes: attrs({
            model: 'claude-opus-4-8',
            status: 'ok',
            input_tokens: 1200,
            output_tokens: 300,
            'secret.body': 'PRIVATE VALUE',
          }),
        }],
      }],
    }],
  };
  const observations = otlpToObservations('logs', body, { projectId: 'a'.repeat(64) });
  accept(observations);

  const request = observations.find((o) => o.event_name === 'claude_code.api_request');
  assert.equal(request.session_id, 'session-1');
  assert.equal(request.trace_id, TRACE);
  assert.equal(request.attributes.model, 'claude-opus-4-8');
  assert.equal(request.attributes.status, 'ok');
  const names = request.measurements.map((m) => `${m.name}:${m.scope}:${m.quality}`).sort();
  assert.deepEqual(names, ['input_tokens:request:exact_provider', 'output_tokens:request:exact_provider']);

  const drop = observations.find((o) => o.event_name === 'schema_drop');
  assert.ok(drop.attributes.field_names.includes('secret_body'));

  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes('PROMPT TEXT'), false);
  assert.equal(serialized.includes('PRIVATE VALUE'), false);
});

test('an unmapped log event name becomes an explicit coverage gap, never a guess', () => {
  const body = {
    resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: NANO, eventName: 'vendor.custom.thing', attributes: [] }] }] }],
  };
  const observations = otlpToObservations('logs', body);
  accept(observations);
  assert.equal(observations.some((o) => o.event_name === 'coverage_gap' && o.attributes.status === 'unmapped_log'), true);
  assert.equal(observations.some((o) => o.event_name === 'claude_code.api_request'), false);
});

test('spans carry trace parentage as a link and inherit hex ids', () => {
  const body = {
    resourceSpans: [{
      resource: { attributes: [] },
      scopeSpans: [{
        spans: [{
          traceId: TRACE, spanId: SPAN, parentSpanId: PARENT,
          name: 'claude_code.llm_request', startTimeUnixNano: NANO,
          attributes: attrs({ model: 'claude-opus-4-8', status: 'ok' }),
        }],
      }],
    }],
  };
  const observations = otlpToObservations('traces', body);
  accept(observations);
  const span = observations.find((o) => o.event_name === 'claude_code.llm_request');
  assert.equal(span.parent_span_id, PARENT);
  assert.equal(span.trace_id, TRACE);
  assert.equal(span.span_id, SPAN);
});

test('scalar metrics map to measurements; histograms become coverage gaps', () => {
  const body = {
    resourceMetrics: [{
      resource: { attributes: [] },
      scopeMetrics: [{
        metrics: [
          { name: 'claude_code.cost.usage', sum: { dataPoints: [{ asDouble: 0.05, timeUnixNano: NANO, attributes: attrs({ model: 'claude-opus-4-8' }) }] } },
          { name: 'claude_code.latency', histogram: { dataPoints: [{ timeUnixNano: NANO }] } },
        ],
      }],
    }],
  };
  const observations = otlpToObservations('metrics', body);
  accept(observations);
  const metric = observations.find((o) => o.event_name === 'otel.metric');
  assert.equal(metric.measurements[0].name, 'cost_usd');
  assert.equal(metric.measurements[0].scope, 'aggregate');
  assert.equal(metric.measurements[0].quality, 'estimate');
  assert.equal(observations.some((o) => o.event_name === 'coverage_gap' && o.attributes.status === 'unsupported_metric_shape'), true);
});

// --- Observer HTTP wiring (injected fake store, no SQLite) ---

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function post(port, pathname, body, contentType) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: { 'content-type': contentType || 'application/json', 'content-length': Buffer.byteLength(payload) } },
    (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    req.on('error', reject); req.end(payload);
  });
}

test('observer accepts OTLP JSON on /v1/logs and rejects protobuf with 415', async (t) => {
  const ingested = [];
  let committed = true;
  const fakeStore = {
    ingestBatch(observations) { ingested.push(...observations); return observations.map(() => ({ accepted: true, committed })); },
    queryView() { return [{}]; },
    close() {},
  };
  const port = await freePort();
  const observer = createObserver({ port, store: fakeStore });
  await observer.start();
  t.after(() => observer.close());

  const logs = { resourceLogs: [{ resource: { attributes: attrs({ 'session.id': 'session-1' }) },
    scopeLogs: [{ logRecords: [{ timeUnixNano: NANO, eventName: 'claude_code.api_request', attributes: attrs({ model: 'claude-opus-4-8', input_tokens: 10 }) }] }] }] };
  const ok = await post(port, '/v1/logs', logs);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), {});
  assert.equal(ingested.some((o) => o.event_name === 'claude_code.api_request'), true);

  committed = false;
  const uncommitted = await post(port, '/v1/logs', logs);
  assert.equal(uncommitted.status, 503);

  const protobuf = await post(port, '/v1/traces', 'binarydata', 'application/x-protobuf');
  assert.equal(protobuf.status, 415);
});

test('Collector transport gets an OTLP acknowledgement after the observer commits', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-otlp-ack-'));
  const store = openObservabilityStore(path.join(directory, 'ledger.db'));
  const observer = createObserver({ port: 0, store, projectId: 'a'.repeat(64) });
  t.after(async () => {
    await observer.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const address = await observer.start();
  const config = buildCollectorConfig({ observerEndpoint: `http://127.0.0.1:${address.port}` });
  const exporter = config.exporters['otlphttp/observer'];

  assert.equal(exporter.encoding, 'json');
  assert.equal(exporter.compression, 'none');
  const response = await fetch(`${exporter.endpoint}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: { attributes: attrs({ 'session.id': 'session-e2e' }) },
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: NANO,
            body: { stringValue: 'REAL USER CONTENT MUST NOT PERSIST' },
            attributes: attrs({
              'event.name': 'claude_code.api_request',
              model: 'claude-opus-4-8',
              status: 'ok',
              input_tokens: 10,
            }),
          }],
        }],
      }],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'claude_code.api_request'").get().count, 1);
  const persisted = JSON.stringify({
    observations: store.database.prepare('SELECT * FROM observation').all(),
    outbox: store.database.prepare('SELECT payload_json FROM otlp_outbox').all(),
  });
  assert.equal(persisted.includes('REAL USER CONTENT'), false);
});
