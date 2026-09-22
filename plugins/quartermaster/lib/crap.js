'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX = 6;
/** lizard prints this literal name for every arrow/closure it cannot attribute to a declaration. */
const ANONYMOUS_NAME = '(anonymous)';
/** A byte no file path, function name or hash can contain, so composed lookup keys stay unambiguous. */
const KEY_SEPARATOR = '\u0000';
const DEFAULT_LCOV = 'coverage/lcov.info';
const CONFIG_RELATIVE_PATH = path.join('.claude', 'quartermaster', 'crap.json');
const INSTALL_HINT = 'install lizard with `uv tool install lizard`, `pipx install lizard`, or `pip install lizard`';
const LIZARD_CANDIDATES = [
  { command: 'lizard', leading: [] },
  { command: 'uvx', leading: ['lizard'] },
  { command: 'pipx', leading: ['run', 'lizard'] },
];

/** Exit code 2: the measurement could not run, which is never the same answer as a passing gate. */
class PrerequisiteError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'PrerequisiteError';
    this.hint = hint ?? null;
  }
}

function lastLines(text, count) {
  return String(text ?? '').split(/\r?\n/).filter((line) => line.trim()).slice(-count).join(' / ');
}

/** lcov SF paths and lizard file columns arrive absolute or relative, either slash, either case on Windows. */
function comparablePath(projectDir, filePath) {
  const resolved = path.resolve(projectDir, String(filePath).trim()).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function displayPath(projectDir, filePath) {
  const relative = path.relative(projectDir, path.resolve(projectDir, String(filePath).trim()));
  return relative.replaceAll('\\', '/');
}

function readConfig(projectDir) {
  const configPath = path.join(projectDir, CONFIG_RELATIVE_PATH);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new PrerequisiteError(`could not read ${configPath}: ${error.message}`, 'fix the config file, then run the gate again');
  }
}

function coverageByFile(lcovText, projectDir) {
  const files = new Map();
  let current = null;
  for (const rawLine of lcovText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      const key = comparablePath(projectDir, line.slice(3));
      current = files.get(key) ?? new Map();
      files.set(key, current);
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current || !line.startsWith('DA:')) continue;
    const [lineNumber, hits] = line.slice(3).split(',');
    const executable = Number(lineNumber);
    if (!Number.isFinite(executable)) continue;
    current.set(executable, Math.max(current.get(executable) ?? 0, Number(hits) || 0));
  }
  return files;
}

function splitCsvRow(row) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (row[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') { fields.push(field); field = ''; }
    else field += character;
  }
  fields.push(field);
  return fields;
}

/** First 16 hex chars of a sha1 over the exact source lines lizard attributed to the function. */
function bodyHash(sourceLines, start, end) {
  if (!sourceLines) return null;
  const body = sourceLines.slice(start - 1, end).join('\n');
  if (!body.trim()) return null;
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
}

/**
 * lizard --csv columns: NLOC, CCN, token, PARAM, length, location, file, function name, long_name, start, end.
 *
 * `rootDir`, when given, lets every function get a body hash: reading the exact source lines lizard
 * attributed to it means a function whose text is untouched still matches its baseline counterpart even
 * when unrelated edits elsewhere in the file shifted its ordinal. Names collide too (two classes with a
 * `run` method, two components with a `render`), so this is not only an anonymous-function problem.
 */
