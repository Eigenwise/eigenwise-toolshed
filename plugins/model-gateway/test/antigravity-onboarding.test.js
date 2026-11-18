'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { isolateInProcessGatewayEnvironment, spawnGatewayProcessSync } = require('./support.js');
const home = isolateInProcessGatewayEnvironment(test);
const commands = require('../lib/commands.js');
const { capability, envelope, native, server } = require('./fixtures/antigravity.js');
const onboarding = () => require('../lib/onboarding.js');
const report = (overrides = {}) => ({ schema_version: 1, provider: 'antigravity', ...capability(overrides) });
const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');

function windowsConfigPath() {
  const subject = path.join(__dirname, '..', 'lib', 'antigravity-config-intent.js');
  const subjectRequire = createRequire(subject);
  const injectedCwd = 'C:\\syntheticcwd';
  const defaultCwd = 'D:\\workspace';
  const windowsPath = {
    join: path.win32.join,
    resolve: (...segments) => path.win32.resolve(...(
      segments[0] === injectedCwd ? segments : [defaultCwd, ...segments]
    )),
  };
  const subjectModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(subject, 'utf8'), {
    module: subjectModule,
    exports: subjectModule.exports,
    process: { cwd: () => defaultCwd, env: {} },
    require: (specifier) => specifier === 'node:path' ? windowsPath : subjectRequire(specifier),
  }, { filename: subject });
  return subjectModule.exports.configPath;
}

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

for (const scenario of [
  { label: 'new Codex supervisor', provider: 'codex', quiet: true, result: { waitCutShort: true, started: ['shim'] }, code: 0,
    message: /retry the Codex model/, commandCalls: 0, records: [['ensure-hook-wait-cut-short', 'SessionStart', 'supervisor-started']] },
  { label: 'existing native supervisor', provider: 'antigravity', quiet: true, result: { waitCutShort: true, started: [] }, code: 0,
    message: /retry the Antigravity model/, commandCalls: 0, records: [] },
  { label: 'unreported start list', provider: 'antigravity', quiet: true, result: { waitCutShort: true }, code: 0,
    message: /retry the Antigravity model/, commandCalls: 0, records: [] },
  { label: 'explicit startup refusal', provider: 'codex', quiet: false, result: { waitCutShort: true, reason: 'fixture refusal' }, code: 1,
    message: /could not start: fixture refusal.*fixture-cli.js.*doctor/, commandCalls: 1, records: [] },
  { label: 'quiet permanent refusal', provider: 'antigravity', quiet: true, result: { waitCutShort: false, reason: 'fixture refusal' }, code: 1,
    message: /could not start: fixture refusal.*fixture-cli.js.*doctor/, commandCalls: 1, records: [] },
]) {
  test(`provider startup guidance preserves lifecycle authority for ${scenario.label}`, () => {
    const notices = [];
    const records = [];
    const codes = [];
    let commandCalls = 0;
    onboarding().reportStartupFailure({ quiet: scenario.quiet, provider: scenario.provider, finish: (code) => codes.push(code) }, scenario.result, {
      notice: (message, options) => notices.push({ message, options }),
      record: (event, fields) => { assert.ok(Number.isInteger(fields.pid)); records.push([event, fields.component, fields.outcome]); },
      command: () => { commandCalls++; return 'fixture-cli.js'; },
    });
    assert.deepEqual(codes, [scenario.code]);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].options, { toStderr: true });
    assert.match(notices[0].message, scenario.message);
    assert.deepEqual(records, scenario.records);
    assert.equal(commandCalls, scenario.commandCalls);
  });
}

test('unreadable guidance remains preserved and an invalid provider cannot create a preference', (t) => {
  const api = onboarding();
  const file = path.join(home, 'invalid-provider-preference.json');
  assert.throws(() => api.writeOnboarding('unknown', file), /expects codex or antigravity/);
  assert.equal(fs.existsSync(file), false);
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('fixture permission refusal'), { code: 'EACCES' }); });
  assert.throws(() => api.readOnboarding(file), /preserved without changes/);
});

