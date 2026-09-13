'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STATE } = require('./runtime.js');

const CONTROL_HEADER = 'x-model-gateway-control-token';
const CONTROL_TOKEN_PATH = path.join(STATE, 'control-token');
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function readControlToken(file = CONTROL_TOKEN_PATH) {
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!TOKEN_PATTERN.test(token)) throw new Error('model-gateway: invalid local control token; refusing lifecycle requests');
  return token;
}

function ensureControlToken(file = CONTROL_TOKEN_PATH) {
  const existing = readControlToken(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readControlToken(file);
}

function controlRequestHeaders(file = CONTROL_TOKEN_PATH) {
  const token = readControlToken(file);
  // Legacy supervisors have no token file. New supervisors create it before listening.
  return token ? { [CONTROL_HEADER]: token } : {};
}

function authenticatedControlRequest(req, token, ports, compatibilityListener = false) {
  const supplied = req.headers[CONTROL_HEADER];
  return !compatibilityListener
    && req.method === 'POST'
    && ports.some((port) => Number.isInteger(port) && port > 0 && req.headers.host === `127.0.0.1:${port}`)
    && req.headers.origin === undefined
    && req.headers['content-type'] === 'application/json'
    && typeof token === 'string' && TOKEN_PATTERN.test(token)
    && typeof supplied === 'string' && TOKEN_PATTERN.test(supplied)
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

module.exports = { CONTROL_HEADER, CONTROL_TOKEN_PATH, authenticatedControlRequest, controlRequestHeaders, ensureControlToken, readControlToken };