function parseLizardCsv(csvText, rootDir) {
  const rows = [];
  for (const row of csvText.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const fields = splitCsvRow(row);
    if (fields.length < 11) continue;
    const complexity = Number(fields[1]);
    const start = Number(fields[9]);
    const end = Number(fields[10]);
    if (![complexity, start, end].every(Number.isFinite)) continue;
    rows.push({ file: fields[6], name: fields[7], complexity, start, end });
  }

  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }

  const sourceLinesCache = new Map();
  const readSourceLines = (file) => {
    if (!rootDir) return null;
    const absolutePath = path.resolve(rootDir, file);
    if (!sourceLinesCache.has(absolutePath)) {
      try {
        sourceLinesCache.set(absolutePath, fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/));
      } catch {
        sourceLinesCache.set(absolutePath, null);
      }
    }
    return sourceLinesCache.get(absolutePath);
  };

  const functions = [];
  for (const [file, entries] of byFile) {
    // lizard usually already emits a file's functions in source order; sort defensively so the anchor
    // (nearest enclosing or preceding named function) and ordinals below are well defined either way.
    entries.sort((left, right) => left.start - right.start || left.end - right.end);
    const nameOrdinals = new Map();
    const anchorOrdinals = new Map();
    const namedSoFar = [];
    for (const entry of entries) {
      const isAnonymous = entry.name === ANONYMOUS_NAME;
      const ordinal = nameOrdinals.get(entry.name) ?? 0;
      nameOrdinals.set(entry.name, ordinal + 1);

      let anchor = null;
      let anchorOrdinal = null;
      if (isAnonymous) {
        let enclosing = null;
        let preceding = null;
        for (const named of namedSoFar) {
          if (named.start > entry.start) continue;
          if (named.end >= entry.end && (!enclosing || named.start > enclosing.start)) enclosing = named;
          if (!preceding || named.start > preceding.start) preceding = named;
        }
        const anchorEntry = enclosing ?? preceding;
        anchor = anchorEntry ? anchorEntry.name : null;
        const anchorKey = anchor ?? '\u0000no-anchor';
        anchorOrdinal = anchorOrdinals.get(anchorKey) ?? 0;
        anchorOrdinals.set(anchorKey, anchorOrdinal + 1);
      } else {
        namedSoFar.push(entry);
      }
      const hash = bodyHash(readSourceLines(file), entry.start, entry.end);

      functions.push({
        file: entry.file,
        name: entry.name,
        ordinal,
        complexity: entry.complexity,
        start: entry.start,
        end: entry.end,
        anchor,
        anchorOrdinal,
        bodyHash: hash,
      });
    }
  }
  return functions;
}

function crapScore(complexity, coverage) {
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

function rounded(value, places) {
  return Number(value.toFixed(places));
}

function measure(lizardFunctions, coverage, projectDir) {
  return lizardFunctions.map((entry) => {
    const lines = coverage.get(comparablePath(projectDir, entry.file));
    let executable = 0;
    let covered = 0;
    for (let line = entry.start; line <= entry.end; line += 1) {
      const hits = lines?.get(line);
      if (hits === undefined) continue;
      executable += 1;
      if (hits > 0) covered += 1;
    }
    // The ratchet recomputes the baseline's CRAP from this reported coverage, so CRAP has to come from
    // the same rounded number. Scoring the raw ratio instead moves CRAP by 0.01 against the baseline's
    // and fails a function whose complexity never changed.
    const ratio = executable ? rounded(covered / executable, 4) : 0;
    return {
      file: displayPath(projectDir, entry.file),
      line: entry.start,
      function: entry.name,
      ordinal: entry.ordinal,
      anchor: entry.anchor ?? null,
      anchorOrdinal: entry.anchorOrdinal ?? null,
      bodyHash: entry.bodyHash ?? null,
      cc: entry.complexity,
      coverage: ratio,
      crap: rounded(crapScore(entry.complexity, ratio), 2),
      unmeasured: executable === 0,
    };
  });
}

function git(projectDir, args, hint) {
  const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`git ${args[0]} failed to start: ${result.error.message}`, hint);
  if (result.status !== 0) throw new PrerequisiteError(`git ${args.join(' ')} failed: ${lastLines(result.stderr, 2)}`, hint);
  return result.stdout;
}

