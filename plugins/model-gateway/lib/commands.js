#!/usr/bin/env node
'use strict';
/*
 * model-gateway: put your ChatGPT/Codex subscription models in Claude Code's
 * /model picker.
 *
 * Two local processes make that happen:
 *   1. claude-code-proxy (raine/claude-code-proxy) translates the Anthropic
 *      Messages API to the Codex subscription backend. It owns the OAuth.
 *   2. This file's `serve-shim` mode, a router in front of it. Claude Code's
 *      ANTHROPIC_BASE_URL points HERE. Requests for `claude-gpt-*` models
 *      are un-prefixed and sent to the proxy; everything else passes through
 *      to api.anthropic.com untouched (claude.ai login keeps working). The
 *      shim's /v1/models advertises the proxy's Codex models under a bare
 *      `claude-` prefix because Claude Code's gateway model discovery drops
 *      ids that don't start with "claude" or "anthropic".
 *
 * Default mode above is zero-admin and always available, but Claude Code's
 * built-in /remote-control only lights up when ANTHROPIC_BASE_URL is exactly
 * the real Anthropic host. There's no supported way to get gateway routing
 * and that exact host at once without touching the OS resolver, so it's an
 * opt-in "RC-compatibility" mode: the user (never this plugin) adds one hosts
 * entry mapping api.anthropic.com to loopback, and once detected the shim
 * additionally binds loopback:80 and Claude Code's env is pointed at
 * http://api.anthropic.com instead of 127.0.0.1:<shim port>. See
 * detectHostsCompat / syncCompatMode below. Never automatic on the hosts side;
 * only the env switch and the extra listener are automatic.
 */

const { fork, spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { writeFileAtomically } = require('./atomic-file.js');
const { createGatewayUsageEmitter, recordRequestBodyHighWater } = require('./usage-observability.js');
const grokBackend = require('./grok-backend.js');
const { CLI_PATH, SOCKET_PATH, resolveNewestInstalledCliPath } = require('./runtime.js');

const WIN = process.platform === 'win32';
const STATE = path.join(os.homedir(), '.claude', 'model-gateway');
const LOGS = path.join(STATE, 'logs');
const BIN_DIR = path.join(STATE, 'bin');
const WIRING_CONFIG_PATH = path.join(STATE, 'wiring.json');
const SHIM_FAILURE_PATH = path.join(STATE, 'shim-supervisor-failure.txt');
const CODEX_UPSTREAM_BLOCK_PATH = path.join(STATE, 'codex-upstream-blocked.json');
const PLUGIN_VERSION = readPluginVersion();
const PROXY_BIN = path.join(BIN_DIR, WIN ? 'claude-code-proxy.exe' : 'claude-code-proxy');
const PROXY_SERVING_VERSION_PATH = path.join(STATE, 'proxy-serving-version.txt');
const PUBLIC_SHIM_PORT = Number(process.env.CODEX_GATEWAY_PORT || 18764);
const SHIM_PORT = Number(process.env.CODEX_GATEWAY_WORKER_PORT || PUBLIC_SHIM_PORT);
const PROXY_PORT = Number(process.env.CODEX_GATEWAY_PROXY_PORT || 18765);
// Advertised ids are `claude-` + the backend's own id (`claude-gpt-5.6-sol`,
// `claude-grok-4.5`). The `claude-` part is not decoration: Claude Code's
// gateway model discovery drops every id that doesn't start with claude/
// anthropic, so an unprefixed id vanishes from /model.
//
// Real Anthropic ids share that prefix, so PREFIX alone can NEVER decide a
// route — matching on it would send claude.ai traffic to the Codex proxy. The
// backend family segment decides: `gpt-*` is Codex, `grok-*` is Grok, anything
// else passes through untouched.
const PREFIX = 'claude-';
const GROK_PREFIX = 'claude-grok-';
const CODEX_FAMILY_RE = /^gpt-/;
// Pre-3.x advertised the backend name too (`claude-codex-gpt-5.6-sol`). Claude
// Code persists the selected model per project, so those ids outlive the
// upgrade in every already-wired project; keep resolving them.
const LEGACY_CODEX_PREFIX = 'claude-codex-';
// Sidequest's virtual dispatch pin, resolved from the conversation's route
// marker rather than from the id itself. It keeps the backend name because
// `codex` here IS the backend (it owns the proxy's OAuth), and because the id
// is persisted in generated agent defs and board dispatch records.
const DISPATCH_MODEL_ID = 'claude-codex-auto';
const GROK_ENDPOINT = process.env.CODEX_GATEWAY_GROK_ENDPOINT || grokBackend.GROK_ENDPOINT;
const REPO = 'raine/claude-code-proxy';
// Earliest claude-code-proxy release that maps a context overflow to HTTP 413
// request_too_large (commit 968cbe2, first tagged in v0.1.14; v0.1.13 has none).
// Below this the proxy signals overflow with an older, differently-shaped error;
// `ensure` nudges the user (once, fail-soft) to re-run setup, which fetches latest.
// Compared numerically (see semverLt); a string compare would read '0.1.9' as
// newer than '0.1.14'.
const MIN_PROXY_VERSION = '0.1.14';
const ANTHROPIC_UPSTREAM = process.env.CODEX_GATEWAY_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
// Enabled by default because route logs are metadata-only: never write prompts,
// tool payloads, auth, or arbitrary headers. Set to `0` to opt out; a running shim
// picks this up at its next natural restart. See requestRouteLog below.
const REQUEST_ROUTE_LOG = process.env.CODEX_GATEWAY_REQUEST_LOG !== '0';
const REQUEST_ROUTE_LOG_PATH = process.env.CODEX_GATEWAY_REQUEST_LOG_PATH || path.join(LOGS, 'request-routes.jsonl');
const DISPATCH_ROUTE_CACHE_PATH = process.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH || path.join(STATE, 'dispatch-routes.json');
const LIST_DISPATCH_MODEL = process.env.CODEX_GATEWAY_LIST_DISPATCH_MODEL === '1';
const ROUTE_TELEMETRY_ENABLED = process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT === '1';
const ROUTE_TELEMETRY_TIMEOUT_MS = 500;
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const AUTH_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'];

const {
  COMPAT_BASE_URL, COMPAT_HOST, COMPAT_PORT, DEFAULT_BASE_URL, HOSTS_BLOCK_END, HOSTS_BLOCK_LINE,
  HOSTS_BLOCK_START, PIN_ALIASES, PIN_OVERRIDE_PATH, STATIC_ENV_BLOCK,
} = require('./runtime.js');
const {
  codexBaseFromId, detectedPinDefaults, effectivePins, envBlockFor, gatewayEnvBlock, isGatewayModelId,
  isValidPin, ourBaseUrls, ownedPinValues, pinEnvBlock, readPinOverrides, refreshDetectedPins, writePinOverrides,
} = require('./pins.js');

// Versions through 0.4.1 wrote this unsafe global override. Remove it during
// the next env write/remove, but leave a user-supplied different value alone.
const LEGACY_ENV_BLOCK = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
};
const GATEWAY_MODELS_CACHE = path.join(os.homedir(), '.claude', 'cache', 'gateway-models.json');

