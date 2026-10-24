'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fixture, capability, envelope, picker, native, waitFor, request, server } = require('./fixtures/antigravity.js');
const { spawnGatewayProcess, gatewayTestEnvironment, startGateway } = require('./support.js');
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

function fixtureProxyPath(home, platform = process.platform) {
  return path.join(home, '.claude', 'model-gateway', 'bin', platform === 'win32' ? 'claude-code-proxy.exe' : 'claude-code-proxy');
}

function installFixtureState(environment, { platform = process.platform } = {}) {
  const state = path.join(environment.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(path.join(state, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(state, 'onboarding.json'), '{"schemaVersion":1,"provider":"antigravity"}\n');
  const binary = fixtureProxyPath(environment.HOME, platform);
  // Node --version is harmless; its nonexistent `codex` script reports unauthenticated.
  try { fs.linkSync(process.execPath, binary); } catch { fs.copyFileSync(process.execPath, binary); }
}

for (const [platform, binaryName] of [['linux', 'claude-code-proxy'], ['win32', 'claude-code-proxy.exe']]) {
  test(`native fixture binary layout follows its explicit ${platform} platform`, (t) => {
    const environment = gatewayTestEnvironment(t);
    installFixtureState(environment, { platform });
    assert.equal(fs.existsSync(path.join(environment.HOME, '.claude', 'model-gateway', 'bin', binaryName)), true);
  });
}

function cli(t, gateway, args, { exportEndpoint = true, cwd = gateway.env.HOME } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnGatewayProcess(t, process.execPath, [CLI, ...args], { env: gateway.env, cwd,
      isolatedOverrides: { CODEX_GATEWAY_PORT: String(gateway.port), CODEX_GATEWAY_WORKER_PORT: String(gateway.port),
        ANTHROPIC_BASE_URL: exportEndpoint ? `http://127.0.0.1:${gateway.port}` : undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function installVersionFixture() {
  const { BIN_DIR, PROXY_BIN } = require('../lib/runtime.js');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, PROXY_BIN);
  const plugins = path.join(process.env.HOME, '.claude', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2,
    plugins: { 'model-gateway@fixture': [{ scope: 'user' }] } }));
}

for (const observation of [
  { event: 'worker-exit', fields: { component: 'supervisor', pid: 301, child: { component: 'worker', pid: 302 }, exitCode: 0, signal: null },
    expected: /observed worker PID 302; exit code 0; signal none/ },
  { event: 'supervisor-exit', fields: { component: 'supervisor', pid: 301, signal: 'SIGTERM' },
    expected: /observed supervisor PID 301; exit code unavailable; signal SIGTERM/ },
]) {
  test(`doctor reports owned fixture ${observation.event}, bounded startup evidence and a stale serving version`, async (t) => {
    const gateway = require('../lib/commands.js');
    const { recordGatewayLifecycle, lifecycleLogPath } = require('../lib/lifecycle-diagnostics.js');
    installVersionFixture();
    recordGatewayLifecycle(observation.event, observation.fields);
    recordGatewayLifecycle('ensure-hook-wait-cut-short', { component: 'SessionStart', pid: 303, outcome: 'supervisor-started' });
    t.after(() => fs.unlinkSync(lifecycleLogPath()));
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(String(line)));
    const previousExitCode = process.exitCode;
    try {
      await gateway.commands.doctor({ readiness: { ready: true, state: 'ready', message: 'fixture local readiness',
        checks: { proxyBinary: true, proxyModels: true, codexAuth: true, shimRunning: true,
          servingVersion: '0.0.0', servingVersionMatches: false },
        health: { ok: true, models: 0, proxyRecovery: true, supervisorVersion: '0.0.0' } } });
    } finally { process.exitCode = previousExitCode; }
    const output = lines.join('\n');
    assert.match(output, observation.expected);
    assert.match(output, /startup evidence: SessionStart.*12s/);
    assert.match(output, /VERSION MISMATCH/);
    assert.match(output, /codex auth: authenticated/);
    assert.match(output, /install scope: user \(shared installation\)/);
  });
}

for (const scenario of [
  { provider: 'codex', args: ['ensure'], status: 1 },
  { provider: 'antigravity', args: ['ensure', '--quiet'], status: 0 },
]) {
  test(`real ${scenario.provider} ensure reports a protected foreign-listener refusal without changing it`, async (t) => {
    const proxy = await server(t, (_req, res) => res.end(JSON.stringify(envelope())));
    const foreign = await server(t, (_req, res) => res.end('foreign fixture'));
    const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
    installFixtureState(env);
    const state = path.join(env.HOME, '.claude', 'model-gateway');
    fs.writeFileSync(path.join(state, 'onboarding.json'), JSON.stringify({ schemaVersion: 1, provider: scenario.provider }));
    fs.writeFileSync(path.join(state, 'proxy-serving-version.txt'), process.version.slice(1));
    const result = await cli(t, { env, port: foreign.port }, scenario.args);
    assert.equal(result.status, scenario.status, result.stderr);
    assert.match(result.stdout + result.stderr, /model-gateway could not start/);
    assert.match(result.stdout + result.stderr, /left.*listener untouched|could not confirm the owner/);
    assert.equal((await request(foreign.port, null, {}, '/healthz', 'GET')).body, 'foreign fixture');
  });
}

test('unwired native onboarding reports its own missing binary without an implicit shell endpoint', async (t) => {
  const env = gatewayTestEnvironment(t);
  const state = path.join(env.HOME, '.claude', 'model-gateway');
  fs.mkdirSync(state, { recursive: true });
  const preference = JSON.stringify({ schemaVersion: 1, provider: 'antigravity' });
  fs.writeFileSync(path.join(state, 'onboarding.json'), preference);
  const result = await cli(t, { env, port: 0 }, ['ensure'], { exportEndpoint: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /not set up for Antigravity/);
  assert.doesNotMatch(result.stdout + result.stderr, /needs a ChatGPT browser sign-in/);
  assert.equal(fs.readFileSync(path.join(state, 'onboarding.json'), 'utf8'), preference);
  assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), false);
});

test('an unwired existing Codex binary does not start a supervisor or silently export an endpoint', async (t) => {
  const proxy = await server(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
  installFixtureState(env);
  const state = path.join(env.HOME, '.claude', 'model-gateway');
  fs.writeFileSync(path.join(state, 'onboarding.json'), JSON.stringify({ schemaVersion: 1, provider: 'codex' }));
  const result = await cli(t, { env, port: 0 }, ['ensure'], { exportEndpoint: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not signed in to ChatGPT/);
  assert.equal(fs.existsSync(path.join(state, 'guardian.pid')), false);
  assert.equal(fs.existsSync(path.join(env.HOME, '.claude', 'settings.local.json')), false);
});

test('settings-only quiet ensure preserves the live router while reporting Codex auth separately', async (t) => {
  const gateway = await fixture(t, { setup: (env) => {
    installFixtureState(env);
    const state = path.join(env.HOME, '.claude', 'model-gateway');
    fs.writeFileSync(path.join(state, 'onboarding.json'), JSON.stringify({ schemaVersion: 1, provider: 'codex' }));
    fs.writeFileSync(path.join(state, 'proxy-serving-version.txt'), process.version.slice(1));
  } });
  const file = path.join(gateway.env.HOME, '.claude', 'settings.local.json');
  const baseUrl = `http://127.0.0.1:${gateway.port}`;
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl } }));
  const result = await cli(t, gateway, ['ensure', '--quiet'], { exportEndpoint: false });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /wiring is shell-only|could not start/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.ANTHROPIC_BASE_URL, baseUrl);
  assert.equal(gateway.child.exitCode, null);
  assert.equal((await request(gateway.port, null, {}, '/healthz', 'GET')).status, 200);
});

