'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildStatuslineObservations,
  formatObserverHealthStatus,
  readObserverHealth,
  renderStatusline,
} = require('../bin/statusline.js');
const { createObserver } = require('../bin/observer.js');
const { buildPreflightOutput } = require('../hooks/request-body-preflight.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const {
  REQUEST_BODY_WARNING_BYTES,
  estimateRequestBodyBytes,
  formatRequestBodyStatus,
  requestBodyHighWaterPath,
} = require('../lib/observability/request-body.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'request-body-transcript.jsonl');
const NOW = new Date('2026-07-19T10:00:00.000Z');

function runStatusline(payload, environment) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'statusline.js')], { env: environment });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function seedStalledObserverOutbox(databasePath) {
  const store = openObservabilityStore(databasePath);
  const [observation] = buildStatuslineObservations({
    session_id: 'stalled-observer',
    model: { id: 'claude-test' },
    context_window: { total_input_tokens: 100, context_window_size: 1000 },
  }, new Date(), null);
  const result = store.ingest(observation);
  store.close();
  assert.equal(result.accepted, true);
}

async function waitForObserverError(port, expectedError) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await response.json();
      if (health.error === expectedError) return health;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Observer did not report ${expectedError} on port ${port}.`);
}

async function startTemporaryObserver(directory, databasePath, seedOutbox) {
  if (seedOutbox) seedStalledObserverOutbox(databasePath);
  const observer = createObserver({
    databaseFile: databasePath,
    host: '127.0.0.1',
    port: 0,
    outboxIntervalMs: 250,
    hookSpoolFile: path.join(directory, 'observer-spool.jsonl'),
    sink: {
      id: 'test',
      egress: 'loopback',
      outbox: { enabled: true, endpoint: 'http://127.0.0.1:45679/v1/logs', headers: {}, allowRemote: false },
    },
    fetch: async () => { throw new TypeError('test sink unavailable'); },
  });
  const address = await observer.start();
  let closed = false;
  const closeObserver = async () => {
    if (closed) return;
    closed = true;
    await observer.close();
  };
  return { closeObserver, healthUrl: `http://127.0.0.1:${address.port}/health` };
}

test('request-body high water uses the gateway record instead of the transcript', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-body-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = 'session-1';
  fs.writeFileSync(requestBodyHighWaterPath(sessionId, directory), JSON.stringify({ value: 1234567 }));
  const estimate = estimateRequestBodyBytes(sessionId, directory);
  assert.deepEqual(estimate, { value: 1234567, warning: false });

  const observations = buildStatuslineObservations({
    session_id: sessionId,
    transcript_path: FIXTURE,
    context_window: { total_input_tokens: 42000, context_window_size: 1000000 },
  }, NOW, estimate);
  const body = observations[0].measurements.find((measurement) => measurement.name === 'request_body_bytes');
  assert.equal(body.value, estimate.value);
  assert.equal(body.quality, 'exact_client');
});

test('request-body threshold is visible in the statusline and warns before Task dispatch', () => {
  const estimate = { value: REQUEST_BODY_WARNING_BYTES, warning: true };
  assert.match(formatRequestBodyStatus(estimate), /^body peak 24\.0MB\/32MB WARNING$/);
  assert.equal(renderStatusline('', estimate), 'body peak 24.0MB/32MB WARNING');

  const output = buildPreflightOutput({ hook_event_name: 'PreToolUse', tool_name: 'Task' }, estimate);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /near the 32MB limit/);
  assert.equal(buildPreflightOutput({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, estimate), null);

  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const preflight = hooks.PreToolUse.find((group) => group.matcher === 'Agent|Task');
  assert.ok(preflight.hooks.some((hook) => hook.command.includes('request-body-preflight.js')));
});

test('statusline renders a degraded observer verdict and stays quiet when healthy', () => {
  assert.equal(formatObserverHealthStatus({ ok: false, error: 'outbox_not_draining' }), 'obs: outbox_not_draining');
  assert.equal(renderStatusline('', null, null, { ok: false, error: 'outbox_not_draining' }), 'obs: outbox_not_draining');
  assert.equal(renderStatusline('', null, null, { ok: true }), '');
});

