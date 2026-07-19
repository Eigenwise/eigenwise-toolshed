'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeObservation } = require('../lib/observability/ingest.js');
const {
  createWorkflowRun,
  flushObservations,
  formatTraceparent,
  normalizeTerminalResult,
  parseTraceparent,
} = require('../lib/observability/sdk.js');

const PROJECT_ID = 'a'.repeat(64);
const PARENT_TRACE = '00-0123456789abcdef0123456789abcdef-1122334455667788-01';

function terminalResult(overrides = {}) {
  return {
    subtype: 'success',
    uuid: 'msg-uuid-1',
    session_id: 'session-1',
    num_turns: 4,
    duration_ms: 5120,
    duration_api_ms: 3980,
    total_cost_usd: 0.0421,
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 64,
    },
    modelUsage: {
      'claude-codex-gpt-5.6-sol': {
        inputTokens: 1000,
        outputTokens: 300,
        cacheReadInputTokens: 800,
        costUSD: 0.0400,
      },
      'claude-haiku-4-5': {
        inputTokens: 200,
        outputTokens: 40,
        costUSD: 0.0021,
      },
    },
    // Content that must never be captured:
    result: 'the assistant said something private',
    cwd: '/home/kenny/secret-project',
    ...overrides,
  };
}

// A faithful SDKResultError shape (subtype error_*, is_error, errors[], permission_denials[]).
function errorResult(overrides = {}) {
  return {
    subtype: 'error_max_turns',
    is_error: true,
    uuid: 'msg-uuid-err',
    session_id: 'session-err',
    num_turns: 12,
    duration_ms: 9100,
    duration_api_ms: 6400,
    total_cost_usd: 0.1337,
    stop_reason: null,
    usage: {
      input_tokens: 4000,
      output_tokens: 900,
    },
    modelUsage: {
      'claude-codex-gpt-5.6-sol': { inputTokens: 4000, outputTokens: 900, costUSD: 0.1337 },
    },
    // Content that must never be captured:
    errors: [{ message: 'private error detail that must not leak' }],
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm secret' } }],
    ...overrides,
  };
}

function assertAccepted(observation) {
  const result = normalizeObservation(observation);
  assert.equal(result.accepted, true, `rejected: ${JSON.stringify(result.rejectedFields)}`);
  assert.deepEqual(result.rejectedFields, []);
  return result;
}

test('parseTraceparent validates and rejects malformed / all-zero context', () => {
  assert.deepEqual(parseTraceparent(PARENT_TRACE), {
    version: '00',
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '1122334455667788',
    flags: '01',
    sampled: true,
  });
  assert.equal(parseTraceparent('not-a-traceparent'), null);
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-1122334455667788-01'), null);
  assert.equal(parseTraceparent('ff-0123456789abcdef0123456789abcdef-1122334455667788-01'), null);

  const unsampled = formatTraceparent('0123456789abcdef0123456789abcdef', '1122334455667788', false);
  assert.equal(unsampled, '00-0123456789abcdef0123456789abcdef-1122334455667788-00');
  assert.equal(parseTraceparent(unsampled).sampled, false);
});

