import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire, SourceMap } from 'node:module';
import { fileURLToPath, fileURLToPath as fromFileUrl, pathToFileURL } from 'node:url';
import crapCore from './crap-core.cjs';

const { crapScore } = crapCore;
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
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const UNANALYZED_SOURCE_EXTENSIONS = new Set(['.cs', '.py', '.sh', '.ps1', '.svelte', '.tsx', '.jsx']);
const THRESHOLD = 6;
const SIDEQUEST_BUILD_OUTPUT_DIRECTORIES = new Set(['bin', 'hooks', 'lib']);
const NO_COVERAGE_RECORD = 'no suite loaded this file, so it has no coverage record (a script only ever spawned as a child process is covered once the spawning test passes NODE_V8_COVERAGE through; see scripts/quality/README.md)';

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

const DECISION_KINDS = new Set([
  ast.SyntaxKind.IfStatement,
  ast.SyntaxKind.ForStatement,
  ast.SyntaxKind.ForInStatement,
  ast.SyntaxKind.ForOfStatement,
  ast.SyntaxKind.WhileStatement,
  ast.SyntaxKind.DoStatement,
  ast.SyntaxKind.CaseClause,
  ast.SyntaxKind.CatchClause,
  ast.SyntaxKind.ConditionalExpression,
]);
const SHORT_CIRCUIT_OPERATORS = new Set([ast.SyntaxKind.AmpersandAmpersandToken, ast.SyntaxKind.BarBarToken, ast.SyntaxKind.QuestionQuestionToken]);

function isDecision(node) {
  return DECISION_KINDS.has(node.kind) || (ast.isBinaryExpression(node) && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind));
}

// A nested function is discovered as its own descriptor, so both its decisions and its text stay
// out of the enclosing function: the same walk feeds the complexity count and the fingerprint.
function forEachOwnNode(functionNode, onOwnNode, onNestedFunction) {
  function walk(node) {
    if (ast.isFunctionLikeDeclaration(node)) return onNestedFunction(node);
    onOwnNode(node);
    node.forEachChild(walk);
  }
  functionNode.forEachChild(walk);
}

export function cyclomaticComplexity(functionNode) {
  let decisions = 0;
  forEachOwnNode(functionNode, (node) => { if (isDecision(node)) decisions += 1; }, () => {});
  return 1 + decisions;
}

export function ownText(functionNode, text) {
  const pieces = [];
  let cursor = functionNode.getStart();
  forEachOwnNode(functionNode, () => {}, (nested) => {
    pieces.push(text.slice(cursor, nested.getStart()));
    cursor = nested.end;
  });
  return pieces.join('') + text.slice(cursor, functionNode.end);
}

export function parserTransport(requested = process.env.CRAP_PARSER_TRANSPORT || 'sync') {
  const ParserApi = PARSER_TRANSPORTS[requested];
  if (!ParserApi) throw new Error(`Unknown TypeScript parser transport "${requested}"; use sync or async.`);
  return ParserApi;
}

