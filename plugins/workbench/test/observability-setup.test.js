'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  COLLECTOR_VERSION,
  LGTM_IMAGE,
  MANAGED_DASHBOARD_CONTAINER,
  MIN_CLAUDE_VERSION,
  OBSERVABILITY_ENV,
  applySettings,
  collectorArchiveUrl,
  compareVersions,
  configuredSink,
  downloadCollector,
  mergeObservabilitySettings,
  parseArgs,
  parseChecksum,
  removeObservabilitySettings,
  removeSettings,
  requireClaudeVersion,
  setupObservability,
  setupPlan,
  startLgtm,
  verificationGuidance,
} = require('../bin/setup-observability.js');

const GRAFANA_SINK_DIR = path.join(path.resolve(__dirname, '..'), 'observability', 'sinks', 'grafana');

test('bundles a valid Grafana provider for the Claude Code Usage dashboard', () => {
  const provisioning = fs.readFileSync(path.join(GRAFANA_SINK_DIR, 'provisioning', 'workbench.yaml'), 'utf8');
  const dashboard = JSON.parse(fs.readFileSync(path.join(GRAFANA_SINK_DIR, 'dashboards', 'claude-code-usage.json'), 'utf8'));

  assert.match(provisioning, /^apiVersion: 1$/m);
  assert.match(provisioning, /^providers:$/m);
  assert.match(provisioning, /^    type: file$/m);
  assert.match(provisioning, /^      path: \/otel-lgtm\/grafana\/conf\/provisioning\/workbench-dashboards$/m);
  assert.equal(dashboard.uid, 'claude-code-usage');
  assert.equal(dashboard.title, 'Claude Code Usage');
  assert.match(JSON.stringify(dashboard), /project_id/);
  assert.doesNotMatch(JSON.stringify(dashboard), /target_info|group_left/);
});

test('requires Claude Code v2.1.212 or newer', () => {
  assert.equal(compareVersions('2.1.212', MIN_CLAUDE_VERSION), 0);
  assert.equal(compareVersions('2.1.213', MIN_CLAUDE_VERSION), 1);
  assert.equal(compareVersions('2.1.211', MIN_CLAUDE_VERSION), -1);
  assert.throws(() => requireClaudeVersion('2.1.211'), /2\.1\.212\+/);
});

test('prints copy-pasteable observer verification guidance', () => {
  const reportPath = path.join(path.resolve(__dirname, '..'), 'bin', 'token-usage-report.js');
  assert.equal(
    verificationGuidance(),
    `Reload plugins once now, then verify: claude --version; curl http://127.0.0.1:14319/health; node "${reportPath}".\n`,
  );
});

test('merges safe local OTLP settings without replacing an existing status line', () => {
  const settings = mergeObservabilitySettings({
    env: { KEEP_ME: 'yes' },
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    statusLine: { type: 'command', command: 'node custom-statusline.js', padding: 2 },
  }, { workbenchRoot: 'C:/Workbench' });

  assert.equal(settings.env.KEEP_ME, 'yes');
  assert.equal(settings.env.WORKBENCH_STATUSLINE_RENDER, undefined);
  assert.deepEqual(Object.fromEntries(Object.entries(settings.env).filter(([key]) => key in OBSERVABILITY_ENV)), OBSERVABILITY_ENV);
  assert.equal(settings.statusLine.command, 'node custom-statusline.js');
  assert.deepEqual(settings.hooks, { SessionEnd: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] });
});

test('does not replace a Workbench status line on repeat setup', () => {
  const settings = mergeObservabilitySettings({
    env: { WORKBENCH_STATUSLINE_RENDER: 'existing renderer' },
    statusLine: { type: 'command', command: 'node workbench-statusline.js', padding: 3 },
  });

  assert.equal(settings.statusLine.padding, 3);
  assert.equal(settings.env.WORKBENCH_STATUSLINE_RENDER, 'existing renderer');
});

