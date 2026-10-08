import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAnalyzer, changedMetricsAgainstBase, readCoverage, functionCoverage, normalizedPath, LEGACY_UNCHANGED } from './core.mjs';

const NO_COVERAGE_RECORD = 'no suite loaded this file, so it has no coverage record (a script only ever spawned as a child process is covered once the spawning test passes NODE_V8_COVERAGE through; see scripts/quality/README.md)';
export const THRESHOLD = 6;

export function enforcedMetrics(changedMetrics) {
  return changedMetrics.filter((metric) => metric.classification !== LEGACY_UNCHANGED);
}

// A legacy-unchanged row is informational: it never fails and never counts as unverified.
export function gateVerdict(changedMetrics) {
  const enforced = enforcedMetrics(changedMetrics);
  return {
    failures: enforced.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric),
    unverified: enforced.filter((metric) => metric.unverified),
  };
}

export function crapScore(complexity, coverage) {
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

export async function readOutput(outputPath, coverageScripts, needsFunctions, { projectRoot, analyzer }) {
  let text;
  try {
    text = await fs.readFile(outputPath, 'utf8');
  } catch {
    return null;
  }
  return {
    relativePath: path.relative(projectRoot, outputPath).replaceAll('\\', '/'),
    descriptors: needsFunctions ? await analyzer.collectFunctions(text, outputPath) : [],
    records: coverageScripts.get(normalizedPath(outputPath)) ?? [],
  };
}

export async function measureSource(sourcePath, coverageScripts, { projectRoot, analyzer, outputPaths = [sourcePath] }) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const descriptors = await analyzer.collectFunctions(sourceText, sourcePath);
  const relativePath = path.relative(projectRoot, sourcePath).replaceAll('\\', '/');
  const source = { relativePath, descriptors, records: coverageScripts.get(normalizedPath(sourcePath)) ?? [] };
  // Parsing an output is a TypeScript API round trip, and only unnamed functions need it.
  const needsFunctions = descriptors.some((descriptor) => descriptor.name === '<anonymous>');
  const builtOutputs = await Promise.all(outputPaths.filter((outputPath) => outputPath !== sourcePath).map((outputPath) => readOutput(outputPath, coverageScripts, needsFunctions, { projectRoot, analyzer })));
  const outputs = [source, ...builtOutputs.filter(Boolean)];
  const loaded = outputs.some((output) => output.records.length);
  return descriptors.map((descriptor) => {
    const metric = {
      identity: descriptor.identity,
      parent: descriptor.parent,
      fingerprint: descriptor.fingerprint,
      line: descriptor.line,
      name: descriptor.name,
      complexity: descriptor.complexity,
      relativePath,
    };
    const { coverage, unverified } = loaded ? functionCoverage(descriptor, outputs) : { unverified: NO_COVERAGE_RECORD };
    if (unverified) return { ...metric, unverified };
    return { ...metric, coverage, crap: crapScore(descriptor.complexity, coverage) };
  });
}


export async function measureFiles(files, { projectRoot, base, coverageDirectory }) {
  const relativePaths = files.map((file) => path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/'));
  const analyzer = await createAnalyzer(projectRoot);
  const coverageScripts = await readCoverage(coverageDirectory);
  const metrics = (await Promise.all(relativePaths.map((file) => measureSource(path.resolve(projectRoot, file), coverageScripts, { projectRoot, analyzer })))).flat();
  const readBaseline = async (revision, relativePath) => {
    const result = spawnSync('git', ['show', revision + ':' + relativePath], { cwd: projectRoot, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.trim());
    return analyzer.collectFunctions(result.stdout, relativePath);
  };
  const changedMetrics = await changedMetricsAgainstBase(metrics, relativePaths, base, readBaseline);
  return { metrics, changedMetrics, ...gateVerdict(changedMetrics) };
}

export function formatMetric(metric) {
  return `${metric.relativePath}:${metric.line} ${metric.name} cc=${metric.complexity} coverage=${(metric.coverage * 100).toFixed(2)}% CRAP=${metric.crap.toFixed(4)}`;
}
