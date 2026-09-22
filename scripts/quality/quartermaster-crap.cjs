'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { crapScore, functionTokenCount, parseLizardCsv } = require('./crap-core.cjs');

const DEFAULT_MAX = 6;
const DEFAULT_LCOV = 'coverage/lcov.info';
/** A coverageCommand can write its lcov.info here instead of the shared `coverage/`, so concurrent runs on one checkout stay apart. */
const COVERAGE_DIR_ENV = 'QUARTERMASTER_COVERAGE_DIR';
const CONFIG_RELATIVE_PATH = path.join('.claude', 'quartermaster', 'crap.json');
const INSTALL_HINT = 'install lizard with `uv tool install lizard`, `pipx install lizard`, or `pip install lizard`';
const LIZARD_CANDIDATES = [
  { command: 'lizard', leading: [] },
  { command: 'uvx', leading: ['lizard'] },
  { command: 'pipx', leading: ['run', 'lizard'] },
];
const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.go', '.h', '.java', '.js', '.jsx', '.kt', '.php', '.py', '.rb', '.rs', '.ts', '.tsx']);
/**
 * lizard's TSX reader abandons an opening tag the moment an attribute is not `name="text"` or
 * `name={expr}` — a hyphenated or valueless attribute, a spread, even tag text holding `(`, `)`, `;`
 * or `=` — and re-emits the `{` of every brace attribute it had already matched. Those unbalanced
 * braces keep the enclosing component open, so it swallows the rest of the file: it reads a
 * complexity nothing in it branches on, and the functions it swallowed are never gated at all. Its
 * TypeScript reader never opens that tag tokenizer, so the same bytes under a `.ts`/`.js` name
 * measure the file honestly. The copy is byte for byte the real file, so line numbers — and with them
 * coverage ranges and baseline pairing — still come from the real file.
 */
const READER_SUBSTITUTE_EXTENSION = new Map([['.tsx', '.ts'], ['.jsx', '.js']]);
const LIZARD_SOURCE = 'lizard';
const LIZARD_TSX_SOURCE = 'lizard-tsx';
const LIZARD_SUBSTITUTE_SOURCE = 'lizard-typescript';

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

function comparablePath(projectDir, filePath) {
  const resolved = path.resolve(projectDir, String(filePath).trim()).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function displayPath(projectDir, filePath) {
  return path.relative(projectDir, path.resolve(projectDir, String(filePath).trim())).replaceAll('\\', '/');
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
    } else if (line === 'end_of_record') current = null;
    else if (current && line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',');
      const executable = Number(lineNumber);
      if (Number.isFinite(executable)) current.set(executable, Math.max(current.get(executable) ?? 0, Number(hits) || 0));
    }
  }
  return files;
}

function rounded(value, places) {
  return Number(value.toFixed(places));
}

function fingerprint(projectDir, filePath, start, end) {
  try {
    const lines = fs.readFileSync(path.resolve(projectDir, filePath), 'utf8').split(/\r?\n/);
    const text = lines.slice(start - 1, end).join('\n').replace(/\s+/g, ' ');
    return crypto.createHash('sha256').update(text).digest('hex');
  } catch {
    return null;
  }
}

/** A named function rather than an inline callback, so V8 coverage can attribute its ranges to it. */
function measuredFunction(entry, coverage, projectDir) {
  const file = displayPath(projectDir, entry.file);
  const lines = coverage.get(comparablePath(projectDir, entry.file));
  let executable = 0;
  let covered = 0;
  for (let line = entry.start; line <= entry.end; line += 1) {
    const hits = lines?.get(line);
    if (hits !== undefined) {
      executable += 1;
      if (hits > 0) covered += 1;
    }
  }
  const coverageRatio = executable ? covered / executable : 0;
  return {
    file,
    line: entry.start,
    function: entry.name,
    ordinal: entry.ordinal,
    cc: entry.complexity,
    coverage: rounded(coverageRatio, 4),
    crap: rounded(crapScore(entry.complexity, coverageRatio), 2),
    fingerprint: fingerprint(projectDir, file, entry.start, entry.end),
    unmeasured: executable === 0,
    source: entry.source,
  };
}

function measure(lizardFunctions, coverage, projectDir) {
  return lizardFunctions.map((entry) => measuredFunction(entry, coverage, projectDir));
}

/** lizard picks its reader by extension, case-insensitively; undefined for a file its default reader measures honestly. */
function readerSubstituteExtension(file) {
  return READER_SUBSTITUTE_EXTENSION.get(path.extname(file).toLowerCase());
}

