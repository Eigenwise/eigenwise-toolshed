'use strict';

import { spawnSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import type { Baseline, SourceRevision } from './kernel';
import type { SnapshotChildResult } from './source-revision-snapshot-child';

export type SourceRevisionResolution = Readonly<{
  candidateExists: boolean;
  containsCandidate: boolean;
}>;

export type SourceRevisionCapability = (
  candidate: SourceRevision,
  baseline: Baseline,
) => SourceRevisionResolution | null | undefined;

export type SourceRevisionAdapterFacts = Readonly<{
  candidate: SourceRevision;
  dispatchBaseline: Baseline;
  baseline: SourceRevisionResolution | null;
}>;

type SourceRevisionTicket = Readonly<{
  dispatch?: Readonly<{ lifecycleAttempt?: Readonly<{ baseline?: Baseline }> }>;
  lifecycleAttempt?: Readonly<{ baseline?: Baseline }>;
  submissionRetry?: Readonly<{ baseline?: Baseline }>;
}>;

type SourceRevisionRegistration = Readonly<{
  token: symbol;
  capability: SourceRevisionCapability;
}>;

const FILESYSTEM_SNAPSHOT_SOURCE = 'filesystem-snapshot';
export const FILESYSTEM_SNAPSHOT_MAX_PATHS = 500;
export const FILESYSTEM_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS = 10_000;

export type FilesystemSnapshotLimit = 'path cap' | 'byte cap' | 'deadline';

export class FilesystemSnapshotLimitError extends Error {
  readonly bound: FilesystemSnapshotLimit;
  readonly observed: number;
  readonly cap: number;
  readonly path: string | null;

  constructor(bound: FilesystemSnapshotLimit, observed: number, cap: number, blockingPath: string | null = null) {
    super(`filesystem snapshot ${bound} exceeded: observed ${observed}, cap ${cap}${blockingPath ? ` while reading ${blockingPath}` : ''}`);
    this.name = 'FilesystemSnapshotLimitError';
    this.bound = bound;
    this.observed = observed;
    this.cap = cap;
    this.path = blockingPath;
  }
}

export function isFilesystemSnapshotLimitError(error: unknown): error is FilesystemSnapshotLimitError {
  return error instanceof FilesystemSnapshotLimitError;
}

export type FilesystemSnapshotOptions = Readonly<{
  maxPaths?: number;
  maxBytes?: number;
  maxElapsedMs?: number;
  // Seam for the tests that need a walk which blocks forever, which no fixture tree can produce.
  childScript?: string;
}>;

// Stderr lines from the snapshot child that carry the file it is about to read.
const SNAPSHOT_READING_MARKER = 'sidequest-snapshot-reading\t';

const snapshotChildExtension = extname(__filename) || '.js';
// The tests load this module from TypeScript through tsx, so the child needs the same loader, and
// resolving it from the plugin root rather than the caller's cwd keeps that independent of where
// the suite was started. The built plugin runs a plain .js child on plain node.
const snapshotChildRunsTypeScript = snapshotChildExtension === '.ts';
const defaultSnapshotChildScript = resolve(__dirname, `source-revision-snapshot-child${snapshotChildExtension}`);
const snapshotChildWorkingDirectory = snapshotChildRunsTypeScript ? resolve(__dirname, '..', '..') : undefined;

const registrationsByProject = new Map<string, SourceRevisionRegistration>();
const resolvedAdapterFacts = new WeakSet<object>();

function projectKey(project: string): string {
  return String(project || '').trim().toLowerCase();
}

function baselinePurpose(value: unknown): Baseline['purpose'] | null {
  if (value === 'dispatch' || value === 'wave' || value === 'submission') return value;
  return null;
}

function snapshotLimit(value: number | undefined, defaultLimit: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultLimit;
}

function blockingSnapshotPath(stderr: string): string | null {
  const lines = String(stderr || '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] || '';
    if (line.startsWith(SNAPSHOT_READING_MARKER)) return line.slice(SNAPSHOT_READING_MARKER.length).trim() || null;
  }
  return null;
}

function snapshotChildResult(root: string, options: FilesystemSnapshotOptions | undefined): SnapshotChildResult | null {
  const maxElapsedMs = snapshotLimit(options?.maxElapsedMs, FILESYSTEM_SNAPSHOT_MAX_ELAPSED_MS);
  const childScript = options?.childScript || defaultSnapshotChildScript;
  const payload = JSON.stringify({
    root,
    maxPaths: snapshotLimit(options?.maxPaths, FILESYSTEM_SNAPSHOT_MAX_PATHS),
    maxBytes: snapshotLimit(options?.maxBytes, FILESYSTEM_SNAPSHOT_MAX_BYTES),
    readingMarker: SNAPSHOT_READING_MARKER,
  });
  const startedAt = performance.now();
  const child = spawnSync(
    process.execPath,
    snapshotChildRunsTypeScript ? ['--import', 'tsx', childScript, payload] : [childScript, payload],
    // spawnSync reads a zero timeout as "no timeout", which is the unbounded hang this exists to end.
    { encoding: 'utf8', timeout: Math.max(1, maxElapsedMs), windowsHide: true, cwd: snapshotChildWorkingDirectory },
  );
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new FilesystemSnapshotLimitError('deadline', elapsedMs, maxElapsedMs, blockingSnapshotPath(child.stderr));
  }
  if (child.error || child.status !== 0) return null;
  try {
    return JSON.parse(String(child.stdout || '')) as SnapshotChildResult;
  } catch {
    return null;
  }
}

