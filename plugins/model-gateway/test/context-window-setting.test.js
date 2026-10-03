'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcessSync, startGateway } = require('./support.js');

delete process.env.CODEX_GATEWAY_CONTEXT_WINDOW;
delete process.env.CODEX_GATEWAY_COMPACT_TRIGGER;
const inProcessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-context-setting-'));
process.env.HOME = inProcessHome;
process.env.USERPROFILE = inProcessHome;
test.after(() => fs.rmSync(inProcessHome, { recursive: true, force: true }));

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const runtime = require('../lib/runtime.js');
const { effectiveSentryPolicy } = require('../lib/request-worker.js');
const { contextWindowReport, contextWindowUpdate, savedContextWindows, syncClaudeContextWindow } = require('../lib/context-window.js');
const { buildCatalog } = require('../lib/commands.js');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

test('a 272000 Codex cap compacts past 187000 so the compaction turn stays at or under the cap', () => {
  const policy = runtime.resolveGatewayModelPolicy('claude-gpt-5.6-sol[1m]');
  const sentry = effectiveSentryPolicy(policy, Number.NaN, 272000);
  assert.deepEqual(sentry, { backendWindow: 920012, compactTrigger: 187000, source: 'cap' });
  // Turn k passes the trigger by one turn of growth, the compaction turn adds another turn and the prompt.
  const largestCompactionTurn = sentry.compactTrigger + 2 * runtime.CODEX_COMPACT_HEADROOM + 5000;
  assert.equal(largestCompactionTurn, 272000);
  assert.equal(effectiveSentryPolicy(policy, 150000, 272000).source, 'env');
  assert.equal(effectiveSentryPolicy(runtime.resolveGatewayModelPolicy('claude-opus-5-5[1m]'), Number.NaN, 272000), null);
});

test('the default caps Codex at 272000 and leaves Claude and Grok full', () => {
  assert.deepEqual(runtime.readContextWindowSettings({ file: path.join(inProcessHome, 'absent.json'), env: {} }), {
    claude: { value: 'full', source: 'default' },
    codex: { value: 272000, source: 'default' },
    grok: { value: 'full', source: 'default' },
  });
  assert.equal(runtime.gatewayAdvertisedWindow('claude-gpt-5.6-sol[1m]'), 272000);
  assert.equal(runtime.gatewayClientModelId('gpt-5.6-sol'), 'claude-gpt-5.6-sol[1m]');
  assert.equal(runtime.gatewayAdvertisedWindow('claude-grok-4.5[1m]'), 500000);
  assert.equal(runtime.gatewayAdvertisedWindow('claude-opus-5-5[1m]'), null);
});

test('a saved value beats CODEX_GATEWAY_CONTEXT_WINDOW, which beats the default, and invalid values fall through', (t) => {
  const file = path.join(temporaryDirectory(t, 'model-gateway-context-file-'), 'context-window.json');
  const env = { CODEX_GATEWAY_CONTEXT_WINDOW: '250000' };
  assert.deepEqual(runtime.readContextWindowSettings({ file, env }).codex, { value: 250000, source: 'CODEX_GATEWAY_CONTEXT_WINDOW' });
  runtime.writeContextWindowSettings({ codex: 'full', claude: 50000, grok: 400000 }, file);
  assert.deepEqual(runtime.readContextWindowSettings({ file, env }), {
    claude: { value: 'full', source: 'default' },
    codex: { value: 'full', source: 'saved' },
    grok: { value: 400000, source: 'saved' },
  });
  fs.writeFileSync(file, 'not json');
  assert.equal(runtime.readContextWindowSettings({ file, env: {} }).codex.source, 'default');
});

test('context-window updates validate the backend and the token range', () => {
  assert.deepEqual(contextWindowUpdate('--codex', '272000'), { backend: 'codex', field: 'window', value: 272000 });
  assert.deepEqual(contextWindowUpdate('--claude', 'full'), { backend: 'claude', field: 'window', value: 'full' });
  assert.match(contextWindowUpdate('--codex', '184999').error, /from 185000 to 1000000/);
  assert.match(contextWindowUpdate('--claude', '99999').error, /from 100000 to 1000000/);
  assert.match(contextWindowUpdate('codex', '272000').error, /expects --claude, --codex, or --grok/);
  assert.match(contextWindowUpdate('--haiku', 'full').error, /expects --claude, --codex, or --grok/);
  assert.deepEqual(savedContextWindows({
    claude: { value: 'full', source: 'default' },
    codex: { value: 300000, source: 'saved' },
    grok: { value: 'full', source: 'saved' },
  }), { codex: 300000, grok: 'full' });
});