test('standalone worker warns about environment-only wiring even when its effective mode is known', async (t) => {
  const proxy = await server(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port), ANTHROPIC_BASE_URL: 'http://127.0.0.1:0' });
  const marker = path.join(env.HOME, 'shell-only-warning-observed');
  const preload = path.join(env.HOME, 'observe-warning.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs');const previous=console.error;console.error=(...args)=>{if(String(args[0]).startsWith('model-gateway: ANTHROPIC_BASE_URL is shell-only;'))fs.writeFileSync(${JSON.stringify(marker)},'observed');previous(...args);};\n`);
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const gateway = await startGateway(t, 'serve-worker', env);
  const health = JSON.parse((await request(gateway.port, null, {}, '/healthz', 'GET')).body);
  assert.equal(health.usage.settingsLevelBaseUrl, false, 'an environment export is not settings-level wiring');
  assert.equal(fs.existsSync(marker), true, 'an environment-only effective mode is not persisted settings wiring');
});

for (const scenario of [
  { scope: 'project-local', file: 'settings.local.json', remedy: /Project settings.local.json wins/ },
  { scope: 'project', file: 'settings.json', remedy: /highest-precedence setting wins/ },
]) {
  test(`doctor explains ${scenario.scope} endpoint precedence without a process export`, async (t) => {
    const gateway = await fixture(t, { setup: installFixtureState });
    const project = path.join(gateway.env.HOME, 'separate-project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(gateway.env.HOME, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' } }));
    fs.writeFileSync(path.join(project, '.claude', scenario.file), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.port}` } }));
    const result = await cli(t, gateway, ['doctor'], { exportEndpoint: false, cwd: project });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /shadowed.*uses compat mode/);
    assert.match(result.stderr, scenario.remedy);
    assert.equal(gateway.child.exitCode, null);
  });
}

