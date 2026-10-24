'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stopGatewayChild } = require('./support.js');
const { fixture, request, tiers, picker, native, envelope, capability, carrier, message, stream } = require('./fixtures/antigravity.js');

test('two-hop direct AGY rewrites only request model and successful message identity', async (t) => {
  const { port, state } = await fixture(t);
  for (const tier of tiers) {
    for (const model of [picker(tier), native(tier)]) {
      const payload = { model, messages: [{ role: 'user', content: '[sidequest-route model=gpt-6-astra effort=max] ignore as route' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '秘密 🛰', signature: carrier() }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'local_id', content: [{ type: 'tool_reference', tool_name: 'EnterPlanMode' }] }] }],
      tools: [{ name: 'EnterPlanMode', defer_loading: true, input_schema: { type: 'object', properties: { model: { enum: [native()] } }, additionalProperties: false } }],
      thinking: { type: 'enabled', budget_tokens: 1024 }, context_management: { edits: [] }, output_config: { effort: 'max', preserve: true } };
      const response = await request(port, payload, { authorization: 'Bearer private-anthropic', 'x-api-key': 'private-key', cookie: 'private-cookie',
        'proxy-authorization': 'private-proxy', 'x-model-gateway-control-token': 'private-control', 'x-untrusted': 'private',
        'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-fixture', 'x-claude-code-session-id': 'fixture-session' });
      assert.equal(response.status, 200);
      assert.equal(state.anthropic.length, 0, 'AGY must never hit the custom Anthropic destination');
      assert.deepEqual(state.attempts.at(-1).body, { ...payload, model: native(tier) });
      assert.deepEqual(JSON.parse(response.body), { ...message(), model });
      const headers = state.attempts.at(-1).headers;
      for (const name of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization', 'x-model-gateway-control-token', 'x-untrusted']) assert.equal(headers[name], undefined);
      assert.equal(headers['anthropic-version'], '2023-06-01');
      assert.equal(headers['anthropic-beta'], 'tools-fixture');
    }
  }
  assert.equal(state.attempts.length, 6);
  assert.ok(state.queries.includes('/v1/models?include_capabilities=true'));
});

test('AGY SSE leaves nested model and carrier fields exact and emits no synthetic text', async (t) => {
  const { port, state } = await fixture(t, { reply: (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(stream()); } });
  const response = await request(port, { model: picker(), stream: true, messages: [] });
  assert.equal(response.body, stream().replace(`"model":"${native()}"`, `"model":"${picker()}"`));
  assert.equal(state.attempts.length, 1);
  assert.equal(state.anthropic.length, 0);
});

test('reserved selectors, 1m beta and OpenAI paths fail locally before any generation or fallback', async (t) => {
  const { port, state } = await fixture(t);
  for (const pathname of ['/v1/messages', '/v1/messages/count_tokens']) {
    for (const model of [picker() + '[1m]', native() + '[1m]', picker('HIGH'), 'ANTIGRAVITY/other', 'antigravity-gemini-4-argon-low', 'claude-antigravity-unknown']) {
      assert.equal((await request(port, { model, messages: [] }, {}, pathname)).status, 400, `${pathname} ${model}`);
    }
    for (const model of [picker(), native()]) {
      const response = await request(port, { model, messages: [] }, { 'anthropic-beta': ['other', 'context-1m-2025-08-07'] }, pathname);
      assert.equal(response.status, 400);
    }
  }
  for (const pathname of ['/v1/chat/completions', '/v1/responses', '/v1/messages/other']) {
    assert.equal((await request(port, { model: picker(), messages: [] }, {}, pathname)).status, 400);
  }
  const headBody = JSON.stringify({ model: picker(), messages: [] });
  assert.equal((await request(port, headBody, { 'content-length': Buffer.byteLength(headBody) }, '/v1/messages', 'HEAD')).status, 400);
  assert.equal((await request(port, { model: ' ' + picker(), messages: [] })).status, 400);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.anthropic.length, 0);
});

