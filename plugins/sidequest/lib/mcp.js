"use strict";
const path = require("path");
const store = require("./store");
const { compactSchema, conciseDescription, resolveProject, TOOL_DESCRIPTION_OVERRIDES, boundedReadPayload } = require("./mcp-shared");
const { sidequestMutationFreshness } = require("./plugin-freshness");
const { tools: readTools } = require("./mcp-read");
const { tools: ticketTools } = require("./mcp-tickets");
const { tools: lifecycleTools } = require("./mcp-lifecycle");
const { tools: collaborationTools } = require("./mcp-collaboration");
const { tools: routingTools } = require("./mcp-routing");
const SERVER_NAME = "sidequest";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MCP_TOOLS_LIST_MAX_BYTES = 23600;
const MCP_TOOLS_LIST_HEADROOM_BYTES = 2500;
function serverVersion() {
  try {
    return require("../.claude-plugin/plugin.json").version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}
const TOOLS = [
  ...readTools,
  ...ticketTools,
  ...lifecycleTools,
  ...collaborationTools,
  ...routingTools
];
const MCP_CLI_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "native_agent",
  "native_agent_cleanup"
]);
const TOOL_BY_NAME = new Map(TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map((tool) => [tool.name, tool]));
const MUTATING_TOOLS = /* @__PURE__ */ new Set([
  "add",
  "update",
  "remove",
  "archive",
  "unarchive",
  "claim",
  "sweepClaims",
  "next",
  "done",
  "groomClose",
  "release",
  "commit",
  "submit",
  "supersede_submission",
  "comment",
  "plan",
  "link",
  "unlink",
  "assign",
  "dispatch",
  "category_add",
  "category_edit",
  "category_detach",
  "category_relink",
  "category_rm",
  "profile_create",
  "profile_edit",
  "profile_retire",
  "profile_use",
  "profile_repoint",
  "profile_promote",
  "archive_board",
  "unarchive_board"
]);
const GLOBAL_MUTATION_TOOLS = /* @__PURE__ */ new Set(["category_add", "category_edit", "category_rm", "global_fallback", "profile_create", "profile_edit", "profile_retire", "profile_repoint", "profile_promote"]);
const mutationTails = /* @__PURE__ */ new Map();
function toolMutates(name, args) {
  if (MUTATING_TOOLS.has(String(name))) return true;
  if (name === "new_board_profile") return args.profile !== void 0;
  if (name === "global_fallback") return args.model !== void 0 || args.effort !== void 0;
  if (name === "board_config") return args.name !== void 0 || args.alwaysInScope != null || args.generatedPairs !== void 0 || args.integrationMode != null || args.integrationBranch != null || args.worktreeIsolation !== void 0 || args.worktreeBase !== void 0 || args.notIntegratedSalvageAgeHours !== void 0 || args.worktreeRecoveryRetentionAgeHours !== void 0 || args.worktreeRecoveryRetentionMaxPerAgent !== void 0 || args.autoApproveTestScope !== void 0 || args.autoApproveScope !== void 0 || args.worktreeSetup !== void 0 || args.worktreeDependencyPaths !== void 0;
  return false;
}
function mutationQueueKey(name, args) {
  if (name === "new_board_profile") return "<global>";
  if (GLOBAL_MUTATION_TOOLS.has(String(name)) && args.project == null) return "<global>";
  return resolveProject(args.project).slug;
}
async function enqueueMutation(board, operation) {
  const previous = mutationTails.get(board) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  mutationTails.set(board, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(board) === tail) mutationTails.delete(board);
  }
}
const ARGUMENT_ALIASES = {
  add: { story: "storyId" },
  comment: { message: "body", m: "body" },
  link: { type: "verb", target: "to", ref: "from" },
  story_log: { append: "entry" },
  unlink: { from: "a", to: "b" }
};
const REQUIRED_ARGUMENT_HINTS = {
  pulse: "pulse reads one ticket; for a project-wide liveness/progress read call changes."
};
const COERCED_PRIORITY = { from: "medium", to: "normal" };
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}
function argumentSuggestion(key, allowed) {
  const matches = Array.from(allowed).filter((accepted) => editDistance(key, accepted) <= 2);
  return matches.length === 1 ? ` did you mean ${matches[0]}?` : "";
}
function validateToolArguments(tool, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new Error(`${tool.name}: arguments must be an object.`);
  }
  const args = { ...rawArgs };
  const aliases = [];
  for (const [from, to] of Object.entries(ARGUMENT_ALIASES[tool.name] || {})) {
    if (args[from] === void 0) continue;
    if (args[to] !== void 0) throw new Error(`${tool.name}: pass either ${from} or ${to}, not both.`);
    args[to] = args[from];
    delete args[from];
    aliases.push(`accepted ${from} as ${to}`);
  }
  if (args.priority === COERCED_PRIORITY.from) {
    args.priority = COERCED_PRIORITY.to;
    aliases.push(`accepted priority "${COERCED_PRIORITY.from}" as "${COERCED_PRIORITY.to}"`);
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties || {}));
  if (tool.name === "dispatch") allowed.add("session");
  const properties = tool.inputSchema.properties || {};
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (tool.name === "board_config" && unknown.length === 1 && unknown[0] === "action" && args.action === "get") {
    throw new Error('board_config: "action" is unsupported; call with no arguments to read board settings.');
  }
  if (unknown.length) {
    const quoted = unknown.map((key) => `"${key}"`).join(", ");
    const accepted = Object.keys(properties).join(", ");
    const suggestion = unknown.length === 1 && unknown[0] !== void 0 ? argumentSuggestion(unknown[0], allowed) : "";
    throw new Error(`${tool.name}: unknown argument${unknown.length === 1 ? "" : "s"} ${quoted} — ${tool.name} accepts: ${accepted}.${suggestion}`);
  }
  const missing = (tool.inputSchema.required || []).filter((key) => args[key] === void 0);
  if (missing.length) {
    const names = missing.map((key) => `"${key}"`).join(", ");
    const argument = missing.length === 1 ? "argument" : "arguments";
    const hint = REQUIRED_ARGUMENT_HINTS[tool.name];
    throw new Error(`${tool.name}: missing required ${argument} ${names}${hint ? ` — ${hint}` : "."}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const values = properties[key]?.enum;
    if (value !== void 0 && Array.isArray(values) && !values.includes(value)) {
      throw new Error(`${tool.name}: ${key} received ${JSON.stringify(value)} — must be one of: ${values.join(", ")}.`);
    }
  }
  return { args, aliases };
}
function acknowledgeAliases(output, aliases) {
  return aliases.length && output && typeof output === "object" ? Object.assign(output, { acceptedAliases: aliases }) : output;
}
function mutationProjectPath(projectArg) {
  const project = projectArg == null ? "" : String(projectArg).trim();
  if (project) {
    const known = store.findProject(project);
    if (known.ok) return known.meta.path;
    return path.isAbsolute(project) ? store.nearestRepoRoot(path.resolve(project)) : null;
  }
  return store.nearestRepoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}
function assertMutationFreshness(projectArg) {
  const projectPath = mutationProjectPath(projectArg);
  if (!projectPath) return;
  const freshness = sidequestMutationFreshness(projectPath, {
    pluginRoot: path.join(__dirname, "..")
  });
  if (freshness.refusal) throw new Error(freshness.refusal);
}
async function runTool(tool, rawArgs) {
  const { args, aliases } = validateToolArguments(tool, rawArgs);
  if (!toolMutates(tool.name, args)) {
    const output = await tool.handler(args);
    return acknowledgeAliases(tool.name === "context_page" ? output : boundedReadPayload(tool.name, output), aliases);
  }
  assertMutationFreshness(args.project);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, async () => acknowledgeAliases(await tool.handler(args), aliases));
}
const ATTESTATION_VERIFY_CONTRACT = "verifyKind attestation: `attestation: <attestationArtifact verbatim> | <evidence produced> | <what it showed>`.";
const MCP_SCHEMA_PROPERTY_DESCRIPTIONS = {
  context_page: {
    cursor: "Opaque.",
    limit: "UTF-8 bytes.",
    expectedRevision: "Required revision."
  },
  add: { complexity: "Legacy score; why required.", verify: ATTESTATION_VERIFY_CONTRACT },
  update: { verify: ATTESTATION_VERIFY_CONTRACT },
  supersede_submission: { supersededBy: "Repair ticket ref, not a commit." },
  comments: {
    full: "Whole bodies.",
    since: "Comment id or ISO timestamp."
  },
  list: {
    detail: "Full comments; default for status.",
    brief: "One compact row per ticket."
  },
  release: {
    command: "Required for blocker/contradiction.",
    outputTail: "Required blocker/contradiction output."
  },
  story_log: { entry: "Must begin DECISION:, CONSTRAINT:, or DISCOVERY:; max 16,000 UTF-8 bytes." },
  category_edit: { fallbackModel: "null clears fallback." },
  dispatch: { sharedTree: "Only declared shared checkout. Omit for an isolated checkout. Live claims cannot dispatch.", recoveryEvidence: "Recovery evidence." },
  integrate: { deliveryInteractionCommit: "Reviewed descendant, submitted paths only." },
  groomClose: { deliveryInteractionCommit: "Reviewed descendant, submitted paths only." }
};
function toolDescriptor(tool) {
  const inputSchema = compactSchema(tool.inputSchema);
  for (const [property, description] of Object.entries(MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || {})) {
    inputSchema.properties[property].description = description;
  }
  return {
    name: tool.name,
    description: Object.hasOwn(TOOL_DESCRIPTION_OVERRIDES, tool.name) ? TOOL_DESCRIPTION_OVERRIDES[tool.name] : conciseDescription(tool.description),
    inputSchema
  };
}
function toolDescriptors() {
  return TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map(toolDescriptor);
}
function toolDescriptorByteReport() {
  const tools = toolDescriptors();
  const payloadBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  return {
    maxBytes: MCP_TOOLS_LIST_MAX_BYTES,
    reserveBytes: MCP_TOOLS_LIST_HEADROOM_BYTES,
    payloadBytes,
    headroomBytes: MCP_TOOLS_LIST_MAX_BYTES - payloadBytes,
    tools: tools.map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool), "utf8") })).sort((left, right) => right.bytes - left.bytes)
  };
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
async function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  const isNotification = id === void 0 || id === null;
  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: serverVersion() }
    });
  }
  if (method === "notifications/initialized" || method && method.indexOf("notifications/") === 0) {
    return null;
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, { tools: toolDescriptors() });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = params && params.arguments || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcResult(id, { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true });
    }
    try {
      const out = await runTool(tool, args);
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      const error = e;
      return rpcResult(id, { content: [{ type: "text", text: `${error && error.message || error}` }], isError: true });
    }
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}
module.exports = {
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  MCP_TOOLS_LIST_MAX_BYTES,
  MCP_TOOLS_LIST_HEADROOM_BYTES,
  ARGUMENT_ALIASES,
  COERCED_PRIORITY,
  TOOLS,
  toolDescriptors,
  toolDescriptorByteReport,
  resolveProject,
  handleRequest,
  serverVersion
};
