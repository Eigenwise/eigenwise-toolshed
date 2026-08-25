'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { stateRoot } = require('./paths.js');

const MAX_TRACKED_SESSIONS = 200;
const HOUR_MS = 3600000;

const NUDGE_DEFAULTS = {
  minSessions: 4,
  minFriction: 6,
  cooldownHours: 24,
};

const OFFER_DEFAULTS = {
  cooldownHours: 24,
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

function offerThresholds(env = process.env) {
  const parsed = Number(env.QUARTERMASTER_OFFER_HOURS);
  return {
    cooldownHours: Number.isFinite(parsed) && parsed > 0 ? parsed : OFFER_DEFAULTS.cooldownHours,
  };
}

function canonicalProjectDir(projectDir) {
  const resolved = path.resolve(String(projectDir).replace(/\r/g, ''));
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // A project can be configured before its directory exists.
  }
  canonical = canonical.replace(/\\/g, '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function projectKey(projectDir) {
  return crypto.createHash('sha256').update(canonicalProjectDir(projectDir)).digest('hex').slice(0, 16);
}

function projectStateDirectory(env = process.env) {
  return path.join(stateRoot(env), 'projects');
}

function projectStateFileForKey(key, env = process.env) {
  return path.join(projectStateDirectory(env), `${key}.json`);
}

function projectStateFile(projectDir, env = process.env) {
  return projectStateFileForKey(projectKey(projectDir), env);
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

function emptyProjectState(projectDir) {
  return {
    version: 1,
    projectDir,
    sessions: [],
    lastResupplyAt: null,
    lastNudgeAt: null,
    lastOfferAt: null,
    lastOfferSessionId: null,
    offeredSessionIds: [],
    lastDeclinedAt: null,
  };
}

function latestTimestamp(first, second) {
  if (!first) return second ?? null;
  if (!second) return first;
  return Date.parse(second) > Date.parse(first) ? second : first;
}

function mergeProjectStates(projectDir, legacyStates) {
  const merged = emptyProjectState(projectDir);
  const sessionsById = new Map();

  for (const state of legacyStates) {
    const previousResupplyAt = merged.lastResupplyAt;
    const previousNudgeAt = merged.lastNudgeAt;
    Object.assign(merged, state);
    merged.lastResupplyAt = latestTimestamp(previousResupplyAt, state.lastResupplyAt ?? state.lastRetroAt);
    merged.lastNudgeAt = latestTimestamp(previousNudgeAt, state.lastNudgeAt);
    for (const session of state.sessions ?? []) {
      if (!session || typeof session !== 'object' || !session.sessionId) continue;
      const existing = sessionsById.get(session.sessionId);
      if (!existing || Date.parse(session.endedAt) >= Date.parse(existing.endedAt)) {
        sessionsById.set(session.sessionId, session);
      }
    }
  }

  merged.projectDir = projectDir;
  merged.sessions = [...sessionsById.values()].sort((first, second) => first.endedAt.localeCompare(second.endedAt));
  delete merged.lastRetroAt;
  return merged;
}

function migrateLegacyProjectState(projectDir, env = process.env) {
  const directory = projectStateDirectory(env);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return emptyProjectState(projectDir);
  }

  const legacyFiles = [];
  const legacyStates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    const state = readJson(file, null);
    if (!state || typeof state.projectDir !== 'string') continue;
    if (canonicalProjectDir(state.projectDir) !== projectDir) continue;
    legacyFiles.push(file);
    legacyStates.push(state);
  }

  if (!legacyStates.length) return emptyProjectState(projectDir);

  const migrated = mergeProjectStates(projectDir, legacyStates);
  writeJsonAtomic(projectStateFile(projectDir, env), migrated);
  for (const file of legacyFiles) fs.rmSync(file, { force: true });
  return migrated;
}

