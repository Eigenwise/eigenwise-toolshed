'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPLACE_RETRY_DELAYS_MS = [20, 60, 140, 300];
const RETRYABLE_REPLACE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const STALE_TEMPORARY_FILE_MS = 60 * 60 * 1000;

function replaceFileWithRetry(temporaryPath, targetPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      const delay = REPLACE_RETRY_DELAYS_MS[attempt];
      if (delay == null || !RETRYABLE_REPLACE_CODES.has(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

function sweepStaleTemporarySiblings(targetPath, now = Date.now()) {
  const directory = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.`;
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    const temporaryPath = path.join(directory, entry);
    try {
      if (now - fs.statSync(temporaryPath).mtimeMs < STALE_TEMPORARY_FILE_MS) continue;
      fs.unlinkSync(temporaryPath);
    } catch {}
  }
}

function writeFileAtomically(targetPath, contents, { mode } = {}) {
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let replaced = false;
  try {
    fs.writeFileSync(temporaryPath, contents, { mode });
    replaceFileWithRetry(temporaryPath, targetPath);
    replaced = true;
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
  if (replaced) sweepStaleTemporarySiblings(targetPath);
}

module.exports = {
  replaceFileWithRetry,
  sweepStaleTemporarySiblings,
  writeFileAtomically,
};