const USAGE = `usage: model-gateway.js <command>

  setup            download the claude-code-proxy binary (v-latest) into ${BIN_DIR}
  login [--device] run the ChatGPT OAuth flow (--device for headless device-code)
  start | stop     start/stop the proxy + shim (detached, logs in ${LOGS})
  ensure [--quiet] start whatever isn't running; used by the SessionStart hook
  status           show what's running
  models           show the model list the shim advertises to Claude Code
  catalog [--json] [--refresh] print the sidequest-readable model catalog (${path.join(STATE, 'catalog.json')})
  pin [--opus|--sonnet|--fable <model|default>]
                   show or persist Claude alias pins (${PIN_OVERRIDE_PATH})
  env [--write-user | --remove] [--reconcile]
                   print the Claude Code env block, or merge/remove global wiring
                   (writes go to ~/.claude/settings.json; --reconcile confirms cleanup
                   of conflicting recorded project-local wiring)
  doctor           full health check
  remote-control <enable|disable|doctor>
                   manage the opt-in hosts-file compatibility mode
  serve-shim       (internal) run the router in the foreground

  Request route logging (on by default; set CODEX_GATEWAY_REQUEST_LOG=0 to opt out):
    CODEX_GATEWAY_REQUEST_LOG=0
    Writes JSONL route metadata to ${REQUEST_ROUTE_LOG_PATH}. Override the path with
    CODEX_GATEWAY_REQUEST_LOG_PATH. It records no request bodies, prompts, tools, or auth.`;

const cmd = process.argv[2];
const args = process.argv.slice(3);
const flag = (f) => args.includes(f);

// A `--json` invocation's stdout is a machine contract. `catalog --refresh --json` writes the catalog on the
// way out, and that write logs when it preserves models from a subset response, so a diagnostic line landed
// ahead of the JSON and Sidequest's catalog refresh threw on parse and silently gave up (SQ-2208). Human lines
// still get emitted, on stderr, where they belong once stdout is data.
// SessionStart hook stdout is model context and nothing else, so every actionable gateway state reached the
// model and nobody else: on 2026-08-13 this hook found the session unwired, said so, and the user only learned
// it hours later by asking which hooks had run (SQ-1901). systemMessage is the one channel Claude Code shows
// the user, and it is only readable inside a JSON object, so the hook path buffers its lines, hands the model
// the same text it always got, and puts the states someone has to go fix in front of the user.
let bufferedHookLines = null;
const userActionNotices = [];

function log(m) {
  if (bufferedHookLines) { bufferedHookLines.push(String(m)); return; }
  if (flag('--json')) console.error(m); else console.log(m);
}

function noticeForUser(text, { toStderr = false } = {}) {
  userActionNotices.push(text);
  if (bufferedHookLines) bufferedHookLines.push(text);
  else if (toStderr) console.error(text);
  else log(text);
}

function flushHookOutput() {
  if (!bufferedHookLines) return;
  const lines = bufferedHookLines;
  bufferedHookLines = null;
  const output = {};
  if (lines.length) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: lines.join('\n') };
  const [worst, ...rest] = userActionNotices;
  // One line, every session start, so noise discipline is part of the contract: the first actionable state names
  // its own fix, and the rest are counted with the one command that lists them all.
  if (worst) output.systemMessage = rest.length ? `${worst} (+${rest.length} more: run \`node "${CLI_PATH}" doctor\`)` : worst;
  if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
}
// Flushes first so a die() from anywhere inside the hook path still emits what was buffered; otherwise the
// buffering below would turn a mid-run failure into total silence.
function die(m, code) { flushHookOutput(); console.error('model-gateway: ' + m); process.exit(code == null ? 1 : code); }
function readPluginVersion() {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof version === 'string' ? version : null;
  } catch { return null; }
}
function mkdirs() { for (const d of [STATE, LOGS, BIN_DIR]) fs.mkdirSync(d, { recursive: true }); }

const {
  createProxyRecovery, fetchUrl, killPid, pidFile, portListening, postJson, processOwningPort, readPid, reapGatewayOrphans,
  removePid, restartWorkerWithDrain, shimHealthy, spawnDetached, stopAll, stopProcess, stopRunningSupervisor,
  stopShimWithDrain, waitForShimExit,
} = require('./process-supervision.js');

const {
  cleanLegacyEnvSettings, cleanLegacyGatewayModelCache, effectiveBaseUrl, isWired, migrateLegacyProjectSettings,
  readSettingsForWrite, reconcileRegisteredProjectWirings, recordProjectWiring, selectedWiringScope,
  retireWiringModeConfig, settingsPath, wiredMode, writeSettings,
} = require('./settings-wiring.js');

// ------------------------------------------------- RC-compatibility hosts

const {
  addManagedHostsBlock, configureRemoteControl, detectHostsCompat, findConflictingHostsMappings, hostsFilePath,
  managedHostsBlock, parseHostsCompatBlock, parseHostsCompatEntry, removeManagedHostsBlock, remoteControlCommand,
} = require('./remote-control.js');
configureRemoteControl({ args, flag, log, die, doctor, fetchShimHealth, startAll, syncCompatMode });

// model-gateway is inherently a USER-SCOPE tool: it wires a GLOBAL env var
// (ANTHROPIC_BASE_URL, every session routes through the shim) and its keepalive
// hook must run in every project. A project/local-only install leaves other
// projects pointing at a shim that isn't kept alive there. Claude Code has no
// manifest field to force scope, so we detect a project-only install and warn.
//
// Returns one of: 'user' (correctly user-scoped), 'project-only' (installed but
// no user-scope entry), or 'unknown' (not found in installed_plugins.json, e.g.
// a --plugin-dir dev checkout — stay quiet).
function installScope() {
  try {
    const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = (data.plugins && data.plugins['model-gateway@eigenwise-toolshed']) || [];
    if (!entries.length) return 'unknown';
    return entries.some((e) => e.scope === 'user') ? 'user' : 'project-only';
  } catch { return 'unknown'; }
}

