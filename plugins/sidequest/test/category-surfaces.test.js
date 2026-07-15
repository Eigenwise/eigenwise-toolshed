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

  run = cli('category', 'edit', 'release-check', '--name', 'Release verification', '--fallback-effort', 'xhigh');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.category.name, 'Release verification');
  assert.deepEqual(run.body.category.fallback, { model: 'opus', effort: 'xhigh' });

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

test('MCP global fallback and category fallback routes round-trip', () => {
  const mcp = freshMcp();
  const created = call(mcp, 'category_add', {
    id: 'fallback-test', name: 'Fallback test', routeModel: 'sonnet', routeEffort: 'high',
    fallbackModel: 'opus', fallbackEffort: 'xhigh',
  });
  assert.deepEqual(created.category.fallback, { model: 'opus', effort: 'xhigh' });

  const updated = call(mcp, 'category_edit', { id: 'fallback-test', fallbackEffort: 'medium' });
  assert.deepEqual(updated.category.fallback, { model: 'opus', effort: 'medium' });

  assert.deepEqual(call(mcp, 'global_fallback', {}).fallback, { model: 'sonnet', effort: 'high' });
  assert.deepEqual(call(mcp, 'global_fallback', { model: 'fable', effort: 'high' }).fallback, { model: 'fable', effort: 'high' });

  const models = call(mcp, 'models', {});
  assert.deepEqual(models.globalFallback, { model: 'fable', effort: 'high' });
  assert.ok(!JSON.stringify(models).includes('grade-'));
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

test('MCP project category layers add, override, disable, and shape models', () => {
  const mcp = freshMcp();
  const first = process.env.CLAUDE_PROJECT_DIR;
  fs.mkdirSync(first, { recursive: true });
  const second = path.join(path.dirname(first), 'second-project');
  fs.mkdirSync(second, { recursive: true });
  call(mcp, 'category_list', {});
  let result = call(mcp, 'category_add', { project: first, id: 'project-only', name: 'Project only', routeModel: 'sonnet', routeEffort: 'medium' });
  assert.equal(result.localRow.kind, 'ADD');

  result = call(mcp, 'category_edit', { project: first, id: 'general', name: 'Scoped general' });
  assert.equal(result.localRow.kind, 'OVERRIDE');
  assert.equal(result.effective.name, 'Scoped general');

  result = call(mcp, 'category_edit', { project: first, id: 'mechanical', enabled: false });
  assert.equal(result.localRow.kind, 'DISABLE');

  result = call(mcp, 'category_list', { project: first });
  assert.equal(result.categories.find((entry) => entry.id === 'project-only').origin, 'project');
  assert.equal(result.categories.find((entry) => entry.id === 'general').origin, 'overridden');
  assert.equal(result.categories.find((entry) => entry.id === 'mechanical').origin, 'disabled');

  result = call(mcp, 'models', { project: first });
  assert.ok(result.categories.some((entry) => entry.id === 'project-only'));
  assert.ok(!result.categories.some((entry) => entry.id === 'mechanical'));

  result = call(mcp, 'category_list', { project: second });
  assert.ok(!result.categories.some((entry) => entry.id === 'project-only'));
  assert.equal(result.categories.find((entry) => entry.id === 'general').name, 'General fallback');
});
