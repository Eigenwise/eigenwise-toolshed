'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const setup = require('../bin/setup-observability.js');
const { createObserver } = require('../bin/observer.js');
const {
  ensureObservability,
  healthSnapshot,
  launchEnsure,
  startManagedProcess,
} = require('../lib/observability/ensure.js');
const { readObservabilityConfig, writeObservabilityConfig } = require('../observability/sinks/index.js');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ensure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function enabledConfig(ports = {}) {
  return {
    observability: {
      enabled: true,
      sink: 'none',
      dashboard: false,
      ports: {
        collector: 15431,
        observer: 15432,
        dashboard: 15433,
        dashboardOtlp: 15434,
        ...ports,
      },
      sinks: {},
      managedVersion: setup.pluginVersion(),
      collectorVersion: setup.COLLECTOR_VERSION,
    },
  };
}

test('SessionStart launch is a silent no-op without enabled consent', async (t) => {
  const dataDir = temporaryDirectory(t);
  let spawned = false;
  assert.equal(await launchEnsure({ dataDir, spawn: () => { spawned = true; } }), false);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), {
    observability: { enabled: false, sink: 'none', dashboard: false, sinks: {} },
  });
  assert.equal(await launchEnsure({ dataDir, spawn: () => { spawned = true; } }), false);
  assert.equal(spawned, false);
});

test('SessionStart launch detaches the bounded ensure worker after consent', async (t) => {
  const dataDir = temporaryDirectory(t);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());
  let call;
  let unref = false;
  const launched = await launchEnsure({
    dataDir,
    checkPort: async () => false,
    spawn(command, args, options) {
      call = { command, args, options };
      return { unref() { unref = true; } };
    },
  });
  assert.equal(launched, true);
  assert.equal(call.command, process.execPath);
  assert.ok(call.args.includes('--run'));
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, true);
  assert.equal(unref, true);
});

test('ensure restores observer and collector on configured loopback ports', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  writeObservabilityConfig(configFile, enabledConfig());
  const starts = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => false,
    waitForPort: async () => true,
    startProcess(name, command, args) { starts.push({ name, command, args }); return 1000 + starts.length; },
  });

  assert.deepEqual(result.started, ['observer', 'collector']);
  assert.equal(starts[0].name, 'observer');
  assert.equal(starts[0].command, process.execPath);
  assert.ok(starts[0].args.includes('15432'));
  assert.deepEqual(starts[1], {
    name: 'collector',
    command: collectorBinary,
    args: ['--config', path.join(dataDir, 'otel-collector-config.yaml')],
  });
  const collectorConfig = fs.readFileSync(path.join(dataDir, 'otel-collector-config.yaml'), 'utf8');
  assert.match(collectorConfig, /127\.0\.0\.1:15431/);
  assert.match(collectorConfig, /127\.0\.0\.1:15432/);
});

test('ensure is idempotent while both managed ports are healthy', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  writeObservabilityConfig(configFile, enabledConfig());

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
    startProcess() { throw new Error('healthy services must not restart'); },
  });

  assert.deepEqual(result.started, []);
});

test('ensure rotates oversized managed logs before starting services', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'collector.log'), 'x'.repeat(128));
  writeObservabilityConfig(configFile, enabledConfig());

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    maxManagedLogBytes: 64,
    checkPort: async () => false,
    waitForPort: async () => true,
    startProcess() { return 1000; },
  });

  assert.deepEqual(result.rotatedLogs, ['collector']);
  assert.equal(fs.existsSync(path.join(dataDir, 'collector.log')), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'collector.log.1'), 'utf8').length, 128);
});

