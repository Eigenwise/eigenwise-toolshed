import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { checkSidequestInstall, installRefusalMessage } = require('../lib/dispatch-preflight.js');
const { installedSidequestVersion, sidequestDispatchFreshness } = require('../lib/plugin-freshness.js');
const agentsync = require('../lib/agentsync.js');
const { findNewerInstall } = require('../lib/server.js');
const PRIVATE_ID = 'sidequest@blackveil-sidequest-reviewed';
const OFFICIAL_ID = 'sidequest@eigenwise-toolshed';

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-private-marketplace-')));
  const claudeHome = path.join(root, 'claude');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  function install(marketplace: string, version: string, label = marketplace) {
    const installPath = path.join(claudeHome, 'plugins/cache', marketplace, 'sidequest', version);
    fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(installPath, 'hooks'));
    fs.mkdirSync(path.join(installPath, 'bin'));
    fs.writeFileSync(path.join(installPath, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sidequest', version }));
    fs.writeFileSync(path.join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { board: { command: 'node', args: ['bin/sidequest-mcp.js'] } } }));
    fs.writeFileSync(path.join(installPath, 'hooks/hooks.json'), JSON.stringify({ hooks: {} }));
    fs.writeFileSync(path.join(installPath, 'bin/sidequest.js'), `process.stdout.write(${JSON.stringify(label)});`);
    return { scope: 'local', projectPath: project, installPath, version };
  }
  const current = install('blackveil-sidequest-reviewed', '5.1.17', 'private-current');
  function registry(plugins: Record<string, unknown>) {
    fs.writeFileSync(path.join(claudeHome, 'plugins/installed_plugins.json'), JSON.stringify({ plugins }));
  }
  const options = { claudeHome, pluginRoot: current.installPath };
  return { root, project, claudeHome, current, options, install, registry };
}

function directFixture() {
  const f = fixture();
  const catalog = path.join(f.root, 'catalog');
  const source = path.join(catalog, 'plugins/sidequest');
  fs.mkdirSync(path.join(catalog, '.claude-plugin'), { recursive: true });
  fs.cpSync(f.current.installPath, source, { recursive: true });
  const catalogPath = path.join(catalog, '.claude-plugin/marketplace.json');
  fs.writeFileSync(catalogPath, JSON.stringify({ name: 'blackveil-sidequest-reviewed', plugins: [{ name: 'sidequest', source: './plugins/sidequest' }] }));
  const knownPath = path.join(f.claudeHome, 'plugins/known_marketplaces.json');
  fs.writeFileSync(knownPath, JSON.stringify({ 'blackveil-sidequest-reviewed': { source: { source: 'directory', path: catalog }, installLocation: catalog } }));
  const official = f.install('eigenwise-toolshed', '99.0.0', 'wrong-official');
  f.registry({ [OFFICIAL_ID]: [official], [PRIVATE_ID]: [f.current] });
  return { ...f, official, catalog, source, catalogPath, knownPath, options: { ...f.options, pluginRoot: source } };
}

test('registered directory-marketplace source resolves to its private installed cache', () => {
  const f = directFixture();
  const result = checkSidequestInstall(f.project, f.options);
  assert.equal(result.ok, true, result.detail || result.reason);
  assert.equal(result.pluginId, PRIVATE_ID);
  assert.equal(result.installPath, f.current.installPath);
  assert.equal(installedSidequestVersion(f.project, f.options), '5.1.17');
});

for (const invalid of ['missing-known', 'corrupt-known', 'wrong-known-root', 'missing-catalog', 'wrong-source', 'wrong-catalog-name', 'wrong-project', 'wrong-cache', 'missing-source']) {
  test(`directory-marketplace source refuses ${invalid} without official fallback`, () => {
    const f = directFixture();
    if (invalid === 'missing-known') fs.unlinkSync(f.knownPath);
    if (invalid === 'corrupt-known') fs.writeFileSync(f.knownPath, '{broken');
    if (invalid === 'wrong-known-root') fs.writeFileSync(f.knownPath, JSON.stringify({ 'blackveil-sidequest-reviewed': { source: { source: 'directory', path: f.root }, installLocation: f.root } }));
    if (invalid === 'missing-catalog') fs.unlinkSync(f.catalogPath);
    if (invalid === 'wrong-source') fs.writeFileSync(f.catalogPath, JSON.stringify({ name: 'blackveil-sidequest-reviewed', plugins: [{ name: 'sidequest', source: './plugins/other' }] }));
    if (invalid === 'wrong-catalog-name') fs.writeFileSync(f.catalogPath, JSON.stringify({ name: 'different-marketplace', plugins: [{ name: 'sidequest', source: './plugins/sidequest' }] }));
    if (invalid === 'wrong-project') f.registry({ [OFFICIAL_ID]: [f.official], [PRIVATE_ID]: [{ ...f.current, projectPath: path.join(f.root, 'other-project') }] });
    if (invalid === 'wrong-cache') f.registry({ [OFFICIAL_ID]: [f.official], [PRIVATE_ID]: [f.install('other-marketplace', '5.1.17')] });
    if (invalid === 'missing-source') fs.rmSync(f.source, { recursive: true });
    const result = checkSidequestInstall(f.project, f.options);
    assert.equal(result.ok, false);
    assert.equal(installedSidequestVersion(f.project, f.options), null);
  });
}

