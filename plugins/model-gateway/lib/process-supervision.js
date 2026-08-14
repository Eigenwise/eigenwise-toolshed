'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { CLI_PATH, LOGS, PROXY_BIN, PROXY_PORT, PUBLIC_SHIM_PORT, SHIM_PORT, STATE, WIN } = require('./runtime.js');

function fetchUrl(url, { timeout = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'model-gateway', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, { timeout, headers }));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout: ' + url)));
  });
}

function portListening(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeout, () => done(false));
  });
}

async function shimHealthy() {
  try {
    const response = await fetchUrl(`http://127.0.0.1:${SHIM_PORT}/healthz`, { timeout: 1000 });
    return response.status === 200;
  } catch { return false; }
}

function pidFile(name) { return path.join(STATE, name + '.pid'); }
function removePid(name) { try { fs.rmSync(pidFile(name)); } catch {} }
function readPid(name) {
  try { return Number(fs.readFileSync(pidFile(name), 'utf8').trim()) || null; } catch { return null; }
}
function killPid(pid) {
  if (!pid) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
function stopProcess(name) {
  killPid(readPid(name));
  removePid(name);
}
function stopAll() {
  stopProcess('shim');
  stopProcess('guardian');
  stopProcess('proxy');
  for (const processInfo of gatewayShimProcesses()) killPid(processInfo.pid);
}
function commandResult(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true });
}
function processOwningPort(port) {
  const result = WIN
    ? commandResult('netstat', ['-ano', '-p', 'tcp'])
    : commandResult('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (result.status !== 0) return null;
  if (!WIN) return Number(String(result.stdout).trim().split(/\s+/)[0]) || null;
  const portPattern = new RegExp(`^\\s*TCP\\s+[^\\s]*:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im');
  return Number(String(result.stdout).match(portPattern)?.[1]) || null;
}
function gatewayShimProcesses() {
  const result = WIN
    ? commandResult('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'])
    : commandResult('ps', ['-eo', 'pid=,ppid=,args=']);
  if (result.status !== 0) return [];
  if (WIN) {
    let entries;
    try { entries = JSON.parse(String(result.stdout) || '[]'); } catch { return []; }
    return (Array.isArray(entries) ? entries : [entries]).map((entry) => ({
      command: entry.CommandLine || '', parentPid: Number(entry.ParentProcessId) || null, pid: Number(entry.ProcessId) || null,
    })).filter((entry) => entry.pid && /model-gateway[\\/].*serve-(?:shim|worker)|model-gateway\.js"?\s+serve-(?:shim|worker)/i.test(entry.command));
  }
  return String(result.stdout).split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match && { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] };
  }).filter((entry) => entry && /model-gateway[\\/].*serve-(?:shim|worker)|model-gateway\.js\s+serve-(?:shim|worker)/i.test(entry.command));
}
function reapGatewayOrphans(supervisorPid) {
  const processes = gatewayShimProcesses();
  const keep = new Set(supervisorPid ? [supervisorPid] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (keep.has(entry.parentPid) && !keep.has(entry.pid)) {
        keep.add(entry.pid);
        changed = true;
      }
    }
  }
  for (const entry of processes) if (!keep.has(entry.pid)) killPid(entry.pid);
  return processes.filter((entry) => !keep.has(entry.pid));
}
async function stopRunningSupervisor({ quiet = false, report = console.log } = {}) {
  const pid = processOwningPort(PUBLIC_SHIM_PORT);
  if (pid) killPid(pid);
  else stopProcess('guardian');
  if (!(await waitForShimExit(3000))) {
    return { ok: false, reason: `could not stop the shim supervisor on :${PUBLIC_SHIM_PORT}${pid ? ` (PID ${pid})` : ''}; run node "${CLI_PATH}" stop, then ensure` };
  }
  reapGatewayOrphans(null);
  if (!quiet) report(`model-gateway: stopped stale shim supervisor${pid ? ` (PID ${pid})` : ''}.`);
  return { ok: true, pid };
}
function postJson(url, body, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout: ' + url)));
    req.end(payload);
  });
}
async function waitForShimExit(timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await portListening(SHIM_PORT, 100))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await portListening(SHIM_PORT, 100));
}
async function stopShimWithDrain({ quiet = false, timeout = Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000, report = console.log } = {}) {
  if (!(await portListening(SHIM_PORT))) {
    removePid('shim');
    return { ok: true, drained: true, running: false };
  }
  if (!quiet) report(`model-gateway: restarting shim. It stopped accepting new requests and is waiting up to ${Math.ceil(timeout / 1000)}s for in-flight requests to finish.`);
  try {
    const response = await postJson(`http://127.0.0.1:${SHIM_PORT}/drain`, { timeout });
    if (response.status !== 202) throw new Error(`drain endpoint returned ${response.status}`);
  } catch (error) {
    if (!quiet) report(`model-gateway: could not ask the shim to drain (${error.message}); force-stopping it.`);
    stopProcess('shim');
    return { ok: true, drained: false, forced: true, reason: error.message };
  }
  if (await waitForShimExit(timeout)) {
    removePid('shim');
    if (!quiet) report('model-gateway: in-flight shim requests finished; restarting shim.');
    return { ok: true, drained: true };
  }
  if (!quiet) report(`model-gateway: shim drain timed out after ${Math.ceil(timeout / 1000)}s; force-stopping it.`);
  stopProcess('shim');
  return { ok: true, drained: false, forced: true, reason: 'drain timeout' };
}
async function restartWorkerWithDrain({ quiet = false, timeout = Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000, report = console.log } = {}) {
  if (!(await portListening(PUBLIC_SHIM_PORT))) return { ok: true, running: false };
  if (!quiet) report(`model-gateway: restarting shim without dropping its listener; waiting up to ${Math.ceil(timeout / 1000)}s for in-flight requests.`);
  try {
    const response = await postJson(`http://127.0.0.1:${PUBLIC_SHIM_PORT}/restart`, { script: CLI_PATH }, 2000);
    if (response.status === 202) return { ok: true, draining: true };
    if (response.status === 404) {
      if (!quiet) report('model-gateway: upgrading the legacy shim to a supervised listener; this one transition reconnects live sessions.');
      return stopShimWithDrain({ quiet, timeout, report });
    }
    throw new Error(`restart endpoint returned ${response.status}`);
  } catch (error) { return { ok: false, reason: error.message }; }
}
function spawnDetached(name, command, cmdArgs, env) {
  const out = fs.openSync(path.join(LOGS, name + '.log'), 'a');
  const child = spawn(command, cmdArgs, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env }, windowsHide: true });
  fs.writeFileSync(pidFile(name), String(child.pid));
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

