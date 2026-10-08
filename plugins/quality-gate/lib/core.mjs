import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { fileURLToPath as fromFileUrl } from 'node:url';
import { loadCompiler } from './compiler.mjs';

export async function createAnalyzer(projectRoot) {
  const { ast, SyncParserApi, AsyncParserApi, createVirtualFileSystem } = await loadCompiler(projectRoot);
  const PARSER_TRANSPORTS = { sync: SyncParserApi, async: AsyncParserApi };
  function functionName(node) {
    if (ast.isConstructorDeclaration(node)) return 'constructor';
    const parent = node.parent;
    const namedParents = [ast.SyntaxKind.VariableDeclaration, ast.SyntaxKind.PropertyAssignment, ast.SyntaxKind.PropertyDeclaration];
    const name = node.name || (namedParents.includes(parent.kind) ? parent.name : null);
    return name?.getText() ?? assignedFunctionName(parent);
  }
  
  function assignedFunctionName(parent) {
    return ast.isBinaryExpression(parent) ? parent.left.getText() : '<anonymous>';
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
  
  function cyclomaticComplexity(functionNode) {
    let decisions = 0;
    forEachOwnNode(functionNode, (node) => { if (isDecision(node)) decisions += 1; }, () => {});
    return 1 + decisions;
  }
  
  function ownText(functionNode, text) {
    const pieces = [];
    let cursor = functionNode.getStart();
    forEachOwnNode(functionNode, () => {}, (nested) => {
      pieces.push(text.slice(cursor, nested.getStart()));
      cursor = nested.end;
    });
    return pieces.join('') + text.slice(cursor, functionNode.end);
  }
  
  function parserTransport(requested = process.env.CRAP_PARSER_TRANSPORT || 'sync') {
    const ParserApi = PARSER_TRANSPORTS[requested];
    if (!ParserApi) throw new Error(`Unknown TypeScript parser transport "${requested}"; use sync or async.`);
    return ParserApi;
  }
  
  async function collectFunctions(text, fileName, { transport } = {}) {
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
  return { collectFunctions, cyclomaticComplexity, ownText, parserTransport };
}

export function normalizedPath(filePath) {
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
  for (const output of builtOutputs.filter((candidate) => siblingIdentities(candidate.descriptors, descriptor.parent))) {
    const outputSiblings = siblingIdentities(output.descriptors, descriptor.parent);
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
// within the gap between the same two anchors, equal text first, then equal name, so an edited body
// keeps its partner and a helper inserted above it does not take that partner and read as legacy.
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
    pairInOrder(heads, bases, pairs, (head, base) => head.name === base.name);
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

export const LEGACY_UNCHANGED = 'legacy-unchanged';

// Only complexity the change introduced is enforced: a function new since base, or one whose
// cyclomatic count rose above its base partner's. Equal or lower is a pass-through edit inside a
// legacy body, reported with its number but never a refusal to land the change.
function classifyChange(metric, partner) {
  if (!partner) return 'new';
  return metric.complexity > partner.complexity ? 'modified-raised' : LEGACY_UNCHANGED;
}

function changedFunctions(fileMetrics, baseline) {
  const partners = baseFunctionByIdentity(baseline, fileMetrics);
  return fileMetrics
    .filter((metric) => partners.get(metric.identity)?.fingerprint !== metric.fingerprint)
    .map((metric) => ({ ...metric, classification: classifyChange(metric, partners.get(metric.identity)) }));
}

export async function changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline) {
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
    changedMetrics.push(...changedFunctions(fileMetrics, baseline));
  }
  return changedMetrics;
}

