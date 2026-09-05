'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grokBackend = require('./grok-backend.js');
const { writeFileAtomically } = require('./atomic-file.js');

const WIN = process.platform === 'win32';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE = path.join(os.homedir(), '.claude', 'model-gateway');
const LOGS = path.join(STATE, 'logs');
const BIN_DIR = path.join(STATE, 'bin');
const WIRING_CONFIG_PATH = path.join(STATE, 'wiring.json');
const PROJECT_WIRING_REGISTRY_PATH = path.join(STATE, 'wired-projects.json');
const SHIM_FAILURE_PATH = path.join(STATE, 'shim-supervisor-failure.txt');
const CODEX_UPSTREAM_BLOCK_PATH = path.join(STATE, 'codex-upstream-blocked.json');
const PROXY_BIN = path.join(BIN_DIR, WIN ? 'claude-code-proxy.exe' : 'claude-code-proxy');
const PUBLIC_SHIM_PORT = Number(process.env.CODEX_GATEWAY_PORT || 18764);
const SHIM_PORT = Number(process.env.CODEX_GATEWAY_WORKER_PORT || PUBLIC_SHIM_PORT);
const PROXY_PORT = Number(process.env.CODEX_GATEWAY_PROXY_PORT || 18765);
const PREFIX = 'claude-';
const GROK_PREFIX = 'claude-grok-';
const CODEX_FAMILY_RE = /^gpt-/;
const LEGACY_CODEX_PREFIX = 'claude-codex-';
const DISPATCH_MODEL_ID = 'claude-codex-auto';
const GROK_ENDPOINT = process.env.CODEX_GATEWAY_GROK_ENDPOINT || grokBackend.GROK_ENDPOINT;
const REPO = 'raine/claude-code-proxy';
const MIN_PROXY_VERSION = '0.1.14';
const ANTHROPIC_UPSTREAM = process.env.CODEX_GATEWAY_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
const REQUEST_ROUTE_LOG = process.env.CODEX_GATEWAY_REQUEST_LOG !== '0';
const REQUEST_ROUTE_LOG_PATH = process.env.CODEX_GATEWAY_REQUEST_LOG_PATH || path.join(LOGS, 'request-routes.jsonl');
const LIFECYCLE_LOG_PATH = path.join(LOGS, 'lifecycle.jsonl');
const DISPATCH_ROUTE_CACHE_PATH = process.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH || path.join(STATE, 'dispatch-routes.json');
const LIST_DISPATCH_MODEL = process.env.CODEX_GATEWAY_LIST_DISPATCH_MODEL === '1';
const ROUTE_TELEMETRY_ENABLED = process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT === '1';
const ROUTE_TELEMETRY_TIMEOUT_MS = 500;
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const AUTH_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'];
const COMPAT_HOST = 'api.anthropic.com';
const COMPAT_PORT = Number(process.env.CODEX_GATEWAY_COMPAT_PORT || 80);
const DEFAULT_BASE_URL = `http://127.0.0.1:${PUBLIC_SHIM_PORT}`;
const SOCKET_PATH = process.env.CODEX_GATEWAY_SOCKET_PATH || (WIN
  ? '\\\\.\\pipe\\model-gateway'
  : path.join(STATE, 'gateway.sock'));
const COMPAT_BASE_URL = `http://${COMPAT_HOST}`;
const HOSTS_BLOCK_START = '# >>> model-gateway RC compatibility >>>';
const HOSTS_BLOCK_END = '# <<< model-gateway RC compatibility <<<';
const HOSTS_BLOCK_LINE = `127.0.0.1 ${COMPAT_HOST}`;
const CODEX_UNKNOWN_MODEL_WINDOW = 200000;
const MODEL_WINDOW_POLICY = Object.freeze({
  default: Object.freeze({
    backend: 'codex',
    backendId: 'default',
    backendWindow: 920000,
    measurement: 'unmeasured default for Codex proxy rows absent from this table',
    pickerAliasTemplate: 'claude-{backendId}[1m]',
    advertisedWindow: 920000,
    sentry: 'codex-synthetic-413',
  }),
  'gpt-5.6-sol': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-sol',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-sol[1m]',
    advertisedWindow: 920000,
    sentry: 'codex-synthetic-413',
  }),
  'gpt-5.6-terra': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-terra',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-terra[1m]',
    advertisedWindow: 920000,
    sentry: 'codex-synthetic-413',
  }),
  'gpt-5.6-luna': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-luna',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-luna[1m]',
    advertisedWindow: 920000,
    sentry: 'codex-synthetic-413',
  }),
  'gpt-6-astra': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-6-astra',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-6-astra[1m]',
    advertisedWindow: 920000,
    sentry: 'codex-synthetic-413',
  }),
  'grok-4.5': Object.freeze({
    backend: 'grok',
    backendId: 'grok-4.5',
    backendWindow: 500000,
    measurement: 'measured 2026-09-05 from grok-backend.js GROK_MODELS',
    pickerAlias: 'claude-grok-4.5[1m]',
    advertisedWindow: 500000,
    sentry: 'none',
  }),
  anthropic: Object.freeze({
    backend: 'anthropic',
    backendId: 'anthropic',
    backendWindow: null,
    measurement: 'upstream-managed native Anthropic passthrough',
    pickerAlias: 'claude-anthropic',
    advertisedWindow: null,
    sentry: 'none',
  }),
});
const CODEX_CONTEXT_WINDOWS = MODEL_WINDOW_POLICY;
const configuredContextWindow = Number(process.env.CODEX_GATEWAY_CONTEXT_WINDOW);