/** Which measurement a row came from, so a phantom complexity can be traced from the report to its reader. */
function readerSource(file) {
  return readerSubstituteExtension(file) ? LIZARD_TSX_SOURCE : LIZARD_SOURCE;
}

function withReaderSource(dir, entries) {
  return entries.map((entry) => {
    const file = displayPath(dir, entry.file);
    return { ...entry, file, source: readerSource(file) };
  });
}

/** A file lizard read but this cannot is left out, so it keeps the TSX reader's rows and the label that says so. */
function copiesForReader(dir, scratchDir, files) {
  const realPathByCopy = new Map();
  for (const file of files) {
    let contents;
    try {
      contents = fs.readFileSync(path.resolve(dir, file));
    } catch {
      continue;
    }
    // A flat name keeps every copy inside the scratch tree, whatever `..` a configured source put in the path.
    const copyPath = `${realPathByCopy.size}${readerSubstituteExtension(file)}`;
    fs.writeFileSync(path.join(scratchDir, copyPath), contents);
    realPathByCopy.set(copyPath, file);
  }
  return realPathByCopy;
}

function rowsByRealPath(scratchDir, realPathByCopy, runLizard) {
  const byFile = new Map();
  // The scratch tree holds only files the first run already measured, so an exclusion has nothing left to
  // exclude, and a pattern written for `.ts` would wrongly drop the copy of a `.tsx`.
  for (const entry of parseLizardCsv(runLizard({ cwd: scratchDir, sources: ['.'], exclude: [] }))) {
    const file = realPathByCopy.get(displayPath(scratchDir, entry.file));
    pushBucket(byFile, file, { ...entry, file, source: LIZARD_SUBSTITUTE_SOURCE });
  }
  return byFile;
}

/** Measures every .tsx/.jsx file among `entries` again through lizard's TypeScript reader, keyed by the real path. */
function typeScriptReaderRows(dir, entries, runLizard) {
  const files = [...new Set(entries.map((entry) => entry.file))].filter(readerSubstituteExtension);
  if (!files.length) return new Map();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-jsx-'));
  try {
    return rowsByRealPath(scratchDir, copiesForReader(dir, scratchDir, files), runLizard);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * The working tree and every baseline file are measured through here, so both sides of a comparison
 * read a .tsx/.jsx file with the same reader: a baseline row read by the TSX reader would span a
 * phantom range and never pair with today's honest one. Per file, the TypeScript reader's rows replace
 * the TSX reader's; a file it found no function in keeps the TSX reader's rows, labelled as such.
 */
function lizardRows(runLizard, request) {
  const entries = withReaderSource(request.cwd, parseLizardCsv(runLizard(request)));
  const substitutes = typeScriptReaderRows(request.cwd, entries, runLizard);
  return [...entries.filter((entry) => !substitutes.has(entry.file)), ...[...substitutes.values()].flat()];
}

function git(projectDir, args, hint) {
  const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`git ${args[0]} failed to start: ${result.error.message}`, hint);
  if (result.status !== 0) throw new PrerequisiteError(`git ${args.join(' ')} failed: ${lastLines(result.stderr, 2)}`, hint);
  return result.stdout;
}

/** `dir` may not be a git checkout at all, which is a normal, silent case when resolving the measured root. */
function tryGit(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/** The native realpath expands Windows 8.3 short names too, so two spellings of one directory compare equal. */
function realDir(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function sameDir(left, right) {
  return Boolean(left && right) && comparablePath(left, '.') === comparablePath(right, '.');
}

function commonGitDir(dir) {
  const output = tryGit(dir, ['rev-parse', '--git-common-dir']);
  // git prints --git-common-dir relative to the directory it was asked from, but absolute from a linked
  // worktree; resolving against `dir` first lands both forms on the same canonical directory.
  return output ? realDir(path.resolve(dir, output)) : null;
}

function gitToplevel(dir) {
  const output = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return output ? realDir(output) : null;
}

/** A linked worktree shares its main checkout's common git dir, which an unrelated clone never does. */
function sameRepository(startDir, projectDir) {
  return sameDir(commonGitDir(startDir), commonGitDir(projectDir));
}

/**
 * `--project` only picks the config. The measured root is the git toplevel of the directory the gate
 * runs in, so a per-ticket linked worktree measures the code checked out there rather than whatever
 * the named project's main checkout has on disk. An unrelated `--project` is measured where it points.
 */
function resolveWorkDir({ projectDir, cwd, projectPathGiven }) {
  // cwd and a toplevel are never empty strings, so `||` is as correct as `??` and lizard scores it once.
  const startDir = path.resolve(cwd || projectDir);
  if (projectPathGiven && !sameRepository(startDir, projectDir)) return projectDir;
  return gitToplevel(startDir) || startDir;
}

function defaultBase(projectDir) {
  for (const candidate of ['develop', 'main', 'master']) {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: projectDir, windowsHide: true }).status === 0) return candidate;
  }
  return 'HEAD';
}

