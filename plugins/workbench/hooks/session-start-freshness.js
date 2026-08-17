#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalPath,
  compareSemver: compareVersions,
  parseSemver: semver,
  pluginIdParts,
  pluginInstances,
  readJson: readJsonFrom,
  reportLoadedPluginVersion,
} = require('./freshness-helpers.js');

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CLAUDE_CODE_VERSION = '2.1.0';
const MIN_NODE_VERSION = '22.5.0';
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const seenStates = new Set();

// The health report is SessionStart additional context, so only the model reads it. A finding the USER has to
// go fix therefore reached nobody: on 2026-08-13 this hook correctly found a Sidequest board whose install had
// been pruned away, plus auto-update off and a stale cache, and Kenny learned none of it until he asked what
// hooks had fired (SQ-1900). Recording who must act at the point each finding is produced is what lets the one
// user-facing line be built without matching on message text.
const BLOCKS_THE_USER = 'blocking';
const DRIFTING_ON_THE_USER = 'degraded';
const USER_ACTION_SEVERITY = [BLOCKS_THE_USER, DRIFTING_ON_THE_USER];

function finding(text, userAction = null) {
  return { text, userAction };
}

function findingText(findings) {
  return findings.map((item) => item.text);
}

function uniqueFindings(findings) {
  const byText = new Map();
  for (const item of findings) if (!byText.has(item.text)) byText.set(item.text, item);
  return [...byText.values()].sort((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
}

function readJson(file) {
  return readJsonFrom(fs, file);
}

function marketplaceManifest(entry) {
  if (!entry?.installLocation) return null;
  return readJson(path.join(entry.installLocation, '.claude-plugin', 'marketplace.json'));
}

function normalizedPath(value) {
  return canonicalPath(value);
}

function proxyVersionFloor(gateway) {
  const source = readText(path.join(gateway.installPath || '', 'bin', 'model-gateway.js'));
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

// Parses the model-gateway doctor's human output. Its version line carries the
// binary name before the number ("version: claude-code-proxy 0.1.33"), and the
// healthy proxy state reads "answering /v1/models", not "running" — matching
// only "running" reported a healthy gateway as down. The phrasings are pinned
// against plugins/model-gateway/lib/commands.js by a drift test.
function parseGatewayDoctorOutput(output) {
  const auth = output.match(/^codex auth:\s*(.+)$/m)?.[1];
  return {
    available: true,
    proxyVersion: output.match(/^version:.*?(\d+\.\d+\.\d+\S*)\s*$/m)?.[1],
    auth: /authenticated/i.test(auth || '') && !/not authenticated/i.test(auth || ''),
    proxy: /^proxy \(claude-code-proxy\).*(answering \/v1\/models|running)/im.test(output),
    shim: /^shim \(model router\).*running/im.test(output),
  };
}

function localGatewayCheck(gateway) {
  if (!gateway?.installPath) return { available: false };
  const gatewayScript = path.join(gateway.installPath, 'bin', 'model-gateway.js');
  if (!fs.existsSync(gatewayScript)) return { available: false };
  const output = runVersion(process.execPath, [gatewayScript, 'doctor'], 3000);
  if (!output) return { available: false };
  return parseGatewayDoctorOutput(output);
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

function sidequestWorktreeRoot(project, home, configuredHome = process.env.SIDEQUEST_HOME) {
  const normalized = normalizedPath(project);
  const name = path.basename(normalized).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return path.join(configuredHome || path.join(home, '.claude', 'sidequest'), 'worktrees', `${name}-${hash}`);
}

function worktreeRoots(project, home, configuredHome) {
  if (!project) return [];
  return [
    path.join(project, '.claude', 'worktrees'),
    sidequestWorktreeRoot(project, home, configuredHome),
  ];
}

function pathPattern(pathname) {
  return pathname.replace(/\\/g, '/').split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
}

function staleWorktreePaths(command, roots, existsSync = fs.existsSync) {
  if (typeof command !== 'string') return [];
  const matches = new Map();
  for (const root of roots) {
    const expression = new RegExp(`(${pathPattern(root)}[\\\\/]([^\\\\/"'\\s]+))`, 'gi');
    for (const match of command.matchAll(expression)) {
      const pathname = match[1];
      const key = normalizedPath(pathname);
      if (!existsSync(pathname)) matches.set(key, pathname);
    }
  }
  return [...matches.values()];
}

function windowsProcesses(run) {
  try {
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    if (result.status !== 0) return [];
    const parsed = JSON.parse(String(result.stdout || ''));
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
      const pid = Number(entry?.ProcessId);
      return Number.isInteger(pid) && pid > 0 ? [{ pid, startTime: entry.CreationDate || '', command: entry.CommandLine || '' }] : [];
    });
  } catch (_) {
    return [];
  }
}

function staleWorktreeProcesses({ project, home, listProcesses, platform = process.platform, existsSync, sidequestHome } = {}) {
  if (platform !== 'win32' || !project) return [];
  const processes = listProcesses ? listProcesses() : windowsProcesses(childProcess.spawnSync);
  const roots = worktreeRoots(project, home, sidequestHome);
  return processes.flatMap((process) => staleWorktreePaths(process.command, roots, existsSync).map((stalePath) => ({
    pid: process.pid,
    startTime: process.startTime,
    stalePath,
  })));
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
      problems.push(finding(`${name} marketplace is not registered locally`, BLOCKS_THE_USER));
      continue;
    }
    if (!autoUpdateEnabled(name, entry)) problems.push(finding(`${name} auto-update is off`, DRIFTING_ON_THE_USER));

    const age = Date.parse(entry.lastUpdated || '');
    if (!Number.isFinite(age) || now - age > CACHE_MAX_AGE_MS) {
      problems.push(finding(`${name} marketplace cache is stale, installed freshness is unknown`, DRIFTING_ON_THE_USER));
      continue;
    }

    const manifest = manifestFor(name, entry);
    if (!manifest) {
      problems.push(finding(`${name} marketplace cache is missing, installed freshness is unknown`, DRIFTING_ON_THE_USER));
      continue;
    }
    manifests.set(name, new Map((manifest.plugins || []).map((plugin) => [plugin.name, plugin])));
  }

  for (const instance of instances) {
    const parts = pluginIdParts(instance.id);
    if (!parts || !manifests.has(parts.marketplace)) continue;
    const plugin = manifests.get(parts.marketplace).get(parts.name);
    if (!plugin) {
      problems.push(finding(`${instance.id} freshness is unknown because it is missing from its cached marketplace manifest`));
      continue;
    }

    // A behind install carries no user-action severity: the update notice below already names it with its
    // remedy, and saying the same thing twice on one session start is the noise this contract rules out.
    if (plugin.version) {
      const comparison = compareVersions(instance.version, plugin.version);
      if (comparison === -1) {
        problems.push(finding(`${instance.id} ${instance.version} is behind cached ${plugin.version}`));
        updates.push({ name: parts.name, installed: instance.version, available: plugin.version, marketplace: parts.marketplace });
      } else if (comparison === null) problems.push(finding(`${instance.id} freshness is unknown because its version cannot be compared`));
      continue;
    }

    const freshness = gitFreshness(instance, plugin, marketplaces[parts.marketplace]);
    if (freshness === 'behind') problems.push(finding(`${instance.id} is behind its cached source`));
    else if (freshness === 'unknown') problems.push(finding(`${instance.id} freshness is unknown because its cached source cannot be compared`));
  }

  return problems;
}

