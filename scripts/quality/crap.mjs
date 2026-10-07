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
const { API: SyncParserApi } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { API: AsyncParserApi } = await import(pathToFileURL(require.resolve('typescript/unstable/async')).href);
const { createVirtualFileSystem } = await import(pathToFileURL(require.resolve('typescript/unstable/fs')).href);
// The sync transport opens a Windows named pipe, which `node --permission --allow-fs-read=*` denies;
// the async transport speaks JSON-RPC over the child's stdio and needs only --allow-child-process.
const PARSER_TRANSPORTS = { sync: SyncParserApi, async: AsyncParserApi };
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

export function parserTransport(requested = process.env.CRAP_PARSER_TRANSPORT || 'sync') {
  const ParserApi = PARSER_TRANSPORTS[requested];
  if (!ParserApi) throw new Error(`Unknown TypeScript parser transport "${requested}"; use sync or async.`);
  return ParserApi;
}

export async function collectFunctions(text, fileName, { transport } = {}) {
  const virtualFile = fileName.endsWith('.js') ? '/source.js' : '/source.ts';
  const virtualFileSystem = createVirtualFileSystem({
    '/tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true }, files: [virtualFile] }),
    [virtualFile]: text,
  });
  const ParserApi = parserTransport(transport);
  const api = new ParserApi({ cwd: '/', fs: virtualFileSystem });
  try {
    const snapshot = await api.updateSnapshot({ openProject: '/tsconfig.json' });
    const sourceFile = await snapshot.getProject('/tsconfig.json').program.getSourceFile(virtualFile);
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
        functions.push({ identity, parent: parentId, name, start, end, line: sourceFile.getLineAndCharacterOfPosition(start).line + 1, fingerprint: crypto.createHash('sha256').update(text.slice(start, end).replace(/\s+/g, ' ')).digest('hex') });
        node.forEachChild((child) => visit(child, identity));
      } else node.forEachChild((child) => visit(child, parentId));
    }
    visit(sourceFile);
    return functions;
  } finally {
    await api.close();
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

function namedRecords(descriptor, outputs) {
  return { records: outputs.flatMap((output) => output.records).filter((record) => record.functionName === descriptor.name && record.ranges[0]) };
}

export function lizardMetric(descriptor, lizardEntries) {
  const expectedName = descriptor.name === '<anonymous>' ? '(anonymous)' : descriptor.name;
  return lizardEntries.find((entry) => entry.start === descriptor.line && entry.name === expectedName)?.complexity ?? null;
}

function siblingIdentities(descriptors, parent) {
  return descriptors.filter((descriptor) => descriptor.parent === parent).map((descriptor) => descriptor.identity).join('\n');
}

// V8 names an inline callback "" and the build ships no source map, so an unnamed function is
// found by position: its twin in each output has the same identity, trusted only where every
// function under the same parent lines up, since anything looser pins coverage on a neighbour.
function anonymousRecords(descriptor, outputs) {
  const sourceSiblings = siblingIdentities(outputs[0].descriptors, descriptor.parent);
  const records = [];
  for (const output of outputs) {
    const outputSiblings = siblingIdentities(output.descriptors, descriptor.parent);
    if (!outputSiblings) continue;
    if (outputSiblings !== sourceSiblings) return { unverified: `the functions beside it in ${output.relativePath} do not line up with the source, so its coverage cannot be paired` };
    const twin = output.descriptors.find((candidate) => candidate.identity === descriptor.identity);
    records.push(...output.records.filter((record) => record.ranges[0]?.startOffset === twin.start));
  }
  return { records };
}

// outputs[0] is the source itself; the rest are its build outputs.
export function functionCoverage(descriptor, outputs) {
  const paired = descriptor.name === '<anonymous>' ? anonymousRecords(descriptor, outputs) : namedRecords(descriptor, outputs);
  if (paired.unverified) return paired;
  const intervals = paired.records.flatMap((record) => projectIntervals(record.ranges, descriptor));
  const coveredLength = mergeIntervals(intervals).reduce((total, [start, end]) => total + end - start, 0);
  return { coverage: Math.min(1, coveredLength / (descriptor.end - descriptor.start)) };
}

export async function builtOutput(outputPath, coverageScripts, needsFunctions) {
  let text;
  try {
    text = await fs.readFile(outputPath, 'utf8');
  } catch {
    return null;
  }
  return {
    relativePath: path.relative(repositoryRoot, outputPath).replaceAll('\\', '/'),
    descriptors: needsFunctions ? await collectFunctions(text, outputPath) : [],
    records: coverageScripts.get(normalizedPath(outputPath)) ?? [],
  };
}

export async function sourceMetrics(sourcePath, coverageScripts, lizardEntries) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const descriptors = await collectFunctions(sourceText, sourcePath);
  const relativePath = path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/');
  const source = { relativePath, descriptors, records: coverageScripts.get(normalizedPath(sourcePath)) ?? [] };
  const outputPaths = await outputPathsForSource(sourcePath);
  if (!source.records.length && !outputPaths.length) throw new Error(`could not resolve coverage output for ${path.relative(repositoryRoot, sourcePath)}; measurement is unverified.`);
  // Parsing an output is a TypeScript API round trip, and only unnamed functions need it.
  const needsFunctions = descriptors.some((descriptor) => descriptor.name === '<anonymous>');
  const builtOutputs = await Promise.all(outputPaths.filter((outputPath) => outputPath !== sourcePath).map((outputPath) => builtOutput(outputPath, coverageScripts, needsFunctions)));
  const outputs = [source, ...builtOutputs.filter(Boolean)];
  return descriptors.map((descriptor) => {
    const metric = {
      identity: descriptor.identity,
      fingerprint: descriptor.fingerprint,
      line: descriptor.line,
      name: descriptor.name,
      relativePath,
    };
    const complexity = lizardMetric(descriptor, lizardEntries);
    if (complexity === null) return { ...metric, unverified: 'lizard could not measure this function' };
    const { coverage, unverified } = functionCoverage(descriptor, outputs);
    if (unverified) return { ...metric, unverified };
    return { ...metric, coverage, complexity, crap: crapScore(complexity, coverage) };
  });
}

