#!/usr/bin/env node
'use strict';
/*
 * codex-gateway: put your ChatGPT/Codex subscription models in Claude Code's
 * /model picker.
 *
 * Two local processes make that happen:
 *   1. claude-code-proxy (raine/claude-code-proxy) translates the Anthropic
 *      Messages API to the Codex subscription backend. It owns the OAuth.
 *   2. This file's `serve-shim` mode, a router in front of it. Claude Code's
 *      ANTHROPIC_BASE_URL points HERE. Requests for `claude-codex-*` models
 *      are un-prefixed and sent to the proxy; everything else passes through
 *      to api.anthropic.com untouched (claude.ai login keeps working). The
 *      shim's /v1/models advertises the proxy's Codex models under the
 *      `claude-codex-` prefix because Claude Code's gateway model discovery
 *      drops ids that don't start with "claude" or "anthropic".
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

const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const STATE = path.join(os.homedir(), '.claude', 'codex-gateway');
const LOGS = path.join(STATE, 'logs');
const BIN_DIR = path.join(STATE, 'bin');
const PROXY_BIN = path.join(BIN_DIR, WIN ? 'claude-code-proxy.exe' : 'claude-code-proxy');
const SHIM_PORT = Number(process.env.CODEX_GATEWAY_PORT || 18764);
const PROXY_PORT = Number(process.env.CODEX_GATEWAY_PROXY_PORT || 18765);
const PREFIX = 'claude-codex-';
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

// ---------------------------------------------------- RC-compatibility mode
//
// COMPAT_PORT/COMPAT_HOST/hostsFilePath are overridable so tests never touch
// a real port 80 or a real hosts file; CODEX_GATEWAY_COMPAT_PORT and
// CODEX_GATEWAY_HOSTS_FILE are test/advanced-use knobs, not part of normal
// setup (the shim always wants real port 80 and the real OS hosts file
// outside of tests).
const COMPAT_HOST = 'api.anthropic.com';
const COMPAT_PORT = Number(process.env.CODEX_GATEWAY_COMPAT_PORT || 80);
const DEFAULT_BASE_URL = `http://127.0.0.1:${SHIM_PORT}`;
const COMPAT_BASE_URL = `http://${COMPAT_HOST}`;
const HOSTS_BLOCK_START = '# >>> codex-gateway RC compatibility >>>';
const HOSTS_BLOCK_END = '# <<< codex-gateway RC compatibility <<<';
const HOSTS_BLOCK_LINE = `127.0.0.1 ${COMPAT_HOST}`;

const STATIC_ENV_BLOCK = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  // Gateway discovery only identifies models. Claude Code cannot verify a
  // third-party model's capacity from it, so ordinary gateway models use its
  // conservative 200k context budget. Pin the real Claude 1M models (opus,
  // sonnet, fable) to their [1m] ids so a session on one gets its true 1M
  // window instead of the 200k gateway default. Haiku is 200k, leave it
  // unpinned. Codex models must stay unsuffixed: [1m] is a local Claude Code
  // override that delays compaction until far beyond Codex's 272k limit.
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5[1m]',
  // Lift the per-response output cap above Claude Code's 32k gateway default so
  // long Codex turns and the auto-compaction summary don't trip "response
  // exceeded the 32000 output token maximum". No per-model output override
  // exists, so this is global and also applies to Claude passthrough; lower it
  // if any backend rejects a 64k max_tokens request.
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
};

// The only plugin-owned setting that differs between default and
// RC-compatibility mode is ANTHROPIC_BASE_URL; everything else stays put.
function envBlockFor(mode) {
  return { ANTHROPIC_BASE_URL: mode === 'compat' ? COMPAT_BASE_URL : DEFAULT_BASE_URL, ...STATIC_ENV_BLOCK };
}
function ourBaseUrls() { return [DEFAULT_BASE_URL, COMPAT_BASE_URL]; }

// Versions through 0.4.1 wrote this unsafe global override. Remove it during
// the next env write/remove, but leave a user-supplied different value alone.
const LEGACY_ENV_BLOCK = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000',
};
const GATEWAY_MODELS_CACHE = path.join(os.homedir(), '.claude', 'cache', 'gateway-models.json');

const USAGE = `usage: codex-gateway.js <command>

  setup            download the claude-code-proxy binary (v-latest) into ${BIN_DIR}
  login [--device] run the ChatGPT OAuth flow (--device for headless device-code)
  start | stop     start/stop the proxy + shim (detached, logs in ${LOGS})
  ensure [--quiet] start whatever isn't running; used by the SessionStart hook
  status           show what's running
  models           show the model list the shim advertises to Claude Code
  catalog [--json] print the sidequest-readable model catalog (${path.join(STATE, 'catalog.json')})
  env [--write-user | --write-project | --remove]
                   print the Claude Code env block, or merge/remove it in settings.json
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

function log(m) { console.log(m); }
function die(m, code) { console.error('codex-gateway: ' + m); process.exit(code == null ? 1 : code); }
function mkdirs() { for (const d of [STATE, LOGS, BIN_DIR]) fs.mkdirSync(d, { recursive: true }); }

// ------------------------------------------------------------ small helpers

function fetchUrl(url, { timeout = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'codex-gateway', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, { timeout, headers }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout: ' + url)));
  });
}

function portListening(port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(timeout, () => done(false));
  });
}

async function shimHealthy() {
  try {
    const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/healthz`, { timeout: 1000 });
    return r.status === 200;
  } catch { return false; }
}

function pidFile(name) { return path.join(STATE, name + '.pid'); }
function stopAll() {
  killPid(readPid('shim'));
  killPid(readPid('proxy'));
  for (const n of ['shim', 'proxy']) { try { fs.rmSync(pidFile(n)); } catch { /* absent */ } }
}
function readPid(name) {
  try { return Number(fs.readFileSync(pidFile(name), 'utf8').trim()) || null; } catch { return null; }
}
function killPid(pid) {
  if (!pid) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

function spawnDetached(name, command, cmdArgs, env) {
  const out = fs.openSync(path.join(LOGS, name + '.log'), 'a');
  const child = spawn(command, cmdArgs, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...env },
  });
  fs.writeFileSync(pidFile(name), String(child.pid));
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

