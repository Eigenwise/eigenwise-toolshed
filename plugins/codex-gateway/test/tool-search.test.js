'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body == null ? 'GET' : 'POST',
      path: pathname,
      headers: body == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHealthz(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('shim did not become healthy');
}

function tool(name, deferLoading) {
  const definition = {
    name,
    description: `${name} fixture`,
    input_schema: { type: 'object', properties: {} },
  };
  if (deferLoading !== undefined) definition.defer_loading = deferLoading;
  return definition;
}

test('Codex tool search resolves references while Anthropic passthrough stays byte-identical', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwardedToCodex = [];
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToCodex.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-sol', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  let forwardedToAnthropic;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToAnthropic = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'claude-opus-4-8[1m]', content: [] }));
    });
  });
  const anthropicPort = await new Promise((resolve) => {
    anthropic.listen(0, '127.0.0.1', () => resolve(anthropic.address().port));
  });
  t.after(() => anthropic.close());

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data;
  assert.ok(models.some(({ id }) => id === 'claude-codex-gpt-5.6-sol'));

  const tools = [
    tool('ToolSearch'),
    tool('Bash', false),
    tool('mcp__sidequest_board__list', true),
    tool('mcp__sidequest_board__comments', true),
  ];
  const initial = JSON.stringify({
    model: 'claude-codex-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Find the board list tool' }],
    tools,
  });
  assert.equal((await request(shimPort, '/v1/messages', initial)).status, 200);
  assert.deepEqual(forwardedToCodex[0].tools.map(({ name }) => name), ['ToolSearch', 'Bash']);
  assert.equal(forwardedToCodex[0].tools.some((entry) => 'defer_loading' in entry), false);

  const followUpBody = {
    model: 'claude-codex-gpt-5.6-sol',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'Find the board list tool' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'search-1', name: 'ToolSearch', input: { query: 'list board tickets' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'search-1',
          content: [
            { type: 'text', text: 'Found one tool' },
            { type: 'tool_reference', tool_name: 'mcp__sidequest_board__list' },
          ],
        }],
      },
    ],
    tools,
  };
  const followUp = JSON.stringify(followUpBody);
  assert.equal((await request(shimPort, '/v1/messages', followUp)).status, 200);
  assert.deepEqual(forwardedToCodex[1].tools.map(({ name }) => name), [
    'ToolSearch',
    'Bash',
    'mcp__sidequest_board__list',
  ]);
  assert.equal(forwardedToCodex[1].tools.some((entry) => 'defer_loading' in entry), false);
  assert.deepEqual(forwardedToCodex[1].messages[2].content[0].content, [
    { type: 'text', text: 'Found one tool' },
    { type: 'text', text: 'Tool reference: mcp__sidequest_board__list' },
  ]);
  assert.equal(JSON.stringify(forwardedToCodex[1]).includes('tool_reference'), false);

  const anthropicRaw = JSON.stringify({ ...followUpBody, model: 'claude-opus-4-8[1m]' }, null, 2);
  assert.equal((await request(shimPort, '/v1/messages', anthropicRaw)).status, 200);
  assert.equal(forwardedToAnthropic, anthropicRaw);
  assert.equal(forwardedToCodex.length, 2);
});
