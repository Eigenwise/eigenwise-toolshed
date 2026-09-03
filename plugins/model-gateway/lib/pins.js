'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { writeFileAtomically } = require('./atomic-file.js');
const {
  CLAUDE_BIN, CLAUDE_BIN_IS_BATCH, CODEX_FAMILY_RE, COMPAT_BASE_URL, DEFAULT_BASE_URL,
  DISPATCH_MODEL_ID, GROK_PREFIX, KNOWN_GOOD_PINS, LEGACY_CODEX_PREFIX, PIN_ALIASES,
  PIN_CACHE_PATH, PIN_CACHE_TTL_MS, PIN_OVERRIDE_PATH, PIN_PROBE_TIMEOUT_MS, PREFIX,
  STATE, STATIC_ENV_BLOCK, WIN,
} = require('./runtime.js');

function codexBaseFromId(id) {
  if (typeof id !== 'string') return null;
  const bare = id.replace(/\[1m\]$/, '');
  if (bare === DISPATCH_MODEL_ID) return 'auto';
  const base = bare.startsWith(LEGACY_CODEX_PREFIX) ? bare.slice(LEGACY_CODEX_PREFIX.length)
    : bare.startsWith(PREFIX) ? bare.slice(PREFIX.length)
      : null;
  return base && CODEX_FAMILY_RE.test(base) ? base : null;
}

function isGatewayModelId(id) {
  return codexBaseFromId(id) != null || (typeof id === 'string' && id.startsWith(GROK_PREFIX));
}

function isValidPin(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !/[\s\x00-\x1F\x7F"'`$\\;&|<>(){}]/.test(value);
}

function normalizedDetectedPin(alias, value) {
  const concrete = typeof value === 'string' ? value.replace(/\[1m\]/gi, '').trim() : '';
  if (!/^claude-[a-z0-9][a-z0-9._-]*$/i.test(concrete)) return null;
  if (!new RegExp(`(?:^|-)${alias}(?:-|$)`, 'i').test(concrete)) return null;
  return `${concrete}[1m]`;
}

function readDetectedPinCache() {
  try {
    const saved = JSON.parse(fs.readFileSync(PIN_CACHE_PATH, 'utf8'));
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') return null;
    const cliVersion = typeof saved.cliVersion === 'string' ? saved.cliVersion : null;
    const pins = Object.fromEntries(Object.keys(PIN_ALIASES)
      .map((alias) => [alias, normalizedDetectedPin(alias, saved.pins?.[alias])])
      .filter(([, pin]) => pin));
    const detectedFor = Object.fromEntries(Object.keys(pins).map((alias) => [
      alias,
      typeof saved.detectedFor?.[alias] === 'string' ? saved.detectedFor[alias] : cliVersion,
    ]));
    return { cliVersion, updatedAt: Number(saved.updatedAt) || 0, pins, detectedFor };
  } catch { return null; }
}

function currentDetectedPins(cache) {
  if (!cache?.cliVersion) return {};
  return Object.fromEntries(Object.entries(cache.pins)
    .filter(([alias]) => cache.detectedFor[alias] === cache.cliVersion));
}

function detectedPinDefaults() {
  return { ...KNOWN_GOOD_PINS, ...currentDetectedPins(readDetectedPinCache()) };
}

function writeDetectedPinCache(cache) {
  fs.mkdirSync(STATE, { recursive: true });
  writeFileAtomically(PIN_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
}

function terminateProbe(child) {
  if (!child?.pid || child.exitCode != null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode != null) return;
    if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }, 250).unref();
}

function startPinProbeServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.writeHead(request.method === 'HEAD' ? 204 : 404);
      response.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function claudeVersion() {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !WIN, shell: CLAUDE_BIN_IS_BATCH });
    let output = '';
    const timeout = setTimeout(() => { terminateProbe(child); resolve(null); }, PIN_PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', () => { clearTimeout(timeout); resolve(null); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && output.trim() ? output.trim() : null);
    });
  });
}

function probeClaudeAlias(alias, endpoint, timeoutMs = PIN_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const excludedVariables = new Set([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'CLAUDE_CODE_OAUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    ]);
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !excludedVariables.has(name.toUpperCase())));
    const child = spawn(CLAUDE_BIN, ['--bare', '--no-session-persistence', '--model', alias, '-p', '--output-format', 'stream-json', '--verbose'], {
      env: { ...environment, ANTHROPIC_BASE_URL: endpoint },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !WIN,
      shell: CLAUDE_BIN_IS_BATCH,
    });
    let output = '';
    let detected = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      terminateProbe(child);
      finish(null);
    }, timeoutMs);
    const read = (chunk) => {
      output += chunk;
      if (output.length > 262144) {
        terminateProbe(child);
        return finish(null);
      }
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const pin = event.type === 'system' && event.subtype === 'init'
            ? normalizedDetectedPin(alias, event.model)
            : null;
          if (pin) detected = pin;
        } catch {}
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? detected : null));
    child.stdin.end(`/model ${alias}\n`);
  });
}

