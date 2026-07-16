'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'sidequest.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-surface-'));
const project = path.join(home, 'project');
const env = Object.assign({}, process.env, { SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: project });

function cli(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
  return { result, body: result.stdout ? JSON.parse(result.stdout) : null };
}

function freshMcp() {
  process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-mcp-surface-'));
  process.env.CLAUDE_PROJECT_DIR = path.join(process.env.SIDEQUEST_HOME, 'project');
  for (const target of ['../lib/mcp.js', '../lib/store.js']) delete require.cache[require.resolve(target)];
  return require('../lib/mcp.js');
}

function call(mcp, name, args) {
  const response = mcp.handleRequest({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
  assert.ok(!response.result.isError, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('CLI category CRUD reports usage and category ticket stamping', () => {
  let run = cli('category', 'add', 'release-check', '--name', 'Release checks', '--description', 'A focused release task', '--contract', 'Run the release check.', '--route-model', 'sonnet', '--route-effort', 'medium', '--fallback-model', 'opus', '--fallback-effort', 'high');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.category.id, 'release-check');
  assert.deepEqual(run.body.category.fallback, { model: 'opus', effort: 'high' });

  run = cli('add', '--title', 'Run release checks', '--category', 'release-check');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.ticket.category.id, 'release-check');

  run = cli('category', 'list');
  const category = run.body.categories.find((entry) => entry.id === 'release-check');
  assert.equal(category.ticketCount, 1);

  run = cli('category', 'edit', 'release-check', '--name', 'Release verification', '--no-fallback');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.category.name, 'Release verification');
  assert.equal(run.body.category.fallback, null);

  run = cli('category', 'rm', 'release-check');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.ticketCount, 1);

  run = cli('category', 'rm', 'general');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /cannot be removed/i);
});

test('CLI rejects unknown category ids with valid choices', () => {
  const run = cli('add', '--title', 'Bad category', '--category', 'does-not-exist');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /unknown category.*valid:/i);
  assert.match(run.result.stderr, /general/);
});

test('CLI global fallback reads and updates routing policy', () => {
  let run = cli('global-fallback');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.body.fallback, { model: 'sonnet', effort: 'high' });

  run = cli('global-fallback', '--model', 'opus', '--effort', 'xhigh');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.body.fallback, { model: 'opus', effort: 'xhigh' });

  run = cli('models');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.body.globalFallback, { model: 'opus', effort: 'xhigh' });
  assert.ok(!JSON.stringify(run.body).includes('grade-'));
});

test('MCP category tools stamp tickets and reject unknown categories', () => {
  const mcp = freshMcp();
  const added = call(mcp, 'add', { title: 'Categorized MCP ticket', category: 'mechanical' });
  assert.equal(added.ticket.category.id, 'mechanical');

  const listed = call(mcp, 'category_list', {});
  assert.ok(listed.categories.some((category) => category.id === 'mechanical' && category.ticketCount === 1));

  const raw = mcp.handleRequest({ jsonrpc: '2.0', id: Date.now() + 1, method: 'tools/call', params: { name: 'update', arguments: { ref: added.ticket.ref, category: 'missing' } } });
  assert.ok(raw.result.isError);
  assert.match(raw.result.content[0].text, /unknown category.*valid:/i);
});

test('CLI project category layers stay isolated and expose effective origins', () => {
  const second = path.join(home, 'second-project');
  fs.mkdirSync(second, { recursive: true });
  let run = cli('category', 'add', 'project-only', '--project', project, '--name', 'Project only', '--route-model', 'sonnet', '--route-effort', 'medium');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'ADD');

  run = cli('category', 'edit', 'general', '--project', project, '--name', 'Local general');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'OVERRIDE');
  assert.equal(run.body.effective.name, 'Local general');

  run = cli('category', 'disable', 'mechanical', '--project', project);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'DISABLE');

  run = cli('category', 'list', '--project', project);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.categories.find((entry) => entry.id === 'project-only').origin, 'project');
  assert.equal(run.body.categories.find((entry) => entry.id === 'general').origin, 'overridden');
  assert.equal(run.body.categories.find((entry) => entry.id === 'mechanical').origin, 'disabled');

  run = cli('category', 'list', '--project', second);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(!run.body.categories.some((entry) => entry.id === 'project-only'));
  assert.equal(run.body.categories.find((entry) => entry.id === 'general').name, 'General fallback');

  run = cli('add', '--title', 'Wrong category for second project', '--project', second, '--category', 'project-only');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /unknown category/i);
});

