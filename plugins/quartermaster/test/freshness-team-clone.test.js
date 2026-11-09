'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { requestManifest } = require('../hooks/marketplace-freshness-cache.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function teamClone(testContext, installedVersion = '1.0.0') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-team-'));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'clone');
  const configuration = path.join(directory, 'configuration');
  const marketplace = path.join(directory, 'marketplace');
  const manifest = { plugins: [{ name: 'quartermaster', version: '2.0.0' }] };
  writeJson(path.join(project, '.claude', 'settings.json'), {});
  writeJson(path.join(configuration, 'plugins', 'installed_plugins.json'), { plugins: {
    'quartermaster@eigenwise-toolshed': [{ scope: 'project', projectPath: project, version: installedVersion }],
  } });
  writeJson(path.join(configuration, 'plugins', 'known_marketplaces.json'), {
    'eigenwise-toolshed': { installLocation: marketplace, lastUpdated: new Date().toISOString(), autoUpdate: false },
  });
  writeJson(path.join(marketplace, '.claude-plugin', 'marketplace.json'), manifest);
  writeJson(path.join(configuration, 'eigenwise-toolshed', 'marketplace-freshness.json'), {
    checkedAt: new Date().toISOString(), manifest,
  });
  return { project, configuration, directory };
}

function runHook(name, fixture, input) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', name)], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configuration, CLAUDE_PLUGIN_ROOT: '', EIGENWISE_TOOLSHED_FRESHNESS_BYPASS: '' },
  });
}

test('a team clone uses CLAUDE_CONFIG_DIR and shows one update across all three hooks', (testContext) => {
  const fixture = teamClone(testContext);
  const input = { cwd: fixture.project, session_id: randomUUID(), prompt: 'continue' };
  const start = JSON.parse(runHook('session-start-freshness.js', fixture, input));
  assert.match(start.systemMessage, /quartermaster 1\.0\.0 → 2\.0\.0/);
  assert.doesNotMatch(start.systemMessage, /auto-update is off/);
  assert.equal(runHook('user-prompt-freshness.js', fixture, input), '');
  assert.equal(runHook('stop-update-check.js', fixture, input), '');
  assert.equal(JSON.parse(runHook('session-start-freshness.js', fixture, input)).systemMessage, undefined);
  assert.match(JSON.parse(runHook('session-start-freshness.js', fixture, { ...input, session_id: randomUUID() })).systemMessage, /update available/);
});

test('a fresh team clone advises installation without removing shared settings', (testContext) => {
  const fixture = teamClone(testContext, '2.0.0');
  fs.mkdirSync(path.join(fixture.project, '.claude', '.codebase-info'));
  writeJson(path.join(fixture.project, '.claude', 'settings.json'), { enabledPlugins: { 'codebase-mapper@eigenwise-toolshed': true } });
  const output = JSON.parse(runHook('session-start-freshness.js', fixture, { cwd: fixture.project, session_id: randomUUID() }));
  assert.match(output.systemMessage, /install codebase-mapper at project scope/);
  assert.doesNotMatch(output.systemMessage, /remove/);
  const auditScript = `const {audit}=require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'session-start-freshness.js'))});console.log(JSON.stringify(audit({currentProject:${JSON.stringify(fixture.project)},versions:{node:'22.5.0',claude:'2.1.0'},boards:[],platform:'darwin'}).instances));`;
  const instances = JSON.parse(execFileSync(process.execPath, ['-e', auditScript], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configuration }, timeout: 10_000,
  }));
  assert.equal(instances[0].version, '2.0.0');
});

test('configured proxies skip the background manifest request without sending traffic', async () => {
  const request = () => { assert.fail('proxy configuration must prevent a direct request'); };
  await assert.rejects(requestManifest(request, 100, { HTTPS_PROXY: 'http://proxy.example:8080' }), /proxy configured/);
  await assert.rejects(requestManifest(request, 100, { HTTP_PROXY: 'http://proxy.example:8080' }), /proxy configured/);
  await assert.rejects(requestManifest(request, 100, { https_proxy: 'http://proxy.example:8080' }), /proxy configured/);
  await assert.rejects(requestManifest(request, 100, { http_proxy: 'http://proxy.example:8080', NO_PROXY: '*' }), /proxy configured/);
});

test('a failed manifest fetch stays silent at the next prompt', (testContext) => {
  const fixture = teamClone(testContext);
  writeJson(path.join(fixture.configuration, 'eigenwise-toolshed', 'marketplace-freshness.json'), {
    checkedAt: new Date().toISOString(), unavailable: true,
  });
  assert.equal(runHook('user-prompt-freshness.js', fixture, { cwd: fixture.project, session_id: randomUUID(), prompt: 'continue' }), '');
});

test('the updater reads the registry from CLAUDE_CONFIG_DIR', (testContext) => {
  const fixture = teamClone(testContext);
  const script = `const {registryPath}=require(${JSON.stringify(path.join(__dirname, '..', 'bin', 'update-toolshed.js'))}); console.log(registryPath());`;
  const registry = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: fixture.configuration }, timeout: 10_000,
  }).trim();
  assert.equal(registry, path.join(fixture.configuration, 'plugins', 'installed_plugins.json'));
});
