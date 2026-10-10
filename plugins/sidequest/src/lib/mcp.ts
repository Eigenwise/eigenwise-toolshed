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
const { compactSchema, conciseDescription, resolveProject, runtimeSessionId, TOOL_DESCRIPTION_OVERRIDES, boundedReadPayload } = require('./mcp-shared');
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

function boardMcpSessionId(): string {
  return runtimeSessionId() || '';
}

const SERVER_NAME = 'sidequest';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
// The listing is loaded into every MCP session. Keep a distinct reserve for
// protocol growth so the contributor-facing budget remains visible in tests.
// Raised from 23000 for groomClose.abandonSubmission (SQ-2188): the old ceiling left 6 bytes of
// slack, so any new property broke it. The alternative was deleting another tool's guidance to make
// room, which costs an agent more than the ~25 tokens per session this adds.
// Raised again from 23100 for the invocation contracts a caller cannot get right on the first call
// (SQ-1955): +432 bytes, about 110 tokens per session, against three tickets in a row refused for the
// attestation grammar alone. Everything that can wait for the second call went to the skill instead.
// Raised from 23600 for recovery-retention board configuration (SQ-2453) while preserving the 2.5KB reserve.
// Raised from 23800 for the reduced Agent-schema contract: callers need the visible-schema condition and first-claim evidence before dispatch.
// Raised from 24000 for VERIFICATION_WAIVER_PROP's type: 'object' (SQ-2 / GitHub #109): an MCP host that
// enforces the declared schema type refused a top-level verificationWaiver because the property listed
// `properties` without `type: 'object'`. +91 bytes compacted, while preserving the 2.5KB reserve.
// Raised from 24100 for add/update verifyCwd (SQ-3118 / GitHub #259): +60 bytes compacted, while preserving
// the 2.5KB reserve. A nested workspace's gate had no other way to run from its own directory.
// Raised from 24200 for deniedTools on board_config and category_edit (GH-222): +114 bytes compacted. The two
// changes landed in one wave, so the cap moved once for both while preserving the 2.5KB reserve.
// Raised from 24300 for groomClose/integrate deliveryRevision and resolvedPaths (GitHub #144), the only route
// that closes a candidate rebased or squash-merged before it landed: +980 bytes compacted, measured on the
// wave-3 tree with SQ-3118 and GH-222 already in, so the 2.5KB reserve still holds.
// Raised from 25400 for update.admitComposition (SQ-3331): +1675 bytes compacted, all of it schema structure,
// since compactSchema strips its descriptions and update's served description is empty. Trimming other tools
// could not recover it without dropping callable constraints or pinned contract text, so the 2.5KB reserve holds.
// Raised from 27075 for two changes that landed on separate branches. board_config.verifyEnvironment
// (SQ-3423) is +235 bytes compacted, 67 for the key and its enum plus 168 for the served description, since
// compactSchema strips the authored one. update.addFiles/removeFiles and scopeRequest.grant (GitHub #173)
// are +535 bytes compacted. Measured at 25332 payload bytes on the merged tree with both in, so the cap is
// set to 27900 and the 2.5KB reserve still holds.
const MCP_TOOLS_LIST_MAX_BYTES = 27900;
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

const CONDITIONAL_MUTATION_FIELDS: Record<string, readonly string[]> = {
  verdict: ['correct'], new_board_profile: ['profile'], global_fallback: ['model', 'effort'],
  board_config: ['name', 'alwaysInScope', 'deniedTools', 'readOnlyDeniedTools', 'generatedPairs', 'integrationMode',
    'integrationBranch', 'worktreeIsolation', 'worktreeBase', 'notIntegratedSalvageAgeHours',
    'worktreeRecoveryRetentionAgeHours', 'autoApproveTestScope', 'autoApproveScope', 'worktreeSetup', 'worktreeDependencyPaths'],
};
const NULL_NONMUTATING_BOARD_FIELDS = new Set(['alwaysInScope', 'integrationMode', 'integrationBranch']);

