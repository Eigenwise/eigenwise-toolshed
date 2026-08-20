'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalPath } = require('../../../lib/observability/path-identity.js');

const ID = 'grafana-lgtm';
const IMAGE = 'grafana/otel-lgtm:0.11.0';
const CONTAINER = 'workbench-otel-lgtm-demo';
const LOOPBACK = '127.0.0.1';
const OTLP_PORT = 14318;
const GRAFANA_PORT = 3000;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATA_VOLUME = 'workbench-lgtm-demo-data';
const VERSION_LABEL = 'dev.eigenwise.workbench.version';
const CONFIG_VERSION_LABEL = 'dev.eigenwise.workbench.lgtm-config-version';
const MANAGED_CONFIG_VERSION = '1';
const PROJECT_ACTIVITY_METRIC = 'claude_code_token_usage_tokens_total';
const DEFAULT_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DOCKER_TIMEOUT_MS = 1_500;
const DASHBOARD_READY_TIMEOUT_MS = 15_000;
const DASHBOARD_READY_POLL_MS = 250;

function runDocker(context, args) {
  const docker = context.docker || 'docker';
  const spawn = context.spawnSync || spawnSync;
  try {
    return spawn(docker, args, {
      encoding: 'utf8',
      timeout: DOCKER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
  } catch (error) {
    return { error };
  }
}

function projectActivityStart(context = {}) {
  const now = typeof context.now === 'function' ? context.now() : (context.now ?? Date.now());
  const start = context.activityStart ?? new Date(now - DEFAULT_ACTIVITY_WINDOW_MS).toISOString();
  if (typeof start !== 'string' || !Number.isFinite(Date.parse(start))) {
    throw new Error('activityStart must be an ISO-8601 timestamp.');
  }
  return start;
}

function activeProjectNames(config = {}, context = {}) {
  if (context.activeProjectNames) return new Set(context.activeProjectNames);
  const activityStart = projectActivityStart(context);
  const state = inspect(config, context);
  if (!state?.running) return new Set();
  const runtime = runtimeConfig(config);
  const result = runDocker(context, [
    'exec', runtime.container, 'curl', '--silent', '--show-error', '--fail', '--get',
    '--data-urlencode', `match[]=${PROJECT_ACTIVITY_METRIC}`,
    '--data-urlencode', `start=${activityStart}`,
    'http://127.0.0.1:9090/api/v1/series',
  ]);
  if (result.error || result.status !== 0) {
    throw new Error('Prometheus could not report recently active dashboard projects.');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('Prometheus returned invalid project activity data.');
  }
  if (response.status !== 'success' || !Array.isArray(response.data)) {
    throw new Error('Prometheus returned incomplete project activity data.');
  }
  return new Set(response.data.map(({ project_id: projectName }) => projectName).filter(Boolean));
}

function port(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return resolved;
}

function runtimeConfig(config = {}) {
  const container = config.container || CONTAINER;
  if (!CONTAINER_NAME.test(container)) throw new Error(`Invalid dashboard container name: ${container}`);
  return {
    container,
    grafanaPort: port(config.grafanaPort, GRAFANA_PORT, 'Grafana port'),
    otlpPort: port(config.otlpPort, OTLP_PORT, 'dashboard OTLP port'),
  };
}

function resolve(config = {}) {
  const runtime = runtimeConfig(config);
  const endpoint = `http://${LOOPBACK}:${runtime.otlpPort}`;
  return {
    id: ID,
    egress: 'loopback',
    collectorExporter: {
      endpoint,
      headers: {},
      allowRemote: false,
    },
    outbox: {
      enabled: true,
      endpoint: `${endpoint}/v1/logs`,
      headers: {},
      allowRemote: false,
    },
    visualization: {
      kind: 'grafana',
      url: `http://${LOOPBACK}:${runtime.grafanaPort}`,
      artifact: path.join(__dirname, 'dashboards', 'claude-code-usage.json'),
    },
  };
}

function parseInspection(output) {
  const values = String(output || '').trim().split('|', 7);
  const hasContainerStatus = values.length === 7;
  const [rawStatus, running, image, rawVersion, rawConfigVersion, bindingsJson, mountsJson] = hasContainerStatus
    ? values
    : [null, ...values];
  let bindings = null;
  let mounts = null;
  try { bindings = bindingsJson ? JSON.parse(bindingsJson) : null; } catch {}
  try { mounts = mountsJson ? JSON.parse(mountsJson) : null; } catch {}
  const version = rawVersion && rawVersion !== '<no value>' ? rawVersion : null;
  const configVersion = rawConfigVersion && rawConfigVersion !== '<no value>' ? rawConfigVersion : null;
  const isRunning = running === 'true';
  return {
    status: rawStatus || (isRunning ? 'running' : 'stopped'),
    running: isRunning,
    image: image || null,
    version,
    configVersion,
    bindings,
    mounts,
  };
}

function managedConfigVersion(context = {}) {
  return context.managedConfigVersion || MANAGED_CONFIG_VERSION;
}

function inspect(config = {}, context = {}) {
  const runtime = runtimeConfig(config);
  const format = `{{.State.Status}}|{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels "${VERSION_LABEL}"}}|{{index .Config.Labels "${CONFIG_VERSION_LABEL}"}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}`;
  const result = runDocker(context, ['inspect', '--format', format, runtime.container]);
  if (result.error || result.status !== 0) return null;
  return parseInspection(result.stdout);
}

function status(config = {}, context = {}) {
  const runtime = runtimeConfig(config);
  const state = inspect(config, context);
  return {
    ...runtime,
    containerState: state?.status || 'missing',
    running: Boolean(state?.running),
    portBindingsCurrent: Boolean(state
      && bindingMatches(state.bindings, 3000, runtime.grafanaPort)
      && bindingMatches(state.bindings, 4318, runtime.otlpPort)),
  };
}

function deleteStatus(config = {}, context = {}) {
  const state = inspect(config, context);
  const available = Boolean(state?.running && state.configVersion === managedConfigVersion(context));
  return { running: Boolean(state?.running), deletes: { prometheus: available, loki: available } };
}

function bindingMatches(bindings, containerPort, hostPort) {
  if (!bindings) return true;
  const entries = bindings[`${containerPort}/tcp`];
  return Array.isArray(entries) && entries.some((entry) => entry
    && entry.HostIp === LOOPBACK && Number(entry.HostPort) === hostPort);
}

function dashboardMountMatches(mounts, dashboardDir) {
  const expectedSource = canonicalPath(dashboardDir);
  const target = '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards';
  return Array.isArray(mounts) && mounts.some((mount) => mount
    && mount.Destination === target && typeof mount.Source === 'string'
    && canonicalPath(mount.Source) === expectedSource);
}

function dashboardReadyTimeout(context = {}) {
  const timeout = context.dashboardReadyTimeoutMs ?? DASHBOARD_READY_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 0) throw new Error(`Invalid dashboard readiness timeout: ${timeout}`);
  return timeout;
}

function dashboardReadyPoll(context = {}) {
  const poll = context.dashboardReadyPollMs ?? DASHBOARD_READY_POLL_MS;
  if (!Number.isInteger(poll) || poll < 0) throw new Error(`Invalid dashboard readiness poll interval: ${poll}`);
  return poll;
}

function pause(context, milliseconds) {
  if (typeof context.pause === 'function') {
    context.pause(milliseconds);
    return;
  }
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function dashboardProbe(runtime, context) {
  const result = runDocker(context, [
    'exec', runtime.container, 'curl', '--silent', '--show-error', '--fail',
    '--request', 'POST', '--header', 'Content-Type: application/json',
    '--data', '{"resourceMetrics":[]}', '--output', '/dev/null', '--write-out', '%{http_code}',
    'http://127.0.0.1:4318/v1/metrics',
  ]);
  return !result.error && result.status === 0 && String(result.stdout).trim() === '200';
}

function dashboardFailure(runtime, context, state) {
  const logs = runDocker(context, ['logs', '--tail', '20', runtime.container]);
  const details = logs.error ? logs.error.message : String(logs.stdout || logs.stderr || '').trim();
  const logSummary = details ? `; logs: ${details}` : '';
  throw new Error(`Docker could not start the pinned loopback-only dashboard container (status: ${state?.status || 'missing'}${logSummary}).`);
}

function waitForDashboard(runtime, config, context) {
  const deadline = Date.now() + dashboardReadyTimeout(context);
  let state = inspect(config, context);
  do {
    if (state?.status === 'created') {
      const started = runDocker(context, ['start', runtime.container]);
      if (started.error || started.status !== 0) dashboardFailure(runtime, context, state);
      state = inspect(config, context);
    }
    if (state?.running && dashboardProbe(runtime, context)) return;
    if (Date.now() >= deadline) dashboardFailure(runtime, context, state);
    pause(context, dashboardReadyPoll(context));
    state = inspect(config, context);
  } while (true);
}

function setup(config = {}, context = {}) {
  const dataDir = context.dataDir;
  const dashboardDir = context.dashboardDir || path.join(__dirname, 'dashboards');
  const runtime = runtimeConfig(config);
  const state = inspect(config, context);
  if (state) {
    const current = context.forceRecreate !== true
      && (!state.image || state.image === IMAGE)
      && (!context.pluginVersion || !state.version || state.version === context.pluginVersion)
      && state.configVersion === managedConfigVersion(context)
      && bindingMatches(state.bindings, 3000, runtime.grafanaPort)
      && bindingMatches(state.bindings, 4318, runtime.otlpPort)
      && dashboardMountMatches(state.mounts, dashboardDir);
    if (current && state.running) {
      waitForDashboard(runtime, config, context);
      return { image: IMAGE, dataDir, container: runtime.container, resumed: false };
    }
    if (current) {
      const restarted = runDocker(context, ['start', runtime.container]);
      if (restarted.error || restarted.status !== 0) {
        throw new Error('Docker could not resume the pinned loopback-only dashboard container.');
      }
      waitForDashboard(runtime, config, context);
      return { image: IMAGE, dataDir, container: runtime.container, resumed: true };
    }
    const removed = runDocker(context, ['rm', '--force', runtime.container]);
    if (removed.error || removed.status !== 0) {
      throw new Error('Docker could not replace the stale dashboard container.');
    }
  }

  const provisioningTarget = '/otel-lgtm/grafana/conf/provisioning/dashboards';
  const dashboardsTarget = '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards';
  const provisioningDir = context.provisioningDir || path.join(__dirname, 'provisioning');
  const managedDir = context.managedDir || path.join(__dirname, 'managed');
  const args = [
    'run', '--detach', '--name', runtime.container, '--restart', 'unless-stopped',
    '--publish', `${LOOPBACK}:${runtime.grafanaPort}:3000`, '--publish', `${LOOPBACK}:${runtime.otlpPort}:4318`,
    '--volume', `${DATA_VOLUME}:/data`,
    '--volume', `${path.join(managedDir, 'loki-config.yaml')}:/otel-lgtm/loki-config.yaml:ro`,
    '--volume', `${path.join(managedDir, 'run-prometheus.sh')}:/workbench-managed/run-prometheus.sh:ro`,
    '--volume', `${provisioningDir}:${provisioningTarget}:ro`,
    '--volume', `${dashboardDir}:${dashboardsTarget}:ro`,
  ];
  if (context.pluginVersion) args.push('--label', `${VERSION_LABEL}=${context.pluginVersion}`);
  args.push('--label', `${CONFIG_VERSION_LABEL}=${managedConfigVersion(context)}`);
  args.push(
    '--entrypoint',
    '/bin/bash',
    IMAGE,
    '-c',
    'cp /workbench-managed/run-prometheus.sh /otel-lgtm/run-prometheus.sh && chmod +x /otel-lgtm/run-prometheus.sh && exec /otel-lgtm/run-all.sh',
  );
  const result = runDocker(context, args);
  if (result.error || result.status !== 0) {
    throw new Error('Docker could not start the pinned loopback-only dashboard container.');
  }
  waitForDashboard(runtime, config, context);
  return { image: IMAGE, dataDir, container: runtime.container, resumed: false };
}

function teardown(config = {}, context = {}) {
  const { container } = runtimeConfig(config);
  const inspected = runDocker(context, ['inspect', '--format', '{{.State.Running}}', container]);
  if (inspected.error) return { container, stopped: false, removed: false, dataDeleted: false, unavailable: true };
  if (inspected.status !== 0) {
    if (!context.deleteData) return { container, stopped: false, removed: false, dataDeleted: false };
    const deleted = runDocker(context, ['volume', 'rm', DATA_VOLUME]);
    if (deleted.error) return { container, stopped: false, removed: false, dataDeleted: false, unavailable: true };
    return { container, stopped: false, removed: false, dataDeleted: deleted.status === 0 };
  }
  const running = String(inspected.stdout).trim() === 'true';
  if (running) {
    const stopped = runDocker(context, ['stop', container]);
    if (stopped.error || stopped.status !== 0) throw new Error('Docker could not stop the dashboard container.');
  }
  if (!context.deleteData) return { container, stopped: running, removed: false, dataDeleted: false };
  const removed = runDocker(context, ['rm', '--force', container]);
  if (removed.error || removed.status !== 0) throw new Error('Docker could not remove the dashboard container.');
  const deleted = runDocker(context, ['volume', 'rm', DATA_VOLUME]);
  if (deleted.error || deleted.status !== 0) throw new Error('Docker could not delete the dashboard data volume.');
  return { container, stopped: running, removed: true, dataDeleted: true };
}

module.exports = {
  CONFIG_VERSION_LABEL,
  CONTAINER,
  DATA_VOLUME,
  GRAFANA_PORT,
  ID,
  IMAGE,
  MANAGED_CONFIG_VERSION,
  OTLP_PORT,
  activeProjectNames,
  deleteStatus,
  resolve,
  runtimeConfig,
  setup,
  status,
  teardown,
};
