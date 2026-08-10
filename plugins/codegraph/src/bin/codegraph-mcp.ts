import { createInterface } from 'node:readline';
import path from 'node:path';
import { codegraphStateRoot, projectStateDirectory } from '../lib/paths.js';
import { invokeCodegraphTool, codegraphToolDefinitions } from '../lib/mcp.js';
import { TypeScriptLanguageProvider } from '../lib/extractors/typescript.js';
import { SemanticLanguageProviderRegistry } from '../lib/runtime-contract.js';
import { TypeScriptRuntimeAcquirer } from '../lib/runtime.js';
import { CodegraphService } from '../lib/service.js';
import { GraphStore } from '../lib/store.js';

interface RpcRequest { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }
interface RpcParameters { name: string; arguments?: unknown }

const maximumJsonRpcRequestBytes = 1_024 * 1_024;
const projectRoot = process.env.CODEGRAPH_PROJECT_ROOT ?? process.cwd();
const stateDirectory = projectStateDirectory(projectRoot);
const runtimeStateDirectory = codegraphStateRoot();
const store = GraphStore.open(path.join(stateDirectory, 'graph.sqlite'));
const providers = new SemanticLanguageProviderRegistry([
  new TypeScriptLanguageProvider(new TypeScriptRuntimeAcquirer({ stateDirectory: runtimeStateDirectory })),
]);
const service = new CodegraphService({ projectRoot, store, providers });

function send(id: RpcRequest['id'], value: Record<string, unknown>): void {
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`);
}

async function handle(request: RpcRequest): Promise<void> {
  try {
    if (request.method === 'initialize') {
      send(request.id, { result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codegraph', version: '1.0.0' } } });
      return;
    }
    if (request.method === 'notifications/initialized') return;
    if (request.method === 'tools/list') { send(request.id, { result: { tools: codegraphToolDefinitions } }); return; }
    if (request.method === 'tools/call') {
      const parameters = request.params;
      if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters) || !('name' in parameters) || typeof parameters.name !== 'string') throw new Error('tools/call requires a tool name');
      const toolParameters = parameters as RpcParameters;
      send(request.id, { result: await invokeCodegraphTool(service, toolParameters.name, toolParameters.arguments) });
      return;
    }
    throw new Error(`unsupported method: ${request.method}`);
  } catch (error: unknown) {
    send(request.id, { error: { code: -32602, message: error instanceof Error ? error.message : 'invalid request' } });
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try {
    if (Buffer.byteLength(line, 'utf8') > maximumJsonRpcRequestBytes) throw new Error('JSON-RPC request exceeds the input budget');
    const request = JSON.parse(line) as RpcRequest;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('invalid JSON-RPC request');
    void handle(request);
  } catch (error: unknown) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: error instanceof Error ? error.message : 'parse error' } })}\n`);
  }
});

process.once('exit', () => store.close());