function gatewayFreshness(instances, checkGateway) {
  const gateway = instances.find((instance) => instance.id === 'model-gateway@eigenwise-toolshed');
  if (!gateway) return [];
  const check = checkGateway(gateway);
  if (!check?.available) return [finding('model-gateway local health check is unavailable', DRIFTING_ON_THE_USER)];

  const problems = [];
  const floor = check.minProxyVersion || proxyVersionFloor(gateway);
  if (!semver(check.proxyVersion)) problems.push(finding('model-gateway proxy is missing or has no readable version', BLOCKS_THE_USER));
  else if (compareVersions(check.proxyVersion, floor) === -1) problems.push(finding(`model-gateway proxy ${check.proxyVersion} is below required ${floor}`, BLOCKS_THE_USER));
  if (check.auth === false) problems.push(finding('model-gateway is not authenticated', BLOCKS_THE_USER));
  if (check.proxy === false || check.shim === false) problems.push(finding('model-gateway proxy or router is down', BLOCKS_THE_USER));
  return problems;
}

function requiredVersions(versions) {
  const problems = [];
  if (compareVersions(versions.node, MIN_NODE_VERSION) === -1) problems.push(finding(`Node ${versions.node} is below required ${MIN_NODE_VERSION}`, BLOCKS_THE_USER));
  if (versions.claude && compareVersions(versions.claude, MIN_CLAUDE_CODE_VERSION) === -1) problems.push(finding(`Claude Code ${versions.claude} is below required ${MIN_CLAUDE_CODE_VERSION}`, BLOCKS_THE_USER));
  return problems;
}