function settingsPath(scope) {
  return scope === 'project'
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.claude', 'settings.json');
}

function cleanLegacyEnvSettings() {
  for (const scope of ['user', 'project']) {
    const file = settingsPath(scope);
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!settings.env) continue;
    let changed = false;
    for (const [k, v] of Object.entries(LEGACY_ENV_BLOCK)) {
      if (String(settings.env[k]) === String(v)) {
        delete settings.env[k];
        changed = true;
      }
    }
    if (!changed) continue;
    if (!Object.keys(settings.env).length) delete settings.env;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
}

function cleanLegacyGatewayModelCache() {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(GATEWAY_MODELS_CACHE, 'utf8')); } catch { return false; }
  if (!ourBaseUrls().includes(cache.baseUrl) || !Array.isArray(cache.models)) return false;
  if (!cache.models.some((m) => m && typeof m.id === 'string'
    && m.id.startsWith(PREFIX) && /\[1m\]$/.test(m.id))) return false;
  cache.models = cache.models.map((m) => {
    if (!m || typeof m.id !== 'string' || !m.id.startsWith(PREFIX)) return m;
    return { ...m, id: m.id.replace(/\[1m\]$/, '') };
  });
  try {
    fs.writeFileSync(GATEWAY_MODELS_CACHE, JSON.stringify(cache, null, 2) + '\n');
  } catch { return false; }
  return true;
}

function isWired() {
  if (ourBaseUrls().includes(process.env.ANTHROPIC_BASE_URL)) return true;
  for (const scope of ['user', 'project']) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath(scope), 'utf8'));
      if (s.env && ourBaseUrls().includes(s.env.ANTHROPIC_BASE_URL)) return true;
    } catch { /* absent or unparsable */ }
  }
  return false;
}

// Which scope currently has a plugin-owned ANTHROPIC_BASE_URL, and which mode
// it encodes. null means codex-gateway hasn't wired anything yet.
function wiredMode() {
  for (const scope of ['user', 'project']) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath(scope), 'utf8'));
      const base = s.env && s.env.ANTHROPIC_BASE_URL;
      if (base === COMPAT_BASE_URL) return { scope, mode: 'compat' };
      if (base === DEFAULT_BASE_URL) return { scope, mode: 'default' };
    } catch { /* absent or unparsable */ }
  }
  return null;
}

// ------------------------------------------------- RC-compatibility hosts

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1']);

function hostsFilePath() {
  if (process.env.CODEX_GATEWAY_HOSTS_FILE) return process.env.CODEX_GATEWAY_HOSTS_FILE;
  return WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';
}

// Cross-platform hosts syntax is identical on Windows/macOS/Linux: one entry
// per line, "<ip> <hostname> [alias...]", '#' starts a trailing comment,
// fields are whitespace-separated. Only an EXACT loopback mapping for
// api.anthropic.com counts — anything mapping to a non-loopback address is
// ignored (it isn't a route back to this shim, so switching would break
// Claude Code, not enable compatibility mode).
function parseHostsCompatEntry(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [ip, ...names] = line.split(/\s+/);
    if (!LOOPBACK_IPS.has(ip)) continue;
    if (names.some((n) => n.toLowerCase().replace(/\.$/, '') === COMPAT_HOST)) {
      return { ip, line: rawLine.trim() };
    }
  }
  return null;
}

function parseHostsCompatBlock(text) {
  const start = text.indexOf(HOSTS_BLOCK_START);
  const end = text.indexOf(HOSTS_BLOCK_END);
  if (start < 0 && end < 0) return { state: 'absent', block: null };
  if (start < 0 || end < 0 || end < start) return { state: 'partial', block: null };
  const endIndex = end + HOSTS_BLOCK_END.length;
  const block = text.slice(start, endIndex);
  const before = text.slice(0, start);
  const after = text.slice(endIndex);
  if (parseHostsCompatEntry(block)) return { state: 'valid', block, before, after };
  return { state: 'invalid', block, before, after };
}

function managedHostsBlock(eol = '\n') {
  return [HOSTS_BLOCK_START, HOSTS_BLOCK_LINE, HOSTS_BLOCK_END].join(eol) + eol;
}

function addManagedHostsBlock(text) {
  const parsed = parseHostsCompatBlock(text);
  if (parsed.state === 'valid') return { text, changed: false };
  if (parsed.state !== 'absent') throw new Error(`plugin-marked hosts block is ${parsed.state}; run remote-control doctor and repair it manually`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text && !text.endsWith('\n') ? eol : '';
  return { text: text + separator + managedHostsBlock(eol), changed: true };
}

function removeManagedHostsBlock(text) {
  const parsed = parseHostsCompatBlock(text);
  if (parsed.state === 'absent') return { text, changed: false };
  if (parsed.state !== 'valid') throw new Error(`plugin-marked hosts block is ${parsed.state}; run remote-control doctor and repair it manually`);
  const after = parsed.after.replace(/^\r?\n/, '');
  const next = (parsed.before + after).replace(/(?:\r?\n){3,}/g, (match) => match.includes('\r\n') ? '\r\n\r\n' : '\n\n');
  return { text: next, changed: true };
}

function findConflictingHostsMappings(text) {
  const conflicts = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.includes(HOSTS_BLOCK_START) || rawLine.includes(HOSTS_BLOCK_END)) continue;
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const [ip, ...names] = line.split(/\s+/);
    if (names.some((name) => name.toLowerCase().replace(/\.$/, '') === COMPAT_HOST) && !LOOPBACK_IPS.has(ip)) {
      conflicts.push(rawLine.trim());
    }
  }
  return conflicts;
}

function readHostsFile() {
  const file = hostsFilePath();
  try { return { file, text: fs.readFileSync(file, 'utf8') }; }
  catch (error) { return { file, text: null, error }; }
}

function hostsWriteStatus(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return 'available';
  } catch { return 'missing (run from an elevated terminal)'; }
}

async function lookupCompatHost() {
  try { return await dns.promises.lookup(COMPAT_HOST); }
  catch { return null; }
}

