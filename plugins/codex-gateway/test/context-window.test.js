'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForShim(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/healthz');
      if (response.status === 200) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('shim did not start');
}

test('Codex discovery advertises context metadata but keeps the local model id unsuffixed', async (t) => {
  let forwarded;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'gpt-5.6-luna' },
      ] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwarded = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const models = JSON.parse((await request(shimPort, 'GET', '/v1/models')).body);
  assert.deepEqual(models.data.map(({ id, max_input_tokens }) => ({ id, max_input_tokens })), [
    { id: 'claude-codex-gpt-5.6-sol', max_input_tokens: 180000 },
    { id: 'claude-codex-gpt-5.6-terra', max_input_tokens: 180000 },
    { id: 'claude-codex-gpt-5.6-luna', max_input_tokens: 180000 },
  ]);
  // 180000 = the advertised compaction budget, deliberately below the real 272k Codex window (see CODEX_COMPACT_CONTEXT_WINDOW).
  assert.equal(models.data.every(({ max_input_tokens }) => max_input_tokens === 180000), true);
  assert.equal(models.data.every(({ id }) => id.includes('[1m]') === false), true);

  await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol[1m]',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'legacy session' }],
  }));
  assert.equal(forwarded.model, 'gpt-5.6-sol');
});

test('opt-in request route logging records Fable metadata but never prompt data', async (t) => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-routes-')), 'routes.jsonl');
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(shimPort + 1),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '1',
      CODEX_GATEWAY_REQUEST_LOG_PATH: logFile,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const sentinel = 'DO-NOT-LOG-this-private-prompt';
  await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-fable-5', max_tokens: 1, messages: [{ role: 'user', content: sentinel }],
  }), { 'x-claude-code-session-id': 'session-safe-id' });

  const logged = fs.readFileSync(logFile, 'utf8');
  assert.equal(logged.includes(sentinel), false);
  const entries = logged.trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries, [{
    at: entries[0].at,
    backend: 'anthropic',
    model: 'claude-fable-5',
    path: '/v1/messages',
    sessionId: 'session-safe-id',
  }]);
});

test('an old-proxy context error is normalized to HTTP 413 request_too_large', async (t) => {
  // claude-code-proxy <=0.1.13 signalled overflow with a 5xx of its own shape; the
  // shim must normalize that to the same 413 request_too_large the new proxy emits.
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model.' } }));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'oversized' }],
  }));
  assert.equal(response.status, 413);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.type, 'error');
  assert.equal(parsed.error.type, 'request_too_large');
});

test('an upstream 413 request_too_large passes through untouched', async (t) => {
  // claude-code-proxy >=0.1.14 already emits the recognized shape. The shim must
  // not rewrite it; status and body pass through byte-for-byte.
  const upstreamBody = JSON.stringify({
    type: 'error',
    error: { type: 'request_too_large', message: 'input is too large for the model context window' },
  });
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'oversized' }],
  }));
  assert.equal(response.status, 413);
  assert.equal(response.body, upstreamBody);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.error.type, 'request_too_large');
});

test('Codex responses strip hallucinated plan-mode tools from JSON and SSE', async (t) => {
  let useSse = false;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    if (!useSse) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        type: 'message',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'keep' },
          { type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: {} },
        ],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'm1' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'keep' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'plan', name: 'EnterPlanMode', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'bash', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const payload = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      .replace('keep', 'keep 🎵');
    const encoded = Buffer.from(payload);
    const split = encoded.indexOf(Buffer.from('🎵')) + 2;
    res.write(encoded.subarray(0, split));
    res.end(encoded.subarray(split));
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort) },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const body = JSON.stringify({ model: 'claude-codex-gpt-5.6-sol', max_tokens: 1, messages: [] });
  const jsonResponse = await request(shimPort, 'POST', '/v1/messages', body);
  const json = JSON.parse(jsonResponse.body);
  assert.deepEqual(json.content, [{ type: 'text', text: 'keep' }]);
  assert.equal(json.stop_reason, 'end_turn');

  useSse = true;
  const sseResponse = await request(shimPort, 'POST', '/v1/messages', body, { accept: 'text/event-stream' });
  assert.equal(sseResponse.body.includes('EnterPlanMode'), false);
  assert.equal(sseResponse.body.includes('keep 🎵'), true);
  assert.equal(sseResponse.body.includes('"name":"Bash"'), true);
  const data = sseResponse.body.split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const bashStart = data.find((event) => event.type === 'content_block_start' && event.content_block?.name === 'Bash');
  assert.equal(bashStart.index, 1);
  assert.equal(data.find((event) => event.type === 'content_block_delta' && event.delta?.partial_json)?.index, 1);
});

