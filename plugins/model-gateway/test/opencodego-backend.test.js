'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { gatewayTestEnvironment, isolateInProcessGatewayEnvironment, spawnGatewayProcess } = require('./support.js');

const inProcessHome = isolateInProcessGatewayEnvironment(test);
const opencodego = require('../lib/opencodego-backend.js');
const runtime = require('../lib/runtime.js');
const { codexBaseFromId } = require('../lib/pins.js');
const { modelIdDifference, readSecretFromStdin } = require('../lib/commands.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'opencode-go');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const CATALOG = JSON.parse(fixture('models.json'));
const TEST_KEY = 'oc_sk_fixtureKey0123456789';
// Neither real catalog entry lacks tools or text, so these two prove the exclusions.
const NO_TOOLS = { id: 'notools-1', name: 'No Tools', modalities: { input: ['text'] }, capabilities: { tools: { supported: false } }, limit: { context: 128000 } };
const NO_TEXT = { id: 'imageonly-1', name: 'Image Only', modalities: { input: ['image/png'] }, capabilities: { tools: { supported: true } }, limit: { context: 128000 } };
const SMALL = { id: 'small-1', name: 'Small', modalities: { input: ['text'] }, capabilities: { tools: { supported: true } }, limit: { context: 128000 } };

function catalogCache(models = CATALOG.data, extra = {}) {
  return { schema: 1, fetchedAt: Date.now(), source: 'fixture', models, hidden: {}, ...extra };
}

function temporaryFile(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-opencodego-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

// ------------------------------------------------------------------ unit

test('effort rule: supported as-is, unsupported goes up, above all goes to the highest', () => {
  const deepseek = ['low', 'high', 'max'];
  const effortOf = (payload, levels) => opencodego.applyEffortRule(payload, levels);
  assert.equal(effortOf({ output_config: { effort: 'high' } }, deepseek).payload.output_config.effort, 'high');
  assert.equal(effortOf({ output_config: { effort: 'medium' } }, deepseek).payload.output_config.effort, 'high');
  assert.equal(effortOf({ output_config: { effort: 'minimal' } }, deepseek).payload.output_config.effort, 'low');
  assert.equal(effortOf({ output_config: { effort: 'xhigh' } }, deepseek).payload.output_config.effort, 'max');
  assert.equal(effortOf({ output_config: { effort: 'max' } }, ['low', 'medium', 'high']).payload.output_config.effort, 'high');
  assert.equal(effortOf({ output_config: { effort: 'xhigh' } }, ['low', 'medium', 'xhigh']).effort, 'xhigh');
  // Other output_config fields survive.
  assert.deepEqual(effortOf({ output_config: { effort: 'medium', format: { type: 'json' } } }, deepseek).payload.output_config,
    { effort: 'high', format: { type: 'json' } });
  // Nothing requested, nothing invented.
  assert.deepEqual(effortOf({ thinking: { type: 'adaptive' } }, deepseek).payload, { thinking: { type: 'adaptive' } });
});

test('effort rule: disabled thinking becomes none when supported, else the lowest level', () => {
  const withNone = opencodego.applyEffortRule({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } }, ['none', 'low', 'high']);
  assert.deepEqual(withNone.payload, { thinking: { type: 'disabled' } });
  assert.equal(withNone.effort, 'none');
  const beamFree = opencodego.applyEffortRule({ thinking: { type: 'disabled' } }, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(beamFree.payload.thinking, undefined, 'a model without none must not receive thinking.disabled (Go answers 400)');
  assert.deepEqual(beamFree.payload.output_config, { effort: 'low' });
});

test('effort rule: a model with no effort list gets no effort or thinking fields at all', () => {
  const kimi = opencodego.effortLevels(CATALOG.data.find((model) => model.id === 'kimi-k2.7-code'));
  assert.equal(kimi, null);
  const { payload, effort } = opencodego.applyEffortRule({ model: 'x', thinking: { type: 'enabled', budget_tokens: 4000 }, output_config: { effort: 'high' } }, kimi);
  assert.deepEqual(payload, { model: 'x' });
  assert.equal(effort, null);
  assert.deepEqual(opencodego.effortLevels(CATALOG.data.find((model) => model.id === 'hy3')), ['none', 'low', 'high']);
});

test('catalog rule: tools and text input; free, gpt, grok and claude families included; no key, no rows', () => {
  const cache = catalogCache([...CATALOG.data, NO_TOOLS, NO_TEXT]);
  const ids = opencodego.advertisedModels({ key: { key: TEST_KEY }, cache }).map((model) => model.id);
  for (const id of ['beam-free', 'gpt-6-luna', 'claude-haiku-5-5', 'grok-4.7', 'deepseek-v4.1-flash', 'kimi-k2.7-code']) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes('notools-1'), false);
  assert.equal(ids.includes('imageonly-1'), false);
  assert.deepEqual(opencodego.advertisedModels({ key: null, cache }), []);
  assert.deepEqual(opencodego.advertisedModels({ key: { key: TEST_KEY }, cache: { lastCatalogError: { message: 'x' } } }), [], 'an error-only record is not a catalog');
  const hidden = opencodego.advertisedModels({ key: { key: TEST_KEY }, cache: { ...cache, hidden: { 'grok-4.7': { at: 'now' } } } }).map((model) => model.id);
  assert.equal(hidden.includes('grok-4.7'), false);
  assert.equal(opencodego.displayName('deepseek-v4.1-flash', cache), 'DeepSeek V4.1 Flash (OpenCode Go)');
});

test('policy: opencodego ids resolve to their own backend, never Codex or native Anthropic, with [1m] above 200k', () => {
  opencodego.writeCatalogCache(catalogCache([...CATALOG.data, SMALL]));
  assert.ok(opencodego.catalogPath().startsWith(inProcessHome));
  const luna = runtime.resolveGatewayModelPolicy('claude-opencodego-gpt-6-luna');
  assert.equal(luna.backend, 'opencodego');
  assert.equal(luna.backendWindow, 1050000);
  assert.equal(luna.measurement, 'provider-reported, unmeasured');
  assert.equal(luna.sentry, 'synthetic-413');
  assert.equal(codexBaseFromId('claude-opencodego-gpt-6-luna'), null, 'the Codex family rule must not claim an opencodego gpt id');
  assert.equal(runtime.gatewayClientModelId('claude-opencodego-gpt-6-luna'), 'claude-opencodego-gpt-6-luna[1m]');
  assert.equal(runtime.gatewayClientModelId('claude-opencodego-hy3'), 'claude-opencodego-hy3[1m]', '256000 is above the 200k unknown-model window');
  assert.equal(runtime.gatewayClientModelId('claude-opencodego-small-1'), 'claude-opencodego-small-1');
  assert.equal(runtime.resolveGatewayModelPolicy('claude-opencodego-claude-haiku-5-5[1m]').backend, 'opencodego');
  const unknown = runtime.resolveGatewayModelPolicy('claude-opencodego-not-in-catalog');
  assert.equal(unknown.backend, 'opencodego');
  assert.equal(unknown.sentry, 'none');
  assert.equal(runtime.gatewayClientModelId('claude-opencodego-not-in-catalog'), 'claude-opencodego-not-in-catalog');
  assert.equal(opencodego.goModelIdFromClientId('claude-opencodego-deepseek-v4.1-flash[1m]'), 'deepseek-v4.1-flash');
  assert.equal(opencodego.goModelIdFromClientId('claude-opus-5-5[1m]'), null);
  // Defaults: no cap for OpenCode Go.
  assert.deepEqual(runtime.readContextWindowSettings({ file: path.join(inProcessHome, 'absent.json'), env: {} }).opencodego, { value: 'full', source: 'default' });
});

test('upstream headers: Claude credentials never pass, Go gets its Bearer, a gateway user agent and a session', () => {
  const session = opencodego.openCodeSessionId('claude-session-1', 'fallback');
  const headers = opencodego.upstreamHeaders({
    authorization: 'Bearer claude-oauth-secret',
    'proxy-authorization': 'Basic secret',
    'x-api-key': 'sk-ant-secret',
    cookie: 'session=secret',
    'x-claude-code-session-id': 'claude-session-1',
    'user-agent': 'claude-cli/2.1',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'interleaved-thinking-2025-05-14',
    'content-type': 'application/json',
  }, { key: TEST_KEY, session, contentLength: 10 });
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`);
  for (const name of ['proxy-authorization', 'x-api-key', 'cookie', 'x-claude-code-session-id']) assert.equal(headers[name], undefined, name);
  assert.equal(headers['x-opencode-session'], session);
  assert.match(session, /^ses_[0-9a-f]{32}$/);
  assert.equal(opencodego.openCodeSessionId('claude-session-1', 'other-fallback'), session, 'stable per Claude Code session');
  assert.notEqual(opencodego.openCodeSessionId('claude-session-2', 'fallback'), session);
  assert.match(opencodego.openCodeSessionId(null, 'fallback'), /^ses_[0-9a-f]{32}$/);
  assert.match(headers['user-agent'], /^eigenwise-model-gateway\//);
  assert.equal(headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
});

test('errors: Go messages are prefixed, a 401 adds the login step, and kinds drive hiding', () => {
  const invalid = opencodego.upstreamErrorBody(401, Buffer.from(fixture('invalid-key-401.json')), { commandPath: '/x/model-gateway.js' });
  const invalidError = JSON.parse(invalid.body).error;
  assert.equal(invalid.kind, 'invalid-credential');
  assert.match(invalidError.message, /^model-gateway \(OpenCode Go\): Upstream request failed: Invalid credential OpenCode Go rejected the saved key\. Run `node "\/x\/model-gateway\.js" login --opencodego`/);
  const region = opencodego.upstreamErrorBody(400, Buffer.from(fixture('region-400.json')));
  assert.equal(region.kind, 'region');
  assert.equal(JSON.parse(region.body).error.message, 'model-gateway (OpenCode Go): Upstream request failed: This Go model requires Global regions. Select Global in your workspace\'s Privacy settings to use it.');
  assert.equal(opencodego.upstreamErrorBody(400, Buffer.from(fixture('training-consent-400.json'))).kind, 'training-consent');
  assert.equal(opencodego.upstreamErrorBody(400, Buffer.from(fixture('model-unavailable-400.json'))).kind, 'model-unavailable');
  assert.equal(opencodego.errorKind(403, 'This model is not usable outside OpenCode.'), 'outside-opencode');
  assert.equal(opencodego.errorKind(403, 'Forbidden'), null, 'a generic 403 never hides a row');
  const plain = JSON.parse(opencodego.upstreamErrorBody(502, Buffer.from('<html>bad gateway</html>')).body).error;
  assert.match(plain.message, /^model-gateway \(OpenCode Go\): upstream returned HTTP 502: <html>bad gateway<\/html>$/);
  assert.match(JSON.parse(opencodego.missingKeyBody('/x/model-gateway.js')).error.message, /login --opencodego/);
});

test('catalog refresh: an early refresh keeps 403 hides, a regular one lifts them, a failure keeps the catalog', async (t) => {
  const file = temporaryFile(t, 'opencode-go-models.json');
  const serve = (body, status = 200) => async () => ({ status, body });
  assert.equal((await opencodego.refreshCatalog({ file, request: serve(JSON.stringify(CATALOG)), reason: 'no-cache' })).ok, true);
  assert.equal(opencodego.hideModel('grok-4.7', 'not usable outside OpenCode', { file }), true);
  await opencodego.refreshCatalog({ file, request: serve(JSON.stringify(CATALOG)), reason: 'model-unavailable' });
  assert.deepEqual(opencodego.hiddenIds(opencodego.readCatalogCache({ file })), ['grok-4.7']);
  await opencodego.refreshCatalog({ file, request: serve(JSON.stringify(CATALOG)), reason: 'scheduled' });
  assert.deepEqual(opencodego.hiddenIds(opencodego.readCatalogCache({ file })), []);
  const failed = await opencodego.refreshCatalog({ file, request: serve('nope', 503), reason: 'scheduled' });
  assert.equal(failed.ok, false);
  const cache = opencodego.readCatalogCache({ file });
  assert.equal(cache.models.length, CATALOG.data.length);
  assert.match(cache.lastCatalogError.message, /HTTP 503/);
});

test('discovery: stand-in Codex lists persist OpenCode Go rows but never the stand-in Codex rows', () => {
  opencodego.writeCatalogCache(catalogCache());
  const current = [
    { id: 'claude-gpt-6.1-sol[1m]', display_name: 'fallback row' },
    { id: 'claude-grok-4.5[1m]', display_name: 'Grok 4.5' },
    { id: 'claude-opencodego-beam-free[1m]', display_name: 'Beam Free (OpenCode Go)' },
  ];
  assert.deepEqual(runtime.standInDiscoveryModels(current, null).map((model) => model.id),
    ['claude-grok-4.5[1m]', 'claude-opencodego-beam-free[1m]']);
  const existing = [{ id: 'claude-gpt-5.6-terra[1m]', display_name: 'from the proxy' }, { id: 'claude-grok-4.5[1m]', display_name: 'Grok 4.5' }];
  assert.deepEqual(runtime.standInDiscoveryModels(current, existing).map((model) => model.id),
    ['claude-gpt-5.6-terra[1m]', 'claude-grok-4.5[1m]', 'claude-opencodego-beam-free[1m]']);
  assert.equal(runtime.standInDiscoveryModels(current.slice(0, 2), existing), null, 'without OpenCode Go the old no-write rule stands');
  assert.deepEqual(runtime.standInDiscoveryModels(current.slice(0, 2), [...existing, current[2]]).map((model) => model.id),
    ['claude-gpt-5.6-terra[1m]', 'claude-grok-4.5[1m]'], 'removed OpenCode Go rows leave the cache');
});

test('doctor model-window check ignores dynamic OpenCode Go ids but still flags a stale Codex id', () => {
  fs.rmSync(opencodego.catalogPath(), { force: true });
  const ocgo = ['claude-opencodego-deepseek-v4.1-flash[1m]', 'claude-opencodego-small-1', 'claude-opencodego-gpt-6-luna[1m]'];
  const live = ['claude-gpt-5.6-sol[1m]', 'claude-grok-4.5[1m]', ...ocgo];
  assert.deepEqual(modelIdDifference(live), { missing: [], extra: [] });
  const stale = modelIdDifference(['claude-gpt-5.6-sol', ...ocgo]);
  assert.deepEqual(stale, { missing: ['claude-gpt-5.6-sol[1m]'], extra: ['claude-gpt-5.6-sol'] });
});

// ------------------------------------------------------------ CLI login

function runCli(t, args, { input = '', env } = {}) {
  return new Promise((resolve) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('login --opencodego writes the stdin key with mode 0600 and refuses argv keys and non-keys', async (t) => {
  const env = gatewayTestEnvironment(t);
  const keyFile = path.join(env.HOME, '.claude', 'model-gateway', 'opencode-go-key');
  const saved = await runCli(t, ['login', '--opencodego'], { input: `  ${TEST_KEY}\n`, env });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), `${TEST_KEY}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(saved.stdout.includes(TEST_KEY), false, 'the key is never printed');
  assert.match(saved.stdout, /fully restart Claude Code/);

  const argv = await runCli(t, ['login', '--opencodego', 'oc_sk_onTheCommandLine123'], { input: '', env });
  assert.equal(argv.status, 2);
  assert.match(argv.stderr, /reads the key from stdin only/);
  const bogus = await runCli(t, ['login', '--opencodego'], { input: 'sk-ant-not-a-go-key\n', env });
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /expected oc_sk_/);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), `${TEST_KEY}\n`, 'a refused key leaves the saved one alone');
});

