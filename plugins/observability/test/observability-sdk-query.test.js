'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeObservation } = require('../lib/observability/ingest.js');
const { AgentSdkQueryFailure, observeQuery } = require('../lib/observability/sdk-query.js');

const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-1122334455667788-01';

function assistant(overrides = {}) {
  return {
    type: 'assistant',
    uuid: 'assistant-uuid-1',
    session_id: 'session-1',
    request_id: 'req-1',
    parent_tool_use_id: 'toolu_parent_1',
    message: {
      id: 'msg-provider-1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 12, output_tokens: 3 },
    },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'result-uuid-1',
    session_id: 'session-1',
    num_turns: 1,
    duration_ms: 120,
    duration_api_ms: 80,
    total_cost_usd: 0.0002,
    usage: { input_tokens: 12, output_tokens: 3 },
    modelUsage: {},
    ...overrides,
  };
}

async function collect(iterator) {
  const messages = [];
  for await (const message of iterator) messages.push(message);
  return messages;
}

function loopbackRecorder() {
  const calls = [];
  return {
    calls,
    flushOptions: {
      url: 'http://127.0.0.1:45681/v1/observations',
      fetch: async (url, init) => {
        calls.push({ url, observations: JSON.parse(init.body) });
        return { ok: true, status: 200 };
      },
    },
  };
}

test('observeQuery consumes real SDK-shaped success messages without buffering their content', async () => {
  const sdkMessages = [
    { type: 'system', subtype: 'init', uuid: 'system-uuid-1', session_id: 'session-1' },
    { type: 'user', uuid: 'user-uuid-1', session_id: 'session-1', parent_tool_use_id: 'toolu_parent_1', message: { content: 'private prompt' } },
    { type: 'stream_event', uuid: 'partial-uuid-1', session_id: 'session-1', parent_tool_use_id: 'toolu_parent_1', event: { type: 'content_block_delta', delta: { text: 'private partial' } } },
    assistant(),
    assistant({ uuid: 'assistant-uuid-duplicate', message: { id: 'msg-provider-1', model: 'claude-opus-4-8', usage: { input_tokens: 12, output_tokens: 3 } } }),
    result({ result: 'private final response' }),
  ];
  let invocation;
  const identities = [];
  const received = [];
  const loopback = loopbackRecorder();
  const query = ({ prompt, options }) => {
    invocation = { prompt, options };
    return (async function* messages() {
      for (const message of sdkMessages) yield message;
    })();
  };

  const output = await collect(observeQuery({
    query,
    prompt: 'private prompt',
    options: { cwd: '/private/project', env: { CALLER_VALUE: 'kept', PATH: 'caller-path' } },
    traceparent: TRACEPARENT,
    tracestate: 'vendor=value',
    flushOptions: loopback.flushOptions,
    onIdentity: async (identity) => identities.push(identity),
    onObservations: async (observations) => received.push(...observations),
  }));

  assert.deepEqual(output, sdkMessages);
  assert.equal(invocation.prompt, 'private prompt');
  assert.equal(invocation.options.env.CALLER_VALUE, 'kept');
  assert.equal(invocation.options.env.PATH, 'caller-path');
  assert.equal(invocation.options.env.TRACEPARENT, TRACEPARENT);
  assert.equal(invocation.options.env.TRACESTATE, 'vendor=value');
  assert.deepEqual(identities.map((identity) => identity.uuid), [
    'system-uuid-1', 'user-uuid-1', 'partial-uuid-1', 'assistant-uuid-1', 'assistant-uuid-duplicate', 'result-uuid-1',
  ]);

  const assistantUsage = received.filter((observation) => observation.event_name === 'agent_sdk.assistant_usage');
  const terminal = received.filter((observation) => observation.event_name === 'agent_sdk.terminal_result');
  assert.equal(assistantUsage.length, 1);
  assert.equal(terminal.length, 1);
  assert.equal(assistantUsage[0].request_id, 'req-1');
  assert.deepEqual(assistantUsage[0].links, [{ relation: 'child_of', to_kind: 'tool', to_id: 'toolu_parent_1', method: 'direct_id', quality: 'exact_client' }]);
  assert.equal(terminal[0].session_id, 'session-1');
  assert.deepEqual(terminal[0].links, [{ relation: 'child_of', to_kind: 'tool', to_id: 'toolu_parent_1', method: 'direct_id', quality: 'exact_client' }]);
  assert.equal(loopback.calls.length, 2);
  for (const observation of received) {
    const normalized = normalizeObservation(observation);
    assert.equal(normalized.accepted, true, JSON.stringify(normalized.rejectedFields));
  }
  assert.equal(JSON.stringify(loopback.calls).includes('private'), false);
});

test('observeQuery leaves Agent SDK automatic propagation alone without explicit trace context', async () => {
  let invocation;
  const query = ({ prompt, options }) => {
    invocation = { prompt, options };
    return (async function* messages() { yield result(); })();
  };

  await collect(observeQuery({ query, prompt: 'hello', options: { env: { CALLER_VALUE: 'kept' } }, flushOptions: loopbackRecorder().flushOptions }));

  assert.deepEqual(invocation.options.env, { CALLER_VALUE: 'kept' });
});

test('observeQuery keeps an SDK error result when the iterator throws afterwards', async () => {
  const loopback = loopbackRecorder();
  const sdkError = result({
    subtype: 'error_max_turns',
    is_error: true,
    uuid: 'result-error-uuid',
    errors: [{ message: 'private error detail' }],
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'private command' } }],
  });
  const query = () => (async function* messages() {
    yield { type: 'system', subtype: 'init', uuid: 'system-uuid-1', session_id: 'session-1' };
    yield sdkError;
    throw new Error('iterator closes after result');
  })();

  const output = await collect(observeQuery({ query, prompt: 'hello', flushOptions: loopback.flushOptions }));

  assert.deepEqual(output, [{ type: 'system', subtype: 'init', uuid: 'system-uuid-1', session_id: 'session-1' }, sdkError]);
  assert.equal(loopback.calls.length, 1);
  const emitted = loopback.calls[0].observations[0];
  assert.equal(emitted.attributes.status, 'error_max_turns');
  assert.equal(JSON.stringify(emitted).includes('private'), false);
});

test('observeQuery throws a typed failure before the SDK emits a result', async () => {
  const loopback = loopbackRecorder();
  const query = () => (async function* messages() {
    yield { type: 'system', subtype: 'init', uuid: 'system-uuid-1', session_id: 'session-1' };
    throw new Error('transport failed');
  })();

  await assert.rejects(
    collect(observeQuery({ query, prompt: 'hello', flushOptions: loopback.flushOptions })),
    (error) => error instanceof AgentSdkQueryFailure && error.code === 'agent_sdk_iterator_failed',
  );
  assert.equal(loopback.calls.length, 0);
});
