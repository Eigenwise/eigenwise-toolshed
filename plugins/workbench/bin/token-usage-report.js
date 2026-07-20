#!/usr/bin/env node
'use strict';

const { defaultDatabaseFile } = require('./workbench-observer.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { readSidequestBoard, defaultSidequestHome } = require('../lib/observability/board-cost.js');
const { buildTokenUsageReport, formatTokenUsageReport } = require('../lib/observability/report.js');

function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const options = {
    databaseFile: defaultDatabaseFile(),
    format: 'text',
    sidequestHome: defaultSidequestHome(env),
    projectPath: env.CLAUDE_PROJECT_DIR || cwd,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--db' && next) { options.databaseFile = next; index += 1; continue; }
    if (argument === '--format' && ['text', 'json'].includes(next)) { options.format = next; index += 1; continue; }
    if (argument === '--sidequest-home' && next) { options.sidequestHome = next; index += 1; continue; }
    if (argument === '--project' && next) { options.projectPath = next; index += 1; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const store = openObservabilityStore(options.databaseFile);
  try {
    const board = readSidequestBoard({
      sidequestHome: options.sidequestHome,
      projectPath: options.projectPath,
    });
    const report = buildTokenUsageReport(store, { board });
    const output = options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatTokenUsageReport(report);
    process.stdout.write(output);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Token usage report failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