test('health reports whether the dashboard supports project-data deletes', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const config = enabledConfig();
  config.observability.sink = 'grafana-lgtm';
  config.observability.dashboard = true;
  config.observability.sinks = {
    'grafana-lgtm': { container: 'workbench-otel-lgtm', grafanaPort: 15433, otlpPort: 15434 },
  };
  writeObservabilityConfig(configFile, config);
  fs.writeFileSync(path.join(dataDir, 'observability.db'), 'database');
  fs.writeFileSync(path.join(dataDir, 'observability.db-wal'), 'wal');

  const snapshot = await healthSnapshot({
    dataDir,
    configFile,
    maxDatabaseBytes: 4,
    maxWalBytes: 2,
    dockerAvailable: true,
    healthTimeoutMs: 25,
    spawnSync(command, args) {
      assert.equal(command, 'docker');
      assert.equal(args[0], 'inspect');
      return {
        status: 0,
        stdout: `true|${setup.LGTM_IMAGE}|${setup.pluginVersion()}|${require('../observability/sinks/grafana/index.js').MANAGED_CONFIG_VERSION}|null`,
      };
    },
  });

  assert.deepEqual(snapshot.dashboard.deletes, { prometheus: true, loki: true });
  assert.equal(snapshot.storage.databaseBytes, 8);
  assert.equal(snapshot.storage.walBytes, 3);
  assert.equal(snapshot.storage.overDatabaseLimit, true);
  assert.equal(snapshot.storage.overWalLimit, true);
});

test('plugin version drift replaces both managed processes and updates the marker', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  const config = enabledConfig();
  config.observability.managedVersion = '0.0.0';
  writeObservabilityConfig(configFile, config);
  fs.writeFileSync(path.join(dataDir, 'observer.pid'), '101\n');
  fs.writeFileSync(path.join(dataDir, 'collector.pid'), '102\n');
  const checks = new Map();
  const killed = [];
  const started = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async (port) => {
      const count = checks.get(port) || 0;
      checks.set(port, count + 1);
      return count === 0;
    },
    waitForPort: async () => true,
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess(name) { started.push(name); return 1000 + started.length; },
  });

  assert.equal(result.pluginDrift, true);
  assert.deepEqual(killed.map((entry) => entry.name).sort(), ['collector', 'observer']);
  assert.deepEqual(started, ['observer', 'collector']);
  assert.equal(readObservabilityConfig(configFile).observability.managedVersion, setup.pluginVersion());
});

test('dashboard drift survives Docker downtime and heals when Docker returns', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  const config = enabledConfig();
  config.observability.sink = 'grafana-lgtm';
  config.observability.dashboard = true;
  config.observability.dashboardVersion = '0.0.0';
  config.observability.optedInProjects = [{ project_name: 'atlas', project_id: 'a'.repeat(64), optedInAt: '2026-07-20T00:00:00.000Z' }];
  config.observability.sinks = {
    'grafana-lgtm': {
      container: 'workbench-otel-lgtm',
      grafanaPort: config.observability.ports.dashboard,
      otlpPort: config.observability.ports.dashboardOtlp,
    },
  };
  writeObservabilityConfig(configFile, config);
  const skipped = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    activeProjectNames: ['atlas'],
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
  });
  assert.equal(skipped.dashboardSkipped, true);
  assert.equal(readObservabilityConfig(configFile).observability.dashboardVersion, '0.0.0');
  assert.equal(fs.existsSync(path.join(dataDir, 'grafana-dashboards')), false);
  const dockerCalls = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: true,
    activeProjectNames: ['atlas'],
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
    spawnSync(command, args) {
      dockerCalls.push([command, args]);
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${setup.LGTM_IMAGE}|0.0.0|null` };
      return { status: 0, stdout: args[0] === 'exec' ? '200' : '' };
    },
  });

  assert.equal(result.dashboardDrift, true);
  assert.deepEqual(dockerCalls.map((call) => call[1][0]), ['inspect', 'rm', 'run', 'inspect', 'exec']);
  assert.ok(dockerCalls[2][1].includes(`${path.join(dataDir, 'grafana-dashboards')}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards:ro`));
  assert.equal(readObservabilityConfig(configFile).observability.dashboardVersion, setup.pluginVersion());
  assert.equal(
    readObservabilityConfig(configFile).observability.dashboardConfigVersion,
    require('../observability/sinks/grafana/index.js').MANAGED_CONFIG_VERSION,
  );
});

test('ensure keeps the observer listening when dashboard activity lookup fails', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  const config = enabledConfig();
  config.observability.dashboard = true;
  config.observability.sink = 'grafana-lgtm';
  config.observability.optedInProjects = [{ project_name: 'atlas', project_id: 'a'.repeat(64) }];
  config.observability.sinks = { 'grafana-lgtm': {} };
  writeObservabilityConfig(configFile, config);
  const listeningPorts = new Set();
  const warnings = [];
  let dashboardProbeCount = 0;

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: true,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async (port) => listeningPorts.has(port),
    waitForPort: async (port, expected) => listeningPorts.has(port) === expected,
    startProcess(name) {
      listeningPorts.add(config.observability.ports[name]);
      return 1000 + listeningPorts.size;
    },
    stderr: { write(message) { warnings.push(message); } },
    spawnSync(command, args) {
      assert.equal(command, 'docker');
      if (args[0] === 'exec') {
        dashboardProbeCount += 1;
        return { status: dashboardProbeCount === 1 ? 1 : 0, stdout: dashboardProbeCount === 1 ? '' : '200' };
      }
      return {
        status: 0,
        stdout: `true|${setup.LGTM_IMAGE}|${setup.pluginVersion()}|1|null|[]`,
      };
    },
  });

  assert.equal(listeningPorts.has(config.observability.ports.observer), true);
  assert.deepEqual(result.started, ['observer', 'collector']);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'grafana-dashboards')), ['claude-code-usage.json']);
  assert.deepEqual(warnings, [
    'warning: could not determine active dashboard projects, provisioning the global dashboard only: Prometheus could not report recently active dashboard projects.\n',
  ]);
});

test('ensure reclaims a stale versioned ensure owner and restores the observer', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  writeObservabilityConfig(configFile, enabledConfig());
  const lockDir = path.join(dataDir, 'ensure-observability.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
    pid: 202,
    pluginVersion: '0.7.8',
    scriptPath: path.join(path.resolve(__dirname, '..'), 'lib', 'observability', 'ensure.js'),
  })}\n`);
  const killed = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    processAlive: () => true,
    killProcess(pid, name) { killed.push({ pid, name }); },
    checkPort: async () => false,
    waitForPort: async () => true,
    startProcess() { return 1000; },
  });

  assert.deepEqual(killed, [{ pid: 202, name: 'ensure' }]);
  assert.deepEqual(result.started, ['observer', 'collector']);
});

