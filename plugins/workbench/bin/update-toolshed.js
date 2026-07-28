#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureStatuslineShim, statuslineCommand } = require('./setup-observability.js');

const GATEWAY_MARKETPLACE = 'eigenwise-toolshed';
const UPDATE_SCOPES = new Set(['user', 'project', 'local']);

function parseArgs(argv) {
  const options = { check: false, dryRun: false, claude: 'claude' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--claude') {
      options.claude = argv[index + 1];
      index += 1;
    } else if (arg === '--wiring-mode') {
      const mode = argv[index + 1];
      if (!['local', 'global'].includes(mode)) throw new Error('--wiring-mode requires local or global');
      options.wiringMode = mode;
      index += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.claude) throw new Error('--claude requires a command');
  return options;
}

function usage() {
  return `Usage: node update-toolshed.js [--check] [--dry-run] [--claude <command>] [--wiring-mode local|global]

Refreshes the eigenwise-toolshed marketplace, then updates every recorded Toolshed
plugin install at user, project, and local scope. Project and local installs run from
their recorded project directory so Claude Code updates the right scope.

  --check       Read installed versions and run model-gateway doctor without updating
  --dry-run     Print every command without running it
  --claude      Claude Code command to run (default: claude)
  --wiring-mode Switch Codex gateway wiring and migrate recorded projects`;
}

function registryPath(home = os.homedir()) {
  return path.join(home, '.claude', 'plugins', 'installed_plugins.json');
}

