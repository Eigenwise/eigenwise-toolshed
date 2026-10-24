'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment, spawnGatewayProcessSync } = require('./support.js');
const home = isolateInProcessGatewayEnvironment(test);
const commands = require('../lib/commands.js');
const { capability, envelope, native, server } = require('./fixtures/antigravity.js');
const onboarding = () => require('../lib/onboarding.js');
const report = (overrides = {}) => ({ schema_version: 1, provider: 'antigravity', ...capability(overrides) });
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

test('onboarding is guidance-only: missing Codex default, explicit provider changes only, invalid files preserved', () => {
  const api = onboarding();
  const file = path.join(home, 'onboarding-fixture.json');
  assert.equal(api.readOnboarding(file), 'codex');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(api.prepareSetup([], { file }), { provider: 'codex', explicit: false, preserveWiring: false });
  api.writeOnboarding('antigravity', file);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(bytes), { schemaVersion: 1, provider: 'antigravity' });
  for (const args of [[], ['--preserve-wiring']]) assert.equal(api.prepareSetup(args, { file }).provider, 'antigravity');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(api.prepareSetup(['--provider', 'codex'], { file }).provider, 'codex');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'preflight does not write');
  for (const bytes of ['invalid', '{"schemaVersion":2,"provider":"codex"}', '{"schemaVersion":1,"provider":"other"}']) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => api.prepareSetup(['--provider', 'antigravity'], { file }), /onboarding.*preserv/i);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('setup validates all arguments and onboarding state before downloads, directories or service actions', () => {
  for (const args of [['--provider'], ['--provider', 'gemini'], ['--provider', 'codex', '--provider', 'antigravity'], ['--unknown']]) {
    const isolatedHome = fs.mkdtempSync(path.join(home, 'invalid-setup-'));
    const result = spawnGatewayProcessSync(process.execPath, [CLI, 'setup', ...args], { encoding: 'utf8', env: { HOME: isolatedHome, USERPROFILE: isolatedHome } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /setup.*provider|setup.*argument/i);
    assert.equal(fs.existsSync(path.join(isolatedHome, '.claude', 'model-gateway')), false);
  }
});

test('setup argument validation is pure so mutable onboarding is read only after lifecycle serialization', (t) => {
  const api = onboarding();
  const reads = [];
  t.mock.method(fs, 'readFileSync', () => { reads.push('read'); throw new Error('unexpected preference read before lock'); });
  assert.deepEqual(api.validateSetupArguments(['--provider', 'antigravity', '--preserve-wiring']),
    { provider: 'antigravity', explicit: true, preserveWiring: true });
  assert.deepEqual(api.validateSetupArguments([]), { provider: 'codex', explicit: false, preserveWiring: false });
  assert.deepEqual(reads, []);
});

test('native status exit0 is a report, not authentication success; refresh-capable local readiness is separate from serving support', () => {
  const api = onboarding();
  const calls = [];
  const run = (_binary, args, options) => { calls.push({ args, options }); return { status: 0, stdout: JSON.stringify(report({ enabled: false,
    status: { configuration: 'valid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } })) }; };
  const result = api.probeCliStatus('fake-candidate', { run });
  assert.equal(result.authoritative, true);
  assert.equal(result.state, 'disabled');
  assert.equal(result.provider.status.configuration_ready, false);
  assert.deepEqual(calls[0].args, ['antigravity', 'auth', 'status', '--json']);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 10000);
  assert.ok(calls[0].options.maxBuffer <= 262144);
});

test('staged candidate refusal preserves installed binary and services; disabled/unauthed native candidate is compatible', async () => {
  const api = onboarding();
  const calls = [];
  const file = path.join(home, 'installed-proxy'); fs.writeFileSync(file, 'original binary');
  const common = { required: true, staged: 'candidate', install: () => { calls.push('replace'); fs.writeFileSync(file, 'new'); },
    restart: () => calls.push('restart') };
  for (const result of [{ status: 1 }, { status: 0, stdout: 'invalid' }, { status: 0, stdout: JSON.stringify({ ...report(), schema_version: 2 }) },
    { status: 0, stdout: JSON.stringify(report({ mode: 'openai' })) }]) {
    await assert.rejects(api.installCompatibleCandidate({ ...common, run: () => result }), /Antigravity.*incompatible/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original binary');
    assert.deepEqual(calls, []);
  }
  await api.installCompatibleCandidate({ ...common, run: () => ({ status: 0, stdout: JSON.stringify(report({ enabled: false,
    status: { configuration: 'valid', auth: 'missing', project: 'missing', configuration_ready: false, live_verified: false } })) }) });
  assert.deepEqual(calls, ['replace', 'restart']);
  let probed = false;
  await api.installCompatibleCandidate({ ...common, required: false, run: () => { probed = true; throw new Error('not permitted'); } });
  assert.equal(probed, false, 'ordinary Codex update skips extra probe');
});

test('new auth command validates before invocation, never enables provider or changes onboarding', () => {
  const api = onboarding();
  const calls = [];
  const run = (binary, args, options) => { calls.push({ binary, args, options }); return { status: 0, stdout: JSON.stringify(report({ enabled: false })) }; };
  for (const args of [[], ['codex', 'login'], ['antigravity', 'device'], ['antigravity', 'login', '--device'], ['antigravity', 'logout', '--enable']]) {
    assert.throws(() => api.runAuth(args, { binary: 'fake', run, print: () => {} }), /auth antigravity|device/i);
  }
  assert.equal(calls.length, 0);
  for (const action of ['login', 'logout', 'status']) assert.equal(api.runAuth(['antigravity', action], { binary: 'fake', run, print: () => {} }), 0);
  assert.deepEqual(calls.map((call) => call.args), [['antigravity', 'auth', 'login'], ['antigravity', 'auth', 'logout'], ['antigravity', 'auth', 'status', '--json']]);
  assert.ok(calls.every((call) => !Object.hasOwn(call.options, 'env')));
});

test('upgrade requirement sees explicit file intent even with old binary and serving down, including native relative/empty resolver', async () => {
  const api = onboarding();
  const cwd = path.join(home, 'native-profile'); fs.mkdirSync(cwd, { recursive: true });
  const absent = () => ({ state: 'unsupported', authoritative: false, provider: null });
  for (const root of ['', 'relative']) {
    const directory = path.resolve(cwd, root); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'config.json');
    const environment = { CCP_CONFIG_DIR: root, CCP_ANTIGRAVITY_ENABLED: 'false', HOME: '/not-the-profile', APPDATA: '/not-appdata' };
    fs.writeFileSync(file, JSON.stringify({ antigravity: { enabled: true, clientSecret: 'private-never-log' } }));
    assert.equal(await api.compatibilityRequired({ provider: 'codex', port: 0, cwd, environment, probe: absent, serving: async () => absent() }), true);
    for (const value of ['invalid', '[]', '{"antigravity":{"enabled":"false"}}', '{"antigravity":{"enabled":false,"unknown":"private"}}',
      '{"antigravity":{"enabled":true},"antigravity":{"enabled":false}}']) {
      fs.writeFileSync(file, value);
      await assert.rejects(api.compatibilityRequired({ provider: 'codex', port: 0, cwd, environment, probe: absent, serving: async () => absent() }), /configuration.*indeterminate/i);
      assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
    fs.writeFileSync(file, '{"otherProvider":{"value":"unchanged"}}');
    assert.equal(await api.compatibilityRequired({ provider: 'codex', port: 0, cwd, environment, probe: absent, serving: async () => absent() }), false);
  }
});

test('upgrade checks serving native support conditionally without probing ordinary-provider capabilities', async (t) => {
  const api = onboarding();
  let agy = false;
  const queries = [];
  const proxy = await server(t, (req, res) => {
    queries.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('?') ? envelope() : { data: [{ id: agy ? native() : 'gpt-6-astra' }] }));
  });
  const options = { provider: 'codex', port: proxy.port, environment: { CCP_CONFIG_DIR: path.join(home, 'no-native-config') },
    probe: () => ({ authoritative: false, provider: null }) };
  assert.equal(await api.compatibilityRequired(options), false);
  assert.deepEqual(queries, ['/v1/models']);
  agy = true;
  assert.equal(await api.compatibilityRequired(options), true);
  assert.ok(queries.includes('/v1/models?include_capabilities=true'));
  assert.equal(await api.compatibilityRequired({ ...options, port: 0 }), false);
});

test('native config intent is bounded, redacted and uses the actual CCP/XDG/HOME resolver', () => {
  const { configPath, configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const directory = path.join(home, 'config-checks'); fs.mkdirSync(directory, { recursive: true });
  assert.equal(configPath({ HOME: '/fixture-home', APPDATA: '/ignored' }, directory), path.resolve('/fixture-home', '.config', 'claude-code-proxy', 'config.json'));
  assert.equal(configPath({ USERPROFILE: '/fixture-profile' }, directory), path.resolve('/fixture-profile', '.config', 'claude-code-proxy', 'config.json'));
  assert.equal(configPath({ XDG_CONFIG_HOME: 'relative' }, directory), path.join(directory, 'relative', 'claude-code-proxy', 'config.json'));
  const environment = { CCP_CONFIG_DIR: directory };
  const file = path.join(directory, 'config.json');
  assert.equal(configRequiresCompatibility({ environment }), false);
  fs.writeFileSync(file, '{"antigravity":{"enabled":false,"baseUrl":"https://fixture.invalid","clientId":"fixture","clientSecret":"private","projectId":"fixture"}}');
  assert.equal(configRequiresCompatibility({ environment }), false);
  assert.equal(configRequiresCompatibility({ environment: { ...environment, CCP_ANTIGRAVITY_ENABLED: '1' } }), true);
  for (const raw of ['{"antigravity":null}', '{"antigravity":{"baseUrl":"http://fixture.invalid"}}',
    '{"antigravity":{"baseUrl":"https://fixture.invalid/path"}}', '{"antigravity":{"clientSecret":""}}',
    '{"antigravity":{"clientId":false}}', ' '.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => configRequiresCompatibility({ environment }), /configuration intent is indeterminate/);
  }
  fs.writeFileSync(file, '{}');
  assert.throws(() => configRequiresCompatibility({ environment: { ...environment, CCP_ANTIGRAVITY_ENABLED: 'TRUE' } }), /indeterminate/);
  assert.throws(() => configRequiresCompatibility({ environment: { ...environment, CCP_ANTIGRAVITY_BASE_URL: 'private-not-a-url' } }), /indeterminate/);
});

test('AGY-only SessionStart does not demand ChatGPT auth and retains direct-model fresh-session guidance', () => {
  const result = commands.sessionStartWiringNotice({ readiness: { onboardingProvider: 'antigravity', ready: true, checks: { codexAuth: false } },
    effectiveWiring: { source: null, value: null, shadowed: [] }, projectWirings: [] });
  assert.doesNotMatch(result, /ChatGPT|Codex.*missing|not signed in/i);
  assert.match(result, /Antigravity/);
  const blocked = commands.sessionStartWiringNotice({ readiness: { onboardingProvider: 'antigravity', ready: false, message: 'Antigravity auth login; fresh session', checks: { codexAuth: true } },
    effectiveWiring: { source: null, value: null, shadowed: [] }, projectWirings: [] });
  assert.equal(blocked, 'Antigravity auth login; fresh session');
});
