import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const {
  installedSidequestVersion,
  reportLoadedSidequestVersion,
  sidequestDispatchRefusal,
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
