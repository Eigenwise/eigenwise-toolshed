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

const path = require('path');
const store = require('./store');
const { compactSchema, conciseDescription, resolveProject, TOOL_DESCRIPTION_OVERRIDES, boundedReadPayload } = require('./mcp-shared');
const { sidequestMutationFreshness } = require('./plugin-freshness');
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
// The listing is loaded into every MCP session. Keep a distinct reserve for
// protocol growth so the contributor-facing budget remains visible in tests.
const MCP_TOOLS_LIST_MAX_BYTES = 23000;
const MCP_TOOLS_LIST_HEADROOM_BYTES = 2500;

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
  'done', 'groomClose', 'release', 'commit', 'submit', 'supersede_submission', 'comment', 'plan', 'link', 'unlink', 'assign', 'dispatch',
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
  if (name === 'board_config') return args.name !== undefined || args.alwaysInScope != null || args.generatedPairs !== undefined || args.integrationMode != null || args.integrationBranch != null || args.worktreeIsolation !== undefined || args.worktreeBase !== undefined || args.notIntegratedSalvageAgeHours !== undefined || args.autoApproveTestScope !== undefined || args.autoApproveScope !== undefined || args.worktreeSetup !== undefined || args.worktreeDependencyPaths !== undefined;
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

const ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  comment: { message: 'body', m: 'body' },
  link: { type: 'verb', target: 'to', ref: 'from' },
  story_log: { append: 'entry' },
};

function editDistance(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function argumentSuggestion(key: string, allowed: Set<string>) {
  const matches = Array.from(allowed).filter((accepted) => editDistance(key, accepted) <= 2);
  return matches.length === 1 ? ` did you mean ${matches[0]}?` : '';
}

function validateToolArguments(tool: ToolDefinition, rawArgs: any) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error(`${tool.name}: arguments must be an object.`);
  }
  const args = { ...rawArgs };
  const aliases: string[] = [];
  for (const [from, to] of Object.entries(ARGUMENT_ALIASES[tool.name] || {})) {
    if (args[from] === undefined) continue;
    if (args[to] !== undefined) throw new Error(`${tool.name}: pass either ${from} or ${to}, not both.`);
    args[to] = args[from];
    delete args[from];
    aliases.push(`accepted ${from} as ${to}`);
  }
  if (args.priority === 'medium') {
    args.priority = 'normal';
    aliases.push('accepted priority "medium" as "normal"');
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties || {}));
  if (tool.name === 'dispatch') allowed.add('session');
  const properties = tool.inputSchema.properties || {};
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) {
    const quoted = unknown.map((key) => `"${key}"`).join(', ');
    const accepted = Object.keys(properties).join(', ');
    const suggestion = unknown.length === 1 && unknown[0] !== undefined ? argumentSuggestion(unknown[0], allowed) : '';
    throw new Error(`${tool.name}: unknown argument${unknown.length === 1 ? '' : 's'} ${quoted} — ${tool.name} accepts: ${accepted}.${suggestion}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const values = properties[key]?.enum;
    if (value !== undefined && Array.isArray(values) && !values.includes(value)) {
      throw new Error(`${tool.name}: ${key} received ${JSON.stringify(value)} — must be one of: ${values.join(', ')}.`);
    }
  }
  return { args, aliases };
}

function acknowledgeAliases(output: any, aliases: string[]) {
  return aliases.length && output && typeof output === 'object'
    ? Object.assign(output, { acceptedAliases: aliases })
    : output;
}

function mutationProjectPath(projectArg: unknown): string | null {
  const project = projectArg == null ? '' : String(projectArg).trim();
  if (project) {
    const known = store.findProject(project);
    if (known.ok) return known.meta.path;
    return path.isAbsolute(project) ? store.nearestRepoRoot(path.resolve(project)) : null;
  }
  return store.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function assertMutationFreshness(projectArg: unknown) {
  const projectPath = mutationProjectPath(projectArg);
  if (!projectPath) return;
  const freshness = sidequestMutationFreshness(projectPath, {
    pluginRoot: path.join(__dirname, '..'),
  });
  if (freshness.refusal) throw new Error(freshness.refusal);
}

async function runTool(tool: ToolDefinition, rawArgs: any) {
  const { args, aliases } = validateToolArguments(tool, rawArgs);
  if (!toolMutates(tool.name, args)) {
    const output = await tool.handler(args);
    return acknowledgeAliases(tool.name === 'context_page' ? output : boundedReadPayload(tool.name, output), aliases);
  }
  assertMutationFreshness(args.project);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, async () => acknowledgeAliases(await tool.handler(args), aliases));
}


const MCP_SCHEMA_PROPERTY_DESCRIPTIONS: Record<string, Record<string, string>> = {
  context_page: {
    cursor: 'Opaque.',
    limit: 'UTF-8 bytes.',
    expectedRevision: 'Required revision.',
  },
  add: { complexity: 'Legacy score; why required.' },
  comments: {
    full: 'Whole bodies; bypasses elision.',
    since: 'Comment id or ISO timestamp.',
  },
  list: {
    detail: 'Full comments; default for status.',
    brief: 'One compact row per ticket.',
  },
  release: {
    command: 'Required for blocker/contradiction.',
    outputTail: 'Required blocker/contradiction output.',
  },
  story_log: { entry: 'Must begin DECISION:, CONSTRAINT:, or DISCOVERY:; max 16,000 UTF-8 bytes.' },
  category_edit: { fallbackModel: 'null clears fallback.' },
  dispatch: { sharedTree: 'Use only from the declared shared checkout; executors with live claims cannot dispatch child work.', recoveryEvidence: 'Recovery evidence for a failed dispatch.' },
};

function toolDescriptor(tool: ToolDefinition) {
  const inputSchema = compactSchema(tool.inputSchema);
  for (const [property, description] of Object.entries(MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || {})) {
    inputSchema.properties[property].description = description;
  }
  return {
    name: tool.name,
    description: Object.hasOwn(TOOL_DESCRIPTION_OVERRIDES, tool.name)
      ? TOOL_DESCRIPTION_OVERRIDES[tool.name]
      : conciseDescription(tool.description),
    inputSchema,
  };
}

function toolDescriptors() {
  return TOOLS
    .filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name))
    .map(toolDescriptor);
}

function toolDescriptorByteReport() {
  const tools = toolDescriptors();
  const payloadBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return {
    maxBytes: MCP_TOOLS_LIST_MAX_BYTES,
    reserveBytes: MCP_TOOLS_LIST_HEADROOM_BYTES,
    payloadBytes,
    headroomBytes: MCP_TOOLS_LIST_MAX_BYTES - payloadBytes,
    tools: tools
      .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool), 'utf8') }))
      .sort((left, right) => right.bytes - left.bytes),
  };
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
  MCP_TOOLS_LIST_MAX_BYTES,
  MCP_TOOLS_LIST_HEADROOM_BYTES,
  TOOLS,
  toolDescriptors,
  toolDescriptorByteReport,
  resolveProject,
  handleRequest,
  serverVersion,
};