test('createWorkflowRun inherits a parent trace as correlation context and emits no observation', () => {
  const run = createWorkflowRun({
    workflowRunId: 'wf-run-7',
    traceparent: PARENT_TRACE,
    projectId: PROJECT_ID,
  });
  assert.equal(run.workflowRunId, 'wf-run-7');
  assert.equal(run.traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(run.parentSpanId, '1122334455667788');
  assert.equal(run.projectId, PROJECT_ID);
  assert.match(run.traceparent, /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
  // Correlation context only: no terminal observation is fabricated before a real result.
  assert.equal('rootObservation' in run, false);
});

test('createWorkflowRun mints a fresh trace when no parent is supplied', () => {
  const run = createWorkflowRun({});
  assert.match(run.traceId, /^[0-9a-f]{32}$/);
  assert.match(run.spanId, /^[0-9a-f]{16}$/);
  assert.equal(run.workflowRunId, null);
  assert.equal(run.parentSpanId, null);
  assert.equal('rootObservation' in run, false);
});

test('normalizeTerminalResult emits acceptable terminal + per-model observations at run scope', () => {
  const observations = normalizeTerminalResult(terminalResult(), {
    workflowRunId: 'wf-run-7',
    traceparent: PARENT_TRACE,
    parentToolUseId: 'toolu_parent_1',
    projectId: PROJECT_ID,
    observedAt: '2026-07-19T10:05:00.000Z',
  });

  const [terminal, ...models] = observations;
  assert.equal(terminal.event_name, 'agent_sdk.terminal_result');
  assert.equal(terminal.attributes.turns, 4);
  assert.equal(terminal.attributes.status, 'success');
  assert.equal(terminal.trace_id, '0123456789abcdef0123456789abcdef');
  assert.equal(terminal.workflow_run_id, 'wf-run-7');

  // run scope, never request scope (that would double-count api_request usage).
  for (const measurement of terminal.measurements) assert.equal(measurement.scope, 'run');
  const durations = terminal.measurements.filter((m) => m.unit === 'ms').map((m) => m.name).sort();
  assert.deepEqual(durations, ['api_duration_ms', 'duration_ms']);
  const costs = terminal.measurements.filter((m) => m.name === 'cost_usd');
  assert.equal(costs[0].quality, 'estimate');

  const relations = terminal.links.map((l) => `${l.relation}:${l.to_kind}:${l.to_id}`);
  assert.ok(relations.includes('belongs_to:workflow:wf-run-7'));
  assert.ok(relations.includes('child_of:tool:toolu_parent_1'));

  assert.equal(models.length, 2);
  const perModel = models.map((m) => m.attributes.model).sort();
  assert.deepEqual(perModel, ['claude-codex-gpt-5.6-sol', 'claude-haiku-4-5']);
  for (const observation of observations) {
    assert.equal(observation.event_name === 'agent_sdk.assistant_usage'
      ? observation.measurements.every((m) => m.scope === 'run')
      : true, true);
    assertAccepted(observation);
  }
});

test('normalizeTerminalResult leaves workflow and tool links out when their IDs are absent', () => {
  const observations = normalizeTerminalResult(terminalResult(), {
    projectId: PROJECT_ID,
    observedAt: '2026-07-19T10:05:00.000Z',
  });
  const [terminal] = observations;
  assert.equal(terminal.workflow_run_id, undefined);
  assert.equal(terminal.links, undefined);
  for (const observation of observations) assertAccepted(observation);
});

test('normalizeTerminalResult never captures prompt, response, cwd, or env content', () => {
  const observations = normalizeTerminalResult(terminalResult({
    stop_reason: 'end_turn',
  }), { workflowRunId: 'wf-run-7', observedAt: '2026-07-19T10:05:00.000Z' });
  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes('secret-project'), false);
  assert.equal(serialized.includes('something private'), false);
  assert.equal(serialized.includes('/home/kenny'), false);
});

test('normalizeTerminalResult accepts an SDKResultError shape and stays metadata-only', () => {
  const observations = normalizeTerminalResult(errorResult(), {
    workflowRunId: 'wf-run-9',
    projectId: PROJECT_ID,
    observedAt: '2026-07-19T10:06:00.000Z',
  });
  const [terminal, ...models] = observations;
  assert.equal(terminal.event_name, 'agent_sdk.terminal_result');
  assert.equal(terminal.attributes.status, 'error_max_turns');
  assert.equal(terminal.attributes.turns, 12);
  const durations = terminal.measurements.filter((m) => m.unit === 'ms').map((m) => m.name).sort();
  assert.deepEqual(durations, ['api_duration_ms', 'duration_ms']);
  assert.equal(models.length, 1);
  // errors[] and permission_denials[] carry private content that must never be captured.
  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes('private error detail'), false);
  assert.equal(serialized.includes('rm secret'), false);
  assert.equal(serialized.includes('Bash'), false);
  for (const observation of observations) assertAccepted(observation);
});

test('normalizeTerminalResult never reads workflow_run_id from the SDK result', () => {
  const observations = normalizeTerminalResult(terminalResult({ workflow_run_id: 'sdk-should-be-ignored' }), {
    projectId: PROJECT_ID,
    observedAt: '2026-07-19T10:05:00.000Z',
  });
  const [terminal] = observations;
  assert.equal(terminal.workflow_run_id, undefined);
});

test('flushObservations is bounded and fail-open', async () => {
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 200 }; };
  const sent = await flushObservations([{ a: 1 }], { fetch: okFetch, url: 'http://127.0.0.1:14319/v1/observations' });
  assert.deepEqual(sent, { sent: 1, ok: true, status: 200 });
  assert.equal(calls.length, 1);

  assert.deepEqual(await flushObservations([], { fetch: okFetch }), { sent: 0, ok: true });

  const throwingFetch = async () => { throw new Error('ECONNREFUSED'); };
  const failed = await flushObservations([{ a: 1 }], { fetch: throwingFetch });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'unreachable');
});