function readProjectState(projectDir, env = process.env) {
  const canonicalDir = canonicalProjectDir(projectDir);
  const file = projectStateFile(canonicalDir, env);
  const state = fs.existsSync(file)
    ? readJson(file, emptyProjectState(canonicalDir))
    : migrateLegacyProjectState(canonicalDir, env);
  state.projectDir = canonicalDir;
  if (state.lastResupplyAt === undefined) state.lastResupplyAt = state.lastRetroAt ?? null;
  if (state.lastNudgeAt === undefined) state.lastNudgeAt = null;
  if (state.lastOfferAt === undefined) state.lastOfferAt = null;
  if (state.lastOfferSessionId === undefined) state.lastOfferSessionId = null;
  if (!Array.isArray(state.offeredSessionIds)) {
    state.offeredSessionIds = state.lastOfferSessionId ? [state.lastOfferSessionId] : [];
  }
  if (state.lastDeclinedAt === undefined) state.lastDeclinedAt = null;
  if (!Array.isArray(state.sessions)) state.sessions = [];
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
  const offer = offerThresholds(env);
  const unanalyzed = sessionsSince(state, state.lastResupplyAt);
  const friction = unanalyzed.reduce((total, session) => total + frictionOf(session.tally), 0);

  const nudgedRecently = state.lastNudgeAt && now - Date.parse(state.lastNudgeAt) < thresholds.cooldownHours * HOUR_MS;
  const resuppliedRecently = state.lastResupplyAt && now - Date.parse(state.lastResupplyAt) < thresholds.cooldownHours * HOUR_MS;
  const offerRecently = state.lastOfferAt && now - Date.parse(state.lastOfferAt) < offer.cooldownHours * HOUR_MS;
  const overThreshold = unanalyzed.length >= thresholds.minSessions || friction >= thresholds.minFriction;
  const resupplyDue = Boolean(overThreshold && !resuppliedRecently);

  return {
    projectDir: state.projectDir,
    trackedSessions: state.sessions.length,
    unanalyzedSessions: unanalyzed.length,
    frictionEvents: friction,
    lastResupplyAt: state.lastResupplyAt,
    lastNudgeAt: state.lastNudgeAt,
    lastOfferAt: state.lastOfferAt,
    lastOfferSessionId: state.lastOfferSessionId,
    offeredSessionIds: state.offeredSessionIds,
    lastDeclinedAt: state.lastDeclinedAt,
    thresholds,
    offer,
    shouldNudge: Boolean(resupplyDue && !nudgedRecently),
    shouldOffer: Boolean(resupplyDue && !offerRecently),
  };
}

function markNudged(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.lastNudgeAt = new Date(now).toISOString();
  writeJsonAtomic(projectStateFile(projectDir, env), state);
}

function markOffered(projectDir, sessionId, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.lastOfferAt = new Date(now).toISOString();
  state.lastOfferSessionId = sessionId;
  state.offeredSessionIds = [...new Set([...state.offeredSessionIds, sessionId])].slice(-MAX_TRACKED_SESSIONS);
  writeJsonAtomic(projectStateFile(projectDir, env), state);
  return state;
}

function markResupply(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  state.lastResupplyAt = new Date(now).toISOString();
  state.lastDeclinedAt = null;
  writeJsonAtomic(projectStateFile(projectDir, env), state);
  return state;
}

function declineResupply(projectDir, env = process.env, now = Date.now()) {
  const state = readProjectState(projectDir, env);
  const timestamp = new Date(now).toISOString();
  state.lastResupplyAt = timestamp;
  state.lastDeclinedAt = timestamp;
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
  const canonicalDir = canonicalProjectDir(projectDir);
  const results = [];
  for (const decision of readDecisions(env)) {
    if (decision.status !== 'applied') continue;
    if (decision.projectDir && canonicalProjectDir(decision.projectDir) !== canonicalDir) continue;
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
  declineResupply,
  frictionOf,
  markNudged,
  markOffered,
  markResupply,
  nudgeThresholds,
  offerThresholds,
  projectStateFile,
  readDecisions,
  readProjectState,
  recordSessionTally,
  rejectedFingerprints,
  statusFor,
  verifyDecisions,
};
