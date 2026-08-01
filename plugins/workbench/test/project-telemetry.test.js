'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildObservation, projectMetadata } = require('../hooks/observability.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const {
  agentTeamsWarning,
  clampAutoCompactWindow,
  configureSidequestCompaction,
  enableAgentTeams,
} = require('../lib/project-settings.js');
const {
  applyProjectTelemetry,
  disableProjectTelemetry,
  enableProjectTelemetry,
  encodedProjectDirectory,
  removeProjectRegistry,
  registryEntry,
  telemetryStatePath,
  updateProjectRegistry,
} = require('../bin/project-telemetry.js');
const { auditProjectTelemetry, formatAudit, verifyProjectTelemetry } = require('../bin/verify-project-telemetry.js');

function temporaryProject(t, name = 'telemetry-project') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-telemetry-'));
  const projectDir = path.join(directory, name);
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, projectDir };
}

function temporaryRepository(t, name = 'sample-repo') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-repo-telemetry-')));
  const root = path.join(directory, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const projects = path.join(directory, 'claude-projects');
  fs.mkdirSync(projects, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, root, projects };
}

function hostSessions(projects, directory) {
  fs.mkdirSync(path.join(projects, encodedProjectDirectory(directory)), { recursive: true });
}

function fakeRuntime(configFile) {
  return async () => ({
    config: { observability: { ports: { collector: 4318, observer: 14319, dashboard: 3000 } } },
    observabilityConfig: configFile,
  });
}

test('adds the Claude Code telemetry block to fresh project settings', (t) => {
  const { projectDir } = temporaryProject(t, 'fresh project');
  const result = applyProjectTelemetry(projectDir);
  const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));

  assert.equal(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
  assert.equal(settings.env.OTEL_METRICS_INCLUDE_SESSION_ID, 'false');
  assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, 'project.id=fresh-project,service.name=claude-code');
  assert.ok(fs.existsSync(result.statePath));

  applyProjectTelemetry(projectDir);
  disableProjectTelemetry(projectDir, { dataDir: path.join(projectDir, 'workbench-data') });
  assert.equal(JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')).env, undefined);
});

test('merges telemetry settings without dropping existing environment keys', (t) => {
  const { projectDir } = temporaryProject(t);
  const claudeDirectory = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDirectory, { recursive: true });
  fs.writeFileSync(path.join(claudeDirectory, 'settings.local.json'), JSON.stringify({
    permissions: { allow: ['Read'] },
    env: {
      KEEP_ME: 'yes',
      OTEL_METRICS_EXPORTER: 'custom',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=dev',
    },
  }));

  const result = applyProjectTelemetry(projectDir);
  const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));

  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.equal(settings.env.KEEP_ME, 'yes');
  assert.equal(settings.env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, 'deployment.environment=dev,project.id=telemetry-project,service.name=claude-code');
});

test('enables agent teams without replacing project environment settings', (t) => {
  const { projectDir } = temporaryProject(t);
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Read'] },
    env: { KEEP_ME: 'yes' },
  }));

  const first = enableAgentTeams(projectDir);
  const second = enableAgentTeams(projectDir);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.deepEqual(settings.env, {
    KEEP_ME: 'yes',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  });
});

test('warns only when a project environment masks agent teams', (t) => {
  const { projectDir } = temporaryProject(t);
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');

  assert.equal(agentTeamsWarning(projectDir), null);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP_ME: 'yes' } }));
  assert.match(agentTeamsWarning(projectDir), /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/);

  enableAgentTeams(projectDir);
  assert.equal(agentTeamsWarning(projectDir), null);
});

test('configures a global compaction window without replacing either settings file', (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const globalSettingsPath = path.join(directory, 'user-settings', '.claude', 'settings.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
  fs.writeFileSync(globalSettingsPath, JSON.stringify({
    env: { KEEP_GLOBAL_ENV: 'yes' },
    enabledPlugins: { workbench: true },
    marketplaces: { eigenwise: { source: 'github' } },
  }));
  fs.writeFileSync(projectSettingsPath, JSON.stringify({
    unknownSetting: { preserved: true },
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    },
  }));

  const first = configureSidequestCompaction(projectDir, {
    autoCompactWindow: 350_000,
    policy: 'pin',
    globalSettingsPath,
  });
  const second = configureSidequestCompaction(projectDir, {
    autoCompactWindow: 350_000,
    policy: 'pin',
    globalSettingsPath,
  });
  const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
  const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(globalSettings.autoCompactWindow, 350_000);
  assert.deepEqual(globalSettings.env, { KEEP_GLOBAL_ENV: 'yes' });
  assert.deepEqual(globalSettings.enabledPlugins, { workbench: true });
  assert.deepEqual(globalSettings.marketplaces, { eigenwise: { source: 'github' } });
  assert.deepEqual(projectSettings.unknownSetting, { preserved: true });
  assert.equal(Object.hasOwn(projectSettings, 'autoCompactWindow'), false);
  assert.deepEqual(projectSettings.env, {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    SIDEQUEST_COMPACTION_POLICY: 'pin',
  });
});