test('doctor keeps unexpected fileless shadowed endpoint diagnostics actionable and ignores unrelated endpoints', async (t) => {
  const gateway = await fixture(t, { setup: installFixtureState });
  const preload = path.join(gateway.env.HOME, 'virtual-shadow.cjs');
  const wiring = path.resolve(__dirname, '..', 'lib', 'settings-wiring.js');
  fs.writeFileSync(preload, `const api=require(${JSON.stringify(wiring)});const previous=api.effectiveBaseUrl;api.effectiveBaseUrl=()=>{const value=previous();return {...value,shadowed:[...value.shadowed,{source:'user',file:'fixture-other.json',value:'https://unrelated.invalid'},{source:'env',file:null,value:'http://api.anthropic.com'}]};};\n`);
  gateway.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const result = await cli(t, gateway, ['doctor']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /shadowed process env ANTHROPIC_BASE_URL uses compat mode/);
  assert.match(result.stderr, /Process env wins/);
  assert.equal(gateway.child.exitCode, null);
});

test('a discovery cache writer fault without an errno stays advisory and never crashes the worker', async (t) => {
  const proxy = await server(t, (_req, res) => res.end(JSON.stringify(envelope())));
  const env = gatewayTestEnvironment(t, { CODEX_GATEWAY_PROXY_PORT: String(proxy.port) });
  const marker = path.join(env.HOME, 'cache-fault-observed');
  const preload = path.join(env.HOME, 'cache-fault.cjs');
  const runtime = path.resolve(__dirname, '..', 'lib', 'runtime.js');
  fs.writeFileSync(preload, `require(${JSON.stringify(runtime)}).syncGatewayDiscoveryCache=()=>{throw new Error('fixture cache failure');};const fs=require('node:fs');const previous=console.error;console.error=(...args)=>{if(String(args[0]).includes('could not update discovery cache (fixture cache failure)'))fs.writeFileSync(${JSON.stringify(marker)},'observed');previous(...args);};\n`);
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' ');
  const gateway = await startGateway(t, 'serve-worker', env);
  await waitFor(() => fs.existsSync(marker));
  const models = JSON.parse((await request(gateway.port, null, {}, '/v1/models', 'GET')).body).data;
  assert.ok(models.some((row) => row.id === picker()));
  assert.equal(gateway.child.exitCode, null);
});

function priorMixedCatalog() {
  const ready = { ready: true, state: 'ready', message: 'historical local readiness' };
  return { schemaVersion: 4, source: 'model-gateway', updatedAt: '2020-01-01T00:00:00.000Z', writtenBy: 'fixture',
    providers: { codex: ready, antigravity: ready }, codexReadiness: ready,
    models: [{ id: 'claude-gpt-6-astra[1m]', slug: 'codex-gpt-6-astra', label: 'Codex', provider: 'codex' },
      { id: picker(), slug: 'antigravity-gemini-4-argon-low', label: 'Antigravity', provider: 'antigravity' }] };
}

async function refreshMixedFixture(t, capabilityBody, { status = 200, models = [], healthy = true } = {}) {
  const requests = [];
  const proxy = await server(t, (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof capabilityBody === 'string' ? capabilityBody : JSON.stringify(capabilityBody));
  });
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const shim = await server(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/healthz' ? { ok: healthy, version } : { data: models.map((id) => ({ id })) }));
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

test('catalog refresh retains model identity but never reports ready when shim health is unavailable', async (t) => {
  const result = await refreshMixedFixture(t, envelope(capability(), [native()]), { models: [picker()], healthy: false });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.models.some((row) => row.id === picker()), true);
  assert.equal(catalog.providers.antigravity.ready, false);
  assert.equal(catalog.providers.antigravity.state, 'shim-down');
  assert.deepEqual(JSON.parse(result.after), catalog);
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
  fs.rmSync(fixtureProxyPath(gateway.env.HOME));
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
