'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

const { slugForProject } = require('../lib/paths.js');
const {
  appendDecision,
  declineResupply,
  markNudged,
  markOffered,
  markResupply,
  nudgeThresholds,
  offerThresholds,
  projectStateFile,
  readProjectState,
  recordSessionTally,
  rejectedFingerprints,
  resupplyThresholds,
  statusFor,
  verifyDecisions,
} = require('../lib/state.js');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// A platform-native path: the transcript counter re-resolves the canonical project directory, and a
// Windows-literal path resolves to a different slug on Linux runners.
const PROJECT = path.resolve(os.tmpdir(), 'example-project');

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

function writeTranscript(projectDir, configDir, sessionId, modifiedAt) {
  const file = path.join(configDir, 'projects', slugForProject(projectDir), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  fs.utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
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

test('statusFor preserves the tally-only friction threshold and cooldown', () => {
  const now = Date.now();
  for (let index = 0; index < 2; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith({ denials: 3, interrupts: 1 }), environment, now - index * DAY_MS);
  }
  assert.equal(statusFor(PROJECT, environment, now).shouldNudge, true, 'friction 8 over default 6');

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

test('statusFor counts recent transcript activity without double-counting tallies', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-config-'));
  const transcriptEnvironment = { CLAUDE_CONFIG_DIR: configDir };
  const now = Date.now();

  for (let index = 0; index < 4; index += 1) {
    writeTranscript(PROJECT, configDir, `active-${index}`, now - (index + 1) * 1000);
  }

  const activeStatus = statusFor(PROJECT, transcriptEnvironment, now);
  assert.equal(activeStatus.unanalyzedSessions, 4, 'four active transcripts satisfy the session threshold without tallies');
  assert.equal(activeStatus.shouldNudge, true, 'four active transcripts satisfy the session threshold');

  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `active-${index}`, tallyWith(), transcriptEnvironment, now - (index + 1) * 1000);
  }

  const overlapStatus = statusFor(PROJECT, transcriptEnvironment, now);
  assert.equal(overlapStatus.unanalyzedSessions, 4, 'overlapping transcript and tally activity uses the larger count');

  markResupply(PROJECT, transcriptEnvironment, now);
  assert.equal(statusFor(PROJECT, transcriptEnvironment, now).unanalyzedSessions, 0, 'the reset excludes transcripts from before it');
});

test('statusFor keeps Stop offers independent from SessionStart nudges and records a decline', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `session-${index}`, tallyWith(), environment, now - DAY_MS);
  }

  markNudged(PROJECT, environment, now);
  assert.equal(statusFor(PROJECT, environment, now).shouldOffer, true, 'a fresh nudge does not suppress an offer');

  markOffered(PROJECT, 'stop-session', environment, now);
  const offeredStatus = statusFor(PROJECT, environment, now);
  assert.equal(offeredStatus.shouldOffer, false, 'the offer cooldown applies across sessions');
  assert.deepEqual(offeredStatus.offeredSessionIds, ['stop-session']);

  declineResupply(PROJECT, environment, now);
  const status = statusFor(PROJECT, environment, now);
  assert.equal(status.shouldOffer, false);
  assert.equal(status.lastDeclinedAt, new Date(now).toISOString());
});

test('strong evidence reopens an accepted resupply cooldown after its floor', () => {
  const now = Date.now();
  markResupply(PROJECT, environment, now);
  for (let index = 0; index < 8; index += 1) {
    recordSessionTally(PROJECT, `strong-${index}`, tallyWith(), environment, now + index + 1);
  }
  assert.equal(statusFor(PROJECT, environment, now + 5 * HOUR_MS).shouldOffer, true, 'eight sessions clear the default 2x escalation bar');

  const weakProject = path.join(PROJECT, 'weak-evidence');
  markResupply(weakProject, environment, now);
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(weakProject, `weak-${index}`, tallyWith(), environment, now + index + 1);
  }
  assert.equal(statusFor(weakProject, environment, now + 5 * HOUR_MS).shouldOffer, false, 'normal-threshold evidence stays inside the accepted resupply cooldown');
});

test('the resupply floor blocks an immediate second Stop offer', () => {
  const now = Date.now();
  markOffered(PROJECT, 'first-stop-session', environment, now);
  markResupply(PROJECT, environment, now + 1);
  for (let index = 0; index < 8; index += 1) {
    recordSessionTally(PROJECT, `immediate-${index}`, tallyWith(), environment, now + index + 2);
  }

  assert.equal(statusFor(PROJECT, environment, now + 3).shouldOffer, false, 'the four-hour floor wins over escalated evidence');
});