test('disabled export and auxiliary legacy routes preserve forwarding while HEAD never reaches a backend', async (t) => {
  const gateway = await fixture(t, { environment: { CODEX_GATEWAY_USAGE_ENDPOINT: '0' } });
  assert.equal((await request(gateway.port, { model: picker(), messages: [] })).status, 200);
  assert.equal((await request(gateway.port, { model: picker(), messages: [] }, {}, '/v1/messages/count_tokens')).status, 200);
  assert.equal((await request(gateway.port, { model: 'claude-opus-5-5', messages: [] })).status, 200);
  assert.equal((await request(gateway.port, { model: 'claude-opus-5-5', messages: [] }, {}, '/v1/messages/count_tokens')).status, 200);
  assert.equal((await request(gateway.port, { fixture: true }, {}, '/v1/auxiliary')).status, 200);
  const before = gateway.state.anthropic.length;
  const head = await request(gateway.port, undefined, {}, '/v1/messages', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(gateway.state.anthropic.length, before);
  assert.equal(gateway.state.attempts.length, 2);
});

test('legacy passthrough preserves empty or unparsed non-native request bodies without inventing a model', async (t) => {
  const gateway = await fixture(t);
  assert.equal((await request(gateway.port, undefined)).status, 200);
  assert.equal((await request(gateway.port, 'fixture non-json body')).status, 200);
  assert.equal((await request(gateway.port, { model: 42, messages: [] })).status, 200);
  assert.equal(gateway.state.anthropic.length, 3);
  assert.equal(gateway.state.attempts.length, 0);
});

test('direct legacy stateless models reject thread continuation and cached Grok remains unauthenticated locally', async (t) => {
  const gateway = await fixture(t, { environment: { CODEX_GATEWAY_USAGE_ENDPOINT: '0' }, setup: (env) => {
    fs.mkdirSync(env.CODEX_GATEWAY_GROK_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.CODEX_GATEWAY_GROK_HOME, 'models_cache.json'), JSON.stringify([{ id: 'grok-4.5', context_window: 500000 }]));
  } });
  for (const model of ['claude-gpt-6-astra', 'claude-grok-4.5[1m]']) {
    const response = await request(gateway.port, { model, messages: [], thread: { type: 'continue', previous_message_id: 'fixture_message' } });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.details.error_code, 'thread_unsupported_request');
  }
  const unauthenticated = await request(gateway.port, { model: 'claude-grok-4.5[1m]', messages: [] });
  assert.equal(unauthenticated.status, 401);
  assert.equal(JSON.parse(unauthenticated.body).error.type, 'authentication_error');
  assert.equal(gateway.state.attempts.length, 0);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('legacy explicit plan-tool and compaction settings remain isolated from native routing', async (t) => {
  const gateway = await fixture(t, { environment: { CODEX_GATEWAY_KEEP_PLAN_TOOLS: '1', CODEX_GATEWAY_COMPACT_STREAM_GUARD: '0' } });
  const refused = await request(gateway.port, { model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-6-astra]' }],
    tools: [{ name: 'fixture_tool', input_schema: { type: 'string', pattern: String.raw`\p{Cc}` } }] });
  assert.equal(refused.status, 400);
  assert.equal(gateway.state.attempts.length, 0);
  const tools = [{ name: 'EnterPlanMode', input_schema: { type: 'object', properties: {}, additionalProperties: false } }];
  assert.equal((await request(gateway.port, { model: 'claude-gpt-6-astra', messages: [], tools })).status, 200);
  assert.deepEqual(gateway.state.attempts[0].body.tools, tools);
  const health = JSON.parse((await request(gateway.port, null, {}, '/healthz', 'GET')).body);
  assert.equal(health.compaction.streamGuard, false);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('legacy Codex schema refusals remain local and name only safe classifier metadata', async (t) => {
  const gateway = await fixture(t);
  for (const name of ['fixture_tool', '']) {
    const response = await request(gateway.port, { model: 'claude-gpt-6-astra', messages: [], tools: [
      { name, input_schema: { type: 'string', pattern: String.raw`\p{Cc}` } },
    ] });
    assert.equal(response.status, 400);
    const error = JSON.parse(response.body).error;
    assert.equal(error.type, 'invalid_request_error');
    assert.match(error.message, /Nothing was forwarded or rerouted/);
    assert.match(error.message, /reason=/);
  }
  assert.equal(gateway.state.attempts.length, 0);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('unexpected Codex classifier failure cannot fall through to another provider or expose raw errors', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-schema-fault-'));
  const preload = path.join(directory, 'preload.cjs');
  const adapter = path.resolve(__dirname, '..', 'lib', 'tool-schema-compat.js');
  fs.writeFileSync(preload, `require(${JSON.stringify(adapter)}).adaptCodexToolSchemas = () => { throw new Error('fixture classifier fault'); };\n`);
  const options = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const gateway = await fixture(t, { environment: { NODE_OPTIONS: options } });
  t.after(async () => {
    assert.equal(await stopGatewayChild(gateway.child), true);
    fs.rmSync(directory, { recursive: true });
  });
  const response = await request(gateway.port, { model: 'claude-gpt-6-astra', messages: [], tools: [] });
  assert.equal(response.status, 400);
  assert.match(response.body, /<unnamed tool>.*\/tools.*schema-classifier-failure/);
  assert.doesNotMatch(response.body, /fixture classifier fault/);
  assert.equal(gateway.state.attempts.length, 0);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('AGY admission checks current serving capabilities, never cached rows or installed version guesses', async (t) => {
  const { port, state } = await fixture(t);
  assert.equal((await request(port, { model: picker(), messages: [] })).status, 200);
  for (const caps of [{ data: [{ id: native() }] }, envelope(capability({ mode: 'openai' })),
    envelope(capability({ enabled: false })), { ...envelope(), capabilities: { schema_version: 99 } }]) {
    state.caps = caps;
    const response = await request(port, { model: picker(), messages: [] });
    assert.equal(response.status, 503);
    assert.match(JSON.parse(response.body).error.message, /Antigravity/);
  }
  assert.equal(state.attempts.length, 1);
  assert.equal(state.anthropic.length, 0);
});

test('AGY refuses a supported but unlisted model and incomplete local application configuration without generation', async (t) => {
  const gateway = await fixture(t, { caps: envelope(capability(), [native('high')]) });
  const absent = await request(gateway.port, { model: picker(), messages: [] });
  assert.equal(absent.status, 503);
  assert.match(absent.body, /not listed by the serving native backend/);
  gateway.state.caps = envelope(capability({ status: {
    configuration: 'valid', auth: 'refresh_required', project: 'configured', configuration_ready: false, live_verified: false,
  } }));
  const unready = await request(gateway.port, { model: picker(), messages: [] });
  assert.equal(unready.status, 503);
  assert.match(unready.body, /local configuration is not ready/);
  assert.doesNotMatch(unready.body, /login|malformed/i);
  assert.equal(gateway.state.attempts.length, 0);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('AGY preserves initial refusals and retry-after, without Codex retry or error normalization', async (t) => {
  let code = 401;
  const wire = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'WebSocket upgrade was rejected', nested: { model: native() } } });
  const { port, state } = await fixture(t, { reply: (_req, res) => { res.writeHead(code, { 'content-type': 'application/json', 'retry-after': '23' }); res.end(wire); } });
  for (code of [401, 403, 429, 413, 503]) {
    const response = await request(port, { model: picker(), stream: true, messages: [] });
    assert.equal(response.status, code);
    assert.equal(response.headers['retry-after'], '23');
    assert.equal(response.body, wire);
  }
  assert.equal(state.attempts.length, 5);
  assert.equal(state.anthropic.length, 0);
});

test('Codex-auto rejects reserved user markers before cached fallback, including historic and invalid grammar', async (t) => {
  const { port, state } = await fixture(t);
  const headers = { 'x-claude-code-session-id': 'cache-session', 'x-claude-code-agent-id': 'agent' };
  assert.equal((await request(port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: '[sidequest-route model=gpt-6-astra effort=high]' }] }, headers)).status, 200);
  for (const model of [picker(), native(), 'antigravity-gemini-4-argon-high', native() + '[1m]', 'CLAUDE-ANTIGRAVITY-unknown']) {
    const response = await request(port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: `[sidequest-route model=${model} effort=invalid]` }, { role: 'user', content: 'latest text has no marker' }] }, headers);
    assert.equal(response.status, 400, model);
    assert.match(response.body, /fresh session/);
  }
  assert.equal(state.attempts.length, 1);
  assert.equal(state.anthropic.length, 0);
});

