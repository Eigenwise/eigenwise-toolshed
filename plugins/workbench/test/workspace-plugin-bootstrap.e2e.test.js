'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const installer = path.join(__dirname, '..', 'bin', 'install-workspace-plugins.js');
const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'init-workspace', 'SKILL.md'), 'utf8');

function writeFakeClaude(directory, projectDir) {
  const script = path.join(directory, 'fake-claude.js');
  fs.writeFileSync(script, String.raw`
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const stateFile = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const command = args.join(' ');

function save() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function fail(message) {
  process.stderr.write(message);
  process.exitCode = 1;
}

if (command === 'marketplace list --json') {
  process.stdout.write(JSON.stringify(state.marketplaces));
} else if (command === 'list --json') {
  process.stdout.write(JSON.stringify(state.plugins));
} else if (args[0] === 'marketplace' && args[1] === 'add') {
  const source = args[2];
  state.events.push({ type: 'marketplace-add', source });
  state.marketplaces.push({
    name: source === 'Eigenwise/eigenwise-toolshed' ? 'eigenwise-toolshed' : 'cloudflare',
    source: 'github',
    repo: source,
  });
  save();
  process.stdout.write('marketplace added');
} else if (args[0] === 'install') {
  const id = args[1];
  const scope = args[3];
  state.events.push({ type: 'plugin-install', id, scope });
  if (id === state.failPlugin) {
    fail('fake install failure');
  } else {
    state.plugins.push({
      id,
      scope,
      enabled: true,
      projectPath: scope === 'user' ? undefined : process.cwd(),
    });
    if (scope !== 'user') {
      const settingsFile = path.join(process.cwd(), '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const settings = fs.existsSync(settingsFile)
        ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        : {};
      settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [id]: true };
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    }
    save();
    process.stdout.write('plugin installed');
  }
} else {
  fail('unexpected fake Claude command: ' + command);
}
`, 'utf8');

  fs.copyFileSync(script, path.join(directory, 'plugin'));
  fs.copyFileSync(script, path.join(projectDir, 'plugin'));
  return process.execPath;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withFixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-bootstrap-e2e-'));
  const projectDir = path.join(directory, 'project');
  const homeDir = path.join(directory, 'home');
  const stateFile = path.join(directory, 'claude-state.json');
  const planFile = path.join(directory, 'plan.json');
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { allow: ['Read(./src/**)'] },
    customSetting: 'keep-me',
  }, null, 2));
  fs.writeFileSync(stateFile, JSON.stringify({ marketplaces: [], plugins: [], events: [], failPlugin: null }, null, 2));
  const claude = writeFakeClaude(directory, projectDir);
  const originalDirectory = process.cwd();
  process.chdir(directory);
  const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_STATE'];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: homeDir,
    FAKE_CLAUDE_STATE: stateFile,
  });

  try {
    return callback({ claude, directory, homeDir, planFile, projectDir, stateFile });
  } finally {
    for (const key of envKeys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runInstaller(fixture, plan) {
  fs.writeFileSync(fixture.planFile, JSON.stringify(plan, null, 2));
  const result = childProcess.spawnSync(process.execPath, [
    installer,
    '--plan', fixture.planFile,
    '--claude', fixture.claude,
  ], { encoding: 'utf8' });
  const output = result.stdout.trim();
  assert.notEqual(output, '', result.stderr);
  return { ...result, json: JSON.parse(output) };
}

function selectedPlan(projectDir, overrides = {}) {
  return {
    version: 1,
    projectDir,
    marketplaces: [
      { name: 'eigenwise-toolshed', source: 'Eigenwise/eigenwise-toolshed' },
      { name: 'cloudflare', source: 'cloudflare/skills' },
    ],
    plugins: [
      { id: 'codebase-mapper@eigenwise-toolshed', scope: 'project', role: 'core' },
      { id: 'live-rules@eigenwise-toolshed', scope: 'project', role: 'core' },
      { id: 'cloudflare@cloudflare', scope: 'project', role: 'optional' },
      { id: 'frontend-design@claude-plugins-official', scope: 'project', role: 'optional' },
    ],
    userScopeConfirmed: false,
    ...overrides,
  };
}

test('bootstraps the interviewed core and stack selection through a real fake Claude CLI', () => withFixture((fixture) => {
  const plan = selectedPlan(fixture.projectDir);
  const first = runInstaller(fixture, plan);

  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.reloadRequired, true);
  assert.deepEqual(readJson(fixture.stateFile).events, [
    { type: 'marketplace-add', source: 'Eigenwise/eigenwise-toolshed' },
    { type: 'marketplace-add', source: 'cloudflare/skills' },
    { type: 'plugin-install', id: 'codebase-mapper@eigenwise-toolshed', scope: 'project' },
    { type: 'plugin-install', id: 'live-rules@eigenwise-toolshed', scope: 'project' },
    { type: 'plugin-install', id: 'cloudflare@cloudflare', scope: 'project' },
    { type: 'plugin-install', id: 'frontend-design@claude-plugins-official', scope: 'project' },
  ]);
  const settings = readJson(path.join(fixture.projectDir, '.claude', 'settings.json'));
  assert.deepEqual(settings.permissions, { allow: ['Read(./src/**)'] });
  assert.equal(settings.customSetting, 'keep-me');
  assert.deepEqual(settings.enabledPlugins, {
    'codebase-mapper@eigenwise-toolshed': true,
    'live-rules@eigenwise-toolshed': true,
    'cloudflare@cloudflare': true,
    'frontend-design@claude-plugins-official': true,
  });
  assert.equal(fs.readdirSync(fixture.homeDir).length, 0);
}));

test('is idempotent on the second run and keeps every install project-scoped', () => withFixture((fixture) => {
  const plan = selectedPlan(fixture.projectDir);
  assert.equal(runInstaller(fixture, plan).status, 0);
  const before = readJson(fixture.stateFile);
  const settingsBefore = readJson(path.join(fixture.projectDir, '.claude', 'settings.json'));
  const second = runInstaller(fixture, plan);
  const after = readJson(fixture.stateFile);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.reloadRequired, false);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(readJson(path.join(fixture.projectDir, '.claude', 'settings.json')), settingsBefore);
  assert.deepEqual(after.plugins.map((plugin) => plugin.scope), ['project', 'project', 'project', 'project']);
}));