function toolMutates(name: string, args: Record<string, unknown> = {}) {
  if (MUTATING_TOOLS.has(name)) return true;
  const fields = CONDITIONAL_MUTATION_FIELDS[name];
  if (!fields) return false;
  return fields.some((field) => {
    if (args[field] === undefined) return false;
    if (name === 'board_config' && args[field] === null) return !NULL_NONMUTATING_BOARD_FIELDS.has(field);
    return true;
  });
}

function mutationQueueKey(name?: any, args?: any) {
  if (name === 'new_board_profile') return '<global>';
  if (GLOBAL_MUTATION_TOOLS.has(String(name)) && args.project == null) return '<global>';
  const board = resolveProject(args.project).slug;
  // A commit runs the repository's hooks, which can take minutes; in the board-wide queue it held
  // every other write on the board that long (GH-314). Its own board writes take the ticket lock.
  return name === 'commit' ? `${board}\0commit\0${args.ref}` : board;
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
  add: { story: 'storyId' },
  comment: { message: 'body', m: 'body' },
  link: { type: 'verb', target: 'to', ref: 'from' },
  story_log: { append: 'entry' },
  unlink: { from: 'a', to: 'b' },
};

const REQUIRED_ARGUMENT_HINTS: Record<string, string> = {
  pulse: 'pulse reads one ticket; for a project-wide liveness/progress read call changes.',
};

// The skill's invocation-contracts reference is drift-tested against these two, so a caller never reads a
// synonym list that the validator has since stopped accepting.
const COERCED_PRIORITY: { from: string; to: string } = { from: 'medium', to: 'normal' };

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
  if (args.priority === COERCED_PRIORITY.from) {
    args.priority = COERCED_PRIORITY.to;
    aliases.push(`accepted priority "${COERCED_PRIORITY.from}" as "${COERCED_PRIORITY.to}"`);
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties || {}));
  if (tool.name === 'dispatch') allowed.add('session');
  const properties = tool.inputSchema.properties || {};
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (tool.name === 'board_config' && unknown.length === 1 && unknown[0] === 'action' && args.action === 'get') {
    throw new Error('board_config: "action" is unsupported; call with no arguments to read board settings.');
  }
  if (unknown.length) {
    const quoted = unknown.map((key) => `"${key}"`).join(', ');
    const accepted = Object.keys(properties).join(', ');
    const suggestion = unknown.length === 1 && unknown[0] !== undefined ? argumentSuggestion(unknown[0], allowed) : '';
    throw new Error(`${tool.name}: unknown argument${unknown.length === 1 ? '' : 's'} ${quoted} — ${tool.name} accepts: ${accepted}.${suggestion}`);
  }
  const missing = (tool.inputSchema.required || []).filter((key: string) => args[key] === undefined);
  if (missing.length) {
    const names = missing.map((key: string) => `"${key}"`).join(', ');
    const argument = missing.length === 1 ? 'argument' : 'arguments';
    const hint = REQUIRED_ARGUMENT_HINTS[tool.name];
    throw new Error(`${tool.name}: missing required ${argument} ${names}${hint ? ` — ${hint}` : '.'}`);
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

function groomCloseArgs(tool: ToolDefinition, args: Record<string, unknown>) {
  if (tool.name !== 'groomClose' || String(args.by || '').trim()) return args;
  const sessionId = runtimeSessionId();
  return sessionId ? Object.assign({}, args, { by: sessionId }) : args;
}

async function runTool(tool: ToolDefinition, rawArgs: any) {
  const validated = validateToolArguments(tool, rawArgs);
  const args = groomCloseArgs(tool, validated.args);
  const { aliases } = validated;
  if (!toolMutates(tool.name, args)) {
    const output = await tool.handler(args);
    return acknowledgeAliases(tool.name === 'context_page' ? output : boundedReadPayload(tool.name, output), aliases);
  }
  assertMutationFreshness(args.project);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, async () => acknowledgeAliases(await tool.handler(args), aliases));
}