test('a supplied native snapshot avoids another probe and unavailable shim remains locally unready', async (t) => {
  const api = onboarding();
  const contract = require('../lib/antigravity-contract.js');
  const snapshot = contract.inspectCapabilities(envelope());
  const codex = { ready: false, checks: { shimRunning: false, servingVersionMatches: true, codexAuth: false } };
  let probes = 0;
  t.mock.method(require('node:http'), 'request', () => { probes++; throw new Error('unexpected fixture probe'); });
  const result = await api.gatewayReadiness({ provider: 'antigravity', getCodexReadiness: async () => codex, snapshot, port: 0 });
  assert.equal(result.ready, false);
  assert.equal(result.state, 'shim-down');
  assert.equal(result.antigravity, snapshot);
  assert.equal(result.codexReadiness, codex);
  assert.equal(probes, 0);
});

test('native compatibility intent trusts an enabled installed contract without probing serving state', async () => {
  const api = onboarding();
  const snapshot = require('../lib/antigravity-contract.js').inspectCliStatus(report());
  assert.equal(await api.compatibilityRequired({ provider: 'codex', port: 0,
    environment: { CCP_CONFIG_DIR: path.join(home, 'absent-install-intent') }, probe: () => snapshot,
    serving: async () => { throw new Error('unexpected serving probe'); } }), true);
});

test('ordinary model-list errors and malformed rows never trigger native capability probes', async (t) => {
  const api = onboarding();
  const queries = [];
  let status = 503;
  let body = { data: [{ id: native() }] };
  const proxy = await server(t, (req, res) => { queries.push(req.url); res.writeHead(status); res.end(JSON.stringify(body)); });
  const options = { provider: 'codex', port: proxy.port, environment: { CCP_CONFIG_DIR: path.join(home, 'absent-error-intent') },
    probe: () => ({ provider: null }) };
  assert.equal(await api.compatibilityRequired(options), false);
  status = 200; body = { data: {} };
  assert.equal(await api.compatibilityRequired(options), false);
  assert.deepEqual(queries, ['/v1/models', '/v1/models']);
});

for (const prior of [
  { enabled: true, expectedQueries: [] },
  { enabled: false, expectedQueries: ['/v1/models?include_capabilities=true'] },
]) {
  test(`remembered native enabled=${prior.enabled} support preserves compatibility without ordinary re-discovery`, async (t) => {
    const api = onboarding();
    const contract = require('../lib/antigravity-contract.js');
    const { createDiscoveryTracker } = require('../lib/antigravity-discovery.js');
    const { STATE } = require('../lib/runtime.js');
    const file = path.join(STATE, 'antigravity-discovery.json');
    assert.equal(fs.existsSync(file), false);
    const tracker = createDiscoveryTracker({ file, probe: async () => contract.inspectCapabilities(envelope(capability({ enabled: prior.enabled }))) });
    await tracker.observe([native()]);
    assert.equal(fs.existsSync(file), true);
    t.after(() => fs.unlinkSync(file));
    const queries = [];
    const proxy = await server(t, (req, res) => { queries.push(req.url); res.end(JSON.stringify(envelope())); });
    assert.equal(await api.compatibilityRequired({ provider: 'codex', port: proxy.port,
      environment: { CCP_CONFIG_DIR: path.join(home, 'absent-remembered-intent') }, probe: () => ({ provider: null }) }), true);
    assert.deepEqual(queries, prior.expectedQueries);
  });
}

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
  assert.ok(calls[0].options.timeout > 0);
  assert.ok(calls[0].options.timeout <= 10000);
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

test('manual login forwards exactly one native flag and preserves inherited terminal stdio', () => {
  const calls = [];
  const printed = [];
  const run = (binary, args, options) => { calls.push({ binary, args, options }); return { status: 0 }; };
  assert.equal(onboarding().runAuth(['antigravity', 'login', '--manual'],
    { binary: 'fixture-proxy', run, print: (line) => printed.push(line) }), 0);
  assert.deepEqual(calls, [{ binary: 'fixture-proxy', args: ['antigravity', 'auth', 'login', '--manual'],
    options: { stdio: 'inherit', windowsHide: true } }]);
  assert.match(printed[0], /without changing provider enablement or onboarding/);
});

test('manual auth rejects every unsupported shape before spawn and preserves native failure exits', () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  for (const args of [['login', '--manual', '--manual'], ['login', '--manual=true'], ['login', '--manual', 'extra'],
    ['login', '--json'], ['status', '--manual'], ['logout', '--manual']]) {
    assert.throws(() => onboarding().runAuth(['antigravity', ...args], { run }), /auth antigravity/);
  }
  assert.deepEqual(calls, []);
  const printed = [];
  for (const [result, expected] of [[{ status: 19 }, 19], [{ status: null }, 1]]) {
    assert.equal(onboarding().runAuth(['antigravity', 'login', '--manual'],
      { run: () => result, print: (line) => printed.push(line) }), expected);
  }
  assert.deepEqual(printed, [], 'a failed native login never prints a completion');
});

