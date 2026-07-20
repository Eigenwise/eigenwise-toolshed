#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compareSemver: compareVersions,
  parseSemver: semver,
  pluginIdParts,
  pluginInstances,
  readJson: readJsonFrom,
} = require('./freshness-helpers.js');

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CLAUDE_CODE_VERSION = '2.1.0';
const MIN_NODE_VERSION = '22.5.0';
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const seenStates = new Set();

function readJson(file) {
  return readJsonFrom(fs, file);
}

function marketplaceManifest(entry) {
  if (!entry?.installLocation) return null;
  return readJson(path.join(entry.installLocation, '.claude-plugin', 'marketplace.json'));
}

function normalizedPath(value) {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function proxyVersionFloor(gateway) {
  const source = readText(path.join(gateway.installPath || '', 'bin', 'codex-gateway.js'));
  return source?.match(/MIN_PROXY_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] || '0.1.14';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function runVersion(command, args, timeout = 1000) {
  try {
    const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true });
    return result.status === 0 ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
  } catch (_) {
    return '';
  }
}

function localGatewayCheck(gateway) {
  if (!gateway?.installPath) return { available: false };
  const gatewayScript = path.join(gateway.installPath, 'bin', 'codex-gateway.js');
  if (!fs.existsSync(gatewayScript)) return { available: false };
  const output = runVersion(process.execPath, [gatewayScript, 'doctor'], 3000);
  if (!output) return { available: false };
  const proxy = output.match(/^version:\s*(.+)$/m)?.[1];
  const auth = output.match(/^codex auth:\s*(.+)$/m)?.[1];
  return {
    available: true,
    proxyVersion: proxy,
    auth: /authenticated/i.test(auth || '') && !/not authenticated/i.test(auth || ''),
    proxy: /proxy \(claude-code-proxy\).*running/i.test(output),
    shim: /shim \(model router\).*running/i.test(output),
  };
}

function sidequestBoards(home) {
  const databaseFile = path.join(home, '.claude', 'sidequest', 'sidequest.db');
  if (!fs.existsSync(databaseFile)) return [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    const rows = database.prepare('SELECT data FROM projects').all();
    database.close();
    return rows.map((row) => JSON.parse(row.data)).filter((board) => board?.path);
  } catch (_) {
    return [];
  }
}

function createDebouncer(states = seenStates) {
  return {
    first(state) {
      if (states.has(state)) return false;
      states.add(state);
      return true;
    },
  };
}

const defaultDebouncer = createDebouncer();

function autoUpdateEnabled(name, entry) {
  return entry?.autoUpdate === true || (name === OFFICIAL_MARKETPLACE && entry?.autoUpdate !== false);
}

function sourcePath(source) {
  if (typeof source !== 'string' || path.isAbsolute(source)) return null;
  const relative = path.normalize(source).replace(/^\.([\\/])/, '');
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' ? relative.replace(/\\/g, '/') : null;
}

function sourceFreshness(instance, plugin, entry, runGit = (args) => childProcess.spawnSync('git', args, { encoding: 'utf8', timeout: 1000, windowsHide: true })) {
  const source = sourcePath(plugin?.source);
  if (!instance?.gitCommitSha || !source || !entry?.installLocation) return 'unknown';
  try {
    const ancestry = runGit(['-C', entry.installLocation, 'merge-base', '--is-ancestor', instance.gitCommitSha, 'HEAD']);
    if (ancestry.status !== 0) return 'unknown';
    const result = runGit(['-C', entry.installLocation, 'diff', '--quiet', `${instance.gitCommitSha}..HEAD`, '--', source]);
    if (result.status === 0) return 'fresh';
    if (result.status === 1) return 'behind';
  } catch (_) {
    // The cache is only evidence when its local git data can prove freshness.
  }
  return 'unknown';
}