test('ensure starts local telemetry before checking an unavailable dashboard', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  const config = enabledConfig();
  config.observability.dashboard = true;
  config.observability.sink = 'grafana-lgtm';
  config.observability.sinks = { 'grafana-lgtm': {} };
  writeObservabilityConfig(configFile, config);
  const started = [];
  const dockerCalls = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => false,
    waitForPort: async () => true,
    startProcess(name) { started.push(name); return 1000; },
    spawnSync(command, args) {
      assert.deepEqual(started, ['observer', 'collector']);
      dockerCalls.push([command, args]);
      return { status: 1, stdout: '' };
    },
  });

  assert.equal(result.dashboardSkipped, true);
  assert.deepEqual(started, ['observer', 'collector']);
  assert.deepEqual(dockerCalls.map(([command, args]) => [command, args[0]]), [['docker', 'info']]);
});

test('start records the managed process provenance next to its PID', (t) => {
  const dataDir = temporaryDirectory(t);
  startManagedProcess('observer', process.execPath, ['--version'], dataDir, {
    pluginVersion: '0.20.0',
    scriptPath: 'C:\\workbench\\bin\\workbench-observer.js',
    now: 0,
    spawn() { return { pid: 101, unref() {} }; },
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'observer.pid.json'), 'utf8')), {
    pid: 101,
    pluginVersion: '0.20.0',
    scriptPath: 'C:\\workbench\\bin\\workbench-observer.js',
    heartbeatAt: '1970-01-01T00:00:00.000Z',
  });
});

