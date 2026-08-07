#!/usr/bin/env node
'use strict';

const { defaultDatabaseFile } = require('./observer.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { readSidequestBoard, defaultSidequestHome } = require('../lib/observability/board-cost.js');
const { buildTokenUsageReport, formatTokenUsageReport } = require('../lib/observability/report.js');

const HELP = `Usage: token-usage-report.js [options]

Print the local SQLite usage report.

Options:
  --db <path>              SQLite database file.
  --format <text|json>     Output format (default: text).
  --sidequest-home <path>  Sidequest data directory.
  --project <path>         Project directory for Sidequest costs.
  --since <timestamp>      Include usage at or after this ISO-8601 timestamp.
  --until <timestamp>      Include usage before this ISO-8601 timestamp.
  --compare-previous       Compare the selected window with the preceding window.
  --ledger                 Include the per-request ledger in text output.
  --help                   Show this help message.
`;

function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const options = {
    databaseFile: defaultDatabaseFile(),
    format: 'text',
    sidequestHome: defaultSidequestHome(env),
    projectPath: env.CLAUDE_PROJECT_DIR || cwd,
    includeLedger: false,
    comparePrevious: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--help') return { ...options, help: true };
    if (argument === '--db' && next) { options.databaseFile = next; index += 1; continue; }
    if (argument === '--format' && ['text', 'json'].includes(next)) { options.format = next; index += 1; continue; }
    if (argument === '--sidequest-home' && next) { options.sidequestHome = next; index += 1; continue; }
    if (argument === '--project' && next) { options.projectPath = next; index += 1; continue; }
    if (argument === '--since' && next) { options.since = next; index += 1; continue; }
    if (argument === '--until' && next) { options.until = next; index += 1; continue; }
    if (argument === '--compare-previous') { options.comparePrevious = true; continue; }
    if (argument === '--ledger') { options.includeLedger = true; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const store = openObservabilityStore(options.databaseFile);
  try {
    const board = readSidequestBoard({
      sidequestHome: options.sidequestHome,
      projectPath: options.projectPath,
    });
    const report = buildTokenUsageReport(store, {
      board,
      includeLedger: options.includeLedger || options.format === 'json',
      boardCost: {
        since: options.since,
        until: options.until,
        comparePrevious: options.comparePrevious,
      },
    });
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