test('the report labels the Codex cap with the 2x rule and names a session-wide autoCompactWindow', () => {
  const windows = {
    claude: { value: 'full', source: 'default' },
    codex: { value: 272000, source: 'default' },
    grok: { value: 400000, source: 'saved' },
  };
  assert.deepEqual(contextWindowReport(windows, { window: 325000, source: 'settings user' }), [
    'claude: full (1M through the [1m] alias pins) [default]; autoCompactWindow 325000 from settings user caps this session; native window 325000; exact compaction trigger unverified (native engine headroom applies)',
    'codex: 272000 cap [default]; compacts past 187000; OpenAI bills input above 272k tokens at 2x; the cap keeps every request, including compaction, under it',
    'grok: 400000 cap [saved]; compacts past 315000',
  ]);
  const [claude, codex, grok] = contextWindowReport({
    claude: { value: 500000, source: 'saved' },
    codex: { value: 'full', source: 'saved' },
    grok: { value: 'full', source: 'default' },
  }, null);
  assert.equal(claude, 'claude: 500000 (autoCompactWindow in project-wired settings) [saved]; native window 500000; exact compaction trigger unverified (native engine headroom applies)');
  assert.equal(codex, "codex: full (each model's backend window, compacting 40000 below it) [saved]; OpenAI bills input above 272k tokens at 2x; requests past 272k pay double");
  assert.equal(grok, "grok: full (each model's backend window, compacting 40000 below it) [default]");
});

test('a Claude cap replaces only the autoCompactWindow the gateway wrote', (t) => {
  const directory = temporaryDirectory(t, 'model-gateway-claude-cap-');
  const owned = path.join(directory, 'owned.json');
  const user = path.join(directory, 'user.json');
  const unset = path.join(directory, 'unset.json');
  const broken = path.join(directory, 'broken.json');
  fs.writeFileSync(owned, JSON.stringify({ env: { A: '1' }, autoCompactWindow: 400000 }));
  fs.writeFileSync(user, JSON.stringify({ autoCompactWindow: 325000 }));
  fs.writeFileSync(broken, '{');

  const capped = syncClaudeContextWindow([owned, user, unset, broken], { owned: 400000, next: 500000 });
  assert.deepEqual(capped.changed.map((entry) => entry.file), [owned, unset]);
  assert.deepEqual(capped.skipped.map((entry) => [entry.file, /not gateway-owned|Could not read/.test(entry.reason)]), [[user, true], [broken, true]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(owned, 'utf8')), { env: { A: '1' }, autoCompactWindow: 500000 });
  assert.equal(JSON.parse(fs.readFileSync(user, 'utf8')).autoCompactWindow, 325000);

  assert.deepEqual(syncClaudeContextWindow([owned], { owned: 500000, next: 500000 }).changed, []);
  const full = syncClaudeContextWindow([owned, unset], { owned: 500000, next: 'full' });
  assert.equal(full.changed.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(owned, 'utf8')), { env: { A: '1' } });
  assert.deepEqual(syncClaudeContextWindow([owned], { owned: null, next: 'full' }).changed, []);
});

test('the catalog carries each discovered row\'s window and the Codex billing note', () => {
  const rows = buildCatalog(['claude-gpt-5.6-sol[1m]', 'claude-grok-4.5[1m]']).models;
  assert.deepEqual(rows.map(({ id, contextWindow, contextWindowNote }) => ({ id, contextWindow, contextWindowNote })), [
    {
      id: 'claude-gpt-5.6-sol[1m]',
      contextWindow: 272000,
      contextWindowNote: 'compacts past 187000; OpenAI bills input above 272k tokens at 2x; the cap keeps every request, including compaction, under it',
    },
    { id: 'claude-grok-4.5[1m]', contextWindow: 500000, contextWindowNote: undefined },
  ]);
});