// The heartbeat is written by a worker thread that has to spawn, receive a message, and
// swap the record through a temp file. Spawning alone can outlast a fixed sleep on a loaded
// runner, so poll instead, and tolerate a read that lands mid-rename.
async function waitForRefreshedHeartbeat(recordFile, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    let heartbeatAt = 0;
    try {
      heartbeatAt = Date.parse(JSON.parse(fs.readFileSync(recordFile, 'utf8')).heartbeatAt);
    } catch {
      heartbeatAt = 0;
    }
    if (heartbeatAt > 0) return heartbeatAt;
    if (Date.now() >= deadline) return heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('observer refreshes its managed process heartbeat from a worker', async (t) => {
  const dataDir = temporaryDirectory(t);
  const recordFile = path.join(dataDir, 'observer.pid.json');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(recordFile, `${JSON.stringify({
    pid: process.pid,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
    heartbeatAt: new Date(0).toISOString(),
  })}\n`);
  const observer = createObserver({
    databaseFile: path.join(dataDir, 'observability.db'),
    host: '127.0.0.1',
    port: 0,
    pluginVersion: setup.pluginVersion(),
    hookSpoolFile: path.join(dataDir, 'hook-spool.jsonl'),
    sink: { id: 'none', egress: 'loopback', outbox: { enabled: false } },
    store: {
      ingestBatch() { return []; },
      preserveStorageHeadroom() { return { state: 'healthy', action: 'none', failure: null }; },
      prune() { return null; },
    },
  });
  t.after(() => observer.close());

  await observer.start();

  assert.ok(await waitForRefreshedHeartbeat(recordFile) > 0);
});

test('ensure replaces a stale managed observer from the current plugin root', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid'), '101\n');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: '0.0.0',
    scriptPath: 'C:\\old-workbench\\bin\\workbench-observer.js',
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());
  const started = [];
  const killed = [];
  let observerChecks = 0;

  await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async (port) => {
      if (port !== 15432) return false;
      observerChecks += 1;
      return observerChecks === 1;
    },
    processAlive: () => true,
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess(name, command, args) { started.push({ name, command, args }); return 1000 + started.length; },
    waitForPort: async () => true,
  });

  assert.deepEqual(killed, [{ pid: 101, name: 'observer' }]);
  assert.equal(started[0].name, 'observer');
  assert.equal(started[0].args[0], observerScript);
});

test('ensure adopts a fresh managed observer without restarting it', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid'), '101\n');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
    processAlive: () => true,
    startProcess() { throw new Error('fresh managed services must not restart'); },
  });

  assert.deepEqual(result.started, []);
});

test('ensure keeps a managed observer that times out during its identity probe', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
    observerIdentity: async () => null,
    portOwner: () => 101,
    killProcess() { throw new Error('busy managed observer must not restart'); },
    startProcess() { throw new Error('busy managed observer must not restart'); },
  });

  assert.deepEqual(result.started, []);
});

test('ensure keeps a fresh managed observer that misses its identity probe', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  const now = 1_000_000;
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
    heartbeatAt: new Date(now - 30_000).toISOString(),
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    now,
    checkPort: async () => true,
    observerIdentity: async () => null,
    portOwner: () => 101,
    killProcess() { throw new Error('fresh managed observer must not restart'); },
    startProcess() { throw new Error('fresh managed observer must not restart'); },
  });

  assert.deepEqual(result.started, []);
});

test('ensure replaces a managed observer with a stale heartbeat', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
    heartbeatAt: new Date(0).toISOString(),
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());
  const killed = [];
  const started = [];
  let observerChecks = 0;

  await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    now: 120_001,
    checkPort: async (port) => port === 15432 && observerChecks++ === 0,
    observerIdentity: async () => null,
    portOwner: () => 101,
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess(name) { started.push(name); return 1000 + started.length; },
    waitForPort: async () => true,
  });

  assert.deepEqual(killed, [{ pid: 101, name: 'observer' }]);
  assert.ok(started.includes('observer'));
});

