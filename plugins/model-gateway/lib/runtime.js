'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grokBackend = require('./grok-backend.js');

const WIN = process.platform === 'win32';
const STATE = path.join(os.homedir(), '.claude', 'model-gateway');
const LOGS = path.join(STATE, 'logs');
const BIN_DIR = path.join(STATE, 'bin');
const WIRING_CONFIG_PATH = path.join(STATE, 'wiring.json');
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
const DISPATCH_ROUTE_CACHE_PATH = process.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH || path.join(STATE, 'dispatch-routes.json');
const LIST_DISPATCH_MODEL = process.env.CODEX_GATEWAY_LIST_DISPATCH_MODEL === '1';
const ROUTE_TELEMETRY_ENABLED = process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT === '1';
const ROUTE_TELEMETRY_TIMEOUT_MS = 500;
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const AUTH_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'];
const COMPAT_HOST = 'api.anthropic.com';
const COMPAT_PORT = Number(process.env.CODEX_GATEWAY_COMPAT_PORT || 80);
const DEFAULT_BASE_URL = `http://127.0.0.1:${SHIM_PORT}`;
const COMPAT_BASE_URL = `http://${COMPAT_HOST}`;
const HOSTS_BLOCK_START = '# >>> model-gateway RC compatibility >>>';
const HOSTS_BLOCK_END = '# <<< model-gateway RC compatibility <<<';
const HOSTS_BLOCK_LINE = `127.0.0.1 ${COMPAT_HOST}`;
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
  fable: 'claude-fable-5[1m]',
};
const PIN_OVERRIDE_PATH = path.join(STATE, 'pins.json');
const PIN_CACHE_PATH = path.join(STATE, 'detected-pins.json');
const PIN_CACHE_TTL_MS = Number(process.env.CODEX_GATEWAY_PIN_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;
const PIN_PROBE_TIMEOUT_MS = Number(process.env.CODEX_GATEWAY_PIN_PROBE_TIMEOUT_MS) || 5000;
const CLAUDE_BIN = process.env.CODEX_GATEWAY_CLAUDE_BIN || 'claude';
const CLAUDE_BIN_IS_BATCH = WIN && /\.(?:cmd|bat)$/i.test(CLAUDE_BIN);
const LEGACY_ENV_BLOCK = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' };
const GATEWAY_MODELS_CACHE = path.join(os.homedir(), '.claude', 'cache', 'gateway-models.json');
const CLI_PATH = path.join(__dirname, '..', 'bin', 'model-gateway.js');

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
  ANTHROPIC_UPSTREAM, AUTH_HEADERS, BIN_DIR, CLAUDE_BIN, CLAUDE_BIN_IS_BATCH, CODEX_FAMILY_RE,
  CODEX_UPSTREAM_BLOCK_PATH, COMPAT_BASE_URL, COMPAT_HOST, COMPAT_PORT, DEFAULT_BASE_URL,
  DISPATCH_MODEL_ID, DISPATCH_ROUTE_CACHE_PATH, GATEWAY_MODELS_CACHE, GROK_ENDPOINT, GROK_PREFIX,
  HOSTS_BLOCK_END, HOSTS_BLOCK_LINE, HOSTS_BLOCK_START, KNOWN_GOOD_PINS, LEGACY_CODEX_PREFIX,
  LEGACY_ENV_BLOCK, LIST_DISPATCH_MODEL, LOGS, MIN_PROXY_VERSION, PIN_ALIASES, PIN_CACHE_PATH,
  PIN_CACHE_TTL_MS, PIN_OVERRIDE_PATH, PIN_PROBE_TIMEOUT_MS, PLUGIN_VERSION, PREFIX, PROXY_BIN,
  PROXY_PORT, PUBLIC_SHIM_PORT, REPO, REQUEST_ROUTE_LOG, REQUEST_ROUTE_LOG_PATH,
  ROUTE_TELEMETRY_ENABLED, ROUTE_TELEMETRY_TIMEOUT_MS, SHIM_FAILURE_PATH, SHIM_PORT, STATE,
  STATIC_ENV_BLOCK, TRACE_HEADERS, WIRING_CONFIG_PATH, WIN, CLI_PATH, mkdirs,
};
