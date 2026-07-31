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
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
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

test('doctor reports a project env block that masks global wiring', (t) => {
  const { home, project } = fixture(t);
  writeJson(wiringConfig(home), { mode: 'global' });
  writeJson(path.join(home, '.claude', 'settings.json'), { env: { ANTHROPIC_BASE_URL: DEFAULT_BASE_URL } });
  writeJson(path.join(project, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } });

  const result = run(home, project, ['doctor']);

  assert.notEqual(result.code, 0);
  assert.match(result.output, /masks global user wiring/);
  assert.match(result.output, /without ANTHROPIC_BASE_URL/);
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
