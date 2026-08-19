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
  isInScope: () => isInScope,
  normalizeScope: () => normalizeScope,
  scopeKey: () => scopeKey,
  scopedPaths: () => scopedPaths
});
module.exports = __toCommonJS(scope_match_exports);
function normalizeScope(scope) {
  return String(scope || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/+$/, "");
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
function isInScope(file, files) {
  const filePath = scopeKey(file);
  return scopedPaths(files).some((scope) => {
    const key = scopeKey(scope);
    return filePath === key || filePath.startsWith(`${key}/`);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isInScope,
  normalizeScope,
  scopeKey,
  scopedPaths
});