test('doctor reports OpenCode Go key presence without printing it, catalog age and advertised rows', async (t) => {
  const env = gatewayTestEnvironment(t);
  const state = path.join(env.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'opencode-go-key'), `${TEST_KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'opencode-go-models.json'), JSON.stringify(catalogCache(CATALOG.data, {
    hidden: { 'grok-4.7': { at: 'x' } },
    lastRequestError: { at: '2026-11-03T00:00:00.000Z', status: 400, kind: 'region', model: 'deepseek-v4-pro', message: 'Upstream request failed: This Go model requires Global regions.' },
  })));
  const result = await runCli(t, ['doctor'], { env });
  const output = result.stdout + result.stderr;
  assert.equal(output.includes(TEST_KEY), false);
  assert.match(output, /opencode go key: present \(.*opencode-go-key\)/);
  assert.match(output, /opencode go catalog: .*opencode-go-models\.json; fetched .* old, refresh every 6\.0h\) from fixture; 8 catalog models/);
  assert.match(output, /opencode go models: 7 advertised from the catalog.*hidden until the next catalog refresh: grok-4\.7/);
  assert.match(output, /opencode go last request error: HTTP 400 \[region\] at 2026-11-03T00:00:00\.000Z \(deepseek-v4-pro\)/);
});

// ------------------------------------------------------- worker integration

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function send(port, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages?beta=true', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

const OUTSIDE_403 = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'This model is not usable outside OpenCode. Use it from the opencode CLI.' } });

function sseBody() {
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return [
    frame({ type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash', content: [], usage: { input_tokens: 53, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello my friend' } }),
    frame({ type: 'content_block_stop', index: 1 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 109 } }),
    frame({ type: 'message_stop' }),
  ].join('');
}

// A fake OpenCode Go: the catalog at /v1/models, Messages at /anthropic/v1/messages, answers chosen by model.
async function fakeGo(t) {
  const state = { catalogFetches: [], messages: [], catalog: JSON.stringify(CATALOG) };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        state.catalogFetches.push({ at: Date.now(), headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(state.catalog);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      state.messages.push({ url: req.url, headers: req.headers, body });
      const json = (status, text) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text); };
      if (body.model === 'claude-haiku-5-5') return json(401, fixture('invalid-key-401.json'));
      if (body.model === 'deepseek-v4-pro') return json(400, fixture('region-400.json'));
      if (body.model === 'hy3') return json(400, fixture('model-unavailable-400.json'));
      if (body.model === 'grok-4.7') return json(403, OUTSIDE_403);
      if (body.model === 'dropped-1') return req.socket.destroy();
      if (body.model === 'aborted-1') {
        res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
        res.write(body.stream ? 'event: message_start\n' : '{"type":');
        return setTimeout(() => req.socket.destroy(), 20);
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(sseBody());
      }
      return json(200, fixture('message-thinking.json'));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { ...state, state, baseUrl: `http://127.0.0.1:${port}` };
}

async function usageCollector(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { received.push(Buffer.concat(chunks).toString()); res.writeHead(200); res.end(); });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { received, endpoint: `http://127.0.0.1:${port}/v1/logs` };
}

