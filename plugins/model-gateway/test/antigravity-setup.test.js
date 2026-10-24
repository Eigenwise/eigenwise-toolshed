'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isolateInProcessGatewayEnvironment } = require('./support.js');
const home = isolateInProcessGatewayEnvironment(test);
const gateway = require('../lib/commands.js');
const { PROXY_BIN, BIN_DIR } = require('../lib/runtime.js');
const { ONBOARDING_PATH, readOnboarding } = require('../lib/onboarding.js');
const { capability } = require('./fixtures/antigravity.js');
const noop = () => {};
const candidateReport = () => ({ status: 0, stdout: JSON.stringify({ schema_version: 1, provider: 'antigravity', ...capability({ enabled: false }) }) });
const stage = () => fs.mkdtempSync(path.join(home, 'stage-test-'));

test('setup staging uses platform assets and mocked verified downloads only', async () => {
  assert.equal(gateway.tarExecutable({ platform: 'linux' }), 'tar');
  assert.equal(gateway.tarExecutable({ platform: 'win32', systemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\tar.exe');
  assert.equal(gateway.tarExecutable({ platform: 'win32', systemRoot: '' }), 'C:\\Windows\\System32\\tar.exe');
  for (const [platform, architecture, suffix] of [['linux', 'x64', 'linux-amd64.tar.gz'], ['darwin', 'arm64', 'darwin-arm64.tar.gz'], ['win32', 'x64', 'windows-amd64.zip']]) {
    assert.equal(gateway.proxyAssetName({ platform, architecture }), 'claude-code-proxy-' + suffix);
  }
  const bytes = Buffer.from('fixture archive, never downloaded');
  const calls = [];
  const fetched = await gateway.downloadProxyArchive('fixture.tar.gz', {
    fetch: async (url) => { calls.push(url); return { status: 200, body: Buffer.from('{"tag_name":"fixture"}') }; },
    download: async (release, asset, options) => { assert.equal(release.tag_name, 'fixture'); assert.equal(asset, 'fixture.tar.gz'); assert.equal(typeof options.fetchUrl, 'function'); return bytes; }, report: noop,
  });
  assert.equal(fetched, bytes);
  assert.equal(calls.length, 1);
  await assert.rejects(gateway.downloadProxyArchive('fixture', { fetch: async () => ({ status: 403 }), report: noop }), /403/);
});

test('setup extraction and failed stages operate only on owned temporary files', async () => {
  const directory = stage();
  const file = gateway.extractProxyCandidate(directory, 'archive.tar.gz', Buffer.from('fake'), { run: (_command, args, options) => {
    assert.equal(args[0], '-xf'); assert.equal(options.cwd, directory);
    const nested = path.join(directory, 'nested'); fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, path.basename(PROXY_BIN)), 'fixture-binary');
    return { status: 0 };
  } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-binary');
  assert.throws(() => gateway.extractProxyCandidate(stage(), 'archive', Buffer.alloc(0), { run: () => ({ status: 1, stderr: 'fixture extraction failed' }) }), /extract failed/);
  assert.throws(() => gateway.extractProxyCandidate(stage(), 'archive', Buffer.alloc(0), { run: () => ({ status: 0 }) }), /not found/);
  const staged = await gateway.stageLatestProxy({ download: async () => Buffer.alloc(0), extract: (directory) => {
    const file = path.join(directory, path.basename(PROXY_BIN)); fs.writeFileSync(file, 'fake'); return file;
  }, versions: () => ({ proxyChanged: false }) });
  assert.equal(staged.proxyChanged, false);
  fs.rmSync(staged.stage, { recursive: true });
  await assert.rejects(gateway.stageLatestProxy({ download: async () => Buffer.alloc(0), extract: () => { throw new Error('fixture extract refusal'); } }), /fixture extract refusal/);
  assert.equal(fs.readdirSync(BIN_DIR).some((name) => name.startsWith('stage-')), false);
});

test('candidate version parsing preserves existing replacement decisions without guessing native capability', () => {
  assert.deepEqual(gateway.binarySemver('fixture', { run: () => ({ stdout: 'proxy 1.2.3' }) }), [1, 2, 3]);
  assert.equal(gateway.binarySemver('fixture', { run: () => ({}) }), null);
  assert.ok(gateway.binarySemver(process.execPath), 'the container Node executable is a harmless version-only stand-in');
  assert.equal(gateway.candidateVersions('candidate', { version: () => [1, 2, 3] }).proxyChanged, false);
  assert.equal(gateway.candidateVersions('candidate', { version: () => null }).proxyChanged, true);
  assert.equal(gateway.candidateVersions('candidate', { version: (binary) => binary === 'candidate' ? [2, 0, 0] : [1, 0, 0] }).proxyChanged, true);
});

test('candidate activation probes before replacement and every restart, including unchanged version', async () => {
  const calls = [];
  const candidate = { stagedProxy: 'staged-fixture', proxyChanged: false };
  const options = { install: () => calls.push('install'), restartProxy: async () => { calls.push('proxy'); return false; },
    restartShim: async () => { calls.push('shim'); return null; }, run: () => { calls.push('probe'); return candidateReport(); } };
  const selection = { provider: 'antigravity', explicit: true };
  await gateway.activateSetupCandidate(candidate, true, selection, options);
  assert.deepEqual(calls, ['probe', 'install', 'proxy', 'shim']);
  calls.length = 0;
  await assert.rejects(gateway.activateSetupCandidate(candidate, true, selection, { ...options, run: () => ({ status: 1 }) }), /incompatible/);
  assert.deepEqual(calls, []);
  await gateway.activateSetupCandidate(candidate, false, selection, { ...options, run: () => { throw new Error('must skip'); } });
  assert.deepEqual(calls, ['install', 'proxy', 'shim']);
});

test('installation updates guidance only explicitly and uses the existing atomic binary replacement', () => {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(PROXY_BIN, 'old fixture');
  const stagedProxy = path.join(stage(), path.basename(PROXY_BIN)); fs.writeFileSync(stagedProxy, 'new fixture');
  gateway.installSetupCandidate({ proxyChanged: true, stagedProxy, currentVersion: [1, 0, 0] }, { provider: 'antigravity', explicit: true });
  assert.equal(fs.readFileSync(PROXY_BIN, 'utf8'), 'new fixture');
  assert.equal(readOnboarding(), 'antigravity');
  gateway.installSetupCandidate({ proxyChanged: false }, { provider: 'codex', explicit: false });
  assert.equal(readOnboarding(), 'antigravity');
  fs.rmSync(ONBOARDING_PATH);
});

test('setup restart orchestration retains handoff, unchanged, failed and still-starting semantics', async () => {
  const logs = [];
  const candidate = { proxyChanged: true, currentVersion: [1, 0, 0], stagedVersion: [2, 0, 0] };
  assert.equal(await gateway.restartSetupProxy({ proxyChanged: false }, { restart: () => { throw new Error('not called'); } }), false);
  assert.equal(await gateway.restartSetupProxy(candidate, { restart: async () => true, report: (line) => logs.push(line) }), true);
  assert.equal(await gateway.restartSetupProxy(candidate, { restart: async () => false, report: (line) => logs.push(line) }), false);
  assert.match(logs[0], /1.0.0/);
  assert.equal(await gateway.restartSetupShim(true), null);
  assert.equal(await gateway.restartSetupShim(false, { supervisor: async () => null, worker: async () => ({ ok: true }) }), null);
  const starting = { ok: false, stillStarting: true };
  assert.equal(await gateway.restartSetupShim(false, { supervisor: async () => starting }), starting);
  await assert.rejects(gateway.restartSetupShim(false, { supervisor: async () => ({ ok: false, reason: 'fixture' }) }), /supervisor.*fixture/);
  await assert.rejects(gateway.restartSetupShim(false, { supervisor: async () => null, worker: async () => ({ ok: false, reason: 'fixture' }) }), /worker.*fixture/);
});

test('startup after install reports bounded starts without claiming that still-starting is ready', async () => {
  const activation = { handoff: true, supervisorRestart: null };
  assert.equal(await gateway.startAfterSetup(activation, { start: async (options) => { assert.equal(options.preserveRunningSupervisor, true); return { ok: true }; } }), true);
  assert.equal(await gateway.startAfterSetup({ supervisorRestart: { stillStarting: true, reason: 'fixture waiting' } }, { reportInstalled: noop }), false);
  assert.equal(await gateway.startAfterSetup(activation, { reportInstalled: noop, start: async () => ({ stillStarting: true, reason: 'fixture waiting' }) }), false);
  await assert.rejects(gateway.startAfterSetup(activation, { reportInstalled: noop, start: async () => ({ ok: false, reason: 'fixture failure' }) }), /fixture failure/);
});

test('AGY setup readiness never demands Codex auth and ordinary Codex recovery remains separate', async () => {
  for (const ready of [true, false]) {
    assert.equal(await gateway.setupProviderReady('antigravity', { auth: () => { throw new Error('must not ask Codex'); },
      readiness: async () => ({ ready, message: 'Antigravity local only' }), report: noop }), ready);
    assert.equal(await gateway.setupProviderReady('codex', { auth: () => ready, report: noop }), ready);
  }
});

test('provider setup wiring preserves update mode and existing project scope without implicit enablement', async () => {
  const calls = [];
  const options = { providerReady: async (provider) => { calls.push(provider); return true; }, refreshPins: async () => calls.push('pins'),
    intended: async () => ({ mode: 'default' }), alreadyWired: () => false, write: () => calls.push('write'),
    catalog: async () => { calls.push('catalog'); throw new Error('advisory'); }, status: async () => calls.push('status'), preserve: async () => calls.push('preserve') };
  await gateway.finishSetupWiring({ provider: 'antigravity', preserveWiring: false }, options);
  assert.deepEqual(calls, ['antigravity', 'pins', 'write', 'catalog', 'status']);
  calls.length = 0;
  await gateway.finishSetupWiring({ provider: 'antigravity', preserveWiring: true }, options);
  assert.deepEqual(calls, ['antigravity', 'pins', 'preserve']);
  calls.length = 0;
  await gateway.finishSetupWiring({ provider: 'antigravity' }, { ...options, alreadyWired: () => true, refreshExisting: () => calls.push('existing') });
  assert.deepEqual(calls, ['antigravity', 'pins', 'existing', 'status']);
  calls.length = 0;
  await gateway.finishSetupWiring({ provider: 'antigravity' }, { ...options, providerReady: async () => false });
  assert.deepEqual(calls, []);
});

test('existing wiring refresh never converts shell-only wiring to settings', () => {
  const writes = [];
  for (const current of [null, { source: 'env' }]) gateway.refreshExistingSetupWiring('default', { read: () => current, write: (...args) => writes.push(args), report: noop });
  assert.equal(writes.length, 0);
  for (const mode of ['compat', 'default']) gateway.refreshExistingSetupWiring('default', { read: () => ({ scope: 'project', mode }), write: (...args) => writes.push(args), report: noop });
  assert.equal(writes.length, 2);
  assert.ok(writes.every(([scope]) => scope === 'project'));
});

test('setup cleans only its staged candidate on compatibility refusal and never starts or wires afterwards', async () => {
  const directory = stage();
  const calls = [];
  await assert.rejects(gateway.setup({ selection: { provider: 'antigravity' }, requires: async () => true,
    stage: async () => ({ stage: directory }), activate: async () => { throw new Error('refused candidate'); },
    start: async () => calls.push('start'), finish: async () => calls.push('wire') }), /refused candidate/);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(calls, []);
});
