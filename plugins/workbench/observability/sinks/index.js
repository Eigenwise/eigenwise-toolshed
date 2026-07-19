'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grafanaLgtm = require('./grafana/index.js');
const none = require('./none/index.js');
const otlp = require('./otlp/index.js');
const posthog = require('./posthog/index.js');

const DEFAULT_SINK = 'grafana-lgtm';
const PROVIDERS = Object.freeze(Object.fromEntries([
  grafanaLgtm,
  otlp,
  posthog,
  none,
].map((provider) => [provider.ID, provider])));
const SINK_IDS = Object.freeze(Object.keys(PROVIDERS));

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultDataDir(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench');
}

function defaultConfigPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, 'observability.json');
}

function normalizeObservabilityConfig(value = {}, options = {}) {
  if (!record(value)) throw new Error('Observability config must be a JSON object.');
  const current = value.observability === undefined ? {} : value.observability;
  if (!record(current)) throw new Error('observability must be a JSON object.');
  const sink = current.sink === undefined ? (options.defaultSink ?? DEFAULT_SINK) : current.sink;
  if (!Object.hasOwn(PROVIDERS, sink)) {
    throw new Error(`Unknown observability sink ${JSON.stringify(sink)}; expected one of ${SINK_IDS.join(', ')}.`);
  }
  const sinks = current.sinks === undefined ? {} : current.sinks;
  if (!record(sinks)) throw new Error('observability.sinks must be a JSON object.');
  for (const [id, config] of Object.entries(sinks)) {
    if (!record(config)) throw new Error(`observability.sinks.${id} must be a JSON object.`);
  }
  return {
    ...structuredClone(value),
    observability: {
      ...structuredClone(current),
      sink,
      sinks: structuredClone(sinks),
    },
  };
}

function readObservabilityConfig(filePath = defaultConfigPath(), options = {}) {
  try {
    return normalizeObservabilityConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), options);
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeObservabilityConfig({}, options);
    if (error instanceof SyntaxError) throw new Error(`Could not parse ${filePath}: ${error.message}`);
    throw error;
  }
}

function writeObservabilityConfig(filePath, value, options = {}) {
  const config = normalizeObservabilityConfig(value, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return config;
}

function providerConfig(config, id) {
  return config.observability.sinks[id] || {};
}

function resolveSink(value, context = {}) {
  const config = normalizeObservabilityConfig(value, context);
  const id = config.observability.sink;
  const provider = PROVIDERS[id];
  const runtime = provider.resolve(providerConfig(config, id), context);
  const validCollectorExporter = runtime?.collectorExporter === null || record(runtime?.collectorExporter);
  if (!record(runtime) || runtime.id !== id || !validCollectorExporter
    || !record(runtime.outbox) || typeof runtime.outbox.enabled !== 'boolean') {
    throw new Error(`Observability sink provider ${id} returned an invalid runtime contract.`);
  }
  return runtime;
}

function setupSink(value, context = {}) {
  const config = normalizeObservabilityConfig(value, context);
  const id = config.observability.sink;
  const runtime = resolveSink(config, context);
  const setup = PROVIDERS[id].setup(providerConfig(config, id), context);
  return { ...runtime, setup };
}

function teardownSink(value, context = {}) {
  const config = normalizeObservabilityConfig(value, context);
  const id = config.observability.sink;
  return PROVIDERS[id].teardown(providerConfig(config, id), context);
}

module.exports = {
  DEFAULT_SINK,
  PROVIDERS,
  SINK_IDS,
  defaultConfigPath,
  defaultDataDir,
  normalizeObservabilityConfig,
  readObservabilityConfig,
  resolveSink,
  setupSink,
  teardownSink,
  writeObservabilityConfig,
};
