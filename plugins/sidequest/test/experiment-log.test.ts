import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-experiment-log-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-experiment-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-experiment-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  updatedAt: new Date().toISOString(),
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;

const store = require('../lib/store.js');
const { slug } = store.ensureProject(PROJECT_DIR);

function ticket() {
  return store.createTicket(slug, {
    title: 'Experiment log fixture',
    description: 'Where: fixture. Contract: persist one experiment round. Verify: inspect the experiment asset.',
    category: 'coding.normal',
    files: ['fixture.ts'],
  });
}

function round(round: number, overrides: any = {}) {
  return Object.assign({
    round,
    date: `2026-07-${String(round).padStart(2, '0')}`,
    headline: `round ${round}`,
    hypothesis: `hypothesis ${round}`,
    change: `change ${round}`,
    commit: `commit${round}`,
    branch: 'sidequest/experiment/SQ-fixture',
    measured: `baseline ${round - 1}, result ${round}`,
    deliverable: `out/${round}.wav`,
    verdict: `verdict ${round}`,
    outcome: 'rejected',
    whyItFailed: `mechanism ${round}`,
    constraintBought: `constraint ${round}`,
    status: `DO-NOT-MERGE commit${round}`,
  }, overrides);
}

test('appendExperimentEntry creates the ticket asset with the full round schema and pinned sections', () => {
  const created = ticket();
  const appended = store.appendExperimentEntry(slug, created.ref, round(1, {
    ruledOut: [{ line: 'threshold tuning', why: 'the rank stayed inverted' }],
    standingConstraints: [{ line: 'rank C above B', boughtBy: 1 }],
  }));

  assert.equal(appended.ok, true);
  assert.equal(appended.asset, `experiment-${created.ref}.md`);
  const asset = store.assetPath(slug, created.id, appended.asset);
  const log = fs.readFileSync(asset, 'utf8');
  assert.match(log, /^## Ruled out\n- threshold tuning — the rank stayed inverted\n## Standing constraints\n- \[R1\] rank C above B/m);
  assert.match(log, /## R1 — 2026-07-01 — round 1/);
  assert.match(log, /Hypothesis: hypothesis 1/);
  assert.match(log, /Change: change 1 \(commit commit1, branch sidequest\/experiment\/SQ-fixture\)/);
  assert.match(log, /Measured: baseline 0, result 1/);
  assert.match(log, /Deliverable: out\/1.wav/);
  assert.match(log, /Verdict: "verdict 1" — rejected/);
  assert.match(log, /Why it failed: mechanism 1/);
  assert.match(log, /Constraint bought: constraint 1/);
  assert.match(log, /Status: DO-NOT-MERGE commit1/);
  assert.ok(store.getTicket(slug, created.ref).assets.includes(appended.asset));
});

test('entries are append-only and an overturned entry gets one structural line', () => {
  const created = ticket();
  assert.equal(store.appendExperimentEntry(slug, created.ref, round(1)).ok, true);
  assert.equal(store.appendExperimentEntry(slug, created.ref, round(2)).ok, true);
  assert.equal(store.appendExperimentEntry(slug, created.ref, round(1, { headline: 'replacement' })).reason, 'round_exists');

  const overturned = store.appendOverturnLine(slug, created.ref, 1, 2, 'the ranking was measured backward');
  assert.equal(overturned.ok, true);
  assert.equal(store.appendOverturnLine(slug, created.ref, 1, 3, 'another correction').reason, 'already_overturned');
  const log = fs.readFileSync(store.assetPath(slug, created.id, overturned.asset), 'utf8');
  assert.match(log, /Status: DO-NOT-MERGE commit1\n> Overturned by R2: the ranking was measured backward\n## R2/m);
});

test('applyExperimentVerdict preserves the user words, clears the oracle, and records a constraint', () => {
  const created = ticket();
  assert.equal(store.appendExperimentEntry(slug, created.ref, round(1, {
    verdict: '',
    outcome: '',
    whyItFailed: '',
    constraintBought: '',
    status: '',
  })).ok, true);
  const prepared = store.prepareDispatch(slug, created.ref, { sessionId: `experiment-verdict-${Date.now()}` });
  assert.equal(store.claimTicket(slug, created.ref, 'experiment-verdict-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, created.ref, 'experiment-verdict-worker', {
    releaseKind: 'oracle',
    oracle: 'Rank the candidates.',
    candidate: 'abc1234',
  }).ok, true);

  const text = 'The attack is still too sharp.\nKeep row B above row C.';
  const verdict = store.applyExperimentVerdict(slug, created.ref, {
    text,
    outcome: 'rejected',
    why: 'The onset transient dominates the comparison.',
    constraint: 'Rank row B above row C.',
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.round, 1);
  const stored = store.getTicket(slug, created.ref);
  assert.equal(stored.oracle.verdict.text, text);
  const log = fs.readFileSync(store.assetPath(slug, created.id, verdict.asset), 'utf8');
  assert.match(log, /Verdict: "The attack is still too sharp\.\nKeep row B above row C\." — rejected/);
  assert.match(log, /Why it failed: The onset transient dominates the comparison\./);
  assert.match(log, /Constraint bought: Rank row B above row C\./);
  assert.match(log, /Status: DO-NOT-MERGE abc1234/);
  assert.match(log, /## Standing constraints\n- \[R1\] Rank row B above row C\./);

  const refused = store.applyExperimentVerdict(slug, created.ref, { text: 'again', outcome: 'accepted' });
  assert.equal(refused.reason, 'no_oracle');
  assert.match(refused.message, /not awaiting an oracle verdict/i);
});

test('applyExperimentVerdict creates a missing oracle round and preserves existing rounds', () => {
  const created = ticket();
  assert.equal(store.appendExperimentEntry(slug, created.ref, round(2)).ok, true);
  const prepared = store.prepareDispatch(slug, created.ref, { sessionId: `missing-oracle-round-${Date.now()}` });
  assert.equal(store.claimTicket(slug, created.ref, 'missing-oracle-round-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, created.ref, 'missing-oracle-round-worker', {
    releaseKind: 'oracle',
    oracle: 'Rank the candidates.',
    candidate: 'abc1234',
    deliverable: 'artifacts/comparison.wav',
  }).ok, true);

  const released = fs.readFileSync(store.assetPath(slug, created.id, `experiment-${created.ref}.md`), 'utf8');
  assert.match(released, /## R1 — \d{4}-\d{2}-\d{2} — Oracle verdict/);
  assert.match(released, /Hypothesis: Rank the candidates\./);
  assert.match(released, /Deliverable: artifacts\/comparison\.wav/);

  const verdict = store.applyExperimentVerdict(slug, created.ref, {
    text: 'Candidate B wins.',
    outcome: 'accepted',
    why: 'The transient is less sharp.',
    constraint: 'Keep the transient below the reference.',
  });

  assert.equal(verdict.ok, true);
  assert.equal(store.getTicket(slug, created.ref).oracle.verdict.text, 'Candidate B wins.');
  const log = fs.readFileSync(store.assetPath(slug, created.id, verdict.asset), 'utf8');
  assert.match(log, /## R1 — \d{4}-\d{2}-\d{2} — Oracle verdict/);
  assert.match(log, /Hypothesis: Rank the candidates\./);
  assert.match(log, /Deliverable: artifacts\/comparison\.wav/);
  assert.match(log, /Verdict: "Candidate B wins\." — accepted/);
  assert.match(log, /## R2 — 2026-07-02 — round 2/);
});

test('experimentPacket retains every pinned section and round', () => {
  const created = ticket();
  for (let index = 1; index <= 7; index++) {
    assert.equal(store.appendExperimentEntry(slug, created.ref, round(index, {
      headline: `round ${index} ${index <= 4 ? 'x'.repeat(3_500) : ''}`,
      ruledOut: index === 1 ? [{ line: 'old metric', why: 'it never ranked the ear result' }] : undefined,
      standingConstraints: index === 1 ? [{ line: 'blind ranking only', boughtBy: 1 }] : undefined,
    })).ok, true);
  }

  const projection = store.experimentPacket(slug, created.ref);
  assert.equal(projection.path, store.assetPath(slug, created.id, projection.asset));
  assert.ok(Buffer.byteLength(projection.packet, 'utf8') > 12 * 1024);
  assert.match(projection.packet, /## Ruled out\n- old metric — it never ranked the ear result/);
  assert.match(projection.packet, /## Standing constraints\n- \[R1\] blind ranking only/);
  for (let index = 1; index <= 7; index++) assert.match(projection.packet, new RegExp(`## R${index} — 2026-07-0${index}`));
});
