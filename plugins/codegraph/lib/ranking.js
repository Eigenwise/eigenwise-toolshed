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
var ranking_exports = {};
__export(ranking_exports, {
  applyQueryLimits: () => applyQueryLimits,
  boundResults: () => boundResults,
  defaultTokenBudget: () => defaultTokenBudget,
  estimateTokens: () => estimateTokens,
  maximumResponseBytes: () => maximumResponseBytes,
  maximumTokenBudget: () => maximumTokenBudget,
  minimumTokenBudget: () => minimumTokenBudget,
  queryTerms: () => queryTerms
});
module.exports = __toCommonJS(ranking_exports);
const minimumTokenBudget = 500;
const maximumTokenBudget = 16e3;
const defaultTokenBudget = 4e3;
const maximumResponseBytes = 64 * 1024;
function applyQueryLimits(limits = {}) {
  const maxDepth = limits.maxDepth ?? 3;
  const tokenBudget = limits.tokenBudget ?? defaultTokenBudget;
  const maxResults = limits.maxResults ?? 200;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) throw new Error("maxDepth must be an integer from 1 through 8");
  if (!Number.isInteger(tokenBudget) || tokenBudget < minimumTokenBudget || tokenBudget > maximumTokenBudget) throw new Error("tokenBudget must be an integer from 500 through 16000");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1e3) throw new Error("maxResults must be an integer from 1 through 1000");
  return { maxDepth, tokenBudget, maxResults };
}
function queryTerms(query) {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 0))].sort();
}
function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}
function boundResults(orderedResults, tokenBudget, maxResults) {
  const results = [];
  let bytes = 0;
  for (const result of orderedResults) {
    if (results.length >= maxResults) break;
    const nextBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (results.length > 0 && (Math.ceil((bytes + nextBytes) / 4) > tokenBudget || bytes + nextBytes > maximumResponseBytes)) break;
    results.push(result);
    bytes += nextBytes;
  }
  return { results, omitted: orderedResults.length - results.length, tokenEstimate: Math.ceil(bytes / 4) };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyQueryLimits,
  boundResults,
  defaultTokenBudget,
  estimateTokens,
  maximumResponseBytes,
  maximumTokenBudget,
  minimumTokenBudget,
  queryTerms
});
