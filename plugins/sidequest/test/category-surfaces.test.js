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
  let run = cli('category', 'add', 'release-check', '--name', 'Release checks', '--description', 'A focused release task', '--contract', 'Run the release check.', '--route-model', 'grade-2', '--route-effort', 'medium');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.category.id, 'release-check');

  run = cli('add', '--title', 'Run release checks', '--category', 'release-check');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.ticket.category.id, 'release-check');

  run = cli('category', 'list');
  const category = run.body.categories.find((entry) => entry.id === 'release-check');
  assert.equal(category.ticketCount, 1);

  run = cli('category', 'edit', 'release-check', '--name', 'Release verification');
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.body.category.name, 'Release verification');

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
