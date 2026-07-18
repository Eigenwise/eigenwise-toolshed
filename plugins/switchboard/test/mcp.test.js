'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const mcp = require('../lib/mcp.js');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mcp-'));
  return {
    directory,
    user: path.join(directory, 'user.json'),
    project: path.join(directory, 'project.json'),
  };
}

function withFixture(run) {
  const priorUser = process.env.SWITCHBOARD_CONFIG_USER_FILE;
  const priorProject = process.env.SWITCHBOARD_CONFIG_PROJECT_FILE;
  const value = fixture();
  process.env.SWITCHBOARD_CONFIG_USER_FILE = value.user;
  process.env.SWITCHBOARD_CONFIG_PROJECT_FILE = value.project;
  try {
    run(value);
  } finally {
    if (priorUser === undefined) delete process.env.SWITCHBOARD_CONFIG_USER_FILE;
    else process.env.SWITCHBOARD_CONFIG_USER_FILE = priorUser;
    if (priorProject === undefined) delete process.env.SWITCHBOARD_CONFIG_PROJECT_FILE;
    else process.env.SWITCHBOARD_CONFIG_PROJECT_FILE = priorProject;
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
}

test('MCP exposes category management and routing explanation tools', () => {
  assert.deepEqual(mcp.toolDescriptors().map((tool) => tool.name), [
    'category_list', 'category_show', 'category_add', 'category_edit', 'category_disable', 'category_remove',
    'category_detach', 'category_relink', 'category_reset', 'global_fallback', 'available_models',
    'routing_resolve', 'routing_contract', 'doctor', 'migrate',
  ]);

  withFixture(({ directory }) => {
    const created = mcp.TOOLS.find((tool) => tool.name === 'category_add').handler({
      id: 'alpha', name: 'Alpha', description: '', contract: '', routeModel: 'sonnet', routeEffort: 'high',
    });
    assert.equal(created.category.id, 'alpha');

    const resolution = mcp.resolve({ categoryId: 'alpha', projectPath: directory });
    assert.equal(resolution.status, 'routed');
    assert.equal(resolution.route.model, 'sonnet');

    const response = mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doctor', arguments: { projectPath: directory } } });
    assert.equal(response.result.isError, undefined);
    assert.equal(JSON.parse(response.result.content[0].text).schemaVersion, 1);
  });
});

test('MCP rejects category routes outside user caps on every mutation', () => {
  withFixture(({ user }) => {
    fs.writeFileSync(user, JSON.stringify({ schemaVersion: 1, allowedModels: ['haiku'] }) + '\n');
    assert.throws(() => mcp.addCategory({
      category: { id: 'blocked', name: 'Blocked', description: '', contract: '', route: { model: 'sonnet', effort: 'high' }, fallback: null, enabled: true },
    }), /allowedModels cap/);
  });
});
