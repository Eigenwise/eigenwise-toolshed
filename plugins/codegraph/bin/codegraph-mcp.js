#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_node_readline = require("node:readline");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("../lib/paths.js");
var import_mcp = require("../lib/mcp.js");
var import_language_providers = require("../lib/language-providers.js");
var import_service = require("../lib/service.js");
var import_store = require("../lib/store.js");
const maximumJsonRpcRequestBytes = 1024 * 1024;
const projectRoot = process.env.CODEGRAPH_PROJECT_ROOT ?? process.cwd();
const stateDirectory = (0, import_paths.projectStateDirectory)(projectRoot);
const runtimeStateDirectory = (0, import_paths.codegraphStateRoot)();
const store = import_store.GraphStore.open(import_node_path.default.join(stateDirectory, "graph.sqlite"));
const providers = (0, import_language_providers.defaultLanguageProviders)(runtimeStateDirectory);
const service = new import_service.CodegraphService({ projectRoot, store, providers });
function send(id, value) {
  if (id !== void 0) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...value })}
`);
}
async function handle(request) {
  try {
    if (request.method === "initialize") {
      send(request.id, { result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codegraph", version: "1.0.0" } } });
      return;
    }
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") {
      send(request.id, { result: { tools: import_mcp.codegraphToolDefinitions } });
      return;
    }
    if (request.method === "tools/call") {
      const parameters = request.params;
      if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || !("name" in parameters) || typeof parameters.name !== "string") throw new Error("tools/call requires a tool name");
      const toolParameters = parameters;
      send(request.id, { result: await (0, import_mcp.invokeCodegraphTool)(service, toolParameters.name, toolParameters.arguments) });
      return;
    }
    throw new Error(`unsupported method: ${request.method}`);
  } catch (error) {
    send(request.id, { error: { code: -32602, message: error instanceof Error ? error.message : "invalid request" } });
  }
}
(0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  try {
    if (Buffer.byteLength(line, "utf8") > maximumJsonRpcRequestBytes) throw new Error("JSON-RPC request exceeds the input budget");
    const request = JSON.parse(line);
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new Error("invalid JSON-RPC request");
    void handle(request);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: error instanceof Error ? error.message : "parse error" } })}
`);
  }
});
process.once("exit", () => store.close());
