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
var freshness_exports = {};
__export(freshness_exports, {
  buildRelevantInputManifest: () => buildRelevantInputManifest,
  projectInputs: () => projectInputs,
  snapshotIsFresh: () => snapshotIsFresh
});
module.exports = __toCommonJS(freshness_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"));
var import_paths = require("./paths.js");
const relevantExtensions = /* @__PURE__ */ new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = /* @__PURE__ */ new Set([".git", "node_modules"]);
function contentHash(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
function manifestHash(inputs) {
  return (0, import_node_crypto.createHash)("sha256").update(inputs.map((input) => `${input.path}\0${input.contentHash}\0${input.configuration}`).join("\n")).digest("hex");
}
function isRelevantInput(filePath) {
  const fileName = import_node_path.default.basename(filePath);
  return fileName === "tsconfig.json" || fileName === "jsconfig.json" || relevantExtensions.has(import_node_path.default.extname(filePath));
}
async function relevantInputPaths(projectRoot, directory = projectRoot) {
  const entries = await (0, import_promises.readdir)(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const entryPath = import_node_path.default.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : relevantInputPaths(projectRoot, entryPath);
    return entry.isFile() && isRelevantInput(entryPath) ? [entryPath] : [];
  }));
  return children.flat();
}
async function buildRelevantInputManifest(projectRoot) {
  const absoluteInputs = await relevantInputPaths(projectRoot);
  const inputs = await Promise.all(absoluteInputs.map(async (absolutePath) => {
    const relativePath = (0, import_paths.normalizeProjectRelativePath)(import_node_path.default.relative(projectRoot, absolutePath));
    return {
      path: relativePath,
      contentHash: contentHash(await (0, import_promises.readFile)(absolutePath, "utf8")),
      configuration: import_node_path.default.basename(absolutePath) === "tsconfig.json" || import_node_path.default.basename(absolutePath) === "jsconfig.json"
    };
  }));
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const configurationInputs = inputs.filter((input) => input.configuration);
  return {
    inputs,
    sourceManifestHash: manifestHash(inputs),
    configHash: manifestHash(configurationInputs)
  };
}
function snapshotIsFresh(snapshot, manifest) {
  return snapshot.sourceManifestHash === manifest.sourceManifestHash && snapshot.configHash === manifest.configHash;
}
function projectInputs(manifest, project) {
  const projectRelativeRoot = import_node_path.default.relative(import_node_path.default.dirname(project.root), project.root).replaceAll("\\", "/");
  return manifest.inputs.filter((input) => projectRelativeRoot === "" || input.path.startsWith(`${projectRelativeRoot}/`));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildRelevantInputManifest,
  projectInputs,
  snapshotIsFresh
});
