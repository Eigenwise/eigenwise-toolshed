'use strict';

const { spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { createGatewayUsageEmitter, recordRequestBodyHighWater } = require('./usage-observability.js');
const grokBackend = require('./grok-backend.js');
const { fetchUrl } = require('./process-supervision.js');
const { wiredMode } = require('./settings-wiring.js');
const { detectHostsCompat } = require('./remote-control.js');
const { codexBaseFromId, ourBaseUrls } = require('./pins.js');
const {
  ANTHROPIC_UPSTREAM, AUTH_HEADERS, CODEX_FAMILY_RE, CODEX_UPSTREAM_BLOCK_PATH, COMPAT_HOST,
  COMPAT_PORT, DISPATCH_MODEL_ID, DISPATCH_ROUTE_CACHE_PATH, GROK_ENDPOINT, GROK_PREFIX, LIST_DISPATCH_MODEL,
  LOGS, PLUGIN_VERSION, PREFIX, PROXY_BIN, PROXY_PORT, REQUEST_ROUTE_LOG,
  REQUEST_ROUTE_LOG_PATH, ROUTE_TELEMETRY_ENABLED, ROUTE_TELEMETRY_TIMEOUT_MS, SHIM_PORT,
  STATE, TRACE_HEADERS, mkdirs,
} = require('./runtime.js');

function isAuthed() {
  const r = spawnSync(PROXY_BIN, ['codex', 'auth', 'status'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 && /account/i.test((r.stdout || '') + (r.stderr || ''));
}

const CODEX_READINESS_MESSAGES = {
  'binary-missing': () => `Codex dispatch refused: claude-code-proxy is missing. Run \`node "${__filename}" setup\`, then retry. No Anthropic fallback was used.`,
  'auth-missing': () => `Codex dispatch refused: ChatGPT sign-in is required. Run \`node "${__filename}" login\`, finish browser OAuth, then run \`node "${__filename}" setup\` and retry. Credentials live in \`~/.config/claude-code-proxy/\`.`,
  'proxy-down': () => `Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run \`node "${__filename}" ensure\`, then retry. No Anthropic fallback was used.`,
  'shim-down': () => `Codex dispatch refused: the model-gateway shim is down. Run \`node "${__filename}" ensure\`, then retry. No Anthropic fallback was used.`,
  'serving-version-mismatch': () => `Codex dispatch refused: model-gateway is serving a stale shim version. Run \`node "${__filename}" ensure\`, then retry. No Anthropic fallback was used.`,
  'upstream-blocked': () => `Codex is blocked by an OpenAI rejection. Run \`node "${__filename}" setup\`; if it persists, wait for a claude-code-proxy update or explicitly re-route this ticket. Codex tickets remain blocked.`,
};

function readUpstreamBlocked() {
  const blocked = readJsonFile(CODEX_UPSTREAM_BLOCK_PATH);
  return blocked?.state === 'upstream-blocked' ? blocked : null;
}

function setUpstreamBlocked({ statusCode, evidence }) {
  mkdirs();
  const blocked = {
    state: 'upstream-blocked',
    observedAt: new Date().toISOString(),
    statusCode,
    evidence,
  };
  fs.writeFileSync(CODEX_UPSTREAM_BLOCK_PATH, JSON.stringify(blocked) + '\n');
  return blocked;
}

function clearUpstreamBlocked() {
  try { fs.rmSync(CODEX_UPSTREAM_BLOCK_PATH); } catch { /* absent */ }
}

function noteCodexRequestSuccess() {
  clearUpstreamBlocked();
}

async function proxyModelsAnswering() {
  try {
    const response = await fetchUrl(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { timeout: 2000 });
    return response.status === 200;
  } catch { return false; }
}

function readinessState(checks, upstreamBlocked) {
  if (!checks.proxyBinary) return 'binary-missing';
  if (!checks.proxyModels) return 'proxy-down';
  if (!checks.codexAuth) return 'auth-missing';
  if (!checks.shimRunning) return 'shim-down';
  if (!checks.servingVersionMatches) return 'serving-version-mismatch';
  if (upstreamBlocked) return 'upstream-blocked';
  return 'ready';
}

async function getCodexReadiness({
  binaryPresent = fs.existsSync(PROXY_BIN),
  probeProxyModels = proxyModelsAnswering,
  authStatus = isAuthed,
  shimHealth = undefined,
  fetchHealth = fetchShimHealth,
} = {}) {
  const proxyBinary = Boolean(binaryPresent);
  const [proxyModels, health] = await Promise.all([
    proxyBinary ? probeProxyModels() : false,
    shimHealth === undefined ? fetchHealth() : shimHealth,
  ]);
  const codexAuth = proxyBinary ? Boolean(authStatus()) : false;
  const shimRunning = Boolean(health?.ok);
  const servingVersion = servingShimVersion(health);
  const checks = {
    proxyBinary,
    proxyModels: Boolean(proxyModels),
    codexAuth,
    shimRunning,
    servingVersion,
    installedVersion: PLUGIN_VERSION,
    servingVersionMatches: shimRunning && servingVersion === PLUGIN_VERSION,
  };
  const upstreamBlocked = readUpstreamBlocked();
  const state = readinessState(checks, upstreamBlocked);
  return {
    ready: state === 'ready',
    state,
    message: state === 'ready'
      ? 'Codex readiness confirms local binary, /v1/models, authentication, shim, and serving-version checks. It does not prove a streaming request will succeed.'
      : CODEX_READINESS_MESSAGES[state](),
    checks,
    upstreamBlocked,
    health,
  };
}

function catalogReadiness(readiness) {
  return {
    ready: readiness.ready,
    state: readiness.state,
    message: readiness.message,
    checks: readiness.checks,
    upstreamBlocked: readiness.upstreamBlocked,
  };
}

function providerReadiness(readiness) {
  return {
    ready: Boolean(readiness?.ready),
    state: typeof readiness?.state === 'string' ? readiness.state : 'unavailable',
    message: typeof readiness?.message === 'string' ? readiness.message : 'Readiness is unavailable.',
  };
}

function hasOpenAiRejectionEvidence(statusCode, headers, body) {
  if (![401, 403, 429].includes(statusCode)) return false;
  const headerNames = Object.keys(headers || {});
  if (headerNames.some((name) => name.toLowerCase().startsWith('x-openai-') || name.toLowerCase() === 'openai-processing-ms')) return true;
  return /\bopenai\b/i.test(Buffer.from(body || '').toString());
}

function noteCodexUpstreamRejection(statusCode, headers, body) {
  if (!hasOpenAiRejectionEvidence(statusCode, headers, body)) return false;
  const headerNames = Object.keys(headers || {}).map((name) => name.toLowerCase())
    .filter((name) => name.startsWith('x-openai-') || name === 'openai-processing-ms' || name === 'content-type');
  const evidence = headerNames.length ? `headers:${headerNames.join(',')}` : 'body:openai';
  setUpstreamBlocked({ statusCode, evidence });
  console.error(`model-gateway: Codex request had an unambiguous OpenAI rejection (status ${statusCode}; ${evidence}); readiness is upstream-blocked.`);
  return true;
}


async function fetchShimHealth() {
  try {
    const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/healthz`, { timeout: 2000 });
    return JSON.parse(r.body.toString());
  } catch { return null; }
}

function servingShimVersion(health) {
  return health?.supervisorVersion || health?.version || null;
}

function displayName(id, backend = 'codex') {
  if (backend === 'grok') return id.replace(/^grok-/, 'Grok ').replace(/-/g, ' ');
  return id.replace(/^gpt-/, 'GPT-').replace(/\[1m\]$/, '') + ' (Codex)';
}

// claude-code-proxy v0.1.10 has no /v1/models route, so the shim owns the
// catalog: ~/.claude/model-gateway/models.json if present, else the Codex ids
// its README documents. A future proxy /v1/models takes precedence over both.
const PLAN_TOOLS = ['EnterPlanMode', 'ExitPlanMode'];

const DEFAULT_MODELS = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2',
];
const DEFAULT_GROK_MODELS = grokBackend.GROK_MODELS.map((model) => model.id);

// Advertised to Claude Code as max_input_tokens for Codex models.
//
// IMPORTANT: as of Claude Code 2.1.207 this value is INERT for compaction. The
// context-window resolver (eyc/sT in claude.exe) never reads a discovered
// model's max_input_tokens for a `claude-`prefixed id — it hardwires 200000
// (PPr). The CLAUDE_CODE_MAX_CONTEXT_TOKENS escape hatch is gated behind
// `!startsWith("claude-")`, and our ids are `claude-*` (discovery drops
// non-claude ids, so we can't drop the prefix). Net: Claude Code uses a 200k
// window for every Codex model no matter what we advertise, proactive
// auto-compaction is OFF (window source is "auto"), and the only recovery is
// reactive — triggered when the BACKEND returns a context-overflow error (see
// the 413 normalize path in forward()). So this number does NOT "make Claude
// Code compact earlier"; the earlier 272k/245k-headroom rationale was wrong.
//
// It is still advertised (a) for honesty in /v1/models and (b) to future-proof
// a Claude Code version that does consult it. Proxy 0.1.17 measured the real
// GPT-5.6 input ceiling at 370000 tokens: 370006 was accepted and 371882 was
// rejected with native 413 request_too_large. Override per-machine with
// CODEX_GATEWAY_CONTEXT_WINDOW. Never set a global CLAUDE_CODE_AUTO_COMPACT_WINDOW
// to influence this: that also hits Claude passthrough models.
const CODEX_COMPACT_CONTEXT_WINDOW = Number(process.env.CODEX_GATEWAY_CONTEXT_WINDOW) || 370000;
const CODEX_SENTRY_ENABLED = process.env.CODEX_GATEWAY_SENTRY !== '0';
const configuredCompactTrigger = Number(process.env.CODEX_GATEWAY_COMPACT_TRIGGER);
const CODEX_COMPACT_TRIGGER = Number.isFinite(configuredCompactTrigger) && configuredCompactTrigger > 0
  ? configuredCompactTrigger
  : 330000;
const CODEX_COMPACT_HEADROOM = 40000;
const configuredSseHeartbeatSeconds = Number(process.env.CODEX_GATEWAY_SSE_HEARTBEAT_S);
const SSE_HEARTBEAT_MS = Number.isFinite(configuredSseHeartbeatSeconds) && configuredSseHeartbeatSeconds >= 0
  ? configuredSseHeartbeatSeconds * 1000
  : 20000;
const configuredWebSocketUpgradeRetries = Number(process.env.CODEX_GATEWAY_WS_UPGRADE_RETRIES);
const WEBSOCKET_UPGRADE_RETRIES = Number.isInteger(configuredWebSocketUpgradeRetries) && configuredWebSocketUpgradeRetries >= 0
  ? configuredWebSocketUpgradeRetries
  : 2;
const configuredWebSocketUpgradeRetryDelayMs = Number(process.env.CODEX_GATEWAY_WS_UPGRADE_RETRY_DELAY_MS);
const WEBSOCKET_UPGRADE_RETRY_DELAY_MS = Number.isFinite(configuredWebSocketUpgradeRetryDelayMs) && configuredWebSocketUpgradeRetryDelayMs >= 0
  ? configuredWebSocketUpgradeRetryDelayMs
  : 250;

// Claude Code's own compaction system prompt, verbatim from the querySource:
// "compact" call site in CLI 2.1.220. claude-code-proxy keys its compaction
// handling off the same literal, so the two stay in step.
const COMPACTION_SYSTEM_PROMPT = 'You are a helpful AI assistant tasked with summarizing conversations.';
// A Codex compaction turn dies mid-stream far more often than a normal turn,
// and claude-code-proxy cannot recover it. Its streaming path is WebSocket-only
// (config.rs codex_transport() defaults to WebSocket; mod.rs routes every
// stream:true request to live_stream_response), and that path can only retry
// BEFORE its first non-empty chunk. After that, an upstream socket that closes
// without a terminal event becomes an SSE error carrying the raw detail slug
// websocket_missing_terminal (websocket.rs missing_terminal_error), which
// Claude Code surfaces as a failed compaction. Compaction is one long
// single-shot generation over the largest body in the session, so it sits in
// that unrecoverable window for minutes. Buffering the translated stream for
// compaction only lets us retry the whole turn while the client has seen
// nothing; normal turns keep streaming live.
const COMPACT_STREAM_GUARD = process.env.CODEX_GATEWAY_COMPACT_STREAM_GUARD !== '0';
const configuredCompactStreamRetries = Number(process.env.CODEX_GATEWAY_COMPACT_STREAM_RETRIES);
const COMPACT_STREAM_RETRIES = Number.isInteger(configuredCompactStreamRetries) && configuredCompactStreamRetries >= 0
  ? configuredCompactStreamRetries
  : 2;
const configuredCompactStreamRetryDelayMs = Number(process.env.CODEX_GATEWAY_COMPACT_STREAM_RETRY_DELAY_MS);
const COMPACT_STREAM_RETRY_DELAY_MS = Number.isFinite(configuredCompactStreamRetryDelayMs) && configuredCompactStreamRetryDelayMs >= 0
  ? configuredCompactStreamRetryDelayMs
  : 250;
const configuredCompactStreamMaxBytes = Number(process.env.CODEX_GATEWAY_COMPACT_STREAM_MAX_BYTES);
const COMPACT_STREAM_MAX_BYTES = Number.isFinite(configuredCompactStreamMaxBytes) && configuredCompactStreamMaxBytes > 0
  ? configuredCompactStreamMaxBytes
  : 16 * 1024 * 1024;
// Retrying these would re-send a body the backend has already refused on its
// merits; they pass straight through to the client instead.
const COMPACT_FATAL_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'billing_error',
]);

function systemPromptText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('\n');
}

function isCompactionRequest(payload) {
  return !!payload && payload.stream === true
    && systemPromptText(payload.system).includes(COMPACTION_SYSTEM_PROMPT);
}

function sseErrorFrame(type, message) {
  const event = { type: 'error', error: { type, message } };
  return `event: error\ndata: ${JSON.stringify(event)}\n\n`;
}

function upstreamErrorMessage(body, statusCode) {
  try {
    const parsed = JSON.parse(body.toString());
    const detail = parsed?.error?.message || parsed?.message;
    if (typeof detail === 'string' && detail) return `model-gateway: upstream returned ${statusCode}: ${detail}`;
  } catch { /* not JSON */ }
  return `model-gateway: upstream returned ${statusCode} with no readable error body`;
}

function noteCompactEvent(attempt, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'message_stop') attempt.terminal = true;
  if (event.type !== 'error') return;
  attempt.sawError = true;
  if (COMPACT_FATAL_ERROR_TYPES.has(event.error?.type)) attempt.fatal = true;
}

function gatewayModel(id, backend = 'codex') {
  const prefix = backend === 'grok' ? GROK_PREFIX : PREFIX;
  const context = backend === 'grok'
    ? (grokBackend.GROK_MODELS.find((model) => model.id === id)?.context || 131072)
    : CODEX_COMPACT_CONTEXT_WINDOW;
  const advertised = backend === 'grok'
    ? `${prefix}${grokBackend.grokPickerId(id)}`
    : id === 'auto' ? DISPATCH_MODEL_ID : `${prefix}${id}`;
  return {
    id: advertised,
    display_name: id === 'auto' ? 'Sidequest Dispatch (Codex)' : displayName(id, backend),
    type: 'model',
    max_input_tokens: context,
  };
}

const ROUTE_MARKER_RE = /\[(switchboard-route|sidequest-route) model=([a-z0-9][a-z0-9.-]{0,63})(?: effort=(low|medium|high|xhigh|max))?\]/g;
const configuredDispatchCacheTtlMs = Number(process.env.CODEX_GATEWAY_DISPATCH_CACHE_TTL_MS);
const DISPATCH_CACHE_TTL_MS = Number.isFinite(configuredDispatchCacheTtlMs) && configuredDispatchCacheTtlMs > 0
  ? configuredDispatchCacheTtlMs
  : 4 * 60 * 60 * 1000;
const configuredDispatchCacheMaxSessions = Number(process.env.CODEX_GATEWAY_DISPATCH_CACHE_MAX_SESSIONS);
const DISPATCH_CACHE_MAX_SESSIONS = Number.isInteger(configuredDispatchCacheMaxSessions) && configuredDispatchCacheMaxSessions > 0
  ? configuredDispatchCacheMaxSessions
  : 500;

class DispatchSessionRouteCache {
  constructor({
    ttlMs = DISPATCH_CACHE_TTL_MS,
    maxSessions = DISPATCH_CACHE_MAX_SESSIONS,
    now = Date.now,
    cachePath = null,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.now = now;
    this.cachePath = cachePath;
    this.routes = new Map();
    this.load();
  }

  get(requestIdentity) {
    if (!requestIdentity) return null;
    const entry = this.routes.get(requestIdentity);
    if (!entry) return null;
    const now = this.now();
    if (now - entry.lastUsedAt >= this.ttlMs) {
      this.routes.delete(requestIdentity);
      this.persist();
      return null;
    }
    entry.lastUsedAt = now;
    this.routes.delete(requestIdentity);
    this.routes.set(requestIdentity, entry);
    this.persist();
    return { model: entry.model, effort: entry.effort };
  }

  set(requestIdentity, route) {
    if (!requestIdentity || !route || !validDispatchRoute(route)) return;
    const now = this.now();
    this.prune(now);
    this.routes.delete(requestIdentity);
    this.routes.set(requestIdentity, { model: route.model, effort: route.effort, lastUsedAt: now });
    this.prune(now);
    this.persist();
  }

  load() {
    if (!this.cachePath) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (!stored || stored.version !== 1 || !Array.isArray(stored.routes)) return;
      for (const entry of stored.routes) {
        const [key, route] = Array.isArray(entry) ? entry : [];
        if (typeof key !== 'string' || !Number.isFinite(route?.lastUsedAt) || !validDispatchRoute(route)) continue;
        this.routes.set(key, { model: route.model, effort: route.effort, lastUsedAt: route.lastUsedAt });
      }
      this.prune(this.now());
      this.persist();
    } catch {}
  }

  prune(now) {
    for (const [key, entry] of this.routes) {
      if (now - entry.lastUsedAt >= this.ttlMs) this.routes.delete(key);
    }
    while (this.routes.size > this.maxSessions) this.routes.delete(this.routes.keys().next().value);
  }

  persist() {
    if (!this.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const tempPath = `${this.cachePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ version: 1, routes: [...this.routes] }) + '\n', { mode: 0o600 });
      fs.renameSync(tempPath, this.cachePath);
    } catch {}
  }
}

