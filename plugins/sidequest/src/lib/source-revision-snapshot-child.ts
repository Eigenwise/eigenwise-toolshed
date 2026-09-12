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
import { relative, resolve, sep } from 'node:path';

export type SnapshotCapBound = 'path cap' | 'byte cap';

export type SnapshotChildPayload = Readonly<{
  root: string;
  maxPaths: number;
  maxBytes: number;
  readingMarker: string;
}>;

export type SnapshotChildResult =
  | Readonly<{ digest: string }>
  | Readonly<{ unavailable: true }>
  | Readonly<{ limit: Readonly<{ bound: SnapshotCapBound; observed: number; cap: number }> }>;

export type SnapshotReader = (entryPath: string) => Buffer;

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

type SnapshotWalk = {
  hash: ReturnType<typeof createHash>;
  root: string;
  payload: SnapshotChildPayload;
  read: SnapshotReader;
  pathCount: number;
  bytesRead: number;
};

function snapshotPath(root: string, entryPath: string): string {
  return relative(root, entryPath).split(sep).join('/');
}

function countSnapshotPath(walk: SnapshotWalk): void {
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

function updateFilesystemSnapshot(walk: SnapshotWalk, entryPath: string): void {
  const entry = lstatSync(entryPath);
  countSnapshotPath(walk);
  const relativePath = snapshotPath(walk.root, entryPath);
  if (entry.isDirectory()) {
    walk.hash.update(`directory\0${relativePath}\0`);
    const children = readdirSync(entryPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) updateFilesystemSnapshot(walk, resolve(entryPath, child));
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

export function snapshotChildResult(payload: SnapshotChildPayload, read: SnapshotReader = readFileSync): SnapshotChildResult {
  const root = resolve(payload.root);
  let rootExists = false;
  try {
    if (!lstatSync(root).isDirectory()) return Object.freeze({ unavailable: true as const });
    rootExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return Object.freeze({ unavailable: true as const });
  }
  const hash = createHash('sha256');
  hash.update('sidequest-filesystem-snapshot-v1\0');
  try {
    if (rootExists) updateFilesystemSnapshot({ hash, root, payload, read, pathCount: 0, bytesRead: 0 }, root);
    else hash.update('missing-project-root\0');
  } catch (error) {
    if (error instanceof SnapshotCapReached) {
      return Object.freeze({
        limit: Object.freeze({ bound: error.bound, observed: error.observed, cap: error.cap }),
      });
    }
    return Object.freeze({ unavailable: true as const });
  }
  return Object.freeze({ digest: hash.digest('hex') });
}

export function runSnapshotChild(serializedPayload: string | undefined, read: SnapshotReader = readFileSync): void {
  const payload = JSON.parse(String(serializedPayload || '{}')) as SnapshotChildPayload;
  writeSync(1, JSON.stringify(snapshotChildResult(payload, read)));
}

if (require.main === module) runSnapshotChild(process.argv[2]);
