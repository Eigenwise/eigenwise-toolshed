"use strict";
const { compactSchema, conciseDescription, resolveProject, TOOL_DESCRIPTION_OVERRIDES, state } = require("./mcp-shared");
state.categoryListServed = false;
const { tools: readTools } = require("./mcp-read");
const { tools: ticketTools } = require("./mcp-tickets");
const { tools: lifecycleTools } = require("./mcp-lifecycle");
const { tools: collaborationTools } = require("./mcp-collaboration");
const { tools: routingTools } = require("./mcp-routing");
const SERVER_NAME = "sidequest";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
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
  if (name === "board_config") return args.name !== void 0 || args.alwaysInScope != null || args.generatedPairs !== void 0 || args.integrationMode != null || args.integrationBranch != null || args.worktreeIsolation !== void 0 || args.autoApprovePluginTests !== void 0 || args.worktreeSetup !== void 0;
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
async function runTool(tool, args) {
  if (!toolMutates(tool.name, args)) return await tool.handler(args);
  const board = mutationQueueKey(tool.name, args);
  return enqueueMutation(board, () => tool.handler(args));
}
const MCP_SCHEMA_PROPERTY_DESCRIPTIONS = {
  add: ["complexity"],
  comments: ["full"],
  list: ["detail"]
};
function toolDescriptors() {
  return TOOLS.filter((tool) => !MCP_CLI_ONLY_TOOLS.has(tool.name)).map((tool) => {
    const inputSchema = compactSchema(tool.inputSchema);
    for (const property of MCP_SCHEMA_PROPERTY_DESCRIPTIONS[tool.name] || []) {
      const description = tool.inputSchema.properties?.[property]?.description;
      if (description) inputSchema.properties[property].description = description;
    }
    return {
      name: tool.name,
      description: TOOL_DESCRIPTION_OVERRIDES[tool.name] || conciseDescription(tool.description),
      inputSchema
    };
  });
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
  TOOLS,
  toolDescriptors,
  resolveProject,
  handleRequest,
  serverVersion
};
