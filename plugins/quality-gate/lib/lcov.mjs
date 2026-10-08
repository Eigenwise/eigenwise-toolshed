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

function runCoverage(command, root, reportsDirectory) {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, QUALITY_GATE_COVERAGE_DIR: reportsDirectory, QUARTERMASTER_COVERAGE_DIR: reportsDirectory } });
  if (result.status !== 0) throw new Error(`Coverage command failed: ${result.stderr || result.error?.message || result.status}. Fix coverageCommand, then rerun the gate.`);
}

function coverageStamp(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : null;
}

export function acquireCoverage(root, settings, files) {
  const defaultPath = path.join(root, 'coverage/lcov.info');
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
  const nested = descriptors.filter((candidate) => candidate.parent === descriptor.identity);
  const executable = [...lines.entries()].filter(([line]) => line >= descriptor.line && line <= descriptor.endLine && !nested.some((child) => line > child.line && line <= child.endLine));
  if (!executable.length) return { unverified: 'No executable LCOV lines in this function. Run coverage that includes this body, then rerun the gate.' };
  return { coverage: executable.filter(([, hits]) => hits > 0).length / executable.length };
}
