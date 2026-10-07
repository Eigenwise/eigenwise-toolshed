'use strict';

import { isInScope } from '../scope-match.js';
import type { Baseline, Diagnostic, SourceRevision } from './index.js';
import type { VerificationResult } from './verification.js';
import { verificationAccepted } from './verification.js';

export type WaveParticipant = Readonly<{
  ref: string;
  dependencies: readonly string[];
  declaredSurfaces: readonly string[];
}>;

export type WaveCandidate = Readonly<{
  ref: string;
  baseline: Baseline;
  surfaces: readonly string[];
  verification: VerificationResult;
  baselineCompatible?: boolean;
}>;

export type CandidateInvalidation = Readonly<{
  ref: string;
  state: 'invalidated';
  reason: 'baseline_moved' | 'surface_overlap' | 'verification_required' | 'participant_missing';
  // The finding without the recovery prose, so a caller summarising several
  // invalidations can name each one without repeating the recovery paragraph.
  detail: string;
  outside?: readonly string[];
  message: string;
}>;

export type Wave = Readonly<{
  baseline: Baseline;
  participants: readonly WaveParticipant[];
  declaredSurfaces: readonly string[];
}>;

export type AssembledWave = Readonly<{
  wave: Wave;
  candidates: readonly WaveCandidate[];
  state: 'assembled';
}>;

export type WaveGateResult = Readonly<{
  assembly: AssembledWave;
  verification: VerificationResult;
  state: 'gate_passed' | 'gate_failed' | 'gate_deferred';
}>;

export type DeliveryResult = Readonly<{
  gate: WaveGateResult;
  revision: SourceRevision;
  verification: VerificationResult;
  state: 'delivered' | 'delivery_failed';
}>;

export type WaveAssemblyDecision = Readonly<{
  ok: true;
  assembly: AssembledWave;
}> | Readonly<{
  ok: false;
  invalidated: readonly CandidateInvalidation[];
}>;

function diagnostic(code: string, message: string): Diagnostic {
  return Object.freeze({ code, message, actionable: true });
}