function validDispatchRoute(route) {
  return typeof route?.model === 'string'
    && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(route.model)
    && (route.effort == null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort));
}

function sessionIdFromMetadata(metadata) {
  const userId = metadata && typeof metadata.user_id === 'string' ? metadata.user_id : null;
  if (!userId) return null;
  try {
    const parsed = JSON.parse(userId);
    return safeMetadataId(parsed && parsed.session_id);
  } catch {}
  const marker = '_session_';
  const markerIndex = userId.lastIndexOf(marker);
  return markerIndex >= 0 ? safeMetadataId(userId.slice(markerIndex + marker.length)) : null;
}

function dispatchRequestIdentity(req, payload) {
  const headerSessionId = safeMetadataId(requestHeader(req, 'x-claude-code-session-id'));
  const sessionId = headerSessionId || sessionIdFromMetadata(payload && payload.metadata);
  if (!sessionId) return null;
  const agentId = safeMetadataId(requestHeader(req, 'x-claude-code-agent-id'));
  const parentAgentId = safeMetadataId(requestHeader(req, 'x-claude-code-parent-agent-id'));
  return {
    key: !agentId && parentAgentId ? null : JSON.stringify([sessionId, agentId]),
    parentKey: agentId && parentAgentId && agentId !== parentAgentId
      ? JSON.stringify([sessionId, parentAgentId])
      : null,
    sessionId,
    agentId,
    parentAgentId,
    sessionSource: headerSessionId ? 'header' : 'metadata',
  };
}

