import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyzer, baseFunctionByIdentity, changedMetricsAgainstBase as changedMetrics, functionCoverage, readCoverage, remapRecords, originalOffsetMapper } from '../../plugins/quality-gate/lib/core.mjs';
import { crapScore, formatMetric, measureSource, readOutput } from '../../plugins/quality-gate/lib/measure.mjs';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const sidequestRoot = path.join(repositoryRoot, 'plugins', 'sidequest');
const { collectFunctions, cyclomaticComplexity, ownText, parserTransport } = await createAnalyzer(repositoryRoot);
export { collectFunctions, cyclomaticComplexity, ownText, parserTransport, functionCoverage, readCoverage, remapRecords, originalOffsetMapper, baseFunctionByIdentity };
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const UNANALYZED_SOURCE_EXTENSIONS = new Set(['.cs', '.py', '.sh', '.ps1', '.svelte', '.tsx', '.jsx']);
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

export function isScoredSource(sourcePath) {
  if (!SOURCE_EXTENSIONS.has(path.extname(sourcePath))) return false;
  const [sidequestDirectory] = path.relative(sidequestRoot, sourcePath).replaceAll('\\', '/').split('/');
  return !SIDEQUEST_BUILD_OUTPUT_DIRECTORIES.has(sidequestDirectory);
}

export function noAnalyzerMetric(relativePath) {
  const extension = path.extname(relativePath);
  if (!UNANALYZED_SOURCE_EXTENSIONS.has(extension)) return null;
  return { relativePath, line: 1, name: path.basename(relativePath), unverified: `this gate has no analyzer for ${extension} sources` };
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

export async function builtOutput(outputPath, coverageScripts, needsFunctions) {
  return readOutput(outputPath, coverageScripts, needsFunctions, { projectRoot: repositoryRoot, analyzer: { collectFunctions } });
}

export async function sourceMetrics(sourcePath, coverageScripts) {
  return measureSource(sourcePath, coverageScripts, { projectRoot: repositoryRoot, analyzer: { collectFunctions }, outputPaths: await outputPathsForSource(sourcePath) });
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
  return runGit(args, cwd).split('\n').filter((line) => line && !line.startsWith('D')).map((line) => {
    const [status, ...fields] = line.split('\t');
    return status.startsWith('R') ? { path: fields[1], baselinePath: fields[0] } : { path: fields[0], baselinePath: fields[0] };
  });
}

export async function baselineFunctions(base, relativePath, cwd = repositoryRoot) {
  return collectFunctions(runGit(['show', `${base}:${relativePath}`], cwd), relativePath);
}

export async function changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  return changedMetrics(metrics, changedPaths, base, readBaseline);
}

export async function compareAgainstBase(metrics, changedPaths, base, readBaseline = baselineFunctions) {
  const changedMetrics = await changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline);
  return changedMetrics.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric);
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
    return `CRAP gate result is out of scope, not vacuous: none of the ${allChangedPaths.length} changed path(s) is a JavaScript or TypeScript source this gate scores: ${allChangedPaths.join(', ')}. Report CRAP as unverified or measure this change another way.`;
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

// Repository scripts outside the plugins, each with the documented command for its tests.
const REPOSITORY_SUITES = [
  { prefix: 'scripts/quality/', name: 'scripts/quality', args: ['--test', 'scripts/quality/*.test.mjs'] },
  { prefix: 'scripts/release/', name: 'scripts/release', args: ['--test', 'scripts/release/test/*.test.mjs'] },
  { prefix: 'docs/scripts/', name: 'docs', args: ['--test', 'docs/scripts/content.test.mjs'] },
];

async function suiteFor(plugin) {
  const pluginRoot = path.join(repositoryRoot, 'plugins', plugin);
  const { scripts = {} } = await optionalJson(path.join(pluginRoot, 'package.json'));
  const script = ['test:full', 'test'].find((name) => scripts[name]);
  if (script) return { name: plugin, cwd: pluginRoot, command: NPM_COMMAND, args: ['run', script] };
  const testFiles = await fs.readdir(path.join(pluginRoot, 'test')).catch(() => []);
  return testFiles.some((file) => file.endsWith('.test.js')) ? { name: plugin, cwd: pluginRoot, command: process.execPath, args: NODE_TEST_ARGUMENTS } : null;
}

function repositorySuites(changedPaths) {
  return REPOSITORY_SUITES
    .filter((suite) => changedPaths.some((changedPath) => changedPath.startsWith(suite.prefix)))
    .map((suite) => ({ name: suite.name, cwd: repositoryRoot, command: process.execPath, args: suite.args }));
}

export async function selectSuites(changedPaths) {
  const plugins = new Set(changedPaths.map((changedPath) => /^plugins\/([^/]+)\//.exec(changedPath)?.[1]).filter(Boolean));
  const pluginSuites = (await Promise.all([...plugins].sort().map(suiteFor))).filter(Boolean);
  return [...pluginSuites, ...repositorySuites(changedPaths)];
}

// node --test refuses to run files while NODE_TEST_CONTEXT says it is already inside a test, so
// a gate started from a test (its own CLI fixture) must not hand that marker to the suites.
function spawnSuite(suite, coverageDirectory) {
  const { NODE_TEST_CONTEXT, ...environment } = process.env;
  return spawnSync(suite.command, suite.args, { cwd: suite.cwd, env: { ...environment, NODE_V8_COVERAGE: coverageDirectory }, stdio: 'inherit', shell: process.platform === 'win32' });
}

async function runSuites(suites, runSuite) {
  const coverageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolshed-crap-'));
  for (const suite of suites) {
    const { status } = runSuite(suite, coverageDirectory);
    if (status !== 0) throw new Error(`${suite.name} tests failed with exit ${status ?? 'signal'}`);
  }
  return coverageDirectory;
}

export async function captureCoverage(changedPaths, suppliedDirectory, runSuite = spawnSuite) {
  if (suppliedDirectory) return { coverageDirectory: suppliedDirectory, suiteSummary: 'none, --coverage supplied' };
  const suites = await selectSuites(changedPaths);
  return { coverageDirectory: await runSuites(suites, runSuite), suiteSummary: suites.map((suite) => suite.name).join(', ') || 'none, no suite covers the changed paths' };
}

export function changedPathContext(base, allChangedEntries = diffEntries(base)) {
  const changedEntries = allChangedEntries.filter((entry) => isScoredSource(path.join(repositoryRoot, entry.path)));
  return {
    allChangedPaths: allChangedEntries.map((entry) => entry.path),
    changedEntries,
    changedPaths: changedEntries.map((entry) => entry.path),
    unanalyzed: allChangedEntries.map((entry) => noAnalyzerMetric(entry.path)).filter(Boolean),
  };
}

async function measureMetrics(changedPaths, coverageDirectory) {
  const coverageScripts = await readCoverage(coverageDirectory);
  return (await Promise.all(changedPaths.map((changedPath) => sourceMetrics(path.join(repositoryRoot, changedPath), coverageScripts)))).flat();
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

export async function reportMetrics({ allChangedPaths, base, baseWasExplicit, changedEntries, changedPaths, metrics, options, suiteSummary, unanalyzed = [] }) {
  const changedMetrics = [...await changedMetricsAgainstBase(metrics, changedEntries, base), ...unanalyzed];
  const unverified = changedMetrics.filter((metric) => metric.unverified);
  const failures = changedMetrics.filter((metric) => !metric.unverified && metric.crap >= THRESHOLD).map(formatMetric);
  writeMetricRows(options.all ? [...metrics, ...unanalyzed] : changedMetrics);
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
