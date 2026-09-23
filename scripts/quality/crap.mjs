import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, fileURLToPath as fromFileUrl, pathToFileURL } from 'node:url';
import crapCore from './crap-core.cjs';

const { crapScore, parseLizardCsv } = crapCore;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const sidequestRoot = path.join(repositoryRoot, 'plugins', 'sidequest');
const require = createRequire(path.join(sidequestRoot, 'package.json'));
const ast = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href);
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { createVirtualFileSystem } = await import(pathToFileURL(require.resolve('typescript/unstable/fs')).href);
const SOURCE_EXTENSIONS = new Set(['.js', '.ts']);
const THRESHOLD = 6;
const SIDEQUEST_BUILD_OUTPUT_DIRECTORIES = new Set(['bin', 'hooks', 'lib']);

function parseArguments(argumentsList) {
  const options = { coverageDirectory: null, base: null, all: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--coverage') options.coverageDirectory = path.resolve(argumentsList[++index] ?? '');
    else if (argument === '--base') options.base = argumentsList[++index] ?? '';
    else if (argument === '--all') options.all = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function filesBelow(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesBelow(entryPath);
      return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
    }));
    return nested.flat().sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function isScoredSource(sourcePath) {
  const [sidequestDirectory] = path.relative(sidequestRoot, sourcePath).replaceAll('\\', '/').split('/');
  return !SIDEQUEST_BUILD_OUTPUT_DIRECTORIES.has(sidequestDirectory);
}

async function sourcePaths() {
  const pluginsDirectory = path.join(repositoryRoot, 'plugins');
  const plugins = await fs.readdir(pluginsDirectory, { withFileTypes: true });
  const sourceLists = await Promise.all(plugins.filter((entry) => entry.isDirectory()).flatMap((entry) => [
    filesBelow(path.join(pluginsDirectory, entry.name, 'lib')),
    filesBelow(path.join(pluginsDirectory, entry.name, 'src')),
  ]));
  return sourceLists.flat().filter(isScoredSource);
}

function functionName(node) {
  if (ast.isConstructorDeclaration(node)) return 'constructor';
  if ('name' in node && node.name) return node.name.getText();
  const parent = node.parent;
  if (ast.isVariableDeclaration(parent)) return parent.name.getText();
  if (ast.isPropertyAssignment(parent)) return parent.name.getText();
  if (ast.isBinaryExpression(parent)) return parent.left.getText();
  if (ast.isPropertyDeclaration(parent) && parent.name) return parent.name.getText();
  return '<anonymous>';
}

function functionKind(node) {
  return ast.SyntaxKind[node.kind];
}

export async function collectFunctions(text, fileName) {
  const virtualFile = fileName.endsWith('.js') ? '/source.js' : '/source.ts';
  const virtualFileSystem = createVirtualFileSystem({
    '/tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true }, files: [virtualFile] }),
    [virtualFile]: text,
  });
  const api = new API({ cwd: '/', fs: virtualFileSystem });
  try {
    const snapshot = api.updateSnapshot({ openProject: '/tsconfig.json' });
    const sourceFile = snapshot.getProject('/tsconfig.json').program.getSourceFile(virtualFile);
    if (!sourceFile) throw new Error(`TypeScript could not parse ${fileName}.`);
    const functions = [];
    const childCounts = new Map();
    function visit(node, parentId = '<root>') {
      if (ast.isFunctionLikeDeclaration(node) && node.body) {
        const name = functionName(node);
        const countKey = `${parentId}\u0000${functionKind(node)}\u0000${name}`;
        const ordinal = childCounts.get(countKey) ?? 0;
        childCounts.set(countKey, ordinal + 1);
        const identity = `${parentId}/${functionKind(node)}:${name}#${ordinal}`;
        const start = node.getStart();
        const end = node.end;
        functions.push({ identity, name, start, end, line: sourceFile.getLineAndCharacterOfPosition(start).line + 1, fingerprint: crypto.createHash('sha256').update(text.slice(start, end).replace(/\s+/g, ' ')).digest('hex') });
        node.forEachChild((child) => visit(child, identity));
      } else node.forEachChild((child) => visit(child, parentId));
    }
    visit(sourceFile);
    return functions;
  } finally {
    api.close();
  }
}

function normalizedPath(filePath) {
  return path.resolve(filePath).replaceAll('\\', '/').toLowerCase();
}

function pathFromCoverageUrl(url) {
  try {
    return normalizedPath(fromFileUrl(url));
  } catch {
    return null;
  }
}

function coverageIntervals(ranges) {
  const boundaries = [...new Set(ranges.flatMap((range) => [range.startOffset, range.endOffset]))].sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const candidates = ranges.filter((range) => range.startOffset <= start && range.endOffset >= end);
    candidates.sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
    if (candidates[0]?.count > 0) intervals.push([start, end]);
  }
  return intervals;
}

