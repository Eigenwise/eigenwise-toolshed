'use strict';

// OpenCode Go backend: passthrough to OpenCode's Anthropic Messages endpoint; rows come only from Go's own catalog.
// Must not require runtime.js (runtime.js requires it), so it resolves its own state paths.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomically } = require('./atomic-file.js');

const OPENCODEGO_BACKEND = 'opencodego';
const OPENCODEGO_PREFIX = 'claude-opencodego-';
const OPENCODEGO_LABEL = 'OpenCode Go';
const ERROR_PREFIX = 'model-gateway (OpenCode Go): ';
const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go';
const KEY_ENV = 'CODEX_GATEWAY_OPENCODEGO_KEY';
const BASE_URL_ENV = 'CODEX_GATEWAY_OPENCODEGO_BASE_URL';
const KEY_FILE_NAME = 'opencode-go-key';
const CATALOG_FILE_NAME = 'opencode-go-models.json';
const CATALOG_SCHEMA = 1;
const KEY_PATTERN = /^oc_sk_[\x21-\x7e]{8,}$/;
// Ordered lowest to highest. The catalog lists each model's supported subset.
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CATALOG_FETCH_TIMEOUT_MS = 15000;

// Same semantics as a destructured default (only undefined falls back), evaluated lazily.
function optionOr(options, name, fallback) {
  const value = options?.[name];
  return value === undefined ? fallback() : value;
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Own timer, never the 60s model-list loop: the catalog changes rarely and is fetched at most this often.
const CATALOG_REFRESH_MS = positiveMs(process.env.CODEX_GATEWAY_OPENCODEGO_CATALOG_REFRESH_MS, 6 * 60 * 60 * 1000);
// Minimum spacing for early refreshes and the retry/key-poll cadence while no catalog exists.
const CATALOG_RETRY_MS = positiveMs(process.env.CODEX_GATEWAY_OPENCODEGO_CATALOG_RETRY_MS, 60 * 1000);

function stateDirectory() {
  return path.join(os.homedir(), '.claude', 'model-gateway');
}

function keyPath() {
  return path.join(stateDirectory(), KEY_FILE_NAME);
}

function catalogPath() {
  return path.join(stateDirectory(), CATALOG_FILE_NAME);
}

function baseUrl(env = process.env) {
  return String(env[BASE_URL_ENV] || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function catalogUrl(env = process.env) {
  return `${baseUrl(env)}/v1/models`;
}

// pathAndQuery is the client's own /v1/messages... path, so count_tokens keeps its route.
function messagesUrl(pathAndQuery = '/v1/messages', env = process.env) {
  return `${baseUrl(env)}/anthropic${pathAndQuery}`;
}

function pluginVersion() {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof version === 'string' ? version : 'unknown';
  } catch { return 'unknown'; }
}

const USER_AGENT = `eigenwise-model-gateway/${pluginVersion()} (Claude Code gateway; OpenCode Go backend)`;

// ------------------------------------------------------------------ key

function looksLikeKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

// The gateway runs as a background supervisor that rarely sees an interactive shell's env, so the file is the
// primary source and the env var only an override.
function envKey(env) {
  return typeof env[KEY_ENV] === 'string' ? env[KEY_ENV].trim() : '';
}

function fileKey(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function readKey(options) {
  const fromEnv = envKey(optionOr(options, 'env', () => process.env));
  if (fromEnv) return { key: fromEnv, source: KEY_ENV };
  const file = optionOr(options, 'file', keyPath);
  const fromFile = fileKey(file);
  return fromFile ? { key: fromFile, source: 'file', file } : null;
}

function writeKey(key, file = keyPath()) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!looksLikeKey(trimmed)) throw new Error('that does not look like an OpenCode Go key (expected oc_sk_...); nothing was saved');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomically(file, trimmed + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

// ------------------------------------------------------------ catalog cache

let memo = { file: null, mtimeMs: null, size: null, value: null };

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function memoMatches(file, stat) {
  return memo.file === file && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseCatalogFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch { return null; }
}

function readCatalogCache(options) {
  const file = optionOr(options, 'file', catalogPath);
  const stat = statOrNull(file);
  if (!stat) {
    memo = { file, mtimeMs: null, size: null, value: null };
    return null;
  }
  if (memoMatches(file, stat)) return memo.value;
  const value = parseCatalogFile(file);
  memo = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

function writeCatalogCache(cache, file = catalogPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  memo = { file: null, mtimeMs: null, size: null, value: null };
}

// A cache only counts once a fetch succeeded; an error-only record never produces rows.
function hasCatalog(cache) {
  return !!cache && Number.isFinite(cache.fetchedAt) && Array.isArray(cache.models);
}

function catalogModel(goId, cache = readCatalogCache()) {
  if (!hasCatalog(cache)) return null;
  return cache.models.find((model) => model?.id === goId) || null;
}

function hasSafeId(model) {
  return !!model && typeof model.id === 'string' && SAFE_MODEL_ID.test(model.id);
}

function supportsTools(model) {
  return model.capabilities?.tools?.supported === true;
}

function acceptsText(model) {
  const input = model.modalities?.input;
  return Array.isArray(input) && input.includes('text');
}

function isAdvertisable(model) {
  return hasSafeId(model) && supportsTools(model) && acceptsText(model);
}

function hiddenIds(cache) {
  return cache?.hidden && typeof cache.hidden === 'object' ? Object.keys(cache.hidden) : [];
}

function advertisedModels(options) {
  if (!optionOr(options, 'key', readKey)) return [];
  const current = optionOr(options, 'cache', readCatalogCache);
  if (!hasCatalog(current)) return [];
  const hidden = new Set(hiddenIds(current));
  const seen = new Set();
  return current.models.filter((model) => {
    if (!isAdvertisable(model) || hidden.has(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function contextWindow(model) {
  const value = Number(model?.limit?.context);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// null means the model lists no effort levels at all.
function declaredEfforts(model) {
  return model?.capabilities?.reasoning?.effort;
}

function effortLevels(model) {
  const levels = declaredEfforts(model);
  if (!Array.isArray(levels)) return null;
  const known = EFFORT_ORDER.filter((level) => levels.includes(level));
  return known.length ? known : null;
}

function displayName(goId, cache) {
  const model = catalogModel(goId, cache);
  const name = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : goId;
  return `${name} (${OPENCODEGO_LABEL})`;
}

function clientDisplayName(clientId) {
  return displayName(goModelIdFromClientId(clientId) || clientId);
}

// ------------------------------------------------------------- model ids

function goModelIdFromClientId(id) {
  if (typeof id !== 'string') return null;
  const bare = id.replace(/\[1m\]$/, '');
  if (!bare.startsWith(OPENCODEGO_PREFIX)) return null;
  const goId = bare.slice(OPENCODEGO_PREFIX.length);
  return SAFE_MODEL_ID.test(goId) ? goId : null;
}

function goModelIdFromPayload(payload) {
  return payload ? goModelIdFromClientId(payload.model) : null;
}

function clientModelId(goId) {
  return `${OPENCODEGO_PREFIX}${goId}`;
}

// --------------------------------------------------------------- effort

function effortRank(level) {
  return EFFORT_ORDER.indexOf(level);
}

function mapEffort(requested, levels) {
  if (levels.includes(requested)) return requested;
  const rank = effortRank(requested);
  if (rank < 0) return null;
  return levels.find((level) => effortRank(level) > rank) || levels[levels.length - 1];
}

function withoutEffort(outputConfig) {
  if (!outputConfig || typeof outputConfig !== 'object' || Array.isArray(outputConfig)) return undefined;
  const rest = { ...outputConfig };
  delete rest.effort;
  return Object.keys(rest).length ? rest : undefined;
}

// Go reads thinking.type "disabled" as effort "none" and silently remaps an unsupported level to an
// undocumented one, so the gateway always applies its own rule first.
function setOutputConfig(next, value) {
  if (value === undefined) delete next.output_config;
  else next.output_config = value;
}

function stripEffort(next, outputConfig, effort) {
  setOutputConfig(next, withoutEffort(outputConfig));
  return { payload: next, effort };
}

function noLevelsRule(next, outputConfig) {
  const result = stripEffort(next, outputConfig, null);
  delete next.thinking;
  return result;
}

function disabledThinkingRule(next, outputConfig, levels) {
  if (levels.includes('none')) return stripEffort(next, outputConfig, 'none');
  delete next.thinking;
  setOutputConfig(next, { ...(withoutEffort(outputConfig) || {}), effort: levels[0] });
  return { payload: next, effort: levels[0] };
}

function requestedEffortRule(next, outputConfig, levels) {
  const requested = typeof outputConfig?.effort === 'string' ? outputConfig.effort : null;
  if (requested === null) return { payload: next, effort: null };
  const mapped = mapEffort(requested, levels);
  if (!mapped) return stripEffort(next, outputConfig, null);
  next.output_config = { ...outputConfig, effort: mapped };
  return { payload: next, effort: mapped };
}

function thinkingDisabled(payload) {
  return payload?.thinking?.type === 'disabled';
}

function applyEffortRule(payload, levels) {
  const next = { ...payload };
  const outputConfig = payload?.output_config;
  if (!levels) return noLevelsRule(next, outputConfig);
  if (thinkingDisabled(payload)) return disabledThinkingRule(next, outputConfig, levels);
  return requestedEffortRule(next, outputConfig, levels);
}

// ---------------------------------------------------------- upstream request

// Go requires x-opencode-session: one id per Claude Code session, hashed so the raw id never leaves the machine.
function openCodeSessionId(claudeSessionId, fallbackSeed) {
  const seed = typeof claudeSessionId === 'string' && claudeSessionId ? `session:${claudeSessionId}` : `gateway:${fallbackSeed}`;
  return `ses_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

// An allowlist, not a denylist: Claude's credentials (AUTH_HEADERS), cookies, Claude Code's own identifiers,
// and tracing headers never reach OpenCode. Only the Messages protocol headers pass.
const FORWARDED_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

function forwardedHeaders(clientHeaders) {
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = clientHeaders?.[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  return headers;
}

function upstreamHeaders(clientHeaders, { key, session, contentLength }) {
  const headers = forwardedHeaders(clientHeaders);
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  headers.authorization = `Bearer ${key}`;
  headers['x-opencode-session'] = session;
  headers['user-agent'] = USER_AGENT;
  if (contentLength != null) headers['content-length'] = contentLength;
  return headers;
}

// ---------------------------------------------------------------- errors

// First match wins, so the order is significant.
const ERROR_KINDS = [
  { kind: 'invalid-credential', matches: (status, text) => status === 401 || /invalid credential/i.test(text) },
  { kind: 'model-unavailable', matches: (status, text) => /model is unavailable/i.test(text) },
  { kind: 'outside-opencode', matches: (status, text) => status === 403 && /opencode/i.test(text) && /\b(outside|only|cli|client)\b/i.test(text) },
  { kind: 'region', matches: (status, text) => /requires global regions/i.test(text) },
  { kind: 'training-consent', matches: (status, text) => /trains on request data/i.test(text) },
];

function errorKind(status, message) {
  const text = String(message || '');
  const match = ERROR_KINDS.find((entry) => entry.matches(status, text));
  return match ? match.kind : null;
}

function loginCommand(commandPath) {
  return commandPath ? `node "${commandPath}" login --opencodego` : 'model-gateway login --opencodego';
}

function guidanceFor(kind, commandPath) {
  if (kind === 'invalid-credential') {
    return ` OpenCode Go rejected the saved key. Run \`${loginCommand(commandPath)}\` and paste a current key from the OpenCode Console.`;
  }
  return '';
}

// Go's messages already name the next step; guidance is added only where they do not.
function bodyText(body) {
  return Buffer.isBuffer(body) ? body.toString() : String(body || '');
}

function parseJsonOrNull(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function hasErrorMessage(parsed) {
  return !!parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string';
}

function jsonErrorBody(status, parsed, commandPath) {
  const upstreamMessage = parsed.error.message;
  const kind = errorKind(status, upstreamMessage);
  const error = { ...parsed.error, message: `${ERROR_PREFIX}${upstreamMessage}${guidanceFor(kind, commandPath)}` };
  return { kind, upstreamMessage, body: Buffer.from(JSON.stringify({ ...parsed, type: parsed.type || 'error', error })) };
}

function textErrorBody(status, text, commandPath) {
  const detail = text ? `: ${text.slice(0, 500)}` : ' with no readable error body';
  const kind = errorKind(status, text);
  const error = {
    type: status === 401 ? 'authentication_error' : 'api_error',
    message: `${ERROR_PREFIX}upstream returned HTTP ${status}${detail}${guidanceFor(kind, commandPath)}`,
  };
  return { kind, upstreamMessage: text.slice(0, 500), body: Buffer.from(JSON.stringify({ type: 'error', error })) };
}

function upstreamErrorBody(status, body, options) {
  const commandPath = options?.commandPath;
  const text = bodyText(body);
  const parsed = parseJsonOrNull(text);
  if (hasErrorMessage(parsed)) return jsonErrorBody(status, parsed, commandPath);
  return textErrorBody(status, text.trim(), commandPath);
}

function errorJson(type, message) {
  return JSON.stringify({ type: 'error', error: { type, message: `${ERROR_PREFIX}${message}` } });
}

function missingKeyBody(commandPath) {
  return errorJson('authentication_error', `no OpenCode Go key is configured, so this model cannot be reached. Run \`${loginCommand(commandPath)}\` and paste your key (it starts with oc_sk_), then retry.`);
}

function networkFailureBody(error) {
  return errorJson('api_error', `upstream request failed: ${error?.message || 'network error'}. Check the connection to opencode.ai and retry.`);
}

// ------------------------------------------------------------- catalog fetch

function requestJson(url, { headers = {}, timeoutMs = CATALOG_FETCH_TIMEOUT_MS } = {}) {
  const transport = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

function parseCatalogResponse(body) {
  const parsed = JSON.parse(body);
  const models = Array.isArray(parsed?.data) ? parsed.data : null;
  if (!models) throw new Error('catalog response has no data array');
  return models.filter((model) => model && typeof model === 'object' && typeof model.id === 'string');
}

// reason "scheduled" or "no-cache" is a regular refresh and lifts every 403 hide; an early refresh
// ("model-unavailable", "outside-opencode") keeps them until the next regular one.
function refreshOptions(options) {
  return {
    reason: optionOr(options, 'reason', () => 'scheduled'),
    file: optionOr(options, 'file', catalogPath),
    env: optionOr(options, 'env', () => process.env),
    request: optionOr(options, 'request', () => requestJson),
    now: optionOr(options, 'now', () => Date.now),
  };
}

async function fetchCatalogModels(url, request) {
  const response = await request(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (response.status !== 200) throw new Error(`catalog returned HTTP ${response.status}`);
  return parseCatalogResponse(response.body);
}

function isRegularRefresh(reason) {
  return reason === 'scheduled' || reason === 'no-cache';
}

function keptHidden(existing, reason) {
  return !isRegularRefresh(reason) && existing?.hidden ? existing.hidden : {};
}

function recordCatalogFailure(existing, { reason, file, now }, error) {
  const record = { ...(existing || { schema: CATALOG_SCHEMA }), lastCatalogError: { at: new Date(now()).toISOString(), reason, message: error.message } };
  try { writeCatalogCache(record, file); } catch {}
  return { ok: false, reason, error: error.message };
}

function recordCatalogSuccess(existing, { reason, file, now }, url, models) {
  const cache = {
    schema: CATALOG_SCHEMA,
    fetchedAt: now(),
    source: url,
    reason,
    models,
    hidden: keptHidden(existing, reason),
    ...(existing?.lastRequestError ? { lastRequestError: existing.lastRequestError } : {}),
  };
  writeCatalogCache(cache, file);
  return { ok: true, reason, modelCount: models.length };
}

async function refreshCatalog(options) {
  const settings = refreshOptions(options);
  const url = catalogUrl(settings.env);
  const existing = readCatalogCache({ file: settings.file });
  let models;
  try {
    models = await fetchCatalogModels(url, settings.request);
  } catch (error) {
    return recordCatalogFailure(existing, settings, error);
  }
  return recordCatalogSuccess(existing, settings, url, models);
}

function storeOptions(options) {
  return { file: optionOr(options, 'file', catalogPath), now: optionOr(options, 'now', () => Date.now) };
}

function clipped(message, length) {
  return String(message || '').slice(0, length);
}

// A genuine "not usable outside OpenCode" 403 hides the row until the next regular refresh. Region and
// training-consent errors never hide a row: they are account settings the user can change.
function hideModel(goId, message, options) {
  const { file, now } = storeOptions(options);
  const existing = readCatalogCache({ file });
  if (!hasCatalog(existing)) return false;
  const hidden = { ...(existing.hidden || {}), [goId]: { at: new Date(now()).toISOString(), message: clipped(message, 300) } };
  writeCatalogCache({ ...existing, hidden }, file);
  return true;
}

function requestErrorRecord({ status, kind, message, model }, now) {
  return {
    at: new Date(now()).toISOString(),
    status,
    ...(kind ? { kind } : {}),
    ...(model ? { model } : {}),
    message: clipped(message, 300),
  };
}

function noteRequestError(details, options) {
  const { file, now } = storeOptions(options);
  const existing = readCatalogCache({ file }) || { schema: CATALOG_SCHEMA };
  const lastRequestError = requestErrorRecord(details, now);
  try { writeCatalogCache({ ...existing, lastRequestError }, file); } catch {}
}

module.exports = {
  CATALOG_REFRESH_MS,
  CATALOG_RETRY_MS,
  EFFORT_ORDER,
  ERROR_PREFIX,
  KEY_ENV,
  BASE_URL_ENV,
  OPENCODEGO_BACKEND,
  OPENCODEGO_LABEL,
  OPENCODEGO_PREFIX,
  USER_AGENT,
  advertisedModels,
  applyEffortRule,
  catalogModel,
  catalogPath,
  catalogUrl,
  clientDisplayName,
  clientModelId,
  contextWindow,
  displayName,
  effortLevels,
  errorKind,
  goModelIdFromClientId,
  goModelIdFromPayload,
  hasCatalog,
  hiddenIds,
  hideModel,
  isAdvertisable,
  keyPath,
  looksLikeKey,
  mapEffort,
  messagesUrl,
  missingKeyBody,
  networkFailureBody,
  noteRequestError,
  openCodeSessionId,
  parseCatalogResponse,
  readCatalogCache,
  readKey,
  refreshCatalog,
  upstreamErrorBody,
  upstreamHeaders,
  writeCatalogCache,
  writeKey,
};