async function proxyModelsAnswering(port = PROXY_PORT, fetch = fetchUrl) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/v1/models`, { timeout: 2000 })).status === 200;
  } catch { return false; }
}

function waitForPortRelease(port, { listening = portListening, attempts = 20, delay = 100 } = {}) {
  return (async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await listening(port))) return true;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return !(await listening(port));
  })();
}

function spawnSupervisedProxy({ command = PROXY_BIN, port = PROXY_PORT, logs = LOGS, spawnProcess = spawn } = {}) {
  const output = fs.openSync(path.join(logs, 'proxy.log'), 'a');
  const child = spawnProcess(command, ['serve', '--no-monitor'], {
    stdio: ['ignore', output, output], env: { ...process.env, PORT: String(port) }, windowsHide: true,
  });
  child.once('error', () => {});
  fs.writeFileSync(pidFile('proxy'), String(child.pid));
  fs.closeSync(output);
  return child;
}

function createProxyRecovery({
  proxyBinary = PROXY_BIN,
  proxyPort = PROXY_PORT,
  probe = () => proxyModelsAnswering(proxyPort),
  listening = portListening,
  owner = processOwningPort,
  stop = killPid,
  waitForRelease = waitForPortRelease,
  start = spawnSupervisedProxy,
  onStarted = () => {},
  binaryExists = fs.existsSync,
  now = Date.now,
  report = console.error,
  initialBackoffMs = 1000,
  maximumBackoffMs = 30000,
} = {}) {
  let recovery = null;
  let restartAttempt = 0;
  let nextRestartAt = 0;

  function log(message) {
    report(`${new Date(now()).toISOString()} model-gateway: ${message}`);
  }

  async function recover() {
    if (recovery) return recovery;
    recovery = (async () => {
      if (await probe()) {
        restartAttempt = 0;
        nextRestartAt = 0;
        return { ok: true, state: 'healthy' };
      }
      if (now() < nextRestartAt) return { ok: false, state: 'backing-off', nextRestartAt };

      restartAttempt += 1;
      const backoffMs = Math.min(maximumBackoffMs, initialBackoffMs * (2 ** (restartAttempt - 1)));
      nextRestartAt = now() + backoffMs;
      log(`proxy /v1/models unavailable; restart attempt ${restartAttempt}`);
      if (!binaryExists(proxyBinary)) {
        log(`proxy restart skipped because ${proxyBinary} is missing`);
        return { ok: false, state: 'binary-missing', retryAt: nextRestartAt };
      }
      if (await listening(proxyPort)) {
        const pid = owner(proxyPort);
        if (!pid) {
          log(`proxy restart deferred because an unresponsive listener still owns :${proxyPort}`);
          return { ok: false, state: 'port-owned', retryAt: nextRestartAt };
        }
        stop(pid);
        if (!(await waitForRelease(proxyPort, { listening }))) {
          log(`proxy restart deferred because PID ${pid} did not release :${proxyPort}`);
          return { ok: false, state: 'port-stuck', retryAt: nextRestartAt };
        }
      }
      start({ command: proxyBinary, port: proxyPort });
      onStarted();
      if (await probe()) {
        restartAttempt = 0;
        nextRestartAt = 0;
        log('proxy recovered and /v1/models is ready');
        return { ok: true, state: 'recovered' };
      }
      log('proxy restart started; /v1/models is not ready yet');
      return { ok: false, state: 'starting', retryAt: nextRestartAt };
    })();
    try { return await recovery; } finally { recovery = null; }
  }

  return { recover };
}

module.exports = {
  createProxyRecovery, fetchUrl, gatewayShimProcesses, killPid, pidFile, portListening, postJson, processOwningPort,
  proxyModelsAnswering, readPid, reapGatewayOrphans, removePid, restartWorkerWithDrain, shimHealthy, spawnDetached,
  spawnSupervisedProxy, stopAll, stopProcess, stopRunningSupervisor, stopShimWithDrain, waitForPortRelease, waitForShimExit,
};
