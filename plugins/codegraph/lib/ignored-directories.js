"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ignored_directories_exports = {};
__export(ignored_directories_exports, {
  ignoredDirectoriesUnder: () => ignoredDirectoriesUnder,
  isIgnoredDirectory: () => isIgnoredDirectory
});
module.exports = __toCommonJS(ignored_directories_exports);
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
const alwaysIgnoredNames = /* @__PURE__ */ new Set([
  ".eggs",
  ".git",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".worktrees",
  "__pycache__",
  "node_modules",
  "worktrees"
]);
async function exists(candidate) {
  try {
    await (0, import_promises.access)(candidate);
    return true;
  } catch {
    return false;
  }
}
async function isNestedCheckout(directory) {
  return exists(import_node_path.default.join(directory, ".git"));
}
async function isVirtualEnvironment(directory) {
  return exists(import_node_path.default.join(directory, "pyvenv.cfg"));
}
async function isIgnoredDirectory(directory, additionalNames = /* @__PURE__ */ new Set()) {
  const name = import_node_path.default.basename(directory);
  if (alwaysIgnoredNames.has(name) || additionalNames.has(name)) return true;
  const [nestedCheckout, virtualEnvironment] = await Promise.all([
    isNestedCheckout(directory),
    isVirtualEnvironment(directory)
  ]);
  return nestedCheckout || virtualEnvironment;
}
async function ignoredDirectoriesUnder(root, additionalNames = /* @__PURE__ */ new Set()) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = import_node_path.default.join(root, entry.name);
    return await isIgnoredDirectory(directory, additionalNames) ? [directory] : ignoredDirectoriesUnder(directory, additionalNames);
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ignoredDirectoriesUnder,
  isIgnoredDirectory
});
