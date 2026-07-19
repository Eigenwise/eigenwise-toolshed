'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ID = 'grafana-lgtm';
const IMAGE = 'grafana/otel-lgtm:0.11.0';
const CONTAINER = 'workbench-otel-lgtm-demo';
const LOOPBACK = '127.0.0.1';
const OTLP_PORT = 14318;
const GRAFANA_PORT = 3000;
const OTLP_ENDPOINT = `http://${LOOPBACK}:${OTLP_PORT}`;

function resolve() {
  return {
    id: ID,
    egress: 'loopback',
    collectorExporter: {
      endpoint: OTLP_ENDPOINT,
      headers: {},
      allowRemote: false,
    },
    outbox: {
      enabled: true,
      endpoint: `${OTLP_ENDPOINT}/v1/logs`,
      headers: {},
      allowRemote: false,
    },
    visualization: {
      kind: 'grafana',
      url: `http://${LOOPBACK}:${GRAFANA_PORT}`,
      artifact: path.join(__dirname, 'dashboards', 'claude-code-usage.json'),
    },
  };
}

function setup(_config = {}, context = {}) {
  const docker = context.docker || 'docker';
  const spawn = context.spawnSync || spawnSync;
  const dataDir = context.dataDir;
  const inspected = spawn(docker, ['inspect', '--format', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' });
  if (inspected.status === 0 && String(inspected.stdout).trim() === 'true') {
    return { image: IMAGE, dataDir, container: CONTAINER, resumed: false };
  }
  if (inspected.status === 0) {
    const restarted = spawn(docker, ['start', CONTAINER], { encoding: 'utf8' });
    if (restarted.error || restarted.status !== 0) {
      throw new Error('Docker could not resume the pinned loopback-only LGTM container.');
    }
    return { image: IMAGE, dataDir, container: CONTAINER, resumed: true };
  }

  const provisioningTarget = '/otel-lgtm/grafana/conf/provisioning/dashboards';
  const dashboardsTarget = '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards';
  const args = [
    'run', '--detach', '--name', CONTAINER, '--restart', 'unless-stopped',
    '--publish', `${LOOPBACK}:${GRAFANA_PORT}:3000`, '--publish', `${LOOPBACK}:${OTLP_PORT}:4318`,
    '--volume', 'workbench-lgtm-demo-data:/data',
    '--volume', `${path.join(__dirname, 'provisioning')}:${provisioningTarget}:ro`,
    '--volume', `${path.join(__dirname, 'dashboards')}:${dashboardsTarget}:ro`,
    IMAGE,
  ];
  const result = spawn(docker, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Docker could not start the pinned loopback-only LGTM container.');
  }
  return { image: IMAGE, dataDir, container: CONTAINER, resumed: false };
}

function teardown(_config = {}, context = {}) {
  const docker = context.docker || 'docker';
  const spawn = context.spawnSync || spawnSync;
  const inspected = spawn(docker, ['inspect', '--format', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' });
  if (inspected.status !== 0 || String(inspected.stdout).trim() !== 'true') {
    return { container: CONTAINER, stopped: false };
  }
  const stopped = spawn(docker, ['stop', CONTAINER], { encoding: 'utf8' });
  if (stopped.error || stopped.status !== 0) throw new Error('Docker could not stop the LGTM container.');
  return { container: CONTAINER, stopped: true };
}

module.exports = {
  CONTAINER,
  ID,
  IMAGE,
  resolve,
  setup,
  teardown,
};
