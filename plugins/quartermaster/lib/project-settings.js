'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const AUTO_COMPACT_WINDOW_MIN = 100_000;
const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
const SIDEQUEST_COMPACTION_POLICY_ENV = 'SIDEQUEST_COMPACTION_POLICY';
const SIDEQUEST_COMPACTION_POLICIES = new Set(['pin', 'veto', 'off']);

function projectSettingsPath(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'settings.local.json');
}

function userSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(settingsPath) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${settingsPath}: ${error.message}`);
  }
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.dirname(settingsPath), 0o700); fs.chmodSync(settingsPath, 0o600); } catch {}
  return settingsPath;
}

function readProjectSettings(projectDir) {
  return readSettings(projectSettingsPath(projectDir));
}

function writeProjectSettings(projectDir, settings) {
  return writeSettings(projectSettingsPath(projectDir), settings);
}

function mergeProjectEnvironment(settings, environment) {
  const next = structuredClone(settings || {});
  next.env = { ...(next.env || {}), ...environment };
  return next;
}

function enableAgentTeams(projectDir) {
  const before = readProjectSettings(projectDir);
  const settings = mergeProjectEnvironment(before, { [AGENT_TEAMS_ENV]: '1' });
  const changed = JSON.stringify(before) !== JSON.stringify(settings);
  const settingsPath = projectSettingsPath(projectDir);
  if (changed) writeProjectSettings(projectDir, settings);
  return { changed, settings, settingsPath };
}

function clampAutoCompactWindow(window) {
  if (typeof window !== 'number' || !Number.isFinite(window)) {
    throw new TypeError('autoCompactWindow must be a finite number');
  }
  return Math.min(AUTO_COMPACT_WINDOW_MAX, Math.max(AUTO_COMPACT_WINDOW_MIN, Math.trunc(window)));
}

function configureSidequestCompaction(projectDir, {
  autoCompactWindow,
  policy,
  removeProjectAutoCompactWindow = false,
  globalSettingsPath = userSettingsPath(),
}) {
  if (!SIDEQUEST_COMPACTION_POLICIES.has(policy)) {
    throw new TypeError(`Sidequest compaction policy must be one of: ${[...SIDEQUEST_COMPACTION_POLICIES].join(', ')}`);
  }

  const globalBefore = readSettings(globalSettingsPath);
  const globalSettings = structuredClone(globalBefore);
  if (autoCompactWindow == null) delete globalSettings.autoCompactWindow;
  else globalSettings.autoCompactWindow = clampAutoCompactWindow(autoCompactWindow);

  const projectBefore = readProjectSettings(projectDir);
  const projectSettings = mergeProjectEnvironment(projectBefore, { [SIDEQUEST_COMPACTION_POLICY_ENV]: policy });
  if (removeProjectAutoCompactWindow) delete projectSettings.autoCompactWindow;

  const globalChanged = JSON.stringify(globalBefore) !== JSON.stringify(globalSettings);
  const projectChanged = JSON.stringify(projectBefore) !== JSON.stringify(projectSettings);
  if (globalChanged) writeSettings(globalSettingsPath, globalSettings);
  if (projectChanged) writeProjectSettings(projectDir, projectSettings);
  return {
    changed: globalChanged || projectChanged,
    globalChanged,
    globalSettings,
    globalSettingsPath,
    projectChanged,
    projectSettings,
    projectSettingsPath: projectSettingsPath(projectDir),
  };
}

function agentTeamsWarning(projectDir) {
  const settings = readProjectSettings(projectDir);
  if (!settings.env || Object.hasOwn(settings.env, AGENT_TEAMS_ENV)) return null;
  return `Project env masks the global agent-teams setting. Add "${AGENT_TEAMS_ENV}": "1" to ${projectSettingsPath(projectDir)}.`;
}

module.exports = {
  AGENT_TEAMS_ENV,
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  SIDEQUEST_COMPACTION_POLICY_ENV,
  agentTeamsWarning,
  clampAutoCompactWindow,
  configureSidequestCompaction,
  enableAgentTeams,
  mergeProjectEnvironment,
  projectSettingsPath,
  readProjectSettings,
  userSettingsPath,
  writeProjectSettings,
};