function gatewayBackendModelId(id) {
  return typeof id === 'string' ? id.replace(/\[1m\]$/, '').replace(/^claude-/, '') : '';
}

function codexContextWindowModelId(id) {
  const baseId = gatewayBackendModelId(id).replace(/-fast$/, '');
  return baseId || 'default';
}

function resolveGatewayModelPolicy(id) {
  const backendId = gatewayBackendModelId(id);
  const policyId = backendId.startsWith('gpt-') ? backendId.replace(/-fast$/, '') : backendId;
  const policy = MODEL_WINDOW_POLICY[policyId]
    || (backendId.startsWith('gpt-') ? MODEL_WINDOW_POLICY.default : null)
    || (typeof id === 'string' && id.startsWith(PREFIX) && !id.startsWith(LEGACY_CODEX_PREFIX)
      ? MODEL_WINDOW_POLICY.anthropic
      : null);
  if (!policy) return null;
  const pickerAlias = policy.backendId === backendId && policy.pickerAlias
    ? policy.pickerAlias
    : policy.pickerAliasTemplate
      ? policy.pickerAliasTemplate.replace('{backendId}', backendId)
      : `${PREFIX}${backendId}[1m]`;
  return { ...policy, backendId, pickerAlias };
}

function gatewayAdvertisedWindow(id) {
  const policy = resolveGatewayModelPolicy(id);
  if (!policy) return null;
  return policy.backend === 'codex' && configuredContextWindow
    ? configuredContextWindow
    : policy.advertisedWindow;
}

function gatewayClientModelId(id) {
  const policy = resolveGatewayModelPolicy(id);
  if (!policy) return id;
  return gatewayAdvertisedWindow(id) > CODEX_UNKNOWN_MODEL_WINDOW
    ? policy.pickerAlias
    : `${PREFIX}${policy.backendId}`;
}

function codexContextWindow(id) {
  return gatewayAdvertisedWindow(id) || MODEL_WINDOW_POLICY.default.advertisedWindow;
}

function codexClientModelId(id) {
  return gatewayClientModelId(id);
}

const STATIC_ENV_BLOCK = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
};
const PIN_ALIASES = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};
const KNOWN_GOOD_PINS = {
  opus: 'claude-opus-5[1m]',
  sonnet: 'claude-sonnet-5[1m]',
  fable: 'claude-fable-5-1[1m]',
};
const PIN_OVERRIDE_PATH = path.join(STATE, 'pins.json');
const PIN_CACHE_PATH = path.join(STATE, 'detected-pins.json');
const PIN_CACHE_TTL_MS = Number(process.env.CODEX_GATEWAY_PIN_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;
const PIN_PROBE_TIMEOUT_MS = Number(process.env.CODEX_GATEWAY_PIN_PROBE_TIMEOUT_MS) || 5000;
const CLAUDE_BIN = process.env.CODEX_GATEWAY_CLAUDE_BIN || 'claude';
const CLAUDE_BIN_IS_BATCH = WIN && /\.(?:cmd|bat)$/i.test(CLAUDE_BIN);
const LEGACY_ENV_BLOCK = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' };
const GATEWAY_MODELS_CACHE = path.join(CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
const CLI_PATH = path.join(__dirname, '..', 'bin', 'model-gateway.js');

function gatewayDiscoveryModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model.id !== 'string' || !/(claude|anthropic)/i.test(model.id)) return [];
    const entry = { id: gatewayClientModelId(model.id) };
    if (typeof model.display_name === 'string') entry.display_name = model.display_name;
    return [entry];
  });
}

function readGatewayDiscoveryCache(cachePath = GATEWAY_MODELS_CACHE) {
  try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return null; }
}

function sameGatewayDiscoveryModels(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((model, index) => (
    model?.id === right[index].id && model?.display_name === right[index].display_name
  ));
}

