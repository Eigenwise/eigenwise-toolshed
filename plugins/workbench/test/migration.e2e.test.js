'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workbench = require('../hooks/user-prompt-freshness.js');
const guard = require('../../toolshed-guard/hooks/user-prompt-freshness.js');
const workspaceInit = require('../../workspace-init/hooks/session-start-freshness.js');

const CWD = 'C:\\dev\\project';
const SESSION_ID = 'migration-e2e-session';
const COMPLETE_TASK_NOTIFICATION = `<task-notification>
<task-id>agent-migration-e2e</task-id>
<tool-use-id>toolu_migration_e2e</tool-use-id>
<status>completed</status>
<summary>Migration executor completed</summary>
</task-notification>`;

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-migration-e2e-'));
}

function manifest(versions = {}) {
  return {
    name: 'eigenwise-toolshed',
    version: '0.3.2',
    plugins: [
      { name: 'toolshed-guard', version: versions['toolshed-guard'] || '0.3.2' },
      { name: 'workspace-init', version: versions['workspace-init'] || '0.7.0' },
      { name: 'workbench', version: versions.workbench || '0.1.0' },
      { name: 'removed-plugin', version: '9.0.0' },
    ],
  };
}

function registry(plugins) {
  return { version: 1, plugins };
}

function writeFixture(directory, installed, remote) {
  const registryFile = path.join(directory, 'installed_plugins.json');
  const stateFile = path.join(directory, 'data', 'remote-freshness.json');
  const reloadStateFile = path.join(directory, 'data', 'reload-required.json');
  fs.writeFileSync(registryFile, JSON.stringify(installed));
  const body = JSON.stringify(remote);
  const state = workbench.stateForManifest(remote, body, null, 100, '"migration"');
  workbench.writeStateAtomic(fs, stateFile, state);
  return { registryFile, stateFile, reloadStateFile };
}

function options(files, extra = {}) {
  return {
    ...files,
    platform: 'win32',
    now: () => 101,
    ...extra,
  };
}

function decideBoth(input, files, extra = {}) {
  const hookOptions = options(files, extra);
  return Promise.all([
    guard.decide(input, hookOptions),
    workbench.decide(input, hookOptions),
  ]);
}

function installed(name, scope = 'user', version = '0.1.0', extra = {}) {
  return { scope, version, ...extra };
}

