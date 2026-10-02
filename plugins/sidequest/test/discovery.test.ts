import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

type CatalogModel = Record<string, unknown>;
interface CatalogHeader {
  schemaVersion?: number;
  schema?: number;
  source?: string;
  updatedAt?: string;
  providers?: unknown;
  codexReadiness?: unknown;
}
interface ResolvedExec {
  agent: string;
  model: string;
  runsModel?: string;
}

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-home-'));
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-empty-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = empty;
const discovery = require('../lib/discovery.js') as {
  discoverExternalModels(): Array<{ slug: string; id: string; label: string; provider: string; source: string }>;
  providerReadiness(provider: string): { provider: string; ready: boolean; state: string; message: string } | null;
  configuredExternalModelProvider(slug: string): string | null;
};
const store = require('../lib/store.js') as {
  CLAUDE_RUNTIMES: readonly string[];
  VALID_EFFORTS: readonly string[];
  resolveExec(model: string, effort: string): ResolvedExec | null;
  classifyModelFilter(model: string): string;
  modelsPayload(options: { project?: string; full?: boolean }): { discovered: Array<Record<string, unknown>> };
};

function writeCatalog(models: CatalogModel[], catalog: CatalogHeader = {
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-'));
  const dir = path.join(root, 'model-gateway');
  const catalogPath = path.join(dir, 'catalog.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...catalog, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  return catalogPath;
}

test('missing and malformed catalogs fail soft', () => {
  assert.deepEqual(discovery.discoverExternalModels(), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-bad-'));
  fs.mkdirSync(path.join(root, 'model-gateway'));
  fs.writeFileSync(path.join(root, 'model-gateway', 'catalog.json'), '{bad');
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('catalog cache re-reads a rewritten catalog', () => {
  const catalogPath = writeCatalog([{ slug: 'codex-gpt-first', id: 'claude-first', label: 'First model' }]);
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-first', id: 'claude-first', label: 'First model', provider: 'codex', source: 'model-gateway',
  }]);

  fs.writeFileSync(catalogPath, JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
    models: [{ slug: 'codex-gpt-reloaded', id: 'claude-reloaded-model', label: 'Reloaded model' }],
  }));

  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-reloaded', id: 'claude-reloaded-model', label: 'Reloaded model', provider: 'codex', source: 'model-gateway',
  }]);
});

test('fixture catalogs remain usable regardless of their recorded timestamp', () => {
  for (const updatedAt of [undefined, 'not-a-date', new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString(), new Date(Date.now() + 60 * 1000).toISOString()]) {
    writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], {
      schemaVersion: 3,
      updatedAt,
      codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
    });
    assert.deepEqual(discovery.discoverExternalModels(), [{
      slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
    }]);
    assert.equal(discovery.providerReadiness('codex')?.ready, true);
  }
});

test('discovery reads the gateway readiness contract independently of catalog models', () => {
  writeCatalog([], {
    schemaVersion: 3,
    codexReadiness: {
      ready: false,
      state: 'proxy-down',
      message: 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.',
    },
  });
  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex',
    ready: false,
    state: 'proxy-down',
    message: 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.',
  });
});

function readyCatalog(updatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 4,
    updatedAt,
    providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } },
    models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex' }],
  };
}

function unreadyCatalog(updatedAt = new Date().toISOString()) {
  return {
    ...readyCatalog(updatedAt),
    providers: { codex: { ready: false, state: 'serving-version-mismatch', message: 'old session' } },
  };
}