test('SessionStart cleanup migrates an already-wired install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18764',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
      USER_SETTING: 'keep-me',
    },
  }));
  const gatewayCache = path.join(claudeDir, 'cache', 'gateway-models.json');
  fs.writeFileSync(gatewayCache, JSON.stringify({
    baseUrl: 'http://127.0.0.1:18764',
    models: [{ id: 'claude-codex-gpt-5.6-sol[1m]' }],
  }));

  spawnSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18764');
  assert.equal(settings.env.USER_SETTING, 'keep-me');
  const migratedCache = JSON.parse(fs.readFileSync(gatewayCache, 'utf8'));
  assert.equal(migratedCache.baseUrl, 'http://127.0.0.1:18764');
  assert.equal(migratedCache.models[0].id, 'claude-codex-gpt-5.6-sol');
});

test('SessionStart cleanup leaves unrelated gateway caches alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-other-cache-'));
  const cacheDir = path.join(home, '.claude', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const gatewayCache = path.join(cacheDir, 'gateway-models.json');
  const original = JSON.stringify({
    baseUrl: 'http://other-gateway.example',
    models: [null, { id: 'claude-codex-gpt-5.6-sol[1m]' }],
  });
  fs.writeFileSync(gatewayCache, original);

  spawnSync(process.execPath, [CLI, 'ensure', '--quiet'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  assert.equal(fs.readFileSync(gatewayCache, 'utf8'), original);
});

test('env wiring preserves Claude 1M aliases and removes the unsafe global threshold', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-env-'));
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
    env: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
      USER_SETTING: 'keep-me',
    },
  }));

  const result = spawnSync(process.execPath, [CLI, 'env', '--write-project'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-8[1m]');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5[1m]');
  // Fable is a 1M Claude model too; pin it so a gateway session gets its full
  // window instead of Claude Code's 200k gateway default.
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5[1m]');
  assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000');
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');

  const removed = spawnSync(process.execPath, [CLI, 'env', '--write-project', '--remove'], { cwd, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.env?.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.equal(after.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(after.env?.USER_SETTING, 'keep-me');
});

test('claude-* passthrough is byte-identical and never subjected to Codex window/error rewriting', async (t) => {
  // The Anthropic path returns a context-overflow-shaped 400. A claude model must
  // see it UNCHANGED (no 413 normalization, no 'prompt is too long' rewrite) and
  // the body forwarded upstream must be the exact bytes the client sent (prompt
  // caching keys on them).
  const overflowBody = JSON.stringify({ error: { message: 'input exceeds the context window of this model' } });
  let forwardedRaw;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedRaw = Buffer.concat(chunks).toString();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(overflowBody);
    });
  });
  const anthropicPort = await listen(anthropic);
  t.after(() => anthropic.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(shimPort + 1),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const sent = JSON.stringify({
    model: 'claude-opus-4-8[1m]',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'huge history' }],
  });
  const response = await request(shimPort, 'POST', '/v1/messages', sent);
  // forwarded bytes untouched (including the [1m] suffix on a real Claude model)
  assert.equal(forwardedRaw, sent);
  // upstream error passed through verbatim: not rewritten to 413 request_too_large
  // and not rewritten to the old 400 'prompt is too long'
  assert.equal(response.status, 400);
  assert.equal(response.body, overflowBody);
});

test('count_tokens for a Codex model still routes to the proxy', async (t) => {
  let countTokensPath;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      countTokensPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 42 }));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const shimProbe = http.createServer();
  const shimPort = await listen(shimProbe);
  await new Promise((resolve) => shimProbe.close(resolve));
  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: { ...process.env, CODEX_GATEWAY_PORT: String(shimPort), CODEX_GATEWAY_PROXY_PORT: String(proxyPort) },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForShim(shimPort);

  const response = await request(shimPort, 'POST', '/v1/messages/count_tokens', JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol',
    messages: [{ role: 'user', content: 'count me' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(countTokensPath, '/v1/messages/count_tokens');
  assert.equal(JSON.parse(response.body).input_tokens, 42);
});

test('proxy version floor uses a numeric semver compare, not a string compare', () => {
  const gw = require(CLI);
  assert.equal(gw.MIN_PROXY_VERSION, '0.1.14');
  const floor = gw.parseSemver(gw.MIN_PROXY_VERSION);
  // string compare would read '0.1.9' as >= '0.1.14'; numeric must read it as older
  assert.equal(gw.semverLt(gw.parseSemver('0.1.9'), floor), true);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.13'), floor), true);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.14'), floor), false);
  assert.equal(gw.semverLt(gw.parseSemver('0.1.15'), floor), false);
  assert.equal(gw.semverLt(gw.parseSemver('v0.2.0'), floor), false);
  assert.equal(gw.parseSemver('not a version'), null);
});
