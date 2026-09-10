'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');
const { CODEX_UPSTREAM_BLOCK_PATH, STATE } = require('./runtime.js');

const CODEX_UPSTREAM_UNAVAILABLE_PATH = path.join(STATE, 'codex-upstream-unavailable.json');
const UPSTREAM_UNAVAILABLE_TTL_MS = 60_000;

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

function readUpstreamBlocked() {
  const blocked = readJsonFile(CODEX_UPSTREAM_BLOCK_PATH);
  return blocked?.state === 'upstream-blocked' ? blocked : null;
}

function setUpstreamBlocked({ statusCode, evidence }) {
  return writeState(CODEX_UPSTREAM_BLOCK_PATH, {
    state: 'upstream-blocked',
    observedAt: new Date().toISOString(),
    statusCode,
    evidence,
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
  UPSTREAM_UNAVAILABLE_TTL_MS,
  clearUpstreamBlocked,
  clearUpstreamUnavailable,
  readUpstreamBlocked,
  readUpstreamUnavailable,
  setUpstreamBlocked,
  setUpstreamUnavailable,
};
