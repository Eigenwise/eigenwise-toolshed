'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ID = 'grafana-lgtm';
const IMAGE = 'grafana/otel-lgtm:0.11.0';
const CONTAINER = 'workbench-otel-lgtm-demo';
const LOOPBACK = '127.0.0.1';
const OTLP_PORT = 14318;
const GRAFANA_PORT = 3000;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATA_VOLUME = 'workbench-lgtm-demo-data';
const VERSION_LABEL = 'dev.eigenwise.workbench.version';

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
  const [running, image, rawVersion, bindingsJson] = String(output || '').trim().split('|', 4);
  let bindings = null;
  try { bindings = bindingsJson ? JSON.parse(bindingsJson) : null; } catch {}
  const version = rawVersion && rawVersion !== '<no value>' ? rawVersion : null;
  return { running: running === 'true', image: image || null, version, bindings };
}

function bindingMatches(bindings, containerPort, hostPort) {
  if (!bindings) return true;
  const entries = bindings[`${containerPort}/tcp`];
  return Array.isArray(entries) && entries.some((entry) => entry
    && entry.HostIp === LOOPBACK && Number(entry.HostPort) === hostPort);
}

function setup(config = {}, context = {}) {
  const docker = context.docker || 'docker';
  const spawn = context.spawnSync || spawnSync;
  const dataDir = context.dataDir;
  const runtime = runtimeConfig(config);
  const format = `{{.State.Running}}|{{.Config.Image}}|{{index .Config.Labels "${VERSION_LABEL}"}}|{{json .HostConfig.PortBindings}}`;
  const inspected = spawn(docker, ['inspect', '--format', format, runtime.container], { encoding: 'utf8' });
  if (inspected.status === 0) {
    const state = parseInspection(inspected.stdout);
    const current = context.forceRecreate !== true
      && (!state.image || state.image === IMAGE)
      && (!context.pluginVersion || !state.version || state.version === context.pluginVersion)
      && bindingMatches(state.bindings, 3000, runtime.grafanaPort)
      && bindingMatches(state.bindings, 4318, runtime.otlpPort);
    if (current && state.running) {
      return { image: IMAGE, dataDir, container: runtime.container, resumed: false };
    }
    if (current) {
      const restarted = spawn(docker, ['start', runtime.container], { encoding: 'utf8' });
      if (restarted.error || restarted.status !== 0) {
        throw new Error('Docker could not resume the pinned loopback-only dashboard container.');
      }
      return { image: IMAGE, dataDir, container: runtime.container, resumed: true };
    }
    const removed = spawn(docker, ['rm', '--force', runtime.container], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0) {
      throw new Error('Docker could not replace the stale dashboard container.');
    }
  }

  const provisioningTarget = '/otel-lgtm/grafana/conf/provisioning/dashboards';
  const dashboardsTarget = '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards';
  const args = [
    'run', '--detach', '--name', runtime.container, '--restart', 'unless-stopped',
    '--publish', `${LOOPBACK}:${runtime.grafanaPort}:3000`, '--publish', `${LOOPBACK}:${runtime.otlpPort}:4318`,
    '--volume', `${DATA_VOLUME}:/data`,
    '--volume', `${path.join(__dirname, 'provisioning')}:${provisioningTarget}:ro`,
    '--volume', `${path.join(__dirname, 'dashboards')}:${dashboardsTarget}:ro`,
  ];
  if (context.pluginVersion) args.push('--label', `${VERSION_LABEL}=${context.pluginVersion}`);
  args.push(IMAGE);
  const result = spawn(docker, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Docker could not start the pinned loopback-only dashboard container.');
  }
  return { image: IMAGE, dataDir, container: runtime.container, resumed: false };
}

function teardown(config = {}, context = {}) {
  const docker = context.docker || 'docker';
  const spawn = context.spawnSync || spawnSync;
  const { container } = runtimeConfig(config);
  const inspected = spawn(docker, ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
  if (inspected.error) return { container, stopped: false, removed: false, dataDeleted: false, unavailable: true };
  if (inspected.status !== 0) {
    if (!context.deleteData) return { container, stopped: false, removed: false, dataDeleted: false };
    const deleted = spawn(docker, ['volume', 'rm', DATA_VOLUME], { encoding: 'utf8' });
    if (deleted.error) return { container, stopped: false, removed: false, dataDeleted: false, unavailable: true };
    return { container, stopped: false, removed: false, dataDeleted: deleted.status === 0 };
  }
  const running = String(inspected.stdout).trim() === 'true';
  if (running) {
    const stopped = spawn(docker, ['stop', container], { encoding: 'utf8' });
    if (stopped.error || stopped.status !== 0) throw new Error('Docker could not stop the dashboard container.');
  }
  if (!context.deleteData) return { container, stopped: running, removed: false, dataDeleted: false };
  const removed = spawn(docker, ['rm', '--force', container], { encoding: 'utf8' });
  if (removed.error || removed.status !== 0) throw new Error('Docker could not remove the dashboard container.');
  const deleted = spawn(docker, ['volume', 'rm', DATA_VOLUME], { encoding: 'utf8' });
  if (deleted.error || deleted.status !== 0) throw new Error('Docker could not delete the dashboard data volume.');
  return { container, stopped: running, removed: true, dataDeleted: true };
}

module.exports = {
  CONTAINER,
  DATA_VOLUME,
  GRAFANA_PORT,
  ID,
  IMAGE,
  OTLP_PORT,
  resolve,
  runtimeConfig,
  setup,
  teardown,
};
