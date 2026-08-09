import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codegraphToolDefinitions, codegraphTools, invokeCodegraphTool } from '../src/lib/mcp.ts';
import { CodegraphService } from '../src/lib/service.ts';
import { GraphStore } from '../src/lib/store.ts';

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
