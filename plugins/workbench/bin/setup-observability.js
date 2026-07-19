#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderCollectorYaml } = require('./install-otel-collector.js');
const grafanaLgtm = require('../observability/sinks/grafana/index.js');
const {
  DEFAULT_SINK,
  SINK_IDS,
  defaultConfigPath,
  normalizeObservabilityConfig: normalizeSinkConfig,
  readObservabilityConfig,
  resolveSink,
  setupSink,
  writeObservabilityConfig,
} = require('../observability/sinks/index.js');

const MIN_CLAUDE_VERSION = '2.1.212';
const COLLECTOR_VERSION = '0.120.0';
const LGTM_IMAGE = grafanaLgtm.IMAGE;
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORTS = Object.freeze({ collector: 4318, observer: 14319, dashboard: 3000, dashboardOtlp: 14318 });
const OBSERVER_PORT = DEFAULT_PORTS.observer;
const COLLECTOR_PORT = DEFAULT_PORTS.collector;
const STATUSLINE_MARKER = 'workbench-statusline.js';
const MANAGED_DASHBOARD_CONTAINER = 'workbench-otel-lgtm';

function managedPort(value, fallback, name) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`observability.ports.${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

function normalizeManagedConfig(value = {}, options = {}) {
  const config = normalizeSinkConfig(value, options);
  const input = value?.observability || {};
  const state = config.observability;
  const existingConsent = input.sink !== undefined || input.sinks !== undefined;
  const enabled = state.enabled === undefined ? (options.defaultEnabled ?? existingConsent) : state.enabled;
  if (typeof enabled !== 'boolean') throw new Error('observability.enabled must be a boolean.');
  const dashboard = state.dashboard === undefined ? enabled && state.sink === DEFAULT_SINK : state.dashboard;
  if (typeof dashboard !== 'boolean') throw new Error('observability.dashboard must be a boolean.');
  if (dashboard && state.sink !== DEFAULT_SINK) throw new Error(`observability.dashboard requires the ${DEFAULT_SINK} sink.`);
  const rawPorts = state.ports === undefined ? {} : state.ports;
  if (!rawPorts || typeof rawPorts !== 'object' || Array.isArray(rawPorts)) throw new Error('observability.ports must be a JSON object.');
  const ports = Object.fromEntries(Object.entries(DEFAULT_PORTS).map(([name, fallback]) => [name, managedPort(rawPorts[name], fallback, name)]));
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('observability ports must be distinct.');
  const rawProjects = state.projects === undefined ? [] : state.projects;
  if (!Array.isArray(rawProjects) || rawProjects.some((project) => typeof project !== 'string' || !project.trim())) {
    throw new Error('observability.projects must be an array of project paths.');
  }
  return {
    ...config,
    observability: { ...state, enabled, dashboard, ports, projects: [...new Set(rawProjects)] },
  };
}

function readManagedConfig(filePath) {
  return normalizeManagedConfig(readObservabilityConfig(filePath), {
    defaultEnabled: fs.existsSync(filePath) ? undefined : false,
  });
}

function observabilityEnvironment(ports = DEFAULT_PORTS) {
  const endpoint = `http://${LOOPBACK}:${ports.collector}`;
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_METRICS_INCLUDE_SESSION_ID: 'false',
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
  };
}

const OBSERVABILITY_ENV = Object.freeze(observabilityEnvironment());

function defaultDataDir(environment = process.env) {
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Eigenwise', 'Workbench');
}

function compareVersions(actual, required) {
  const parse = (version) => String(version).match(/\d+/g)?.slice(0, 3).map(Number) || [];
  const left = parse(actual);
  const right = parse(required);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requireClaudeVersion(version) {
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    throw new Error(`Claude Code ${MIN_CLAUDE_VERSION}+ is required for observability; found ${version || 'unknown'}.`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); fs.chmodSync(filePath, 0o600); } catch {}
}

