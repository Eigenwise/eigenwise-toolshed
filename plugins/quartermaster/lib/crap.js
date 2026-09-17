'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX = 6;
/** lizard prints this literal name for every arrow/closure it cannot attribute to a declaration. */
const ANONYMOUS_NAME = '(anonymous)';
const DEFAULT_LCOV = 'coverage/lcov.info';
/** A coverageCommand can read this to write its report somewhere unique to this run instead of the default `coverage/`. */
const COVERAGE_DIR_ENV = 'QUARTERMASTER_COVERAGE_DIR';
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
 * `rootDir`, when given, lets anonymous functions (lizard name `(anonymous)`) get a body hash: reading the
 * exact source lines lizard attributed to them means a function whose text is untouched still matches its
 * baseline counterpart even when unrelated edits elsewhere in the file shifted its ordinal.
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
      let hash = null;
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
        hash = bodyHash(readSourceLines(file), entry.start, entry.end);
      } else {
        namedSoFar.push(entry);
      }

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
    const ratio = executable ? covered / executable : 0;
    return {
      file: displayPath(projectDir, entry.file),
      line: entry.start,
      function: entry.name,
      ordinal: entry.ordinal,
      anchor: entry.anchor ?? null,
      anchorOrdinal: entry.anchorOrdinal ?? null,
      bodyHash: entry.bodyHash ?? null,
      cc: entry.complexity,
      coverage: rounded(ratio, 4),
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

/** Non-throwing git probe: `dir` may not be a git checkout at all, which is a normal, silent case here. */
function tryGit(dir, args) {
  const result = spawnSync('git', [...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function commonGitDir(dir) {
  const output = tryGit(dir, ['rev-parse', '--git-common-dir']);
  return output ? path.resolve(dir, output) : null;
}

function gitToplevel(dir) {
  const output = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return output ? path.resolve(output) : null;
}

/**
 * `--project` names which project's config and ratchet baseline apply; it is not necessarily the tree
 * to measure. When cwd sits inside a linked worktree of that same project, or no `--project` was given
 * at all, the coverage command, lcov read, and lizard scan all run against cwd's own git toplevel
 * instead - so a Sidequest-style per-ticket worktree measures the code actually checked out there
 * rather than whatever the named project's main checkout happens to have on disk.
 */
function resolveWorkDir({ projectDir, cwd, projectPathGiven }) {
  const startDir = path.resolve(cwd ?? projectDir);
  if (projectPathGiven) {
    const cwdCommon = commonGitDir(startDir);
    const projectCommon = commonGitDir(projectDir);
    if (!cwdCommon || !projectCommon || cwdCommon !== projectCommon) return projectDir;
  }
  return gitToplevel(startDir) ?? startDir;
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

function runCoverageCommand(command, workDir, coverageReportsDir) {
  const env = coverageReportsDir ? { ...process.env, [COVERAGE_DIR_ENV]: coverageReportsDir } : process.env;
  const result = spawnSync(command, { cwd: workDir, shell: true, encoding: 'utf8', windowsHide: true, env });
  if (result.error) throw new PrerequisiteError(`coverage command failed to start: ${result.error.message}`, 'check coverageCommand in the config');
  if (result.status !== 0) {
    throw new PrerequisiteError(`coverage command exited ${result.status}: ${lastLines(result.stderr, 3)}`, 'fix the coverage command, then run the gate again');
  }
}

/**
 * An explicit --lcov/config.lcov always wins, read exactly where it points. Otherwise prefer this
 * run's own coverage directory (set via COVERAGE_DIR_ENV) so concurrent runs sharing one workDir don't
 * collide; a coverageCommand that ignores the env var is "opaque" to us, so fall back to copying its
 * default output into our own directory immediately, before another run's coverage command can
 * overwrite it out from under this read.
 */
function resolveLcovPath({ workDir, coverageReportsDir, explicitLcov }) {
  if (explicitLcov) return path.resolve(workDir, explicitLcov);
  const defaultPath = path.join(workDir, DEFAULT_LCOV);
  if (!coverageReportsDir) return defaultPath;
  const isolatedPath = path.join(coverageReportsDir, 'lcov.info');
  if (fs.existsSync(isolatedPath)) return isolatedPath;
  try {
    fs.copyFileSync(defaultPath, isolatedPath);
    return isolatedPath;
  } catch {
    return defaultPath;
  }
}

function baselineFunctions({ projectDir, ratchet, files, exclude, runLizard }) {
  const hint = `check that ${JSON.stringify(ratchet)} is a git ref this repository knows`;
  const base = git(projectDir, ['merge-base', 'HEAD', ratchet], hint).trim();
  const changed = new Set(
    git(projectDir, ['diff', '--name-only', '--relative', base], hint)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const changedHere = [...files].filter((file) => changed.has(file));
  const empty = { byIdentity: new Map(), byBodyHash: new Map(), byAnchor: new Map(), functionsByFile: new Map() };
  if (!changedHere.length) return { base, changed, ...empty };

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-base-'));
  try {
    let extracted = 0;
    for (const file of changedHere) {
      const show = spawnSync('git', ['show', `${base}:${file}`], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (show.status !== 0) continue;
      const target = path.join(temporaryDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, show.stdout, 'utf8');
      extracted += 1;
    }
    const byIdentity = new Map();
    const byBodyHash = new Map();
    const byAnchor = new Map();
    const functionsByFile = new Map();
    if (extracted) {
      for (const entry of parseLizardCsv(runLizard({ cwd: temporaryDir, sources: ['.'], exclude }), temporaryDir)) {
        const file = displayPath(temporaryDir, entry.file);
        byIdentity.set(`${file}\u0000${entry.name}\u0000${entry.ordinal}`, entry);
        if (entry.bodyHash) byBodyHash.set(`${file}\u0000${entry.bodyHash}`, entry);
        if (entry.name === ANONYMOUS_NAME) byAnchor.set(`${file}\u0000${entry.anchor ?? ''}\u0000${entry.anchorOrdinal}`, entry);
        if (!functionsByFile.has(file)) functionsByFile.set(file, []);
        functionsByFile.get(file).push(entry);
      }
    }
    return { base, changed, byIdentity, byBodyHash, byAnchor, functionsByFile };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function crapReport(options) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const workDir = resolveWorkDir({ projectDir, cwd: options.cwd, projectPathGiven: Boolean(options.projectPathGiven) });
  const config = readConfig(projectDir);
  const max = Number(options.max ?? config.max ?? DEFAULT_MAX);
  if (!Number.isFinite(max) || max <= 0) throw new PrerequisiteError('--max must be a positive number', 'pass --max <n> or set max in the config');
  const ratchet = options.ratchet ?? config.ratchet ?? null;
  const sources = config.sources?.length ? config.sources : ['.'];
  const exclude = config.exclude ?? [];
  const coverageCommand = options.coverageCommand ?? config.coverageCommand ?? null;
  const runLizard = options.runLizard ?? lizardRunner();

  let coverageReportsDir = null;
  let lcovText;
  try {
    if (coverageCommand) {
      coverageReportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-coverage-'));
      runCoverageCommand(coverageCommand, workDir, coverageReportsDir);
    }
    const explicitLcov = options.lcov ?? config.lcov ?? null;
    const lcovPath = resolveLcovPath({ workDir, coverageReportsDir, explicitLcov });
    try {
      lcovText = fs.readFileSync(lcovPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new PrerequisiteError(`could not read ${lcovPath}: ${error.message}`, 'check the lcov path');
      throw new PrerequisiteError(
        `no lcov coverage at ${lcovPath}`,
        coverageCommand ? 'the coverage command ran but wrote no lcov there' : 'run your coverage command first, or set coverageCommand in the config',
      );
    }
  } finally {
    if (coverageReportsDir) fs.rmSync(coverageReportsDir, { recursive: true, force: true });
  }
  const coverage = coverageByFile(lcovText, workDir);

  const complexityCsv = options.complexity
    ? fs.readFileSync(path.resolve(workDir, options.complexity), 'utf8')
    : runLizard({ cwd: workDir, sources, exclude });
  const functions = measure(parseLizardCsv(complexityCsv, workDir), coverage, workDir);

  let baseline = null;
  if (ratchet) {
    baseline = baselineFunctions({
      projectDir: workDir,
      ratchet,
      files: new Set(functions.map((entry) => entry.file)),
      exclude,
      runLizard,
    });
  }

  const failures = [];
  let atOrAboveMax = 0;
  let preExistingAtOrAboveMax = 0;
  const ambiguousByFile = new Map();
  for (const entry of functions) {
    let previous = null;
    if (baseline) {
      if (entry.function === ANONYMOUS_NAME) {
        if (entry.bodyHash) previous = baseline.byBodyHash.get(`${entry.file}\u0000${entry.bodyHash}`) ?? null;
        if (!previous) previous = baseline.byAnchor.get(`${entry.file}\u0000${entry.anchor ?? ''}\u0000${entry.anchorOrdinal}`) ?? null;
      } else {
        previous = baseline.byIdentity.get(`${entry.file}\u0000${entry.function}\u0000${entry.ordinal}`) ?? null;
      }
    }
    if (previous) {
      if (entry.crap >= max) preExistingAtOrAboveMax += 1;
      const baselineCrap = rounded(crapScore(previous.complexity, entry.coverage), 2);
      if (entry.crap > baselineCrap) failures.push({ ...entry, reason: 'ratchet', baselineCc: previous.complexity, baselineCrap });
      continue;
    }
    if (baseline && !baseline.changed.has(entry.file)) {
      if (entry.crap >= max) preExistingAtOrAboveMax += 1;
      continue;
    }
    // An anonymous function with no baseline counterpart is ambiguous, not new: same-named siblings shift
    // position whenever the file gains or loses one of them, so a missing identity match proves nothing
    // about this specific function. Judge the file as a whole once every entry has been scanned.
    if (baseline && entry.function === ANONYMOUS_NAME) {
      if (!ambiguousByFile.has(entry.file)) ambiguousByFile.set(entry.file, []);
      ambiguousByFile.get(entry.file).push(entry);
      continue;
    }
    if (entry.crap >= max) {
      atOrAboveMax += 1;
      failures.push({ ...entry, reason: 'ceiling' });
    }
  }

  const ambiguousMatches = [];
  for (const [file, entries] of ambiguousByFile) {
    const baselineEntries = baseline.functionsByFile.get(file) ?? [];
    const fileFunctions = functions.filter((candidate) => candidate.file === file);
    // The baseline copy was measured without today's coverage, so its own functions only carry raw
    // complexity; comparing complexity ceilings on both sides is the closest apples-to-apples aggregate.
    const current = {
      overCeiling: fileFunctions.filter((candidate) => candidate.crap >= max).length,
      maxComplexity: fileFunctions.reduce((highest, candidate) => Math.max(highest, candidate.cc), 0),
    };
    const baselineAggregate = {
      overCeiling: baselineEntries.filter((candidate) => candidate.complexity >= max).length,
      maxComplexity: baselineEntries.reduce((highest, candidate) => Math.max(highest, candidate.complexity), 0),
    };
    const degraded = current.overCeiling > baselineAggregate.overCeiling || current.maxComplexity > baselineAggregate.maxComplexity;
    ambiguousMatches.push({ file, current, baseline: baselineAggregate, degraded });
    for (const entry of entries) {
      if (entry.crap < max) continue;
      if (degraded) {
        atOrAboveMax += 1;
        failures.push({ ...entry, reason: 'ambiguous' });
      } else {
        preExistingAtOrAboveMax += 1;
      }
    }
  }

  failures.sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line);
  return {
    root: workDir,
    functions: functions.sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line),
    failures,
    max,
    ratchet,
    unmeasured: functions.filter((entry) => entry.unmeasured).length,
    atOrAboveMax,
    preExistingAtOrAboveMax: ratchet ? preExistingAtOrAboveMax : null,
    ambiguousMatches,
  };
}

function formatReport(report) {
  const lines = report.failures.map(
    (entry) => `${entry.file}:${entry.line} ${entry.function} cc=${entry.cc} coverage=${Math.round(entry.coverage * 100)}% CRAP=${entry.crap}`,
  );
  for (const ambiguous of report.ambiguousMatches ?? []) {
    const verb = ambiguous.degraded ? 'aggregate got worse' : 'aggregate holds';
    lines.push(`${ambiguous.file}: ambiguous match (unnamed functions moved; ${verb})`);
  }
  const verdict = report.failures.length ? 'failed' : 'passed';
  let summary = `CRAP gate ${verdict}: ${report.atOrAboveMax} of ${report.functions.length} functions at or above ${report.max}`;
  if (report.ratchet) {
    summary += `; ${report.preExistingAtOrAboveMax} pre-existing functions at or above ${report.max} (ratchet against ${report.ratchet})`;
  }
  lines.push(summary);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  COVERAGE_DIR_ENV,
  DEFAULT_MAX,
  INSTALL_HINT,
  PrerequisiteError,
  coverageByFile,
  crapReport,
  crapScore,
  formatReport,
  parseLizardCsv,
  resolveWorkDir,
};
