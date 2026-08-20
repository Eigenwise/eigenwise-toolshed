#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DEFAULT_MAX_DATABASE_BYTES, DEFAULT_MAX_WAL_BYTES } = require('./store.js');
const grafanaLgtm = require('../../observability/sinks/grafana/index.js');
const {
  dashboardActivityStart,
  projectsWithActivity,
  provisionDashboards,
} = require('../../observability/sinks/grafana/dashboard-generator.js');
const {
  DEFAULT_SINK,
  defaultConfigPath,
  defaultDataDir,
  readObservabilityConfig,
  resolveSink,
  writeObservabilityConfig,
} = require('../../observability/sinks/index.js');

const LOOPBACK = '127.0.0.1';
const MAX_MANAGED_LOG_BYTES = 16 * 1024 * 1024;
const MANAGED_LOG_ARCHIVES = 3;
const PROCESS_RECORD_STALE_AFTER_MS = 120_000;

// The worker records a five-second main-thread pulse. The longest measured spool drain is 17 seconds, so this permits seven such drains before takeover.
const processRecordHeartbeatIsFresh = (record, recordFile, now = Date.now()) => {
  const heartbeatAt = typeof record?.heartbeatAt === 'string'
    ? Date.parse(record.heartbeatAt)
    : fs.statSync(recordFile).mtimeMs;
  return Number.isFinite(heartbeatAt)
    && heartbeatAt <= now
    && now - heartbeatAt <= PROCESS_RECORD_STALE_AFTER_MS;
};

function normalizeManagedConfig(value, options) {
  return require('../../bin/setup-observability.js').normalizeManagedConfig(value, options);
}

