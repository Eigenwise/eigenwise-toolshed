'use strict';

const { HostBridge } = require('./host-bridge.js');
const { CLAUDE_ADAPTER } = require('./agent-handoff.js');

const project = { type: 'string', description: 'Absolute project directory. Omit to use the server-pinned project. A different project is refused; this is a routing boundary, not a filesystem sandbox.' };
const conversationId = { type: 'string', description: 'Bridge-owned conversation UUID returned by start. Existing TUI or arbitrary Claude session IDs are not accepted.' };
const jobId = { type: 'string', description: 'Bridge-owned job UUID. Omit to select the conversation’s latest job.' };
const turnProperties = {
  project,
  adapter: { type: 'string', enum: [CLAUDE_ADAPTER], description: 'Optional receiver adapter; defaults to claude-code. Only that adapter is implemented. Unsupported adapters are refused without fallback; existing provider/model settings remain unchanged.' },
  requestId: { type: 'string', description: 'Client-generated UUIDv4 idempotency key. Retry the exact same request with this ID after an uncertain call; it returns the original job. Reuse with a different payload is refused.' },
  prompt: { type: 'string', minLength: 1, maxLength: 131072, description: 'Message to the real Claude orchestrator; passed as stdin. Do not ask this bridge to impersonate a native Agent executor.' },
  profile: { type: 'string', enum: ['plan', 'work'], description: 'plan: native plan permissions and Read/Glob/Grep built-ins only. work: preserve the project’s current Claude permission policy. Both deny actions that would prompt; neither enables bypass. Installed plugins/hooks/MCP and provider still load normally.' },
  timeoutMs: { type: 'integer', minimum: 100, maximum: 900000, description: 'Host turn runtime limit; default 120000ms.' },
  maxTurns: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum native Claude turns for this message; default 12.' },
};
const lookupProperties = { project, conversationId, jobId };
const tools = [
  { name: 'quartermaster_bridge_start', description: 'Start a new bridge-owned real Claude Code orchestrator conversation. Returns a queued job immediately; use status/result for completion. Exact requestId retries return the same handle without launching another host. Default plan profile. Normal installed plugins/hooks/MCP/provider/auth load; startup can have their usual effects. Native Agent delegation stays inside Claude. A succeeded state means a parsed successful host turn, never accepted task delivery.', inputSchema: { type: 'object', properties: turnProperties, required: ['requestId', 'prompt'], additionalProperties: false }, operation: 'start' },
  { name: 'quartermaster_bridge_followup', description: 'Send another message to the exact bridge-owned Claude conversation with --resume. Requires its previous job to be terminal and serializes turns across bridge processes. Exact requestId retries return the original handle. Retains profile unless explicitly changed. Never attaches to an existing live TUI session or accepts an arbitrary Claude session ID.', inputSchema: { type: 'object', properties: { ...turnProperties, conversationId }, required: ['requestId', 'conversationId', 'prompt'], additionalProperties: false }, operation: 'followup' },
  { name: 'quartermaster_bridge_status', description: 'Read durable bounded job status, timestamps, permission denials and selected loaded-plugin/MCP metadata. A dead owner’s unfinished job becomes interrupted without automatic retry. Work outcome is always unverified by this transport.', inputSchema: { type: 'object', properties: lookupProperties, required: ['conversationId'], additionalProperties: false }, operation: 'status' },
  { name: 'quartermaster_bridge_result', description: 'Read a durable bounded final host response, per-result correlation metadata and errors. terminal:false means work is still pending. Documented indexed result sequences must be contiguous from 0; a legacy stream permits one result. succeeded requires process closure, zero exit status and no earlier native error or permission denial. A final clean response never hides earlier failures. Validate actual artifacts/Sidequest completion separately.', inputSchema: { type: 'object', properties: lookupProperties, required: ['conversationId'], additionalProperties: false }, operation: 'result' },
  { name: 'quartermaster_bridge_cancel', description: 'Cancel only the live child owned by this MCP process, including its process tree. Never kills a PID recovered from disk. Terminal jobs are unchanged; a live foreign-owner job must be cancelled through its owning connection.', inputSchema: { type: 'object', properties: lookupProperties, required: ['conversationId'], additionalProperties: false }, operation: 'cancel' },
];

function validateArguments(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown bridge argument: ${key}`);
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) throw new Error(`Missing required bridge argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property.type === 'string' && typeof value !== 'string') throw new Error(`${key} must be a string.`);
    if (property.type === 'integer' && !Number.isInteger(value)) throw new Error(`${key} must be an integer.`);
    if (property.enum && !property.enum.includes(value)) throw new Error(`${key} must be ${property.enum.join(' or ')}.`);
  }
}

function createMcp(options = {}) {
  const bridge = options.bridge || new HostBridge(options);
  async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } };
    if (message.id == null) return null;
    const response = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return response({ protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'quartermaster-host-bridge', version: '1.0.0' }, instructions: 'One project-pinned native Claude orchestrator bridge. Default plan. Every job response includes the additive eigenwise.agent-handoff v1 receipt: terminal alone does not mean the receiver stopped; use handoff.hostStopped and handoff.safeToResume. Host turn success does not establish accepted task delivery. Only adapter claude-code is implemented; no provider/model fallback. Existing TUI sessions are never attached.' });
    if (message.method === 'ping') return response({});
    if (message.method === 'tools/list') return response({ tools: tools.map(({ operation, ...descriptor }) => descriptor) });
    if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } };
    const tool = tools.find((entry) => entry.name === message.params?.name);
    if (!tool) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown bridge tool.' } };
    try {
      const args = message.params.arguments || {};
      validateArguments(args, tool.inputSchema);
      const result = await bridge[tool.operation](args);
      return response({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
    } catch (error) { return response({ content: [{ type: 'text', text: error.message }], isError: true }); }
  }
  return { bridge, handle, close: () => bridge.close() };
}

module.exports = { createMcp, tools, validateArguments };
