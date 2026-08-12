'use strict';

const fs = require('node:fs');
const path = require('node:path');

const registry = require('./project-registry');
const { languageForFile } = require('./language-server-locator');
const cpp = require('./language-server-locators/cpp');

const SERVER_NAME = 'code-intel';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const MAX_DEFINITIONS = 50;
const MAX_REFERENCES = 200;
const MAX_DIAGNOSTICS_PER_FILE = 100;
const MAX_MESSAGE_CHARS = 400;
const MAX_FILES_PER_CALL = 16;
const MAX_RESPONSE_CHARS = 40_000;

// The same complete-message limit bounds inbound wire text. A longer raw line
// is refused before it is buffered any further or parsed, so a writer that
// never sends a newline can neither grow the stdio buffer nor reach
// JSON.parse.
const MAX_REQUEST_CHARS = MAX_RESPONSE_CHARS;

const SEVERITY_NAMES = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' };

function serverVersion() {
  try {
    return require('../../.claude-plugin/plugin.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function comparablePath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

// path.relative output escapes the root only when it is exactly `..` or
// begins with a `..` path component; a bare startsWith('..') test would also
// reject valid in-root names such as `..in-root.ts`. An absolute result means
// a different drive on Windows.
function isUnderRoot(rootDir, realTarget) {
  const relative = path.relative(comparablePath(rootDir), comparablePath(realTarget));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative);
}

function resolveFileUnderRoot(rootDir, rawFile) {
  if (typeof rawFile !== 'string' || !rawFile.trim()) {
    throw new Error('file is required: pass a path inside the bound project root.');
  }
  const resolved = path.resolve(rootDir, rawFile.trim());
  let realFile;
  try {
    realFile = fs.realpathSync.native(resolved);
  } catch {
    throw new Error(`file not found: ${capText(resolved)}`);
  }
  if (!fs.statSync(realFile).isFile()) {
    throw new Error(`not a file: ${capText(realFile)}`);
  }
  if (!isUnderRoot(rootDir, realFile)) {
    throw new Error(`file is outside the project root this request is bound to: ${capText(realFile)} is not under ${capText(rootDir)}. Each request may only target files inside its own root; send a separate request bound to that file's root.`);
  }
  return realFile;
}

function bindProject(args) {
  const canonical = registry.canonicalizeRoot(args.root);
  if (canonical.error) throw new Error(canonical.error);
  return canonical;
}

function clientFor(rootDir, file) {
  const language = languageForFile(file);
  if (!language) throw new Error(`No language server is available for ${path.extname(file) || 'files without an extension'}.`);
  if (language === 'cpp') {
    const compileDatabase = cpp.validateFile(rootDir, file);
    if (compileDatabase.error) throw new Error(compileDatabase.error);
  }
  const bound = registry.clientForRoot(rootDir, language, file);
  if (bound.error) throw new Error(bound.error);
  return bound.client;
}

function capText(text) {
  const value = String(text ?? '');
  return value.length > MAX_MESSAGE_CHARS ? value.slice(0, MAX_MESSAGE_CHARS) + '…' : value;
}

// Responses are root-bound: a real TypeScript server can resolve declarations
// into inherited node_modules, lib files, or mapped paths outside the request's
// root, and a malformed frame can carry an arbitrary or oversized URI. A kept
// location must be an existing file whose native realpath is under the
// canonical root, so non-file URIs (file: null), targets that are missing or
// unreadable, and junction or symlink paths that escape the root are withheld
// and counted, never resolved against the process cwd.
function keepOnlyLocationsUnderRoot(rootDir, locations) {
  const locationsUnderRoot = [];
  let withheldOutsideRoot = 0;
  const realTargetByResolvedPath = new Map();
  for (const location of locations) {
    const realTarget = typeof location.file === 'string'
      ? realLocationTarget(rootDir, location.file, realTargetByResolvedPath)
      : null;
    if (realTarget === null || !isUnderRoot(rootDir, realTarget)) {
      withheldOutsideRoot += 1;
      continue;
    }
    locationsUnderRoot.push({ ...location, file: capText(realTarget) });
  }
  return { locationsUnderRoot, withheldOutsideRoot };
}

// A missing or unreadable target fails closed to null: it is withheld and
// counted, and the claimed path never appears in a response or error message.
function realLocationTarget(rootDir, claimedFile, realTargetByResolvedPath) {
  const resolved = path.resolve(rootDir, claimedFile);
  if (!realTargetByResolvedPath.has(resolved)) {
    let realTarget;
    try {
      realTarget = fs.realpathSync.native(resolved);
    } catch {
      realTarget = null;
    }
    realTargetByResolvedPath.set(resolved, realTarget);
  }
  return realTargetByResolvedPath.get(resolved);
}

const ERROR_TRUNCATION_SUFFIX = '… [error truncated to fit the response budget]';

// Headroom inside MAX_RESPONSE_CHARS for the JSON-RPC frame and a maximal
// bounded id, so the complete serialized envelope also fits the budget.
const ENVELOPE_RESERVE_CHARS = 1_024;

// fitResponseBudget never sees a thrown error, and an argument echo or a
// backend server message can carry unbounded text whose JSON escaping can
// multiply its serialized size, so every error response is bounded here by
// the serialized length it will add to the complete envelope.
function boundedErrorText(error) {
  const text = `${(error && error.message) || error}`;
  const serializedLimit = MAX_RESPONSE_CHARS - ENVELOPE_RESERVE_CHARS;
  if (JSON.stringify(text).length <= serializedLimit) return text;
  let keep = Math.max(0, serializedLimit - ERROR_TRUNCATION_SUFFIX.length);
  for (;;) {
    const candidate = text.slice(0, keep) + ERROR_TRUNCATION_SUFFIX;
    const serializedOverrun = JSON.stringify(candidate).length - serializedLimit;
    if (serializedOverrun <= 0 || keep === 0) return candidate;
    keep = Math.max(0, keep - serializedOverrun);
  }
}

// The parse boundary for wire text: invalid JSON becomes undefined, matching
// the silent drop the stdio loop has always applied to a frame it cannot
// read.
function parseMessage(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A refused line was never parsed, so there is no id to echo and no fragment
// of it may appear in the answer.
function oversizedRequestLineError() {
  return rpcError(null, -32600, `Invalid Request: a request line must stay within ${MAX_REQUEST_CHARS} characters; this one was refused unparsed and answered with the null id.`);
}

// JSON-RPC permits only string, number, or null request ids (a message with
// no id member is a notification, and a present null id is a real request
// whose response echoes null), and it says a numeric id should carry no
// fractional part because implementations handle fractions inconsistently.
// Numbers are therefore accepted only as safe integers: a fractional,
// non-finite, or out-of-range number cannot survive JSON.parse and
// JSON.stringify unchanged, so echoing it would name an id the caller never
// sent. JSON.stringify(Infinity) is even "null", which would claim the null
// id was used. A string id whose serialized form could crowd the response
// budget is refused for that envelope reason. JSON-RPC answers a request
// whose id cannot be used with the null id.
function usableRequestId(id) {
  if (id === null) return true;
  if (typeof id === 'number') return Number.isSafeInteger(id);
  return typeof id === 'string' && JSON.stringify(id).length <= MAX_MESSAGE_CHARS;
}

// A numeric id keys by the value it represents, so a cancellation naming
// 1000 finds the in-flight call sent as 1e3. The prefixes keep numeric,
// string, and null ids in separate key spaces.
function requestIdKey(id) {
  if (typeof id === 'number') return 'n:' + id;
  if (typeof id === 'string') return 's:' + id;
  return 'null';
}

const PROTOCOL_VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// MCP echoes a requested protocol version only when the server can honor it;
// any other shape — including oversized junk that would push the initialize
// envelope past the response budget — gets the server's own version back.
function echoableProtocolVersion(requested) {
  return typeof requested === 'string' && PROTOCOL_VERSION_SHAPE.test(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

// The budget holds for the complete serialized envelope: the payload is
// emitted pretty-printed inside a JSON string, where newlines, quotes, and
// Windows path backslashes escape and inflate it well past its compact
// length, so the loop measures the exact serialized text the envelope will
// carry, under the same headroom that bounds error responses.
function fitResponseBudget(payload, shrinkOneArray) {
  const serializedLimit = MAX_RESPONSE_CHARS - ENVELOPE_RESERVE_CHARS;
  while (JSON.stringify(JSON.stringify(payload, null, 2)).length > serializedLimit) {
    if (!shrinkOneArray(payload)) {
      throw new Error(`response for ${payload.root} exceeded the ${MAX_RESPONSE_CHARS}-character budget and could not shrink further; narrow the request to fewer files or a more specific position.`);
    }
    payload.truncated = true;
  }
  return payload;
}

function halveInPlace(list) {
  if (!Array.isArray(list) || list.length <= 1) return false;
  list.length = Math.ceil(list.length / 2);
  return true;
}

function boundedDiagnosticCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string') return capText(code);
  return null;
}

function formatDiagnostic(diagnostic) {
  return {
    severity: SEVERITY_NAMES[diagnostic.severity] || 'error',
    code: boundedDiagnosticCode(diagnostic.code),
    message: capText(diagnostic.message),
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
}

async function runDefinition(args, signal) {
  const { rootDir } = bindProject(args);
  const file = resolveFileUnderRoot(rootDir, args.file);
  const client = clientFor(rootDir, file);
  const located = await client.definition(file, args.line, args.column, signal);
  const { locationsUnderRoot, withheldOutsideRoot } = keepOnlyLocationsUnderRoot(rootDir, located);
  const payload = {
    root: rootDir,
    file,
    backend: client.backend,
    definitions: locationsUnderRoot.slice(0, MAX_DEFINITIONS),
  };
  if (withheldOutsideRoot) payload.withheldOutsideRoot = withheldOutsideRoot;
  if (locationsUnderRoot.length > MAX_DEFINITIONS) {
    payload.truncated = true;
    payload.totalDefinitions = locationsUnderRoot.length;
  }
  return fitResponseBudget(payload, (current) => halveInPlace(current.definitions));
}

async function runReferences(args, signal) {
  const { rootDir } = bindProject(args);
  const file = resolveFileUnderRoot(rootDir, args.file);
  const client = clientFor(rootDir, file);
  const located = await client.references(file, args.line, args.column, signal);
  const { locationsUnderRoot, withheldOutsideRoot } = keepOnlyLocationsUnderRoot(rootDir, located);
  const payload = {
    root: rootDir,
    file,
    backend: client.backend,
    total: locationsUnderRoot.length,
    references: locationsUnderRoot.slice(0, MAX_REFERENCES),
  };
  if (withheldOutsideRoot) payload.withheldOutsideRoot = withheldOutsideRoot;
  if (client.backend === 'clangd' && client.indexStatus().active) {
    payload.incomplete = true;
    payload.incompleteReason = 'clangd background index is still warming; retry for complete project-wide references or narrow the query.';
  }
  if (locationsUnderRoot.length > MAX_REFERENCES) payload.truncated = true;
  return fitResponseBudget(payload, (current) => halveInPlace(current.references));
}

async function runDiagnostics(args, signal) {
  const { rootDir } = bindProject(args);
  const files = args.files.map((file) => resolveFileUnderRoot(rootDir, file));
  const clientsByLanguage = new Map();
  const clientForFile = (file) => {
    const language = languageForFile(file);
    if (!language) return clientFor(rootDir, file);
    if (!clientsByLanguage.has(language)) clientsByLanguage.set(language, clientFor(rootDir, file));
    return clientsByLanguage.get(language);
  };
  for (const file of files) clientForFile(file);
  const results = [];
  let totalDiagnostics = 0;
  for (const file of files) {
    try {
      const diagnostics = await clientForFile(file).diagnostics(file, signal);
      totalDiagnostics += diagnostics.length;
      const entry = { file, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE).map(formatDiagnostic) };
      if (diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
        entry.truncated = true;
        entry.totalDiagnostics = diagnostics.length;
      }
      results.push(entry);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      results.push({ file, error: capText(error.message) });
    }
  }
  const payload = {
    root: rootDir,
    backend: clientsByLanguage.size === 1 ? clientsByLanguage.values().next().value.backend : undefined,
    totalDiagnostics,
    files: results,
  };
  return fitResponseBudget(payload, (current) => {
    let longest = null;
    for (const entry of current.files) {
      if (Array.isArray(entry.diagnostics) && (!longest || entry.diagnostics.length > longest.diagnostics.length)) {
        longest = entry;
      }
    }
    return longest ? halveInPlace(longest.diagnostics) : false;
  });
}

const ROOT_DESCRIPTION = 'Absolute project root (checkout or worktree) this request binds to. Results are computed in and returned to this call only; roots never share language-server state.';
const FILE_DESCRIPTION = 'File to query, absolute or relative to root. Must be inside root.';

const TOOLS = [
  {
    name: 'definition',
    description: 'Find where the symbol at a position is defined, via the language server for the file extension. Pull-only and local: results arrive in this response only, and a location is returned only when its native realpath (symlinks and junctions resolved) is an existing file inside the bound root; non-file URIs, missing targets, and anything outside are withheld (counted in withheldOutsideRoot). Lines and columns are 1-based.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESCRIPTION },
        file: { type: 'string', description: FILE_DESCRIPTION },
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
      },
      required: ['root', 'file', 'line', 'column'],
    },
    handler: runDefinition,
  },
  {
    name: 'references',
    description: 'List every reference to the symbol at a position, via the language server for the file extension. Pull-only and local: results arrive in this response only, and a location is returned only when its native realpath (symlinks and junctions resolved) is an existing file inside the bound root; non-file URIs, missing targets, and anything outside are withheld (counted in withheldOutsideRoot). Lines and columns are 1-based.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESCRIPTION },
        file: { type: 'string', description: FILE_DESCRIPTION },
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
      },
      required: ['root', 'file', 'line', 'column'],
    },
    handler: runReferences,
  },
  {
    name: 'diagnostics',
    description: 'Check the named files on demand and return their current errors, warnings, and hints through the language server for each file extension. Pull-only and local: diagnostics are computed for this call and returned only here, never pushed into any transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: ROOT_DESCRIPTION },
        files: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_FILES_PER_CALL,
          description: 'Files to check, absolute or relative to root. Each must be inside root.',
        },
      },
      required: ['root', 'files'],
    },
    handler: runDiagnostics,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function validateToolArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${tool.name}: arguments must be an object.`);
  }
  const properties = tool.inputSchema.properties;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length) {
    const quoted = unknown.map((key) => `"${key}"`).join(', ');
    throw new Error(`${tool.name}: unknown argument${unknown.length === 1 ? '' : 's'} ${quoted} — ${tool.name} accepts: ${Object.keys(properties).join(', ')}.`);
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined) throw new Error(`${tool.name}: ${required} is required.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (value === undefined) continue;
    if (schema.type === 'string' && typeof value !== 'string') {
      throw new Error(`${tool.name}: ${key} must be a string.`);
    }
    if (schema.type === 'integer' && (!Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum))) {
      throw new Error(`${tool.name}: ${key} must be an integer >= ${schema.minimum ?? 0}.`);
    }
    if (schema.type === 'array') {
      const usable = Array.isArray(value)
        && value.length >= (schema.minItems ?? 0)
        && value.length <= (schema.maxItems ?? Infinity)
        && value.every((item) => typeof item === 'string');
      if (!usable) {
        throw new Error(`${tool.name}: ${key} must be an array of 1 to ${schema.maxItems} strings.`);
      }
    }
  }
}

