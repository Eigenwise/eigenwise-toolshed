import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveCompiler } from './compiler.mjs';
import { spawnSync } from 'node:child_process';
import { createAnalyzer, changedMetricsAgainstBase, readCoverage, functionCoverage, normalizedPath, LEGACY_UNCHANGED } from './core.mjs';

const NO_COVERAGE_RECORD = 'no suite loaded this file, so it has no coverage record (a child process needs QUALITY_GATE_V8_CAPTURE and the shared core preload in NODE_OPTIONS; see scripts/quality/README.md)';
export const THRESHOLD = 6;

export function enforcedMetrics(changedMetrics) {
  return changedMetrics.filter((metric) => metric.classification !== LEGACY_UNCHANGED);
}

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

export async function readOutput(outputPath, coverageScripts, needsFunctions, { projectRoot, analyzer, text }) {
  try {
    text ??= await fs.readFile(outputPath, 'utf8');
  } catch {
    return null;
  }
  return {
    filePath: normalizedPath(outputPath),
    relativePath: path.relative(projectRoot, outputPath).replaceAll('\\', '/'),
    text,
    descriptors: needsFunctions ? await analyzer.collectFunctions(text, outputPath) : [],
    captures: await Promise.all((coverageScripts.get(normalizedPath(outputPath)) ?? []).map(async (capture) => ({ ...capture, filePath: outputPath, descriptors: typeof capture.text === 'string' ? await analyzer.collectFunctions(capture.text, outputPath + '.js') : [] }))),
  };
}

export async function measureSource(sourcePath, coverageScripts, { projectRoot, analyzer, outputPaths = [sourcePath], sourceText, relativePath = path.relative(projectRoot, sourcePath).replaceAll('\\', '/') }) {
  sourceText ??= await fs.readFile(sourcePath, 'utf8');
  const descriptors = await analyzer.collectFunctions(sourceText, sourcePath);
  const source = await readOutput(sourcePath, coverageScripts, false, { projectRoot, analyzer, text: sourceText });
  source.descriptors = descriptors;
  const builtOutputs = await Promise.all(outputPaths.filter((outputPath) => outputPath !== sourcePath).map((outputPath) => readOutput(outputPath, coverageScripts, false, { projectRoot, analyzer })));
  const outputs = [source, ...builtOutputs.filter(Boolean)];
  const loaded = outputs.some((output) => output.captures.length);
  return Promise.all(descriptors.map(async (descriptor) => {
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
  }));
}


function outsideProject(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function declaredExternalPath(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error(`${filePath}: external declaration must be absolute`);
  if (filePath.replaceAll('\\', '/') !== path.resolve(filePath).replaceAll('\\', '/')) throw new Error(`${filePath}: external declaration must be normalized, without traversal`);
}

async function canonicalExternalPath(filePath, projectRoot) {
  if (!(await fs.lstat(filePath)).isFile()) throw new Error(`${filePath}: external declaration must name a regular file`);
  if (!/\.[cm]?js$/.test(filePath)) throw new Error(`${filePath}: external declaration supports .js, .cjs and .mjs only`);
  const canonical = realpathSync.native(filePath);
  if (filePath.replaceAll('\\', '/') !== canonical.replaceAll('\\', '/')) throw new Error(`${filePath}: external declaration is an alias; use ${canonical}`);
  if (!outsideProject(canonical, projectRoot)) throw new Error(`${filePath}: external declaration must be outside the project root`);
  return canonical;
}

async function externalSource(filePath) {
  const bytes = await fs.readFile(filePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${filePath}: external source must be strict UTF-8`);
  }
  if (text.startsWith('﻿')) throw new Error(`${filePath}: BOM parser offsets are unsupported; original bytes were retained`);
  return { sourceText: text, sourceHash: crypto.createHash('sha256').update(bytes).digest('hex'), relativePath: filePath.replaceAll('\\', '/'), admission: 'external-new' };
}

async function admittedExternalSources(files, projectRoot) {
  const sources = new Map();
  for (const filePath of files) {
    declaredExternalPath(filePath);
    const canonical = await canonicalExternalPath(filePath, projectRoot);
    const identity = normalizedPath(canonical);
    if (sources.has(identity)) throw new Error(`${filePath}: duplicate external declaration`);
    sources.set(identity, await externalSource(canonical));
  }
  return sources;
}

function selectedPath(file, projectRoot, externalSources) {
  const absolute = path.resolve(projectRoot, file);
  const external = externalSources.get(normalizedPath(absolute));
  if (external) {
    if (file.replaceAll('\\', '/') !== external.relativePath) throw new Error(`${file}: unaccounted external alias; use ${external.relativePath}`);
    return external.relativePath;
  }
  if (outsideProject(absolute, projectRoot)) throw new Error(`${file}: outside repository; explicitly declare --new-external-file`);
  return path.relative(projectRoot, absolute).replaceAll('\\', '/');
}

export async function measureFiles(files, { projectRoot, base, coverageDirectory, externalNewFiles = [] }) {
  const externalSources = await admittedExternalSources(externalNewFiles, realpathSync.native(projectRoot));
  const selectedPaths = files.map((file) => selectedPath(file, projectRoot, externalSources));
  const relativePaths = [...new Set([...selectedPaths, ...Array.from(externalSources.values(), (source) => source.relativePath)])];
  const repositoryPaths = relativePaths.filter((file) => !externalSources.has(normalizedPath(path.resolve(projectRoot, file))));
  if (repositoryPaths.length && !base) throw new Error('Repository files require --base, including mixed repository/external measurement');
  const analyzer = await createAnalyzer(projectRoot);
  try {
    return await measureWithAnalyzer(analyzer, { projectRoot, base, coverageDirectory, externalSources, relativePaths });
  } finally {
    await analyzer.close();
  }
}

async function measureWithAnalyzer(analyzer, { projectRoot, base, coverageDirectory, externalSources, relativePaths }) {
  const evaluatorVersions = { typescript: resolveCompiler(projectRoot)('typescript/package.json').version, node: process.version };
  const coverageScripts = await readCoverage(coverageDirectory);
  const metrics = (await Promise.all(relativePaths.map(async (file) => {
    const sourcePath = path.resolve(projectRoot, file);
    const external = externalSources.get(normalizedPath(sourcePath));
    const measured = await measureSource(sourcePath, coverageScripts, { projectRoot, analyzer, ...external });
    return external ? measured.map((metric) => ({ ...metric, admission: external.admission, sourceHash: external.sourceHash, evaluatorVersions })) : measured;
  }))).flat();
  const readBaseline = async (revision, relativePath) => {
    if (externalSources.has(normalizedPath(path.resolve(projectRoot, relativePath)))) return [];
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
