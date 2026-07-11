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
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
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
const ANTHROPIC_UPSTREAM = process.env.CODEX_GATEWAY_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
const ENV_BLOCK = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${SHIM_PORT}`,
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
};

const USAGE = `usage: codex-gateway.js <command>

  setup            download the claude-code-proxy binary (v-latest) into ${BIN_DIR}
  login [--device] run the ChatGPT OAuth flow (--device for headless device-code)
  start | stop     start/stop the proxy + shim (detached, logs in ${LOGS})
  ensure [--quiet] start whatever isn't running; used by the SessionStart hook
  status           show what's running
  models           show the model list the shim advertises to Claude Code
  env [--write-user | --write-project | --remove]
                   print the Claude Code env block, or merge/remove it in settings.json
  doctor           full health check
  serve-shim       (internal) run the router in the foreground`;

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
  log(`next: node "${__filename}" login   (ChatGPT browser sign-in)`);
}

// ------------------------------------------------------- process management

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
      return { ok: true, started };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, reason: `not healthy after 12s (check logs in ${LOGS})` };
}

async function statusReport() {
  const proxyUp = await portListening(PROXY_PORT);
  const shimUp = await shimHealthy();
  log(`proxy (claude-code-proxy) on :${PROXY_PORT}: ${proxyUp ? 'running' : 'DOWN'}`);
  log(`shim (model router) on :${SHIM_PORT}: ${shimUp ? 'running' : 'DOWN'}`);
  if (shimUp) {
    try {
      const r = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/v1/models`, { timeout: 3000 });
      const n = (JSON.parse(r.body.toString()).data || []).length;
      log(`models advertised to Claude Code: ${n}`);
    } catch { log('models advertised to Claude Code: (unavailable)'); }
  }
  return proxyUp && shimUp;
}

// -------------------------------------------------------------- env wiring

function envCommand() {
  const remove = flag('--remove');
  const scope = flag('--write-project') ? 'project' : flag('--write-user') ? 'user' : null;
  if (!scope) {
    log('add this to the "env" block of your Claude Code settings.json:');
    log(JSON.stringify({ env: ENV_BLOCK }, null, 2));
    log('\nor run: env --write-user   (global) / --write-project (this repo)');
    return;
  }
  const file = settingsPath(scope);
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  settings.env = settings.env || {};
  if (remove) {
    for (const k of Object.keys(ENV_BLOCK)) {
      if (String(settings.env[k]) === String(ENV_BLOCK[k])) delete settings.env[k];
    }
    if (!Object.keys(settings.env).length) delete settings.env;
  } else {
    Object.assign(settings.env, ENV_BLOCK);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  log(`${remove ? 'removed from' : 'written to'} ${file}`);
  if (!remove) {
    log('every new Claude Code session now routes through the shim; the SessionStart');
    log('hook keeps it alive. Restart Claude Code, then open /model to see the Codex rows.');
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
  for (const scope of ['user', 'project']) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath(scope), 'utf8'));
      const wired = s.env && s.env.ANTHROPIC_BASE_URL === ENV_BLOCK.ANTHROPIC_BASE_URL;
      log(`${scope} settings: ${wired ? 'wired' : 'not wired'} (${settingsPath(scope)})`);
    } catch { log(`${scope} settings: not wired`); }
  }
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- the shim

function displayName(id) {
  return id.replace(/^gpt-/, 'GPT-').replace(/\[1m\]$/, '') + ' (Codex)';
}

// claude-code-proxy v0.1.10 has no /v1/models route, so the shim owns the
// catalog: ~/.claude/codex-gateway/models.json if present, else the Codex ids
// its README documents. A future proxy /v1/models takes precedence over both.
const DEFAULT_MODELS = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2',
];

