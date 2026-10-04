'use strict';

// The filesystem snapshot walk runs here, in a child process, because a readFileSync that blocks
// forever cannot be interrupted in the process that started it. A OneDrive files-on-demand
// placeholder does exactly that during hydration, so the caller enforces its wall clock by killing
// this process instead of by checking a deadline between entries (SQ-2799).
//
// Windows marks those placeholders with FILE_ATTRIBUTE_OFFLINE / RECALL_ON_OPEN /
// RECALL_ON_DATA_ACCESS, which would let a snapshot refuse before touching the file, but Node 22
// exposes no attribute field on fs.Stats and nothing in fs.constants, so the kill is the only bound
// available without a native dependency or a shelled-out call per file.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { basename, join, matchesGlob, relative, resolve, sep } from 'node:path';

export type SnapshotCapBound = 'path cap' | 'byte cap';

export type SnapshotChildPayload = Readonly<{
  root: string;
  maxPaths: number;
  maxBytes: number;
  readingMarker: string;
}>;

export type SnapshotCountedEntry = Readonly<{ path: string; paths: number }>;

export type SnapshotWalkLimit = Readonly<{
  bound: SnapshotCapBound;
  observed: number;
  cap: number;
  skipped: readonly string[];
  skippedTotal: number;
  counted: readonly SnapshotCountedEntry[];
}>;

export type SnapshotChildResult =
  | Readonly<{ digest: string }>
  | Readonly<{ unavailable: true }>
  | Readonly<{ limit: SnapshotWalkLimit }>;

export type SnapshotReader = (entryPath: string) => Buffer;

// A snapshot stands for the project's own content. Version-control internals and installed or
// built output are regenerated, and counting them put a 19-file repository over the path cap (GH-334).
export const SNAPSHOT_SKIPPED_NAMES: readonly string[] = Object.freeze(['.git', 'node_modules', '.next', 'dist', 'build', 'target', '.venv', 'vendor']);
const skippedNames = new Set(SNAPSHOT_SKIPPED_NAMES);

// A refusal shares a byte budget, so it names a bounded sample of what the walk skipped and counted.
const REPORTED_SKIPPED_MAX = 10;
const REPORTED_COUNTED_MAX = 5;

const UNAVAILABLE = Object.freeze({ unavailable: true as const });

class SnapshotCapReached extends Error {
  readonly bound: SnapshotCapBound;
  readonly observed: number;
  readonly cap: number;

  constructor(bound: SnapshotCapBound, observed: number, cap: number) {
    super(`filesystem snapshot ${bound} exceeded: observed ${observed}, cap ${cap}`);
    this.name = 'SnapshotCapReached';
    this.bound = bound;
    this.observed = observed;
    this.cap = cap;
  }
}

type GitignoreRule = Readonly<{ glob: string; directoryOnly: boolean }>;

type SnapshotWalk = {
  hash: ReturnType<typeof createHash>;
  root: string;
  payload: SnapshotChildPayload;
  read: SnapshotReader;
  ignoreRules: readonly GitignoreRule[];
  pathCount: number;
  bytesRead: number;
  skipped: string[];
  countedByTopLevel: Map<string, number>;
};

function gitignoreRule(line: string): GitignoreRule {
  const directoryOnly = line.endsWith('/');
  const pattern = directoryOnly ? line.slice(0, -1) : line;
  if (!pattern.includes('/')) return Object.freeze({ glob: `**/${pattern}`, directoryOnly });
  return Object.freeze({ glob: pattern.startsWith('/') ? pattern.slice(1) : pattern, directoryOnly });
}

