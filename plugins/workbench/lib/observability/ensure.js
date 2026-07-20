#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const grafanaLgtm = require('../../observability/sinks/grafana/index.js');
const { provisionDashboards } = require('../../observability/sinks/grafana/dashboard-generator.js');
const {
  DEFAULT_SINK,
  defaultConfigPath,
  defaultDataDir,
  readObservabilityConfig,
  resolveSink,
  writeObservabilityConfig,
} = require('../../observability/sinks/index.js');

const LOCK_MAX_AGE_MS = 30_000;
const LOOPBACK = '127.0.0.1';

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

function managedProcessNeedsRestart(name, dataDir, provenance, options = {}) {
  const pid = readPid(pidFile(dataDir, name));
  const alive = options.processAlive || processAlive;
  if (!pid || !alive(pid)) return false;
  const record = readProcessRecord(dataDir, name);
  return !record
    || record.pid !== pid
    || record.pluginVersion !== provenance.pluginVersion
    || record.scriptPath !== provenance.scriptPath;
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
      if ((options.platform || process.platform) === 'win32') {
        (options.spawnSync || spawnSync)('taskkill', ['/pid', String(pid), '/T', '/F'], {
          encoding: 'utf8', timeout: 3000, windowsHide: true,
        });
      } else {
        process.kill(pid, 'SIGTERM');
      }
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
  writeProcessRecord(dataDir, name, {
    pid: child.pid,
    pluginVersion: options.pluginVersion,
    scriptPath: options.scriptPath,
  });
  if (typeof child.unref === 'function') child.unref();
  return child.pid;
}

function lockDirectory(dataDir) {
  return path.join(dataDir, 'ensure-observability.lock');
}

function acquireLock(dataDir, now = Date.now()) {
  const directory = lockDirectory(dataDir);
  const ownerFile = path.join(directory, 'pid');
  const create = () => {
    fs.mkdirSync(directory);
    fs.writeFileSync(ownerFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
    return directory;
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    return create();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  try {
    const owner = readPid(ownerFile);
    if (owner && processAlive(owner)) return null;
    if (!owner && now - fs.statSync(directory).mtimeMs <= LOCK_MAX_AGE_MS) return null;
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
  const lock = acquireLock(dataDir, options.now);
  if (!lock) return { enabled: true, started: [], skipped: 'locked' };

  try {
    config = consentedConfig(configFile);
    if (!config) return { enabled: false, started: [] };
    const setup = options.setupModule || require('../../bin/setup-observability.js');
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
    const pluginRoot = options.pluginRoot || path.resolve(__dirname, '..', '..');
    const currentPluginVersion = setup.pluginVersion(pluginRoot);
    const pluginDrift = Boolean(state.managedVersion && state.managedVersion !== currentPluginVersion);
    const collectorDrift = Boolean(state.collectorVersion && state.collectorVersion !== setup.COLLECTOR_VERSION);
    const dashboardDrift = Boolean(state.dashboardVersion && state.dashboardVersion !== currentPluginVersion);
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
    if (state.dashboard) {
      const dashboardDir = provisionDashboards(dataDir, state.optedInProjects);
      if (setup.dockerAvailable(options)) {
        dashboard = grafanaLgtm.setup(state.sinks[DEFAULT_SINK] || {}, {
          ...options,
          dataDir,
          dashboardDir,
          pluginVersion: currentPluginVersion,
          forceRecreate: pluginDrift || dashboardDrift,
        });
      } else {
        dashboardSkipped = true;
      }
    }

    const started = [];
    const checkPort = options.checkPort || portListening;
    const startProcess = options.startProcess || startManagedProcess;
    const wait = options.waitForPort || waitForPort;
    const observerScript = path.join(pluginRoot, 'bin', 'workbench-observer.js');
    const processes = [
      { name: 'observer', port: ports.observer, scriptPath: observerScript },
      { name: 'collector', port: ports.collector, scriptPath: collectorBinary },
    ];
    for (const process of processes) {
      if (await checkPort(process.port, options)
        && managedProcessNeedsRestart(process.name, dataDir, {
          pluginVersion: currentPluginVersion,
          scriptPath: process.scriptPath,
        }, options)) {
        stopManagedProcess(process.name, dataDir, options);
        await wait(process.port, false, options);
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

    const dashboardVersion = state.dashboard && dashboard ? currentPluginVersion : state.dashboardVersion;
    if (state.managedVersion !== currentPluginVersion
      || state.collectorVersion !== setup.COLLECTOR_VERSION
      || state.dashboardVersion !== dashboardVersion) {
      config = normalizeManagedConfig({
        ...config,
        observability: {
          ...state,
          managedVersion: currentPluginVersion,
          collectorVersion: setup.COLLECTOR_VERSION,
          dashboardVersion,
        },
      });
      writeObservabilityConfig(configFile, config);
    }
    return { enabled: true, started, dashboard, dashboardSkipped, pluginDrift, collectorDrift, dashboardDrift };
  } finally {
    releaseLock(lock);
  }
}

function observerHealth(port, options = {}) {
  const timeoutMs = Math.max(25, Number(options.healthTimeoutMs) || 300);
  return new Promise((resolve) => {
    const request = (options.httpGet || http.get)(`http://${LOOPBACK}:${port}/health`, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function healthSnapshot(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const configFile = options.configFile || defaultConfigPath(dataDir);
  if (!fs.existsSync(configFile)) return { configured: false, enabled: false };
  let config;
  try {
    config = normalizeManagedConfig(readObservabilityConfig(configFile));
  } catch (error) {
    return { configured: true, enabled: false, error: error.message };
  }
  const state = config.observability;
  if (!state.enabled) return {
    configured: true,
    enabled: false,
    sink: state.sink,
    dashboard: state.dashboard,
    ports: state.ports,
  };
  const [observerPort, collectorPort, observer] = await Promise.all([
    portListening(state.ports.observer, options),
    portListening(state.ports.collector, options),
    observerHealth(state.ports.observer, options),
  ]);
  let dashboard = { configured: state.dashboard, docker: false, running: false };
  if (state.dashboard) {
    const setup = options.setupModule || require('../../bin/setup-observability.js');
    const docker = setup.dockerAvailable(options);
    const runtime = grafanaLgtm.runtimeConfig(state.sinks[DEFAULT_SINK] || {});
    if (docker) {
      const inspected = (options.spawnSync || spawnSync)(options.docker || 'docker', [
        'inspect', '--format', '{{.State.Running}}', runtime.container,
      ], { encoding: 'utf8', timeout: 1500, windowsHide: true });
      dashboard = { configured: true, docker: true, running: inspected.status === 0 && String(inspected.stdout).trim() === 'true', container: runtime.container };
    } else {
      dashboard = { configured: true, docker: false, running: false, container: runtime.container };
    }
  }
  return {
    configured: true,
    enabled: true,
    sink: state.sink,
    ports: state.ports,
    observer: { listening: observerPort, healthy: observer },
    collector: { listening: collectorPort },
    dashboard,
  };
}

function launchEnsure(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const configFile = options.configFile || defaultConfigPath(dataDir);
  if (!consentedConfig(configFile)) return false;
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
    launchEnsure();
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
  LOCK_MAX_AGE_MS,
  acquireLock,
  consentedConfig,
  ensureObservability,
  healthSnapshot,
  launchEnsure,
  portListening,
  releaseLock,
  startManagedProcess,
  stopManagedProcess,
  teardownRuntime,
  waitForPort,
};
