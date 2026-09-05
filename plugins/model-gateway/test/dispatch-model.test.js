'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess, spawnGatewayProcessSync } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gw = require(CLI);

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
      method: body ? 'POST' : 'GET',
      path: pathname,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
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

test('dispatch model stays routable when omitted from the default model listing', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-dispatch-'));
  const routeLog = path.join(logDir, 'routes.jsonl');
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
        return;
      }
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
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

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data;
  assert.ok(models.every((model) => model.id !== 'claude-codex-auto'));

  const v2Response = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=xhigh] dispatch ticket' }],
    output_config: { preserve: true },
  }));
  assert.equal(v2Response.status, 200);
  assert.equal(forwarded[0].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[0].output_config, { preserve: true, effort: 'xhigh' });
  assert.equal(JSON.parse(v2Response.body).model, 'claude-codex-auto');

  const v1Response = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra] legacy briefing' }],
  }));
  assert.equal(v1Response.status, 200);
  assert.equal(forwarded[1].model, 'gpt-5.6-terra');
  assert.equal('output_config' in forwarded[1], false);

  const invalidEffortResponse = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=high] valid [sidequest-route model=gpt-5.6-sol effort=invalid] ignored' }],
  }));
  assert.equal(invalidEffortResponse.status, 200);
  assert.equal(forwarded[2].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[2].output_config, { effort: 'high' });

  const routes = fs.readFileSync(routeLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual({ backend: routes[0].backend, model: routes[0].model, via: routes[0].via, effort: routes[0].effort }, {
    backend: 'codex', model: 'gpt-5.6-terra', via: 'dispatch', effort: 'xhigh',
  });
});

test('dispatch model is listed with the explicit rollback flag and stays routable', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
        return;
      }
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_LIST_DISPATCH_MODEL: '1',
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data;
  assert.ok(models.some((model) => model.id === 'claude-codex-auto' && model.display_name === 'Sidequest Dispatch (Codex)'));

  const response = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [{ role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=medium] dispatch ticket' }],
  }));
  assert.equal(response.status, 200);
  assert.equal(forwarded[0].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[0].output_config, { effort: 'medium' });
});

test('dispatch model rejects missing and malformed route markers', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const retiredMarker = `[${['switch', 'board-route'].join('')} model=gpt-5.6-terra]`;
  for (const content of [
    'no route marker',
    '[sidequest-route model=GPT-5.6-terra]',
    retiredMarker,
    '[sidequest-route model=gpt-5.6-terra] [sidequest-route model=gpt-5.6-terra]',
  ]) {
    const response = await request(shimPort, '/v1/messages', JSON.stringify({
      model: 'claude-codex-auto', messages: [{ role: 'user', content }],
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'model-gateway: dispatch model requires exactly one [sidequest-route model=...] marker in the conversation; redispatch the ticket',
      },
    });
  }
});