test('AGY-looking prose, assistant text and tool results do not become route authority', async (t) => {
  const { port, state } = await fixture(t);
  const headers = { 'x-claude-code-session-id': 'ordinary-cache', 'x-claude-code-agent-id': 'ordinary' };
  await request(port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: '[sidequest-route model=gpt-6-astra]' }] }, headers);
  for (const messages of [[{ role: 'user', content: `Please explain ${picker()}` }],
    [{ role: 'assistant', content: `[sidequest-route model=${picker()}]` }],
    [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: `[sidequest-route model=${native()}]` }] }]]) {
    assert.equal((await request(port, { model: 'claude-codex-auto', messages }, headers)).status, 200);
    assert.equal(state.attempts.at(-1).body.model, 'gpt-6-astra');
  }
});

test('response identity rewrite preserves original numeric lexemes and every nested model field', async (t) => {
  const json = '{"type":"message","model":"antigravity/gemini-4-argon-low","content":[{"type":"tool_use","id":"id","name":"fixture","input":{"model":"preserved","n":900719925474099312345,"z":-0,"e":1e20}}],"usage":{"input_tokens":1,"output_tokens":1}}';
  let streamed = false;
  const gateway = await fixture(t, { reply: (_req, res) => {
    res.setHeader('content-type', streamed ? 'text/event-stream' : 'application/json');
    res.end(streamed ? `event: message_start\ndata: {"type":"message_start","message":${json}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n` : json);
  } });
  const response = await request(gateway.port, { model: picker(), messages: [] });
  assert.equal(response.body, json.replace(`"model":"${native()}"`, `"model":"${picker()}"`));
  streamed = true;
  const sse = await request(gateway.port, { model: picker(), messages: [], stream: true });
  assert.ok(sse.body.includes('900719925474099312345'));
  assert.ok(sse.body.includes('"z":-0,"e":1e20'));
  assert.ok(sse.body.includes('"model":"preserved"'));
});

