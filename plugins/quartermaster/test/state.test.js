'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const {
  appendDecision,
  markNudged,
  markRetro,
  readProjectState,
  recordSessionTally,
  rejectedFingerprints,
  statusFor,
  verifyDecisions,
} = require('../lib/state.js');

const DAY_MS = 86400000;
const PROJECT = 'C:\\dev\\example-project';

let environment;

beforeEach(() => {
  environment = {
    QUARTERMASTER_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-test-')),
  };
});

function tallyWith(overrides = {}) {
  return { prompts: 5, toolCalls: 20, toolErrors: 0, denials: 0, interrupts: 0, corrections: 0, ...overrides };
}

test('recordSessionTally persists and replaces by session id', () => {
  recordSessionTally(PROJECT, 'session-1', tallyWith({ denials: 2 }), environment);
  recordSessionTally(PROJECT, 'session-1', tallyWith({ denials: 3 }), environment);
  const state = readProjectState(PROJECT, environment);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].tally.denials, 3);
});

test('statusFor nudges on friction threshold and respects cooldown', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith({ denials: 3, interrupts: 1 }), environment, now - index * DAY_MS);
  }
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, true, 'friction 16 over default 12');

  markNudged(PROJECT, environment, now);
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, false, 'cooldown after nudge');
});

test('statusFor nudges on session count and resets after retro', () => {
  const now = Date.now();
  for (let index = 0; index < 9; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith(), environment, now - (index + 5) * DAY_MS);
  }
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, true, '9 sessions over default 8');

  markRetro(PROJECT, environment, now - 4 * DAY_MS);
  const status = statusFor(PROJECT, environment, now);
  assert.equal(status.unanalyzedSessions, 0);
  assert.equal(status.shouldNudge, false);
});

test('decisions ledger separates applied from rejected fingerprints', () => {
  appendDecision({ projectDir: PROJECT, fingerprint: 'plugin-install:context7', status: 'applied', title: 'a' }, environment);
  appendDecision({ projectDir: PROJECT, fingerprint: 'rule:no-force-push', status: 'rejected', title: 'b' }, environment);
  const { applied, rejected } = rejectedFingerprints(environment);
  assert.deepEqual(applied, ['plugin-install:context7']);
  assert.deepEqual(rejected, ['rule:no-force-push']);
});

test('verifyDecisions reports improvement against the targeted signal', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `before-${index}`, tallyWith({ denials: 4 }), environment, now - (10 - index) * DAY_MS);
  }
  const decision = appendDecision(
    { projectDir: PROJECT, fingerprint: 'permission:Bash:npm', status: 'applied', title: 'allow npm', signal: 'denials' },
    environment,
    now - 5 * DAY_MS,
  );
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `after-${index}`, tallyWith({ denials: 0 }), environment, now - (4 - index) * DAY_MS);
  }
  const results = verifyDecisions(PROJECT, environment);
  const result = results.find((entry) => entry.id === decision.id);
  assert.equal(result.verdict, 'improved');
  assert.equal(result.perSessionBefore, 4);
  assert.equal(result.perSessionAfter, 0);
});

test('verifyDecisions declines to judge on thin data', () => {
  const now = Date.now();
  recordSessionTally(PROJECT, 'only-one', tallyWith(), environment, now - DAY_MS);
  appendDecision({ projectDir: PROJECT, fingerprint: 'rule:x', status: 'applied', title: 'x' }, environment, now);
  assert.equal(verifyDecisions(PROJECT, environment)[0].verdict, 'insufficient-data');
});