test('dispatchRouteFromMessages scans only user-authored text blocks', () => {
  // Canonical marker in a plain-string user message resolves.
  assert.deepEqual(
    gw.dispatchRouteFromMessages([
      { role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=high] work the ticket' },
    ]),
    { model: 'gpt-5.6-terra', effort: 'high' },
  );

  // Briefing marker in a type:"text" block resolves.
  assert.deepEqual(
    gw.dispatchRouteFromMessages([
      { role: 'user', content: [{ type: 'text', text: '[sidequest-route model=gpt-5.6-sol]' }] },
    ]),
    { model: 'gpt-5.6-sol', effort: null },
  );

  // A LATER valid marker inside a tool_result block is ignored — briefing wins.
  assert.deepEqual(
    gw.dispatchRouteFromMessages([
      { role: 'user', content: '[sidequest-route model=gpt-5.6-terra] briefing' },
      { role: 'assistant', content: [{ type: 'text', text: 'reading the diff' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'echoed [sidequest-route model=codex-gpt-5-6-terra] fixture' },
      ] },
    ]),
    { model: 'gpt-5.6-terra', effort: null },
  );

  // A tool_result whose content is a nested block array is also skipped whole.
  assert.deepEqual(
    gw.dispatchRouteFromMessages([
      { role: 'user', content: '[sidequest-route model=gpt-5.6-terra] briefing' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '[sidequest-route model=codex-gpt-5-6-luna]' }] },
      ] },
    ]),
    { model: 'gpt-5.6-terra', effort: null },
  );

  // A valid marker in assistant message text never counts.
  assert.equal(
    gw.dispatchRouteFromMessages([
      { role: 'assistant', content: [{ type: 'text', text: '[sidequest-route model=gpt-5.6-sol]' }] },
      { role: 'assistant', content: '[sidequest-route model=gpt-5.6-luna]' },
    ]),
    null,
  );

  // No qualifying marker anywhere (only tool_result / assistant) → null.
  assert.equal(
    gw.dispatchRouteFromMessages([
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't3', content: '[sidequest-route model=codex-gpt-5-6-terra]' },
      ] },
      { role: 'assistant', content: '[sidequest-route model=gpt-5.6-sol]' },
    ]),
    null,
  );

  // Any duplicate or conflicting qualifying marker is rejected.
  for (const messages of [
    [{ role: 'user', content: '[sidequest-route model=gpt-5.6-sol effort=low] [sidequest-route model=gpt-5.6-sol effort=low]' }],
    [
      { role: 'user', content: '[sidequest-route model=gpt-5.6-sol effort=low]' },
      { role: 'user', content: [{ type: 'text', text: '[sidequest-route model=gpt-5.6-terra effort=xhigh]' }] },
    ],
  ]) {
    assert.equal(gw.dispatchRouteFromMessages(messages), null);
  }
});

test('dispatch route ignores markers echoed through tool_result blocks end-to-end', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
        return;
      }
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  // Briefing marker wins even though a later tool_result echoes a competing
  // (invalid-upstream) marker — the SQ-375 self-hijack scenario.
  const hijackAttempt = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [
      { role: 'user', content: '[sidequest-route model=gpt-5.6-terra effort=high] work the ticket' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok, reading the diff' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'leftover diff: [sidequest-route model=codex-gpt-5-6-terra]' },
      ] },
    ],
  }));
  assert.equal(hijackAttempt.status, 200);
  assert.equal(forwarded[0].model, 'gpt-5.6-terra');
  assert.deepEqual(forwarded[0].output_config, { effort: 'high' });

  // A marker present ONLY in a tool_result → no qualifying route → 400 redispatch.
  const toolResultOnly = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-codex-auto',
    messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: '[sidequest-route model=gpt-5.6-terra]' },
      ] },
    ],
  }));
  assert.equal(toolResultOnly.status, 400);
  assert.deepEqual(JSON.parse(toolResultOnly.body), {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'model-gateway: dispatch model requires exactly one [sidequest-route model=...] marker in the conversation; redispatch the ticket',
    },
  });
  assert.equal(forwarded.length, 1);
});

