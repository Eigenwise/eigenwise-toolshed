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
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.claude) throw new Error('--claude requires a command');
  return options;
}

function usage() {
  return `Usage: node update-toolshed.js [--check] [--dry-run] [--claude <command>]

Refreshes every marketplace that has an installed plugin, then updates every recorded
user, project, and local plugin install. Project and local installs run from their
recorded project directory so Claude Code updates the right scope.

  --check       Read installed versions and run codex-gateway doctor without updating
  --dry-run     Print every command without running it
  --claude      Claude Code command to run (default: claude)`;
}

function registryPath(home = os.homedir()) {
  return path.join(home, '.claude', 'plugins', 'installed_plugins.json');
}

function readRegistry(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const gateways = instances.filter((instance) => instance.id === `codex-gateway@${GATEWAY_MARKETPLACE}` && instance.installPath);
  if (gateways.length === 0) return null;

  const newest = gateways.sort((left, right) => String(right.lastUpdated ?? '').localeCompare(String(left.lastUpdated ?? '')))[0];
  return {
    command: process.execPath,
    args: [path.join(newest.installPath, 'bin', 'codex-gateway.js'), action],
    cwd: newest.scope === 'user' ? undefined : newest.projectPath,
    label: `codex-gateway ${action}`,
  };
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
  const registry = readRegistry(registryFile);
  let instances = installedPlugins(registry);

  if (instances.length === 0) {
    report(`No user, project, or local plugin installs found in ${registryFile}.`);
    return { ok: true, instances, failures: [] };
  }

  const marketplaces = marketplacesFor(registry);
  report(`Found ${instances.length} plugin install(s) from ${marketplaces.length} marketplace(s):`);
  for (const instance of instances) report(`- ${instance.id} ${instance.version ?? 'unknown'} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`);

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

    if (!options.dryRun) instances = installedPlugins(readRegistry(registryFile));
  } else {
    report('\nCheck mode does not refresh marketplaces or update plugins. Claude Code normally checks plugin updates after session start with up to a 10-minute delay when marketplace auto-update is enabled.');
  }

  const gatewayAction = options.check ? 'doctor' : 'setup';
  const gateway = gatewayCommand(instances, gatewayAction);
  if (gateway) {
    if (!execute(gateway, options, run, report)) failures.push(gateway.label);
    if (!options.dryRun && !options.check) {
      const doctor = gatewayCommand(instances, 'doctor');
      if (doctor && !execute(doctor, options, run, report)) failures.push(doctor.label);
    }
  }

  const healedStatuslines = options.check ? [] : healStaleStatuslines(instances, { home, dryRun: options.dryRun });
  if (healedStatuslines.length > 0) {
    report(`Healed ${healedStatuslines.length} stale Workbench status line setting(s).`);
  }

  for (const line of reloadAdvice(instances)) report(line);
  if (failures.length > 0) report(`\nCompleted with ${failures.length} failure(s): ${failures.join(', ')}`);
  else report('\nCompleted successfully.');
  return { ok: failures.length === 0, instances, failures, healedStatuslines };
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
  healStaleStatuslines,
  healStatusline,
  installedPlugins,
  marketplaceCommand,
  marketplacesFor,
  parseArgs,
  registryPath,
  runUpdate,
  updateCommand,
  workbenchStatuslinePin,
};
