'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CACHE_MAX_AGE_MS, readCache } = require('../hooks/marketplace-freshness-cache.js');
const { loadedVersionStateFile, reportLoadedPluginVersion } = require('../hooks/freshness-helpers.js');
const { decide: decideUserPrompt } = require('../hooks/user-prompt-freshness.js');
const { decide } = require('../hooks/stop-update-check.js');

const NOW = 1_000_000;

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stop-update-check-'));
}

function cacheAt(timestamp, version) {
  return {
    checkedAt: new Date(timestamp).toISOString(),
    manifest: { plugins: [{ name: 'quartermaster', version }] },
  };
}

function writeRegistry(home, version = '1.0.0') {
  const registryFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: {
    'quartermaster@eigenwise-toolshed': [{ scope: 'user', version }],
  } }));
}

function writeLoadedQuartermaster(home, version) {
  const pluginRoot = path.join(home, 'loaded-quartermaster');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return pluginRoot;
}

function writeCache(home, cache) {
  const destination = path.join(home, '.claude', 'eigenwise-toolshed', 'marketplace-freshness.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(cache));
}

function input(sessionId = 'stop-update-session') {
  return { cwd: 'C:\\dev\\project', session_id: sessionId };
}

function options(home, extras = {}) {
  return {
    home,
    now: NOW,
    warningStateDirectory: path.join(home, 'warnings'),
    warnedStates: new Set(),
    ...extras,
  };
}

test('refreshes a stale cache before reporting an available update', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home);
  writeCache(home, cacheAt(NOW - CACHE_MAX_AGE_MS, '1.0.0'));
  let requests = 0;

  const output = await decide(input(), options(home, {
    requestManifest: async () => {
      requests += 1;
      return { plugins: [{ name: 'quartermaster', version: '2.0.0' }] };
    },
  }));

  assert.equal(requests, 1);
  assert.deepEqual(readCache(fs, home), cacheAt(NOW, '2.0.0'));
  assert.match(JSON.parse(output).systemMessage, /quartermaster 1\.0\.0 → 2\.0\.0/);
});

test('does not request the marketplace when the cache is current', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home);
  writeCache(home, cacheAt(NOW, '1.0.0'));
  let requests = 0;

  const output = await decide(input(), options(home, {
    requestManifest: async () => { requests += 1; throw new Error('must not request'); },
  }));

  assert.equal(output, '');
  assert.equal(requests, 0);
});

test('leaves an existing stale cache untouched when refreshing fails', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home);
  const staleCache = cacheAt(NOW - CACHE_MAX_AGE_MS, '1.0.0');
  writeCache(home, staleCache);

  const output = await decide(input(), options(home, {
    requestManifest: async () => { throw new Error('offline'); },
  }));

  assert.equal(output, '');
  assert.deepEqual(readCache(fs, home), staleCache);
});

test('reports each distinct available version once per session without blocking', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home);
  const sharedOptions = options(home);

  const first = JSON.parse(await decide(input(), { ...sharedOptions, cache: cacheAt(NOW, '2.0.0') }));
  assert.equal(first.decision, undefined);
  assert.match(first.systemMessage, /quartermaster 1\.0\.0 → 2\.0\.0/);
  assert.equal(await decide(input(), { ...sharedOptions, cache: cacheAt(NOW, '2.0.0') }), '');

  const newer = JSON.parse(await decide(input(), { ...sharedOptions, cache: cacheAt(NOW, '3.0.0') }));
  assert.equal(newer.decision, undefined);
  assert.match(newer.systemMessage, /quartermaster 1\.0\.0 → 3\.0\.0/);
});

test('reports newer installed Quartermaster versions once without blocking', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home, '2.0.0');
  const pluginRoot = writeLoadedQuartermaster(home, '1.0.0');
  const sharedOptions = options(home, {
    cache: cacheAt(NOW, '2.0.0'),
    pluginRoot,
  });

  const first = JSON.parse(await decide(input('reload-version-change'), sharedOptions));
  assert.equal(first.decision, undefined);
  assert.match(first.systemMessage, /Quartermaster 2\.0\.0 is installed, but this session loaded 1\.0\.0/);
  const promptOutput = JSON.parse(decideUserPrompt({ ...input('reload-version-change'), prompt: 'continue' }, sharedOptions));
  assert.match(promptOutput.hookSpecificOutput.additionalContext, /Quartermaster 2\.0\.0 is installed/);
  assert.equal(await decide(input('reload-version-change'), sharedOptions), '');

  writeRegistry(home, '3.0.0');
  const newer = JSON.parse(await decide(input('reload-version-change'), sharedOptions));
  assert.match(newer.systemMessage, /Quartermaster 3\.0\.0 is installed, but this session loaded 1\.0\.0/);

  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '3.0.0' }));
  assert.equal(await decide(input('loaded-version-current'), sharedOptions), '');
});