function elevatedHostsInstructions(action) {
  if (WIN) {
    return `Open Notepad as Administrator, then ${action} the plugin-marked block in ${hostsFilePath()}.`;
  }
  return `Use sudo to ${action} the plugin-marked block in ${hostsFilePath()}.`;
}

async function remoteControlCommand() {
  const action = args[0];
  if (!['enable', 'disable', 'doctor'].includes(action)) {
    die('usage: remote-control <enable|disable|doctor>');
  }
  const { file, text, error } = readHostsFile();
  const parsed = text == null ? { state: 'unreadable', block: null } : parseHostsCompatBlock(text);
  const conflicts = text == null ? [] : findConflictingHostsMappings(text);
  const detected = text == null ? null : parseHostsCompatEntry(text);

  if (action === 'doctor') {
    log(`hosts file: ${file}`);
    log(`plugin block: ${parsed.state}`);
    log(`loopback mapping: ${detected ? detected.line : 'not present'}`);
    log(`conflicting mappings: ${conflicts.length ? conflicts.join(' | ') : 'none'}`);
    log(`elevated write: ${hostsWriteStatus(file)}`);
    const dnsResult = await lookupCompatHost();
    log(`DNS lookup: ${dnsResult ? `${dnsResult.address} (IPv${dnsResult.family})` : 'failed'}`);
    await doctor();
    return;
  }

  if (text == null) {
    die(`cannot read hosts file ${file}: ${error && (error.code || error.message)}`);
  }
  if (conflicts.length) {
    die(`conflicting non-loopback mapping for ${COMPAT_HOST}: ${conflicts.join(' | ')}. Remove it manually before enabling compatibility mode.`);
  }

  const operation = action === 'enable' ? addManagedHostsBlock : removeManagedHostsBlock;
  let transformed;
  try { transformed = operation(text); } catch (error) { die(error.message); }
  if (!transformed.changed) {
    log(`remote-control compatibility is already ${action === 'enable' ? 'enabled' : 'disabled'} in ${file}`);
    return;
  }

  log(`${action === 'enable' ? 'Enable' : 'Disable'} Remote Control compatibility by ${action === 'enable' ? 'adding' : 'removing'} only this block:`);
  log(action === 'enable' ? managedHostsBlock(text.includes('\r\n') ? '\r\n' : '\n').trim() : parsed.block);
  log(`This needs elevation. ${elevatedHostsInstructions(action === 'enable' ? 'add' : 'remove')}`);
  log('Do you want to make this hosts-file change now? Re-run with --confirm only after the user answers yes.');
  if (!flag('--confirm')) return;

  const backup = `${file}.codex-gateway-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  try {
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, transformed.text);
  } catch (writeError) {
    die(`could not write ${file}: ${writeError.code || writeError.message}. Backup ${backup} may exist. ${elevatedHostsInstructions('edit')}`);
  }
  log(`backup: ${backup}`);
  const result = await startAll();
  if (!result.ok) die(`hosts file changed, but gateway reconciliation failed: ${result.reason}`);
  await syncCompatMode();
  await remoteControlVerify();
}

async function remoteControlVerify() {
  const entry = detectHostsCompat();
  const health = await fetchShimHealth();
  const dnsResult = await lookupCompatHost();
  const modelCount = health ? health.models : 0;
  log(`DNS/hosts mapping: ${dnsResult ? `${dnsResult.address} (IPv${dnsResult.family})` : 'FAILED'}`);
  log(`hosts entry: ${entry ? entry.line : 'MISSING'}`);
  log(`port ${COMPAT_PORT}: ${health && health.compat.port80Bound ? 'bound' : 'unavailable'}`);
  log(`shim health: ${health && health.ok ? 'healthy' : 'DOWN'}`);
  log(`Codex discovery: ${modelCount ? `${modelCount} models` : 'unavailable'}`);
  log(`Remote Control eligibility: ${entry && health && health.compat.port80Bound ? `ready after Claude Code restarts with ${COMPAT_BASE_URL}` : 'not ready'}`);
}

// Read-only: codex-gateway never writes to the hosts file. Returns
// { ip, line } when the user has added the exact managed entry, else null.
function detectHostsCompat() {
  let text;
  try { text = fs.readFileSync(hostsFilePath(), 'utf8'); } catch { return null; }
  return parseHostsCompatEntry(text);
}

// codex-gateway is inherently a USER-SCOPE tool: it wires a GLOBAL env var
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
    const entries = (data.plugins && data.plugins['codex-gateway@eigenwise-toolshed']) || [];
    if (!entries.length) return 'unknown';
    return entries.some((e) => e.scope === 'user') ? 'user' : 'project-only';
  } catch { return 'unknown'; }
}

function isAuthed() {
  const r = spawnSync(PROXY_BIN, ['codex', 'auth', 'status'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 && /account/i.test((r.stdout || '') + (r.stderr || ''));
}

// ------------------------------------------------------------------- setup

async function setup() {
  mkdirs();
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

  // Windows can't overwrite a running exe; setup doubles as the upgrade
  // path, so stop the gateway before extracting (restarted below)
  stopAll();
  await new Promise((r) => setTimeout(r, 700)); // let the file lock release
  const tmp = path.join(BIN_DIR, assetName);
  fs.writeFileSync(tmp, archive.body);
  // Windows: force the System32 bsdtar (reads zip); PATH may find Git's GNU
  // tar, which reads neither zip nor "C:\..." paths. Relative paths + cwd
  // keep GNU tar on other platforms happy too.
  const tarBin = WIN
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const tar = spawnSync(tarBin, ['-xf', assetName], { encoding: 'utf8', cwd: BIN_DIR });
  if (tar.status !== 0) die(`extract failed: ${tar.stderr || tar.status}`);
  fs.rmSync(tmp);
  if (!fs.existsSync(PROXY_BIN)) {
    // some archives nest the binary; find and move it up
    const found = fs.readdirSync(BIN_DIR, { recursive: true })
      .map(String).find((f) => path.basename(f) === path.basename(PROXY_BIN));
    if (!found) die(`extracted, but ${path.basename(PROXY_BIN)} not found in ${BIN_DIR}`);
    fs.renameSync(path.join(BIN_DIR, found), PROXY_BIN);
  }
  if (!WIN) fs.chmodSync(PROXY_BIN, 0o755);

  const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8' });
  log(`installed: ${(v.stdout || v.stderr || '').trim() || PROXY_BIN}`);

  // one-shot: start everything, and finish the wiring when auth already works
  const r = await startAll();
  if (!r.ok) die(r.reason);
  if (!isAuthed()) {
    log(`next: node "${__filename}" login   (ChatGPT browser sign-in), then setup again to wire Claude Code`);
    return;
  }
  log('ChatGPT auth: valid');
  const { mode } = await resolveIntendedMode();
  if (isWired()) {
    const current = wiredMode();
    if (current && current.mode !== mode) {
      writeEnv(current.scope, false, { mode, quiet: true });
      log(`codex-gateway: hosts compatibility state changed since last wired; switched ${current.scope} settings to ${mode} mode. Restart Claude Code.`);
    } else {
      log('already wired; restart Claude Code and open /model');
    }
    return;
  }
  writeEnv('user', false, { mode });
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

// Fail-soft: read the running proxy's --version and, if it's below
// MIN_PROXY_VERSION, print exactly one stderr nudge. Never throws and never
// blocks the session; a version we can't read/parse is treated as "don't nag".
// Does NOT auto-download; that belongs in `setup`, not the 30s keepalive hook.
function warnIfProxyOutdated() {
  try {
    const floor = parseSemver(MIN_PROXY_VERSION);
    const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', timeout: 10000 });
    const got = parseSemver((v.stdout || '') + (v.stderr || ''));
    if (got && floor && semverLt(got, floor)) {
      console.error(`codex-gateway: claude-code-proxy ${got.join('.')} is older than ${MIN_PROXY_VERSION}; Codex context-overflow recovery needs the newer proxy. Run the codex-gateway skill setup to update (it downloads the latest).`);
    }
  } catch { /* fail-soft: a version check must never break the session */ }
}

async function startAll({ quiet = false } = {}) {
  if (!fs.existsSync(PROXY_BIN)) return { ok: false, reason: 'proxy binary missing (run setup)' };
  mkdirs();
  let started = [];
  if (!(await portListening(PROXY_PORT))) {
    spawnDetached('proxy', PROXY_BIN, ['serve', '--no-monitor'], { PORT: String(PROXY_PORT) });
    started.push('proxy');
  }
  if (!(await shimHealthy())) {
    spawnDetached('shim', process.execPath, [__filename, 'serve-shim'], {});
    started.push('shim');
  }
  // wait for both to come up
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if ((await portListening(PROXY_PORT)) && (await shimHealthy())) {
      if (!quiet && started.length) log(`started: ${started.join(', ')}`);
      await writeCatalog().catch(() => { /* advisory only; sidequest just won't see fresh models */ });
      return { ok: true, started };
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

// What mode the running shim actually achieved this session: compat only if
// the user's hosts entry is present AND the shim actually managed to bind
// loopback:COMPAT_PORT (never trust the hosts file alone — a bind failure,
// e.g. no permission or something else already on :80, must fall back).
async function resolveIntendedMode() {
  const health = await fetchShimHealth();
  const compat = (health && health.compat) || { hostsDetected: false, port80Bound: false };
  return { mode: compat.hostsDetected && compat.port80Bound ? 'compat' : 'default', compat };
}

async function statusReport() {
  const proxyUp = await portListening(PROXY_PORT);
  const shimUp = await shimHealthy();
  log(`proxy (claude-code-proxy) on :${PROXY_PORT}: ${proxyUp ? 'running' : 'DOWN'}`);
  log(`shim (model router) on :${SHIM_PORT}: ${shimUp ? 'running' : 'DOWN'}`);
  let health = null;
  if (shimUp) {
    health = await fetchShimHealth();
    try {
      const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 });
      const n = (JSON.parse(r.body.toString()).data || []).length;
      log(`models advertised to Claude Code: ${n}`);
    } catch { log('models advertised to Claude Code: (unavailable)'); }
  }
  const compat = health && health.compat;
  if (compat && compat.hostsDetected) {
    log(`RC-compatibility hosts entry: detected (${compat.hostsLine})`);
    log(`  127.0.0.1:${COMPAT_PORT} bound: ${compat.port80Bound ? 'yes' : `no${compat.reason ? ` (${compat.reason})` : ''}`}`);
  } else if (compat) {
    log('RC-compatibility hosts entry: not present (default gateway mode)');
  }
  return proxyUp && shimUp;
}

// -------------------------------------------------------------- env wiring

function envCommand() {
  const remove = flag('--remove');
  const scope = flag('--write-project') ? 'project' : flag('--write-user') ? 'user' : null;
  if (!scope) {
    log('add this to the "env" block of your Claude Code settings.json:');
    log(JSON.stringify({ env: envBlockFor('default') }, null, 2));
    log('\nor run: env --write-user   (global) / --write-project (this repo)');
    log('\nRC-compatibility mode (restores /remote-control) is opt-in and automatic once you add the');
    log('hosts entry yourself; see the RC-compatibility mode section of the README.');
    return;
  }
  writeEnv(scope, remove);
}

// mode only matters when writing (not removing); quiet suppresses this
// function's own logging so a caller doing an automatic mode switch can print
// its own single, more specific line instead.
function writeEnv(scope, remove, { mode = 'default', quiet = false } = {}) {
  const file = settingsPath(scope);
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  settings.env = settings.env || {};
  if (remove) {
    if (ourBaseUrls().includes(settings.env.ANTHROPIC_BASE_URL)) delete settings.env.ANTHROPIC_BASE_URL;
    for (const [k, v] of Object.entries({ ...STATIC_ENV_BLOCK, ...LEGACY_ENV_BLOCK })) {
      if (String(settings.env[k]) === String(v)) delete settings.env[k];
    }
    if (!Object.keys(settings.env).length) delete settings.env;
  } else {
    Object.assign(settings.env, envBlockFor(mode));
    for (const [k, v] of Object.entries(LEGACY_ENV_BLOCK)) {
      if (String(settings.env[k]) === String(v)) delete settings.env[k];
    }
    cleanLegacyGatewayModelCache();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  if (quiet) return;
  log(`${remove ? 'removed from' : 'written to'} ${file}`);
  if (!remove) {
    log('every new Claude Code session now routes through the shim; the SessionStart');
    log('hook keeps it alive. Restart Claude Code, then open /model to see the Codex rows.');
  }
}

// Called once per session (from `ensure`, after the shim is confirmed
// running) to keep the wired env in sync with the hosts file: promotes to
// compat mode when the entry appears and the shim actually bound :80, reverts
// to default the moment either condition stops holding (entry removed, or
// the port became unavailable). Exactly one log line when something changes;
// silent otherwise. Never touches settings this plugin didn't wire itself.
async function syncCompatMode() {
  const current = wiredMode();
  if (!current) return;
  const { mode, compat } = await resolveIntendedMode();
  if (mode === current.mode) return;
  writeEnv(current.scope, false, { mode, quiet: true });
  if (mode === 'compat') {
    log(`codex-gateway: hosts entry mapping ${COMPAT_HOST} to loopback detected (${compat.hostsLine}); switched to RC-compatibility mode (http://${COMPAT_HOST} via 127.0.0.1:${COMPAT_PORT}). Restart Claude Code to enable /remote-control.`);
  } else {
    const why = compat.hostsDetected
      ? `127.0.0.1:${COMPAT_PORT} is unavailable${compat.reason ? ` (${compat.reason})` : ''}`
      : `the hosts entry mapping ${COMPAT_HOST} to loopback was removed`;
    log(`codex-gateway: reverted to default gateway mode (${why}). Restart Claude Code.`);
  }
}