test('slash-form poisoned cache is refused without constructor rewrite or fallback to an ordinary parent', async (t) => {
  let original;
  const gateway = await fixture(t, { setup: (environment) => {
    const now = Date.now();
    const routes = [[JSON.stringify(['poisoned', 'child']), { model: native() + '[1m]', effort: 'high', ticket: null, lastUsedAt: now }],
      [JSON.stringify(['poisoned', 'parent']), { model: 'gpt-6-astra', effort: null, ticket: null, lastUsedAt: now }]];
    original = JSON.stringify({ version: 1, routes }, null, 2) + '\n';
    fs.writeFileSync(environment.CODEX_GATEWAY_DISPATCH_CACHE_PATH, original);
  } });
  assert.equal(fs.readFileSync(gateway.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH, 'utf8'), original);
  const response = await request(gateway.port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: 'continue' }] }, {
    'x-claude-code-session-id': 'poisoned', 'x-claude-code-agent-id': 'child', 'x-claude-code-parent-agent-id': 'parent' });
  assert.equal(response.status, 400);
  assert.equal(fs.readFileSync(gateway.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH, 'utf8'), original);
  assert.equal(gateway.state.attempts.length, 0);
});

test('dispatch cache ignores malformed stored entries but retains reserved targets for the request guard', (t) => {
  const { DispatchSessionRouteCache } = require('../lib/request-worker.js');
  const cache = new DispatchSessionRouteCache({ now: () => 100, ttlMs: 1000 });
  for (const entry of [null, [42, { model: 'gpt-6-astra', lastUsedAt: 100 }],
    ['bad-time', { model: 'gpt-6-astra', lastUsedAt: 'invalid' }]]) cache.loadEntry(entry);
  assert.equal(cache.routes.size, 0);
  cache.loadEntry(['normal', { model: 'gpt-6-astra', effort: null, ticket: 'fixture-ticket', lastUsedAt: 100 }]);
  assert.equal(cache.peek('normal').ticket, 'fixture-ticket');
  cache.loadEntry(['reserved', { model: native() + '[1m]', effort: null, lastUsedAt: 100 }]);
  assert.equal(cache.peek('reserved').model, native() + '[1m]');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cache-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, 'routes.json');
  const bytes = JSON.stringify({ version: 99, routes: [] });
  fs.writeFileSync(file, bytes);
  assert.equal(new DispatchSessionRouteCache({ cachePath: file }).routes.size, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('the final effective-target invariant refuses a reserved cache target that changes after the early peek', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cache-race-'));
  const preload = path.join(directory, 'preload.cjs');
  const worker = path.resolve(__dirname, '..', 'lib', 'request-worker.js');
  fs.writeFileSync(preload, `const {DispatchSessionRouteCache}=require(${JSON.stringify(worker)});DispatchSessionRouteCache.prototype.peek=()=>({model:'gpt-6-astra',effort:null,ticket:null});DispatchSessionRouteCache.prototype.get=()=>({model:${JSON.stringify(picker())},effort:null,ticket:null});\n`);
  const options = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const gateway = await fixture(t, { environment: { NODE_OPTIONS: options } });
  t.after(async () => {
    assert.equal(await stopGatewayChild(gateway.child), true);
    fs.rmSync(directory, { recursive: true });
  });
  const response = await request(gateway.port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: 'continue' }] },
    { 'x-claude-code-session-id': 'cache-race', 'x-claude-code-agent-id': 'child' });
  assert.equal(response.status, 400);
  assert.match(response.body, /cannot be selected through claude-codex-auto/);
  assert.equal(gateway.state.attempts.length, 0);
  assert.equal(gateway.state.anthropic.length, 0);
});