test('stops before reload-ready success on partial failure and safely resumes on rerun', () => withFixture((fixture) => {
  const plan = selectedPlan(fixture.projectDir);
  const state = readJson(fixture.stateFile);
  state.failPlugin = 'cloudflare@cloudflare';
  fs.writeFileSync(fixture.stateFile, JSON.stringify(state, null, 2));

  const failed = runInstaller(fixture, plan);
  assert.equal(failed.status, 1);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.reloadRequired, false);
  assert.match(failed.json.failure.command, /cloudflare@cloudflare/);
  assert.equal(failed.json.failure.output, 'fake install failure');
  const partial = readJson(fixture.stateFile);
  assert.deepEqual(partial.plugins.map((plugin) => plugin.id), [
    'codebase-mapper@eigenwise-toolshed',
    'live-rules@eigenwise-toolshed',
  ]);

  partial.failPlugin = null;
  fs.writeFileSync(fixture.stateFile, JSON.stringify(partial, null, 2));
  const resumed = runInstaller(fixture, plan);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.reloadRequired, true);
  assert.deepEqual(readJson(fixture.stateFile).plugins.map((plugin) => plugin.id), [
    'codebase-mapper@eigenwise-toolshed',
    'live-rules@eigenwise-toolshed',
    'cloudflare@cloudflare',
    'frontend-design@claude-plugins-official',
  ]);
}));

test('honors a personal local scope only when it is explicit in the plan', () => withFixture((fixture) => {
  const plan = selectedPlan(fixture.projectDir, {
    marketplaces: [{ name: 'eigenwise-toolshed', source: 'Eigenwise/eigenwise-toolshed' }],
    plugins: [{ id: 'personal-rules@eigenwise-toolshed', scope: 'local', role: 'optional' }],
  });
  const result = runInstaller(fixture, plan);

  assert.equal(result.status, 0, result.stderr);
  const state = readJson(fixture.stateFile);
  assert.deepEqual(state.events.filter((event) => event.type === 'plugin-install'), [
    { type: 'plugin-install', id: 'personal-rules@eigenwise-toolshed', scope: 'local' },
  ]);
  assert.equal(state.plugins[0].scope, 'local');
}));

test('documents one reload boundary and the selected-plugin verification list', () => {
  assert.equal((skill.match(/Run \*\*`\/reload-plugins`\*\*/g) ?? []).length, 1);
  assert.match(skill, /confirm every selected plugin is\ninstalled, enabled, and at its requested scope/);
  assert.match(skill, /Optional plugins\.\*\* Verify each selected extra is usable/);
  assert.match(skill, /Tell the user \*\*exactly what they got\*\*: which plugins are enabled/);
});
