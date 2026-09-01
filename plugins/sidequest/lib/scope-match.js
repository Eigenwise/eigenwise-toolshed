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
var scope_match_exports = {};
__export(scope_match_exports, {
  hasGlob: () => hasGlob,
  isInScope: () => isInScope,
  normalizeScope: () => normalizeScope,
  scopeKey: () => scopeKey,
  scopedPaths: () => scopedPaths
});
module.exports = __toCommonJS(scope_match_exports);
function normalizeScope(scope) {
  return String(scope || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function scopedPaths(files) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const scope = normalizeScope(file);
    const key = scopeKey(scope);
    if (scope && !seen.has(key)) {
      seen.add(key);
      paths.push(scope);
    }
  }
  return paths;
}
function hasGlob(scope) {
  return scope.includes("*");
}
function globExpression(scope) {
  let expression = "^";
  for (let index = 0; index < scope.length; index += 1) {
    const character = scope[index];
    if (character !== "*") {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (scope[index + 1] === "*") {
      if (scope[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    expression += "[^/]*";
  }
  return new RegExp(`${expression}$`, process.platform === "win32" ? "i" : "");
}
function isInScope(file, files) {
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return hasGlob(key) ? globExpression(key).test(filePath) : filePath === key || filePath.startsWith(`${key}/`);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  hasGlob,
  isInScope,
  normalizeScope,
  scopeKey,
  scopedPaths
});
