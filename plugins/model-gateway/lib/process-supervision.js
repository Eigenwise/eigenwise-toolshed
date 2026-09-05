'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { CLI_PATH, LOGS, PROXY_BIN, PROXY_PORT, PUBLIC_SHIM_PORT, resolveNewestInstalledCliPath, SHIM_PORT, STATE, WIN } = require('./runtime.js');
const { recordGatewayLifecycle } = require('./lifecycle-diagnostics.js');

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
function pidRecordFile(name) { return path.join(STATE, name + '.pid.json'); }
function removePid(name) {
  try { fs.rmSync(pidFile(name)); } catch {}
  try { fs.rmSync(pidRecordFile(name)); } catch {}
}
function readPid(name) {
  try { return Number(fs.readFileSync(pidFile(name), 'utf8').trim()) || null; } catch { return null; }
}
function readPidRecord(name) {
  const pid = readPid(name);
  if (!pid) return null;
  try {
    const record = JSON.parse(fs.readFileSync(pidRecordFile(name), 'utf8'));
    return record?.pid === pid ? record : null;
  } catch { return null; }
}
function writePidRecord(name, pid) {
  const process = processInfoSync(pid);
  fs.writeFileSync(pidFile(name), String(pid));
  fs.writeFileSync(pidRecordFile(name), JSON.stringify({
    pid,
    command: process?.command || null,
    startedAt: process?.startedAt || null,
  }));
}
async function writePidRecordAsync(name, pid, { inspectProcess, probeChildren = null, stillActive = () => true } = {}) {
  fs.writeFileSync(pidFile(name), String(pid));
  const readProcess = inspectProcess || ((processPid) => processInfoAsync(processPid, { probeChildren }));
  const process = await readProcess(pid);
  if (!stillActive() || readPid(name) !== pid) return;
  fs.writeFileSync(pidRecordFile(name), JSON.stringify({
    pid,
    command: process?.command || null,
    startedAt: process?.startedAt || null,
  }));
}
function processDescription(process) {
  return process?.command || 'not a gateway process';
}
function stalePidFile(name, pid, process, report = console.error) {
  report(`model-gateway: stale pid file ${name}: PID ${pid} is now ${processDescription(process)}`);
  removePid(name);
}
function commandIncludesFile(command, filePath) {
  return String(command).replace(/[\\/]+/g, '/').toLowerCase().includes(normalizedPath(filePath));
}
function processRunsThisProxyBinary(process, proxyBinary = PROXY_BIN) {
  return Boolean(process && commandIncludesFile(process.command, proxyBinary));
}
function processIsOwnedByThisInstall(pid, { record = null } = {}) {
  const process = processInfoSync(pid);
  if (!process) return false;
  const installRoot = gatewayInstallRootFromCommand(process.command);
  const belongsToThisInstall = installRoot && normalizedPath(installRoot) === normalizedPath(gatewayInstallRoot());
  const recordMatches = !record || (record.pid === pid && (
    (record.command && record.command === process.command)
    || (record.startedAt && record.startedAt === process.startedAt)
  ));
  return Boolean(belongsToThisInstall && recordMatches);
}
function recordedGatewayPid(name, { report = console.error } = {}) {
  const pid = readPid(name);
  if (!pid) return null;
  const record = readPidRecord(name);
  const process = processInfoSync(pid);
  if (record && processIsOwnedByThisInstall(pid, { record })) return pid;
  stalePidFile(name, pid, process, report);
  return null;
}
function recordedGatewayPids(options) {
  return [...new Set(['guardian', 'shim', 'proxy'].map((name) => recordedGatewayPid(name, options)).filter(Boolean))];
}
function killPid(pid) {
  if (!pid || !processIsOwnedByThisInstall(pid)) return false;
  if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch {} }
  return true;
}
function stopProcess(name, options) {
  const pid = recordedGatewayPid(name, options);
  if (pid) killPid(pid);
  removePid(name);
}
function recordStopRequest(operation, name) {
  const pid = recordedGatewayPid(name);
  if (!pid) return;
  const component = name === 'guardian' ? 'supervisor' : name;
  recordGatewayLifecycle(`${operation}-${component}-stop-requested`, {
    component: 'controller',
    pid: process.pid,
    child: { component, pid },
    signal: WIN ? 'TASKKILL' : 'SIGTERM',
  });
}
function commandResultSync(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true });
}
function processOwningPortSync(port) {
  if (!port) return null;
  const result = WIN
    ? commandResultSync('netstat', ['-ano', '-p', 'tcp'])
    : commandResultSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  if (result.status !== 0) return null;
  if (!WIN) return Number(String(result.stdout).trim().split(/\s+/)[0]) || null;
  const portPattern = new RegExp(`^\\s*TCP\\s+[^\\s]*:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im');
  return Number(String(result.stdout).match(portPattern)?.[1]) || null;
}
function processInfoFromOutput(output) {
  if (WIN) {
    try {
      const entry = JSON.parse(String(output) || 'null');
      if (!entry?.ProcessId) return null;
      return {
        command: entry.CommandLine || '',
        parentPid: Number(entry.ParentProcessId) || null,
        pid: Number(entry.ProcessId),
        startedAt: entry.CreationDate || null,
      };
    } catch { return null; }
  }
  const match = String(output).match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/m);
  return match ? { command: match[4], parentPid: Number(match[2]) || null, pid: Number(match[1]), startedAt: match[3] } : null;
}
function processInfoSync(pid) {
  if (!pid) return null;
  const result = WIN
    ? commandResultSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`])
    : commandResultSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,args=']);
  return result.status === 0 ? processInfoFromOutput(result.stdout) : null;
}
function processTableFromOutput(output) {
  if (WIN) {
    try {
      const entries = JSON.parse(String(output) || '[]');
      return new Map((Array.isArray(entries) ? entries : [entries])
        .filter((entry) => entry?.ProcessId)
        .map((entry) => [Number(entry.ProcessId), {
          command: entry.CommandLine || '',
          parentPid: Number(entry.ParentProcessId) || null,
          pid: Number(entry.ProcessId),
          startedAt: entry.CreationDate || null,
        }]));
    } catch { return null; }
  }
  return new Map(String(output).trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/);
    return match ? [Number(match[1]), { command: match[4], parentPid: Number(match[2]) || null, pid: Number(match[1]), startedAt: match[3] }] : null;
  }).filter(Boolean));
}
function processTableSync() {
  const result = WIN
    ? commandResultSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress'])
    : commandResultSync('ps', ['-eo', 'pid=,ppid=,lstart=,args=']);
  return result.status === 0 ? processTableFromOutput(result.stdout) : null;
}
function probeTimeoutMs() {
  return Math.max(1, Number(process.env.CODEX_GATEWAY_PROBE_TIMEOUT_MS) || 2000);
}
function waitForProbeChildClose(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
    if (child.exitCode != null || child.signalCode != null) finish();
  });
}
function waitForTaskkill(pid) {
  return new Promise((resolve) => {
    let taskkill;
    try {
      taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve();
      return;
    }
    taskkill.once('close', resolve);
    taskkill.once('error', resolve);
  });
}
function probeChildClosedWithin(closed, timeout = 250) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    timer.unref?.();
    void closed.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