test('rewrites the Quartermaster loaded-version record before Stop checks reported reloads', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home, '0.7.6');
  const stateDirectory = path.join(home, 'loaded-plugin-versions');
  const sessionInput = input('stop-reloaded-quartermaster');
  const previousRoot = writeLoadedQuartermaster(home, '0.7.3');
  reportLoadedPluginVersion(sessionInput, 'quartermaster@eigenwise-toolshed', '0.7.3', { directory: stateDirectory, pluginRoot: previousRoot });
  const reloadedRoot = path.join(home, 'reloaded-quartermaster');
  fs.mkdirSync(path.join(reloadedRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(reloadedRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.7.6' }));

  assert.equal(await decide(sessionInput, options(home, {
    cache: cacheAt(NOW, '0.7.6'),
    loadedVersionStateDirectory: stateDirectory,
    pluginRoot: reloadedRoot,
  })), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(loadedVersionStateFile(sessionInput, 'quartermaster@eigenwise-toolshed', stateDirectory), 'utf8')), {
    pluginId: 'quartermaster@eigenwise-toolshed',
    pluginRoot: reloadedRoot,
    version: '0.7.6',
  });
});

test('reports newer installed versions reported by other Toolshed plugins', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({ plugins: {
    'sidequest@eigenwise-toolshed': [{ scope: 'user', version: '2.0.0' }],
  } }));
  const sessionInput = input('reported-reload-version-change');
  const loadedVersionStateDirectory = path.join(home, 'loaded-plugin-versions');
  const sidequestRoot = path.join(home, 'loaded-sidequest');
  fs.mkdirSync(sidequestRoot);
  reportLoadedPluginVersion(sessionInput, 'sidequest@eigenwise-toolshed', '1.0.0', { directory: loadedVersionStateDirectory, pluginRoot: sidequestRoot });
  const sharedOptions = options(home, {
    cache: { checkedAt: new Date(NOW).toISOString(), manifest: { plugins: [{ name: 'sidequest', version: '2.0.0' }] } },
    loadedVersionStateDirectory,
  });

  const first = JSON.parse(await decide(sessionInput, sharedOptions));
  assert.match(first.systemMessage, /sidequest: loaded 1\.0\.0, installed 2\.0\.0/);
  assert.equal(await decide(sessionInput, sharedOptions), '');

  fs.writeFileSync(registryFile, JSON.stringify({ plugins: {
    'sidequest@eigenwise-toolshed': [{ scope: 'user', version: '3.0.0' }],
  } }));
  const newer = JSON.parse(await decide(sessionInput, sharedOptions));
  assert.match(newer.systemMessage, /sidequest: loaded 1\.0\.0, installed 3\.0\.0/);
});

test('still lets the next user prompt report the refreshed update', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeRegistry(home);
  const sharedOptions = options(home);
  const cache = cacheAt(NOW, '2.0.0');

  assert.match(JSON.parse(await decide(input(), { ...sharedOptions, cache })).systemMessage, /2\.0\.0/);
  const promptOutput = JSON.parse(decideUserPrompt({ ...input(), prompt: 'continue' }, { ...sharedOptions, cache }));
  assert.match(promptOutput.hookSpecificOutput.additionalContext, /2\.0\.0/);
});

test('is silent for stop-hook re-entry and a freshness bypass', async (testContext) => {
  const home = tempDirectory();
  testContext.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let requests = 0;
  const requestManifest = async () => { requests += 1; return { plugins: [] }; };

  assert.equal(await decide({ ...input(), stop_hook_active: true }, options(home, { requestManifest })), '');
  assert.equal(await decide(input(), options(home, {
    environment: { EIGENWISE_TOOLSHED_FRESHNESS_BYPASS: '1' },
    requestManifest,
  })), '');
  assert.equal(requests, 0);
});
