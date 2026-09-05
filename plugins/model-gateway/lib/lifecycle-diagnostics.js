'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { LIFECYCLE_LOG_PATH } = require('./runtime.js');

const MAX_RECORDS = 200;

function lifecycleLogPath() {
  return LIFECYCLE_LOG_PATH;
}

function lifecycleRecord(event, fields = {}) {
  const record = {
    at: new Date().toISOString(),
    event,
    component: fields.component,
    pid: fields.pid,
  };
  for (const key of ['startedAt', 'outcome', 'errorType']) {
    if (fields[key] != null) record[key] = fields[key];
  }
  if (fields.signal !== undefined) record.signal = fields.signal;
  if (fields.exitCode !== undefined) record.exitCode = fields.exitCode;
  if (fields.child) record.child = fields.child;
  return record;
}

function keepRecentRecords(recordPath) {
  let lines;
  try { lines = fs.readFileSync(recordPath, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return; }
  if (lines.length < MAX_RECORDS) return;
  fs.writeFileSync(recordPath, lines.slice(-(MAX_RECORDS - 1)).join('\n') + '\n');
}

function recordGatewayLifecycle(event, fields) {
  try {
    const recordPath = lifecycleLogPath();
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    keepRecentRecords(recordPath);
    fs.appendFileSync(recordPath, JSON.stringify(lifecycleRecord(event, fields)) + '\n');
  } catch {}
}

function readLifecycleRecords() {
  try {
    return fs.readFileSync(lifecycleLogPath(), 'utf8').split(/\r?\n/).flatMap((line) => {
      try { return line ? [JSON.parse(line)] : []; } catch { return []; }
    });
  } catch { return []; }
}

function latestObservedLifecycleExit() {
  return readLifecycleRecords().findLast((record) => record.event === 'supervisor-exit' || record.event === 'worker-exit' || record.event === 'proxy-exit') || null;
}

function latestHookWaitCutShort() {
  return readLifecycleRecords().findLast((record) => record.event === 'ensure-hook-wait-cut-short') || null;
}

module.exports = { latestHookWaitCutShort, latestObservedLifecycleExit, lifecycleLogPath, readLifecycleRecords, recordGatewayLifecycle };