async function stopProbeChild(child, closed) {
  if (child?.pid) {
    if (WIN) await waitForTaskkill(child.pid);
    else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      if (!(await probeChildClosedWithin(closed))) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }
    }
  }
  await closed;
}
function stopProbeChildSync(child) {
  if (!child?.pid) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } }
}
function createProbeChildRegistry() {
  const children = new Map();
  let queue = Promise.resolve();
  let stopping = false;
  function run(runProbe) {
    const queued = queue.then(() => stopping
      ? { status: null, stdout: '', stderr: '', timedOut: true }
      : runProbe());
    queue = queued.catch(() => {});
    return queued;
  }
  function track(child) {
    const closed = waitForProbeChildClose(child);
    children.set(child, closed);
    void closed.then(() => children.delete(child));
    return closed;
  }
  async function stop() {
    stopping = true;
    await Promise.all([...children].map(([child, closed]) => stopProbeChild(child, closed)));
    await queue;
  }
  function stopSync() {
    stopping = true;
    for (const child of children.keys()) stopProbeChildSync(child);
  }
  return { run, stop, stopSync, track };
}
function commandResultAsync(command, commandArgs, { timeout = probeTimeoutMs(), spawnProcess = spawn, probeChildren = null, queued = false } = {}) {
  if (probeChildren && !queued) {
    return probeChildren.run(() => commandResultAsync(command, commandArgs, { timeout, spawnProcess, probeChildren, queued: true }));
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    let closed;
    try {
      child = spawnProcess(command, commandArgs, { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      closed = probeChildren ? probeChildren.track(child) : waitForProbeChildClose(child);
    } catch (error) {
      finish({ status: null, stdout, stderr: String(error), timedOut: false });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ status: null, stdout, stderr: `${stderr}${error}`, timedOut: false }));
    child.once('close', (status) => finish({ status, stdout, stderr, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      void stopProbeChild(child, closed).then(
        () => finish({ status: null, stdout, stderr, timedOut: true }),
        () => finish({ status: null, stdout, stderr, timedOut: true }),
      );
    }, timeout);
    timer.unref?.();
  });
}
async function processOwningPortAsync(port, { commandResult = commandResultAsync, probeChildren = null } = {}) {
  if (!port) return null;
  const result = await commandResult(WIN ? 'netstat' : 'lsof', WIN ? ['-ano', '-p', 'tcp'] : ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { probeChildren });
  if (result.timedOut) return undefined;
  if (result.status !== 0) return null;
  if (!WIN) return Number(String(result.stdout).trim().split(/\s+/)[0]) || null;
  const portPattern = new RegExp(`^\\s*TCP\\s+[^\\s]*:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im');
  return Number(String(result.stdout).match(portPattern)?.[1]) || null;
}
async function processInfoAsync(pid, { commandResult = commandResultAsync, probeChildren = null } = {}) {
  if (!pid) return null;
  const result = await commandResult(WIN ? 'powershell.exe' : 'ps', WIN
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`]
    : ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,args='], { probeChildren });
  if (result.timedOut) return undefined;
  return result.status === 0 ? processInfoFromOutput(result.stdout) : null;
}
async function processTableAsync({ commandResult = commandResultAsync, probeChildren = null } = {}) {
  const result = await commandResult(WIN ? 'powershell.exe' : 'ps', WIN
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress']
    : ['-eo', 'pid=,ppid=,lstart=,args='], { probeChildren });
  if (result.timedOut) return undefined;
  return result.status === 0 ? processTableFromOutput(result.stdout) : null;
}
function gatewayInstallRoot() {
  return path.resolve(path.join(CLI_PATH, '..', '..'));
}
function normalizedPath(filePath) {
  return path.resolve(filePath).replace(/[\\/]+/g, '/').toLowerCase();
}
function gatewayInstallRootFromCommand(command) {
  const match = String(command).match(/(?:^|\s)(?:"([^"]*model-gateway(?:[\\/]\d+\.\d+\.\d+)?[\\/]bin[\\/]model-gateway\.js)"|'([^']*model-gateway(?:[\\/]\d+\.\d+\.\d+)?[\\/]bin[\\/]model-gateway\.js)'|([^\s]*model-gateway(?:[\\/]\d+\.\d+\.\d+)?[\\/]bin[\\/]model-gateway\.js))/i);
  const cliPath = match?.slice(1).find(Boolean);
  return cliPath ? path.resolve(path.join(cliPath, '..', '..')) : null;
}
function processBelongsToThisInstall(pid) {
  const process = processInfoSync(pid);
  const installRoot = process && gatewayInstallRootFromCommand(process.command);
  return Boolean(installRoot && normalizedPath(installRoot) === normalizedPath(gatewayInstallRoot()));
}
function foreignPortOwner(port = PUBLIC_SHIM_PORT) {
  const pid = processOwningPortSync(port);
  if (!pid || processBelongsToThisInstall(pid)) return null;
  const process = processInfoSync(pid);
  return { installRoot: process ? gatewayInstallRootFromCommand(process.command) : null, pid };
}
function foreignPortOwnerReason(owner, port = PUBLIC_SHIM_PORT) {
  return `refusing to stop PID ${owner.pid} on :${port}; it belongs to a different install root (${owner.installRoot || 'unknown'}), not ${gatewayInstallRoot()}`;
}
function isDescendantInProcessTable(pid, ancestorPid, processes) {
  const visited = new Set();
  let currentPid = pid;
  while (currentPid && !visited.has(currentPid)) {
    if (currentPid === ancestorPid) return true;
    visited.add(currentPid);
    currentPid = processes.get(currentPid)?.parentPid || null;
  }
  return false;
}
function isDescendantOf(pid, ancestorPid) {
  const processes = processTableSync();
  return Boolean(processes && isDescendantInProcessTable(pid, ancestorPid, processes));
}
async function isDescendantOfAsync(pid, ancestorPid, { processTable = processTableAsync } = {}) {
  const processes = await processTable();
  return processes ? isDescendantInProcessTable(pid, ancestorPid, processes) : undefined;
}
async function processIsOwnedByThisInstallAsync(pid, { record = null, inspectProcess, probeChildren = null } = {}) {
  const readProcess = inspectProcess || ((processPid) => processInfoAsync(processPid, { probeChildren }));
  const process = await readProcess(pid);
  if (!process) return process === undefined ? undefined : false;
  const installRoot = gatewayInstallRootFromCommand(process.command);
  const belongsToThisInstall = installRoot && normalizedPath(installRoot) === normalizedPath(gatewayInstallRoot());
  const recordMatches = !record || (record.pid === pid && (
    (record.command && record.command === process.command)
    || (record.startedAt && record.startedAt === process.startedAt)
  ));
  return Boolean(belongsToThisInstall && recordMatches);
}
async function killPidAsync(pid, { trusted = false, ...ownershipOptions } = {}) {
  const owned = trusted ? true : await processIsOwnedByThisInstallAsync(pid, ownershipOptions);
  if (owned !== true) return owned;
  if (WIN) {
    if (trusted) await waitForTaskkill(pid);
    else {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => {});
    }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  return true;
}
function reapGatewayOrphans(supervisorPid = null) {
  const reaped = [];
  const processes = supervisorPid ? processTableSync() : null;
  for (const pid of recordedGatewayPids()) {
    if (processes && isDescendantInProcessTable(pid, supervisorPid, processes)) continue;
    killPid(pid);
    reaped.push(pid);
  }
  return reaped;
}
function stopAll({ report = console.log } = {}) {
  const foreignOwner = foreignPortOwner();
  if (foreignOwner) {
    const reason = foreignPortOwnerReason(foreignOwner);
    report(`model-gateway: ${reason}.`);
    return { ok: false, reason };
  }
  for (const name of ['shim', 'guardian', 'proxy']) recordStopRequest('stop', name);
  const portOwner = processOwningPortSync(PUBLIC_SHIM_PORT);
  for (const name of ['shim', 'guardian', 'proxy']) stopProcess(name);
  if (portOwner) killPid(portOwner);
  reapGatewayOrphans(null);
  return { ok: true };
}
async function stopRunningSupervisor({ quiet = false, operation = 'restart', report = console.log } = {}) {
  const foreignOwner = foreignPortOwner();
  if (foreignOwner) return { ok: false, reason: foreignPortOwnerReason(foreignOwner) };
  const pid = processOwningPortSync(PUBLIC_SHIM_PORT);
  const targetPid = pid || readPid('guardian');
  if (targetPid) {
    recordGatewayLifecycle(`${operation}-supervisor-stop-requested`, {
      component: 'controller',
      pid: process.pid,
      child: { component: 'supervisor', pid: targetPid },
      signal: WIN ? 'TASKKILL' : 'SIGTERM',
    });
  }
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
async function stopShimWithDrain({ quiet = false, timeout = Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000, report = console.log, findForeignOwner = foreignPortOwner } = {}) {
  if (!(await portListening(SHIM_PORT))) {
    removePid('shim');
    return { ok: true, drained: true, running: false };
  }
  const foreignOwner = findForeignOwner(SHIM_PORT);
  if (foreignOwner) return { ok: false, reason: foreignPortOwnerReason(foreignOwner, SHIM_PORT) };
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
async function restartWorkerWithDrain({ quiet = false, timeout = Number(process.env.CODEX_GATEWAY_DRAIN_TIMEOUT_MS) || 30000, report = console.log, findForeignOwner = foreignPortOwner } = {}) {
  if (!(await portListening(PUBLIC_SHIM_PORT))) return { ok: true, running: false };
  const foreignOwner = findForeignOwner(PUBLIC_SHIM_PORT);
  if (foreignOwner) return { ok: false, reason: foreignPortOwnerReason(foreignOwner, PUBLIC_SHIM_PORT) };
  if (!quiet) report(`model-gateway: restarting shim without dropping its listener; waiting up to ${Math.ceil(timeout / 1000)}s for in-flight requests.`);
  try {
    const response = await postJson(`http://127.0.0.1:${PUBLIC_SHIM_PORT}/restart`, { script: resolveNewestInstalledCliPath() }, 2000);
    if (response.status === 202) return { ok: true, draining: true };
    if (response.status === 404) {
      if (!quiet) report('model-gateway: upgrading the legacy shim to a supervised listener; this one transition reconnects live sessions.');
      return stopShimWithDrain({ quiet, timeout, report });
    }
    throw new Error(`restart endpoint returned ${response.status}`);
  } catch (error) { return { ok: false, reason: error.message }; }
}
function spawnDetached(name, command, cmdArgs, env) {
  if (WIN) {
    const { spawnWindowsDetached } = require('./windows-detached.js');
    const pid = spawnWindowsDetached(command, cmdArgs, {
      env: { ...process.env, ...env }, logPath: path.join(LOGS, name + '.log'), state: STATE,
    });
    writePidRecord(name, pid);
    return pid;
  }
  const out = fs.openSync(path.join(LOGS, name + '.log'), 'a');
  const child = spawn(command, cmdArgs, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env }, windowsHide: true });
  writePidRecord(name, child.pid);
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
  fs.closeSync(output);
  return child;
}