function runShim() {
  let modelCache = { at: 0, data: [] };
  const counters = { models: 0, codex: 0, anthropic: 0 };

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
      data: ids.map((id) => ({
        id: `${PREFIX}${id}[1m]`,
        display_name: displayName(id),
        type: 'model',
      })),
    };
  }
  refreshModels();

  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  function forward(clientReq, clientRes, target, body, extraHeaderDrop = []) {
    const url = new URL(clientReq.url, target);
    const isHttps = url.protocol === 'https:';
    const headers = { ...clientReq.headers };
    for (const h of ['host', 'connection', 'content-length', 'keep-alive', ...extraHeaderDrop]) delete headers[h];
    if (body != null) headers['content-length'] = Buffer.byteLength(body);
    const upReq = (isHttps ? https : http).request(url, {
      method: clientReq.method,
      headers,
      agent: isHttps ? httpsAgent : httpAgent,
    }, (upRes) => {
      const resHeaders = { ...upRes.headers };
      for (const h of ['transfer-encoding', 'connection', 'keep-alive']) delete resHeaders[h];
      clientRes.writeHead(upRes.statusCode, resHeaders);
      upRes.pipe(clientRes); // never buffer: Claude Code needs the SSE stream live
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

  const server = http.createServer((req, res) => {
    const pathOnly = req.url.split('?')[0];

    if (pathOnly === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, models: modelCache.data.length, served: counters }));
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
      if (raw && pathOnly.startsWith('/v1/messages')) {
        try {
          const parsed = JSON.parse(raw.toString());
          if (typeof parsed.model === 'string' && parsed.model.startsWith(PREFIX)) {
            // [1m] is Claude Code's local compaction hint; proxy v0.1.10
            // rejects it here despite its README, so strip it ourselves
            parsed.model = parsed.model.slice(PREFIX.length).replace(/\[1m\]$/, '');
            counters.codex++;
            // claude.ai credentials never leave this machine toward the proxy
            return forward(req, res, `http://127.0.0.1:${PROXY_PORT}`,
              JSON.stringify(parsed), ['authorization', 'x-api-key']);
          }
        } catch { /* not JSON; fall through to passthrough */ }
      }
      counters.anthropic++;
      forward(req, res, ANTHROPIC_UPSTREAM, raw);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 75000;
  server.listen(SHIM_PORT, '127.0.0.1', () => {
    console.log(`codex-gateway shim listening on 127.0.0.1:${SHIM_PORT} (proxy :${PROXY_PORT}, anthropic ${ANTHROPIC_UPSTREAM})`);
  });
}

// -------------------------------------------------------------------- main

(async () => {
  switch (cmd) {
    case 'setup': await setup(); break;
    case 'login': {
      if (!fs.existsSync(PROXY_BIN)) die('proxy binary missing, run setup first');
      const mode = flag('--device') ? 'device' : 'login';
      const r = spawnSync(PROXY_BIN, ['codex', 'auth', mode], { stdio: 'inherit' });
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
      killPid(readPid('shim'));
      killPid(readPid('proxy'));
      for (const n of ['shim', 'proxy']) { try { fs.rmSync(pidFile(n)); } catch { /* absent */ } }
      log('stopped');
      break;
    case 'ensure': {
      const quiet = flag('--quiet');
      if (!fs.existsSync(PROXY_BIN)) {
        // only nag if Claude Code is actually wired to route through us
        try {
          const s = JSON.parse(fs.readFileSync(settingsPath('user'), 'utf8'));
          if (s.env && s.env.ANTHROPIC_BASE_URL === ENV_BLOCK.ANTHROPIC_BASE_URL) {
            console.error('codex-gateway: ANTHROPIC_BASE_URL is wired but the proxy binary is missing; run codex-gateway setup or env --remove');
            process.exit(1);
          }
        } catch { /* not wired */ }
        process.exit(0);
      }
      const r = await startAll({ quiet });
      if (!r.ok) { console.error('codex-gateway: ' + r.reason); process.exit(1); }
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
    case 'env': envCommand(); break;
    case 'doctor': await doctor(); break;
    case 'serve-shim': runShim(); break;
    default:
      log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
})().catch((e) => die(e.message));