function routeMarkersInText(text, markers = []) {
  const matcher = new RegExp(ROUTE_MARKER_RE);
  let match;
  while ((match = matcher.exec(text))) markers.push({ model: match[2], effort: match[3] || null });
  return markers;
}

function onlyRoute(markers) {
  return markers.length === 1 ? markers[0] : null;
}

function dispatchRouteFromRawBody(raw) {
  return onlyRoute(routeMarkersInText(String(raw)));
}

function dispatchModelFromRawBody(raw) {
  const route = dispatchRouteFromRawBody(raw);
  return route ? route.model : null;
}

// The legitimate marker lives in the dispatch briefing, so only user-authored
// text counts. tool_result blocks can echo marker-shaped text from a fixture,
// log, or diff and must not influence the next request's route (SQ-375).
function dispatchRouteMarkersFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const markers = [];
  for (const message of messages) {
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') {
      routeMarkersInText(content, markers);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        routeMarkersInText(block.text, markers);
      }
    }
  }
  return markers;
}

function dispatchRouteFromMessages(messages) {
  return onlyRoute(dispatchRouteMarkersFromMessages(messages));
}

// ------------------------------------------------------------ model catalog
//
// sidequest (same marketplace) auto-discovers Codex models by reading this
// file: ~/.claude/model-gateway/catalog.json. Shape is a frozen contract
// (see plugins/sidequest/lib/discovery.js) — don't change it casually.

const CATALOG_PATH = path.join(STATE, 'catalog.json');
const CATALOG_STALE_MS = 5 * 60 * 1000;
const CATALOG_SCHEMA_VERSION = 4;

// Slugs keep the `codex-` backend name and so survive the id rename byte for
// byte: the board's route table pins slugs, and re-slugging would break every
// persisted route at once.
//
// Provider + base, dots→dashes, kept inside ^[a-z0-9][a-z0-9-]{1,31}$; on
// collision (or an over-length base) fall back to a short deterministic hash
// so the slug stays unique without depending on iteration order.
function slugFor(provider, base, used) {
  const providerPrefix = `${provider}-`;
  const providerBase = base.startsWith(providerPrefix) ? base.slice(providerPrefix.length) : base;
  let s = (providerPrefix + providerBase).toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9]/.test(s)) s = 'x' + s;
  if (s.length > 32) {
    const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);
    s = s.slice(0, 32 - 1 - hash.length) + '-' + hash;
  }
  let unique = s;
  let n = 2;
  while (used.has(unique)) {
    const suffix = '-' + n;
    unique = s.slice(0, Math.max(1, 32 - suffix.length)) + suffix;
    n++;
  }
  used.add(unique);
  return unique;
}

// "gpt-5.6-sol" -> "GPT-5.6 Sol", "gpt-5.3-codex-spark" -> "GPT-5.3 Codex Spark"
function labelFor(base) {
  const rest = base.replace(/^gpt-/, '');
  const m = rest.match(/^(\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (!m) return 'GPT-' + rest.replace(/-/g, ' ');
  const [, ver, suffix] = m;
  const suffixLabel = suffix
    ? ' ' + suffix.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : '';
  return `GPT-${ver}${suffixLabel}`;
}

function modelCatalogDetails(id) {
  const codexBase = codexBaseFromId(id);
  if (codexBase && codexBase !== 'auto') {
    return { provider: 'codex', base: codexBase, label: labelFor(codexBase) };
  }
  if (typeof id === 'string' && id.startsWith(GROK_PREFIX)) {
    const base = id.slice(PREFIX.length).replace(/\[1m\]$/, '');
    return { provider: 'grok', base, label: displayName(base, 'grok') };
  }
  return null;
}

function unavailableProviderReadiness(provider) {
  return {
    ready: false,
    state: 'unavailable',
    message: `${provider} readiness is unavailable.`,
  };
}

function getGrokReadiness({ readAuth = grokBackend.readGrokAuth } = {}) {
  try {
    readAuth();
    return {
      ready: true,
      state: 'ready',
      message: 'Grok CLI auth is present.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Grok CLI auth is unavailable. Run `grok` and log in again.';
    return {
      ready: false,
      state: /invalid/i.test(message) ? 'auth-invalid' : 'auth-missing',
      message,
    };
  }
}

function providerCatalogReadiness(provider, readiness) {
  const source = readiness?.[provider] ?? (provider === 'codex' ? readiness : null);
  if (source) return providerReadiness(source);
  if (provider === 'grok') return getGrokReadiness();
  return unavailableProviderReadiness(provider);
}

function buildCatalog(ids, readiness = null) {
  const used = new Set();
  const models = ids
    .map((id) => ({ id, details: modelCatalogDetails(id) }))
    .filter(({ details }) => details)
    .map(({ id, details }) => ({
      slug: slugFor(details.provider, details.base, used),
      id,
      label: details.label,
      provider: details.provider,
    }));
  const providers = Object.fromEntries(
    [...new Set(models.map((model) => model.provider))].map((provider) => [provider, providerCatalogReadiness(provider, readiness)]),
  );
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'model-gateway',
    updatedAt: new Date().toISOString(),
    writtenBy: PLUGIN_VERSION,
    providers,
    codexReadiness: providers.codex ?? null,
    models,
  };
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function catalogSchemaVersion(catalog) {
  if (!catalog || typeof catalog !== 'object') return null;
  const version = catalog.schemaVersion ?? catalog.schema;
  return Number.isInteger(version) && version > 0 ? version : null;
}

function catalogModelIds(catalog) {
  return new Set(
    Array.isArray(catalog?.models)
      ? catalog.models.filter((model) => typeof model?.id === 'string').map((model) => model.id)
      : [],
  );
}

function mergeSubsetCatalog(existing, catalog) {
  if (catalogSchemaVersion(existing) !== CATALOG_SCHEMA_VERSION || !Array.isArray(existing.models)) return catalog;

  const existingIds = catalogModelIds(existing);
  const fetchedIds = catalogModelIds(catalog);
  const isStrictSubset = fetchedIds.size < existingIds.size && [...fetchedIds].every((id) => existingIds.has(id));
  if (!isStrictSubset) return catalog;

  // A removal-only response is indistinguishable from a stale writer. Adding a model makes the response authoritative, so intentional replacement can still remove entries.
  const preserved = existing.models.filter((model) => typeof model?.id === 'string' && !fetchedIds.has(model.id));
  const models = [...catalog.models, ...preserved];
  const providers = { ...catalog.providers };
  for (const model of preserved) {
    if (typeof model.provider === 'string' && !providers[model.provider] && existing.providers?.[model.provider]) {
      providers[model.provider] = existing.providers[model.provider];
    }
  }
  log(`catalog: preserved ${preserved.map((model) => model.id).join(', ')} from a subset write`);
  return { ...catalog, models, providers, codexReadiness: providers.codex ?? null };
}

function writeCatalogFile(catalogPath, catalog) {
  const existing = readJsonFile(catalogPath);
  const storedVersion = catalogSchemaVersion(existing);
  if (storedVersion != null && storedVersion > CATALOG_SCHEMA_VERSION) {
    throw new Error(`refusing to overwrite catalog schema ${storedVersion} at ${catalogPath}; this gateway supports schema ${CATALOG_SCHEMA_VERSION}, upgrade required`);
  }
  const nextCatalog = mergeSubsetCatalog(existing, catalog);
  const tempPath = `${catalogPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(nextCatalog, null, 2) + '\n');
  fs.renameSync(tempPath, catalogPath);
  return nextCatalog;
}

async function fetchShimModelIds() {
  // the shim's own refreshModels() can still be mid-flight right after
  // /healthz starts answering; retry once, short, before giving up
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 });
    if (r.status !== 200) throw new Error(`shim /v1/models returned ${r.status}`);
    const ids = (JSON.parse(r.body.toString()).data || []).map((m) => m.id).filter((id) => modelCatalogDetails(id) != null);
    if (ids.length || attempt === 1) return ids;
    await new Promise((res) => setTimeout(res, 300));
  }
  return [];
}

async function writeCatalog() {
  const ids = await fetchShimModelIds();
  if (!ids.length) return null;
  const readiness = await getCodexReadiness();
  const catalog = buildCatalog(ids, readiness);
  mkdirs();
  return writeCatalogFile(CATALOG_PATH, catalog);
}

function readCatalog() {
  return readJsonFile(CATALOG_PATH);
}

async function catalogCommand() {
  const jsonOut = flag('--json');
  let catalog = readCatalog();
  const stale = !catalog || (Date.now() - Date.parse(catalog.updatedAt || 0) > CATALOG_STALE_MS);
  if (stale && (await shimHealthy())) {
    catalog = (await writeCatalog().catch(() => null)) || catalog;
  }
  if (!catalog) die('no catalog available yet (run setup or start first)');
  if (jsonOut) process.stdout.write(JSON.stringify(catalog) + '\n');
  else log(JSON.stringify(catalog, null, 2));
}

// dns.resolve4()/resolve6() query DNS directly and, unlike dns.lookup() (what
// http/https use by default), never consult the OS hosts file. That's exactly
// why this exists: RC-compatibility mode only works because the user's hosts
// file maps COMPAT_HOST to loopback, but that same mapping would make the
// shim's own "everything else -> real Anthropic" forward resolve right back
// to itself if it used the default resolver — infinite self-forwarding. A
// factory (not a module singleton) so tests can inject fake resolvers and get
// an isolated cache. On resolution failure this errors closed rather than
// falling back to dns.lookup(), which would silently recreate the recursion.
function createHostsBypassResolver({ resolve4, resolve6, ttlMs = 5 * 60 * 1000 } = {}) {
  const doResolve4 = resolve4 || dns.promises.resolve4;
  const doResolve6 = resolve6 || dns.promises.resolve6;
  let cache = { at: 0, value: null };
  async function resolve(hostname) {
    const now = Date.now();
    if (cache.value && now - cache.at < ttlMs) return cache.value;
    let result = null;
    try {
      const addrs = await doResolve4(hostname);
      if (addrs && addrs.length) result = { address: addrs[0], family: 4 };
    } catch { /* try AAAA below */ }
    if (!result) {
      try {
        const addrs = await doResolve6(hostname);
        if (addrs && addrs.length) result = { address: addrs[0], family: 6 };
      } catch { /* both failed */ }
    }
    if (result) { cache = { at: now, value: result }; return result; }
    return cache.value || null; // serve stale on a transient DNS blip rather than recurse
  }
  function lookup(hostname, options, callback) {
    resolve(hostname).then(
      (r) => (r
        ? callback(null, r.address, r.family)
        : callback(new Error(`model-gateway: could not resolve ${hostname} via DNS to bypass the hosts compatibility entry`))),
      callback,
    );
  }
  return { lookup, resolve };
}

function loopbackTelemetryEndpoint() {
  if (!ROUTE_TELEMETRY_ENABLED) return null;
  const explicit = process.env.CODEX_GATEWAY_TELEMETRY_ENDPOINT;
  if (explicit === '0') return null;
  let raw = explicit || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  let appendTracesPath = false;
  if (!raw && process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    appendTracesPath = true;
  }
  if (!raw) raw = 'http://127.0.0.1:4318/v1/traces';
  try {
    const endpoint = new URL(raw);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!loopback || !['http:', 'https:'].includes(endpoint.protocol)) return null;
    if (hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    if (appendTracesPath) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v1/traces`;
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint;
  } catch {
    return null;
  }
}

function parseIncomingTraceparent(headers) {
  if (!ROUTE_TELEMETRY_ENABLED) return null;
  const value = headers.traceparent;
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-[0-9a-f-]+)?$/.exec(value.trim());
  if (!match || match[1] === 'ff' || (match[1] === '00' && match[5])) return null;
  if (/^0{32}$/.test(match[2]) || /^0{16}$/.test(match[3])) return null;
  return { traceId: match[2], parentSpanId: match[3], flags: parseInt(match[4], 16) };
}

function safeMetadataId(value, maxLength = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return null;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(value) ? value : null;
}

function otlpAttribute(key, value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

function postRouteSpan(endpoint, span) {
  if (!endpoint) return;
  try {
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [otlpAttribute('service.name', 'model-gateway')] },
        scopeSpans: [{
          scope: { name: 'eigenwise.codex-gateway' },
          spans: [span],
        }],
      }],
    });
    const client = endpoint.protocol === 'https:' ? https : http;
    const telemetryReq = client.request(endpoint, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (telemetryRes) => telemetryRes.resume());
    telemetryReq.on('socket', (socket) => socket.unref());
    telemetryReq.on('error', () => {});
    telemetryReq.setTimeout(ROUTE_TELEMETRY_TIMEOUT_MS, () => telemetryReq.destroy());
    telemetryReq.end(body);
  } catch {}
}

