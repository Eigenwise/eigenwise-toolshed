'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  COLLECTOR_VERSION,
  DOCKER_PROBE_TIMEOUT_MS,
  LGTM_IMAGE,
  MANAGED_DASHBOARD_CONTAINER,
  MIN_CLAUDE_VERSION,
  OBSERVABILITY_ENV,
  applySettings,
  collectorArchiveUrl,
  compareVersions,
  configuredSink,
  dashboardSkippedMessage,
  dockerProbe,
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
const grafana = require('../observability/sinks/grafana/index.js');
const { MANAGED_CONFIG_VERSION } = grafana;

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
  const healthPath = path.join(path.resolve(__dirname, '..'), 'lib', 'observability', 'ensure.js');
  assert.equal(
    verificationGuidance(),
    `Reload plugins once now, then verify: claude --version; curl http://127.0.0.1:14319/health; node "${healthPath}" --health; node "${reportPath}".\n`,
  );
});

test('identifies a Docker binary missing from PATH', () => {
  const probe = dockerProbe({
    spawnSync() {
      return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    },
  });

  assert.deepEqual(probe, { available: false, state: 'not-installed', timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  assert.match(dashboardSkippedMessage(probe), /Docker is not installed or not on PATH/);
});

test('identifies a Docker daemon that refuses the probe', () => {
  const probe = dockerProbe({ spawnSync: () => ({ status: 1, stderr: 'daemon is not running' }) });

  assert.deepEqual(probe, { available: false, state: 'daemon-unavailable', timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  assert.match(dashboardSkippedMessage(probe), /Docker is installed but its daemon is not responding/);
});

test('reports an unknown Docker state when the probe exceeds its budget', () => {
  const probe = dockerProbe({
    spawnSync() {
      return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    },
  });
  const message = dashboardSkippedMessage(probe);

  assert.deepEqual(probe, { available: false, state: 'timeout', timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
  assert.match(message, new RegExp(`Docker probe timed out after ${DOCKER_PROBE_TIMEOUT_MS}ms`));
  assert.match(message, /Docker state is unknown/);
  assert.doesNotMatch(message, /Docker is unavailable/);
});

test('check results preserve a successful Docker probe', async () => {
  const result = await setupObservability({
    check: true,
    dataDir: path.join(os.tmpdir(), 'workbench-observability-check-result'),
    dockerAvailable: true,
    config: {
      observability: { enabled: true, sink: 'grafana-lgtm', dashboard: true, projects: [] },
    },
    spawnSync() {
      return { status: 1, stdout: '' };
    },
  });

  assert.equal(result.dockerAvailable, true);
  assert.equal(result.docker.state, 'available');
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

test('does not replace an existing status line on repeat setup', () => {
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

  const binary = await downloadCollector({
    dataDir: directory,
    platform: 'win32',
    arch: 'x64',
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

  assert.match(urls[0], new RegExp(`/otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64\\.tar\\.gz$`));
  assert.match(urls[1], /opentelemetry-collector-releases_otelcol-contrib_checksums\.txt$/);
  assert.equal(calls[0][0], 'tar');
  assert.equal(calls[0][1][0], '--force-local');
  assert.equal(path.basename(binary), 'otelcol-contrib.exe');
});

test('plans current-user application data and only starts LGTM on request', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lgtm-start-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const plan = setupPlan({ dataDir, projectDir: '.' });
  assert.equal(plan.dataDir, dataDir);
  assert.equal(plan.lgtm, false);
  const calls = [];
  const registeredProject = { project_id: 'a'.repeat(64), project_name: 'atlas' };
  let dashboardRunning = false;
  const lgtm = startLgtm(plan.dataDir, {
    config: { observability: { optedInProjects: [registeredProject] } },
    activeProjectNames: ['atlas'],
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') {
        if (!dashboardRunning) return { status: 1, stdout: '' };
        return {
          status: 0,
          stdout: `running|true|${LGTM_IMAGE}||${MANAGED_CONFIG_VERSION}|null|${JSON.stringify([{
            Source: path.join(plan.dataDir, 'grafana-dashboards'),
            Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
          }])}`,
        };
      }
      if (args[0] === 'run') dashboardRunning = true;
      return { status: 0, stdout: args[0] === 'exec' ? '200' : 'container' };
    },
  });
  assert.equal(lgtm.image, LGTM_IMAGE);
  const runArgs = calls[1][1];
  assert.deepEqual(runArgs.filter((argument) => argument.startsWith('127.0.0.1:')), ['127.0.0.1:3000:3000', '127.0.0.1:14318:4318']);
  assert.equal(runArgs[runArgs.indexOf('--restart') + 1], 'unless-stopped');
  assert.ok(runArgs.includes(`${path.join(GRAFANA_SINK_DIR, 'provisioning')}:/otel-lgtm/grafana/conf/provisioning/dashboards:ro`));
  assert.ok(runArgs.includes(`${path.join(plan.dataDir, 'grafana-dashboards')}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards:ro`));
  assert.ok(fs.existsSync(path.join(plan.dataDir, 'grafana-dashboards', `claude-code-${registeredProject.project_id.slice(0, 16)}.json`)));
  const resumed = [];
  const dashboardMounts = JSON.stringify([{
    Source: path.join(plan.dataDir, 'grafana-dashboards'),
    Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
  }]);
  startLgtm(plan.dataDir, {
    config: { observability: { optedInProjects: [registeredProject] } },
    activeProjectNames: [],
    spawnSync(command, args) {
      resumed.push([command, args]);
      return { status: 0, stdout: args[0] === 'exec' ? '200' : `true|||${MANAGED_CONFIG_VERSION}|null|${dashboardMounts}` };
    },
  });
  assert.equal(resumed.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(plan.dataDir, 'grafana-dashboards')).sort(), [
    'claude-code-aaaaaaaaaaaaaaaa.json',
    'claude-code-usage.json',
  ]);
});

test('repairs a created dashboard container before reporting setup success', () => {
  const bindings = JSON.stringify({
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }],
    '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: '14318' }],
  });
  const dashboardDir = path.join(os.tmpdir(), 'workbench-grafana-created-container');
  const mounts = JSON.stringify([{
    Source: dashboardDir,
    Destination: '/otel-lgtm/grafana/conf/provisioning/workbench-dashboards',
  }]);
  const calls = [];
  let containerState = 'missing';

  const result = grafana.setup({}, {
    dashboardDir,
    pluginVersion: '0.20.0',
    dashboardReadyTimeoutMs: 0,
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') {
        if (containerState === 'missing') return { status: 1, stdout: '' };
        const running = containerState === 'running';
        return {
          status: 0,
          stdout: `${containerState}|${running}|${grafana.IMAGE}|0.20.0|${MANAGED_CONFIG_VERSION}|${bindings}|${mounts}`,
        };
      }
      if (args[0] === 'run') {
        containerState = 'created';
        return { status: 0, stdout: 'container-id' };
      }
      if (args[0] === 'start') {
        containerState = 'running';
        return { status: 0, stdout: 'workbench-otel-lgtm-demo' };
      }
      if (args[0] === 'exec') return { status: 0, stdout: '200' };
      throw new Error(`Unexpected Docker command: ${args[0]}`);
    },
  });

  assert.equal(result.resumed, false);
  assert.deepEqual(calls.map(([, args]) => args[0]), ['inspect', 'run', 'inspect', 'start', 'inspect', 'exec']);
  const probe = calls.at(-1)[1];
  assert.deepEqual(probe.slice(0, 3), ['exec', 'workbench-otel-lgtm-demo', 'curl']);
  assert.equal(probe[probe.indexOf('--write-out') + 1], '%{http_code}');
});

test('reports created container diagnostics when it cannot become ready', () => {
  let containerCreated = false;

  assert.throws(() => grafana.setup({}, {
    dashboardReadyTimeoutMs: 0,
    spawnSync(command, args) {
      if (args[0] === 'inspect') {
        return containerCreated
          ? { status: 0, stdout: 'created|false|grafana/otel-lgtm:0.11.0|<no value>|1|null|null' }
          : { status: 1, stdout: '' };
      }
      if (args[0] === 'run') containerCreated = true;
      if (args[0] === 'logs') return { status: 0, stdout: 'collector never became ready' };
      return { status: 0, stdout: '' };
    },
  }), /status: created; logs: collector never became ready/);
});

test('reports created dashboard containers distinctly from stopped ones', () => {
  const result = grafana.status({}, {
    spawnSync() {
      return { status: 0, stdout: 'created|false|grafana/otel-lgtm:0.11.0|<no value>|1|null|null' };
    },
  });

  assert.equal(result.containerState, 'created');
  assert.equal(result.running, false);
});

test('setup mounts generated Grafana dashboards only for active opted-in projects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lgtm-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const projectDir = path.join(directory, 'project');
  const registeredProjects = [
    { project_id: 'a'.repeat(64), project_name: 'atlas' },
    { project_id: 'b'.repeat(64), project_name: 'beacon' },
  ];
  fs.mkdirSync(projectDir, { recursive: true });
  const calls = [];
  let dashboardRunning = false;

  await setupObservability({
    projectDir,
    dataDir,
    dashboard: true,
    config: {
      observability: {
        dashboard: true,
        sink: 'grafana-lgtm',
        projects: [projectDir],
        optedInProjects: registeredProjects,
      },
    },
    dockerAvailable: true,
    activeProjectNames: ['atlas'],
    claudeVersion: MIN_CLAUDE_VERSION,
    environment: { WORKBENCH_OTELCOL_CONTRIB: process.execPath },
    applyProjectSettings: false,
    ensure: async () => ({ enabled: true, started: [] }),
    spawnSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'inspect') {
        return dashboardRunning
          ? { status: 0, stdout: `running|true|${LGTM_IMAGE}||${MANAGED_CONFIG_VERSION}|null|null` }
          : { status: 1, stdout: '' };
      }
      if (args[0] === 'run') dashboardRunning = true;
      return { status: 0, stdout: args[0] === 'exec' ? '200' : process.version };
    },
  });

  const dashboardDir = path.join(dataDir, 'grafana-dashboards');
  const runArgs = calls.find(([, args]) => args[0] === 'run')[1];
  assert.ok(runArgs.includes(`${dashboardDir}:/otel-lgtm/grafana/conf/provisioning/workbench-dashboards:ro`));
  assert.deepEqual(fs.readdirSync(dashboardDir).sort(), [
    'claude-code-aaaaaaaaaaaaaaaa.json',
    'claude-code-usage.json',
  ]);
});

