import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP_CLEANUP_RECENT_MS = 5 * 60 * 1000;

type CleanupOptions = {
  root?: string;
  now?: number;
  recentMs?: number;
};

type CleanupReport = {
  root: string;
  recentMs: number;
  scanned: number;
  removed: number;
  removedEntries: number;
  skippedRecent: string[];
  skippedUnsafe: string[];
  failed: Array<{ path: string; error: string }>;
};

function samePath(left: string, right: string) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function realPath(candidate: string) {
  return fs.realpathSync.native(candidate);
}

function isReparsePoint(candidate: string, stats?: fs.Stats) {
  const info = stats || fs.lstatSync(candidate);
  if (info.isSymbolicLink()) return true;
  if (process.platform !== 'win32') return false;
  const resolved = path.resolve(candidate);
  return !samePath(realPath(resolved), path.join(realPath(path.dirname(resolved)), path.basename(resolved)));
}

function containsReparsePoint(candidate: string): boolean {
  const stats = fs.lstatSync(candidate);
  if (isReparsePoint(candidate, stats)) return true;
  if (!stats.isDirectory()) return false;
  let names: string[];
  try {
    names = fs.readdirSync(candidate);
  } catch (error: any) {
    throw new Error(`could not inspect ${candidate}: ${error?.message || String(error)}`);
  }
  for (const name of names) {
    if (containsReparsePoint(path.join(candidate, name))) return true;
  }
  return false;
}

function removeTree(candidate: string): number {
  const stats = fs.lstatSync(candidate);
  if (isReparsePoint(candidate, stats)) throw new Error('reparse point');
  if (!stats.isDirectory()) {
    fs.unlinkSync(candidate);
    return 1;
  }
  let removed = 0;
  for (const name of fs.readdirSync(candidate)) removed += removeTree(path.join(candidate, name));
  fs.rmdirSync(candidate);
  return removed + 1;
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveCleanupRoot(candidate?: string) {
  const expected = realPath(os.tmpdir());
  const requested = candidate ? path.resolve(candidate) : expected;
  let resolved: string;
  try {
    resolved = realPath(requested);
  } catch {
    throw new Error(`temp cleanup refused: root does not exist: ${requested}`);
  }
  if (!samePath(resolved, expected) && !isInside(resolved, expected)) {
    throw new Error(`temp cleanup refused: root must resolve to the OS temp directory (${expected}) or a directory inside it`);
  }
  if (isReparsePoint(requested)) {
    throw new Error('temp cleanup refused: the cleanup root is a symlink or reparse point');
  }
  return resolved;
}

export function cleanupTempRoots(options: CleanupOptions = {}): CleanupReport {
  const root = resolveCleanupRoot(options.root);
  const now = options.now ?? Date.now();
  const recentMs = options.recentMs ?? TEMP_CLEANUP_RECENT_MS;
  const report: CleanupReport = {
    root,
    recentMs,
    scanned: 0,
    removed: 0,
    removedEntries: 0,
    skippedRecent: [],
    skippedUnsafe: [],
    failed: [],
  };

  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('sq-')) continue;
    const candidate = path.join(root, name);
    report.scanned++;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error: any) {
      report.failed.push({ path: candidate, error: error?.message || String(error) });
      continue;
    }
    if (stats.mtimeMs > now - recentMs) {
      report.skippedRecent.push(candidate);
      continue;
    }
    try {
      if (isReparsePoint(candidate, stats) || containsReparsePoint(candidate)) {
        report.skippedUnsafe.push(candidate);
        continue;
      }
    } catch (error: any) {
      report.skippedUnsafe.push(candidate);
      report.failed.push({ path: candidate, error: error?.message || String(error) });
      continue;
    }
    try {
      report.removedEntries += removeTree(candidate);
      report.removed++;
    } catch (error: any) {
      report.failed.push({ path: candidate, error: error?.message || String(error) });
    }
  }
  return report;
}
