'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildStatuslineObservations, renderStatusline } = require('../bin/workbench-statusline.js');
const { buildPreflightOutput } = require('../hooks/request-body-preflight.js');
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

test('missing or oversized transcripts fail open', (t) => {
  const oversized = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-body-')), 'transcript.jsonl');
  t.after(() => fs.rmSync(path.dirname(oversized), { recursive: true, force: true }));
  fs.writeFileSync(oversized, 'x');
  fs.truncateSync(oversized, 37 * 1024 * 1024);
  assert.equal(estimateRequestBodyBytes(path.join(__dirname, 'fixtures', 'missing.jsonl')), null);
  assert.equal(estimateRequestBodyBytes(oversized), null);
});
