#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH_ID = 'workbench@eigenwise-toolshed';
const MIGRATION_NOTICE = 'workspace-init moved into the Workbench plugin: run /plugin install workbench@eigenwise-toolshed --scope user, reload, then uninstall workspace-init and toolshed-guard';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function hasUserWorkbench(registry) {
  return registry?.plugins?.[WORKBENCH_ID]?.some((plugin) => plugin.scope === 'user') === true;
}

function migrationNotice(registry) {
  return hasUserWorkbench(registry) ? '' : MIGRATION_NOTICE;
}

function main() {
  const registry = readJson(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  const message = migrationNotice(registry);
  if (message) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message } }));
}

if (require.main === module) main();

module.exports = { MIGRATION_NOTICE, hasUserWorkbench, migrationNotice };