// ------------------------------------------------------------------ doctor

async function doctor() {
  log(`binary: ${fs.existsSync(PROXY_BIN) ? PROXY_BIN : 'MISSING (run setup)'}`);
  if (fs.existsSync(PROXY_BIN)) {
    const v = spawnSync(PROXY_BIN, ['--version'], { encoding: 'utf8', timeout: 10000 });
    log(`version: ${(v.stdout || v.stderr || '').trim()}`);
    const a = spawnSync(PROXY_BIN, ['codex', 'auth', 'status'], { encoding: 'utf8', timeout: 15000 });
    log(`codex auth: ${((a.stdout || '') + (a.stderr || '')).trim().split('\n')[0] || '(no output)'}`);
  }
  const ok = await statusReport();
  const catalog = readCatalog();
  log(catalog && Array.isArray(catalog.models)
    ? `catalog: ${catalog.models.length} models at ${CATALOG_PATH}`
    : 'catalog: not written yet');
  for (const scope of ['user', 'project']) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath(scope), 'utf8'));
      const base = s.env && s.env.ANTHROPIC_BASE_URL;
      const wired = ourBaseUrls().includes(base);
      const modeLabel = base === COMPAT_BASE_URL ? ' [RC-compatibility mode]' : base === DEFAULT_BASE_URL ? ' [default mode]' : '';
      log(`${scope} settings: ${wired ? 'wired' + modeLabel : 'not wired'} (${settingsPath(scope)})`);
    } catch { log(`${scope} settings: not wired`); }
  }
  const scope = installScope();
  if (scope === 'project-only') {
    log('install scope: PROJECT-ONLY — codex-gateway wires a global env var and needs its');
    log('  keepalive hook in every session; reinstall at user scope:');
    log('  claude plugin install codex-gateway@eigenwise-toolshed --scope user');
  } else if (scope === 'user') {
    log('install scope: user (correct)');
  }
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- the shim