function isAuthed() {
  const r = spawnSync(PROXY_BIN, ['codex', 'auth', 'status'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 && /account/i.test((r.stdout || '') + (r.stderr || ''));
}

const CODEX_READINESS_MESSAGES = {
  'binary-missing': () => `Codex dispatch refused: claude-code-proxy is missing. Run \`node "${CLI_PATH}" setup\`, then retry. No Anthropic fallback was used.`,
  'auth-missing': () => `Codex dispatch refused: ChatGPT sign-in is required. Run \`node "${CLI_PATH}" login\`, finish browser OAuth, then run \`node "${CLI_PATH}" setup\` and retry. Credentials live in \`~/.config/claude-code-proxy/\`.`,
  'proxy-down': () => `Codex dispatch refused: claude-code-proxy is not answering on /v1/models. The running shim supervisor retries recovery with bounded backoff; check ${path.join(LOGS, 'guardian.log')} if it does not recover. No Anthropic fallback was used.`,
  'shim-down': () => `Codex dispatch refused: the model-gateway shim is down. Run \`node "${CLI_PATH}" ensure\`, then retry. No Anthropic fallback was used.`,
  'serving-version-mismatch': () => `Codex dispatch refused: model-gateway is serving a stale shim version. Run \`node "${resolveNewestInstalledCliPath()}" ensure\`, then retry. No Anthropic fallback was used.`,
  'upstream-blocked': () => `Codex is blocked by an OpenAI rejection. Run \`node "${CLI_PATH}" setup\`; if it persists, wait for a claude-code-proxy update or explicitly re-route this ticket. Codex tickets remain blocked.`,
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
    servingVersionMatches: shimRunning && servingVersionIsCurrentOrNewer(servingVersion, PLUGIN_VERSION),
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

// ------------------------------------------------------------------- setup

function proxyVersion(version) {
  return Array.isArray(version) ? version.join('.') : null;
}

function currentProxyVersion(binary = PROXY_BIN) {
  return proxyVersion(parseSemver((spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim()));
}

function oldProxyPath(currentPath, version, now = Date.now()) {
  return `${currentPath}.old-${version || 'unknown'}-${now}`;
}

function sweepOldProxyBinaries({ directory = BIN_DIR, basename = path.basename(PROXY_BIN), fsImpl = fs } = {}) {
  let entries;
  try { entries = fsImpl.readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    if (!String(entry).startsWith(`${basename}.old-`)) continue;
    try { fsImpl.rmSync(path.join(directory, entry)); } catch {}
  }
}

function replaceProxyBinary({ currentPath = PROXY_BIN, stagedPath, currentVersion, fsImpl = fs, now = Date.now() } = {}) {
  const hadExistingProxy = fsImpl.existsSync(currentPath);
  const previousPath = hadExistingProxy ? oldProxyPath(currentPath, proxyVersion(currentVersion), now) : null;
  if (hadExistingProxy) fsImpl.renameSync(currentPath, previousPath);
  try {
    fsImpl.renameSync(stagedPath, currentPath);
  } catch (error) {
    if (previousPath) fsImpl.renameSync(previousPath, currentPath);
    throw new Error(`proxy upgrade failed (${error.code || error.message}); original proxy restored.`, { cause: error });
  }
  return { hadExistingProxy, previousPath };
}

function readProxyServingVersion(file = PROXY_SERVING_VERSION_PATH) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

function writeProxyServingVersion(version, file = PROXY_SERVING_VERSION_PATH) {
  if (!version) return;
  fs.writeFileSync(file, `${version}\n`);
}

async function waitForProxyExit({ listening = portListening, attempts = 7, delay = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await listening(PROXY_PORT))) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

async function restartProxyForVersionChange({ previousVersion, currentVersion = currentProxyVersion(), listening = portListening, stop = stopProcess, start = spawnDetached } = {}) {
  if (previousVersion) writeProxyServingVersion(previousVersion);
  if (await listening(PROXY_PORT)) stop('proxy');
  if (!(await waitForProxyExit({ listening }))) return false;
  start('proxy', PROXY_BIN, ['serve', '--no-monitor'], { PORT: String(PROXY_PORT) });
  writeProxyServingVersion(currentVersion);
  return true;
}

async function restartProxyIfOutdated({ quiet = false } = {}) {
  const onDisk = currentProxyVersion();
  const serving = readProxyServingVersion() || onDisk;
  if (!onDisk || !serving || onDisk === serving) return { restarted: false, onDisk, serving };
  const restarted = await restartProxyForVersionChange({ previousVersion: serving, currentVersion: onDisk });
  if (!restarted && !quiet) log(`proxy on disk: ${onDisk}   serving: ${serving}   restarts on next \`ensure\``);
  return { restarted, onDisk, serving };
}

async function setup() {
  mkdirs();
  sweepOldProxyBinaries();
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const plat = WIN ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const ext = WIN ? 'zip' : 'tar.gz';
  const assetName = `claude-code-proxy-${plat}-${arch}.${ext}`;

  log(`fetching latest release of ${REPO}...`);
  const rel = await fetchUrl(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (rel.status !== 200) die(`GitHub API returned ${rel.status}`);
  const release = JSON.parse(rel.body.toString());
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) die(`no asset ${assetName} in release ${release.tag_name}`);
  const shaAsset = (release.assets || []).find((a) => a.name === assetName.replace(/\.(zip|tar\.gz)$/, '.sha256'));

  log(`downloading ${assetName} (${release.tag_name})...`);
  const archive = await fetchUrl(asset.browser_download_url, { timeout: 120000 });
  if (archive.status !== 200) die(`download failed with ${archive.status}`);

  if (shaAsset) {
    const shaBody = (await fetchUrl(shaAsset.browser_download_url)).body.toString();
    const want = (shaBody.match(/[0-9a-f]{64}/i) || [])[0];
    const got = crypto.createHash('sha256').update(archive.body).digest('hex');
    if (want && want.toLowerCase() !== got) die(`sha256 mismatch: expected ${want}, got ${got}`);
    log('sha256 verified');
  }

  const stage = fs.mkdtempSync(path.join(BIN_DIR, 'stage-'));
  const archiveFile = path.join(stage, assetName);
  fs.writeFileSync(archiveFile, archive.body);
  const tarBin = WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const tar = spawnSync(tarBin, ['-xf', archiveFile], { encoding: 'utf8', cwd: stage, windowsHide: true });
  if (tar.status !== 0) die(`extract failed: ${tar.stderr || tar.status}`);
  const staged = fs.readdirSync(stage, { recursive: true })
    .map(String).find((file) => path.basename(file) === path.basename(PROXY_BIN));
  if (!staged) die(`extracted, but ${path.basename(PROXY_BIN)} not found in ${BIN_DIR}`);
  const stagedProxy = path.join(stage, staged);
  if (!WIN) fs.chmodSync(stagedProxy, 0o755);
  const currentVersion = parseSemver((spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim());
  const stagedVersion = parseSemver((spawnSync(stagedProxy, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim());
  const proxyChanged = !currentVersion || !stagedVersion || currentVersion.join('.') !== stagedVersion.join('.');

  if (proxyChanged) {
    const previousVersion = proxyVersion(currentVersion);
    const installedVersion = proxyVersion(stagedVersion);
    replaceProxyBinary({ stagedPath: stagedProxy, currentVersion });
    const restarted = await restartProxyForVersionChange({ previousVersion, currentVersion: installedVersion });
    if (!restarted) log(`proxy on disk: ${installedVersion || 'unknown'}   serving: ${previousVersion || 'unknown'}   restarts on next \`ensure\``);
  } else {
    log('model-gateway: proxy unchanged; keeping its authenticated process running.');
  }
  const supervisorRestart = await restartShimIfOutdated();
  if (supervisorRestart && !supervisorRestart.ok) die(`could not restart shim supervisor: ${supervisorRestart.reason}`);
  if (!supervisorRestart) {
    const restarting = await restartWorkerWithDrain();
    if (!restarting.ok) die(`could not restart shim worker: ${restarting.reason}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });

  const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', windowsHide: true });
  log(`installed: ${(v.stdout || v.stderr || '').trim() || PROXY_BIN}`);

  // one-shot: start everything, and finish the wiring when auth already works
  const r = await startAll();
  if (!r.ok) die(r.reason);
  clearUpstreamBlocked();
  if (!isAuthed()) {
    log(`next: node "${CLI_PATH}" login   (ChatGPT browser sign-in), then setup again to wire Claude Code`);
    return;
  }
  log('ChatGPT auth: valid');
  await refreshDetectedPins({ force: true });
  const { mode } = await resolveIntendedMode();
  if (isWired()) {
    const current = wiredMode();
    if (!current || !current.scope) {
      // Refusing to copy an environment value into settings is deliberate (it may point at someone's dev
      // instance), but saying only that left no route forward, so setup skipped the write on every run and the
      // machine stayed permanently wired by one terminal (SQ-1901). Name the command that does converge it.
      log(`already wired through ${current ? current.source : 'ANTHROPIC_BASE_URL'}, which has no settings file this command can write, so nothing here is permanent: any session started outside that environment is unwired. Run \`node "${CLI_PATH}" env --write-user\` to write ~/.claude/settings.json. Claude alias pins were left alone; they belong wherever that base URL is defined.`);
    } else if (current.mode !== mode) {
      writeEnv(current.scope, false, { mode, quiet: true });
      log(`model-gateway: hosts compatibility state changed since last wired; switched ${current.scope} settings to ${mode} mode. Restart Claude Code.`);
    } else {
      writeEnv(current.scope, false, { mode, quiet: true });
      log('already wired; refreshed Claude alias pins. Restart Claude Code and open /model');
    }
    await statusReport();
    return;
  }
  writeEnv(selectedWiringScope(), false, { mode });
  await statusReport();
}

// ------------------------------------------------------- process management

// Parse the first "x.y.z" out of a --version line into [major, minor, patch]
// ints, ignoring a leading 'v' or any pre-release/build suffix. null when none.
function parseSemver(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true when semver a is strictly less than b, comparing major/minor/patch as
// ints (never lexicographically: '0.1.9' must read as older than '0.1.14').
function semverLt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function servingVersionIsCurrentOrNewer(servingVersion, installedVersion) {
  if (servingVersion === installedVersion) return true;
  const serving = parseSemver(servingVersion);
  const installed = parseSemver(installedVersion);
  return Boolean(serving && installed && !semverLt(serving, installed));
}

function servingVersionIsNewer(servingVersion, installedVersion) {
  const serving = parseSemver(servingVersion);
  const installed = parseSemver(installedVersion);
  return Boolean(serving && installed && semverLt(installed, serving));
}

function staleSessionReloadNotice(installedVersion, health) {
  const servingVersion = servingShimVersion(health);
  if (!servingVersionIsNewer(servingVersion, installedVersion)) return null;
  return `model-gateway: this session loaded ${installedVersion}, but the serving shim is newer (${servingVersion}). Reload plugins with /reload-plugins or restart Claude Code; the newer shim was left running.`;
}

// Fail-soft: read the running proxy's --version and, if it's below
// MIN_PROXY_VERSION, print exactly one stderr nudge. Never throws and never
// blocks the session; a version we can't read/parse is treated as "don't nag".
// Does NOT auto-download; that belongs in `setup`, not the 30s keepalive hook.
function warnIfProxyOutdated() {
  try {
    const floor = parseSemver(MIN_PROXY_VERSION);
    const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const got = parseSemver((v.stdout || '') + (v.stderr || ''));
    if (got && floor && semverLt(got, floor)) {
      console.error(`model-gateway: claude-code-proxy ${got.join('.')} is older than ${MIN_PROXY_VERSION}; Codex context-overflow recovery needs the newer proxy. Run the model-gateway skill setup to update (it downloads the latest).`);
    }
  } catch { /* fail-soft: a version check must never break the session */ }
}

async function startAll({ quiet = false } = {}) {
  if (!fs.existsSync(PROXY_BIN)) return { ok: false, reason: 'proxy binary missing (run setup)' };
  mkdirs();
  const started = [];
  const health = await fetchShimHealth();
  const staleSessionNotice = staleSessionReloadNotice(PLUGIN_VERSION, health);
  if (staleSessionNotice) noticeForUser(staleSessionNotice, { toStderr: true });
  if (health && shimNeedsRestart(PLUGIN_VERSION, health)) {
    const stopped = await stopRunningSupervisor({ quiet });
    if (!stopped.ok) return stopped;
  } else if (health) {
    reapGatewayOrphans(processOwningPort(PUBLIC_SHIM_PORT));
  } else if (await portListening(PUBLIC_SHIM_PORT)) {
    const stopped = await stopRunningSupervisor({ quiet });
    if (!stopped.ok) return stopped;
  } else {
    reapGatewayOrphans(null);
  }
  if (!(await shimHealthy())) {
    try { fs.rmSync(SHIM_FAILURE_PATH); } catch {}
    spawnDetached('guardian', process.execPath, [resolveNewestInstalledCliPath(), 'serve-shim'], {});
    started.push('shim');
  }
  const deadline = Date.now() + Math.max(12000, (Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000) + 12000);
  while (Date.now() < deadline) {
    if ((await proxyModelsAnswering()) && (await shimHealthy())) {
      if (!quiet && started.length) log(`started: ${started.join(', ')}`);
      await writeCatalog().catch(() => { /* advisory only; sidequest just won't see fresh models */ });
      return { ok: true, started };
    }
    if (fs.existsSync(SHIM_FAILURE_PATH)) {
      const reason = fs.readFileSync(SHIM_FAILURE_PATH, 'utf8').trim();
      return { ok: false, reason };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, reason: `not healthy after 12s (check logs in ${LOGS})` };
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

function shimNeedsRestart(installedVersion, health) {
  if (health?.proxyRecovery !== true) return true;
  const running = parseSemver(servingShimVersion(health));
  const installed = parseSemver(installedVersion);
  return !running || !installed || semverLt(running, installed);
}

async function restartSupervisorForVersionMismatch({ quiet = false, health = null, fetchHealth = fetchShimHealth, start = startAll } = {}) {
  const currentHealth = health || await fetchHealth().catch(() => null);
  if (currentHealth && !shimNeedsRestart(PLUGIN_VERSION, currentHealth)) return null;
  const stopped = await stopRunningSupervisor({ quiet });
  if (!stopped.ok) return stopped;
  return start({ quiet });
}

async function restartShimIfOutdated({
  quiet = false,
  fetchHealth = fetchShimHealth,
  restartWorker = restartWorkerWithDrain,
  restartSupervisor = restartSupervisorForVersionMismatch,
  start = startAll,
} = {}) {
  let health;
  try { health = await fetchHealth(); } catch { return null; }
  if (!shimNeedsRestart(PLUGIN_VERSION, health)) return null;
  return restartSupervisor({ quiet, health, restartWorker, start });
}

// What mode the running shim actually achieved this session: compat only if
// the user's hosts entry is present AND the shim actually managed to bind
// loopback:COMPAT_PORT (never trust the hosts file alone — a bind failure,
// e.g. no permission or something else already on :80, must fall back).
async function resolveIntendedMode() {
  const health = await fetchShimHealth();
  const compat = (health && health.compat) || { hostsDetected: false, port80Bound: false };
  return { mode: compat.hostsDetected && compat.port80Bound ? 'compat' : 'default', compat };
}

async function statusReport({ readiness = null } = {}) {
  const codex = readiness || await getCodexReadiness();
  const { checks, health } = codex;
  log(`proxy (claude-code-proxy) on :${PROXY_PORT}: ${checks.proxyModels ? 'answering /v1/models' : 'DOWN'}`);
  if (checks.shimRunning) {
    log(`models advertised to Claude Code: ${health?.models ?? 'unavailable'}`);
    log(health?.proxyRecovery
      ? 'proxy recovery: shim supervisor probes /v1/models and restarts an unavailable proxy with bounded backoff'
      : 'proxy recovery: unavailable until the shim supervisor is refreshed');
  }
  log(`shim (model router) on :${SHIM_PORT}: ${checks.shimRunning ? `running${checks.servingVersion ? ` (serving ${checks.servingVersion})` : ' (serving version unavailable)'}` : 'DOWN'}`);
  const compat = health?.compat;
  if (compat?.hostsDetected) {
    log(`RC-compatibility hosts entry: detected (${compat.hostsLine})`);
    log(`  127.0.0.1:${COMPAT_PORT} bound: ${compat.port80Bound ? 'yes' : `no${compat.reason ? ` (${compat.reason})` : ''}`}`);
  } else if (compat) {
    log('RC-compatibility hosts entry: not present (default gateway mode)');
  }
  log(`Codex readiness: ${codex.state}`);
  if (!codex.ready) log(codex.message);
  return { ok: codex.ready, health, readiness: codex };
}

// -------------------------------------------------------------- env wiring

function pinCommand() {
  if (args.length === 0) {
    for (const [alias, pin] of Object.entries(effectivePins())) {
      log(`${alias}: ${pin.value} (${pin.override ? `overridden; shipped default: ${pin.default}` : 'default'})`);
    }
    return;
  }

  const overrides = readPinOverrides();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const alias = option && option.startsWith('--') ? option.slice(2) : null;
    const value = args[index + 1];
    if (!Object.hasOwn(PIN_ALIASES, alias) || value == null) {
      die('pin expects --opus, --sonnet, or --fable followed by a model id or default', 2);
    }
    if (value === 'default') {
      delete overrides[alias];
      continue;
    }
    if (!isValidPin(value)) die(`invalid ${alias} pin: use a non-empty model id without whitespace or shell characters`, 2);
    overrides[alias] = value;
  }
  writePinOverrides(overrides);
  log(`saved Claude alias pins to ${PIN_OVERRIDE_PATH}`);
  log('Rewire with env --write-user, then start a new Claude Code session for the change to apply.');
}

async function syncEffectivePins() {
  await refreshDetectedPins();
  const current = wiredMode();
  if (!current?.scope) return;
  const env = readSettingsForWrite(settingsPath(current.scope)).env || {};
  if (Object.entries(pinEnvBlock()).some(([key, value]) => env[key] !== value)) {
    writeEnv(current.scope, false, { mode: current.mode, quiet: true });
  }
}

async function envCommand() {
  for (const retired of ['--mode', '--show-mode', '--write-project']) {
    if (flag(retired)) {
      die(`env ${retired} was removed: wiring is global only. Use env --write-user, or env --remove to unwire.`, 2);
    }
  }

  const reconcile = flag('--reconcile');
  const remove = flag('--remove');
  if (!flag('--write-user') && !remove) {
    log('add this to the "env" block of your ~/.claude/settings.json:');
    log(JSON.stringify({ env: envBlockFor('default') }, null, 2));
    log('\nor use /model-gateway:model-gateway to run its env --write-user command');
    log('\nWiring is global: one ~/.claude/settings.json block covers every project. It applies to new Claude Code sessions after restart.');
    log('RC-compatibility mode (restores /remote-control) is opt-in and automatic once you add the');
    log('hosts entry yourself; see the RC-compatibility mode section of the README.');
    return;
  }

  recordProjectWiring();
  if (!remove) await refreshDetectedPins({ force: true });
  writeEnv('user', remove, { mode: remove ? 'default' : (await resolveIntendedMode()).mode });
  retireWiringModeConfig();
  if (remove) return;

  // A project-local ANTHROPIC_BASE_URL outranks the user scope we just wrote, so
  // reporting success without naming the shadows would repeat the original defect.
  const targetBaseUrl = readSettingsForWrite(settingsPath('user')).env?.ANTHROPIC_BASE_URL;
  const result = reconcileRegisteredProjectWirings(targetBaseUrl, { confirm: reconcile });
  if (!result.conflicting.length) return;
  log(`${result.conflicting.length} recorded project-local wiring ${result.conflicting.length === 1 ? 'entry overrides' : 'entries override'} the global URL:`);
  for (const wiring of result.conflicting) log(`  ${wiring.file}`);
  if (reconcile) log(`removed model-gateway-owned wiring from ${result.reconciled.length} project${result.reconciled.length === 1 ? '' : 's'}`);
  else log('project files were not changed. To confirm cleanup, invoke env --write-user --reconcile for the model-gateway-owned entries shown above.');
}

// mode only matters when writing (not removing); quiet suppresses this
// function's own logging so a caller doing an automatic mode switch can print
// its own single, more specific line instead.
function writeEnv(scope, remove, { mode = 'default', quiet = false } = {}) {
  // Runs for the user scope too: a committed project settings.json carrying
  // gateway keys outranks ~/.claude/settings.json and would shadow this write.
  const migration = remove ? null : migrateLegacyProjectSettings();
  const effectiveMode = migration?.mode || mode;
  const file = settingsPath(scope);
  if (remove && !fs.existsSync(file)) {
    if (scope === 'project') recordProjectWiring();
    return { changed: false, file };
  }
  const settings = readSettingsForWrite(file);
  const original = JSON.stringify(settings);
  settings.env = settings.env || {};
  delete settings.env.ANTHROPIC_UNIX_SOCKET;
  if (remove) {
    const ownedPins = ownedPinValues();
    if (ourBaseUrls().includes(settings.env.ANTHROPIC_BASE_URL)) delete settings.env.ANTHROPIC_BASE_URL;
    for (const [k, v] of Object.entries({ ...gatewayEnvBlock(), ...LEGACY_ENV_BLOCK })) {
      const ours = ownedPins[k] ? ownedPins[k].has(String(settings.env[k])) : String(settings.env[k]) === String(v);
      if (ours) delete settings.env[k];
    }
    if (!Object.keys(settings.env).length) delete settings.env;
  } else {
    Object.assign(settings.env, envBlockFor(effectiveMode));
    for (const [k, v] of Object.entries(LEGACY_ENV_BLOCK)) {
      if (String(settings.env[k]) === String(v)) delete settings.env[k];
    }
    cleanLegacyGatewayModelCache();
  }
  if (remove && JSON.stringify(settings) === original) {
    if (scope === 'project') recordProjectWiring();
    return { changed: false, file };
  }
  writeSettings(file, settings);
  const verified = readSettingsForWrite(file);
  const expected = remove ? undefined : envBlockFor(effectiveMode).ANTHROPIC_BASE_URL;
  if (verified.env?.ANTHROPIC_BASE_URL !== expected) throw new Error(`Could not verify gateway settings in ${file}`);
  if (scope === 'project') recordProjectWiring();
  if (quiet) return { changed: true, file };
  log(`${remove ? 'removed from' : 'written to'} ${file}`);
  if (!remove) {
    log('new Claude Code sessions now use this wiring. Restart Claude Code, then open /model to see the Codex rows.');
  }
  return { changed: true, file };
}

// Called once per session (from `ensure`, after the shim is confirmed
// running) to keep the wired env in sync with the hosts file: promotes to
// compat mode when the entry appears and the shim actually bound :80, reverts
// to default the moment either condition stops holding (entry removed, or
// the port became unavailable). Exactly one log line when something changes;
// silent otherwise. Never touches settings this plugin didn't wire itself.
async function syncCompatMode() {
  const current = wiredMode();
  if (!current?.scope) return;
  const { mode, compat } = await resolveIntendedMode();
  if (mode === current.mode) return;
  writeEnv(current.scope, false, { mode, quiet: true });
  if (mode === 'compat') {
    log(`model-gateway: hosts entry mapping ${COMPAT_HOST} to loopback detected (${compat.hostsLine}); switched to RC-compatibility mode (http://${COMPAT_HOST} via 127.0.0.1:${COMPAT_PORT}). Restart Claude Code to enable /remote-control.`);
  } else {
    const why = compat.hostsDetected
      ? `127.0.0.1:${COMPAT_PORT} is unavailable${compat.reason ? ` (${compat.reason})` : ''}`
      : `the hosts entry mapping ${COMPAT_HOST} to loopback was removed`;
    log(`model-gateway: reverted to default gateway mode (${why}). Restart Claude Code.`);
  }
}

// ------------------------------------------------------------------ doctor

async function doctor({ readiness: suppliedReadiness = null } = {}) {
  const readiness = suppliedReadiness || await getCodexReadiness();
  log(`binary: ${readiness.checks.proxyBinary ? PROXY_BIN : 'MISSING (run setup)'}`);
  if (readiness.checks.proxyBinary) {
    const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    log(`version: ${(v.stdout || v.stderr || '').trim()}`);
    log(`codex auth: ${readiness.checks.codexAuth ? 'authenticated' : 'MISSING'}`);
  }
  try {
    grokBackend.readGrokAuth();
    log(`grok auth: present (${grokBackend.readGrokVersion()})`);
  } catch (error) {
    log(`grok auth: ${error.message}`);
  }
  const status = await statusReport({ readiness });
  const servingVersion = readiness.checks.servingVersion;
  log(`serving shim version: ${servingVersion || 'unavailable'}`);
  log('model fallback diagnostic: if dispatch and served models appear different, reproduce in a throwaway session with CLAUDE_CODE_NO_MODEL_FALLBACK=true; unset it afterwards. It turns silent fallback into a thrown error identifying the call site, while normal operation should keep graceful fallback for transient 5xx errors.');
  if (readiness.checks.shimRunning && !readiness.checks.servingVersionMatches) {
    log(`model-gateway: VERSION MISMATCH: CLI ${PLUGIN_VERSION}, serving shim ${servingVersion}. Run node "${resolveNewestInstalledCliPath()}" ensure to replace the stale supervisor.`);
  }
  const catalog = readCatalog();
  log(catalog && Array.isArray(catalog.models)
    ? `catalog: ${catalog.models.length} models at ${CATALOG_PATH} (writtenBy: ${catalog.writtenBy || 'unknown'})`
    : 'catalog: not written yet');
  for (const [alias, pin] of Object.entries(effectivePins())) {
    log(`Claude ${alias} pin: ${pin.value}${pin.override ? ` (overridden; shipped default: ${pin.default})` : ' (default)'}`);
  }
  const activeScope = selectedWiringScope();
  const effective = effectiveBaseUrl();
  const wiring = new Map();
  const modeFor = (base) => (base === COMPAT_BASE_URL ? 'compat' : base === DEFAULT_BASE_URL ? 'default' : null);
  const labelFor = {
    env: 'process env',
    'project-local': 'project settings.local.json',
    'project-shared': 'project settings.json',
    user: 'user settings.json',
  };
  const scopeFor = { 'project-local': 'project', user: 'user' };
  log('wiring: global ~/.claude/settings.json (one block covers every project)');
  for (const source of ['env', 'project-local', 'project-shared', 'user']) {
    const scope = scopeFor[source];
    const file = source === 'env' ? null : settingsPath(source === 'project-local' ? 'project' : source);
    let base = source === 'env' ? process.env.ANTHROPIC_BASE_URL : null;
    if (file) {
      try { base = JSON.parse(fs.readFileSync(file, 'utf8')).env?.ANTHROPIC_BASE_URL; } catch {}
    }
    const wired = ourBaseUrls().includes(base);
    const mode = modeFor(base);
    wiring.set(source, { base, file, mode, wired });
    const tags = [source === effective.source ? ' [effective]' : '', scope === activeScope ? ' [selected mode]' : ''].join('');
    const modeLabel = mode === 'compat' ? ' [RC-compatibility mode]' : mode === 'default' ? ' [default mode]' : '';
    log(`${labelFor[source]}: ${wired ? 'wired' + modeLabel : 'not wired'}${file ? ` (${file})` : ''}${tags}`);
  }
  const effectiveWired = ourBaseUrls().includes(effective.value);
  const effectiveScope = scopeFor[effective.source] || activeScope;
  if (!effectiveWired) {
    console.error('model-gateway: ERROR: global wiring is not configured. Run /model-gateway:model-gateway, then use its env --write-user command and restart Claude Code.');
    process.exitCode = 1;
  }
  const selected = wiring.get('user');
  const effectiveMode = modeFor(effective.value);
  if (effectiveMode && selected.mode && effectiveMode !== selected.mode) {
    const effectiveLocation = effective.file || 'process env ANTHROPIC_BASE_URL';
    // A project-local shadow is not fixed by rewriting the user scope, so the
    // remediation has to name the file that actually wins.
    const fix = effective.source === 'user'
      ? 'Run /model-gateway:model-gateway, then use its env --write-user command'
      : `Remove ANTHROPIC_BASE_URL from ${effectiveLocation}, or use /model-gateway:model-gateway to run its env --write-user --reconcile command and clear recorded project wiring`;
    console.error(`model-gateway: ERROR: effective ${effectiveLocation} uses ${effectiveMode} mode, but shadowed ${selected.file} uses ${selected.mode} mode. ${fix}, then restart Claude Code.`);
    process.exitCode = 1;
  }
  const scope = installScope();
  if (scope === 'project-only') {
    log('install scope: PROJECT-ONLY — the shim is not kept alive for other projects; reinstall at user scope.');
  } else if (scope === 'user') {
    log('install scope: user (correct)');
  }
  if (!status.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- the shim

// display_name feeds the /model PICKER only (with gateway model discovery on,
// for ids starting with claude-/anthropic-), where it shows correctly as e.g.
// "GPT-5.6 Terra (Codex)". It does NOT reach the running-subagent CARD: that
// surface resolves the model label internally and maps an unrecognized claude-*
// id (like claude-gpt-5.6-terra) to a Claude family name — it renders
// "Fable 5" for a Terra run. Nothing we return here overrides that (verified:
// the response model field is "gpt-5.6-terra" and the model self-reports GPT-5,
// so the RUN is correct — only the card label lies). Native subagent model
// display isn't a supported feature (anthropics/claude-code#24094, not planned).
// The sidequest agent NAME (sidequest-exec-codex-gpt-5-6-terra-*) carries the
// true runtime, so don't chase the badge by editing display_name — it's a dead
// end. See SQ-202.
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
];
const DEFAULT_GROK_MODELS = grokBackend.GROK_MODELS;

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

const ROUTE_MARKER_RE = /\[(sidequest-route) model=([a-z0-9][a-z0-9.-]{0,63})(?: effort=(low|medium|high|xhigh|max))?\]/g;
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
      writeFileAtomically(this.cachePath, JSON.stringify({ version: 1, routes: [...this.routes] }) + '\n', { mode: 0o600 });
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
  try {
    writeFileAtomically(catalogPath, JSON.stringify(nextCatalog, null, 2) + '\n');
  } catch (error) {
    log(`catalog: could not replace ${catalogPath} (${error.code || error.message}); the models list stays at its previous contents`);
    throw error;
  }
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
  const refresh = flag('--refresh');
  let catalog = readCatalog();
  const stale = !catalog || (Date.now() - Date.parse(catalog.updatedAt || 0) > CATALOG_STALE_MS);
  if ((refresh || stale) && (await shimHealthy())) {
    catalog = (await writeCatalog().catch(() => null)) || catalog;
  }
  if (!catalog) die('no catalog available yet (run setup or start first)');
  if (jsonOut) process.stdout.write(JSON.stringify(catalog) + '\n');
  else log(JSON.stringify(catalog, null, 2));
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

const { runWorker } = require('./request-worker.js');
function runShim() {
  mkdirs();
  const configuredWorkerPort = Number(process.env.CODEX_GATEWAY_WORKER_PORT || 0);
  const workerPortReportTimeoutMs = 5000;
  let workerPort = configuredWorkerPort;
  const timeout = Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000;
  const hostsEntry = detectHostsCompat();
  const compatState = { hostsDetected: !!hostsEntry, hostsLine: hostsEntry?.line ?? null, port80Bound: false, reason: null };
  let worker = null;
  let workerScript = CLI_PATH;
  let workerPortReportTimeout = null;
  let restarting = false;
  let stopped = false;
  const recoveryIntervalMs = Math.max(1000, Number(process.env.CODEX_GATEWAY_PROXY_RECOVERY_INTERVAL_MS) || 5000);
  const proxyRecovery = createProxyRecovery({ onStarted: () => writeProxyServingVersion(currentProxyVersion()) });
  let proxyRecoveryTimer = null;

  function clearWorkerPortReportTimeout() {
    if (!workerPortReportTimeout) return;
    clearTimeout(workerPortReportTimeout);
    workerPortReportTimeout = null;
  }

  function stopForMissingWorkerPort() {
    if (stopped || configuredWorkerPort || workerPort) return;
    stopped = true;
    console.error(`model-gateway: shim worker did not report its listener port within ${workerPortReportTimeoutMs}ms`);
    killPid(worker?.pid);
    main.close(() => process.exit(1));
  }

  function startWorker() {
    if (stopped || (worker && worker.exitCode == null)) return;
    if (!configuredWorkerPort) {
      workerPort = 0;
      workerPortReportTimeout ||= setTimeout(stopForMissingWorkerPort, workerPortReportTimeoutMs);
    }
    const out = fs.openSync(path.join(LOGS, 'shim.log'), 'a');
    const child = fork(workerScript, ['serve-worker'], {
      stdio: ['ignore', out, out, 'ipc'],
      windowsHide: true,
      env: { ...process.env, CODEX_GATEWAY_WORKER_PORT: String(configuredWorkerPort) },
    });
    fs.closeSync(out);
    worker = child;
    if (!configuredWorkerPort) {
      child.once('message', (message) => {
        const reportedPort = message?.type === 'listening' ? message.port : null;
        if (worker !== child || !Number.isInteger(reportedPort) || reportedPort < 1 || reportedPort > 65535) return;
        workerPort = reportedPort;
        clearWorkerPortReportTimeout();
      });
    }
    fs.writeFileSync(pidFile('shim'), String(child.pid));
    child.unref();
    child.once('exit', () => {
      if (worker === child) worker = null;
      removePid('shim');
      if (!stopped) setTimeout(startWorker, 50);
    });
  }

  function workerReady() {
    return portListening(workerPort, 100);
  }

  function requestWorker(req, body, retry = 0) {
    return new Promise((resolve, reject) => {
      if (!workerPort) {
        if (retry < 80 && !stopped) return setTimeout(() => requestWorker(req, body, retry + 1).then(resolve, reject), 50);
        return reject(new Error('shim worker did not report a listener port'));
      }
      const upstream = http.request({
        host: '127.0.0.1', port: workerPort, method: req.method, path: req.url, headers: req.headers,
      }, (response) => resolve(response));
      upstream.once('error', (error) => {
        if (retry < 80 && !stopped) return setTimeout(() => requestWorker(req, body, retry + 1).then(resolve, reject), 50);
        reject(error);
      });
      upstream.end(body);
    });
  }

  async function relay(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      const upstream = await requestWorker(req, body);
      if (req.url.split('?')[0] === '/healthz') {
        const response = [];
        upstream.on('data', (chunk) => response.push(chunk));
        upstream.once('end', () => {
          const health = JSON.parse(Buffer.concat(response).toString());
          health.supervisorVersion = PLUGIN_VERSION;
          health.proxyRecovery = true;
          health.compat = { ...compatState };
          res.writeHead(upstream.statusCode || 502, upstream.headers);
          res.end(JSON.stringify(health));
        });
        return;
      }
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    } catch {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model-gateway is restarting; retry this request shortly' } }));
    }
  }

  async function restartWorker(script) {
    if (script && path.isAbsolute(script)) workerScript = script;
    restarting = true;
    const current = worker;
    if (!current) {
      restarting = false;
      startWorker();
      return;
    }
    try { await postJson(`http://127.0.0.1:${workerPort}/drain`, { timeout }, timeout + 1000); } catch {}
    setTimeout(() => {
      if (worker === current && current.exitCode == null) {
        console.error(`model-gateway: shim drain timed out after ${Math.ceil(timeout / 1000)}s; force-stopping it.`);
        killPid(current.pid);
      }
    }, timeout);
    current.once('exit', () => {
      restarting = false;
      startWorker();
    });
  }

  function handle(req, res) {
    const pathOnly = req.url.split('?')[0];
    if (req.method === 'POST' && pathOnly === '/restart') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let script;
        try { script = JSON.parse(Buffer.concat(chunks).toString()).script; } catch {}
        restartWorker(script);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restarting: true }));
      });
      return;
    }
    return relay(req, res);
  }

  function monitorProxy() {
    void proxyRecovery.recover().catch((error) => {
      console.error(`${new Date().toISOString()} model-gateway: proxy recovery failed: ${error.message}`);
    });
  }

  function listen(port, host, callback) {
    const server = http.createServer(handle);
    server.requestTimeout = 0;
    server.headersTimeout = 120000;
    server.keepAliveTimeout = 75000;
    server.listen(port, host, callback);
    return server;
  }

  const main = listen(PUBLIC_SHIM_PORT, '127.0.0.1', () => {
    const publicShimPort = main.address().port;
    try { fs.rmSync(SHIM_FAILURE_PATH); } catch {}
    console.log(`model-gateway shim supervisor listening on 127.0.0.1:${publicShimPort}`);
    startWorker();
    monitorProxy();
    proxyRecoveryTimer = setInterval(monitorProxy, recoveryIntervalMs);
    proxyRecoveryTimer.unref();
  });
  main.once('error', (error) => {
    stopped = true;
    const owner = error.code === 'EADDRINUSE' ? processOwningPort(PUBLIC_SHIM_PORT) : null;
    const remedy = owner
      ? `PID ${owner} owns 127.0.0.1:${PUBLIC_SHIM_PORT}; run node "${CLI_PATH}" stop, then node "${CLI_PATH}" ensure.`
      : `run node "${CLI_PATH}" stop, then node "${CLI_PATH}" ensure.`;
    const message = `model-gateway: shim supervisor cannot bind 127.0.0.1:${PUBLIC_SHIM_PORT}: ${error.code || error.message}; ${remedy}`;
    try { fs.writeFileSync(SHIM_FAILURE_PATH, message); } catch {}
    console.error(message);
    setImmediate(() => process.exit(1));
  });
  let compatServer = null;
  if (hostsEntry) {
    compatServer = listen(COMPAT_PORT, hostsEntry.ip, () => {
      compatState.port80Bound = true;
      console.log(`model-gateway RC-compatibility supervisor on ${hostsEntry.ip}:${COMPAT_PORT}`);
    });
    compatServer.once('error', (error) => {
      compatState.reason = error.code || error.message;
      console.error(`model-gateway: RC-compatibility supervisor unavailable: ${compatState.reason}`);
    });
  }
  process.once('SIGTERM', () => {
    stopped = true;
    clearInterval(proxyRecoveryTimer);
    killPid(worker?.pid);
    compatServer?.close();
    main.close(() => process.exit(0));
  });
}


const commands = {
  setup: () => setup(),
  login: () => {
    if (!fs.existsSync(PROXY_BIN)) die('proxy binary missing, run setup first');
    const mode = flag('--device') ? 'device' : 'login';
    const result = spawnSync(PROXY_BIN, ['codex', 'auth', mode], { stdio: 'inherit', windowsHide: true });
    if (result.status === 0) log('signed in; run setup once more to finish wiring Claude Code');
    process.exitCode = result.status == null ? 1 : result.status;
  },
  start: async () => {
    const result = await startAll();
    if (!result.ok) die(result.reason);
    await statusReport();
  },
  stop: () => { stopAll(); log('stopped'); },
  ensure: async () => {
    const quiet = flag('--quiet');
    if (quiet) bufferedHookLines = [];
    // The hook path exits 0 even on a refusal state, because Claude Code reads a hook's stdout JSON only on a
    // zero exit: exiting nonzero there trades the one user-visible line for a bare "hook failed" badge, which is
    // this ticket's whole complaint (SQ-1901). A direct `ensure` still fails loudly for the updater and for a
    // person running it by hand.
    const finish = (code) => { flushHookOutput(); process.exit(quiet ? 0 : code); };
    cleanLegacyEnvSettings();
    cleanLegacyGatewayModelCache();
    sweepOldProxyBinaries();
    const wired = isWired();
    const initialReadiness = await getCodexReadiness();
    if (!initialReadiness.checks.proxyBinary) {
      if (wired) {
        noticeForUser(initialReadiness.message, { toStderr: true });
        finish(1);
      }
      noticeForUser('model-gateway is installed but not set up. Offer to run its setup (one command; needs a ChatGPT browser sign-in) to put the user\'s ChatGPT/Codex models in the /model picker. See the model-gateway skill.');
      finish(0);
    }
    await restartProxyIfOutdated({ quiet });
    const result = await startAll({ quiet });
    if (!result.ok) {
      noticeForUser(`model-gateway could not start: ${result.reason}. Run \`node "${CLI_PATH}" doctor\` to see which part is down.`, { toStderr: true });
      finish(1);
    }
    const readiness = await getCodexReadiness();
    if (wired && !readiness.ready) {
      noticeForUser(readiness.message, { toStderr: true });
      finish(1);
    }
    warnIfProxyOutdated();
    if (!wired) {
      noticeForUser(readiness.checks.codexAuth
        ? `Claude Code is not wired to model-gateway, so your ChatGPT/Codex models are missing from /model. Run \`node "${CLI_PATH}" env --write-user\`, then restart Claude Code.`
        : 'model-gateway is running but not signed in to ChatGPT. Offer to run its login (browser sign-in), then setup to finish wiring. See the model-gateway skill.');
    } else {
      if (installScope() === 'project-only') {
        noticeForUser('model-gateway is installed PROJECT-ONLY, but wiring is global. Other projects route through a shim this hook will not keep alive. Reinstall at user scope.');
      }
      // isWired() accepts a base URL exported by the shell, which is how a machine ends up routed only in the
      // terminal that exported it: background sessions and executor worktrees start unwired, and the only place
      // that said so was a per-request stderr line in the worker.
      const wiring = effectiveBaseUrl();
      if (wiring.source === 'env' && !wiring.shadowed.some((definition) => definition.file)) {
        noticeForUser(`model-gateway wiring is shell-only: ANTHROPIC_BASE_URL comes from this terminal's environment and no settings file sets it, so sessions started anywhere else are not routed through the gateway. Run \`node "${CLI_PATH}" env --write-user\` to make it permanent.`);
      }
      await syncCompatMode();
      await syncEffectivePins();
    }
    if (!quiet) await statusReport({ readiness });
    flushHookOutput();
  },
  status: async () => { process.exitCode = (await statusReport()).ok ? 0 : 1; },
  models: async () => {
    const result = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 })
      .catch(() => die('shim not running (start it first)'));
    log(JSON.stringify(JSON.parse(result.body.toString()), null, 2));
  },
  catalog: () => catalogCommand(),
  pin: () => pinCommand(),
  env: () => envCommand(),
  doctor: (options) => doctor(options),
  'remote-control': () => remoteControlCommand(),
  'serve-shim': () => runShim(),
  'serve-worker': () => runWorker(),
};