// A refresh is a side effect on the catalog FILE, and the real gateway also reports what it did on stdout, so a
// fake that only prints the catalog would pass while the shipped code silently gave up on that report (SQ-2208).
function seedGatewayHome(
  t: { after(fn: () => void): void },
  stored: unknown,
  refreshWrites: Record<string, unknown>,
  registryKey = 'model-gateway@eigenwise-toolshed',
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-refresh-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousClaudeHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const previousDiscoveryDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    process.env.SIDEQUEST_CLAUDE_HOME = previousClaudeHome;
    process.env.SIDEQUEST_DISCOVERY_DIRS = previousDiscoveryDirs;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SIDEQUEST_CLAUDE_HOME = path.join(home, '.claude');
  delete process.env.SIDEQUEST_DISCOVERY_DIRS;

  const catalogPath = path.join(home, '.claude', 'model-gateway', 'catalog.json');
  const installs = Object.entries(refreshWrites).map(([version, catalog]) => {
    const installPath = path.join(home, 'plugins', version);
    const command = path.join(installPath, 'bin', 'model-gateway.js');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, [
      `require('fs').writeFileSync(${JSON.stringify(catalogPath)}, ${JSON.stringify(JSON.stringify(catalog))});`,
      "process.stdout.write('catalog: preserved claude-grok-build from a subset write\\n');",
    ].join('\n'));
    return { installPath, version };
  });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { [registryKey]: installs },
  }));
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(stored));
}

test('discovery refreshes an unready Codex catalog through the newest installed gateway', (t) => {
  seedGatewayHome(t, unreadyCatalog(), { '0.48.6': unreadyCatalog(), '0.48.7': readyCatalog() });

  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex', ready: true, state: 'ready', message: 'Codex is ready.',
  });
});

test('discovery refreshes through a gateway installed from another marketplace', (t) => {
  seedGatewayHome(t, unreadyCatalog(), { '0.48.7-fork.1': readyCatalog() }, 'model-gateway@fork-toolshed');

  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex', ready: true, state: 'ready', message: 'Codex is ready.',
  });
});

test('SQ-2208: models survive a catalog that aged out of the freshness window', (t) => {
  const agedOut = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  seedGatewayHome(t, readyCatalog(agedOut), { '0.48.7': readyCatalog() });

  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
  assert.equal(discovery.configuredExternalModelProvider('codex-gpt-test'), 'codex');
});

test('SQ-2937: discovery override adds fixture roots without hiding the gateway catalog', (t) => {
  const agedOut = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  seedGatewayHome(t, readyCatalog(agedOut), { '0.48.7': readyCatalog() });
  process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-custom-root-'));

  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
  assert.equal(discovery.providerReadiness('codex')?.ready, true);
});

test('SQ-2937: a stale installed gateway catalog with no refresh command is still suppressed', (t) => {
  const agedOut = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  seedGatewayHome(t, readyCatalog(agedOut), {});

  assert.deepEqual(discovery.discoverExternalModels(), []);
  assert.equal(discovery.providerReadiness('codex'), null);
});

function seedGatewayCommand(t: { after(fn: () => void): void }, stored: unknown, script: (catalogPath: string) => string) {
  seedGatewayHome(t, stored, {});
  const claudeHome = String(process.env.SIDEQUEST_CLAUDE_HOME);
  const installPath = path.join(claudeHome, 'gateway-install');
  fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true });
  const catalogPath = path.join(claudeHome, 'model-gateway', 'catalog.json');
  fs.writeFileSync(path.join(installPath, 'bin', 'model-gateway.js'), script(catalogPath));
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'model-gateway@eigenwise-toolshed': [{ installPath, version: '0.51.7' }] },
  }));
  return catalogPath;
}

test('GH-227: a gateway refresh that declines to write puts its own reason in the dispatch refusal', (t) => {
  const agedOut = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  seedGatewayCommand(t, readyCatalog(agedOut), () => [
    "process.stderr.write('model-gateway: catalog refresh did not write (shim /healthz on 127.0.0.1:18764 returned 503); kept the stored catalog\\n');",
    'process.exit(1);',
  ].join('\n'));
  const dispatchRouteRefusal = (store as unknown as { dispatchRouteRefusal(route: { model: string; effort: string }): string | null }).dispatchRouteRefusal;

  const refusal = dispatchRouteRefusal({ model: 'codex-gpt-test', effort: 'high' });

  assert.match(String(refusal), /^Codex dispatch refused: model-gateway readiness is unavailable\./);
  assert.match(String(refusal), /Last gateway catalog refresh: model-gateway: catalog refresh did not write \(shim \/healthz on 127\.0\.0\.1:18764 returned 503\)/);
});