function usageRecords(received) {
  return received.flatMap((body) => {
    const record = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0];
    if (record.eventName !== 'gateway.token.usage') return [];
    return [Object.fromEntries(record.attributes.map(({ key, value }) => [key, value.stringValue ?? (value.intValue !== undefined ? Number(value.intValue) : value.boolValue ?? value.doubleValue)]))];
  });
}

async function startWorker(t, go, { key = TEST_KEY, cache = null, env: extra = {} } = {}) {
  const port = await freePort();
  const proxyPort = await freePort();
  const env = gatewayTestEnvironment(t, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_SSE_HEARTBEAT_S: '0',
    CODEX_GATEWAY_OPENCODEGO_CATALOG_RETRY_MS: '100',
    ...extra,
  }, {
    CODEX_GATEWAY_PORT: String(port),
    CODEX_GATEWAY_WORKER_PORT: String(port),
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_OPENCODEGO_BASE_URL: go.baseUrl,
  });
  const state = path.join(env.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  if (key) fs.writeFileSync(path.join(state, 'opencode-go-key'), `${key}\n`, { mode: 0o600 });
  if (cache) fs.writeFileSync(path.join(state, 'opencode-go-models.json'), JSON.stringify(cache));
  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-worker'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  await waitFor(() => getJson(`http://127.0.0.1:${port}/healthz`).then((health) => health.ok), `worker did not start: ${stderr}`);
  const models = async () => (await getJson(`http://127.0.0.1:${port}/v1/models`)).data.map((model) => model.id).filter((id) => id.startsWith('claude-opencodego-'));
  return { port, env, state, models, stderr: () => stderr };
}

