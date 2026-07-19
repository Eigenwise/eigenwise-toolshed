'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'codex-gateway.js');
const { DispatchSessionRouteCache } = require(CLI);

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

function request(port, pathname, body, sessionId, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = body
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders }
      : { ...extraHeaders };
    if (sessionId) headers['x-claude-code-session-id'] = sessionId;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body ? 'POST' : 'GET',
      path: pathname,
      headers,
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

function dispatchBody(content, extra = {}) {
  return JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content }],
    ...extra,
  });
}

function agentMetadata(sessionId) {
  return {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'device-fixture',
        account_uuid: 'account-fixture',
        session_id: sessionId,
      }),
    },
  };
}

test('dispatch session route cache expires entries after their idle TTL', () => {
  let now = 0;
  const cache = new DispatchSessionRouteCache({ ttlMs: 100, maxSessions: 2, now: () => now });
  const route = { model: 'gpt-5.6-sol', effort: 'xhigh' };

  cache.set('session-a', route);
  now = 50;
  assert.deepEqual(cache.get('session-a'), route);
  now = 149;
  assert.deepEqual(cache.get('session-a'), route);
  now = 249;
  assert.equal(cache.get('session-a'), null);
});

test('dispatch session route cache evicts the least recently used session', () => {
  const cache = new DispatchSessionRouteCache({ ttlMs: 1000, maxSessions: 2 });
  const routeA = { model: 'gpt-5.6-sol', effort: 'xhigh' };
  const routeB = { model: 'gpt-5.6-terra', effort: 'high' };
  const routeC = { model: 'gpt-5.6-luna', effort: 'low' };

  cache.set('session-a', routeA);
  cache.set('session-b', routeB);
  assert.deepEqual(cache.get('session-a'), routeA);
  cache.set('session-c', routeC);

  assert.equal(cache.get('session-b'), null);
  assert.deepEqual(cache.get('session-a'), routeA);
  assert.deepEqual(cache.get('session-c'), routeC);
});

test('dispatch model reuses a session route after compaction and logs cache hits', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-session-route-'));
  const routeLog = path.join(logDir, 'routes.jsonl');
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      forwarded.push(payload);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: payload.model, content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG_PATH: routeLog,
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const canonical = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('[switchboard-route model=gpt-5.6-sol effort=xhigh] work the ticket'),
    'canonical-session',
  );
  const compacted = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('Compacted context with no route marker'),
    'canonical-session',
  );
  const legacy = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('[sidequest-route model=gpt-5.6-terra effort=high] compatibility briefing'),
    'legacy-session',
  );
  const legacyCompacted = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('Compacted legacy context with no route marker'),
    'legacy-session',
  );
  const unknown = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('No marker was ever presented'),
    'unknown-session',
  );

  assert.equal(canonical.status, 200);
  assert.equal(compacted.status, 200);
  assert.equal(legacy.status, 200);
  assert.equal(legacyCompacted.status, 200);
  assert.equal(unknown.status, 400);
  assert.deepEqual(forwarded.map(({ model, output_config: outputConfig }) => ({ model, outputConfig })), [
    { model: 'gpt-5.6-sol', outputConfig: { effort: 'xhigh' } },
    { model: 'gpt-5.6-sol', outputConfig: { effort: 'xhigh' } },
    { model: 'gpt-5.6-terra', outputConfig: { effort: 'high' } },
    { model: 'gpt-5.6-terra', outputConfig: { effort: 'high' } },
  ]);

  const routes = fs.readFileSync(routeLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(routes.map(({ model, via, effort, sessionId, sessionSource }) => ({
    model, via, effort, sessionId, sessionSource,
  })), [
    { model: 'gpt-5.6-sol', via: 'dispatch', effort: 'xhigh', sessionId: 'canonical-session', sessionSource: 'header' },
    { model: 'gpt-5.6-sol', via: 'dispatch-cached', effort: 'xhigh', sessionId: 'canonical-session', sessionSource: 'header' },
    { model: 'gpt-5.6-terra', via: 'dispatch', effort: 'high', sessionId: 'legacy-session', sessionSource: 'header' },
    { model: 'gpt-5.6-terra', via: 'dispatch-cached', effort: 'high', sessionId: 'legacy-session', sessionSource: 'header' },
    { model: 'claude-codex-auto', via: 'dispatch-unbound', effort: undefined, sessionId: 'unknown-session', sessionSource: 'header' },
  ]);
});

