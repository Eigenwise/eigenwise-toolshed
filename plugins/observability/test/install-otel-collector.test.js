'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  PROJECT_LABEL_PROMOTION,
  buildCollectorConfig,
  writeCollectorConfig,
} = require('../bin/install-otel-collector.js');
const { downloadCollector } = require('../bin/setup-observability.js');

const configuredBinary = process.env.WORKBENCH_OTELCOL_CONTRIB;
const runRealCollectorTest = Boolean(configuredBinary || process.env.CI);

test('the Collector config uses supported redaction and creates its queue directory', () => {
  const config = buildCollectorConfig();
  const redact = config.processors['transform/redact'];
  for (const group of ['log_statements', 'trace_statements']) {
    assert.equal(redact[group][0].statements.length, 22);
    assert.ok(redact[group][0].statements.every((statement) => statement.startsWith('delete_key(attributes, ')));
  }
  assert.equal(redact.metric_statements[0].statements.length, 23);
  assert.equal(redact.metric_statements[0].statements[0], PROJECT_LABEL_PROMOTION);
  assert.ok(redact.metric_statements[0].statements.slice(1).every((statement) => statement.startsWith('delete_key(attributes, ')));
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function waitFor(check, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(async () => {
      if (await check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('timed out waiting for collector output'));
      }
    }, 50);
  });
}

test('the real Collector converts delta sums and forwards gateway usage logs', {
  skip: runRealCollectorTest ? false : 'set WORKBENCH_OTELCOL_CONTRIB to run the Collector transport test',
  timeout: 60_000,
}, async (t) => {
  const received = [];
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  const observerPort = await listen(receiver);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-collector-runtime-'));
  const collectorPort = await new Promise((resolve) => {
    const portProbe = net.createServer();
    portProbe.listen(0, '127.0.0.1', () => {
      const { port } = portProbe.address();
      portProbe.close(() => resolve(port));
    });
  });
  const configPath = path.join(directory, 'otel-collector-config.yaml');
  writeCollectorConfig(configPath, {
    receiverEndpoint: `127.0.0.1:${collectorPort}`,
    observerEndpoint: `http://127.0.0.1:${observerPort}`,
    queueDirectory: path.join(directory, 'collector-queue'),
  });
  const binary = configuredBinary || await downloadCollector({ dataDir: directory });
  const collector = spawn(binary, ['--config', configPath], { stdio: 'ignore' });
  t.after(() => {
    collector.kill();
    receiver.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const now = String(Date.now() * 1_000_000);
  await waitFor(async () => {
    try {
      return await post(collectorPort, '/v1/logs', { resourceLogs: [] }) === 200;
    } catch {
      return false;
    }
  });
  assert.equal(await post(collectorPort, '/v1/metrics', {
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code_tokens_total', sum: {
      aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ asInt: '5', startTimeUnixNano: now, timeUnixNano: now }],
    } }] }] }],
  }), 200);
  assert.equal(await post(collectorPort, '/v1/logs', {
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: now, attributes: [
      { key: 'event.name', value: { stringValue: 'gateway.token.usage' } },
    ] }] }] }],
  }), 200);

  await waitFor(() => received.some((entry) => entry.path === '/v1/metrics') && received.some((entry) => entry.path === '/v1/logs'));
  const metric = received.find((entry) => entry.path === '/v1/metrics').body.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.sum.aggregationTemporality, 2);
  const log = received.find((entry) => entry.path === '/v1/logs').body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.attributes.find((attribute) => attribute.key === 'event.name').value.stringValue, 'gateway.token.usage');
});