test('worker: fetches the catalog when none is cached, lists rows, routes, strips Claude auth, sets session and Bearer, emits usage', async (t) => {
  const go = await fakeGo(t);
  const usage = await usageCollector(t);
  const worker = await startWorker(t, go, { env: { CODEX_GATEWAY_USAGE_ENDPOINT: usage.endpoint } });
  await waitFor(async () => (await worker.models()).length, 'no OpenCode Go rows appeared');
  assert.equal(go.catalogFetches.length, 1);
  assert.match(go.catalogFetches[0].headers['user-agent'], /^eigenwise-model-gateway\//);
  assert.equal(go.catalogFetches[0].headers.authorization, undefined, 'the catalog needs no auth and gets none');
  const listed = await getJson(`http://127.0.0.1:${worker.port}/v1/models`);
  const flash = listed.data.find((model) => model.id === 'claude-opencodego-deepseek-v4.1-flash[1m]');
  assert.equal(flash.display_name, 'DeepSeek V4.1 Flash (OpenCode Go)');
  assert.equal(flash.max_input_tokens, 1000000);
  assert.ok(listed.data.some((model) => model.id === 'claude-opencodego-gpt-6-luna[1m]'));

  const claudeAuth = { authorization: 'Bearer claude-oauth-secret', 'x-api-key': 'sk-ant-secret', cookie: 'c=secret', 'proxy-authorization': 'Basic secret' };
  const first = await send(worker.port, { model: 'claude-opencodego-deepseek-v4.1-flash[1m]', max_tokens: 50, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: 'hi' }] },
    { ...claudeAuth, 'x-claude-code-session-id': 'session-A', 'anthropic-version': '2023-06-01' });
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), JSON.parse(fixture('message-thinking.json')), 'the response is passed through unchanged');
  const [upstream] = go.messages;
  assert.equal(upstream.url, '/anthropic/v1/messages?beta=true');
  assert.equal(upstream.body.model, 'deepseek-v4.1-flash');
  assert.equal(upstream.body.output_config.effort, 'high', 'medium is unsupported on deepseek, so the next higher level');
  assert.equal(upstream.headers.authorization, `Bearer ${TEST_KEY}`);
  for (const name of ['x-api-key', 'cookie', 'proxy-authorization', 'x-claude-code-session-id']) assert.equal(upstream.headers[name], undefined, name);
  assert.equal(JSON.stringify(upstream.headers).includes('secret'), false);
  assert.match(upstream.headers['x-opencode-session'], /^ses_[0-9a-f]{32}$/);
  assert.match(upstream.headers['user-agent'], /^eigenwise-model-gateway\//);

  await send(worker.port, { model: 'claude-opencodego-gpt-6-luna[1m]', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, { 'x-claude-code-session-id': 'session-A' });
  await send(worker.port, { model: 'claude-opencodego-kimi-k2.7-code', max_tokens: 50, thinking: { type: 'enabled', budget_tokens: 2000 }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] }, { 'x-claude-code-session-id': 'session-B' });
  await send(worker.port, { model: 'claude-opencodego-beam-free', max_tokens: 50, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] });
  const [, luna, kimi, beam] = go.messages;
  assert.equal(luna.body.model, 'gpt-6-luna', 'an opencodego gpt id goes to Go, not the Codex proxy');
  assert.equal(luna.headers['x-opencode-session'], upstream.headers['x-opencode-session'], 'same Claude Code session, same Go session');
  assert.notEqual(kimi.headers['x-opencode-session'], upstream.headers['x-opencode-session']);
  assert.equal(kimi.body.output_config, undefined);
  assert.equal(kimi.body.thinking, undefined);
  assert.match(beam.headers['x-opencode-session'], /^ses_[0-9a-f]{32}$/, 'a request without a session still sends one');
  assert.equal(beam.body.thinking, undefined);
  assert.deepEqual(beam.body.output_config, { effort: 'low' });

  const streamed = await send(worker.port, { model: 'claude-opencodego-deepseek-v4.1-flash[1m]', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, { 'x-claude-code-session-id': 'session-A' });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.body, sseBody(), 'the stream reaches Claude Code byte for byte');

  const records = await waitFor(() => {
    const found = usageRecords(usage.received).filter((record) => record.backend === 'opencodego');
    return found.some((record) => record.response_mode === 'sse') && found;
  }, 'no opencodego usage records');
  const sse = records.find((record) => record.response_mode === 'sse');
  assert.equal(sse.model, 'deepseek-v4.1-flash');
  assert.equal(sse.requested_model, 'claude-opencodego-deepseek-v4.1-flash[1m]');
  assert.equal(sse.input_tokens, 53);
  assert.equal(sse.output_tokens, 109);
  assert.equal(sse.cache_read_tokens, 7);
  const health = await getJson(`http://127.0.0.1:${worker.port}/healthz`);
  assert.equal(health.served.opencodego, 5);
  assert.equal(health.served.codex, 0);
  assert.equal(health.served.anthropic, 0);

  // Only OpenCode Go and no Codex proxy: the rows still reach Claude Code's discovery cache, the stand-in Codex rows never do.
  const discovery = path.join(worker.env.CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
  const cached = await waitFor(() => fs.existsSync(discovery) && JSON.parse(fs.readFileSync(discovery, 'utf8')), 'discovery cache not written');
  assert.ok(cached.models.some((model) => model.id === 'claude-opencodego-deepseek-v4.1-flash[1m]'));
  assert.equal(cached.models.some((model) => model.id.startsWith('claude-gpt-')), false);
});

