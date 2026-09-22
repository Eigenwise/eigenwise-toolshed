'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX = 6;
const DEFAULT_LCOV = 'coverage/lcov.info';
/**
 * lizard's TSX reader abandons an opening tag the moment an attribute is not `name="text"` or
 * `name={expr}` — a hyphenated or valueless attribute, a spread, even tag text holding `(`, `)`, `;`
 * or `=` — and re-emits the `{` of every brace attribute it had already matched. Those unbalanced
 * braces keep the enclosing component open, so it swallows the rest of the file: it reads a
 * complexity nothing in it branches on, and the functions it swallowed are never gated at all. Its
 * TypeScript reader never opens that tag tokenizer, so the same bytes under a `.ts`/`.js` name
 * measure the file honestly. The copy is byte for byte the real file, so line numbers — and with them
 * coverage ranges and baseline identity — still come from the real file.
 */
const READER_SUBSTITUTE_EXTENSION = new Map([['.tsx', '.ts'], ['.jsx', '.js']]);
const LIZARD_SOURCE = 'lizard';
const LIZARD_TSX_SOURCE = 'lizard-tsx';
const LIZARD_SUBSTITUTE_SOURCE = 'lizard-typescript';
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

/** The name a copy needs for lizard to read it with the TypeScript reader instead of the TSX one. */
function readerSubstitutePath(relativePath) {
  const extension = path.extname(relativePath);
  const substitute = READER_SUBSTITUTE_EXTENSION.get(extension.toLowerCase());
  return substitute ? `${relativePath.slice(0, -extension.length)}${substitute}` : null;
}

/** Which measurement a report line came from, so a phantom complexity is diagnosable from the output. */
function readerSource(relativePath) {
  return readerSubstitutePath(relativePath) ? LIZARD_TSX_SOURCE : LIZARD_SOURCE;
}