test('buildCatalog publishes the v4 provider-generic model contract', () => {
  const readiness = {
    codex: { ready: true, state: 'ready', message: 'Codex is ready.' },
    grok: { ready: false, state: 'auth-missing', message: 'Grok CLI auth is missing. Run `grok` and log in again.' },
  };
  const catalog = gw.buildCatalog([
    'claude-codex-auto',
    'claude-gpt-5.6-sol',
    'claude-gpt-5.6-terra',
    'claude-gpt-5.6-luna',
    'claude-gpt-5.6-sol-fast',
    'claude-gpt-5.6-terra-fast',
    'claude-gpt-5.6-luna-fast',
    'claude-grok-4.5',
    'claude-grok-build',
  ], readiness);
  assert.equal(catalog.schemaVersion, 4);
  assert.equal(catalog.source, 'model-gateway');
  assert.equal(catalog.writtenBy, JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.deepEqual(catalog.providers, readiness);
  assert.deepEqual(catalog.codexReadiness, catalog.providers.codex);
  assert.deepEqual(catalog.models, [
    {
      slug: 'codex-gpt-5-6-sol',
      id: 'claude-gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      provider: 'codex',
    },
    {
      slug: 'codex-gpt-5-6-terra',
      id: 'claude-gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      provider: 'codex',
    },
    {
      slug: 'codex-gpt-5-6-luna',
      id: 'claude-gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      provider: 'codex',
    },
    {
      slug: 'codex-gpt-5-6-sol-fast',
      id: 'claude-gpt-5.6-sol-fast',
      label: 'GPT-5.6 Sol Fast',
      provider: 'codex',
    },
    {
      slug: 'codex-gpt-5-6-terra-fast',
      id: 'claude-gpt-5.6-terra-fast',
      label: 'GPT-5.6 Terra Fast',
      provider: 'codex',
    },
    {
      slug: 'codex-gpt-5-6-luna-fast',
      id: 'claude-gpt-5.6-luna-fast',
      label: 'GPT-5.6 Luna Fast',
      provider: 'codex',
    },
    {
      slug: 'grok-4-5',
      id: 'claude-grok-4.5',
      label: 'Grok 4.5',
      provider: 'grok',
    },
    {
      slug: 'grok-build',
      id: 'claude-grok-build',
      label: 'Grok build',
      provider: 'grok',
    },
  ]);
});

test('writeCatalogFile preserves missing models from a same-schema subset write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-subset-write-'));
  const file = path.join(dir, 'catalog.json');
  try {
    const existing = gw.buildCatalog([
      'claude-gpt-5.6-terra',
      'claude-gpt-5.6-sol',
    ]);
    const subset = gw.buildCatalog(['claude-gpt-5.6-terra']);
    fs.writeFileSync(file, JSON.stringify(existing));

    const written = gw.writeCatalogFile(file, subset);

    assert.deepEqual(written.models.map((model) => model.id), [
      'claude-gpt-5.6-terra',
      'claude-gpt-5.6-sol',
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), written);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCatalogFile preserves provider readiness for subset-retained models', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-provider-subset-write-'));
  const file = path.join(dir, 'catalog.json');
  const readiness = {
    codex: { ready: true, state: 'ready', message: 'Codex is ready.' },
    grok: { ready: false, state: 'auth-missing', message: 'Grok CLI auth is missing.' },
  };
  try {
    const existing = gw.buildCatalog(['claude-gpt-5.6-terra', 'claude-grok-4.5'], readiness);
    const subset = gw.buildCatalog(['claude-gpt-5.6-terra'], readiness);
    fs.writeFileSync(file, JSON.stringify(existing));

    const written = gw.writeCatalogFile(file, subset);

    assert.deepEqual(written.models.map((model) => model.id), ['claude-gpt-5.6-terra', 'claude-grok-4.5']);
    assert.deepEqual(written.providers, readiness);
    assert.deepEqual(written.codexReadiness, written.providers.codex);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCatalogFile replaces a catalog when the fetched set contains a new model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-superset-write-'));
  const file = path.join(dir, 'catalog.json');
  try {
    fs.writeFileSync(file, JSON.stringify(gw.buildCatalog(['claude-gpt-5.6-terra'])));
    const replacement = gw.buildCatalog([
      'claude-gpt-5.6-terra',
      'claude-gpt-5.6-sol',
    ]);

    const written = gw.writeCatalogFile(file, replacement);

    assert.deepEqual(written, replacement);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), replacement);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQ-2208: catalog --refresh --json keeps stdout parseable while it logs a preserved subset', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-json-stdout-'));
  const state = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'catalog.json'), JSON.stringify(gw.buildCatalog([
    'claude-gpt-5.6-terra',
    'claude-gpt-5.6-sol',
  ])));

  const port = await freePort();
  const shim = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/healthz' ? '{"ok":true}' : '{"data":[{"id":"claude-gpt-5.6-terra"}]}');
  });
  await new Promise((resolve) => shim.listen(port, '127.0.0.1', resolve));
  t.after(() => {
    shim.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Not spawnSync: this fake shim answers from the test's own event loop, which a synchronous child blocks.
  const result = await new Promise((resolve) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, 'catalog', '--refresh', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_GATEWAY_PORT: String(port),
        CODEX_GATEWAY_WORKER_PORT: String(port),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /catalog: preserved claude-gpt-5\.6-sol from a subset write/);
  assert.deepEqual(
    JSON.parse(result.stdout).models.map((model) => model.id),
    ['claude-gpt-5.6-terra', 'claude-gpt-5.6-sol'],
    'a --json invocation is a machine contract, so a human diagnostic belongs on stderr',
  );
});