test('migration state matrix covers old-only, mixed, Workbench-only, and removed rows', async () => {
  const directory = tempDirectory();
  try {
    const oldOnly = writeFixture(directory, registry({
      'toolshed-guard@eigenwise-toolshed': [installed('toolshed-guard', 'user', '0.2.0')],
      'workspace-init@eigenwise-toolshed': [installed('workspace-init', 'user', '0.6.0')],
    }), manifest());
    const [oldGuardResult] = await decideBoth({ prompt: 'do migration work', cwd: CWD }, oldOnly);
    const oldGuardBlock = JSON.parse(oldGuardResult);
    assert.equal(oldGuardBlock.decision, 'block');
    assert.match(oldGuardBlock.reason, /toolshed-guard 0\.2\.0 -> 0\.3\.2/);
    assert.match(oldGuardBlock.reason, /Run \/update-toolshed/);
    assert.equal(workspaceInit.migrationNotice(JSON.parse(fs.readFileSync(oldOnly.registryFile, 'utf8'))), workspaceInit.MIGRATION_NOTICE);

    const mixed = writeFixture(directory, registry({
      'toolshed-guard@eigenwise-toolshed': [installed('toolshed-guard', 'user', '0.2.0')],
      'workspace-init@eigenwise-toolshed': [installed('workspace-init', 'user', '0.6.0')],
      'workbench@eigenwise-toolshed': [installed('workbench', 'user', '0.1.0')],
    }), manifest());
    const [mixedGuard, mixedWorkbench] = await decideBoth({ prompt: 'do migration work', cwd: CWD }, mixed);
    assert.equal(mixedGuard, '');
    const mixedWorkbenchBlock = JSON.parse(mixedWorkbench);
    assert.equal(mixedWorkbenchBlock.decision, 'block');
    assert.match(mixedWorkbenchBlock.reason, /toolshed-guard 0\.2\.0 -> 0\.3\.2/);
    assert.equal(workspaceInit.migrationNotice(JSON.parse(fs.readFileSync(mixed.registryFile, 'utf8'))), '');

    const removed = writeFixture(directory, registry({
      'toolshed-guard@eigenwise-toolshed': [installed('toolshed-guard', 'removed', '0.1.0')],
    }), manifest());
    const [removedGuard, removedWorkbench] = await decideBoth({ prompt: 'do migration work', cwd: CWD }, removed);
    assert.equal(removedGuard, '');
    assert.equal(removedWorkbench, '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Workbench blocks when loaded code is older than the installed registry row', async () => {
  const directory = tempDirectory();
  try {
    const pluginRoot = path.join(directory, 'loaded-workbench');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.1.0' }));
    const files = writeFixture(directory, registry({
      'workbench@eigenwise-toolshed': [installed('workbench', 'user', '0.2.0')],
    }), manifest({ workbench: '0.2.0' }));
    const result = await workbench.decide({ prompt: 'continue', cwd: CWD }, options(files, { pluginRoot }));
    assert.match(result, /still loaded workbench 0\.1\.0 while the installed version is 0\.2\.0/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reload-required state survives update and non-force reload, then clears at forced reload', async () => {
  const directory = tempDirectory();
  try {
    const files = writeFixture(directory, registry({
      'workbench@eigenwise-toolshed': [installed('workbench', 'user', '0.1.0')],
    }), manifest({ workbench: '0.2.0' }));
    const input = { prompt: 'continue', cwd: CWD, session_id: SESSION_ID };
    const hookOptions = options(files);

    assert.match(await workbench.decide(input, hookOptions), /workbench 0\.1\.0 -> 0\.2\.0/);
    const required = JSON.parse(fs.readFileSync(files.reloadStateFile, 'utf8'));
    assert.equal(required.sessions[SESSION_ID].plugins[0].requiredVersion, '0.2.0');

    fs.writeFileSync(files.registryFile, JSON.stringify(registry({
      'workbench@eigenwise-toolshed': [installed('workbench', 'user', '0.2.0')],
    })));
    assert.equal(await workbench.decide({ ...input, prompt: '/reload-plugins' }, hookOptions), '');
    assert.match(await workbench.decide(input, hookOptions), /still needs a reload after detecting workbench 0\.1\.0/);
    assert.ok(JSON.parse(fs.readFileSync(files.reloadStateFile, 'utf8')).sessions[SESSION_ID]);

    assert.equal(await workbench.decide({ ...input, prompt: '/reload-plugins --force' }, hookOptions), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(files.reloadStateFile, 'utf8')).sessions, {});
    assert.equal(await workbench.decide(input, hookOptions), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native task notifications and every migration recovery command bypass both guards', async () => {
  const directory = tempDirectory();
  try {
    const files = writeFixture(directory, registry({
      'toolshed-guard@eigenwise-toolshed': [installed('toolshed-guard', 'user', '0.2.0')],
      'workspace-init@eigenwise-toolshed': [installed('workspace-init', 'user', '0.6.0')],
    }), manifest());
    const commands = [
      '/update-toolshed',
      '/reload-plugins',
      '/reload-plugins --force',
      '/plugin install workbench@eigenwise-toolshed --scope user',
      '/plugin uninstall workspace-init@eigenwise-toolshed --scope user',
      '/plugin uninstall toolshed-guard@eigenwise-toolshed --scope user',
      'claude plugin marketplace update eigenwise-toolshed',
      'claude plugin update workbench@eigenwise-toolshed --scope user',
    ];
    for (const command of commands) {
      assert.equal(guard.isMaintenancePrompt(command), true, `guard rejected ${command}`);
      assert.equal(workbench.isMaintenancePrompt(command), true, `Workbench rejected ${command}`);
      const [guardResult, workbenchResult] = await decideBoth({ prompt: command, cwd: CWD }, files);
      assert.equal(guardResult, '', `guard blocked ${command}`);
      assert.equal(workbenchResult, '', `Workbench blocked ${command}`);
    }
    assert.equal(guard.isTaskNotificationPrompt(COMPLETE_TASK_NOTIFICATION), true);
    assert.equal(workbench.isTaskNotificationPrompt(COMPLETE_TASK_NOTIFICATION), true);
    const [guardResult, workbenchResult] = await decideBoth({ prompt: COMPLETE_TASK_NOTIFICATION, cwd: CWD }, files);
    assert.equal(guardResult, '');
    assert.equal(workbenchResult, '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
