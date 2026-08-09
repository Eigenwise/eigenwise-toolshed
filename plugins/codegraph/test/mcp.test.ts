import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codegraphToolDefinitions, codegraphTools, invokeCodegraphTool } from '../src/lib/mcp.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { GraphStore } from '../src/lib/store.ts';
import { projectStateDirectory } from '../src/lib/paths.ts';

test('MCP exposes exactly the seven Codegraph tools', () => {
  assert.deepEqual(codegraphToolDefinitions.map((tool) => tool.name), codegraphTools);
  assert.equal(codegraphTools.length, 7);
  for (const tool of codegraphToolDefinitions) assert.equal(tool.inputSchema.additionalProperties, false);
});

test('MCP validates calls before querying the graph', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-mcp-'));
  try {
    const service = new CodegraphService({
      projectRoot,
      store: GraphStore.open(':memory:'),
      runtime: { acquire: async () => ({ engineId: 'test', engineVersion: '1', extractors: [] }) },
    });
    await assert.rejects(invokeCodegraphTool(service, 'codegraph_context', { query: '', maxDepth: 9 }));
    const response = await invokeCodegraphTool(service, 'codegraph_status');
    assert.match(response.content[0].text, /"status":"missing"/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('MCP rejects oversized inputs before graph work', async () => {
  const service = new CodegraphService({
    projectRoot: process.cwd(),
    store: GraphStore.open(':memory:'),
    runtime: { acquire: async () => ({ engineId: 'test', engineVersion: '1', extractors: [] }) },
  });
  await assert.rejects(invokeCodegraphTool(service, 'codegraph_context', { query: 'x'.repeat(64 * 1_024 + 1) }), /input budget/);
  await assert.rejects(invokeCodegraphTool(service, 'codegraph_context', { query: 'query', seedFiles: Array.from({ length: 1_001 }, () => 'file.ts') }), /at most 1000 entries/);
  await assert.rejects(invokeCodegraphTool(service, 'codegraph_context', { query: 'query', cursor: 'x'.repeat(16 * 1_024 + 1) }), /input budget/);
});

test('packaged MCP initializes with user-local project state', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-project-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-state-'));
  try {
    const entrypoint = path.resolve(process.cwd(), 'bin', 'codegraph-mcp.js');
    const child = spawnSync(process.execPath, [entrypoint], {
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_PROJECT_ROOT: projectRoot, CODEGRAPH_STATE_DIR: stateRoot },
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /"protocolVersion":"2024-11-05"/);
    await access(path.join(projectStateDirectory(projectRoot, { CODEGRAPH_STATE_DIR: stateRoot }), 'graph.sqlite'));
    await assert.rejects(access(path.join(projectRoot, '.claude')));
  } finally {
    await Promise.all([rm(projectRoot, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]);
  }
});

test('MCP rejects an oversized JSON-RPC line before parsing', () => {
  const entrypoint = path.resolve(process.cwd(), 'bin', 'codegraph-mcp.js');
  const child = spawnSync(process.execPath, [entrypoint], { encoding: 'utf8', input: 'x'.repeat(1_024 * 1_024 + 1) });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /JSON-RPC request exceeds the input budget/);
});
