'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');
const grok = require('../lib/grok-backend.js');

test('translates Anthropic messages, tools, and effort to Responses input', () => {
  const request = grok.translateRequest({
    system: [{ type: 'text', text: 'Be useful.' }],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will look that up.' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }, { type: 'text', text: 'Use this result.' }] },
    ],
    tools: [{ name: 'lookup', description: 'Find things', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    output_config: { effort: 'high' },
    max_tokens: 456,
    stream: true,
  }, 'grok-4.5');

  assert.equal(request.model, 'grok-4.5');
  assert.equal(request.max_output_tokens, 456);
  assert.equal(request.reasoning.effort, 'high');
  assert.deepEqual(request.input[0], { role: 'developer', content: [{ type: 'input_text', text: 'Be useful.' }] });
  assert.deepEqual(request.input[1], { role: 'user', content: [{ type: 'input_text', text: 'hello' }] });
  assert.deepEqual(request.input[2], { role: 'assistant', content: [{ type: 'output_text', text: 'I will look that up.' }] });
  assert.deepEqual(request.input[3], { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' });
  assert.deepEqual(request.input[4], { type: 'function_call_output', call_id: 'call_1', output: 'found' });
  assert.deepEqual(request.input[5], { role: 'user', content: [{ type: 'input_text', text: 'Use this result.' }] });
  assert.equal(request.input.some((item) => item.content?.some((part) => part.type === 'function_call' || part.type === 'function_call_output')), false);
  assert.equal(request.tools[0].type, 'function');
});

test('omits effort for a Grok model without documented reasoning support', () => {
  const request = grok.translateRequest({ output_config: { effort: 'high' } }, 'grok-unknown');
  assert.equal(request.reasoning, undefined);
});
test('omits empty assistant messages for tool-only turns', () => {
  const request = grok.translateRequest({
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }] }],
  }, 'grok-4.5');

  assert.deepEqual(request.input, [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }]);
});

test('refreshes fixture auth without exposing it in return values', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-grok-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({
    'https://auth.x.ai::fixture-client': {
      key: 'fixture-expired-token', refresh_token: 'fixture-refresh-token', expires_at: 0,
      oidc_client_id: 'fixture-client',
    },
  }));
  const token = await grok.refreshGrokAuth({
    file,
    request: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return { status: 200, body: { token_endpoint: 'https://auth.x.ai/oauth/token' } };
      }
      assert.equal(url, 'https://auth.x.ai/oauth/token');
      assert.match(options.body, /grant_type=refresh_token/);
      return { status: 200, body: { access_token: 'fixture-fresh-token', expires_in: 3600 } };
    },
  });
  assert.equal(token, 'fixture-fresh-token');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['https://auth.x.ai::fixture-client'].key, 'fixture-fresh-token');
});

test('reads the CLI version and sends the required Grok headers', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-grok-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'version.json');
  fs.writeFileSync(file, JSON.stringify({ version: '0.2.112' }));
  const headers = grok.grokHeaders('fixture-token', 'grok-4.5', grok.readGrokVersion({ file }));
  assert.equal(headers['x-grok-client-version'], '0.2.112');
  assert.equal(headers['x-grok-model-override'], 'grok-4.5');
  assert.equal(headers['user-agent'], 'xai-grok-build/0.2.112');
});

test('reads the current Grok catalog from the CLI cache', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-grok-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({
    models: {
      'grok-4.5': {
        info: {
          id: 'grok-4.5',
          context_window: 500000,
          supports_reasoning_effort: true,
        },
      },
    },
  }));

  assert.deepEqual(grok.grokModelsFromCache({ file }), [
    { id: 'grok-4.5', context: 500000, reasoning: true },
  ]);
  assert.deepEqual(grok.grokModelIdsFromCache({ file }), ['grok-4.5']);
  assert.deepEqual(grok.GROK_MODELS, [{ id: 'grok-4.5', context: 500000, reasoning: true }]);
});