// ponytail: only the root .gitignore is read and `!` re-includes are dropped, so a re-included path
// under an ignored pattern stays out of the snapshot; parse nested files and negation if a board needs them.
function gitignoreRules(root: string): readonly GitignoreRule[] {
  let text: string;
  try {
    text = readFileSync(join(root, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(gitignoreRule);
}

function skippedByWalk(walk: SnapshotWalk, relativePath: string, isDirectory: boolean): boolean {
  return skippedNames.has(basename(relativePath))
    || walk.ignoreRules.some((rule) => (isDirectory || !rule.directoryOnly) && matchesGlob(relativePath, rule.glob));
}

function snapshotPath(root: string, entryPath: string): string {
  return relative(root, entryPath).split(sep).join('/');
}

function countSnapshotPath(walk: SnapshotWalk, relativePath: string): void {
  const topLevel = relativePath.split('/')[0] || '.';
  walk.countedByTopLevel.set(topLevel, (walk.countedByTopLevel.get(topLevel) || 0) + 1);
  walk.pathCount += 1;
  if (walk.pathCount > walk.payload.maxPaths) {
    throw new SnapshotCapReached('path cap', walk.pathCount, walk.payload.maxPaths);
  }
}

function reserveSnapshotBytes(walk: SnapshotWalk, byteCount: number): void {
  const observedBytes = walk.bytesRead + byteCount;
  if (observedBytes > walk.payload.maxBytes) {
    throw new SnapshotCapReached('byte cap', observedBytes, walk.payload.maxBytes);
  }
}

function updateDirectorySnapshot(walk: SnapshotWalk, entryPath: string, relativePath: string): void {
  walk.hash.update(`directory\0${relativePath}\0`);
  const children = readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const childPath = resolve(entryPath, child.name);
    const childRelativePath = snapshotPath(walk.root, childPath);
    if (skippedByWalk(walk, childRelativePath, child.isDirectory())) walk.skipped.push(childRelativePath);
    else updateFilesystemSnapshot(walk, childPath);
  }
}

function updateFilesystemSnapshot(walk: SnapshotWalk, entryPath: string): void {
  const entry = lstatSync(entryPath);
  const relativePath = snapshotPath(walk.root, entryPath);
  countSnapshotPath(walk, relativePath);
  if (entry.isDirectory()) {
    updateDirectorySnapshot(walk, entryPath, relativePath);
    return;
  }
  if (entry.isSymbolicLink()) {
    walk.hash.update(`symlink\0${relativePath}\0${readlinkSync(entryPath)}\0`);
    return;
  }
  if (entry.isFile()) {
    walk.hash.update(`file\0${relativePath}\0`);
    reserveSnapshotBytes(walk, entry.size);
    // The caller reads this back off stderr after it kills a timed-out snapshot: the name of the
    // file being read when the clock ran out is the whole diagnostic value of that refusal.
    writeSync(2, `${walk.payload.readingMarker}${relativePath}\n`);
    const contents = walk.read(entryPath);
    reserveSnapshotBytes(walk, contents.byteLength);
    walk.bytesRead += contents.byteLength;
    walk.hash.update(contents);
    walk.hash.update('\0');
    return;
  }
  walk.hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}

function largestCountedEntries(walk: SnapshotWalk): readonly SnapshotCountedEntry[] {
  return [...walk.countedByTopLevel]
    .sort((left, right) => right[1] - left[1])
    .slice(0, REPORTED_COUNTED_MAX)
    .map(([path, paths]) => Object.freeze({ path, paths }));
}

function walkedSnapshotResult(walk: SnapshotWalk): SnapshotChildResult {
  try {
    updateFilesystemSnapshot(walk, walk.root);
  } catch (error) {
    if (!(error instanceof SnapshotCapReached)) return UNAVAILABLE;
    return Object.freeze({
      limit: Object.freeze({
        bound: error.bound,
        observed: error.observed,
        cap: error.cap,
        skipped: walk.skipped.slice(0, REPORTED_SKIPPED_MAX),
        skippedTotal: walk.skipped.length,
        counted: largestCountedEntries(walk),
      }),
    });
  }
  return Object.freeze({ digest: walk.hash.digest('hex') });
}

function snapshotRootState(root: string): 'directory' | 'missing' | 'unavailable' {
  try {
    return lstatSync(root).isDirectory() ? 'directory' : 'unavailable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

export function snapshotChildResult(payload: SnapshotChildPayload, read: SnapshotReader = readFileSync): SnapshotChildResult {
  const root = resolve(payload.root);
  const rootState = snapshotRootState(root);
  if (rootState === 'unavailable') return UNAVAILABLE;
  const hash = createHash('sha256');
  hash.update('sidequest-filesystem-snapshot-v1\0');
  if (rootState === 'missing') return Object.freeze({ digest: hash.update('missing-project-root\0').digest('hex') });
  return walkedSnapshotResult({
    hash, root, payload, read, ignoreRules: gitignoreRules(root), pathCount: 0, bytesRead: 0, skipped: [], countedByTopLevel: new Map(),
  });
}

export function runSnapshotChild(serializedPayload: string | undefined, read: SnapshotReader = readFileSync): void {
  const payload = JSON.parse(String(serializedPayload || '{}')) as SnapshotChildPayload;
  writeSync(1, JSON.stringify(snapshotChildResult(payload, read)));
}

if (require.main === module) runSnapshotChild(process.argv[2]);