test('continues setup when the dashboard activity probe fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lgtm-probe-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const projectDir = path.join(directory, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  let ensured = false;
  let dashboardProbeCount = 0;

  const result = await setupObservability({
    projectDir,
    dataDir,
    dashboard: true,
    config: {
      observability: {
        dashboard: true,
        sink: 'grafana-lgtm',
        projects: [projectDir],
        optedInProjects: [
          { project_id: 'a'.repeat(64), project_name: 'atlas' },
          { project_id: 'b'.repeat(64), project_name: 'beacon' },
        ],
      },
    },
    dockerAvailable: true,
    claudeVersion: MIN_CLAUDE_VERSION,
    environment: { WORKBENCH_OTELCOL_CONTRIB: process.execPath },
    applyProjectSettings: false,
    ensure: async () => { ensured = true; return { enabled: true, started: ['observer', 'collector'] }; },
    spawnSync(command, args) {
      if (args[0] === 'exec') {
        dashboardProbeCount += 1;
        return { status: dashboardProbeCount === 1 ? 1 : 0, stdout: dashboardProbeCount === 1 ? '' : '200' };
      }
      if (args[0] === 'inspect') return { status: 0, stdout: `true|${LGTM_IMAGE}||${MANAGED_CONFIG_VERSION}|null|null` };
      return { status: 0, stdout: process.version };
    },
  });

  assert.equal(ensured, true);
  assert.deepEqual(result.runtime.started, ['observer', 'collector']);
  const dashboardDir = path.join(dataDir, 'grafana-dashboards');
  const dashboardFiles = fs.readdirSync(dashboardDir).sort();
  assert.deepEqual(dashboardFiles, [
    'claude-code-aaaaaaaaaaaaaaaa.json',
    'claude-code-bbbbbbbbbbbbbbbb.json',
    'claude-code-usage.json',
  ]);
  const globalDashboard = fs.readFileSync(path.join(dashboardDir, 'claude-code-usage.json'), 'utf8');
  const globalExpressions = JSON.parse(globalDashboard).panels
    .flatMap((panel) => panel.targets || [])
    .map(({ expr }) => expr);
  assert.ok(globalExpressions.some((expression) => expression.includes('project_id=~"atlas|beacon"')));
  assert.ok(globalExpressions.some((expression) => expression.includes('workbench_attribute_project_name=~"atlas|beacon"')));
  for (const fileName of dashboardFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(dashboardDir, fileName), 'utf8'), /\$\^/);
  }
});

