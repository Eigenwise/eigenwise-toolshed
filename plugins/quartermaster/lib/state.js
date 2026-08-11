'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { stateRoot } = require('./paths.js');

const MAX_TRACKED_SESSIONS = 200;
const HOUR_MS = 3600000;

const NUDGE_DEFAULTS = {
  minSessions: 8,
  minFriction: 12,
  cooldownHours: 72,
};

function nudgeThresholds(env = process.env) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    minSessions: number(env.QUARTERMASTER_MIN_SESSIONS, NUDGE_DEFAULTS.minSessions),
    minFriction: number(env.QUARTERMASTER_MIN_FRICTION, NUDGE_DEFAULTS.minFriction),
    cooldownHours: number(env.QUARTERMASTER_NUDGE_HOURS, NUDGE_DEFAULTS.cooldownHours),
  };
}

function projectKey(projectDir) {
  return crypto.createHash('sha256').update(String(projectDir).replace(/\r/g, '')).digest('hex').slice(0, 16);
}

function projectStateFile(projectDir, env = process.env) {
  return path.join(stateRoot(env), 'projects', `${projectKey(projectDir)}.json`);
}

function decisionsFile(env = process.env) {
  return path.join(stateRoot(env), 'decisions.jsonl');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function readProjectState(projectDir, env = process.env) {
  const state = readJson(projectStateFile(projectDir, env), {
    version: 1,
    projectDir: String(projectDir),
    sessions: [],
    lastResupplyAt: null,
    lastNudgeAt: null,
  });
  // State written before the skill was renamed carries lastRetroAt. Reading it forward keeps an
  // existing install's history intact, so the first run after an update does not look like a
  // project that has never been reviewed.
  if (state.lastResupplyAt === undefined) state.lastResupplyAt = state.lastRetroAt ?? null;
  delete state.lastRetroAt;
  return state;
}

function recordSessionTally(projectDir, sessionId, tally, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.sessions = state.sessions.filter((session) => session.sessionId !== sessionId);
  state.sessions.push({ sessionId, endedAt: new Date(now).toISOString(), tally });
  if (state.sessions.length > MAX_TRACKED_SESSIONS) {
    state.sessions = state.sessions.slice(-MAX_TRACKED_SESSIONS);
  }
  writeJsonAtomic(projectStateFile(projectDir, env), state);
  return state;
}

function frictionOf(tally) {
  return (tally?.denials ?? 0) + (tally?.interrupts ?? 0) + (tally?.corrections ?? 0);
}

function sessionsSince(state, isoTimestamp) {
  if (!isoTimestamp) return state.sessions;
  return state.sessions.filter((session) => session.endedAt > isoTimestamp);
}

function statusFor(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  const thresholds = nudgeThresholds(env);
  const unanalyzed = sessionsSince(state, state.lastResupplyAt);
  const friction = unanalyzed.reduce((total, session) => total + frictionOf(session.tally), 0);

  const nudgedRecently = state.lastNudgeAt && now - Date.parse(state.lastNudgeAt) < thresholds.cooldownHours * HOUR_MS;
  const resuppliedRecently = state.lastResupplyAt && now - Date.parse(state.lastResupplyAt) < thresholds.cooldownHours * HOUR_MS;
  const overThreshold = unanalyzed.length >= thresholds.minSessions || friction >= thresholds.minFriction;

  return {
    projectDir: String(projectDir),
    trackedSessions: state.sessions.length,
    unanalyzedSessions: unanalyzed.length,
    frictionEvents: friction,
    lastResupplyAt: state.lastResupplyAt,
    lastNudgeAt: state.lastNudgeAt,
    thresholds,
    shouldNudge: Boolean(overThreshold && !nudgedRecently && !resuppliedRecently),
  };
}

function markNudged(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.lastNudgeAt = new Date(now).toISOString();
  writeJsonAtomic(projectStateFile(projectDir, env), state);
}

function markResupply(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.lastResupplyAt = new Date(now).toISOString();
  writeJsonAtomic(projectStateFile(projectDir, env), state);
  return state;
}

/**
 * Every recommendation surfaced gets recorded here, applied or rejected. Rejections are the
 * important half: they are what stops the same advice from being surfaced forever.
 */
function appendDecision(decision, env = process.env, now = Date.now()) {
  const file = decisionsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    id: crypto.randomUUID(),
    at: new Date(now).toISOString(),
    ...decision,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function readDecisions(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(decisionsFile(env), 'utf8');
  } catch {
    return [];
  }
  const decisions = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      decisions.push(JSON.parse(line));
    } catch {
      // A corrupt line loses one decision, never the ledger.
    }
  }
  return decisions;
}

function rejectedFingerprints(env = process.env) {
  const rejected = new Set();
  const applied = new Set();
  for (const decision of readDecisions(env)) {
    if (!decision.fingerprint) continue;
    if (decision.status === 'rejected') rejected.add(decision.fingerprint);
    if (decision.status === 'applied') applied.add(decision.fingerprint);
  }
  return { rejected: [...rejected], applied: [...applied] };
}

/**
 * Compares per-session friction before and after each applied decision, using the tallies the
 * SessionEnd hook has been recording. This is what turns the recommendations from "plausible"
 * into "with a track record".
 */
function verifyDecisions(projectDir, env = process.env) {
  const state = readProjectState(projectDir, env);
  const results = [];
  for (const decision of readDecisions(env)) {
    if (decision.status !== 'applied') continue;
    if (decision.projectDir && decision.projectDir !== String(projectDir)) continue;
    const signal = decision.signal && decision.signal !== 'any' ? decision.signal : null;
    const valueOf = (tally) => (signal ? tally?.[signal] ?? 0 : frictionOf(tally));
    const before = state.sessions.filter((session) => session.endedAt <= decision.at);
    const after = state.sessions.filter((session) => session.endedAt > decision.at);
    if (before.length < 3 || after.length < 3) {
      results.push({ id: decision.id, title: decision.title, fingerprint: decision.fingerprint, verdict: 'insufficient-data', sessionsBefore: before.length, sessionsAfter: after.length });
      continue;
    }
    const mean = (sessions) => sessions.reduce((total, session) => total + valueOf(session.tally), 0) / sessions.length;
    const beforeRate = mean(before);
    const afterRate = mean(after);
    const verdict = afterRate < beforeRate * 0.7 ? 'improved' : afterRate > beforeRate * 1.3 ? 'worse' : 'flat';
    results.push({
      id: decision.id,
      title: decision.title,
      fingerprint: decision.fingerprint,
      signal: signal ?? 'friction',
      perSessionBefore: Number(beforeRate.toFixed(2)),
      perSessionAfter: Number(afterRate.toFixed(2)),
      sessionsBefore: before.length,
      sessionsAfter: after.length,
      verdict,
    });
  }
  return results;
}

module.exports = {
  appendDecision,
  decisionsFile,
  frictionOf,
  markNudged,
  markResupply,
  nudgeThresholds,
  projectStateFile,
  readDecisions,
  readProjectState,
  recordSessionTally,
  rejectedFingerprints,
  statusFor,
  verifyDecisions,
};
