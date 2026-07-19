#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  activeInstances,
  compareSemver,
  parseSemver,
  readJson,
} = require('./freshness-helpers.js');

const MARKETPLACE = 'eigenwise-toolshed';
const AUTOMATION_TAG = /^<(?:agent-message|local-command-caveat|task-notification|task-progress|task-result)\b/i;
const warnedReloads = new Set();

function isMaintenancePrompt(prompt) {
  const value = String(prompt || '').trim();
  if (/^\/(?:workbench:)?update-toolshed(?:\s+[\w.-]+)*$/i.test(value)) return true;
  if (/^\/(?:workbench:)?workbench-doctor$/i.test(value)) return true;
  if (/^\/reload-plugins(?:\s+--force)?$/i.test(value)) return true;
  if (/^\/plugin$/i.test(value)) return true;
  if (/^\/plugin\s+(?:install|update|enable|disable|remove|uninstall)(?:\s+[^\s]+){0,4}$/i.test(value)) return true;
  if (/^\/plugin\s+marketplace\s+(?:add|update|remove)(?:\s+[^\s]+){0,3}$/i.test(value)) return true;
  if (/^claude\s+plugin\s+marketplace\s+update\s+eigenwise-toolshed$/i.test(value)) return true;
  return /^claude\s+plugin\s+update\s+[\w.-]+@eigenwise-toolshed(?:\s+--scope\s+(?:user|project|local))?$/i.test(value);
}

function isTaskNotificationPrompt(prompt) {
  const source = String(prompt || '');
  const allowedFields = new Set(['task-id', 'tool-use-id', 'output-file', 'status', 'summary', 'note', 'result', 'usage', 'worktree']);
  const values = new Map();
  const stack = [];
  const tags = /<(\/)?([a-z][a-z0-9-]*)>/g;
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;
  let match;
  while ((match = tags.exec(source))) {
    const text = source.slice(cursor, match.index);
    if (text.includes('<') || (stack.length === 1 && stack[0].name === 'task-notification' && text.trim())) return false;
    cursor = tags.lastIndex;
    const closing = Boolean(match[1]);
    const name = match[2];
    if (!closing) {
      if (!stack.length) {
        if (name !== 'task-notification' || rootSeen || source.slice(0, match.index).trim()) return false;
        rootSeen = true;
      } else if (stack.length === 1 && stack[0].name === 'task-notification') {
        if (!allowedFields.has(name) || values.has(name)) return false;
      } else if (name === 'task-notification') {
        return false;
      }
      stack.push({ name, valueStart: tags.lastIndex });
      continue;
    }
    const field = stack.pop();
    if (!field || field.name !== name) return false;
    if (stack.length === 1 && stack[0].name === 'task-notification') values.set(name, source.slice(field.valueStart, match.index));
    if (name === 'task-notification') {
      if (stack.length || rootClosed || source.slice(tags.lastIndex).trim()) return false;
      rootClosed = true;
    }
  }
  if (source.slice(cursor).includes('<') || !rootClosed || stack.length) return false;
  const taskId = values.get('task-id');
  const toolUseId = values.get('tool-use-id');
  const status = values.get('status');
  const summary = values.get('summary');
  return Boolean(taskId?.trim() && toolUseId?.trim() && summary?.trim())
    && !/[<]/.test(taskId)
    && !/[<]/.test(toolUseId)
    && !/[<]/.test(summary)
    && ['completed', 'failed', 'stopped'].includes(status?.trim());
}

// The ONLY hard block is the reload window: this session loaded an OLDER workbench than the
// one now installed, so its plugin code (and the sidequest MCP it fronts) can write a stale
// store shape until /reload-plugins lands. That is the one moment a stale prompt can corrupt
// shared state, and the user clears it themselves by reloading.
//
// "Installed is behind the central marketplace" is deliberately NOT blocked here. Being behind
// is not a corruption risk (loaded == installed, so no schema mismatch), and hard-blocking on
// the marketplace version — which advances on every toolshed release — trapped unrelated
// prompts in unrelated projects every time anything shipped. The advisory "an update is
// available" nudge lives in the SessionStart freshness hook instead.
function reloadReason(instances, loadedVersion) {
  const installed = instances
    .filter((instance) => instance.name === 'workbench')
    .find((instance) => compareSemver(loadedVersion, instance.version) === -1);
  return installed
    ? `Toolshed plugins were updated, but this session still loaded workbench ${loadedVersion} while the installed version is ${installed.version}. Run /reload-plugins or restart Claude Code. If ordinary reload is refused after plugin MCP state changes, retry with /reload-plugins --force, then resubmit this prompt. This prompt was not sent to Claude.`
    : null;
}