test('clamps custom compaction windows to Claude Code limits', () => {
  assert.equal(clampAutoCompactWindow(1), 100_000);
  assert.equal(clampAutoCompactWindow(2_000_000), 1_000_000);
  assert.throws(() => clampAutoCompactWindow('350000'), /finite number/);
});

test('leaving the compaction window at default removes it globally and can remove a legacy project override', (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const globalSettingsPath = path.join(directory, 'user-settings', '.claude', 'settings.json');
  const projectSettingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
  fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
  fs.writeFileSync(globalSettingsPath, JSON.stringify({ autoCompactWindow: 250_000, marketplaces: { kept: true } }));
  fs.writeFileSync(projectSettingsPath, JSON.stringify({
    autoCompactWindow: 250_000,
    unknownSetting: true,
    env: { KEEP_ME: 'yes' },
  }));

  configureSidequestCompaction(projectDir, {
    autoCompactWindow: null,
    policy: 'off',
    removeProjectAutoCompactWindow: true,
    globalSettingsPath,
  });
  const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf8'));
  const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf8'));

  assert.equal(Object.hasOwn(globalSettings, 'autoCompactWindow'), false);
  assert.deepEqual(globalSettings.marketplaces, { kept: true });
  assert.equal(Object.hasOwn(projectSettings, 'autoCompactWindow'), false);
  assert.equal(projectSettings.unknownSetting, true);
  assert.deepEqual(projectSettings.env, {
    KEEP_ME: 'yes',
    SIDEQUEST_COMPACTION_POLICY: 'off',
  });
});

test('rejects unsupported Sidequest compaction policies', (t) => {
  const { projectDir } = temporaryProject(t);
  assert.throws(
    () => configureSidequestCompaction(projectDir, { autoCompactWindow: 350_000, policy: 'unknown' }),
    /pin, veto, off/,
  );
});

test('disable restores only telemetry values owned by Workbench', (t) => {
  const { projectDir } = temporaryProject(t);
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP_ME: 'yes' } }));
  applyProjectTelemetry(projectDir);
  const configured = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  configured.env.USER_LATER = 'preserved';
  configured.env.OTEL_RESOURCE_ATTRIBUTES += ',user.preference=kept';
  fs.writeFileSync(settingsPath, JSON.stringify(configured));

  const result = disableProjectTelemetry(projectDir, { dataDir: path.join(projectDir, 'workbench-data') });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.equal(result.changed, true);
  assert.deepEqual(settings.env, {
    KEEP_ME: 'yes',
    USER_LATER: 'preserved',
    OTEL_RESOURCE_ATTRIBUTES: 'user.preference=kept',
  });
});

test('keeps a machine-local opted-in project registry in sync', (t) => {
  const { directory, projectDir } = temporaryProject(t, 'Registry Project');
  const configFile = path.join(directory, 'application-data', 'observability.json');
  const expected = projectMetadata(projectDir);

  const added = updateProjectRegistry(projectDir, { configFile, now: '2026-07-20T08:00:00.000Z' });
  const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects;
  assert.deepEqual(added.entry, { ...expected, optedInAt: '2026-07-20T08:00:00.000Z' });
  assert.deepEqual(stored, [{ ...expected, optedInAt: '2026-07-20T08:00:00.000Z' }]);

  const removed = removeProjectRegistry(projectDir, { configFile });
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects, []);
});