test('native string auth status permits normal refresh and static live_verified false is not login failure', () => {
  const contract = require('../lib/antigravity-contract.js');
  for (const auth of ['ready', 'refresh_required']) {
    const calls = [];
    const status = { configuration: 'valid', auth, project: 'configured', configuration_ready: true, live_verified: false };
    const run = (_binary, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(report({ status })) }; };
    const snapshot = onboarding().probeCliStatus('fixture-proxy', { run });
    assert.deepEqual(snapshot.provider.status, status);
    assert.equal(contract.readiness(snapshot).ready, true);
    assert.doesNotMatch(contract.readiness(snapshot).message, /login|sign.in/i);
    const codex = { ready: false, checks: { shimRunning: true, servingVersionMatches: true, codexAuth: false } };
    const selected = onboarding().selectedReadiness('antigravity', codex, snapshot);
    assert.equal(selected.ready, true);
    assert.equal(selected.codexReadiness, codex);
    const printed = [];
    assert.equal(onboarding().runAuth(['antigravity', 'status', '--json'],
      { run, print: (line) => printed.push(line) }), 0);
    assert.deepEqual(JSON.parse(printed[0]).status, status);
    assert.deepEqual(calls, Array(2).fill(['antigravity', 'auth', 'status', '--json']));
  }
});

test('native refresh-required status stays supported but locally unready when application configuration is incomplete', () => {
  const contract = require('../lib/antigravity-contract.js');
  const status = { configuration: 'valid', auth: 'refresh_required', project: 'configured', configuration_ready: false, live_verified: false };
  const calls = [];
  const run = (_binary, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(report({ status })) }; };
  const snapshot = onboarding().probeCliStatus('fixture-proxy', { run });
  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.provider.supported, true);
  assert.deepEqual(snapshot.provider.status, status);
  const readiness = contract.readiness(snapshot);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.state, 'configuration-unready');
  assert.doesNotMatch(readiness.message, /login|sign.in/i);
  const printed = [];
  assert.equal(onboarding().runAuth(['antigravity', 'status', '--json'], { run, print: (line) => printed.push(line) }), 0);
  assert.deepEqual(JSON.parse(printed[0]).status, status);
  assert.deepEqual(calls, Array(2).fill(['antigravity', 'auth', 'status', '--json']));
});

