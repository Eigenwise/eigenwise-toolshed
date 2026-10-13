'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildObservation, projectMetadata } = require('../hooks/observability.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { otlpToObservations } = require('../lib/observability/otlp.js');
const {
  USER_EXPORT_VARIABLES,
  applyProjectTelemetry,
  applyUserExport,
  claudeUserSettingsPath,
  claudeVersionFromAgent,
  disableProjectTelemetry,
  enableProjectTelemetry,
  encodedProjectDirectory,
  installedClaudeVersion,
  missingUserExport,
  parseArgs,
  projectSettingsCanExport,
  removeProjectRegistry,
  registryEntry,
  runCommand,
  telemetryStatePath,
  updateProjectRegistry,
  userExportAdvice,
  userExportEnvironment,
  userExportNotice,
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
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-repo-telemetry-')));
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

function emptyUserSettings(directory) {
  return { userSettingsPath: path.join(directory, 'user-settings.json'), environment: {} };
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
  assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, `project.id=${projectMetadata(projectDir).project_id},project.name=fresh-project,service.name=claude-code`);
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
  assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, `deployment.environment=dev,project.id=${projectMetadata(projectDir).project_id},project.name=telemetry-project,service.name=claude-code`);
});


test('disable restores only telemetry values owned by Observability', (t) => {
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

test('disabling one repository leaves the other registry entry intact', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  const configFile = path.join(directory, 'observability.json');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const firstEntry = updateProjectRegistry(first, { configFile, now: '2026-07-20T08:00:00.000Z' }).entry;
  const secondEntry = updateProjectRegistry(second, { configFile, now: '2026-07-20T08:01:00.000Z' }).entry;

  assert.equal(disableProjectTelemetry(first, { configFile }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects, [secondEntry]);
  assert.equal(secondEntry.optedInAt, '2026-07-20T08:01:00.000Z');
  assert.notEqual(firstEntry.project_id, secondEntry.project_id);
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
  const registered = JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects;
  const expectedProject = projectMetadata(root);
  assert.deepEqual(registered.map(({ project_name: name }) => name), ['sample-repo']);
  assert.equal(registered[0].project_id, expectedProject.project_id);
  assert.match(registered[0].project_id, /^[a-f0-9]{64}$/);
  for (const { directory: wired } of enabled.directories) {
    const settings = JSON.parse(fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8'));
    const attributes = new Map(settings.env.OTEL_RESOURCE_ATTRIBUTES.split(',').map((entry) => entry.split('=')));
    assert.equal(attributes.get('project.id'), registered[0].project_id);
    assert.equal(attributes.get('project.name'), registered[0].project_name);
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  }

  for (const untouched of [quiet, vendored, dependency, worktree]) {
    assert.equal(fs.existsSync(path.join(untouched, '.claude')), false, `${untouched} should not be wired`);
  }

  const otlp = otlpToObservations('logs', {
    resourceLogs: [{
      resource: { attributes: [
        { key: 'project.id', value: { stringValue: registered[0].project_id } },
        { key: 'project.name', value: { stringValue: registered[0].project_name } },
      ] },
      scopeLogs: [{ logRecords: [{
        timeUnixNano: '1721378400000000000',
        eventName: 'claude_code.api_request',
        attributes: [],
      }] }],
    }],
  });
  const otlpStore = openObservabilityStore(path.join(directory, 'otlp.db'), { outboxEnabled: false });
  assert.equal(otlpStore.ingestBatch(otlp).every((result) => result.accepted), true);
  assert.equal(otlpStore.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'schema_drop'").get().count, 0);
  otlpStore.close();

  const disabled = disableProjectTelemetry(gui, { configFile });
  assert.equal(disabled.changed, true);
  assert.deepEqual(disabled.directories.map((entry) => entry.directory), [root, gui]);
  for (const { directory: unwired } of disabled.directories) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(unwired, '.claude', 'settings.local.json'), 'utf8')).env, undefined);
    assert.equal(fs.existsSync(telemetryStatePath(unwired)), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).observability.optedInProjects, []);
});