function readRegistry(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registryInstallEntries(registry) {
  if (!isRecord(registry)) throw new Error('Plugin registry root is not an object');
  if (!isRecord(registry.plugins)) throw new Error('Plugin registry has no plugins object');

  const entries = [];
  for (const [id, installs] of Object.entries(registry.plugins)) {
    if (!Array.isArray(installs)) throw new Error(`Plugin registry entry ${id} is not an install list`);
    installs.forEach((install, index) => {
      if (!isRecord(install)) throw new Error(`Plugin registry entry ${id}[${index}] is not an install object`);
      entries.push({ id, installs, install });
    });
  }
  return entries;
}

function isStaleAgentWorktreeInstall(install) {
  const projectPath = install.projectPath;
  return typeof projectPath === 'string'
    && /[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+[\\/]?$/i.test(projectPath)
    && !fs.existsSync(projectPath);
}

function registryBackupPath(file, date = new Date()) {
  return `${file}.${date.toISOString().replace(/[:.]/g, '-')}.bak`;
}

function reportAgentWorktreeEntries(entries, report, heading) {
  report(`${heading} ${entries.length} stale Sidequest agent worktree plugin registry install(s):`);
  for (const { id, install } of entries) report(`- ${id} (${install.scope ?? 'unknown'}, ${install.projectPath})`);
}

function cleanStaleAgentWorktreeInstalls(registryFile, registry, options, report) {
  const entries = registryInstallEntries(registry);
  const staleEntries = entries.filter(({ install }) => isStaleAgentWorktreeInstall(install));
  if (staleEntries.length === 0) return { entries: [], backupPath: null, cleaned: false };

  if (options.check) {
    reportAgentWorktreeEntries(staleEntries, report, 'Found');
    report('Registry cleanup was not run in check mode. Run /update-toolshed to remove these entries.');
    return { entries: staleEntries, backupPath: null, cleaned: false };
  }

  const backupPath = registryBackupPath(registryFile);
  if (options.dryRun) {
    reportAgentWorktreeEntries(staleEntries, report, 'Would remove');
    report(`Registry backup would be written to: ${backupPath}`);
    return { entries: staleEntries, backupPath, cleaned: false };
  }

  fs.copyFileSync(registryFile, backupPath);
  for (const [id, installs] of Object.entries(registry.plugins)) {
    const remaining = installs.filter((install) => !isStaleAgentWorktreeInstall(install));
    if (remaining.length === 0) delete registry.plugins[id];
    else registry.plugins[id] = remaining;
  }
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  reportAgentWorktreeEntries(staleEntries, report, 'Removed');
  report(`Registry backup: ${backupPath}`);
  return { entries: staleEntries, backupPath, cleaned: true };
}

function workbenchStatuslinePin(command) {
  return /[\\/]plugins[\\/]cache[\\/]eigenwise-toolshed[\\/]workbench[\\/][^\\/]+[\\/]bin[\\/]workbench-statusline\.js/i.test(String(command || ''));
}

function readSettings(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function writeSettings(filePath, settings) {
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function healStatusline(settings, fallbackStatusLine, command) {
  if (!workbenchStatuslinePin(settings?.statusLine?.command)) return { settings, healed: false, removed: false };
  const next = structuredClone(settings);
  if (fallbackStatusLine?.command && !workbenchStatuslinePin(fallbackStatusLine.command)) {
    delete next.statusLine;
    return { settings: next, healed: true, removed: true };
  }
  next.statusLine = { ...next.statusLine, type: 'command', command };
  return { settings: next, healed: true, removed: false };
}

function healStatuslineFile(filePath, fallbackStatusLine, command, dryRun) {
  const settings = readSettings(filePath);
  if (!settings) return { filePath, healed: false, removed: false };
  const result = healStatusline(settings, fallbackStatusLine, command);
  if (result.healed && !dryRun) writeSettings(filePath, result.settings);
  return { filePath, ...result };
}

function healStaleStatuslines(instances, options = {}) {
  const home = options.home || os.homedir();
  const command = statuslineCommand(home);
  const userSettingsPath = path.join(home, '.claude', 'settings.json');
  const user = healStatuslineFile(userSettingsPath, null, command, options.dryRun);
  const userStatusLine = user.settings?.statusLine;
  const projects = [...new Set(instances.map((instance) => instance.projectPath).filter(Boolean))];
  const results = [user];
  for (const projectPath of projects) {
    const claudeDir = path.join(projectPath, '.claude');
    const legacy = healStatuslineFile(path.join(claudeDir, 'settings.json'), userStatusLine, command, options.dryRun);
    const local = healStatuslineFile(path.join(claudeDir, 'settings.local.json'), legacy.settings?.statusLine || userStatusLine, command, options.dryRun);
    results.push(legacy, local);
  }
  if (results.some((result) => result.healed) && !options.dryRun) ensureStatuslineShim(home);
  return results.filter((result) => result.healed);
}

function pluginIdParts(id) {
  const index = String(id).lastIndexOf('@');
  return index > 0 ? { name: id.slice(0, index), marketplace: id.slice(index + 1) } : null;
}

function installedPlugins(registry) {
  const instances = [];

  for (const [id, installs] of Object.entries(registry?.plugins ?? {})) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!UPDATE_SCOPES.has(install?.scope) || !pluginIdParts(id)) continue;
      instances.push({ id, ...install });
    }
  }

  return instances.sort((left, right) => {
    const leftParts = pluginIdParts(left.id);
    const rightParts = pluginIdParts(right.id);
    const leftProject = left.projectPath ?? '';
    const rightProject = right.projectPath ?? '';
    return leftParts.marketplace.localeCompare(rightParts.marketplace)
      || left.id.localeCompare(right.id)
      || left.scope.localeCompare(right.scope)
      || leftProject.localeCompare(rightProject);
  });
}

function toolshedPlugins(registry) {
  return installedPlugins(registry).filter((instance) => pluginIdParts(instance.id)?.marketplace === GATEWAY_MARKETPLACE);
}

function isStaleProjectInstance(instance) {
  return instance.scope !== 'user' && Boolean(instance.projectPath) && !fs.existsSync(instance.projectPath);
}

function staleProjectInstances(instances) {
  return instances.filter(isStaleProjectInstance);
}

function activeProjectInstances(instances) {
  return instances.filter((instance) => !isStaleProjectInstance(instance));
}

function reportStaleProjectInstances(instances, report) {
  if (instances.length === 0) return;
  report(`Skipped ${instances.length} stale project install(s): directory no longer exists:`);
  for (const instance of instances) report(`- ${instance.id} (${instance.scope}, ${instance.projectPath})`);
  report('The plugin registry was left unchanged. Remove stale entries from /plugin if you no longer need them.');
}

function installKey(instance) {
  return [instance.id, instance.scope, instance.projectPath ?? ''].join('\u0000');
}

function versionTransitions(before, after) {
  const prior = new Map(before.map((instance) => [installKey(instance), instance.version ?? 'unknown']));
  return after.flatMap((instance) => {
    const from = prior.get(installKey(instance));
    const to = instance.version ?? 'unknown';
    return from && from !== to ? [{ instance, from, to }] : [];
  });
}

function reportVersionTransitions(transitions, report) {
  if (transitions.length === 0) {
    report('Toolshed version transitions: none recorded.');
    return;
  }
  report('Toolshed version transitions:');
  for (const { instance, from, to } of transitions) {
    report(`- ${instance.id} ${from} -> ${to} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`);
  }
  report('Release notes are not stored in Claude Code\'s installed-plugin registry, so this updater cannot reliably list commit subjects for these transitions. Add release notes to the marketplace metadata to make that available here.');
}

function marketplacesFor(registryOrInstances) {
  const ids = Array.isArray(registryOrInstances)
    ? registryOrInstances.map((instance) => instance.id)
    : Object.keys(registryOrInstances?.plugins ?? {});
  return [...new Set(ids.map((id) => pluginIdParts(id)?.marketplace).filter(Boolean))].sort();
}

function updateCommand(instance, claude) {
  return {
    command: claude,
    args: ['plugin', 'update', instance.id, '--scope', instance.scope],
    cwd: instance.scope === 'user' ? undefined : instance.projectPath,
    label: `${instance.id} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`,
  };
}

function marketplaceCommand(marketplace, claude) {
  return {
    command: claude,
    args: ['plugin', 'marketplace', 'update', marketplace],
    label: `${marketplace} marketplace`,
  };
}

function gatewayCommand(instances, action) {
  const gateways = activeProjectInstances(instances).filter((instance) => instance.id === `model-gateway@${GATEWAY_MARKETPLACE}` && instance.installPath);
  if (gateways.length === 0) return null;

  const newest = gateways.sort((left, right) => String(right.lastUpdated ?? '').localeCompare(String(left.lastUpdated ?? '')))[0];
  return {
    command: process.execPath,
    args: [path.join(newest.installPath, 'bin', 'model-gateway.js'), action],
    cwd: newest.scope === 'user' ? undefined : newest.projectPath,
    label: `model-gateway ${action}`,
  };
}

function gatewayWiringMode(home = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'wiring.json'), 'utf8')).mode === 'global'
      ? 'global'
      : 'local';
  } catch { return 'local'; }
}

