"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mcp_exports = {};
__export(mcp_exports, {
  codegraphToolDefinitions: () => codegraphToolDefinitions,
  codegraphTools: () => codegraphTools,
  invokeCodegraphTool: () => invokeCodegraphTool
});
module.exports = __toCommonJS(mcp_exports);
var import_cursors = require("./cursors.js");
var import_ranking = require("./ranking.js");
const codegraphTools = [
  "codegraph_status",
  "codegraph_index",
  "codegraph_impact",
  "codegraph_path",
  "codegraph_hierarchy",
  "codegraph_modules",
  "codegraph_context"
];
const edgeKinds = /* @__PURE__ */ new Set(["contains", "imports", "exports", "references", "calls", "extends", "implements", "overrides", "aliases"]);
const nodeKinds = /* @__PURE__ */ new Set(["module", "namespace", "class", "interface", "type", "enum", "function", "method", "constructor", "property", "variable", "parameter"]);
function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function onlyKeys(value, keys) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown parameter: ${key}`);
}
const maximumMcpTextBytes = 64 * 1024;
const maximumSeedFiles = 1e3;
function text(value, label, minimum = 1, maximumBytes = maximumMcpTextBytes) {
  if (typeof value !== "string" || value.trim().length < minimum) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${label} exceeds the input budget`);
  return value;
}
function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
function optionalText(value, label) {
  return value === void 0 ? void 0 : text(value, label);
}
function selector(value, label) {
  const input = object(value, label);
  onlyKeys(input, ["qualifiedName", "file", "kind"]);
  const kind = input.kind;
  if (kind !== void 0 && (typeof kind !== "string" || !nodeKinds.has(kind))) throw new Error(`${label}.kind is invalid`);
  return { qualifiedName: text(input.qualifiedName, `${label}.qualifiedName`), ...input.file === void 0 ? {} : { file: text(input.file, `${label}.file`) }, ...kind === void 0 ? {} : { kind } };
}
function limits(value, allowed) {
  onlyKeys(value, allowed);
  return {
    ...value.maxDepth === void 0 ? {} : { maxDepth: integer(value.maxDepth, "maxDepth", 1, 8) },
    ...value.tokenBudget === void 0 ? {} : { tokenBudget: integer(value.tokenBudget, "tokenBudget", 500, 16e3) },
    ...value.maxResults === void 0 ? {} : { maxResults: integer(value.maxResults, "maxResults", 1, 1e3) },
    ...value.cursor === void 0 ? {} : { cursor: text(value.cursor, "cursor", 1, import_cursors.maximumCursorBytes) }
  };
}
function traversal(value, allowed) {
  const parsed = limits(value, allowed);
  const direction = value.direction;
  if (direction !== void 0 && direction !== "forward" && direction !== "reverse" && direction !== "both") throw new Error("direction must be forward, reverse, or both");
  const kinds = value.edgeKinds;
  if (kinds !== void 0 && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string" || !edgeKinds.has(kind)))) throw new Error("edgeKinds contains an invalid edge kind");
  return { ...parsed, ...direction === void 0 ? {} : { direction }, ...kinds === void 0 ? {} : { edgeKinds: [...kinds] } };
}
function result(response) {
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, "utf8") > import_ranking.maximumResponseBytes) throw new Error("Codegraph response exceeded the output budget");
  const status = object(response, "response").status;
  return { content: [{ type: "text", text: serialized }], structuredContent: response, ...status === "error" || status === "unavailable" ? { isError: true } : {} };
}
async function invokeCodegraphTool(service, name, arguments_ = {}) {
  const input = object(arguments_, "arguments");
  if (!codegraphTools.includes(name)) throw new Error(`unknown Codegraph tool: ${name}`);
  if (name === "codegraph_status") {
    onlyKeys(input, []);
    return result(await service.status());
  }
  if (name === "codegraph_index") {
    onlyKeys(input, []);
    return result(await service.index());
  }
  if (name === "codegraph_impact") {
    onlyKeys(input, ["symbol", "direction", "edgeKinds", "maxDepth", "tokenBudget", "maxResults", "cursor"]);
    const { symbol, ...options } = input;
    return result(await service.impact(selector(symbol, "symbol"), traversal(options, ["direction", "edgeKinds", "maxDepth", "tokenBudget", "maxResults", "cursor"])));
  }
  if (name === "codegraph_path") {
    onlyKeys(input, ["from", "to", "edgeKinds", "maxDepth", "tokenBudget", "maxResults", "cursor"]);
    const { from, to, ...options } = input;
    return result(await service.path(selector(from, "from"), selector(to, "to"), traversal(options, ["edgeKinds", "maxDepth", "tokenBudget", "maxResults", "cursor"])));
  }
  if (name === "codegraph_hierarchy") {
    onlyKeys(input, ["symbol", "direction", "maxDepth", "tokenBudget", "maxResults", "cursor"]);
    const { symbol, ...options } = input;
    return result(await service.hierarchy(selector(symbol, "symbol"), traversal(options, ["direction", "maxDepth", "tokenBudget", "maxResults", "cursor"])));
  }
  if (name === "codegraph_modules") {
    onlyKeys(input, ["mode", "tokenBudget", "maxResults", "cursor"]);
    const mode = input.mode;
    if (mode !== "cycles" && mode !== "layers" && mode !== "fanout") throw new Error("mode must be cycles, layers, or fanout");
    return result(await service.modules(mode, limits(input, ["mode", "tokenBudget", "maxResults", "cursor"])));
  }
  onlyKeys(input, ["query", "seedFiles", "maxDepth", "tokenBudget", "maxResults", "cursor"]);
  if (input.seedFiles !== void 0) {
    if (!Array.isArray(input.seedFiles) || input.seedFiles.length > maximumSeedFiles) throw new Error(`seedFiles must contain at most ${maximumSeedFiles} entries`);
    for (const file of input.seedFiles) text(file, "seedFiles entry", 1);
  }
  return result(await service.context(text(input.query, "query"), { ...limits(input, ["query", "seedFiles", "maxDepth", "tokenBudget", "maxResults", "cursor"]), ...input.seedFiles === void 0 ? {} : { seedFiles: input.seedFiles } }));
}
const selectorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["qualifiedName"],
  properties: { qualifiedName: { type: "string", minLength: 1, maxLength: maximumMcpTextBytes }, file: { type: "string", minLength: 1, maxLength: maximumMcpTextBytes }, kind: { type: "string", enum: [...nodeKinds] } }
};
const limitsSchema = {
  maxDepth: { type: "integer", minimum: 1, maximum: 8 },
  tokenBudget: { type: "integer", minimum: 500, maximum: 16e3 },
  maxResults: { type: "integer", minimum: 1, maximum: 1e3 },
  cursor: { type: "string", minLength: 1, maxLength: import_cursors.maximumCursorBytes }
};
function toolSchema(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, ...required.length === 0 ? {} : { required } };
}
const codegraphToolDefinitions = [
  { name: "codegraph_status", description: "Read Codegraph availability, snapshot, and coverage.", inputSchema: toolSchema({}) },
  { name: "codegraph_index", description: "Build a fresh Codegraph snapshot.", inputSchema: toolSchema({}) },
  { name: "codegraph_impact", description: "Traverse callers and dependents of a symbol.", inputSchema: toolSchema({ symbol: selectorSchema, direction: { enum: ["forward", "reverse", "both"] }, edgeKinds: { type: "array", items: { enum: [...edgeKinds] } }, ...limitsSchema }, ["symbol"]) },
  { name: "codegraph_path", description: "Find the shortest resolved path between two symbols.", inputSchema: toolSchema({ from: selectorSchema, to: selectorSchema, edgeKinds: { type: "array", items: { enum: [...edgeKinds] } }, ...limitsSchema }, ["from", "to"]) },
  { name: "codegraph_hierarchy", description: "Traverse type extension and implementation relationships.", inputSchema: toolSchema({ symbol: selectorSchema, direction: { enum: ["forward", "reverse", "both"] }, ...limitsSchema }, ["symbol"]) },
  { name: "codegraph_modules", description: "Report import cycles, layers, or fanout.", inputSchema: toolSchema({ mode: { enum: ["cycles", "layers", "fanout"] }, tokenBudget: limitsSchema.tokenBudget, maxResults: limitsSchema.maxResults, cursor: limitsSchema.cursor }, ["mode"]) },
  { name: "codegraph_context", description: "Rank lexical and graph-adjacent context.", inputSchema: toolSchema({ query: { type: "string", minLength: 1, maxLength: maximumMcpTextBytes }, seedFiles: { type: "array", maxItems: maximumSeedFiles, items: { type: "string", minLength: 1, maxLength: maximumMcpTextBytes } }, ...limitsSchema }, ["query"]) }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  codegraphToolDefinitions,
  codegraphTools,
  invokeCodegraphTool
});
