'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PARSE_CHECKS = {
  '.js': (file) => ['node', ['--check', file]],
  '.cjs': (file) => ['node', ['--check', file]],
  '.mjs': (file) => ['node', ['--check', file]],
  '.ps1': (file) => ['pwsh', ['-NoProfile', '-Command', `$null = [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count) { exit 1 }`]],
  '.py': (file) => ['python', ['-m', 'py_compile', file]],
  '.sh': (file) => ['bash', ['-n', file]],
};

/**
 * Checks that a salvaged file is syntactically valid before anyone is asked to review it. A retro that
 * ships a broken script is worse than one that ships nothing, because the reader stops trusting the
 * next report too.
 */
function checkParses(file) {
  const extension = path.extname(file).toLowerCase();
  const build = PARSE_CHECKS[extension];
  if (!build) return { checked: false, ok: null, reason: `no parse check for ${extension || 'files with no extension'}` };
  const [command, args] = build(file);
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) return { checked: false, ok: null, reason: `${command} is not available: ${result.error.message}` };
  return {
    checked: true,
    ok: result.status === 0,
    reason: result.status === 0 ? 'parses' : String(result.stderr ?? '').trim().split('\n').slice(0, 4).join('\n'),
  };
}

// Output that legitimately moves between runs: timings, byte counts, temp directory names. Comparing
// after normalizing these keeps the check meaningful instead of failing on a clock.
function normalizeOutput(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~+-]+)+[\\/]?/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length)
    .join('\n');
}

function compareOutput(recorded, actual) {
  if (recorded === actual) return { match: 'exact', detail: 'byte-identical to the recorded output' };
  const a = normalizeOutput(recorded);
  const b = normalizeOutput(actual);
  if (a === b) return { match: 'normalized', detail: 'identical once timestamps, ids, paths, and numbers are normalized' };

  const left = a.split('\n');
  const right = b.split('\n');
  const at = left.findIndex((line, index) => line !== right[index]);
  return {
    match: 'differs',
    detail: `first difference at normalized line ${at + 1}\n  recorded: ${left[at] ?? '(end of output)'}\n  actual:   ${right[at] ?? '(end of output)'}`,
  };
}

/**
 * Points the recorded command at the salvaged copy.
 *
 * The replacement is written with forward slashes and quoted, because the command is replayed through a
 * shell: a Windows path substituted raw loses its backslashes to shell escaping and the script is
 * reported as broken when only the path was. An occurrence that was already quoted keeps its own quotes
 * rather than gaining a second pair.
 */
function retarget(command, sourcePath, basename, target) {
  const replacement = target.split('\\').join('/');

  // The path recorded in the tool input and the path written into the command often disagree about
  // slashes on Windows, so both spellings are tried before falling back to the bare filename. Matching
  // the filename inside a full path would splice the replacement into the middle of it.
  const candidates = [];
  if (sourcePath) candidates.push(sourcePath, sourcePath.split('\\').join('/'), sourcePath.split('/').join('\\'));
  const original = candidates.find((candidate) => command.includes(candidate)) ?? (command.includes(basename) ? basename : null);
  if (!original) return command;

  return command
    .split(`"${original}"`).join(`"${replacement}"`)
    .split(`'${original}'`).join(`"${replacement}"`)
    .split(original).join(`"${replacement}"`)
    .replace(/""+/g, '"');
}

function isAvailable(executable, args = ['--version']) {
  const probe = spawnSync(executable, args, { windowsHide: true });
  return !probe.error && probe.status === 0;
}

function bundledGitBash() {
  if (process.platform !== 'win32') return null;
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  if (git.error || git.status !== 0) return null;

  for (const executable of String(git.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
    const bash = path.resolve(path.dirname(executable), '..', 'bin', 'bash.exe');
    if (fs.existsSync(bash) && isAvailable(bash)) return bash;
  }
  return null;
}

function resolveShell(tool) {
  if (tool === 'PowerShell') {
    const probe = ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'];
    if (isAvailable('pwsh', probe)) return 'pwsh';
    if (isAvailable('powershell', probe)) return 'powershell';
    return null;
  }
  if (isAvailable('bash')) return 'bash';
  return bundledGitBash();
}

function shellFor(tool, command, resolve = resolveShell) {
  const executable = resolve(tool);
  if (!executable) return null;
  return tool === 'PowerShell'
    ? [executable, ['-NoProfile', '-NonInteractive', '-Command', command]]
    : [executable, ['-lc', command]];
}

/**
 * Re-runs the command that proved a salvaged script worked, against the salvaged copy, and compares
 * with the output the transcript recorded at the time. The transcript holds both halves, so whether
 * the script still works is decidable rather than assumed.
 *
 * Execution is opt-in: the recorded command came out of a transcript and may do anything, so the
 * default prints what would run and stops.
 */
function verifySalvage(entry, options = {}) {
  const { execute = false, cwd = process.cwd() } = options;
  const result = { id: entry.id, basename: entry.basename };

  const scratch = options.scratchDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skill-retro-verify-'));
  const target = path.join(scratch, entry.basename);
  fs.writeFileSync(target, entry.content, 'utf8');
  result.restoredTo = target;
  result.parse = checkParses(target);

  if (!entry.proof) {
    result.execution = { status: 'unproven', detail: 'no successful run of this file was recorded in the window, so there is nothing to compare against' };
    return result;
  }

  result.command = retarget(entry.proof.command, entry.sourcePath, entry.basename, target);
  const { command } = result;

  if (!execute) {
    result.execution = { status: 'skipped', detail: 'pass --run to execute the recorded command and diff against the recorded output' };
    return result;
  }

  const tool = entry.proof.tool ?? 'Bash';
  const shell = shellFor(tool, command, options.resolveShell);
  if (!shell) {
    result.execution = { status: 'shell-unavailable', detail: `The recorded ${tool} shell is unavailable, so this replay could not run.` };
    return result;
  }

  const [executable, args] = shell;
  const run = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs ?? 120000 });
  if (run.error) {
    result.execution = run.error.code === 'ENOENT'
      ? { status: 'shell-unavailable', detail: `The recorded ${tool} shell (${executable}) is unavailable, so this replay could not run.` }
      : { status: 'error', detail: run.error.message };
    return result;
  }
  result.execution = {
    status: run.status === 0 ? 'ran' : 'nonzero-exit',
    exitCode: run.status,
    ...compareOutput(entry.proof.stdout, `${run.stdout ?? ''}${run.stderr ?? ''}`),
  };
  return result;
}

function pathsExist(paths, base) {
  return paths.map((candidate) => {
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(base, candidate);
    return { path: candidate, exists: fs.existsSync(resolved) };
  });
}

function gitTracked(projectPath, relativePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relativePath], {
      cwd: projectPath,
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { checkParses, compareOutput, gitTracked, normalizeOutput, pathsExist, retarget, shellFor, verifySalvage };
