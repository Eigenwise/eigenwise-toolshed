import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

import type { Baseline } from '../src/lib/kernel/index.js';
import type { AssembledWave, DeliveryResult, Wave, WaveCandidate, WaveGateResult, WaveParticipant } from '../src/lib/kernel/wave.js';
import type { VerificationResult } from '../src/lib/kernel/verification.js';

const test = require('node:test');
const assert = require('node:assert');
const wave: typeof import('../src/lib/kernel/wave.js') = require('../lib/kernel/wave.js');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');

const observedAt = '2026-08-19T00:00:00.000Z';

function git(repository: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function branchOverlapProject(): { repository: string; slug: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wave-target-'));
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repository, 'shared.txt'), 'top\n1\n2\n3\n4\n5\n6\n7\n8\n9\nbottom\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'base']);
  git(repository, ['branch', 'story-a']);
  git(repository, ['branch', 'story-b']);
  const { slug } = store.ensureProject(repository);
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: 'main' });
  const category = store.getCategory('codebase-exploration');
  store.setCategory({ ...category, route: { model: 'sonnet', effort: 'medium' }, fallback: null });
  return { repository, slug };
}

// GH-643: a ticket with no verifier at all fails the gate, so these candidates carry document evidence the gate accepts as supplied.
const OVERLAP_FIXTURE_EVIDENCE = 'overlap fixture reviewed by hand';

function submitBranchOverlapCandidate(repository: string, slug: string, branch: string, label: string, body = `${label}\n`): string {
  git(repository, ['checkout', branch]);
  const ticket = store.createTicket(slug, {
    title: `overlapping ${label} candidate`, category: 'codebase-exploration',
    description: 'Exercise recorded branch isolation for overlapping candidates.', files: ['shared.txt'],
    executorVerifyKind: 'document', executorVerify: OVERLAP_FIXTURE_EVIDENCE,
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, integrationMode: 'local', integrationBranch: branch });
  assert.equal(prepared.ticket.dispatch.integrationTarget.branch, branch);
  assert.equal(store.claimTicket(slug, ticket.ref, label, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  git(repository, ['checkout', '-b', `candidate-${label}`, branch]);
  fs.writeFileSync(path.join(repository, 'shared.txt'), body);
  git(repository, ['add', 'shared.txt']);
  git(repository, ['commit', '-m', label]);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(repository, ['update-ref', gitRef, commit]);
  const range = commitScope.submissionRange(repository, { commit, gitRef, upstream: branch, integrationBranch: branch });
  assert.equal(range.ok, true, JSON.stringify(range));
  const submitted = store.submitTicket(slug, ticket.ref, label, { commit, gitRef, range, worktree: repository, verify: OVERLAP_FIXTURE_EVIDENCE });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  return ticket.ref;
}

for (const siblingBranch of ['story-a', 'story-b']) {
  test(`GH-630: pending overlap on ${siblingBranch} respects the story-a wave target`, () => {
    const { repository, slug } = branchOverlapProject();
    const participantRef = submitBranchOverlapCandidate(repository, slug, 'story-a', 'participant');
    const siblingRef = submitBranchOverlapCandidate(repository, slug, siblingBranch, 'sibling');
    const assembled = store.assembleSubmissionWave(slug, [participantRef], {
      verification: store.getTicket(slug, participantRef).submission.verificationResult,
    });
    if (siblingBranch === 'story-b') {
      assert.equal(assembled.ok, true, JSON.stringify(assembled));
      assert.deepEqual(assembled.wave.participants, [participantRef]);
    } else {
      assert.equal(assembled.reason, 'candidate_overlap');
      assert.deepEqual(assembled.conflicts.map(({ evidence, ...conflict }: { evidence: string }) => conflict), [{ participant: participantRef, sibling: siblingRef, surfaces: ['shared.txt'] }]);
      assert.match(assembled.conflicts[0].evidence, /CONFLICT.*shared.txt/);
      assert.match(assembled.message, /Wave assembly paused because submitted candidates overlap/);
    }
  });
}

test('SQ-3911: disjoint regions of one shared document integrate as singletons', () => {
  const { repository, slug } = branchOverlapProject();
  const participantRef = submitBranchOverlapCandidate(repository, slug, 'story-a', 'top-edit', 'changed top\n1\n2\n3\n4\n5\n6\n7\n8\n9\nbottom\n');
  const siblingRef = submitBranchOverlapCandidate(repository, slug, 'story-a', 'bottom-edit', 'top\n1\n2\n3\n4\n5\n6\n7\n8\n9\nchanged bottom\n');
  const assembled = store.assembleSubmissionWave(slug, [participantRef], { verification: store.getTicket(slug, participantRef).submission.verificationResult });
  assert.equal(assembled.ok, true, JSON.stringify(assembled));
  git(repository, ['checkout', 'story-a']);
  const delivered = store.integrateSubmission(slug, participantRef, { mode: 'merge', verification: store.getTicket(slug, participantRef).submission.verificationResult });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  const siblingDelivery = store.integrateSubmission(slug, siblingRef, { mode: 'merge', verification: store.getTicket(slug, siblingRef).submission.verificationResult });
  assert.equal(siblingDelivery.ok, true, JSON.stringify(siblingDelivery));
  assert.match(fs.readFileSync(path.join(repository, 'shared.txt'), 'utf8'), /^changed top[\s\S]*changed bottom\n$/);
});

function setWaveCommandFixture(slug: string, ref: string, verifyCwd: string): void {
  const ticket = store.getTicket(slug, ref);
  const command = 'node -e "require(\'node:assert\').equal(require(\'node:fs\').readFileSync(\'directory.txt\', \'utf8\'), \'ready\')"';
  ticket.executorVerifyCwd = verifyCwd;
  ticket.dispatch.verificationRequirement = { kind: 'command', command, evidenceContract: command };
  const database = require('../lib/db.js');
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status, archived: 0,
    ord: ticket.order, claim_by: null, data: ticket,
  });
}

