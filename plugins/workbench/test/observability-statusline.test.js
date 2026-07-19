'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildStatuslineObservations, renderStatusline } = require('../bin/workbench-statusline.js');
const { buildPreflightOutput } = require('../hooks/request-body-preflight.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const {
  REQUEST_BODY_WARNING_BYTES,
  estimateRequestBodyBytes,
  formatRequestBodyStatus,
} = require('../lib/observability/request-body.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'request-body-transcript.jsonl');
const NOW = new Date('2026-07-19T10:00:00.000Z');

test('request-body estimate counts base64 fixture bytes without exposing attachment data', () => {
  const estimate = estimateRequestBodyBytes(FIXTURE);
  assert.equal(estimate.attachment_bytes, 12);
  assert.equal(estimate.value, estimate.attachment_bytes + estimate.text_allowance_bytes);
  assert.equal(estimate.warning, false);

  const observations = buildStatuslineObservations({
    session_id: 'session-1',
    transcript_path: FIXTURE,
    context_window: { total_input_tokens: 42000, context_window_size: 1000000 },
  }, NOW, estimate);
  const body = observations[0].measurements.find((measurement) => measurement.name === 'request_body_bytes');
  assert.equal(body.value, estimate.value);
  assert.equal(body.quality, 'estimate');
  assert.equal(body.scope, 'context_snapshot');
  assert.equal(JSON.stringify(observations).includes('AQID'), false);
});

test('request-body threshold is visible in the statusline and warns before Task dispatch', () => {
  const estimate = { value: REQUEST_BODY_WARNING_BYTES, warning: true };
  assert.match(formatRequestBodyStatus(estimate), /^body ~26\.0MB\/32MB WARNING: \/compact before spawning$/);
  assert.equal(renderStatusline('', estimate), 'body ~26.0MB/32MB WARNING: /compact before spawning');

  const output = buildPreflightOutput({ hook_event_name: 'PreToolUse', tool_name: 'Task' }, estimate);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /near the 32MB limit/);
  assert.equal(buildPreflightOutput({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, estimate), null);

  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const preflight = hooks.PreToolUse.find((group) => group.matcher === 'Agent|Task');
  assert.ok(preflight.hooks.some((hook) => hook.command.includes('request-body-preflight.js')));
});

test('real statusline invocation appends subscription burn and ledgers both windows', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-statusline-'));
  const spoolPath = path.join(directory, 'spool.jsonl');
  const rendererPath = path.join(directory, 'renderer.js');
  const databasePath = path.join(directory, 'observability.db');
  fs.writeFileSync(rendererPath, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('custom'));\n");

  const payload = {
    session_id: 'session-rate-limits',
    model: { id: 'claude-opus-4-8' },
    rate_limits: {
      five_hour: { used_percentage: 62.4, resets_at: 1738425600 },
      seven_day: { used_percentage: 34.2, resets_at: 1738857600 },
    },
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'workbench-statusline.js')], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      WORKBENCH_HOOK_SPOOL: spoolPath,
      WORKBENCH_STATUSLINE_RENDER: `"${process.execPath}" "${rendererPath}"`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'custom | 5h: 62% 7d: 34%');

  const store = openObservabilityStore(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
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

test('missing or oversized transcripts fail open', (t) => {
  const oversized = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-body-')), 'transcript.jsonl');
  t.after(() => fs.rmSync(path.dirname(oversized), { recursive: true, force: true }));
  fs.writeFileSync(oversized, 'x');
  fs.truncateSync(oversized, 37 * 1024 * 1024);
  assert.equal(estimateRequestBodyBytes(path.join(__dirname, 'fixtures', 'missing.jsonl')), null);
  assert.equal(estimateRequestBodyBytes(oversized), null);
});
