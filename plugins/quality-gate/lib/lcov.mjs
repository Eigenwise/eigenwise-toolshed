import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizedPath } from './core.mjs';
import { sourceHashes } from './crap-inputs.mjs';

export function coverageByFile(text, root) {
  const files = new Map();
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const [kind, value] = rawLine.split(/:(.*)/s);
    switch (kind) {
      case 'SF': {
        const key = normalizedPath(path.resolve(root, value));
        current = new Map(files.get(key));
        files.set(key, current);
        break;
      }
      case 'end_of_record': current = undefined; break;
      case 'DA': recordLine(current, value); break;
    }
  }
  return files;
}

function recordLine(lines, value) {
  if (!lines) return;
  const [line, hits] = value.split(',').map(Number);
  if (!Number.isInteger(line) || !Number.isFinite(hits)) throw new Error('Invalid LCOV DA record. Regenerate LCOV with your coverage tool.');
  lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}

function readCoverage(lcovPath, hashes) {
  try {
    return { text: fs.readFileSync(lcovPath, 'utf8'), hashes, lcovPath };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { text: '', hashes, reason: `No LCOV at ${lcovPath}. Run coverage, set coverageCommand, or use your Vitest coverage provider's LCOV output; raw NODE_V8_COVERAGE does not identify vite-node modules.` };
  }
}

function existingHashes(lcovPath) {
  const hashPath = lcovPath + '.sources.json';
  if (!fs.existsSync(hashPath)) return {};
  return JSON.parse(fs.readFileSync(hashPath, 'utf8'));
}

const COMMAND_VARIABLE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g;

// cmd.exe never expands $VAR and sh never expands %VAR%, so without this one coverageCommand only works on one platform (GH-543).
export function expandCommandVariables(command, env) {
  return command.replace(COMMAND_VARIABLE, (match, braced, bare, percent) => env[braced ?? bare ?? percent] ?? match);
}

function runCoverage(command, root, reportsDirectory) {
  const env = { ...process.env, QUALITY_GATE_COVERAGE_DIR: reportsDirectory, QUARTERMASTER_COVERAGE_DIR: reportsDirectory };
  const result = spawnSync(expandCommandVariables(command, env), { cwd: root, shell: true, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024, env });
  if (result.status !== 0) throw new Error(`Coverage command failed: ${result.stderr || result.error?.message || result.status}. Fix coverageCommand, then rerun the gate.`);
}

function coverageStamp(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : null;
}

export function acquireCoverage(root, settings, files) {
  const defaultPath = path.resolve(root, settings.fallbackLcov || 'coverage/lcov.info');
  const explicitPath = settings.lcov ? path.resolve(root, settings.lcov) : null;
  if (!settings.coverageCommand) {
    const lcovPath = explicitPath || defaultPath;
    return readCoverage(lcovPath, existingHashes(lcovPath));
  }
  const reportsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-coverage-'));
  try {
    return captureCoverage(root, settings, files, { defaultPath, explicitPath, reportsDirectory });
  } finally {
    fs.rmSync(reportsDirectory, { recursive: true, force: true });
  }
}

function capturedPath({ defaultPath, explicitPath, reportsDirectory }, before) {
  const isolatedPath = path.join(reportsDirectory, 'lcov.info');
  const target = explicitPath || (fs.existsSync(isolatedPath) ? isolatedPath : defaultPath);
  if (coverageStamp(target) === before.get(target)) throw new Error(`Coverage command did not rewrite ${target}. Fix coverageCommand to write fresh LCOV, then rerun the gate.`);
  return target;
}

function captureCoverage(root, settings, files, locations) {
  const hashes = sourceHashes(root, files);
  const before = new Map([locations.defaultPath, locations.explicitPath].filter(Boolean).map((file) => [file, coverageStamp(file)]));
  runCoverage(settings.coverageCommand, root, locations.reportsDirectory);
  const after = sourceHashes(root, files);
  if (JSON.stringify(hashes) !== JSON.stringify(after)) throw new Error('Scored source changed during coverageCommand. Stop source edits and rerun coverage on fixed bytes.');
  return readCoverage(capturedPath(locations, before), hashes);
}

export function coverageTrust(input, file, hash) {
  if (input.reason) return input.reason;
  if (input.hashes[file] !== hash) return `Coverage source hash is missing or differs for ${file}. Rerun with coverageCommand, or supply an authentic ${input.lcovPath}.sources.json SHA-256 map from the coverage capture.`;
  return null;
}

export function functionLineCoverage(descriptor, descriptors, lines) {
  if (descriptor.ownedLines) return inventoriedLineCoverage(descriptor, descriptors, lines);
  return { unverified: 'LCOV executable-line completeness is unverified for this adapter. Source hashes and DA records alone cannot establish the denominator. Only the JS/TS and Python adapters inventory executable lines from exact source.' };
}

function isAncestorBody(ancestor, descendant, descriptors) {
  let parent = descendant.parent;
  while (parent !== '<root>') {
    if (parent === ancestor.identity) return true;
    parent = descriptors.find((candidate) => candidate.identity === parent)?.parent;
    if (!parent) return false;
  }
  return false;
}

function nestedLineSubset(left, right, descriptors) {
  if (isAncestorBody(left, right, descriptors)) return right.ownedLines.every((line) => left.ownedLines.includes(line));
  return isAncestorBody(right, left, descriptors) && left.ownedLines.every((line) => right.ownedLines.includes(line));
}

function sharedLineCoverage(descriptor, descriptors) {
  const shared = descriptors.filter((candidate) => candidate.identity !== descriptor.identity && candidate.ownedLines?.some((line) => descriptor.ownedLines.includes(line)));
  if (!shared.length) return {};
  if (shared.some((candidate) => !nestedLineSubset(descriptor, candidate, descriptors))) return { unverified: 'Sibling bodies share executable source lines without nested owned-line containment. Put those bodies on separate lines to measure per-function LCOV coverage.' };
  return { coverageNote: 'Shared nested-body DA lines measure line execution, an upper bound for callback execution; coverage uses those line hits for both bodies.' };
}

function inventoriedLineCoverage(descriptor, descriptors, lines) {
  const shared = sharedLineCoverage(descriptor, descriptors);
  if (shared.unverified) return shared;
  const executable = descriptor.executableLines;
  if (!executable) return { unverified: 'Executable-line inventory is missing. Rerun the exact-source adapter and coverage capture.' };
  if (!executable.length) return { unverified: 'No executable LCOV lines in this function. Run coverage that includes this body, then rerun the gate.' };
  if (executable.some((line) => !lines.has(line))) return { unverified: 'Missing executable LCOV lines from the exact-source executable-line inventory. Regenerate complete coverage; exclusions, skipped statements or ambiguous multiline mapping cannot prove per-body coverage.' };
  return { ...shared, coverage: executable.filter((line) => lines.get(line) > 0).length / executable.length };
}