function routeStatus(statusCode, override) {
  if (override) return override;
  if (!Number.isInteger(statusCode)) return 'upstream_error';
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  return 'ok';
}

function buildRouteTelemetry(req) {
  const endpoint = loopbackTelemetryEndpoint();
  if (!endpoint) return { setRoute() {}, finish() {} };
  const incoming = parseIncomingTraceparent(req.headers);
  const traceId = incoming?.traceId || crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const parentSpanId = incoming?.parentSpanId || null;
  const routeId = crypto.randomUUID();
  const sessionId = safeMetadataId(requestHeader(req, 'x-claude-code-session-id'));
  const startedAt = BigInt(Date.now()) * 1000000n;
  const started = process.hrtime.bigint();
  let route = {};
  let finished = false;
  return {
    setRoute(nextRoute) {
      route = { ...nextRoute };
    },
    finish(statusCode, statusOverride = null) {
      if (finished) return;
      finished = true;
      try {
        const elapsed = process.hrtime.bigint() - started;
        const durationMs = Number(elapsed) / 1000000;
        const status = routeStatus(statusCode, statusOverride);
        const attributes = [
          otlpAttribute('source', 'codex-gateway'),
          otlpAttribute('source_event_id', routeId),
          otlpAttribute('source_schema', '1'),
          otlpAttribute('event_name', 'codex_gateway.route'),
          otlpAttribute('route_id', routeId),
          otlpAttribute('trace_id', traceId),
          otlpAttribute('span_id', spanId),
          otlpAttribute('parent_span_id', parentSpanId),
          otlpAttribute('trace_linked', !!incoming),
          otlpAttribute('session_id', sessionId),
          otlpAttribute('selected_model', safeMetadataId(route.selectedModel)),
          otlpAttribute('effective_model', safeMetadataId(route.effectiveModel)),
          otlpAttribute('backend', ['codex', 'anthropic'].includes(route.backend) ? route.backend : null),
          otlpAttribute('effort', ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort) ? route.effort : null),
          otlpAttribute('fallback', route.fallback === true),
          otlpAttribute('via', ['direct', 'dispatch', 'dispatch-cached'].includes(route.via) ? route.via : null),
          otlpAttribute('status', status),
          otlpAttribute('status_code', Number.isInteger(statusCode) ? statusCode : null),
          otlpAttribute('duration_ms', durationMs),
        ].filter(Boolean);
        const endedAt = startedAt + elapsed;
        postRouteSpan(endpoint, {
          traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          ...(incoming ? { flags: incoming.flags } : {}),
          name: 'codex-gateway.route',
          kind: 2,
          startTimeUnixNano: startedAt.toString(),
          endTimeUnixNano: endedAt.toString(),
          attributes,
          events: [{ timeUnixNano: endedAt.toString(), name: 'codex-gateway.route', attributes }],
          status: { code: status === 'ok' ? 1 : 2 },
        });
      } catch {}
    },
  };
}

function createRouteTelemetry(req) {
  try {
    return buildRouteTelemetry(req);
  } catch {
    return { setRoute() {}, finish() {} };
  }
}

function requestHeader(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}