for (const missingDirectory of [false, true]) {
  test(`SQ-3994: wave verifiers use participant directories and record cwd (missing=${missingDirectory})`, () => {
    const { repository, slug } = branchOverlapProject();
    git(repository, ['checkout', 'story-a']);
    fs.mkdirSync(path.join(repository, 'first'));
    fs.writeFileSync(path.join(repository, 'first', 'directory.txt'), 'ready');
    if (!missingDirectory) {
      fs.mkdirSync(path.join(repository, 'second'));
      fs.writeFileSync(path.join(repository, 'second', 'directory.txt'), 'ready');
    }
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'verification directories']);
    const first = submitBranchOverlapCandidate(repository, slug, 'story-a', 'first-worker', 'changed top\n1\n2\n3\n4\n5\n6\n7\n8\n9\nbottom\n');
    const second = submitBranchOverlapCandidate(repository, slug, 'story-a', 'second-worker', 'top\n1\n2\n3\n4\n5\n6\n7\n8\n9\nchanged bottom\n');
    setWaveCommandFixture(slug, first, 'first');
    setWaveCommandFixture(slug, second, 'second');
    const assembled = store.assembleSubmissionWave(slug, [first, second]);
    const results = assembled.gate.verification.results;
    assert.equal(results.length, 2, 'identical commands in different directories both run');
    assert.equal(results[0].status, 'passed', JSON.stringify(assembled));
    assert.equal(path.basename(results[0].cwd), 'first');
    assert.equal(path.basename(results[1].cwd), 'second');
    assert.equal(path.dirname(results[0].cwd), path.dirname(results[1].cwd));
    if (missingDirectory) {
      assert.equal(results[1].status, 'could_not_run');
      assert.equal(results[1].evidence, `verify_cwd_missing: ${results[1].cwd}`);
      assert.deepEqual(results[1].failureIdentities, [`verify_cwd_missing: ${results[1].cwd}`]);
    } else {
      assert.equal(assembled.ok, true, JSON.stringify(assembled));
      assert.equal(results[1].status, 'passed');
    }
  });
}

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

