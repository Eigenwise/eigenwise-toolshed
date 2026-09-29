'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { CODEX_UPSTREAM_BLOCK_PATH, STATE } = require('./runtime.js');

const CODEX_UPSTREAM_UNAVAILABLE_PATH = path.join(STATE, 'codex-upstream-unavailable.json');
const UPSTREAM_UNAVAILABLE_TTL_MS = 60_000;
// A 429 names its own end: Retry-After, or the reset instant claude-code-proxy copies from a
// ChatGPT usage limit. Without either the block still has to lift by itself (issue #190).
const RATE_LIMIT_BLOCK_DEFAULT_MS = 60_000;

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function removeFile(file) {
  try { fs.rmSync(file); } catch { /* absent */ }
}

function writeState(file, state) {
  fs.mkdirSync(STATE, { recursive: true });
  writeFileAtomically(file, JSON.stringify(state) + '\n', { mode: 0o600 });
  return state;
}

function readUpstreamBlocked(now = Date.now()) {
  const blocked = readJsonFile(CODEX_UPSTREAM_BLOCK_PATH);
  if (blocked?.state !== 'upstream-blocked') return null;
  return now >= blocked.expiresAtMs ? null : blocked;
}

function retryAfterInstant(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function unifiedResetInstant(value) {
  const seconds = Number(value);
  return typeof value === 'string' && seconds > 0 ? seconds * 1000 : null;
}

function rateLimitExpiresAtMs(headers, now) {
  return retryAfterInstant(headers['retry-after'], now)
    ?? unifiedResetInstant(headers['anthropic-ratelimit-unified-reset'])
    ?? now + RATE_LIMIT_BLOCK_DEFAULT_MS;
}

// 401 and 403 are credential verdicts and wait for setup or a success; only a 429 expires.
function setUpstreamBlocked({ statusCode, evidence, headers, now = Date.now() }) {
  const expiresAtMs = statusCode === 429 ? rateLimitExpiresAtMs(headers || {}, now) : null;
  return writeState(CODEX_UPSTREAM_BLOCK_PATH, {
    state: 'upstream-blocked',
    observedAt: new Date(now).toISOString(),
    statusCode,
    evidence,
    ...(expiresAtMs === null ? {} : { expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs }),
  });
}

function clearUpstreamBlocked() {
  removeFile(CODEX_UPSTREAM_BLOCK_PATH);
}

function readUpstreamUnavailable(now = Date.now()) {
  const unavailable = readJsonFile(CODEX_UPSTREAM_UNAVAILABLE_PATH);
  if (unavailable?.state !== 'upstream-unavailable' || !Number.isFinite(unavailable.observedAtMs)) return null;
  return now - unavailable.observedAtMs < UPSTREAM_UNAVAILABLE_TTL_MS ? unavailable : null;
}

function setUpstreamUnavailable({ statusCode, now = Date.now() }) {
  if (readUpstreamBlocked()) return null;
  return writeState(CODEX_UPSTREAM_UNAVAILABLE_PATH, {
    state: 'upstream-unavailable',
    observedAt: new Date(now).toISOString(),
    observedAtMs: now,
    statusCode,
  });
}

function clearUpstreamUnavailable() {
  removeFile(CODEX_UPSTREAM_UNAVAILABLE_PATH);
}

module.exports = {
  CODEX_UPSTREAM_BLOCK_PATH,
  CODEX_UPSTREAM_UNAVAILABLE_PATH,
  RATE_LIMIT_BLOCK_DEFAULT_MS,
  UPSTREAM_UNAVAILABLE_TTL_MS,
  clearUpstreamBlocked,
  clearUpstreamUnavailable,
  readUpstreamBlocked,
  readUpstreamUnavailable,
  setUpstreamBlocked,
  setUpstreamUnavailable,
};
