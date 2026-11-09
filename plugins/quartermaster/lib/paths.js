'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function claudeDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
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

function isWindowsAbsolute(value) {
  return /^[a-z]:[\\/]/i.test(value);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || isWindowsAbsolute(value));
}

/**
 * Registry rows and callers spell the same project with different separators and drive-letter
 * case, so comparisons go through this form; a relative or missing path is null, never a match.
 */
function normalizeProjectPath(value) {
  if (!isAbsolutePath(value)) return null;
  const normalized = isWindowsAbsolute(value)
    ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.resolve(value).replaceAll('\\', '/');
  return normalized.replace(/\/$/, '');
}

function checkoutPaths(projectPath) {
  const project = path.resolve(projectPath);
  try {
    const listing = execFileSync('git', ['-C', project, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set([...listing.split('\0')
      .filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9)), project])];
  } catch {
    return [project];
  }
}

function mainProjectPath(projectPath) {
  return checkoutPaths(projectPath)[0];
}

module.exports = { checkoutPaths, mainProjectPath, claudeDir, normalizeProjectPath, pluginsDir, projectsRoot, slugForProject, stateRoot };
