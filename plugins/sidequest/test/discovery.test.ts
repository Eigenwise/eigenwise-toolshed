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
};
const store = require('../lib/store.js') as {
  CLAUDE_RUNTIMES: readonly string[];
  VALID_EFFORTS: readonly string[];
  resolveExec(model: string, effort: string): ResolvedExec | null;
  classifyModelFilter(model: string): string;
};

function writeCatalog(models: CatalogModel[], catalog: CatalogHeader = {
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-'));
  const dir = path.join(root, 'model-gateway');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ updatedAt: new Date().toISOString(), ...catalog, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
}

test('missing and malformed catalogs fail soft', () => {
  assert.deepEqual(discovery.discoverExternalModels(), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-bad-'));
  fs.mkdirSync(path.join(root, 'model-gateway'));
  fs.writeFileSync(path.join(root, 'model-gateway', 'catalog.json'), '{bad');
  process.env.SIDEQUEST_DISCOVERY_DIRS = root;
  assert.deepEqual(discovery.discoverExternalModels(), []);
});

test('stale, invalid, and future catalog timestamps suppress both models and readiness', () => {
  for (const updatedAt of [undefined, 'not-a-date', new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString(), new Date(Date.now() + 60 * 1000).toISOString()]) {
    writeCatalog([{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test' }], {
      schemaVersion: 3,
      updatedAt,
      codexReadiness: { ready: true, state: 'ready', message: 'Codex is ready.' },
    });
    assert.deepEqual(discovery.discoverExternalModels(), []);
    assert.equal(discovery.providerReadiness('codex'), null);
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

test('discovery refreshes an unready Codex catalog through the newest installed gateway', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-discovery-refresh-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDiscoveryDirs = process.env.SIDEQUEST_DISCOVERY_DIRS;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    process.env.SIDEQUEST_DISCOVERY_DIRS = previousDiscoveryDirs;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SIDEQUEST_DISCOVERY_DIRS;

  const readyCatalog = {
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } },
    models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex' }],
  };
  const installs = ['0.48.6', '0.48.7'].map((version) => {
    const installPath = path.join(home, 'plugins', version);
    const command = path.join(installPath, 'bin', 'model-gateway.js');
    const catalog = version === '0.48.7'
      ? readyCatalog
      : { ...readyCatalog, providers: { codex: { ready: false, state: 'serving-version-mismatch', message: 'old session' } } };
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, `process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});`);
    return { installPath, version };
  });
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'model-gateway@eigenwise-toolshed': installs },
  }));
  fs.mkdirSync(path.join(home, '.claude', 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    providers: { codex: { ready: false, state: 'serving-version-mismatch', message: 'old session' } },
    models: [{ slug: 'codex-gpt-test', id: 'claude-test', label: 'GPT Test', provider: 'codex' }],
  }));

  assert.deepEqual(discovery.providerReadiness('codex'), {
    provider: 'codex', ready: true, state: 'ready', message: 'Codex is ready.',
  });
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