function portListening(port, options = {}) {
  const connect = options.connect || net.createConnection;
  const timeoutMs = Math.max(25, Number(options.portTimeoutMs) || 150);
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: LOOPBACK, port });
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port, expected, options = {}) {
  const deadline = Date.now() + Math.max(0, Number(options.waitTimeoutMs) || 2000);
  do {
    if (await portListening(port, options) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

function pidFile(dataDir, name) {
  return path.join(dataDir, `${name}.pid`);
}

function processRecordFile(dataDir, name) {
  return path.join(dataDir, `${name}.pid.json`);
}

function fileBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function managedLogFile(dataDir, name) {
  return path.join(dataDir, `${name}.log`);
}

function managedLogNeedsRotation(name, dataDir, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxManagedLogBytes) || MAX_MANAGED_LOG_BYTES);
  return fileBytes(managedLogFile(dataDir, name)) > maxBytes;
}

function rotateManagedLog(name, dataDir, options = {}) {
  if (!managedLogNeedsRotation(name, dataDir, options)) return false;
  const archives = Math.max(1, Number(options.managedLogArchives) || MANAGED_LOG_ARCHIVES);
  const logFile = managedLogFile(dataDir, name);
  for (let index = archives; index >= 1; index -= 1) {
    const source = index === 1 ? logFile : `${logFile}.${index - 1}`;
    const target = `${logFile}.${index}`;
    try { fs.rmSync(target, { force: true }); } catch {}
    try { fs.renameSync(source, target); } catch {}
  }
  return !fs.existsSync(logFile);
}

function storageHealth(dataDir, options = {}) {
  const databaseFile = path.join(dataDir, 'observability.db');
  const maxDatabaseBytes = Math.max(1, Number(options.maxDatabaseBytes) || DEFAULT_MAX_DATABASE_BYTES);
  const maxWalBytes = Math.max(1, Number(options.maxWalBytes) || DEFAULT_MAX_WAL_BYTES);
  const databaseBytes = fileBytes(databaseFile);
  const walBytes = fileBytes(`${databaseFile}-wal`);
  return {
    databaseBytes,
    walBytes,
    maxDatabaseBytes,
    maxWalBytes,
    overDatabaseLimit: databaseBytes > maxDatabaseBytes,
    overWalLimit: walBytes > maxWalBytes,
  };
}

function readPid(filePath) {
  try {
    const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessRecord(dataDir, name) {
  try {
    const record = JSON.parse(fs.readFileSync(processRecordFile(dataDir, name), 'utf8'));
    if (!record || typeof record !== 'object') return null;
    return record;
  } catch {
    return null;
  }
}

function writeProcessRecord(dataDir, name, record) {
  fs.writeFileSync(processRecordFile(dataDir, name), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function processRecordMatchesProvenance(name, dataDir, pid, provenance, options = {}) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const record = readProcessRecord(dataDir, name);
  if (record?.pid !== pid
    || record.pluginVersion !== provenance.pluginVersion
    || record.scriptPath !== provenance.scriptPath) return false;
  try {
    const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
    return processRecordHeartbeatIsFresh(record, processRecordFile(dataDir, name), now);
  } catch {
    return false;
  }
}

function managedProcessNeedsRestart(name, dataDir, provenance, options = {}) {
  const pid = readPid(pidFile(dataDir, name));
  const alive = options.processAlive || processAlive;
  if (!pid || !alive(pid)) return false;
  return !processRecordMatchesProvenance(name, dataDir, pid, provenance, options);
}

function stopManagedProcess(name, dataDir, options = {}) {
  const filePath = pidFile(dataDir, name);
  const pid = readPid(filePath);
  if (!pid) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    try { fs.rmSync(processRecordFile(dataDir, name), { force: true }); } catch {}
    return false;
  }
  try {
    if (options.killManaged === false) {
      return false;
    }
    if (typeof options.killProcess === 'function') {
      options.killProcess(pid, name);
    } else if (processAlive(pid) && pid !== process.pid) {
      stopProcess(pid, name, options);
    }
  } finally {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    try { fs.rmSync(processRecordFile(dataDir, name), { force: true }); } catch {}
  }
  return true;
}

async function teardownRuntime(value, options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const config = normalizeManagedConfig(value || {});
  const ports = config.observability.ports;
  const checkPort = options.checkPort || portListening;
  const [collectorListening, observerListening] = await Promise.all([
    checkPort(ports.collector, options),
    checkPort(ports.observer, options),
  ]);
  const collector = stopManagedProcess('collector', dataDir, { ...options, killManaged: collectorListening });
  const observer = stopManagedProcess('observer', dataDir, { ...options, killManaged: observerListening });
  const wait = options.waitForPort || waitForPort;
  if (collector) await wait(ports.collector, false, options);
  if (observer) await wait(ports.observer, false, options);
  return { collector, observer };
}

function startManagedProcess(name, command, args, dataDir, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dataDir, `${name}.log`);
  const descriptor = fs.openSync(logFile, 'a');
  let child;
  try {
    child = (options.spawn || spawn)(command, args, {
      cwd: dataDir,
      detached: true,
      env: { ...process.env, ...(options.environment || {}) },
      stdio: ['ignore', descriptor, descriptor],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(descriptor);
  }
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) throw new Error(`Could not start the Workbench ${name}.`);
  fs.writeFileSync(pidFile(dataDir, name), `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  writeProcessRecord(dataDir, name, {
    pid: child.pid,
    pluginVersion: options.pluginVersion,
    scriptPath: options.scriptPath,
    heartbeatAt: new Date(now).toISOString(),
  });
  if (typeof child.unref === 'function') child.unref();
  return child.pid;
}

function lockDirectory(dataDir) {
  return path.join(dataDir, 'ensure-observability.lock');
}

function readLockOwner(filePath) {
  try {
    const owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null;
  }
}

function acquireLock(dataDir, options = {}) {
  const directory = lockDirectory(dataDir);
  const ownerFile = path.join(directory, 'owner.json');
  const create = () => {
    fs.mkdirSync(directory);
    fs.writeFileSync(ownerFile, `${JSON.stringify({
      pid: process.pid,
      pluginVersion: options.pluginVersion,
      scriptPath: __filename,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    return directory;
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    return create();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  try {
    const owner = readLockOwner(ownerFile);
    const ownerIsCurrent = owner
      && Number.isInteger(owner.pid)
      && owner.pid > 0
      && owner.pluginVersion === options.pluginVersion
      && owner.scriptPath === __filename;
    if (ownerIsCurrent && (options.processAlive || processAlive)(owner.pid)) return null;
    if (owner?.pid && owner.scriptPath === __filename) stopProcess(owner.pid, 'ensure', options);
    fs.rmSync(directory, { recursive: true, force: true });
    return create();
  } catch {
    return null;
  }
}

function releaseLock(directory) {
  if (!directory) return;
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function consentedConfig(configFile) {
  if (!fs.existsSync(configFile)) return null;
  try {
    const config = normalizeManagedConfig(readObservabilityConfig(configFile));
    return config.observability.enabled ? config : null;
  } catch {
    return null;
  }
}

async function ensureObservability(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const configFile = options.configFile || defaultConfigPath(dataDir);
  let config = consentedConfig(configFile);
  if (!config) return { enabled: false, started: [] };
  const setup = options.setupModule || require('../../bin/setup-observability.js');
  const pluginRoot = options.pluginRoot || path.resolve(__dirname, '..', '..');
  const currentPluginVersion = setup.pluginVersion(pluginRoot);
  const lock = acquireLock(dataDir, { ...options, pluginVersion: currentPluginVersion });
  if (!lock) return { enabled: true, started: [], skipped: 'locked' };

  try {
    config = consentedConfig(configFile);
    if (!config) return { enabled: false, started: [] };
    let state = config.observability;
    const ports = state.ports;
    if (state.dashboard) {
      const dashboardConfig = state.sinks[DEFAULT_SINK] || {};
      const managedDashboard = {
        ...dashboardConfig,
        container: dashboardConfig.container || setup.MANAGED_DASHBOARD_CONTAINER,
        grafanaPort: dashboardConfig.grafanaPort ?? ports.dashboard,
        otlpPort: dashboardConfig.otlpPort ?? ports.dashboardOtlp,
      };
      if (JSON.stringify(dashboardConfig) !== JSON.stringify(managedDashboard)) {
        config = normalizeManagedConfig({
          ...config,
          observability: {
            ...state,
            sinks: { ...state.sinks, [DEFAULT_SINK]: managedDashboard },
          },
        });
        state = config.observability;
      }
    }
    const pluginDrift = Boolean(state.managedVersion && state.managedVersion !== currentPluginVersion);
    const collectorDrift = Boolean(state.collectorVersion && state.collectorVersion !== setup.COLLECTOR_VERSION);
    const dashboardDrift = Boolean(state.dashboardVersion && state.dashboardVersion !== currentPluginVersion);
    const dashboardConfigDrift = Boolean(state.dashboard && state.dashboardConfigVersion !== grafanaLgtm.MANAGED_CONFIG_VERSION);
    const collectorBinary = setup.resolveCollectorBinary(dataDir, options.environment);
    const binaryMissing = !fs.existsSync(collectorBinary);
    const sink = resolveSink(config);

    setup.ensureCollectorConfig(dataDir, sink, ports);
    if (pluginDrift || collectorDrift || binaryMissing) await teardownRuntime(config, { ...options, dataDir });
    if (binaryMissing || collectorDrift) {
      await setup.downloadCollector({ ...options, dataDir });
      setup.verifyCommand(collectorBinary, ['--version'], options.spawnSync);
    }

    let dashboard = null;
    let dashboardSkipped = false;

    const started = [];
    const rotatedLogs = [];
    const checkPort = options.checkPort || portListening;
    const startProcess = options.startProcess || startManagedProcess;
    const wait = options.waitForPort || waitForPort;
    const observerScript = path.join(pluginRoot, 'bin', 'observer.js');
    const processes = [
      { name: 'observer', port: ports.observer, scriptPath: observerScript },
      { name: 'collector', port: ports.collector, scriptPath: collectorBinary },
    ];
    for (const process of processes) {
      const listening = await checkPort(process.port, options);
      const logNeedsRotation = managedLogNeedsRotation(process.name, dataDir, options);
      const restartManagedProcess = managedProcessNeedsRestart(process.name, dataDir, {
        pluginVersion: currentPluginVersion,
        scriptPath: process.scriptPath,
      }, options);
      let owner = null;
      let needsRestart = restartManagedProcess;
      if (process.name === 'observer') {
        const ownerFinder = options.portOwner || (!options.checkPort ? portOwner : null);
        if (listening) {
          const identifyObserver = options.observerIdentity || (options.checkPort ? null : observerIdentity);
          const identity = identifyObserver ? await identifyObserver(process.port, options) : null;
          const observedOwner = identity?.pid || (ownerFinder && ownerFinder(process.port, options));
          const recordMatchesOwner = processRecordMatchesProvenance(process.name, dataDir, observedOwner, {
            pluginVersion: currentPluginVersion,
            scriptPath: process.scriptPath,
          }, options);
          needsRestart = identity
            ? identity.pluginVersion !== currentPluginVersion
            : !recordMatchesOwner;
          if (needsRestart) owner = observedOwner;
        } else {
          owner = ownerFinder && ownerFinder(process.port, options);
          needsRestart = Boolean(owner) || restartManagedProcess;
        }
      }
      if ((needsRestart || logNeedsRotation) && (listening || owner)) {
        if (owner) stopProcess(owner, process.name, options);
        else stopManagedProcess(process.name, dataDir, options);
        if (await wait(process.port, false, options) && logNeedsRotation
          && rotateManagedLog(process.name, dataDir, options)) {
          rotatedLogs.push(process.name);
        }
      } else if (!listening && logNeedsRotation && rotateManagedLog(process.name, dataDir, options)) {
        rotatedLogs.push(process.name);
      }
    }
    if (!await checkPort(ports.observer, options)) {
      startProcess('observer', process.execPath, [
        observerScript,
        '--db', path.join(dataDir, 'observability.db'),
        '--host', LOOPBACK,
        '--port', String(ports.observer),
        '--config', configFile,
      ], dataDir, {
        ...options,
        pluginVersion: currentPluginVersion,
        scriptPath: observerScript,
      });
      started.push('observer');
      await wait(ports.observer, true, options);
    }
    if (!await checkPort(ports.collector, options)) {
      startProcess('collector', collectorBinary, ['--config', path.join(dataDir, 'otel-collector-config.yaml')], dataDir, {
        ...options,
        pluginVersion: currentPluginVersion,
        scriptPath: collectorBinary,
      });
      started.push('collector');
      await wait(ports.collector, true, options);
    }

    if (state.dashboard) {
      if (setup.dockerAvailable(options)) {
        const activityStart = dashboardActivityStart(dataDir, options.now ?? Date.now());
        let activeProjectNames = new Set();
        try {
          activeProjectNames = grafanaLgtm.activeProjectNames(state.sinks[DEFAULT_SINK] || {}, {
            ...options,
            activityStart,
          });
        } catch (error) {
          const warningStream = options.stderr || process.stderr;
          warningStream.write(`warning: could not determine active dashboard projects, provisioning the global dashboard only: ${error.message}\n`);
        }
        const activeProjects = projectsWithActivity(state.optedInProjects, activeProjectNames);
        const dashboardDir = provisionDashboards(dataDir, activeProjects);
        dashboard = grafanaLgtm.setup(state.sinks[DEFAULT_SINK] || {}, {
          ...options,
          dataDir,
          dashboardDir,
          pluginVersion: currentPluginVersion,
          forceRecreate: pluginDrift || dashboardDrift || dashboardConfigDrift,
        });
      } else {
        dashboardSkipped = true;
      }
    }

    const dashboardVersion = state.dashboard && dashboard ? currentPluginVersion : state.dashboardVersion;
    const dashboardConfigVersion = state.dashboard && dashboard
      ? grafanaLgtm.MANAGED_CONFIG_VERSION
      : state.dashboardConfigVersion;
    if (state.managedVersion !== currentPluginVersion
      || state.collectorVersion !== setup.COLLECTOR_VERSION
      || state.dashboardVersion !== dashboardVersion
      || state.dashboardConfigVersion !== dashboardConfigVersion) {
      config = normalizeManagedConfig({
        ...config,
        observability: {
          ...state,
          managedVersion: currentPluginVersion,
          collectorVersion: setup.COLLECTOR_VERSION,
          dashboardVersion,
          dashboardConfigVersion,
        },
      });
      writeObservabilityConfig(configFile, config);
    }
    return {
      enabled: true,
      started,
      rotatedLogs,
      dashboard,
      dashboardSkipped,
      pluginDrift,
      collectorDrift,
      dashboardDrift,
      dashboardConfigDrift,
    };
  } finally {
    releaseLock(lock);
  }
}

function observerIdentity(port, options = {}) {
  const timeoutMs = Math.max(25, Number(options.healthTimeoutMs) || 300);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (identity = null) => {
      if (settled) return;
      settled = true;
      resolve(identity);
    };
    const request = (options.httpGet || http.get)(`http://${LOOPBACK}:${port}/health`, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body?.ok === true && Number.isInteger(body.pid) && body.pid > 0 && typeof body.pluginVersion === 'string') {
            finish({ pid: body.pid, pluginVersion: body.pluginVersion });
            return;
          }
        } catch {}
        finish();
      });
      response.once('error', () => finish());
    });
    request.once('timeout', () => { request.destroy(); finish(); });
    request.once('error', () => finish());
  });
}

function endpointHealthy(port, pathname, options = {}) {
  const timeoutMs = Math.max(25, Number(options.healthTimeoutMs) || 300);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (healthy = false) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = (options.httpGet || http.get)(`http://${LOOPBACK}:${port}${pathname}`, { timeout: timeoutMs }, (response) => {
      response.resume();
      finish(response.statusCode < 500);
    });
    request.once('timeout', () => { request.destroy(); finish(); });
    request.once('error', () => finish());
  });
}