function mergeObservabilitySettings(settings, options = {}) {
  const next = structuredClone(settings || {});
  const workbenchRoot = options.workbenchRoot || path.resolve(__dirname, '..');
  const statuslineCommand = `node --no-warnings "${path.join(workbenchRoot, 'bin', 'workbench-statusline.js')}"`;
  const environment = { ...(next.env || {}) };
  const existingStatusLine = next.statusLine || options.inheritedStatusLine;

  if (!String(existingStatusLine?.command || '').includes(STATUSLINE_MARKER)) {
    if (existingStatusLine?.type === 'command' && existingStatusLine.command) {
      environment.WORKBENCH_STATUSLINE_RENDER = existingStatusLine.command;
    }
    next.statusLine = { type: 'command', command: statuslineCommand };
  }

  next.env = { ...environment, ...observabilityEnvironment(options.ports) };
  return next;
}

function removeObservabilitySettings(settings, options = {}) {
  const next = structuredClone(settings || {});
  const environment = { ...(next.env || {}) };
  const previousStatusline = environment.WORKBENCH_STATUSLINE_RENDER;
  for (const name of [...Object.keys(OBSERVABILITY_ENV), 'WORKBENCH_STATUSLINE_RENDER']) delete environment[name];

  if (String(next.statusLine?.command || '').includes(STATUSLINE_MARKER)) {
    if (previousStatusline && previousStatusline !== options.inheritedStatuslineCommand) {
      next.statusLine = { ...next.statusLine, type: 'command', command: previousStatusline };
    } else {
      delete next.statusLine;
    }
  }
  if (Object.keys(environment).length > 0) next.env = environment;
  else delete next.env;
  return next;
}

function projectSettingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function legacyProjectSettingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

function updateSettingsFile(filePath, transform) {
  if (!fs.existsSync(filePath)) return { changed: false, settings: {} };
  const before = readJson(filePath);
  const after = transform(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writePrivateJson(filePath, after);
  return { changed, settings: after };
}

function applySettings(projectDir, options = {}) {
  const legacy = updateSettingsFile(legacyProjectSettingsPath(projectDir), removeObservabilitySettings);
  const settingsPath = projectSettingsPath(projectDir);
  const before = readJson(settingsPath);
  const after = mergeObservabilitySettings(before, {
    ...options,
    inheritedStatusLine: legacy.settings.statusLine,
  });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writePrivateJson(settingsPath, after);
  return { settingsPath, changed, migratedLegacy: legacy.changed, settings: after };
}

function removeSettings(projectDir) {
  const legacyPath = legacyProjectSettingsPath(projectDir);
  const legacy = { filePath: legacyPath, ...updateSettingsFile(legacyPath, removeObservabilitySettings) };
  const inheritedStatuslineCommand = legacy.settings.statusLine?.command;
  const localPath = projectSettingsPath(projectDir);
  const local = {
    filePath: localPath,
    ...updateSettingsFile(localPath, (settings) => removeObservabilitySettings(settings, { inheritedStatuslineCommand })),
  };
  const results = [local, legacy];
  return { changed: results.some((result) => result.changed), files: results };
}

function collectorArchiveUrl(platform = process.platform, arch = process.arch) {
  const target = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch;
  const archive = `otelcol-contrib_${COLLECTOR_VERSION}_${target}_${cpu}.tar.gz`;
  return `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${COLLECTOR_VERSION}/${archive}`;
}

function collectorBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'otelcol-contrib.exe' : 'otelcol-contrib';
}

function resolveCollectorBinary(dataDir, environment = process.env) {
  return environment.WORKBENCH_OTELCOL_CONTRIB || path.join(dataDir, 'collector', collectorBinaryName());
}

function parseChecksum(text, archiveName) {
  const line = String(text).split(/\r?\n/).find((entry) => entry.includes(archiveName));
  const checksum = line && line.match(/[a-fA-F0-9]{64}/)?.[0];
  if (!checksum) throw new Error(`No SHA-256 checksum found for ${archiveName}.`);
  return checksum.toLowerCase();
}

