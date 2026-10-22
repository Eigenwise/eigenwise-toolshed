'use strict';

// Preloaded into concurrency fixture children so a Windows CI lock failure carries its own numbers: how long
// each write transaction waited for BEGIN IMMEDIATE and how long it then held the lock (SQ-3844).
const fs = require('fs');
const { performance } = require('perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const timingLog = process.env.SIDEQUEST_TEST_WRITE_LOCK_TIMING_LOG;
const originalExec = DatabaseSync.prototype.exec;
let waitStartedAt = null;
let lockedAt = null;

function recordRelease(waitedMs) {
  fs.appendFileSync(timingLog, `${JSON.stringify({ pid: process.pid, waitMs: Math.round(waitedMs), holdMs: Math.round(performance.now() - lockedAt) })}\n`);
}

function beginImmediate(database, sql) {
  waitStartedAt ??= performance.now();
  const result = originalExec.call(database, sql);
  lockedAt = performance.now();
  return result;
}

function finishTransaction(database, sql) {
  const result = originalExec.call(database, sql);
  if (lockedAt !== null) recordRelease(lockedAt - waitStartedAt);
  waitStartedAt = null;
  lockedAt = null;
  return result;
}

if (timingLog) {
  DatabaseSync.prototype.exec = function timedExec(sql) {
    const statement = String(sql).trim().toUpperCase();
    if (statement === 'BEGIN IMMEDIATE') return beginImmediate(this, sql);
    if (statement === 'COMMIT' || statement === 'ROLLBACK') return finishTransaction(this, sql);
    return originalExec.call(this, sql);
  };
}