test('preserves existing project settings when applying the setup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observability-'));
  try {
    const claudeDir = path.join(directory, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Read'] },
      statusLine: { type: 'command', command: 'node inherited-statusline.js' },
    }));
    const result = applySettings(directory, { workbenchRoot: 'C:/Workbench' });
    const projectSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.equal(projectSettings.permissions.allow[0], 'Read');
    assert.equal(projectSettings.statusLine.command, 'node inherited-statusline.js');
    assert.match(result.settingsPath, /settings\.local\.json$/);
    assert.equal(result.settings.statusLine, undefined);
    assert.equal(result.settings.env.WORKBENCH_STATUSLINE_RENDER, undefined);
    removeSettings(directory);
    const cleanedLocal = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    assert.equal(cleanedLocal.statusLine, undefined);
    assert.equal(projectSettings.statusLine.command, 'node inherited-statusline.js');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installs a stable status line shim when none is configured', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-statusline-shim-'));
  try {
    const result = applySettings(path.join(directory, 'project'), { home: directory });
    const shimPath = path.join(directory, '.claude', 'workbench-statusline.js');

    assert.equal(result.settings.statusLine.command, `node --no-warnings "${shimPath}"`);
    assert.match(fs.readFileSync(shimPath, 'utf8'), /installed_plugins\.json/);
    assert.doesNotMatch(result.settings.statusLine.command, /plugins[\\/]cache/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('leaves an existing user status line untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-user-statusline-'));
  try {
    const projectDir = path.join(directory, 'project');
    const userSettings = path.join(directory, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings, JSON.stringify({ statusLine: { type: 'command', command: 'node user-statusline.js' } }));

    const result = applySettings(projectDir, { home: directory });
    const projectSettings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    const savedUserSettings = JSON.parse(fs.readFileSync(userSettings, 'utf8'));

    assert.equal(savedUserSettings.statusLine.command, 'node user-statusline.js');
    assert.equal(projectSettings.statusLine, undefined);
    assert.equal(result.statusLine.existing, 'node user-statusline.js');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uses a pinned platform collector archive and verifies release checksums', () => {
  assert.match(collectorArchiveUrl('win32', 'x64'), new RegExp(`v${COLLECTOR_VERSION}/otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64\\.tar\\.gz$`));
  const checksum = 'a'.repeat(64);
  assert.equal(parseChecksum(`${checksum}  otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64.tar.gz`, `otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64.tar.gz`), checksum);
  assert.throws(() => parseChecksum('', 'missing.tar.gz'), /No SHA-256/);
});

test('downloads the pinned archive with the release checksums manifest and Windows-local tar paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-collector-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archive = Buffer.from('verified collector archive');
  const checksum = require('node:crypto').createHash('sha256').update(archive).digest('hex');
  const urls = [];
  const calls = [];

  await downloadCollector({
    dataDir: directory,
    platform: 'win32',
    environment: { SystemRoot: path.join(directory, 'missing-windows') },
    fetch: async (url) => {
      urls.push(url);
      return url.endsWith('_checksums.txt')
        ? { ok: true, text: async () => `${checksum}  otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64.tar.gz` }
        : { ok: true, arrayBuffer: async () => archive };
    },
    spawnSync(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
  });

  assert.match(urls[1], /opentelemetry-collector-releases_otelcol-contrib_checksums\.txt$/);
  assert.equal(calls[0][0], 'tar');
  assert.equal(calls[0][1][0], '--force-local');
});

test('plans current-user application data and only starts LGTM on request', () => {
  const plan = setupPlan({ projectDir: '.', environment: { LOCALAPPDATA: 'C:/Users/example/AppData/Local' } });
  assert.match(plan.dataDir, /Eigenwise[\\/]Workbench$/);
  assert.equal(plan.lgtm, false);
  const calls = [];
  const lgtm = startLgtm(plan.dataDir, { spawnSync(command, args) {
    calls.push([command, args]);
    return args[0] === 'inspect' ? { status: 1, stdout: '' } : { status: 0, stdout: 'container' };
  } });
  assert.equal(lgtm.image, LGTM_IMAGE);
  const runArgs = calls[1][1];
  assert.deepEqual(runArgs.filter((argument) => argument.startsWith('127.0.0.1:')), ['127.0.0.1:3000:3000', '127.0.0.1:14318:4318']);
  assert.equal(runArgs[runArgs.indexOf('--restart') + 1], 'unless-stopped');
  assert.ok(runArgs.includes(`${path.join(GRAFANA_SINK_DIR, 'provisioning')}:/otel-lgtm/grafana/conf/provisioning/dashboards:ro`));
  assert.ok(runArgs.includes(`${path.join(GRAFANA_SINK_DIR, 'dashboards')}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards:ro`));
  const resumed = [];
  startLgtm(plan.dataDir, { spawnSync(command, args) { resumed.push([command, args]); return { status: 0, stdout: 'true' }; } });
  assert.equal(resumed.length, 1);
});

test('stores sink selection separately from project settings', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-sink-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, 'project');
  const dataDir = path.join(directory, 'application-data');
  fs.mkdirSync(projectDir, { recursive: true });

  const result = await setupObservability({
    projectDir,
    dataDir,
    sink: 'none',
    claudeVersion: MIN_CLAUDE_VERSION,
    environment: { WORKBENCH_OTELCOL_CONTRIB: process.execPath },
    spawnSync: () => ({ status: 0, stdout: process.version }),
    ensure: async () => ({ enabled: true, started: [] }),
  });

  const config = JSON.parse(fs.readFileSync(result.observabilityConfig, 'utf8'));
  assert.equal(config.observability.sink, 'none');
  assert.equal(result.sink.id, 'none');
  assert.equal(result.sink.outbox.enabled, false);
  assert.doesNotMatch(fs.readFileSync(result.collectorConfig, 'utf8'), /otlphttp\/sink/);
  assert.equal(Object.hasOwn(result.settings.settings.env, 'WORKBENCH_OBSERVABILITY_SINK'), false);
});