async function downloadCollector(options) {
  const dataDir = options.dataDir;
  const archiveUrl = options.archiveUrl || collectorArchiveUrl();
  const archiveName = path.basename(archiveUrl);
  const checksumsUrl = options.checksumsUrl || `${archiveUrl.slice(0, archiveUrl.lastIndexOf('/'))}/opentelemetry-collector-releases_otelcol-contrib_checksums.txt`;
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to install the Collector.');
  const [archiveResponse, checksumsResponse] = await Promise.all([fetchImpl(archiveUrl), fetchImpl(checksumsUrl)]);
  if (!archiveResponse.ok || !checksumsResponse.ok) throw new Error('Could not download the pinned Collector archive or its checksums.');
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const expected = parseChecksum(await checksumsResponse.text(), archiveName);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error('Collector archive checksum did not match the pinned release manifest.');
  const archivePath = path.join(dataDir, archiveName);
  const collectorDir = path.join(dataDir, 'collector');
  fs.mkdirSync(collectorDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const systemRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  const systemTar = path.join(systemRoot, 'System32', 'tar.exe');
  const tar = platform === 'win32' && fs.existsSync(systemTar) ? systemTar : 'tar';
  const tarArgs = platform === 'win32' && tar === 'tar'
    ? ['--force-local', '-xf', archivePath, '-C', collectorDir]
    : ['-xf', archivePath, '-C', collectorDir];
  const result = (options.spawnSync || spawnSync)(tar, tarArgs, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Could not extract the pinned Collector archive.');
  try { fs.unlinkSync(archivePath); } catch {}
  return resolveCollectorBinary(dataDir, options.environment);
}

function ensureCollectorConfig(dataDir, sink, ports = DEFAULT_PORTS) {
  const configPath = path.join(dataDir, 'otel-collector-config.yaml');
  const yaml = renderCollectorYaml({
    receiverEndpoint: `${LOOPBACK}:${ports.collector}`,
    observerEndpoint: `http://${LOOPBACK}:${ports.observer}`,
    queueDirectory: path.join(dataDir, 'collector-queue'),
    sinkExporter: sink.collectorExporter,
  });
  let current = null;
  try { current = fs.readFileSync(configPath, 'utf8'); } catch {}
  if (current !== yaml) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, yaml, { encoding: 'utf8', mode: 0o600 });
  }
  return configPath;
}

function verifyCommand(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
  return String(result.stdout || '').trim();
}

function pluginVersion(root = path.resolve(__dirname, '..')) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