test('native Agent route survives repeated tools and the compaction identity transition', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-agent-route-'));
  const routeLog = path.join(logDir, 'routes.jsonl');
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      forwarded.push(payload);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: payload.model, content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawn(process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG_PATH: routeLog,
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const sessionMetadata = agentMetadata('root-session');
  const agentHeaders = { 'x-claude-code-agent-id': 'agent-a' };
  const initial = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('[sidequest-route model=gpt-5.6-sol effort=xhigh] initial-agent-turn', sessionMetadata),
    'root-session',
    agentHeaders,
  );
  const repeatedToolTurn = await request(
    shimPort,
    '/v1/messages',
    dispatchBody(null, {
      ...sessionMetadata,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: 'tool-result-sentinel' }],
      }],
    }),
    'root-session',
    agentHeaders,
  );
  const compacted = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('compact-summary-sentinel', {
      ...sessionMetadata,
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    }),
    null,
    agentHeaders,
  );
  const otherAgent = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('unbound-other-agent', sessionMetadata),
    null,
    { 'x-claude-code-agent-id': 'agent-b' },
  );
  const otherSession = await request(
    shimPort,
    '/v1/messages',
    dispatchBody('unbound-other-session', agentMetadata('other-session')),
    null,
    agentHeaders,
  );

  assert.equal(initial.status, 200);
  assert.equal(repeatedToolTurn.status, 200);
  assert.equal(compacted.status, 200);
  assert.equal(otherAgent.status, 400);
  assert.equal(otherSession.status, 400);
  assert.deepEqual(forwarded.map(({ model, output_config: outputConfig }) => ({ model, outputConfig })), [
    { model: 'gpt-5.6-sol', outputConfig: { effort: 'xhigh' } },
    { model: 'gpt-5.6-sol', outputConfig: { effort: 'xhigh' } },
    { model: 'gpt-5.6-sol', outputConfig: { effort: 'xhigh' } },
  ]);

  const logged = fs.readFileSync(routeLog, 'utf8');
  assert.equal(logged.includes('initial-agent-turn'), false);
  assert.equal(logged.includes('tool-result-sentinel'), false);
  assert.equal(logged.includes('compact-summary-sentinel'), false);
  const routes = logged.trim().split('\n').map(JSON.parse);
  assert.deepEqual(routes.map(({ model, via, effort, sessionId, agentId, sessionSource }) => ({
    model, via, effort, sessionId, agentId, sessionSource,
  })), [
    {
      model: 'gpt-5.6-sol', via: 'dispatch', effort: 'xhigh',
      sessionId: 'root-session', agentId: 'agent-a', sessionSource: 'header',
    },
    {
      model: 'gpt-5.6-sol', via: 'dispatch-cached', effort: 'xhigh',
      sessionId: 'root-session', agentId: 'agent-a', sessionSource: 'header',
    },
    {
      model: 'gpt-5.6-sol', via: 'dispatch-cached', effort: 'xhigh',
      sessionId: 'root-session', agentId: 'agent-a', sessionSource: 'metadata',
    },
    {
      model: 'claude-codex-auto', via: 'dispatch-unbound', effort: undefined,
      sessionId: 'root-session', agentId: 'agent-b', sessionSource: 'metadata',
    },
    {
      model: 'claude-codex-auto', via: 'dispatch-unbound', effort: undefined,
      sessionId: 'other-session', agentId: 'agent-a', sessionSource: 'metadata',
    },
  ]);
});
