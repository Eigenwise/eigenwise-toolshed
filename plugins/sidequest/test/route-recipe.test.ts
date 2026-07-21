'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'sidequest.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-route-recipe-'));
const project = path.join(home, 'project');
const discovery = path.join(home, 'discovery');
fs.mkdirSync(path.join(discovery, 'codex-gateway'), { recursive: true });
fs.writeFileSync(path.join(discovery, 'codex-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'codex-gateway',
  models: [{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }],
}));
const env = Object.assign({}, process.env, {
  SIDEQUEST_HOME: home,
  SIDEQUEST_DISCOVERY_DIRS: discovery,
  CLAUDE_PROJECT_DIR: project,
});

function cli(...args: any[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
}

function jsonCli(...args: any[]) {
  const result = cli(...args, '--json');
  return { result, body: result.stdout ? JSON.parse(result.stdout) : null };
}

test('route returns the live workflow recipe as JSON', () => {
  const added = jsonCli('category', 'add', 'workflow-terra', '--profile', 'coding', '--name', 'Workflow Terra', '--route-model', 'codex-terra', '--route-effort', 'medium');
  assert.equal(added.result.status, 0, added.result.stderr);

  const route = jsonCli('route', 'workflow-terra');
  assert.equal(route.result.status, 0, route.result.stderr);
  assert.deepEqual(route.body, {
    project: route.body.project,
    category: 'workflow-terra',
    categoryName: 'Workflow Terra',
    backend: 'codex',
    route: { model: 'codex-terra', effort: 'medium' },
    runsLabel: 'Codex Terra',
    agent: {
      model: 'claude-codex-auto',
      promptPrefix: '[sidequest-route model=gpt-5.6-terra effort=medium]\n\n',
    },
    effortCarrier: 'marker',
    warnings: [],
    profile: { id: 'coding', revision: 2 },
    categorySource: { kind: 'profile', baseProfileId: 'coding' },
  });
});

test('route requires JSON and names unknown and disabled categories', () => {
  let result = cli('route', 'workflow-terra');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pass --json/i);

  result = cli('route', 'missing-recipe', '--json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown/i);

  const disabled = jsonCli('category', 'add', 'disabled-recipe', '--profile', 'coding', '--name', 'Disabled Recipe', '--route-model', 'sonnet', '--route-effort', 'high');
  assert.equal(disabled.result.status, 0, disabled.result.stderr);
  const disable = jsonCli('category', 'disable', 'disabled-recipe', '--project', project);
  assert.equal(disable.result.status, 0, disable.result.stderr);
  result = cli('route', 'disabled-recipe', '--json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled for this project/i);
});

export {};
