import './_temp-cleanup.js';
'use strict';

import type { Baseline } from '../src/lib/kernel/index.js';
import type { AssembledWave, DeliveryResult, Wave, WaveCandidate, WaveGateResult, WaveParticipant } from '../src/lib/kernel/wave.js';
import type { VerificationResult } from '../src/lib/kernel/verification.js';

const test = require('node:test');
const assert = require('node:assert');
const wave: typeof import('../src/lib/kernel/wave.js') = require('../lib/kernel/wave.js');

const observedAt = '2026-08-19T00:00:00.000Z';

type CandidateOptions = Readonly<{
  baseline?: Baseline;
  verification?: VerificationResult;
}>;

function baseline(source = 'git', value = 'base-1'): Baseline {
  return { revision: { source, value, observedAt }, purpose: 'wave' };
}

function participant(ref: string, declaredSurfaces: string[], dependencies: string[] = []): WaveParticipant {
  return { ref, declaredSurfaces, dependencies };
}

function candidate(ref: string, declaredSurfaces: string[], options: CandidateOptions = {}): WaveCandidate {
  return {
    ref,
    baseline: options.baseline || baseline(),
    surfaces: declaredSurfaces,
    verification: options.verification || { kind: 'command', status: 'passed', command: 'npm test', evidence: 'passed' },
  };
}

function openedWave(participants: WaveParticipant[], source = 'git', value = 'base-1'): Wave {
  const result = wave.openWave({ baseline: baseline(source, value), participants });
  if ('code' in result) throw new Error(result.message);
  return result;
}

function assembledWave(opened: Wave, candidates: WaveCandidate[]): AssembledWave {
  const result = wave.assembleWave(opened, candidates);
  if (!result.ok) throw new Error(result.invalidated.map((entry) => entry.message).join('; '));
  return result.assembly;
}

function deliveredWave(gate: WaveGateResult, verification: VerificationResult): DeliveryResult {
  const result = wave.recordWaveDelivery(gate, { source: 'git', value: 'delivery-1', observedAt }, verification);
  if ('code' in result) throw new Error(result.message);
  return result;
}

test('wave assembly names concrete recovery paths for overlapping candidates', () => {
  const opened = openedWave([
    participant('SQ-1', ['plugins/sidequest/src']),
    participant('SQ-2', ['plugins/sidequest/test']),
  ]);

  const decision = wave.assembleWave(opened, [
    candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts']),
    candidate('SQ-2', ['plugins/sidequest/src/lib/kernel/wave.ts']),
  ]);

  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error('Expected overlapping candidates to be invalidated.');
  assert.deepEqual(decision.invalidated.map((entry) => entry.ref), ['SQ-1', 'SQ-2']);
  assert.ok(decision.invalidated.every((entry) => entry.reason === 'surface_overlap'));
  assert.ok(decision.invalidated.every((entry) => entry.message.includes('Call integrate with one candidate ref')));
  assert.ok(decision.invalidated.every((entry) => !('refreshRoute' in entry)));
});

test('wave assembly invalidates a candidate when its source revision moved', () => {
  const opened = openedWave([participant('SQ-1', ['docs'])], 'document-set', 'revision-4');

  const decision = wave.assembleWave(opened, [
    candidate('SQ-1', ['docs/guide.md'], { baseline: baseline('document-set', 'revision-5') }),
  ]);

  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error('Expected a moved source revision to be invalidated.');
  assert.equal(decision.invalidated[0]?.reason, 'baseline_moved');
  assert.match(decision.invalidated[0]?.message || '', /redispatch a candidate against the current base/);
});

test('a failed assembled-wave gate blocks delivery', () => {
  const opened = openedWave([participant('SQ-1', ['plugins/sidequest/src'])]);
  const assembly = assembledWave(opened, [candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts'])]);

  const gate = wave.recordAssembledWaveGate(assembly, {
    kind: 'suite', status: 'failed_check', command: 'npm test', evidence: 'failed', failureIdentities: ['wave-gate'],
  });
  const delivery = wave.recordWaveDelivery(gate, { source: 'git', value: 'delivery-1', observedAt }, { kind: 'suite', status: 'passed', command: 'npm test', evidence: 'passed' });

  assert.equal(gate.state, 'gate_failed');
  assert.ok('code' in delivery);
  if (!('code' in delivery)) throw new Error('Expected a failed gate to block delivery.');
  assert.equal(delivery.code, 'assembled_wave_gate_required');
});

test('a delivery failure holds dependent work after an accepted assembly', () => {
  const opened = openedWave([
    participant('SQ-1', ['plugins/sidequest/src']),
    participant('SQ-2', ['plugins/sidequest/test'], ['SQ-1']),
  ]);
  const assembly = assembledWave(opened, [
    candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts']),
    candidate('SQ-2', ['plugins/sidequest/test/wave.test.ts']),
  ]);
  const gate = wave.recordAssembledWaveGate(assembly, { kind: 'suite', status: 'passed', command: 'npm test', evidence: 'passed' });
  const delivery = deliveredWave(gate, {
    kind: 'suite', status: 'failed_check', command: 'npm test', evidence: 'failed', failureIdentities: ['delivery-gate'],
  });

  assert.equal(delivery.state, 'delivery_failed');
  const blocked = wave.dependentReleaseDecision(delivery, opened.participants[1]!);
  if (!blocked) throw new Error('Expected failed delivery to keep dependent work blocked.');
  assert.equal(blocked.code, 'delivery_verification_required');
});

test('a passing delivery releases dependent work', () => {
  const opened = openedWave([
    participant('SQ-1', ['plugins/sidequest/src']),
    participant('SQ-2', ['plugins/sidequest/test'], ['SQ-1']),
  ]);
  const assembly = assembledWave(opened, [
    candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts']),
    candidate('SQ-2', ['plugins/sidequest/test/wave.test.ts']),
  ]);
  const gate = wave.recordAssembledWaveGate(assembly, { kind: 'suite', status: 'passed', command: 'npm test', evidence: 'passed' });
  const delivery = deliveredWave(gate, { kind: 'suite', status: 'passed', command: 'npm test', evidence: 'passed' });

  assert.equal(delivery.state, 'delivered');
  assert.equal(wave.dependentReleaseDecision(delivery, opened.participants[1]!), null);
});

test('a non-code artifact wave does not require process or worktree capabilities', () => {
  const opened = openedWave([participant('SQ-docs', ['docs'])], 'document-set', 'revision-4');
  const assembly = assembledWave(opened, [candidate('SQ-docs', ['docs/guide.md'], {
    baseline: baseline('document-set', 'revision-4'),
    verification: { kind: 'document', status: 'passed', evidence: 'schema and links checked' },
  })]);
  const gate = wave.recordAssembledWaveGate(assembly, { kind: 'document', status: 'passed', evidence: 'schema and links checked' });
  const delivery = deliveredWave(gate, { kind: 'attestation', status: 'attestation', evidence: 'published document set' });

  assert.equal(delivery.state, 'delivered');
});