test('ensure replaces a managed observer from another recorded plugin version', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(collectorBinary, 'test');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 101,
    pluginVersion: '0.0.0',
    scriptPath: observerScript,
    heartbeatAt: new Date().toISOString(),
  })}\n`);
  writeObservabilityConfig(configFile, enabledConfig());
  const killed = [];
  const started = [];
  let observerChecks = 0;

  await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async (port) => port === 15432 && observerChecks++ === 0,
    observerIdentity: async () => null,
    portOwner: () => 101,
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess(name) { started.push(name); return 1000 + started.length; },
    waitForPort: async () => true,
  });

  assert.deepEqual(killed, [{ pid: 101, name: 'observer' }]);
  assert.ok(started.includes('observer'));
});

test('ensure replaces an observer that reports another plugin version', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  writeObservabilityConfig(configFile, enabledConfig());
  const killed = [];
  const started = [];
  let observerChecks = 0;

  await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async (port) => port === 15432 && observerChecks++ === 0,
    observerIdentity: async () => ({ pid: 202, pluginVersion: '0.3.1' }),
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess(name) { started.push(name); return 1000 + started.length; },
    waitForPort: async () => true,
  });

  assert.deepEqual(killed, [{ pid: 202, name: 'observer' }]);
  assert.deepEqual(started, ['observer', 'collector']);
});

test('ensure removes an observer that holds the port without accepting connections', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  fs.writeFileSync(collectorBinary, 'test');
  writeObservabilityConfig(configFile, enabledConfig());
  const killed = [];

  await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: false,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => false,
    portOwner: () => 62536,
    killProcess(pid, name) { killed.push({ pid, name }); },
    startProcess() { return 1000; },
    waitForPort: async () => true,
  });

  assert.deepEqual(killed, [{ pid: 62536, name: 'observer' }]);
});

test('SessionStart warns when it replaces a listening observer that does not identify itself', async (t) => {
  const dataDir = temporaryDirectory(t);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());
  const notices = [];

  await launchEnsure({
    dataDir,
    checkPort: async () => true,
    observerIdentity: async () => null,
    portOwner: () => 202,
    reportNotice(message) { notices.push(message); },
    spawn() { return { unref() {} }; },
  });

  assert.deepEqual(notices, ['Observability: replacing the observer on 127.0.0.1:15432 held by pid 202, no health response.']);
});

test('SessionStart does not report a replacement for a busy managed observer', async (t) => {
  const dataDir = temporaryDirectory(t);
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  fs.writeFileSync(path.join(dataDir, 'observer.pid.json'), `${JSON.stringify({
    pid: 202,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
  })}\n`);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());
  const notices = [];

  await launchEnsure({
    dataDir,
    checkPort: async () => true,
    observerIdentity: async () => null,
    portOwner: () => 202,
    reportNotice(message) { notices.push(message); },
    spawn() { return { unref() {} }; },
  });

  assert.deepEqual(notices, []);
});

test('SessionStart keeps a managed observer whose record mtime is a fraction of a millisecond ahead', async (t) => {
  const dataDir = temporaryDirectory(t);
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'observer.js');
  const recordFile = path.join(dataDir, 'observer.pid.json');
  fs.writeFileSync(recordFile, `${JSON.stringify({
    pid: 202,
    pluginVersion: setup.pluginVersion(),
    scriptPath: observerScript,
  })}\n`);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());

  // A record with no heartbeatAt falls back to mtimeMs, which carries sub-millisecond precision that
  // Date.now() does not. Pin the pair so the file is 0.4ms "ahead" of the clock every run, instead of
  // the ~50% of real writes that land that way by chance.
  const pinnedNow = Date.now();
  const mtimeSeconds = (pinnedNow + 0.4) / 1000;
  fs.utimesSync(recordFile, mtimeSeconds, mtimeSeconds);

  const notices = [];
  await launchEnsure({
    dataDir,
    now: pinnedNow,
    checkPort: async () => true,
    observerIdentity: async () => null,
    portOwner: () => 202,
    reportNotice(message) { notices.push(message); },
    spawn() { return { unref() {} }; },
  });

  assert.deepEqual(notices, []);
});

test('SessionStart warns when it replaces an observer from an older plugin version', async (t) => {
  const dataDir = temporaryDirectory(t);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());
  const notices = [];

  await launchEnsure({
    dataDir,
    checkPort: async () => true,
    observerIdentity: async () => ({ pid: 202, pluginVersion: '0.3.1' }),
    reportNotice(message) { notices.push(message); },
    spawn() { return { unref() {} }; },
  });

  assert.deepEqual(notices, ['Observability: replacing the observer on 127.0.0.1:15432 held by pid 202, plugin 0.3.1.']);
});

test('setup disable runs without a circular dependency warning', (t) => {
  const root = temporaryDirectory(t);
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'setup-observability.js'), '--disable'], {
    cwd: projectDir,
    env: { ...process.env, LOCALAPPDATA: root },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
