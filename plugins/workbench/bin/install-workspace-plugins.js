#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_SCOPES = new Set(['project', 'local', 'user']);
const KNOWN_MARKETPLACES = new Map([
  ['claude-plugins-official', 'anthropics/claude-plugins-official'],
  ['eigenwise-toolshed', 'Eigenwise/eigenwise-toolshed'],
  ['cloudflare', 'cloudflare/skills'],
  ['svelte', 'sveltejs/ai-tools'],
  ['claude-community', 'anthropics/claude-plugins-community'],
]);
const IMPLICIT_MARKETPLACES = new Set(['claude-plugins-official']);
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/i;

function parseArgs(argv) {
  const options = { claude: 'claude', dryRun: false, check: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') {
      options.planFile = argv[index + 1];
      index += 1;
    } else if (arg === '--claude') {
      options.claude = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.help && !options.planFile) throw new Error('--plan requires a file');
  if (!options.claude) throw new Error('--claude requires a command');
  return options;
}

function usage() {
  return `Usage: node install-workspace-plugins.js --plan <file> [--check] [--dry-run] [--claude <command>]

Installs the marketplaces and plugins in a validated workspace plan.

  --plan      JSON install plan written by workbench:init-workspace
  --check     Inventory and report the plan without making changes
  --dry-run   Print the planned mutations without making changes
  --claude    Claude Code command to run (default: claude)`;
}

function hasOnlyKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label} has unknown key: ${key}`);
  }
}

function isWindowsAbsolute(value) {
  return /^[a-z]:[\\/]/i.test(value);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || isWindowsAbsolute(value));
}

function normalizeProjectPath(value) {
  if (!isAbsolutePath(value)) return null;
  const normalized = isWindowsAbsolute(value)
    ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase()
    : path.resolve(value).replaceAll('\\', '/');
  return normalized.replace(/\/$/, '');
}

function validatePlan(plan, { checkProjectDir = false } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Plan must be an object');
  hasOnlyKeys(plan, new Set(['version', 'projectDir', 'marketplaces', 'plugins', 'userScopeConfirmed', 'settingsMerge']), 'Plan');
  if (plan.version !== 1) throw new Error('Plan version must be 1');
  if (!isAbsolutePath(plan.projectDir)) throw new Error('Plan projectDir must be an absolute path');
  if (checkProjectDir && (!fs.existsSync(plan.projectDir) || !fs.statSync(plan.projectDir).isDirectory())) {
    throw new Error(`Plan projectDir is not a directory: ${plan.projectDir}`);
  }
  if (!Array.isArray(plan.marketplaces)) throw new Error('Plan marketplaces must be an array');
  if (!Array.isArray(plan.plugins)) throw new Error('Plan plugins must be an array');
  if (plan.userScopeConfirmed !== undefined && typeof plan.userScopeConfirmed !== 'boolean') {
    throw new Error('Plan userScopeConfirmed must be a boolean');
  }
  if (plan.settingsMerge !== undefined && (!plan.settingsMerge || typeof plan.settingsMerge !== 'object' || Array.isArray(plan.settingsMerge))) {
    throw new Error('Plan settingsMerge must be an object');
  }

  const marketplaceNames = new Set();
  for (const marketplace of plan.marketplaces) {
    if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace)) throw new Error('Each marketplace must be an object');
    hasOnlyKeys(marketplace, new Set(['name', 'source']), 'Marketplace');
    if (typeof marketplace.name !== 'string' || typeof marketplace.source !== 'string') throw new Error('Marketplace name and source must be strings');
    if (KNOWN_MARKETPLACES.get(marketplace.name) !== marketplace.source) {
      throw new Error(`Marketplace is not an approved portable source: ${marketplace.name}`);
    }
    if (IMPLICIT_MARKETPLACES.has(marketplace.name)) throw new Error(`Marketplace is implicit and must not be added: ${marketplace.name}`);
    if (marketplaceNames.has(marketplace.name)) throw new Error(`Marketplace appears more than once: ${marketplace.name}`);
    marketplaceNames.add(marketplace.name);
  }

  const pluginIds = new Set();
  for (const plugin of plan.plugins) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) throw new Error('Each plugin must be an object');
    hasOnlyKeys(plugin, new Set(['id', 'scope', 'role', 'preflight']), 'Plugin');
    if (typeof plugin.id !== 'string' || !PLUGIN_ID.test(plugin.id)) throw new Error(`Plugin id is invalid: ${plugin.id}`);
    if (!ALLOWED_SCOPES.has(plugin.scope)) throw new Error(`Plugin has unsupported scope: ${plugin.scope}`);
    if (plugin.scope === 'user' && plan.userScopeConfirmed !== true) throw new Error(`User-scope plugin needs userScopeConfirmed: ${plugin.id}`);
    if (plugin.role !== undefined && plugin.role !== 'core' && plugin.role !== 'optional') throw new Error(`Plugin has unsupported role: ${plugin.role}`);
    if (plugin.preflight !== undefined && !Array.isArray(plugin.preflight)) throw new Error(`Plugin preflight must be an array: ${plugin.id}`);
    const marketplace = plugin.id.slice(plugin.id.lastIndexOf('@') + 1);
    if (!marketplaceNames.has(marketplace) && !IMPLICIT_MARKETPLACES.has(marketplace)) {
      throw new Error(`Plugin references an undeclared marketplace: ${plugin.id}`);
    }
    if (pluginIds.has(plugin.id)) throw new Error(`Plugin appears more than once: ${plugin.id}`);
    pluginIds.add(plugin.id);
  }

  return plan;
}

function marketplaceSource(entry) {
  if (entry?.source === 'github') return entry.repo;
  if (entry?.source === 'git') return entry.url;
  return entry?.path;
}

function projectMatches(plugin, projectDir) {
  if (plugin.scope === 'user') return true;
  return normalizeProjectPath(plugin.projectPath) === normalizeProjectPath(projectDir);
}

function computeDelta(plan, marketplaces, plugins) {
  validatePlan(plan);
  if (!Array.isArray(marketplaces)) throw new Error('Marketplace inventory must be an array');
  if (!Array.isArray(plugins)) throw new Error('Plugin inventory must be an array');

  const marketplaceDelta = plan.marketplaces.map((planned) => {
    const installed = marketplaces.find((marketplace) => marketplace?.name === planned.name);
    if (!installed) return { ...planned, status: 'missing' };
    if (marketplaceSource(installed) && marketplaceSource(installed) !== planned.source) {
      return { ...planned, status: 'source-mismatch', actualSource: marketplaceSource(installed) };
    }
    return { ...planned, status: 'skipped' };
  });

  const pluginDelta = plan.plugins.map((planned) => {
    const matching = plugins.filter((plugin) => plugin?.id === planned.id);
    const correct = matching.find((plugin) => plugin.scope === planned.scope && projectMatches(plugin, plan.projectDir));
    if (correct && correct.enabled !== false) return { ...planned, status: 'skipped' };
    if (correct) return { ...planned, status: 'disabled' };
    if (matching.length > 0) return { ...planned, status: 'scope-mismatch' };
    return { ...planned, status: 'missing' };
  });

  return { marketplaces: marketplaceDelta, plugins: pluginDelta };
}

function commandText(command) {
  return [command.command, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

function marketplaceListCommand(claude) {
  return { command: claude, args: ['plugin', 'marketplace', 'list', '--json'], label: 'marketplace inventory' };
}

function pluginListCommand(claude, projectDir) {
  return { command: claude, args: ['plugin', 'list', '--json'], cwd: projectDir, label: 'plugin inventory' };
}

function marketplaceAddCommand(marketplace, claude, projectDir) {
  return {
    command: claude,
    args: ['plugin', 'marketplace', 'add', marketplace.source, '--scope', 'project'],
    cwd: projectDir,
    label: `${marketplace.name} marketplace`,
  };
}

function pluginInstallCommand(plugin, claude, projectDir) {
  return {
    command: claude,
    args: ['plugin', 'install', plugin.id, '--scope', plugin.scope],
    cwd: plugin.scope === 'user' ? undefined : projectDir,
    label: `${plugin.id} (${plugin.scope})`,
  };
}

function defaultRun(command) {
  const result = childProcess.spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    shell: false,
  });
  return {
    ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
    error: result.error?.message,
    status: result.status,
  };
}

function runCommand(command, run, steps) {
  const result = run(command);
  const step = {
    label: command.label,
    command: commandText(command),
    cwd: command.cwd,
    status: result.ok ? 'ok' : 'failed',
    output: result.ok ? undefined : (result.output ?? ''),
    error: result.error,
  };
  steps.push(step);
  return { result, step };
}

function failedSummary(base, step, error) {
  return {
    ...base,
    ok: false,
    failure: {
      command: step?.command,
      output: step?.output || error,
      error,
    },
  };
}

function inventory(command, run, steps, errorMessage) {
  const { result, step } = runCommand(command, run, steps);
  if (!result.ok) return { step, error: errorMessage };
  try {
    const value = JSON.parse(result.output);
    if (!Array.isArray(value)) throw new Error('expected a JSON array');
    return { value, step };
  } catch (error) {
    step.status = 'failed';
    return { step, error: `${errorMessage}: ${error.message}` };
  }
}

function orderedPlugins(pluginDelta) {
  return [...pluginDelta].sort((left, right) => {
    const leftRole = left.role === 'optional' ? 1 : 0;
    const rightRole = right.role === 'optional' ? 1 : 0;
    return leftRole - rightRole;
  });
}

function runInstall({ plan, options = {}, run = defaultRun, report = () => {} }) {
  validatePlan(plan, { checkProjectDir: true });
  const settings = { claude: 'claude', dryRun: false, check: false, ...options };
  const steps = [];
  const base = { ok: true, dryRun: settings.dryRun, check: settings.check, steps, marketplaces: [], plugins: [], reloadRequired: false };

  const initialMarketplaces = inventory(marketplaceListCommand(settings.claude), run, steps, 'Could not read marketplace inventory');
  if (initialMarketplaces.error) return failedSummary(base, initialMarketplaces.step, initialMarketplaces.error);
  const initialPlugins = inventory(pluginListCommand(settings.claude, plan.projectDir), run, steps, 'Could not read plugin inventory');
  if (initialPlugins.error) return failedSummary(base, initialPlugins.step, initialPlugins.error);

  const delta = computeDelta(plan, initialMarketplaces.value, initialPlugins.value);
  base.marketplaces = delta.marketplaces;
  base.plugins = delta.plugins;
  const conflicts = [...delta.marketplaces.filter((item) => item.status === 'source-mismatch'), ...delta.plugins.filter((item) => item.status === 'scope-mismatch')];
  if (conflicts.length > 0) return failedSummary(base, null, `Plan conflicts with installed state: ${conflicts.map((item) => item.name ?? item.id).join(', ')}`);

  const mutations = [
    ...delta.marketplaces.filter((item) => item.status === 'missing').map((item) => marketplaceAddCommand(item, settings.claude, plan.projectDir)),
    ...orderedPlugins(delta.plugins).filter((item) => item.status === 'missing' || item.status === 'disabled').map((item) => pluginInstallCommand(item, settings.claude, plan.projectDir)),
  ];

  if (settings.check || settings.dryRun) {
    for (const command of mutations) {
      steps.push({ label: command.label, command: commandText(command), cwd: command.cwd, status: settings.check ? 'not-run' : 'dry-run', output: '' });
    }
    return base;
  }

  for (const marketplace of delta.marketplaces.filter((item) => item.status === 'missing')) {
    const { result, step } = runCommand(marketplaceAddCommand(marketplace, settings.claude, plan.projectDir), run, steps);
    if (!result.ok) return failedSummary(base, step, `Failed to add marketplace: ${marketplace.name}`);
  }

  if (delta.marketplaces.some((item) => item.status === 'missing')) {
    const verifiedMarketplaces = inventory(marketplaceListCommand(settings.claude), run, steps, 'Could not verify marketplace inventory');
    if (verifiedMarketplaces.error) return failedSummary(base, verifiedMarketplaces.step, verifiedMarketplaces.error);
    const verifiedDelta = computeDelta(plan, verifiedMarketplaces.value, initialPlugins.value);
    const missing = verifiedDelta.marketplaces.filter((item) => item.status !== 'skipped');
    if (missing.length > 0) return failedSummary(base, verifiedMarketplaces.step, `Marketplace verification failed: ${missing.map((item) => item.name).join(', ')}`);
  }

  for (const plugin of orderedPlugins(delta.plugins).filter((item) => item.status === 'missing' || item.status === 'disabled')) {
    const { result, step } = runCommand(pluginInstallCommand(plugin, settings.claude, plan.projectDir), run, steps);
    if (!result.ok) return failedSummary(base, step, `Failed to install plugin: ${plugin.id}`);
  }

  if (delta.plugins.some((item) => item.status === 'missing' || item.status === 'disabled')) {
    const verifiedPlugins = inventory(pluginListCommand(settings.claude, plan.projectDir), run, steps, 'Could not verify plugin inventory');
    if (verifiedPlugins.error) return failedSummary(base, verifiedPlugins.step, verifiedPlugins.error);
    const verifiedDelta = computeDelta(plan, initialMarketplaces.value, verifiedPlugins.value);
    const missing = verifiedDelta.plugins.filter((item) => item.status !== 'skipped');
    if (missing.length > 0) return failedSummary(base, verifiedPlugins.step, `Plugin verification failed: ${missing.map((item) => item.id).join(', ')}`);
  }

  base.reloadRequired = mutations.length > 0;
  base.installed = delta.plugins.filter((item) => item.status === 'missing' || item.status === 'disabled').map((item) => item.id);
  report(JSON.stringify(base));
  return base;
}

function readPlan(planFile) {
  return JSON.parse(fs.readFileSync(planFile, 'utf8'));
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = runInstall({ plan: readPlan(options.planFile), options, report: () => {} });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_SCOPES,
  IMPLICIT_MARKETPLACES,
  KNOWN_MARKETPLACES,
  commandText,
  computeDelta,
  defaultRun,
  marketplaceAddCommand,
  normalizeProjectPath,
  parseArgs,
  pluginInstallCommand,
  runInstall,
  validatePlan,
};