function createProxyRecovery({
  proxyBinary = PROXY_BIN,
  proxyPort = PROXY_PORT,
  probe = () => proxyModelsAnswering(proxyPort),
  listening = portListening,
  probeChildren = createProbeChildRegistry(),
  owner = (port) => processOwningPortAsync(port, { probeChildren }),
  inspectProcess = (pid) => processInfoAsync(pid, { probeChildren }),
  processTable = () => processTableAsync({ probeChildren }),
  ownsProxy = async (pid) => {
    const proxyProcess = await inspectProcess(pid);
    if (!proxyProcess) return proxyProcess === undefined ? undefined : false;
    if (!processRunsThisProxyBinary(proxyProcess, proxyBinary)) return false;
    return isDescendantOfAsync(pid, process.pid, { processTable });
  },
  stop = (pid) => killPidAsync(pid, { trusted: true }),
  waitForRelease = waitForPortRelease,
  start = spawnSupervisedProxy,
  onStarted = () => {},
  binaryExists = fs.existsSync,
  now = Date.now,
  report = console.error,
  recordLifecycle = () => {},
  initialBackoffMs = 1000,
  maximumBackoffMs = 30000,
} = {}) {
  let recovery = null;
  let halted = false;
  let restartAttempt = 0;
  let nextRestartAt = 0;

  function log(message) {
    report(`${new Date(now()).toISOString()} model-gateway: ${message}`);
  }

  async function recover() {
    if (recovery) return recovery;
    if (halted) return { ok: false, state: 'foreign-port-owner' };
    recovery = (async () => {
      if (await probe()) {
        restartAttempt = 0;
        nextRestartAt = 0;
        return { ok: true, state: 'healthy' };
      }
      if (halted) return { ok: false, state: 'stopped' };
      if (now() < nextRestartAt) return { ok: false, state: 'backing-off', nextRestartAt };

      restartAttempt += 1;
      const backoffMs = Math.min(maximumBackoffMs, initialBackoffMs * (2 ** (restartAttempt - 1)));
      nextRestartAt = now() + backoffMs;
      recordLifecycle('proxy-recovery-started', {
        component: 'supervisor',
        pid: process.pid,
        outcome: `attempt-${restartAttempt}`,
      });
      log(`proxy /v1/models unavailable; restart attempt ${restartAttempt}`);
      if (!binaryExists(proxyBinary)) {
        log(`proxy restart skipped because ${proxyBinary} is missing`);
        recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'binary-missing' });
        return { ok: false, state: 'binary-missing', retryAt: nextRestartAt };
      }
      if (await listening(proxyPort)) {
        const pid = await owner(proxyPort);
        if (pid === undefined) {
          log(`proxy restart deferred because the ownership probe for :${proxyPort} timed out; refusing to stop an unknown owner`);
          recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'owner-unknown' });
          return { ok: false, state: 'owner-unknown', retryAt: nextRestartAt };
        }
        if (!pid) {
          log(`proxy restart deferred because an unresponsive listener still owns :${proxyPort}`);
          recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'port-owned' });
          return { ok: false, state: 'port-owned', retryAt: nextRestartAt };
        }
        const ownedByProxy = await ownsProxy(pid);
        if (ownedByProxy === undefined) {
          log(`proxy restart deferred because the ownership probe for PID ${pid} timed out; refusing to stop an unknown owner`);
          recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'owner-unknown' });
          return { ok: false, state: 'owner-unknown', retryAt: nextRestartAt };
        }
        if (!ownedByProxy) {
          const ownerProcess = await inspectProcess(pid);
          const installRoot = ownerProcess && gatewayInstallRootFromCommand(ownerProcess.command);
          halted = true;
          log(`proxy restart refused because PID ${pid} owns :${proxyPort} from a different install root (${installRoot || 'unknown'}), not ${gatewayInstallRoot()}`);
          recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'foreign-port-owner' });
          return { ok: false, state: 'foreign-port-owner' };
        }
        recordLifecycle('proxy-stop-requested', {
          component: 'supervisor',
          pid: process.pid,
          child: { component: 'proxy', pid },
          signal: WIN ? 'TASKKILL' : 'SIGTERM',
        });
        await stop(pid);
        if (!(await waitForRelease(proxyPort, { listening }))) {
          log(`proxy restart deferred because PID ${pid} did not release :${proxyPort}`);
          recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'port-stuck' });
          return { ok: false, state: 'port-stuck', retryAt: nextRestartAt };
        }
      }
      if (halted) return { ok: false, state: 'stopped' };
      const proxy = await start({ command: proxyBinary, port: proxyPort });
      onStarted(proxy?.pid);
      if (proxy?.pid) {
        recordLifecycle('proxy-started', {
          component: 'supervisor',
          pid: process.pid,
          child: { component: 'proxy', pid: proxy.pid },
        });
        if (typeof proxy.once === 'function') {
          proxy.once('exit', (exitCode, signal) => recordLifecycle('proxy-exit', {
            component: 'supervisor',
            pid: process.pid,
            child: { component: 'proxy', pid: proxy.pid },
            exitCode,
            signal,
          }));
        }
      }
      if (await probe()) {
        restartAttempt = 0;
        nextRestartAt = 0;
        log('proxy recovered and /v1/models is ready');
        recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'recovered' });
        return { ok: true, state: 'recovered' };
      }
      log('proxy restart started; /v1/models is not ready yet');
      recordLifecycle('proxy-recovery-finished', { component: 'supervisor', pid: process.pid, outcome: 'starting' });
      return { ok: false, state: 'starting', retryAt: nextRestartAt };
    })();
    try { return await recovery; } finally { recovery = null; }
  }

  async function stopRecovery() {
    halted = true;
    await probeChildren.stop();
    if (recovery) await recovery;
  }

  return { recover, stop: stopRecovery, stopSync: () => probeChildren.stopSync() };
}

module.exports = {
  commandResultAsync, createProbeChildRegistry, createProxyRecovery, fetchUrl, foreignPortOwner, foreignPortOwnerReason, gatewayInstallRoot, isDescendantOfAsync, killPid, killPidAsync, pidFile, pidRecordFile, portListening, postJson,
  processInfoAsync, processIsOwnedByThisInstall, processIsOwnedByThisInstallAsync, processOwningPort: processOwningPortSync, processOwningPortAsync, processTableAsync,
  proxyModelsAnswering, readPid, readPidRecord, recordedGatewayPids, reapGatewayOrphans, removePid, restartWorkerWithDrain, shimHealthy, spawnDetached,
  spawnSupervisedProxy, stopAll, stopProcess, stopRunningSupervisor, stopShimWithDrain, waitForPortRelease, waitForShimExit, writePidRecord, writePidRecordAsync,
};
