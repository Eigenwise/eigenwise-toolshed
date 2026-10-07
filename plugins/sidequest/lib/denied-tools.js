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
var denied_tools_exports = {};
__export(denied_tools_exports, {
  deniedToolMatch: () => deniedToolMatch,
  normalizeDeniedTools: () => normalizeDeniedTools
});
module.exports = __toCommonJS(denied_tools_exports);
const BOARD_TOOL_PREFIX = "mcp__plugin_sidequest_board";
function deniedToolPattern(entry, label) {
  const pattern = String(entry ?? "").trim();
  if (!/^[A-Za-z][\w.:-]*$/.test(pattern)) throw new Error(`${label} entries must be tool names or MCP prefixes: ${String(entry)}`);
  if (pattern.startsWith(BOARD_TOOL_PREFIX)) throw new Error(`${label} cannot deny the Sidequest board tools executors need to claim and close: ${pattern}`);
  return pattern;
}
function normalizeDeniedTools(value, label = "deniedTools") {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of tool names.`);
  return [...new Set(value.map((entry) => deniedToolPattern(entry, label)))];
}
function toolDeniedBy(toolName, pattern) {
  return toolName === pattern || toolName.startsWith(`${pattern}__`);
}
function deniedToolMatch(toolName, patterns) {
  return patterns.find((pattern) => toolDeniedBy(toolName, pattern)) ?? null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deniedToolMatch,
  normalizeDeniedTools
});