test('unsupported native support, missing binary and malformed status never become authentication success', () => {
  const unsupported = onboarding().probeCliStatus('fixture', { run: () => ({ status: 0,
    stdout: JSON.stringify({ schema_version: 1, provider: 'antigravity', supported: false }) }) });
  assert.equal(unsupported.state, 'unsupported');
  assert.deepEqual(unsupported.provider, { supported: false });
  const missing = onboarding().probeCliStatus('fixture', { run: () => { throw new Error('fixture executable missing'); } });
  assert.equal(missing.authoritative, false);
  for (const status of [
    { configuration: 'valid', auth: true, refresh_required: true, project: 'configured', configuration_ready: true, live_verified: false },
    { configuration: 'valid', auth: 'ready', project: 'configured', configuration_ready: true, live_verified: true },
  ]) {
    const run = () => ({ status: 0, stdout: JSON.stringify(report({ status })) });
    assert.equal(onboarding().probeCliStatus('fixture', { run }).state, 'malformed');
    assert.throws(() => onboarding().runAuth(['antigravity', 'status', '--json'], { run }), /compatible native status/);
  }
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

test('native config path honors the injected Windows cwd across C, drive-less and relative roots', () => {
  const configPath = windowsConfigPath();
  const cwd = 'C:\\syntheticcwd';
  const cases = [
    ['CCP_CONFIG_DIR absolute C root wins', { CCP_CONFIG_DIR: 'C:\\synthetic\\ccp', XDG_CONFIG_HOME: 'C:\\ignored\\xdg' }, 'C:\\synthetic\\ccp\\config.json'],
    ['CCP_CONFIG_DIR drive-less root inherits C cwd', { CCP_CONFIG_DIR: '\\synthetic\\ccp' }, 'C:\\synthetic\\ccp\\config.json'],
    ['CCP_CONFIG_DIR relative root uses C cwd', { CCP_CONFIG_DIR: 'relative-ccp' }, 'C:\\syntheticcwd\\relative-ccp\\config.json'],
    ['XDG absolute C root takes precedence over HOME', { XDG_CONFIG_HOME: 'C:\\synthetic\\xdg', HOME: 'C:\\ignored\\home' }, 'C:\\synthetic\\xdg\\claude-code-proxy\\config.json'],
    ['XDG drive-less root inherits C cwd', { XDG_CONFIG_HOME: '\\synthetic\\xdg' }, 'C:\\synthetic\\xdg\\claude-code-proxy\\config.json'],
    ['XDG relative root uses C cwd', { XDG_CONFIG_HOME: 'relative-xdg' }, 'C:\\syntheticcwd\\relative-xdg\\claude-code-proxy\\config.json'],
    ['HOME absolute C root takes precedence over USERPROFILE', { HOME: 'C:\\synthetic\\home', USERPROFILE: 'C:\\ignored\\profile' }, 'C:\\synthetic\\home\\.config\\claude-code-proxy\\config.json'],
    ['HOME drive-less root inherits C cwd', { HOME: '\\synthetic\\home' }, 'C:\\synthetic\\home\\.config\\claude-code-proxy\\config.json'],
    ['USERPROFILE absolute C root is the HOME fallback', { USERPROFILE: 'C:\\synthetic\\profile' }, 'C:\\synthetic\\profile\\.config\\claude-code-proxy\\config.json'],
  ];
  for (const [label, environment, expected] of cases) assert.equal(configPath(environment, cwd), expected, label);
  assert.equal(configPath({ CCP_CONFIG_DIR: 'relative-ccp' }, 'project'), 'D:\\workspace\\project\\relative-ccp\\config.json',
    'relative cwd resolution uses the simulated process cwd');
});

test('native config intent is bounded, redacted and uses the actual CCP/XDG/HOME resolver', () => {
  const { configPath, configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const directory = path.join(home, 'config-checks'); fs.mkdirSync(directory, { recursive: true });
  assert.equal(configPath({ HOME: '/fixture-home', APPDATA: '/ignored' }, directory), path.resolve(directory, '/fixture-home', '.config', 'claude-code-proxy', 'config.json'));
  assert.equal(configPath({ USERPROFILE: '/fixture-profile' }, directory), path.resolve(directory, '/fixture-profile', '.config', 'claude-code-proxy', 'config.json'));
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

function nativeConfigFixture(name, antigravity) {
  const directory = path.join(home, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ antigravity }));
  return { file, environment: { CCP_CONFIG_DIR: directory } };
}

test('native configuration depth bound rejects otherwise unrelated deeply nested provider data', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-config-depth', { enabled: false });
  let nested = { value: 0 };
  for (let index = 0; index < 65; index++) nested = { nested };
  const bytes = JSON.stringify({ antigravity: { enabled: false }, otherProvider: nested });
  fs.writeFileSync(fixture.file, bytes);
  assert.throws(() => configRequiresCompatibility(fixture), /configuration intent is indeterminate/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), bytes);
});

test('native userAgent accepts exact printable ASCII bounds without enabling or rewriting configuration', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-user-agent-valid', { enabled: false });
  const printable = 'x ' + String.fromCharCode(...Array.from({ length: 95 }, (_, index) => index + 32)) + ' z';
  for (const userAgent of ['x', 'fixture-proxy/1.2.3 (offline fixture)', 'x'.repeat(4096), printable]) {
    const bytes = JSON.stringify({ antigravity: { enabled: false, userAgent } });
    fs.writeFileSync(fixture.file, bytes);
    assert.equal(configRequiresCompatibility(fixture), false);
    assert.equal(fs.readFileSync(fixture.file, 'utf8'), bytes);
  }
});

test('native userAgent rejects invalid file values even when inference is disabled', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-user-agent-invalid-file', {});
  for (const userAgent of ['', ' leading', 'trailing ', '\tinside', 'bad\r\nfixture-sensitive', 'bad\u0000', '\u007f', '\u0080', 'λ',
    'x'.repeat(4097), false, 7, null, [], {}]) {
    const bytes = JSON.stringify({ antigravity: { enabled: false, userAgent } });
    fs.writeFileSync(fixture.file, bytes);
    assert.throws(() => configRequiresCompatibility(fixture), /configuration intent is indeterminate/);
    assert.equal(fs.readFileSync(fixture.file, 'utf8'), bytes);
  }
});