async function refreshDetectedPins({ force = false } = {}) {
  const cached = readDetectedPinCache();
  const version = await claudeVersion();
  const fresh = cached && Date.now() - cached.updatedAt < PIN_CACHE_TTL_MS;
  const aliases = Object.keys(PIN_ALIASES);
  const aliasesToProbe = force || !fresh
    ? aliases
    : version
      ? aliases.filter((alias) => cached?.detectedFor[alias] !== version)
      : [];
  if (aliasesToProbe.length === 0) return cached?.pins || {};

  let server;
  try {
    server = await startPinProbeServer();
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}`;
    const detected = await Promise.all(aliasesToProbe.map((alias) => probeClaudeAlias(alias, endpoint)));
    const retryIndexes = detected.map((pin, index) => pin ? -1 : index).filter((index) => index >= 0);
    const retries = await Promise.all(retryIndexes.map((index) => (
      probeClaudeAlias(aliasesToProbe[index], endpoint, PIN_PROBE_TIMEOUT_MS * 2)
    )));
    for (const [retryIndex, detectedIndex] of retryIndexes.entries()) {
      if (retries[retryIndex]) detected[detectedIndex] = retries[retryIndex];
    }

    const pins = { ...(cached?.pins || {}) };
    const detectedFor = { ...(cached?.detectedFor || {}) };
    const recordedVersion = version || cached?.cliVersion || 'unknown';
    for (const [index, alias] of aliasesToProbe.entries()) {
      if (!detected[index]) continue;
      pins[alias] = detected[index];
      detectedFor[alias] = recordedVersion;
    }
    if (detected.some(Boolean)) {
      writeDetectedPinCache({ cliVersion: recordedVersion, updatedAt: Date.now(), pins, detectedFor });
    }
    return pins;
  } catch { return cached?.pins || {}; } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

function readPinOverrides() {
  try {
    const saved = JSON.parse(fs.readFileSync(PIN_OVERRIDE_PATH, 'utf8'));
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') return {};
    return Object.fromEntries(Object.keys(PIN_ALIASES)
      .filter((alias) => isValidPin(saved[alias]))
      .map((alias) => [alias, saved[alias]]));
  } catch { return {}; }
}

function writePinOverrides(overrides) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(PIN_OVERRIDE_PATH, JSON.stringify(overrides, null, 2) + '\n');
}

function effectivePins() {
  const overrides = readPinOverrides();
  const defaults = detectedPinDefaults();
  return Object.fromEntries(Object.entries(PIN_ALIASES).map(([alias]) => [alias, {
    default: defaults[alias],
    override: overrides[alias] || null,
    value: overrides[alias] || defaults[alias],
  }]));
}

function pinEnvBlock() {
  return Object.fromEntries(Object.entries(effectivePins()).map(([alias, pin]) => [PIN_ALIASES[alias], pin.value]));
}

function gatewayEnvBlock() {
  return { ...STATIC_ENV_BLOCK, ...pinEnvBlock() };
}

// ANTHROPIC_DEFAULT_*_MODEL are ordinary Claude Code settings a user may set
// without this plugin, so unwiring must not claim them by key. A pin is ours
// only if it still holds a value we could have written: the current effective
// pin, the detected-pin cache, a saved override, or the built-in default. A
// value outside that set was typed by the user and survives `env --remove`.
function ownedPinValues() {
  const overrides = readPinOverrides();
  const cached = readDetectedPinCache()?.pins || {};
  return Object.fromEntries(Object.keys(PIN_ALIASES).map((alias) => [
    PIN_ALIASES[alias],
    new Set([KNOWN_GOOD_PINS[alias], cached[alias], overrides[alias], detectedPinDefaults()[alias]].filter(Boolean)),
  ]));
}

function envBlockFor(mode) {
  return { ANTHROPIC_BASE_URL: mode === 'compat' ? COMPAT_BASE_URL : DEFAULT_BASE_URL, ...gatewayEnvBlock() };
}

function ourBaseUrls() { return [DEFAULT_BASE_URL, COMPAT_BASE_URL]; }

module.exports = {
  codexBaseFromId, detectedPinDefaults, effectivePins, envBlockFor, gatewayEnvBlock, isGatewayModelId,
  isValidPin, ourBaseUrls, ownedPinValues, pinEnvBlock, probeClaudeAlias, readPinOverrides,
  refreshDetectedPins, writePinOverrides,
};