test('before 2.1.282 the audit accepts canonical and legacy project.id wiring from project settings alone', async (t) => {
  const { directory, root, projects } = temporaryRepository(t);
  const gui = path.join(root, 'apps', 'gui');
  fs.mkdirSync(gui, { recursive: true });
  hostSessions(projects, gui);
  const configFile = path.join(directory, 'observability.json');
  fs.writeFileSync(configFile, JSON.stringify({
    observability: { dashboard: false, optedInProjects: [registryEntry(root)] },
  }));
  applyProjectTelemetry(root);
  fs.mkdirSync(path.join(gui, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(gui, '.claude', 'settings.local.json'), JSON.stringify({
    env: { OTEL_RESOURCE_ATTRIBUTES: 'project.id=sample-repo,service.name=claude-code' },
  }));

  const audit = await auditProjectTelemetry(root, {
    configFile,
    databaseFile: path.join(directory, 'missing.db'),
    projectsDir: projects,
    claudeVersion: '2.1.281',
    ...emptyUserSettings(directory),
  });

  assert.deepEqual(audit.directories, [{ directory: root, state: 'wired' }, { directory: gui, state: 'wired' }]);
  assert.deepEqual(audit.exportMissing, []);
  assert.equal(audit.claudeCodeRows, null);
  assert.equal(audit.verdict, 'unconfirmed');
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

  const audit = await auditProjectTelemetry(gui, {
    configFile,
    databaseFile,
    projectsDir: projects,
    claudeVersion: '2.1.281',
    ...emptyUserSettings(directory),
  });
  assert.equal(audit.project, 'sample-repo');
  assert.equal(audit.repositoryRoot, root);
  assert.equal(audit.observerEvents, 2);
  assert.equal(audit.nativeSamples, false);
  assert.deepEqual(audit.halfWired, [{ project: 'sample-repo', events: 2 }]);
  assert.deepEqual(audit.directories, [{ directory: root, state: 'unwired' }, { directory: gui, state: 'unwired' }]);
  assert.equal(audit.verdict, 'unwired');

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

test('parses the project, disable and user-export arguments and refuses anything else', () => {
  assert.deepEqual(parseArgs(['--project', 'here', '--disable']), { projectDir: 'here', disable: true });
  assert.deepEqual(parseArgs(['--user-export']), { userExport: true });
  assert.throws(() => parseArgs(['--project']), /Unknown or incomplete argument: --project/);
  assert.throws(() => parseArgs(['--audit']), /Unknown or incomplete argument: --audit/);
});

test('reads the Claude Code version from the CLI, falling back to the AI_AGENT marker', () => {
  assert.equal(claudeVersionFromAgent({ AI_AGENT: 'claude-code_2-1-285_harness' }), '2.1.285');
  assert.equal(claudeVersionFromAgent({ AI_AGENT: 'some-other-agent' }), null);
  assert.equal(claudeVersionFromAgent({}), null);
  assert.equal(installedClaudeVersion({ claudeVersion: '2.1.200' }), '2.1.200');
  assert.equal(installedClaudeVersion({ spawnSync: () => ({ status: 0, stdout: '2.1.285 (Claude Code)\n' }) }), '2.1.285');
  assert.equal(installedClaudeVersion({ spawnSync: () => ({ status: 0, stdout: 'no version here' }) }), null);
  assert.equal(installedClaudeVersion({
    spawnSync: () => ({ status: 1, stdout: '' }),
    environment: { AI_AGENT: 'claude-code_2-1-283_agent' },
  }), '2.1.283');
  assert.equal(projectSettingsCanExport('2.1.281'), true);
  assert.equal(projectSettingsCanExport('2.1.282'), false);
  assert.equal(projectSettingsCanExport(null), false);
});

test('user settings live in CLAUDE_CONFIG_DIR when it is set, else in ~/.claude', (t) => {
  const { directory } = temporaryProject(t);
  assert.equal(claudeUserSettingsPath({ environment: { CLAUDE_CONFIG_DIR: directory } }), path.join(directory, 'settings.json'));
  assert.equal(claudeUserSettingsPath({ environment: {} }), path.join(os.homedir(), '.claude', 'settings.json'));
});

test('the user-level export step merges into user settings without replacing any existing key', async (t) => {
  const { directory } = temporaryProject(t);
  const userSettingsPath = path.join(directory, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
  fs.writeFileSync(userSettingsPath, JSON.stringify({ model: 'opus', env: { OTEL_METRICS_EXPORTER: 'console', KEEP: '1' } }));
  const configFile = path.join(directory, 'observability.json');
  fs.writeFileSync(configFile, JSON.stringify({ observability: { ports: { collector: 4555 } } }));

  const report = await runCommand(['--user-export'], { configFile, userSettingsPath });

  const settings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.env.KEEP, '1');
  assert.equal(settings.env.OTEL_METRICS_EXPORTER, 'console');
  assert.equal(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4555');
  assert.equal(settings.env.OTEL_RESOURCE_ATTRIBUTES, undefined, 'project.id stays in each session directory');
  assert.equal(settings.env.OTEL_METRICS_INCLUDE_SESSION_ID, undefined);
  const written = USER_EXPORT_VARIABLES.filter((name) => name !== 'OTEL_METRICS_EXPORTER');
  assert.deepEqual(written.filter((name) => !(name in settings.env)), []);
  assert.match(report, new RegExp(`Wrote to ${userSettingsPath.replace(/[\\.]/g, '\\$&')} env:`));
  for (const name of written) assert.match(report, new RegExp(`^  ${name}=`, 'm'));
  assert.match(report, /Left alone because .* already gives them other values: OTEL_METRICS_EXPORTER\./);

  const ports = { collector: 4555 };
  assert.deepEqual(missingUserExport(ports, { userSettingsPath, environment: {} }), ['OTEL_METRICS_EXPORTER']);
  assert.deepEqual(missingUserExport(ports, { userSettingsPath, environment: { OTEL_METRICS_EXPORTER: 'otlp' } }), []);
  assert.deepEqual(applyUserExport({ userSettingsPath, ports }).written, {});
  assert.match(await runCommand(['--user-export'], { configFile, userSettingsPath }), /^Nothing written: /);
});

test('enable says in plain words that current Claude Code needs the user-level export step, and never takes it itself', async (t) => {
  const { directory, root, projects } = temporaryRepository(t);
  const configFile = path.join(directory, 'observability.json');
  const common = { projectsDir: projects, configFile, prepareRuntime: fakeRuntime(configFile), ...emptyUserSettings(directory) };

  const current = await runCommand(['--project', root], { ...common, claudeVersion: '2.1.285' });
  assert.match(current, /Project telemetry enabled for sample-repo .* in 1 directory:/);
  assert.match(current, /Claude Code 2\.1\.285 ignores telemetry export settings in project files \(since 2\.1\.282\)/);
  assert.ok(current.includes('--user-export'), current);
  assert.equal(fs.existsSync(common.userSettingsPath), false);
  assert.match(userExportAdvice({}, { ...common, claudeVersion: null }), /Claude Code \(version unknown\) ignores/);

  assert.doesNotMatch(await runCommand(['--project', root], { ...common, claudeVersion: '2.1.281' }), /user-export/);
  applyUserExport({ userSettingsPath: common.userSettingsPath });
  assert.doesNotMatch(await runCommand(['--project', root], { ...common, claudeVersion: '2.1.285' }), /user-export/);

  assert.match(await runCommand(['--project', root, '--disable'], common), /disabled for sample-repo in 1 directory:/);
  assert.equal(await runCommand(['--project', root, '--disable'], common), 'Project telemetry was not enabled by Observability.\n');
  updateProjectRegistry(root, { configFile });
  assert.match(await runCommand(['--project', root, '--disable'], common), /Removed sample-repo from the local registry; no wired directory remained/);
});

test('the SessionStart notice fires only for current Claude Code on an opted-in machine without user-level export', (t) => {
  const { directory } = temporaryProject(t);
  const userSettingsPath = path.join(directory, 'settings.json');
  const config = { observability: { ports: {}, optedInProjects: [{ project_id: 'a'.repeat(64) }] } };
  const current = { userSettingsPath, environment: { AI_AGENT: 'claude-code_2-1-285_harness' } };

  assert.match(userExportNotice(config, current), /Claude Code 2\.1\.285 ignores telemetry export settings in project files/);
  assert.equal(userExportNotice(config, { userSettingsPath, environment: { AI_AGENT: 'claude-code_2-1-281_harness' } }), null);
  assert.equal(userExportNotice(config, { userSettingsPath, environment: {} }), null);
  assert.equal(userExportNotice({ observability: { ports: {} } }, current), null);
  fs.writeFileSync(userSettingsPath, JSON.stringify({ env: userExportEnvironment({}) }));
  assert.equal(userExportNotice(config, current), null);
});

test('on Claude Code 2.1.282+ the audit separates wired, project.id without export, and unwired directories', async (t) => {
  const { directory, root, projects } = temporaryRepository(t);
  const gui = path.join(root, 'apps', 'gui');
  fs.mkdirSync(gui, { recursive: true });
  hostSessions(projects, gui);
  const configFile = path.join(directory, 'observability.json');
  fs.writeFileSync(configFile, JSON.stringify({ observability: { dashboard: false, optedInProjects: [registryEntry(root)] } }));
  applyProjectTelemetry(root);
  const databaseFile = path.join(directory, 'observability.db');
  openObservabilityStore(databaseFile, { outboxEnabled: false }).close();
  const now = new Date();
  const user = emptyUserSettings(directory);
  const options = { configFile, databaseFile, projectsDir: projects, claudeVersion: '2.1.285', now, ...user };

  const partial = await auditProjectTelemetry(root, options);
  assert.deepEqual(partial.directories, [{ directory: root, state: 'no-export' }, { directory: gui, state: 'unwired' }]);
  assert.equal(partial.verdict, 'unwired');
  const partialReport = formatAudit(partial);
  assert.ok(partialReport.includes(`NO-EXPORT ${root}`), partialReport);
  assert.ok(partialReport.includes(`UNWIRED ${gui}`), partialReport);
  assert.match(partialReport, /Claude Code 2\.1\.285 ignores telemetry export variables in project settings \(since 2\.1\.282\)/);
  assert.ok(partialReport.includes('--user-export'), partialReport);

  applyProjectTelemetry(gui);
  const exportDisabled = await auditProjectTelemetry(root, options);
  assert.equal(exportDisabled.verdict, 'export-disabled');
  const exportReport = formatAudit(exportDisabled);
  assert.doesNotMatch(exportReport, /^fix: /m, 'project-telemetry.js --project cannot turn export on');
  assert.ok(exportReport.includes('--user-export'), exportReport);

  applyUserExport({ userSettingsPath: user.userSettingsPath });
  const silent = await auditProjectTelemetry(root, options);
  assert.deepEqual(silent.directories.map(({ state }) => state), ['wired', 'wired']);
  assert.equal(silent.claudeCodeRows, 0);
  assert.equal(silent.verdict, 'no-data');
  assert.match(formatAudit(silent), /^no-data: no claude_code rows for sample-repo in 6h/m);

  const store = openObservabilityStore(databaseFile, { outboxEnabled: false });
  store.ingestBatch(otlpToObservations('logs', {
    resourceLogs: [{
      resource: { attributes: [{ key: 'project.id', value: { stringValue: registryEntry(root).project_id } }] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: `${BigInt(now.getTime()) * 1000000n}`, eventName: 'claude_code.api_request', attributes: [] }] }],
    }],
  }));
  store.close();
  const wired = await auditProjectTelemetry(root, options);
  assert.equal(wired.claudeCodeRows, 1);
  assert.equal(wired.verdict, 'wired');
  const wiredReport = formatAudit(wired);
  assert.match(wiredReport, /claude-code=2\.1\.285/);
  assert.match(wiredReport, /^verdict=wired$/m);
  assert.doesNotMatch(wiredReport, /^(fix|export|no-data)/m);
});

test('the audit report names unknown values and the busiest projects that never opted in', () => {
  const base = {
    project: 'sample-repo',
    repositoryRoot: '/repo',
    windowHours: 6,
    claudeVersion: null,
    observerEvents: null,
    claudeCodeRows: null,
    nativeSamples: null,
    reason: 'dashboard_not_configured',
    halfWired: [],
    unregistered: [],
    directories: [],
    exportMissing: [],
    verdict: 'unconfirmed',
    fixCommand: 'project-fix',
    userExportCommand: 'export-fix',
    userSettingsPath: '/home/.claude/settings.json',
  };
  const single = formatAudit({ ...base, unregistered: [{ project: 'other', events: 3 }], exportMissing: ['CLAUDE_CODE_ENABLE_TELEMETRY'] });
  assert.match(single, /claude-code=unknown/);
  assert.match(single, /observer-events=unknown claude-code-rows=unknown native-samples=unknown reason=dashboard_not_configured/);
  assert.match(single, /Claude Code \(version unknown\) ignores telemetry export variables/);
  assert.match(single, /not opted in: 1 project name sent observer events with no metrics, busiest other \(3\)/);
  const many = formatAudit({
    ...base,
    nativeSamples: true,
    unregistered: ['a', 'b', 'c', 'd'].map((project, index) => ({ project, events: 9 - index })),
  });
  assert.match(many, /native-samples=yes/);
  assert.match(many, /not opted in: 4 project names sent observer events with no metrics, busiest a \(9\), b \(8\), c \(7\)\n/);
  assert.doesNotMatch(many, /export-fix|project-fix/);
});
