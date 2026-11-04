'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonTokens } = require('./json-model-identity.js');

const MAX_CONFIG_BYTES = 1024 * 1024;
const SETTINGS = Object.freeze({ baseUrl: 'CCP_ANTIGRAVITY_BASE_URL', clientId: 'CCP_ANTIGRAVITY_CLIENT_ID',
  clientSecret: 'CCP_ANTIGRAVITY_CLIENT_SECRET', projectId: 'CCP_ANTIGRAVITY_PROJECT_ID',
  userAgent: 'CCP_ANTIGRAVITY_USER_AGENT' });
function indeterminate() { return new Error('Antigravity configuration intent is indeterminate; installed binary and services were left unchanged. Inspect the native configuration locally before updating.'); }

function configPath(environment, cwd) {
  // Rust std::env::consts::OS is windows/macos, not the resolver's retired
  // win32/darwin labels. Match its actual CCP -> XDG -> HOME/USERPROFILE chain.
  if (Object.hasOwn(environment, 'CCP_CONFIG_DIR')) return path.resolve(cwd, environment.CCP_CONFIG_DIR, 'config.json');
  const home = environment.HOME ?? environment.USERPROFILE ?? '/';
  const root = environment.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.resolve(cwd, root, 'claude-code-proxy', 'config.json');
}

function readConfigBytes(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    let count;
    while ((count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > MAX_CONFIG_BYTES) throw indeterminate();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
}

function noteKey(frame, token) {
  if (!frame?.object || !frame.expectKey || !token.startsWith('"')) return;
  const key = JSON.parse(token);
  if (frame.keys.has(key)) throw indeterminate();
  frame.keys.add(key); frame.expectKey = false;
}

function checkDepth(stack) {
  if (stack.length > 64) throw indeterminate();
}

function advanceJson(stack, token) {
  noteKey(stack.at(-1), token);
  if (['{', '['].includes(token)) stack.push({ object: token === '{', expectKey: true, keys: new Set() });
  if (['}', ']'].includes(token)) stack.pop();
  if (token === ',' && stack.at(-1)) stack.at(-1).expectKey = true;
  checkDepth(stack);
}

function assertUniqueKeys(text) {
  const stack = [];
  for (const match of jsonTokens(text)) advanceJson(stack, match[0]);
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function configSection(text) {
  const root = JSON.parse(text);
  assertUniqueKeys(text);
  if (!object(root)) throw indeterminate();
  const section = Object.hasOwn(root, 'antigravity') ? root.antigravity : {};
  if (!object(section)) throw indeterminate();
  if (Object.keys(section).some((key) => !['enabled', ...Object.keys(SETTINGS)].includes(key))) throw indeterminate();
  return section;
}

function validSetting(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function assertOrigin(value) {
  const url = new URL(value);
  if (![url.protocol === 'https:', url.hostname !== '', url.pathname === '/', !url.username, !url.password, !url.search, !url.hash].every(Boolean)) throw indeterminate();
}

function assertUserAgent(value) {
  if (!/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) throw indeterminate();
}

function assertSetting(key, value) {
  if (value === undefined) return;
  if (!validSetting(value)) throw indeterminate();
  if (key === 'baseUrl') assertOrigin(value);
  if (key === 'userAgent') assertUserAgent(value);
}

function assertFileUserAgent(section) {
  if (Object.hasOwn(section, 'userAgent') && typeof section.userAgent !== 'string') throw indeterminate();
}

function assertSettings(section, environment) {
  assertFileUserAgent(section);
  for (const [key, variable] of Object.entries(SETTINGS)) assertSetting(key, environment[variable] ?? section[key]);
}

function assertEnabledValue(value) {
  if (value !== undefined && typeof value !== 'boolean') throw indeterminate();
}

function enabledIntent(section, environment) {
  assertEnabledValue(section.enabled);
  const env = environment.CCP_ANTIGRAVITY_ENABLED;
  if (env !== undefined && !['true', 'false', '1', '0'].includes(env)) throw indeterminate();
  return section.enabled === true || ['1', 'true'].includes(env);
}

function readSection(file) {
  try { return configSection(readConfigBytes(file)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw indeterminate(); }
}

function configRequiresCompatibility({ environment = process.env, cwd = process.cwd() } = {}) {
  try {
    const section = readSection(configPath(environment, cwd));
    assertSettings(section, environment);
    return enabledIntent(section, environment);
  } catch { throw indeterminate(); }
}

module.exports = { configPath, configRequiresCompatibility };