test('configures generic OTLP from the private sink config and parses explicit CLI selection', () => {
  const plan = setupPlan({ dataDir: 'C:/Workbench', projectDir: '.' });
  const config = configuredSink(plan, {
    sink: 'otlp',
    sinkEndpoint: 'https://otlp.example.test',
    config: {
      observability: {
        sinks: { otlp: { headers: { Authorization: 'Bearer private' } } },
      },
    },
  });

  assert.equal(config.observability.sink, 'otlp');
  assert.equal(config.observability.sinks.otlp.endpoint, 'https://otlp.example.test');
  assert.equal(config.observability.sinks.otlp.headers.Authorization, 'Bearer private');
  assert.deepEqual(parseArgs(['--sink', 'otlp', '--sink-endpoint', 'https://otlp.example.test']), {
    sink: 'otlp',
    sinkEndpoint: 'https://otlp.example.test',
  });
  assert.throws(() => parseArgs(['--sink', 'unknown']), /Unknown observability sink/);
});

test('uses dashboard language, keeps the lgtm alias, and defaults bare setup from Docker', () => {
  assert.deepEqual(parseArgs(['--dashboard']), { dashboard: true });
  assert.deepEqual(parseArgs(['--lgtm']), { dashboard: true, lgtm: true });
  assert.deepEqual(parseArgs([]), {});
  const plan = setupPlan({ dataDir: 'C:/Workbench', projectDir: '.' });
  const dashboard = configuredSink(plan, { config: {}, defaultDashboard: true });
  assert.equal(dashboard.observability.enabled, true);
  assert.equal(dashboard.observability.dashboard, true);
  assert.equal(dashboard.observability.sink, 'grafana-lgtm');
  assert.equal(dashboard.observability.sinks['grafana-lgtm'].container, MANAGED_DASHBOARD_CONTAINER);
  const withoutDocker = configuredSink(plan, { config: {}, defaultDashboard: false });
  assert.equal(withoutDocker.observability.enabled, true);
  assert.equal(withoutDocker.observability.dashboard, false);
  assert.equal(withoutDocker.observability.sink, 'none');

  const disabledDashboard = configuredSink(plan, { config: dashboard, dashboard: false });
  assert.equal(disabledDashboard.observability.dashboard, false);
  assert.equal(disabledDashboard.observability.sink, 'none');
  assert.throws(() => parseArgs(['--dashboard', '--sink', 'otlp']), /cannot be combined/);
});

test('removes only Workbench settings without changing a status line', () => {
  const configured = mergeObservabilitySettings({
    env: { KEEP_ME: 'yes' },
    statusLine: { type: 'command', command: 'node custom-statusline.js' },
  }, { workbenchRoot: 'C:/Workbench' });
  const removed = removeObservabilitySettings(configured);
  assert.deepEqual(removed.env, { KEEP_ME: 'yes' });
  assert.equal(removed.statusLine.command, 'node custom-statusline.js');
  for (const name of Object.keys(OBSERVABILITY_ENV)) assert.equal(Object.hasOwn(removed.env, name), false);
});

test('disable tears down managed runtime and keeps the consent record reconfigurable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-disable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, 'project');
  const otherProjectDir = path.join(directory, 'other-project');
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(otherProjectDir, '.claude'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'observability.json'), JSON.stringify({
    observability: { enabled: true, sink: 'none', dashboard: false, projects: [otherProjectDir], sinks: {} },
  }));
  applySettings(projectDir, { workbenchRoot: 'C:/Workbench' });
  applySettings(otherProjectDir, { workbenchRoot: 'C:/Workbench' });
  let tornDown = false;

  const result = await setupObservability({
    projectDir,
    dataDir,
    disable: true,
    dockerAvailable: false,
    ensureModule: {
      teardownRuntime: async () => { tornDown = true; return { observer: true, collector: true }; },
    },
  });

  assert.equal(tornDown, true);
  assert.equal(result.disabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'observability.json'), 'utf8')).observability.enabled, false);
  const localSettings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(localSettings.env, undefined);
  assert.equal(localSettings.statusLine, undefined);
  const otherSettings = JSON.parse(fs.readFileSync(path.join(otherProjectDir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(otherSettings.env, undefined);
  assert.equal(otherSettings.statusLine, undefined);
});