test('wave assembly admits overlapping candidates so the delivery merge decides whether they conflict', () => {
  const opened = openedWave([
    participant('SQ-1', ['plugins/sidequest/src']),
    participant('SQ-2', ['plugins/sidequest/src']),
  ]);

  const decision = wave.assembleWave(opened, [
    candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts']),
    candidate('SQ-2', ['plugins/sidequest/src/lib/kernel/wave.ts']),
  ]);

  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error('Expected same-file candidates to remain available for the delivery merge.');
  assert.deepEqual(decision.assembly.candidates.map((entry) => entry.ref), ['SQ-1', 'SQ-2']);
});

test('wave assembly invalidates a candidate when its source revision moved', () => {
  const opened = openedWave([participant('SQ-1', ['docs'])], 'document-set', 'revision-4');

  const decision = wave.assembleWave(opened, [
    candidate('SQ-1', ['docs/guide.md'], { baseline: baseline('document-set', 'revision-5') }),
  ]);

  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error('Expected a moved source revision to be invalidated.');
  assert.equal(decision.invalidated[0]?.reason, 'baseline_moved');
  assert.match(decision.invalidated[0]?.message || '', /baseline is no longer reachable from the wave target/);
  assert.match(decision.invalidated[0]?.message || '', /manually merge the verified candidate onto the current target, re-gate it/);
  assert.match(decision.invalidated[0]?.message || '', /groomClose using deliveryCommit/);
});

test('GH-156: a fragment-only candidate on the wave baseline assembles', () => {
  const opened = openedWave([participant('SQ-1', ['docs/report.md', '.release/unreleased/SQ-1.md'])]);

  const decision = wave.assembleWave(opened, [candidate('SQ-1', ['.release/unreleased/SQ-1.md'])]);

  assert.equal(decision.ok, true);
});

test('SQ-16: a surface_overlap invalidation names every path outside the wave surface', () => {
  const opened = openedWave([participant('SQ-1', ['plugins/sidequest/src'])]);

  const decision = wave.assembleWave(opened, [
    candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts', '.release/unreleased/SQ-1.md', 'vitest.config.ts']),
  ]);

  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error('Expected surfaces outside the wave surface to be invalidated.');
  assert.equal(decision.invalidated[0]?.reason, 'surface_overlap');
  assert.deepEqual(decision.invalidated[0]?.outside, ['.release/unreleased/SQ-1.md', 'vitest.config.ts']);
  assert.equal(decision.invalidated[0]?.detail, 'SQ-1 changed surfaces outside its wave-declared surfaces: .release/unreleased/SQ-1.md, vitest.config.ts.');
  assert.match(decision.invalidated[0]?.message || '', /Candidate submissions remain available/);
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

// SQ-3424: a deferred candidate assembles and records gate_deferred, and delivery takes that gate only
// with an accepted delivery verification: the pinned command runs once, in the shared checkout.
test('SQ-3424: a deferred candidate assembles into a gate_deferred wave that delivers only on accepted verification', () => {
  const deferred: VerificationResult = { kind: 'command', status: 'deferred', command: 'npm test', evidence: 'Deferred to the environment lane: npm test runs in the shared checkout at delivery, against the merged tree.' };
  const opened = openedWave([participant('SQ-1', ['plugins/sidequest/src'])]);
  const assembly = assembledWave(opened, [candidate('SQ-1', ['plugins/sidequest/src/lib/kernel/wave.ts'], { verification: deferred })]);
  const gate = wave.recordAssembledWaveGate(assembly, deferred);
  assert.equal(gate.state, 'gate_deferred');

  const refused = wave.recordWaveDelivery(gate, { source: 'git', value: 'delivery-1', observedAt }, { kind: 'command', status: 'failed_suite', command: 'npm test', evidence: 'failed', failureIdentities: ['delivery-gate'] });
  assert.ok('code' in refused);
  if (!('code' in refused)) throw new Error('Expected a deferred gate to refuse delivery without accepted verification.');
  assert.equal(refused.code, 'deferred_gate_delivery_verification_required');
  assert.match(refused.message, /delivery verification returned failed_suite/);

  const stillDeferred = wave.recordWaveDelivery(gate, { source: 'git', value: 'delivery-1', observedAt }, deferred);
  assert.ok('code' in stillDeferred);

  const delivered = deliveredWave(gate, { kind: 'command', status: 'passed', command: 'npm test', evidence: 'passed' });
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.gate.state, 'gate_deferred');
});