test('declines preserve evidence and increase the offer backoff', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `declined-${index}`, tallyWith(), environment, now - DAY_MS + index);
  }

  declineResupply(PROJECT, environment, now);
  let state = readProjectState(PROJECT, environment);
  assert.equal(state.lastResupplyAt, null, 'declining does not move the evidence cutoff');
  assert.equal(state.sessions.length, 4, 'declining retains the accumulated evidence');
  assert.equal(state.consecutiveDeclines, 1);
  assert.equal(statusFor(PROJECT, environment, now + HOUR_MS).shouldOffer, false, 'the first decline suppresses the base offer window');

  const secondDeclineAt = now + 24 * HOUR_MS + 1;
  assert.equal(statusFor(PROJECT, environment, secondDeclineAt).shouldOffer, true, 'the first decline backoff expires after the base window');
  declineResupply(PROJECT, environment, secondDeclineAt);
  state = readProjectState(PROJECT, environment);
  assert.equal(state.consecutiveDeclines, 2);
  assert.equal(statusFor(PROJECT, environment, secondDeclineAt + 24 * HOUR_MS).shouldOffer, false, 'the second decline doubles the backoff');
  assert.equal(statusFor(PROJECT, environment, secondDeclineAt + 48 * HOUR_MS + 1).shouldOffer, true, 'the doubled backoff eventually expires');
});

test('an accepted resupply resets decline backoff and moves the evidence cutoff', () => {
  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(PROJECT, `accepted-${index}`, tallyWith(), environment, now - DAY_MS + index);
  }
  declineResupply(PROJECT, environment, now);
  declineResupply(PROJECT, environment, now + DAY_MS);

  const acceptedAt = now + 2 * DAY_MS;
  markResupply(PROJECT, environment, acceptedAt);
  let state = readProjectState(PROJECT, environment);
  assert.equal(state.lastResupplyAt, new Date(acceptedAt).toISOString());
  assert.equal(state.lastDeclinedAt, null);
  assert.equal(state.consecutiveDeclines, 0);
  assert.equal(statusFor(PROJECT, environment, acceptedAt + 1).unanalyzedSessions, 0, 'the accepted pass moves the evidence cutoff');

  declineResupply(PROJECT, environment, acceptedAt + 2);
  state = readProjectState(PROJECT, environment);
  assert.equal(state.consecutiveDeclines, 1, 'the next decline starts at the base backoff');
});

test('the resupply cooldown has its own environment knob', () => {
  const now = Date.now();
  const projectDir = path.join(PROJECT, 'resupply-cooldown');
  markResupply(projectDir, environment, now);
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectDir, `cooldown-${index}`, tallyWith(), environment, now + index + 1);
  }

  assert.equal(statusFor(projectDir, { ...environment, QUARTERMASTER_NUDGE_HOURS: '1' }, now + 5 * HOUR_MS).shouldOffer, false, 'nudge cadence does not shorten the resupply cooldown');
  assert.equal(statusFor(projectDir, { ...environment, QUARTERMASTER_RESUPPLY_HOURS: '1' }, now + 5 * HOUR_MS).shouldOffer, true, 'the resupply cadence can be configured independently');
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

test('a rejection recorded against another project does not suppress the fingerprint here', () => {
  appendDecision({ projectDir: path.resolve(os.tmpdir(), 'other-repo'), fingerprint: 'permission:auto-allowlist-optin', status: 'rejected', title: 'elsewhere' }, environment);
  appendDecision({ fingerprint: 'rule:legacy-entry', status: 'rejected', title: 'no projectDir' }, environment);

  const scoped = rejectedFingerprints(environment, PROJECT);
  assert.equal(scoped.rejected.includes('permission:auto-allowlist-optin'), false, 'another project cannot silence this one');
  assert.equal(scoped.rejected.includes('rule:legacy-entry'), true, 'an entry predating projectDir stays global');

  assert.equal(rejectedFingerprints(environment, path.resolve(os.tmpdir(), 'other-repo')).rejected.includes('permission:auto-allowlist-optin'), true);
  assert.equal(rejectedFingerprints(environment).rejected.includes('permission:auto-allowlist-optin'), true, 'unscoped keeps the whole-ledger view');
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

test('every documented threshold variable is read under its documented name', () => {
  const documented = [
    ['QUARTERMASTER_MIN_SESSIONS', 11, () => nudgeThresholds(environment).minSessions],
    ['QUARTERMASTER_MIN_FRICTION', 13, () => nudgeThresholds(environment).minFriction],
    ['QUARTERMASTER_NUDGE_HOURS', 17, () => nudgeThresholds(environment).cooldownHours],
    ['QUARTERMASTER_OFFER_HOURS', 19, () => offerThresholds(environment).cooldownHours],
    ['QUARTERMASTER_RESUPPLY_HOURS', 23, () => resupplyThresholds(environment).cooldownHours],
    ['QUARTERMASTER_RESUPPLY_MULTIPLIER', 29, () => resupplyThresholds(environment).escalationMultiplier],
  ];

  for (const [variable, value, read] of documented) {
    const withoutOverride = read();
    environment[variable] = String(value);
    assert.notEqual(withoutOverride, value, `${variable} test value must differ from the default to prove anything`);
    assert.equal(read(), value, `${variable} is documented in README.md but state.js does not read that exact name`);
    delete environment[variable];
  }
});