// compactSchema strips property descriptions, so an authored one that is not repeated here reaches nobody: the
// full attestation grammar has been on `add.verify` in the source all along and three tickets in a row were still
// refused for not knowing it (SQ-1955). Anything a caller cannot get right on the FIRST call belongs in this table.
const ATTESTATION_VERIFY_CONTRACT = 'For attestation: `attestation: <attestationArtifact verbatim> | <evidence produced> | <what it showed>`.';
// A rebased or squash-merged candidate never byte-matches the working tree, and the
// refusal only reaches an operator who already knows these two properties exist.
const DELIVERY_REVISION_CONTRACT = 'Landed revision reachable from the target, never an ancestor of the candidate base; proves each submitted path at its tree, not the working tree. Ignored when reachable.';
const RESOLVED_PATHS_CONTRACT = 'Diverging submitted paths resolved by hand; needs deliveryRevision, refused when reachable. reason is the evidence.';

const MCP_SCHEMA_PROPERTY_DESCRIPTIONS: Record<string, Record<string, string>> = {
  context_page: {
    limit: 'UTF-8 bytes.',
  },
  add: { complexity: 'Legacy score; why required.', verify: ATTESTATION_VERIFY_CONTRACT },
  claim: { force: 'Operator-only.' },
  update: {
    verify: ATTESTATION_VERIFY_CONTRACT,
    addFiles: 'Appends, keeps rest. Refused with files. Applied before removeFiles.',
    removeFiles: 'Drops only these, keeps rest. Refused with files, and for a path this ticket does not declare. An isolated live dispatch loses them at once; a shared-tree one keeps them until redispatch.',
  },
  supersede_submission: { supersededBy: 'Repair ticket ref, not a commit.' },
  comments: {
    since: 'Comment id or ISO timestamp.',
  },
  list: {
    detail: 'Full comments.',
    brief: 'One compact row per ticket.',
  },
  release: {
    command: 'Required for blocker/contradiction.',
    outputTail: 'Required blocker/contradiction output.',
  },
  story_log: { entry: 'Must begin DECISION:, CONSTRAINT:, or DISCOVERY:; max 16,000 UTF-8 bytes.' },
  category_edit: { fallbackModel: 'null clears.' },
  board_config: { verifyEnvironment: 'shared: the pinned command or suite verifier runs in the shared checkout at integrate; executors do not run it. Pinned per dispatch (default isolated).' },
  dispatch: {
    reducedAgentSchema: 'Only when name/mode missing; hook needs agent_id+auto|bypass mode.',
    recoveryEvidence: 'Unverified; preparer retires now, else latest signal grace; bound name only.',
  },
  integrate: {
    deliveryInteractionCommit: 'Reviewed descendant, submitted paths only.',
    deliveryRevision: DELIVERY_REVISION_CONTRACT,
    resolvedPaths: RESOLVED_PATHS_CONTRACT,
  },
  groomClose: {
    deliveryCommit: 'Prepared integration target.',
    deliveryInteractionCommit: 'Reviewed descendant, submitted paths only.',
    deliveryRevision: DELIVERY_REVISION_CONTRACT,
    resolvedPaths: RESOLVED_PATHS_CONTRACT,
    recoveryEvidence: 'Unclaimed: preparing session retires now; others past deadline; CLI too.',
  },
  verdict: {
    outcome: 'Candidate, not reviewer prose.',
    correct: 'Main-thread accepted-to-rejected correction; requires rejected/by/text. expectedVerdictAt: list({ref}).ticket.oracle.verdict.at. Exactly one commit or sourceRevision.',
  },
  scopeRequest: {
    grant: 'Grants every path this claim still has refused; pass no files. Refuses the claim holder’s own by.',
  },
};

function toolDescriptor(tool: ToolDefinition) {
  const inputSchema = compactSchema(tool.inputSchema);
  for (const [property, description] of Object.entries(MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || {})) {
    inputSchema.properties[property].description = description;
  }
  const description = Object.hasOwn(TOOL_DESCRIPTION_OVERRIDES, tool.name)
    ? TOOL_DESCRIPTION_OVERRIDES[tool.name]
    : conciseDescription(tool.description);
  return {
    name: tool.name,
    ...(description ? { description } : {}),
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
  boardMcpSessionId,
  MCP_TOOLS_LIST_MAX_BYTES,
  MCP_TOOLS_LIST_HEADROOM_BYTES,
  ARGUMENT_ALIASES,
  COERCED_PRIORITY,
  TOOLS,
  toolDescriptors,
  toolDescriptorByteReport,
  resolveProject,
  handleRequest,
  serverVersion,
};