function functionIdentity(entry) {
  return `${entry.file}\u0000${entry.function}\u0000${entry.ordinal}`;
}

function fingerprintIdentity(entry) {
  return `${entry.file}\u0000${entry.fingerprint}`;
}

/** Every bucket is a queue, so pairing can hand one baseline row to one current function and no more. */
function pushBucket(index, key, entry) {
  const bucket = index.get(key);
  if (bucket) bucket.push(entry);
  else index.set(key, [entry]);
}

function indexBaselineEntry(index, entry) {
  pushBucket(index.byIdentity, functionIdentity(entry), entry);
  if (entry.fingerprint) pushBucket(index.byFingerprint, fingerprintIdentity(entry), entry);
}

function baselineFunctions({ projectDir, baseReference, files, exclude, runLizard }) {
  const hint = `check that ${JSON.stringify(baseReference)} is a git ref this repository knows`;
  const base = git(projectDir, ['merge-base', 'HEAD', baseReference], hint).trim();
  const changed = new Set(git(projectDir, ['diff', '--name-only', '--relative', base], hint).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const changedHere = [...files].filter((file) => changed.has(file));
  const index = { byIdentity: new Map(), byFingerprint: new Map() };
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-base-'));
  try {
    for (const file of changedHere) {
      const show = spawnSync('git', ['show', `${base}:${file}`], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (show.status !== 0) continue;
      const target = path.join(temporaryDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, show.stdout, 'utf8');
      for (const entry of measure(lizardRows(runLizard, { cwd: temporaryDir, sources: [file], exclude }), new Map(), temporaryDir)) {
        indexBaselineEntry(index, entry);
      }
    }
    return { base, changed, ...index };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
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

function runCoverageCommand(command, workDir, reportsDir) {
  const result = spawnSync(command, { cwd: workDir, shell: true, encoding: 'utf8', windowsHide: true, env: { ...process.env, [COVERAGE_DIR_ENV]: reportsDir } });
  if (result.error) throw new PrerequisiteError(`coverage command failed to start: ${result.error.message}`, 'check coverageCommand in the config');
  if (result.status !== 0) throw new PrerequisiteError(`coverage command exited ${result.status}: ${lastLines(result.stderr, 3)}`, 'fix the coverage command, then run the gate again');
}

function defaultLcovMtime(workDir) {
  return fs.statSync(path.join(workDir, DEFAULT_LCOV), { throwIfNoEntry: false })?.mtimeMs;
}

/**
 * A coverage command that exits 0 without rewriting the fallback lcov leaves an earlier run's coverage
 * there, and scoring against it would be a wrong answer. Comparing the file's own mtime before and after
 * the command, rather than against the clock, keeps a fast command from looking stale: the kernel stamps
 * files from a coarser clock than Date.now().
 */
function assertDefaultLcovRewritten(workDir, mtimeBefore) {
  if (mtimeBefore !== undefined && defaultLcovMtime(workDir) === mtimeBefore) {
    throw new PrerequisiteError(`${DEFAULT_LCOV} predates this run's coverage command`, 'the coverage command exited 0 but did not write fresh coverage; check coverageCommand in the config');
  }
}

/** This run's own report wins; the shared default lcov is only the fallback for a command that ignores COVERAGE_DIR_ENV. */
function coverageRunLcovPath(workDir, coverageRun) {
  const isolatedPath = path.join(coverageRun.reportsDir, 'lcov.info');
  if (fs.existsSync(isolatedPath)) return isolatedPath;
  assertDefaultLcovRewritten(workDir, coverageRun.defaultLcovMtime);
  return path.join(workDir, DEFAULT_LCOV);
}

/** An explicit --lcov or config lcov is read exactly where it points. */
function resolveLcovPath(workDir, explicitLcov, coverageRun) {
  if (explicitLcov) return path.resolve(workDir, explicitLcov);
  if (coverageRun) return coverageRunLcovPath(workDir, coverageRun);
  return path.join(workDir, DEFAULT_LCOV);
}

function readLcovText(lcovPath, coverageCommand) {
  try {
    return fs.readFileSync(lcovPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new PrerequisiteError(`could not read ${lcovPath}: ${error.message}`, 'check the lcov path');
    throw new PrerequisiteError(`no lcov coverage at ${lcovPath}`, coverageCommand ? 'the coverage command ran but wrote no lcov there' : 'run your coverage command first, or set coverageCommand in the config');
  }
}

function acquireLcovText(workDir, settings) {
  if (!settings.coverageCommand) return readLcovText(resolveLcovPath(workDir, settings.lcov, null), null);
  const coverageRun = { reportsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-coverage-')), defaultLcovMtime: defaultLcovMtime(workDir) };
  try {
    runCoverageCommand(settings.coverageCommand, workDir, coverageRun.reportsDir);
    return readLcovText(resolveLcovPath(workDir, settings.lcov, coverageRun), settings.coverageCommand);
  } finally {
    fs.rmSync(coverageRun.reportsDir, { recursive: true, force: true });
  }
}

function sourceFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function unmeasuredLizardFiles(projectDir, sources, entries, changed) {
  const measured = new Set(entries.map((entry) => comparablePath(projectDir, entry.file)));
  return sources.flatMap((source) => sourceFiles(path.resolve(projectDir, source)))
    .filter((file) => changed.has(displayPath(projectDir, file)))
    .filter((file) => functionTokenCount(fs.readFileSync(file, 'utf8')) && !measured.has(comparablePath(projectDir, file)))
    .map((file) => displayPath(projectDir, file));
}

/** A claimed baseline row is spent: the next current function asking for it has to look elsewhere. */
function claimFirstUnclaimed(bucket, claimed) {
  for (const candidate of bucket ?? []) {
    if (claimed.has(candidate)) continue;
    claimed.add(candidate);
    return candidate;
  }
  return null;
}

function matchByFingerprint(baseline, entry, claimed) {
  if (!entry.fingerprint) return null;
  return claimFirstUnclaimed(baseline.byFingerprint.get(fingerprintIdentity(entry)), claimed);
}

function matchByPosition(baseline, entry, claimed) {
  return claimFirstUnclaimed(baseline.byIdentity.get(functionIdentity(entry)), claimed);
}

function claimRound(match, pairing) {
  for (const entry of pairing.functions) {
    if (pairing.pairs.has(entry)) continue;
    const previous = match(pairing.baseline, entry, pairing.claimed);
    if (previous) pairing.pairs.set(entry, previous);
  }
}

/**
 * Position among namesakes cannot identify a function across an insertion: one added `run` shifts every
 * later `run` onto a sibling's baseline row, so untouched code reads as changed and answers to the
 * ceiling it was already over. Identical source text, whitespace aside, is the stronger claim, so it pairs
 * across every function before position is consulted at all. Pairing is one-to-one, which is what keeps a
 * copy-pasted function new: the baseline copy of the file has only one row to give, and its twin took it.
 */
function pairWithBaseline(functions, baseline) {
  const pairing = { functions, baseline, claimed: new Set(), pairs: new Map() };
  claimRound(matchByFingerprint, pairing);
  claimRound(matchByPosition, pairing);
  return pairing.pairs;
}

function sameFingerprint(entry, previous) {
  return Boolean(entry.fingerprint && entry.fingerprint === previous?.fingerprint);
}

function changedFunctions(functions, baseline) {
  if (!baseline) return functions;
  const pairs = pairWithBaseline(functions, baseline);
  return functions.filter((entry) => baseline.changed.has(entry.file) && !sameFingerprint(entry, pairs.get(entry)));
}

/** lizard scores every `??` as two branches, so the command-line-then-config fallbacks go through one lookup. */
function firstDefined(values) {
  return values.find((value) => value != null);
}

function gateSettings(options, config) {
  if (Number(firstDefined([options.max, config.max, DEFAULT_MAX])) !== DEFAULT_MAX) {
    throw new PrerequisiteError(`the CRAP threshold is fixed at ${DEFAULT_MAX}`, 'remove max from the command or config');
  }
  return {
    sources: config.sources?.length ? config.sources : ['.'],
    exclude: firstDefined([config.exclude, []]),
    coverageCommand: firstDefined([options.coverageCommand, config.coverageCommand]),
    lcov: firstDefined([options.lcov, config.lcov]),
    runLizard: firstDefined([options.runLizard, lizardRunner()]),
    baseReference: firstDefined([options.base, options.ratchet, config.base, config.ratchet]),
  };
}

/** A ready-made --complexity CSV was measured by whichever reader produced it, so its .tsx/.jsx rows say lizard-tsx. */
function complexityEntries(workDir, options, settings) {
  if (options.complexity) return withReaderSource(workDir, parseLizardCsv(fs.readFileSync(path.resolve(workDir, options.complexity), 'utf8')));
  return lizardRows(settings.runLizard, { cwd: workDir, sources: settings.sources, exclude: settings.exclude });
}

function baselineFor(workDir, settings, functions) {
  const baseReference = settings.baseReference ?? defaultBase(workDir);
  if (baseReference === 'HEAD') return null;
  return baselineFunctions({ projectDir: workDir, baseReference, files: new Set(functions.map((entry) => entry.file)), exclude: settings.exclude, runLizard: settings.runLizard });
}

function changedFiles(baseline, functions) {
  return baseline?.changed ?? new Set(functions.map((entry) => entry.file));
}

/** A named function, because lizard does not see an arrow whose body is a template literal, and the repository gate refuses what lizard cannot measure. */
function functionLabel(entry) {
  return `${entry.file}:${entry.line} ${entry.function}`;
}

function assertMeasured(workDir, settings, { lizardEntries, changed, candidates }) {
  const lizardFailures = unmeasuredLizardFiles(workDir, settings.sources, lizardEntries, changed);
  if (lizardFailures.length) throw new PrerequisiteError(`lizard reported zero functions for ${lizardFailures.join(', ')}`, 'measurement is unverified; fix the parser input before passing the gate');
  const unmeasured = candidates.filter((entry) => entry.unmeasured);
  if (unmeasured.length) throw new PrerequisiteError(`coverage is unverified for ${unmeasured.map(functionLabel).join(', ')}`, 'run coverage that includes every changed function before passing the gate');
}

function byCrapThenPlace(left, right) {
  return right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line;
}

function gateResult(workDir, functions, candidates, baseline) {
  const failures = candidates.filter((entry) => entry.crap >= DEFAULT_MAX).sort(byCrapThenPlace).map((entry) => ({ ...entry, reason: 'ceiling' }));
  return { root: workDir, functions: functions.sort(byCrapThenPlace), failures, max: DEFAULT_MAX, checked: candidates.length, unmeasured: 0, base: baseline?.base ?? null };
}

/**
 * `--project` (projectPathGiven) only picks the config. The coverage command, the lcov, the lizard scan
 * and the base comparison all use the measured root, and without `--project` so does the config, so an
 * agent working in a subdirectory gets the gate the project configured rather than silent defaults.
 */
function crapReport(options) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const projectPathGiven = Boolean(options.projectPathGiven);
  const workDir = resolveWorkDir({ projectDir, cwd: options.cwd, projectPathGiven });
  const settings = gateSettings(options, readConfig(projectPathGiven ? projectDir : workDir));
  const lcovText = acquireLcovText(workDir, settings);
  const lizardEntries = complexityEntries(workDir, options, settings);
  const functions = measure(lizardEntries, coverageByFile(lcovText, workDir), workDir);
  const baseline = baselineFor(workDir, settings, functions);
  const candidates = changedFunctions(functions, baseline);
  assertMeasured(workDir, settings, { lizardEntries, changed: changedFiles(baseline, functions), candidates });
  return gateResult(workDir, functions, candidates, baseline);
}

/** Only file types lizard has more than one reader for name the measurement, so ordinary lines stay unchanged. */
function readerNote(entry) {
  return entry.source === LIZARD_SOURCE ? '' : ` source=${entry.source}`;
}

function formatReport(report) {
  const lines = report.failures.map((entry) => `${entry.file}:${entry.line} ${entry.function} cc=${entry.cc} coverage=${Math.round(entry.coverage * 100)}% CRAP=${entry.crap}${readerNote(entry)}`);
  lines.push(`CRAP gate ${report.failures.length ? 'failed' : 'passed'}: ${report.failures.length} of ${report.checked} changed or new functions at or above ${report.max}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { COVERAGE_DIR_ENV, DEFAULT_MAX, INSTALL_HINT, PrerequisiteError, coverageByFile, crapReport, crapScore, formatReport, parseLizardCsv, realDir, sameDir };
