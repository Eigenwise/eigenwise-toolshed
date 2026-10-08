import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAnalyzer, changedMetricsAgainstBase, normalizedPath, LEGACY_UNCHANGED } from './core.mjs';
import { crapScore, THRESHOLD } from './measure.mjs';
import { JAVASCRIPT_SOURCE, projectRoot, readConfig, gateSettings, selectedFiles, sourceHashes, baseRevision, runGit, tryGit } from './crap-inputs.mjs';
import { acquireCoverage, coverageByFile, coverageTrust, functionLineCoverage } from './lcov.mjs';
import { lizardDescriptors } from './lizard.mjs';

export const GATE_VERSION = 'crap-1';

function unsupportedDescriptor(text, file, reason) {
  return [{ identity: `<root>/unsupported:${file}#0`, parent: '<root>', name: file, line: 1, endLine: text.split('\n').length, complexity: null, fingerprint: crypto.createHash('sha256').update(text).digest('hex'), unverified: reason, informational: true }];
}

async function descriptors(text, file, analyzer, complexityCsv) {
  if (JAVASCRIPT_SOURCE.test(file)) return (await analyzer.collectFunctions(text, file)).map((descriptor) => ({ ...descriptor, endLine: text.slice(0, descriptor.end).split('\n').length, source: 'typescript-ast' }));
  if (file.endsWith('.py')) return unsupportedDescriptor(text, file, 'Python adapter not installed in this version');
  const rows = await lizardDescriptors(text, file, analyzer, complexityCsv);
  if (!rows.length) return unsupportedDescriptor(text, file, 'Lizard reported no functions; source definitions are unverified. Install a supported language adapter to verify this file.');
  return rows.map((row) => ({ ...row, informational: Boolean(row.unverified) }));
}

async function sourceMetrics(root, files, analyzer, complexityCsv) {
  return (await Promise.all(files.map(async (file) => (await descriptors(fs.readFileSync(path.resolve(root, file), 'utf8'), file, analyzer, complexityCsv)).map((descriptor) => ({ ...descriptor, relativePath: file }))))).flat();
}

function scoredMetric(metric, report, input, lines) {
  if (metric.unverified) return metric;
  if (report.ccOnly) return { ...metric, crap: metric.complexity, coverage: null };
  const unverified = coverageTrust(input, metric.relativePath, report.files[metric.relativePath]);
  if (unverified) return { ...metric, unverified };
  const siblings = report.metrics.filter((candidate) => candidate.relativePath === metric.relativePath);
  const measurement = functionLineCoverage(metric, siblings, new Map(lines.get(normalizedPath(path.resolve(report.root, metric.relativePath)))));
  if (measurement.unverified) return { ...metric, ...measurement };
  return { ...metric, ...measurement, crap: crapScore(metric.complexity, measurement.coverage) };
}

function verdict(report) {
  const enforced = report.changedMetrics.filter((metric) => metric.classification !== LEGACY_UNCHANGED && !metric.informational);
  report.failures = enforced.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD);
  report.unverified = report.changedMetrics.filter((metric) => metric.unverified);
  const blockingUnverified = enforced.some((metric) => metric.unverified);
  report.exitCode = Math.max(2 * Number(blockingUnverified), Number(report.failures.length > 0));
  report.verdict = ['passed', 'failed'][Number(report.failures.length > 0)];
  if (blockingUnverified) report.verdict = 'unverified';
  if (!report.changedMetrics.length) report.verdict = 'nothing to score';
  if (report.unverified.some((metric) => metric.informational)) report.verdict = 'unverified';
  return report;
}

function emptyScopeReason(files, metrics, changed) {
  if (!files.length) return 'No supported source files matched sources and exclude.';
  if (!metrics.length) return 'Selected files contain no runtime function bodies (type-only declarations are excluded).';
  if (!changed.length) return 'No function bodies changed against the base revision.';
  return null;
}

async function changedAgainstBase(report, analyzer) {
  if (!report.base) return report.metrics.map((metric) => ({ ...metric, classification: 'new' }));
  const readBaseline = async (base, file) => descriptors(runGit(report.root, ['show', `${base}:${file}`]), file, analyzer);
  return changedMetricsAgainstBase(report.metrics, Object.keys(report.files), report.base, readBaseline);
}

