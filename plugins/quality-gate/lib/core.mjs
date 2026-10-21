import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { fileURLToPath as fromFileUrl } from 'node:url';
import { loadCompiler } from './compiler.mjs';
import { conditionalDescriptors, conditionResult, inChangedLines } from './branches.mjs';
import { observeCaptureGaps } from './capture-gaps.mjs';

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
  
  // LCOV only reports lines, so the denominator is the start line of each emitted statement the
  // body owns: blocks, empty statements and type-only or ambient declarations emit no code.
  const NON_EXECUTABLE_STATEMENTS = new Set([ast.SyntaxKind.Block, ast.SyntaxKind.EmptyStatement, ast.SyntaxKind.InterfaceDeclaration, ast.SyntaxKind.TypeAliasDeclaration]);

  function isExecutableStatement(node) {
    return ast.isStatement(node) && !NON_EXECUTABLE_STATEMENTS.has(node.kind) && !node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.DeclareKeyword);
  }

  function statementStartAfterDecorators(node, text) {
    const lastDecorator = node.modifiers?.findLast(ast.isDecorator);
    return lastDecorator ? ast.skipTrivia(text, lastDecorator.end) : node.getStart();
  }

  function executableLines(functionNode, sourceFile, text) {
    const starts = ast.isBlock(functionNode.body) ? [] : [functionNode.body.getStart()];
    forEachOwnNode(functionNode, (node) => { if (isExecutableStatement(node)) starts.push(statementStartAfterDecorators(node, text)); }, () => {});
    return [...new Set(starts.map((start) => sourceFile.getLineAndCharacterOfPosition(start).line + 1))].sort((left, right) => left - right);
  }

  function logicalOperatorBoundary(node) {
    if (!ast.isBinaryExpression(node) || !SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)) return null;
    return { kind: node.operatorToken.kind, start: node.operatorToken.getStart(), anchorStart: node.right.getStart(), anchorEnd: node.right.end };
  }

  function finallyBoundary(node) {
    if (!ast.isTryStatement(node) || !node.finallyBlock) return null;
    const token = ast.findPrecedingToken(node.getSourceFile(), node.finallyBlock.getStart());
    if (token?.kind !== ast.SyntaxKind.FinallyKeyword) return null;
    return { kind: token.kind, start: token.getStart(), anchorStart: node.finallyBlock.getStart(), anchorEnd: node.finallyBlock.end };
  }

  function runtimeBoundaries(functionNode) {
    const boundaries = [];
    forEachOwnNode(functionNode, (node) => {
      const boundary = logicalOperatorBoundary(node) ?? finallyBoundary(node);
      if (boundary) boundaries.push(boundary);
    }, () => {});
    return boundaries;
  }

  function parserTransport(requested = process.env.CRAP_PARSER_TRANSPORT || 'sync') {
    const ParserApi = PARSER_TRANSPORTS[requested];
    if (!ParserApi) throw new Error(`Unknown TypeScript parser transport "${requested}"; use sync or async.`);
    return ParserApi;
  }
  
  function runtimeStart(node, text) {
    return node.getStart() + (text.slice(node.getStart()).match(/^export\s+(?:default\s+)?/)?.[0].length ?? 0);
  }

  function functionsIn(sourceFile, text) {
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
        const lines = executableLines(node, sourceFile, text);
        functions.push({ identity, parent: parentId, name, start, runtimeStart: runtimeStart(node, text), bodyStart: node.body.getStart(), conditions: conditionalDescriptors(ast, node, forEachOwnNode), boundaries: runtimeBoundaries(node), end, line: sourceFile.getLineAndCharacterOfPosition(start).line + 1, complexity: cyclomaticComplexity(node), fingerprint: crypto.createHash('sha256').update(ownText(node, text)).digest('hex'), ownedLines: lines, executableLines: lines });
        node.forEachChild((child) => visit(child, identity));
      } else node.forEachChild((child) => visit(child, parentId));
    }
    visit(sourceFile);
    return functions;
  }

  function virtualExtension(fileName) {
    if (/\.(jsx|tsx)$/i.test(fileName)) return path.extname(fileName).toLowerCase();
    return /\.[cm]?js$/.test(fileName) ? '.js' : '.ts';
  }

  // One sync tsc --api child serves the whole run (GH-554): a child per file exhausted per-user
  // process limits. Only the sync child is unref'd and dies with this process; an async child holds
  // the event loop open until closed, so async parsers stay per call for callers that never close.
  let sharedParser = null;
  let parseQueue = Promise.resolve();

  function openParser(ParserApi) {
    const fileSystem = createVirtualFileSystem({});
    return { fileSystem, api: new ParserApi({ cwd: '/', fs: fileSystem }), parsed: 0, deleted: [] };
  }

  async function withParser(transport, parse) {
    const ParserApi = parserTransport(transport);
    if (ParserApi !== SyncParserApi) {
      const parser = openParser(ParserApi);
      try {
        return await parse(parser);
      } finally {
        await closeParserApi(parser.api);
      }
    }
    sharedParser ??= openParser(ParserApi);
    return parse(sharedParser);
  }

  // The server keeps a virtual file's first content even under invalidateAll, so every parse gets a
  // fresh file name and names its changes explicitly.
  async function parseFunctions(text, fileName, parser) {
    const { fileSystem, api } = parser;
    const virtualFile = `/source-${parser.parsed++}${virtualExtension(fileName)}`;
    fileSystem.writeFile('/tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true }, files: [virtualFile] }));
    fileSystem.writeFile(virtualFile, text);
    const snapshot = await api.updateSnapshot({ openProject: '/tsconfig.json', fileChanges: { changed: ['/tsconfig.json'], created: [virtualFile], deleted: parser.deleted } });
    try {
      const sourceFile = await snapshot.getProject('/tsconfig.json').program.getSourceFile(virtualFile);
      if (!sourceFile) throw new Error(`TypeScript could not parse ${fileName}.`);
      return functionsIn(sourceFile, text);
    } finally {
      await snapshot.dispose();
      fileSystem.removeFile(virtualFile);
      parser.deleted = [virtualFile];
    }
  }

  // A parser holds one virtual file at a time, and at most one child may run, so parses queue.
  function collectFunctions(text, fileName, { transport } = {}) {
    const parsed = parseQueue.then(() => withParser(transport, (parser) => parseFunctions(text, fileName, parser)));
    parseQueue = parsed.catch(() => {});
    return parsed;
  }

  async function close() {
    await parseQueue;
    if (!sharedParser) return;
    const { api } = sharedParser;
    sharedParser = null;
    await closeParserApi(api);
  }
  return { collectFunctions, close, cyclomaticComplexity, ownText, parserTransport };
}