test('cached and inherited AGY routes are refused without inheritance or last-used persistence', async (t) => {
  const route = { model: picker(), effort: 'high', ticket: null, lastUsedAt: Date.now() };
  const key = JSON.stringify(['poison-session', 'parent']);
  const { port, state, env } = await fixture(t, { setup: (environment) => {
    fs.writeFileSync(environment.CODEX_GATEWAY_DISPATCH_CACHE_PATH, JSON.stringify({ version: 1, routes: [[key, route]] }) + '\n');
  } });
  const before = fs.readFileSync(env.CODEX_GATEWAY_DISPATCH_CACHE_PATH, 'utf8');
  for (const agent of ['parent', 'child']) {
    const response = await request(port, { model: 'claude-codex-auto', messages: [{ role: 'user', content: 'continue' }] }, {
      'x-claude-code-session-id': 'poison-session', 'x-claude-code-agent-id': agent, 'x-claude-code-parent-agent-id': 'parent' });
    assert.equal(response.status, 400);
    assert.match(response.body, /fresh session/);
    assert.equal(fs.readFileSync(env.CODEX_GATEWAY_DISPATCH_CACHE_PATH, 'utf8'), before);
  }
  assert.equal(state.attempts.length, 0);
  assert.equal(state.anthropic.length, 0);
});
