'use strict';

const fs = require('node:fs');

const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const REQUEST_BODY_WARNING_BYTES = 26 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 36 * 1024 * 1024;
const SERIALIZATION_ALLOWANCE = 1.1;
const FIXED_ALLOWANCE_BYTES = 8 * 1024;

function base64Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function attachmentBytes(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + attachmentBytes(item), 0);
  let total = value.type === 'base64' ? base64Bytes(value.data) : 0;
  for (const child of Object.values(value)) total += attachmentBytes(child);
  return total;
}

function estimateRequestBodyBytes(transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;

    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    let attachment = 0;
    for (const line of transcript.split(/\r?\n/)) {
      if (!line) continue;
      try { attachment += attachmentBytes(JSON.parse(line)); } catch {}
    }
    const transcriptBytes = Buffer.byteLength(transcript, 'utf8');
    const textAllowance = Math.max(0, transcriptBytes - attachment);
    const value = attachment + Math.ceil(textAllowance * SERIALIZATION_ALLOWANCE) + FIXED_ALLOWANCE_BYTES;
    return {
      value,
      attachment_bytes: attachment,
      text_allowance_bytes: Math.ceil(textAllowance * SERIALIZATION_ALLOWANCE) + FIXED_ALLOWANCE_BYTES,
      warning: value >= REQUEST_BODY_WARNING_BYTES,
    };
  } catch {
    return null;
  }
}

function formatRequestBodyStatus(estimate) {
  if (!estimate || !Number.isFinite(estimate.value)) return '';
  const value = (estimate.value / (1024 * 1024)).toFixed(1);
  const limit = (REQUEST_BODY_LIMIT_BYTES / (1024 * 1024)).toFixed(0);
  return estimate.warning
    ? `body ~${value}MB/${limit}MB WARNING: /compact before spawning`
    : `body ~${value}MB/${limit}MB`;
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_WARNING_BYTES,
  estimateRequestBodyBytes,
  formatRequestBodyStatus,
};