export async function collectFunctions(text, fileName, { transport } = {}) {
  const virtualFile = /\.[cm]?js$/.test(fileName) ? '/source.js' : '/source.ts';
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
        functions.push({ identity, parent: parentId, name, start, end, line: sourceFile.getLineAndCharacterOfPosition(start).line + 1, complexity: cyclomaticComplexity(node), fingerprint: crypto.createHash('sha256').update(ownText(node, text).replace(/\s+/g, ' ')).digest('hex') });
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

function lineStarts(lineLengths) {
  const starts = [0];
  for (const length of lineLengths) starts.push(starts.at(-1) + length + 1);
  return starts;
}

function positionAt(starts, offset) {
  let line = 0;
  while (line + 1 < starts.length - 1 && starts[line + 1] <= offset) line += 1;
  return { line, column: offset - starts[line] };
}

// tsx hands V8 transpiled text, so raw offsets land in the wrong place in the .ts source.
// Node caches the inline source map beside the coverage whenever NODE_V8_COVERAGE is set,
// and node:module decodes it; the delta past the found segment carries a range end through.
export function originalOffsetMapper(cacheEntry, originalText) {
  const sourceMap = new SourceMap(cacheEntry.data);
  const generatedStarts = lineStarts(cacheEntry.lineLengths);
  const originalStarts = lineStarts(originalText.split('\n').map((line) => line.length));
  return (offset) => {
    const { line, column } = positionAt(generatedStarts, offset);
    const entry = sourceMap.findEntry(line, column);
    if (entry.originalLine === undefined) return null;
    return originalStarts[entry.originalLine] + entry.originalColumn + (column - entry.generatedColumn);
  };
}

export function remapRecords(records, toOriginal) {
  return records.flatMap((record) => {
    const ranges = record.ranges.map((range) => ({ ...range, startOffset: toOriginal(range.startOffset), endOffset: toOriginal(range.endOffset) }));
    if (ranges[0].startOffset === null || ranges[0].endOffset === null) return [];
    return [{ ...record, ranges: ranges.filter((range) => range.startOffset !== null && range.endOffset !== null) }];
  });
}

// Only a map whose source is the script itself (tsx transpiling in place) is applied here; the
// Sidequest build ships no map, and its outputs are paired with src by builtOutput instead.
async function originalRecords(script, cacheEntry) {
  const scriptPath = pathFromCoverageUrl(script.url);
  if (!cacheEntry || pathFromCoverageUrl(cacheEntry.data.sources?.[0]) !== scriptPath) return script.functions;
  const originalText = cacheEntry.data.sourcesContent?.[0] ?? await fs.readFile(fromFileUrl(script.url), 'utf8');
  return remapRecords(script.functions, originalOffsetMapper(cacheEntry, originalText));
}

async function reportRecordsByScriptPath(report) {
  const sourceMapCache = report['source-map-cache'] ?? {};
  return Promise.all((report.result ?? []).map(async (script) => [pathFromCoverageUrl(script.url), await originalRecords(script, sourceMapCache[script.url])]));
}

export async function readCoverage(coverageDirectory) {
  const reports = await Promise.all((await fs.readdir(coverageDirectory)).filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await fs.readFile(path.join(coverageDirectory, file), 'utf8'))));
  const scripts = new Map();
  for (const [scriptPath, records] of (await Promise.all(reports.map(reportRecordsByScriptPath))).flat()) {
    if (scriptPath) scripts.set(scriptPath, [...(scripts.get(scriptPath) ?? []), ...records]);
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

function siblingIdentities(descriptors, parent) {
  return descriptors.filter((descriptor) => descriptor.parent === parent).map((descriptor) => descriptor.identity).join('\n');
}

// V8 names an inline callback "" and the build ships no source map, so an unnamed function is
// found by position: its twin in each output has the same identity, trusted only where every
// function under the same parent lines up, since anything looser pins coverage on a neighbour.
function anonymousRecords(descriptor, source, builtOutputs) {
  const sourceSiblings = siblingIdentities(source.descriptors, descriptor.parent);
  const records = [];
  for (const output of builtOutputs) {
    const outputSiblings = siblingIdentities(output.descriptors, descriptor.parent);
    if (!outputSiblings) continue;
    if (outputSiblings !== sourceSiblings) return { unverified: `the functions beside it in ${output.relativePath} do not line up with the source, so its coverage cannot be paired` };
    const twin = output.descriptors.find((candidate) => candidate.identity === descriptor.identity);
    records.push(...output.records.filter((record) => record.ranges[0]?.startOffset === twin.start));
  }
  return { records };
}

// A record on the source itself carries source offsets, so it is paired by position: V8 names
// most callbacks "" and a constructor after its class. A remapped start can still land past the
// AST's (esbuild drops a lone parameter's parentheses; tsx's __name wrapper leaves a zero-parameter
// arrow no segment of its own), so a record belongs to the innermost function holding its start,
// and the end, which maps cleanly, picks the function's own record over a nested class initializer.
function ownRecords(descriptor, source) {
  const nested = source.descriptors.filter((candidate) => candidate.parent === descriptor.identity);
  const holds = (span, offset) => span.start <= offset && offset < span.end;
  const startsHere = ({ ranges: [range] }) => holds(descriptor, range.startOffset) && !nested.some((child) => holds(child, range.startOffset));
  const startedHere = source.records.filter(startsHere);
  const endDistance = ({ ranges: [range] }) => Math.abs(range.endOffset - descriptor.end);
  const nearest = Math.min(...startedHere.map(endDistance));
  return startedHere.filter((record) => endDistance(record) === nearest);
}

// outputs[0] is the source itself; the rest are its build outputs.
export function functionCoverage(descriptor, outputs) {
  const [source, ...builtOutputs] = outputs;
  const paired = descriptor.name === '<anonymous>' ? anonymousRecords(descriptor, source, builtOutputs) : namedRecords(descriptor, builtOutputs);
  if (paired.unverified) return paired;
  const intervals = [...ownRecords(descriptor, source), ...paired.records].flatMap((record) => projectIntervals(record.ranges, descriptor));
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

export async function sourceMetrics(sourcePath, coverageScripts) {
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const descriptors = await collectFunctions(sourceText, sourcePath);
  const relativePath = path.relative(repositoryRoot, sourcePath).replaceAll('\\', '/');
  const source = { relativePath, descriptors, records: coverageScripts.get(normalizedPath(sourcePath)) ?? [] };
  const outputPaths = await outputPathsForSource(sourcePath);
  // Parsing an output is a TypeScript API round trip, and only unnamed functions need it.
  const needsFunctions = descriptors.some((descriptor) => descriptor.name === '<anonymous>');
  const builtOutputs = await Promise.all(outputPaths.filter((outputPath) => outputPath !== sourcePath).map((outputPath) => builtOutput(outputPath, coverageScripts, needsFunctions)));
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

function siblingsBetweenAnchors(siblings, anchors) {
  let segment = 0;
  const between = [];
  for (const sibling of siblings) {
    if (anchors.has(sibling)) segment += 1;
    else between.push({ segment, sibling });
  }
  return Map.groupBy(between, (entry) => entry.segment);
}

function pairInOrder(heads, bases, pairs, accepts) {
  const taken = new Set(pairs.values());
  const free = bases.filter((base) => !taken.has(base));
  for (const head of heads) {
    const index = pairs.has(head) ? -1 : free.findIndex((base) => accepts(head, base));
    if (index >= 0) pairs.set(head, free.splice(index, 1)[0]);
  }
}

// An identity ends in a per-parent ordinal, so an inserted or deleted sibling shifts every later one.
// Siblings whose own text appears exactly once on each side anchor the pairing; the rest pair in order
// within the gap between the same two anchors, equal text first, so an edited body keeps its partner.
function pairSiblings(baseSiblings, headSiblings) {
  const baseByFingerprint = Map.groupBy(baseSiblings, (sibling) => sibling.fingerprint);
  const headByFingerprint = Map.groupBy(headSiblings, (sibling) => sibling.fingerprint);
  const isUnique = (groups, sibling) => groups.get(sibling.fingerprint)?.length === 1;
  const pairs = new Map(headSiblings.filter((head) => isUnique(headByFingerprint, head) && isUnique(baseByFingerprint, head)).map((head) => [head, baseByFingerprint.get(head.fingerprint)[0]]));
  const baseGaps = siblingsBetweenAnchors(baseSiblings, new Set(pairs.values()));
  for (const [segment, headEntries] of siblingsBetweenAnchors(headSiblings, new Set(pairs.keys()))) {
    const heads = headEntries.map((entry) => entry.sibling);
    const bases = (baseGaps.get(segment) ?? []).map((entry) => entry.sibling);
    pairInOrder(heads, bases, pairs, (head, base) => head.fingerprint === base.fingerprint);
    pairInOrder(heads, bases, pairs, () => true);
  }
  return pairs;
}

// Pairs top-down, so a function's children are compared only with the children of its own partner.
export function baseFunctionByIdentity(baseFunctions, headFunctions) {
  const baseChildren = Map.groupBy(baseFunctions, (descriptor) => descriptor.parent);
  const headChildren = Map.groupBy(headFunctions, (descriptor) => descriptor.parent);
  const partners = new Map();
  const pairChildren = (baseParent, headParent) => {
    for (const [head, base] of pairSiblings(baseChildren.get(baseParent) ?? [], headChildren.get(headParent) ?? [])) {
      partners.set(head.identity, base);
      pairChildren(base.identity, head.identity);
    }
  };
  pairChildren('<root>', '<root>');
  return partners;
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
    let baseline = [];
    try {
      baseline = await readBaseline(base, baselinePath);
    } catch (error) {
      if (!pathAbsentAtBase(error, baselinePath)) throw error;
    }
    const partners = baseFunctionByIdentity(baseline, fileMetrics);
    changedMetrics.push(...fileMetrics.filter((metric) => partners.get(metric.identity)?.fingerprint !== metric.fingerprint));
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
  try {
    for (const suite of suites) {
      const { status } = runSuite(suite, coverageDirectory);
      if (status !== 0) throw new Error(`${suite.name} tests failed with exit ${status ?? 'signal'}`);
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
