'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  agentTeamsWarning,
  clampAutoCompactWindow,
  configureSidequestCompaction,
  enableAgentTeams,
} = require('../lib/project-settings.js');

function temporaryProject(t, name = 'settings-project') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-settings-'));
  const projectDir = path.join(directory, name);
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, projectDir };
}

test('enables agent teams without replacing project environment settings', (t) => {
  const { projectDir } = temporaryProject(t);
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    env: { KEEP_ME: 'yes' },
  }));

  const first = enableAgentTeams(projectDir);
  const second = enableAgentTeams(projectDir);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.deepEqual(settings.env, {
    KEEP_ME: 'yes',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  });
});

test('warns only when a project environment masks agent teams', (t) => {
  const { projectDir } = temporaryProject(t);
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');

  assert.equal(agentTeamsWarning(projectDir), null);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP_ME: 'yes' } }));
  assert.match(agentTeamsWarning(projectDir), /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/);

  enableAgentTeams(projectDir);
  assert.equal(agentTeamsWarning(projectDir), null);
});

test('configures a global compaction window without replacing either settings file', (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const globalSettingsPath = path.join(directory, 'user-settings', '.claude', 'settings.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
  fs.writeFileSync(globalSettingsPath, JSON.stringify({
    env: { KEEP_GLOBAL_ENV: 'yes' },
    enabledPlugins: { workbench: true },
    marketplaces: { eigenwise: { source: 'github' } },
  }));
  fs.writeFileSync(projectSettingsPath, JSON.stringify({
    unknownSetting: { preserved: true },
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    },
  }));

  const first = configureSidequestCompaction(projectDir, {
    autoCompactWindow: 350_000,
    policy: 'pin',
    globalSettingsPath,
  });
  const second = configureSidequestCompaction(projectDir, {
    autoCompactWindow: 350_000,
    policy: 'pin',
    globalSettingsPath,
  });
  const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
  const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(globalSettings.autoCompactWindow, 350_000);
  assert.deepEqual(globalSettings.env, { KEEP_GLOBAL_ENV: 'yes' });
  assert.deepEqual(globalSettings.enabledPlugins, { workbench: true });
  assert.deepEqual(globalSettings.marketplaces, { eigenwise: { source: 'github' } });
  assert.deepEqual(projectSettings.unknownSetting, { preserved: true });
  assert.equal(Object.hasOwn(projectSettings, 'autoCompactWindow'), false);
  assert.deepEqual(projectSettings.env, {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    SIDEQUEST_COMPACTION_POLICY: 'pin',
  });
});

test('clamps custom compaction windows to Claude Code limits', () => {
  assert.equal(clampAutoCompactWindow(1), 100_000);
  assert.equal(clampAutoCompactWindow(2_000_000), 1_000_000);
  assert.throws(() => clampAutoCompactWindow('350000'), /finite number/);
});

test('leaving the compaction window at default removes it globally and can remove a legacy project override', (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const globalSettingsPath = path.join(directory, 'user-settings', '.claude', 'settings.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
  fs.writeFileSync(globalSettingsPath, JSON.stringify({ autoCompactWindow: 250_000, marketplaces: { kept: true } }));
  fs.writeFileSync(projectSettingsPath, JSON.stringify({
    autoCompactWindow: 250_000,
    unknownSetting: true,
    env: { KEEP_ME: 'yes' },
  }));

  configureSidequestCompaction(projectDir, {
    autoCompactWindow: null,
    policy: 'off',
    removeProjectAutoCompactWindow: true,
    globalSettingsPath,
  });
  const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
  const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));

  assert.equal(Object.hasOwn(globalSettings, 'autoCompactWindow'), false);
  assert.deepEqual(globalSettings.marketplaces, { kept: true });
  assert.equal(Object.hasOwn(projectSettings, 'autoCompactWindow'), false);
  assert.equal(projectSettings.unknownSetting, true);
  assert.deepEqual(projectSettings.env, {
    KEEP_ME: 'yes',
    SIDEQUEST_COMPACTION_POLICY: 'off',
  });
});

test('rejects unsupported Sidequest compaction policies', (t) => {
  const { projectDir } = temporaryProject(t);
  assert.throws(
    () => configureSidequestCompaction(projectDir, { autoCompactWindow: 350_000, policy: 'unknown' }),
    /pin, veto, off/,
  );
});