function normalizedSurfaces(surfaces: readonly string[]): readonly string[] {
  return Object.freeze(Array.from(new Set(
    surfaces
      .map((surface) => String(surface || '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(Boolean),
  )));
}

function sameRevision(left: SourceRevision, right: SourceRevision): boolean {
  return left.source === right.source && left.value === right.value;
}

function sameBaseline(left: Baseline, right: Baseline): boolean {
  return sameRevision(left.revision, right.revision);
}

function participantFor(wave: Wave, ref: string): WaveParticipant | null {
  return wave.participants.find((participant) => participant.ref === ref) || null;
}

// Split out so the optional field spread doesn't add its own branch to invalidation()'s
// complexity on top of the reason ternary already there.
function invalidationOutsideField(outside?: readonly string[]): Readonly<{ outside: readonly string[] }> | Record<string, never> {
  return outside?.length ? { outside: Object.freeze([...outside]) } : {};
}

function invalidation(ref: string, reason: CandidateInvalidation['reason'], detail: string, outside?: readonly string[]): CandidateInvalidation {
  // A moved baseline is the one reason redispatch cannot recover from: the
  // candidate is already verified against a revision the target rewound past, so
  // the only way forward is a hand merge onto the current target (SQ-2528).
  const recovery = reason === 'baseline_moved'
    ? ' The recorded baseline is no longer reachable from the wave target. Recovery: manually merge the verified candidate onto the current target, re-gate it, then record delivery with groomClose using deliveryCommit.'
    : ' Candidate submissions remain available. Call integrate with one candidate ref, redispatch a candidate against the current base, or have the integrator use groomClose after a verified reconciled delivery.';
  return Object.freeze({
    ref,
    state: 'invalidated',
    reason,
    detail,
    ...invalidationOutsideField(outside),
    message: `${detail}${recovery}`,
  });
}

export function openWave(input: Readonly<{
  baseline: Baseline;
  participants: readonly WaveParticipant[];
}>): Wave | Diagnostic {
  const participantRefs = new Set<string>();
  const surfaces: string[] = [];
  for (const participant of input.participants) {
    const ref = String(participant.ref || '').trim();
    if (!ref || participantRefs.has(ref)) return diagnostic('invalid_wave_participant', 'A wave requires unique non-empty participant refs.');
    participantRefs.add(ref);
    for (const dependency of participant.dependencies) {
      if (dependency === ref || !participantRefs.has(dependency) && !input.participants.some((candidate) => candidate.ref === dependency)) {
        return diagnostic('invalid_wave_dependency', `Wave participant ${ref} names an unavailable dependency ${dependency}.`);
      }
    }
    surfaces.push(...normalizedSurfaces(participant.declaredSurfaces));
  }
  if (!input.participants.length) return diagnostic('empty_wave', 'A wave requires at least one participant.');
  return Object.freeze({
    baseline: Object.freeze({ revision: Object.freeze({ ...input.baseline.revision }), purpose: 'wave' }),
    participants: Object.freeze(input.participants.map((participant) => Object.freeze({
      ref: String(participant.ref).trim(),
      dependencies: normalizedSurfaces(participant.dependencies),
      declaredSurfaces: normalizedSurfaces(participant.declaredSurfaces),
    }))),
    declaredSurfaces: normalizedSurfaces(surfaces),
  });
}

// A deferred result is admitted into the wave but never read as accepted: the pinned command runs
// once, in the shared checkout, when integrate delivers the wave.
function verificationAdmitted(verification: VerificationResult): boolean {
  return verificationAccepted(verification) || verification.status === 'deferred';
}

function baselineMoved(wave: Wave, candidate: WaveCandidate): boolean {
  return !sameBaseline(wave.baseline, candidate.baseline) && !candidate.baselineCompatible;
}

function participantInvalidation(wave: Wave, participant: WaveParticipant, candidate: WaveCandidate | undefined): CandidateInvalidation | null {
  if (!candidate) return invalidation(participant.ref, 'participant_missing', `${participant.ref} is not ready for the opened wave.`);
  if (baselineMoved(wave, candidate)) {
    return invalidation(candidate.ref, 'baseline_moved', `${candidate.ref} was verified against ${candidate.baseline.revision.source}:${candidate.baseline.revision.value}, but this wave is pinned to ${wave.baseline.revision.source}:${wave.baseline.revision.value}.`);
  }
  if (!verificationAdmitted(candidate.verification)) {
    return invalidation(candidate.ref, 'verification_required', `${candidate.ref} has no accepted verifier evidence for the opened wave.`);
  }
  // Name the paths. "changed surfaces outside its wave-declared surfaces" sent four
  // integration attempts hunting a baseline mismatch that did not exist, because the
  // refusal never said which path was outside.
  const outside = candidate.surfaces.filter((surface) => !isInScope(surface, participant.declaredSurfaces));
  if (outside.length) {
    return invalidation(candidate.ref, 'surface_overlap', `${candidate.ref} changed surfaces outside its wave-declared surfaces: ${outside.join(', ')}.`, outside);
  }
  return null;
}

export function assembleWave(wave: Wave, candidates: readonly WaveCandidate[]): WaveAssemblyDecision {
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const invalidated = wave.participants
    .map((participant) => participantInvalidation(wave, participant, byRef.get(participant.ref)))
    .filter((entry): entry is CandidateInvalidation => entry !== null);
  const admitted = candidates.filter((candidate) => wave.participants.some((participant) => participant.ref === candidate.ref));
  if (invalidated.length) {
    const unique = new Map(invalidated.map((entry) => [entry.ref, entry]));
    return Object.freeze({ ok: false, invalidated: Object.freeze(Array.from(unique.values()).sort((left, right) => left.ref.localeCompare(right.ref))) });
  }
  return Object.freeze({
    ok: true,
    assembly: Object.freeze({ wave, candidates: Object.freeze(admitted), state: 'assembled' }),
  });
}

export function recordAssembledWaveGate(assembly: AssembledWave, verification: VerificationResult): WaveGateResult {
  return Object.freeze({
    assembly,
    verification,
    state: verification.status === 'deferred' ? 'gate_deferred' : verificationAccepted(verification) ? 'gate_passed' : 'gate_failed',
  });
}

export function recordWaveDelivery(gate: WaveGateResult, revision: SourceRevision, verification: VerificationResult): DeliveryResult | Diagnostic {
  if (gate.state === 'gate_failed') {
    return diagnostic('assembled_wave_gate_required', 'Delivery requires a passing assembled-wave gate. Refresh the wave and reverify its candidates after fixing the gate.');
  }
  const accepted = verificationAccepted(verification);
  if (gate.state === 'gate_deferred' && !accepted) {
    return diagnostic('deferred_gate_delivery_verification_required', `The assembled-wave gate was deferred to the environment lane, so delivery requires accepted verification of the merged tree; the delivery verification returned ${verification.status}.`);
  }
  return Object.freeze({
    gate,
    revision: Object.freeze({ ...revision }),
    verification,
    state: accepted ? 'delivered' : 'delivery_failed',
  });
}

export function dependentReleaseDecision(delivery: DeliveryResult, participant: WaveParticipant): Diagnostic | null {
  if (delivery.state !== 'delivered') {
    return diagnostic('delivery_verification_required', `Dependent work for ${participant.ref} remains blocked until delivery verification passes.`);
  }
  return null;
}
