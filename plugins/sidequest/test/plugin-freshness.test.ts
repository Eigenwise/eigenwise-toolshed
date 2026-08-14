import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const {
  installedSidequestVersion,
  reportLoadedSidequestVersion,
  sidequestDispatchFreshness,
  sidequestDispatchRefusal,
  sidequestMutationFreshness,
  sidequestReloadWarning,
} = require('../lib/plugin-freshness.js');

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sidequest-plugin-freshness-'));
}

function writePluginVersion(pluginRoot: string, version: string): void {
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
}

function writeRegistry(claudeHome: string, installs: unknown[]): void {
  const registryPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: { 'sidequest@eigenwise-toolshed': installs } }));
}

test('uses the Sidequest install registered for this project', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  writePluginVersion(pluginRoot, '1.0.0');
  writeRegistry(claudeHome, [
    { scope: 'project', projectPath: path.join(directory, 'other'), version: '9.0.0' },
    { scope: 'project', projectPath: project, version: '2.0.0' },
  ]);

  assert.equal(installedSidequestVersion(project, { claudeHome }), '2.0.0');
  assert.equal(sidequestReloadWarning(project, { claudeHome, pluginRoot }), 'Sidequest: loaded 1.0.0, installed 2.0.0. Run /reload-plugins or restart Claude Code before dispatching work.');
});

test('stays silent when the registry is unavailable or versions cannot be compared', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  writePluginVersion(pluginRoot, '1.0.0');

  assert.doesNotThrow(() => assert.equal(sidequestReloadWarning(project, { claudeHome, pluginRoot }), ''));
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: 'not-semver' }]);
  assert.doesNotThrow(() => assert.equal(sidequestReloadWarning(project, { claudeHome, pluginRoot }), ''));
});

test('dispatch refuses stale or malformed installed Sidequest versions', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  writePluginVersion(pluginRoot, '1.0.0');
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: '2.0.0' }]);
  assert.match(sidequestDispatchRefusal(project, { claudeHome, pluginRoot }), /loaded 1\.0\.0, installed 2\.0\.0/);

  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: 'not-semver' }]);
  assert.match(sidequestDispatchRefusal(project, { claudeHome, pluginRoot }), /missing or malformed/);
});

test('mutation freshness reuses the dispatch decision once per session', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  const options = { claudeHome, pluginRoot, sessionId: 'mutation-freshness-session' };
  writePluginVersion(pluginRoot, '4.48.0');
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: '4.48.1' }]);

  const first = sidequestMutationFreshness(project, options);
  assert.match(first.refusal, /loaded 4\.48\.0, installed 4\.48\.1/);
  fs.rmSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  assert.deepEqual(sidequestMutationFreshness(project, options), first);
  assert.equal(sidequestMutationFreshness(project, { ...options, sessionId: 'no-installed-evidence' }).refusal, '');
});

test('dispatch permits a heal-capable version skew with a recorded warning', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  writePluginVersion(pluginRoot, '4.48.1');
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: '4.49.0' }]);

  assert.deepEqual(sidequestDispatchFreshness(project, { claudeHome, pluginRoot }), {
    refusal: '',
    warning: 'Sidequest dispatch skew: loaded 4.48.1, installed 4.49.0. Claim self-heal can bridge this compatible version skew, so dispatch continues; run /reload-plugins or restart Claude Code before the next dispatch. A schema change or a loaded version before 4.48.1 still refuses.',
    skew: { loadedVersion: '4.48.1', installedVersion: '4.49.0', schemaVersion: 1 },
  });
});

test('dispatch refuses a version skew that predates claim self-heal', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const project = path.join(directory, 'current');
  writePluginVersion(pluginRoot, '4.48.0');
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: '4.49.0' }]);

  assert.match(sidequestDispatchRefusal(project, { claudeHome, pluginRoot }), /predates claim self-heal 4\.48\.1/);
  assert.match(sidequestDispatchRefusal(project, { claudeHome, pluginRoot }), /reload-plugins or restart Claude Code/);
});

test('records this session loaded version for the Workbench prompt guard', () => {
  const directory = temporaryDirectory();
  const pluginRoot = path.join(directory, 'loaded-sidequest');
  const stateDirectory = path.join(directory, 'state');
  writePluginVersion(pluginRoot, '1.0.0');

  assert.equal(reportLoadedSidequestVersion({ session_id: 'freshness-session' }, { pluginRoot, stateDirectory }), '1.0.0');
  assert.equal(fs.readdirSync(stateDirectory).length, 1);
});

test('writes a SessionStart reload notice when the installed Sidequest is newer', () => {
  const directory = temporaryDirectory();
  const claudeHome = path.join(directory, 'claude');
  const sidequestHome = path.join(directory, 'sidequest-home');
  const project = path.join(directory, 'project');
  const pluginRoot = path.join(__dirname, '..');
  writeRegistry(claudeHome, [{ scope: 'project', projectPath: project, version: '99.99.99' }]);

  const output = JSON.parse(execFileSync(process.execPath, [path.join(pluginRoot, 'hooks', 'session-start.js')], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'session-start-freshness', cwd: project }),
    env: {
      ...process.env,
      SIDEQUEST_CLAUDE_HOME: claudeHome,
      SIDEQUEST_HOME: sidequestHome,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      SIDEQUEST_NUDGE: 'on',
    },
  }));
  assert.match(output.hookSpecificOutput.additionalContext, /Sidequest: loaded \d+\.\d+\.\d+, installed 99\.99\.99/);
  assert.match(output.hookSpecificOutput.additionalContext, /\/reload-plugins/);
});
