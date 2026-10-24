'use strict';

const http = require('node:http');
const { setTimeout: pause } = require('node:timers/promises');
const { gatewayTestEnvironment, startGateway } = require('../support.js');
const tiers = ['low', 'medium', 'high'];
const picker = (tier = 'low') => `claude-antigravity-gemini-4-argon-${tier}`;
const native = (tier = 'low') => `antigravity/gemini-4-argon-${tier}`;
function capability(overrides = {}) {
  return { supported: true, enabled: true, mode: 'native', experimental: true,
    supported_apis: ['messages', 'count_tokens'], session_policy: 'fixed-model', context_window: 200000,
    backend_window_verified: false, status: { configuration: 'valid', auth: 'ready', project: 'configured',
      configuration_ready: true, live_verified: false }, ...overrides };
}
function envelope(provider = capability(), ids = tiers.map(native)) {
  return { data: ids.map((id) => ({ id })), capabilities: { schema_version: 1, providers: { antigravity: provider } } };
}
function carrier() {
  return 'ccp:antigravity:v1:' + Buffer.from(JSON.stringify({ version: 1, profile_id: 'fixture-profile', project_id: 'fixture-project',
    native_model: 'gemini-4-argon-low', session_id: '-9223372036854775808', thought_display: 'full',
    contents: [{ role: 'model', parts: [{ thought: true, text: '秘密 🛰', thoughtSignature: 'opaque-native-signature' }] }],
    projection_digest: 'a'.repeat(64), tool_mapping: [] })).toString('base64url');
}
function message(model = native()) {
  return { id: 'msg_fixture', type: 'message', role: 'assistant', model,
    content: [{ type: 'thinking', thinking: '秘密 🛰', signature: carrier() },
      { type: 'tool_use', id: 'tool_1', name: 'EnterPlanMode', input: { model: native(), nested: { model: 'gpt-preserve' } } }],
    stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 11, reasoning_tokens: 3, cache_read_input_tokens: 2 } };
}
function sse(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
function stream(model = native()) {
  return sse({ type: 'message_start', message: message(model) })
    + sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: carrier() } })
    + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } })
    + sse({ type: 'message_stop' });
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return { server: instance, port: instance.address().port };
}
function request(port, body, headers = {}, pathname = '/v1/messages', method = 'POST') {
  const wire = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end(method === 'GET' ? undefined : wire);
  });
}
async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(20);
  }
  throw new Error('fixture condition timed out');
}
async function fixture(t, { caps = envelope(), reply = null, setup = null, environment = {} } = {}) {
  const state = { caps, attempts: [], anthropic: [], queries: [], reply };
  const proxy = await server(t, (req, res) => {
    if (req.url.startsWith('/v1/models')) {
      state.queries.push(req.url);
      const response = req.url.includes('?') ? state.caps : { data: state.caps?.data || [] };
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(response));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const wire = Buffer.concat(chunks).toString();
      state.attempts.push({ body: JSON.parse(wire), wire, headers: req.headers, path: req.url });
      if (state.reply) return state.reply(req, res, state.attempts.at(-1));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(message()));
    });
  });
  const anthropic = await server(t, (req, res) => {
    state.anthropic.push(req.url); req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'message', model: 'wrong-provider', content: [] }));
  });
  const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port),
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropic.port}`, CODEX_GATEWAY_MODELS_REFRESH_MS: '100', ...environment });
  if (setup) setup(env);
  const gateway = await startGateway(t, 'serve-shim', env);
  return { ...gateway, state, env, proxyPort: proxy.port };
}
module.exports = { tiers, picker, native, capability, envelope, carrier, message, stream, sse, server, request, waitFor, fixture };