function installedFreshness(instances, marketplaces, now, manifestFor, gitFreshness = sourceFreshness, updates = []) {
  const problems = [];
  const manifests = new Map();
  const names = [...new Set(instances.map((instance) => pluginIdParts(instance.id)?.marketplace).filter(Boolean))];

  for (const name of names) {
    const entry = marketplaces?.[name];
    if (!entry) {
      problems.push(`${name} marketplace is not registered locally`);
      continue;
    }
    if (!autoUpdateEnabled(name, entry)) problems.push(`${name} auto-update is off`);

    const age = Date.parse(entry.lastUpdated || '');
    if (!Number.isFinite(age) || now - age > CACHE_MAX_AGE_MS) {
      problems.push(`${name} marketplace cache is stale, installed freshness is unknown`);
      continue;
    }

    const manifest = manifestFor(name, entry);
    if (!manifest) {
      problems.push(`${name} marketplace cache is missing, installed freshness is unknown`);
      continue;
    }
    manifests.set(name, new Map((manifest.plugins || []).map((plugin) => [plugin.name, plugin])));
  }

  for (const instance of instances) {
    const parts = pluginIdParts(instance.id);
    if (!parts || !manifests.has(parts.marketplace)) continue;
    const plugin = manifests.get(parts.marketplace).get(parts.name);
    if (!plugin) {
      problems.push(`${instance.id} freshness is unknown because it is missing from its cached marketplace manifest`);
      continue;
    }

    if (plugin.version) {
      const comparison = compareVersions(instance.version, plugin.version);
      if (comparison === -1) {
        problems.push(`${instance.id} ${instance.version} is behind cached ${plugin.version}`);
        updates.push({ name: parts.name, installed: instance.version, available: plugin.version });
      } else if (comparison === null) problems.push(`${instance.id} freshness is unknown because its version cannot be compared`);
      continue;
    }

    const freshness = gitFreshness(instance, plugin, marketplaces[parts.marketplace]);
    if (freshness === 'behind') problems.push(`${instance.id} is behind its cached source`);
    else if (freshness === 'unknown') problems.push(`${instance.id} freshness is unknown because its cached source cannot be compared`);
  }

  return problems;
}

function gatewayFreshness(instances, checkGateway) {
  const gateway = instances.find((instance) => instance.id === 'codex-gateway@eigenwise-toolshed');
  if (!gateway) return [];
  const check = checkGateway(gateway);
  if (!check?.available) return ['codex-gateway local health check is unavailable'];

  const problems = [];
  const floor = check.minProxyVersion || proxyVersionFloor(gateway);
  if (!semver(check.proxyVersion)) problems.push('codex-gateway proxy is missing or has no readable version');
  else if (compareVersions(check.proxyVersion, floor) === -1) problems.push(`codex-gateway proxy ${check.proxyVersion} is below required ${floor}`);
  if (check.auth === false) problems.push('codex-gateway is not authenticated');
  if (check.proxy === false || check.shim === false) problems.push('codex-gateway proxy or router is down');
  return problems;
}

function requiredVersions(versions) {
  const problems = [];
  if (compareVersions(versions.node, MIN_NODE_VERSION) === -1) problems.push(`Node ${versions.node} is below required ${MIN_NODE_VERSION}`);
  if (versions.claude && compareVersions(versions.claude, MIN_CLAUDE_CODE_VERSION) === -1) problems.push(`Claude Code ${versions.claude} is below required ${MIN_CLAUDE_CODE_VERSION}`);
  return problems;
}

function boardMappings(boards, instances) {
  const sidequestInstalls = instances.filter((instance) => instance.id === 'sidequest@eigenwise-toolshed');
  const missing = [];
  const mappings = boards.map((board) => {
    const boardPath = normalizedPath(board.path);
    const matching = sidequestInstalls.filter((instance) => instance.projectPath && normalizedPath(instance.projectPath) === boardPath);
    const user = sidequestInstalls.some((instance) => instance.scope === 'user');
    const status = matching.length ? 'installed' : user ? 'user-only' : 'missing';
    if (status !== 'installed') missing.push({ board, status });
    return { name: board.name || board.path, path: board.path, status };
  });
  const problems = missing.length === 1
    ? [`Sidequest board ${missing[0].board.name || missing[0].board.path} has ${missing[0].status === 'user-only' ? 'no project/local' : 'no'} Sidequest install`]
    : missing.length > 1
      ? [`${missing.length} Sidequest boards lack a project/local Sidequest install`]
      : [];
  return { mappings, problems };
}

