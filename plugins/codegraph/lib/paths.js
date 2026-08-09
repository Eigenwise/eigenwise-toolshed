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
var paths_exports = {};
__export(paths_exports, {
  codegraphStateRoot: () => codegraphStateRoot,
  normalizeProjectRelativePath: () => normalizeProjectRelativePath,
  normalizeProjectRoot: () => normalizeProjectRoot,
  projectIdentity: () => projectIdentity,
  projectStateDirectory: () => projectStateDirectory,
  runtimeCacheDirectory: () => runtimeCacheDirectory
});
module.exports = __toCommonJS(paths_exports);
var import_node_crypto = require("node:crypto");
var import_node_os = require("node:os");
var import_node_path = __toESM(require("node:path"));
const projectPathSeparator = "/";
function normalizedPath(pathValue) {
  return pathValue.replaceAll("\\", projectPathSeparator);
}
function isAbsoluteProjectPath(pathValue) {
  return import_node_path.default.posix.isAbsolute(pathValue) || /^[A-Za-z]:\//.test(pathValue);
}
function normalizeProjectRelativePath(pathValue) {
  const normalized = normalizedPath(pathValue);
  if (isAbsoluteProjectPath(normalized)) {
    throw new Error(`project path must be relative: ${pathValue}`);
  }
  const relativePath = import_node_path.default.posix.normalize(normalized).replace(/^\.\//, "");
  if (relativePath === "" || relativePath === "." || relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`project path escapes the project root: ${pathValue}`);
  }
  return relativePath;
}
function normalizeProjectRoot(projectRoot) {
  return normalizedPath(import_node_path.default.resolve(projectRoot));
}
function projectIdentity(projectRoot) {
  return (0, import_node_crypto.createHash)("sha256").update(normalizeProjectRoot(projectRoot)).digest("hex");
}
function codegraphStateRoot(environment = process.env, userHomeDirectory = (0, import_node_os.homedir)()) {
  const override = environment.CODEGRAPH_STATE_DIR;
  return import_node_path.default.resolve(override ?? import_node_path.default.join(userHomeDirectory, ".claude", "codegraph"));
}
function projectStateDirectory(projectRoot, environment = process.env, userHomeDirectory = (0, import_node_os.homedir)()) {
  return import_node_path.default.join(codegraphStateRoot(environment, userHomeDirectory), "projects", projectIdentity(projectRoot));
}
function runtimeCacheDirectory(engineVersion, platform = process.platform, architecture = process.arch, environment = process.env, userHomeDirectory = (0, import_node_os.homedir)()) {
  return import_node_path.default.join(
    codegraphStateRoot(environment, userHomeDirectory),
    "runtime",
    engineVersion,
    `${platform}-${architecture}`
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  codegraphStateRoot,
  normalizeProjectRelativePath,
  normalizeProjectRoot,
  projectIdentity,
  projectStateDirectory,
  runtimeCacheDirectory
});