test('GH-175: a refreshed catalog that is still unready is asked again after 30 s, not held for the catalog window', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  const catalogPath = seedGatewayCommand(t, unreadyCatalog(), (writtenPath) => [
    "const fs = require('fs');",
    `const catalogPath = ${JSON.stringify(writtenPath)};`,
    "const recovered = fs.existsSync(catalogPath + '.recovered');",
    `const ready = ${JSON.stringify(readyCatalog())};`,
    `const unready = ${JSON.stringify(unreadyCatalog())};`,
    "fs.writeFileSync(catalogPath, JSON.stringify({ ...(recovered ? ready : unready), updatedAt: new Date().toISOString() }));",
  ].join('\n'));

  assert.equal(discovery.providerReadiness('codex')?.ready, false, 'the refresh right after the failure still reports it');
  fs.writeFileSync(`${catalogPath}.recovered`, '');
  t.mock.timers.tick(20 * 1000);
  assert.equal(discovery.providerReadiness('codex')?.ready, false, 'inside the 30 s retry window the refusal holds');
  t.mock.timers.tick(15 * 1000);
  assert.equal(discovery.providerReadiness('codex')?.ready, true, 'the next refresh after the window clears it');
});

test('GH-263/GH-361: a discovered provider the gateway shim does not serve runs its own id from a pinned definition, not the Agent model', () => {
  writeCatalog([
    { slug: 'oc-flash', id: 'claude-opencode-flash', label: 'Flash', provider: 'opencode' },
    { slug: 'grok-build', id: 'claude-grok-build', label: 'Grok Build', provider: 'grok' },
    { slug: 'relay-opus', id: 'claude-relay-opus-5', label: 'Relay Opus', provider: 'claude' },
  ], {
    schemaVersion: 4,
    source: 'model-gateway',
    providers: {
      opencode: { ready: true, state: 'ready', message: 'ready' },
      grok: { ready: true, state: 'ready', message: 'ready' },
      claude: { ready: true, state: 'ready', message: 'ready' },
    },
  });
  const resolveExec = store.resolveExec as (model: string, effort: string) => (Omit<ResolvedExec, 'model'> & { model: string | null; readOnlyAgent?: string; backend: string; apiModel: string; dispatchModel?: string }) | null;

  const direct = resolveExec('oc-flash', 'high');
  assert.equal(direct?.backend, 'opencode');
  assert.equal(direct?.model, null, 'the Agent model enum refuses a full id, so the spawn carries none');
  assert.equal(direct?.apiModel, 'claude-opencode-flash');
  assert.equal(direct?.agent, 'sidequest-exec-model-oc-flash-high');
  assert.equal(direct?.readOnlyAgent, 'sidequest-exec-readonly-model-oc-flash-high');
  assert.equal(direct?.dispatchModel, undefined);
  assert.equal(resolveExec('grok-build', 'high')?.backend, 'codex', 'the shim still serves grok through the marker');
  const relay = resolveExec('relay-opus', 'high');
  assert.equal(relay?.model, null, 'a catalog entry calling itself claude is still not one of the four aliases');
  assert.equal(relay?.agent, 'sidequest-exec-model-relay-opus-high');
  assert.equal(resolveExec('opus', 'high')?.model, 'opus', 'the Claude runtimes keep their alias');
});

test('discovery validates concrete catalog identity and drops routing hints', () => {
  writeCatalog([
    { slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', suggestedTier: 'ignored' },
    { slug: 'Bad Slug', id: 'bad' },
    { slug: 'missing-id' },
  ]);
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
});

test('discovery accepts catalog v2 migration input', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], {
    schema: 2,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
  });
  assert.deepEqual(discovery.discoverExternalModels(), [{
    slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex', source: 'model-gateway',
  }]);
});

