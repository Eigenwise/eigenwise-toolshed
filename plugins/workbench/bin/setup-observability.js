#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeCollectorConfig } = require('./install-otel-collector.js');

const MIN_CLAUDE_VERSION = '2.1.212';
const COLLECTOR_VERSION = '0.120.0';
const LGTM_IMAGE = 'grafana/otel-lgtm:0.11.0';
const LOOPBACK = '127.0.0.1';
const OBSERVER_PORT = 14319;
const COLLECTOR_PORT = 4318;
const LGTM_PORT = 14318;
const STATUSLINE_MARKER = 'workbench-statusline.js';
const OBSERVABILITY_ENV = Object.freeze({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://${LOOPBACK}:${COLLECTOR_PORT}`,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://${LOOPBACK}:${COLLECTOR_PORT}/v1/metrics`,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://${LOOPBACK}:${COLLECTOR_PORT}/v1/logs`,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://${LOOPBACK}:${COLLECTOR_PORT}/v1/traces`,
  OTEL_METRICS_INCLUDE_SESSION_ID: 'false',
  OTEL_METRIC_EXPORT_INTERVAL: '1000',
});

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
  try { fs.chmodSync(path.dirname(filePath), 0o700); fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs inherit the current user. */ }
}

function mergeObservabilitySettings(settings, options = {}) {
  const next = structuredClone(settings || {});
  const workbenchRoot = options.workbenchRoot || path.resolve(__dirname, '..');
  const statuslineCommand = `node --no-warnings "${path.join(workbenchRoot, 'bin', 'workbench-statusline.js')}"`;
  const environment = { ...(next.env || {}) };
  const existingStatusLine = next.statusLine;

  if (!String(existingStatusLine?.command || '').includes(STATUSLINE_MARKER)) {
    if (existingStatusLine?.type === 'command' && existingStatusLine.command) {
      environment.WORKBENCH_STATUSLINE_RENDER = existingStatusLine.command;
    }
    next.statusLine = { type: 'command', command: statuslineCommand };
  }

  next.env = { ...environment, ...OBSERVABILITY_ENV };
  return next;
}

function projectSettingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

function applySettings(projectDir, options = {}) {
  const settingsPath = projectSettingsPath(projectDir);
  const before = readJson(settingsPath);
  const after = mergeObservabilitySettings(before, options);
  if (JSON.stringify(before) !== JSON.stringify(after)) writePrivateJson(settingsPath, after);
  return { settingsPath, changed: JSON.stringify(before) !== JSON.stringify(after), settings: after };
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
  const checksumsUrl = options.checksumsUrl || `${archiveUrl.slice(0, archiveUrl.lastIndexOf('/'))}/otelcol-contrib_${COLLECTOR_VERSION}_checksums.txt`;
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
  const result = (options.spawnSync || spawnSync)('tar', ['-xf', archivePath, '-C', collectorDir], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Could not extract the pinned Collector archive.');
  try { fs.unlinkSync(archivePath); } catch { /* The archive is disposable after a verified extraction. */ }
  return resolveCollectorBinary(dataDir, options.environment);
}

function ensureCollectorConfig(dataDir) {
  const configPath = path.join(dataDir, 'otel-collector-config.yaml');
  writeCollectorConfig(configPath, {
    receiverEndpoint: `${LOOPBACK}:${COLLECTOR_PORT}`,
    observerEndpoint: `http://${LOOPBACK}:${OBSERVER_PORT}`,
    queueDirectory: path.join(dataDir, 'collector-queue'),
  });
  return configPath;
}

function verifyCommand(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
  return String(result.stdout || '').trim();
}

function startLgtm(dataDir, options = {}) {
  const docker = options.docker || 'docker';
  const spawn = options.spawnSync || spawnSync;
  const container = 'workbench-otel-lgtm-demo';
  const inspected = spawn(docker, ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
  if (inspected.status === 0 && String(inspected.stdout).trim() === 'true') return { image: LGTM_IMAGE, dataDir, container };
  if (inspected.status === 0) {
    const restarted = spawn(docker, ['start', container], { encoding: 'utf8' });
    if (restarted.error || restarted.status !== 0) throw new Error('Docker could not resume the pinned loopback-only LGTM container.');
    return { image: LGTM_IMAGE, dataDir, container };
  }
  const args = [
    'run', '--detach', '--name', container, '--restart', 'no',
    '--publish', `${LOOPBACK}:3000:3000`, '--publish', `${LOOPBACK}:${LGTM_PORT}:4318`,
    '--volume', 'workbench-lgtm-demo-data:/data', LGTM_IMAGE,
  ];
  const result = spawn(docker, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Docker could not start the pinned loopback-only LGTM container.');
  return { image: LGTM_IMAGE, dataDir, container };
}

function setupPlan(options = {}) {
  const dataDir = options.dataDir || defaultDataDir(options.environment);
  const projectDir = path.resolve(options.projectDir || process.cwd());
  return {
    dataDir,
    projectDir,
    settingsPath: projectSettingsPath(projectDir),
    databaseFile: path.join(dataDir, 'observability.db'),
    collectorConfig: path.join(dataDir, 'otel-collector-config.yaml'),
    collectorBinary: resolveCollectorBinary(dataDir, options.environment),
    lgtm: options.lgtm === true,
  };
}

async function setupObservability(options = {}) {
  const plan = setupPlan(options);
  requireClaudeVersion(options.claudeVersion || verifyCommand(options.claude || 'claude', ['--version'], options.spawnSync));
  if (options.check) return { ...plan, check: true };
  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(plan.dataDir, 0o700); } catch { /* Windows ACLs inherit the current user. */ }
  const collectorConfig = ensureCollectorConfig(plan.dataDir);
  const collectorBinary = fs.existsSync(plan.collectorBinary)
    ? plan.collectorBinary
    : await downloadCollector({ ...options, dataDir: plan.dataDir });
  verifyCommand(collectorBinary, ['--version'], options.spawnSync);
  const settings = applySettings(plan.projectDir, options);
  const lgtm = plan.lgtm ? startLgtm(plan.dataDir, options) : null;
  return { ...plan, collectorConfig, collectorBinary, settings, lgtm };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project' && argv[index + 1]) { options.projectDir = argv[++index]; continue; }
    if (argument === '--lgtm') { options.lgtm = true; continue; }
    if (argument === '--check') { options.check = true; continue; }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await setupObservability(parseArgs(process.argv.slice(2)));
  if (result.check) {
    process.stdout.write(`Ready to set up observability in ${result.projectDir}.\n`);
    return;
  }
  process.stdout.write(`Observability is prepared in ${result.dataDir}.\n`);
  process.stdout.write('Reload plugins once now, then verify: claude --version; curl http://127.0.0.1:14319/health; node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js".\n');
  if (result.lgtm) process.stdout.write('LGTM is available at http://127.0.0.1:3000.\n');
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = {
  COLLECTOR_VERSION,
  LGTM_IMAGE,
  MIN_CLAUDE_VERSION,
  OBSERVABILITY_ENV,
  applySettings,
  collectorArchiveUrl,
  compareVersions,
  defaultDataDir,
  downloadCollector,
  mergeObservabilitySettings,
  parseArgs,
  parseChecksum,
  requireClaudeVersion,
  setupObservability,
  setupPlan,
  startLgtm,
};