test('translates Responses completions and stream events to Anthropic messages', () => {
  const response = {
    id: 'resp_fixture',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
  };
  const translated = grok.translateResponse(response, 'claude-grok-4.5');
  assert.deepEqual(translated.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(translated.usage.output_tokens_details.reasoning_tokens, 2);

  const frames = [];
  const stream = grok.createGrokSseTransformer((frame) => frames.push(frame), 'claude-grok-4.5');
  stream.event({ type: 'response.created', response });
  stream.event({ type: 'response.output_text.delta', delta: 'hi', response });
  stream.event({ type: 'response.completed', response });
  assert.match(frames.join(''), /"type":"message_start"/);
  assert.match(frames.join(''), /"type":"text_delta","text":"hi"/);
  assert.match(frames.join(''), /"type":"message_stop"/);
});

test('translates Anthropic web search server tools and Grok web search calls', () => {
  const request = grok.translateRequest({
    tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'lookup', input_schema: { type: 'object', properties: {} } },
    ],
  }, 'grok-4.5');
  assert.deepEqual(request.tools, [
    { type: 'web_search' },
    { type: 'function', name: 'lookup', description: undefined, parameters: { type: 'object', properties: {} } },
  ]);

  const response = {
    output: [{
      type: 'web_search_call',
      id: 'ws_1',
      action: {
        type: 'search',
        query: 'Tokyo population',
        sources: [{ type: 'url', url: 'https://example.com/tokyo', title: 'Tokyo data' }],
      },
    }],
  };
  assert.deepEqual(grok.translateResponse(response, 'claude-grok-4.5').content, [
    { type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: { type: 'search', query: 'Tokyo population' } },
    { type: 'web_search_tool_result', tool_use_id: 'ws_1', content: [{ type: 'web_search_result', title: 'Tokyo data', url: 'https://example.com/tokyo' }] },
  ]);
  assert.equal(grok.translateResponse(response, 'claude-grok-4.5').stop_reason, 'end_turn');
});

test('streams Grok web search calls as server tool blocks', () => {
  const frames = [];
  const stream = grok.createGrokSseTransformer((frame) => frames.push(frame), 'claude-grok-4.5');
  const item = {
    type: 'web_search_call',
    id: 'ws_1',
    action: { type: 'search', query: 'Tokyo population', sources: [{ type: 'url', url: 'https://example.com/tokyo' }] },
  };
  stream.event({ type: 'response.created', response: { id: 'resp_fixture' } });
  stream.event({ type: 'response.output_item.added', output_index: 0, item, response: { id: 'resp_fixture' } });
  stream.event({ type: 'response.output_item.done', output_index: 0, item, response: { id: 'resp_fixture' } });
  stream.event({ type: 'response.completed', response: { id: 'resp_fixture', output: [item] } });

  const events = sseEvents(frames);
  const starts = events.filter((event) => event.type === 'content_block_start');
  assert.deepEqual(starts.map((event) => event.content_block), [
    { type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: { type: 'search', query: 'Tokyo population' } },
    { type: 'web_search_tool_result', tool_use_id: 'ws_1', content: [{ type: 'web_search_result', title: 'https://example.com/tokyo', url: 'https://example.com/tokyo' }] },
  ]);
  assert.equal(events.some((event) => event.content_block?.type === 'tool_use'), false);
  assertWellFormedContentBlocks(events);
});

function sseEvents(frames) {
  return frames.map((frame) => JSON.parse(frame.split('\n')[1].slice('data: '.length)));
}

function assertWellFormedContentBlocks(events) {
  const openIndexes = new Set();
  for (const event of events) {
    if (event.type === 'content_block_start') {
      assert.equal(openIndexes.has(event.index), false);
      openIndexes.add(event.index);
    }
    if (event.type === 'content_block_delta') assert.equal(openIndexes.has(event.index), true);
    if (event.type === 'content_block_stop') assert.equal(openIndexes.delete(event.index), true);
  }
  assert.equal(openIndexes.size, 0);
}