test('does not generate project dashboards from configured project paths', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lgtm-setup-empty-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data');
  const projectDir = path.join(directory, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  let dashboardRunning = false;

  await setupObservability({
    projectDir,
    dataDir,
    dashboard: true,
    config: {
      observability: {
        dashboard: true,
        sink: 'grafana-lgtm',
        projects: [projectDir],
        optedInProjects: [],
      },
    },
    dockerAvailable: true,
    claudeVersion: MIN_CLAUDE_VERSION,
    environment: { WORKBENCH_OTELCOL_CONTRIB: process.execPath },
    applyProjectSettings: false,
    ensure: async () => ({ enabled: true, started: [] }),
    spawnSync(command, args) {
      if (args[0] === 'inspect') {
        return dashboardRunning
          ? { status: 0, stdout: `running|true|${LGTM_IMAGE}||${MANAGED_CONFIG_VERSION}|null|null` }
          : { status: 1, stdout: '' };
      }
      if (args[0] === 'run') dashboardRunning = true;
      return { status: 0, stdout: args[0] === 'exec' ? '200' : process.version };
    },
  });

  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'grafana-dashboards')), ['claude-code-usage.json']);
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
  assert.deepEqual(parseArgs(['--reset-dashboards']), { resetDashboards: true });
  assert.throws(() => parseArgs(['--reset-dashboards', '--dashboard']), /cannot be combined/);
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

test('removes only Observability settings without changing a status line', () => {
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

test('enable-project-telemetry points current projects at scoped gateway wiring', () => {
  const skillPath = path.join(__dirname, '..', 'skills', 'enable-project-telemetry', 'SKILL.md');
  const document = fs.readFileSync(skillPath, 'utf8');
  assert.match(document, /\/model-gateway:model-gateway.*env --write-project/);
  assert.match(document, /env --write-user/);
  assert.doesNotMatch(document, /--show-mode|--mode global|--mode local/);
  assert.doesNotMatch(document, /`codex-gateway env --/);
});

test('observability README does not promise unsupported retention policies', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /retained for 30 days|retained for 365 days|under 24 hours|age-prune/);
});