// display_name feeds the /model PICKER only (with gateway model discovery on,
// for ids starting with claude-/anthropic-), where it shows correctly as e.g.
// "GPT-5.6 Terra (Codex)". It does NOT reach the running-subagent CARD: that
// surface resolves the model label internally and maps an unrecognized claude-*
// id (like claude-codex-gpt-5.6-terra) to a Claude family name — it renders
// "Fable 5" for a Terra run. Nothing we return here overrides that (verified:
// the response model field is "gpt-5.6-terra" and the model self-reports GPT-5,
// so the RUN is correct — only the card label lies). Native subagent model
// display isn't a supported feature (anthropics/claude-code#24094, not planned).
// The sidequest agent NAME (sidequest-exec-codex-gpt-5-6-terra-*) carries the
// true runtime, so don't chase the badge by editing display_name — it's a dead
// end. See SQ-202.
function displayName(id) {
  return id.replace(/^gpt-/, 'GPT-').replace(/\[1m\]$/, '') + ' (Codex)';
}

// claude-code-proxy v0.1.10 has no /v1/models route, so the shim owns the
// catalog: ~/.claude/codex-gateway/models.json if present, else the Codex ids
// its README documents. A future proxy /v1/models takes precedence over both.
const PLAN_TOOLS = ['EnterPlanMode', 'ExitPlanMode'];

const DEFAULT_MODELS = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2',
];

// Advertised to Claude Code as max_input_tokens for Codex models.
//
// IMPORTANT: as of Claude Code 2.1.207 this value is INERT for compaction. The
// context-window resolver (eyc/sT in claude.exe) never reads a discovered
// model's max_input_tokens for a `claude-`prefixed id — it hardwires 200000
// (PPr). The CLAUDE_CODE_MAX_CONTEXT_TOKENS escape hatch is gated behind
// `!startsWith("claude-")`, and our ids are `claude-codex-*` (discovery drops
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

function gatewayModel(id) {
  return {
    id: `${PREFIX}${id}`,
    display_name: displayName(id),
    type: 'model',
    max_input_tokens: CODEX_COMPACT_CONTEXT_WINDOW,
  };
}

// ------------------------------------------------------------ model catalog
//
// sidequest (same marketplace) auto-discovers Codex models by reading this
// file: ~/.claude/codex-gateway/catalog.json. Shape is a frozen contract
// (see plugins/sidequest/lib/discovery.js) — don't change it casually.

