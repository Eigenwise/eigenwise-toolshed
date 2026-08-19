'use strict';

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { Baseline, SourceRevision } from './kernel';

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
const registrationsByProject = new Map<string, SourceRevisionRegistration>();
const resolvedAdapterFacts = new WeakSet<object>();

function projectKey(project: string): string {
  return String(project || '').trim().toLowerCase();
}

function baselinePurpose(value: unknown): Baseline['purpose'] | null {
  if (value === 'dispatch' || value === 'wave' || value === 'submission') return value;
  return null;
}

function snapshotPath(projectPath: string, entryPath: string): string {
  return relative(projectPath, entryPath).split(sep).join('/');
}

function updateFilesystemSnapshot(hash: ReturnType<typeof createHash>, projectPath: string, entryPath: string): void {
  const entry = lstatSync(entryPath);
  const relativePath = snapshotPath(projectPath, entryPath);
  if (entry.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    const children = readdirSync(entryPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) updateFilesystemSnapshot(hash, projectPath, resolve(entryPath, child));
    return;
  }
  if (entry.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(entryPath)}\0`);
    return;
  }
  if (entry.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(readFileSync(entryPath));
    hash.update('\0');
    return;
  }
  hash.update(`other\0${relativePath}\0${entry.mode}\0${entry.size}\0`);
}

export function filesystemSnapshotRevision(projectPath: string, observedAt = new Date().toISOString()): SourceRevision | null {
  const root = resolve(String(projectPath || '').trim());
  if (!root || !Number.isFinite(Date.parse(observedAt))) return null;
  let rootExists = false;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    rootExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  const hash = createHash('sha256');
  hash.update('sidequest-filesystem-snapshot-v1\0');
  try {
    if (rootExists) updateFilesystemSnapshot(hash, root, root);
    else hash.update('missing-project-root\0');
  } catch {
    return null;
  }
  return Object.freeze({
    source: FILESYSTEM_SNAPSHOT_SOURCE,
    value: hash.digest('hex'),
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