function toolDescriptors() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.inputSchema, additionalProperties: false },
  }));
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const inFlightToolCalls = new Map();

async function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0') return null;
  const { id, method, params } = message;
  // A present top-level id is validated before any method branch so an
  // unusable id can never ride a side-effecting method: an object-id
  // cancellation frame is refused right here, before the abort below could
  // honor its otherwise-valid requestId.
  if (id !== undefined && !usableRequestId(id)) {
    return rpcError(null, -32600, `Invalid Request: a JSON-RPC id must be a string, a safe-integer number, or null, since a fractional, non-finite, or out-of-range number cannot be echoed back as the same value, and a string id's serialized form must stay within ${MAX_MESSAGE_CHARS} characters so a response can echo it inside the ${MAX_RESPONSE_CHARS}-character envelope budget; the request is refused with the null id.`);
  }
  if (method === 'notifications/cancelled') {
    // The requestId is validated with the same rule as request ids before it
    // may touch the in-flight map: an unusable shape must never reach the
    // lookup or trigger an abort, and a bare `params && params.requestId`
    // would turn a null params into a null lookup that aborts a legitimate
    // null-id call.
    const requestId = params && typeof params === 'object' ? params.requestId : undefined;
    if (usableRequestId(requestId)) {
      const cancelled = inFlightToolCalls.get(requestIdKey(requestId));
      if (cancelled) cancelled.abort();
    }
    return null;
  }
  // A message whose id member is absent is a JSON-RPC notification: it must
  // never be answered with a response frame, and a tool call whose result
  // nobody could receive is never dispatched. A present null id is not a
  // notification.
  if (id === undefined) return null;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: echoableProtocolVersion(params && params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: serverVersion() },
    });
  }
  if (method && method.indexOf('notifications/') === 0) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: toolDescriptors() });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcResult(id, { content: [{ type: 'text', text: `Unknown tool "${capText(name)}".` }], isError: true });
    }
    const cancellation = new AbortController();
    const inFlightKey = requestIdKey(id);
    inFlightToolCalls.set(inFlightKey, cancellation);
    try {
      validateToolArguments(tool, args);
      const output = await tool.handler(args, cancellation.signal);
      if (cancellation.signal.aborted) return null;
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] });
    } catch (error) {
      if (cancellation.signal.aborted) return null;
      return rpcResult(id, { content: [{ type: 'text', text: boundedErrorText(error) }], isError: true });
    } finally {
      inFlightToolCalls.delete(inFlightKey);
    }
  }
  return rpcError(id, -32601, `Method not found: ${capText(method)}`);
}

module.exports = {
  SERVER_NAME,
  DEFAULT_PROTOCOL_VERSION,
  TOOLS,
  toolDescriptors,
  handleRequest,
  parseMessage,
  oversizedRequestLineError,
  serverVersion,
  resolveFileUnderRoot,
  MAX_FILES_PER_CALL,
  MAX_REQUEST_CHARS,
  MAX_RESPONSE_CHARS,
};
