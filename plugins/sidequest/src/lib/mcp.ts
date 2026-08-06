'use strict';
/**
 * sidequest - MCP tool layer
 *
 * A second entry point over the same store as the CLI, so an agent working the
 * board calls typed tools (mcp__sidequest__claim, …) instead of shelling out to
 * `node bin/sidequest.js …` on every action. What that buys:
 *   - one permission grant for the whole toolset instead of a Bash prompt per call,
 *   - structured JSON in and out (no stdout parsing, no literal-\n heredoc trap on
 *     multi-line descriptions), and
 *   - a smaller skill, because the tool schemas are self-describing.
 *
 * This file is pure logic: a tool registry plus a JSON-RPC request handler. The
 * transport (a newline-delimited stdio loop) lives in bin/sidequest-mcp.js, and
 * the tests drive handleRequest() directly. Node stdlib only — no MCP SDK, so the
 * plugin stays dependency-free; the stdio JSON-RPC surface is tiny enough to
 * implement by hand.
 *
 * Every tool resolves its target board exactly like the CLI (CLAUDE_PROJECT_DIR
 * or cwd -> nearest repo root -> ensureProject; an explicit `project` arg -> the
 * registered board it names), so the CLI, the dashboard, and these tools all act
 * on the same store.
 */

const { compactSchema, conciseDescription, resolveProject, TOOL_DESCRIPTION_OVERRIDES } = require('./mcp-shared');
const { tools: readTools } = require('./mcp-read');
const { tools: ticketTools } = require('./mcp-tickets');
const { tools: lifecycleTools } = require('./mcp-lifecycle');
const { tools: collaborationTools } = require('./mcp-collaboration');
const { tools: routingTools } = require('./mcp-routing');

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => any | Promise<any>;
};
type RpcId = string | number | null | undefined;
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: any };

const SERVER_NAME = 'sidequest';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function serverVersion() {
  try {
    return require('../.claude-plugin/plugin.json').version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

const TOOLS: ToolDefinition[] = [
  ...readTools,
  ...ticketTools,
  ...lifecycleTools,
  ...collaborationTools,
  ...routingTools,
];


const MCP_CLI_ONLY_TOOLS = new Set([
  'native_agent', 'native_agent_cleanup',
]);

const TOOL_BY_NAME = new Map(TOOLS
  .filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name))
  .map((tool) => [tool.name, tool]));

const MUTATING_TOOLS = new Set([
  'add', 'update', 'remove', 'archive', 'unarchive', 'claim', 'sweepClaims', 'next',
  'done', 'groomClose', 'release', 'commit', 'submit', 'comment', 'plan', 'link', 'unlink', 'assign', 'dispatch',
  'category_add', 'category_edit', 'category_detach', 'category_relink', 'category_rm',
  'profile_create', 'profile_edit', 'profile_retire', 'profile_use', 'profile_repoint', 'profile_promote',
  'archive_board', 'unarchive_board',
]);
const GLOBAL_MUTATION_TOOLS = new Set(['category_add', 'category_edit', 'category_rm', 'global_fallback', 'profile_create', 'profile_edit', 'profile_retire', 'profile_repoint', 'profile_promote']);
const mutationTails = new Map<string, Promise<void>>();

function toolMutates(name?: any, args?: any) {
  if (MUTATING_TOOLS.has(String(name))) return true;
  if (name === 'new_board_profile') return args.profile !== undefined;
  if (name === 'global_fallback') return args.model !== undefined || args.effort !== undefined;
  if (name === 'board_config') return args.name !== undefined || args.alwaysInScope != null || args.generatedPairs !== undefined || args.integrationMode != null || args.integrationBranch != null || args.worktreeIsolation !== undefined || args.autoApproveTestScope !== undefined || args.worktreeSetup !== undefined;
  return false;
}

function mutationQueueKey(name?: any, args?: any) {
  if (name === 'new_board_profile') return '<global>';
  if (GLOBAL_MUTATION_TOOLS.has(String(name)) && args.project == null) return '<global>';
  return resolveProject(args.project).slug;
}

async function enqueueMutation<T>(board: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = mutationTails.get(board) || Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  mutationTails.set(board, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release!();
    if (mutationTails.get(board) === tail) mutationTails.delete(board);
  }
}

async function runTool(tool: ToolDefinition, args: any) {
  if (!toolMutates(tool.name, args)) return await tool.handler(args);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, () => tool.handler(args));
}


const MCP_SCHEMA_PROPERTY_DESCRIPTIONS: Record<string, string[]> = {
  add: ['complexity'],
  comments: ['full'],
  list: ['detail'],
  release: ['command', 'outputTail'],
};

function toolDescriptors() {
  return TOOLS
    .filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name))
    .map((tool) => {
      const inputSchema = compactSchema(tool.inputSchema);
      for (const property of MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || []) {
        const description = tool.inputSchema.properties?.[property]?.description;
        if (description) inputSchema.properties[property].description = description;
      }
      return {
        name: tool.name,
        description: TOOL_DESCRIPTION_OVERRIDES[tool.name] || conciseDescription(tool.description),
        inputSchema,
      };
    });
}

/* ------------------------------------------------------------------ *
 *  JSON-RPC request handling
 *
 *  handleRequest(msg) -> a response object to write back, or null for a
 *  notification (no id) that takes no reply. Never throws: a tool error is
 *  returned as an isError tool result the model can read; a protocol error is a
 *  JSON-RPC error object.
 * ------------------------------------------------------------------ */

function rpcResult(id?: RpcId, result?: any) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id?: RpcId, code?: any, message?: any) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(msg?: RpcMessage) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: serverVersion() },
    });
  }

  // Notifications carry no id and expect no response.
  if (method === 'notifications/initialized' || (method && method.indexOf('notifications/') === 0)) {
    return null;
  }
  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: toolDescriptors() });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true });
    }
    try {
      const out = await runTool(tool, args);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      const error = e as any;
      return rpcResult(id, { content: [{ type: 'text', text: `${(error && error.message) || error}` }], isError: true });
    }
  }

  if (isNotification) return null; // unknown notification: ignore
  return rpcError(id, -32601, `Method not found: ${method}`);
}

module.exports = {
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  TOOLS,
  toolDescriptors,
  resolveProject,
  handleRequest,
  serverVersion,
};