test('context-window writes a Claude cap into project-wired settings and refuses without one', (t) => {
  const home = temporaryDirectory(t, 'model-gateway-context-home-');
  const project = temporaryDirectory(t, 'model-gateway-context-project-');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const isolatedOverrides = { CODEX_GATEWAY_PORT: '18764', CODEX_GATEWAY_WORKER_PORT: '18764', CODEX_GATEWAY_PROXY_PORT: '18765' };
  const run = (...args) => spawnGatewayProcessSync(process.execPath, [CLI, ...args], { cwd: project, env, isolatedOverrides, encoding: 'utf8' });

  const refused = run('context-window', '--claude', '500000');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /no project is wired to the gateway at project scope/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'context-window.json')), false);

  assert.equal(run('env', '--write-project').status, 0);
  const settingsFile = path.join(project, '.claude', 'settings.local.json');
  const saved = run('context-window', '--claude', '500000', '--codex', '300000');
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /updated autoCompactWindow in /);
  assert.match(saved.stdout, /context window codex: 300000 cap \[saved\]; compacts past 215000; OpenAI bills input above 272k tokens at 2x; requests past 272k pay double/);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoCompactWindow, 500000);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'context-window.json'), 'utf8')), { claude: 500000, codex: 300000 });

  const shown = run('context-window');
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /context window claude: 500000 \(autoCompactWindow in project-wired settings\) \[saved\]; native window 500000; exact compaction trigger unverified \(native engine headroom applies\)/);

  const laterProject = temporaryDirectory(t, 'model-gateway-context-later-');
  const runLater = (...args) => spawnGatewayProcessSync(process.execPath, [CLI, ...args], { cwd: laterProject, env, isolatedOverrides, encoding: 'utf8' });
  const laterFile = path.join(laterProject, '.claude', 'settings.local.json');
  assert.equal(runLater('env', '--write-project').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(laterFile, 'utf8')).autoCompactWindow, undefined);
  // The next registered-project refresh, which SessionStart also runs, applies the saved cap to the project wired later.
  const refreshed = runLater('env', '--write-project');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /updated autoCompactWindow in /);
  assert.equal(JSON.parse(fs.readFileSync(laterFile, 'utf8')).autoCompactWindow, 500000);

  const reset = run('context-window', '--claude', 'full');
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoCompactWindow, undefined);
  assert.equal(JSON.parse(fs.readFileSync(laterFile, 'utf8')).autoCompactWindow, undefined);
});

test('a saved Codex cap reaches the shim\'s advertised max_input_tokens without renaming picker ids', async (t) => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }] }));
  });
  const proxyPort = await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  t.after(() => proxy.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-context-shim-'));
  runtime.writeContextWindowSettings({ codex: 300000 }, path.join(home, '.claude', 'model-gateway', 'context-window.json'));
  const { port } = await startGateway(t, 'serve-shim', {
    HOME: home,
    USERPROFILE: home,
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
  });
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    }).on('error', reject);
  });
  assert.deepEqual(body.data.filter(({ id }) => id.startsWith('claude-gpt-')).map(({ id, max_input_tokens }) => ({ id, max_input_tokens })), [
    { id: 'claude-gpt-5.6-sol[1m]', max_input_tokens: 300000 },
    { id: 'claude-gpt-6-astra[1m]', max_input_tokens: 300000 },
  ]);
});

test('explicit context-window compact-at wins over legacy env without subtracting the reserve', () => {
  const policy = runtime.resolveGatewayModelPolicy('claude-gpt-6.1-sol[1m]');
  assert.equal(runtime.gatewayCompactTrigger(272000, 242000), 242000);
  assert.equal(runtime.gatewayCompactTrigger(272000, null), 187000);
  assert.equal(runtime.gatewayCompactTrigger(null, null), null);
  assert.deepEqual(effectiveSentryPolicy(policy, 320000, 272000, 242000), { backendWindow: 920012, compactTrigger: 242000, source: 'compact-at' });
  assert.deepEqual(effectiveSentryPolicy(policy, 320000, 272000, null), { backendWindow: 920012, compactTrigger: 187000, source: 'cap' });
  assert.deepEqual(effectiveSentryPolicy(policy, 1, 272000, 300000), { backendWindow: 920012, compactTrigger: 272000, source: 'compact-at' });
  assert.deepEqual(effectiveSentryPolicy(policy, 320000, null, 900000), { backendWindow: 920012, compactTrigger: 880012, source: 'derived' });
  assert.deepEqual(effectiveSentryPolicy(runtime.resolveGatewayModelPolicy('claude-grok-4.5[1m]'), 1, null, 900000), { backendWindow: 500000, compactTrigger: 460000, source: 'derived' });
});

test('context-window compact-at validates positive whole counts and rejects unsupported Claude fields', (t) => {
  assert.deepEqual(contextWindowUpdate('--codex-compact-at', '242000'), { backend: 'codex', field: 'compactAt', value: 242000 });
  assert.deepEqual(contextWindowUpdate('--grok-compact-at', '1'), { backend: 'grok', field: 'compactAt', value: 1 });
  assert.deepEqual(contextWindowUpdate('--codex-compact-at', 'cap'), { backend: 'codex', field: 'compactAt', value: null });
  assert.match(contextWindowUpdate('--claude-compact-at', '242000').error, /unsupported compactAt.claude/);
  assert.match(contextWindowUpdate('--codex-compact-at', '0').error, /positive whole token count/);
  assert.match(contextWindowUpdate('--codex-compact-at', '-1').error, /positive whole token count/);
  assert.match(contextWindowUpdate('--codex-compact-at', '1.5').error, /positive whole token count/);
  assert.match(contextWindowUpdate('--codex-compact-at', 'Infinity').error, /positive whole token count/);
  assert.match(contextWindowUpdate('--codex-compact-at', 'NaN').error, /positive whole token count/);
  assert.match(contextWindowUpdate('--codex-compact-at', undefined).error, /positive whole token count/);
  assert.equal(runtime.parseCompactAtValue(true), null);
  const file = path.join(temporaryDirectory(t, 'model-gateway-invalid-compact-at-'), 'nested', 'context-window.json');
  assert.throws(() => runtime.writeContextWindowSettings({ compactAt: { claude: 242000 } }, file), /unsupported compactAt.claude/);
  assert.throws(() => runtime.writeContextWindowSettings({ compactAt: { codex: 0 } }, file), /invalid compactAt.codex/);
  assert.throws(() => runtime.writeContextWindowSettings({ compactAt: { codex: '242000' } }, file), /invalid compactAt.codex/);
  assert.throws(() => runtime.writeContextWindowSettings({ compactAt: { codex: null } }, file), /invalid compactAt.codex/);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});