test('directory-marketplace registration accepts a canonical catalog alias', () => {
  const f = directFixture();
  const alias = path.join(f.root, 'catalog-alias');
  fs.symlinkSync(f.catalog, alias, 'dir');
  fs.writeFileSync(f.knownPath, JSON.stringify({ 'blackveil-sidequest-reviewed': { source: { source: 'directory', path: alias }, installLocation: f.catalog } }));
  assert.equal(checkSidequestInstall(f.project, f.options).pluginId, PRIVATE_ID);
});

test('directory-marketplace registration refuses a mismatched install location', () => {
  const f = directFixture();
  fs.writeFileSync(f.knownPath, JSON.stringify({ 'blackveil-sidequest-reviewed': { source: { source: 'directory', path: f.catalog }, installLocation: f.root } }));
  assert.equal(checkSidequestInstall(f.project, f.options).ok, false);
});

test('directory-marketplace registration refuses a plugin source symlink escaping the catalog', () => {
  const f = directFixture();
  const outside = path.join(f.root, 'outside');
  fs.renameSync(f.source, outside);
  fs.symlinkSync(outside, f.source, 'dir');
  const result = checkSidequestInstall(f.project, f.options);
  assert.equal(result.ok, false);
  assert.equal(installedSidequestVersion(f.project, f.options), null);
});

test('directory-marketplace launcher refuses a deleted source anchor instead of switching marketplaces', () => {
  const f = directFixture();
  const stub = agentsync.renderDispatchStub({
    ref: 'SQ-source-gone', title: 'Deleted source fixture', model: 'opus', effort: 'high', category: {},
    dispatch: { tokenFile: path.join(f.root, 'token'), preparedCompatibility: { servingInstall: f.source } },
  }, f.project);
  const launcher = stub.match(/FIRST action: run `node "([^"]+)"/)[1];
  fs.rmSync(f.catalog, { recursive: true });
  const result = spawnSync(process.execPath, [launcher, 'briefing', 'SQ-source-gone', '--project', f.project], {
    encoding: 'utf8', env: { ...process.env, SIDEQUEST_CLAUDE_HOME: f.claudeHome },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('directory-marketplace briefing launcher uses the private cache rather than official metadata', () => {
  const f = directFixture();
  const stub = agentsync.renderDispatchStub({
    ref: 'SQ-source-private', title: 'Direct source fixture', model: 'opus', effort: 'high', category: {},
    dispatch: { tokenFile: path.join(f.root, 'token'), preparedCompatibility: { servingInstall: f.source } },
  }, f.project);
  const launcher = stub.match(/FIRST action: run `node "([^"]+)"/)[1];
  const result = spawnSync(process.execPath, [launcher, 'briefing', 'SQ-source-private', '--project', f.project], {
    encoding: 'utf8', env: { ...process.env, SIDEQUEST_CLAUDE_HOME: f.claudeHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'private-current');
});

for (const scope of ['local', 'project', 'user']) {
  test(`private marketplace ${scope} install supplies preflight identity and freshness`, () => {
    const f = fixture();
    f.registry({ [PRIVATE_ID]: [{ ...f.current, scope }] });
    const check = checkSidequestInstall(f.project, f.options);
    assert.equal(check.ok, true, check.detail || check.reason);
    assert.equal(check.installPath, f.current.installPath);
    assert.equal(installedSidequestVersion(f.project, f.options), '5.1.17');
    assert.ok(check.identity);
  });
}

test('private serving path wins over a newer official entry regardless of registry order', () => {
  const f = fixture();
  const official = f.install('eigenwise-toolshed', '99.0.0');
  for (const entries of [ [[OFFICIAL_ID, [official]], [PRIVATE_ID, [f.current]]], [[PRIVATE_ID, [f.current]], [OFFICIAL_ID, [official]]] ]) {
    f.registry(Object.fromEntries(entries));
    assert.equal(checkSidequestInstall(f.project, f.options).installPath, f.current.installPath);
    assert.equal(installedSidequestVersion(f.project, f.options), '5.1.17');
  }
});

for (const invalid of ['wrong-project', 'missing-project', 'unknown-scope', 'unrelated-path', 'missing-private']) {
  test(`private marketplace refuses ${invalid} without using an official fallback`, () => {
    const f = fixture();
    const official = f.install('eigenwise-toolshed', '5.1.16');
    const entry: any = { ...f.current };
    if (invalid === 'wrong-project') entry.projectPath = path.join(f.root, 'other');
    if (invalid === 'missing-project') delete entry.projectPath;
    if (invalid === 'unknown-scope') entry.scope = 'unrecognized';
    if (invalid === 'unrelated-path') entry.installPath = official.installPath;
    f.registry({ [OFFICIAL_ID]: [official], [PRIVATE_ID]: invalid === 'missing-private' ? [] : [entry] });
    assert.equal(checkSidequestInstall(f.project, f.options).ok, false);
    assert.equal(installedSidequestVersion(f.project, f.options), null);
  });
}

test('private registry canonicalizes a serving-path alias and ignores malformed siblings', () => {
  const f = fixture();
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.current.installPath, alias, 'dir');
  f.registry({ [PRIVATE_ID]: [null, 'invalid', { ...f.current, installPath: alias }] });
  assert.equal(checkSidequestInstall(f.project, f.options).ok, true);
  assert.equal(installedSidequestVersion(f.project, f.options), '5.1.17');
});

