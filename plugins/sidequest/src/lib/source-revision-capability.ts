'use strict';

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

const registrationsByProject = new Map<string, SourceRevisionRegistration>();
const resolvedAdapterFacts = new WeakSet<object>();

function projectKey(project: string): string {
  return String(project || '').trim().toLowerCase();
}

function baselinePurpose(value: unknown): Baseline['purpose'] | null {
  if (value === 'dispatch' || value === 'wave' || value === 'submission') return value;
  return null;
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
): SourceRevisionAdapterFacts | null {
  const pinnedCandidate = sourceRevision(candidate || undefined);
  const pinnedBaseline = immutableBaseline(baseline || undefined);
  if (!pinnedCandidate || !pinnedBaseline) return null;
  const capability = registrationsByProject.get(projectKey(project))?.capability;
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