function dockerAvailable(options = {}) {
  if (typeof options.dockerAvailable === 'boolean') return options.dockerAvailable;
  const result = (options.spawnSync || spawnSync)(options.docker || 'docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8', timeout: 1500, windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function startLgtm(dataDir, options = {}) {
  return grafanaLgtm.setup({}, { ...options, dataDir });
}

function setupPlan(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const sink = options.sink || ((options.dashboard || options.lgtm) ? DEFAULT_SINK : null);
  return {
    dataDir,
    projectDir,
    settingsPath: projectSettingsPath(projectDir),
    databaseFile: path.join(dataDir, 'observability.db'),
    collectorConfig: path.join(dataDir, 'otel-collector-config.yaml'),
    collectorBinary: resolveCollectorBinary(dataDir, options.environment),
    observabilityConfig: defaultConfigPath(dataDir),
    sink,
    lgtm: sink === DEFAULT_SINK,
  };
}

function configuredSink(plan, options = {}) {
  const configExists = options.config !== undefined || fs.existsSync(plan.observabilityConfig);
  const existing = options.config
    ? normalizeManagedConfig(options.config)
    : readManagedConfig(plan.observabilityConfig);
  const requestedDashboard = options.dashboard === undefined
    ? (options.lgtm ? true : undefined)
    : options.dashboard;

  if (options.disable) {
    return normalizeManagedConfig({
      ...existing,
      observability: {
        ...existing.observability,
        enabled: false,
        dashboard: false,
        projects: [],
      },
    });
  }

  let sink = options.sink;
  if (!sink && requestedDashboard === true) sink = DEFAULT_SINK;
  if (!sink && requestedDashboard === false && existing.observability.sink === DEFAULT_SINK) sink = 'none';
  if (!sink) sink = configExists && existing.observability.enabled
    ? existing.observability.sink
    : (options.defaultDashboard ? DEFAULT_SINK : 'none');

  let dashboard = requestedDashboard;
  if (dashboard === undefined && options.sink) dashboard = sink === DEFAULT_SINK;
  if (dashboard === undefined && configExists && existing.observability.enabled) dashboard = existing.observability.dashboard;
  if (dashboard === undefined) dashboard = Boolean(options.defaultDashboard);
  if (dashboard && sink !== DEFAULT_SINK) throw new Error(`--dashboard cannot be combined with --sink ${sink}.`);
  if (!dashboard && sink === DEFAULT_SINK) throw new Error(`--sink ${DEFAULT_SINK} requires --dashboard.`);

  const ports = { ...existing.observability.ports, ...(options.ports || {}) };
  const currentSettings = existing.observability.sinks[sink] || {};
  const sinkSettings = { ...currentSettings, ...(options.sinkSettings || {}) };
  if (options.sinkEndpoint !== undefined) {
    if (sink !== 'otlp') throw new Error('--sink-endpoint is only valid with --sink otlp.');
    sinkSettings.endpoint = options.sinkEndpoint;
  }
  const sinks = { ...existing.observability.sinks, [sink]: sinkSettings };
  if (dashboard) {
    sinks[DEFAULT_SINK] = {
      ...(existing.observability.sinks[DEFAULT_SINK] || {}),
      ...(sink === DEFAULT_SINK ? sinkSettings : {}),
      container: MANAGED_DASHBOARD_CONTAINER,
      grafanaPort: ports.dashboard,
      otlpPort: ports.dashboardOtlp,
    };
  }

  return normalizeManagedConfig({
    ...existing,
    observability: {
      ...existing.observability,
      enabled: true,
      sink,
      dashboard,
      ports,
      projects: [...new Set([...existing.observability.projects, plan.projectDir])],
      sinks,
    },
  });
}

function configurationSummary(config) {
  const state = config.observability;
  return {
    enabled: state.enabled,
    sink: state.sink,
    dashboard: state.dashboard,
    ports: state.ports,
  };
}

function configurationChanges(before, after) {
  const previous = configurationSummary(before);
  const next = configurationSummary(after);
  const changes = [];
  for (const key of ['enabled', 'sink', 'dashboard', 'ports']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes.push({ key, from: previous[key], to: next[key] });
  }
  return changes;
}

function deleteLocalObservabilityData(dataDir) {
  const files = [
    'observability.db', 'observability.db-shm', 'observability.db-wal', 'hook-spool.jsonl',
    'observer.log', 'collector.log', 'observer.pid', 'collector.pid', 'observer.pid.json', 'collector.pid.json',
  ];
  for (const name of files) {
    try { fs.rmSync(path.join(dataDir, name), { force: true }); } catch {}
  }
  try { fs.rmSync(path.join(dataDir, 'collector-queue'), { recursive: true, force: true }); } catch {}
}

async function setupObservability(options = {}) {
  const plan = setupPlan(options);
  const before = readManagedConfig(plan.observabilityConfig);
  const dashboardRelevant = !options.disable && options.dashboard !== false
    && (!options.sink || options.sink === DEFAULT_SINK);
  const available = dashboardRelevant ? dockerAvailable(options) : false;
  const config = configuredSink(plan, { ...options, defaultDashboard: available });
  const changes = configurationChanges(before, config);
  if (options.check) return { ...plan, check: true, before, config, changes, dockerAvailable: available };

  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(plan.dataDir, 0o700); } catch {}

  const ensureModule = options.ensureModule || require('../lib/observability/ensure.js');
  if (!config.observability.enabled) {
    await ensureModule.teardownRuntime(before, { ...options, dataDir: plan.dataDir });
    let dashboard = null;
    if (before.observability.dashboard) {
      dashboard = grafanaLgtm.teardown(before.observability.sinks[DEFAULT_SINK] || {}, {
        ...options,
        dataDir: plan.dataDir,
        deleteData: options.deleteData,
      });
    }
    const projects = [...new Set([...before.observability.projects, plan.projectDir])];
    const projectSettings = projects.map((projectDir) => ({ projectDir, ...removeSettings(projectDir) }));
    const settings = { changed: projectSettings.some((result) => result.changed), projects: projectSettings };
    if (options.deleteData) deleteLocalObservabilityData(plan.dataDir);
    writeObservabilityConfig(plan.observabilityConfig, config);
    const localDataDeleted = Boolean(options.deleteData);
    const dataDeleted = localDataDeleted && (!before.observability.dashboard || dashboard?.dataDeleted === true);
    return { ...plan, before, config, changes, disabled: true, settings, dashboard, localDataDeleted, dataDeleted };
  }

  requireClaudeVersion(options.claudeVersion || verifyCommand(options.claude || 'claude', ['--version'], options.spawnSync));
  const sinkRuntime = resolveSink(config);
  const collectorConfig = ensureCollectorConfig(plan.dataDir, sinkRuntime, config.observability.ports);
  const collectorBinary = fs.existsSync(plan.collectorBinary)
    ? plan.collectorBinary
    : await downloadCollector({ ...options, dataDir: plan.dataDir });
  verifyCommand(collectorBinary, ['--version'], options.spawnSync);

  const version = pluginVersion(options.pluginRoot);
  let dashboard = null;
  let dashboardSkipped = false;
  let sinkSetup = null;
  if (config.observability.dashboard) {
    if (available) {
      dashboard = grafanaLgtm.setup(config.observability.sinks[DEFAULT_SINK], {
        ...options,
        dataDir: plan.dataDir,
        pluginVersion: version,
        forceRecreate: Boolean(config.observability.dashboardVersion
          && config.observability.dashboardVersion !== version),
      });
      sinkSetup = dashboard;
    } else {
      dashboardSkipped = true;
    }
  } else {
    sinkSetup = setupSink(config, { ...options, dataDir: plan.dataDir, pluginVersion: version }).setup;
    if (before.observability.dashboard) {
      dashboard = grafanaLgtm.teardown(before.observability.sinks[DEFAULT_SINK] || {}, { ...options, dataDir: plan.dataDir });
    }
  }

  const settings = applySettings(plan.projectDir, { ...options, ports: config.observability.ports });
  const managedConfig = normalizeManagedConfig({
    ...config,
    observability: {
      ...config.observability,
      managedVersion: version,
      collectorVersion: COLLECTOR_VERSION,
      dashboardVersion: dashboard && config.observability.dashboard ? version : config.observability.dashboardVersion,
    },
  });
  writeObservabilityConfig(plan.observabilityConfig, managedConfig);
  if (changes.length > 0 && before.observability.enabled) {
    await ensureModule.teardownRuntime(before, { ...options, dataDir: plan.dataDir });
  }
  const runtime = await (options.ensure || ensureModule.ensureObservability)({
    ...options,
    dataDir: plan.dataDir,
    configFile: plan.observabilityConfig,
    pluginRoot: options.pluginRoot || path.resolve(__dirname, '..'),
  });
  const sink = resolveSink(managedConfig);
  return {
    ...plan,
    collectorConfig,
    collectorBinary,
    settings,
    before,
    config: managedConfig,
    changes,
    sink: { ...sink, setup: sinkSetup },
    lgtm: dashboard,
    dashboard,
    dashboardSkipped,
    dockerAvailable: available,
    runtime,
  };
}

function parsePort(argument, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${argument}: ${value}`);
  return port;
}

function parseArgs(argv) {
  const options = { ports: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--project' && next) { options.projectDir = argv[++index]; continue; }
    if (argument === '--sink' && next) { options.sink = argv[++index]; continue; }
    if (argument === '--sink-endpoint' && next) { options.sinkEndpoint = argv[++index]; continue; }
    if (argument === '--dashboard') { options.dashboard = true; continue; }
    if (argument === '--no-dashboard') { options.dashboard = false; continue; }
    if (argument === '--lgtm') { options.dashboard = true; options.lgtm = true; continue; }
    if (argument === '--observer-port' && next) { options.ports.observer = parsePort(argument, argv[++index]); continue; }
    if (argument === '--collector-port' && next) { options.ports.collector = parsePort(argument, argv[++index]); continue; }
    if (argument === '--dashboard-port' && next) { options.ports.dashboard = parsePort(argument, argv[++index]); continue; }
    if (argument === '--dashboard-otlp-port' && next) { options.ports.dashboardOtlp = parsePort(argument, argv[++index]); continue; }
    if (argument === '--disable') { options.disable = true; continue; }
    if (argument === '--delete-data') { options.deleteData = true; continue; }
    if (argument === '--check') { options.check = true; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (Object.keys(options.ports).length === 0) delete options.ports;
  if (options.sink && !SINK_IDS.includes(options.sink)) {
    throw new Error(`Unknown observability sink ${JSON.stringify(options.sink)}; expected one of ${SINK_IDS.join(', ')}.`);
  }
  if (options.dashboard && options.sink && options.sink !== DEFAULT_SINK) {
    throw new Error(`--dashboard cannot be combined with --sink ${options.sink}.`);
  }
  if (options.dashboard === false && options.sink === DEFAULT_SINK) {
    throw new Error(`--sink ${DEFAULT_SINK} requires --dashboard.`);
  }
  if (options.deleteData && !options.disable) throw new Error('--delete-data requires --disable.');
  return options;
}

function verificationGuidance(ports = DEFAULT_PORTS) {
  const tokenUsageReport = path.join(__dirname, 'token-usage-report.js');
  return `Reload plugins once now, then verify: claude --version; curl http://${LOOPBACK}:${ports.observer}/health; node "${tokenUsageReport}".\n`;
}

function describeChange(change) {
  return `${change.key}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`;
}

async function main() {
  const result = await setupObservability(parseArgs(process.argv.slice(2)));
  if (result.check) {
    process.stdout.write(`Current observability: ${JSON.stringify(configurationSummary(result.before))}.\n`);
    process.stdout.write(`Planned observability: ${JSON.stringify(configurationSummary(result.config))}.\n`);
    process.stdout.write(result.changes.length > 0
      ? `Changes: ${result.changes.map(describeChange).join('; ')}.\n`
      : 'Changes: none.\n');
    if (result.config.observability.dashboard && !result.dockerAvailable) {
      process.stdout.write('Dashboard skipped: Docker is unavailable; SQLite observability will keep running.\n');
    }
    return;
  }
  if (result.disabled) {
    if (result.localDataDeleted && !result.dataDeleted) {
      process.stdout.write('Observability is disabled. Local data was deleted; dashboard data could not be deleted.\n');
    } else {
      process.stdout.write(`Observability is disabled. Data was ${result.dataDeleted ? 'deleted' : 'kept'}.\n`);
    }
    return;
  }
  process.stdout.write(`Observability is prepared in ${result.dataDir}.\n`);
  process.stdout.write(`Downstream sink: ${result.sink.id}.\n`);
  process.stdout.write(verificationGuidance(result.config.observability.ports));
  if (result.dashboardSkipped) {
    process.stdout.write('Dashboard skipped: Docker is unavailable; SQLite observability will keep running.\n');
  } else if (result.sink.visualization) {
    process.stdout.write(`Grafana is available at ${result.sink.visualization.url}.\n`);
  }
}

module.exports = {
  COLLECTOR_VERSION,
  DEFAULT_PORTS,
  LGTM_IMAGE,
  MANAGED_DASHBOARD_CONTAINER,
  MIN_CLAUDE_VERSION,
  OBSERVABILITY_ENV,
  applySettings,
  collectorArchiveUrl,
  collectorBinaryName,
  compareVersions,
  configurationChanges,
  configurationSummary,
  configuredSink,
  defaultDataDir,
  deleteLocalObservabilityData,
  dockerAvailable,
  downloadCollector,
  ensureCollectorConfig,
  mergeObservabilitySettings,
  normalizeManagedConfig,
  observabilityEnvironment,
  parseArgs,
  parseChecksum,
  pluginVersion,
  removeObservabilitySettings,
  removeSettings,
  requireClaudeVersion,
  resolveCollectorBinary,
  setupObservability,
  setupPlan,
  startLgtm,
  verificationGuidance,
  verifyCommand,
};

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
