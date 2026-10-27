import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Nothing in this module may look at a file extension or language name: any generator that writes a
// flat Source Map v3 with sourcesContent is handled the same way (SQ-3955).

class SourceMapRefusal extends Error {}

const refuse = (reason) => { throw new SourceMapRefusal(reason); };
const refuseIf = (reason) => { if (reason) refuse(reason); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAP_COMMENT = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*]+)/g;
const TRAILING_MAP_COMMENT_LINE = /(^|\n)[^\n]*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=[^\n]*\n?$/;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.claude']);

const projectRelative = (root, absolute) => path.relative(root, absolute).replaceAll('\\', '/');
const existingFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile();

function insideProject(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The coverage command may create generated files and maps, but any that already existed must still
// hold these bytes when its LCOV is read.
export function projectFileHashes(root, directory = root, hashes = {}) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) projectFileHashes(root, target, hashes);
    else if (entry.isFile()) hashes[projectRelative(root, target)] = sha256(fs.readFileSync(target));
  }
  return hashes;
}

const signedVlq = (value) => (value % 2 ? -(value - 1) / 2 : value / 2);

function vlqValues(segmentText) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const character of segmentText) {
    const digit = BASE64_DIGITS.indexOf(character);
    if (digit < 0) refuse(`mappings contain the invalid VLQ character "${character}"`);
    value += (digit & 31) * 2 ** shift;
    shift += 5;
    if (digit & 32) continue;
    values.push(signedVlq(value));
    value = 0;
    shift = 0;
  }
  if (shift) refuse('mappings end inside an unterminated VLQ value');
  return values;
}

function decodedLine(lineText, state) {
  const segments = [];
  let generatedColumn = 0;
  for (const segmentText of lineText.split(',').filter(Boolean)) {
    const values = vlqValues(segmentText);
    if (![1, 4, 5].includes(values.length)) refuse(`mapping segment "${segmentText}" has ${values.length} fields; Source Map v3 allows 1, 4 or 5`);
    generatedColumn += values[0];
    if (values.length === 1) continue;
    state.source += values[1];
    state.originalLine += values[2];
    segments.push({ generatedColumn, source: state.source, originalLine: state.originalLine });
  }
  return segments;
}

export function decodeMappings(mappings) {
  const state = { source: 0, originalLine: 0 };
  return mappings.split(';').map((lineText) => decodedLine(lineText, state));
}

function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  if (comma < 0) refuse('inline sourceMappingURL is not a valid data: URL');
  const payload = url.slice(comma + 1);
  return url.slice(0, comma).endsWith(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}

function mapFileLocation(generatedPath, url) {
  if (url.startsWith('file:')) return fileURLToPath(url);
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !path.isAbsolute(url)) refuse(`sourceMappingURL ${url} is neither a data: URL nor a local path`);
  return path.resolve(path.dirname(generatedPath), decodeURIComponent(url));
}

function readMapFile(mapPath, declared) {
  if (existingFile(mapPath)) return { kind: 'file', path: mapPath, bytes: fs.readFileSync(mapPath) };
  return declared ? refuse(`declared source map ${mapPath} is missing`) : null;
}

// Contract 1, discovery: the last sourceMappingURL in the generated file, else a sibling <file>.map.
export function locateSourceMap(generatedPath, generatedText) {
  const url = [...generatedText.matchAll(MAP_COMMENT)].at(-1)?.[1];
  if (url?.startsWith('data:')) return { kind: 'inline', path: null, bytes: dataUrlBytes(url) };
  if (url) return readMapFile(mapFileLocation(generatedPath, url), true);
  return readMapFile(generatedPath + '.map', false);
}

function parsedMap(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { return refuse(`source map is not valid JSON (${error.message})`); }
}

function mapLayoutRefusal(map) {
  if (map?.version !== 3) return 'source map is not version 3';
  if (Object.hasOwn(map, 'sections')) return 'indexed source maps (sections) are not supported; emit a flat Source Map v3';
  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return 'source map lacks string mappings or a sources array';
  return null;
}

function sourcesContentRefusal(map) {
  const contents = map.sourcesContent;
  if (!Array.isArray(contents) || contents.length !== map.sources.length || contents.some((text) => typeof text !== 'string')) return 'source map lacks sourcesContent text for every source; enable sourcesContent in the generator';
  return null;
}

// Contract 2, shape: only a flat v3 map carrying the exact text of every source can be verified.
export function sourceMapShapeRefusal(map) {
  return mapLayoutRefusal(map) ?? sourcesContentRefusal(map);
}

function resolvedSourcePath(map, entry, mapBase) {
  const joined = (map.sourceRoot ?? '') + entry;
  return joined.startsWith('file:') ? fileURLToPath(joined) : path.resolve(path.dirname(mapBase), joined);
}

const fileHash = (file) => (existingFile(file) ? sha256(fs.readFileSync(file)) : null);