// The TypeScript API's close() only signals the child (kill on sync, stdin EOF on async) and exposes
// no exit handle, so wait on the internal child to know it is reaped before the run returns.
async function closeParserApi(api) {
  const child = api.client?.channel?.child ?? api.client?.process;
  const exited = child?.exitCode === null && child.signalCode === null ? once(child, 'exit') : null;
  child?.ref();
  await api.close();
  await exited;
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

export function originalOffsetMapper(cacheEntry, originalText, generatedText) {
  if (cacheEntry.data.sources.length !== 1) throw new Error('Only single-source compiler maps are supported.');
  if (cacheEntry.data.sourcesContent.length !== 1) throw new Error('Compiler map source content is ambiguous.');
  if (cacheEntry.data.sourcesContent[0] !== originalText) throw new Error('Compiler map source bytes do not match.');
  const sourceMap = new SourceMap(cacheEntry.data);
  const generatedStarts = lineStarts(cacheEntry.lineLengths);
  const originalStarts = lineStarts(originalText.split('\n').map((line) => line.length));
  const toOriginal = (offset, boundaryBytes = 0) => {
    const { line, column } = positionAt(generatedStarts, offset);
    const entry = sourceMap.findEntry(line, column);
    if (!Number.isInteger(entry.originalLine)) return null;
    const original = originalStarts[entry.originalLine] + entry.originalColumn;
    if (typeof originalText[original] !== 'string') return null;
    const generated = generatedStarts[entry.generatedLine] + entry.generatedColumn;
    const delta = offset - generated;
    if (generatedText.slice(generated, offset + boundaryBytes) !== originalText.slice(original, original + delta + boundaryBytes)) return null;
    return original + delta;
  };
  toOriginal.exactDeclarationStart = (offset) => {
    const { line, column } = positionAt(generatedStarts, offset);
    const entry = sourceMap.findEntry(line, column);
    if (!Number.isInteger(entry.originalLine)) return null;
    if (entry.generatedLine !== line || entry.generatedColumn !== column) return null;
    return originalStarts[entry.originalLine] + entry.originalColumn;
  };
  return toOriginal;
}

export function remapRecords(records, toOriginal) {
  return records.flatMap((record) => {
    const ranges = record.ranges.map((range) => ({ ...range, startOffset: toOriginal(range.startOffset), endOffset: toOriginal(range.endOffset, true) }));
    if (ranges.some((range) => range.startOffset === null || range.endOffset === null)) return [];
    return [{ ...record, ranges }];
  });
}

function inspectorResult(session, method, parameters = {}) {
  let response;
  session.post(method, parameters, (error, result) => {
    if (error) throw error;
    response = result;
  });
  return response;
}

export function startCoverageCapture(directory) {
  const session = new Session();
  session.connect();
  inspectorResult(session, 'Debugger.enable');
  inspectorResult(session, 'Profiler.enable');
  inspectorResult(session, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const captureId = crypto.randomUUID();
  const uncapturedChildren = observeCaptureGaps();
  process.once('exit', () => {
    const { result } = inspectorResult(session, 'Profiler.takePreciseCoverage');
    const scripts = result.filter((script) => pathFromCoverageUrl(script.url)).map((script) => ({ ...script, source: inspectorResult(session, 'Debugger.getScriptSource', { scriptId: script.scriptId }).scriptSource }));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `owned-${captureId}.json`), JSON.stringify({ qualityGate: { version: 'v8-owned-1', captureId, pid: process.pid, branchCapture: 1, uncapturedChildren: [...uncapturedChildren] }, result: scripts }));
    session.disconnect();
  });
}