test('CLI category list defaults to the current project taxonomy and supports global policy view', () => {
  const projectOnly = path.join(home, 'list-project');
  fs.mkdirSync(projectOnly, { recursive: true });
  let run = cli('category', 'add', 'project-only-list', '--project', projectOnly, '--name', 'Project only list', '--route-model', 'sonnet', '--route-effort', 'medium');
  assert.equal(run.result.status, 0, run.result.stderr);
  run = cli('category', 'disable', 'mechanical', '--project', projectOnly);
  assert.equal(run.result.status, 0, run.result.stderr);

  const currentEnv = Object.assign({}, env, { CLAUDE_PROJECT_DIR: projectOnly });
  const current = spawnSync(process.execPath, [BIN, 'category', 'list', '--json'], { encoding: 'utf8', env: currentEnv });
  assert.equal(current.status, 0, current.stderr);
  const currentBody = JSON.parse(current.stdout);
  assert.ok(currentBody.categories.some((entry) => entry.id === 'project-only-list' && entry.origin === 'project'));
  assert.ok(currentBody.categories.some((entry) => entry.id === 'mechanical' && entry.origin === 'disabled'));

  const global = spawnSync(process.execPath, [BIN, 'category', 'list', '--global', '--json'], { encoding: 'utf8', env: currentEnv });
  assert.equal(global.status, 0, global.stderr);
  const globalBody = JSON.parse(global.stdout);
  assert.ok(!globalBody.categories.some((entry) => entry.id === 'project-only-list'));
  assert.ok(globalBody.categories.some((entry) => entry.id === 'mechanical' && entry.origin === 'global'));
});

test('CLI category detach and relink expose project link states and warnings', () => {
  const scoped = path.join(home, 'detach-project');
  fs.mkdirSync(scoped, { recursive: true });

  let run = cli('category', 'edit', 'mechanical', '--project', scoped, '--name', 'Local mechanical');
  assert.equal(run.result.status, 0, run.result.stderr);

  run = cli('category', 'list', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  let category = run.body.categories.find((entry) => entry.id === 'mechanical');
  assert.equal(category.linkState, 'overridden');
  assert.deepEqual(category.changedFields, ['name', 'route']);

  run = cli('category', 'detach', 'mechanical', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'DETACH');

  run = cli('category', 'list', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  category = run.body.categories.find((entry) => entry.id === 'mechanical');
  assert.equal(category.linkState, 'detached');
  assert.ok(run.body.warnings.some((warning) => warning.kind === 'shadows-global' && warning.id === 'mechanical'));

  const plain = spawnSync(process.execPath, [BIN, 'category', 'list', '--project', scoped], { encoding: 'utf8', env });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /detached from global/);
  assert.match(plain.stdout, /shadows a global category/);

  run = cli('category', 'relink', 'mechanical', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow, null);
  assert.equal(run.body.effective.name, 'Mechanical change');
});

test('MCP category detach and relink expose project link states and warnings', () => {
  const mcp = freshMcp();
  const scoped = process.env.CLAUDE_PROJECT_DIR;
  fs.mkdirSync(scoped, { recursive: true });

  let result = call(mcp, 'category_edit', { project: scoped, id: 'mechanical', name: 'Local mechanical' });
  assert.equal(result.localRow.kind, 'OVERRIDE');

  result = call(mcp, 'category_detach', { project: scoped, id: 'mechanical' });
  assert.equal(result.localRow.kind, 'DETACH');
  assert.ok(result.warnings.some((warning) => warning.kind === 'shadows-global' && warning.id === 'mechanical'));

  result = call(mcp, 'category_list', { project: scoped });
  const category = result.categories.find((entry) => entry.id === 'mechanical');
  assert.equal(category.linkState, 'detached');
  assert.equal(category.origin, 'detached');
  assert.ok(result.warnings.some((warning) => warning.kind === 'shadows-global' && warning.id === 'mechanical'));

  result = call(mcp, 'category_relink', { project: scoped, id: 'mechanical' });
  assert.equal(result.localRow, null);
  assert.equal(result.effective.name, 'Mechanical change');
});
