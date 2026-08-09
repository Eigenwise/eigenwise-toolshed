#!/usr/bin/env node
'use strict';
const { createInterface } = require('node:readline');
const path = require('node:path');
const { invokeCodegraphTool, codegraphToolDefinitions } = require('../lib/mcp.js');
const { TypeScriptRuntimeAcquirer } = require('../lib/runtime.js');
const { CodegraphService } = require('../lib/service.js');
const { GraphStore } = require('../lib/store.js');
const projectRoot = process.env.CODEGRAPH_PROJECT_ROOT ?? process.cwd();
const stateDirectory = process.env.CODEGRAPH_STATE_DIR ?? path.join(projectRoot, '.claude', 'codegraph');
const store = GraphStore.open(path.join(stateDirectory, 'graph.sqlite'));
const service = new CodegraphService({ projectRoot, store, runtime: new TypeScriptRuntimeAcquirer({ stateDirectory }) });
function send(id, value) { if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`); }
async function handle(request) {
  try {
    if (request.method === 'initialize') return send(request.id, { result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codegraph', version: '1.0.0' } } });
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'tools/list') return send(request.id, { result: { tools: codegraphToolDefinitions } });
    if (request.method === 'tools/call') {
      const parameters = request.params;
      if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters) || typeof parameters.name !== 'string') throw new Error('tools/call requires a tool name');
      return send(request.id, { result: await invokeCodegraphTool(service, parameters.name, parameters.arguments) });
    }
    throw new Error(`unsupported method: ${request.method}`);
  } catch (error) { send(request.id, { error: { code: -32602, message: error instanceof Error ? error.message : 'invalid request' } }); }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try {
    const request = JSON.parse(line);
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('invalid JSON-RPC request');
    void handle(request);
  } catch (error) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: error instanceof Error ? error.message : 'parse error' } })}\n`); }
});
process.once('exit', () => store.close());
