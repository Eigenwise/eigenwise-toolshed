'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const DEFAULT_BASE_URL = 'http://127.0.0.1:9';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-wiring-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, project };
}

function run(home, project, args) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
    },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function wiringConfig(home) {
  return path.join(home, '.claude', 'model-gateway', 'wiring.json');
}

test('env --mode global wires user settings', (t) => {
  const { home, project } = fixture(t);

  assert.equal(run(home, project, ['env', '--mode', 'global']).code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
});

test('env --mode local wires project settings', (t) => {
  const { home, project } = fixture(t);

  assert.equal(run(home, project, ['env', '--mode', 'local']).code, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
});

test('doctor fails when its active global user settings are unwired', (t) => {
  const { home, project } = fixture(t);
  writeJson(wiringConfig(home), { mode: 'global' });

  const result = run(home, project, ['doctor']);

  assert.notEqual(result.code, 0);
  assert.match(result.output, /active user wiring is not configured/);
  assert.match(result.output, /env --write-user/);
});

test('doctor skips a project env block without ANTHROPIC_BASE_URL', (t) => {
  const { home, project } = fixture(t);
  writeJson(wiringConfig(home), { mode: 'global' });
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  writeJson(path.join(project, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });

  const result = run(home, project, ['doctor']);

  assert.doesNotMatch(result.output, /masks global user wiring/);
  assert.match(result.output, /user settings\.json: wired .*\[effective\] \[selected mode\]/);
});

test('global mode preserves existing user env values', (t) => {
  const { home, project } = fixture(t);
  const userSettings = path.join(home, '.claude', 'settings.json');
  writeJson(userSettings, {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    },
  });

  assert.equal(run(home, project, ['env', '--mode', 'global']).code, 0);
  const settings = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(settings.env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, DEFAULT_BASE_URL);
});

const SETTINGS_WIRING = path.join(__dirname, '..', 'lib', 'settings-wiring.js');
const COMMANDS = path.join(__dirname, '..', 'lib', 'commands.js');

function runNode(home, project, script, extraEnv = {}) {
  const { ANTHROPIC_BASE_URL, ...environment } = process.env;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      CODEX_GATEWAY_PORT: '9',
      CODEX_GATEWAY_PROXY_PORT: '9',
      ...extraEnv,
    },
  });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout + result.stderr };
}

function resolveEffective(home, project, extraEnv) {
  const result = runNode(home, project, `process.stdout.write(JSON.stringify(require(${JSON.stringify(SETTINGS_WIRING)}).effectiveBaseUrl()))`, extraEnv);
  assert.equal(result.code, 0);
  return JSON.parse(result.output);
}

function runDoctor(home, project) {
  const readiness = {
    ready: true,
    state: 'ready',
    checks: { proxyBinary: false, proxyModels: true, codexAuth: true, shimRunning: true, servingVersion: 'test', servingVersionMatches: true },
  };
  return runNode(home, project, `require(${JSON.stringify(COMMANDS)}).commands.doctor({ readiness: ${JSON.stringify(readiness)} })`);
}

test('effectiveBaseUrl follows Claude Code precedence and reports shadowed definitions', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  const shared = path.join(project, '.claude', 'settings.json');
  const user = path.join(home, '.claude', 'settings.json');
  writeJson(local, { env: { ANTHROPIC_BASE_URL: 'http://local.example' } });
  writeJson(shared, { env: { ANTHROPIC_BASE_URL: 'http://shared.example' } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://user.example' } });

  let result = resolveEffective(home, project, { ANTHROPIC_BASE_URL: 'http://env.example' });
  assert.equal(result.source, 'env');
  assert.equal(result.value, 'http://env.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['project-local', 'project-shared', 'user']);

  result = resolveEffective(home, project);
  assert.equal(result.source, 'project-local');
  assert.equal(result.value, 'http://local.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['project-shared', 'user']);

  fs.rmSync(local);
  result = resolveEffective(home, project);
  assert.equal(result.source, 'project-shared');
  assert.equal(result.value, 'http://shared.example');
  assert.deepEqual(result.shadowed.map(({ source }) => source), ['user']);

  fs.rmSync(shared);
  result = resolveEffective(home, project);
  assert.equal(result.source, 'user');
  assert.equal(result.value, 'http://user.example');
  assert.deepEqual(result.shadowed, []);
});

test('effectiveBaseUrl skips absent, unparsable, and env-less settings files', (t) => {
  const { home, project } = fixture(t);
  const local = path.join(project, '.claude', 'settings.local.json');
  const shared = path.join(project, '.claude', 'settings.json');
  const user = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, '{');
  writeJson(shared, { env: { OTHER_VALUE: 'present' } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://user.example' } });

  const result = resolveEffective(home, project);
  assert.deepEqual(result, {
    value: 'http://user.example',
    source: 'user',
    file: user,
    shadowed: [],
  });
});

test('effectiveBaseUrl is re-exported through commands', (t) => {
  const { home, project } = fixture(t);
  const result = runNode(home, project, `process.stdout.write(typeof require(${JSON.stringify(COMMANDS)}).effectiveBaseUrl)`);
  assert.equal(result.code, 0);
  assert.equal(result.output, 'function');
});

test('doctor fails on a selected-mode contradiction and passes when modes agree', (t) => {
  const { home, project } = fixture(t);
  writeJson(wiringConfig(home), { mode: 'global' });
  const local = path.join(project, '.claude', 'settings.local.json');
  const user = path.join(home, '.claude', 'settings.json');
  writeJson(local, { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  writeJson(user, { env: { ANTHROPIC_BASE_URL: 'http://api.anthropic.com' } });

  let result = runDoctor(home, project);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /effective .*settings\.local\.json uses default mode/);
  assert.match(result.output, /shadowed .*settings\.json uses compat mode/);
  assert.match(result.output, /env --write-user/);

  writeJson(user, { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  result = runDoctor(home, project);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.output, /ERROR:/);
});