function isAgentGeneratedPrompt(prompt) {
  const source = String(prompt || '');
  return isTaskNotificationPrompt(source) || (AUTOMATION_TAG.test(source) && !/^<task-notification\b/i.test(source));
}

function blockOutput(reason) {
  return reason ? JSON.stringify({ decision: 'block', reason }) : '';
}

function warningOutput(message) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } });
}

function reloadWarning(installedVersion, loadedVersion) {
  return `Workbench ${installedVersion} installed, session loaded ${loadedVersion}. Reload when convenient.`;
}

function warningKey(input, installedVersion, loadedVersion) {
  return `${input?.session_id || ''}\0${input?.cwd || ''}\0${installedVersion}\0${loadedVersion}`;
}

function warningStateFile(input, installedVersion, loadedVersion, directory) {
  if (!input?.session_id) return null;
  const digest = crypto.createHash('sha256').update(warningKey(input, installedVersion, loadedVersion)).digest('hex');
  return path.join(directory, digest);
}

function warnOnce(input, installedVersion, loadedVersion, options = {}) {
  const key = warningKey(input, installedVersion, loadedVersion);
  const warned = options.warnedReloads || warnedReloads;
  if (warned.has(key)) return false;
  warned.add(key);
  const stateFile = warningStateFile(input, installedVersion, loadedVersion, options.warningStateDirectory || path.join(os.tmpdir(), 'eigenwise-toolshed', 'freshness-warnings'));
  if (!stateFile) return true;
  try {
    (options.fileSystem || fs).mkdirSync(path.dirname(stateFile), { recursive: true });
    (options.fileSystem || fs).writeFileSync(stateFile, '', { flag: 'wx' });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

function marketplaceRoot(projectDirectory, fileSystem) {
  if (!projectDirectory) return false;
  let directory = path.resolve(projectDirectory);
  while (true) {
    const manifest = readJson(fileSystem, path.join(directory, '.claude-plugin', 'marketplace.json'));
    if (manifest?.name === MARKETPLACE && manifest.plugins?.some((plugin) => plugin.name === 'workbench' && plugin.source === './plugins/workbench')) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function isToolshedDevProject(input, fileSystem) {
  return marketplaceRoot(process.env.CLAUDE_PROJECT_DIR, fileSystem) || marketplaceRoot(input?.cwd, fileSystem);
}

function loadedPluginVersion(fileSystem, pluginRoot) {
  return pluginRoot ? readJson(fileSystem, path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version || null : null;
}

function decide(input, options = {}) {
  if (process.env.EIGENWISE_TOOLSHED_FRESHNESS_BYPASS === '1' || isMaintenancePrompt(input?.prompt)) return '';
  const fileSystem = options.fileSystem || fs;
  const registryFile = options.registryFile || path.join(options.home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const instances = activeInstances(readJson(fileSystem, registryFile) || {}, input?.cwd, MARKETPLACE, options.platform);
  const loadedVersion = loadedPluginVersion(fileSystem, options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT);
  const reason = reloadReason(instances, loadedVersion);
  if (!reason) return '';
  const installedVersion = instances
    .filter((instance) => instance.name === 'workbench')
    .find((instance) => compareSemver(loadedVersion, instance.version) === -1)?.version;
  if ((isAgentGeneratedPrompt(input?.prompt) || isToolshedDevProject(input, fileSystem))
    && warnOnce(input, installedVersion, loadedVersion, options)) {
    return warningOutput(reloadWarning(installedVersion, loadedVersion));
  }
  return isAgentGeneratedPrompt(input?.prompt) || isToolshedDevProject(input, fileSystem) ? '' : blockOutput(reason);
}

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const output = decide(input);
    if (output) process.stdout.write(output);
  } catch (_) {
    // Unknown local state and hook failures must never block a user prompt.
  }
}

if (require.main === module) main();

module.exports = {
  MARKETPLACE,
  activeInstances,
  blockOutput,
  compareSemver,
  decide,
  isAgentGeneratedPrompt,
  isMaintenancePrompt,
  isTaskNotificationPrompt,
  isToolshedDevProject,
  loadedPluginVersion,
  parseSemver,
  reloadReason,
  reloadWarning,
  warnOnce,
};
