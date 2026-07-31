'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const REQUEST_BODY_WARNING_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_BODY_RECORD_BYTES = 1024;
const REQUEST_BODY_STATE_DIR = process.env.MODEL_GATEWAY_REQUEST_BODY_DIR
  || path.join(os.homedir(), '.claude', 'model-gateway', 'request-body');
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;

function requestBodyHighWaterPath(sessionId, directory = REQUEST_BODY_STATE_DIR) {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(directory, `${Buffer.from(sessionId).toString('base64url')}.json`);
}

function estimateRequestBodyBytes(sessionId, directory) {
  try {
    const filePath = requestBodyHighWaterPath(sessionId, directory);
    if (!filePath) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_REQUEST_BODY_RECORD_BYTES) return null;
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Number.isFinite(record?.value) || record.value < 0) return null;
    return {
      value: record.value,
      warning: record.value >= REQUEST_BODY_WARNING_BYTES,
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
    ? `body peak ${value}MB/${limit}MB WARNING`
    : `body peak ${value}MB/${limit}MB`;
}

module.exports = {
  REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_WARNING_BYTES,
  estimateRequestBodyBytes,
  formatRequestBodyStatus,
  requestBodyHighWaterPath,
};
