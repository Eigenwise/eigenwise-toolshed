import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAnalyzer, changedMetricsAgainstBase, normalizedPath, LEGACY_UNCHANGED } from './core.mjs';
import { crapScore, enforcedMetrics, THRESHOLD } from './measure.mjs';
import { JAVASCRIPT_SOURCE, projectRoot, readConfig, gateSettings, selectedFiles, filesChangedSince, selectedDeletedFiles, sourceHashes, baseRevision, runGit, tryGit } from './crap-inputs.mjs';
import { acquireCoverage, coverageByFile, coverageTrust, functionLineCoverage } from './lcov.mjs';
import { lizardDescriptors } from './lizard.mjs';
import { pythonDescriptors, verifyOracleOwnership } from './python.mjs';

import { reuseSignals, formatReuseSignal } from './reuse-signals.mjs';

export const GATE_VERSION = 'crap-1';

function unsupportedDescriptor(text, file, reason) {
  return [{ identity: `<root>/unsupported:${file}#0`, parent: '<root>', name: file, line: 1, endLine: text.split('\n').length, complexity: null, fingerprint: crypto.createHash('sha256').update(text).digest('hex'), unverified: reason, informational: true }];
}

async function descriptors(text, file, analyzer, complexityCsv, root, policy, oracles) {
  if (JAVASCRIPT_SOURCE.test(file)) return (await analyzer.collectFunctions(text, file)).map((descriptor) => ({ ...descriptor, endLine: text.slice(0, descriptor.end).split('\n').length, source: 'typescript-ast' }));
  if (file.endsWith('.py')) return pythonDescriptors(text, file, root, policy, oracles);
  const rows = await lizardDescriptors(text, file, analyzer, complexityCsv);
  if (!rows.length) return unsupportedDescriptor(text, file, 'Lizard reported no functions; source definitions are unverified. Install a supported language adapter to verify this file.');
  return rows.map((row) => ({ ...row, informational: Boolean(row.unverified) }));
}

async function fileDescriptors(root, file, analyzer, complexityCsv, policy, oracles) {
  const bytes = fs.readFileSync(path.resolve(root, file));
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    return unsupportedDescriptor(bytes.toString('utf8'), file, 'UTF-8 decode failed: ' + error.message);
  }
  return descriptors(text, file, analyzer, complexityCsv, root, policy, oracles);
}