const CATALOG_PATH = path.join(STATE, 'catalog.json');
const CATALOG_STALE_MS = 5 * 60 * 1000;
const TIERS = new Set(['haiku', 'sonnet', 'opus', 'fable']);

// The catalog is what sidequest reads to offer Codex models as ladder-tier
// backends. It carries the GPT-5.6 family only — the three flagship models a
// user actually maps onto a tier. The /model picker (fed by the shim's
// /v1/models) still sees all of DEFAULT_MODELS; this narrowing is catalog-only.
const CATALOG_FAMILY = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

// A suggested tier per catalog model: the dashboard shows it as the dropdown's
// default hint. It is NOT applied — the user assigns each tier's backend. Terra
// reads closest to opus, Sol sits above opus toward fable, Luna is haiku-class.
const SUGGESTED_TIER = {
  'gpt-5.6-terra': 'opus',
  'gpt-5.6-sol': 'fable',
  'gpt-5.6-luna': 'haiku',
};

function suggestedTierFor(base) {
  const t = SUGGESTED_TIER[base];
  return TIERS.has(t) ? t : null;
}

function baseFromId(id) {
  return id.slice(PREFIX.length).replace(/\[1m\]$/, '');
}

// "codex-" + base, dots→dashes, kept inside ^[a-z0-9][a-z0-9-]{1,31}$; on
// collision (or an over-length base) fall back to a short deterministic hash
// so the slug stays unique without depending on iteration order.
function slugFor(base, used) {
  let s = ('codex-' + base).toLowerCase()
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

function buildCatalog(ids) {
  const used = new Set();
  const models = ids
    .filter((id) => CATALOG_FAMILY.has(baseFromId(id)))
    .map((id) => {
      const base = baseFromId(id);
      return { slug: slugFor(base, used), id, label: labelFor(base), suggestedTier: suggestedTierFor(base) };
    });
  return { schema: 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models };
}

async function fetchShimModelIds() {
  // the shim's own refreshModels() can still be mid-flight right after
  // /healthz starts answering; retry once, short, before giving up
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 });
    if (r.status !== 200) throw new Error(`shim /v1/models returned ${r.status}`);
    const ids = (JSON.parse(r.body.toString()).data || []).map((m) => m.id).filter((id) => id.startsWith(PREFIX));
    if (ids.length || attempt === 1) return ids;
    await new Promise((res) => setTimeout(res, 300));
  }
  return [];
}

async function writeCatalog() {
  const ids = await fetchShimModelIds();
  if (!ids.length) return null;
  const catalog = buildCatalog(ids);
  mkdirs();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')); } catch { return null; }
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
        : callback(new Error(`codex-gateway: could not resolve ${hostname} via DNS to bypass the hosts compatibility entry`))),
      callback,
    );
  }
  return { lookup, resolve };
}