function audit(options = {}) {
  const home = options.home || os.homedir();
  const registry = options.registry || readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {};
  const marketplaces = options.marketplaces || readJson(path.join(home, '.claude', 'plugins', 'known_marketplaces.json')) || {};
  const now = options.now ?? Date.now();
  const instances = pluginInstances(registry);
  const manifestFor = options.manifestFor || ((_name, entry) => marketplaceManifest(entry));
  const gitFreshness = options.gitFreshness || sourceFreshness;
  const checkGateway = options.checkGateway || localGatewayCheck;
  const versions = options.versions || {
    node: process.version,
    claude: runVersion(options.claudeCommand || 'claude', ['--version']),
  };
  const boards = options.boards || sidequestBoards(home);
  const mappings = boardMappings(boards, instances);
  const updates = [];
  const problems = [
    ...installedFreshness(instances, marketplaces, now, manifestFor, gitFreshness, updates),
    ...gatewayFreshness(instances, checkGateway),
    ...requiredVersions(versions),
    ...mappings.problems,
  ];
  return { problems: [...new Set(problems)].sort(), mappings: mappings.mappings, instances, updates };
}

function warning(problems) {
  if (!problems.length) return '';
  const shown = problems.slice(0, 5);
  const extra = problems.length > shown.length ? `; +${problems.length - shown.length} more` : '';
  return `Toolshed local health: ${shown.join('; ')}${extra}. Cached version signals are advisory; the prompt guard decides release freshness. Run /update-toolshed for deliberate updates.`;
}

function emitWarning(problems, debouncer = defaultDebouncer) {
  const message = warning(problems);
  if (!message) return '';
  const state = crypto.createHash('sha256').update(problems.join('\n')).digest('hex');
  return debouncer.first(state) ? message : '';
}

function loadedPluginVersion(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT) {
  return pluginRoot ? readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version || null : null;
}

function newerWorkbenchVersion(instances, loadedVersion) {
  return instances
    .filter((instance) => pluginIdParts(instance.id)?.name === 'workbench')
    .find((instance) => compareVersions(loadedVersion, instance.version) === -1)?.version || null;
}

function compressedUpdates(updates) {
  const unique = new Map();
  for (const update of updates) {
    const existing = unique.get(update.name);
    if (!existing || compareVersions(existing.available, update.available) === -1) unique.set(update.name, update);
  }
  const values = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  const shown = values.slice(0, 3).map((update) => `${update.name} ${update.installed} → ${update.available}`);
  return shown.length ? `${shown.join(', ')}${values.length > shown.length ? `, +${values.length - shown.length} more` : ''}` : '';
}

function systemMessage(result, loadedVersion) {
  const messages = [];
  const installedVersion = newerWorkbenchVersion(result.instances, loadedVersion);
  if (installedVersion) messages.push(`Toolshed: workbench ${loadedVersion} loaded, ${installedVersion} installed — /reload-plugins to pick it up.`);
  const updates = compressedUpdates(result.updates);
  if (updates) messages.push(`Toolshed updates available (cached): ${updates} — /update-toolshed, then /reload-plugins.`);
  return messages.join('\n');
}

function main() {
  try {
    const result = audit();
    const context = emitWarning(result.problems);
    const notice = systemMessage(result, loadedPluginVersion());
    if (context || notice) {
      const output = {};
      if (context) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
      if (notice) output.systemMessage = notice;
      process.stdout.write(JSON.stringify(output));
    }
  } catch (_) {
    // A read-only audit must never stop Claude Code from starting.
  }
}

if (require.main === module) main();

module.exports = {
  CACHE_MAX_AGE_MS,
  MIN_CLAUDE_CODE_VERSION,
  MIN_NODE_VERSION,
  OFFICIAL_MARKETPLACE,
  audit,
  autoUpdateEnabled,
  boardMappings,
  compareVersions,
  compressedUpdates,
  createDebouncer,
  emitWarning,
  gatewayFreshness,
  installedFreshness,
  loadedPluginVersion,
  newerWorkbenchVersion,
  pluginInstances,
  sourceFreshness,
  systemMessage,
  warning,
};