export async function crapReport(options = {}) {
  const root = projectRoot(options.project ?? process.cwd());
  const { config, warnings } = readConfig(root);
  const settings = gateSettings(options, config);
  const files = selectedFiles(root, settings);
  const analyzer = files.some((file) => JAVASCRIPT_SOURCE.test(file) || file.endsWith('.vue')) ? await createAnalyzer(root) : null;
  const complexityCsv = options.complexity ? fs.readFileSync(path.resolve(root, options.complexity), 'utf8') : undefined;
  const baseline = baseRevision(root, settings.base);
  const report = { root, base: baseline.base, files: sourceHashes(root, files), metrics: await sourceMetrics(root, files, analyzer, complexityCsv), ccOnly: Boolean(options.ccOnly), max: THRESHOLD, warnings: [...warnings, ...baseline.warnings] };
  if (settings.usedDeprecatedRatchet) report.warnings.push('--ratchet and config ratchet are deprecated. Use --base or config base instead.');
  report.changedMetrics = await changedAgainstBase(report, analyzer);
  report.nothingToScoreReason = emptyScopeReason(files, report.metrics, report.changedMetrics);
  return measureReport(report, settings);
}

function measureReport(report, settings) {
  const input = report.ccOnly || !report.changedMetrics.length ? null : acquireCoverage(report.root, settings, Object.keys(report.files));
  const lines = input ? coverageByFile(input.text, report.root) : new Map();
  report.changedMetrics = report.changedMetrics.map((metric) => scoredMetric(metric, report, input, lines));
  report.checked = report.changedMetrics.filter((metric) => metric.classification !== LEGACY_UNCHANGED && !metric.informational).length;
  return verdict(report);
}

export function writeReceipt(report) {
  const head = tryGit(report.root, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const rowCounts = Object.fromEntries(['new', 'modified-raised', LEGACY_UNCHANGED].map((classification) => [classification, report.changedMetrics.filter((metric) => metric.classification === classification).length]));
  rowCounts.unverified = report.unverified.length;
  const receipt = { gateVersion: GATE_VERSION, project: report.root, base: report.base, head, files: report.files, rowCounts, verdict: report.verdict, timestamp: new Date().toISOString(), ccOnly: report.ccOnly, reasons: report.unverified.map((metric) => `${metric.relativePath}:${metric.line} ${metric.name}: ${metric.unverified}`) };
  const directory = path.join(report.root, '.claude/quality-gate/receipts');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, head + '.json');
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n');
  fs.renameSync(temporary, target);
  return target;
}

function metricLine(metric, ccOnly) {
  const label = `${metric.relativePath}:${metric.line} ${metric.name}`;
  if (metric.unverified) return `UNVERIFIED ${label}: ${metric.unverified}`;
  const prefix = metric.classification === LEGACY_UNCHANGED ? 'LEGACY' : ['PASS', 'FAIL'][Number(metric.crap >= THRESHOLD)];
  const measured = ccOnly ? ' (cc-only, no coverage)' : ` coverage=${(metric.coverage * 100).toFixed(2)}%`;
  const advice = metric.complexity >= THRESHOLD ? '; fails at any coverage, split the function, more tests cannot help' : '';
  return `${prefix} ${label} cc=${metric.complexity}${measured} CRAP=${metric.crap.toFixed(4)} source=${metric.source}${advice}`;
}

export function formatCrapReport(report) {
  if (report.nothingToScoreReason) return `CRAP gate: nothing to score. ${report.nothingToScoreReason}\n`;
  const rows = report.changedMetrics.length ? report.changedMetrics : report.unverified;
  return rows.map((metric) => metricLine(metric, report.ccOnly)).join('\n') + `\nCRAP gate ${report.verdict}: ${report.failures.length} failures, ${report.unverified.length} unverified; ${report.checked} new or modified-raised functions checked (strictly below ${THRESHOLD}).\n`;
}