function runShim() {
  let modelCache = {
    at: 0,
    data: DEFAULT_MODELS.map(gatewayModel),
  };
  const counters = { models: 0, codex: 0, anthropic: 0 };
  const sentrySessions = new Map();
  const compactTriggerIsFixed = Number.isFinite(configuredCompactTrigger) && configuredCompactTrigger > 0;
  let compactTrigger = CODEX_COMPACT_TRIGGER;
  let observedCeiling = null;
  // hostsDetected drives the DNS-bypass decision below regardless of whether
  // this process itself managed to bind the compat port; the OS hosts file is
  // machine-wide and would misdirect the passthrough forward either way.
  const compatState = { hostsDetected: false, hostsLine: null, port80Bound: false, reason: null };
  const anthropicBypass = createHostsBypassResolver();

  // A local audit trail for which model went where. This is intentionally a
  // small, fixed schema, never a dump of the request: prompts, messages, tools,
  // auth, and arbitrary headers are all excluded. Claude Code currently sends a
  // session id in x-claude-code-session-id when it has one; keep only that safe
  // caller correlation value.
  function requestRouteLog(req, backend, model, pathOnly) {
    if (!REQUEST_ROUTE_LOG) return;
    const sessionId = req.headers['x-claude-code-session-id'];
    const entry = {
      at: new Date().toISOString(),
      backend,
      model: typeof model === 'string' ? model : null,
      path: pathOnly,
      ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
    };
    try {
      mkdirs();
      fs.appendFileSync(REQUEST_ROUTE_LOG_PATH, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error(`codex-gateway: could not write request route log: ${error.code || error.message}`);
    }
  }

  function codexSessionId(req) {
    if (!CODEX_SENTRY_ENABLED) return null;
    const sessionId = req.headers['x-claude-code-session-id'];
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
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
      'Codex context sentry: input crossed the compaction trigger; compact and retry.');
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
    if (!Array.isArray(ids) || !ids.length) ids = DEFAULT_MODELS;
    modelCache = {
      at: Date.now(),
      data: ids.map(gatewayModel),
    };
  }
  refreshModels();

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  function filterPlanToolBlock(block) {
    return block && block.type === 'tool_use' && PLAN_TOOLS.includes(block.name);
  }

  function filterPlanToolJson(body) {
    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch { return body; }
    if (!Array.isArray(parsed.content)) return body;
    const content = parsed.content.filter((block) => !filterPlanToolBlock(block));
    if (content.length === parsed.content.length) return body;
    parsed.content = content;
    if (parsed.stop_reason === 'tool_use' && !content.some((block) => block && block.type === 'tool_use')) {
      parsed.stop_reason = 'end_turn';
    }
    return Buffer.from(JSON.stringify(parsed));
  }

  function createPlanToolSseFilter(write, observe) {
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

      const originalIndex = Number.isInteger(event.index) ? event.index : null;
      if (event.type === 'content_block_start' && originalIndex != null) {
        if (filterPlanToolBlock(event.content_block)) {
          dropped.add(originalIndex);
          droppedCount++;
          return;
        }
        if (event.content_block && event.content_block.type === 'tool_use') keptToolUse = true;
      }
      if (originalIndex != null && dropped.has(originalIndex)) return;
      if (originalIndex != null) event.index = originalIndex - droppedCount;
      if (event.type === 'message_delta' && event.delta && event.delta.stop_reason === 'tool_use'
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

  function createSseEventObserver(observe) {
    const decoder = new StringDecoder('utf8');
    let pending = '';

    function inspectFrame(frame) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
      if (!dataLine) return;
      const raw = dataLine.slice(5).trimStart();
      if (!raw || raw === '[DONE]') return;
      try { observe(JSON.parse(raw)); } catch { /* pass malformed upstream data through untouched */ }
    }

    return {
      write(chunk) {
        pending += decoder.write(chunk);
        for (;;) {
          const match = /\r?\n\r?\n/.exec(pending);
          if (!match) break;
          inspectFrame(pending.slice(0, match.index));
          pending = pending.slice(match.index + match[0].length);
        }
      },
      end() {
        pending += decoder.end();
        if (pending) inspectFrame(pending);
      },
    };
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

  function forward(clientReq, clientRes, target, body, extraHeaderDrop = [], normalizeContextErrors = false, filterPlanTools = false, sessionId = null) {
    const url = new URL(clientReq.url, target);
    const isHttps = url.protocol === 'https:';
    const headers = { ...clientReq.headers };
    for (const h of ['host', 'connection', 'content-length', 'keep-alive', ...extraHeaderDrop]) delete headers[h];
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
      if (normalizeContextErrors && CODEX_SENTRY_ENABLED && upRes.statusCode === 413) {
        const chunks = [];
        let settled = false;
        const failBufferedResponse = () => {
          if (settled) return;
          settled = true;
          if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'codex-gateway shim: upstream response ended early' },
          }));
        };
        upRes.on('data', (chunk) => chunks.push(chunk));
        upRes.on('error', failBufferedResponse);
        upRes.on('aborted', failBufferedResponse);
        upRes.on('end', () => {
          if (settled) return;
          settled = true;
          const normalized = normalizeGenuineContextOverflow(Buffer.concat(chunks), sessionId);
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
            error: { type: 'api_error', message: 'codex-gateway shim: upstream response ended early' },
          }));
        };
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('error', failBufferedResponse);
        upRes.on('aborted', failBufferedResponse);
        upRes.on('end', () => {
          if (settled) return;
          settled = true;
          const upstreamBody = Buffer.concat(chunks);
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
              'x-codex-gateway-upstream-status': String(upRes.statusCode),
            });
            return clientRes.end(normalized);
          }
          resHeaders['content-length'] = upstreamBody.length;
          clientRes.writeHead(upRes.statusCode, resHeaders);
          clientRes.end(upstreamBody);
        });
        return;
      }
      if (filterPlanTools && upRes.statusCode >= 200 && upRes.statusCode < 300) {
        const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
        delete resHeaders['content-length'];
        if (contentType.includes('text/event-stream')) {
          clientRes.writeHead(upRes.statusCode, resHeaders);
          keepSseAlive(upRes, clientRes);
          const filter = createPlanToolSseFilter(
            (chunk) => clientRes.write(chunk),
            (event) => recordSentryUsage(sessionId, event),
          );
          upRes.on('data', (chunk) => filter.write(chunk));
          upRes.on('end', () => { filter.end(); clientRes.end(); });
          upRes.on('error', () => clientRes.destroy());
          upRes.on('aborted', () => clientRes.destroy());
          return;
        }
        const chunks = [];
        upRes.on('data', (chunk) => chunks.push(chunk));
        upRes.on('error', () => clientRes.destroy());
        upRes.on('aborted', () => clientRes.destroy());
        upRes.on('end', () => {
          const filtered = filterPlanToolJson(Buffer.concat(chunks));
          resHeaders['content-length'] = filtered.length;
          clientRes.writeHead(upRes.statusCode, resHeaders);
          clientRes.end(filtered);
        });
        return;
      }
      const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
      clientRes.writeHead(upRes.statusCode, resHeaders);
      if (normalizeContextErrors && upRes.statusCode >= 200 && upRes.statusCode < 300 && contentType.includes('text/event-stream')) {
        keepSseAlive(upRes, clientRes);
        if (CODEX_SENTRY_ENABLED && sessionId) {
          const observer = createSseEventObserver((event) => recordSentryUsage(sessionId, event));
          upRes.on('data', (chunk) => observer.write(chunk));
          upRes.on('end', () => observer.end());
        }
      }
      upRes.pipe(clientRes); // never buffer successful SSE: Claude Code needs the stream live
    });
    upReq.setTimeout(3600000, () => upReq.destroy(new Error('upstream timeout')));
    upReq.on('error', (e) => {
      if (clientRes.headersSent) return clientRes.destroy();
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `codex-gateway shim: upstream ${url.origin} failed: ${e.message}` },
      }));
    });
    if (body != null) upReq.end(body);
    else clientReq.pipe(upReq);
  }

  function handleRequest(req, res) {
    const pathOnly = req.url.split('?')[0];

    if (pathOnly === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        models: modelCache.data.length,
        served: counters,
        compat: { ...compatState },
      }));
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
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = chunks.length ? Buffer.concat(chunks) : null;
      let requestedModel = null;
      if (raw && pathOnly.startsWith('/v1/messages')) {
        try {
          const parsed = JSON.parse(raw.toString());
          requestedModel = typeof parsed.model === 'string' ? parsed.model : null;
          if (typeof parsed.model === 'string' && parsed.model.startsWith(PREFIX)) {
            // Accept legacy typed ids from pre-0.4.2 sessions even though new
            // discovery rows are unsuffixed.
            parsed.model = parsed.model.slice(PREFIX.length).replace(/\[1m\]$/, '');
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
            requestRouteLog(req, 'codex', requestedModel, pathOnly);
            const sessionId = codexSessionId(req);
            if (pathOnly === '/v1/messages' && fireContextSentry(res, sessionId)) return;
            // claude.ai credentials never leave this machine toward the proxy
            return forward(req, res, `http://127.0.0.1:${PROXY_PORT}`,
              JSON.stringify(parsed), ['authorization', 'x-api-key'], true, !keepPlanTools, sessionId);
          }
        } catch { /* not JSON; fall through to passthrough */ }
      }
      counters.anthropic++;
      requestRouteLog(req, 'anthropic', requestedModel, pathOnly);
      forward(req, res, ANTHROPIC_UPSTREAM, raw);
    });
  }

  function makeServer() {
    const server = http.createServer(handleRequest);
    server.requestTimeout = 0;
    server.headersTimeout = 120000;
    server.keepAliveTimeout = 75000;
    return server;
  }

  makeServer().listen(SHIM_PORT, '127.0.0.1', () => {
    console.log(`codex-gateway shim listening on 127.0.0.1:${SHIM_PORT} (proxy :${PROXY_PORT}, anthropic ${ANTHROPIC_UPSTREAM})`);
  });

  // RC-compatibility: only attempted when the user has added the exact hosts
  // entry themselves (never written by this plugin). A second, independent
  // listener bound to whichever loopback address that entry named, on
  // COMPAT_PORT (80 by default) — same handler, same routing. If the bind
  // fails (no permission, or something else already owns the port) this logs
  // why and simply doesn't add the listener; the main port above keeps
  // running normally and codex-gateway stays in default mode this session.
  const hostsEntry = detectHostsCompat();
  compatState.hostsDetected = !!hostsEntry;
  compatState.hostsLine = hostsEntry ? hostsEntry.line : null;
  if (hostsEntry) {
    const compatServer = makeServer();
    compatServer.once('error', (e) => {
      compatState.port80Bound = false;
      compatState.reason = e.code || e.message;
      console.error(`codex-gateway: hosts RC-compatibility entry found (${hostsEntry.line}) but could not bind ${hostsEntry.ip}:${COMPAT_PORT}: ${e.code || e.message}. Staying on default gateway mode this session.`);
    });
    compatServer.listen(COMPAT_PORT, hostsEntry.ip, () => {
      compatState.port80Bound = true;
      console.log(`codex-gateway RC-compatibility listener on ${hostsEntry.ip}:${COMPAT_PORT} (hosts: ${hostsEntry.line})`);
    });
  }
}