test('private cache lineage reports version skew after the registry advances', () => {
  const f = fixture();
  const next = f.install('blackveil-sidequest-reviewed', '5.1.18', 'private-next');
  f.registry({ [PRIVATE_ID]: [next] });
  assert.equal(checkSidequestInstall(f.project, f.options).installPath, next.installPath);
  assert.match(sidequestDispatchFreshness(f.project, f.options).warning, /loaded 5\.1\.17, installed 5\.1\.18/);
});

test('an unregistered inline override preserves the official install fallback', () => {
  const f = fixture();
  const official = f.install('eigenwise-toolshed', '5.1.16');
  f.registry({ [OFFICIAL_ID]: [official] });
  const options = { ...f.options, pluginRoot: path.resolve(__dirname, '..') };
  assert.equal(checkSidequestInstall(f.project, options).ok, true);
  assert.equal(installedSidequestVersion(f.project, options), '5.1.16');
});

test('private briefing launcher stays in its marketplace after its old cache is removed', () => {
  const f = fixture();
  const next = f.install('blackveil-sidequest-reviewed', '5.1.18', 'private-next');
  const official = f.install('eigenwise-toolshed', '99.0.0', 'wrong-official');
  const foreign = { ...f.install('blackveil-sidequest-reviewed', '99.0.0', 'wrong-project'), projectPath: path.join(f.root, 'other') };
  f.registry({ [OFFICIAL_ID]: [official], [PRIVATE_ID]: [foreign, next, f.current] });
  const tokenFile = path.join(f.root, 'token');
  fs.writeFileSync(tokenFile, 'fixture-token');
  const stub = agentsync.renderDispatchStub({
    ref: 'SQ-private', title: 'Private fixture', model: 'opus', effort: 'high', category: {},
    dispatch: { tokenFile, preparedCompatibility: { servingInstall: f.current.installPath } },
  }, f.project);
  const launcher = stub.match(/FIRST action: run `node "([^"]+)"/)[1];
  fs.rmSync(f.current.installPath, { recursive: true });
  const result = spawnSync(process.execPath, [launcher, 'briefing', 'SQ-private', '--token-file', tokenFile, '--project', f.project], {
    encoding: 'utf8', env: { ...process.env, SIDEQUEST_CLAUDE_HOME: f.claudeHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'private-next');
});

for (const invalid of ['missing', 'malformed', 'unreadable-runtime']) {
  test(`private ${invalid} refusal names its own marketplace, not an official replacement`, () => {
    const f = fixture();
    f.registry({ [PRIVATE_ID]: [f.current] });
    const registryPath = path.join(f.claudeHome, 'plugins/installed_plugins.json');
    if (invalid === 'missing') fs.unlinkSync(registryPath);
    if (invalid === 'malformed') fs.writeFileSync(registryPath, '{broken');
    if (invalid === 'unreadable-runtime') fs.unlinkSync(path.join(f.current.installPath, '.mcp.json'));
    const result = checkSidequestInstall(f.project, f.options);
    assert.equal(result.ok, false);
    const message = installRefusalMessage(result, f.project);
    assert.ok(message.includes(PRIVATE_ID), message);
    assert.equal(message.includes(OFFICIAL_ID), false);
  });
}

test('an exact external private install is recognized but an ambiguous alias is refused', () => {
  const f = fixture();
  const external = path.join(f.root, 'external-install');
  fs.renameSync(f.current.installPath, external);
  const entry = { ...f.current, installPath: external };
  const options = { ...f.options, pluginRoot: external };
  f.registry({ [PRIVATE_ID]: [entry] });
  assert.equal(checkSidequestInstall(f.project, options).ok, true);
  f.registry({ [PRIVATE_ID]: [entry], 'sidequest@ambiguous-alias': [entry] });
  const refused = checkSidequestInstall(f.project, options);
  assert.equal(refused.ok, false);
  assert.equal(installRefusalMessage(refused, f.project).includes(OFFICIAL_ID), false);
});

for (const invalid of ['missing', 'malformed']) {
  test(`external private ${invalid} registry gets source-neutral repair guidance`, () => {
    const f = fixture();
    const external = path.join(f.root, 'external');
    fs.renameSync(f.current.installPath, external);
    f.registry({ [PRIVATE_ID]: [{ ...f.current, installPath: external }] });
    const registryPath = path.join(f.claudeHome, 'plugins/installed_plugins.json');
    if (invalid === 'missing') fs.unlinkSync(registryPath);
    else fs.writeFileSync(registryPath, '{broken');
    const result = checkSidequestInstall(f.project, { ...f.options, pluginRoot: external });
    assert.equal(result.ok, false);
    assert.equal(installRefusalMessage(result, f.project).includes(OFFICIAL_ID), false);
  });
}

test('legacy briefing packets receive a runtime-specific launcher rather than a shared mutable file', () => {
  const f = fixture();
  const stub = agentsync.renderDispatchStub({
    ref: 'SQ-legacy-private', title: 'Legacy fixture', model: 'opus', effort: 'high', category: {},
    dispatch: { tokenFile: path.join(f.root, 'token') },
  }, f.project);
  const launcher = stub.match(/FIRST action: run `node "([^"]+)"/)[1];
  assert.equal(path.basename(path.dirname(path.dirname(launcher))), 'launchers');
});