function capturedScript(report, script) {
  if (report.qualityGate?.version !== 'v8-owned-1' || !report.qualityGate.captureId || !report.qualityGate.pid) return { unverified: 'missing same-session executed-byte capture binding; recapture with the Quality Gate core preload' };
  if (typeof script.source !== 'string') return { unverified: 'missing executed script bytes in the bound capture' };
  const records = script.functions.filter((record, index) => index !== 0 || record.ranges[0]?.startOffset !== 0 || record.ranges[0]?.endOffset !== script.source.length);
  return { text: script.source, records };
}

export async function readCoverage(coverageDirectory) {
  const reports = await Promise.all((await fs.readdir(coverageDirectory)).filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await fs.readFile(path.join(coverageDirectory, file), 'utf8'))));
  const scripts = new Map();
  scripts.branchUnverified = branchCaptureProblem(reports);
  const entries = reports.flatMap((report) => (report.result ?? []).map((script) => [pathFromCoverageUrl(script.url), capturedScript(report, script)]));
  for (const [scriptPath, capture] of entries) {
    if (scriptPath) scripts.set(scriptPath, [...(scripts.get(scriptPath) ?? []), capture]);
  }
  return scripts;
}

function embeddedSourceMap(text) {
  const encoded = text.match(/\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([^\s]+)/);
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function mappedSource(capture, source) {
  if (capture.text === source.text) return (offset) => offset;
  const data = embeddedSourceMap(capture.text);
  try {
    const originalPath = path.resolve(path.dirname(capture.filePath), data.sourceRoot ?? '', data.sources[0]);
    if (normalizedPath(originalPath) !== source.filePath) return null;
    return originalOffsetMapper({ data, lineLengths: capture.text.split('\n').map((line) => line.length) }, source.text, capture.text);
  } catch {
    return null;
  }
}

function runtimeBoundaryOffsets(original, generated, toOriginal) {
  const pairs = generated.boundaries.flatMap((boundary) => {
    const twins = original.boundaries.filter((candidate) => candidate.kind === boundary.kind && toOriginal(boundary.anchorStart, 1) === candidate.anchorStart && toOriginal(boundary.anchorEnd - 1, 1) === candidate.anchorEnd - 1);
    return twins.length === 1 ? [{ generated: boundary.start, original: twins[0].start }] : [];
  });
  const offsets = new Map();
  for (const twins of Map.groupBy(pairs, (pair) => pair.original).values()) {
    if (twins.length === 1) offsets.set(twins[0].generated, twins[0].original);
  }
  return offsets;
}

// CommonJS can map an erased export prefix at the exact AST declaration start; typed returns can erase the body-start segment.
function runtimeBodyRecords(descriptor, source, capture) {
  if (capture.unverified) return capture;
  const toOriginal = mappedSource(capture, source);
  if (!toOriginal) return { unverified: `executed bytes differ from ${source.relativePath}; an authentic matching source map is required` };
  const twins = capture.descriptors.filter((candidate) => (toOriginal(candidate.bodyStart) === descriptor.bodyStart || toOriginal(candidate.runtimeStart, 1) === descriptor.runtimeStart || toOriginal.exactDeclarationStart?.(candidate.start) === descriptor.start) && toOriginal(candidate.end - 1) === descriptor.end - 1);
  if (twins.length !== 1) return { unverified: 'missing or ambiguous source-map correspondence for the owned runtime body' };
  const twin = twins[0];
  const records = capture.records.filter((record) => record.ranges[0]?.startOffset === twin.runtimeStart && record.ranges[0]?.endOffset === twin.end);
  if (records.length > 1) return { unverified: 'ambiguous exact runtime range for the owned function body' };
  const boundaries = runtimeBoundaryOffsets(descriptor, twin, toOriginal);
  return { records, toOriginal: (offset, boundaryBytes) => toOriginal(offset, boundaryBytes) ?? boundaries.get(offset) ?? null };
}

// Compilers re-indent the whitespace before a closing token, so a block end that lands on it binds through the token itself.
function mappedEnd(offset, toOriginal) {
  const last = toOriginal(offset - 1);
  return last === null ? toOriginal(offset, 1) : last + 1;
}

function outputCoverage(descriptor, source, output) {
  const intervals = [];
  let measured = 0;
  for (const capture of output.captures) {
    const owned = runtimeBodyRecords(descriptor, source, capture);
    if (owned.unverified) return owned;
    if (!owned.records.length) continue;
    measured += 1;
    const mapped = remapRecords(owned.records, (offset, isEnd) => isEnd ? mappedEnd(offset, owned.toOriginal) : owned.toOriginal(offset));
    if (!mapped.length) return { unverified: 'a runtime coverage boundary has no exact source-map or unique owned AST correspondence' };
    intervals.push(...coverageIntervals(mapped[0].ranges));
  }
  return { intervals, measured };
}

function ownBodyIntervals(descriptor, descriptors) {
  const nested = descriptors.filter((candidate) => candidate.parent === descriptor.identity && candidate.end > descriptor.bodyStart);
  const intervals = [];
  let start = nested.some((child) => child.start === descriptor.bodyStart && child.end === descriptor.end) ? descriptor.runtimeStart : descriptor.bodyStart;
  for (const child of nested) {
    intervals.push([start, child.start]);
    start = child.end;
  }
  intervals.push([start, descriptor.end]);
  return intervals;
}

export function functionCoverage(descriptor, outputs) {
  const [source] = outputs;
  if (outputs.some((output) => !output.captures)) return { unverified: 'missing executed-byte capture binding for the owned function body' };
  const measured = outputs.filter((output) => output.captures.length).map((output) => outputCoverage(descriptor, source, output));
  if (!measured.length) return { unverified: 'no executed-byte capture for the owned function body' };
  const unverified = measured.find((result) => result.unverified);
  if (unverified) return unverified;
  if (!measured.some((result) => result.measured)) return { unverified: 'no captured exact runtime range for the owned function body' };
  const covered = mergeIntervals(measured.flatMap((result) => result.intervals));
  const owned = ownBodyIntervals(descriptor, source.descriptors);
  const total = owned.reduce((length, [start, end]) => length + end - start, 0);
  const coveredLength = owned.reduce((length, [start, end]) => length + covered.reduce((sum, [left, right]) => sum + Math.max(0, Math.min(end, right) - Math.max(start, left)), 0), 0);
  return { coverage: coveredLength / total };
}

function branchCaptureProblem(reports) {
  if (reports.some((report) => report.qualityGate?.branchCapture !== 1)) return 'branch capture completeness UNVERIFIED: recapture with child-gap observation enabled';
  const commands = reports.flatMap((report) => report.qualityGate.uncapturedChildren ?? []);
  return commands.length ? `branch capture completeness UNVERIFIED: child environment dropped the core preload or capture directory (${[...new Set(commands)].join(', ')})` : undefined;
}

function branchRecords(descriptor, source, output) {
  return output.captures.map((capture) => {
    const owned = runtimeBodyRecords(descriptor, source, capture);
    if (owned.unverified) return owned;
    const records = remapRecords(owned.records, (offset, isEnd) => isEnd ? mappedEnd(offset, owned.toOriginal) : owned.toOriginal(offset));
    return records.length === owned.records.length ? { records } : { unverified: 'branch boundary has no exact source-map correspondence' };
  });
}

export function functionBranches(descriptor, outputs, changedLines, captureProblem) {
  const results = outputs.flatMap((output) => branchRecords(descriptor, outputs[0], output));
  const records = results.flatMap((result) => result.records ?? []);
  const unverified = captureProblem ?? results.find((result) => result.unverified)?.unverified ?? (records.length ? undefined : 'no captured exact runtime range for branch outcomes');
  return descriptor.conditions.filter((condition) => inChangedLines(condition, changedLines)).map((condition) => conditionResult(condition, records, unverified)).filter(Boolean);
}

if (process.env.QUALITY_GATE_V8_CAPTURE) startCoverageCapture(process.env.QUALITY_GATE_V8_CAPTURE);

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

function classifyChange(metric, partner) {
  if (!partner) return 'new';
  return metric.complexity > partner.complexity ? 'modified-raised' : LEGACY_UNCHANGED;
}

function changedFunctions(fileMetrics, baseline, relativePath, removedMetrics) {
  const partners = baseFunctionByIdentity(baseline, fileMetrics);
  const retained = new Set(partners.values());
  removedMetrics.push(...baseline.filter((metric) => !retained.has(metric)).map((metric) => ({ ...metric, relativePath })));
  return fileMetrics
    .filter((metric) => partners.get(metric.identity)?.fingerprint !== metric.fingerprint)
    .map((metric) => ({ ...metric, classification: classifyChange(metric, partners.get(metric.identity)) }));
}

export async function changedMetricsAgainstBase(metrics, changedPaths, base, readBaseline, removedMetrics = []) {
  const baselinePathByPath = new Map(changedPaths.map(pathAndBaselinePath));
  const changedMetrics = [];
  const byPath = Map.groupBy(metrics, (metric) => metric.relativePath);
  for (const [relativePath, baselinePath] of baselinePathByPath) {
    const fileMetrics = byPath.get(relativePath) ?? [];
    let baseline = [];
    try {
      baseline = await readBaseline(base, baselinePath);
    } catch (error) {
      if (!pathAbsentAtBase(error, baselinePath)) throw error;
    }
    changedMetrics.push(...changedFunctions(fileMetrics, baseline, relativePath, removedMetrics));
  }
  return changedMetrics;
}

