'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fixture, capability, envelope, picker, native, waitFor, request, server } = require('./fixtures/antigravity.js');
const { spawnGatewayProcess, gatewayTestEnvironment } = require('./support.js');
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

function installFixtureState(environment) {
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(path.join(state, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(state, 'onboarding.json'), '{"schemaVersion":1,"provider":"antigravity"}\n');
  const binary = path.join(state, 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
  // Node --version is harmless; its nonexistent `codex` script reports unauthenticated.
  try { fs.linkSync(process.execPath, binary); } catch { fs.copyFileSync(process.execPath, binary); }
}

function cli(t, gateway, args) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, ...args], { env: gateway.env, cwd: gateway.env.HOME,
      isolatedOverrides: { CODEX_GATEWAY_PORT: String(gateway.port), CODEX_GATEWAY_WORKER_PORT: String(gateway.port),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function priorMixedCatalog() {
  const ready = { ready: true, state: 'ready', message: 'historical local readiness' };
  return { schemaVersion: 4, source: 'model-gateway', updatedAt: '2020-01-01T00:00:00.000Z', writtenBy: 'fixture',
    providers: { codex: ready, antigravity: ready }, codexReadiness: ready,
    models: [{ id: 'claude-gpt-6-astra[1m]', slug: 'codex-gpt-6-astra', label: 'Codex', provider: 'codex' },
      { id: picker(), slug: 'antigravity-gemini-4-argon-low', label: 'Antigravity', provider: 'antigravity' }] };
}

async function refreshMixedFixture(t, capabilityBody, { status = 200, models = [] } = {}) {
  const requests = [];
  const proxy = await server(t, (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof capabilityBody === 'string' ? capabilityBody : JSON.stringify(capabilityBody));
  });
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const shim = await server(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/healthz' ? { ok: true, version } : { data: models.map((id) => ({ id })) }));
  });
  const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
  const file = path.join(env.HOME, '.claude', 'model-gateway', 'catalog.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = JSON.stringify(priorMixedCatalog(), null, 2) + '\n';
  fs.writeFileSync(file, before);
  const result = await cli(t, { env, port: shim.port }, ['catalog', '--refresh', '--json']);
  assert.ok(requests.every(({ method }) => method === 'GET'));
  return { ...result, before, after: fs.readFileSync(file, 'utf8') };
}

test('an old AGY row cannot make an unconfirmed empty shim catalog a fresh successful refresh', async (t) => {
  const unknown = envelope(); unknown.capabilities.schema_version = 2;
  const cases = [{ data: [] }, unknown, 'not-json', envelope(capability(), [native()])];
  for (const body of cases) {
    const result = await refreshMixedFixture(t, body);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /catalog refresh did not write.*none of them a gateway id/);
    assert.equal(result.after, result.before);
    assert.equal(JSON.parse(result.stdout).updatedAt, '2020-01-01T00:00:00.000Z');
  }
  const failed = await refreshMixedFixture(t, { error: 'fixture unavailable' }, { status: 503 });
  assert.equal(failed.status, 1);
  assert.equal(failed.after, failed.before);
});

test('authoritative empty AGY removal retains Codex identity but never resurrects stale ready:true', async (t) => {
  for (const provider of [capability({ enabled: false }), { supported: false }, capability()]) {
    const result = await refreshMixedFixture(t, envelope(provider, []));
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(result.stdout);
    assert.deepEqual(catalog.models.map((row) => row.provider), ['codex']);
    assert.equal(catalog.providers.codex.ready, false);
    assert.equal(catalog.providers.codex.state, 'binary-missing');
    assert.deepEqual(catalog.codexReadiness, catalog.providers.codex);
    assert.equal(catalog.providers.antigravity, undefined);
    assert.notEqual(catalog.updatedAt, '2020-01-01T00:00:00.000Z');
    assert.deepEqual(JSON.parse(result.after), catalog);
  }
});

test('a nonempty AGY subset retains current unavailable Codex readiness alongside retained Codex rows', async (t) => {
  const result = await refreshMixedFixture(t, envelope(capability(), [native()]), { models: [picker()] });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.models.some((row) => row.provider === 'codex'), true);
  assert.equal(catalog.providers.codex.ready, false);
  assert.deepEqual(catalog.codexReadiness, catalog.providers.codex);
  assert.equal(catalog.providers.antigravity.ready, true);
});

test('AGY-only real status, doctor and SessionStart do not require Codex sign-in', async (t) => {
  const gateway = await fixture(t, { setup: installFixtureState });
  await waitFor(async () => JSON.parse((await request(gateway.port, null, {}, '/v1/models', 'GET')).body).data.some((row) => row.id === picker()));
  for (const command of ['start', 'status', 'doctor', 'ensure']) {
    const result = await cli(t, gateway, [command]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Codex readiness \(not required for Antigravity\): auth-missing/);
    assert.match(result.stdout, /Antigravity readiness: ready/);
    assert.doesNotMatch(result.stdout + result.stderr, /ChatGPT sign-in is required|not signed in to ChatGPT/);
  }
  const hook = await cli(t, gateway, ['ensure', '--quiet']);
  assert.equal(hook.status, 0, hook.stderr);
  assert.doesNotMatch(hook.stdout, /ChatGPT sign-in is required|not signed in to ChatGPT/);
  const state = JSON.parse(fs.readFileSync(path.join(gateway.env.HOME, '.claude', 'model-gateway', 'onboarding.json'), 'utf8'));
  assert.equal(state.provider, 'antigravity');
  fs.rmSync(path.join(gateway.env.HOME, '.claude', 'model-gateway', 'bin', process.platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy'));
  const missingBinary = await cli(t, gateway, ['ensure', '--quiet']);
  assert.equal(missingBinary.status, 0);
  assert.match(missingBinary.stdout, /Antigravity.*native proxy binary.*missing/);
  assert.doesNotMatch(missingBinary.stdout, /ChatGPT/);
  assert.equal(gateway.state.attempts.length, 0, 'all readiness and doctor operations are read-only native probes');
});

test('real catalog refresh projects AGY readiness honestly, preserves auth-missing rows and prunes authoritative disable', async (t) => {
  const gateway = await fixture(t, { setup: installFixtureState });
  await waitFor(async () => JSON.parse((await request(gateway.port, null, {}, '/v1/models', 'GET')).body).data.some((row) => row.id === picker()));
  const first = await cli(t, gateway, ['catalog', '--refresh', '--json']);
  assert.equal(first.status, 0, first.stderr);
  const initial = JSON.parse(first.stdout);
  assert.equal(initial.providers.antigravity.ready, true);
  assert.equal(initial.codexReadiness, null);
  gateway.state.caps = envelope(capability({ status: { configuration: 'valid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } }));
  const missing = JSON.parse((await cli(t, gateway, ['catalog', '--refresh', '--json'])).stdout);
  assert.equal(missing.providers.antigravity.ready, false);
  assert.equal(missing.models.filter((row) => row.provider === 'antigravity').length, 3);
  gateway.state.caps = envelope(capability(), [native('high')]);
  const changed = JSON.parse((await cli(t, gateway, ['catalog', '--refresh', '--json'])).stdout);
  assert.deepEqual(changed.models.filter((row) => row.provider === 'antigravity').map((row) => row.id), [picker('high')]);
  gateway.state.caps = envelope(capability({ enabled: false }), []);
  const disabled = JSON.parse((await cli(t, gateway, ['catalog', '--refresh', '--json'])).stdout);
  assert.deepEqual(disabled.models.filter((row) => row.provider === 'antigravity'), []);
  assert.equal(gateway.state.attempts.length, 0);
});