function verifiedSource(context, entry, content) {
  const absolute = resolvedSourcePath(context.map, entry, context.mapBase);
  if (!insideProject(context.root, absolute)) refuse(`map source ${entry} resolves outside the project to ${absolute}`);
  const relative = projectRelative(context.root, absolute);
  const contentHash = sha256(Buffer.from(content, 'utf8'));
  if (contentHash !== fileHash(absolute)) refuse(`map sourcesContent differs from the on-disk bytes of ${relative}`);
  if ((context.hashes[relative] ?? contentHash) !== contentHash) refuse(`map sourcesContent differs from the scored-source hash of ${relative}`);
  return { path: relative, sha256: contentHash, lineCount: content.split('\n').length };
}

// Contract 3, source identity: every source is inside the project and is the exact scored bytes.
export function verifiedSources(context) {
  return context.map.sources.map((entry, index) => verifiedSource(context, entry, context.map.sourcesContent[index]));
}

function committedBlobIds(root) {
  const git = (argumentsList) => spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024 * 1024 });
  const listing = git(['ls-tree', '-r', '-z', 'HEAD']);
  if (listing.status !== 0) return { algorithm: null, blobs: new Map() };
  const blobs = new Map(listing.stdout.split('\0').filter(Boolean).map((line) => line.split('\t')).map(([meta, file]) => [file, meta.split(' ')[2]]));
  return { algorithm: git(['rev-parse', '--show-object-format']).stdout.trim() === 'sha256' ? 'sha256' : 'sha1', blobs };
}

