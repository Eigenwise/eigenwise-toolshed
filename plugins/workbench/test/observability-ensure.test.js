'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const setup = require('../bin/setup-observability.js');
const {
  ensureObservability,
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

test('SessionStart launch is a silent no-op without enabled consent', (t) => {
  const dataDir = temporaryDirectory(t);
  let spawned = false;
  assert.equal(launchEnsure({ dataDir, spawn: () => { spawned = true; } }), false);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), {
    observability: { enabled: false, sink: 'none', dashboard: false, sinks: {} },
  });
  assert.equal(launchEnsure({ dataDir, spawn: () => { spawned = true; } }), false);
  assert.equal(spawned, false);
});

test('SessionStart launch detaches the bounded ensure worker after consent', (t) => {
  const dataDir = temporaryDirectory(t);
  writeObservabilityConfig(path.join(dataDir, 'observability.json'), enabledConfig());
  let call;
  let unref = false;
  const launched = launchEnsure({
    dataDir,
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
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
  });
  assert.equal(skipped.dashboardSkipped, true);
  assert.equal(readObservabilityConfig(configFile).observability.dashboardVersion, '0.0.0');
  const dockerCalls = [];

  const result = await ensureObservability({
    dataDir,
    configFile,
    dockerAvailable: true,
    environment: { WORKBENCH_OTELCOL_CONTRIB: collectorBinary },
    checkPort: async () => true,
    spawnSync(command, args) {
      dockerCalls.push([command, args]);
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${setup.LGTM_IMAGE}|0.0.0|null` };
      return { status: 0, stdout: '' };
    },
  });

  assert.equal(result.dashboardDrift, true);
  assert.deepEqual(dockerCalls.map((call) => call[1][0]), ['inspect', 'rm', 'run']);
  assert.equal(readObservabilityConfig(configFile).observability.dashboardVersion, setup.pluginVersion());
});

test('start records the managed process provenance next to its PID', (t) => {
  const dataDir = temporaryDirectory(t);
  startManagedProcess('observer', process.execPath, ['--version'], dataDir, {
    pluginVersion: '0.20.0',
    scriptPath: 'C:\\workbench\\bin\\workbench-observer.js',
    spawn() { return { pid: 101, unref() {} }; },
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'observer.pid.json'), 'utf8')), {
    pid: 101,
    pluginVersion: '0.20.0',
    scriptPath: 'C:\\workbench\\bin\\workbench-observer.js',
  });
});

test('ensure replaces a stale managed observer from the current plugin root', async (t) => {
  const dataDir = temporaryDirectory(t);
  const configFile = path.join(dataDir, 'observability.json');
  const collectorBinary = path.join(dataDir, 'collector-test-binary');
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'workbench-observer.js');
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
  const observerScript = path.join(path.resolve(__dirname, '..'), 'bin', 'workbench-observer.js');
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