test('wires the repository and every subdirectory that hosts sessions, from any of them', async (t) => {
  const { directory, root, projects } = temporaryRepository(t);
  const gui = path.join(root, 'apps', 'gui');
  const quiet = path.join(root, 'apps', 'quiet');
  const vendored = path.join(root, 'vendor', 'other-repo');
  const dependency = path.join(root, 'node_modules', 'package');
  const worktree = path.join(root, '.claude', 'worktrees', 'agent-a1');
  for (const created of [gui, quiet, dependency, worktree, path.join(vendored, '.git')]) {
    fs.mkdirSync(created, { recursive: true });
  }
  // Everything but `quiet` hosts sessions, so only the skip rules can keep them out.
  for (const hosted of [gui, vendored, dependency, worktree]) hostSessions(projects, hosted);
  const configFile = path.join(directory, 'observability.json');

  const enabled = await enableProjectTelemetry(gui, {
    projectsDir: projects,
    configFile,
    prepareRuntime: fakeRuntime(configFile),
  });

  assert.equal(enabled.repositoryRoot, root);
  assert.deepEqual(enabled.directories.map((entry) => entry.directory), [root, gui]);
  for (const { directory: wired } of enabled.directories) {
    const settings = JSON.parse(fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, 'project.id=sample-repo,service.name=claude-code');
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  }
  for (const untouched of [quiet, vendored, dependency, worktree]) {
    assert.equal(fs.existsSync(path.join(untouched, '.claude')), false, `${untouched} should not be wired`);
  }
  const registered = JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects;
  assert.deepEqual(registered.map(({ project_name: name }) => name), ['sample-repo']);
  assert.equal(registered[0].project_id, projectMetadata(root).project_id);

  const disabled = disableProjectTelemetry(gui, { configFile });
  assert.equal(disabled.changed, true);
  assert.deepEqual(disabled.directories.map((entry) => entry.directory), [root, gui]);
  for (const { directory: unwired } of disabled.directories) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(unwired, '.claude', 'settings.local.json'), 'utf8')).env, undefined);
    assert.equal(fs.existsSync(telemetryStatePath(unwired)), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects, []);
});

test('the audit names half-wired projects, the unwired directories, and the fixing command', async (t) => {
  const { directory, root, projects } = temporaryRepository(t);
  const gui = path.join(root, 'apps', 'gui');
  fs.mkdirSync(gui, { recursive: true });
  hostSessions(projects, gui);

  const databaseFile = path.join(directory, 'observability.db');
  const store = openObservabilityStore(databaseFile, { outboxEnabled: false });
  for (const session of ['session-1', 'session-2']) {
    store.ingest(buildObservation({ hook_event_name: 'SessionStart', session_id: session, cwd: gui }, new Date()));
  }
  store.close();

  const server = http.createServer((request, response) => {
    if (request.url === '/api/datasources') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ type: 'prometheus', uid: 'local-prometheus' }]));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: { result: [{ metric: { project_id: 'unrelated-project' } }] } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const configFile = path.join(directory, 'observability.json');
  const { port } = server.address();
  fs.writeFileSync(configFile, JSON.stringify({
    observability: {
      dashboard: true,
      ports: { observer: port, dashboard: port },
      optedInProjects: [registryEntry(root)],
    },
  }));

  const audit = await auditProjectTelemetry(gui, { configFile, databaseFile, projectsDir: projects });
  assert.equal(audit.project, 'sample-repo');
  assert.equal(audit.repositoryRoot, root);
  assert.equal(audit.observerEvents, 2);
  assert.equal(audit.nativeSamples, false);
  assert.deepEqual(audit.halfWired, [{ project: 'sample-repo', events: 2 }]);
  assert.deepEqual(audit.directories, [{ directory: root, wired: false }, { directory: gui, wired: false }]);

  const report = formatAudit(audit);
  assert.match(report, /half-wired: opted-in project sample-repo has 2 observer events/);
  assert.ok(report.includes(`UNWIRED ${gui}`), report);
  assert.ok(report.includes(`--project "${root}"`), report);
  assert.match(report, /restart Claude Code/);
});

test('verifies project telemetry through Grafana datasource proxy outcomes', async (t) => {
  const { directory, projectDir } = temporaryProject(t);
  const cases = [
    { name: 'finds a metric', result: [{ value: [1, '13'] }], expected: { found: true, reason: undefined } },
    { name: 'reports an empty metric result', result: [], expected: { found: false, reason: 'metric_not_found' } },
    { name: 'reports a Grafana query failure', statusCode: 404, expected: { found: false, reason: 'dashboard_unreachable' } },
  ];

  for (const scenario of cases) {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === '/api/datasources') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([{ type: 'prometheus', uid: 'local-prometheus' }]));
        return;
      }
      if (request.url.startsWith('/api/datasources/proxy/uid/local-prometheus/api/v1/query')) {
        response.writeHead(scenario.statusCode || 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { result: scenario.result } }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const configFile = path.join(directory, `${scenario.name}.json`);
    const { port } = server.address();
    fs.writeFileSync(configFile, JSON.stringify({ observability: { dashboard: true, ports: { observer: port, dashboard: port } } }));
    const result = await verifyProjectTelemetry(projectDir, { configFile });

    assert.deepEqual({ found: result.found, reason: result.reason }, scenario.expected);
    assert.ok(requests.some((url) => url.startsWith('/api/datasources/proxy/uid/local-prometheus/api/v1/query')));
  }
});