function projectIntervals(ranges, descriptor) {
  const primaryRange = ranges[0];
  const sourceLength = primaryRange.endOffset - primaryRange.startOffset;
  const targetLength = descriptor.end - descriptor.start;
  if (sourceLength <= 0 || targetLength <= 0) return [];
  return coverageIntervals(ranges).map(([start, end]) => [
    descriptor.start + ((start - primaryRange.startOffset) / sourceLength) * targetLength,
    descriptor.start + ((end - primaryRange.startOffset) / sourceLength) * targetLength,
  ]);
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const [start, end] of intervals.sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

async function readCoverage(coverageDirectory) {
  const reports = await Promise.all((await fs.readdir(coverageDirectory)).filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await fs.readFile(path.join(coverageDirectory, file), 'utf8'))));
  const scripts = new Map();
  for (const report of reports) {
    for (const script of report.result ?? []) {
      const scriptPath = pathFromCoverageUrl(script.url);
      if (!scriptPath) continue;
      scripts.set(scriptPath, [...(scripts.get(scriptPath) ?? []), ...script.functions]);
    }
  }
  return scripts;
}

async function outputPathsForSource(sourcePath) {
  const relativeToSidequest = path.relative(sidequestRoot, sourcePath).replaceAll('\\', '/');
  if (!relativeToSidequest.startsWith('src/')) return [sourcePath];
  const sourceRelative = relativeToSidequest.slice('src/'.length);
  if (sourceRelative.startsWith('lib/') || sourceRelative.startsWith('bin/')) return [path.join(sidequestRoot, sourceRelative.replace(/\.ts$/, '.js'))];
  if (sourceRelative.startsWith('hooks/') && !sourceRelative.slice('hooks/'.length).includes('/')) return [path.join(sidequestRoot, 'hooks', path.basename(sourceRelative, '.ts') + '.js')];
  if (sourceRelative.startsWith('hooks/shared/')) return (await fs.readdir(path.join(sidequestRoot, 'hooks'))).filter((file) => file.endsWith('.js')).map((file) => path.join(sidequestRoot, 'hooks', file));
  return [];
}

function matchingCoverage(records, descriptor) {
  return records.filter((record) => record.functionName === descriptor.name && record.ranges[0]);
}

export function lizardMetric(descriptor, lizardEntries) {
  const expectedName = descriptor.name === '<anonymous>' ? '(anonymous)' : descriptor.name;
  return lizardEntries.find((entry) => entry.start === descriptor.line && entry.name === expectedName)?.complexity ?? null;
}

async function sourceMetrics(sourcePath, coverageScripts, lizardEntries) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const descriptors = await collectFunctions(sourceText, sourcePath);
  const sourceRecords = coverageScripts.get(normalizedPath(sourcePath)) ?? [];
  const outputPaths = await outputPathsForSource(sourcePath);
  const outputRecords = (await Promise.all(outputPaths.map(async (outputPath) => {
    try {
      await fs.access(outputPath);
      return coverageScripts.get(normalizedPath(outputPath)) ?? [];
    } catch {
      return [];
    }
  }))).flat();
  if (!sourceRecords.length && !outputPaths.length) throw new Error(`could not resolve coverage output for ${path.relative(repositoryRoot, sourcePath)}; measurement is unverified.`);
  return descriptors.map((descriptor) => {
    const metric = {
      identity: descriptor.identity,
      fingerprint: descriptor.fingerprint,
      line: descriptor.line,
      name: descriptor.name,
      relativePath: path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/'),
    };
    const complexity = lizardMetric(descriptor, lizardEntries);
    if (complexity === null) return { ...metric, unverified: 'lizard could not measure this function' };
    const intervals = [...matchingCoverage(sourceRecords, descriptor), ...matchingCoverage(outputRecords, descriptor)].flatMap((record) => projectIntervals(record.ranges, descriptor));
    const coveredLength = mergeIntervals(intervals).reduce((total, [start, end]) => total + end - start, 0);
    const coverage = Math.min(1, coveredLength / (descriptor.end - descriptor.start));
    return { ...metric, coverage, complexity, crap: crapScore(complexity, coverage) };
  });
}