function syncGatewayDiscoveryCache({ models, baseUrl = DEFAULT_BASE_URL, cachePath = GATEWAY_MODELS_CACHE, now = Date.now } = {}) {
  if (baseUrl === COMPAT_BASE_URL) return { state: 'skipped', reason: 'rc-compatibility', cachePath, modelCount: 0 };
  if (baseUrl !== DEFAULT_BASE_URL) return { state: 'skipped', reason: 'gateway-not-wired', cachePath, modelCount: 0 };

  const gatewayModels = gatewayDiscoveryModels(models);
  const existing = readGatewayDiscoveryCache(cachePath);
  if (existing && sameGatewayDiscoveryModels(existing.models, gatewayModels)) {
    return { state: 'unchanged', cachePath, modelCount: gatewayModels.length };
  }

  const cache = { baseUrl, fetchedAt: now(), models: gatewayModels };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileAtomically(cachePath, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(cachePath, 0o600); } catch {}
  return { state: 'wrote', cachePath, modelCount: gatewayModels.length };
}

function parseVersionDirectory(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionIsOlder(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

function parseInstalledCliVersion(cliPath) {
  const pluginRoot = path.dirname(path.dirname(cliPath));
  return parseVersionDirectory(path.basename(pluginRoot));
}

function canReplaceInstalledCliPath(currentCliPath, candidateCliPath) {
  const currentVersion = parseInstalledCliVersion(currentCliPath);
  const candidateVersion = parseInstalledCliVersion(candidateCliPath);
  if (!candidateVersion) return !currentVersion;
  return !currentVersion || !versionIsOlder(candidateVersion, currentVersion);
}

function resolveNewestInstalledCliPath({ cliPath = CLI_PATH, readDirectory = fs.readdirSync, pathExists = fs.existsSync } = {}) {
  const pluginRoot = path.dirname(path.dirname(cliPath));
  const pluginCacheRoot = path.dirname(pluginRoot);
  const candidates = [cliPath];
  try {
    for (const entry of readDirectory(pluginCacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const siblingCliPath = path.join(pluginCacheRoot, entry.name, 'bin', 'model-gateway.js');
      if (pathExists(siblingCliPath)) candidates.push(siblingCliPath);
    }
  } catch {}

  return candidates.reduce((newestCliPath, candidateCliPath) => (
    canReplaceInstalledCliPath(newestCliPath, candidateCliPath) ? candidateCliPath : newestCliPath
  ));
}

function readPluginVersion() {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof version === 'string' ? version : null;
  } catch { return null; }
}

const PLUGIN_VERSION = readPluginVersion();

function mkdirs() {
  for (const directory of [STATE, LOGS, BIN_DIR]) fs.mkdirSync(directory, { recursive: true });
}

module.exports = {
  ANTHROPIC_UPSTREAM, AUTH_HEADERS, BIN_DIR, CLAUDE_BIN, CLAUDE_BIN_IS_BATCH, CODEX_CONTEXT_WINDOWS,
  CODEX_FAMILY_RE, CODEX_UNKNOWN_MODEL_WINDOW, CODEX_UPSTREAM_BLOCK_PATH, COMPAT_BASE_URL, COMPAT_HOST, COMPAT_PORT,
  DEFAULT_BASE_URL, MODEL_WINDOW_POLICY,
  DISPATCH_MODEL_ID, DISPATCH_ROUTE_CACHE_PATH, GATEWAY_MODELS_CACHE, GROK_ENDPOINT, GROK_PREFIX,
  HOSTS_BLOCK_END, HOSTS_BLOCK_LINE, HOSTS_BLOCK_START, KNOWN_GOOD_PINS, LEGACY_CODEX_PREFIX,
  LEGACY_ENV_BLOCK, LIST_DISPATCH_MODEL, LOGS, MIN_PROXY_VERSION, PIN_ALIASES, PIN_CACHE_PATH,
  PIN_CACHE_TTL_MS, PIN_OVERRIDE_PATH, PIN_PROBE_TIMEOUT_MS, PLUGIN_VERSION, PREFIX, PROXY_BIN,
  PROXY_PORT, PUBLIC_SHIM_PORT, REPO, REQUEST_ROUTE_LOG, REQUEST_ROUTE_LOG_PATH, LIFECYCLE_LOG_PATH,
  PROJECT_WIRING_REGISTRY_PATH, ROUTE_TELEMETRY_ENABLED, ROUTE_TELEMETRY_TIMEOUT_MS, SHIM_FAILURE_PATH, SHIM_PORT, SOCKET_PATH, STATE,
  STATIC_ENV_BLOCK, TRACE_HEADERS, WIRING_CONFIG_PATH, WIN, CLI_PATH, CLAUDE_CONFIG_DIR, mkdirs,
  canReplaceInstalledCliPath, codexClientModelId, codexContextWindow, codexContextWindowModelId,
  gatewayAdvertisedWindow, gatewayBackendModelId, gatewayClientModelId, gatewayDiscoveryModels,
  readGatewayDiscoveryCache, resolveGatewayModelPolicy, resolveNewestInstalledCliPath,
  sameGatewayDiscoveryModels, syncGatewayDiscoveryCache,
};
