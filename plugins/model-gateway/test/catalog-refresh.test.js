'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const gw = require(CLI);

const STORED_IDS = ['claude-gpt-5.6-terra', 'claude-gpt-5.6-sol'];

function freePort() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function storedCatalog({ updatedAt }) {
  return { ...gw.buildCatalog(STORED_IDS), updatedAt };
}

// One isolated home, one fake shim and one CLI run per case, so a case that keeps failing
// silently cannot hide the next one.
async function runCatalogCommand(t, { respond, commandArguments, updatedAt }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-refresh-'));
  const catalogPath = path.join(home, '.claude', 'model-gateway', 'catalog.json');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(storedCatalog({ updatedAt })));
  const before = fs.readFileSync(catalogPath, 'utf8');

  const port = await freePort();
  const shim = http.createServer(respond);
  await new Promise((resolve) => shim.listen(port, '127.0.0.1', resolve));
  t.after(() => {
    shim.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Not spawnSync: the fake shim answers from this test's own event loop, which a synchronous child blocks.
  const result = await new Promise((resolve) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, 'catalog', ...commandArguments], {
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

  return { ...result, before, after: fs.readFileSync(catalogPath, 'utf8'), storedUpdatedAt: updatedAt };
}

function healthyShimServing(modelsBody) {
  return (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/healthz' ? '{"ok":true}' : modelsBody);
  };
}

const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FRESH = new Date().toISOString();

test('an explicit refresh that observes new models writes them and exits 0', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: STALE,
    commandArguments: ['--refresh', '--json'],
    respond: healthyShimServing(JSON.stringify({
      data: [...STORED_IDS, 'claude-gpt-5.6-luna'].map((id) => ({ id })),
    })),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /catalog refresh did not write/);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.models.map((model) => model.id), [
    'claude-gpt-5.6-terra[1m]',
    'claude-gpt-5.6-sol[1m]',
    'claude-gpt-5.6-luna[1m]',
  ]);
  assert.notEqual(printed.updatedAt, result.storedUpdatedAt);
  assert.deepEqual(JSON.parse(result.after), printed, 'the printed catalog is the one it just wrote');
});

test('issue #227: an explicit refresh whose shim advertises no gateway ids fails instead of reprinting the stored catalog', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: STALE,
    commandArguments: ['--refresh', '--json'],
    respond: healthyShimServing(JSON.stringify({
      data: [{ id: 'anthropic-custom' }, { id: 'gpt-5.6-terra' }],
    })),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /catalog refresh did not write \(shim advertised 2 model\(s\), none of them a gateway id\)/);
  assert.equal(result.after, result.before, 'the stored catalog is retained byte for byte');
  assert.equal(JSON.parse(result.stdout).updatedAt, result.storedUpdatedAt, 'stdout stays parseable and does not claim a fresh timestamp');
});

test('issue #227: an explicit refresh whose model list errors fails with the shim status', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: STALE,
    commandArguments: ['--refresh', '--json'],
    respond: (request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end('{"ok":true}');
      }
      response.writeHead(500);
      response.end('boom');
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /catalog refresh did not write \(shim \/v1\/models returned 500\)/);
  assert.equal(result.after, result.before);
});

test('issue #227: an explicit refresh against an unhealthy shim fails instead of exiting 0', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: STALE,
    commandArguments: ['--refresh', '--json'],
    respond: (request, response) => {
      response.writeHead(503);
      response.end('not ready');
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /catalog refresh did not write \(shim is not answering \/healthz on 127\.0\.0\.1:\d+\)/);
  assert.equal(result.after, result.before);
});

test('a stale-triggered refresh stays advisory: it reports the reason but keeps exit 0', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: STALE,
    commandArguments: ['--json'],
    respond: (request, response) => {
      response.writeHead(503);
      response.end('not ready');
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /catalog refresh did not write \(shim is not answering/);
  assert.equal(result.after, result.before);
  assert.equal(JSON.parse(result.stdout).updatedAt, result.storedUpdatedAt);
});

test('a fresh catalog read without --refresh touches nothing and says nothing', async (t) => {
  const result = await runCatalogCommand(t, {
    updatedAt: FRESH,
    commandArguments: ['--json'],
    respond: (request, response) => {
      response.writeHead(503);
      response.end('not ready');
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.after, result.before);
  assert.equal(JSON.parse(result.stdout).updatedAt, result.storedUpdatedAt);
});