function runGit(argumentsList) {
  const result = spawnSync('git', argumentsList, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${argumentsList.join(' ')} failed`);
  return result.stdout.trim();
}

function integrationBranch() {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', 'develop'], { cwd: repositoryRoot }).status === 0 ? 'develop' : 'main';
}

function mergeBase(base) {
  return base || runGit(['merge-base', 'HEAD', integrationBranch()]);
}

async function baselineFunctions(base, relativePath) {
  const text = runGit(['show', `${base}:${relativePath}`]);
  return new Map((await collectFunctions(text, relativePath)).map((descriptor) => [descriptor.identity, descriptor.fingerprint]));
}

export async function changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  const changed = new Set(changedPaths);
  const changedMetrics = [];
  const byPath = Map.groupBy(metrics, (metric) => metric.relativePath);
  for (const [relativePath, fileMetrics] of byPath) {
    if (!changed.has(relativePath)) continue;
    let baseline = new Map();
    try {
      baseline = await readBaseline(base, relativePath);
    } catch (error) {
      if (!String(error.message).includes(`path '${relativePath}' does not exist`)) throw error;
    }
    changedMetrics.push(...fileMetrics.filter((metric) => baseline.get(metric.identity) !== metric.fingerprint));
  }
  return changedMetrics;
}

export async function compareAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  const changedMetrics = await changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline);
  return changedMetrics.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric);
}

function formatMetric(metric) {
  return `${metric.relativePath}:${metric.line} ${metric.name} cc=${metric.complexity} coverage=${(metric.coverage * 100).toFixed(2)}% CRAP=${metric.crap.toFixed(4)}`;
}

function formatUnverifiedMetric(metric) {
  return `${metric.relativePath}:${metric.line} ${metric.name} ${metric.unverified}; measurement is unverified.`;
}

export function emptyChangedFunctionWarning(changedMetrics, workingTreeIsClean) {
  if (changedMetrics.length || !workingTreeIsClean) return null;
  return 'Warning: no changed functions were found in a clean working tree; this CRAP result is vacuous.';
}

async function captureCoverage() {
  const coverageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolshed-crap-'));
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', 'test:full'], { cwd: sidequestRoot, env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`npm run test:full failed with exit ${result.status ?? 'signal'}`);
  const quartermasterTests = spawnSync(process.execPath, ['--test', '--test-timeout=120000', 'test/*.test.js'], { cwd: path.join(repositoryRoot, 'plugins', 'quartermaster'), env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, stdio: 'inherit', shell: process.platform === 'win32' });
  if (quartermasterTests.status !== 0) throw new Error(`Quartermaster tests failed with exit ${quartermasterTests.status ?? 'signal'}`);
  return coverageDirectory;
}

export async function run(options = parseArguments(process.argv.slice(2))) {
  const coverageDirectory = options.coverageDirectory ?? await captureCoverage();
  try {
    const coverageScripts = await readCoverage(coverageDirectory);
    const base = mergeBase(options.base);
    const changedPaths = runGit(['diff', '--name-only', base, '--', 'plugins']).split('\n').filter(Boolean);
    const sources = (await sourcePaths()).filter((sourcePath) => changedPaths.includes(path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/')));
    const lizardResult = spawnSync('lizard', ['--csv', ...sources], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (lizardResult.status !== 0) throw new Error(`lizard failed with exit ${lizardResult.status ?? 'signal'}`);
    const lizardRecords = parseLizardCsv(lizardResult.stdout ?? '');
    const lizardByPath = Map.groupBy(lizardRecords, (entry) => normalizedPath(entry.file));
    const metrics = (await Promise.all(sources.map((sourcePath) => sourceMetrics(sourcePath, coverageScripts, lizardByPath.get(normalizedPath(sourcePath)) ?? [])))).flat();
    const changedMetrics = await changedMetricsAgainstBase(metrics, changedPaths, base);
    const unverified = changedMetrics.filter((metric) => metric.unverified);
    const failures = changedMetrics.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric);
    const displayedMetrics = options.all ? metrics : changedMetrics;
    displayedMetrics.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.line - right.line).forEach((metric) => {
      const status = metric.unverified ? 'UNVERIFIED' : metric.crap >= THRESHOLD ? 'FAIL' : 'PASS';
      process.stdout.write(`${status} ${metric.unverified ? formatUnverifiedMetric(metric) : formatMetric(metric)}\n`);
    });
    const warning = emptyChangedFunctionWarning(changedMetrics, !runGit(['status', '--porcelain']));
    if (warning) process.stderr.write(`${warning}\n`);
    if (failures.length || unverified.length) {
      const errors = [...failures, ...unverified.map(formatUnverifiedMetric)];
      process.stderr.write(`CRAP gate failed against ${base}:\n${errors.map((failure) => `- ${failure}`).join('\n')}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`CRAP gate passed against ${base}: ${changedMetrics.length} changed or new functions scored below ${THRESHOLD}.\n`);
    return { metrics, changedMetrics, failures, unverified };
  } finally {
    if (!options.coverageDirectory) await fs.rm(coverageDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
