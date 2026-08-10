import './_temp-cleanup.js';
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
fs.mkdirSync(path.join(discovery, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(discovery, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' },
    { slug: 'codex-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'Codex Sol' },
  ],
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

test('route resolves a ticket override without changing its sibling recipe', () => {
  const added = jsonCli('category', 'add', 'workflow-override', '--profile', 'coding', '--name', 'Workflow override', '--route-model', 'codex-terra', '--route-effort', 'medium');
  assert.equal(added.result.status, 0, added.result.stderr);

  const overridden = jsonCli('add', '--title', 'Use Sol', '--category', 'workflow-override', '--route-model', 'codex-sol', '--route-effort', 'high');
  const sibling = jsonCli('add', '--title', 'Keep Terra', '--category', 'workflow-override');
  assert.equal(overridden.result.status, 0, overridden.result.stderr);
  assert.equal(sibling.result.status, 0, sibling.result.stderr);

  const overrideRecipe = jsonCli('route', 'workflow-override', '--ticket', overridden.body.ticket.ref);
  assert.equal(overrideRecipe.result.status, 0, overrideRecipe.result.stderr);
  assert.deepEqual(overrideRecipe.body.route, { model: 'codex-sol', effort: 'high' });
  assert.equal(overrideRecipe.body.agent.promptPrefix, '[sidequest-route model=gpt-5.6-sol effort=high]\n\n');
  assert.deepEqual(overrideRecipe.body.ticket, {
    ref: overridden.body.ticket.ref,
    route: { model: 'codex-sol', effort: 'high' },
  });

  const siblingRecipe = jsonCli('route', 'workflow-override', '--ticket', sibling.body.ticket.ref);
  assert.equal(siblingRecipe.result.status, 0, siblingRecipe.result.stderr);
  assert.deepEqual(siblingRecipe.body.route, { model: 'codex-terra', effort: 'medium' });
  assert.equal(siblingRecipe.body.agent.promptPrefix, '[sidequest-route model=gpt-5.6-terra effort=medium]\n\n');
});

export {};
