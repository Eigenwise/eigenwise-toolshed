'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  agentTeamsWarning,
  clampAutoCompactWindow,
  compactionWindowFinding,
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

test('reports the effective compaction window and its winning settings file', (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const globalSettingsPath = path.join(directory, 'user-settings', '.claude', 'settings.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');

  const unsetFinding = compactionWindowFinding(projectDir, { globalSettingsPath, home: directory });
  assert.match(unsetFinding, /"autoCompactWindow"/);
  assert.match(unsetFinding, new RegExp(globalSettingsPath.replace(/\\/g, '\\\\')));
  assert.match(unsetFinding, new RegExp(projectSettingsPath.replace(/\\/g, '\\\\')));
  assert.match(unsetFinding, /Compaction follows the model default/);
  assert.match(unsetFinding, /model-gateway.js context-window/);
  assert.doesNotMatch(unsetFinding, /325000|292000/);

  fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
  fs.writeFileSync(globalSettingsPath, JSON.stringify({ autoCompactWindow: 250_000 }));
  const userFinding = compactionWindowFinding(projectDir, { globalSettingsPath });
  assert.match(userFinding, /250000/);
  assert.match(userFinding, /user setting wins/);

  fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
  fs.writeFileSync(projectSettingsPath, JSON.stringify({ autoCompactWindow: 325_000 }));
  const projectFinding = compactionWindowFinding(projectDir, { globalSettingsPath });
  assert.match(projectFinding, /325000/);
  assert.match(projectFinding, new RegExp(projectSettingsPath.replace(/\\/g, '\\\\')));
  assert.match(projectFinding, /project setting wins/);
});

function gatewayFixture(t) {
  const { directory: home, projectDir } = temporaryProject(t);
  t.mock.method(os, 'homedir', () => home);
  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const gatewayDirectory = path.join(home, '.claude', 'model-gateway');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.mkdirSync(gatewayDirectory, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: {
    'model-gateway@eigenwise-toolshed': [{ installPath: path.resolve(__dirname, '../../model-gateway') }],
  } }));
  fs.writeFileSync(path.join(gatewayDirectory, 'model-gateway.js'), 'throw new Error("launcher must not run");');
  const policyPath = path.join(gatewayDirectory, 'context-window.json');
  fs.writeFileSync(policyPath, JSON.stringify({ codex: 300000, compactAt: { codex: 210000 } }));
  return { home, projectDir, policyPath, registryPath, gatewayDirectory };
}

test('reports gateway-owned saved compact-at and gateway defaults without changing settings', (t) => {
  const { home, projectDir, policyPath } = gatewayFixture(t);
  const before = fs.readFileSync(policyPath, 'utf8');
  const finding = compactionWindowFinding(projectDir, { home });
  assert.match(finding, /Compaction is owned by Model Gateway/);
  assert.match(finding, /codex: 300000 cap \[saved\].*requested compact-at 210000/);
  assert.match(finding, /effective maximum 210000 \(compact-at\)/);
  assert.match(finding, /claude: full/);
  assert.match(finding, /grok: full/);
  assert.match(finding, /installed gateway reader and defaults/);
  assert.doesNotMatch(finding, /325000|292000/);
  assert.equal(fs.readFileSync(policyPath, 'utf8'), before);
});

test('explicit user and project windows take precedence over gateway policy and remain unchanged', (t) => {
  const { home, projectDir } = gatewayFixture(t);
  const globalSettingsPath = path.join(home, '.claude', 'settings.json');
  const projectPath = path.join(projectDir, '.claude', 'settings.local.json');
  const userSettings = JSON.stringify({ autoCompactWindow: 240000, keep: true });
  fs.writeFileSync(globalSettingsPath, userSettings);
  assert.match(compactionWindowFinding(projectDir, { home }), /240000.*user setting wins/);
  assert.equal(fs.readFileSync(globalSettingsPath, 'utf8'), userSettings);
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  const projectSettings = JSON.stringify({ autoCompactWindow: 220000 });
  fs.writeFileSync(projectPath, projectSettings);
  assert.match(compactionWindowFinding(projectDir, { home }), /220000.*project setting wins/);
  assert.equal(fs.readFileSync(projectPath, 'utf8'), projectSettings);
  assert.equal(fs.readFileSync(globalSettingsPath, 'utf8'), userSettings);
});

test('requires both gateway registry installation and stable launcher', (t) => {
  const { home, projectDir, registryPath, gatewayDirectory } = gatewayFixture(t);
  fs.unlinkSync(path.join(gatewayDirectory, 'model-gateway.js'));
  assert.match(compactionWindowFinding(projectDir, { home }), /Compaction follows the model default/);
  fs.writeFileSync(path.join(gatewayDirectory, 'model-gateway.js'), '');
  fs.writeFileSync(registryPath, JSON.stringify({ plugins: { 'other@marketplace': [{}], 'model-gateway@empty': [] } }));
  assert.match(compactionWindowFinding(projectDir, { home }), /Compaction follows the model default/);
});

test('reports unreadable gateway policy without inventing a compaction recommendation', (t) => {
  const { home, projectDir, policyPath } = gatewayFixture(t);
  fs.writeFileSync(policyPath, JSON.stringify({ compactAt: { codex: -1 } }));
  const finding = compactionWindowFinding(projectDir, { home });
  assert.match(finding, /Model Gateway compaction report unavailable/);
  assert.match(finding, /invalid compactAt.codex/);
  assert.doesNotMatch(finding, /325000|292000|Compaction follows the model default/);
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