test('defined invalid native userAgent environment overrides never fall back to a default', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-user-agent-invalid-environment', { enabled: false });
  for (const value of ['', ' leading', 'trailing ', 'bad\nheader', '\u007f', 'é', 'x'.repeat(4097)]) {
    assert.throws(() => configRequiresCompatibility({ environment: { ...fixture.environment, CCP_ANTIGRAVITY_USER_AGENT: value } }),
      /configuration intent is indeterminate/);
  }
});

test('native userAgent environment precedence preserves explicit origin and rejects unknown native keys', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-user-agent-precedence', { enabled: false, baseUrl: 'https://native.example', userAgent: 'bad\r\nheader' });
  const bytes = fs.readFileSync(fixture.file, 'utf8');
  const environment = { ...fixture.environment, CCP_ANTIGRAVITY_USER_AGENT: 'fixture-proxy/1.2.3  explicit spacing' };
  assert.equal(configRequiresCompatibility({ environment }), false);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), bytes, 'validation cannot replace an explicit native origin or user-agent');
  assert.throws(() => configRequiresCompatibility(fixture), /indeterminate/);
  fs.writeFileSync(fixture.file, JSON.stringify({ antigravity: { userAgent: 'fixture-proxy/1.2.3', unknown: 'fixture' } }));
  assert.throws(() => configRequiresCompatibility({ environment }), /indeterminate/);
});

test('native file userAgent is type-checked before environment overlay but string contents remain overridable', () => {
  const { configRequiresCompatibility } = require('../lib/antigravity-config-intent.js');
  const fixture = nativeConfigFixture('native-user-agent-file-types', {});
  const environment = { ...fixture.environment, CCP_ANTIGRAVITY_USER_AGENT: 'fixture-proxy/1.2.3' };
  for (const userAgent of [42, null, false, [], {}]) {
    fs.writeFileSync(fixture.file, JSON.stringify({ antigravity: { enabled: false, userAgent } }));
    assert.throws(() => configRequiresCompatibility({ environment }), /configuration intent is indeterminate/);
  }
  for (const userAgent of ['', 'bad\r\nheader']) {
    fs.writeFileSync(fixture.file, JSON.stringify({ antigravity: { enabled: false, userAgent } }));
    assert.equal(configRequiresCompatibility({ environment }), false);
  }
});

test('an embedding can observe an unready ensure exit without running final wiring maintenance', async (t) => {
  const { ONBOARDING_PATH } = onboarding();
  const { PROXY_BIN, STATE } = require('../lib/runtime.js');
  assert.equal(fs.existsSync(PROXY_BIN), false);
  assert.equal(fs.existsSync(ONBOARDING_PATH), false);
  fs.mkdirSync(STATE, { recursive: true });
  const bytes = JSON.stringify({ schemaVersion: 1, provider: 'antigravity' });
  fs.writeFileSync(ONBOARDING_PATH, bytes);
  t.after(() => fs.unlinkSync(ONBOARDING_PATH));
  const exits = [];
  const notices = [];
  t.mock.method(process, 'exit', (code) => exits.push(code));
  t.mock.method(console, 'log', (line) => notices.push(String(line)));
  await commands.commands.ensure();
  assert.deepEqual(exits, [0]);
  assert.match(notices.join('\n'), /not set up for Antigravity/);
  assert.equal(fs.readFileSync(ONBOARDING_PATH, 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(STATE, 'guardian.pid')), false);
});

test('provider-specific wiring notices keep Codex sign-in separate and recognize project-local native wiring', () => {
  const codex = commands.sessionStartWiringNotice({ readiness: { onboardingProvider: 'codex', ready: false, checks: { codexAuth: false } },
    effectiveWiring: { source: null, value: null, shadowed: [] }, projectWirings: [] });
  assert.match(codex, /not signed in to ChatGPT/);
  const nativeWiring = commands.sessionStartWiringNotice({ readiness: { onboardingProvider: 'antigravity', ready: true, checks: { codexAuth: false } },
    effectiveWiring: { source: 'project-local', value: require('../lib/runtime.js').DEFAULT_BASE_URL,
      file: 'fixture-project/settings.local.json', shadowed: [] }, projectWirings: [] });
  assert.match(nativeWiring, /wired.*project settings.local.json/);
  assert.doesNotMatch(nativeWiring, /not signed in|ChatGPT/);
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
