#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATEWAY_MARKETPLACE = 'eigenwise-toolshed';
const OBSERVABILITY_PLUGIN = 'observability@eigenwise-toolshed';
const LEGACY_GATEWAY_PLUGIN = `codex-gateway@${GATEWAY_MARKETPLACE}`;
const MODEL_GATEWAY_PLUGIN = `model-gateway@${GATEWAY_MARKETPLACE}`;
const UPDATE_SCOPES = new Set(['user', 'project', 'local']);

function parseArgs(argv) {
  const options = { check: false, dryRun: false, claude: 'claude' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--migrate-model-gateway') options.migrateModelGateway = true;
    else if (arg === '--confirm-sessions-closed') options.confirmSessionsClosed = true;
    else if (arg === '--claude') {
      options.claude = argv[index + 1];
      index += 1;
    } else if (arg === '--wiring-mode') {
      throw new Error('--wiring-mode was removed: model gateway wiring is global only');
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.claude) throw new Error('--claude requires a command');
  return options;
}

function usage() {
  return `Usage: node update-toolshed.js [--check] [--dry-run] [--claude <command>]

Refreshes the eigenwise-toolshed marketplace, then updates every recorded Toolshed
plugin install at user, project, and local scope. Project and local installs run from
their recorded project directory so Claude Code updates the right scope.

  --check       Read installed versions and run model-gateway doctor without updating
  --dry-run     Print every command without running it
  --migrate-model-gateway
                Migrate the retired codex-gateway install after every Claude Code session is closed
  --confirm-sessions-closed
                Required with --migrate-model-gateway because migration moves shared gateway state
  --claude      Claude Code command to run (default: claude)`;
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

// The statusline belongs to the observability plugin. Resolve its setup module from
// the install registry rather than importing it, so Workbench keeps working for the
// people who never installed observability.
function observabilitySetup(home) {
  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return null; }
  const installs = registry?.plugins?.[OBSERVABILITY_PLUGIN];
  if (!Array.isArray(installs)) return null;
  for (const install of installs) {
    if (!install?.installPath) continue;
    const script = path.join(install.installPath, 'bin', 'setup-observability.js');
    if (fs.existsSync(script)) {
      try { return require(script); } catch { return null; }
    }
  }
  return null;
}

function healStaleStatuslines(instances, options = {}) {
  const home = options.home || os.homedir();
  const setup = options.observabilitySetup || observabilitySetup(home);
  if (!setup) return [];
  const { ensureStatuslineShim, statuslineCommand } = setup;
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

function legacyGatewayInstances(instances) {
  return instances.filter((instance) => instance.id === LEGACY_GATEWAY_PLUGIN);
}

function modelGatewayInstances(instances) {
  return instances.filter((instance) => instance.id === MODEL_GATEWAY_PLUGIN);
}

function matchingInstall(instance, candidates) {
  return candidates.some((candidate) => candidate.scope === instance.scope && candidate.projectPath === instance.projectPath);
}

function gatewayMigrationInstruction() {
  return `Migration required: codex-gateway was renamed to model-gateway. Close every Claude Code session using Codex, then run from a terminal:\n  node "${__filename}" --migrate-model-gateway --confirm-sessions-closed\nThis installs model-gateway at the legacy scopes, moves only ~/.claude/codex-gateway state, starts and verifies the new gateway, then retires the legacy registry entries. The normal updater will not run stale codex-gateway setup or wiring.`;
}

function moveLegacyGatewayState(home, options) {
  const legacyState = path.join(home, '.claude', 'codex-gateway');
  const modelState = path.join(home, '.claude', 'model-gateway');
  if (!fs.existsSync(legacyState)) return { moved: false, legacyState, modelState };
  if (fs.existsSync(modelState)) {
    throw new Error(`Refusing to merge legacy gateway state into existing ${modelState}. Move it aside after checking it, then retry the migration.`);
  }
  if (!options.dryRun) fs.renameSync(legacyState, modelState);
  return { moved: true, legacyState, modelState };
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

function installModelGatewayCommand(instance, claude) {
  return {
    command: claude,
    args: ['plugin', 'install', MODEL_GATEWAY_PLUGIN, '--scope', instance.scope],
    cwd: instance.scope === 'user' ? undefined : instance.projectPath,
    label: `${MODEL_GATEWAY_PLUGIN} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`,
  };
}

function retireLegacyGatewayCommand(instance, claude) {
  return {
    command: claude,
    args: ['plugin', 'uninstall', LEGACY_GATEWAY_PLUGIN, '--scope', instance.scope],
    cwd: instance.scope === 'user' ? undefined : instance.projectPath,
    label: `retire ${LEGACY_GATEWAY_PLUGIN} (${instance.scope}${instance.projectPath ? `, ${instance.projectPath}` : ''})`,
  };
}

function marketplaceCommand(marketplace, claude) {
  return {
    command: claude,
    args: ['plugin', 'marketplace', 'update', marketplace],
    label: `${marketplace} marketplace`,
  };
}

function gatewayUpdateCommand(home = os.homedir()) {
  return {
    command: process.execPath,
    args: [path.join(home, '.claude', 'model-gateway', 'update.js')],
    label: 'model-gateway update',
  };
}

function installGatewayUpdateLauncher(instances, home = os.homedir()) {
  const gateways = activeProjectInstances(instances)
    .filter((instance) => instance.id === MODEL_GATEWAY_PLUGIN && instance.installPath)
    .sort((left, right) => String(right.version || '').localeCompare(String(left.version || ''))
      || String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || '')));
  const writer = gateways.length > 0 && path.join(gateways[0].installPath, 'hooks', 'registry-writer.js');
  if (!writer || !fs.existsSync(writer)) return { written: true, skipped: true };
  const { writeUpdateLauncher } = require(writer);
  return writeUpdateLauncher({ home });
}

function gatewayCommand(instances, action) {
  const gateways = activeProjectInstances(instances).filter((instance) => instance.id === MODEL_GATEWAY_PLUGIN && instance.installPath);
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

function gatewayWiringCommand(instances, projectPath) {
  const gateway = gatewayCommand(instances, 'env');
  if (!gateway) return null;
  return {
    ...gateway,
    args: [...gateway.args, '--write-user', '--reconcile'],
    cwd: projectPath,
    label: `model-gateway wire global${projectPath ? ` (reconciling ${projectPath})` : ''}`,
  };
}

function recordedProjects(instances) {
  return [...new Set(activeProjectInstances(instances).map((instance) => instance.projectPath).filter(Boolean))];
}

function healGatewayWiring(instances, options, run, report) {
  const mode = 'global';
  const projects = recordedProjects(instances);
  const results = [];
  const failures = [];

  // Recorded projects first, so any stale per-project block is recorded and then
  // cleared; the final pass covers the case where there are no projects at all.
  for (const projectPath of [...projects, undefined]) {
    const command = gatewayWiringCommand(instances, projectPath);
    if (!command) break;
    results.push(command);
    if (!execute(command, options, run, report)) failures.push(command.label);
  }

  if (failures.length > 0) {
    report('Gateway wiring did not finish. Per-project ANTHROPIC_BASE_URL blocks may still shadow the global setting; run model-gateway remote-control doctor to see which file wins.');
    return { mode, results, failures };
  }
  report('Global gateway wiring applies to new Claude Code sessions. Restart open sessions.');
  if (projects.length > 0) report(`Reconciled model-gateway-owned wiring across ${projects.length} recorded project(s).`);
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

function runModelGatewayMigration({ registryFile = registryPath(), home = os.homedir(), options, run = defaultRun, report = console.log }) {
  if (!options.confirmSessionsClosed) {
    report('Migration stopped: close every Claude Code session using Codex, then retry with --confirm-sessions-closed. The migration will not stop the shared gateway for you.');
    return { ok: false, failures: ['model-gateway migration confirmation required'] };
  }

  const registry = readRegistry(registryFile);
  registryInstallEntries(registry);
  const legacy = activeProjectInstances(legacyGatewayInstances(toolshedPlugins(registry)));
  if (legacy.length === 0) {
    report('model-gateway migration is not needed: no active codex-gateway install remains.');
    return { ok: true, failures: [] };
  }

  const failures = [];
  for (const instance of legacy) {
    const command = installModelGatewayCommand(instance, options.claude);
    if (!execute(command, options, run, report)) failures.push(command.label);
  }
  if (failures.length > 0) {
    report(`Migration stopped before changing gateway state because ${failures.length} model-gateway install(s) failed.`);
    return { ok: false, failures };
  }
  if (options.dryRun) {
    report(`Would move gateway-owned state from ${path.join(home, '.claude', 'codex-gateway')} to ${path.join(home, '.claude', 'model-gateway')}, then run model-gateway setup, ensure, doctor, and retire codex-gateway.`);
    return { ok: true, failures: [] };
  }

  const updated = toolshedPlugins(readRegistry(registryFile));
  const gateways = modelGatewayInstances(updated);
  const missing = legacy.filter((instance) => !matchingInstall(instance, gateways));
  if (missing.length > 0) {
    report('Migration stopped before changing gateway state because Claude Code did not record every new model-gateway install.');
    return { ok: false, failures: ['model-gateway install missing from registry'] };
  }

  try {
    const state = moveLegacyGatewayState(home, options);
    if (state.moved) report(`Moved gateway-owned state to ${state.modelState}.`);
  } catch (error) {
    report(`Migration stopped: ${error.message}`);
    return { ok: false, failures: ['gateway state move failed'] };
  }

  for (const action of ['setup', 'ensure', 'doctor']) {
    const command = gatewayCommand(gateways, action);
    if (!command || !execute(command, options, run, report)) failures.push(`model-gateway ${action}`);
  }
  if (failures.length === 0) {
    const wiring = healGatewayWiring(updated, { ...options, home }, run, report);
    failures.push(...wiring.failures);
  }
  if (failures.length > 0) {
    report('Migration kept the legacy registry entries because the new gateway did not finish setup, verification, and wiring.');
    return { ok: false, failures };
  }

  for (const instance of legacy) {
    const command = retireLegacyGatewayCommand(instance, options.claude);
    if (!execute(command, options, run, report)) failures.push(command.label);
  }
  if (failures.length > 0) {
    report('Migration verified model-gateway, but one or more legacy registry entries could not be retired. Retry the migration after resolving those failures.');
    return { ok: false, failures };
  }

  report('model-gateway migration completed. Start a new Claude Code session, then use /reload-plugins if the model picker is still stale.');
  return { ok: true, failures: [] };
}

function runUpdate({ registryFile = registryPath(), home = os.homedir(), options, run = defaultRun, report = console.log, installGatewayLauncher = installGatewayUpdateLauncher }) {
  let registry;
  try {
    registry = readRegistry(registryFile);
    registryInstallEntries(registry);
  } catch (error) {
    report(`Registry GC skipped: ${error.message}. Registry was left unchanged.`);
    throw error;
  }
  const legacyGateways = legacyGatewayInstances(toolshedPlugins(registry));
  if (legacyGateways.length > 0) {
    report(gatewayMigrationInstruction());
    return {
      ok: false,
      instances: toolshedPlugins(registry),
      staleInstances: [],
      registryGc: { entries: [], backupPath: null, cleaned: false },
      failures: ['model-gateway migration required'],
      migrationRequired: true,
    };
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

  const gateways = modelGatewayInstances(instances);
  const gateway = gateways.length > 0 ? (options.check ? gatewayCommand(instances, 'doctor') : gatewayUpdateCommand(home)) : null;
  let gatewaySetupOk = true;
  if (gateway && !options.check && !options.dryRun) {
    const launcher = installGatewayLauncher(instances, home);
    if (!launcher.written) {
      gatewaySetupOk = false;
      failures.push(gateway.label);
      report(`FAILED: could not install the stable model-gateway updater (${launcher.reason || 'unknown reason'})`);
    }
  }
  if (gateway && !options.check) {
    report('Gateway update: the stable updater swaps the proxy by rename, keeps the running listener available until restart, and reports the resulting state.');
  }
  if (gateway && gatewaySetupOk) {
    gatewaySetupOk = execute(gateway, options, run, report);
    if (!gatewaySetupOk) failures.push(gateway.label);
  }

  let healedGatewayWiring = { mode: 'global', results: [], failures: [] };
  if (!options.check && gateway && gatewaySetupOk) {
    report('Gateway wiring is handled by the stable model-gateway updater.');
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
    const result = options.migrateModelGateway
      ? runModelGatewayMigration({ options })
      : runUpdate({ options });
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Toolshed update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  GATEWAY_MARKETPLACE,
  LEGACY_GATEWAY_PLUGIN,
  MODEL_GATEWAY_PLUGIN,
  gatewayCommand,
  gatewayUpdateCommand,
  installGatewayUpdateLauncher,
  gatewayMigrationInstruction,
  gatewayWiringCommand,
  healGatewayWiring,
  healStaleStatuslines,
  healStatusline,
  installedPlugins,
  marketplaceCommand,
  marketplacesFor,
  parseArgs,
  registryPath,
  runModelGatewayMigration,
  runUpdate,
  toolshedPlugins,
  updateCommand,
  workbenchStatuslinePin,
};