// A plugin is also active because a project's settings say so, and that path leaves no registry row at all:
// contractify enables codebase-mapper in a committed .claude/settings.json, and the registry holds rows for
// three of the other four plugins in that same block but none for it, so the plugin was invisible here and
// the "nothing maintains it" finding fired against a maintained map (SQ-2211). Registry rows stay the
// authority on which VERSION a project runs; they were never the authority on whether the plugin is there.
// Later layers win, so an explicit false in a higher-precedence file disables what a lower one enabled.
function settingsActivationScope(pluginId, projectPath, home) {
  const layers = [
    ['user', path.join(home, '.claude', 'settings.json')],
    ['project', projectPath && path.join(projectPath, '.claude', 'settings.json')],
    ['project', projectPath && path.join(projectPath, '.claude', 'settings.local.json')],
  ];
  let scope = null;
  for (const [layerScope, file] of layers) {
    if (!file) continue;
    const enabled = readJson(file)?.enabledPlugins?.[pluginId];
    if (typeof enabled === 'boolean') scope = enabled ? layerScope : null;
  }
  return scope;
}

function boardMappings(boards, instances, home) {
  const sidequestInstalls = instances.filter((instance) => instance.id === 'sidequest@eigenwise-toolshed');
  const missing = [];
  const mappings = boards.map((board) => {
    const boardPath = normalizedPath(board.path);
    const matching = sidequestInstalls.filter((instance) => instance.projectPath && normalizedPath(instance.projectPath) === boardPath);
    const settingsScope = settingsActivationScope('sidequest@eigenwise-toolshed', board.path, home);
    const user = sidequestInstalls.some((instance) => instance.scope === 'user') || settingsScope === 'user';
    const status = matching.length || settingsScope === 'project' ? 'installed' : user ? 'user-only' : 'missing';
    if (status !== 'installed') missing.push({ board, status });
    return { name: board.name || board.path, path: board.path, status };
  });
  const problems = missing.length === 1
    ? [finding(`Sidequest board ${missing[0].board.name || missing[0].board.path} has ${missing[0].status === 'user-only' ? 'no project/local' : 'no'} Sidequest install`, BLOCKS_THE_USER)]
    : missing.length > 1
      ? [finding(`${missing.length} Sidequest boards lack a project/local Sidequest install`, BLOCKS_THE_USER)]
      : [];
  return { mappings, problems };
}

// A codebase map is only true while something maintains it, and nothing checked whether anything does. A project
// carrying .claude/.codebase-info with codebase-mapper uninstalled keeps injecting that map on every session
// start, which reads as maintained while it quietly rots (SQ-2209, split out of SQ-1900). Same user-only
// distinction as the board check: a user-scope install is not the same as none.
function mapMaintenance(currentProject, instances, home) {
  if (!currentProject || !fs.existsSync(path.join(currentProject, '.claude', '.codebase-info'))) return [];
  const installs = instances.filter((instance) => instance.id === 'codebase-mapper@eigenwise-toolshed');
  const settingsScope = settingsActivationScope('codebase-mapper@eigenwise-toolshed', currentProject, home);
  if (settingsScope === 'project' || installs.some((instance) => isCurrentProjectPath(instance.projectPath, currentProject))) return [];
  const scope = settingsScope === 'user' || installs.some((instance) => instance.scope === 'user') ? 'no project/local' : 'no';
  return [finding(`this project has a codebase map but ${scope} codebase-mapper install, so nothing maintains it`, BLOCKS_THE_USER)];
}