test('statusline health lookup sends a bounded request and fails silent', async () => {
  let request;
  const health = await readObserverHealth(async (url, options) => {
    request = { url, options };
    return { ok: false, json: async () => ({ ok: false, error: 'outbox_not_draining' }) };
  }, {});
  assert.ok(request);
  assert.equal(request.url, 'http://127.0.0.1:14319/health');
  assert.ok(request.options.signal);
  assert.deepEqual(health, { ok: false, error: 'outbox_not_draining' });
  assert.equal(await readObserverHealth(async () => { throw new TypeError('observer unavailable'); }, {}), null);
});

test('real statusline invocation appends subscription burn and ledgers both windows', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-statusline-'));
  const spoolPath = path.join(directory, 'spool.jsonl');
  const rendererPath = path.join(directory, 'renderer.js');
  const databasePath = path.join(directory, 'observability.db');
  fs.writeFileSync(rendererPath, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('custom'));\n");
  const { closeObserver, healthUrl } = await startTemporaryObserver(directory, databasePath, false);
  let store;
  t.after(async () => {
    if (store) store.close();
    await closeObserver();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const payload = {
    session_id: 'session-rate-limits',
    model: { id: 'claude-opus-4-8' },
    rate_limits: {
      five_hour: { used_percentage: 62.4, resets_at: 1738425600 },
      seven_day: { used_percentage: 34.2, resets_at: 1738857600 },
    },
  };
  const result = await runStatusline(payload, {
    ...process.env,
    LOCALAPPDATA: directory,
    WORKBENCH_HOOK_SPOOL: spoolPath,
    WORKBENCH_OBSERVER_HEALTH_URL: healthUrl,
    WORKBENCH_STATUSLINE_RENDER: `"${process.execPath}" "${rendererPath}"`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'custom | 5h: 62% 7d: 34%');

  await closeObserver();
  store = openObservabilityStore(databasePath);
  const observations = fs.readFileSync(spoolPath, 'utf8').trim().split('\n').map(JSON.parse);
  for (const observation of observations) assert.equal(store.ingest(observation).accepted, true);
  const values = Object.fromEntries(store.database.prepare(`
    SELECT m.name, m.value
    FROM measurement m
    JOIN observation o ON o.event_id = m.event_id
    WHERE o.event_name = 'statusline.rate_limit'
  `).all().map((row) => [row.name, row.value]));
  assert.equal(values.rate_limit_five_hour_used_percent, 62.4);
  assert.equal(values.rate_limit_five_hour_reset_at_ms, 1738425600000);
  assert.equal(values.rate_limit_seven_day_used_percent, 34.2);
  assert.equal(values.rate_limit_seven_day_reset_at_ms, 1738857600000);
});

test('real statusline invocation appends a stalled outbox health suffix', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-statusline-'));
  const spoolPath = path.join(directory, 'spool.jsonl');
  const rendererPath = path.join(directory, 'renderer.js');
  const databasePath = path.join(directory, 'observability.db');
  fs.writeFileSync(rendererPath, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('custom'));\n");
  const { closeObserver, healthUrl } = await startTemporaryObserver(directory, databasePath, true);
  t.after(async () => {
    await closeObserver();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const health = await waitForObserverError(Number(new URL(healthUrl).port), 'outbox_stalled');
  assert.equal(health.outbox.pending_count, 1);

  const payload = {
    session_id: 'session-rate-limits',
    model: { id: 'claude-opus-4-8' },
    rate_limits: {
      five_hour: { used_percentage: 62.4, resets_at: 1738425600 },
      seven_day: { used_percentage: 34.2, resets_at: 1738857600 },
    },
  };
  const result = await runStatusline(payload, {
    ...process.env,
    LOCALAPPDATA: directory,
    WORKBENCH_HOOK_SPOOL: spoolPath,
    WORKBENCH_OBSERVER_HEALTH_URL: healthUrl,
    WORKBENCH_STATUSLINE_RENDER: `"${process.execPath}" "${rendererPath}"`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'custom | 5h: 62% 7d: 34% | obs: outbox_stalled');
  await closeObserver();
});

test('gateway records stay readable after a transcript exceeds the former limit', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-body-'));
  const transcript = path.join(directory, 'transcript.jsonl');
  const sessionId = 'large-session';
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(transcript, 'x');
  fs.truncateSync(transcript, 37 * 1024 * 1024);
  fs.writeFileSync(requestBodyHighWaterPath(sessionId, directory), JSON.stringify({ value: 1024 }));
  assert.deepEqual(estimateRequestBodyBytes(sessionId, directory), { value: 1024, warning: false });
});

test('missing gateway records fail open', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-body-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(estimateRequestBodyBytes('missing-session', directory), null);
});