function runWorker() {
  process.once('disconnect', () => process.exit(0));
  let modelCache = {
    at: 0,
    data: [...DEFAULT_MODELS, ...(LIST_DISPATCH_MODEL ? ['auto'] : [])].map(gatewayModel),
  };
  const counters = { models: 0, codex: 0, grok: 0, anthropic: 0 };
  const dispatchRoutes = new DispatchSessionRouteCache({ cachePath: DISPATCH_ROUTE_CACHE_PATH });
  const usageEmitter = createGatewayUsageEmitter();
  const settingsWiring = wiredMode();
  if (ourBaseUrls().includes(process.env.ANTHROPIC_BASE_URL) && !settingsWiring) {
    console.error('model-gateway: ANTHROPIC_BASE_URL is shell-only; wire it through local .claude/settings.local.json or global settings so background sessions stay metered');
  }
  const sentrySessions = new Map();
  const compactTriggerIsFixed = Number.isFinite(configuredCompactTrigger) && configuredCompactTrigger > 0;
  let compactTrigger = CODEX_COMPACT_TRIGGER;
  let observedCeiling = null;
  // hostsDetected drives the DNS-bypass decision below regardless of whether
  // this process itself managed to bind the compat port; the OS hosts file is
  // machine-wide and would misdirect the passthrough forward either way.
  const compatState = { hostsDetected: false, hostsLine: null, port80Bound: false, reason: null };
  const servers = new Set();
  let draining = false;
  let activeRequests = 0;
  const anthropicBypass = createHostsBypassResolver();

  function beginDrain() {
    let remaining = servers.size;
    if (remaining === 0) return process.exit(0);
    for (const server of servers) {
      server.close(() => {
        remaining -= 1;
        if (remaining === 0) process.exit(0);
      });
      server.closeIdleConnections?.();
    }
  }

  function trackInFlight(res) {
    activeRequests += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests -= 1;
      if (draining && activeRequests === 0) {
        for (const server of servers) server.closeAllConnections?.();
      }
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  function requestSessionId(req) {
    const sessionId = req.headers['x-claude-code-session-id'];
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  }

  // A local audit trail for which model went where. This is intentionally a
  // small, fixed schema, never a dump of the request: prompts, messages, tools,
  // auth, and arbitrary headers are all excluded. Keep only Claude Code's safe
  // session/agent correlation values and whether the session came from its
  // canonical header or metadata fallback.
  function requestRouteLog(req, backend, model, pathOnly, via = null, effort = null, identity = null, markersLength = null, inheritedFromAgentId = null) {
    if (!REQUEST_ROUTE_LOG) return;
    const sessionId = identity?.sessionId || requestSessionId(req);
    const entry = {
      at: new Date().toISOString(),
      backend,
      model: typeof model === 'string' ? model : null,
      path: pathOnly,
      ...(via ? { via } : {}),
      ...(effort ? { effort } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(identity?.agentId ? { agentId: identity.agentId } : {}),
      ...(identity?.parentAgentId ? { parentAgentId: identity.parentAgentId } : {}),
      ...(inheritedFromAgentId ? { inheritedFromAgentId } : {}),
      ...(identity?.sessionSource ? { sessionSource: identity.sessionSource } : {}),
      ...(Number.isInteger(markersLength) ? { markersLength } : {}),
    };
    try {
      mkdirs();
      fs.appendFileSync(REQUEST_ROUTE_LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error(`model-gateway: could not write request route log: ${error.code || error.message}`);
    }
  }

  function codexSessionId(req) {
    return CODEX_SENTRY_ENABLED ? requestSessionId(req) : null;
  }

  function sentrySession(sessionId) {
    if (!sessionId) return null;
    let state = sentrySessions.get(sessionId);
    if (!state) {
      state = { usage: 0, fired: false };
      sentrySessions.set(sessionId, state);
    }
    return state;
  }

  function recordSentryUsage(sessionId, event) {
    if (!sessionId || event.type !== 'message_delta' || !event.usage) return;
    const usage = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .reduce((total, field) => total + (Number.isFinite(event.usage[field]) ? event.usage[field] : 0), 0);
    if (usage <= 0) return;
    const state = sentrySession(sessionId);
    state.usage = usage;
    const lowWatermark = compactTrigger - Math.min(CODEX_COMPACT_HEADROOM, compactTrigger * 0.25);
    if (usage < lowWatermark) state.fired = false;
  }

  function contextOverflowBody(actualTokens, maxTokens, prefix) {
    return JSON.stringify({
      type: 'error',
      error: {
        type: 'request_too_large',
        message: `${prefix} (${actualTokens} tokens > ${maxTokens} tokens)`,
      },
    });
  }

  function fireContextSentry(res, sessionId) {
    const state = sentrySession(sessionId);
    if (!state || state.fired || state.usage <= compactTrigger) return false;
    state.fired = true;
    const body = contextOverflowBody(state.usage, compactTrigger,
      'Prompt is too long for the Codex context window; compact and retry.');
    res.writeHead(413, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  }

  function noteGenuineOverflow(sessionId) {
    const state = sentrySession(sessionId);
    const usage = state?.usage || 0;
    if (state) state.fired = true;
    if (!compactTriggerIsFixed && usage > CODEX_COMPACT_HEADROOM) {
      observedCeiling = observedCeiling == null ? usage : Math.min(observedCeiling, usage);
      compactTrigger = Math.max(1, observedCeiling - CODEX_COMPACT_HEADROOM);
    }
    return usage;
  }

  function normalizeGenuineContextOverflow(body, sessionId) {
    const text = body.toString();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return body; }
    if (parsed?.error?.type !== 'request_too_large' || typeof parsed.error.message !== 'string') return body;
    const usage = noteGenuineOverflow(sessionId);
    if (/\d+\s+tokens\s*>\s*\d+\s+tokens/i.test(text)) return body;
    const maxTokens = CODEX_COMPACT_CONTEXT_WINDOW;
    const actualTokens = usage || maxTokens + 1;
    parsed.error.message += ` (${actualTokens} tokens > ${maxTokens} tokens)`;
    return Buffer.from(JSON.stringify(parsed));
  }

  async function refreshModels() {
    let ids = null;
    try {
      const r = await fetchUrl(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { timeout: 2500 });
      if (r.status === 200) {
        ids = (JSON.parse(r.body.toString()).data || []).map((m) => m.id).filter((id) => /^gpt-/.test(id));
        if (!ids.length) ids = null;
      }
    } catch { /* proxy down or no such route */ }
    if (!ids) {
      try { ids = JSON.parse(fs.readFileSync(path.join(STATE, 'models.json'), 'utf8')); } catch { /* absent */ }
    }
    // Advertising an id the router can't claim back would hand it to
    // api.anthropic.com, so a local models.json is held to the same family rule.
    if (Array.isArray(ids)) ids = ids.filter((id) => typeof id === 'string' && (id === 'auto' || CODEX_FAMILY_RE.test(id)));
    if (!Array.isArray(ids) || !ids.length) ids = DEFAULT_MODELS;
    const grokIds = grokBackend.grokModelIdsFromCache();
    modelCache = {
      at: Date.now(),
      data: [
        ...[...ids.filter((id) => id !== 'auto'), ...(LIST_DISPATCH_MODEL ? ['auto'] : [])].map((id) => gatewayModel(id)),
        ...[...(grokIds.length ? grokIds : DEFAULT_GROK_MODELS)].map((id) => gatewayModel(id, 'grok')),
      ],
    };
  }
  refreshModels();

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  function filterPlanToolBlock(block) {
    return block && block.type === 'tool_use' && PLAN_TOOLS.includes(block.name);
  }

  function renderCodexToolReferences(content, referencedTools) {
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (!block || typeof block !== 'object') return block;
      if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
        referencedTools.add(block.tool_name);
        return { type: 'text', text: `Tool reference: ${block.tool_name}` };
      }
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      return { ...block, content: renderCodexToolReferences(block.content, referencedTools) };
    });
  }

  function resolveCodexDeferredTools(request) {
    const referencedTools = new Set();
    if (Array.isArray(request.messages)) {
      request.messages = request.messages.map((message) => {
        if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return message;
        return { ...message, content: renderCodexToolReferences(message.content, referencedTools) };
      });
    }
    if (!Array.isArray(request.tools)) return;
    request.tools = request.tools.flatMap((tool) => {
      if (!tool || typeof tool !== 'object') return [tool];
      if (tool.defer_loading === true && !referencedTools.has(tool.name)) return [];
      if (!Object.prototype.hasOwnProperty.call(tool, 'defer_loading')) return [tool];
      const loadedTool = { ...tool };
      delete loadedTool.defer_loading;
      return [loadedTool];
    });
  }

  function rewriteResponseModel(value, advertisedModel) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      for (const item of value) rewriteResponseModel(item, advertisedModel);
      return value;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'model' && typeof item === 'string' && item.startsWith('gpt-')) value[key] = advertisedModel;
      else rewriteResponseModel(item, advertisedModel);
    }
    return value;
  }

  function rewriteCodexJson(body, advertisedModel, filterPlanTools) {
    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { return body; }
    rewriteResponseModel(parsed, advertisedModel);
    if (filterPlanTools && Array.isArray(parsed.content)) {
      const content = parsed.content.filter((block) => !filterPlanToolBlock(block));
      if (content.length !== parsed.content.length) {
        parsed.content = content;
        if (parsed.stop_reason === 'tool_use' && !content.some((block) => block && block.type === 'tool_use')) {
          parsed.stop_reason = 'end_turn';
        }
      }
    }
    return Buffer.from(JSON.stringify(parsed));
  }

  function isWebSocketUpgradeRejection(statusCode, body) {
    if (statusCode !== 403) return false;
    try {
      const error = JSON.parse(body.toString()).error;
      return error?.type === 'permission_error' && error.message === 'WebSocket upgrade was rejected';
    } catch { return false; }
  }

  function transientWebSocketUpgradeError(attempts) {
    return Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: `model-gateway: Codex WebSocket upgrade was temporarily rejected after ${attempts} attempts; retry the request.`,
      },
    }));
  }

  function createCodexSseTransformer(write, observe, advertisedModel, filterPlanTools) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const dropped = new Set();
    let droppedCount = 0;
    let keptToolUse = false;

    function transformFrame(frame, separator) {
      const lines = frame.split(/\r?\n/);
      const dataLine = lines.findIndex((line) => line.startsWith('data:'));
      if (dataLine < 0) return write(frame + separator);
      const raw = lines[dataLine].slice(5).trimStart();
      if (!raw || raw === '[DONE]') return write(frame + separator);
      let event;
      try { event = JSON.parse(raw); } catch { return write(frame + separator); }
      if (observe) observe(event);
      rewriteResponseModel(event, advertisedModel);

      const originalIndex = Number.isInteger(event.index) ? event.index : null;
      if (filterPlanTools && event.type === 'content_block_start' && originalIndex != null) {
        if (filterPlanToolBlock(event.content_block)) {
          dropped.add(originalIndex);
          droppedCount++;
          return;
        }
        if (event.content_block && event.content_block.type === 'tool_use') keptToolUse = true;
      }
      if (filterPlanTools && originalIndex != null && dropped.has(originalIndex)) return;
      if (filterPlanTools && originalIndex != null) event.index = originalIndex - droppedCount;
      if (filterPlanTools && event.type === 'message_delta' && event.delta && event.delta.stop_reason === 'tool_use'
          && droppedCount > 0 && !keptToolUse) {
        event.delta.stop_reason = 'end_turn';
      }
      lines[dataLine] = `data: ${JSON.stringify(event)}`;
      write(lines.join('\n') + separator);
    }

    return {
      write(chunk) {
        pending += decoder.write(chunk);
        for (;;) {
          const match = /\r?\n\r?\n/.exec(pending);
          if (!match) break;
          const frame = pending.slice(0, match.index);
          const separator = match[0];
          pending = pending.slice(match.index + separator.length);
          transformFrame(frame, separator);
        }
      },
      end() {
        pending += decoder.end();
        if (pending) transformFrame(pending, '');
      },
    };
  }

  function createSseEventObserver(observe, maxPendingBytes = 4 * 1024 * 1024, onOverflow = null) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let overflowed = false;

    function inspectFrame(frame) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
      if (!dataLine) return;
      const raw = dataLine.slice(5).trimStart();
      if (!raw || raw === '[DONE]') return;
      try { observe(JSON.parse(raw)); } catch { /* pass malformed upstream data through untouched */ }
    }

    function overflowIfNeeded() {
      if (Buffer.byteLength(pending) <= maxPendingBytes) return false;
      pending = '';
      overflowed = true;
      try { onOverflow?.(); } catch {}
      return true;
    }

    return {
      write(chunk) {
        if (overflowed) return;
        pending += decoder.write(chunk);
        if (overflowIfNeeded()) return;
        for (;;) {
          const match = /\r?\n\r?\n/.exec(pending);
          if (!match) break;
          inspectFrame(pending.slice(0, match.index));
          pending = pending.slice(match.index + match[0].length);
        }
      },
      end() {
        if (overflowed) return;
        pending += decoder.end();
        if (!overflowIfNeeded() && pending) inspectFrame(pending);
      },
    };
  }

  function observeSse(upRes, observer, contentEncoding, onChunk, onDecodeFailure, onEnd = () => {}) {
    const decompressor = {
      br: zlib.createBrotliDecompress,
      deflate: zlib.createInflate,
      gzip: zlib.createGunzip,
    }[String(contentEncoding || '').toLowerCase().trim()];
    if (!decompressor) {
      upRes.on('data', (chunk) => {
        onChunk(chunk);
        observer.write(chunk);
      });
      upRes.on('end', () => {
        observer.end();
        onEnd();
      });
      return;
    }
    const decoded = decompressor();
    upRes.on('data', onChunk);
    decoded.on('data', (chunk) => observer.write(chunk));
    decoded.on('end', () => {
      observer.end();
      onEnd();
    });
    decoded.on('error', () => {
      onDecodeFailure();
      onEnd();
    });
    upRes.pipe(decoded);
  }

  function keepSseAlive(upRes, clientRes) {
    if (!SSE_HEARTBEAT_MS) return;
    let timer = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (clientRes.destroyed || !clientRes.writable) return stop();
        clientRes.write(': ping\n\n');
        arm();
      }, SSE_HEARTBEAT_MS);
    };
    upRes.on('data', arm);
    upRes.once('end', stop);
    upRes.once('error', stop);
    upRes.once('aborted', stop);
    clientRes.once('close', stop);
    arm();
  }

  function forward(clientReq, clientRes, target, body, extraHeaderDrop = [], normalizeContextErrors = false, filterPlanTools = false, sessionId = null, advertisedModel = null, routeTelemetry = null, usageCapture = null, webSocketUpgradeRetries = 0, compactGuard = null) {
    const url = new URL(clientReq.url, target);
    let finishUsage = () => usageCapture?.finish();
    if (usageCapture) clientRes.once('finish', () => finishUsage());
    const isHttps = url.protocol === 'https:';
    const headers = { ...clientReq.headers };
    for (const h of ['host', 'connection', 'content-length', 'keep-alive', ...TRACE_HEADERS, ...extraHeaderDrop]) delete headers[h];
    if (body != null) headers['content-length'] = Buffer.byteLength(body);
    const reqOptions = {
      method: clientReq.method,
      headers,
      agent: isHttps ? httpsAgent : httpAgent,
    };
    // Only the real-Anthropic passthrough target can recurse into this shim
    // (the proxy target is always a bare 127.0.0.1 address, never affected).
    if (compatState.hostsDetected && url.hostname.toLowerCase() === COMPAT_HOST) {
      reqOptions.lookup = anthropicBypass.lookup;
    }
    const upReq = (isHttps ? https : http).request(url, reqOptions, (upRes) => {
      const resHeaders = { ...upRes.headers };
      for (const h of ['transfer-encoding', 'connection', 'keep-alive']) delete resHeaders[h];
      // A compaction retry already committed the SSE status line on an earlier
      // attempt, so no later attempt may write one. Report the real upstream
      // status and message in-band instead of crashing on ERR_HTTP_HEADERS_SENT.
      const successful2xx = upRes.statusCode >= 200 && upRes.statusCode < 300;
      if (normalizeContextErrors && successful2xx) noteCodexRequestSuccess();
      const streamedContentType = String(upRes.headers['content-type'] || '').toLowerCase().includes('text/event-stream');
      if (compactGuard?.headWritten && !(successful2xx && streamedContentType)) {
        usageCapture?.setResponse(upRes.statusCode, upRes.headers);
        const chunks = [];
        let reported = false;
        const report = () => {
          if (reported) return;
          reported = true;
          routeTelemetry?.finish(upRes.statusCode);
          // The status line is gone but the sentry's learned ceiling is not.
          if (normalizeContextErrors && CODEX_SENTRY_ENABLED && upRes.statusCode === 413) noteGenuineOverflow(sessionId);
          if (normalizeContextErrors) noteCodexUpstreamRejection(upRes.statusCode, upRes.headers, Buffer.concat(chunks));
          clientRes.write(sseErrorFrame('api_error', upstreamErrorMessage(Buffer.concat(chunks), upRes.statusCode)));
          clientRes.end();
        };
        upRes.on('data', (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          chunks.push(chunk);
        });
        upRes.on('end', report);
        upRes.on('error', report);
        upRes.on('aborted', report);
        return;
      }
      if (normalizeContextErrors && upRes.statusCode === 403) {
        const chunks = [];
        upRes.on('data', (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          chunks.push(chunk);
        });
        upRes.on('error', () => clientRes.destroy());
        upRes.on('aborted', () => clientRes.destroy());
        upRes.on('end', () => {
          const upstreamBody = Buffer.concat(chunks);
          if (!isWebSocketUpgradeRejection(upRes.statusCode, upstreamBody)) {
            noteCodexUpstreamRejection(upRes.statusCode, upRes.headers, upstreamBody);
            usageCapture?.setResponse(upRes.statusCode, upRes.headers);
            routeTelemetry?.finish(upRes.statusCode);
            const rewritten = rewriteCodexJson(upstreamBody, advertisedModel, false);
            resHeaders['content-length'] = rewritten.length;
            clientRes.writeHead(upRes.statusCode, resHeaders);
            return clientRes.end(rewritten);
          }
          if (webSocketUpgradeRetries < WEBSOCKET_UPGRADE_RETRIES) {
            return setTimeout(() => forward(clientReq, clientRes, target, body, extraHeaderDrop,
              normalizeContextErrors, filterPlanTools, sessionId, advertisedModel, routeTelemetry,
              usageCapture, webSocketUpgradeRetries + 1, compactGuard), WEBSOCKET_UPGRADE_RETRY_DELAY_MS);
          }
          const transientError = transientWebSocketUpgradeError(webSocketUpgradeRetries + 1);
          usageCapture?.setResponse(503, resHeaders);
          routeTelemetry?.finish(503, 'upstream_error');
          resHeaders['content-length'] = transientError.length;
          clientRes.writeHead(503, resHeaders);
          clientRes.end(transientError);
        });
        return;
      }
      usageCapture?.setResponse(upRes.statusCode, upRes.headers);
      upRes.once('end', () => routeTelemetry?.finish(upRes.statusCode));
      upRes.once('aborted', () => routeTelemetry?.finish(upRes.statusCode, 'upstream_aborted'));
      upRes.once('error', () => routeTelemetry?.finish(upRes.statusCode, 'upstream_error'));
      if (normalizeContextErrors && CODEX_SENTRY_ENABLED && upRes.statusCode === 413) {
        const chunks = [];
        let settled = false;
        const failBufferedResponse = () => {
          if (settled) return;
          settled = true;
          if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'model-gateway shim: upstream response ended early' },
          }));
        };
        upRes.on('data', (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          chunks.push(chunk);
        });
        upRes.on('error', failBufferedResponse);
        upRes.on('aborted', failBufferedResponse);
        upRes.on('end', () => {
          if (settled) return;
          settled = true;
          const normalized = rewriteCodexJson(normalizeGenuineContextOverflow(Buffer.concat(chunks), sessionId), advertisedModel, false);
          resHeaders['content-length'] = normalized.length;
          clientRes.writeHead(413, resHeaders);
          clientRes.end(normalized);
        });
        return;
      }
      // Older proxies may signal overflow with a differently-shaped 4xx/5xx.
      // Buffer only those failures and normalize them to request_too_large.
      if (normalizeContextErrors && upRes.statusCode >= 400 && upRes.statusCode !== 413) {
        const chunks = [];
        let settled = false;
        const failBufferedResponse = () => {
          if (settled) return;
          settled = true;
          if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'model-gateway shim: upstream response ended early' },
          }));
        };
        upRes.on('data', (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          chunks.push(chunk);
        });
        upRes.on('error', failBufferedResponse);
        upRes.on('aborted', failBufferedResponse);
        upRes.on('end', () => {
          if (settled) return;
          settled = true;
          const upstreamBody = rewriteCodexJson(Buffer.concat(chunks), advertisedModel, false);
          noteCodexUpstreamRejection(upRes.statusCode, upRes.headers, upstreamBody);
          const text = upstreamBody.toString();
          if (/context window|context length|input exceeds|prompt token count|too many tokens/i.test(text)) {
            const normalized = CODEX_SENTRY_ENABLED
              ? contextOverflowBody(noteGenuineOverflow(sessionId) || CODEX_COMPACT_CONTEXT_WINDOW + 1,
                CODEX_COMPACT_CONTEXT_WINDOW, 'Input exceeds the model context window; compact and retry.')
              : JSON.stringify({
                type: 'error',
                error: { type: 'request_too_large', message: 'Input exceeds the model context window; compact and retry.' },
              });
            clientRes.writeHead(413, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(normalized),
              'x-model-gateway-upstream-status': String(upRes.statusCode),
            });
            return clientRes.end(normalized);
          }
          resHeaders['content-length'] = upstreamBody.length;
          clientRes.writeHead(upRes.statusCode, resHeaders);
          clientRes.end(upstreamBody);
        });
        return;
      }
      if (advertisedModel && upRes.statusCode >= 400) {
        const chunks = [];
        upRes.on('data', (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          chunks.push(chunk);
        });
        upRes.on('error', () => clientRes.destroy());
        upRes.on('aborted', () => clientRes.destroy());
        upRes.on('end', () => {
          const rewritten = rewriteCodexJson(Buffer.concat(chunks), advertisedModel, false);
          resHeaders['content-length'] = rewritten.length;
          clientRes.writeHead(upRes.statusCode, resHeaders);
          clientRes.end(rewritten);
        });
        return;
      }
      if (advertisedModel && upRes.statusCode >= 200 && upRes.statusCode < 300) {
        const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
        delete resHeaders['content-length'];
        if (contentType.includes('text/event-stream')) {
          if (!compactGuard?.headWritten) clientRes.writeHead(upRes.statusCode, resHeaders);
          if (compactGuard) compactGuard.headWritten = true;
          keepSseAlive(upRes, clientRes);
          const attempt = compactGuard
            ? { chunks: [], bytes: 0, terminal: false, fatal: false, sawError: false, degraded: false }
            : null;
          const observeEvent = (attempt || filterPlanTools || (CODEX_SENTRY_ENABLED && sessionId) || usageCapture)
            ? (event) => {
              if (attempt) noteCompactEvent(attempt, event);
              if (filterPlanTools || (CODEX_SENTRY_ENABLED && sessionId)) recordSentryUsage(sessionId, event);
              usageCapture?.observeEvent(event);
            }
            : null;
          const emit = attempt
            ? (chunk) => {
              if (attempt.degraded) return clientRes.write(chunk);
              attempt.chunks.push(chunk);
              attempt.bytes += Buffer.byteLength(chunk);
              if (attempt.bytes <= COMPACT_STREAM_MAX_BYTES) return;
              // Far past any real summary; keep the turn alive rather than
              // hoard it, and say plainly that retry cover is gone.
              console.error(`model-gateway: compaction response passed ${COMPACT_STREAM_MAX_BYTES} buffered bytes; streaming the remainder live without retry cover`);
              attempt.degraded = true;
              for (const buffered of attempt.chunks) clientRes.write(buffered);
              attempt.chunks.length = 0;
            }
            : (chunk) => clientRes.write(chunk);
          const filter = createCodexSseTransformer(emit, observeEvent, advertisedModel, filterPlanTools);
          upRes.on('data', (chunk) => {
            usageCapture?.noteResponseBytes(chunk.length);
            filter.write(chunk);
          });
          if (!attempt) {
            upRes.on('end', () => { filter.end(); clientRes.end(); });
            upRes.on('error', () => clientRes.destroy());
            upRes.on('aborted', () => clientRes.destroy());
            return;
          }
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            filter.end();
            if (clientRes.destroyed || !clientRes.writable) return;
            const recoverable = !attempt.terminal && !attempt.fatal && !attempt.degraded;
            if (recoverable && compactGuard.attempts < COMPACT_STREAM_RETRIES) {
              compactGuard.attempts++;
              upRes.destroy();
              return setTimeout(() => forward(clientReq, clientRes, target, body, extraHeaderDrop,
                normalizeContextErrors, filterPlanTools, sessionId, advertisedModel, routeTelemetry,
                usageCapture, webSocketUpgradeRetries, compactGuard), COMPACT_STREAM_RETRY_DELAY_MS);
            }
            for (const buffered of attempt.chunks) clientRes.write(buffered);
            if (!attempt.terminal && !attempt.sawError) {
              const attempts = compactGuard.attempts + 1;
              clientRes.write(sseErrorFrame('api_error',
                `model-gateway: the Codex compaction stream ended without a terminal message_stop event after ${attempts} attempt(s); the summary above is incomplete`));
            }
            clientRes.end();
          };
          upRes.on('end', settle);
          upRes.on('error', settle);
          upRes.on('aborted', settle);
          return;
        }
        const chunks = [];
        upRes.on('data', (chunk) => chunks.push(chunk));
        upRes.on('error', () => clientRes.destroy());
        upRes.on('aborted', () => clientRes.destroy());
        upRes.on('end', () => {
          const upstreamBody = Buffer.concat(chunks);
          usageCapture?.observeJson(upstreamBody);
          const filtered = rewriteCodexJson(upstreamBody, advertisedModel, filterPlanTools);
          resHeaders['content-length'] = filtered.length;
          clientRes.writeHead(upRes.statusCode, resHeaders);
          clientRes.end(filtered);
        });
        return;
      }
      const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
      const successful = upRes.statusCode >= 200 && upRes.statusCode < 300;
      clientRes.writeHead(upRes.statusCode, resHeaders);
      if (successful && contentType.includes('text/event-stream')) {
        if (normalizeContextErrors) keepSseAlive(upRes, clientRes);
        const observeSentry = normalizeContextErrors && CODEX_SENTRY_ENABLED && sessionId;
        if (observeSentry || usageCapture) {
          const observer = createSseEventObserver(
            (event) => {
              if (observeSentry) recordSentryUsage(sessionId, event);
              usageCapture?.observeEvent(event);
            },
            usageEmitter.maxResponseBytes,
            () => usageCapture?.markOverflow(),
          );
          let clientFinished = false;
          let observationFinished = false;
          const completeUsage = () => {
            observationFinished = true;
            if (clientFinished) usageCapture?.finish();
          };
          finishUsage = () => {
            clientFinished = true;
            if (observationFinished) usageCapture?.finish();
          };
          observeSse(
            upRes,
            observer,
            upRes.headers['content-encoding'],
            (chunk) => usageCapture?.noteResponseBytes(chunk.length),
            () => usageCapture?.markOverflow(),
            completeUsage,
          );
        }
      } else if (successful && usageCapture) {
        upRes.on('data', (chunk) => usageCapture.observeChunk(chunk));
      } else if (usageCapture) {
        upRes.on('data', (chunk) => usageCapture.noteResponseBytes(chunk.length));
      }
      upRes.pipe(clientRes); // never buffer successful SSE: Claude Code needs the stream live
    });
    upReq.setTimeout(3600000, () => upReq.destroy(new Error('upstream timeout')));
    upReq.on('error', (e) => {
      routeTelemetry?.finish(502, 'upstream_error');
      if (clientRes.headersSent) return clientRes.destroy();
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `model-gateway shim: upstream ${url.origin} failed: ${e.message}` },
      }));
    });
    if (body != null) upReq.end(body);
    else clientReq.pipe(upReq);
  }

  async function forwardGrok(clientReq, clientRes, payload, model, advertisedModel, routeTelemetry, usageCapture) {
    let token;
    try {
      token = await grokBackend.grokAccessToken();
    } catch (error) {
      const body = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `model-gateway: ${error.message}` } });
      routeTelemetry?.finish(401, 'authentication_error');
      clientRes.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      clientRes.end(body);
      return;
    }
    const upstreamPayload = grokBackend.translateRequest(payload, model);
    const body = JSON.stringify(upstreamPayload);
    const target = new URL(GROK_ENDPOINT);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'POST',
      headers: { ...grokBackend.grokHeaders(token, model), 'content-length': Buffer.byteLength(body) },
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
    }, (upstream) => {
      const responseHeaders = { ...upstream.headers };
      for (const header of ['transfer-encoding', 'connection', 'keep-alive']) delete responseHeaders[header];
      const streamed = String(upstream.headers['content-type'] || '').toLowerCase().includes('text/event-stream');
      usageCapture?.setResponse(upstream.statusCode, upstream.headers);
      upstream.once('end', () => routeTelemetry?.finish(upstream.statusCode));
      upstream.once('error', () => routeTelemetry?.finish(upstream.statusCode, 'upstream_error'));
      if (upstream.statusCode === 426) {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          const message = 'model-gateway: Grok CLI version header is outdated. Update the grok CLI, then retry.';
          const errorBody = JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
          clientRes.writeHead(426, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errorBody) });
          clientRes.end(errorBody);
        });
        return;
      }
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          let detail = `Grok upstream returned ${upstream.statusCode}`;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            detail = parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : detail);
          } catch {}
          const errorBody = JSON.stringify({ type: 'error', error: { type: upstream.statusCode === 401 ? 'authentication_error' : 'api_error', message: `model-gateway: ${detail}` } });
          clientRes.writeHead(upstream.statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errorBody) });
          clientRes.end(errorBody);
        });
        return;
      }
      delete responseHeaders['content-length'];
      if (streamed) {
        clientRes.writeHead(upstream.statusCode, { ...responseHeaders, 'content-type': 'text/event-stream' });
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const transformer = grokBackend.createGrokSseTransformer((frame) => clientRes.write(frame), advertisedModel);
        const consume = (chunk) => {
          usageCapture?.noteResponseBytes(chunk.length);
          pending += decoder.write(chunk);
          for (;;) {
            const match = /\r?\n\r?\n/.exec(pending);
            if (!match) break;
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              transformer.event(event);
              if (event?.response?.usage) usageCapture?.observeEvent({ type: 'message_delta', usage: grokBackend.anthropicUsage(event.response.usage) });
            } catch {}
          }
        };
        upstream.on('data', consume);
        upstream.on('end', () => { pending += decoder.end(); transformer.end(); clientRes.end(); });
        upstream.on('error', () => clientRes.destroy());
        return;
      }
      const chunks = [];
      upstream.on('data', (chunk) => { usageCapture?.noteResponseBytes(chunk.length); chunks.push(chunk); });
      upstream.on('end', () => {
        let response;
        try { response = JSON.parse(Buffer.concat(chunks).toString()); } catch { response = null; }
        const translated = grokBackend.translateResponse(response, advertisedModel);
        const translatedBody = Buffer.from(JSON.stringify(translated));
        usageCapture?.observeJson(translatedBody);
        clientRes.writeHead(upstream.statusCode, { ...responseHeaders, 'content-type': 'application/json', 'content-length': translatedBody.length });
        clientRes.end(translatedBody);
      });
      upstream.on('error', () => clientRes.destroy());
    });
    request.setTimeout(3600000, () => request.destroy(new Error('Grok upstream timeout')));
    request.on('error', (error) => {
      routeTelemetry?.finish(502, 'upstream_error');
      if (clientRes.headersSent) return clientRes.destroy();
      const errorBody = JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-gateway: Grok upstream failed: ${error.message}` } });
      clientRes.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errorBody) });
      clientRes.end(errorBody);
    });
    request.end(body);
  }

  function handleRequest(req, res) {
    const pathOnly = req.url.split('?')[0];

    if (req.method === 'POST' && pathOnly === '/drain') {
      draining = true;
      res.once('finish', () => setImmediate(beginDrain));
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draining, activeRequests }));
      return;
    }

    if (draining && pathOnly !== '/healthz') {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model-gateway shim is restarting; retry this request shortly' } }));
    }

    if (pathOnly !== '/healthz') trackInFlight(res);

    if (pathOnly === '/healthz') {
      const health = {
        ok: true,
        version: PLUGIN_VERSION,
        models: modelCache.data.length,
        served: counters,
        draining,
        activeRequests,
        compat: { ...compatState },
        compaction: {
          streamGuard: COMPACT_STREAM_GUARD,
          retries: COMPACT_STREAM_RETRIES,
          maxBufferedBytes: COMPACT_STREAM_MAX_BYTES,
        },
        usage: {
          enabled: usageEmitter.enabled,
          endpoint: usageEmitter.endpoint,
          maxResponseBytes: usageEmitter.maxResponseBytes,
          settingsLevelBaseUrl: !!settingsWiring,
        },
      };
      getCodexReadiness({ shimHealth: health }).then((readiness) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...health, codexReadiness: catalogReadiness(readiness) }));
      }).catch((error) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }

    if (req.method === 'GET' && pathOnly === '/v1/models') {
      counters.models++;
      if (Date.now() - modelCache.at > 60000) refreshModels(); // serve stale, refresh behind
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: modelCache.data, has_more: false }));
    }

    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }

    // buffer the body so we can route on the model field; forward original
    // bytes untouched on the Anthropic path (prompt caching keys on them)
    const routeTelemetry = createRouteTelemetry(req);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = chunks.length ? Buffer.concat(chunks) : null;
      let requestedModel = null;
      let requestedEffort = null;
      let parsedPayload = null;
      if (raw && pathOnly.startsWith('/v1/messages')) {
        try {
          const parsed = JSON.parse(raw.toString());
          parsedPayload = parsed;
          requestedModel = typeof parsed.model === 'string' ? parsed.model : null;
          requestedEffort = typeof parsed.output_config?.effort === 'string' ? parsed.output_config.effort : null;
          const requestedBase = codexBaseFromId(parsed.model);
          if (requestedBase) {
            const advertisedModel = parsed.model;
            let dispatchRoute = null;
            let dispatchVia = null;
            let dispatchIdentity = null;
            let dispatchMarkersLength = null;
            let dispatchInheritedFromAgentId = null;
            if (requestedBase === 'auto') {
              const markers = dispatchRouteMarkersFromMessages(parsed.messages);
              dispatchMarkersLength = markers.length;
              dispatchIdentity = dispatchRequestIdentity(req, parsed);
              if (markers.length === 1) {
                dispatchRoute = markers[0];
                dispatchRoutes.set(dispatchIdentity?.key, dispatchRoute);
                dispatchVia = 'dispatch';
              } else if (markers.length === 0) {
                dispatchRoute = dispatchRoutes.get(dispatchIdentity?.key);
                if (dispatchRoute) {
                  dispatchVia = 'dispatch-cached';
                } else {
                  dispatchRoute = dispatchRoutes.get(dispatchIdentity?.parentKey);
                  if (dispatchRoute) {
                    dispatchRoutes.set(dispatchIdentity?.key, dispatchRoute);
                    dispatchInheritedFromAgentId = dispatchIdentity.parentAgentId;
                    dispatchVia = 'dispatch-inherited';
                  }
                }
              }
              if (!dispatchRoute) {
                const body = JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    message: 'model-gateway: dispatch model requires exactly one [switchboard-route model=...] marker in the conversation; [sidequest-route ...] remains temporarily accepted for compatibility; redispatch the ticket',
                  },
                });
                routeTelemetry.setRoute({
                  selectedModel: advertisedModel,
                  effectiveModel: null,
                  backend: 'codex',
                  effort: null,
                  fallback: false,
                  via: 'dispatch',
                });
                routeTelemetry.finish(400, 'invalid_route');
                requestRouteLog(req, 'codex', advertisedModel, pathOnly, 'dispatch-unbound', null, dispatchIdentity, dispatchMarkersLength);
                res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
                return res.end(body);
              }
            }
            // Accept legacy typed ids from pre-0.4.2 sessions even though new
            // discovery rows are unsuffixed.
            parsed.model = dispatchRoute ? dispatchRoute.model : requestedBase;
            if (dispatchRoute && dispatchRoute.effort) {
              parsed.output_config = { ...(parsed.output_config || {}), effort: dispatchRoute.effort };
            }
            resolveCodexDeferredTools(parsed);
            // Non-Claude models call the plan-mode tools spuriously, and an
            // approved ExitPlanMode downgrades the session's permission mode
            // to acceptEdits instead of restoring it (anthropics/claude-code
            // #39973). Hide those tools from Codex models; Claude models are
            // untouched. Escape hatch: CODEX_GATEWAY_KEEP_PLAN_TOOLS=1.
            const keepPlanTools = process.env.CODEX_GATEWAY_KEEP_PLAN_TOOLS === '1';
            if (Array.isArray(parsed.tools) && !keepPlanTools) {
              parsed.tools = parsed.tools.filter((t) => !PLAN_TOOLS.includes(t && t.name));
            }
            counters.codex++;
            const effectiveEffort = typeof parsed.output_config?.effort === 'string' ? parsed.output_config.effort : requestedEffort;
            requestRouteLog(req, 'codex', parsed.model, pathOnly, dispatchVia, effectiveEffort,
              dispatchIdentity, dispatchMarkersLength, dispatchInheritedFromAgentId);
            routeTelemetry.setRoute({
              selectedModel: advertisedModel,
              effectiveModel: parsed.model,
              backend: 'codex',
              effort: effectiveEffort,
              fallback: false,
              via: dispatchVia || 'direct',
            });
            const requestBodySessionId = requestSessionId(req);
            const sessionId = codexSessionId(req);
            if (pathOnly === '/v1/messages' && fireContextSentry(res, sessionId)) {
              routeTelemetry.finish(413);
              return;
            }
            const forwardedBody = JSON.stringify(parsed);
            recordRequestBodyHighWater(requestBodySessionId, Buffer.byteLength(forwardedBody));
            const usageCapture = pathOnly === '/v1/messages' && usageEmitter.enabled
              ? usageEmitter.start({
                payload: parsed,
                requestBodyBytes: Buffer.byteLength(forwardedBody),
                requestHeaders: req.headers,
                route: {
                  requestedModel: advertisedModel,
                  effectiveModel: parsed.model,
                  backend: 'codex',
                  effort: effectiveEffort,
                  via: dispatchVia || 'direct',
                },
              })
              : null;
            const compactGuard = COMPACT_STREAM_GUARD && pathOnly === '/v1/messages' && isCompactionRequest(parsed)
              ? { attempts: 0, headWritten: false }
              : null;
            // claude.ai credentials never leave this machine toward the proxy
            return forward(req, res, `http://127.0.0.1:${PROXY_PORT}`,
              forwardedBody, AUTH_HEADERS, true, !keepPlanTools, sessionId, advertisedModel, routeTelemetry,
              usageCapture, 0, compactGuard);
          }
        } catch { /* not JSON; fall through to passthrough */ }
      }
      if (raw && pathOnly.startsWith('/v1/messages')) {
        try {
          const parsed = JSON.parse(raw.toString());
          if (typeof parsed.model === 'string' && parsed.model.startsWith(GROK_PREFIX)) {
            const advertisedModel = parsed.model;
            const pickerId = parsed.model.slice(GROK_PREFIX.length).replace(/\[1m\]$/, '');
            const cachedGrokModels = grokBackend.grokModelIdsFromCache();
            const model = grokBackend.grokModelFromPicker(pickerId, cachedGrokModels.length ? cachedGrokModels : DEFAULT_GROK_MODELS);
            const effort = typeof parsed.output_config?.effort === 'string' ? parsed.output_config.effort : null;
            counters.grok = (counters.grok || 0) + 1;
            requestRouteLog(req, 'grok', model, pathOnly, 'direct', effort);
            routeTelemetry.setRoute({
              selectedModel: advertisedModel,
              effectiveModel: model,
              backend: 'grok',
              effort,
              fallback: false,
              via: 'direct',
            });
            recordRequestBodyHighWater(requestSessionId(req), raw.length);
            const usageCapture = usageEmitter.enabled
              ? usageEmitter.start({
                payload: parsed,
                requestBodyBytes: raw.length,
                requestHeaders: req.headers,
                route: { requestedModel: advertisedModel, effectiveModel: model, backend: 'grok', effort, via: 'direct' },
              })
              : null;
            return forwardGrok(req, res, parsed, model, advertisedModel, routeTelemetry, usageCapture);
          }
        } catch { /* not JSON; fall through to passthrough */ }
      }
      counters.anthropic++;
      requestRouteLog(req, 'anthropic', requestedModel, pathOnly);
      routeTelemetry.setRoute({
        selectedModel: requestedModel,
        effectiveModel: requestedModel,
        backend: 'anthropic',
        effort: requestedEffort,
        fallback: false,
        via: 'direct',
      });
      recordRequestBodyHighWater(requestSessionId(req), raw.length);
      const usageCapture = pathOnly === '/v1/messages' && usageEmitter.enabled && parsedPayload
        ? usageEmitter.start({
          payload: parsedPayload,
          requestBodyBytes: raw.length,
          requestHeaders: req.headers,
          route: {
            requestedModel,
            effectiveModel: requestedModel,
            backend: 'anthropic',
            effort: requestedEffort,
            via: 'direct',
          },
        })
        : null;
      forward(req, res, ANTHROPIC_UPSTREAM, raw, [], false, false, null, null, routeTelemetry, usageCapture);
    });
  }

  function makeServer() {
    const server = http.createServer(handleRequest);
    server.requestTimeout = 0;
    server.headersTimeout = 120000;
    server.keepAliveTimeout = 75000;
    return server;
  }

  const mainServer = makeServer();
  servers.add(mainServer);
  mainServer.listen(SHIM_PORT, '127.0.0.1', () => {
    console.log(`model-gateway shim listening on 127.0.0.1:${SHIM_PORT} (proxy :${PROXY_PORT}, anthropic ${ANTHROPIC_UPSTREAM})`);
  });

  // RC-compatibility: only attempted when the user has added the exact hosts
  // entry themselves (never written by this plugin). A second, independent
  // listener bound to whichever loopback address that entry named, on
  // COMPAT_PORT (80 by default) — same handler, same routing. If the bind
  // fails (no permission, or something else already owns the port) this logs
  // why and simply doesn't add the listener; the main port above keeps
  // running normally and model-gateway stays in default mode this session.
  const hostsEntry = detectHostsCompat();
  compatState.hostsDetected = !!hostsEntry;
  compatState.hostsLine = hostsEntry ? hostsEntry.line : null;
  if (hostsEntry && !process.env.CODEX_GATEWAY_WORKER_PORT) {
    const compatServer = makeServer();
    servers.add(compatServer);
    compatServer.once('error', (e) => {
      servers.delete(compatServer);
      compatState.port80Bound = false;
      compatState.reason = e.code || e.message;
      console.error(`model-gateway: hosts RC-compatibility entry found (${hostsEntry.line}) but could not bind ${hostsEntry.ip}:${COMPAT_PORT}: ${e.code || e.message}. Staying on default gateway mode this session.`);
    });
    compatServer.listen(COMPAT_PORT, hostsEntry.ip, () => {
      compatState.port80Bound = true;
      console.log(`model-gateway RC-compatibility listener on ${hostsEntry.ip}:${COMPAT_PORT} (hosts: ${hostsEntry.line})`);
    });
  }
}

module.exports = { runWorker };