module.exports = {
  commands,
  usage: USAGE,
  parseHostsCompatEntry,
  parseHostsCompatBlock,
  addManagedHostsBlock,
  removeManagedHostsBlock,
  findConflictingHostsMappings,
  managedHostsBlock,
  detectHostsCompat,
  hostsFilePath,
  envBlockFor,
  ourBaseUrls,
  isWired,
  wiredMode,
  writeEnv,
  migrateLegacyProjectSettings,
  effectiveBaseUrl,
  settingsPath,
  COMPAT_HOST,
  COMPAT_PORT,
  DEFAULT_BASE_URL,
  COMPAT_BASE_URL,
  SOCKET_PATH,
  WIRING_CONFIG_PATH,
  parseSemver,
  semverLt,
  resolveNewestInstalledCliPath,
  staleSessionReloadNotice,
  oldProxyPath,
  replaceProxyBinary,
  restartProxyForVersionChange,
  restartProxyIfOutdated,
  sweepOldProxyBinaries,
  shimNeedsRestart,
  servingShimVersion,
  restartShimIfOutdated,
  restartSupervisorForVersionMismatch,
  stopShimWithDrain,
  PLUGIN_VERSION,
  MIN_PROXY_VERSION,
  getCodexReadiness,
  catalogReadiness,
  getGrokReadiness,
  setUpstreamBlocked,
  clearUpstreamBlocked,
  noteCodexRequestSuccess,
  hasOpenAiRejectionEvidence,
  noteCodexUpstreamRejection,
  CODEX_UPSTREAM_BLOCK_PATH,
  CATALOG_SCHEMA_VERSION,
  codexBaseFromId,
  isGatewayModelId,
  buildCatalog,
  writeCatalogFile,
  DispatchSessionRouteCache,
  dispatchModelFromRawBody,
  dispatchRouteFromMessages,
};
