#!/usr/bin/env node
'use strict';

const { defaultDatabaseFile } = require('./observer.js');
const { DEFAULT_RETENTION_DAYS, openObservabilityStore } = require('../lib/observability/store.js');

function parseRetentionDays(value) {
  const retentionDays = Number(value);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error('--retention-days must be a positive integer.');
  }
  return retentionDays;
}

const HELP = `Usage: prune-observability.js [options]

Preview rows older than the retention window. Deletion requires --apply or --yes.

Options:
  --apply                    Delete matching rows. Destructive.
  --yes                      Alias for --apply. Destructive.
  --dry-run                  Preview matching rows without deleting them.
  --db <path>                SQLite database file.
  --format <text|json>       Output format (default: text).
  --retention-days <days>    Keep this many days of observations (default: ${DEFAULT_RETENTION_DAYS}).
  --help                     Show this help message.
`;

function parseArgs(argv) {
  const options = {
    databaseFile: defaultDatabaseFile(),
    dryRun: true,
    format: 'text',
    retentionDays: DEFAULT_RETENTION_DAYS,
  };
  let apply = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--apply' || argument === '--yes') { apply = true; continue; }
    if (argument === '--dry-run') { dryRun = true; continue; }
    if (argument === '--help') return { ...options, help: true };
    if (argument === '--db' && next) { options.databaseFile = next; index += 1; continue; }
    if (argument === '--format' && ['text', 'json'].includes(next)) { options.format = next; index += 1; continue; }
    if (argument === '--retention-days' && next) { options.retentionDays = parseRetentionDays(next); index += 1; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return { ...options, dryRun: !apply || dryRun };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(1)} ${unit}`;
  }
  return `${bytes} B`;
}

function formatResult(result) {
  const action = result.dryRun ? 'would remove' : 'removed';
  const reusableBytes = result.dryRun ? result.estimatedReclaimableBytes : result.reusableBytes;
  return [
    `Retention prune ${result.dryRun ? 'preview' : 'complete'}: ${action} observations before ${result.cutoff}.`,
    `observations: ${result.counts.observations}`,
    `measurements: ${result.counts.measurements}`,
    `links: ${result.counts.links}`,
    `dedupe records: ${result.counts.dedupe}`,
    `outbox records: ${result.counts.outbox}`,
    `${result.dryRun ? 'estimated reusable space' : 'reusable space'}: ${formatBytes(reusableBytes)}`,
    result.dryRun
      ? `SQLite keeps the ${formatBytes(result.databaseBytes)} database file size until VACUUM runs. Applying checks free disk space before attempting a full VACUUM, which can need roughly that much temporary space and blocks for about a minute per 2 GB.`
      : `Database file is now ${formatBytes(result.storage.databaseBytes)}.`,
    ...(result.sizePrune
      ? [`Over the ${formatBytes(result.storage.maxDatabaseBytes)} size cap, so the oldest ${result.sizePrune.days} day(s) were dropped as well: ${result.sizePrune.counts.observations} observations.`]
      : []),
    ...(result.dryRun ? ['Run again with --apply to permanently delete these rows.'] : []),
    '',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const store = openObservabilityStore(options.databaseFile, { readOnly: options.dryRun });
  try {
    const result = store.prune({
      ...options,
      reclaimFileSpace: !options.dryRun,
      maxSizePruneDays: Number.POSITIVE_INFINITY,
    });
    process.stdout.write(options.format === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : formatResult(result));
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Observability retention prune failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { formatResult, main, parseArgs };