function runGit(argumentsList, cwd = repositoryRoot) {
  const result = spawnSync('git', argumentsList, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${argumentsList.join(' ')} failed`);
  return result.stdout.trim();
}

function integrationBranch() {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', 'develop'], { cwd: repositoryRoot }).status === 0 ? 'develop' : 'main';
}

function mergeBase(base) {
  return base || runGit(['merge-base', 'HEAD', integrationBranch()]);
}

export function diffEntries(base, pathspec, cwd = repositoryRoot) {
  const args = ['diff', '--name-status', '-M', base];
  if (pathspec) args.push('--', pathspec);
  return runGit(args, cwd).split('\n').filter(Boolean).map((line) => {
    const [status, ...fields] = line.split('\t');
    return status.startsWith('R') ? { path: fields[1], baselinePath: fields[0] } : { path: fields[0], baselinePath: fields[0] };
  });
}

export async function baselineFunctions(base, relativePath, cwd = repositoryRoot) {
  const text = runGit(['show', `${base}:${relativePath}`], cwd);
  return new Map((await collectFunctions(text, relativePath)).map((descriptor) => [descriptor.identity, descriptor.fingerprint]));
}

function pathAndBaselinePath(entry) {
  return typeof entry === 'string' ? [entry, entry] : [entry.path, entry.baselinePath ?? entry.path];
}

// git show phrases a missing path two ways: "does not exist in 'rev'" when it is
// absent everywhere, "exists on disk, but not in 'rev'" when the file is new.
function pathAbsentAtBase(error, baselinePath) {
  const message = String(error.message);
  return message.includes(`path '${baselinePath}' does not exist`)
    || message.includes(`path '${baselinePath}' exists on disk, but not in`);
}

export async function changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  const baselinePathByPath = new Map(changedPaths.map(pathAndBaselinePath));
  const changedMetrics = [];
  const byPath = Map.groupBy(metrics, (metric) => metric.relativePath);
  for (const [relativePath, fileMetrics] of byPath) {
    if (!baselinePathByPath.has(relativePath)) continue;
    const baselinePath = baselinePathByPath.get(relativePath);
    let baseline = new Map();
    try {
      baseline = await readBaseline(base, baselinePath);
    } catch (error) {
      if (!pathAbsentAtBase(error, baselinePath)) throw error;
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

function emptyDiffCaveat(baseWasExplicit, base) {
  return baseWasExplicit
    ? `Warning: --base ${base} produced an empty diff; this CRAP result is vacuous.`
    : `Warning: no --base was given, so it defaulted to the merge-base with HEAD (${base}) on a clean working tree, leaving nothing to diff; this CRAP result is vacuous. Pass --base to compare against a specific revision.`;
}

export function emptyChangedFunctionWarning({ changedMetrics, workingTreeIsClean, baseWasExplicit, base, allChangedPaths, changedPaths }) {
  if (changedMetrics.length) return null;
  if (!allChangedPaths.length) return emptyDiffCaveat(baseWasExplicit, base);
  if (!changedPaths.length) {
    return `CRAP gate result is out of scope, not vacuous: none of the ${allChangedPaths.length} changed path(s) fall under a scored root (plugins/*/lib, plugins/*/src): ${allChangedPaths.join(', ')}. Report CRAP as unverified or measure this change another way.`;
  }
  return workingTreeIsClean ? 'Warning: no changed functions were found in a clean working tree; this CRAP result is vacuous.' : null;
}

const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NODE_TEST_ARGUMENTS = ['--test', '--test-timeout=300000', 'test/*.test.js'];

async function optionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function suiteFor(plugin) {
  const pluginRoot = path.join(repositoryRoot, 'plugins', plugin);
  const { scripts = {} } = await optionalJson(path.join(pluginRoot, 'package.json'));
  const script = ['test:full', 'test'].find((name) => scripts[name]);
  if (script) return { plugin, cwd: pluginRoot, command: NPM_COMMAND, args: ['run', script] };
  const testFiles = await fs.readdir(path.join(pluginRoot, 'test')).catch(() => []);
  return testFiles.some((file) => file.endsWith('.test.js')) ? { plugin, cwd: pluginRoot, command: process.execPath, args: NODE_TEST_ARGUMENTS } : null;
}

export async function selectSuites(changedPaths) {
  const plugins = new Set(changedPaths.map((changedPath) => /^plugins\/([^/]+)\//.exec(changedPath)?.[1]).filter(Boolean));
  return (await Promise.all([...plugins].sort().map(suiteFor))).filter(Boolean);
}

function spawnSuite(suite, coverageDirectory) {
  return spawnSync(suite.command, suite.args, { cwd: suite.cwd, env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, stdio: 'inherit', shell: process.platform === 'win32' });
}

async function runSuites(suites, runSuite) {
  const coverageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolshed-crap-'));
  try {
    for (const suite of suites) {
      const { status } = runSuite(suite, coverageDirectory);
      if (status !== 0) throw new Error(`${suite.plugin} tests failed with exit ${status ?? 'signal'}`);
    }
  } catch (error) {
    // run()'s finally only starts once captureCoverage returns, so a failing suite would leak the V8 coverage directory.
    await fs.rm(coverageDirectory, { recursive: true, force: true });
    throw error;
  }
  return coverageDirectory;
}

export async function captureCoverage(changedPaths, suppliedDirectory, runSuite = spawnSuite) {
  if (suppliedDirectory) return { coverageDirectory: suppliedDirectory, suiteSummary: 'none, --coverage supplied' };
  const suites = await selectSuites(changedPaths);
  return { coverageDirectory: await runSuites(suites, runSuite), suiteSummary: suites.map((suite) => suite.plugin).join(', ') || 'none, no plugin changed' };
}

function changedPathContext(base) {
  const allChangedEntries = diffEntries(base);
  const changedEntries = diffEntries(base, 'plugins');
  return {
    allChangedPaths: allChangedEntries.map((entry) => entry.path),
    changedEntries,
    changedPaths: changedEntries.map((entry) => entry.path),
  };
}

async function measureMetrics(changedPaths, coverageDirectory) {
  const coverageScripts = await readCoverage(coverageDirectory);
  const sources = (await sourcePaths()).filter((sourcePath) => changedPaths.includes(path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/')));
  const lizardResult = spawnSync('lizard', ['--csv', ...sources], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (lizardResult.status !== 0) throw new Error(`lizard failed with exit ${lizardResult.status ?? 'signal'}`);
  const lizardRecords = parseLizardCsv(lizardResult.stdout || '');
  const lizardByPath = Map.groupBy([...lizardRecords, ...sources.map((sourcePath) => ({ file: sourcePath }))], (entry) => normalizedPath(entry.file));
  return (await Promise.all(sources.map((sourcePath) => sourceMetrics(sourcePath, coverageScripts, lizardByPath.get(normalizedPath(sourcePath)))))).flat();
}

function metricStatus(metric) {
  if (metric.unverified) return 'UNVERIFIED';
  return metric.crap >= THRESHOLD ? 'FAIL' : 'PASS';
}

function writeMetricRows(metrics) {
  metrics.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.line - right.line);
  for (const metric of metrics) process.stdout.write(`${metricStatus(metric)} ${metric.unverified ? formatUnverifiedMetric(metric) : formatMetric(metric)}\n`);
}

function writeGateResult({ base, changedMetrics, failures, unverified, suiteSummary }) {
  if (failures.length || unverified.length) {
    const errors = [...failures, ...unverified.map(formatUnverifiedMetric)];
    process.stderr.write(`CRAP gate failed against ${base} (coverage suites: ${suiteSummary}):\n${errors.map((failure) => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const summary = changedMetrics.length ? `${changedMetrics.length} changed or new functions scored below ${THRESHOLD}.` : 'no changed or new functions were scored.';
  process.stdout.write(`CRAP gate passed against ${base} (coverage suites: ${suiteSummary}): ${summary}\n`);
}

export async function reportMetrics({ allChangedPaths, base, baseWasExplicit, changedEntries, changedPaths, metrics, options, suiteSummary }) {
  const changedMetrics = await changedMetricsAgainstBase(metrics, changedEntries, base);
  const unverified = changedMetrics.filter((metric) => metric.unverified);
  const failures = changedMetrics.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric);
  writeMetricRows(options.all ? metrics : changedMetrics);
  const warning = emptyChangedFunctionWarning({
    changedMetrics,
    workingTreeIsClean: !runGit(['status', '--porcelain']),
    baseWasExplicit,
    base,
    allChangedPaths,
    changedPaths,
  });
  if (warning) process.stderr.write(`${warning}\n`);
  writeGateResult({ base, changedMetrics, failures, unverified, suiteSummary });
  return { metrics, changedMetrics, failures, unverified };
}

export async function run(options = parseArguments(process.argv.slice(2))) {
  const base = mergeBase(options.base);
  const changes = changedPathContext(base);
  const { coverageDirectory, suiteSummary } = await captureCoverage(changes.changedPaths, options.coverageDirectory);
  try {
    const metrics = await measureMetrics(changes.changedPaths, coverageDirectory);
    return reportMetrics({ ...changes, base, baseWasExplicit: Boolean(options.base), metrics, options, suiteSummary });
  } finally {
    if (!options.coverageDirectory) await fs.rm(coverageDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
