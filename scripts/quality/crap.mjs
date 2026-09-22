import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, fileURLToPath as fromFileUrl, pathToFileURL } from 'node:url';
import crapCore from './crap-core.cjs';

const { crapScore, functionTokenCount, parseLizardCsv } = crapCore;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const sidequestRoot = path.join(repositoryRoot, 'plugins', 'sidequest');
const require = createRequire(path.join(sidequestRoot, 'package.json'));
const ast = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href);
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { createVirtualFileSystem } = await import(pathToFileURL(require.resolve('typescript/unstable/fs')).href);
const SOURCE_EXTENSIONS = new Set(['.js', '.ts']);
const THRESHOLD = 6;

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

async function sourcePaths() {
  const pluginsDirectory = path.join(repositoryRoot, 'plugins');
  const plugins = await fs.readdir(pluginsDirectory, { withFileTypes: true });
  const sourceLists = await Promise.all(plugins.filter((entry) => entry.isDirectory()).flatMap((entry) => [
    filesBelow(path.join(pluginsDirectory, entry.name, 'lib')),
    filesBelow(path.join(pluginsDirectory, entry.name, 'src')),
  ]));
  return sourceLists.flat();
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

function lizardMetric(sourcePath, descriptor, lizardEntries) {
  const expectedName = descriptor.name === '<anonymous>' ? '(anonymous)' : descriptor.name;
  const match = lizardEntries.find((entry) => entry.start === descriptor.line && entry.name === expectedName);
  if (!match) throw new Error(`lizard could not measure ${path.relative(repositoryRoot, sourcePath)}:${descriptor.line} ${descriptor.name}; measurement is unverified.`);
  return match.complexity;
}

async function sourceMetrics(sourcePath, coverageScripts, lizardEntries) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const descriptors = await collectFunctions(sourceText, sourcePath);
  if (functionTokenCount(sourceText) && !lizardEntries.length) throw new Error(`lizard reported zero functions for ${path.relative(repositoryRoot, sourcePath)}; measurement is unverified.`);
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
    const intervals = [...matchingCoverage(sourceRecords, descriptor), ...matchingCoverage(outputRecords, descriptor)].flatMap((record) => projectIntervals(record.ranges, descriptor));
    const coveredLength = mergeIntervals(intervals).reduce((total, [start, end]) => total + end - start, 0);
    const coverage = Math.min(1, coveredLength / (descriptor.end - descriptor.start));
    const complexity = lizardMetric(sourcePath, descriptor, lizardEntries);
    return { coverage, complexity, crap: crapScore(complexity, coverage), identity: descriptor.identity, fingerprint: descriptor.fingerprint, line: descriptor.line, name: descriptor.name, relativePath: path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/') };
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

export async function compareAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  const changed = new Set(changedPaths);
  const failures = [];
  const byPath = Map.groupBy(metrics, (metric) => metric.relativePath);
  for (const [relativePath, fileMetrics] of byPath) {
    if (!changed.has(relativePath)) continue;
    let baseline = new Map();
    try {
      baseline = await readBaseline(base, relativePath);
    } catch (error) {
      if (!String(error.message).includes(`path '${relativePath}' does not exist`)) throw error;
    }
    for (const metric of fileMetrics) {
      if (baseline.get(metric.identity) === metric.fingerprint) continue;
      if (metric.crap >= THRESHOLD) failures.push(formatMetric(metric));
    }
  }
  return failures;
}

function formatMetric(metric) {
  return `${metric.relativePath}:${metric.line} ${metric.name} cc=${metric.complexity} coverage=${(metric.coverage * 100).toFixed(2)}% CRAP=${metric.crap.toFixed(4)}`;
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
    const failures = await compareAgainstBase(metrics, changedPaths, base);
    if (options.all) metrics.filter((metric) => metric.crap >= THRESHOLD).sort((left, right) => right.crap - left.crap).forEach((metric) => process.stdout.write(`${formatMetric(metric)}\n`));
    if (failures.length) {
      process.stderr.write(`CRAP gate failed against ${base}:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`CRAP gate passed against ${base}: 0 changed or new functions at or above ${THRESHOLD}.\n`);
    return { metrics, failures };
  } finally {
    if (!options.coverageDirectory) await fs.rm(coverageDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
