'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT_TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

function projectSettingsPath(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'settings.local.json');
}

function readProjectSettings(projectDir) {
  const settingsPath = projectSettingsPath(projectDir);
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Could not read ${settingsPath}: ${error.message}`);
  }
}

function writeProjectSettings(projectDir, settings) {
  const settingsPath = projectSettingsPath(projectDir);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.dirname(settingsPath), 0o700); fs.chmodSync(settingsPath, 0o600); } catch {}
  return settingsPath;
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

function agentTeamsWarning(projectDir) {
  const settings = readProjectSettings(projectDir);
  if (!settings.env || Object.hasOwn(settings.env, AGENT_TEAMS_ENV)) return null;
  return `Project env masks the global agent-teams setting. Add "${AGENT_TEAMS_ENV}": "1" to ${projectSettingsPath(projectDir)}.`;
}

module.exports = {
  AGENT_TEAMS_ENV,
  agentTeamsWarning,
  enableAgentTeams,
  mergeProjectEnvironment,
  projectSettingsPath,
  readProjectSettings,
  writeProjectSettings,
};