function collectorHealth(port, options = {}) {
  return endpointHealthy(port, '/v1/logs', options);
}

function dashboardHealth(port, options = {}) {
  return endpointHealthy(port, '/api/health', options);
}

function observerHealth(port, options = {}) {
  return observerIdentity(port, options).then(Boolean);
}

function portOwner(port, options = {}) {
  const command = options.platform || process.platform;
  const run = options.spawnSync || spawnSync;
  try {
    if (command === 'win32') {
      const output = String(run('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8', timeout: 3000, windowsHide: true,
      }).stdout || '');
      for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields[0]?.toUpperCase() !== 'TCP' || fields[1] !== `${LOOPBACK}:${port}` || fields[3] !== 'LISTENING') continue;
        const pid = Number(fields[4]);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    }
    const output = String(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    }).stdout || '');
    const pid = Number(output.trim().split(/\s+/, 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function stopProcess(pid, name, options = {}) {
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
  if (typeof options.killProcess === 'function') {
    options.killProcess(pid, name);
    return true;
  }
  if (!processAlive(pid)) return false;
  if ((options.platform || process.platform) === 'win32') {
    (options.spawnSync || spawnSync)('taskkill', ['/pid', String(pid), '/T', '/F'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
  } else {
    process.kill(pid, 'SIGTERM');
  }
  return true;
}

async function healthSnapshot(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const storage = storageHealth(dataDir, options);
  const configFile = options.configFile || defaultConfigPath(dataDir);
  if (!fs.existsSync(configFile)) return { configured: false, enabled: false, storage };
  let config;
  try {
    config = normalizeManagedConfig(readObservabilityConfig(configFile));
  } catch (error) {
    return { configured: true, enabled: false, error: error.message, storage };
  }
  const state = config.observability;
  if (!state.enabled) return {
    configured: true,
    enabled: false,
    sink: state.sink,
    dashboard: state.dashboard,
    ports: state.ports,
    storage,
  };
  const [observer, collector] = await Promise.all([
    observerHealth(state.ports.observer, options),
    collectorHealth(state.ports.collector, options),
  ]);
  let dashboard = { configured: state.dashboard, docker: false, running: false };
  if (state.dashboard) {
    const setup = options.setupModule || require('../../bin/setup-observability.js');
    const docker = setup.dockerAvailable(options);
    const runtime = grafanaLgtm.runtimeConfig(state.sinks[DEFAULT_SINK] || {});
    if (docker) {
      const deleteStatus = grafanaLgtm.deleteStatus(state.sinks[DEFAULT_SINK] || {}, options);
      const healthy = await dashboardHealth(runtime.grafanaPort, options);
      dashboard = {
        configured: true,
        docker: true,
        running: deleteStatus.running,
        healthy,
        container: runtime.container,
        deletes: deleteStatus.deletes,
      };
    } else {
      dashboard = {
        configured: true,
        docker: false,
        running: false,
        healthy: false,
        container: runtime.container,
        deletes: { prometheus: false, loki: false },
      };
    }
  }
  return {
    configured: true,
    enabled: true,
    sink: state.sink,
    ports: state.ports,
    observer: { healthy: observer },
    collector: { healthy: collector },
    storage,
    dashboard,
  };
}

async function launchEnsure(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const configFile = options.configFile || defaultConfigPath(dataDir);
  const config = consentedConfig(configFile);
  if (!config) return false;
  const observerPort = config.observability.ports.observer;
  const checkPort = options.checkPort || portListening;
  const listening = await checkPort(observerPort, options);
  const ownerFinder = options.portOwner || (!options.checkPort ? portOwner : null);
  const identity = listening ? await (options.observerIdentity || observerIdentity)(observerPort, options) : null;
  const owner = identity?.pid || (ownerFinder && ownerFinder(observerPort, options));
  const pluginRoot = options.pluginRoot || path.resolve(__dirname, '..', '..');
  const currentPluginVersion = (options.setupModule || require('../../bin/setup-observability.js')).pluginVersion(pluginRoot);
  const recordMatchesOwner = processRecordMatchesProvenance('observer', dataDir, owner, {
    pluginVersion: currentPluginVersion,
    scriptPath: path.join(pluginRoot, 'bin', 'observer.js'),
  }, options);
  const needsRestart = listening
    ? identity ? identity.pluginVersion !== currentPluginVersion : !recordMatchesOwner
    : Boolean(owner);
  if (needsRestart) {
    const ownerDescription = identity
      ? `pid ${identity.pid}, plugin ${identity.pluginVersion}`
      : owner ? `pid ${owner}, no health response` : 'an unknown process, no health response';
    if (typeof options.reportNotice === 'function') {
      options.reportNotice(`Observability: replacing the observer on ${LOOPBACK}:${observerPort} held by ${ownerDescription}.`);
    }
  }
  const child = (options.spawn || spawn)(process.execPath, [__filename, '--run'], {
    detached: true,
    env: { ...process.env, ...(options.environment || {}) },
    stdio: 'ignore',
    windowsHide: true,
  });
  if (typeof child.unref === 'function') child.unref();
  return true;
}

async function main() {
  if (process.argv.includes('--launch')) {
    await launchEnsure({
      reportNotice(message) {
        process.stdout.write(JSON.stringify({ systemMessage: message }));
      },
    });
    return;
  }
  if (process.argv.includes('--health')) {
    process.stdout.write(`${JSON.stringify(await healthSnapshot(), null, 2)}\n`);
    return;
  }
  await ensureObservability();
}

if (require.main === module) main().catch(() => { process.exitCode = 0; });

module.exports = {
  MANAGED_LOG_ARCHIVES,
  MAX_MANAGED_LOG_BYTES,
  acquireLock,
  consentedConfig,
  ensureObservability,
  healthSnapshot,
  launchEnsure,
  managedLogNeedsRotation,
  observerIdentity,
  portListening,
  portOwner,
  releaseLock,
  rotateManagedLog,
  startManagedProcess,
  stopManagedProcess,
  storageHealth,
  teardownRuntime,
  waitForPort,
};