// -------------------------------------------------------------------- main

if (require.main === module) {
(async () => {
  switch (cmd) {
    case 'setup': await setup(); break;
    case 'login': {
      if (!fs.existsSync(PROXY_BIN)) die('proxy binary missing, run setup first');
      const mode = flag('--device') ? 'device' : 'login';
      const r = spawnSync(PROXY_BIN, ['codex', 'auth', mode], { stdio: 'inherit' });
      if (r.status === 0) log(`signed in; run setup once more to finish wiring Claude Code`);
      process.exitCode = r.status == null ? 1 : r.status;
      break;
    }
    case 'start': {
      const r = await startAll();
      if (!r.ok) die(r.reason);
      await statusReport();
      break;
    }
    case 'stop':
      stopAll();
      log('stopped');
      break;
    case 'ensure': {
      // Clean the unsafe values and discovery rows written by versions through
      // 0.4.1 on the first session after the plugin cache updates.
      cleanLegacyEnvSettings();
      cleanLegacyGatewayModelCache();
      // SessionStart hook path: stdout lands in Claude's context, so stay
      // silent when healthy and emit exactly one actionable line otherwise
      const quiet = flag('--quiet');
      const wired = isWired();
      if (!fs.existsSync(PROXY_BIN)) {
        if (wired) {
          console.error('codex-gateway: ANTHROPIC_BASE_URL is wired but the proxy binary is missing; run the codex-gateway skill setup, or env --remove to unwire');
          process.exit(1);
        }
        log('codex-gateway is installed but not set up. Offer to run its setup (one command; needs a ChatGPT browser sign-in) to put the user\'s ChatGPT/Codex models in the /model picker. See the codex-gateway skill.');
        process.exit(0);
      }
      const r = await startAll({ quiet });
      if (!r.ok) { console.error('codex-gateway: ' + r.reason); process.exit(1); }
      // Proxy is confirmed running; one fail-soft nudge if it predates the 413
      // overflow fix. No auto-download inside the keepalive hook.
      warnIfProxyOutdated();
      if (!wired) {
        log(isAuthed()
          ? 'codex-gateway is running but Claude Code is not wired to it. Offer to run its env --write-user (see the codex-gateway skill), then restart.'
          : 'codex-gateway is running but not signed in to ChatGPT. Offer to run its login (browser sign-in), then setup to finish wiring. See the codex-gateway skill.');
      } else {
        if (installScope() === 'project-only') {
          // wired (global env) but the keepalive hook only runs in the project it's
          // installed in — every other project points at a shim nothing restarts.
          log('codex-gateway is installed PROJECT-ONLY but wires a global env var, so other projects route through a shim its hook won\'t keep alive. Offer to reinstall it at user scope: claude plugin install codex-gateway@eigenwise-toolshed --scope user');
        }
        // Keep the wired env in sync with the hosts file every session: promote
        // to RC-compatibility mode once the entry appears (and :80 actually
        // bound), revert the moment either stops being true.
        await syncCompatMode();
      }
      if (!quiet) await statusReport();
      break;
    }
    case 'status': process.exitCode = (await statusReport()) ? 0 : 1; break;
    case 'models': {
      const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 })
        .catch(() => die('shim not running (start it first)'));
      log(JSON.stringify(JSON.parse(r.body.toString()), null, 2));
      break;
    }
    case 'catalog': await catalogCommand(); break;
    case 'env': envCommand(); break;
    case 'doctor': await doctor(); break;
    case 'remote-control': await remoteControlCommand(); break;
    case 'serve-shim': runShim(); break;
    default:
      log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
})().catch((e) => die(e.message));
}

// Exported for unit tests only (require()'d directly, never run as a CLI in
// that mode). The CLI entry point above is guarded by require.main so this
// export has no effect on normal `node codex-gateway.js <command>` usage.
module.exports = {
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
  wiredMode,
  writeEnv,
  settingsPath,
  createHostsBypassResolver,
  COMPAT_HOST,
  COMPAT_PORT,
  DEFAULT_BASE_URL,
  COMPAT_BASE_URL,
  parseSemver,
  semverLt,
  MIN_PROXY_VERSION,
};