test('context-window preserves saved compact-at across cap updates and removal restores legacy policy', (t) => {
  const home = temporaryDirectory(t, 'model-gateway-explicit-context-home-');
  const project = temporaryDirectory(t, 'model-gateway-explicit-context-project-');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const isolatedOverrides = { CODEX_GATEWAY_COMPACT_TRIGGER: '320000' };
  const run = (...arguments_) => spawnGatewayProcessSync(process.execPath, [CLI, ...arguments_], { cwd: project, env, isolatedOverrides, encoding: 'utf8', timeout: 15000 });
  const file = path.join(home, '.claude', 'model-gateway', 'context-window.json');
  const saved = run('context-window', '--codex-compact-at', '242000', '--grok-compact-at', '900000');
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /codex: 272000 cap \[default\]; requested compact-at 242000; backend window 920000; effective maximum 242000 \(compact-at\)/);
  assert.match(saved.stdout, /grok: full.*requested compact-at 900000; backend window 500000; effective maximum 460000 \(derived\)/);
  assert.match(saved.stdout, /CODEX_GATEWAY_COMPACT_TRIGGER=320000 ignored: compact-at is saved/);
  assert.match(saved.stdout, /crossing turn and compaction request can still exceed 272k and pay double/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { compactAt: { codex: 242000, grok: 900000 } });
  assert.deepEqual(runtime.readContextWindowSettings({ file, env: {} }).codex, { value: 272000, source: 'default', compactAt: 242000 });
  const updated = run('context-window', '--codex', '300000');
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codex: 300000, compactAt: { codex: 242000, grok: 900000 } });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(run('context-window', '--codex', '400000', '--grok-compact-at', '1.5').status, 2);
  assert.equal(run('context-window', '--claude-compact-at', '242000').status, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const removed = run('context-window', '--codex-compact-at', 'cap');
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /codex: 300000 cap \[saved\]; compacts past 215000/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codex: 300000, compactAt: { grok: 900000 } });
  assert.equal(run('context-window', '--grok-compact-at', 'cap').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codex: 300000 });
});

test('startup context-window compact-at reaches the real catalog and sentry with honest effective limits', (t) => {
  const home = temporaryDirectory(t, 'model-gateway-explicit-catalog-');
  const file = path.join(home, '.claude', 'model-gateway', 'context-window.json');
  runtime.writeContextWindowSettings({ codex: 272000, compactAt: { codex: 242000, grok: 900000 } }, file);
  const script = `
    const runtime = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'runtime.js'))});
    const worker = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'request-worker.js'))});
    const commands = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'commands.js'))});
    process.stdout.write(JSON.stringify({
      trigger: runtime.contextWindowCompactAt('codex'),
      sentry: worker.effectiveSentryPolicy(runtime.resolveGatewayModelPolicy('claude-gpt-6.1-sol[1m]')),
      catalog: commands.buildCatalog(['claude-gpt-6.1-sol[1m]', 'claude-grok-4.5[1m]']).models,
      environment: process.env.CODEX_GATEWAY_COMPACT_TRIGGER,
    }));
  `;
  const child = spawnGatewayProcessSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home }, isolatedOverrides: { CODEX_GATEWAY_COMPACT_TRIGGER: '320000' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.trigger, 242000);
  assert.deepEqual(result.sentry, { backendWindow: 920012, compactTrigger: 242000, source: 'compact-at' });
  assert.equal(result.environment, '320000');
  assert.equal(result.catalog[0].contextWindow, 272000);
  assert.match(result.catalog[0].contextWindowNote, /requested compact-at 242000; backend window 920012; effective maximum 242000 \(compact-at\)/);
  assert.match(result.catalog[0].contextWindowNote, /320000 ignored/);
  assert.match(result.catalog[0].contextWindowNote, /can still exceed 272k/);
  assert.match(result.catalog[1].contextWindowNote, /effective maximum 460000 \(derived\)/);
  fs.writeFileSync(file, JSON.stringify({ compactAt: { claude: 242000 } }));
  assert.throws(() => runtime.readContextWindowSettings({ file, env: {} }), /unsupported compactAt.claude/);
});