/** Copies one file into a scratch tree under the name that picks its reader, and returns that name. */
function writeForReader(targetDir, relativePath, contents) {
  const copyPath = readerSubstitutePath(relativePath) ?? relativePath;
  const target = path.join(targetDir, copyPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return copyPath;
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

/** lizard --csv columns: NLOC, CCN, token, PARAM, length, location, file, function name, long_name, start, end. */
function parseLizardCsv(csvText) {
  const functions = [];
  const ordinals = new Map();
  for (const row of csvText.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const fields = splitCsvRow(row);
    if (fields.length < 11) continue;
    const complexity = Number(fields[1]);
    const start = Number(fields[9]);
    const end = Number(fields[10]);
    if (![complexity, start, end].every(Number.isFinite)) continue;
    const file = fields[6];
    const name = fields[7];
    const ordinalKey = `${file}\u0000${name}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    functions.push({ file, name, ordinal, complexity, start, end });
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
    const file = displayPath(projectDir, entry.file);
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
      file,
      line: entry.start,
      function: entry.name,
      ordinal: entry.ordinal,
      cc: entry.complexity,
      coverage: rounded(ratio, 4),
      crap: rounded(crapScore(entry.complexity, ratio), 2),
      unmeasured: executable === 0,
      source: entry.source ?? readerSource(file),
    };
  });
}

/**
 * Measures the .tsx/.jsx files lizard already read, again, through its TypeScript reader. Returns the
 * replacement rows keyed by the real project-relative path, or null when the project has none.
 */
function substituteReaderFunctions({ projectDir, files, runLizard }) {
  const jsxFiles = [...files].filter((file) => readerSubstitutePath(file));
  if (!jsxFiles.length) return null;

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-jsx-'));
  try {
    const realPathByCopy = new Map();
    for (const file of jsxFiles) {
      let contents;
      try {
        contents = fs.readFileSync(path.resolve(projectDir, file));
      } catch {
        continue; // lizard read it and we cannot: leave that file's TSX-reader rows in place.
      }
      realPathByCopy.set(writeForReader(temporaryDir, file, contents), file);
    }
    if (!realPathByCopy.size) return null;

    const byFile = new Map();
    // The copies are exactly the files the project run already measured, so this run excludes nothing.
    for (const entry of parseLizardCsv(runLizard({ cwd: temporaryDir, sources: ['.'], exclude: [] }))) {
      const file = realPathByCopy.get(displayPath(temporaryDir, entry.file));
      if (!file) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ ...entry, file, source: LIZARD_SUBSTITUTE_SOURCE });
    }
    return byFile;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/** Swaps in the TypeScript reader's rows per file, keeping the TSX reader's rows for any file it measured empty. */
function applySubstituteReader(entries, projectDir, byFile) {
  const swapped = new Set();
  const merged = [];
  for (const entry of entries) {
    const file = displayPath(projectDir, entry.file);
    const substitute = byFile?.get(file);
    if (!substitute?.length) {
      merged.push({ ...entry, file, source: readerSource(file) });
      continue;
    }
    if (swapped.has(file)) continue;
    swapped.add(file);
    merged.push(...substitute);
  }
  return merged;
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

function baselineFunctions({ projectDir, ratchet, files, runLizard }) {
  const hint = `check that ${JSON.stringify(ratchet)} is a git ref this repository knows`;
  const base = git(projectDir, ['merge-base', 'HEAD', ratchet], hint).trim();
  const changed = new Set(
    git(projectDir, ['diff', '--name-only', '--relative', base], hint)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const changedHere = [...files].filter((file) => changed.has(file));
  if (!changedHere.length) return { base, changed, byIdentity: new Map() };

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-base-'));
  try {
    // The baseline copies pick their reader the same way the working tree's do, or a .tsx file would
    // be compared against a phantom complexity on one side of the ratchet and its real one on the other.
    const realPathByCopy = new Map();
    for (const file of changedHere) {
      const show = spawnSync('git', ['show', `${base}:${file}`], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (show.status !== 0) continue;
      realPathByCopy.set(writeForReader(temporaryDir, file, show.stdout), file);
    }
    const byIdentity = new Map();
    if (realPathByCopy.size) {
      // The scratch tree holds only files the project run already measured, so it excludes nothing of
      // its own: an exclusion written for `.tsx` would no longer match the `.ts` copy anyway.
      for (const entry of parseLizardCsv(runLizard({ cwd: temporaryDir, sources: ['.'], exclude: [] }))) {
        const copyPath = displayPath(temporaryDir, entry.file);
        const file = realPathByCopy.get(copyPath) ?? copyPath;
        byIdentity.set(`${file}\u0000${entry.name}\u0000${entry.ordinal}`, entry);
      }
    }
    return { base, changed, byIdentity };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function crapReport(options) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const config = readConfig(projectDir);
  const max = Number(options.max ?? config.max ?? DEFAULT_MAX);
  if (!Number.isFinite(max) || max <= 0) throw new PrerequisiteError('--max must be a positive number', 'pass --max <n> or set max in the config');
  const ratchet = options.ratchet ?? config.ratchet ?? null;
  const sources = config.sources?.length ? config.sources : ['.'];
  const exclude = config.exclude ?? [];
  const coverageCommand = options.coverageCommand ?? config.coverageCommand ?? null;
  const runLizard = options.runLizard ?? lizardRunner();

  if (coverageCommand) runCoverageCommand(coverageCommand, projectDir);

  const lcovPath = path.resolve(projectDir, options.lcov ?? config.lcov ?? DEFAULT_LCOV);
  let lcovText;
  try {
    lcovText = fs.readFileSync(lcovPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new PrerequisiteError(`could not read ${lcovPath}: ${error.message}`, 'check the lcov path');
    throw new PrerequisiteError(
      `no lcov coverage at ${lcovPath}`,
      coverageCommand ? 'the coverage command ran but wrote no lcov there' : 'run your coverage command first, or set coverageCommand in the config',
    );
  }
  const coverage = coverageByFile(lcovText, projectDir);

  const complexityCsv = options.complexity
    ? fs.readFileSync(path.resolve(projectDir, options.complexity), 'utf8')
    : runLizard({ cwd: projectDir, sources, exclude });
  const parsed = parseLizardCsv(complexityCsv);
  const substituteReader = options.complexity
    ? null
    : substituteReaderFunctions({
      projectDir,
      files: new Set(parsed.map((entry) => displayPath(projectDir, entry.file))),
      runLizard,
    });
  const functions = measure(applySubstituteReader(parsed, projectDir, substituteReader), coverage, projectDir);

  let baseline = null;
  if (ratchet) {
    baseline = baselineFunctions({
      projectDir,
      ratchet,
      files: new Set(functions.map((entry) => entry.file)),
      runLizard,
    });
  }

  const failures = [];
  let atOrAboveMax = 0;
  let preExistingAtOrAboveMax = 0;
  for (const entry of functions) {
    const previous = baseline?.byIdentity.get(`${entry.file}\u0000${entry.function}\u0000${entry.ordinal}`);
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
    if (entry.crap >= max) {
      atOrAboveMax += 1;
      failures.push({ ...entry, reason: 'ceiling' });
    }
  }

  failures.sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line);
  return {
    functions: functions.sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line),
    failures,
    max,
    ratchet,
    unmeasured: functions.filter((entry) => entry.unmeasured).length,
    atOrAboveMax,
    preExistingAtOrAboveMax: ratchet ? preExistingAtOrAboveMax : null,
  };
}

function formatReport(report) {
  const lines = report.failures.map((entry) => {
    // Name the measurement for the file types lizard has more than one reader for, so a complexity
    // nothing in the function branches on can be traced to the reader that produced it.
    const source = entry.source && entry.source !== LIZARD_SOURCE ? ` source=${entry.source}` : '';
    return `${entry.file}:${entry.line} ${entry.function} cc=${entry.cc} coverage=${Math.round(entry.coverage * 100)}% CRAP=${entry.crap}${source}`;
  });
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