test('streams Grok function calls with their added-item identity', () => {
  const response = {
    id: 'resp_fixture',
    output: [{ type: 'function_call', id: 'fc_resp_0', call_id: 'call_fixture_0', name: 'Read', arguments: '{"file_path":"config.toml"}' }],
  };
  const frames = [];
  const stream = grok.createGrokSseTransformer((frame) => frames.push(frame), 'claude-grok-4.5');
  stream.event({ type: 'response.created', response });
  stream.event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_resp_0', call_id: 'call_fixture_0', name: 'Read', arguments: '', status: 'in_progress' }, response });
  stream.event({ type: 'response.function_call_arguments.delta', item_id: 'fc_resp_0', output_index: 1, delta: '{"file_path":"config.toml"}', response });
  stream.event({ type: 'response.function_call_arguments.done', item_id: 'fc_resp_0', arguments: '{"file_path":"config.toml"}', response });
  stream.event({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_resp_0' }, response });
  stream.event({ type: 'response.completed', response });

  const events = sseEvents(frames);
  const toolStart = events.find((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use');
  assert.deepEqual(toolStart.content_block, { type: 'tool_use', id: 'call_fixture_0', name: 'Read', input: {} });
  assert.deepEqual(events.filter((event) => event.type === 'content_block_delta').map((event) => event.delta.partial_json), ['{"file_path":"config.toml"}']);
  assertWellFormedContentBlocks(events);
});

test('streams text and tool blocks in either order', () => {
  const response = {
    id: 'resp_fixture',
    output: [{ type: 'function_call', id: 'fc_resp_0', call_id: 'call_fixture_0', name: 'Read', arguments: '{}' }],
  };
  const streams = [
    {
      expectedTypes: ['text', 'tool_use'],
      events: [
        { type: 'response.output_text.delta', output_index: 0, delta: 'before' },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_resp_0', call_id: 'call_fixture_0', name: 'Read' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_resp_0', arguments: '{}' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_resp_0' } },
      ],
    },
    {
      expectedTypes: ['tool_use', 'text'],
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_resp_0', call_id: 'call_fixture_0', name: 'Read' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_resp_0', arguments: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_resp_0' } },
        { type: 'response.output_text.delta', output_index: 1, delta: 'after' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'message' } },
      ],
    },
  ];

  for (const { events: upstreamEvents, expectedTypes } of streams) {
    const frames = [];
    const stream = grok.createGrokSseTransformer((frame) => frames.push(frame), 'claude-grok-4.5');
    stream.event({ type: 'response.created', response });
    for (const event of upstreamEvents) stream.event({ ...event, response });
    stream.event({ type: 'response.completed', response });
    const events = sseEvents(frames);
    const starts = events.filter((event) => event.type === 'content_block_start');
    assert.deepEqual(starts.map((event) => event.index), [0, 1]);
    assert.deepEqual(starts.map((event) => event.content_block.type), expectedTypes);
    assert.deepEqual(events.filter((event) => event.type === 'content_block_delta' && event.delta.type === 'input_json_delta').map((event) => event.delta.partial_json), ['{}']);
    assertWellFormedContentBlocks(events);
  }
});

test('the shim lists and routes claude-prefixed Grok models', async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const cli = path.join(__dirname, '..', 'bin', 'model-gateway.js');
  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
  const request = (port, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const authDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-grok-auth-'));
  fs.writeFileSync(path.join(authDirectory, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::fixture-client': { key: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000, oidc_client_id: 'fixture-client' },
  }));
  fs.writeFileSync(path.join(authDirectory, 'models_cache.json'), JSON.stringify({
    models: {
      'grok-4.5': {
        info: { id: 'grok-4.5', context_window: 500000, supports_reasoning_effort: true },
      },
    },
  }));
  const observed = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observed.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_fixture', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  const upstreamPort = await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
  t.after(() => { upstream.close(); fs.rmSync(authDirectory, { recursive: true, force: true }); });
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const child = spawnGatewayProcess(t, process.execPath, [cli, 'serve-worker'], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_WORKER_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort), CODEX_GATEWAY_GROK_HOME: authDirectory, CODEX_GATEWAY_GROK_ENDPOINT: `http://127.0.0.1:${upstreamPort}/v1/responses`, CODEX_GATEWAY_REQUEST_LOG: '0', CODEX_GATEWAY_SENTRY: '0' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  let models;
  for (let retry = 0; retry < 100; retry += 1) {
    try {
      models = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${shimPort}/v1/models`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }).on('error', reject));
      if (models.data) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(models.data.filter((model) => model.id.startsWith('claude-grok-')).map((model) => model.id), ['claude-grok-4.5']);
  const response = await request(shimPort, JSON.stringify({ model: 'claude-grok-4.5', max_tokens: 10, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content[0].text, 'hello');
  assert.equal(observed[0].headers['x-grok-model-override'], 'grok-4.5');
  assert.equal(observed[0].headers['x-grok-client-version'], '0.2.112');
  assert.deepEqual(observed[0].body.reasoning, { effort: 'high' });
});
