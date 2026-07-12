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

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
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

test('Codex discovery stays below the real backend context limit', async (t) => {
  let forwarded;
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
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
  assert.equal(models.data[0].id, 'claude-codex-gpt-5.6-sol');
  assert.equal(models.data[0].id.includes('[1m]'), false);

  await request(shimPort, 'POST', '/v1/messages', JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol[1m]',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'legacy session' }],
  }));
  assert.equal(forwarded.model, 'gpt-5.6-sol');
});

test('Codex context errors use Claude Code compact-and-retry wording', async (t) => {
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
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'prompt is too long' },
  });
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
  assert.equal(fs.existsSync(gatewayCache), false);
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
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(settings.env.USER_SETTING, 'keep-me');
});