async function sourceMetrics(root, files, analyzer, complexityCsv, policy, oracles) {
  return (await Promise.all(files.map(async (file) => (await fileDescriptors(root, file, analyzer, complexityCsv, policy, oracles)).map((descriptor) => ({ ...descriptor, relativePath: file }))))).flat();
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
  const enforced = enforcedMetrics(report.changedMetrics).filter((metric) => !metric.informational);
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

function emptyScopeReason(selected, files, metrics, changed) {
  if (!selected.length) return 'No supported source files matched sources and exclude.';
  if (files.length && !metrics.length) return 'Selected files contain no runtime function bodies (type-only declarations are excluded).';
  if (!changed.length) return 'No function bodies changed against the base revision.';
  return null;
}

async function changedAgainstBase(report, analyzer, changedPaths, removedMetrics) {
  if (!report.base) return report.metrics.map((metric) => ({ ...metric, classification: 'new' }));
  const readBaseline = async (base, file) => {
    const text = runGit(report.root, ['show', `${base}:${file}`]);
    let oracles = report.pythonOracles;
    if (file.endsWith('.py') && oracles?.length) {
      const baseline = await descriptors(text, file, analyzer, undefined, report.root, report.pythonPolicy, []);
      const names = new Set(baseline.map((row) => row.name));
      oracles = oracles.filter((entry) => entry.file === file && names.has(entry.name));
    }
    return descriptors(text, file, analyzer, undefined, report.root, report.pythonPolicy, oracles);
  };
  const changed = await changedMetricsAgainstBase(report.metrics, changedPaths, report.base, readBaseline, removedMetrics);
  const changedIdentities = new Set(changed.map((metric) => metric.relativePath + ':' + metric.identity));
  return changed.concat(report.metrics.filter((metric) => metric.informational && !changedIdentities.has(metric.relativePath + ':' + metric.identity)));
}

function complexityOnly(root, options, settings) {
  if (options.ccOnly) return true;
  if (settings.lcov || settings.fallbackLcov || settings.coverageCommand) return false;
  return !fs.existsSync(path.join(root, 'coverage/lcov.info'));
}

export async function crapReport(options = {}) {
  const root = projectRoot(options.project ?? process.cwd());
  const { config, warnings } = readConfig(root);
  const settings = gateSettings(options, config);
  const baseline = baseRevision(root, settings.base);
  const selected = selectedFiles(root, settings, options.files);
  const files = filesChangedSince(root, baseline.base, selected);
  const changedPaths = files.concat(selectedDeletedFiles(root, baseline.base, settings));
  const removedMetrics = [];
  const analyzer = changedPaths.some((file) => JAVASCRIPT_SOURCE.test(file) || file.endsWith('.vue')) ? await createAnalyzer(root) : null;
  const complexityCsv = options.complexity ? fs.readFileSync(path.resolve(root, options.complexity), 'utf8') : undefined;
  const report = { root, base: baseline.base, files: sourceHashes(root, files), pythonPolicy: settings.pythonPolicy, pythonOracles: settings.pythonOracles, ccOnly: complexityOnly(root, options, settings), max: THRESHOLD, warnings: [...warnings, ...baseline.warnings] };
  if (settings.usedDeprecatedRatchet) report.warnings.push('--ratchet and config ratchet are deprecated. Use --base or config base instead.');
  try {
    report.metrics = await sourceMetrics(root, files, analyzer, complexityCsv, settings.pythonPolicy, settings.pythonOracles);
    verifyOracleOwnership(report.metrics, settings.pythonOracles?.filter((entry) => files.includes(entry.file) || !selected.includes(entry.file)));
    report.changedMetrics = await changedAgainstBase(report, analyzer, changedPaths, removedMetrics);
  } finally {
    await analyzer?.close();
  }
  report.signals = reuseSignals(root, report.changedMetrics, removedMetrics);
  report.nothingToScoreReason = emptyScopeReason(selected, files, report.metrics, report.changedMetrics);
  return measureReport(report, settings);
}

function measureReport(report, settings) {
  const input = report.ccOnly || !report.changedMetrics.length ? null : acquireCoverage(report.root, settings, Object.keys(report.files));
  const lines = input ? coverageByFile(input.text, report.root) : new Map();
  report.changedMetrics = report.changedMetrics.map((metric) => scoredMetric(metric, report, input, lines));
  report.checked = enforcedMetrics(report.changedMetrics).filter((metric) => !metric.informational).length;
  return verdict(report);
}

export function writeReceipt(report) {
  const head = tryGit(report.root, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const rowCounts = Object.fromEntries(['new', 'modified-raised', LEGACY_UNCHANGED].map((classification) => [classification, report.changedMetrics.filter((metric) => metric.classification === classification).length]));
  rowCounts.unverified = report.unverified.length;
  const receipt = { gateVersion: GATE_VERSION, pythonPolicy: report.pythonPolicy, pythonOracles: report.pythonOracles, project: report.root, base: report.base, head, files: report.files, rowCounts, verdict: report.verdict, timestamp: new Date().toISOString(), ccOnly: report.ccOnly, reasons: report.unverified.map((metric) => `${metric.relativePath}:${metric.line} ${metric.name}: ${metric.unverified}`) };
  const directory = path.join(report.root, '.claude/quality-gate/receipts');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, head + '.json');
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n');
  fs.renameSync(temporary, target);
  return target;
}

function pythonClassificationLabel(metric) {
  if (!metric.adapterVersion) return '';
  return ` adapter=${metric.adapterVersion} role=${metric.oracleClassification} (${metric.oracleReason}) policy=${metric.measurementPolicy}`;
}

function complexityFailureAdvice(metric) {
  if (metric.classification === LEGACY_UNCHANGED) return '';
  return metric.complexity >= THRESHOLD ? '; fails at any coverage, split the function, more tests cannot help' : '';
}

function metricLine(metric, ccOnly) {
  const label = `${metric.relativePath}:${metric.line} ${metric.name}${pythonClassificationLabel(metric)}`;
  const legacy = metric.classification === LEGACY_UNCHANGED;
  if (metric.unverified) return `${legacy ? 'LEGACY UNVERIFIED' : 'UNVERIFIED'} ${label}: ${metric.unverified}`;
  const prefix = legacy ? 'LEGACY' : ['PASS', 'FAIL'][Number(metric.crap >= THRESHOLD)];
  const measured = ccOnly ? ' (cc-only, no coverage)' : ` coverage=${(metric.coverage * 100).toFixed(2)}%`;
  const advice = complexityFailureAdvice(metric);
  return `${prefix} ${label} cc=${metric.complexity}${measured} CRAP=${metric.crap.toFixed(4)} source=${metric.source}${advice}`;
}

export function formatCrapReport(report) {
  const signals = report.signals ?? [];
  const signalRows = signals.map(formatReuseSignal);
  if (report.nothingToScoreReason) return [...signalRows, `CRAP gate: nothing to score. ${report.nothingToScoreReason} ${signals.length} reuse signals.`].join('\n') + '\n';
  const rows = report.changedMetrics.length ? report.changedMetrics : report.unverified;
  return [...rows.map((metric) => metricLine(metric, report.ccOnly)), ...signalRows].join('\n') + `\nCRAP gate ${report.verdict}: ${report.failures.length} failures, ${report.unverified.length} unverified; ${signals.length} reuse signals; ${report.checked} new or complexity-raised functions checked (strictly below ${THRESHOLD}).\n`;
}
