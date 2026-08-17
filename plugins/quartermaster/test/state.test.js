'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const {
  appendDecision,
  markNudged,
  markResupply,
  projectStateFile,
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

function alternateProjectSpelling(projectDir) {
  return process.platform === 'win32' ? projectDir.replace(/\\/g, '/') : `${projectDir}${path.sep}`;
}

function legacyProjectStateFile(projectDir) {
  const legacyKey = crypto.createHash('sha256').update(String(projectDir).replace(/\r/g, '')).digest('hex').slice(0, 16);
  return path.join(environment.QUARTERMASTER_STATE_DIR, 'projects', `${legacyKey}.json`);
}

test('recordSessionTally persists and replaces by session id', () => {
  recordSessionTally(PROJECT, 'session-1', tallyWith({ denials: 2 }), environment);
  recordSessionTally(PROJECT, 'session-1', tallyWith({ denials: 3 }), environment);
  const state = readProjectState(PROJECT, environment);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].tally.denials, 3);
});

test('path spellings share one project state for reads and writes', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-test-'));
  const alternateDir = alternateProjectSpelling(projectDir);

  recordSessionTally(projectDir, 'session-1', tallyWith({ denials: 2 }), environment);
  markNudged(alternateDir, environment);

  const state = readProjectState(projectDir, environment);
  assert.equal(state.sessions.length, 1, 'read through the original spelling finds the alternate spelling write');
  assert.ok(state.lastNudgeAt, 'write through the alternate spelling updates the shared state');
  assert.equal(projectStateFile(projectDir, environment), projectStateFile(alternateDir, environment));
});

test('a legacy raw-keyed state migrates to the canonical project key', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-test-'));
  const legacySpelling = alternateProjectSpelling(projectDir);
  const legacyFile = legacyProjectStateFile(legacySpelling);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    projectDir: legacySpelling,
    sessions: [{ sessionId: 'legacy-session', endedAt: new Date().toISOString(), tally: tallyWith({ denials: 2 }) }],
    lastResupplyAt: null,
    lastNudgeAt: null,
  }), 'utf8');

  const state = readProjectState(projectDir, environment);
  const canonicalFile = projectStateFile(projectDir, environment);
  const stored = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));

  assert.equal(state.sessions[0].sessionId, 'legacy-session');
  assert.equal(fs.existsSync(legacyFile), false, 'legacy file is removed after migration');
  assert.equal(stored.projectDir, state.projectDir, 'canonical state stores the canonical project directory');
});

test('statusFor nudges on friction threshold and respects cooldown', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith({ denials: 3, interrupts: 1 }), environment, now - index * DAY_MS);
  }
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, true, 'friction 16 over default 6');

  markNudged(PROJECT, environment, now);
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, false, 'cooldown after nudge');
});

test('statusFor nudges on session count and resets after a resupply pass', () => {
  const now = Date.now();
  for (let index = 0; index < 9; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith(), environment, now - (index + 5) * DAY_MS);
  }
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, true, '9 sessions over default 4');

  markResupply(PROJECT, environment, now - 4 * DAY_MS);
  const status = statusFor(PROJECT, environment, now);
  assert.equal(status.unanalyzedSessions, 0);
  assert.equal(status.shouldNudge, false);
});

test('state written before the rename keeps its history under the new key', () => {
  const now = Date.now();
  for (let index = 0; index < 9; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith(), environment, now - (index + 5) * DAY_MS);
  }
  // Simulate an install that last ran a pass under the old spelling.
  const file = projectStateFile(PROJECT, environment);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete onDisk.lastResupplyAt;
  onDisk.lastRetroAt = new Date(now - 4 * DAY_MS).toISOString();
  fs.writeFileSync(file, JSON.stringify(onDisk), 'utf8');

  const status = statusFor(PROJECT, environment, now);
  assert.equal(status.lastResupplyAt, onDisk.lastRetroAt, 'old key is read forward');
  assert.equal(status.unanalyzedSessions, 0, 'sessions before the old pass are still counted as reviewed');
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

test('verifyDecisions matches decisions recorded through another path spelling', () => {
  const now = Date.now();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-project-test-'));
  const alternateDir = alternateProjectSpelling(projectDir);
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `before-${index}`, tallyWith({ denials: 4 }), environment, now - (10 - index) * DAY_MS);
  }
  const decision = appendDecision(
    { projectDir: alternateDir, fingerprint: 'permission:Bash:npm', status: 'applied', title: 'allow npm', signal: 'denials' },
    environment,
    now - 5 * DAY_MS,
  );
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `after-${index}`, tallyWith({ denials: 0 }), environment, now - (4 - index) * DAY_MS);
  }

  const result = verifyDecisions(projectDir, environment).find((entry) => entry.id === decision.id);
  assert.equal(result.verdict, 'improved', 'decision recorded under another spelling verifies against this project state');
});

test('verifyDecisions declines to judge on thin data', () => {
  const now = Date.now();
  recordSessionTally(PROJECT, 'only-one', tallyWith(), environment, now - DAY_MS);
  appendDecision({ projectDir: PROJECT, fingerprint: 'rule:x', status: 'applied', title: 'x' }, environment, now);
  assert.equal(verifyDecisions(PROJECT, environment)[0].verdict, 'insufficient-data');
});