function isCurrentProjectPath(projectPath, currentProject) {
  if (!projectPath || !currentProject) return false;
  const relative = path.relative(normalizedPath(projectPath), normalizedPath(currentProject));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function currentProjectInstances(instances, currentProject) {
  return instances.filter((instance) => isCurrentProjectPath(instance.projectPath, currentProject));
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
  const mappings = boardMappings(boards, instances, home);
  const updates = [];
  const problems = [
    ...installedFreshness(instances, marketplaces, now, manifestFor, gitFreshness, updates),
    ...gatewayFreshness(instances, checkGateway),
    ...requiredVersions(versions),
    ...mappings.problems,
  ];
  const projectInstances = currentProjectInstances(instances, options.currentProject);
  const projectBoards = boards.filter((board) => isCurrentProjectPath(board.path, options.currentProject));
  const projectUpdates = [];
  const projectProblems = options.currentProject ? [
    ...installedFreshness(projectInstances, marketplaces, now, manifestFor, gitFreshness, projectUpdates),
    ...gatewayFreshness(projectInstances, checkGateway),
    ...boardMappings(projectBoards, instances, home).problems,
    ...mapMaintenance(options.currentProject, instances, home),
  ] : [];
  const staleProcesses = staleWorktreeProcesses({
    project: options.currentProject,
    home,
    listProcesses: options.listProcesses,
    platform: options.platform,
    existsSync: options.existsSync,
    sidequestHome: options.sidequestHome,
  });
  return {
    problems: uniqueFindings(problems),
    mappings: mappings.mappings,
    instances,
    updates,
    projectInstances,
    projectProblems: uniqueFindings(projectProblems),
    projectUpdates,
    staleProcesses,
  };
}

function warning(problems) {
  if (!problems.length) return '';
  const shown = findingText(problems).slice(0, 5);
  const extra = problems.length > shown.length ? `; +${problems.length - shown.length} more` : '';
  return `Toolshed local health: ${shown.join('; ')}${extra}. Cached version signals are advisory; the prompt guard decides release freshness. Run /update-toolshed for deliberate updates.`;
}

function emitWarning(problems, debouncer = defaultDebouncer) {
  const message = warning(problems);
  if (!message) return '';
  const state = crypto.createHash('sha256').update(findingText(problems).join('\n')).digest('hex');
  return debouncer.first(state) ? message : '';
}

function loadedPluginVersion(pluginRoot = process.env.CLAUDE_PLUGIN_ROOT) {
  return pluginRoot ? readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version || null : null;
}

function newerWorkbenchVersion(instances, loadedVersion) {
  return instances
    .filter((instance) => {
      const parts = pluginIdParts(instance.id);
      return parts?.marketplace === 'eigenwise-toolshed' && parts.name === 'workbench';
    })
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
  const installedVersion = newerWorkbenchVersion(result.instances, loadedVersion);
  if (installedVersion) return `Toolshed: workbench ${loadedVersion} loaded, ${installedVersion} installed — /reload-plugins to pick it up.`;
  const update = result.updates
    .filter((candidate) => candidate.marketplace === 'eigenwise-toolshed')
    .sort((left, right) => left.name.localeCompare(right.name))[0];
  return update ? `Toolshed update available (cached): ${update.name} ${update.installed} → ${update.available} — /update-toolshed, then /reload-plugins.` : '';
}

function projectWarning(problems) {
  const shown = findingText(problems).slice(0, 3);
  const extra = problems.length > shown.length ? `; +${problems.length - shown.length} more` : '';
  return shown.length ? `Toolshed project health: ${shown.join('; ')}${extra}.` : '';
}

// One line, on every session start, so noise discipline is part of the contract: the worst finding, the count
// of the rest, and where the detail lives. The detail lives in model-facing context the user cannot see, which
// is the whole defect, so the line has to tell them how to get it out of the model (SQ-1900).
function userActionNotice(problems) {
  const actionable = problems.filter((problem) => problem.userAction);
  if (!actionable.length) return '';
  const worst = actionable
    .slice()
    .sort((left, right) => USER_ACTION_SEVERITY.indexOf(left.userAction) - USER_ACTION_SEVERITY.indexOf(right.userAction))[0];
  const rest = actionable.length - 1;
  return `Toolshed needs you: ${worst.text}${rest ? `, +${rest} more` : ''} — ask me for the Toolshed health report.`;
}

function sessionInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (_) {
    return {};
  }
}

function main() {
  try {
    const input = sessionInput();
    const loadedVersion = loadedPluginVersion();
    reportLoadedPluginVersion(input, 'workbench@eigenwise-toolshed', loadedVersion);
    const result = audit({ currentProject: input.cwd });
    const context = [
      projectWarning(result.projectProblems),
      ...result.staleProcesses.map((process) => `Stale worktree process: pid ${process.pid}, started ${process.startTime || 'unknown'}, path ${process.stalePath}`),
    ].filter(Boolean).join('\n');
    const notice = [
      systemMessage({ instances: result.projectInstances, updates: result.projectUpdates }, loadedVersion),
      userActionNotice(result.projectProblems),
    ].filter(Boolean).join(' ');
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
  finding,
  findingText,
  gatewayFreshness,
  installedFreshness,
  loadedPluginVersion,
  mapMaintenance,
  newerWorkbenchVersion,
  parseGatewayDoctorOutput,
  pluginInstances,
  sourceFreshness,
  staleWorktreeProcesses,
  systemMessage,
  userActionNotice,
  warning,
};