test('worker: errors are prefixed, 401 names the login, region does not hide, unavailable and 403 refresh early, 403 hides until a regular refresh', async (t) => {
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { env: { CODEX_GATEWAY_OPENCODEGO_CATALOG_REFRESH_MS: '2500' } });
  await waitFor(async () => (await worker.models()).length, 'no OpenCode Go rows appeared');
  await new Promise((resolve) => setTimeout(resolve, 150));

  const invalid = await send(worker.port, { model: 'claude-opencodego-claude-haiku-5-5[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(invalid.status, 401);
  assert.match(JSON.parse(invalid.body).error.message, /^model-gateway \(OpenCode Go\): Upstream request failed: Invalid credential .*login --opencodego/);

  const region = await send(worker.port, { model: 'claude-opencodego-deepseek-v4-pro[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(region.status, 400);
  assert.match(JSON.parse(region.body).error.message, /^model-gateway \(OpenCode Go\): Upstream request failed: This Go model requires Global regions/);
  assert.ok((await worker.models()).includes('claude-opencodego-deepseek-v4-pro[1m]'), 'a region error never hides a row');
  assert.equal(go.catalogFetches.length, 1, 'region and credential errors do not refresh the catalog');

  const unavailable = await send(worker.port, { model: 'claude-opencodego-hy3[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(unavailable.status, 400);
  assert.match(JSON.parse(unavailable.body).error.message, /^model-gateway \(OpenCode Go\): Upstream request failed: Model is unavailable\./);
  await waitFor(() => go.catalogFetches.length === 2, 'model unavailable did not refresh the catalog early');
  await new Promise((resolve) => setTimeout(resolve, 150));

  const outside = await send(worker.port, { model: 'claude-opencodego-grok-4.7[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(outside.status, 403);
  assert.match(JSON.parse(outside.body).error.message, /^model-gateway \(OpenCode Go\): This model is not usable outside OpenCode/);
  await waitFor(async () => !(await worker.models()).includes('claude-opencodego-grok-4.7[1m]'), 'the 403 did not hide the row');
  await waitFor(() => go.catalogFetches.length === 3, 'the 403 did not refresh the catalog early');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await worker.models()).includes('claude-opencodego-grok-4.7[1m]'), false, 'an early refresh keeps the hide');
  await waitFor(() => go.catalogFetches.length >= 4, 'the regular refresh never ran', 6000);
  await waitFor(async () => (await worker.models()).includes('claude-opencodego-grok-4.7[1m]'), 'the regular refresh did not lift the hide');
  const cache = JSON.parse(fs.readFileSync(path.join(worker.state, 'opencode-go-models.json'), 'utf8'));
  assert.equal(cache.lastRequestError.kind, 'outside-opencode');
  assert.equal(JSON.stringify(cache).includes(TEST_KEY), false);
});

test('worker: no key means no rows, no catalog fetch, and a request names the login command', async (t) => {
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { key: null, cache: catalogCache() });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await worker.models(), []);
  assert.equal(go.catalogFetches.length, 0);
  const refused = await send(worker.port, { model: 'claude-opencodego-deepseek-v4.1-flash[1m]', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(refused.status, 401);
  assert.match(JSON.parse(refused.body).error.message, /^model-gateway \(OpenCode Go\): no OpenCode Go key is configured.*login --opencodego/);
  assert.equal(go.messages.length, 0);
});

test('worker: a fresh disk cache is used without fetching until the refresh interval, then refreshed on its own timer', async (t) => {
  const go = await fakeGo(t);
  const subset = CATALOG.data.filter((model) => model.id === 'beam-free');
  const worker = await startWorker(t, go, { cache: catalogCache(subset), env: { CODEX_GATEWAY_OPENCODEGO_CATALOG_REFRESH_MS: '1500' } });
  await waitFor(async () => (await worker.models()).length === 1, 'cached rows not listed');
  assert.deepEqual(await worker.models(), ['claude-opencodego-beam-free[1m]']);
  assert.equal(go.catalogFetches.length, 0, 'a fresh cache is not refetched at startup');
  await waitFor(() => go.catalogFetches.length === 1, 'the catalog timer never refreshed', 6000);
  await waitFor(async () => (await worker.models()).length === 8, 'refreshed rows not listed');
});

test('worker: OpenCode Go refuses message threads like the other stateless backends', async (t) => {
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { cache: catalogCache() });
  const refused = await send(worker.port, { model: 'claude-opencodego-beam-free', max_tokens: 5, thread: { type: 'continue', id: 'thr_1' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(refused.status, 400);
  assert.match(JSON.parse(refused.body).error.message, /Codex, Grok and OpenCode Go backends hold no conversation state/);
  assert.equal(go.messages.length, 0);
});

test('login secret: piped stdin is read whole, a TTY reads one hidden line with backspace', async (t) => {
  const piped = new PassThrough();
  const pipedRead = readSecretFromStdin(piped);
  piped.end('oc_sk_piped0123456789\n');
  assert.equal(await pipedRead, 'oc_sk_piped0123456789\n');

  const rawModes = [];
  const tty = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (mode) => rawModes.push(mode),
    resume() {},
    pause() {},
    setEncoding() {},
  });
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => { process.stderr.write = stderrWrite; });
  const ttyRead = readSecretFromStdin(tty);
  tty.emit('data', 'oc_sk_ab');
  tty.emit('data', '\u007fc\b');
  tty.emit('data', 'xy\rignored');
  assert.equal(await ttyRead, 'oc_sk_axy');
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(tty.listenerCount('data'), 0);
});

test('worker: a dropped upstream connection answers 502 with the network guidance and records it', async (t) => {
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { cache: catalogCache() });
  const response = await send(worker.port, { model: 'claude-opencodego-dropped-1', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.status, 502);
  const error = JSON.parse(response.body).error;
  assert.equal(error.type, 'api_error');
  assert.match(error.message, /^model-gateway \(OpenCode Go\): upstream request failed: .+\. Check the connection to opencode\.ai and retry\.$/);
  const cache = JSON.parse(fs.readFileSync(path.join(worker.state, 'opencode-go-models.json'), 'utf8'));
  assert.equal(cache.lastRequestError.status, 502);
  assert.equal(cache.lastRequestError.kind, 'network');
  assert.equal(cache.lastRequestError.model, 'dropped-1');
});

test('worker: invalid JSON and a literal null body pass through to Anthropic untouched', async (t) => {
  const received = [];
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"passthrough":true}');
    });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => new Promise((resolve) => anthropic.close(resolve)));
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { cache: catalogCache(), env: { CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}` } });
  for (const body of ['{', 'null']) {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: worker.port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(response.status, 200, body);
    assert.equal(response.body, '{"passthrough":true}', body);
  }
  assert.deepEqual(received, ['{', 'null']);
  assert.equal(go.messages.length, 0);
});

test('worker: an upstream that dies mid-response tears down the client for JSON and streamed replies', async (t) => {
  const go = await fakeGo(t);
  const worker = await startWorker(t, go, { cache: catalogCache() });
  const attempt = (stream) => new Promise((resolve) => {
    const body = JSON.stringify({ model: 'claude-opencodego-aborted-1', max_tokens: 5, stream, messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({ host: '127.0.0.1', port: worker.port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode, complete: res.complete }));
      res.resume();
    });
    req.on('error', (error) => resolve({ error: error.code || error.message }));
    req.end(body);
  });
  const json = await attempt(false);
  assert.ok(json.error, `the JSON reply was not torn down: ${JSON.stringify(json)}`);
  const streamed = await attempt(true);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.complete, false);
});
