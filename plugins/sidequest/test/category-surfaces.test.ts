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
fs.mkdirSync(project, { recursive: true });
const env = Object.assign({}, process.env, { SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: project });

function cli(...args: any[]) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
  return { result, body: result.stdout ? JSON.parse(result.stdout) : null };
}

function freshMcp() {
  process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-mcp-surface-'));
  process.env.CLAUDE_PROJECT_DIR = path.join(process.env.SIDEQUEST_HOME, 'project');
  for (const target of ['../lib/mcp.js', '../lib/store.js']) delete require.cache[require.resolve(target)];
  return require('../lib/mcp.js');
}

async function call(mcp?: any, name?: any, args?: any) {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } });
  assert.ok(!response.result.isError, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('CLI category CRUD reports usage and category ticket stamping', () => {
  let run = cli('category', 'add', 'release-check', '--project', project, '--name', 'Release checks', '--description', 'A focused release task', '--contract', 'Run the release check.', '--artifact-roots', 'reports/maps,reports/index', '--route-model', 'sonnet', '--route-effort', 'medium', '--fallback-model', 'opus', '--fallback-effort', 'high');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.effective.id, 'release-check');
  assert.deepEqual(run.body.effective.fallback, { model: 'opus', effort: 'high' });
  assert.deepEqual(run.body.effective.artifactRoots, ['reports/maps', 'reports/index']);

  run = cli('add', '--title', 'Run release checks', '--category', 'release-check');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.ticket.category.id, 'release-check');

  run = cli('category', 'list');
  const category = run.body.categories.find((entry?: any) => entry.id === 'release-check');
  assert.equal(category.ticketCount, 1);

  run = cli('category', 'edit', 'release-check', '--project', project, '--name', 'Release verification', '--no-fallback');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.effective.name, 'Release verification');
  assert.equal(run.body.effective.fallback, null);

  run = cli('category', 'rm', 'release-check', '--project', project);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.ticketCount, 1);

  run = cli('category', 'rm', 'general', '--project', project);
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /cannot be (removed|disabled)/i);
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
  assert.deepEqual(run.body.globalFallback, { label: 'availability fallback', model: 'opus', effort: 'xhigh' });
  assert.ok(!JSON.stringify(run.body).includes('grade-'));
});

test('MCP category tools stamp tickets and reject unknown categories', async () => {
  const mcp = freshMcp();
  const added = await call(mcp, 'add', { title: 'Categorized MCP ticket', category: 'coding.easy' });
  assert.match(added.ref, /^SQ-\d+$/);

  const listed = await call(mcp, 'category_list', { full: true });
  assert.ok(listed.categories.some((category?: any) => category.id === 'coding.easy' && category.ticketCount === 1));

  const raw = await mcp.handleRequest({ jsonrpc: '2.0', id: Date.now() + 1, method: 'tools/call', params: { name: 'update', arguments: { ref: added.ref, category: 'missing' } } });
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
  assert.equal(run.body.localRow.kind, 'DETACH');
  assert.equal(run.body.effective.name, 'Local general');

  run = cli('category', 'disable', 'coding.easy', '--project', project);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'DISABLE');

  run = cli('category', 'list', '--project', project);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.categories.find((entry?: any) => entry.id === 'project-only').origin, 'added');
  assert.equal(run.body.categories.find((entry?: any) => entry.id === 'general').origin, 'detached');
  assert.equal(run.body.categories.find((entry?: any) => entry.id === 'coding.easy').origin, 'disabled');

  run = cli('category', 'list', '--project', second);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.ok(!run.body.categories.some((entry?: any) => entry.id === 'project-only'));
  assert.equal(run.body.categories.find((entry?: any) => entry.id === 'general').name, 'General fallback');

  run = cli('add', '--title', 'Wrong category for second project', '--project', second, '--category', 'project-only');
  assert.notEqual(run.result.status, 0);
  assert.match(run.result.stderr, /unknown category/i);
});

test('CLI category list defaults to the current project taxonomy and supports global policy view', () => {
  const projectOnly = path.join(home, 'list-project');
  fs.mkdirSync(projectOnly, { recursive: true });
  let run = cli('category', 'add', 'project-only-list', '--project', projectOnly, '--name', 'Project only list', '--route-model', 'sonnet', '--route-effort', 'medium');
  assert.equal(run.result.status, 0, run.result.stderr);
  run = cli('category', 'disable', 'coding.easy', '--project', projectOnly);
  assert.equal(run.result.status, 0, run.result.stderr);

  const currentEnv = Object.assign({}, env, { CLAUDE_PROJECT_DIR: projectOnly });
  const current = spawnSync(process.execPath, [BIN, 'category', 'list', '--json'], { encoding: 'utf8', env: currentEnv });
  assert.equal(current.status, 0, current.stderr);
  const currentBody = JSON.parse(current.stdout);
  assert.ok(currentBody.categories.some((entry?: any) => entry.id === 'project-only-list' && entry.origin === 'added'));
  assert.ok(currentBody.categories.some((entry?: any) => entry.id === 'coding.easy' && entry.origin === 'disabled'));

  const global = spawnSync(process.execPath, [BIN, 'category', 'list', '--profile', 'coding', '--json'], { encoding: 'utf8', env: currentEnv });
  assert.equal(global.status, 0, global.stderr);
  const globalBody = JSON.parse(global.stdout);
  assert.ok(!globalBody.categories.some((entry?: any) => entry.id === 'project-only-list'));
  assert.ok(globalBody.categories.some((entry?: any) => entry.id === 'coding.easy' && entry.origin === 'profile'));
});

test('CLI category edit forks a board category, and reset returns it to the shared default', () => {
  const scoped = path.join(home, 'fork-project');
  fs.mkdirSync(scoped, { recursive: true });

  let run = cli('category', 'edit', 'coding.easy', '--project', scoped, '--name', 'Local coding.easy');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow.kind, 'DETACH');

  run = cli('category', 'list', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  const category = run.body.categories.find((entry?: any) => entry.id === 'coding.easy');
  assert.equal(category.linkState, 'detached');
  assert.equal(category.name, 'Local coding.easy');
  assert.deepEqual(run.body.warnings, []); // a forked board copy is normal, not a warning

  const plain = spawnSync(process.execPath, [BIN, 'category', 'list', '--project', scoped], { encoding: 'utf8', env });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /customized/);

  run = cli('category', 'reset', 'coding.easy', '--project', scoped);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.localRow, null);
  assert.equal(run.body.effective.name, 'Straightforward change');
});

test('MCP category edit forks a board category; category_relink resets it to the shared default', async () => {
  const mcp = freshMcp();
  const scoped = process.env.CLAUDE_PROJECT_DIR;
  fs.mkdirSync(scoped, { recursive: true });

  let result = await call(mcp, 'category_edit', { project: scoped, id: 'coding.easy', name: 'Local coding.easy' });
  assert.deepEqual(Object.keys(result).sort(), ['id', 'localRow', 'ok', 'project']);
  assert.equal(result.localRow.kind, 'DETACH');

  result = await call(mcp, 'category_list', { project: scoped, full: true });
  const category = result.categories.find((entry?: any) => entry.id === 'coding.easy');
  assert.equal(category.linkState, 'detached');
  assert.equal(category.origin, 'detached');
  assert.deepEqual(result.warnings, []);

  result = await call(mcp, 'category_relink', { project: scoped, id: 'coding.easy' });
  assert.deepEqual(result, { ok: true, project: result.project, id: 'coding.easy', localRow: null });
});

export {};
