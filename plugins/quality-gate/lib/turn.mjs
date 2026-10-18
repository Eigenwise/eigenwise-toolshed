import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { crapReport } from './crap.mjs';
import { projectRoot, trackedSources, filesChangedSince, readConfig, gateSettings, tryGit } from './crap-inputs.mjs';
import { definitionInventory, formatReuseSignal } from './reuse-signals.mjs';

function turnFiles(root, since, settings) {
  const files = [...new Set(trackedSources(root).concat(trackedSources(root, ['--others', '--exclude-standard'])))];
  const selected = files.filter((file) => !settings.exclude.some((pattern) => path.matchesGlob(file, pattern)));
  if (!since) return filesChangedSince(root, tryGit(root, ['rev-parse', '--verify', 'HEAD']), selected);
  const timestamp = Date.parse(since);
  if (!Number.isFinite(timestamp)) throw new Error('--since requires an ISO timestamp');
  return selected.filter((file) => fs.statSync(path.join(root, file)).mtimeMs > timestamp);
}

function turnBody(metric) {
  return { file: metric.relativePath, name: metric.name, cc: metric.complexity, state: metric.classification, verdict: metric.unverified ? 'unverified' : metric.crap >= 6 && metric.classification !== 'legacy-unchanged' ? 'fail' : 'pass' };
}

function turnSignal(signal) {
  return { kind: signal.kind === 'callers-open' ? 'open-callers' : signal.kind, file: signal.file, name: signal.name, detail: formatReuseSignal(signal) };
}

export async function turnReport(options) {
  const root = projectRoot(options.project ?? process.cwd());
  const { config } = readConfig(root);
  const files = turnFiles(root, options.since, gateSettings({}, config));
  const base = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
  const report = await crapReport({ project: root, base, ccOnly: true, files });
  const lcov = path.join(root, 'coverage/lcov.info');
  return { bodies: report.changedMetrics.map(turnBody), signals: report.signals.map(turnSignal), unverified: true, lcov: fs.existsSync(lcov) ? lcov : null };
}

export function inventoryText(root, budget = 2048) {
  assert.ok(Number.isSafeInteger(budget) && budget >= 0, '--bytes requires a nonnegative integer');
  const rows = definitionInventory(projectRoot(root)).map(({ name, file }) => `${name} ${file}\n`);
  let count = rows.length;
  let text = rows.join('');
  while (Buffer.byteLength(text) > budget && count > 0) {
    count -= 1;
    text = rows.slice(0, count).join('') + `… ${rows.length - count} more\n`;
  }
  return Buffer.byteLength(text) <= budget ? text : '';
}
