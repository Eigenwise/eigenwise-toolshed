'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { crapScore, functionTokenCount, parseLizardCsv } = require('./crap-core.cjs');

const DEFAULT_MAX = 6;
const DEFAULT_LCOV = 'coverage/lcov.info';
const CONFIG_RELATIVE_PATH = path.join('.claude', 'quartermaster', 'crap.json');
const INSTALL_HINT = 'install lizard with `uv tool install lizard`, `pipx install lizard`, or `pip install lizard`';
const LIZARD_CANDIDATES = [
  { command: 'lizard', leading: [] },
  { command: 'uvx', leading: ['lizard'] },
  { command: 'pipx', leading: ['run', 'lizard'] },
];
const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.go', '.h', '.java', '.js', '.jsx', '.kt', '.php', '.py', '.rb', '.rs', '.ts', '.tsx']);

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

function measure(lizardFunctions, coverage, projectDir) {
  return lizardFunctions.map((entry) => {
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
    };
  });
}

function git(projectDir, args, hint) {
  const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`git ${args[0]} failed to start: ${result.error.message}`, hint);
  if (result.status !== 0) throw new PrerequisiteError(`git ${args.join(' ')} failed: ${lastLines(result.stderr, 2)}`, hint);
  return result.stdout;
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

function baselineFunctions({ projectDir, baseReference, files, exclude, runLizard }) {
  const hint = `check that ${JSON.stringify(baseReference)} is a git ref this repository knows`;
  const base = git(projectDir, ['merge-base', 'HEAD', baseReference], hint).trim();
  const changed = new Set(git(projectDir, ['diff', '--name-only', '--relative', base], hint).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const changedHere = [...files].filter((file) => changed.has(file));
  const byIdentity = new Map();
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-crap-base-'));
  try {
    for (const file of changedHere) {
      const show = spawnSync('git', ['show', `${base}:${file}`], { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (show.status !== 0) continue;
      const target = path.join(temporaryDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, show.stdout, 'utf8');
      for (const entry of measure(parseLizardCsv(runLizard({ cwd: temporaryDir, sources: [file], exclude })), new Map(), temporaryDir)) {
        byIdentity.set(functionIdentity(entry), entry);
      }
    }
    return { base, changed, byIdentity };
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

function runCoverageCommand(command, projectDir) {
  const result = spawnSync(command, { cwd: projectDir, shell: true, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new PrerequisiteError(`coverage command failed to start: ${result.error.message}`, 'check coverageCommand in the config');
  if (result.status !== 0) throw new PrerequisiteError(`coverage command exited ${result.status}: ${lastLines(result.stderr, 3)}`, 'fix the coverage command, then run the gate again');
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

// lizard's own -x matching is fnmatch against the raw os.walk path it builds from the source
// argument, which carries a "./" prefix that makes an anchored pattern like "dist/**" never
// match. path.matchesGlob against the display-relative path instead gives every documented
// pattern ("**/*.test.*", "dist/**", "**/node_modules/**") its plainly intended meaning.
function excludedByConfig(projectDir, exclude) {
  const patterns = exclude ?? [];
  return (filePath) => patterns.some((pattern) => path.matchesGlob(displayPath(projectDir, filePath), pattern));
}

function unmeasuredLizardFiles(projectDir, sources, entries, changed, exclude) {
  const measured = new Set(entries.map((entry) => comparablePath(projectDir, entry.file)));
  const isExcluded = excludedByConfig(projectDir, exclude);
  return sources.flatMap((source) => sourceFiles(path.resolve(projectDir, source)))
    .filter((file) => changed.has(displayPath(projectDir, file)))
    .filter((file) => !isExcluded(file))
    .filter((file) => functionTokenCount(fs.readFileSync(file, 'utf8')) && !measured.has(comparablePath(projectDir, file)))
    .map((file) => displayPath(projectDir, file));
}

function changedFunctions(functions, baseline) {
  if (!baseline) return functions;
  return functions.filter((entry) => {
    if (!baseline.changed.has(entry.file)) return false;
    const previous = baseline.byIdentity.get(functionIdentity(entry));
    return !previous || !entry.fingerprint || !previous.fingerprint || entry.fingerprint !== previous.fingerprint;
  });
}

function crapReport(options) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const config = readConfig(projectDir);
  const requestedMax = Number(options.max ?? config.max ?? DEFAULT_MAX);
  if (requestedMax !== DEFAULT_MAX) throw new PrerequisiteError(`the CRAP threshold is fixed at ${DEFAULT_MAX}`, 'remove max from the command or config');
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
    throw new PrerequisiteError(`no lcov coverage at ${lcovPath}`, coverageCommand ? 'the coverage command ran but wrote no lcov there' : 'run your coverage command first, or set coverageCommand in the config');
  }
  const lizardEntries = parseLizardCsv(options.complexity ? fs.readFileSync(path.resolve(projectDir, options.complexity), 'utf8') : runLizard({ cwd: projectDir, sources, exclude }));
  const functions = measure(lizardEntries, coverageByFile(lcovText, projectDir), projectDir);
  const baseReference = options.base ?? options.ratchet ?? config.base ?? config.ratchet ?? defaultBase(projectDir);
  const baseline = baseReference === 'HEAD' ? null : baselineFunctions({ projectDir, baseReference, files: new Set(functions.map((entry) => entry.file)), exclude, runLizard });
  const candidates = changedFunctions(functions, baseline);
  const lizardFailures = unmeasuredLizardFiles(projectDir, sources, lizardEntries, baseline?.changed ?? new Set(functions.map((entry) => entry.file)), exclude);
  if (lizardFailures.length) throw new PrerequisiteError(`lizard reported zero functions for ${lizardFailures.join(', ')}`, 'measurement is unverified; fix the parser input before passing the gate');
  const unmeasured = candidates.filter((entry) => entry.unmeasured);
  if (unmeasured.length) throw new PrerequisiteError(`coverage is unverified for ${unmeasured.map((entry) => `${entry.file}:${entry.line} ${entry.function}`).join(', ')}`, 'run coverage that includes every changed function before passing the gate');
  const failures = candidates.filter((entry) => entry.crap >= DEFAULT_MAX).sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line).map((entry) => ({ ...entry, reason: 'ceiling' }));
  return { functions: functions.sort((left, right) => right.crap - left.crap || left.file.localeCompare(right.file) || left.line - right.line), failures, max: DEFAULT_MAX, checked: candidates.length, unmeasured: 0, base: baseline?.base ?? null };
}

function formatReport(report) {
  const lines = report.failures.map((entry) => `${entry.file}:${entry.line} ${entry.function} cc=${entry.cc} coverage=${Math.round(entry.coverage * 100)}% CRAP=${entry.crap}`);
  lines.push(`CRAP gate ${report.failures.length ? 'failed' : 'passed'}: ${report.failures.length} of ${report.checked} changed or new functions at or above ${report.max}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { DEFAULT_MAX, INSTALL_HINT, PrerequisiteError, coverageByFile, crapReport, crapScore, formatReport, parseLizardCsv };
