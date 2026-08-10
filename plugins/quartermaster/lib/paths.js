'use strict';

const os = require('node:os');
const path = require('node:path');

function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot(env = process.env) {
  return path.join(claudeDir(env), 'projects');
}

function pluginsDir(env = process.env) {
  return path.join(claudeDir(env), 'plugins');
}

function stateRoot(env = process.env) {
  return env.QUARTERMASTER_STATE_DIR || path.join(claudeDir(env), 'quartermaster-state');
}

/**
 * Claude Code names a transcript directory after the project path with every character that is not
 * alphanumeric replaced one-for-one by a dash, so `C:\dev\toolshed` becomes `C--dev-toolshed`.
 */
function slugForProject(projectPath) {
  return String(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { claudeDir, pluginsDir, projectsRoot, slugForProject, stateRoot };