function gitBlobId(algorithm, bytes) {
  return crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function witnessRefusal(witness, relative, hash, label) {
  const before = witness.hashes[relative];
  if (before === undefined) return witness.allowsCreated ? null : `${label} ${relative} has no capture-time SHA-256 in ${witness.source}; rerun with coverageCommand, or record it there at capture`;
  return before === hash ? null : `${label} ${relative} changed ${witness.changedWhen}`;
}

function trackedGeneratedRefusal(context, relative, bytes) {
  const committed = context.committed();
  const blob = committed.blobs.get(relative);
  if (!blob) return null;
  const withoutMapComment = Buffer.from(bytes.toString('latin1').replace(TRAILING_MAP_COMMENT_LINE, '$1'), 'latin1');
  const shipped = [bytes, withoutMapComment].some((candidate) => gitBlobId(committed.algorithm, candidate) === blob);
  return shipped ? null : `tracked generated file ${relative} differs from its committed blob beyond a trailing sourceMappingURL line; executed code must be the shipped code`;
}

// Contract 4, generated identity: the generated file and its map are the bytes the coverage ran on.
export function generatedIdentityRefusal(context, generated, located) {
  const generatedRelative = projectRelative(context.root, generated.path);
  const mapRefusal = located.kind === 'file' ? witnessRefusal(context.witness, projectRelative(context.root, located.path), sha256(located.bytes), 'source map') : null;
  return witnessRefusal(context.witness, generatedRelative, sha256(generated.bytes), 'generated file') ?? mapRefusal ?? trackedGeneratedRefusal(context, generatedRelative, generated.bytes);
}

function generatedColumnRefusal(segment, generatedLine, lineLength) {
  if (segment.generatedColumn < 0 || segment.generatedColumn > lineLength) return `mapping segment at generated line ${generatedLine} column ${segment.generatedColumn} is outside the generated file`;
  return null;
}

function originalLineRefusal(segment, generatedLine, sources) {
  const source = sources[segment.source];
  if (!source) return `mapping segment at generated line ${generatedLine} names source index ${segment.source}, which the map does not list`;
  if (segment.originalLine < 0 || segment.originalLine >= source.lineCount) return `mapping segment at generated line ${generatedLine} points at line ${segment.originalLine + 1} of ${source.path}, which has ${source.lineCount} lines`;
  return null;
}

// Contract 5, bounds: one segment outside either file refuses the whole map.
export function mappingBoundsRefusal(decoded, generatedText, sources) {
  const generatedLines = generatedText.split('\n');
  for (const [index, segments] of decoded.entries()) {
    const lineLength = generatedLines[index]?.length ?? -1;
    const refusal = segments.map((segment) => generatedColumnRefusal(segment, index + 1, lineLength) ?? originalLineRefusal(segment, index + 1, sources)).find(Boolean);
    if (refusal) return refusal;
  }
  return null;
}

function raiseHits(lines, line, hits) {
  lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}

function translateLineHits(perSource, record, decoded) {
  for (const [generatedLine, hits] of record.lines) {
    for (const segment of decoded[generatedLine - 1] ?? []) raiseHits(perSource[segment.source].lines, segment.originalLine + 1, hits);
  }
}

function translateFunctions(perSource, record, decoded) {
  for (const definition of record.functions) {
    const first = decoded[definition.line - 1]?.[0];
    if (first) perSource[first.source].functions.push({ ...definition, line: first.originalLine + 1 });
  }
}

// Contract 6, translation: an original line only gets hits a segment proves; unmapped lines stay absent,
// so the executable-line inventory leaves their bodies UNVERIFIED.
export function translatedRecords(record, decoded, sources) {
  const perSource = sources.map((source) => ({ path: source.path, lines: new Map(), functions: [] }));
  translateLineHits(perSource, record, decoded);
  translateFunctions(perSource, record, decoded);
  return perSource;
}

function lcovRecordText(translated) {
  const sorted = [...translated.lines].sort(([left], [right]) => left - right);
  return [
    `SF:${translated.path}`,
    ...translated.functions.map((definition) => `FN:${definition.line},${definition.name}`),
    ...translated.functions.map((definition) => `FNDA:${definition.hits},${definition.name}`),
    ...sorted.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${sorted.length}`, `LH:${sorted.filter(([, hits]) => hits > 0).length}`, 'end_of_record',
  ].join('\n');
}

function recordEntry(record, kind, value) {
  const [first, ...rest] = value.split(',');
  if (kind === 'DA') raiseHits(record.lines, Number(first), Number(rest[0]));
  if (kind === 'FN') record.functions.push({ line: Number(first), name: rest.join(',') });
  if (kind === 'FNDA') record.functionHits.set(rest.join(','), Number(first));
}

export function lcovRecords(text) {
  const records = [];
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const [kind, value = ''] = rawLine.split(/:(.*)/s);
    if (kind === 'SF') records.push(current = { file: value, lines: new Map(), functions: [], functionHits: new Map() });
    else if (kind === 'end_of_record') current = undefined;
    else if (current) recordEntry(current, kind, value);
  }
  records.forEach(attachFunctionHits);
  return records;
}

function attachFunctionHits(record) {
  record.functions = record.functions.map((definition) => ({ ...definition, hits: record.functionHits.get(definition.name) ?? 0 }));
}

function generatedFile(root, file) {
  const absolute = path.resolve(root, file);
  return existingFile(absolute) ? { path: absolute, bytes: fs.readFileSync(absolute) } : null;
}

function translationReceipt(root, generated, located, sources) {
  return {
    generated: { path: projectRelative(root, generated.path), sha256: sha256(generated.bytes) },
    map: { kind: located.kind, path: located.path && projectRelative(root, located.path), sha256: sha256(located.bytes) },
    sources: sources.map((source) => ({ path: source.path, sha256: source.sha256 })),
  };
}

function mappedTranslation(context, record, generated, located) {
  const map = parsedMap(located.bytes);
  refuseIf(sourceMapShapeRefusal(map));
  const sources = verifiedSources({ ...context, map, mapBase: located.path ?? generated.path });
  refuseIf(generatedIdentityRefusal(context, generated, located));
  const decoded = decodeMappings(map.mappings);
  refuseIf(mappingBoundsRefusal(decoded, generated.bytes.toString('utf8'), sources));
  return { receipt: translationReceipt(context.root, generated, located, sources), records: translatedRecords(record, decoded, sources) };
}

function recordTranslation(context, record) {
  const generated = generatedFile(context.root, record.file);
  if (!generated) return null;
  try {
    const located = locateSourceMap(generated.path, generated.bytes.toString('utf8'));
    return located && mappedTranslation(context, record, generated, located);
  } catch (error) {
    if (!(error instanceof SourceMapRefusal)) throw error;
    return { refusal: { generated: projectRelative(context.root, generated.path), reason: error.message } };
  }
}

function once(compute) {
  let value;
  return () => (value ??= compute());
}

// Contract 7, receipt. Original records stay as they are, so anything a map does not cover, or a
// refused translation, still answers to the same-byte source hash check.
export function translateCoverage(input, root, witness) {
  if (input.reason) return { ...input, sourceMapTranslations: [], sourceMapRefusals: [] };
  const context = { root, hashes: input.hashes, witness, committed: once(() => committedBlobIds(root)) };
  const outcomes = lcovRecords(input.text).map((record) => recordTranslation(context, record)).filter(Boolean);
  const translations = outcomes.filter((outcome) => !outcome.refusal);
  const translatedHashes = translations.flatMap((outcome) => outcome.receipt.sources.map((source) => [source.path, source.sha256]));
  const translatedText = translations.flatMap((outcome) => outcome.records.map(lcovRecordText)).join('\n');
  return {
    ...input,
    text: translatedText ? `${input.text.replace(/\n?$/, '\n')}${translatedText}\n` : input.text,
    hashes: { ...input.hashes, ...Object.fromEntries(translatedHashes) },
    sourceMapTranslations: translations.map((outcome) => outcome.receipt),
    sourceMapRefusals: outcomes.filter((outcome) => outcome.refusal).map((outcome) => outcome.refusal),
  };
}
