'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectMetadata } = require('../hooks/observability.js');
const {
  applyProjectTelemetry,
  disableProjectTelemetry,
  removeProjectRegistry,
  updateProjectRegistry,
} = require('../bin/project-telemetry.js');

function temporaryProject(t, name = 'telemetry-project') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-telemetry-'));
  const projectDir = path.join(directory, name);
  fs.mkdirSync(projectDir, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, projectDir };
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