function hasGatewayWiringMode(home = os.homedir()) {
  try {
    return ['local', 'global'].includes(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'model-gateway', 'wiring.json'), 'utf8')).mode);
  } catch { return false; }
}

function setGatewayWiringMode(home, mode) {
  const file = path.join(home, '.claude', 'model-gateway', 'wiring.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mode }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function gatewayWiringCommand(instances, scope, projectPath, remove = false) {
  const gateway = gatewayCommand(instances, 'env');
  if (!gateway) return null;
  return {
    ...gateway,
    args: [...gateway.args, scope === 'project' ? '--write-project' : '--write-user', ...(remove ? ['--remove'] : [])],
    cwd: scope === 'project' ? projectPath : undefined,
    label: remove ? 'model-gateway remove legacy global wiring' : `model-gateway wire ${scope}${projectPath ? ` (${projectPath})` : ''}`,
  };
}

function recordedProjects(instances) {
  return [...new Set(activeProjectInstances(instances).map((instance) => instance.projectPath).filter(Boolean))];
}

function healGatewayWiring(instances, options, run, report) {
  const mode = options.wiringMode ?? gatewayWiringMode(options.home);
  const projects = recordedProjects(instances);
  if (mode === 'global') {
    const command = gatewayWiringCommand(instances, 'user');
    if (!command) return { mode, results: [], failures: [] };
    const ok = execute(command, options, run, report);
    if (ok) {
      report('Global gateway wiring applies to new Claude Code sessions. Restart open sessions.');
      if (projects.length > 0) report(`Existing per-project blocks remain in ${projects.length} recorded project(s); they are redundant while global mode is active.`);
    }
    return { mode, results: [command], failures: ok ? [] : [command.label] };
  }

  if (projects.length === 0) {
    report('Gateway local wiring: no recorded projects found. Legacy global wiring was left in place. Wire a new project with: model-gateway env --write-project');
    return { mode, results: [], failures: [] };
  }

  const results = [];
  const failures = [];
  for (const projectPath of projects) {
    const command = gatewayWiringCommand(instances, 'project', projectPath);
    if (!command) continue;
    results.push(command);
    if (!execute(command, options, run, report)) failures.push(command.label);
  }
  if (failures.length > 0) {
    report('Gateway local wiring kept legacy global settings because one or more recorded projects could not be wired.');
    return { mode, results, failures };
  }

  const remove = gatewayWiringCommand(instances, 'user', undefined, true);
  if (remove) {
    results.push(remove);
    if (!execute(remove, options, run, report)) failures.push(remove.label);
  }
  if (failures.length === 0) report('Gateway local wiring applies to new Claude Code sessions. Restart open sessions.');
  return { mode, results, failures };
}

function commandText(command) {
  return [command.command, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

function defaultRun(command) {
  const result = childProcess.spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

  return {
    ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
    error: result.error?.message,
  };
}

function reloadAdvice(instances) {
  const projects = [...new Set(instances.map((instance) => instance.projectPath).filter(Boolean))];
  const lines = ['Reload required: every Claude Code session that had a plugin loaded before this run. Use /reload-plugins, or restart if reload does not pick up the new version.'];
  if (instances.some((instance) => instance.scope === 'user')) lines.push('User scope: reload every open Claude Code session.');
  for (const project of projects) lines.push(`Project/local scope: reload sessions open in ${project}.`);
  return lines;
}

function execute(command, options, run, report) {
  report(`\n${command.label}\n  ${commandText(command)}${command.cwd ? `\n  cwd: ${command.cwd}` : ''}`);
  if (options.dryRun) return true;

  const result = run(command);
  if (result.output) report(result.output);
  if (result.ok) return true;
  report(`FAILED: ${result.error ?? 'command exited unsuccessfully'}`);
  return false;
}

function runUpdate({ registryFile = registryPath(), home = os.homedir(), options, run = defaultRun, report = console.log }) {
  const modeWasConfigured = hasGatewayWiringMode(home);
  if (options.wiringMode && !options.check && !options.dryRun) setGatewayWiringMode(home, options.wiringMode);
  let registry;
  try {
    registry = readRegistry(registryFile);
    registryInstallEntries(registry);
  } catch (error) {
    report(`Registry GC skipped: ${error.message}. Registry was left unchanged.`);
    throw error;
  }
  const registryGc = cleanStaleAgentWorktreeInstalls(registryFile, registry, options, report);
  let instances = toolshedPlugins(registry);
  const staleInstances = staleProjectInstances(instances).filter((instance) => !isStaleAgentWorktreeInstall(instance));
  instances = activeProjectInstances(instances);
  const beforeUpdate = instances;

  reportStaleProjectInstances(staleInstances, report);
  if (instances.length === 0) {
    report(`No active user, project, or local Toolshed plugin installs found in ${registryFile}.`);
    return { ok: true, instances, staleInstances, registryGc, failures: [] };
  }

  const marketplaces = marketplacesFor(instances);
  report(`Found ${instances.length} Toolshed plugin install(s) from ${marketplaces.length} marketplace(s):`);
  for (const instance of instances) report(`- ${instance.id} ${instance.version ?? 'unknown'} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`);
  report('Other marketplaces are managed by Claude Code auto-update — not touched.');
  if (!modeWasConfigured && !options.wiringMode) report('Wiring mode defaulted to per-project; run /workbench:update-toolshed --wiring-mode global to change.');
  if (options.wiringMode) report(`Wiring mode ${options.dryRun || options.check ? 'would switch' : 'switched'} to ${options.wiringMode}.`);

  const failures = [];
  if (!options.check) {
    for (const marketplace of marketplaces) {
      const command = marketplaceCommand(marketplace, options.claude);
      if (!execute(command, options, run, report)) failures.push(command.label);
    }

    for (const instance of instances) {
      const command = updateCommand(instance, options.claude);
      if (!execute(command, options, run, report)) failures.push(command.label);
    }

    if (!options.dryRun) {
      instances = activeProjectInstances(toolshedPlugins(readRegistry(registryFile)));
      reportVersionTransitions(versionTransitions(beforeUpdate, instances), report);
    } else {
      report('Dry run cannot know version targets until Claude Code refreshes the marketplace. It will print the gateway restart warning before it would run setup.');
    }
  } else {
    report('\nCheck mode does not refresh marketplaces or update plugins. Claude Code normally checks plugin updates after session start with up to a 10-minute delay when marketplace auto-update is enabled.');
    report('Check mode reports installed versions only. It cannot determine available version transitions or release notes without refreshing the marketplace.');
  }

  const gatewayAction = options.check ? 'doctor' : 'setup';
  const gateway = gatewayCommand(instances, gatewayAction);
  if (gateway && !options.check) {
    report('Gateway restart warning: this run will restart the gateway worker while its listener stays available. Live Claude Code sessions using Codex stay connected; in-flight requests drain or retry. The authenticated proxy stays running unless its binary changed.');
  }
  let gatewaySetupOk = true;
  if (gateway) {
    gatewaySetupOk = execute(gateway, options, run, report);
    if (!gatewaySetupOk) failures.push(gateway.label);
  }

  let healedGatewayWiring = { mode: gatewayWiringMode(home), results: [], failures: [] };
  if (!options.check && gateway && gatewaySetupOk) {
    healedGatewayWiring = healGatewayWiring(instances, { ...options, home }, run, report);
    failures.push(...healedGatewayWiring.failures);
  }

  if (gateway && !options.dryRun && !options.check && gatewaySetupOk) {
    const doctor = gatewayCommand(instances, 'doctor');
    if (doctor && !execute(doctor, options, run, report)) failures.push(doctor.label);
  }

  const healedStatuslines = options.check ? [] : healStaleStatuslines(instances, { home, dryRun: options.dryRun });
  if (healedStatuslines.length > 0) {
    report(`Healed ${healedStatuslines.length} stale Workbench status line setting(s).`);
  }

  for (const line of reloadAdvice(instances)) report(line);
  if (failures.length > 0) report(`\nCompleted with ${failures.length} failure(s): ${failures.join(', ')}`);
  else report('\nCompleted successfully.');
  return { ok: failures.length === 0, instances, staleInstances, registryGc, failures, healedGatewayWiring, healedStatuslines };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const result = runUpdate({ options });
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Toolshed update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  GATEWAY_MARKETPLACE,
  gatewayCommand,
  gatewayWiringCommand,
  gatewayWiringMode,
  hasGatewayWiringMode,
  setGatewayWiringMode,
  healGatewayWiring,
  healStaleStatuslines,
  healStatusline,
  installedPlugins,
  marketplaceCommand,
  marketplacesFor,
  parseArgs,
  registryPath,
  runUpdate,
  toolshedPlugins,
  updateCommand,
  workbenchStatuslinePin,
};