test('doctor prints the catalog writer version', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-doctor-'));
  try {
    const state = path.join(home, '.claude', 'model-gateway');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'catalog.json'), JSON.stringify({
      schemaVersion: 4,
      source: 'model-gateway',
      writtenBy: '0.30.0',
      models: [],
    }));

    const result = spawnGatewayProcessSync(process.execPath, [CLI, 'doctor'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });

    assert.match(result.stdout, /catalog: 0 models at .+ \(writtenBy: 0\.30\.0\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeCatalogFile refuses to replace a future schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-write-guard-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 5, models: [] }));
  assert.throws(
    () => gw.writeCatalogFile(file, gw.buildCatalog(['claude-gpt-5.6-terra'])),
    /refusing to overwrite catalog schema 5.*supports schema 4.*upgrade required/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 5, models: [] });
});

// SQ-1004: the advertised ids lost their backend segment, so `claude-` is no
// longer a route discriminator — the whole Anthropic catalog shares it.
test('codexBaseFromId claims only gateway ids', () => {
  assert.equal(gw.codexBaseFromId('claude-gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(gw.codexBaseFromId('claude-gpt-5.6-sol[1m]'), 'gpt-5.6-sol');
  assert.equal(gw.codexBaseFromId('claude-codex-gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(gw.codexBaseFromId('claude-codex-auto'), 'auto');
  for (const passthrough of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-4-5', 'claude-fable-5', 'claude-haiku-4-5', 'claude-grok-4.5', 'claude-', 'gpt-5.6-sol', null]) {
    assert.equal(gw.codexBaseFromId(passthrough), null, `${passthrough} must not be claimed by the Codex route`);
  }
  assert.equal(gw.isGatewayModelId('claude-grok-4.5'), true);
  assert.equal(gw.isGatewayModelId('claude-opus-5'), false);
});

test('the shim keeps Claude ids on the Anthropic path and claims both id forms for Codex', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const toCodex = [];
  const toAnthropic = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }));
      toCodex.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-terra', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      toAnthropic.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5', content: [] }));
    });
  });
  const anthropicPort = await new Promise((resolve) => {
    anthropic.listen(0, '127.0.0.1', () => resolve(anthropic.address().port));
  });
  t.after(() => anthropic.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
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

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data.map(({ id }) => id);
  assert.ok(models.includes('claude-gpt-5.6-terra'), `advertised: ${models.join(', ')}`);
  assert.ok(models.includes('claude-grok-4.5'), `advertised: ${models.join(', ')}`);
  assert.ok(models.every((id) => id.startsWith('claude-')), 'discovery drops ids that do not start with claude');

  for (const model of ['claude-gpt-5.6-terra', 'claude-codex-gpt-5.6-terra', 'claude-opus-5[1m]', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
    const response = await request(shimPort, '/v1/messages', JSON.stringify({ model, max_tokens: 1, messages: [] }));
    assert.equal(response.status, 200, `${model} returned ${response.status}`);
  }

  assert.deepEqual(toCodex, ['gpt-5.6-terra', 'gpt-5.6-terra']);
  assert.deepEqual(toAnthropic, ['claude-opus-5[1m]', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
});