test('private local freshness does not treat a parent or child project as the same scope', () => {
  const f = fixture();
  f.registry({ [PRIVATE_ID]: [f.current] });
  assert.equal(installedSidequestVersion(path.join(f.project, 'child'), f.options), null);
  assert.equal(installedSidequestVersion(f.root, f.options), null);
});

test('shared dashboard discovery spans projects within its marketplace without a newer-loaded warning', async () => {
  const f = fixture();
  const next = { ...f.install('blackveil-sidequest-reviewed', '5.1.18'), projectPath: path.join(f.root, 'other-project') };
  f.registry({ [PRIVATE_ID]: [f.current, next] });
  const target = await findNewerInstall({ claudeHome: f.claudeHome, selfRoot: f.current.installPath, selfVersion: '5.1.17', ignoreOptOut: true });
  assert.equal(target, path.join(next.installPath, 'bin/sidequest.js'));
  const freshness = sidequestDispatchFreshness(f.project, { ...f.options, pluginRoot: next.installPath });
  assert.deepEqual(freshness, { refusal: '', warning: '' });
});

test('private dashboard discovery never switches to an official marketplace update', async () => {
  const f = fixture();
  const next = f.install('blackveil-sidequest-reviewed', '5.1.18');
  const official = f.install('eigenwise-toolshed', '99.0.0');
  f.registry({ [OFFICIAL_ID]: [official], [PRIVATE_ID]: [next] });
  const target = await findNewerInstall({ claudeHome: f.claudeHome, selfRoot: f.current.installPath, selfVersion: '5.1.17', ignoreOptOut: true });
  assert.equal(target, path.join(next.installPath, 'bin/sidequest.js'));
});