export function filesystemSnapshotRevision(
  projectPath: string,
  observedAt = new Date().toISOString(),
  options?: FilesystemSnapshotOptions,
): SourceRevision | null {
  const root = resolve(String(projectPath || '').trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  const result = snapshotChildResult(root, options);
  if (!result) return null;
  if ('limit' in result) {
    throw new FilesystemSnapshotLimitError(result.limit.bound, result.limit.observed, result.limit.cap);
  }
  if (!('digest' in result)) return null;
  return Object.freeze({
    source: FILESYSTEM_SNAPSHOT_SOURCE,
    value: result.digest,
    observedAt: new Date(observedAt).toISOString(),
  });
}

export function filesystemSnapshotCapability(
  projectPath: string,
  hasPersistedBaseline: (baseline: Baseline) => boolean,
): SourceRevisionCapability {
  return (candidate, baseline) => {
    if (candidate.source !== FILESYSTEM_SNAPSHOT_SOURCE) return null;
    const current = filesystemSnapshotRevision(projectPath, candidate.observedAt);
    return Object.freeze({
      candidateExists: current?.value === candidate.value,
      containsCandidate: baseline.revision.source === FILESYSTEM_SNAPSHOT_SOURCE && hasPersistedBaseline(baseline),
    });
  };
}

export function sourceRevision(value: SourceRevision | undefined): SourceRevision | null {
  const source = String(value?.source || '').trim();
  const revisionValue = String(value?.value || '').trim();
  const observedAt = String(value?.observedAt || '').trim();
  if (!source || !revisionValue || !Number.isFinite(Date.parse(observedAt))) return null;
  return Object.freeze({ source, value: revisionValue, observedAt: new Date(observedAt).toISOString() });
}

function immutableBaseline(value: Baseline | undefined): Baseline | null {
  const revision = sourceRevision(value?.revision);
  const purpose = baselinePurpose(value?.purpose);
  if (!revision || !purpose) return null;
  return Object.freeze({ revision, purpose });
}

export function sourceRevisionBaseline(ticket: SourceRevisionTicket | null | undefined): Baseline | null {
  return immutableBaseline(
    ticket?.submissionRetry?.baseline
    || ticket?.lifecycleAttempt?.baseline
    || ticket?.dispatch?.lifecycleAttempt?.baseline,
  );
}

export function registerSourceRevisionCapability(
  project: string,
  capability: SourceRevisionCapability,
): () => void {
  const key = projectKey(project);
  if (!key) throw new Error('source revision capability requires a project');
  if (typeof capability !== 'function') throw new Error('source revision capability must be a function');
  const token = Symbol(key);
  registrationsByProject.set(key, Object.freeze({ token, capability }));
  return () => {
    if (registrationsByProject.get(key)?.token === token) registrationsByProject.delete(key);
  };
}

export function sourceRevisionAdapterFacts(
  project: string,
  candidate: SourceRevision | null | undefined,
  baseline: Baseline | null | undefined,
  persistedCapability?: SourceRevisionCapability | null,
): SourceRevisionAdapterFacts | null {
  const pinnedCandidate = sourceRevision(candidate || undefined);
  const pinnedBaseline = immutableBaseline(baseline || undefined);
  if (!pinnedCandidate || !pinnedBaseline) return null;
  const capability = registrationsByProject.get(projectKey(project))?.capability || persistedCapability;
  let resolution: SourceRevisionResolution | null = null;
  if (capability) {
    try {
      const reported = capability(pinnedCandidate, pinnedBaseline);
      if (reported && typeof reported.candidateExists === 'boolean' && typeof reported.containsCandidate === 'boolean') {
        resolution = Object.freeze({
          candidateExists: reported.candidateExists,
          containsCandidate: reported.containsCandidate,
        });
      }
    } catch {
      resolution = null;
    }
  }
  const facts = Object.freeze({
    candidate: pinnedCandidate,
    dispatchBaseline: pinnedBaseline,
    baseline: resolution,
  });
  resolvedAdapterFacts.add(facts);
  return facts;
}

export function isSourceRevisionAdapterFacts(value: unknown): value is SourceRevisionAdapterFacts {
  return Boolean(value && typeof value === 'object' && resolvedAdapterFacts.has(value));
}