function lizardRunner() {
  let resolved = null;
  return ({ cwd, sources, exclude }) => {
    const tail = ['--csv', ...exclude.flatMap((pattern) => ['-x', pattern]), ...sources];
    for (const candidate of resolved ? [resolved] : LIZARD_CANDIDATES) {
      const label = [candidate.command, ...candidate.leading].join(' ');
      const result = spawnSync(candidate.command, [...candidate.leading, ...tail], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (result.error?.code === 'ENOENT') continue;
      if (result.error) throw new PrerequisiteError(`${label} failed to start: ${result.error.message}`, INSTALL_HINT);
      if (result.status !== 0) throw new PrerequisiteError(`${label} exited ${result.status}: ${lastLines(result.stderr, 3)}`, INSTALL_HINT);
      resolved = candidate;
      return result.stdout;
    }
    throw new PrerequisiteError('lizard is not resolvable (tried lizard, uvx lizard, pipx run lizard)', INSTALL_HINT);
  };
}

function runCoverageCommand(command, projectDir) {
  const result = spawnSync(command, { cwd: projectDir, shell: true, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`coverage command failed to start: ${result.error.message}`, 'check coverageCommand in the config');
  if (result.status !== 0) {
    throw new PrerequisiteError(`coverage command exited ${result.status}: ${lastLines(result.stderr, 3)}`, 'fix the coverage command, then run the gate again');
  }
}

function textKey(file, hash) {
  return [file, hash].join(KEY_SEPARATOR);
}

function identityKey(file, name, ordinal) {
  return [file, name, ordinal].join(KEY_SEPARATOR);
}

function anchorKey(file, anchor, ordinal) {
  return [file, anchor || '', ordinal].join(KEY_SEPARATOR);
}

/** Every bucket is a queue: pairing claims a baseline row and never hands the same row out twice. */
function pushBucket(index, key, entry) {
  const bucket = index.get(key);
  if (bucket) bucket.push(entry);
  else index.set(key, [entry]);
}

function emptyBaselineIndex() {
  return {
    byIdentity: new Map(),
    byBodyHash: new Map(),
    byAnchor: new Map(),
    functionsByFile: new Map(),
    namesByFile: new Map(),
  };
}

function rememberName(index, file, name) {
  const names = index.namesByFile.get(file);
  if (names) names.add(name);
  else index.namesByFile.set(file, new Set([name]));
}

function indexBaselineEntry(index, file, entry) {
  pushBucket(index.byIdentity, identityKey(file, entry.name, entry.ordinal), entry);
  if (entry.bodyHash) pushBucket(index.byBodyHash, textKey(file, entry.bodyHash), entry);
  if (entry.name === ANONYMOUS_NAME) pushBucket(index.byAnchor, anchorKey(file, entry.anchor, entry.anchorOrdinal), entry);
  pushBucket(index.functionsByFile, file, entry);
  rememberName(index, file, entry.name);
}

function changedFiles(projectDir, base, hint) {
  return git(projectDir, ['diff', '--name-only', '--relative', base], hint)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractBaselineFiles(projectDir, base, files, targetDir) {
  let extracted = 0;
  for (const file of files) {
    const show = spawnSync('git', ['show', `${base}:${file}`], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (show.status !== 0) continue;
    const target = path.join(targetDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, show.stdout, 'utf8');
    extracted += 1;
  }
  return extracted;
}

function indexBaselineCheckout(temporaryDir, exclude, runLizard) {
  const index = emptyBaselineIndex();
  for (const entry of parseLizardCsv(runLizard({ cwd: temporaryDir, sources: ['.'], exclude }), temporaryDir)) {
    indexBaselineEntry(index, displayPath(temporaryDir, entry.file), entry);
  }
  return index;
}

function baselineFunctions(options) {
  const { projectDir, ratchet, files, exclude, runLizard } = options;
  const hint = `check that ${JSON.stringify(ratchet)} is a git ref this repository knows`;
  const base = git(projectDir, ['merge-base', 'HEAD', ratchet], hint).trim();
  const changed = new Set(changedFiles(projectDir, base, hint));
  const changedHere = [...files].filter((file) => changed.has(file));
  if (!changedHere.length) return { base, changed, ...emptyBaselineIndex() };

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-base-'));
  try {
    const extracted = extractBaselineFiles(projectDir, base, changedHere, temporaryDir);
    const index = extracted ? indexBaselineCheckout(temporaryDir, exclude, runLizard) : emptyBaselineIndex();
    return { base, changed, ...index };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/** A claimed baseline row is spent: the next current function asking for it has to look elsewhere. */
function claimFirstUnclaimed(bucket, claimed) {
  for (const candidate of bucket || []) {
    if (claimed.has(candidate)) continue;
    claimed.add(candidate);
    return candidate;
  }
  return null;
}

function matchByText(baseline, entry, claimed) {
  if (!entry.bodyHash) return null;
  return claimFirstUnclaimed(baseline.byBodyHash.get(textKey(entry.file, entry.bodyHash)), claimed);
}

function matchByName(baseline, entry, claimed) {
  if (entry.function === ANONYMOUS_NAME) return null;
  return claimFirstUnclaimed(baseline.byIdentity.get(identityKey(entry.file, entry.function, entry.ordinal)), claimed);
}

function matchByAnchor(baseline, entry, claimed) {
  if (entry.function !== ANONYMOUS_NAME) return null;
  return claimFirstUnclaimed(baseline.byAnchor.get(anchorKey(entry.file, entry.anchor, entry.anchorOrdinal)), claimed);
}

function claimRound(match, pairing) {
  const { functions, baseline, claimed, matches } = pairing;
  for (const entry of functions) {
    if (matches.has(entry)) continue;
    const previous = match(baseline, entry, claimed);
    if (previous) matches.set(entry, previous);
  }
}

/**
 * Pairing has to survive an insertion anywhere in the file: one added function shifts every later
 * position, and names repeat (two classes with a `run`, two components with a `render`), so neither
 * position nor name on its own identifies a function. Byte-identical source text is the strongest
 * identity, so it claims across every function before a weaker lookup runs: an inserted namesake must
 * not take the row its untouched twin can prove it owns. Pairing is one-to-one, so a current function
 * left without a row is one the baseline copy of the file cannot account for.
 */
function pairWithBaseline(functions, baseline) {
  const pairing = { functions, baseline, claimed: new Set(), matches: new Map() };
  claimRound(matchByText, pairing);
  claimRound(matchByName, pairing);
  claimRound(matchByAnchor, pairing);
  return pairing.matches;
}

function newTally() {
  return { failures: [], atOrAboveMax: 0, preExistingAtOrAboveMax: 0, movedNamesakes: new Set() };
}

function countPreExisting(tally, entry, max) {
  if (entry.crap >= max) tally.preExistingAtOrAboveMax += 1;
}

/** A paired function answers only to its own baseline row, both sides scored from this run's coverage. */
function judgeMatched(tally, entry, previous, max) {
  countPreExisting(tally, entry, max);
  const baselineCrap = rounded(crapScore(previous.complexity, entry.coverage), 2);
  if (entry.crap <= baselineCrap) return;
  tally.failures.push({ ...entry, reason: 'ratchet', baselineCc: previous.complexity, baselineCrap });
}

function baselineKnewName(baseline, entry) {
  const names = baseline ? baseline.namesByFile.get(entry.file) : null;
  return Boolean(names && names.has(entry.function));
}

/**
 * Pairing already gave every baseline row to at most one current function, so a function left without
 * one is code the baseline copy of this file cannot account for: it answers to the ceiling on its own,
 * copy-pasted or freshly written. A name the baseline already carried only marks the file for the
 * aggregate line in the report; it no longer excuses the function.
 */
function judgeUnmatched(tally, entry, baseline, max) {
  if (entry.crap < max) return;
  tally.atOrAboveMax += 1;
  tally.failures.push({ ...entry, reason: 'ceiling' });
  if (baselineKnewName(baseline, entry)) tally.movedNamesakes.add(entry.file);
}

function judgeEntry(tally, entry, previous, baseline, max) {
  if (previous) return judgeMatched(tally, entry, previous, max);
  if (baseline && !baseline.changed.has(entry.file)) return countPreExisting(tally, entry, max);
  return judgeUnmatched(tally, entry, baseline, max);
}

function complexityAggregate(complexities, max) {
  return {
    overCeiling: complexities.filter((value) => value >= max).length,
    maxComplexity: complexities.reduce((highest, value) => Math.max(highest, value), 0),
  };
}

/**
 * Report only, and scored by complexity on both sides because the baseline copy was measured without
 * today's coverage. It says how the file as a whole moved when same-named functions lost their place;
 * a tie proves nothing either way, which is why it no longer clears anything.
 */
function namesakeAggregates(files, functions, baseline, max) {
  const aggregates = [];
  for (const file of files) {
    const current = complexityAggregate(functions.filter((entry) => entry.file === file).map((entry) => entry.cc), max);
    const previous = complexityAggregate((baseline.functionsByFile.get(file) || []).map((entry) => entry.complexity), max);
    const degraded = current.overCeiling > previous.overCeiling || current.maxComplexity > previous.maxComplexity;
    aggregates.push({ file, current, baseline: previous, degraded });
  }
  return aggregates;
}

function gateFunctions(functions, baseline, max) {
  const matches = baseline ? pairWithBaseline(functions, baseline) : new Map();
  const tally = newTally();
  for (const entry of functions) judgeEntry(tally, entry, matches.get(entry), baseline, max);
  return {
    failures: tally.failures,
    atOrAboveMax: tally.atOrAboveMax,
    preExistingAtOrAboveMax: tally.preExistingAtOrAboveMax,
    ambiguousMatches: namesakeAggregates(tally.movedNamesakes, functions, baseline, max),
  };
}

function firstDefined(values) {
  const found = values.find((value) => value !== undefined && value !== null);
  return found === undefined ? null : found;
}

function resolvedMax(options, config) {
  const max = Number(firstDefined([options.max, config.max, DEFAULT_MAX]));
  if (!Number.isFinite(max) || max <= 0) throw new PrerequisiteError('--max must be a positive number', 'pass --max <n> or set max in the config');
  return max;
}

function resolveSettings(options, config) {
  return {
    max: resolvedMax(options, config),
    ratchet: firstDefined([options.ratchet, config.ratchet]),
    sources: config.sources?.length ? config.sources : ['.'],
    exclude: firstDefined([config.exclude, []]),
    coverageCommand: firstDefined([options.coverageCommand, config.coverageCommand]),
    lcov: firstDefined([options.lcov, config.lcov, DEFAULT_LCOV]),
    runLizard: options.runLizard || lizardRunner(),
  };
}

function missingLcovHint(coverageCommand) {
  if (coverageCommand) return 'the coverage command ran but wrote no lcov there';
  return 'run your coverage command first, or set coverageCommand in the config';
}

function readLcov(projectDir, settings) {
  const lcovPath = path.resolve(projectDir, settings.lcov);
  try {
    return fs.readFileSync(lcovPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new PrerequisiteError(`could not read ${lcovPath}: ${error.message}`, 'check the lcov path');
    throw new PrerequisiteError(`no lcov coverage at ${lcovPath}`, missingLcovHint(settings.coverageCommand));
  }
}

function complexityCsv(projectDir, options, settings) {
  if (!options.complexity) return settings.runLizard({ cwd: projectDir, sources: settings.sources, exclude: settings.exclude });
  return fs.readFileSync(path.resolve(projectDir, options.complexity), 'utf8');
}

function byCrapThenPlace(left, right) {
  return right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line;
}

function crapReport(options) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const settings = resolveSettings(options, readConfig(projectDir));
  if (settings.coverageCommand) runCoverageCommand(settings.coverageCommand, projectDir);
  const coverage = coverageByFile(readLcov(projectDir, settings), projectDir);
  const functions = measure(parseLizardCsv(complexityCsv(projectDir, options, settings), projectDir), coverage, projectDir);
  const baseline = settings.ratchet
    ? baselineFunctions({
      projectDir,
      ratchet: settings.ratchet,
      files: new Set(functions.map((entry) => entry.file)),
      exclude: settings.exclude,
      runLizard: settings.runLizard,
    })
    : null;
  const gated = gateFunctions(functions, baseline, settings.max);
  return {
    functions: functions.sort(byCrapThenPlace),
    failures: gated.failures.sort(byCrapThenPlace),
    max: settings.max,
    ratchet: settings.ratchet,
    unmeasured: functions.filter((entry) => entry.unmeasured).length,
    atOrAboveMax: gated.atOrAboveMax,
    preExistingAtOrAboveMax: settings.ratchet ? gated.preExistingAtOrAboveMax : null,
    ambiguousMatches: gated.ambiguousMatches,
  };
}

function failureLine(entry) {
  return `${entry.file}:${entry.line} ${entry.function} cc=${entry.cc} coverage=${Math.round(entry.coverage * 100)}% CRAP=${entry.crap}`;
}

function ambiguousLine(ambiguous) {
  const verb = ambiguous.degraded ? 'the file aggregate got worse' : 'the file aggregate held';
  return `${ambiguous.file}: ambiguous match (same-named functions moved; ${verb}); each unmatched function answered to the ceiling`;
}

function formatReport(report) {
  const lines = report.failures.map(failureLine);
  for (const ambiguous of report.ambiguousMatches || []) lines.push(ambiguousLine(ambiguous));
  const verdict = report.failures.length ? 'failed' : 'passed';
  let summary = `CRAP gate ${verdict}: ${report.atOrAboveMax} of ${report.functions.length} functions at or above ${report.max}`;
  if (report.ratchet) {
    summary += `; ${report.preExistingAtOrAboveMax} pre-existing functions at or above ${report.max} (ratchet against ${report.ratchet})`;
  }
  lines.push(summary);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  DEFAULT_MAX,
  INSTALL_HINT,
  PrerequisiteError,
  coverageByFile,
  crapReport,
  crapScore,
  formatReport,
  parseLizardCsv,
};