test('discovery reads schema-4 providers and model providers', () => {
  writeCatalog([{ slug: 'grok-test', id: 'claude-grok-test', label: 'Grok Test', provider: 'grok' }], {
    schemaVersion: 4,
    providers: {
      grok: { ready: false, state: 'credentials-missing', message: 'Sign in to Grok CLI, then retry.' },
      codex: { ready: true, state: 'ready', message: 'Codex is ready.' },
    },
  });
  assert.deepEqual(discovery.discoverExternalModels(), []);
  assert.deepEqual(discovery.providerReadiness('grok'), {
    provider: 'grok', ready: false, state: 'credentials-missing', message: 'Sign in to Grok CLI, then retry.',
  });
  assert.equal(discovery.providerReadiness('gemini'), null);
});

test('SQ-3183: discovery carries every row context window and billing note into the models payload', () => {
  const codexNote = 'OpenAI bills input above 272k tokens at 2x; the cap keeps every request, including compaction, under it';
  writeCatalog([
    { slug: 'codex-gpt-capped', id: 'claude-gpt-capped[1m]', label: 'Capped', provider: 'codex', contextWindow: 272000, contextWindowNote: codexNote },
    { slug: 'grok-full', id: 'claude-grok-full[1m]', label: '  ', provider: 'grok', contextWindow: 500000, contextWindowNote: ' ' },
    { slug: 'codex-gpt-fraction', id: 'claude-gpt-fraction', label: 'Fraction', provider: 'codex', contextWindow: 1.5 },
    { slug: 'codex-gpt-text', id: 'claude-gpt-text', label: 'Text', provider: 'codex', contextWindow: '272000' },
    { slug: 'codex-gpt-upper', id: 'claude-gpt-upper', label: 'Upper', provider: 'Codex' },
  ], {
    schemaVersion: 4,
    source: 'model-gateway',
    providers: {
      codex: { ready: true, state: 'ready', message: 'Codex is ready.' },
      grok: { ready: true, state: 'ready', message: 'Grok is ready.' },
    },
  });
  const expected = [
    { slug: 'codex-gpt-capped', id: 'claude-gpt-capped[1m]', label: 'Capped', provider: 'codex', source: 'model-gateway', contextWindow: 272000, contextWindowNote: codexNote },
    { slug: 'grok-full', id: 'claude-grok-full[1m]', label: 'grok-full', provider: 'grok', source: 'model-gateway', contextWindow: 500000 },
    { slug: 'codex-gpt-fraction', id: 'claude-gpt-fraction', label: 'Fraction', provider: 'codex', source: 'model-gateway' },
    { slug: 'codex-gpt-text', id: 'claude-gpt-text', label: 'Text', provider: 'codex', source: 'model-gateway' },
  ];
  assert.deepEqual(discovery.discoverExternalModels(), expected);
  const payloadRows = store.modelsPayload({}).discovered.filter((row) => row.source === 'model-gateway');
  assert.deepEqual(payloadRows, expected);
});

test('discovery ignores future catalog schemas', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], { schemaVersion: 5 });
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('Claude runtimes resolve to their stable executor at every stamped effort', () => {
  for (const model of store.CLAUDE_RUNTIMES) {
    for (const effort of store.VALID_EFFORTS) {
      const resolved = store.resolveExec(model, effort) as ResolvedExec;
      assert.equal(resolved.agent, `sidequest-exec-${effort}`);
      assert.equal(resolved.model, model);
    }
  }
});

test('concrete discovered route resolves while an absent route is unavailable', () => {
  writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }]);
  assert.equal(store.resolveExec('codex-gpt-test', 'high')!.runsModel, 'codex-gpt-test');
  assert.equal(store.resolveExec('missing-model', 'high'), null);
  assert.equal(store.classifyModelFilter('missing-model'), 'unknown');
});
